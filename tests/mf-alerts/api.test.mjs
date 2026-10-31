// Run: npm test
// Calls the Pages Function handler directly with a fake KV and a stubbed fetch.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../../functions/api/mf/[[route]].js';

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(k, type) { const v = store.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, v); },
  };
}
let env, sent, realFetch;
beforeEach(() => {
  env = { MF_KV: fakeKv(), RESEND_API_KEY: 'k', MAIL_FROM: 'MF <alerts@iamabhilash.in>', ALLOWED_EMAILS: 'me@x.com, mom@x.com' };
  sent = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (url === 'https://api.resend.com/emails') { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: `em_${sent.length}` })); }
    throw new Error('unexpected fetch ' + url);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function call(method, path, body) {
  const route = path.split('/').filter(Boolean);
  const request = new Request('https://www.iamabhilash.in/api/mf/' + path, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await onRequest({ request, env, params: { route } });
  return { status: res.status, body: await res.json() };
}
const PORTFOLIO = { name: 'Mine', emails: 'me@x.com', funds: [{ schemeCode: '122639', schemeName: 'PPFAS Flexi Direct', units: 10 }] };

test('portfolios can be created, listed, updated and deleted without a login', async () => {
  const created = await call('POST', 'portfolios', PORTFOLIO);
  assert.equal(created.status, 200);
  const id = created.body.portfolio.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal((await call('GET', 'portfolios')).body.portfolios.length, 1);
  const updated = await call('POST', 'portfolios', { ...PORTFOLIO, id, name: 'Renamed', emails: 'me@x.com, mom@x.com' });
  assert.equal(updated.body.portfolio.name, 'Renamed');
  assert.deepEqual((await call('GET', 'portfolios')).body.portfolios.map((p) => p.emails), [['me@x.com', 'mom@x.com']]);
  assert.equal((await call('POST', 'portfolios', { ...PORTFOLIO, id: '00000000-0000-0000-0000-000000000000' })).status, 404);
  assert.equal((await call('DELETE', `portfolios/${id}`)).status, 200);
  assert.equal((await call('DELETE', `portfolios/${id}`)).status, 404);
  assert.deepEqual((await call('GET', 'portfolios')).body.portfolios, []);
});

test('saving rejects addresses that are not approved, and everything when none are configured', async () => {
  const r = await call('POST', 'portfolios', { ...PORTFOLIO, emails: 'me@x.com, stranger@evil.com' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /stranger@evil\.com isn't on this site's approved recipient list/);
  env.ALLOWED_EMAILS = '';
  assert.match((await call('POST', 'portfolios', PORTFOLIO)).body.error, /No approved recipients are configured/);
  assert.deepEqual((await call('GET', 'portfolios')).body.portfolios, []);
});

test('test email goes only to approved addresses and is limited to one per 10 minutes', async () => {
  const { body } = await call('POST', 'portfolios', { ...PORTFOLIO, emails: 'me@x.com, mom@x.com' });
  env.ALLOWED_EMAILS = 'me@x.com'; // mom@ removed after saving
  const first = await call('POST', `test-email/${body.portfolio.id}`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.to, ['me@x.com']);
  assert.deepEqual(sent.map((m) => m.to), [['me@x.com']]);
  const second = await call('POST', `test-email/${body.portfolio.id}`);
  assert.equal(second.status, 429);
  assert.match(second.body.error, /try again in 10 min/);
  assert.equal(sent.length, 1);
});

test('test email with no approved address left, or no Resend key, sends nothing and sets no cooldown', async () => {
  const { body } = await call('POST', 'portfolios', PORTFOLIO);
  env.ALLOWED_EMAILS = 'mom@x.com';
  assert.equal((await call('POST', `test-email/${body.portfolio.id}`)).status, 400);
  env.ALLOWED_EMAILS = 'me@x.com';
  delete env.RESEND_API_KEY;
  const r = await call('POST', `test-email/${body.portfolio.id}`);
  assert.equal(r.status, 503);
  assert.match(r.body.skipped, /RESEND_API_KEY not set/);
  assert.equal(env.MF_KV.store.has(`testEmail:${body.portfolio.id}`), false);
  assert.equal(sent.length, 0);
});

test('limits, bad input and unknown routes get clear errors', async () => {
  assert.equal((await call('GET', 'nope')).status, 404);
  const bad = await onRequest({ request: new Request('https://x/api/mf/portfolios', { method: 'POST', body: '{not json' }), env, params: { route: ['portfolios'] } });
  assert.equal(bad.status, 400);
  for (let i = 0; i < 20; i++) assert.equal((await call('POST', 'portfolios', { ...PORTFOLIO, name: `P${i}` })).status, 200);
  assert.match((await call('POST', 'portfolios', PORTFOLIO)).body.error, /At most 20 portfolios/);
  const noKv = await onRequest({ request: new Request('https://x/api/mf/portfolios'), env: {}, params: { route: ['portfolios'] } });
  assert.equal(noKv.status, 503);
});

// Run: npm test
// Drives mf-alerts/api.js the way the browser does: sign-in codes arrive by
// (fake) email, and the session cookie is carried between requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../mf-alerts/api.js';
import { fakeKv, fakeMailer } from './fakes.mjs';

const MASTER = 'abilashhp@gmail.com';
const SITE = 'https://www.iamabhilash.in';

// NAV source stand-in: scheme 122639 sits 7% below its high.
const navFetch = async (url) => {
  const code = url.split('/').pop();
  const data = code === '122639' ? [{ date: '30-10-2026', nav: '93' }, { date: '01-06-2026', nav: '100' }] : [{ date: '30-10-2026', nav: '50' }];
  return new Response(JSON.stringify({ data }));
};

function harness() {
  const env = { MF_KV: fakeKv(), MASTER_EMAIL: MASTER, SITE_URL: SITE };
  const { mailer, sent } = fakeMailer();
  async function call(method, path, body, { cookie, origin } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const request = new Request(`${SITE}/api/mf/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handle({ request, env, params: { route: path.split('/') } }, { mailer, fetchImpl: navFetch });
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, body: await res.json(), cookie: setCookie && setCookie.split(';')[0] };
  }
  const lastCode = (to) => {
    const m = [...sent].reverse().find((x) => x.to[0] === to && /sign-in code/.test(x.subject));
    return m && /code is (\d{6})/.exec(m.text)[1];
  };
  async function signIn(email) {
    const r = await call('POST', 'auth/code', { email });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const v = await call('POST', 'auth/verify', { email, code: lastCode(email) });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return v.cookie;
  }
  return { env, sent, call, lastCode, signIn };
}
const PORTFOLIO = { name: 'Mine', funds: [{ schemeCode: '122639', schemeName: 'PPFAS Flexi Direct', units: 10 }] };

test('the master signs in with an emailed code and is the admin', async () => {
  const h = harness();
  assert.equal((await h.call('GET', 'me')).body.email, null);
  assert.equal((await h.call('POST', 'auth/code', { email: ' AbilashHP@Gmail.com ' })).status, 200);
  assert.deepEqual(h.sent[0].to, [MASTER]);
  assert.match(h.sent[0].subject, /^\d{6} is your MF Alerts sign-in code$/);
  const wrong = await h.call('POST', 'auth/verify', { email: MASTER, code: h.lastCode(MASTER) === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /Wrong code \(4 tries left\)/);
  const ok = await h.call('POST', 'auth/verify', { email: MASTER, code: h.lastCode(MASTER) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { email: MASTER, admin: true });
  assert.match(ok.cookie, /^mf_session=[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual((await h.call('GET', 'me', undefined, { cookie: ok.cookie })).body, { email: MASTER, admin: true });
  // A code works once.
  assert.equal((await h.call('POST', 'auth/verify', { email: MASTER, code: h.lastCode(MASTER) })).status, 401);
});

test('someone without access can request it; the master approves; then they can sign in', async () => {
  const h = harness();
  const friend = 'friend@example.com';
  const denied = await h.call('POST', 'auth/code', { email: friend });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.noAccess, true);
  assert.equal(h.sent.length, 0); // no code goes to people without access

  assert.equal((await h.call('POST', 'access/request', { email: friend, note: 'college friend' })).body.status, 'requested');
  assert.equal((await h.call('POST', 'access/request', { email: friend })).body.status, 'pending');
  const notice = h.sent.find((m) => m.to[0] === MASTER);
  assert.match(notice.subject, /friend@example\.com requested access/);
  assert.match(notice.text, /college friend/);

  const master = await h.signIn(MASTER);
  const list = await h.call('GET', 'access', undefined, { cookie: master });
  assert.deepEqual(list.body.requests.map((r) => [r.email, r.note]), [[friend, 'college friend']]);
  const g = await h.call('POST', 'access/grant', { email: friend }, { cookie: master });
  assert.equal(g.body.invited, true);
  assert.match(h.sent.find((m) => m.to[0] === friend).subject, /You now have access/);
  const after = (await h.call('GET', 'access', undefined, { cookie: master })).body;
  assert.deepEqual(after.requests, []);
  assert.deepEqual(after.users.map((u) => [u.email, u.grantedBy]), [[friend, MASTER]]);

  const friendCookie = await h.signIn(friend);
  assert.deepEqual((await h.call('GET', 'me', undefined, { cookie: friendCookie })).body, { email: friend, admin: false });
  assert.equal((await h.call('GET', 'access', undefined, { cookie: friendCookie })).status, 403);
});

test("each person sees and changes only their own portfolios; the owner can't be spoofed", async () => {
  const h = harness();
  const master = await h.signIn(MASTER);
  await h.call('POST', 'access/grant', { email: 'mom@example.com' }, { cookie: master });
  const mom = await h.signIn('mom@example.com');

  const mine = (await h.call('POST', 'portfolios', PORTFOLIO, { cookie: master })).body.portfolio;
  const hers = (await h.call('POST', 'portfolios', { ...PORTFOLIO, name: 'Mom', owner: MASTER }, { cookie: mom })).body.portfolio;
  assert.equal(mine.owner, MASTER);
  assert.equal(hers.owner, 'mom@example.com');
  assert.deepEqual((await h.call('GET', 'portfolios', undefined, { cookie: mom })).body.portfolios.map((p) => p.name), ['Mom']);
  assert.deepEqual((await h.call('GET', 'portfolios', undefined, { cookie: master })).body.portfolios.map((p) => p.name), ['Mine']);
  // Mom can't edit or delete the master's portfolio, even knowing its id.
  assert.equal((await h.call('POST', 'portfolios', { ...PORTFOLIO, id: mine.id, name: 'Hacked' }, { cookie: mom })).status, 404);
  assert.equal((await h.call('DELETE', `portfolios/${mine.id}`, undefined, { cookie: mom })).status, 404);
  assert.equal((await h.call('POST', `test-email/${mine.id}`, undefined, { cookie: mom })).status, 404);
  assert.equal((await h.call('DELETE', `portfolios/${hers.id}`, undefined, { cookie: mom })).status, 200);
});

test('revoking access ends sessions and sign-in immediately; the master cannot be revoked', async () => {
  const h = harness();
  const master = await h.signIn(MASTER);
  await h.call('POST', 'access/grant', { email: 'x@example.com' }, { cookie: master });
  const x = await h.signIn('x@example.com');
  assert.equal((await h.call('GET', 'portfolios', undefined, { cookie: x })).status, 200);
  await h.call('POST', 'access/revoke', { email: 'x@example.com' }, { cookie: master });
  const after = await h.call('GET', 'portfolios', undefined, { cookie: x });
  assert.equal(after.status, 401);
  assert.equal(after.body.signedOut, true);
  assert.equal((await h.call('POST', 'auth/code', { email: 'x@example.com' })).status, 403);
  assert.match((await h.call('POST', 'access/revoke', { email: MASTER }, { cookie: master })).body.error, /can't be revoked/);
});

test('sign-in codes: 60s between requests, 5 wrong tries, single use after sign-out', async () => {
  const h = harness();
  assert.equal((await h.call('POST', 'auth/code', { email: MASTER })).status, 200);
  const again = await h.call('POST', 'auth/code', { email: MASTER });
  assert.equal(again.status, 429);
  assert.match(again.body.error, /wait \d+s/);
  const code = h.lastCode(MASTER);
  const bad = code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.equal((await h.call('POST', 'auth/verify', { email: MASTER, code: bad })).status, 401);
  const locked = await h.call('POST', 'auth/verify', { email: MASTER, code });
  assert.match(locked.body.error, /Too many wrong codes/);

  h.env.MF_KV.store.delete(`rl:code:${MASTER}`); // skip the 60s wait
  const cookie = await h.signIn(MASTER);
  const out = await h.call('POST', 'auth/logout', undefined, { cookie });
  assert.match(out.cookie, /^mf_session=$/);
  assert.equal((await h.call('GET', 'portfolios', undefined, { cookie })).status, 401);
});

test('saving a portfolio emails funds already past a step right away, once', async () => {
  const h = harness();
  const master = await h.signIn(MASTER);
  const before = h.sent.length;
  const saved = (await h.call('POST', 'portfolios', { name: 'Mine', funds: [{ schemeCode: '122639', schemeName: 'PPFAS Flexi Direct' }, { schemeCode: '100001', schemeName: 'Flat Fund' }] }, { cookie: master })).body.portfolio;
  const alerts = h.sent.slice(before).filter((m) => /52-week high/.test(m.subject));
  assert.deepEqual(alerts.map((m) => [m.to[0], m.subject]), [[MASTER, 'PPFAS Flexi Direct is 7.0% below its 52-week high']]);
  // Saving again (e.g. renaming) doesn't repeat the -5% email.
  await h.call('POST', 'portfolios', { ...saved, name: 'Renamed' }, { cookie: master });
  assert.equal(h.sent.slice(before).filter((m) => /52-week high/.test(m.subject)).length, 1);
});

test('test email goes to the signed-in owner, at most once per 10 minutes', async () => {
  const h = harness();
  const master = await h.signIn(MASTER);
  const p = (await h.call('POST', 'portfolios', PORTFOLIO, { cookie: master })).body.portfolio;
  const first = await h.call('POST', `test-email/${p.id}`, undefined, { cookie: master });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.to, [MASTER]);
  assert.match(h.sent.at(-1).subject, /^Test: MF Alerts for "Mine"$/);
  assert.equal((await h.call('POST', `test-email/${p.id}`, undefined, { cookie: master })).status, 429);
});

test('cross-site requests, signed-out access, bad input and missing config are refused', async () => {
  const h = harness();
  const master = await h.signIn(MASTER);
  assert.equal((await h.call('POST', 'portfolios', PORTFOLIO, { cookie: master, origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.call('POST', 'portfolios', PORTFOLIO, { cookie: master, origin: SITE })).status, 200);
  assert.equal((await h.call('GET', 'portfolios')).status, 401);
  assert.equal((await h.call('GET', 'portfolios', undefined, { cookie: 'mf_session=forgedforgedforgedforgedforged' })).status, 401);
  assert.equal((await h.call('POST', 'auth/code', { email: 'not-an-email' })).status, 400);
  assert.equal((await h.call('GET', 'nope', undefined, { cookie: master })).status, 404);
  const noKv = await handle({ request: new Request(`${SITE}/api/mf/me`), env: {}, params: { route: ['me'] } }, { mailer: async () => ({}) });
  assert.equal(noKv.status, 503);
  const noMaster = await handle({ request: new Request(`${SITE}/api/mf/me`), env: { MF_KV: fakeKv() }, params: { route: ['me'] } }, { mailer: async () => ({}) });
  assert.equal(noMaster.status, 503);
});

test('a code that cannot be emailed says so instead of pretending', async () => {
  const env = { MF_KV: fakeKv(), MASTER_EMAIL: MASTER };
  const request = new Request(`${SITE}/api/mf/auth/code`, { method: 'POST', body: JSON.stringify({ email: MASTER }) });
  const res = await handle({ request, env, params: { route: ['auth', 'code'] } }, { mailer: async () => { throw new Error('mail server rejected login (check GMAIL_USER / GMAIL_APP_PASSWORD): 535'); } });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Couldn't send the code: mail server rejected login/);
});

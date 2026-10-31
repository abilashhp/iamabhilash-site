// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawdownFromHistory, alertLevel, evaluatePortfolio, renderAlertEmail, validatePortfolio, runChecks,
} from '../../mf-alerts/core.js';

const DAY = 86400000;
const ddmmyyyy = (t) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`; };
// navs[0] is the latest; one point per day going back.
function history(navs, latest = Date.UTC(2026, 9, 30)) {
  return navs.map((nav, i) => ({ date: ddmmyyyy(latest - i * DAY), nav: String(nav) }));
}
const info = (drawdownPct) => ({ latestNav: 100 - drawdownPct, latestDate: '30-10-2026', peakNav: 100, peakDate: '01-06-2026', drawdownPct });

// ---------- Drawdown ----------
test('drawdown is measured from the highest NAV of the trailing 52 weeks', () => {
  const navs = new Array(400).fill(50);
  navs[0] = 90; navs[100] = 100; navs[380] = 200; // 200 is older than 365 days, so ignored
  const d = drawdownFromHistory(history(navs));
  assert.equal(d.peakNav, 100);
  assert.equal(d.latestNav, 90);
  assert.equal(d.latestDate, '30-10-2026');
  assert.equal(d.peakDate, ddmmyyyy(Date.UTC(2026, 9, 30) - 100 * DAY));
  assert.ok(Math.abs(d.drawdownPct - 10) < 1e-9);
});

test('a NAV at its high has zero drawdown; bad points and order are tolerated', () => {
  const h = history([105, 100, 101]);
  const shuffled = [h[2], { date: 'garbage', nav: '999' }, h[0], { date: '01-01-2026', nav: 'N.A.' }, h[1]];
  const d = drawdownFromHistory(shuffled);
  assert.equal(d.latestNav, 105);
  assert.equal(d.drawdownPct, 0);
  assert.equal(drawdownFromHistory([]), null);
  assert.equal(drawdownFromHistory([{ date: 'x', nav: '1' }]), null);
});

test('alert steps: floor of drawdown / step, exact multiples included', () => {
  assert.equal(alertLevel(4.999, 5), 0);
  assert.equal(alertLevel(5, 5), 1);
  assert.equal(alertLevel(9.99, 5), 1);
  assert.equal(alertLevel((100 - 90) / 100 * 100, 5), 2);
  assert.equal(alertLevel(0.3 * 100 / 3 * 3, 10), 3); // float noise around 30
  assert.equal(alertLevel(0, 5), 0);
  assert.equal(alertLevel(-3, 5), 0);
});

// ---------- Re-alert rules ----------
test('alerts at each new step, ignores partial recoveries, re-arms after full recovery', () => {
  const p = { id: 'p1', name: 'P', thresholdPct: 5, funds: [{ schemeCode: '1', schemeName: 'Fund A' }] };
  let state = {};
  const steps = [];
  for (const dd of [3, 6, 7, 11, 7, 11.5, 16, 4, 6]) {
    const { alerts, nextState } = evaluatePortfolio(p, { 1: info(dd) }, state);
    steps.push(alerts.length ? `alert@${alerts[0].stepPct}` : '-');
    state = nextState;
  }
  assert.deepEqual(steps, ['-', 'alert@5', '-', 'alert@10', '-', '-', 'alert@15', '-', 'alert@5']);
});

test('changing the step size keeps what was already alerted', () => {
  const p = { id: 'p1', name: 'P', thresholdPct: 5, funds: [{ schemeCode: '1', schemeName: 'A' }] };
  let { nextState: state } = evaluatePortfolio(p, { 1: info(10.5) }, {}); // alerted at 10%
  p.thresholdPct = 4;
  let r = evaluatePortfolio(p, { 1: info(11) }, state); // 8% step < 10% alerted
  assert.equal(r.alerts.length, 0);
  r = evaluatePortfolio(p, { 1: info(12.5) }, r.nextState); // 12% > 10%
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].stepPct, 12);
});

test('a fund with no NAV data today keeps its alert state', () => {
  const p = { id: 'p1', name: 'P', thresholdPct: 5, funds: [{ schemeCode: '1', schemeName: 'A' }, { schemeCode: '2', schemeName: 'B', units: 10 }] };
  const first = evaluatePortfolio(p, { 1: info(6), 2: info(1) }, {});
  const second = evaluatePortfolio(p, { 1: { error: 'HTTP 502' }, 2: info(1) }, first.nextState);
  assert.equal(second.rows[0].error, 'HTTP 502');
  assert.deepEqual(second.nextState['1'], first.nextState['1']);
  assert.equal(second.rows[1].value, 990);
});

// ---------- Email ----------
test('alert email escapes names and summarizes the alerts', () => {
  const p = { name: 'Mine <b>', thresholdPct: 5 };
  const a = { schemeName: 'Fund & Co <script>', latestNav: 90.12345, latestDate: '30-10-2026', peakNav: 100, peakDate: '01-06-2026', drawdownPct: 9.876, stepPct: 5, value: 12345.6 };
  const one = renderAlertEmail(p, [a], 'https://www.iamabhilash.in');
  assert.equal(one.subject, 'Fund & Co <script> is 9.9% below its 52-week high');
  assert.ok(!one.html.includes('<script>') && !one.html.includes('Mine <b>'));
  assert.ok(one.html.includes('Fund &amp; Co &lt;script&gt;'));
  assert.match(one.text, /Down 9\.88% \(crossed -5%\), holding now ₹12,346/);
  assert.match(one.text, /https:\/\/www\.iamabhilash\.in\/tools\/mf-alerts/);
  const two = renderAlertEmail(p, [a, { ...a, drawdownPct: 12.3, stepPct: 10, value: null }], 'https://x');
  assert.equal(two.subject, '2 funds in "Mine <b>" fell past an alert step (worst: -12.3%)');
});

// ---------- Validation ----------
test('portfolio validation normalizes input and explains problems', () => {
  const ok = validatePortfolio({ name: ' Mine ', emails: 'A@x.com, b@y.in;a@x.com', thresholdPct: '', funds: [{ schemeCode: 122639, schemeName: 'PPFAS', units: '12.5' }, { schemeCode: '119551' }] });
  assert.deepEqual(ok, { id: null, name: 'Mine', emails: ['a@x.com', 'b@y.in'], thresholdPct: 5, funds: [{ schemeCode: '122639', schemeName: 'PPFAS', units: 12.5 }, { schemeCode: '119551', schemeName: 'Scheme 119551', units: null }] });
  const base = { name: 'n', emails: 'a@x.com', funds: [{ schemeCode: '1234' }] };
  assert.throws(() => validatePortfolio({ ...base, name: '' }), /name/);
  assert.throws(() => validatePortfolio({ ...base, emails: 'not-an-email' }), /doesn't look like an email/);
  assert.throws(() => validatePortfolio({ ...base, emails: '' }), /at least one email/);
  assert.throws(() => validatePortfolio({ ...base, thresholdPct: 0.5 }), /between 1% and 50%/);
  assert.throws(() => validatePortfolio({ ...base, funds: [] }), /at least one fund/);
  assert.throws(() => validatePortfolio({ ...base, funds: [{ schemeCode: 'abc' }] }), /AMFI scheme code/);
  assert.throws(() => validatePortfolio({ ...base, funds: [{ schemeCode: '1234' }, { schemeCode: '1234' }] }), /twice/);
  assert.throws(() => validatePortfolio({ ...base, funds: [{ schemeCode: '1234', units: -1 }] }), /positive number/);
  assert.equal(validatePortfolio({ ...base, id: 'bad id!' }).id, null);
});

// ---------- Full run against fakes ----------
function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store, writes: 0,
    async get(k, type) { const v = store.get(k); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { this.writes++; store.set(k, v); },
  };
}
function fakeFetch(navsByCode, { resendFails = false } = {}) {
  const calls = { nav: [], emails: [] };
  const impl = async (url, opts = {}) => {
    if (url.startsWith('https://api.mfapi.in/mf/')) {
      const code = url.split('/').pop();
      calls.nav.push(code);
      const navs = navsByCode[code];
      if (!navs) return new Response('{}', { status: 502 });
      return new Response(JSON.stringify({ data: history(navs), status: 'SUCCESS' }));
    }
    if (url === 'https://api.resend.com/emails') {
      if (resendFails) return new Response('rate limited', { status: 429 });
      calls.emails.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: `em_${calls.emails.length}` }));
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { impl, calls };
}
const PORTFOLIOS = [
  { id: 'p1', name: 'Mine', emails: ['me@x.com'], thresholdPct: 5, funds: [{ schemeCode: '111', schemeName: 'Falling Fund' }, { schemeCode: '222', schemeName: 'Steady Fund' }] },
  { id: 'p2', name: 'Family', emails: ['a@x.com', 'b@x.com'], thresholdPct: 5, funds: [{ schemeCode: '111', schemeName: 'Falling Fund' }] },
  { id: 'p3', name: 'Broken', emails: ['c@x.com'], thresholdPct: 5, funds: [{ schemeCode: '999', schemeName: 'Missing Fund' }] },
];
const ENV = (kv) => ({ MF_KV: kv, RESEND_API_KEY: 'k', MAIL_FROM: 'MF <alerts@iamabhilash.in>', SITE_URL: 'https://www.iamabhilash.in' });

test('a run emails each portfolio with new alerts once, fetches each scheme once, and records state', async () => {
  const kv = fakeKv({ portfolios: PORTFOLIOS });
  const { impl, calls } = fakeFetch({ 111: [93, 100], 222: [100, 99] });
  const { summary, results } = await runChecks(ENV(kv), { fetchImpl: impl, fetchOpts: { backoffMs: 1 } });
  // '111' is in two portfolios but fetched once; the failing '999' gets 3 attempts.
  assert.deepEqual(calls.nav.sort(), ['111', '222', '999', '999', '999']);
  assert.deepEqual(calls.emails.map((e) => e.to), [['me@x.com'], ['a@x.com', 'b@x.com']]);
  assert.equal(calls.emails[0].from, 'MF <alerts@iamabhilash.in>');
  assert.equal(summary.alertsSent, 2);
  assert.deepEqual(summary.errors, ['scheme 999: NAV source returned HTTP 502']);
  assert.equal(results[2].rows[0].error, 'NAV source returned HTTP 502');
  const state = JSON.parse(kv.store.get('state'));
  assert.equal(state.p1['111'].alertedStepPct, 5);
  assert.equal(state.p1['222'].alertedStepPct, 0);
  assert.ok(kv.store.get('lastRun'));

  // Same NAVs again: nothing new to say.
  const again = fakeFetch({ 111: [93, 100], 222: [100, 99] });
  const r2 = await runChecks(ENV(kv), { fetchImpl: again.impl });
  assert.equal(again.calls.emails.length, 0);
  assert.equal(r2.summary.alertsSent, 0);
});

test('a NAV fetch that times out is retried, then reported', async () => {
  let n = 0;
  const flaky = async () => { n++; if (n < 3) throw new DOMException('timed out', 'TimeoutError'); return new Response(JSON.stringify({ data: history([90, 100]) })); };
  const kv = fakeKv({ portfolios: [{ ...PORTFOLIOS[0], funds: [PORTFOLIOS[0].funds[0]] }] });
  const r = await runChecks({ ...ENV(kv), RESEND_API_KEY: undefined }, { fetchImpl: flaky, fetchOpts: { backoffMs: 1 }, dryRun: true });
  assert.equal(n, 3);
  assert.equal(r.results[0].rows[0].drawdownPct, 10);
});

test('a failed email keeps the old state so the alert is retried; dry runs write nothing', async () => {
  const kv = fakeKv({ portfolios: [PORTFOLIOS[0]] });
  const failing = fakeFetch({ 111: [93, 100], 222: [100] }, { resendFails: true });
  const r = await runChecks(ENV(kv), { fetchImpl: failing.impl });
  assert.match(r.summary.errors[0], /Mine: Resend returned HTTP 429/);
  assert.deepEqual(JSON.parse(kv.store.get('state')), { p1: {} });

  const dry = fakeFetch({ 111: [93, 100], 222: [100] });
  const writes = kv.writes;
  const d = await runChecks(ENV(kv), { fetchImpl: dry.impl, dryRun: true });
  assert.equal(kv.writes, writes);
  assert.equal(dry.calls.emails.length, 0);
  assert.equal(d.results[0].alerts.length, 1); // still pending

  const retry = fakeFetch({ 111: [93, 100], 222: [100] });
  await runChecks(ENV(kv), { fetchImpl: retry.impl });
  assert.equal(retry.calls.emails.length, 1);
});

test('without RESEND_API_KEY nothing is sent and alerts stay pending', async () => {
  const kv = fakeKv({ portfolios: [PORTFOLIOS[0]] });
  const { impl, calls } = fakeFetch({ 111: [93, 100], 222: [100] });
  const env = { ...ENV(kv), RESEND_API_KEY: undefined };
  const r = await runChecks(env, { fetchImpl: impl });
  assert.equal(calls.emails.length, 0);
  assert.match(r.summary.errors[0], /RESEND_API_KEY not set/);
  assert.deepEqual(JSON.parse(kv.store.get('state')), { p1: {} });
});

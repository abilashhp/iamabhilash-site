// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawdownFromHistory, alertLevel, evaluatePortfolio, renderAlertEmail, validatePortfolio, runChecks,
} from '../../mf-alerts/core.js';
import { fakeKv, fakeMailer } from './fakes.mjs';

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
  const ok = validatePortfolio({ name: ' Mine ', thresholdPct: '', owner: 'attacker@x.com', funds: [{ schemeCode: 122639, schemeName: 'PPFAS', units: '12.5' }, { schemeCode: '119551' }] });
  assert.deepEqual(ok, { id: null, name: 'Mine', thresholdPct: 5, funds: [{ schemeCode: '122639', schemeName: 'PPFAS', units: 12.5 }, { schemeCode: '119551', schemeName: 'Scheme 119551', units: null }] });
  const base = { name: 'n', funds: [{ schemeCode: '1234' }] };
  assert.throws(() => validatePortfolio({ ...base, name: '' }), /name/);
  assert.throws(() => validatePortfolio({ ...base, thresholdPct: 0.5 }), /between 1% and 50%/);
  assert.throws(() => validatePortfolio({ ...base, funds: [] }), /at least one fund/);
  assert.throws(() => validatePortfolio({ ...base, funds: [{ schemeCode: 'abc' }] }), /AMFI scheme code/);
  assert.throws(() => validatePortfolio({ ...base, funds: [{ schemeCode: '1234' }, { schemeCode: '1234' }] }), /twice/);
  assert.throws(() => validatePortfolio({ ...base, funds: [{ schemeCode: '1234', units: -1 }] }), /positive number/);
  assert.equal(validatePortfolio({ ...base, id: 'bad id!' }).id, null);
});

// ---------- Full run against fakes ----------
function fakeNav(navsByCode) {
  const calls = [];
  const impl = async (url) => {
    const code = url.split('/').pop();
    calls.push(code);
    const navs = navsByCode[code];
    if (!navs) return new Response('{}', { status: 502 });
    return new Response(JSON.stringify({ data: history(navs), status: 'SUCCESS' }));
  };
  return { impl, calls };
}
const PORTFOLIOS = [
  { id: 'p1', owner: 'me@x.com', name: 'Mine', thresholdPct: 5, funds: [{ schemeCode: '111', schemeName: 'Falling Fund' }, { schemeCode: '222', schemeName: 'Steady Fund' }] },
  { id: 'p2', owner: 'mom@x.com', name: 'Mom', thresholdPct: 5, funds: [{ schemeCode: '111', schemeName: 'Falling Fund' }] },
  { id: 'p3', owner: 'me@x.com', name: 'Broken', thresholdPct: 5, funds: [{ schemeCode: '999', schemeName: 'Missing Fund' }] },
];
const ACCESS = { users: { 'mom@x.com': { grantedAt: '2026-11-01T00:00:00Z', grantedBy: 'me@x.com' } }, requests: {} };
const ENV = (kv) => ({ MF_KV: kv, MASTER_EMAIL: 'me@x.com', SITE_URL: 'https://www.iamabhilash.in' });
const FAST = { backoffMs: 1 };

test('a run emails each owner once, fetches each scheme once, and records state', async () => {
  const kv = fakeKv({ portfolios: PORTFOLIOS, access: ACCESS });
  const nav = fakeNav({ 111: [93, 100], 222: [100, 99] });
  const { mailer, sent } = fakeMailer();
  const { summary, results } = await runChecks(ENV(kv), { fetchImpl: nav.impl, fetchOpts: FAST, mailer });
  // '111' is in two portfolios but fetched once; the failing '999' gets 3 attempts.
  assert.deepEqual(nav.calls.sort(), ['111', '222', '999', '999', '999']);
  assert.deepEqual(sent.map((m) => m.to), [['me@x.com'], ['mom@x.com']]);
  assert.match(sent[0].subject, /Falling Fund is 7\.0% below its 52-week high/);
  assert.equal(summary.alertsSent, 2);
  assert.deepEqual(summary.errors, ['scheme 999: NAV source returned HTTP 502']);
  assert.equal(results[2].rows[0].error, 'NAV source returned HTTP 502');
  const state = JSON.parse(kv.store.get('state'));
  assert.equal(state.p1['111'].alertedStepPct, 5);
  assert.equal(state.p1['222'].alertedStepPct, 0);
  assert.ok(kv.store.get('lastRun'));

  const again = fakeMailer();
  const r2 = await runChecks(ENV(kv), { fetchImpl: fakeNav({ 111: [93, 100], 222: [100, 99] }).impl, fetchOpts: FAST, mailer: again.mailer });
  assert.equal(again.sent.length, 0);
  assert.equal(r2.summary.alertsSent, 0);
});

test('a revoked owner gets no email and their alert stays pending', async () => {
  const kv = fakeKv({ portfolios: [PORTFOLIOS[1]], access: { users: {}, requests: {} } });
  const { mailer, sent } = fakeMailer();
  const r = await runChecks(ENV(kv), { fetchImpl: fakeNav({ 111: [93, 100] }).impl, mailer });
  assert.equal(sent.length, 0);
  assert.match(r.summary.errors[0], /mom@x\.com no longer has access/);
  assert.deepEqual(JSON.parse(kv.store.get('state')), { p2: {} });
});

test('a NAV fetch that times out is retried, then reported', async () => {
  let n = 0;
  const flaky = async () => { n++; if (n < 3) throw new DOMException('timed out', 'TimeoutError'); return new Response(JSON.stringify({ data: history([90, 100]) })); };
  const kv = fakeKv({ portfolios: [{ ...PORTFOLIOS[0], funds: [PORTFOLIOS[0].funds[0]] }], access: ACCESS });
  const r = await runChecks(ENV(kv), { fetchImpl: flaky, fetchOpts: FAST, dryRun: true });
  assert.equal(n, 3);
  assert.equal(r.results[0].rows[0].drawdownPct, 10);
});

test('a failed email keeps the old state so the alert is retried; dry runs write nothing', async () => {
  const kv = fakeKv({ portfolios: [PORTFOLIOS[0]], access: ACCESS });
  const navs = { 111: [93, 100], 222: [100] };
  const r = await runChecks(ENV(kv), { fetchImpl: fakeNav(navs).impl, mailer: fakeMailer({ fails: true }).mailer });
  assert.match(r.summary.errors[0], /Mine: mail server rejected login: 535/);
  assert.deepEqual(JSON.parse(kv.store.get('state')), { p1: {} });

  const writes = kv.writes;
  const dry = fakeMailer();
  const d = await runChecks(ENV(kv), { fetchImpl: fakeNav(navs).impl, mailer: dry.mailer, dryRun: true });
  assert.equal(kv.writes, writes);
  assert.equal(dry.sent.length, 0);
  assert.equal(d.results[0].alerts.length, 1); // still pending

  const retry = fakeMailer();
  await runChecks(ENV(kv), { fetchImpl: fakeNav(navs).impl, mailer: retry.mailer });
  assert.equal(retry.sent.length, 1);
});

test("a per-owner run touches only that owner's portfolios and keeps others' state", async () => {
  const kv = fakeKv({ portfolios: PORTFOLIOS, access: ACCESS, state: { p2: { 111: { alertedStepPct: 5 } } } });
  const { mailer, sent } = fakeMailer();
  const r = await runChecks(ENV(kv), { owner: 'me@x.com', fetchImpl: fakeNav({ 111: [93, 100], 222: [100] }).impl, fetchOpts: FAST, mailer });
  assert.deepEqual(r.results.map((x) => x.id), ['p1', 'p3']);
  assert.deepEqual(sent.map((m) => m.to), [['me@x.com']]);
  const state = JSON.parse(kv.store.get('state'));
  assert.deepEqual(state.p2, { 111: { alertedStepPct: 5 } });
  assert.equal(state.p1['111'].alertedStepPct, 5);
  assert.equal(kv.store.get('lastRun'), undefined); // per-user runs don't overwrite the scheduled summary
});

test('without a mailer nothing is sent and alerts stay pending', async () => {
  const kv = fakeKv({ portfolios: [PORTFOLIOS[0]], access: ACCESS });
  const r = await runChecks(ENV(kv), { fetchImpl: fakeNav({ 111: [93, 100], 222: [100] }).impl });
  assert.match(r.summary.errors[0], /no mailer configured/);
  assert.deepEqual(JSON.parse(kv.store.get('state')), { p1: {} });
});


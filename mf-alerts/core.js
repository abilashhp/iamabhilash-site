// Mutual fund drawdown alerts — logic shared by the scheduled Worker
// (mf-alerts/worker.js) and the site's API (functions/api/mf/[[route]].js).
//
// Rule: a fund's drawdown is how far its latest NAV sits below its highest NAV
// of the trailing 52 weeks. Alerts fire in steps of the portfolio's threshold
// (5% by default): at -5%, again at -10%, -15%…; a fund that recovers to less
// than one step down re-arms. NAVs come from mfapi.in (AMFI data).
//
// Each portfolio belongs to a signed-in user (auth.js) and alerts go only to
// that owner's address, sent from Gmail (mail.js). Owners whose access is
// revoked stop getting alerts.
//
// KV layout (binding MF_KV):
//   portfolios  [{ id, owner, name, thresholdPct, funds: [{ schemeCode, schemeName, units? }] }]
//   state       { [portfolioId]: { [schemeCode]: { alertedStepPct, drawdownPct, peakNav, peakDate, latestDate, alertedAt } } }
//   lastRun     summary of the most recent scheduled or manual run

import { getAccess, hasAccess } from './auth.js';

export const DEFAULT_THRESHOLD = 5;
export const LOOKBACK_DAYS = 365;
export const LIMITS = { portfolios: 30, portfoliosPerUser: 10, fundsPerPortfolio: 40, distinctSchemes: 45 };
const NAV_API = 'https://api.mfapi.in/mf/';
const DAY_MS = 86400000;

// mfapi dates are dd-mm-yyyy.
export function parseNavDate(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s || '');
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : NaN;
}

// history: mfapi `data`, newest first. The window is the LOOKBACK_DAYS before
// the latest NAV, so a fund with a stale feed is judged on its own last year.
export function drawdownFromHistory(history, lookbackDays = LOOKBACK_DAYS) {
  const points = [];
  for (const p of history || []) {
    const t = parseNavDate(p.date), nav = Number(p.nav);
    if (Number.isFinite(t) && Number.isFinite(nav) && nav > 0) points.push({ t, date: p.date, nav });
  }
  if (!points.length) return null;
  points.sort((a, b) => b.t - a.t);
  const latest = points[0];
  const from = latest.t - lookbackDays * DAY_MS;
  let peak = latest;
  for (const p of points) {
    if (p.t < from) break;
    if (p.nav > peak.nav) peak = p;
  }
  return {
    latestNav: latest.nav, latestDate: latest.date,
    peakNav: peak.nav, peakDate: peak.date,
    drawdownPct: (peak.nav - latest.nav) / peak.nav * 100,
    windowStart: points.filter((p) => p.t >= from).at(-1).date,
  };
}

// 0 below one threshold step; 1 at ≥1 step (e.g. -5%), 2 at ≥2 steps (-10%)…
// The epsilon keeps an exact -10.000% from flooring to step 1 through float error.
export function alertLevel(drawdownPct, thresholdPct) {
  if (!(thresholdPct > 0) || !(drawdownPct > 0)) return 0;
  return Math.floor(drawdownPct / thresholdPct + 1e-9);
}

// navInfo: { [schemeCode]: drawdownFromHistory() result | { error } }.
// prevState: this portfolio's slice of the `state` key.
export function evaluatePortfolio(portfolio, navInfo, prevState = {}, now = new Date()) {
  const threshold = portfolio.thresholdPct || DEFAULT_THRESHOLD;
  const rows = [], alerts = [], nextState = {};
  for (const fund of portfolio.funds) {
    const code = String(fund.schemeCode);
    const info = navInfo[code];
    const prev = prevState[code];
    if (!info || info.error) {
      rows.push({ ...fund, error: (info && info.error) || 'no NAV data' });
      if (prev) nextState[code] = prev; // unknown today: keep what we knew
      continue;
    }
    // Steps are kept as percentages so changing the threshold doesn't misread
    // what was already alerted. The deepest step alerted stays until the fund
    // recovers to under one step down; partial recoveries don't re-alert.
    const stepPct = alertLevel(info.drawdownPct, threshold) * threshold;
    const alertedStepPct = prev ? prev.alertedStepPct || 0 : 0;
    const isAlert = stepPct > alertedStepPct;
    const row = {
      ...fund, ...info, stepPct, alertedStepPct,
      value: fund.units ? fund.units * info.latestNav : null,
    };
    rows.push(row);
    if (isAlert) alerts.push(row);
    nextState[code] = {
      alertedStepPct: stepPct === 0 ? 0 : Math.max(stepPct, alertedStepPct),
      drawdownPct: +info.drawdownPct.toFixed(2), peakNav: info.peakNav, peakDate: info.peakDate, latestDate: info.latestDate,
      alertedAt: isAlert ? now.toISOString() : (stepPct ? prev.alertedAt : null),
    };
  }
  return { rows, alerts, nextState };
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
const fmtNav = (n) => n.toFixed(4).replace(/0{1,2}$/, '');
const fmtInr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

export function renderAlertEmail(portfolio, alerts, siteUrl) {
  const n = alerts.length;
  const worst = Math.max(...alerts.map((a) => a.drawdownPct));
  const subject = n === 1
    ? `${alerts[0].schemeName} is ${alerts[0].drawdownPct.toFixed(1)}% below its 52-week high`
    : `${n} funds in "${portfolio.name}" fell past an alert step (worst: -${worst.toFixed(1)}%)`;
  const lines = alerts.map((a) =>
    `• ${a.schemeName}\n  NAV ${fmtNav(a.latestNav)} on ${a.latestDate}, 52-week high ${fmtNav(a.peakNav)} on ${a.peakDate}`
    + `\n  Down ${a.drawdownPct.toFixed(2)}% (crossed -${a.stepPct}%)${a.value ? `, holding now ${fmtInr(a.value)}` : ''}`);
  const text = `Portfolio: ${portfolio.name}\n\n${lines.join('\n\n')}\n\n`
    + `You'll hear again only if a fund falls another ${portfolio.thresholdPct}% step, or recovers and falls back.\n`
    + `Manage alerts: ${siteUrl}/tools/mf-alerts\n`;
  const rows = alerts.map((a) => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(a.schemeName)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(fmtNav(a.latestNav))}<br><span style="color:#6b7280;font-size:12px;">${escapeHtml(a.latestDate)}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(fmtNav(a.peakNav))}<br><span style="color:#6b7280;font-size:12px;">${escapeHtml(a.peakDate)}</span></td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;color:#b91c1c;font-weight:700;">-${escapeHtml(a.drawdownPct.toFixed(2))}%</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right;">${escapeHtml(a.value ? fmtInr(a.value) : '—')}</td>
    </tr>`).join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:680px;">
  <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Portfolio</p>
  <h2 style="margin:0 0 16px;font-size:18px;">${escapeHtml(portfolio.name)}</h2>
  <table style="border-collapse:collapse;width:100%;font-size:14px;">
    <thead><tr style="background:#f3f4f6;text-align:left;">
      <th style="padding:8px 10px;">Fund</th><th style="padding:8px 10px;text-align:right;">Latest NAV</th>
      <th style="padding:8px 10px;text-align:right;">52-week high</th><th style="padding:8px 10px;text-align:right;">Down</th>
      <th style="padding:8px 10px;text-align:right;">Holding</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="font-size:13px;color:#4b5563;margin:16px 0 4px;">You'll hear again only if a fund falls another ${escapeHtml(portfolio.thresholdPct)}% step, or recovers and falls back.</p>
  <p style="font-size:13px;margin:0;"><a href="${escapeHtml(siteUrl)}/tools/mf-alerts">Manage alerts</a></p>
</div>`;
  return { subject, text, html };
}

// Normalizes and checks a portfolio from the API. Throws Error with a message
// fit to show the user. The owner is set by the API from the session, never
// taken from the request.
export function validatePortfolio(input) {
  if (!input || typeof input !== 'object') throw new Error('Expected a portfolio object.');
  const name = String(input.name || '').trim();
  if (!name || name.length > 80) throw new Error('Give the portfolio a name (up to 80 characters).');
  const thresholdPct = input.thresholdPct === undefined || input.thresholdPct === '' ? DEFAULT_THRESHOLD : Number(input.thresholdPct);
  if (!(thresholdPct >= 1 && thresholdPct <= 50)) throw new Error('Alert step must be between 1% and 50%.');
  const funds = Array.isArray(input.funds) ? input.funds : [];
  if (!funds.length) throw new Error('Add at least one fund.');
  if (funds.length > LIMITS.fundsPerPortfolio) throw new Error(`At most ${LIMITS.fundsPerPortfolio} funds per portfolio.`);
  const seen = new Set();
  const clean = funds.map((f) => {
    const schemeCode = String(f && f.schemeCode || '').trim();
    if (!/^\d{3,7}$/.test(schemeCode)) throw new Error(`"${schemeCode}" isn't an AMFI scheme code.`);
    if (seen.has(schemeCode)) throw new Error(`Scheme ${schemeCode} is listed twice.`);
    seen.add(schemeCode);
    const schemeName = String(f.schemeName || '').trim().slice(0, 160) || `Scheme ${schemeCode}`;
    const units = f.units === undefined || f.units === null || f.units === '' ? null : Number(f.units);
    if (units !== null && !(units > 0 && units < 1e9)) throw new Error(`Units for ${schemeName} must be a positive number (or left empty).`);
    return { schemeCode, schemeName, units };
  });
  const id = input.id && /^[a-z0-9-]{6,40}$/.test(input.id) ? input.id : null;
  return { id, name, thresholdPct: +thresholdPct.toFixed(2), funds: clean };
}

// mfapi.in is a free service that occasionally times out, so each fetch has a
// timeout and up to 3 attempts with a short backoff.
export async function fetchSchemeHistory(code, fetchImpl = fetch, { attempts = 3, timeoutMs = 15000, backoffMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, backoffMs * attempt));
    try {
      const res = await fetchImpl(NAV_API + encodeURIComponent(code), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`NAV source returned HTTP ${res.status}`);
      const body = await res.json();
      if (!body || !Array.isArray(body.data) || !body.data.length) throw new Error('NAV source returned no data for this scheme');
      return body;
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// One fetch per distinct scheme across all portfolios.
export async function loadNavInfo(codes, fetchImpl = fetch, fetchOpts) {
  const navInfo = {};
  await Promise.all([...new Set(codes.map(String))].map(async (code) => {
    try { navInfo[code] = drawdownFromHistory((await fetchSchemeHistory(code, fetchImpl, fetchOpts)).data); }
    catch (err) { navInfo[code] = { error: err.message }; }
    if (!navInfo[code]) navInfo[code] = { error: 'no usable NAV points' };
  }));
  return navInfo;
}

export async function readJson(kv, key, fallback) {
  const v = await kv.get(key, 'json');
  return v ?? fallback;
}

// The whole check. dryRun: compute and report only — no email, no state change
// (what the site's status view uses). owner: only that user's portfolios
// (others' state is left as is). A portfolio whose email fails keeps its old
// state, so the alert is retried on the next run.
// mailer: async ({ to, subject, text, html }) => { id } | { skipped } (mail.js).
export async function runChecks(env, { dryRun = false, owner = null, mailer = null, fetchImpl = fetch, fetchOpts, now = new Date(), trigger = 'scheduled' } = {}) {
  const kv = env.MF_KV;
  const all = await readJson(kv, 'portfolios', []);
  const portfolios = owner ? all.filter((p) => p.owner === owner) : all;
  const state = await readJson(kv, 'state', {});
  const access = await getAccess(kv);
  const navInfo = await loadNavInfo(portfolios.flatMap((p) => p.funds.map((f) => f.schemeCode)), fetchImpl, fetchOpts);
  const siteUrl = env.SITE_URL || 'https://www.iamabhilash.in';
  const results = [];
  // A full run rebuilds state (dropping deleted portfolios); a per-owner run keeps everyone else's.
  const nextState = owner ? { ...state } : {};
  for (const p of portfolios) {
    const { rows, alerts, nextState: ps } = evaluatePortfolio(p, navInfo, state[p.id] || {}, now);
    const result = { id: p.id, name: p.name, owner: p.owner, rows, alerts: alerts.map((a) => ({ schemeCode: a.schemeCode, schemeName: a.schemeName, drawdownPct: a.drawdownPct, stepPct: a.stepPct })) };
    nextState[p.id] = ps;
    if (alerts.length && !dryRun) {
      try {
        // Access is checked at send time: a revoked owner gets nothing.
        if (!hasAccess(env, access, p.owner)) result.email = { skipped: `${p.owner} no longer has access — email not sent` };
        else if (!mailer) result.email = { skipped: 'no mailer configured — email not sent' };
        else result.email = await mailer({ to: [p.owner], ...renderAlertEmail(p, alerts, siteUrl) });
      } catch (err) {
        result.email = { error: err.message };
      }
      if (!result.email.id) nextState[p.id] = state[p.id] || {};
    }
    results.push(result);
  }
  const summary = {
    at: now.toISOString(), trigger, dryRun, owner,
    portfolios: results.length,
    alertsSent: results.filter((r) => r.email && r.email.id).reduce((n, r) => n + r.alerts.length, 0),
    errors: [
      ...Object.entries(navInfo).filter(([, v]) => v.error).map(([code, v]) => `scheme ${code}: ${v.error}`),
      ...results.filter((r) => r.email && (r.email.error || r.email.skipped)).map((r) => `${r.name}: ${r.email.error || r.email.skipped}`),
    ],
  };
  if (!dryRun) {
    await kv.put('state', JSON.stringify(nextState));
    // lastRun records the scheduled (all-portfolio) runs; per-user manual runs don't overwrite it.
    if (!owner) await kv.put('lastRun', JSON.stringify(summary));
  }
  return { summary, results };
}

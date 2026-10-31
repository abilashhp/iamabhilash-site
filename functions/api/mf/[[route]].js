// API for /tools/mf-alerts (Cloudflare Pages Function). There is no login yet:
// anyone with the link can read and change portfolios. What keeps it from
// being abused as a mail relay is that mail only goes to ALLOWED_EMAILS, and
// test emails are rate-limited. Bindings (Pages project settings): MF_KV (same
// KV namespace as the mf-alerts Worker), ALLOWED_EMAILS, RESEND_API_KEY,
// MAIL_FROM.
//
//   GET    /api/mf/portfolios        list + last run
//   POST   /api/mf/portfolios        create or update one (id in body to update)
//   DELETE /api/mf/portfolios/:id
//   GET    /api/mf/status            dry run: current drawdowns, no email, no state change
//   POST   /api/mf/run               real run now: emails + state, as the schedule would
//   POST   /api/mf/test-email/:id    one test email to a portfolio's approved addresses
import { LIMITS, allowedEmails, readJson, runChecks, sendEmail, validatePortfolio } from '../../../mf-alerts/core.js';

const TEST_EMAIL_COOLDOWN_MS = 10 * 60 * 1000;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export async function onRequest({ request, env, params }) {
  if (!env.MF_KV) return json({ error: 'MF alerts are not configured on this deployment (MF_KV binding missing).' }, 503);
  const [resource, id] = params.route || [];
  const method = request.method;
  try {
    if (resource === 'portfolios' && method === 'GET' && !id) {
      return json({ portfolios: await readJson(env.MF_KV, 'portfolios', []), lastRun: await readJson(env.MF_KV, 'lastRun', null) });
    }
    if (resource === 'portfolios' && method === 'POST' && !id) {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Body must be JSON.' }, 400); }
      const p = validatePortfolio(body, { allowed: allowedEmails(env) });
      const list = await readJson(env.MF_KV, 'portfolios', []);
      const i = p.id ? list.findIndex((x) => x.id === p.id) : -1;
      if (p.id && i < 0) return json({ error: 'That portfolio no longer exists.' }, 404);
      if (i < 0) {
        if (list.length >= LIMITS.portfolios) return json({ error: `At most ${LIMITS.portfolios} portfolios.` }, 400);
        p.id = crypto.randomUUID();
        list.push(p);
      } else list[i] = p;
      // One NAV fetch per distinct scheme per run; Workers cap subrequests.
      const schemes = new Set(list.flatMap((x) => x.funds.map((f) => f.schemeCode)));
      if (schemes.size > LIMITS.distinctSchemes) return json({ error: `Across all portfolios you can track up to ${LIMITS.distinctSchemes} distinct schemes (this would make ${schemes.size}).` }, 400);
      await env.MF_KV.put('portfolios', JSON.stringify(list));
      return json({ portfolio: p });
    }
    if (resource === 'portfolios' && method === 'DELETE' && id) {
      const list = await readJson(env.MF_KV, 'portfolios', []);
      const next = list.filter((x) => x.id !== id);
      if (next.length === list.length) return json({ error: 'No such portfolio.' }, 404);
      await env.MF_KV.put('portfolios', JSON.stringify(next));
      const state = await readJson(env.MF_KV, 'state', {});
      if (state[id]) { delete state[id]; await env.MF_KV.put('state', JSON.stringify(state)); }
      return json({ deleted: id });
    }
    if (resource === 'status' && method === 'GET') {
      const { results } = await runChecks(env, { dryRun: true, trigger: 'status' });
      return json({ results, lastRun: await readJson(env.MF_KV, 'lastRun', null) });
    }
    if (resource === 'run' && method === 'POST') {
      return json(await runChecks(env, { trigger: 'manual' }));
    }
    if (resource === 'test-email' && method === 'POST' && id) {
      const p = (await readJson(env.MF_KV, 'portfolios', [])).find((x) => x.id === id);
      if (!p) return json({ error: 'No such portfolio.' }, 404);
      const allowed = allowedEmails(env);
      const to = p.emails.filter((e) => allowed.has(e));
      if (!to.length) return json({ error: 'None of this portfolio\'s addresses are on the approved recipient list.' }, 400);
      const key = `testEmail:${p.id}`;
      const last = Number(await env.MF_KV.get(key)) || 0;
      const wait = last + TEST_EMAIL_COOLDOWN_MS - Date.now();
      if (wait > 0) return json({ error: `A test email was sent recently — try again in ${Math.ceil(wait / 60000)} min.` }, 429);
      const text = `This is a test from your MF drawdown alerts for "${p.name}". Real alerts arrive when a fund falls ${p.thresholdPct}% below its 52-week high, and again at each further ${p.thresholdPct}% step.`;
      const result = await sendEmail(env, { to, subject: `Test: MF alerts for "${p.name}"`, text, html: `<p>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>` });
      if (result.skipped) return json(result, 503);
      // KV entries need a TTL of at least 60s; the cooldown is longer anyway.
      await env.MF_KV.put(key, String(Date.now()), { expirationTtl: TEST_EMAIL_COOLDOWN_MS / 1000 });
      return json({ ...result, to });
    }
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    return json({ error: err.message }, 400);
  }
}

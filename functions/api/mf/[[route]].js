// API for /tools/mf-alerts (Cloudflare Pages Function). Every route needs the
// owner's passphrase in the x-mf-passphrase header, checked against the
// ADMIN_PASSPHRASE secret. Bindings (Pages project settings): MF_KV (same KV
// namespace as the mf-alerts Worker), ADMIN_PASSPHRASE, RESEND_API_KEY,
// MAIL_FROM.
//
//   GET    /api/mf/portfolios        list + last run
//   POST   /api/mf/portfolios        create or update one (id in body to update)
//   DELETE /api/mf/portfolios/:id
//   GET    /api/mf/status            dry run: current drawdowns, no email, no state change
//   POST   /api/mf/run               real run now: emails + state, as the schedule would
//   POST   /api/mf/test-email/:id    one test email to a portfolio's addresses
import { LIMITS, readJson, runChecks, sendEmail, validatePortfolio } from '../../../mf-alerts/core.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
// Compares fixed-length digests in constant time, so response timing says
// nothing about how much of a guess was right.
async function passphraseOk(given, expected) {
  const [a, b] = await Promise.all([digest(given || ''), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function onRequest({ request, env, params }) {
  if (!env.MF_KV || !env.ADMIN_PASSPHRASE) return json({ error: 'MF alerts are not configured on this deployment (MF_KV / ADMIN_PASSPHRASE missing).' }, 503);
  if (!(await passphraseOk(request.headers.get('x-mf-passphrase'), env.ADMIN_PASSPHRASE))) {
    await new Promise((r) => setTimeout(r, 750)); // slow down guessing
    return json({ error: 'Wrong passphrase.' }, 401);
  }
  const [resource, id] = params.route || [];
  const method = request.method;
  try {
    if (resource === 'portfolios' && method === 'GET' && !id) {
      return json({ portfolios: await readJson(env.MF_KV, 'portfolios', []), lastRun: await readJson(env.MF_KV, 'lastRun', null) });
    }
    if (resource === 'portfolios' && method === 'POST' && !id) {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Body must be JSON.' }, 400); }
      const p = validatePortfolio(body);
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
      return json({ results, state: await readJson(env.MF_KV, 'state', {}), lastRun: await readJson(env.MF_KV, 'lastRun', null) });
    }
    if (resource === 'run' && method === 'POST') {
      return json(await runChecks(env, { trigger: 'manual' }));
    }
    if (resource === 'test-email' && method === 'POST' && id) {
      const p = (await readJson(env.MF_KV, 'portfolios', [])).find((x) => x.id === id);
      if (!p) return json({ error: 'No such portfolio.' }, 404);
      const text = `This is a test from your MF drawdown alerts for "${p.name}". Real alerts arrive when a fund falls ${p.thresholdPct}% below its 52-week high, and again at each further ${p.thresholdPct}% step.`;
      const result = await sendEmail(env, { to: p.emails, subject: `Test: MF alerts for "${p.name}"`, text, html: `<p>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>` });
      return json(result, result.skipped ? 503 : 200);
    }
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    return json({ error: err.message }, 400);
  }
}

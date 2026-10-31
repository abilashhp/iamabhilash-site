// HTTP API behind /tools/mf-alerts, served by functions/api/mf/[[route]].js.
// Kept free of runtime-only imports (the mailer is passed in) so it can be
// tested in Node.
//
// Public:   POST auth/code {email}           email a sign-in code (granted emails only)
//           POST auth/verify {email, code}   sign in; sets the session cookie
//           POST access/request {email, note}
//           GET  me                          { email, admin } or { email: null }
// Signed in: POST auth/logout
//           GET/POST portfolios, DELETE portfolios/:id   (own portfolios only)
//           GET status, POST run, POST test-email/:id     (own portfolios only)
// Master:   GET access, POST access/grant | access/revoke | access/dismiss {email}
import { LIMITS, readJson, runChecks, validatePortfolio } from './core.js';
import {
  dismissRequest, endSession, getAccess, grantAccess, isAdmin, requestAccess, requestCode, revokeAccess,
  sessionCookie, sessionUser, verifyCode,
} from './auth.js';

const TEST_EMAIL_COOLDOWN_S = 600;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function body(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Body must be JSON.'); }
}

// waitUntil (from the Pages context) lets work finish after the response; without
// it (tests) that work is awaited. fetchImpl is for tests.
export async function handle({ request, env, params, waitUntil }, { mailer, fetchImpl = fetch }) {
  const background = (promise) => (waitUntil ? waitUntil(promise) : promise);
  if (!env.MF_KV) return json({ error: 'MF alerts are not configured on this deployment (MF_KV binding missing).' }, 503);
  if (!env.MASTER_EMAIL) return json({ error: 'MF alerts are not configured on this deployment (MASTER_EMAIL missing).' }, 503);
  const [resource, sub] = params.route || [];
  const method = request.method;
  // Browsers always send Origin on these requests; a different one means another
  // site is trying to act with the visitor's cookie.
  const origin = request.headers.get('origin');
  if (method !== 'GET' && origin && origin !== new URL(request.url).origin) return json({ error: 'Cross-site request refused.' }, 403);
  try {
    // ---------- public ----------
    if (resource === 'auth' && sub === 'code' && method === 'POST') {
      const r = await requestCode(env, (await body(request)).email, mailer);
      if (r.status === 'no-access') return json({ error: 'This email doesn\'t have access yet. You can request it below.', noAccess: true }, 403);
      if (r.status === 'wait') return json({ error: `Please wait ${r.seconds}s before asking for another code.` }, 429);
      if (r.status === 'mail-failed') return json({ error: `Couldn't send the code: ${r.error}` }, 502);
      return json({ sent: true });
    }
    if (resource === 'auth' && sub === 'verify' && method === 'POST') {
      const b = await body(request);
      let session;
      try { session = await verifyCode(env, b.email, b.code); } catch (err) { throw new HttpError(401, err.message); }
      return json({ email: session.email, admin: isAdmin(env, session.email) }, 200, { 'set-cookie': sessionCookie(session.token) });
    }
    if (resource === 'access' && sub === 'request' && method === 'POST') {
      const b = await body(request);
      return json(await requestAccess(env, b.email, b.note, mailer));
    }
    const user = await sessionUser(env, request);
    if (resource === 'me' && method === 'GET') return json({ email: user, admin: isAdmin(env, user) });
    if (resource === 'auth' && sub === 'logout' && method === 'POST') {
      await endSession(env, request);
      return json({ signedOut: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    }

    // ---------- signed in ----------
    if (!user) return json({ error: 'Please sign in.', signedOut: true }, 401);

    if (resource === 'portfolios' && method === 'GET' && !sub) {
      return json({ portfolios: (await readJson(env.MF_KV, 'portfolios', [])).filter((p) => p.owner === user) });
    }
    if (resource === 'portfolios' && method === 'POST' && !sub) {
      const p = validatePortfolio(await body(request));
      const list = await readJson(env.MF_KV, 'portfolios', []);
      const i = p.id ? list.findIndex((x) => x.id === p.id && x.owner === user) : -1;
      if (p.id && i < 0) return json({ error: 'That portfolio no longer exists.' }, 404);
      p.owner = user;
      if (i < 0) {
        if (list.filter((x) => x.owner === user).length >= LIMITS.portfoliosPerUser) return json({ error: `At most ${LIMITS.portfoliosPerUser} portfolios per person.` }, 400);
        if (list.length >= LIMITS.portfolios) return json({ error: 'The site has reached its portfolio limit.' }, 400);
        p.id = crypto.randomUUID();
        list.push(p);
      } else list[i] = p;
      // One NAV fetch per distinct scheme per run; Workers cap subrequests.
      const schemes = new Set(list.flatMap((x) => x.funds.map((f) => f.schemeCode)));
      if (schemes.size > LIMITS.distinctSchemes) return json({ error: `The site can track up to ${LIMITS.distinctSchemes} distinct schemes across everyone's portfolios (this would make ${schemes.size}).` }, 400);
      await env.MF_KV.put('portfolios', JSON.stringify(list));
      // Funds already past a step are emailed right away rather than at the next
      // daily check; steps already emailed aren't repeated.
      await background(runChecks(env, { owner: user, mailer, fetchImpl, trigger: 'saved' }).catch(() => {}));
      return json({ portfolio: p });
    }
    if (resource === 'portfolios' && method === 'DELETE' && sub) {
      const list = await readJson(env.MF_KV, 'portfolios', []);
      const next = list.filter((x) => !(x.id === sub && x.owner === user));
      if (next.length === list.length) return json({ error: 'No such portfolio.' }, 404);
      await env.MF_KV.put('portfolios', JSON.stringify(next));
      const state = await readJson(env.MF_KV, 'state', {});
      if (state[sub]) { delete state[sub]; await env.MF_KV.put('state', JSON.stringify(state)); }
      return json({ deleted: sub });
    }
    if (resource === 'status' && method === 'GET') {
      const { results } = await runChecks(env, { dryRun: true, owner: user, fetchImpl, trigger: 'status' });
      return json({ results, lastRun: await readJson(env.MF_KV, 'lastRun', null) });
    }
    if (resource === 'run' && method === 'POST') {
      return json(await runChecks(env, { owner: user, mailer, fetchImpl, trigger: 'manual' }));
    }
    if (resource === 'test-email' && method === 'POST' && sub) {
      const p = (await readJson(env.MF_KV, 'portfolios', [])).find((x) => x.id === sub && x.owner === user);
      if (!p) return json({ error: 'No such portfolio.' }, 404);
      const key = `testEmail:${p.id}`;
      if (await env.MF_KV.get(key)) return json({ error: 'A test email was sent in the last 10 minutes — check your inbox (and spam).' }, 429);
      const text = `This is a test from MF Alerts for "${p.name}". Real alerts arrive when a fund falls ${p.thresholdPct}% below its 52-week high, and again at each further ${p.thresholdPct}% step.`;
      const r = await mailer({ to: [user], subject: `Test: MF Alerts for "${p.name}"`, text, html: `<p>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>` })
        .catch((err) => ({ error: `Couldn't send: ${err.message}` }));
      if (r.skipped || r.error) return json({ error: r.skipped || r.error }, r.skipped ? 503 : 502);
      await env.MF_KV.put(key, '1', { expirationTtl: TEST_EMAIL_COOLDOWN_S });
      return json({ ...r, to: [user] });
    }

    // ---------- master ----------
    if (resource === 'access') {
      if (!isAdmin(env, user)) return json({ error: 'Only the master account can manage access.' }, 403);
      if (method === 'GET' && !sub) {
        const a = await getAccess(env.MF_KV);
        return json({
          users: Object.entries(a.users).map(([email, u]) => ({ email, ...u })).sort((x, y) => x.email.localeCompare(y.email)),
          requests: Object.entries(a.requests).map(([email, r]) => ({ email, ...r })).sort((x, y) => x.at.localeCompare(y.at)),
        });
      }
      const b = method === 'POST' ? await body(request) : {};
      if (method === 'POST' && sub === 'grant') return json(await grantAccess(env, b.email, user, mailer));
      if (method === 'POST' && sub === 'revoke') return json(await revokeAccess(env, b.email));
      if (method === 'POST' && sub === 'dismiss') { await dismissRequest(env, b.email); return json({ dismissed: true }); }
    }
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    return json({ error: err.message }, err.status || 400);
  }
}

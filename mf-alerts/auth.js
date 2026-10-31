// Access control for MF alerts: an access list managed by the master account,
// and passwordless sign-in with a 6-digit code emailed to the address.
//
// MASTER_EMAIL (setting) is always allowed and is the only admin. KV keys:
//   access            { users: { [email]: { grantedAt, grantedBy } }, requests: { [email]: { at, note } } }
//   otp:<email>       { hash, attempts }                 TTL 10 min
//   session:<sha256>  { email, createdAt }               TTL 30 days (the cookie holds the raw token)
//   rl:<name>         { count, first, last }             rate-limit counters

export const CODE_TTL_S = 600;
export const SESSION_TTL_S = 30 * 86400;
export const COOKIE = 'mf_session';
const MAX_CODE_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[A-Za-z]{2,}$/;

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const isEmail = (e) => EMAIL_RE.test(e) && e.length <= 254;
export const masterEmail = (env) => normEmail(env.MASTER_EMAIL);
export const isAdmin = (env, email) => !!email && email === masterEmail(env);

async function sha256Hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomCode() {
  // Rejection sampling keeps all 1,000,000 codes equally likely.
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4294000000);
  return String(a[0] % 1000000).padStart(6, '0');
}

export async function getAccess(kv) {
  const a = (await kv.get('access', 'json')) || {};
  return { users: a.users || {}, requests: a.requests || {} };
}
export function hasAccess(env, access, email) {
  return !!email && (isAdmin(env, email) || Object.prototype.hasOwnProperty.call(access.users, email));
}

// Fixed-window counter: at most `max` events per `windowS`, and (optionally)
// `minGapS` between events. Returns seconds to wait, or 0 if allowed (and counts it).
export async function rateLimit(kv, name, { max, windowS, minGapS = 0 }, now = Date.now()) {
  const key = `rl:${name}`;
  let r = await kv.get(key, 'json');
  if (!r || now - r.first > windowS * 1000) r = { count: 0, first: now, last: 0 };
  if (minGapS && now - r.last < minGapS * 1000) return Math.ceil((r.last + minGapS * 1000 - now) / 1000);
  if (r.count >= max) return Math.ceil((r.first + windowS * 1000 - now) / 1000);
  r.count++; r.last = now;
  await kv.put(key, JSON.stringify(r), { expirationTtl: Math.max(60, windowS) });
  return 0;
}

const signInUrl = (env) => `${env.SITE_URL || 'https://www.iamabhilash.in'}/tools/mf-alerts`;

// → { status: 'sent' } | { status: 'no-access' } | { status: 'wait', seconds } | { status: 'mail-failed', error }
export async function requestCode(env, rawEmail, mailer) {
  const email = normEmail(rawEmail);
  if (!isEmail(email)) throw new Error('Enter a valid email address.');
  if (!hasAccess(env, await getAccess(env.MF_KV), email)) return { status: 'no-access' };
  const wait = await rateLimit(env.MF_KV, `code:${email}`, { max: 5, windowS: 3600, minGapS: 60 });
  if (wait) return { status: 'wait', seconds: wait };
  const code = randomCode();
  await env.MF_KV.put(`otp:${email}`, JSON.stringify({ hash: await sha256Hex(`${email}:${code}`), attempts: 0 }), { expirationTtl: CODE_TTL_S });
  const text = `Your MF Alerts sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't try to sign in at ${signInUrl(env)}, ignore this email.`;
  const r = await mailer({ to: [email], subject: `${code} is your MF Alerts sign-in code`, text, html: `<p>Your MF Alerts sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p><p style="color:#6b7280;">It expires in 10 minutes. If you didn't try to sign in, ignore this email.</p>` })
    .catch((err) => ({ error: err.message }));
  if (r.skipped || r.error) return { status: 'mail-failed', error: r.skipped || r.error };
  return { status: 'sent' };
}

// → raw session token on success; throws with a user-facing message otherwise.
export async function verifyCode(env, rawEmail, rawCode) {
  const email = normEmail(rawEmail);
  const code = String(rawCode || '').replace(/\s+/g, '');
  const key = `otp:${email}`;
  const rec = await env.MF_KV.get(key, 'json');
  if (!rec) throw new Error('That code has expired or was never sent — request a new one.');
  if (rec.attempts >= MAX_CODE_ATTEMPTS) { await env.MF_KV.delete(key); throw new Error('Too many wrong codes — request a new one.'); }
  if (!/^\d{6}$/.test(code) || (await sha256Hex(`${email}:${code}`)) !== rec.hash) {
    rec.attempts++;
    await env.MF_KV.put(key, JSON.stringify(rec), { expirationTtl: CODE_TTL_S });
    throw new Error(`Wrong code (${MAX_CODE_ATTEMPTS - rec.attempts} tries left).`);
  }
  if (!hasAccess(env, await getAccess(env.MF_KV), email)) { await env.MF_KV.delete(key); throw new Error('This email no longer has access.'); }
  await env.MF_KV.delete(key);
  const token = randomToken();
  await env.MF_KV.put(`session:${await sha256Hex(token)}`, JSON.stringify({ email, createdAt: new Date().toISOString() }), { expirationTtl: SESSION_TTL_S });
  return { email, token };
}

export function sessionCookie(token, maxAge = SESSION_TTL_S) {
  return `${COOKIE}=${token}; Path=/api/mf; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function tokenFrom(request) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`).exec(request.headers.get('cookie') || '');
  return m ? m[1] : null;
}
// The signed-in email, re-checked against the access list on every request so
// revoking takes effect immediately.
export async function sessionUser(env, request) {
  const token = tokenFrom(request);
  if (!token) return null;
  const s = await env.MF_KV.get(`session:${await sha256Hex(token)}`, 'json');
  if (!s || !hasAccess(env, await getAccess(env.MF_KV), s.email)) return null;
  return s.email;
}
export async function endSession(env, request) {
  const token = tokenFrom(request);
  if (token) await env.MF_KV.delete(`session:${await sha256Hex(token)}`);
}

export async function requestAccess(env, rawEmail, rawNote, mailer) {
  const email = normEmail(rawEmail);
  if (!isEmail(email)) throw new Error('Enter a valid email address.');
  const note = String(rawNote || '').trim().slice(0, 300);
  const access = await getAccess(env.MF_KV);
  if (hasAccess(env, access, email)) return { status: 'already' };
  if (access.requests[email]) return { status: 'pending' };
  if (Object.keys(access.requests).length >= 50) throw new Error('Too many pending requests right now — try again later.');
  // Caps the emails a stranger can make the master receive.
  const wait = await rateLimit(env.MF_KV, 'access-requests', { max: 10, windowS: 3600 });
  if (wait) throw new Error('Too many access requests right now — try again later.');
  access.requests[email] = { at: new Date().toISOString(), note };
  await env.MF_KV.put('access', JSON.stringify(access));
  const master = masterEmail(env);
  if (master) {
    await mailer({
      to: [master], subject: `MF Alerts: ${email} requested access`,
      text: `${email} asked to use MF Alerts.${note ? `\n\nNote: ${note}` : ''}\n\nApprove or dismiss it in the Access panel: ${signInUrl(env)}`,
      html: `<p><b>${escapeHtml(email)}</b> asked to use MF Alerts.</p>${note ? `<p>Note: ${escapeHtml(note)}</p>` : ''}<p><a href="${escapeHtml(signInUrl(env))}">Open the Access panel</a> to approve or dismiss it.</p>`,
    }).catch(() => {}); // the request is saved either way
  }
  return { status: 'requested' };
}

export async function grantAccess(env, rawEmail, by, mailer) {
  const email = normEmail(rawEmail);
  if (!isEmail(email)) throw new Error('Enter a valid email address.');
  const access = await getAccess(env.MF_KV);
  const fresh = !access.users[email] && !isAdmin(env, email);
  if (fresh) access.users[email] = { grantedAt: new Date().toISOString(), grantedBy: by };
  delete access.requests[email];
  await env.MF_KV.put('access', JSON.stringify(access));
  let invite = null;
  if (fresh) {
    invite = await mailer({
      to: [email], subject: 'You now have access to MF Alerts',
      text: `You've been given access to MF Alerts, which emails you when a mutual fund falls 5% (or a step you choose) below its 52-week high.\n\nSign in with this email address at ${signInUrl(env)}`,
      html: `<p>You've been given access to MF Alerts, which emails you when a mutual fund falls 5% (or a step you choose) below its 52-week high.</p><p><a href="${escapeHtml(signInUrl(env))}">Sign in with this email address</a>.</p>`,
    }).catch((err) => ({ error: err.message }));
  }
  return { email, invited: !!(invite && invite.id), inviteError: invite && (invite.error || invite.skipped) };
}

// Keeps the person's portfolios (alerts stop because they no longer have
// access) so re-granting restores them.
export async function revokeAccess(env, rawEmail) {
  const email = normEmail(rawEmail);
  if (isAdmin(env, email)) throw new Error("The master account can't be revoked.");
  const access = await getAccess(env.MF_KV);
  delete access.users[email];
  delete access.requests[email];
  await env.MF_KV.put('access', JSON.stringify(access));
  return { email };
}
export async function dismissRequest(env, rawEmail) {
  const access = await getAccess(env.MF_KV);
  delete access.requests[normEmail(rawEmail)];
  await env.MF_KV.put('access', JSON.stringify(access));
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

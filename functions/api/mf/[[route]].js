// /api/mf/* for /tools/mf-alerts. The routes live in mf-alerts/api.js; this
// file only supplies the Gmail mailer, which needs the Workers socket API.
// Pages project settings: MF_KV (KV binding shared with the mf-alerts Worker),
// MASTER_EMAIL, GMAIL_USER, GMAIL_APP_PASSWORD (secret).
import { connect } from 'cloudflare:sockets';
import { handle } from '../../../mf-alerts/api.js';
import { createMailer } from '../../../mf-alerts/mail.js';

export function onRequest(context) {
  return handle({ ...context, waitUntil: (p) => context.waitUntil(p) }, { mailer: createMailer(context.env, connect) });
}

// Minimal SMTP client for sending through Gmail (smtp.gmail.com:465, implicit
// TLS) from Cloudflare Workers / Pages Functions, authenticated with a Gmail
// app password. The socket factory is passed in (cloudflare:sockets' connect
// in production, a scripted fake in tests), so this module has no runtime
// imports.
//
// Settings: GMAIL_USER (the sending Gmail address), GMAIL_APP_PASSWORD
// (secret), optional SMTP_HOST / SMTP_PORT / SMTP_SECURE ('on' | 'starttls' |
// 'off', the last for local testing only).

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64Utf8 = (str) => b64(enc.encode(str));
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');
// RFC 2047 encoded word: user text in a header can't inject CRLF or new headers.
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64Utf8(s)}?=`);
const ADDRESS = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+$/;

export function buildMessage({ from, fromName, to, subject, text, html, now = new Date(), id = crypto.randomUUID() }) {
  for (const a of [from, ...to]) if (!ADDRESS.test(a)) throw new Error(`refusing to send to/from malformed address "${a}"`);
  const boundary = `b_${id}`;
  const domain = from.split('@')[1];
  return [
    `From: ${fromName ? `${encodeHeader(fromName)} ` : ''}<${from}>`,
    `To: ${to.map((a) => `<${a}>`).join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64Utf8(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64Utf8(html)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// Reads SMTP replies (multi-line "250-…" until "250 …") off a byte stream.
function replyReader(readable) {
  const reader = readable.getReader();
  let buf = '';
  return {
    async read() {
      const lines = [];
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          lines.push(line);
          if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) return { code: Number(line.slice(0, 3)), text: lines.join(' | ') };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('connection closed by the mail server');
        buf += dec.decode(value, { stream: true });
      }
    },
    release() { try { reader.releaseLock(); } catch { /* already released */ } },
  };
}

export async function smtpSend({ connect, host, port, secure, user, pass, from, to, message, heloName = 'iamabhilash.in' }) {
  let socket = connect({ hostname: host, port }, { secureTransport: secure, allowHalfOpen: false });
  let reader = replyReader(socket.readable);
  let writer = socket.writable.getWriter();
  const send = (line) => writer.write(enc.encode(line + '\r\n'));
  async function expect(stage, ok) {
    const r = await reader.read();
    if (!ok.includes(r.code)) throw new Error(`mail server rejected ${stage}: ${r.code} ${r.text.slice(0, 200)}`);
    return r;
  }
  try {
    await expect('connection', [220]);
    await send(`EHLO ${heloName}`);
    await expect('EHLO', [250]);
    if (secure === 'starttls') {
      await send('STARTTLS');
      await expect('STARTTLS', [220]);
      reader.release(); writer.releaseLock();
      socket = socket.startTls();
      reader = replyReader(socket.readable);
      writer = socket.writable.getWriter();
      await send(`EHLO ${heloName}`);
      await expect('EHLO after STARTTLS', [250]);
    }
    await send(`AUTH PLAIN ${b64Utf8(`\0${user}\0${pass}`)}`);
    await expect('login (check GMAIL_USER / GMAIL_APP_PASSWORD)', [235]);
    await send(`MAIL FROM:<${from}>`);
    await expect('sender', [250]);
    for (const rcpt of to) {
      await send(`RCPT TO:<${rcpt}>`);
      await expect(`recipient ${rcpt}`, [250, 251]);
    }
    await send('DATA');
    await expect('DATA', [354]);
    // Dot-stuffing: a line starting with "." gets another one.
    await writer.write(enc.encode(message.replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n'));
    const done = await expect('message', [250]);
    await send('QUIT').catch(() => {});
    return { id: done.text.slice(4, 120) };
  } finally {
    try { await writer.close(); } catch { /* socket may already be gone */ }
    try { await socket.close(); } catch { /* ignore */ }
  }
}

// Returns async ({ to, subject, text, html }) => { id } | { skipped }, or a
// mailer that always skips when Gmail isn't configured.
export function createMailer(env, connect, { timeoutMs = 20000 } = {}) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    return async () => ({ skipped: 'Gmail is not configured (GMAIL_USER / GMAIL_APP_PASSWORD) — email not sent' });
  }
  const host = env.SMTP_HOST || 'smtp.gmail.com';
  const secure = env.SMTP_SECURE || 'on';
  const port = Number(env.SMTP_PORT) || (secure === 'starttls' ? 587 : 465);
  return async ({ to, subject, text, html }) => {
    const message = buildMessage({ from: env.GMAIL_USER, fromName: env.MAIL_FROM_NAME || 'MF Alerts', to, subject, text, html });
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('mail server timed out')), timeoutMs); });
    try {
      return await Promise.race([smtpSend({ connect, host, port, secure, user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD, from: env.GMAIL_USER, to, message }), timeout]);
    } finally { clearTimeout(timer); }
  };
}

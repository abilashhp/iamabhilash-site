// Run: npm test
// The SMTP client against a scripted in-memory mail server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, smtpSend, createMailer } from '../../mf-alerts/mail.js';

const dec = new TextDecoder();
const enc = new TextEncoder();

// connect() stand-in: a fake SMTP server that checks AUTH PLAIN credentials.
function fakeSmtp({ user = 'me@gmail.com', pass = 'abcd efgh ijkl mnop', rejectRcpt = null } = {}) {
  const log = { commands: [], data: null, connects: [] };
  const connect = (addr, opts) => {
    log.connects.push({ ...addr, ...opts });
    let ctl;
    const readable = new ReadableStream({ start(c) { ctl = c; } });
    const reply = (s) => ctl.enqueue(enc.encode(s));
    reply('220 smtp.test ESMTP ready\r\n');
    let buf = '', inData = false;
    const writable = new WritableStream({
      write(chunk) {
        buf += dec.decode(chunk);
        for (;;) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) return;
            log.data = buf.slice(0, end);
            buf = buf.slice(end + 5);
            inData = false;
            reply('250 2.0.0 OK queued as ABC123\r\n');
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          log.commands.push(line.startsWith('AUTH PLAIN') ? 'AUTH PLAIN ***' : line);
          if (line.startsWith('EHLO')) reply('250-smtp.test\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
          else if (line.startsWith('AUTH PLAIN ')) {
            const [, u, p] = atob(line.slice(11)).split('\0');
            reply(u === user && p === pass ? '235 2.7.0 Accepted\r\n' : '535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 Learn more\r\n');
          } else if (line.startsWith('MAIL FROM:')) reply('250 OK\r\n');
          else if (line.startsWith('RCPT TO:')) reply(rejectRcpt && line.includes(rejectRcpt) ? '550 no such user\r\n' : '250 OK\r\n');
          else if (line === 'DATA') { inData = true; reply('354 go ahead\r\n'); }
          else if (line === 'QUIT') { reply('221 bye\r\n'); ctl.close(); }
        }
      },
    });
    return { readable, writable, close: async () => {}, startTls: () => { throw new Error('not used'); } };
  };
  return { connect, log };
}
const MSG = { to: ['friend@example.com'], subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' };

test('sends through Gmail over implicit TLS with the right SMTP conversation', async () => {
  const { connect, log } = fakeSmtp();
  const mailer = createMailer({ GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', SMTP_HOST: 'smtp.test' }, connect);
  const r = await mailer({ ...MSG, text: 'line one\n.starts with a dot\n' });
  assert.match(r.id, /OK queued as ABC123/);
  assert.deepEqual(log.connects, [{ hostname: 'smtp.test', port: 465, secureTransport: 'on', allowHalfOpen: false }]);
  assert.deepEqual(log.commands, ['EHLO iamabhilash.in', 'AUTH PLAIN ***', 'MAIL FROM:<me@gmail.com>', 'RCPT TO:<friend@example.com>', 'DATA', 'QUIT']);
  assert.match(log.data, /^From: MF Alerts <me@gmail\.com>\r\nTo: <friend@example\.com>\r\nSubject: Hello\r\n/);
  // Bodies are base64, so a leading "." in the text can't end the message early.
  const textPart = /text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/.exec(log.data)[1];
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(textPart.replace(/\r\n/g, '')), (c) => c.charCodeAt(0))), 'line one\n.starts with a dot\n');
});

test('a rejected login is reported without the password', async () => {
  const { connect } = fakeSmtp();
  const mailer = createMailer({ GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'wrong-password' }, connect);
  await assert.rejects(mailer(MSG), (err) => {
    assert.match(err.message, /rejected login \(check GMAIL_USER \/ GMAIL_APP_PASSWORD\): 535 535-5\.7\.8 Username and Password not accepted/);
    assert.ok(!err.message.includes('wrong-password'));
    return true;
  });
});

test('a rejected recipient fails the send', async () => {
  const { connect } = fakeSmtp({ rejectRcpt: 'friend@' });
  const mailer = createMailer({ GMAIL_USER: 'me@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' }, connect);
  await assert.rejects(mailer(MSG), /rejected recipient friend@example\.com: 550/);
});

test('without Gmail settings nothing is sent', async () => {
  const r = await createMailer({}, () => { throw new Error('should not connect'); })(MSG);
  assert.match(r.skipped, /Gmail is not configured/);
});

test('headers with non-ASCII or CR/LF are encoded, and malformed addresses are refused', () => {
  const m = buildMessage({ from: 'me@gmail.com', fromName: 'MF Alerts', to: ['a@x.com'], subject: 'Fund ₹ down\r\nBcc: victim@x.com', text: 't', html: 'h', id: 'fixed' });
  const subject = /^Subject: (.*)$/m.exec(m)[1];
  assert.match(subject, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.ok(!/^Bcc:/m.test(m));
  assert.match(m, /^Message-ID: <fixed@gmail\.com>$/m);
  assert.throws(() => buildMessage({ from: 'me@gmail.com', to: ['a@x.com>\r\nRCPT TO:<b@y.com'], subject: 's', text: 't', html: 'h' }), /malformed address/);
});

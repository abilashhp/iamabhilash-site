#!/usr/bin/env node
// Minimal, dependency-free proxy for the Akamai Edge Diagnostics "grep" API.
//
// Why this exists: the grep API uses EdgeGrid HMAC request signing, which
// needs a client secret that must never be exposed to a browser. This
// process holds that secret, signs requests server-side, and hands the
// browser-facing tool only the resulting log lines. See README-server.md
// for setup.
//
// No npm dependencies on purpose — only Node's built-in http/https/crypto —
// so this matches the rest of the project's "no build step" philosophy.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PULL_LOGS_PORT || 8899;
const SHARED_SECRET = process.env.PULL_LOGS_SHARED_SECRET || '';
const EDGEGRID_HOST = process.env.AKAMAI_HOST || '';
const EDGEGRID_CLIENT_TOKEN = process.env.AKAMAI_CLIENT_TOKEN || '';
const EDGEGRID_CLIENT_SECRET = process.env.AKAMAI_CLIENT_SECRET || '';
const EDGEGRID_ACCESS_TOKEN = process.env.AKAMAI_ACCESS_TOKEN || '';

const MAX_BODY_FOR_SIGNING = 131072; // Akamai EdgeGrid default max-body
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 90000;

function assertConfigured() {
  const missing = [];
  if (!SHARED_SECRET) missing.push('PULL_LOGS_SHARED_SECRET');
  if (!EDGEGRID_HOST) missing.push('AKAMAI_HOST');
  if (!EDGEGRID_CLIENT_TOKEN) missing.push('AKAMAI_CLIENT_TOKEN');
  if (!EDGEGRID_CLIENT_SECRET) missing.push('AKAMAI_CLIENT_SECRET');
  if (!EDGEGRID_ACCESS_TOKEN) missing.push('AKAMAI_ACCESS_TOKEN');
  if (missing.length) {
    console.error('Missing required environment variables:', missing.join(', '));
    console.error('See README-server.md for how to set these.');
    process.exit(1);
  }
}

/* ---------- EdgeGrid request signing ---------- */
/* Implements Akamai's documented EdgeGrid auth scheme directly (HMAC-SHA256
   over method/scheme/host/path/headers/content-hash/auth-header, with a
   per-request signing key derived from a timestamp HMAC). Reference:
   https://techdocs.akamai.com/developer/docs/authenticate-with-edgegrid */
function edgeGridTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+0000`;
}
function edgeGridNonce() {
  const buf = crypto.randomBytes(16);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function signEdgeGridRequest({ method, path, body }) {
  const timestamp = edgeGridTimestamp();
  const nonce = edgeGridNonce();
  const authHeaderNoSig =
    `EG1-HMAC-SHA256 client_token=${EDGEGRID_CLIENT_TOKEN};` +
    `access_token=${EDGEGRID_ACCESS_TOKEN};timestamp=${timestamp};nonce=${nonce};`;

  let contentHash = '';
  if (method === 'POST' && body) {
    const bodyBuf = Buffer.from(body, 'utf8');
    const truncated = bodyBuf.length > MAX_BODY_FOR_SIGNING ? bodyBuf.subarray(0, MAX_BODY_FOR_SIGNING) : bodyBuf;
    contentHash = crypto.createHash('sha256').update(truncated).digest('base64');
  }

  const dataToSign = [method, 'https', EDGEGRID_HOST, path, '', contentHash, authHeaderNoSig].join('\t');
  const signingKey = crypto.createHmac('sha256', EDGEGRID_CLIENT_SECRET).update(timestamp).digest('base64');
  const signature = crypto.createHmac('sha256', signingKey).update(dataToSign).digest('base64');
  return authHeaderNoSig + `signature=${signature}`;
}

function edgeGridRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const authHeader = signEdgeGridRequest({ method, path, body: bodyStr });
    const headers = { Authorization: authHeader };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request({ hostname: EDGEGRID_HOST, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { /* non-JSON error body */ }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runGrep(filters) {
  const body = {
    edgeIp: filters.edgeIp,
    logType: filters.logType || 'BOTH',
    start: filters.start,
    end: filters.end,
  };
  if (filters.hostnames && filters.hostnames.length) body.hostnames = filters.hostnames;
  if (filters.cpCodes && filters.cpCodes.length) body.cpCodes = filters.cpCodes;
  if (filters.clientIps && filters.clientIps.length) body.clientIps = filters.clientIps;
  if (filters.userAgents && filters.userAgents.length) body.userAgents = filters.userAgents;
  if (filters.arlContains && filters.arlContains.length) {
    body.arls = { comparison: 'CONTAINS', value: filters.arlContains };
  }
  if (filters.httpStatusCodes && filters.httpStatusCodes.length) {
    body.httpStatusCodes = { comparison: 'EQUALS', value: filters.httpStatusCodes };
  }

  let res = await edgeGridRequest('POST', '/edge-diagnostics/v1/grep', body);
  if (res.status !== 202 && res.status !== 200) {
    return { ok: false, status: res.status, error: res.body || res.raw };
  }

  let job = res.body;
  const startedAt = Date.now();
  while (job && job.executionStatus === 'IN_PROGRESS') {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      return { ok: false, status: 202, error: { message: 'Timed out waiting for grep job to finish. It may still complete — try again shortly with the same requestId.', requestId: job.requestId } };
    }
    await sleep(job.retryAfter ? job.retryAfter * 1000 : POLL_INTERVAL_MS);
    const poll = await edgeGridRequest('GET', `/edge-diagnostics/v1/grep/requests/${job.requestId}`);
    if (poll.status !== 200) return { ok: false, status: poll.status, error: poll.body || poll.raw };
    job = poll.body;
  }

  if (!job || job.executionStatus === 'FAILURE') {
    return { ok: false, status: 200, error: (job && job.errorResponse) || 'Grep request failed with no further detail.' };
  }
  return { ok: true, job };
}

/* ---------- Convert Akamai's structured log entries into the same
   space-delimited positional format our client-side parser already reads.
   Every field is space-escaped (spaces -> %20) since the array is later
   joined with ' ' and re-split the same way on the client; an unescaped
   space in any value would silently shift every field after it. ---------- */
function esc(v) {
  if (v === undefined || v === null || v === '') return '-';
  return String(v).replace(/\s+/g, '%20');
}
function toEpochSeconds(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (t / 1000).toFixed(3) : '-';
}
function buildRLine(e) {
  const f = new Array(91).fill('-');
  f[1] = 'r';
  f[2] = toEpochSeconds(e.dateTime);
  f[5] = esc(e.turnaroundTime);
  f[9] = esc(e.bytesServed);
  f[10] = esc(e.clientIp);
  f[11] = esc(e.httpMethod);
  f[12] = esc(e.arl);
  f[13] = esc(e.httpStatus);
  f[14] = esc(e.error);
  f[15] = esc(e.objectStatus);
  f[16] = esc(e.contentType);
  f[17] = esc(e.hostHeader);
  f[18] = esc(e.cookie);
  f[19] = esc(e.referer);
  f[20] = esc(e.userAgent);
  f[48] = esc(e.objectStatus2);
  f[52] = esc(e.objectStatus3);
  return f.join(' ');
}
function buildFLine(e) {
  const f = new Array(63).fill('-');
  f[1] = 'f';
  f[2] = toEpochSeconds(e.dateTime);
  f[6] = esc(e.turnaroundTime);
  f[9] = esc(e.bytesReceived);
  f[10] = esc(e.forwardIp);
  f[11] = esc(e.clientIp);
  f[12] = esc(e.httpMethod);
  f[13] = esc(e.arl);
  f[14] = esc(e.httpStatus);
  f[15] = esc(e.contentType);
  f[18] = esc(e.objectStatus);
  f[23] = esc(e.forwardIp); // no resolved forward hostname in this API; IP is the closest available
  return f.join(' ');
}
function apiLogsToLines(logs) {
  return logs.map((e) => (e.logType === 'f' ? buildFLine(e) : buildRLine(e)));
}

/* ---------- HTTP server ---------- */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url !== '/api/pull-logs' || req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let input;
    try { input = JSON.parse(body || '{}'); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
      return;
    }

    const providedKey = req.headers['x-api-key'] || input.apiKey;
    if (!providedKey || providedKey !== SHARED_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing or invalid API key' }));
      return;
    }
    if (!input.edgeIp || !input.start || !input.end) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'edgeIp, start, and end are required' }));
      return;
    }

    try {
      const result = await runGrep(input);
      if (!result.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: result.error }));
        return;
      }
      const logs = (result.job.result && result.job.result.logs) || [];
      const lines = apiLogsToLines(logs);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        requestId: result.job.requestId,
        executionStatus: result.job.executionStatus,
        warning: result.job.warning,
        logLinesCount: logs.length,
        edgeIpLocation: result.job.edgeIpLocation,
        lines,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
    }
  });
});

assertConfigured();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`pull-logs proxy listening on 127.0.0.1:${PORT}`);
});

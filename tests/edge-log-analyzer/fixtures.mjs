// Synthetic Ghost log lines built on the tool's own field map, plus a seeded
// random "realistic" dataset used for drill-down parity tests.
export function makeTools(T) {
  const { RF, FF, SF } = T;
  function r(o = {}) {
    const f = new Array(91).fill('-');
    f[RF.edgeIp] = o.edge ?? '23.1.1.1'; f[RF.type] = 'r'; f[RF.ts] = String(o.ts ?? 1700000000);
    f[RF.turnaround] = String(o.lat ?? 10); f[RF.bytes] = String(o.bytes ?? 100); f[RF.clientIp] = o.ip ?? '1.2.3.4';
    f[RF.method] = o.method ?? 'GET'; f[RF.arl] = o.uri ?? '/x'; f[RF.status] = String(o.status ?? 200);
    f[RF.error] = o.err ?? '-'; f[RF.objStatus] = o.os ?? 'd'; f[RF.contentType] = o.ct ?? 'text/html';
    f[RF.host] = o.host ?? 'example.com'; f[RF.ua] = o.ua ?? 'curl/8.0'; f[RF.trueClientIp] = o.tcip ?? '-'; f[RF.waf] = o.waf ?? '-';
    return f.join(' ');
  }
  function fl(o = {}) {
    const f = new Array(63).fill('-');
    f[FF.edgeIp] = o.edge ?? '23.1.1.1'; f[FF.type] = 'f'; f[FF.ts] = String(o.ts ?? 1700000000);
    f[FF.turnaround] = String(o.lat ?? 5); f[FF.forwardIp] = o.fwd ?? '9.9.9.9'; f[FF.clientIp] = o.ip ?? '1.2.3.4';
    f[FF.method] = 'GET'; f[FF.arl] = o.uri ?? '/x'; f[FF.status] = String(o.status ?? 200);
    f[FF.objStatus] = o.os ?? '-'; f[FF.forwardHost] = o.fhost ?? 'origin.example.com'; f[FF.error] = o.err ?? '-';
    return f.join(' ');
  }
  // S record: the client-facing request in the compact layout. `path` is
  // relative to the host, as in real S lines.
  function sl(o = {}) {
    const f = new Array(78).fill('-');
    f[SF.edgeIp] = o.edge ?? '23.1.1.1'; f[SF.type] = 'S'; f[SF.ts] = String(o.ts ?? 1700000000);
    f[SF.turnaround] = String(o.lat ?? 10); f[SF.bytes] = String(o.bytes ?? 100); f[SF.clientIp] = o.ip ?? '1.2.3.4';
    f[SF.method] = o.method ?? 'GET'; f[SF.cpcode] = o.cp ?? '1156'; f[SF.serial] = o.serial ?? '2077514';
    f[SF.host] = o.host ?? 'example.com'; f[SF.status] = String(o.status ?? 200); f[SF.objStatus] = o.os ?? 'd';
    f[SF.contentType] = o.ct ?? 'text/html'; f[SF.typecode] = o.typecode ?? 'D'; f[SF.path] = o.path ?? 'x';
    f[SF.error] = o.err ?? '-'; f[SF.ua] = o.ua ?? 'curl/8.0'; f[SF.waf] = o.waf ?? '-';
    return f.join(' ');
  }
  return { r, fl, sl };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// withS: about a third of the client requests are written as S records.
export function realisticDataset(T, { n = 3000, seed = 42, withS = false } = {}) {
  const { r, fl, sl } = makeTools(T);
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const uris = [
    '/', '/index.html', '/account/registration', '/api/subscriptions', '/api/notifications', '/api/v1/item/123/detail',
    '/api/v1/item/98765/detail?x=1', '/s/a1b2c3d4e5f6a7b8c9/view', '/s/0f9e8d7c6b5a4f3e2d/view', '/s/123456789012/view',
    "/search?q=o'reilly", '/products?select=color&from=home', '/.env', '/static/app.js', '/img/logo.png',
    '/a.b/c(d)/[e]', '/weird/{id}/literal', '/api/v2/orders/42.',
  ];
  const statuses = ['200', '200', '200', '200', '304', '301', '403', '404', '429', '500', '502', '503', '0', '000', '-'];
  const errs = ['-', '-', '-', '-', 'ERR_READ_TIMEOUT|before_resp_hdrs', 'ERR_CONNECT_FAIL', 'ERR_ACCESS_DENIED|fwd_acl', "ERR_X|it's"];
  const oss = ['d', 'm', 'i', 'o', 'do', 'sA', 'n', 'g', 'p', '-', 'oW', 'dz', ...(withS ? ['ptxkR'] : [])];
  const cts = ['text/html', 'text/html;charset=utf-8', 'application/json', 'application/json,text/plain', 'image/png', '-', ';weird'];
  const wafs = ['-', '-', '-', 'cop2_18820|3000508|LFI-ANOMALY', 'cop2_1|950001|SQL_Injection', 'x|y|XSS-ANOMALY', 'solo', 'a|b|c|'];
  const hosts = ['www.example.com', 'api.example.com', "o'host.example.com"];
  const ips = Array.from({ length: 40 }, (_, i) => `198.51.${i % 7}.${i}`);
  const edges = ['23.216.159.134', '23.216.159.133', '23.46.229.134'];
  const fwds = ['23.48.5.16', '172.234.92.188', '172.235.202.189'];
  const lines = [];
  let t = 1700000000;
  for (let i = 0; i < n; i++) {
    t += rand() < 0.02 ? 300 * rand() : rand() * 2;
    const ts = t.toFixed(3);
    const uri = pick(uris), ip = pick(ips), edge = pick(edges);
    const common = { ts, lat: Math.floor(rand() * 900), ip, status: pick(statuses), err: pick(errs), os: pick(oss), ct: pick(cts), host: pick(hosts), ua: pick(['curl/8.0', 'Mozilla/5.0%20(X11)', '%3Cimg%20src%3Dx%3E']), edge, waf: pick(wafs) };
    if (withS && rand() < 0.35) lines.push(sl({ ...common, path: uri.slice(1) || 'index.html', cp: pick(['1156', '1156.', '42']), waf: pick(['-', '-', 'waqa_1||60425675', 'cop2_1|950001|SQL_Injection']) }));
    else lines.push(r({ ...common, uri: withS && rand() < 0.5 ? `/D/1156/2077514/000/${common.host}${uri}` : uri, tcip: rand() < 0.2 ? '203.0.113.9' : ip }));
    if (rand() < 0.5) lines.push(fl({ ts, lat: Math.floor(rand() * 800), ip, uri, status: pick(statuses), fwd: pick(fwds), edge, err: pick(errs), fhost: pick(['origin.example.com', 'parent.akamai.net']) }));
  }
  return lines;
}

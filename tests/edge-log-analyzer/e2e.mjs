// Real-browser end-to-end check: headless Chrome driven over the DevTools
// protocol (Node's built-in WebSocket, no dependencies). Needs network access
// for the Chart.js CDN, which also verifies the script's SRI hash.
// Run: node tests/edge-log-analyzer/e2e.mjs [screenshot.png]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadTool, INDEX_HTML } from './load.mjs';
import { makeTools, realisticDataset } from './fixtures.mjs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const toolDir = dirname(INDEX_HTML);
const server = createServer((req, res) => {
  const file = req.url === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
  let body;
  try { body = readFileSync(join(toolDir, file)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
  res.end(body);
}).listen(0, '127.0.0.1');
await new Promise((res) => server.once('listening', res));
const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;

const profile = mkdtempSync(join(tmpdir(), 'ela-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank']);
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) res(m[1]); });
  setTimeout(() => rej(new Error('Chrome did not start')), 15000);
});

const ws = new WebSocket(wsUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
let msgId = 0;
const pending = new Map();
const pageErrors = [];
const geoRequests = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.includes('geojs.io')) geoRequests.push(msg.params.request.url);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') pageErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
});
let sessionId;
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
async function clickAt(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
async function clickSelector(sel) {
  const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await clickAt(box.x, box.y);
}
async function clickChartElement(chartVar, index) {
  const pt = await evaluate(`(() => { const c = ${chartVar}; c.canvas.scrollIntoView({ block: 'center' }); const el = c.getDatasetMeta(0).data[${index}]; const r = c.canvas.getBoundingClientRect(); const p = el.tooltipPosition(); return { x: r.x + p.x, y: r.y + p.y }; })()`);
  await clickAt(pt.x, pt.y);
}

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: pageUrl });
  for (let i = 0; i < 100 && !(await evaluate(`document.readyState === 'complete' && typeof Chart !== 'undefined' && !!document.getElementById('kpiTotal')`).catch(() => false)); i++) await sleep(100);
  await sleep(800);

  check('page loads with Chart.js (SRI hash accepted) and no script errors', pageErrors.length === 0 && (await evaluate('typeof Chart')) === 'function', pageErrors.join(' | '));
  check('sample dashboard renders', (await evaluate(`document.getElementById('kpiTotal').textContent`)) === '559');

  // --- hostile log content must render as text ---
  const T = loadTool();
  const { r } = makeTools(T);
  const attacker = '203.0.113.66';
  const hostile = [
    ...Array.from({ length: 30 }, (_, i) => r({ ts: 1700000000 + i, ip: attacker, ua: '%3Cimg%20src%3Dx%20onerror%3D%22window.__xss%3D1%22%3E', err: '<svg/onload=window.__xss=2>', status: 403 })),
    r({ ts: 1700000100, ip: '"><img/src=x/onerror=window.__xss=3>', method: '<b>GET</b>' }),
  ];
  await evaluate(`analyzeText(${JSON.stringify(hostile.join('\n'))}, 'e2e hostile')`);
  await sleep(300);
  const xss = await evaluate(`({ flag: window.__xss ?? null, imgs: document.querySelectorAll('img[src="x"], svg[onload]').length, text: document.querySelector('#ipTable').textContent.includes('<img src=x onerror="window.__xss=1">'), raw: document.getElementById('rawTable').textContent.includes('Method <b>GET</b>'), ipCell: document.querySelector('#ipTable').textContent.includes('"><img/src=x/onerror=window.__xss=3>') })`);
  check('XSS payloads in user-agent / error / IP / method render as inert text', xss.flag === null && xss.imgs === 0 && xss.text && xss.raw && xss.ipCell, JSON.stringify(xss));

  // --- unparseable input clears the dashboard ---
  await evaluate(`analyzeText('this is not a ghost log\\nneither is this', 'e2e junk')`);
  await sleep(200);
  const empty = await evaluate(`({ total: document.getElementById('kpiTotal').textContent, badge: document.getElementById('statusBadge').textContent, status: document.getElementById('uploadStatus').textContent })`);
  check('unparseable input clears the dashboard and explains why', empty.total === '0' && empty.badge === 'NO DATA' && /Parsed 0 of 2 lines.*2 record type/.test(empty.status), JSON.stringify(empty));

  // --- realistic dataset: drill-downs via real clicks ---
  const lines = realisticDataset(T);
  await evaluate(`analyzeText(${JSON.stringify(lines.join('\n'))}, 'e2e realistic')`);
  await sleep(1200);
  const statusLine = await evaluate(`document.getElementById('uploadStatus').textContent`);
  check('parse report shown in the status line', /Parsed \d+ of \d+ lines/.test(statusLine), statusLine);

  const shotPath = process.argv[2];
  if (shotPath) {
    // Full-height viewport, no scrolling: the capture starts at the top of the page.
    const { cssContentSize } = await send('Page.getLayoutMetrics');
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: Math.ceil(cssContentSize.height), deviceScaleFactor: 1, mobile: false });
    await evaluate('window.scrollTo(0, 0)');
    await sleep(1500);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotPath, Buffer.from(data, 'base64'));
    console.log(`screenshot: ${shotPath}`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
  }

  await evaluate(`document.getElementById('groupByDim').value = 'fwdIp'; document.getElementById('groupByDim').dispatchEvent(new Event('change'))`);
  const gbN = await evaluate(`document.querySelector('#groupByTable tbody tr td:nth-child(2)').textContent`);
  await clickSelector('#groupByTable [data-gb-idx="0"]');
  await sleep(500);
  const gbStatus = await evaluate(`document.getElementById('queryStatus').textContent`);
  check('group-by "lines" click reproduces the row count', gbStatus.includes(`: ${gbN} output line(s)`), `row n=${gbN}; status="${gbStatus}"`);

  const failExpected = await evaluate(`lastAnalyzeResult.topFail[0].count`);
  await clickChartElement('failChart', 0);
  await sleep(500);
  const failStatus = await evaluate(`document.getElementById('queryStatus').textContent`);
  check('clicking a failing-endpoint bar drills into exactly its lines', failStatus.startsWith('Lines behind "4xx/5xx on') && failStatus.includes(`: ${failExpected} output line(s)`), failStatus);

  const ipExpected = await evaluate(`lastAnalyzeResult.ipAll[lastAnalyzeResult.ipAll.length - 1]`);
  await evaluate(`(() => { const f = document.getElementById('ipFilter'); f.value = ${JSON.stringify(ipExpected.ip)}; f.dispatchEvent(new Event('input')); })()`);
  const ipFound = await evaluate(`[...document.querySelectorAll('#ipTable tbody tr')].some((tr) => tr.textContent.includes(${JSON.stringify(ipExpected.ip)}))`);
  check('IP search finds an IP outside the top 12', ipFound, ipExpected.ip);
  await evaluate(`(() => { const f = document.getElementById('ipFilter'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);

  const bin = await evaluate(`lastAnalyzeResult.timeline.counts.findIndex((c) => c > 20)`);
  const binCount = await evaluate(`lastAnalyzeResult.timeline.counts[${bin}]`);
  await clickChartElement('rpsChart', bin);
  await sleep(900);
  const zoom = await evaluate(`({ badge: document.getElementById('rangeBadge').textContent, total: document.getElementById('kpiTotal').textContent })`);
  check('clicking a timeline bin zooms to exactly that bin', zoom.badge === 'zoomed to bin' && zoom.total === String(binCount), `bin ${bin}: expected ${binCount}, got ${JSON.stringify(zoom)}`);

  await clickSelector('#resetRangeBtn');
  await sleep(600);
  check('reset restores the full range', (await evaluate(`document.getElementById('kpiTotal').textContent`)) === String(await evaluate('fullRLines.length')));

  // --- S records: counted, and drill-downs / quick queries include them ---
  await evaluate(`analyzeText(${JSON.stringify(realisticDataset(T, { withS: true }).join('\n'))}, 'e2e with S')`);
  await sleep(1200);
  const sStatus = await evaluate(`document.getElementById('uploadStatus').textContent`);
  check('S records are parsed and reported', /client requests \(\d+ r \+ \d+ S\)/.test(sStatus), sStatus);
  const sFailExpected = await evaluate(`lastAnalyzeResult.topFail[0].count`);
  await clickChartElement('failChart', 0);
  await sleep(500);
  const sFail = await evaluate(`({ status: document.getElementById('queryStatus').textContent, query: document.getElementById('queryInput').value })`);
  check('drill-down with S records matches the clicked bar', sFail.status.includes(`: ${sFailExpected} output line(s)`) && sFail.query.includes('$2=="S"'), JSON.stringify(sFail));
  await evaluate(`document.querySelector('[data-example-s]').click()`);
  await sleep(300);
  const tally = await evaluate(`({ sum: document.getElementById('queryOutput').textContent.trim().split('\\n').reduce((s, l) => s + parseInt(l, 10), 0), total: fullRLines.length })`);
  check('status-code tally quick query counts r and S records', tally.sum === tally.total, JSON.stringify(tally));

  check('no script errors during the whole session', pageErrors.length === 0, pageErrors.join(' | '));

  // --- geolocation is opt-in: nothing goes to geojs.io until the button is clicked ---
  // Runs after the script-error check: a failed lookup (offline) logs a console error.
  const notLookedUp = await evaluate(`document.getElementById('originLocationList').textContent.includes('location not looked up')`);
  check('no geolocation requests before opt-in', geoRequests.length === 0 && notLookedUp, `requests=${geoRequests.length}, placeholder shown=${notLookedUp}`);
  await clickSelector('#infraGeoBtn');
  for (let i = 0; i < 30 && !geoRequests.length; i++) await sleep(100);
  check('"Look up locations" sends infrastructure IPs to geojs.io', geoRequests.length > 0, geoRequests[0] || 'no request seen');

} catch (err) {
  check('e2e run completed', false, err.stack);
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);

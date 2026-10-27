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
import { makeTools, realisticDataset, realisticGfaDataset, GFA_TEST_DICT } from './fixtures.mjs';

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

  // --- GFA: column found, drill-downs reproduce counts, trace, range scoping, dictionary ---
  const gfaLines = realisticGfaDataset(T, { withS: true });
  gfaLines.push(r({ ts: 1700005000, gfa: 'nsa=//aa/S/%3Cimg%20src%3Dx%20onerror%3Dwindow.__xss%3D5%3E/<b>1</b>' }));
  await evaluate(`analyzeText(${JSON.stringify(gfaLines.join('\n'))}, 'e2e gfa')`);
  await sleep(900);
  const gfaTop = await evaluate(`({ badge: document.getElementById('gfaBadge').textContent, summary: document.getElementById('gfaSummary').textContent, insightsHidden: document.getElementById('gfaInsightsBox').hidden, n: gfaResult.withGfa })`);
  check('GFA column found on r and S records, structure shown without a dictionary', gfaTop.badge === `${gfaTop.n} request(s)` && /column \$72 on r lines, \$61 on S records/.test(gfaTop.summary) && gfaTop.insightsHidden, JSON.stringify(gfaTop));

  await evaluate(`gfaDict = validateGfaDictionary(${JSON.stringify(GFA_TEST_DICT)}); refreshGfa();`);
  await sleep(300);
  const provN = await evaluate(`gfaResult.providers[0].n`);
  await clickSelector('#gfaProviderTable [data-gfa-drill]');
  await sleep(500);
  const provStatus = await evaluate(`({ status: document.getElementById('queryStatus').textContent, query: document.getElementById('queryInput').value })`);
  check('GFA provider "lines" reproduces its request count across r and S', provStatus.status.includes(`: ${provN} output line(s)`) && provStatus.query.includes('$2=="S"'), JSON.stringify(provStatus));

  await clickSelector('[data-gfa-select="nsa/aa"]');
  await sleep(400);
  const valExpected = await evaluate(`gfaResult.providers.find((p) => p.key === 'nsa/aa').fields[1].values[0].count`);
  await clickSelector('#gfaDetailFields tbody[data-gfa-field="1"] [data-gfa-drill]');
  await sleep(500);
  const valStatus = await evaluate(`document.getElementById('queryStatus').textContent`);
  check('GFA field value "lines" reproduces its count', valStatus.includes(`: ${valExpected} output line(s)`), `${valExpected}: ${valStatus}`);

  const insExpected = await evaluate(`gfaResult.insights[0].count`);
  await clickSelector('#gfaInsights [data-gfa-drill]');
  await sleep(500);
  const insStatus = await evaluate(`document.getElementById('queryStatus').textContent`);
  check('GFA insight "lines" reproduces its count', insStatus.includes(`: ${insExpected} output line(s)`), `${insExpected}: ${insStatus}`);

  await sleep(800); // let the drill-down's smooth scroll settle; nsa/aa is still open
  await clickSelector('#gfaDetailFields tbody[data-gfa-field="0"] [data-gfa-trace]');
  await sleep(400);
  const trace = await evaluate(`({ status: document.getElementById('gfaTraceStatus').textContent, rows: document.querySelectorAll('#gfaTraceTable tbody tr').length, v: document.getElementById('gfaTraceInput').value })`);
  const traceN = parseInt(trace.status, 10);
  check('trace from a session value lists its requests', traceN > 0 && trace.rows === Math.min(traceN, 200) && trace.v.length === 32, JSON.stringify(trace));
  await clickSelector('[data-gfa-trace-drill]');
  await sleep(500);
  const traceStatus = await evaluate(`document.getElementById('queryStatus').textContent`);
  check('trace "lines" reproduces the trace count', traceStatus.includes(`: ${traceN} output line(s)`), traceStatus);

  const xssGfa = await evaluate(`(() => { gfaSelected = 'nsa/aa'; renderGfa(); runGfaTrace('S'); const card = document.getElementById('gfaCard').textContent; return { flag: window.__xss ?? null, imgs: document.querySelectorAll('#gfaCard img').length, bold: document.querySelectorAll('#gfaCard b').length, text: card.includes('<img src=x onerror=window.__xss=5>') && card.includes('<b>1<') }; })()`);
  check('hostile GFA values render as inert text', xssGfa.flag === null && xssGfa.imgs === 0 && xssGfa.bold === 0 && xssGfa.text, JSON.stringify(xssGfa));

  const fullGfa = await evaluate('gfaResult.withGfa');
  await evaluate(`runGfaTrace(${JSON.stringify(trace.v)})`);
  const gfaBin = await evaluate(`lastAnalyzeResult.timeline.counts.findIndex((c) => c > 20)`);
  await clickChartElement('rpsChart', gfaBin);
  await sleep(900);
  const zoomed = await evaluate(`({ n: gfaResult.withGfa, inScope: currentScopeLines.rLines.filter((f) => f.gfa).length, trace: parseInt(document.getElementById('gfaTraceStatus').textContent, 10), traceScope: gfaTrace(currentScopeLines.rLines, ${JSON.stringify(trace.v)}).length })`);
  check('zooming re-scopes the GFA section and re-runs the open trace', zoomed.n === zoomed.inScope && zoomed.n < fullGfa && zoomed.trace === zoomed.traceScope, JSON.stringify({ ...zoomed, fullGfa }));
  await clickSelector('#resetRangeBtn');
  await sleep(500);

  await evaluate(`(() => { const s = document.getElementById('gfaView'); s.value = 'g:Alpha and beta'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  const view = await evaluate(`({ summary: document.getElementById('gfaSummary').textContent, rows: [...document.querySelectorAll('#gfaProviderTable tbody td.key')].map((td) => td.textContent), n: gfaResult.withGfa, all: gfaResult.gfaTotal })`);
  await clickSelector('#gfaSummary [data-gfa-drill]');
  await sleep(500);
  const viewStatus = await evaluate(`document.getElementById('queryStatus').textContent`);
  check('a dictionary group view shows only its providers and its "lines" reproduce its count', view.summary.startsWith('View "Alpha and beta"') && view.rows.sort().join() === 'nsa/aa,nsa/bb' && view.n < view.all && viewStatus.includes(`: ${view.n} output line(s)`), JSON.stringify({ ...view, viewStatus }));
  await evaluate(`(() => { const s = document.getElementById('gfaView'); s.value = 'ns:nsb'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  const nsRows = await evaluate(`[...document.querySelectorAll('#gfaProviderTable tbody td.key')].map((td) => td.textContent).join()`);
  check('a namespace view needs no dictionary group', nsRows === 'nsb/cc', nsRows);
  await evaluate(`(() => { const s = document.getElementById('gfaView'); s.value = 'g:Gamma only'; s.dispatchEvent(new Event('change')); })()`);

  await clickSelector('#gfaDictForgetBtn');
  await sleep(300);
  const forgot = await evaluate(`({ hidden: document.getElementById('gfaInsightsBox').hidden, stored: localStorage.getItem('edgeLogAnalyzer.gfaDictionary'), status: document.getElementById('gfaDictStatus').textContent, view: document.getElementById('gfaView').value })`);
  check('"Forget dictionary" drops insights, the stored copy and its group view', forgot.hidden && forgot.stored === null && /No dictionary loaded/.test(forgot.status) && forgot.view === '', JSON.stringify(forgot));

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

// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTool, INDEX_HTML } from './load.mjs';
import { makeTools, realisticDataset } from './fixtures.mjs';

const T = loadTool();
const { r, fl, sl } = makeTools(T);
const parseAndAnalyze = (lines) => { const p = T.parseLogText(lines.join('\n')); return { p, a: T.analyze(p.rLines, p.fLines) }; };
const countLines = (query, lines) => Number(T.runQueryPipeline(`${query} | wc -l`, lines)[0]);

// ---------- Security ----------
test('escapeHtml neutralises markup and attribute breakouts', () => {
  assert.equal(T.escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(T.escapeHtml('" onmouseover="x'), '&quot; onmouseover=&quot;x');
  assert.equal(T.escapeHtml("a'b&c"), 'a&#39;b&amp;c');
  assert.equal(T.escapeHtml(null), '');
});

test('every innerHTML assignment in the page interpolates only escaped or numeric values', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');
  // Collect the template literals assigned to innerHTML / outerHTML and check each ${...}.
  const allowed = /^(escapeHtml\(|ipLocationCellHtml\(|statusPillClass\(|fmtPct\(|formatUtc\(|r\.n$|r\.p50 \?\? |r\.p95 \?\? |r\.p99 \?\? |r\.avg \?\? |i$|d\.id$|shown\.length$|matched\.length$)/;
  const offenders = [];
  for (const m of html.matchAll(/(?:innerHTML|outerHTML)\s*[+]?=([\s\S]*?);\n/g)) {
    for (const expr of m[1].matchAll(/\$\{([^}]*)\}/g)) {
      if (!allowed.test(expr[1].trim())) offenders.push(expr[1].trim());
    }
  }
  assert.deepEqual(offenders, [], `unescaped interpolations into innerHTML: ${offenders.join(', ')}`);
});

// ---------- Parse accounting ----------
test('parse report counts every rejected line by reason and removes exact duplicates', () => {
  const good = r();
  const truncated = good.split(' ').slice(0, 80).join(' ');
  const badTs = r({ ts: 'garbage' });
  const shifted = (() => { const f = r({ status: 503 }).split(' '); f[T.RF.arl] = '/a b'; return f.join(' '); })();
  const notRF = 'hello world this is not a ghost log';
  const { report, rLines, skippedLines } = T.parseLogText([good, good, truncated, badTs, shifted, notRF, fl()].join('\r\n'));
  assert.equal(report.totalLines, 7);
  assert.equal(report.duplicates, 1);
  assert.equal(report.r, 1);
  assert.equal(report.f, 1);
  assert.deepEqual(report.skipped, { notRF: 1, fieldCount: 1, badTimestamp: 1, misaligned: 1 });
  assert.equal(report.skippedTotal, 4);
  assert.equal(rLines.length, 1);
  assert.equal(skippedLines.length, 4);
  assert.match(T.parseReportText(report), /Parsed 2 of 7 lines.*skipped 4.*removed 1 exact duplicate/);
});

test('a malformed timestamp no longer poisons the observed window', () => {
  const { a } = parseAndAnalyze([r({ ts: 1700000000 }), r({ ts: 1700000100 }), r({ ts: 'garbage' })]);
  assert.equal(a.kpis.total, 2);
  assert.match(a.meta.subtitle, /2023-11-14 22:13:20 → 2023-11-14 22:15:00/);
});

test('large inputs analyse without the old Math.min(...spread) stack overflow', () => {
  assert.deepEqual(T.minMax(new Float64Array(500000).map((_, i) => i)), [0, 499999]);
  const html = readFileSync(INDEX_HTML, 'utf8');
  assert.doesNotMatch(html, /Math\.(min|max)\(\.\.\./);
  const lines = Array.from({ length: 160000 }, (_, i) => r({ ts: (1700000000 + i * 0.01).toFixed(3), ip: `10.0.${i % 200}.${i % 251}` }));
  const { a } = parseAndAnalyze(lines);
  assert.equal(a.kpis.total, 160000);
});

test('dashboard tokenisation matches the query engine for irregular whitespace', () => {
  const line = '  ' + r({ status: 404 }).replace(' r ', ' r\t \t');
  assert.deepEqual(T.splitFields(line), line.trim().split(/\s+/));
  assert.equal(countLines(`awk '$2=="r" && $14=="404"'`, [line]), 1);
});

// ---------- Analytical correctness ----------
test('endpoint normalisation keeps real path words distinct', () => {
  assert.equal(T.normalizeUri('/account/registration'), '/account/registration');
  assert.notEqual(T.normalizeUri('/api/subscriptions'), T.normalizeUri('/api/notifications'));
  assert.equal(T.normalizeUri('/api/v1/item/123/detail?x=1'), '/api/v1/item/{id}/detail');
  assert.equal(T.normalizeUri('/s/a1b2c3d4e5f6a7b8c9/view'), '/s/{token}/view');
});

test('failing-endpoint label matches what is counted (all 4xx + 5xx)', () => {
  const { a } = parseAndAnalyze([r({ status: 404, uri: '/a' }), ...Array.from({ length: 5 }, (_, i) => r({ status: 403, uri: '/login', ts: 1700000001 + i }))]);
  assert.doesNotMatch(a.failHint, /404 \+ 5xx/);
  assert.deepEqual(a.topFail.map((x) => [x.endpoint, x.count]), [['/login', 5], ['/a', 1]]);
});

test('403/429 KPI reports WAF-info and origin-contacted indicators instead of claiming WAF blocks', () => {
  const { a } = parseAndAnalyze([
    r({ status: 403, waf: 'a|1|LFI-ANOMALY', os: '-', ts: 1700000001 }),
    r({ status: 403, os: 'o', ts: 1700000002 }),
    r({ status: 429, ts: 1700000003 }),
  ]);
  assert.equal(a.kpis.blocks, 3);
  assert.match(a.kpis.blocksSub, /2×403 \+ 1×429 .* 1 with WAF info · 1 origin-contacted/);
});

test('turnaround split compares like with like', () => {
  const lines = []; let t = 1700000000;
  for (let i = 0; i < 90; i++) lines.push(r({ ts: t++, lat: 5, os: 'd' }));
  for (let i = 0; i < 10; i++) { lines.push(r({ ts: t, lat: 900, os: 'o' })); lines.push(fl({ ts: t++, lat: 850 })); }
  const { a } = parseAndAnalyze(lines);
  assert.deepEqual(a.turnaround.cache, { n: 90, p50: 5, p95: 5, p99: 5, avg: 5 });
  assert.deepEqual(a.turnaround.contacted, { n: 10, p50: 900, p95: 900, p99: 900, avg: 900 });
  assert.deepEqual(a.turnaround.forward, { n: 10, p50: 850, p95: 850, p99: 850, avg: 850 });
});

test('p95 is withheld for groups smaller than the minimum sample size', () => {
  const { a } = parseAndAnalyze([r({ os: 'o', lat: 100 }), r({ os: 'o', lat: 200, ts: 1700000001 })]);
  assert.equal(a.turnaround.contacted.p95, null);
  assert.equal(a.turnaround.contacted.p99, null);
  assert.equal(a.turnaround.contacted.p50, 100);
});

test('percentiles are nearest-rank, matching sort -n + awk a[ceil(n*p)]', () => {
  // 1..20: p95 = rank 19 and p99 = rank 20 (interpolating would give 19.05 and 19.81).
  const lines = [r(), ...Array.from({ length: 20 }, (_, i) => fl({ ts: 1700000000 + i, lat: i + 1 }))];
  const { a } = parseAndAnalyze(lines);
  assert.deepEqual(a.turnaround.forward, { n: 20, p50: 10, p95: 19, p99: 20, avg: 11 });
  // 1011 samples: rank ceil(960.45) = 961, the 961st smallest value.
  const big = [r(), ...Array.from({ length: 1011 }, (_, i) => fl({ ts: 1700000000 + i, lat: i }))];
  assert.equal(parseAndAnalyze(big).a.turnaround.forward.p95, 960);
});

test('chained hops in one file are flagged instead of silently blended', () => {
  // Edge A takes a loopback subrequest and forwards to edge B's host; edge B
  // sees edge A as its client and forwards to the backend.
  const lines = [];
  for (let i = 0; i < 10; i++) {
    const ts = 1700000000 + i;
    lines.push(r({ ts, edge: '23.0.0.1', ip: '127.0.0.1', lat: 100, os: 'p' }));
    lines.push(fl({ ts, edge: '23.0.0.1', fhost: 'tier.example.net', lat: 90 }));
    lines.push(r({ ts, edge: '23.0.0.2', ip: '23.0.0.1', lat: 10, os: 'p' }));
    lines.push(fl({ ts, edge: '23.0.0.2', fhost: 'backend.example.net', lat: 5 }));
  }
  const { a } = parseAndAnalyze(lines);
  assert.deepEqual(a.turnaround.clientTiers.map((t) => [t.key, t.n, t.p95]), [['loopback', 10, 100], ['edge', 10, 10]]);
  assert.deepEqual(a.turnaround.forwardByHost.map((h) => [h.key, h.n, h.p50]), [['tier.example.net', 10, 90], ['backend.example.net', 10, 5]]);
  assert.match(a.kpis.p95Mix, /blends 2 hops/);
  assert.match(a.turnaround.tierMix, /10 from loopback.*: p50 100ms, p95 100ms.*10 from other edges in this file.*p95 10ms/);
  assert.match(a.turnaround.fwdMix, /2 forward hosts/);
});

test('a single-tier, single-origin file raises no blend warning', () => {
  const { a } = parseAndAnalyze([r({ os: 'o' }), fl(), r({ os: 'o', ts: 1700000001, ip: '5.6.7.8' }), fl({ ts: 1700000001 })]);
  assert.equal(a.kpis.p95Mix, '');
  assert.equal(a.turnaround.tierMix, '');
  assert.equal(a.turnaround.fwdMix, '');
});

test('group-by rows carry p99 and avg', () => {
  const lines = Array.from({ length: 20 }, (_, i) => fl({ ts: 1700000000 + i, lat: i + 1, fhost: 'backend.example.net' }));
  const p = T.parseLogText(lines.join('\n'));
  const [row] = T.groupBy(p.rLines, p.fLines, 'fwdHost');
  assert.deepEqual([row.key, row.p50, row.p95, row.p99, row.avg], ['backend.example.net', 10, 19, 20, 11]);
});

test('empty timeline bins are null, not 0 ms', () => {
  const { a } = parseAndAnalyze([r({ ts: 1700000000, lat: 800 }), r({ ts: 1700003000, lat: 800 })]);
  assert.equal(a.timeline.p95[0], 800);
  assert.equal(a.timeline.p95[5], null);
  assert.equal(a.timeline.counts.reduce((x, y) => x + y, 0), 2);
});

test('client-IP search covers every IP, not just the top 12', () => {
  const lines = Array.from({ length: 50 }, (_, i) => r({ ip: `10.0.0.${i}`, ts: 1700000000 + i }));
  const { a } = parseAndAnalyze(lines);
  assert.equal(a.ipTable.length, 12);
  assert.equal(a.ipAll.length, 50);
  assert.ok(a.ipAll.some((x) => x.ip === '10.0.0.49'));
});

// ---------- Drill-down parity: the generated query must reproduce the clicked number ----------
const dataset = realisticDataset(T);
const { p: rp, a: ra } = parseAndAnalyze(dataset);
const datasetS = realisticDataset(T, { withS: true });
const { p: sp, a: sa } = parseAndAnalyze(datasetS);

function widgetChecks(a) {
  return [
    ...a.topFail.map((x) => [`topFail ${x.endpoint}`, x.drill, x.count]),
    ...a.topSlow.map((x) => [`topSlow ${x.endpoint}`, x.drill, x.count]),
    ...a.cache.breakdown.map((x) => [`cache ${x.label}`, x.drill, x.count]),
    ...a.contentType.map((x) => [`ct ${x.label}`, x.drill, x.count]),
    ...a.waf.topSignals.map((x) => [`waf ${x.signal}`, x.drill, x.count]),
    ...a.ipAll.map((x) => [`ip ${x.ip}`, x.drill, x.requests]),
    ...['2xx', '3xx', '4xx', '5xx'].map((c) => [`status ${c}`, T.statusClassDrill(c), a.statusBuckets[c]]),
  ];
}
function groupByParity(p, opts) {
  let rows = 0;
  for (const dim of T.GROUP_DIMS) {
    const groups = T.groupBy(p.rLines, p.fLines, dim.id);
    const scopeTotal = dim.rec === 'r' ? p.rLines.length : p.fLines.length;
    assert.equal(groups.reduce((s, g) => s + g.n, 0), scopeTotal, `${dim.id} groups must partition the records`);
    for (const g of groups) {
      rows++;
      const q = T.buildDrillQuery(g.drill, opts);
      assert.equal(countLines(q, p.lines), g.n, `${dim.id}=${g.key}: ${q}`);
    }
  }
  return rows;
}

test('drill-down parity: endpoint, cache, content-type, WAF and IP widgets', () => {
  const checks = widgetChecks(ra);
  assert.ok(checks.length > 60);
  for (const [label, spec, expected] of checks) {
    assert.equal(countLines(T.buildDrillQuery(spec), rp.lines), expected, `${label}: ${T.buildDrillQuery(spec)}`);
  }
});

test('drill-down parity: every row of every group-by dimension', () => {
  assert.ok(groupByParity(rp) > 100);
});

test('drill-down parity holds with S records mixed in (includeS)', () => {
  assert.ok(sp.report.S > 500 && sp.report.r > 1000, JSON.stringify(sp.report));
  const checks = widgetChecks(sa);
  assert.ok(checks.length > 60);
  for (const [label, spec, expected] of checks) {
    const q = T.buildDrillQuery(spec, { includeS: true });
    assert.equal(countLines(q, sp.lines), expected, `${label}: ${q}`);
  }
  assert.ok(groupByParity(sp, { includeS: true }) > 100);
});

test('zooming into a timeline bin selects exactly that bin, including nested zooms', () => {
  const checkBins = (rLines, a) => {
    const tl = a.timeline;
    let nonEmpty = null;
    for (let i = 0; i < T.NBINS; i++) {
      const pred = T.makeRangePredicate({ kind: 'bin', t0: tl.t0, t1: tl.t1, binWidth: tl.binWidth, idx: i });
      const inBin = rLines.filter((f) => pred(Number(f[T.RF.ts])));
      assert.equal(inBin.length, tl.counts[i], `bin ${i}`);
      if (inBin.length > 50 && nonEmpty === null) nonEmpty = inBin;
    }
    return nonEmpty;
  };
  const sub = checkBins(rp.rLines, ra);
  assert.ok(sub, 'fixture should have a populated bin');
  const subResult = T.analyze(sub, []);
  checkBins(rp.rLines.filter((f) => { const t = Number(f[T.RF.ts]); return t >= subResult.timeline.t0 && t <= subResult.timeline.t1; }), subResult);
});

test('manual range "To" includes the whole final second', () => {
  const lines = [r({ ts: '1700000000.100' }), r({ ts: '1700000010.750' })];
  const { p } = parseAndAnalyze(lines);
  const pred = T.makeRangePredicate({ kind: 'manual', from: 1700000000, toSec: 1700000010, toExclusive: 1700000011 });
  assert.equal(p.rLines.filter((f) => pred(Number(f[T.RF.ts]))).length, 2);
});

// ---------- Query engine ----------
test('query engine rejects unsupported options instead of silently ignoring them', () => {
  const raw = [r({ uri: '/a' }), r({ uri: '/b', ts: 1700000001 })];
  assert.throws(() => T.runQueryPipeline(`awk '{print $13}' | sort -k2`, raw), /sort: unsupported option '-k2'/);
  assert.throws(() => T.runQueryPipeline(`awk '{print $13}' | uniq -d`, raw), /uniq: unsupported option/);
  assert.throws(() => T.runQueryPipeline(`awk '{print $13}' | wc -c`, raw), /only 'wc -l'/);
  assert.throws(() => T.runQueryPipeline(`awk '{print $13}' | head -x`, raw), /head: unsupported option/);
  assert.throws(() => T.runQueryPipeline(`awk '{print $13}' | grep -o a`, raw), /grep: unsupported option/);
  assert.deepEqual(T.runQueryPipeline(`awk '{print $13}' | grep -E 'a|b'`, raw), ['/a', '/b']);
  assert.deepEqual(T.runQueryPipeline(`awk '{print $13}' | grep -F .`, raw), []);
  assert.deepEqual(T.runQueryPipeline(`awk '{print $13}' | grep -c a`, raw), ['1']);
  assert.deepEqual(T.runQueryPipeline(`awk '{print $13}' | head -n 1`, raw), ['/a']);
});

test('string constants force string comparison (POSIX awk semantics)', () => {
  const raw = [r({ status: '0' }), r({ status: '000', ts: 1700000001 })];
  assert.equal(countLines(`awk '$14=="0"'`, raw), 1);
  assert.equal(countLines(`awk '$14==0'`, raw), 2);
  assert.equal(countLines(`awk '$14=="\\x30\\x30\\x30"'`, raw), 1);
});

test('plain-English "top 200 urls" is a row limit, not a status filter', () => {
  const { command } = T.translateEnglish('top 200 urls');
  assert.doesNotMatch(command, /\$14==/);
  assert.match(command, /head -200$/);
  assert.match(T.translateEnglish('top 10 urls with 404').command, /\$14=="404"/);
});

// ---------- S records ----------
test('S records are parsed as client-facing requests at their own field positions', () => {
  const line = sl({ ip: '9.8.7.6', status: 403, path: '.env', err: 'ERR_ACCESS_DENIED|waf', os: 'xR', waf: 'waqa_1||60425675', host: 'h.example.com', lat: 0 });
  const { report, rLines, lines, skippedLines } = T.parseLogText([r(), line, fl(), sl({ ts: 1700000001 }).split(' ').slice(0, 60).join(' ')].join('\n'));
  assert.deepEqual([report.r, report.S, report.f, report.skipped.fieldCount], [1, 1, 1, 1]);
  assert.equal(skippedLines.length, 1);
  assert.equal(lines[1], line, 'the raw S text is kept for queries');
  const v = rLines[1];
  assert.deepEqual([v[T.RF.type], v[T.RF.clientIp], v[T.RF.status], v[T.RF.error], v[T.RF.objStatus], v[T.RF.host], v[T.RF.waf], v[T.RF.trueClientIp]],
    ['S', '9.8.7.6', '403', 'ERR_ACCESS_DENIED|waf', 'xR', 'h.example.com', 'waqa_1||60425675', '-']);
  assert.equal(v[T.RF.arl], '/D/1156/2077514/0/h.example.com/.env');
  assert.match(T.parseReportText(report), /Parsed 3 of 4 lines \(2 client requests \(1 r \+ 1 S\) \+ 1 forward legs\)/);
  assert.doesNotMatch(T.parseReportText(T.parseLogText(r()).report), /\bS\)/, 'pure r/f input keeps the old summary');
});

test('S blocks count as blocks and scanner paths are flagged', () => {
  const { a } = parseAndAnalyze([
    sl({ status: 403, path: '.env', err: 'ERR_ACCESS_DENIED|waf', waf: 'waqa_1||60425675' }),
    sl({ status: 403, path: 'wp-config.php', ts: 1700000001, waf: 'waqa_1||60425675' }),
    r({ ts: 1700000002 }),
  ]);
  assert.equal(a.kpis.total, 3);
  assert.equal(a.kpis.blocks, 2);
  assert.match(a.kpis.blocksSub, /2 with WAF info/);
  assert.equal(a.rawCounts['URI pattern match (heuristic): env/config file'], 2);
});

test('an S path and the equivalent r ARL group into one endpoint, and its drill matches both', () => {
  const lines = [r({ uri: '/D/1156/2077514/000/example.com/api/v1/item/7?x=1' }), sl({ path: 'api/v1/item/9', ts: 1700000001 }), sl({ path: 'api/v1/other', ts: 1700000002 })];
  const { p, a } = parseAndAnalyze(lines);
  const ep = a.topSlow.find((x) => x.endpoint === '/D/{id}/{id}/{id}/example.com/api/v1/item/{id}');
  assert.ok(ep, JSON.stringify(a.topSlow.map((x) => x.endpoint)));
  assert.equal(ep.count, 2);
  const q = T.buildDrillQuery(ep.drill, { includeS: true });
  assert.equal(countLines(q, p.lines), 2, q);
  assert.equal(countLines(T.buildDrillQuery(ep.drill), p.lines), 1, 'without includeS the query is r-only, as before');
});

test('a drill on a column S records lack matches S lines only when the condition fits their "-"', () => {
  const { p } = parseAndAnalyze([r({ tcip: '203.0.113.9' }), r({ ts: 1700000001 }), sl({ ts: 1700000002 })]);
  const by = (key) => T.groupBy(p.rLines, p.fLines, 'trueClientIp').find((g) => g.key === key);
  assert.equal(by('-').n, 2);
  assert.equal(countLines(T.buildDrillQuery(by('-').drill, { includeS: true }), p.lines), 2);
  assert.equal(countLines(T.buildDrillQuery(by('203.0.113.9').drill, { includeS: true }), p.lines), 1);
});

test('SureRoute probe errors are excluded from the 5xx KPI and status badge, but stay in the status chart', () => {
  const probes = Array.from({ length: 6 }, (_, i) => r({ ts: 1700000000 + i, ip: '127.0.0.1', status: 502, err: 'ERR_FORWARDING_DENIED', os: 'ptxkR', uri: '/D/1/2/000/h/sureroute-test-object.html' }));
  const users = Array.from({ length: 100 }, (_, i) => sl({ ts: 1700000100 + i }));
  const { a } = parseAndAnalyze([...probes, ...users]);
  assert.equal(a.kpis.count5xx, 0);
  assert.equal(a.kpis.good5xx, true);
  assert.match(a.kpis.count5xxSub, /6 SureRoute probe 5xx excluded/);
  assert.equal(a.meta.statusBadge, 'NORMAL');
  assert.equal(a.statusBuckets['5xx'], 6);
  const real = parseAndAnalyze([r({ status: 500 }), ...users]).a;
  assert.equal(real.kpis.count5xx, 1);
  assert.equal(real.meta.statusBadge, 'WARN');
});

test('awk programs may hold several rules, and leftover tokens are an error', () => {
  const raw = [r({ status: 404 }), sl({ status: 403, ts: 1700000001 }), fl()];
  assert.deepEqual(T.runQueryPipeline(`awk '$2=="r" {print $14} $2=="S" {print $16}'`, raw), ['404', '403']);
  assert.deepEqual(T.runQueryPipeline(`awk '{print "a"}; {print "b"}' | head -2`, raw), ['a', 'b']);
  assert.throws(() => T.runQueryPipeline(`awk '$2=="r" == )'`, raw), /Unexpected token/);
});

test('plain-English queries cover S records when the data has them', () => {
  const raw = [r({ status: 403, ip: '1.1.1.1' }), sl({ status: 403, ip: '2.2.2.2', ts: 1700000001 }), sl({ status: 200, ip: '3.3.3.3', ts: 1700000002 })];
  const plain = T.translateEnglish('top client ips with 403');
  assert.doesNotMatch(plain.command, /"S"/, 'no S rule unless asked');
  const withS = T.translateEnglish('top client ips with 403', { includeS: true });
  assert.match(withS.command, /\$2=="S" && \$16=="403" \{print \$11\}/);
  assert.match(withS.explanation, /r \+ S lines/);
  assert.deepEqual(T.runQueryPipeline(withS.command, raw).map((l) => l.trim()).sort(), ['1 1.1.1.1', '1 2.2.2.2']);
  assert.equal(T.runQueryPipeline(T.translateEnglish('how many 403', { includeS: true }).command, raw)[0], '2');
  const tcip = T.translateEnglish('count true client ip', { includeS: true });
  assert.doesNotMatch(tcip.command, /"S"/);
  assert.match(tcip.explanation, /S records not included.*\$60/);
});

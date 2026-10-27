// Run: npm test
// GFA_DICTIONARY=/path/to/dictionary.json npm test  also checks the public page
// carries none of that dictionary's wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTool, INDEX_HTML } from './load.mjs';
import { makeTools, realisticGfaDataset, GFA_TEST_DICT, GFA_R_COL, GFA_S_COL } from './fixtures.mjs';

const T = loadTool();
const { r } = makeTools(T);
const countLines = (query, lines) => Number(T.runQueryPipeline(`${query} | wc -l`, lines)[0]);
const keys = (...k) => new Set(k);

// ---------- Entry splitting ----------
test('entries split at known providers; empty fields and the closing "//" segment stay positional', () => {
  const token = 'nsa=//aa/S1//Bad/0.9//bb/1;nsb=//cc/S1/1;';
  const entries = T.gfaEntries(token, keys('nsa/aa', 'nsa/bb', 'nsb/cc'));
  assert.deepEqual(entries.map((e) => [e.key, e.fields]), [
    ['nsa/aa', ['S1', '', 'Bad', '0.9', '']],
    ['nsa/bb', ['1']],
    ['nsb/cc', ['S1', '1']],
  ]);
  // Without knowing "bb", its "//bb/1" is just more aa fields.
  assert.deepEqual(T.gfaEntries(token, keys('nsa/aa'))[0].fields, ['S1', '', 'Bad', '0.9', '', 'bb', '1']);
  // A provider name that doesn't follow "//" (or open the value) is a field value.
  assert.deepEqual(T.gfaEntries('nsa=//aa/bb/x', keys('nsa/aa', 'nsa/bb'))[0].fields, ['bb', 'x']);
});

test('malformed parts are ignored', () => {
  assert.deepEqual(T.gfaParts('x=y;=//aa/1;1ns=//aa/1;nsa=x//aa/1;-'), []);
  assert.deepEqual(T.gfaEntries('nsa=/aa/1', keys('nsa/aa'))[0].fields, ['1']);
});

// ---------- Column detection ----------
test('the GFA column is found by content per record type, ignoring a decoy "=/" column', () => {
  const p = T.parseLogText(realisticGfaDataset(T, { withS: true }).join('\n'));
  assert.deepEqual(p.report.gfaColumn, { r: GFA_R_COL, S: GFA_S_COL });
  const withGfa = p.rLines.filter((f) => f.gfa);
  assert.ok(withGfa.length > 1000 && withGfa.length < p.rLines.length);
  assert.ok(withGfa.every((f) => f.gfa.startsWith('nsa=')));
  assert.ok(p.rLines.some((f) => f[T.RF.type] === 'S' && f.gfa));
});

test('no GFA column when nothing looks like one', () => {
  const p = T.parseLogText([r(), r({ gfa: '-' }), r({ gfa: 'a=b' })].join('\n'));
  assert.deepEqual(p.report.gfaColumn, { r: null, S: null });
  assert.ok(p.rLines.every((f) => !f.gfa));
  assert.equal(T.buildGfaDrillQuery([{ ns: 'a', provider: 'b' }], p.report.gfaColumn), null);
});

// ---------- Drill-down parity: every number the section shows is reproduced by its AWK ----------
function assertParity(dataset, dict, label, view = null) {
  const p = T.parseLogText(dataset.join('\n'));
  const g = T.analyzeGfa(p.rLines, dict, view);
  const col = p.report.gfaColumn;
  let checked = 0;
  const within = g.viewDrill || [];
  if (g.viewDrill) {
    assert.equal(countLines(T.buildGfaDrillQuery(g.viewDrill, col), p.lines), g.withGfa, `${label}: view lines`);
    checked++;
  }
  for (const prov of g.providers) {
    assert.equal(countLines(T.buildGfaDrillQuery(prov.drill, col), p.lines), prov.n, `${label}: provider ${prov.key}`);
    checked++;
    for (const fld of prov.fields) {
      for (const x of fld.values) {
        assert.equal(countLines(T.buildGfaDrillQuery(x.drill, col), p.lines), x.count, `${label}: ${prov.key} #${fld.k + 1} = "${x.v}"`);
        checked++;
      }
    }
  }
  for (const ins of g.insights) {
    assert.equal(countLines(T.buildGfaDrillQuery(ins.drill, col), p.lines), ins.count, `${label}: insight ${ins.text}`);
    checked++;
  }
  for (const v of ['0.9', 'Bad', 'ab12', 'core', 'y%3Bz', p.rLines.find((f) => f.gfa && f.gfa.includes('//aa/')).gfa.split('/')[3]]) {
    const n = T.gfaTrace(p.rLines, v, within, new Set(g.providerKeys)).length;
    if (!view) assert.ok(n > 0, `${label}: trace ${v} finds something`);
    assert.equal(countLines(T.buildGfaDrillQuery([{ trace: v }, ...within], col), p.lines), n, `${label}: trace ${v}`);
    checked++;
  }
  return { g, checked };
}

test('drill-down parity without a dictionary (providers learned from the data)', () => {
  const { g, checked } = assertParity(realisticGfaDataset(T), null, 'no dict');
  assert.deepEqual(g.providers.map((x) => x.key).sort(), ['nsa/aa', 'nsa/bb', 'nsa/core', 'nsb/cc', 'nsc/@h']);
  assert.deepEqual(g.insights, []);
  assert.ok(checked > 100, `checked ${checked}`);
});

test('drill-down parity with a dictionary, r and S records mixed', () => {
  const { g, checked } = assertParity(realisticGfaDataset(T, { withS: true, seed: 11 }), T.validateGfaDictionary(GFA_TEST_DICT), 'dict + S');
  assert.ok(g.insights.length > 5);
  assert.ok(checked > 100, `checked ${checked}`);
});

test('a dictionary group view narrows everything and keeps drill parity', () => {
  const dict = T.validateGfaDictionary(GFA_TEST_DICT);
  const data = realisticGfaDataset(T, { withS: true, seed: 5 });
  const { g, checked } = assertParity(data, dict, 'group view', { keys: dict.groups['Alpha and beta'] });
  assert.deepEqual(g.viewKeys, ['nsa/aa', 'nsa/bb']); // nsa/nope is unknown, so dropped
  assert.deepEqual(g.providers.map((x) => x.key).sort(), ['nsa/aa', 'nsa/bb']);
  assert.ok(g.withGfa < g.gfaTotal && g.withGfa > 0);
  assert.ok(g.insights.length && g.insights.every((x) => x.drill.every((c) => c.ns === 'nsa' && ['aa', 'bb'].includes(c.provider))));
  assert.ok(!g.insights.some((x) => x.text === 'gamma present'));
  for (const prov of g.providers) assert.ok(Math.abs(prov.share - prov.n / g.withGfa * 100) < 1e-9);
  assert.ok(checked > 50, `checked ${checked}`);
});

test('a namespace view needs no dictionary and keeps drill parity', () => {
  const { g } = assertParity(realisticGfaDataset(T, { seed: 9 }), null, 'ns view', { ns: 'nsb' });
  assert.deepEqual(g.viewKeys, ['nsb/cc']);
  assert.deepEqual(g.presentKeys, ['nsa/aa', 'nsa/bb', 'nsa/core', 'nsb/cc', 'nsc/@h']);
});

test('a view with no known provider matches nothing', () => {
  const p = T.parseLogText(realisticGfaDataset(T, { n: 200 }).join('\n'));
  const g = T.analyzeGfa(p.rLines, GFA_TEST_DICT, { keys: GFA_TEST_DICT.groups['Nothing known'] });
  assert.deepEqual(g.viewKeys, []);
  assert.equal(g.viewDrill, null);
  assert.equal(g.withGfa, 0);
  assert.deepEqual(g.providers, []);
  assert.ok(g.gfaTotal > 0);
});

// ---------- Dictionary decoding ----------
test('meanings: exact, case-insensitive, and bitmask', () => {
  const aa = GFA_TEST_DICT.providers['nsa/aa'].fields, bb = GFA_TEST_DICT.providers['nsa/bb'].fields[0];
  assert.equal(T.gfaMeaning(aa[2], 'Bad'), 'tampered');
  assert.equal(T.gfaMeaning(aa[2], 'bad'), 'tampered');
  assert.equal(T.gfaMeaning(aa[2], 'constructor'), '');
  assert.equal(T.gfaMeaning(bb, '3'), 'one + two');
  assert.equal(T.gfaMeaning(bb, '130'), 'two + big');
  assert.equal(T.gfaMeaning(bb, '260'), 'unknown bits 260');
  assert.equal(T.gfaMeaning(bb, '0'), '');
  assert.equal(T.gfaMeaning(null, '1'), '');
});

test('analysis labels fields, flags bad values and ranks insights by severity', () => {
  const p = T.parseLogText(realisticGfaDataset(T).join('\n'));
  const g = T.analyzeGfa(p.rLines, GFA_TEST_DICT);
  const aa = g.providers.find((x) => x.key === 'nsa/aa');
  assert.equal(aa.title, 'Alpha check');
  assert.equal(aa.declared, 4);
  assert.deepEqual(aa.fields.slice(0, 4).map((f) => f.label), ['Session', 'Code', 'State', 'Score']);
  assert.ok(aa.fields[0].trace);
  assert.ok(aa.fields[2].values.find((x) => x.v === 'Bad').bad);
  assert.ok(!aa.fields[2].values.find((x) => x.v === '').bad);
  assert.equal(aa.fields[1].values.find((x) => x.v === '1').meaning, 'retry');

  const texts = g.insights.map((x) => x.text);
  assert.equal(g.insights[0].severity, 'critical');
  assert.equal(texts[0], 'retried or dropped, yet scored high');
  assert.ok(texts.includes('gamma present'));
  assert.ok(texts.includes('state gone (field named twice)'));
  assert.ok(!texts.includes('never seen') && !texts.includes('unknown field'));
  assert.ok(texts.some((t) => t.startsWith('nsa/aa · State = "Gone" — missing')));
  assert.ok(texts.some((t) => t.startsWith('nsa/bb · MASK = "130" — two + big')));
  const ranks = g.insights.map((x) => ({ critical: 0, warn: 1, info: 2 })[x.severity]);
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b));
  // A provider the dictionary doesn't describe still shows, untitled.
  const h = g.providers.find((x) => x.key === 'nsc/@h');
  assert.equal(h.title, '');
  assert.equal(h.declared, null);
});

test('dictionary validation explains what is wrong', () => {
  assert.throws(() => T.validateGfaDictionary([]), /JSON object/);
  assert.throws(() => T.validateGfaDictionary({}), /"providers"/);
  assert.throws(() => T.validateGfaDictionary({ providers: { aa: {} } }), /namespace\/provider/);
  assert.throws(() => T.validateGfaDictionary({ providers: { 'n/a': { fields: {} } } }), /"fields" should be an array/);
  assert.throws(() => T.validateGfaDictionary({ providers: {}, insights: {} }), /"insights"/);
  assert.throws(() => T.validateGfaDictionary({ providers: {}, groups: [] }), /"groups"/);
  assert.throws(() => T.validateGfaDictionary({ providers: {}, groups: { x: 'n/a' } }), /group "x"/);
  assert.equal(T.validateGfaDictionary(GFA_TEST_DICT), GFA_TEST_DICT);
});

// ---------- The public page must not embed the private dictionary ----------
test('index.html contains none of the private GFA dictionary wording', { skip: !process.env.GFA_DICTIONARY && 'set GFA_DICTIONARY to check' }, () => {
  const dict = JSON.parse(readFileSync(process.env.GFA_DICTIONARY, 'utf8'));
  const html = readFileSync(INDEX_HTML, 'utf8').toLowerCase();
  // Distinctive wording only: short value meanings ("not applicable") also
  // occur in the page's own cache-status decoder.
  const strings = new Set();
  const add = (s, min = 12) => { if (typeof s === 'string' && s.length >= min) strings.add(s.toLowerCase()); };
  for (const p of Object.values(dict.providers)) {
    add(p.title); add(p.description);
    for (const f of p.fields || []) {
      if (/_/.test(f.name || '')) add(f.name, 8); // identifiers like BM_X_Y, not plain words
      add(f.label); add(f.description);
      for (const m of Object.values({ ...f.values, ...f.bitmask })) add(m, 24);
    }
  }
  for (const i of dict.insights || []) add(i.text);
  for (const name of Object.keys(dict.groups || {})) add(name);
  const leaked = [...strings].filter((s) => html.includes(s));
  assert.deepEqual(leaked, []);
  assert.ok(strings.size > 50, `only ${strings.size} strings checked`);
});

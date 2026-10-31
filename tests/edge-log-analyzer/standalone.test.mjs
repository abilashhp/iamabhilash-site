// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INDEX_HTML, loadTool, CORE_EXPORTS } from './load.mjs';
import { realisticDataset, realisticGfaDataset } from './fixtures.mjs';
import { toStandalone } from '../../scripts/build-standalone-ela.mjs';

const site = readFileSync(INDEX_HTML, 'utf8');

test('standalone build strips site-only blocks and rewrites title and PDF link', () => {
  const out = toStandalone(site);
  assert.ok(!out.includes('site-nav'));
  assert.ok(!out.includes('@site-only'));
  assert.ok(!out.includes('href="/tools"'));
  assert.ok(out.includes('<title>Edge Log Analysis Dashboard</title>'));
  assert.ok(out.includes('href="./log-line-fields.pdf"'));
  assert.ok(!out.includes('/tools/edge-log-analyzer/'));
});

test('standalone build carries no GFA section', () => {
  const out = toStandalone(site);
  assert.doesNotMatch(out, /gfa|ghost fact/i);
  assert.match(site, /id="gfaCard"/); // the site keeps it
});

test('standalone build removes only the marked blocks', () => {
  const out = toStandalone(site);
  // Every line in the marked blocks (markers included) plus one trailing blank
  // line per block, where present; nothing else.
  let marked = 0;
  for (const m of site.matchAll(/^[ \t]*(?:\/\*|<!--) @site-only:begin[\s\S]*?@site-only:end (?:\*\/|-->)\n([ \t]*\n)?/gm)) marked += m[0].split('\n').length - 1;
  assert.equal(site.split('\n').length - out.split('\n').length, marked);
  assert.ok(out.includes('/* @testable:begin */'));
});

test('standalone code gives the same results as the site on the same logs', () => {
  const S = loadTool(toStandalone(site), CORE_EXPORTS);
  const T = loadTool(site, CORE_EXPORTS);
  for (const lines of [realisticDataset(T, { withS: true }), realisticGfaDataset(T, { withS: true })]) {
    const text = lines.join('\n');
    const ps = S.parseLogText(text), pt = T.parseLogText(text);
    const { gfaColumn, ...siteReport } = pt.report;
    assert.deepEqual(ps.report, siteReport);
    assert.deepEqual(ps.lines, pt.lines);
    assert.deepEqual(JSON.parse(JSON.stringify(S.analyze(ps.rLines, ps.fLines))), JSON.parse(JSON.stringify(T.analyze(pt.rLines, pt.fLines))));
    for (const dim of T.GROUP_DIMS.map((d) => d.id)) assert.deepEqual(S.groupBy(ps.rLines, ps.fLines, dim), T.groupBy(pt.rLines, pt.fLines, dim));
    const q = `awk '$2=="r" {print $14} $2=="S" {print $16}' | sort | uniq -c | sort -rn`;
    assert.deepEqual(S.runQueryPipeline(q, ps.lines), T.runQueryPipeline(q, pt.lines));
  }
});

test('standalone build fails loudly when a marker goes missing', () => {
  assert.throws(() => toStandalone(site.replace('<!-- @site-only:end -->', '')), /@site-only/);
  assert.throws(() => toStandalone(site.replace('<title>Edge Log Analyzer — Abhilash HP</title>', '<title>x</title>')), /exactly 1 occurrence/);
  // A GFA block that loses its markers must not ship silently.
  const unmarked = site.replace('  /* @site-only:begin */\n  refreshGfa();\n  /* @site-only:end */\n', '  refreshGfa();\n');
  assert.notEqual(unmarked, site);
  assert.throws(() => toStandalone(unmarked), /expected 13 @site-only blocks|site-only content left/);
});

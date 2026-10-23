// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INDEX_HTML } from './load.mjs';
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

test('standalone build keeps everything else byte-for-byte', () => {
  const out = toStandalone(site);
  const removed = site.split('\n').length - out.split('\n').length;
  // 2 CSS markers + 7 CSS lines, 2 HTML markers + 4 nav lines + 1 trailing blank line.
  assert.equal(removed, 16);
  assert.ok(out.includes('/* @testable:begin */'));
});

test('standalone build fails loudly when a marker goes missing', () => {
  assert.throws(() => toStandalone(site.replace('<!-- @site-only:end -->', '')), /@site-only/);
  assert.throws(() => toStandalone(site.replace('<title>Edge Log Analyzer — Abhilash HP</title>', '<title>x</title>')), /exactly 1 occurrence/);
});

// Generates the standalone Edge Log Analyzer (github.com/abilashhp/edge-log-analyzer)
// from the site copy, which is the source of truth. Edit the tool here, never in the
// standalone repo — it's overwritten on every sync.
//
//   node scripts/build-standalone-ela.mjs <output-dir>
//
// Writes <output-dir>/index.html and <output-dir>/log-line-fields.pdf. Fails loudly if
// any expected marker or string is missing, so a site edit can't silently ship a
// half-converted page.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/tools/edge-log-analyzer');

// Blocks wrapped in /* @site-only:begin */ … /* @site-only:end */ (CSS) or
// <!-- @site-only:begin --> … <!-- @site-only:end --> (HTML) exist only on the site:
// the nav bar linking back to /tools. One trailing blank line is dropped with each block.
const SITE_ONLY = /^[ \t]*(?:\/\*|<!--) @site-only:begin (?:\*\/|-->)\n[\s\S]*?^[ \t]*(?:\/\*|<!--) @site-only:end (?:\*\/|-->)\n(?:[ \t]*\n)?/gm;
const EXPECTED_SITE_ONLY_BLOCKS = 2;

const REPLACEMENTS = [
  ['<title>Edge Log Analyzer — Abhilash HP</title>', '<title>Edge Log Analysis Dashboard</title>'],
  // The standalone page is served from its own root, next to the PDF.
  ['href="/tools/edge-log-analyzer/log-line-fields.pdf"', 'href="./log-line-fields.pdf"'],
];

export function toStandalone(html) {
  const blocks = html.match(SITE_ONLY) || [];
  if (blocks.length !== EXPECTED_SITE_ONLY_BLOCKS) {
    throw new Error(`expected ${EXPECTED_SITE_ONLY_BLOCKS} @site-only blocks, found ${blocks.length}`);
  }
  let out = html.replace(SITE_ONLY, '');
  if (out.includes('@site-only')) throw new Error('unbalanced @site-only marker left after stripping');

  for (const [from, to] of REPLACEMENTS) {
    const count = out.split(from).length - 1;
    if (count !== 1) throw new Error(`expected exactly 1 occurrence of ${JSON.stringify(from)}, found ${count}`);
    out = out.replace(from, to);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: node scripts/build-standalone-ela.mjs <output-dir>');
    process.exit(2);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'index.html'), toStandalone(readFileSync(resolve(SRC_DIR, 'index.html'), 'utf8')));
  copyFileSync(resolve(SRC_DIR, 'log-line-fields.pdf'), resolve(outDir, 'log-line-fields.pdf'));
  console.log(`wrote standalone Edge Log Analyzer to ${outDir}`);
}

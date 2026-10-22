// Loads the pure (DOM-free) parts of the single-file tool for testing: every
// block between /* @testable:begin */ and /* @testable:end */ in index.html.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const INDEX_HTML = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/tools/edge-log-analyzer/index.html');

const EXPORTS = [
  'RF', 'FF', 'SF', 'NBINS', 'MIN_N_FOR_P95', 'escapeHtml', 'splitFields', 'normalizeUri', 'normPathRegex', 'minMax',
  'buildDrillQuery', 'statusClassDrill', 'parseLogText', 'parseReportText', 'analyze', 'groupBy', 'GROUP_DIMS',
  'binIndexOf', 'makeRangePredicate', 'runQueryPipeline', 'translateEnglish',
];

export function loadTool() {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const blocks = [...html.matchAll(/\/\* @testable:begin \*\/([\s\S]*?)\/\* @testable:end \*\//g)].map((m) => m[1]);
  if (blocks.length < 3) throw new Error(`expected 3 testable blocks in index.html, found ${blocks.length}`);
  return new Function(`${blocks.join('\n')}\nreturn { ${EXPORTS.join(', ')} };`)();
}

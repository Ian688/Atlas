// Print the shared column-scale report as JSON.
//
// The scale is defined once, in `web/hierarchy.js`, and both projections read
// it. This driver exists so the readability bench reads the same definition
// instead of re-implementing the formula in Python -- a second implementation
// would drift from the first exactly like the two hierarchies did, and the
// drift would be invisible because both would look reasonable on their own.
//
// Usage:
//   node scripts/scale_report.mjs --fixture realistic
//   echo '[0,3,1056]' | node scripts/scale_report.mjs
//
// stdlib only; no network, no dependencies.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HIERARCHY = path.join(HERE, '..', 'web', 'hierarchy.js');

// A distribution shaped like a real package: most files hold nothing or a
// couple of functions, a handful hold a lot, and one already-compiled bundle
// dwarfs everything. The exact numbers matter less than the shape, because the
// shape is what a linear height fails on.
const FIXTURES = {
  realistic: [
    ...Array(59).fill(0),
    1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 5, 5, 6, 7, 8, 9, 11,
    14, 18, 20, 21, 26, 31, 38, 44, 50, 51, 63, 80, 96, 120, 174, 233, 301, 512, 1056,
  ],
  flat: [0, 0, 0, 0],
  single: [1056],
};

function counts() {
  const index = process.argv.indexOf('--fixture');
  if (index !== -1) {
    const name = process.argv[index + 1];
    if (!Object.prototype.hasOwnProperty.call(FIXTURES, name)) {
      process.stderr.write(`unknown_fixture:${name}\n`);
      process.exit(2);
    }
    return FIXTURES[name];
  }
  const text = readFileSync(0, 'utf8').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    process.stderr.write('expected a JSON array of counts on stdin\n');
    process.exit(2);
  }
  return parsed;
}

const context = vm.createContext({ console });
vm.runInContext(readFileSync(HIERARCHY, 'utf8'), context, { filename: 'web/hierarchy.js' });
const run = (expr, args) => vm.runInContext(`(${expr})`, context)(...(args || []));

const list = counts();
const report = run('(counts) => atlasScaleReport(counts)', [list]);
const ruler = run('(counts) => atlasScaleRuler(counts)', [list]);
const tiers = [0, 1, 8, 9, 20, 21, 50, 51, 1056, 1000000].map((n) => ({
  n,
  height: run('(n) => atlasScaleHeight(n)', [n]),
  tier: run('(n) => atlasScaleTier(n)', [n]),
  radius: run('(n) => atlasScaleRadius(n)', [n]),
  compressed: run('(n) => atlasScaleCompression(n)', [n]).compressed,
}));

process.stdout.write(JSON.stringify({ schema: 'atlas.view-readability.v1', report, ruler, probes: tiers }, null, 2));
process.stdout.write('\n');

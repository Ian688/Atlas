// 单独复现索引里的解析这一步：按 is_source 的口径收集文件，直接喂给
// workers/typescript/worker.mjs，量出它到底输出多少字节（上限 32 MiB）。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.argv[2] || '/Users/yinsijie/CodeRepo/Atlas';
const SKIP = new Set(['.git', 'target', 'node_modules', 'local-state', '.codebuddy']);
const EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) {
      const rel = path.relative(ROOT, full);
      if (EXTS.has(path.extname(entry.name)) || entry.name === 'package.json') out.push(rel);
    }
  }
  return out;
}

const rels = walk(ROOT, []).sort();
const files = rels.map((rel) => ({ path: rel, content: fs.readFileSync(path.join(ROOT, rel), 'utf8') }));
const request = { schema: 'atlas.parse-request.v1', snapshot_id: 'probe', files };
const payload = JSON.stringify(request);
console.log(`files=${files.length} payload_bytes=${payload.length} (${(payload.length / 1048576).toFixed(1)} MiB)`);

const worker = path.join(ROOT, 'workers/typescript/worker.mjs');
const started = Date.now();
const run = spawnSync('node', ['--max-old-space-size=1024', worker], {
  cwd: path.dirname(worker),
  input: payload,
  maxBuffer: 1024 * 1024 * 1024,
});
const seconds = (Date.now() - started) / 1000;
const out = run.stdout || Buffer.alloc(0);
const err = run.stderr || Buffer.alloc(0);
console.log(`exit=${run.status} seconds=${seconds.toFixed(1)} stdout_bytes=${out.length} (${(out.length / 1048576).toFixed(1)} MiB) stderr=${JSON.stringify(err.toString().slice(0, 500))}`);
console.log(`stdout>32MiB ? ${out.length > 32 * 1024 * 1024}`);
if (out.length > 32 * 1024 * 1024) {
  const parsed = JSON.parse(out.toString());
  const size = (v) => Buffer.byteLength(JSON.stringify(v));
  const parts = Object.entries(parsed)
    .map(([k, v]) => [k, size(v)])
    .sort((a, b) => b[1] - a[1]);
  for (const [k, bytes] of parts) console.log(`  ${k.padEnd(16)} ${(bytes / 1048576).toFixed(2)} MiB`);
  const flow = parsed.flow;
  if (flow && Array.isArray(flow.functions)) {
    const biggest = flow.functions
      .map((f) => [f.symbol || f.name || f.id, Buffer.byteLength(JSON.stringify(f))])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    console.log('  biggest flow functions:');
    for (const [name, bytes] of biggest) console.log(`    ${String(name).slice(0, 60).padEnd(60)} ${(bytes / 1024).toFixed(0)} KiB`);
  }
}

// 引擎的每函数预算：MAX_BINDINGS_PER_FUNCTION / MAX_SCOPES_PER_FUNCTION = 4000。
if (process.env.ATLAS_PROBE_BUDGETS) {
  const parsed = JSON.parse((run.stdout || Buffer.alloc(0)).toString());
  const flow = parsed.flow || {};
  const fns = flow.functions || [];
  const over = (f) => f.bindings.length > 4000 || f.scopes.length > 4000;
  const count = (f) => ({ bindings: f.bindings.length, scopes: f.scopes.length, body: (f.body || []).length });
  const offenders = fns
    .map((f) => [f.symbol, count(f)])
    .filter(([, c]) => c.bindings > 4000 || c.scopes > 4000)
    .sort((a, b) => b[1].bindings + b[1].scopes - (a[1].bindings + a[1].scopes));
  console.log(`flow.functions=${fns.length} over-budget=${fns.filter(over).length}`);
  for (const [symbol, c] of offenders.slice(0, 6)) {
    console.log(`  ${symbol}  bindings=${c.bindings} scopes=${c.scopes} body=${c.body}`);
  }
  const max = fns.map((f) => ({ symbol: f.symbol, ...count(f) })).sort((a, b) => b.bindings - a.bindings)[0];
  if (max) console.log(`  max-bindings: ${max.symbol} bindings=${max.bindings} scopes=${max.scopes} body=${max.body}`);
}

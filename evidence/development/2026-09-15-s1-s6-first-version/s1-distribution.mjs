// S1: 复制后的分发包，从另一个工作目录启动，完成补丁验证 / 应用 / 撤销。
//
// 与旧 distribution.cjs 的差别：这次断言的是修复后的完整链（验证必须真的
// 跑起来并跑测试、应用/撤销后文件字节正确）。脚本只做 HTTP 层的驱动与断言；
// 浏览器旅程由 S4 单独做，这里不冒充。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = '/Users/yinsijie/CodeRepo/Atlas';
// 含空格：路径里出现空格时，任何依赖 cwd 或未经引用的资源定位都会暴露。
const BASE = '/tmp/Atlas 首版 S1';
const DIST = path.join(BASE, 'dist');
const PROJECT = path.join(BASE, 'proj');
const STORE = path.join(BASE, 'store');
const OUT = process.argv[2] || path.join(REPO, 'evidence/development/2026-09-15-s1-s6-first-version');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n     ${String(detail).replace(/\n/g, '\n     ')}` : ''}`);
}

const ORIGINAL = `export function applyDiscount(amount, percent) {
  const rate = percent;
  return Math.round(amount * (1 - rate));
}
`;
const PATCHED = `export function applyDiscount(amount, percent) {
  // 边界：折扣率必须落在 0..1，负数与超过 1 都按端点处理。
  const rate = percent < 0 ? 0 : percent > 1 ? 1 : percent;
  return Math.round(amount * (1 - rate));
}
`;
const TEST_FILE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('normal discount is unchanged', () => {
  assert.equal(applyDiscount(100, 0.2), 80);
});

test('percent is clamped at both ends', () => {
  assert.equal(applyDiscount(100, -1), 100);
  assert.equal(applyDiscount(100, 5), 0);
});
`;

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });
fs.mkdirSync(path.join(PROJECT, 'test'), { recursive: true });
fs.writeFileSync(path.join(PROJECT, 'src', 'price.js'), ORIGINAL);
fs.writeFileSync(path.join(PROJECT, 'test', 'price.test.mjs'), TEST_FILE);
fs.writeFileSync(path.join(PROJECT, 'package.json'), JSON.stringify({
  name: 's1-sample', type: 'module', private: true,
}, null, 2) + '\n');
fs.cpSync(path.join(REPO, 'dist/atlas-local-darwin-x64'), DIST, { recursive: true });

const diff = [
  '--- a/src/price.js',
  '+++ b/src/price.js',
  '@@ -1,3 +1,5 @@',
  ' export function applyDiscount(amount, percent) {',
  '-  const rate = percent;',
  '+  // 边界：折扣率必须落在 0..1，负数与超过 1 都按端点处理。',
  '+  const rate = percent < 0 ? 0 : percent > 1 ? 1 : percent;',
  '   return Math.round(amount * (1 - rate));',
  ' }',
  '',
].join('\n');

const ATLAS = path.join(DIST, 'atlas');
function run(args, opts = {}) {
  const r = spawnSync(ATLAS, args, { encoding: 'utf8', cwd: opts.cwd || BASE, env: process.env });
  return { code: r.status, stdout: `${r.stdout || ''}${r.stderr || ''}` };
}

const child = spawn('bash', [path.join(DIST, 'start.sh'), PROJECT], {
  cwd: '/',
  env: {
    ...process.env,
    ATLAS_STORE: STORE,
    ATLAS_TEST_ARGV: JSON.stringify(['node', '--test']),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });
const stop = () => { try { child.kill('SIGTERM'); } catch {} };
process.on('exit', stop);

async function waitForUrl(ms = 90_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const m = /http:\/\/127\.0\.0\.1:\d+\/#token=([0-9a-f-]+)/.exec(log);
    if (m) return { url: m[0].split('#')[0], token: m[1] };
    if (/错误/.test(log) && !/正在索引/.test(log)) throw new Error(`启动失败:\n${log}`);
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`等待启动超时:\n${log}`);
}

let base = '', token = '';
async function api(name, { method = 'GET', params, body } = {}) {
  const url = new URL(`/api/${name}`, base);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = await r.json().catch(() => null);
  return { status: r.status, body: parsed };
}

// grace_ms：重试时旧行仍是 failed，服务端认领是异步的。给一小段宽限期，
// 否则第一次轮询就把"上一次的失败"当成这次重试的结果。
async function pollVerify(id, { ms = 180_000, graceMs = 0 } = {}) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const answer = (await api('patch/verify', { params: { id } })).body;
    const state = answer.job?.state;
    const terminal = state === 'completed' || state === 'failed' || state === 'cancelled';
    if (terminal && (Date.now() - started) >= graceMs) return { state, answer };
    await new Promise(r => setTimeout(r, 500));
  }
  return { state: 'timeout', answer: null };
}

try {
  const boot = await waitForUrl();
  base = boot.url; token = boot.token;
  check('从另一个工作目录(cwd=/)启动含空格路径的分发包', true, `${base} (${log.match(/受控运行能力：[^\n]*/)?.[0] || ''})`);

  const report = (await api('report')).body;
  const analysis = report.id;
  check('服务可读且返回固定分析版本', Boolean(analysis), analysis);

  const found = (await api('search', { params: { q: 'applyDiscount', kind: 'function' } })).body;
  const hit = (found.items || []).find(n => n.name === 'applyDiscount');
  check('按名字找到目标函数', Boolean(hit), hit ? `${hit.path}:${hit.name}` : JSON.stringify(found).slice(0, 200));

  const proposed = await api('patch/propose', { method: 'POST', body: { entity: hit.id, diff } });
  const proposal = proposed.body?.proposal;
  check('登记多行补丁提案并通过固定快照校验', proposal?.state === 'proposed',
    proposal ? `${proposal.id} · ${proposal.state}` : JSON.stringify(proposed.body).slice(0, 300));

  const contract = (await api('contract')).body;
  check('启动配置里声明的测试命令对页面可见',
    JSON.stringify(contract.verification?.test_argv) === JSON.stringify(['node', '--test']),
    JSON.stringify(contract.verification));

  const queued = await api('patch/verify', { method: 'POST', body: { id: proposal.id } });
  check('页面触发的验证进入服务端队列', queued.body?.outcome === 'queued', JSON.stringify(queued.body?.job?.id));

  const first = await pollVerify(proposal.id);
  const verification = first.answer?.proposal?.verification;
  check('后台验证作业完成（不再是 worker_missing）', first.state === 'completed',
    `state=${first.state} reason=${first.answer?.job?.terminal_reason || '无'}`);
  check('验证在隔离副本里真的跑了声明的测试',
    verification?.test?.ran === true && verification?.test?.passed === true,
    JSON.stringify(verification?.test).slice(0, 400));

  // 重跑同一份已完成的验证：必须回答"已经完成"，而不是再次失败。
  const again = await api('patch/verify', { method: 'POST', body: { id: proposal.id } });
  check('已验证的提案再次验证被具名拒绝（不静默重跑，也不报成功）',
    again.status === 409 && again.body?.error === 'proposal_not_verifiable' && /verified/.test(again.body?.detail || ''),
    JSON.stringify({ status: again.status, body: again.body }).slice(0, 300));

  // 应用 / 撤销：核对真实字节。写目录以服务端 canonicalize 后的路径为准
  // （页面也是从契约里拿到它再逐字回显），脚本不另行假设。
  const writes = contract.writes;
  const root = writes?.root;
  check('写路径只在启动时授权的目录内', writes?.enabled === true && root === fs.realpathSync(PROJECT),
    JSON.stringify(writes));
  const applied = await api('patch/apply', { method: 'POST', body: { id: proposal.id, confirm_path: root } });
  check('应用到授权目录', applied.body?.proposal?.state === 'applied', JSON.stringify(applied.body).slice(0, 200));
  const appliedBytes = fs.readFileSync(path.join(PROJECT, 'src/price.js'), 'utf8');
  check('应用后文件字节等于补丁内容', appliedBytes === PATCHED,
    appliedBytes === PATCHED ? `${appliedBytes.length} 字节` : JSON.stringify(appliedBytes));

  const reverted = await api('patch/revert', { method: 'POST', body: { id: proposal.id, confirm_path: root } });
  check('撤销成功', reverted.body?.proposal?.state === 'reverted', JSON.stringify(reverted.body).slice(0, 200));
  const revertedBytes = fs.readFileSync(path.join(PROJECT, 'src/price.js'), 'utf8');
  check('撤销后文件逐字节回到原始内容', revertedBytes === ORIGINAL,
    revertedBytes === ORIGINAL ? `${revertedBytes.length} 字节` : JSON.stringify(revertedBytes));

  // 一个会让测试失败的补丁：验证必须说失败，而不是把没跑说成通过。
  const breaking = [
    '--- a/src/price.js',
    '+++ b/src/price.js',
    '@@ -1,3 +1,3 @@',
    ' export function applyDiscount(amount, percent) {',
    '-  const rate = percent;',
    '+  const rate = percent + 1;',
    '   return Math.round(amount * (1 - rate));',
    ' }',
    '',
  ].join('\n');
  const bad = await api('patch/propose', { method: 'POST', body: { entity: hit.id, diff: breaking } });
  const badProposal = bad.body?.proposal;
  await api('patch/verify', { method: 'POST', body: { id: badProposal.id } });
  const badRun = await pollVerify(badProposal.id);
  const badTest = badRun.answer?.proposal?.verification?.test;
  check('让测试失败的补丁被如实报告为失败（有退出码，不是"没跑"）',
    badRun.state === 'completed' && badTest?.ran === true && badTest?.passed === false && badTest?.exit_code !== null,
    JSON.stringify(badTest).slice(0, 400));

  // 用户检出目录自始至终没有被验证过程改动。
  check('验证过程没有改动用户检出目录',
    fs.readFileSync(path.join(PROJECT, 'src/price.js'), 'utf8') === ORIGINAL);

  // 失败的验证必须给出具名原因，并且可以重试。这里用 CLI 故意把 worker 指到
  // 一个不存在的路径（复现历史上那个 worker_missing），确认失败原因具名，再由
  // 页面用服务端自己的资源重试——重试必须真的跑起来。
  const retry = [
    '--- a/src/price.js',
    '+++ b/src/price.js',
    '@@ -1,3 +1,3 @@',
    ' export function applyDiscount(amount, percent) {',
    '-  const rate = percent;',
    '+  const rate = percent || 0;',
    '   return Math.round(amount * (1 - rate));',
    ' }',
    '',
  ].join('\n');
  const third = await api('patch/propose', { method: 'POST', body: { entity: hit.id, diff: retry } });
  const thirdId = third.body?.proposal?.id;
  const owner = `session-${token.slice(0, 12)}`;
  const poisoned = run([
    '--store', STORE, 'patch', 'verify', thirdId,
    '--enqueue', '--owner', owner, '--worker', '/nonexistent/worker.mjs',
  ]);
  check('故意指向缺失 worker 的验证可以入队', poisoned.code === 0, poisoned.stdout.slice(0, 200));
  const worked = run(['--store', STORE, 'job', 'work', '--once']);
  check('缺失 worker 的验证作业失败并给出具名原因',
    /worker_missing/.test(worked.stdout),
    worked.stdout.slice(0, 300));
  const retried = await api('patch/verify', { method: 'POST', body: { id: thirdId } });
  check('页面用服务端资源重试同一份失败的验证', retried.status === 200 && retried.body?.outcome === 'retrying',
    JSON.stringify({ status: retried.status, outcome: retried.body?.outcome, state: retried.body?.job?.state }).slice(0, 200));
  const retriedRun = await pollVerify(thirdId, { graceMs: 5000 });
  check('重试后验证真的跑起来并完成（attempt 递增，不是停在失败态）',
    retriedRun.state === 'completed'
    && (retriedRun.answer?.job?.attempt ?? 0) >= 2
    && retriedRun.answer?.proposal?.verification?.test?.ran === true,
    `state=${retriedRun.state} attempt=${retriedRun.answer?.job?.attempt} passed=${retriedRun.answer?.proposal?.verification?.test?.passed}`);

  // 二进制自己能定位 worker：不带 --worker、从任意 cwd 直接跑前台验证也必须成功。
  // 这正是分发包原本失败的形状（资源定位曾依赖调用者 cwd）。
  const fifth = [
    '--- a/src/price.js',
    '+++ b/src/price.js',
    '@@ -1,3 +1,3 @@',
    ' export function applyDiscount(amount, percent) {',
    '-  const rate = percent;',
    '+  const rate = Number(percent) || 0;',
    '   return Math.round(amount * (1 - rate));',
    ' }',
    '',
  ].join('\n');
  const fifthProposal = (await api('patch/propose', { method: 'POST', body: { entity: hit.id, diff: fifth } })).body?.proposal;
  const bare = run(['--store', STORE, 'patch', 'verify', fifthProposal.id,
    '--test-argv', '["node","--test"]'], { cwd: '/' });
  check('CLI 不带 --worker、从 / 执行前台验证也找得到 worker',
    bare.code === 0 && /"ran": ?true/.test(bare.stdout),
    `exit=${bare.code} ${bare.stdout.slice(0, 200)}`);
} catch (error) {
  check('脚本执行完成', false, String(error && error.stack || error));
} finally {
  fs.writeFileSync(path.join(OUT, 's1-results.json'), JSON.stringify({ results, log }, null, 2));
  fs.writeFileSync(path.join(OUT, 's1-log.txt'), log);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  stop();
  process.exit(failed ? 1 : 0);
}

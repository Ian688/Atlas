// S5：真实 Agent 任务 —— 准备样本、启动服务、给出可复用的调用凭据。
//
// 这个脚本只做"布置考场"：建一个金额计算的临时样本，用最终分发包启动服务，
// 把 URL/令牌写到一个文件里交给 Agent。任务本身由 Agent 用公开接口完成，
// 脚本不替它做任何探索、提案或验证。
import fs from 'node:fs';
import p from 'node:path';
import cp from 'node:child_process';

const REPO = '/Users/yinsijie/CodeRepo/Atlas';
const OUT = p.dirname(new URL(import.meta.url).pathname);
const BASE = process.env.ATLAS_S5_BASE || '/tmp/Atlas 首版 S5';
const DIST = p.join(BASE, 'dist');
const STORE = p.join(BASE, 'store');
const PROJECT = p.join(BASE, 'shop');

const MONEY = `// 金额计算：折扣券直接乘算，边界没有约束。
export function charge(amount, coupon) {
  if (amount <= 0) {
    return 0;
  }
  const rate = coupon && coupon.rate ? coupon.rate : 0;
  const total = amount * (1 - rate);
  return Math.round(total * 100) / 100;
}

export function refundable(amount) {
  return amount > 0 && amount <= 1000;
}
`;
const ORDER = `import { charge } from './money.js';

export function checkout(items, coupon) {
  let sum = 0;
  for (const item of items) {
    sum = sum + item.amount;
  }
  return charge(sum, coupon);
}
`;
const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { charge, refundable } from '../src/money.js';

test('charge applies the coupon', () => {
  assert.equal(charge(100, { rate: 0.2 }), 80);
});

test('charge returns zero for zero or negative amounts', () => {
  assert.equal(charge(0, null), 0);
  assert.equal(charge(-5, null), 0);
});

test('refundable covers the normal range', () => {
  assert.equal(refundable(500), true);
  assert.equal(refundable(2000), false);
});
`;

// 只重建分发包副本与样本文件，**不删 store**：store 里存着 Agent 提交的提案
// 与验证记录，那是这一项的证据。样本内容不变，所以 analysis id 也不变，
// 重跑脚本不会让已有提案失去对应的分析版本。
fs.rmSync(p.join(BASE, 'dist'), { recursive: true, force: true });
fs.rmSync(p.join(BASE, 'shop'), { recursive: true, force: true });
fs.mkdirSync(p.join(PROJECT, 'src'), { recursive: true });
fs.mkdirSync(p.join(PROJECT, 'test'), { recursive: true });
fs.writeFileSync(p.join(PROJECT, 'package.json'), JSON.stringify({ name: 'shop', type: 'module', private: true }, null, 2) + '\n');
fs.writeFileSync(p.join(PROJECT, 'src', 'money.js'), MONEY);
fs.writeFileSync(p.join(PROJECT, 'src', 'order.js'), ORDER);
fs.writeFileSync(p.join(PROJECT, 'test', 'money.test.mjs'), TEST);
fs.cpSync(p.join(REPO, 'dist/atlas-local-darwin-x64'), DIST, { recursive: true });

const proc = cp.spawn('bash', [p.join(DIST, 'start.sh'), PROJECT], {
  cwd: '/',
  env: { ...process.env, ATLAS_STORE: STORE, ATLAS_TEST_ARGV: '["node","--test"]' },
  detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
proc.stdout.on('data', d => { log += d; process.stdout.write(d); });
proc.stderr.on('data', d => { log += d; });
for (let i = 0; i < 400; i += 1) {
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f-]+)/.exec(log);
  if (m) {
    const credentials = {
      url: `http://127.0.0.1:${m[1]}/`,
      token: m[2],
      project: PROJECT,
      store: STORE,
      note: '服务由本脚本启动并保持运行；任务结束后由 s5-agent-check 停止。',
    };
    fs.writeFileSync(p.join(OUT, process.env.ATLAS_S5_CREDENTIALS || 's5-credentials.json'), JSON.stringify(credentials, null, 2));
    console.log('\n凭据已写入 s5-credentials.json');
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 100));
}
throw new Error(`launcher timeout: ${log}`);

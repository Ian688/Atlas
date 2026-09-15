// S4（第二段）：结构不同的临时项目（多层目录 + 跨目录 import 链 + package.json）。
//
// tour 是单层 src；这里换成 lib/util、lib/core、app 三层互相引用，验证"换一
// 个项目结构还是走得通"，而不是只对示例项目有效。再补一次"停止服务重开"。
import fs from 'node:fs';
import p from 'node:path';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const REPO = '/Users/yinsijie/CodeRepo/Atlas';
const OUT = p.dirname(new URL(import.meta.url).pathname);
const BASE = '/tmp/Atlas 首版 S4B';
const DIST = p.join(BASE, 'dist');
const STORE = p.join(BASE, 'store');
const PROJECT = p.join(BASE, 'proj2');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const FORMAT = `export function percent(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * 100 * factor) / factor;
}

export function label(name) {
  return \`[\${name}]\`;
}
`;
const ENGINE = `import { percent, label } from '../util/format.js';

export function start(job) {
  return { name: label(job.name), progress: percent(job.done / job.total, 2) };
}
`;
const MAIN = `import { start } from '../lib/core/engine.js';

export function run(jobs) {
  return jobs.map((job) => start(job));
}
`;
// 补丁把"百分比"改成"千分比"：两侧结果必须明显不同（12.34 / 123.4），
// 否则对照区分不出这次修改。（早先用 Math.round -> Math.floor，浮点下两者
// 在这个输入上给出同一个值，对照显示不出差异，是样本设计问题不是产品问题。）
const DIFF = [
  '--- a/lib/util/format.js',
  '+++ b/lib/util/format.js',
  '@@ -1,4 +1,4 @@',
  ' export function percent(value, digits) {',
  '   const factor = 10 ** digits;',
  '-  return Math.round(value * 100 * factor) / factor;',
  '+  return Math.round(value * 1000 * factor) / factor;',
  ' }',
  '',
].join('\n');

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, result: ok ? 'PASS' : 'FAIL', detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== null && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
}
const wait = ms => new Promise(r => setTimeout(r, ms));

fs.rmSync(BASE, { recursive: true, force: true });
for (const dir of ['lib/util', 'lib/core', 'app', 'test']) fs.mkdirSync(p.join(PROJECT, dir), { recursive: true });
fs.writeFileSync(p.join(PROJECT, 'package.json'), JSON.stringify({ name: 'proj2', type: 'module', private: true }, null, 2) + '\n');
fs.writeFileSync(p.join(PROJECT, 'lib/util/format.js'), FORMAT);
fs.writeFileSync(p.join(PROJECT, 'lib/core/engine.js'), ENGINE);
fs.writeFileSync(p.join(PROJECT, 'app/main.js'), MAIN);
fs.writeFileSync(p.join(PROJECT, 'test/format.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { label } from '../lib/util/format.js';

test('label wraps a name', () => {
  assert.equal(label('a'), '[a]');
});
`);
fs.cpSync(p.join(REPO, 'dist/atlas-local-darwin-x64'), DIST, { recursive: true });

let proc = null, log = '', browser;
async function launch() {
  log = '';
  proc = cp.spawn('bash', [p.join(DIST, 'start.sh'), PROJECT], {
    cwd: '/',
    env: { ...process.env, ATLAS_STORE: STORE, ATLAS_TEST_ARGV: '["node","--test"]' },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 400; i += 1) {
    const m = /http:\/\/127\.0\.0\.1:\d+\/#token=([0-9a-f-]+)/.exec(log);
    if (m) return { url: m[0].split('#')[0], token: m[1] };
    if (proc.exitCode !== null) throw new Error(`launcher exited ${proc.exitCode}: ${log}`);
    await wait(100);
  }
  throw new Error(`launcher timeout: ${log}`);
}
async function stop() {
  if (!proc || proc.exitCode !== null) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 40 && proc.exitCode === null; i += 1) await wait(100);
  await wait(300);
}

try {
  let session = await launch();
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  let context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  let page = await context.newPage();
  page.on('pageerror', e => record('页面无 JS 异常', false, String(e.message)));
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 30000 });

  // 跨目录的调用链：run -> start -> percent。先选中链的中间一层。
  await page.locator('#fn-search').click();
  await page.locator('#fn-search').pressSequentially('start', { delay: 35 });
  await page.waitForFunction(() => /start/.test(document.querySelector('#fn-list button')?.textContent || ''), null, { timeout: 30000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'start', null, { timeout: 30000 });
  record('多层目录项目里选中中间层函数', true, await page.locator('#selection-path').innerText());

  await page.waitForFunction(() => document.querySelectorAll('#graph g.node-group').length > 1, null, { timeout: 30000 });
  await wait(1500);
  const neighbour = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('#graph g.node-group')];
    const t = groups.find(g => {
      const text = g.querySelector('text')?.textContent || '';
      return text && text !== 'start';
    });
    return t ? t.querySelector('text').textContent : null;
  });
  await page.locator('#graph g.node-group', { hasNotText: 'start' }).first().click({ position: { x: 20, y: 8 }, timeout: 8000 }).catch(async () => {
    await page.evaluate(() => {
      const g = [...document.querySelectorAll('#graph g.node-group')]
        .find(el => !/start/.test(el.querySelector('text')?.textContent || ''));
      if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  });
  await page.waitForFunction(name => document.getElementById('selection-name')?.textContent === name, neighbour, { timeout: 30000 });
  record('跨目录关系可点击（start 的邻居）', true, { neighbour, path: await page.locator('#selection-path').innerText() });

  // 运行 percent：参数是标量，跨文件导入不需要声明。
  await page.locator('#fn-search').fill('');
  await page.locator('#fn-search').pressSequentially('percent', { delay: 35 });
  await page.waitForFunction(() => /percent/.test(document.querySelector('#fn-list button')?.textContent || ''), null, { timeout: 30000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'percent', null, { timeout: 30000 });
  await page.locator('.wb-tabs [data-mode="run"]').click();
  await page.locator('#exec-param-0').waitFor({ timeout: 20000 });
  await page.locator('#exec-param-0').click();
  await page.locator('#exec-param-0').pressSequentially('0.1234', { delay: 25 });
  await page.locator('#exec-param-1').click();
  await page.locator('#exec-param-1').pressSequentially('2', { delay: 25 });
  await page.locator('#exec-run').click();
  await page.waitForFunction(() => /returned/.test(document.getElementById('exec-result')?.textContent || ''), null, { timeout: 40000 });
  record('跨目录导入的函数可以真实运行', /12\.34/.test(await page.locator('#exec-result').innerText()),
    (await page.locator('#exec-result').innerText()).split('\n').slice(0, 4));

  // 补丁 → 验证 → 对照
  await page.locator('.wb-tabs [data-mode="review"]').click();
  await page.locator('#patch-input').click();
  await page.locator('#patch-input').fill(DIFF);
  await page.locator('#patch-propose').click();
  await page.waitForFunction(() => /提案已登记|已经登记过|未通过固定快照校验/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 20000 });
  const state1 = await page.locator('#status').innerText();
  if (/未通过固定快照校验/.test(state1)) record('不同结构项目的补丁通过固定快照校验', false, state1);
  await page.locator('#patch-body button', { hasText: '验证（隔离副本重新派生分析）' }).first().click();
  await page.waitForFunction(() => /观测：测试命令/.test(document.getElementById('patch-body')?.textContent || ''), null, { timeout: 180000 });
  record('不同结构项目的隔离验证跑通声明测试',
    /退出码\s*0/.test(await page.locator('#patch-body').innerText()),
    (await page.locator('#patch-body').innerText()).split('\n').filter(l => /观测/.test(l)).slice(0, 2));
  await page.locator('#patch-body button', { hasText: '以相同输入运行两侧' }).first().click();
  await page.waitForFunction(() => /两侧同一输入/.test(document.querySelector('[id^="compare-result-"]')?.textContent || ''), null, { timeout: 60000 });
  await wait(1200);
  // textContent 而不是 innerText：innerText 只算可见文本，会把被折叠/溢出的
  // 补丁侧整段漏掉，从而把"渲染没显示"误读成"补丁侧没跑"。
  const cmp = await page.locator('[id^="compare-result-"]').first().textContent();
  // 同时直接问服务端一次：这条断言不依赖页面渲染，只关心两侧是不是都真跑了。
  const verifiedId = await page.evaluate(() => (state.patches || []).find(item => item.state === 'verified')?.id || null);
  const raw = await page.evaluate(async ({ url, token, proposalId }) => {
    const r = await fetch(`${url}api/exec-compare`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity: 'percent', args: [0.1234, 2], proposal_id: proposalId }),
    });
    return { status: r.status, data: await r.json() };
  }, { url: session.url, token: session.token, proposalId: verifiedId }).catch(e => ({ status: 0, error: String(e.message) }));
  record('不同结构项目的前后对照两侧都真实运行（12.34 / 123.4）',
    /12\.34/.test(cmp) && /123\.4/.test(cmp) && /补丁（验证派生的候选版本）[\s\S]*verdict returned/.test(cmp),
    { rendered: (cmp || '').replace(/\s+/g, ' ').slice(0, 400), raw: raw.status === 200 ? {
      base: raw.data.base?.record?.value, patched: raw.data.patched?.record?.value,
    } : raw });
  await page.screenshot({ path: p.join(OUT, 's4-proj2-compare.png'), fullPage: true });

  // 停止服务再启动：这个项目上的任务也要接得上。
  await wait(1500);
  const before = await page.evaluate(() => ({
    selection: document.getElementById('selection-name').textContent,
    mode: state.mode,
    drafts: Object.keys(state.execDrafts).length,
  }));
  await page.close();
  await context.close();
  await stop();

  session = await launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  page = await context.newPage();
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'percent', null, { timeout: 30000 });
  await page.waitForFunction(() => /已恢复上次任务|重定位/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  const after = await page.evaluate(() => ({
    selection: document.getElementById('selection-name').textContent,
    mode: state.mode,
    drafts: Object.keys(state.execDrafts).length,
  }));
  record('不同结构项目停止服务重开后任务接得上',
    after.selection === before.selection && after.mode === before.mode && after.drafts > 0,
    { before, after });
  await page.screenshot({ path: p.join(OUT, 's4-proj2-restart.png'), fullPage: true });

  await page.close();
  await context.close();
} catch (error) {
  record('harness', false, String(error && error.stack || error));
} finally {
  if (browser) await browser.close();
  await stop();
  const exit_code = checks.some(c => c.result === 'FAIL') ? 1 : 0;
  fs.writeFileSync(p.join(OUT, 's4-proj2-results.json'), JSON.stringify({
    scope: '最终分发包 + 真实 Chrome；多层目录、跨目录 import 链的临时项目',
    checks, exit_code,
  }, null, 2));
  console.log(`\n${checks.filter(c => c.result === 'PASS').length}/${checks.length} 通过`);
  process.exitCode = exit_code;
}

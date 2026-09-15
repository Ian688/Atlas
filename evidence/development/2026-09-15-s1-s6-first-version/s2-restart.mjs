// S2: 真正停止服务再启动，任务能接上。
//
// 与上一轮复验的差别：那次端口每次都变，浏览器是全新 origin，localStorage
// 取不到，于是选区/页签/草稿全部丢失。这里用真实浏览器做真实指针与键盘操作，
// 并且**每次重开都用全新的浏览器 context**（等价于换一个没有任何本地数据的
// 浏览器），因此恢复只能来自服务端按项目身份保存的状态。
import fs from 'node:fs';
import p from 'node:path';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
// playwright 不在本仓库依赖里；用 CJS require 以便 NODE_PATH 生效（ESM 的
// import 不走 NODE_PATH）。运行方式见报告里的命令。
const { chromium } = createRequire(import.meta.url)('playwright');

const REPO = '/Users/yinsijie/CodeRepo/Atlas';
const OUT = p.dirname(new URL(import.meta.url).pathname);
const BASE = '/tmp/Atlas 首版 S2';
const DIST = p.join(BASE, 'dist');
const STORE = p.join(BASE, 'store');
const A = p.join(BASE, 'proj-a');
const B = p.join(BASE, 'proj-b');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const A_SOURCE = `export function add(a, b) {
  return a + b;
}
`;
const B_SOURCE = `export function add(a, b) {
  return a + b + 100;
}
`;

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, result: ok ? 'PASS' : 'FAIL', detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== null && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
}
const wait = ms => new Promise(r => setTimeout(r, ms));

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(A, { recursive: true });
fs.mkdirSync(B, { recursive: true });
fs.writeFileSync(p.join(A, 'package.json'), '{"type":"module"}');
fs.writeFileSync(p.join(A, 'math.js'), A_SOURCE);
fs.writeFileSync(p.join(B, 'package.json'), '{"type":"module"}');
fs.writeFileSync(p.join(B, 'math.js'), B_SOURCE);
fs.cpSync(p.join(REPO, 'dist/atlas-local-darwin-x64'), DIST, { recursive: true });

let proc = null;
let log = '';
async function launch(project) {
  log = '';
  proc = cp.spawn('bash', [p.join(DIST, 'start.sh'), project], {
    cwd: '/',
    env: { ...process.env, ATLAS_STORE: STORE },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 400; i += 1) {
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f-]+)/.exec(log);
    if (m) return { url: `http://127.0.0.1:${m[1]}/`, port: m[1], token: m[2] };
    if (proc.exitCode !== null) throw new Error(`launcher exited ${proc.exitCode}: ${log}`);
    await wait(100);
  }
  throw new Error(`launcher timeout: ${log}`);
}
async function stop() {
  if (!proc || proc.exitCode !== null) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 40 && proc.exitCode === null; i += 1) await wait(100);
  if (proc.exitCode === null) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }
  await wait(300);
}

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: CHROME });

  // --- 第一次：真实操作，产生一个"上次任务" ---------------------------------
  let session = await launch(A);
  let context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let page = await context.newPage();
  page.on('pageerror', e => record('页面无 JS 异常', false, String(e.message)));
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 20000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'add', null, { timeout: 20000 });
  record('浏览器里按名字选到函数', true, await page.locator('#selection-name').innerText());

  await page.locator('.wb-tabs [data-mode="run"]').click();
  await page.locator('#exec-param-0').click();
  await page.locator('#exec-param-0').pressSequentially('17', { delay: 30 });
  await page.locator('#exec-param-1').click();
  await page.locator('#exec-param-1').pressSequentially('23', { delay: 30 });
  await page.locator('#exec-run').click();
  await page.waitForFunction(() => /returned/.test(document.getElementById('exec-result')?.textContent || ''), null, { timeout: 30000 });
  const runText = await page.locator('#exec-result').innerText();
  record('真实运行返回观测结果', /40/.test(runText), runText.split('\n').slice(0, 4));

  await page.locator('.wb-tabs [data-mode="review"]').click();
  await page.waitForFunction(() => state.mode === 'review');
  await wait(1500); // 等去抖保存落库
  const before = await page.evaluate(() => ({
    selection: document.getElementById('selection-name').textContent,
    mode: state.mode,
    drafts: Object.keys(state.execDrafts).length,
  }));
  await page.screenshot({ path: p.join(OUT, 's2-before-restart.png'), fullPage: true });
  record('第一次会话结束前确有可恢复状态', before.selection === 'add' && before.mode === 'review' && before.drafts > 0, before);

  await page.close();
  await context.close();
  await stop();

  // --- 第二次：全新浏览器 context（没有任何本地存储）+ 新的会话令牌 ----------
  const secondPort = session.port;
  session = await launch(A);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on('pageerror', e => record('重开后页面无 JS 异常', false, String(e.message)));
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'add', null, { timeout: 20000 });
  // select() 会在加载完源码/关系/画像之后才写出恢复结论，因此要等这句话出现，
  // 否则读到的还是上一句"已连接"。
  await page.waitForFunction(() => /已恢复上次任务|重定位/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  const after = await page.evaluate(() => ({
    selection: document.getElementById('selection-name').textContent,
    mode: state.mode,
    drafts: Object.keys(state.execDrafts).length,
    status: document.getElementById('status').textContent,
  }));
  await page.screenshot({ path: p.join(OUT, 's2-after-restart.png'), fullPage: true });
  record('停止服务并重开后，选区/页签/草稿都恢复了',
    after.selection === 'add' && after.mode === 'review' && after.drafts > 0,
    { before, after, port_before: secondPort, port_after: session.port });

  // 草稿内容（而不是只有键）也要回来：切到运行页签读实际输入框。
  await page.locator('.wb-tabs [data-mode="run"]').click();
  await page.waitForSelector('#exec-param-0');
  const refilled = [await page.locator('#exec-param-0').inputValue(), await page.locator('#exec-param-1').inputValue()];
  record('恢复的是草稿内容本身（17 / 23）', refilled[0] === '17' && refilled[1] === '23', refilled);
  await page.screenshot({ path: p.join(OUT, 's2-after-restart-run-tab.png'), fullPage: true });

  await page.close();
  await context.close();
  await stop();

  // --- 不同项目、同名函数：不串状态 ------------------------------------------
  session = await launch(B);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 20000 });
  await wait(1200);
  const other = await page.evaluate(() => ({
    selection: document.getElementById('selection-name').textContent,
    mode: state.mode,
    drafts: Object.keys(state.execDrafts).length,
    saved: state.savedUi,
  }));
  await page.screenshot({ path: p.join(OUT, 's2-other-project.png'), fullPage: true });
  record('另一个项目里同名 add 不继承上一个项目的状态',
    other.selection === '选择一个函数' && other.drafts === 0 && !other.saved,
    other);
  await page.close();
  await context.close();
  await stop();

  // --- 源码变了：重定位或明确说明，不能悄悄指到别的对象 ----------------------
  fs.writeFileSync(p.join(A, 'math.js'), `// 顶部新增一行注释，字节位置整体后移。\n${A_SOURCE}`);
  session = await launch(A);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'add', null, { timeout: 20000 });
  await page.waitForFunction(() => /重定位/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  const moved = await page.evaluate(() => ({
    selection: document.getElementById('selection-name').textContent,
    status: document.getElementById('status').textContent,
  }));
  await page.screenshot({ path: p.join(OUT, 's2-source-moved-relocated.png'), fullPage: true });
  record('源码位移后按依据重定位并说明依据',
    moved.selection === 'add' && /重定位/.test(moved.status), moved);
  await page.close();
  await context.close();
  await stop();

  // 改名：同名同路径都不存在时，必须拒绝并说出来，而不是选中别的函数。
  fs.writeFileSync(p.join(A, 'math.js'), A_SOURCE.replace('function add(', 'function addRenamed('));
  session = await launch(A);
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 20000 });
  await wait(1500);
  const renamed = await page.evaluate(() => ({
    selection: document.getElementById('selection-name').textContent,
    status: document.getElementById('status').textContent,
  }));
  await page.screenshot({ path: p.join(OUT, 's2-source-renamed-refused.png'), fullPage: true });
  record('函数改名后不能恢复时明确拒绝（不静默改指其他函数）',
    renamed.selection === '选择一个函数' && /重定位|不在|拒绝/.test(renamed.status), renamed);
  await page.close();
  await context.close();
  await stop();
} catch (error) {
  record('harness', false, String(error && error.stack || error));
} finally {
  if (browser) await browser.close();
  await stop();
  const exit_code = checks.some(c => c.result === 'FAIL') ? 1 : 0;
  fs.writeFileSync(p.join(OUT, 's2-results.json'), JSON.stringify({
    scope: '实际分发包 + 真实 Chrome；每次重开使用全新浏览器 context；同机测试',
    checks,
    exit_code,
  }, null, 2));
  console.log(`\n${checks.filter(c => c.result === 'PASS').length}/${checks.length} 通过`);
  process.exitCode = exit_code;
}

// U2：后台执行与真实取消（真实服务 + 真实子进程 + 真实浏览器）。
//
// 这一项要证明的是：取消不是"断开 HTTP"。页面拿到 run id 后轮询服务端状态，
// 终态来自 runner 发布的 cancelled 记录；同时可以看到真的有一个受控 Node
// 子进程在跑，取消后它消失。
import fs from 'node:fs';
import p from 'node:path';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const REPO = '/Users/yinsijie/CodeRepo/Atlas';
const OUT = p.dirname(new URL(import.meta.url).pathname);
const BASE = '/tmp/atlas-u2-browser';
const STORE = p.join(BASE, 'store');
const PROJECT = p.join(BASE, 'proj');
const BIN = p.join(REPO, 'target/debug/atlas');
const WORKER = p.join(REPO, 'workers/typescript/worker.mjs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, result: ok ? 'PASS' : 'FAIL', detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== null && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
}
const wait = ms => new Promise(r => setTimeout(r, ms));

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(p.join(PROJECT, 'src'), { recursive: true });
fs.writeFileSync(p.join(PROJECT, 'package.json'), '{"name":"u2","type":"module","private":true}\n');
fs.writeFileSync(p.join(PROJECT, 'src/slow.js'), `// 只做算术的慢函数：静态画像允许直接运行。
export function spin(rounds) {
  let count = 0;
  while (count < rounds) {
    count = count + 1;
  }
  return count;
}

export function quick(value) {
  return value + 1;
}
`);

function cli(args) {
  const r = cp.spawnSync(BIN, args, { encoding: 'utf8', cwd: REPO });
  if (r.status !== 0) throw new Error(`atlas ${args.join(' ')} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const analysis = cli(['--store', STORE, 'index', PROJECT, '--worker', WORKER]).id;

let serve = null;
let log = '';
async function launch() {
  serve = cp.spawn(BIN, ['--store', STORE, 'serve', analysis, '--port', '0', '--worker', WORKER, '--project', PROJECT], {
    cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  serve.stdout.on('data', d => { log += d; });
  serve.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 200; i += 1) {
    const m = /"listening":"http:\/\/127\.0\.0\.1:(\d+)\/"/.exec(log);
    const session = /"session_file":"([^"]+)"/.exec(log);
    if (m && session) {
      const token = JSON.parse(fs.readFileSync(session[1], 'utf8')).token;
      return { url: `http://127.0.0.1:${m[1]}/`, token };
    }
    await wait(100);
  }
  throw new Error(`serve timeout: ${log}`);
}
async function stop() {
  if (!serve || serve.exitCode !== null) return;
  try { process.kill(-serve.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 30 && serve.exitCode === null; i += 1) await wait(100);
}

let browser;
try {
  const session = await launch();
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
  const page = await context.newPage();
  page.on('pageerror', e => record('页面无 JS 异常', false, String(e.message)));
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 30000 });

  await page.locator('#fn-search').click();
  await page.locator('#fn-search').pressSequentially('spin', { delay: 30 });
  await page.waitForFunction(() => /spin/.test(document.querySelector('#fn-list button')?.textContent || ''), null, { timeout: 20000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'spin', null, { timeout: 20000 });
  await page.locator('#run-shortcut').click();
  await page.locator('#exec-param-0').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => /执行画像/.test(document.getElementById('exec-body')?.textContent || ''), null, { timeout: 20000 });
  await page.locator('#exec-param-0').click();
  await page.locator('#exec-param-0').pressSequentially('4000000000', { delay: 20 });
  await page.locator('#exec-run').click();
  // 等两件事都发生：取消入口出现，并且横幅写明这次执行会继续留在服务端。
  await page.waitForFunction(() => !document.getElementById('exec-cancel').hidden, null, { timeout: 20000 });
  await page.waitForFunction(() => /仍在服务端进行/.test(document.getElementById('run-banner')?.textContent || ''), null, { timeout: 20000 });
  const running = await page.evaluate(() => ({
    runButton: document.getElementById('exec-run').textContent,
    cancelShown: !document.getElementById('exec-cancel').hidden,
    note: document.getElementById('exec-run-note').textContent,
    banner: document.getElementById('run-banner').textContent.replace(/\s+/g, ' '),
  }));
  record('运行期间：按钮原位显示运行中，并且出现取消入口',
    /运行中/.test(running.runButton) && running.cancelShown && /不会停它/.test(running.banner),
    running);

  await wait(1500);
  const childVisible = cp.execSync('ps -o pid,command -ax | grep -c "[a]tlas-run" || true', { encoding: 'utf8' }).trim();
  record('服务端确有受控子进程在跑（取消前）', Number(childVisible) > 0, { processes: childVisible });

  await page.locator('#exec-cancel').click();
  // 点击后立刻看到的是"取消中 + 等终态"，而不是"已取消"：进程由服务端结束。
  const cancelling = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    note: document.getElementById('exec-run-note').textContent,
  }));
  // 点击后立刻看到的是"取消中：已发出信号、等终态"，而不是"已取消"——
  // 进程由服务端结束，页面不抢先宣布结果。
  record('点击取消后页面说明"信号已发出、终态待服务端确认"',
    /取消中/.test(cancelling.status) && /等待服务端结束进程/.test(cancelling.status), cancelling);

  await page.waitForFunction(() => /已取消/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 40000 });
  const after = await page.evaluate(() => ({
    status: document.getElementById('status').textContent,
    result: document.getElementById('exec-result').textContent.replace(/\s+/g, ' ').slice(0, 160),
    cancelHidden: document.getElementById('exec-cancel').hidden,
    runButton: document.getElementById('exec-run').textContent,
  }));
  record('终态来自服务端：页面显示"已取消"，结果区是 cancelled 记录',
    /已取消/.test(after.status) && /cancelled/.test(after.result) && after.cancelHidden,
    after);
  await wait(1200);
  const childGone = cp.execSync('ps -o pid,command -ax | grep -c "[a]tlas-run" || true', { encoding: 'utf8' }).trim();
  record('取消后受控子进程确实消失', Number(childGone) === 0, { processes: childGone });
  await page.screenshot({ path: p.join(OUT, 'u2-cancel.png'), fullPage: true });

  // 离页之后结果仍在：切到别的页面再回来，run 状态与结果都还在。
  await page.evaluate(() => setPage('explore'));
  await wait(400);
  const away = await page.evaluate(() => ({
    page: state.page,
    hasResult: Boolean(state.execResult && state.execResult.record),
    busy: state.execBusy,
  }));
  record('离开运行页后结果与状态仍在内存里（离页不影响任务）',
    away.page === 'explore' && away.hasResult && away.busy === false, away);

  await page.close();
  await context.close();
} catch (error) {
  record('harness', false, String(error && error.stack || error));
} finally {
  if (browser) await browser.close();
  await stop();
  const exit_code = checks.some(c => c.result === 'FAIL') ? 1 : 0;
  fs.writeFileSync(p.join(OUT, 'u2-cancel-results.json'), JSON.stringify({
    scope: '真实服务 + 真实子进程 + 真实 Chrome；取消以服务端记录为准',
    analysis_id: analysis, checks, exit_code,
  }, null, 2));
  console.log(`\n${checks.filter(c => c.result === 'PASS').length}/${checks.length} 通过`);
  process.exitCode = exit_code;
}

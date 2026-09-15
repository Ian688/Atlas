// S3: 显式声明的测试命令真的在隔离副本里跑并在页面上可读；
//     前后对照把已支持的完整声明输入（args + globals + this）带到两侧。
//
// 真实浏览器操作：搜索框逐字输入、点击、按钮点击，全部走指针/键盘事件。
import fs from 'node:fs';
import p from 'node:path';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const REPO = '/Users/yinsijie/CodeRepo/Atlas';
const OUT = p.dirname(new URL(import.meta.url).pathname);
const BASE = '/var/folders/d0/h8zmbc0971n266zb4nx3j9980000gn/T/atlas-independent-c9ja63cp';
const DIST = p.join(BASE, 'dist');
const STORE = p.join(BASE, 'store');
const PROJECT = p.join(BASE, 'proj-c');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SOURCE = `export function total(amount) {
  return Math.round(amount * (1 + Number(TAX_RATE)));
}

export function margin() {
  return this.rate * 10;
}

export function fixed() {
  return 7;
}
`;
const TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { fixed } from '../src/tax.js';

test('fixed is seven', () => {
  assert.equal(fixed(), 7);
});
`;

// 多于一行的补丁：改 total 的返回值，margin/fixed 不动。
const TOTAL_DIFF = [
  '--- a/src/tax.js',
  '+++ b/src/tax.js',
  '@@ -1,9 +1,9 @@',
  ' export function total(amount) {',
  '-  return Math.round(amount * (1 + Number(TAX_RATE)));',
  '+  return Math.round(amount * (1 + Number(TAX_RATE))) + 1;',
  ' }',
  ' ',
  ' export function margin() {',
  '   return this.rate * 10;',
  ' }',
  ' ',
  ' export function fixed() {',
  '   return 7;',
  ' }',
  '',
].join('\n');
// 这个补丁会让测试失败，用来验证"失败"不会被显示成通过。
const BREAKING_DIFF = [
  '--- a/src/tax.js',
  '+++ b/src/tax.js',
  '@@ -9,3 +9,3 @@',
  ' export function fixed() {',
  '-  return 7;',
  '+  return 8;',
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
fs.mkdirSync(p.join(PROJECT, 'src'), { recursive: true });
fs.mkdirSync(p.join(PROJECT, 'test'), { recursive: true });
fs.writeFileSync(p.join(PROJECT, 'package.json'), '{"name":"s3","type":"module","private":true}');
fs.writeFileSync(p.join(PROJECT, 'src', 'tax.js'), SOURCE);
fs.writeFileSync(p.join(PROJECT, 'test', 'basic.test.mjs'), TEST);
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
  const session = await launch();
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  page.on('pageerror', e => record('页面无 JS 异常', false, String(e.message)));
  await page.goto(`${session.url}#token=${session.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 20000 });

  // 真实键盘输入搜索，再真实点击命中项。
  await page.locator('#fn-search').click();
  await page.locator('#fn-search').pressSequentially('total', { delay: 40 });
  await page.waitForFunction(() => {
    const b = document.querySelector('#fn-list button');
    return b && /total/.test(b.textContent || '');
  }, null, { timeout: 20000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'total', null, { timeout: 20000 });
  record('搜索并选中目标函数', true, await page.locator('#selection-name').innerText());

  await page.locator('.wb-tabs [data-mode="run"]').click();
  await page.waitForSelector('#exec-global-0', { timeout: 20000 });
  record('画像要求 TAX_RATE 时表单出现 globals 输入', true,
    await page.locator('#exec-context').innerText().then(t => t.split('\n')[0]));
  await page.locator('#exec-param-0').click();
  await page.locator('#exec-param-0').pressSequentially('100', { delay: 30 });
  await page.locator('#exec-global-0').click();
  await page.locator('#exec-global-0').pressSequentially('0.25', { delay: 30 });
  await page.locator('#exec-run').click();
  await page.waitForFunction(() => /returned/.test(document.getElementById('exec-result')?.textContent || ''), null, { timeout: 30000 });
  const runText = await page.locator('#exec-result').innerText();
  record('声明 globals 后真实运行成功', /125/.test(runText), runText.split('\n').slice(0, 5));
  await page.screenshot({ path: p.join(OUT, 's3-run-with-globals.png'), fullPage: true });

  // --- 提案 + 隔离验证 + 测试显示 --------------------------------------------
  await page.locator('.wb-tabs [data-mode="review"]').click();
  await page.locator('#patch-input').click();
  await page.locator('#patch-input').fill(TOTAL_DIFF);
  await page.locator('#patch-propose').click();
  await page.waitForFunction(() => /提案已登记|已经登记过/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 20000 });
  const verifyButton = page.locator('#patch-body button', { hasText: '验证（隔离副本重新派生分析）' }).first();
  await verifyButton.waitFor({ timeout: 20000 });
  record('未验证前页面显示启动配置声明的测试命令',
    /node.*--test/.test(await page.locator('#patch-body').innerText()),
    (await page.locator('#patch-body').innerText()).split('\n').filter(l => /测试|验证配置/.test(l)).slice(0, 3));
  await verifyButton.click();
  await page.waitForFunction(() => /观测：测试命令/.test(document.getElementById('patch-body')?.textContent || ''), null, { timeout: 180000 });
  const patchText = await page.locator('#patch-body').innerText();
  record('验证完成且页面显示真实测试命令与退出码',
    /观测：测试命令/.test(patchText) && /退出码\s*0/.test(patchText) && /通过/.test(patchText),
    patchText.split('\n').filter(l => /观测|测试/.test(l)).slice(0, 4));
  record('测试输出可读（stdout 在折叠区里）',
    await page.locator('#patch-body details summary').count() > 0,
    await page.locator('#patch-body details summary').first().innerText().catch(() => null));
  await page.locator('#patch-body details').first().click().catch(() => {});
  await page.screenshot({ path: p.join(OUT, 's3-verification-test-output.png'), fullPage: true });

  // --- 前后对照：同一份完整声明输入到两侧 ------------------------------------
  const argsBox = page.locator('#patch-body textarea[id^="compare-args-"]').first();
  await argsBox.waitFor({ timeout: 20000 });
  const prefilled = await argsBox.inputValue();
  record('对照默认沿用运行页签的声明输入（不是空数组）', /100/.test(prefilled), prefilled);
  const declaredLine = (await page.locator('#patch-body').innerText()).split('\n').find(l => /两侧使用同一份声明输入/.test(l));
  record('对照区明确列出将发出的完整声明输入', /globals/.test(declaredLine || ''), declaredLine);
  await page.locator('#patch-body button', { hasText: '以相同输入运行两侧' }).first().click();
  await page.waitForFunction(() => /两侧同一输入/.test(document.querySelector('[id^="compare-result-"]')?.textContent || ''), null, { timeout: 60000 });
  const compareText = await page.locator('[id^="compare-result-"]').first().innerText();
  record('对照两侧都真实运行并返回不同结果（125 / 126）',
    /globals/.test(compareText) && /125/.test(compareText) && /126/.test(compareText),
    compareText.split('\n').slice(0, 8));
  await page.screenshot({ path: p.join(OUT, 's3-compare-full-inputs.png'), fullPage: true });

  // --- 失败不能显示成通过 ----------------------------------------------------
  await page.locator('#patch-input').fill(BREAKING_DIFF);
  await page.locator('#patch-propose').click();
  await page.waitForFunction(() => /提案已登记|已经登记过|未通过固定快照校验/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 20000 });
  const breakState = await page.locator('#status').innerText();
  if (/未通过固定快照校验/.test(breakState)) record('第二个补丁通过固定快照校验', false, breakState);
  await page.locator('#patch-body button', { hasText: '验证（隔离副本重新派生分析）' }).first().click();
  await page.waitForFunction(() => {
    const t = document.getElementById('patch-body')?.textContent || '';
    return /观测：测试命令/.test(t) && /退出码\s*1/.test(t);
  }, null, { timeout: 180000 });
  const failText = await page.locator('#patch-body').innerText();
  record('测试失败被如实显示（退出码非 0，不是"没跑"也不是通过）',
    /失败/.test(failText) && /退出码\s*1/.test(failText) && !/没有跑任何测试/.test(failText.split('验证配置')[0] || ''),
    failText.split('\n').filter(l => /观测/.test(l)).slice(0, 3));
  await page.screenshot({ path: p.join(OUT, 's3-verification-test-failed.png'), fullPage: true });

  // --- HTTP 层：this（receiver）也必须到两侧 ----------------------------------
  const api = async (name, body) => {
    const r = await fetch(`${session.url}api/${name}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  const patches = await api('patches?limit=20');
  const verified = (patches.data.proposals || []).find(item => item.state === 'verified');
  const margin = await api('node?entity=margin');
  const marginProfile = await api('profile?entity=margin');
  const compared = await api('exec-compare', {
    entity: margin.data.node.id,
    args: [],
    proposal_id: verified.id,
    this_arg: { rate: 3 },
    // 与页面一致：画像要求的授权按需转发，不是由页面放宽沙箱。
    allow_effects: (marginProfile.data.required_grants || []).filter(n => n === 'unknown_calls'),
  });
  const base = compared.data.base?.record, patched = compared.data.patched?.record;
  record('receiver（this）被带到对照两侧，两侧都真实运行',
    compared.status === 200
    && JSON.stringify(compared.data.declared_inputs?.this_arg) === '{"rate":3}'
    && base?.verdict === 'returned' && patched?.verdict === 'returned',
    {
      declared: compared.data.declared_inputs,
      profile: { status: marginProfile.data.status, required_context: marginProfile.data.required_context, required_grants: marginProfile.data.required_grants },
      base: base?.verdict || compared.data.base?.refused,
      patched: patched?.verdict || compared.data.patched?.refused,
      base_value: base?.value, patched_value: patched?.value,
    });

  await page.close();
  await context.close();
} catch (error) {
  record('harness', false, String(error && error.stack || error));
} finally {
  if (browser) await browser.close();
  await stop();
  const exit_code = checks.some(c => c.result === 'FAIL') ? 1 : 0;
  fs.writeFileSync(p.join(OUT, 's3-results.json'), JSON.stringify({
    scope: '实际分发包 + 真实 Chrome；测试命令以启动配置声明，在隔离副本执行',
    checks, exit_code,
  }, null, 2));
  console.log(`\n${checks.filter(c => c.result === 'PASS').length}/${checks.length} 通过`);
  process.exitCode = exit_code;
}

// S5（人的那一半）：在工作台里定位 Agent 提交的同一份提案与验证结果，
// 在授权目录里应用、核对真实字节、再撤销、再核对字节。
//
// Agent 那一半由 s5-agent-task.mjs 布置、由独立 Agent 用公开接口完成；
// 这个脚本只做"人怎么审阅并决定"，真实浏览器操作。
import fs from 'node:fs';
import p from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const OUT = p.dirname(new URL(import.meta.url).pathname);
const cred = JSON.parse(fs.readFileSync(p.join(OUT, process.env.ATLAS_S5_CREDENTIALS || 's5-credentials.json'), 'utf8'));
const PROPOSAL = process.env.ATLAS_S5_PROPOSAL || 'a41f014f';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MONEY = p.join(cred.project, 'src/money.js');
const TEST = p.join(cred.project, 'test/money.test.mjs');

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, result: ok ? 'PASS' : 'FAIL', detail: detail ?? null });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== null && detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`);
}
const wait = ms => new Promise(r => setTimeout(r, ms));

const before = { money: fs.readFileSync(MONEY, 'utf8'), test: fs.readFileSync(TEST, 'utf8') };

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();
  page.on('pageerror', e => record('页面无 JS 异常', false, String(e.message)));
  await page.goto(`${cred.url}#token=${cred.token}`);
  await page.locator('#fn-list button').first().waitFor({ timeout: 30000 });

  await page.locator('#fn-search').click();
  await page.locator('#fn-search').pressSequentially('charge', { delay: 35 });
  await page.waitForFunction(() => /charge/.test(document.querySelector('#fn-list button')?.textContent || ''), null, { timeout: 30000 });
  await page.locator('#fn-list button').first().click();
  await page.waitForFunction(() => document.getElementById('selection-name')?.textContent === 'charge', null, { timeout: 30000 });

  await page.locator('.wb-tabs [data-mode="review"]').click();
  await page.waitForFunction(() => /提案|还没有提案/.test(document.getElementById('patch-body')?.textContent || ''), null, { timeout: 30000 });
  const body = await page.locator('#patch-body').textContent();
  record(`工作台里能看到 Agent 提交的那份提案（${PROPOSAL}）`,
    new RegExp(PROPOSAL).test(body), (body || '').replace(/\s+/g, ' ').slice(0, 180));
  record('同一提案的验证结果可读（测试真跑、退出码、输出）',
    /观测：测试命令/.test(body || '') && /退出码\s*0/.test(body || '') && /通过/.test(body || ''),
    (body || '').replace(/\s+/g, ' ').match(/观测：测试命令[\s\S]{0,120}/)?.[0] || null);
  await page.screenshot({ path: p.join(OUT, process.env.ATLAS_S5_SHOT_PREFIX ? `${process.env.ATLAS_S5_SHOT_PREFIX}-review-proposal.png` : 's5-human-review-proposal.png'), fullPage: true });

  // 人决定应用：写目录由启动时授权，页面必须逐字回显。
  const applied = await page.locator('#patch-body button', { hasText: '应用（写入' }).first().click()
    .then(() => true).catch(() => false);
  await page.waitForFunction(() => /已应用|写入未发生/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 30000 });
  const appliedStatus = await page.locator('#status').innerText();
  const afterApply = fs.readFileSync(MONEY, 'utf8');
  record('人应用后检出目录字节真的变了，且是 Agent 那份改动',
    applied && /已应用/.test(appliedStatus)
    && afterApply !== before.money
    && /Math\.min\(1, Math\.max\(0, raw\)\)/.test(afterApply)
    && !/const rate = coupon && coupon\.rate/.test(afterApply),
    { status: appliedStatus, moneyBytes: afterApply.length });
  await page.screenshot({ path: p.join(OUT, process.env.ATLAS_S5_SHOT_PREFIX ? `${process.env.ATLAS_S5_SHOT_PREFIX}-review-applied.png` : 's5-human-review-applied.png'), fullPage: true });

  // 撤销：必须逐字节回到应用前。
  await page.locator('#patch-body button', { hasText: '一键撤销' }).first().click();
  await page.waitForFunction(() => /已撤销|写入未发生/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 30000 });
  const revertStatus = await page.locator('#status').innerText();
  const afterRevert = { money: fs.readFileSync(MONEY, 'utf8'), test: fs.readFileSync(TEST, 'utf8') };
  record('撤销后两个文件逐字节回到应用前',
    afterRevert.money === before.money && afterRevert.test === before.test,
    { status: revertStatus, moneyEqual: afterRevert.money === before.money, testEqual: afterRevert.test === before.test });
  await page.screenshot({ path: p.join(OUT, process.env.ATLAS_S5_SHOT_PREFIX ? `${process.env.ATLAS_S5_SHOT_PREFIX}-review-reverted.png` : 's5-human-review-reverted.png'), fullPage: true });

  await page.close();
  await context.close();
} catch (error) {
  record('harness', false, String(error && error.stack || error));
} finally {
  if (browser) await browser.close();
  const exit_code = checks.some(c => c.result === 'FAIL') ? 1 : 0;
  fs.writeFileSync(p.join(OUT, process.env.ATLAS_S5_HUMAN_RESULTS || 's5-human-results.json'), JSON.stringify({
    scope: '人在工作台审阅 Agent 提交的提案，在授权目录应用与撤销',
    checks, exit_code,
  }, null, 2));
  console.log(`\n${checks.filter(c => c.result === 'PASS').length}/${checks.length} 通过`);
  process.exitCode = exit_code;
}

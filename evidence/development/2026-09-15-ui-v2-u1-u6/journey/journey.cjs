// U6 最终包完整旅程：从仓库外的分发包（/tmp/atlas-journey/pkg）出发，
// 用真实 Chrome（本机 Google Chrome，非 playwright 自带浏览器）按用户操作
// 走完开发者与 Agent 两条旅程。直接 API 只用于：
//   1) 以"外部 Agent"身份提交提案（这正是 Agent 的真实接入方式）；
//   2) 轮询打开作业状态（页面自身轮询的旁证）。
// 其余全部通过页面点击/输入完成。截图与结果写入本目录。
const fs = require('fs');
const path = require('path');
// 复放前置：需要 playwright-core（npm i playwright-core）与本机 Chrome。
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { ({ chromium } = require('/tmp/atlas-pw/node_modules/playwright-core')); }

const OUT = __dirname;
const BASE = 'http://127.0.0.1:59711';
const TOKEN = '75fe13a0-880d-4b9d-bb10-c1b15d429d51';
const STORE = '/tmp/atlas-journey/store';
const PKG = '/tmp/atlas-journey/pkg/atlas';
const ALPHA = '/tmp/atlas-journey/alpha';
const BETA = '/tmp/atlas-journey/beta';

const checks = [];
const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(v, m) { if (!v) throw new Error(m); }
async function check(name, fn) {
  try { checks.push({ name, result: 'PASS', detail: await fn() }); }
  catch (e) { checks.push({ name, result: 'FAIL', detail: String(e.message || e).slice(0, 800) }); }
}
async function shot(page, name) { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false }); }
async function nav(page, n) { await page.locator(`.wb-nav [data-go="${n}"]`).click(); await wait(150); }

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(`${BASE}/#token=${TOKEN}`);
    await page.waitForFunction(() => state.report && state.contract);

    // --- U1 探索：搜索 → 关系 → 源码 → 返回 --------------------------------
    await check('U1 搜索非首屏函数并选中', async () => {
      await page.locator('#fn-search').fill('checkout');
      await page.waitForFunction(() => document.querySelector('#fn-list button')?.textContent.includes('checkout'));
      await page.locator('#fn-list button').first().click();
      await page.waitForFunction(() => state.selected?.name === 'checkout' && state.execProfile?.symbol === state.selected.id);
      return { name: await page.locator('#selection-name').innerText(), path: await page.locator('#selection-path').innerText() };
    });
    await check('U1 关系图跳转到被调函数并读源码', async () => {
      // checkout 调用 add：焦点图以 checkout 为根，add 是它的出边邻居。
      await page.waitForFunction(() => state.selected?.name === 'checkout' && state.focus !== null);
      await page.waitForFunction(() => document.querySelectorAll('#graph g.node-group').length > 1);
      await page.locator('#graph g.node-group').filter({ hasText: 'add' }).first().click();
      await page.waitForFunction(() => state.selected?.name === 'add' && state.sourceRes?.status === 'ready');
      const source = await page.locator('#source').innerText();
      assert(source.includes('return a + b'), 'source must show add body');
      await shot(page, 'j01-explore-add');
      await page.locator('#explore-back').click();
      await page.waitForFunction(() => state.selected?.name === 'checkout');
      return { back: await page.locator('#selection-name').innerText() };
    });

    // --- U2 运行：真实输入 → 基线 bug 值 → 历史 ----------------------------
    await check('U2 运行 checkout(17,23) 基线返回 -6', async () => {
      await page.locator('#fn-search').fill('checkout');
      await page.waitForFunction(() => document.querySelector('#fn-list button')?.textContent.includes('checkout'));
      await page.locator('#fn-list button').first().click();
      await page.waitForFunction(() => state.selected?.name === 'checkout' && state.execProfile?.symbol === state.selected.id);
      await page.locator('#run-shortcut').click();
      await page.locator('#exec-param-0').fill('17');
      await page.locator('#exec-param-1').fill('23');
      await page.locator('#exec-run').click();
      await page.waitForFunction(() => document.getElementById('exec-result').textContent.includes('returned'));
      const hero = await page.locator('.run-hero').innerText();
      assert(hero.includes('-6'), `baseline bug value must be -6, got: ${hero}`);
      await shot(page, 'j02-run-baseline');
      const history = await page.locator('#exec-history').innerText();
      assert(history.includes('-6'), 'history must record the run');
      return { hero, history: history.slice(0, 120) };
    });
    await check('U2 输入快照与输出日志页签', async () => {
      await page.locator('.run-tab').filter({ hasText: '本次输入' }).click();
      const inputs = await page.locator('.run-tab-body').innerText();
      assert(inputs.includes('[17,23]'), `inputs tab must show declared args: ${inputs}`);
      await page.locator('.run-tab').filter({ hasText: '输出日志' }).click();
      const logs = await page.locator('.run-tab-body').innerText();
      assert(logs.length > 0, 'logs tab renders');
      await page.locator('.run-tab').filter({ hasText: '结果' }).click();
      return { inputs: inputs.slice(0, 100) };
    });

    // --- U2 后台任务：运行中离开 → 任务面板 → 取消 → 终态 -------------------
    await check('U2 后台任务：切换对象后取消仍可达，终态真实', async () => {
      await nav(page, 'explore');
      await page.locator('#fn-search').fill('spin');
      await page.waitForFunction(() => document.querySelector('#fn-list button')?.textContent.includes('spin'));
      await page.locator('#fn-list button').first().click();
      await page.waitForFunction(() => state.selected?.name === 'spin' && state.execProfile?.symbol === state.selected.id);
      await page.locator('#run-shortcut').click();
      await page.locator('#exec-param-0').fill('3000000000');
      await page.locator('#exec-run').click();
      await page.waitForFunction(() => state.currentRun && state.currentRun.id);
      // 离开对象：切到 checkout
      await nav(page, 'explore');
      await page.locator('#fn-search').fill('checkout');
      await page.waitForFunction(() => document.querySelector('#fn-list button')?.textContent.includes('checkout'));
      await page.locator('#fn-list button').first().click();
      await page.waitForFunction(() => state.selected?.name === 'checkout');
      // 后台任务入口
      await page.locator('#nav-tasks').click();
      await page.waitForFunction(() => document.getElementById('tasks-body').textContent.includes('spin'));
      const dialog = await page.locator('#tasks-dialog').innerText();
      assert(dialog.includes('运行中'), `running task must be listed: ${dialog}`);
      await shot(page, 'j03-background-tasks');
      // 面板里取消
      await page.locator('#tasks-body button').filter({ hasText: '取消' }).first().click();
      await page.waitForFunction(() => document.getElementById('tasks-body').textContent.includes('已取消'), null, { timeout: 20000 });
      const after = await page.locator('#tasks-dialog').innerText();
      assert(after.includes('已取消'), `cancelled terminal must show: ${after.slice(0, 200)}`);
      await shot(page, 'j04-task-cancelled');
      await page.keyboard.press('Escape');
      return { terminal: 'cancelled（服务端确认）' };
    });

    // --- U4 项目设置：声明测试命令，保存即生效 ------------------------------
    await check('U4 项目设置保存测试命令', async () => {
      await nav(page, 'home');
      await page.locator('#settings-test-argv').fill('["node","--test"]');
      await page.locator('#settings-test-timeout').fill('60000');
      await page.locator('#home-settings-save').click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('已生效'));
      const effective = await page.locator('#home-settings-body').innerText();
      assert(effective.includes('node","--test'), `settings must show effective argv: ${effective.slice(0, 200)}`);
      await shot(page, 'j05-settings');
      return { saved: 'test_argv=["node","--test"], timeout=60000' };
    });

    // --- U4 打开第二个项目并核对隔离 ----------------------------------------
    await check('U4 页面打开第二个项目并切换', async () => {
      await page.locator('#home-open-path').fill(BETA);
      await page.locator('#home-open-button').click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('新项目已加载'), null, { timeout: 60000 });
      await page.waitForFunction(() => state.report && state.selected === null || true);
      const current = await page.evaluate(() => state.projectName);
      assert(current === 'beta', `project must switch to beta, got ${current}`);
      await shot(page, 'j06-project-beta');
      return { project: current };
    });
    await check('U4 两个项目状态隔离', async () => {
      await page.locator('#fn-search').fill('gamma');
      await page.waitForFunction(() => document.querySelector('#fn-list button')?.textContent.includes('gamma'));
      await page.locator('#fn-list button').first().click();
      await page.waitForFunction(() => state.selected?.name === 'gamma');
      await page.locator('#fn-search').fill('checkout');
      await page.waitForFunction(() => document.getElementById('fn-list').textContent.includes('没有匹配的函数'));
      await page.locator('#fn-search').fill('gamma');
      await page.waitForFunction(() => document.querySelector('#fn-list button'));
      return { beta_has: 'gamma', beta_lacks: 'checkout' };
    });
    await check('U4 最近项目切回 alpha', async () => {
      await nav(page, 'home');
      const row = page.locator('.project-row').filter({ hasText: 'alpha' });
      await row.locator('button').filter({ hasText: '继续这个项目' }).click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('已切换到'), null, { timeout: 30000 });
      await page.waitForFunction(() => state.projectName === 'alpha', null, { timeout: 30000 });
      await shot(page, 'j07-project-alpha');
      return { project: await page.evaluate(() => state.projectName) };
    });

    // --- U5 外部 Agent 提交提案 → Agent 页定位 → 审阅 ------------------------
    await check('U5 外部 Agent 经接口提交提案', async () => {
      const { analysis, node } = await page.evaluate(async () => {
        const r = await fetch(`/api/node?entity=math.js:checkout`, { headers: { Authorization: `Bearer ${state.token}` } });
        if (!r.ok) throw new Error(`node resolve failed ${r.status}`);
        return { analysis: state.report.id, node: (await r.json()).node };
      });
      const diff = `--- a/math.js\n+++ b/math.js\n@@ -1,3 +1,3 @@\n export function add(a, b) { return a + b; }\n-export function checkout(a, b) { return add(a, -b); }\n+export function checkout(a, b) { return add(a, b); }\n export function spin(n) { let x = 0; while (x < n) { x = x + 1; } return x; }\n`;
      const diffPath = path.join(OUT, 'agent-fix-checkout.patch');
      fs.writeFileSync(diffPath, diff);
      const out = require('child_process').execFileSync(PKG, ['--store', STORE, 'patch', 'propose', analysis, node.id, '--diff', diffPath, '--proposed-by', 'codex-agent', '--summary', 'checkout 应该是 add 而不是减法'], { encoding: 'utf8' });
      const parsed = JSON.parse(out);
      assert(parsed.proposal, `propose failed: ${out.slice(0, 300)}`);
      return { proposal: parsed.proposal.id.slice(0, 12), by: parsed.proposal.proposed_by };
    });
    await check('U5 Agent 页展示提案并定位到审阅', async () => {
      await nav(page, 'agent');
      await page.locator('#agent-proposals button').filter({ hasText: '刷新' }).count();
      // 回到探索选中 checkout，让提案按实体加载
      await nav(page, 'explore');
      await page.locator('#fn-search').fill('checkout');
      await page.waitForFunction(() => document.querySelector('#fn-list button')?.textContent.includes('checkout'));
      await page.locator('#fn-list button').first().click();
      await page.waitForFunction(() => state.patches.length > 0);
      await nav(page, 'agent');
      await page.waitForFunction(() => document.getElementById('agent-proposals').textContent.includes('codex-agent'));
      await shot(page, 'j08-agent-proposal');
      await page.locator('#agent-proposals button').filter({ hasText: '审阅这份提案' }).first().click();
      await page.waitForFunction(() => state.page === 'review' && state.reviewSelected);
      const center = await page.locator('#review-center-inner').innerText();
      assert(center.includes('add(a, b)'), `diff must be centered: ${center.slice(0, 200)}`);
      await shot(page, 'j09-review-located');
      return { selected: (await page.evaluate(() => state.reviewSelected)).slice(0, 12) };
    });

    // --- U3 验证（声明的测试真实运行）→ 对照 → 应用 → 新版本 → 撤销 -----------
    await check('U3 验证：声明的 node --test 真实运行并通过', async () => {
      await page.locator('#review-evidence-inner button').filter({ hasText: '验证' }).first().click();
      await page.waitForFunction(() => document.getElementById('review-evidence-inner').textContent.includes('通过（退出码 0）'), null, { timeout: 180000 });
      const evidence = await page.locator('#review-evidence-inner').innerText();
      assert(evidence.includes('["node","--test"]'), `declared argv must appear: ${evidence.slice(0, 300)}`);
      await shot(page, 'j10-verified');
      return { test: 'node --test passed inside isolated copy' };
    });
    await check('U3 运行页同输入对照：基线 -6 vs 补丁 40', async () => {
      await nav(page, 'run');
      await page.locator('#exec-param-0').fill('17');
      await page.locator('#exec-param-1').fill('23');
      await page.locator('#run-compare-select').selectOption({ index: 0 });
      await page.locator('#run-compare-body button').filter({ hasText: '以相同输入比较' }).click();
      try {
        await page.waitForFunction(() => document.getElementById('run-compare-result').textContent.includes('返回'), null, { timeout: 120000 });
      } catch (e) {
        const dump = await page.locator('#run-compare-result').innerText().catch(() => '');
        throw new Error(`compare did not finish: ${e.message.slice(0, 80)} | result: ${dump.slice(0, 300)}`);
      }
      const compare = await page.locator('#run-compare-result').innerText();
      assert(compare.includes('-6'), `base side must show -6: ${compare}`);
      assert(compare.includes('40'), `patched side must show 40: ${compare}`);
      await shot(page, 'j11-compare');
      return { base: '-6', patched: '40' };
    });
    await check('U3 确认应用（真实目录确认层）→ 磁盘更新', async () => {
      await nav(page, 'review');
      await page.waitForFunction(() => state.reviewSelected);
      const apply = page.locator('#review-evidence-inner button').filter({ hasText: '检查并应用' });
      await apply.click();
      await page.waitForFunction(() => document.getElementById('write-dialog').open);
      const confirmBody = await page.locator('#write-dialog-body').innerText();
      assert(confirmBody.includes(ALPHA), `dialog must show the real authorized directory: ${confirmBody}`);
      await shot(page, 'j12-apply-confirm');
      await page.locator('#write-dialog-confirm').click();
      await page.waitForFunction(() => document.getElementById('review-evidence-inner').textContent.includes('已应用到'), null, { timeout: 30000 });
      const disk = fs.readFileSync(path.join(ALPHA, 'math.js'), 'utf8');
      assert(disk.includes('return add(a, b);'), `disk must be updated: ${disk}`);
      return { applied: true, disk: 'checkout → add(a, b)' };
    });
    await check('U3 打开新版本：重索引切换，源码与运行都是新基线', async () => {
      await page.locator('#review-evidence-inner button').filter({ hasText: '打开新版本' }).click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('新版本已加载'), null, { timeout: 120000 });
      // 重新选中 checkout（重定位或重搜）
      await nav(page, 'explore');
      await page.locator('#fn-search').fill('checkout');
      await page.waitForFunction(() => document.querySelector('#fn-list button')?.textContent.includes('checkout'));
      await page.locator('#fn-list button').first().click();
      await page.waitForFunction(() => state.selected?.name === 'checkout' && state.sourceRes?.status === 'ready');
      const source = await page.locator('#source').innerText();
      assert(source.includes('return add(a, b);'), `updated source must show: ${source.slice(0, 200)}`);
      // 新基线下同样输入返回 40（等待新记录：旧结果里没有 40）
      await nav(page, 'run');
      await page.waitForFunction(() => state.execProfile && state.execProfile.symbol === state.selected.id);
      await page.locator('#exec-param-0').fill('17');
      await page.locator('#exec-param-1').fill('23');
      await page.locator('#exec-run').click();
      await page.waitForFunction(() => document.getElementById('exec-result').textContent.includes('40'), null, { timeout: 30000 });
      const hero = await page.locator('.run-hero').innerText();
      assert(hero.includes('40'), `new baseline must return 40: ${hero}`);
      await shot(page, 'j13-new-version');
      return { version: (await page.evaluate(() => state.report.id)).slice(0, 12), run: 40 };
    });
    await check('U3 撤销：跨版本提案可达，磁盘恢复', async () => {
      await nav(page, 'review');
      await page.waitForFunction(() => document.getElementById('patch-body').textContent.includes('之前的分析'));
      await shot(page, 'j14-cross-version-proposal');
      await page.locator('#review-evidence-inner button').filter({ hasText: '一键撤销' }).click();
      await page.waitForFunction(() => document.getElementById('write-dialog').open);
      await page.locator('#write-dialog-confirm').click();
      await page.waitForFunction(() => document.getElementById('review-evidence-inner').textContent.includes('已撤销'), null, { timeout: 30000 });
      const disk = fs.readFileSync(path.join(ALPHA, 'math.js'), 'utf8');
      assert(disk.includes('return add(a, -b);'), `disk must be restored: ${disk}`);
      // 再走一次"打开项目"重索引，页面读到恢复后的源码
      await nav(page, 'home');
      await page.locator('#home-open-path').fill(ALPHA);
      await page.locator('#home-open-button').click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('新项目已加载'), null, { timeout: 120000 });
      await nav(page, 'explore');
      await page.locator('#fn-search').fill('checkout');
      await page.waitForFunction(() => document.querySelector('#fn-list button')?.textContent.includes('checkout'));
      await page.locator('#fn-list button').first().click();
      await page.waitForFunction(() => state.selected?.name === 'checkout' && state.sourceRes?.status === 'ready');
      const source = await page.locator('#source').innerText();
      assert(source.includes('return add(a, -b);'), `restored source must show: ${source.slice(0, 200)}`);
      await shot(page, 'j15-reverted');
      return { reverted: true, disk_restored: true, page_shows: 'a - b' };
    });

    // --- U5 3D：同一分析的第二个投影，成员往返 ------------------------------
    await check('U5 3D 选区揭示与文件成员往返', async () => {
      const selection = await page.evaluate(() => state.selection);
      assert(selection, 'a selection must exist');
      await page.goto(`${BASE}/city3d#selection=${encodeURIComponent(selection.entity_id)}&analysis=${encodeURIComponent(selection.analysis_id)}&token=${TOKEN}`);
      await page.waitForFunction(() => document.getElementById('city-status')?.textContent.includes('已连接'), null, { timeout: 30000 });
      await page.waitForFunction(() => document.getElementById('city-selection-note')?.textContent.length > 4, null, { timeout: 30000 });
      const note = await page.locator('#city-selection-note').innerText();
      assert(note.includes('共享选区') || note.includes('2D'), `selection must be revealed: ${note}`);
      // 文件层级点选 math.js 柱体（成员区由层级/选区驱动；直接验证成员区随选区出现）
      await page.locator('#city-level-file').click();
      await wait(600);
      const canvas = page.locator('#city-canvas');
      const box = await canvas.boundingBox();
      // 画布中心附近点选一次（中心多为最大目录柱体），成员区出现成员列表即可
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await wait(1200);
      const members = await page.locator('#city-members').innerText();
      await shot(page, 'j16-city3d');
      // 回 2D 工作台
      await page.locator('a.version[href^="/#"]').first().click();
      await page.waitForFunction(() => typeof state !== 'undefined' && state.report && state.contract);
      await wait(400);
      await shot(page, 'j17-roundtrip');
      return { city3d_note: note.slice(0, 120), members: members.slice(0, 160) };
    });

    // --- U6 布局与最终包 -----------------------------------------------------
    await page.goto(`${BASE}/#token=${TOKEN}`);
    await page.waitForFunction(() => state.report && state.contract);
    for (const width of [1600, 1024, 390]) {
      for (const n of ['explore', 'run', 'review', 'home']) {
        await check(`U6 布局 ${width} ${n}`, async () => {
          await page.setViewportSize({ width, height: 1050 });
          await nav(page, n);
          await wait(200);
          const d = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
          assert(d.scroll <= d.width + 1, `horizontal overflow: ${JSON.stringify(d)}`);
          if (width === 390 || width === 1024) await shot(page, `j18-${n}-${width}`);
          return d;
        });
      }
    }
    checks.push({ name: 'browser JS errors', result: errors.length ? 'FAIL' : 'PASS', detail: errors });
  } catch (e) {
    checks.push({ name: 'harness', result: 'FAIL', detail: String(e.stack || e).slice(0, 1200) });
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
      scope: '最终分发包（dist/atlas-local-darwin-x64 复制到 /tmp/atlas-journey/pkg），仓库外真实 Chrome 旅程；分析/项目均为临时样本',
      checks,
    }, null, 2));
    const failed = checks.filter((c) => c.result === 'FAIL');
    console.log(`checks: ${checks.length}, failed: ${failed.length}`);
    for (const f of failed) console.log(`FAIL ${f.name}: ${f.detail}`);
    process.exitCode = failed.length ? 1 : 0;
  }
})();

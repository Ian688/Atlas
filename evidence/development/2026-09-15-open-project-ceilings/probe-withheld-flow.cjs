// 端到端：在页面上打开本仓库 → 探索一个真实函数（应有值事实）→ 探索被撤下数据流的
// 文件里的函数（应说明原因，而不是报成加载失败）。
const os = require('os');
const path = require('path');
const { chromium } = require('/tmp/atlas-repro/node_modules/playwright-core');

const EXEC = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);
const BASE = process.env.ATLAS_BASE || 'http://127.0.0.1:8791';
const TOKEN = process.env.ATLAS_TOKEN;
const REPO = process.env.ATLAS_REPO || '/Users/yinsijie/CodeRepo/Atlas';

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/#token=${TOKEN}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const text = async (sel) => ((await page.locator(sel).textContent().catch(() => null)) || '');

  if (process.env.ATLAS_SKIP_OPEN) {
    console.log('open     : skipped（服务已在跑这个项目）');
  } else {
    await page.locator('.wb-nav [data-go="home"]').click();
    await page.locator('#home-open-path').fill(REPO);
    await page.locator('#home-open-button').click();
    const started = Date.now();
    for (let i = 0; i < 300; i++) {
      await page.waitForTimeout(1000);
      const s = await text('#status');
      if (/新项目已加载|已切换到|打开未完成|打开失败/.test(s)) {
        console.log(`open ${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(s)}`);
        break;
      }
    }
  }
  console.log('nav project:', JSON.stringify(await text('#nav-project-button')));

  const probe = async (label, query) => {
    await page.locator('.wb-nav [data-go="explore"]').click();
    await page.waitForTimeout(200);
    await page.locator('#fn-search').fill(query);
    await page.waitForTimeout(1200);
    const first = page.locator('#fn-list button').first();
    if (!(await first.count())) {
      console.log(`--- ${label} (${query}) --- 没有命中任何函数`);
      return;
    }
    const name = ((await first.textContent().catch(() => '')) || '').trim();
    await first.click();
    await page.waitForTimeout(2000);
    console.log(`--- ${label} (query=${query}) ---`);
    console.log(`  selected  : ${JSON.stringify(name.slice(0, 90))}`);
    console.log(`  flow body : ${JSON.stringify((await text('#flow-body')).replace(/\s+/g, ' ').slice(0, 300))}`);
    console.log(`  unknowns  : ${JSON.stringify((await text('#unknown-body')).replace(/\s+/g, ' ').slice(0, 260))}`);
  };

  await probe('真实项目代码', 'renderHome');
  await probe('被撤下数据流的文件', 'elk.bundled');

  await browser.close();
})();

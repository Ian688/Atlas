// 把页面"打开并分析"这段按真实操作逐个走一遍，并原样打印每一句状态文字。
// 用法：ATLAS_TOKEN=... node ui_probe.cjs            （令牌对不对都行，故意支持错的）
const os = require('os');
const path = require('path');
const { chromium } = require('/tmp/atlas-repro/node_modules/playwright-core');

const EXEC = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
);
const BASE = process.env.ATLAS_BASE || 'http://127.0.0.1:8791';
const TOKEN = process.env.ATLAS_TOKEN || '';

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, headless: true });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/')) logs.push(`[http] ${r.request().method()} ${r.url().split('/api/')[1]} -> ${r.status()}`);
  });

  await page.goto(`${BASE}/#token=${TOKEN}`, { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  const text = async (sel) => (await page.locator(sel).textContent().catch(() => null)) || '';
  console.log('token used      :', TOKEN || '(none)');
  console.log('connection      :', JSON.stringify(await text('#nav-connection-text')));
  console.log('nav project     :', JSON.stringify(await text('#nav-project-button')));
  console.log('open button dis :', await page.locator('#home-open-button').isDisabled().catch(() => 'n/a'));
  console.log('status on load  :', JSON.stringify(await text('#status')));
  console.log('open card       :', JSON.stringify((await text('.home-open')).replace(/\s+/g, ' ').slice(0, 300)));

  await page.locator('.wb-nav [data-go="home"]').click();
  await page.waitForTimeout(400);

  const cases = [
    ['空输入', ''],
    ['波浪号路径', '~/CodeRepo/Atlas'],
    ['相对路径', 'examples/tour'],
    ['指向一个文件', '/Users/yinsijie/CodeRepo/Atlas/README.md'],
    ['本来不存在的目录', '/Users/yinsijie/CodeRepo/Atlas/not-here'],
    ['占位符原样', '/Users/you/your-project'],
    ['正常绝对路径', '/Users/yinsijie/CodeRepo/Atlas/examples/flow-lab'],
  ];
  for (const [label, value] of cases) {
    await page.locator('#home-open-path').fill(value);
    await page.locator('#home-open-button').click();
    await page.waitForTimeout(600);
    let status = await text('#status');
    // 索引类输入会进入轮询：等它出现终局句子，最多 90 秒。
    if (/正在索引/.test(status)) {
      for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(1000);
        status = await text('#status');
        if (/已切换到|新项目已加载|打开未完成|打开失败/.test(status)) break;
      }
      await page.locator('.wb-nav [data-go="home"]').click();
      await page.waitForTimeout(300);
    }
    console.log(`case ${label.padEnd(12)} value=${JSON.stringify(value)}`);
    console.log(`   status: ${JSON.stringify(status)}`);
    console.log(`   progress: ${JSON.stringify(await text('#home-open-progress'))}`);
    console.log(`   recent: ${JSON.stringify((await text('#home-recent-body')).replace(/\s+/g, ' ').slice(0, 200))}`);
  }

  console.log('--- http / console ---');
  console.log(logs.join('\n'));
  await browser.close();
})();

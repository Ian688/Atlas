// Design-only interaction and layout checks. Does not verify Atlas product APIs.
// NODE_PATH=<directory containing playwright> node docs/design/check-prototype.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
(async()=>{
 const out=path.resolve('evidence/design/2026-09-13-workbench');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:process.env.ATLAS_DESIGN_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light'});
 const errors=[];const checks=[];page.on('pageerror',e=>errors.push(e.message));
 async function check(name,fn){await fn();checks.push({name,result:'PASS'});}
 function assert(v,m){if(!v)throw Error(m);}
 try {
 await page.goto(pathToFileURL(path.resolve('docs/design/workbench-preview.html')).href,{waitUntil:'domcontentloaded'});
 const f=page.frameLocator('iframe'),root=f.locator('#atlas-workbench');
 await f.locator('#at-title').waitFor();await page.waitForTimeout(150);
 async function shot(name){const h=Math.ceil((await root.boundingBox()).height);await page.locator('iframe').evaluate((el,h)=>el.style.height=(h+8)+'px',h);await page.setViewportSize({width:page.viewportSize().width,height:Math.max(1000,h+60)});await page.waitForTimeout(80);await root.screenshot({path:path.join(out,name)});}
 await check('initial graph and no synthetic run',async()=>{assert(await f.locator('.at-node').count()===6,'expected six diagram nodes');assert(await f.locator('#at-run').isHidden(),'run initially hidden');});
 await shot('01-understand.png');
 await check('graph navigation and back',async()=>{await f.locator('.at-node[data-select="validate"]').click();assert(await f.locator('#at-title').textContent()==='validate','selection');await f.locator('#at-back').click();assert(await f.locator('#at-title').textContent()==='redeem','back');});
 await check('value source anchor',async()=>{await f.locator('[data-lens="values"]').click();await f.locator('[data-lines="24,25"]').click();assert(await f.locator('.at-highlight').count()===2,'source highlighting');});
 await shot('02-values.png');
 await check('unknown drilldown and source warning',async()=>{await f.locator('[data-lens="unknowns"]').click();await f.locator('[data-inspect-unknown]').click();assert(await f.locator('#at-title').textContent()==='dispatch','unknown target');assert(await f.locator('.at-warning-line').count()===2,'warning anchors');});
 await shot('03-unknowns.png');
 await check('search empty and selection',async()=>{await f.locator('#at-search').fill('not-a-function');assert(await f.locator('#at-search-empty').isVisible(),'empty search');await f.locator('#at-search').fill('validate');await f.locator('.at-fn[data-select="validate"]').click();await f.locator('#at-search').fill('');});
 await check('run invalid JSON and preview result',async()=>{await f.locator('#at-run-shortcut').click();await f.locator('#at-input-mode').click();await f.locator('#at-args').fill('{');await f.locator('#at-run-preview').click();assert(await f.locator('#at-input-error').isVisible(),'invalid JSON');await f.locator('#at-args').fill('[{"amount":100,"used":false},{}]');await f.locator('#at-run-preview').click();assert((await f.locator('#at-result').textContent()).includes('非实际执行'),'sample label');});
 await check('run draft survives task switch',async()=>{const before=await f.locator('#at-args').inputValue();await f.locator('.at-tabs [data-mode="understand"]').click();await f.locator('.at-tabs [data-mode="run"]').click();assert(await f.locator('#at-args').inputValue()===before,'draft lost');assert(await f.locator('#at-result').isVisible(),'record lost');await f.locator('#at-input-mode').click();assert(await f.locator('#at-param-0').isVisible(),'named params');});
 await shot('04-run.png');
 for(const verdict of ['threw','refused','timeout','cancelled'])await check('result variant '+verdict,async()=>{await f.locator('#at-preview-verdict').selectOption(verdict);await f.locator('#at-run-preview').click();assert(await f.locator('#at-result').isVisible(),'result');assert(await f.locator('.at-highlight').count()===0,'run implies line coverage');});
 await check('review verify apply revert preview',async()=>{await f.locator('.at-tabs [data-mode="review"]').click();await f.locator('#at-verify-preview').click();assert(await f.locator('#at-verification').isVisible(),'verification');await f.locator('#at-apply-preview').click();await f.locator('#at-revert-preview').click();assert(await f.locator('#at-apply-preview').isVisible(),'revert');});
 await shot('05-review.png');
 await check('source toggle',async()=>{await f.locator('#at-close-source').click();assert(await f.locator('.at-source').isHidden(),'closed');await f.locator('#at-show-source').click();assert(await f.locator('.at-source').isVisible(),'opened');});
 await f.locator('.at-fn[data-select="redeem"]').click();await f.locator('.at-tabs [data-mode="understand"]').click();await f.locator('[data-lens="calls"]').click();
 for(const width of [1440,1024,768,390,320]){await page.setViewportSize({width,height:1100});await page.waitForTimeout(100);await check('no horizontal overflow at '+width,async()=>{const r=await root.evaluate(el=>({scroll:el.scrollWidth,client:el.clientWidth}));assert(r.scroll<=r.client+1,JSON.stringify(r));});if(width===1024||width===390)await shot('06-width-'+width+'.png');}
 await page.setViewportSize({width:1440,height:1000});await check('structure selection shares target',async()=>{await f.locator('.at-tabs [data-mode="structure"]').click();await f.locator('.at-building[data-select="write"]').click();assert(await f.locator('#at-title').textContent()==='write','structure target');});await shot('08-structure.png');await f.locator('.at-tabs [data-mode="understand"]').click();await f.locator('.at-fn[data-select="redeem"]').click();await page.emulateMedia({colorScheme:'dark'});await page.waitForTimeout(100);await shot('07-dark.png');
 assert(!errors.length,'page errors: '+errors.join(';'));
 const report={scope:'Design prototype only; sample data, no product API or process execution',checks,page_errors:errors,exit_code:0};fs.writeFileSync(path.join(out,'prototype-checks.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }catch(error){fs.writeFileSync(path.join(out,'prototype-failure.json'),JSON.stringify({checks,page_errors:errors,error:String(error),exit_code:1},null,2));throw error;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

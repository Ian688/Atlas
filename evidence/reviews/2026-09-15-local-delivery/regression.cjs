const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const {chromium}=require('playwright');
const root=process.cwd(),out=__dirname,bin=path.join(root,'dist/atlas-local-darwin-x64/atlas');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'atlas-frontend-review-')),project=path.join(temp,'project'),store=path.join(temp,'store');fs.mkdirSync(project);fs.writeFileSync(path.join(project,'package.json'),'{"type":"module"}');
const source='export function add(a, b) { return a + b; }\nexport function caller(a, b) { return add(a, b); }\nexport function shadow() { { let CONFIG = 1; } CONFIG; return 0; }\n';fs.writeFileSync(path.join(project,'math.js'),source);
const findings=[],checks=[];let server,browser;
function record(name,ok,detail){checks.push({name,result:ok?'PASS':'FAIL',detail});if(!ok)findings.push(name);}
function cli(args){const r=cp.spawnSync(bin,['--store',store,...args],{cwd:root,encoding:'utf8',timeout:120000});if(r.status!==0)throw Error(r.stderr);return JSON.parse(r.stdout);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 const analysis=cli(['index',project]);
 server=cp.spawn(bin,['--store',store,'serve',analysis.id,'--port','0','--allow-writes',project],{cwd:root,stdio:['ignore','pipe','pipe']});let stdout='';server.stdout.on('data',x=>stdout+=x);for(let i=0;i<100&&!stdout.includes('\n');i++)await sleep(100);const boot=JSON.parse(stdout.split('\n')[0]);const session=JSON.parse(fs.readFileSync(boot.session_file));
 async function api(endpoint,body){const r=await fetch(session.url+'api/'+endpoint,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+session.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
 const all=await api('search?q=&kind=function&limit=100');const add=all.data.items.find(n=>n.name==='add'),caller=all.data.items.find(n=>n.name==='caller'),shadow=all.data.items.find(n=>n.name==='shadow');record('server-side search',!!add&&!!caller&&!!shadow,{names:all.data.items.map(n=>n.name)});
 const profile=await api('profile?entity='+encodeURIComponent(shadow.id));record('block local must not hide global read',profile.data.required_globals.includes('CONFIG'),{required_globals:profile.data.required_globals,classification:profile.data.classification,reasons:profile.data.reasons});
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(session.url+'#token='+session.token);await page.locator('#fn-list button').first().waitFor();
 async function select(name){await page.locator('#fn-search').fill(name);await page.waitForTimeout(350);await page.locator('#fn-list button').filter({hasText:new RegExp('^ƒ?\\s*'+name+'(?:\\s|$)')}).first().click();await page.waitForFunction(name=>document.getElementById('selection-name').textContent===name,name);await page.waitForTimeout(250);}
 await select('caller');const graphButton=page.locator('#graph g[role="button"][aria-label="add"]');await graphButton.waitFor();await graphButton.click();await page.waitForFunction(()=>document.getElementById('selection-name').textContent==='add');record('real pointer SVG neighbor navigation',true,{from:'caller',to:'add'});
 // R4: geometry. Boxes must be drawn where the layout put them, and every
 // drawn edge must start and end on some box's boundary (within tolerance).
 await page.waitForTimeout(600);
 const geo=await page.evaluate(()=>{
   const svg=document.getElementById('graph');
   const boxes=[...svg.querySelectorAll('g[role="button"] rect')].map(r=>({x:+r.getAttribute('x'),y:+r.getAttribute('y'),w:+r.getAttribute('width'),h:+r.getAttribute('height')}));
   const onBoundary=(x,y)=>boxes.some(b=>Math.abs(y-(b.y+b.h/2))<1.5&&(Math.abs(x-b.x)<1.5||Math.abs(x-(b.x+b.w))<1.5));
   const edges=[...svg.querySelectorAll('path.edge')].map(p=>{const m=/^M ([\d.-]+) ([\d.-]+)/.exec(p.getAttribute('d'));const a=/ ([\d.-]+) ([\d.-]+)$/.exec(p.getAttribute('d'));return {start:m?{x:+m[1],y:+m[2]}:null,end:a?{x:+a[1],y:+a[2]}:null,d:p.getAttribute('d')};});
   const badEdges=edges.filter(e=>!e.start||!e.end||!onBoundary(e.start.x,e.start.y)||!onBoundary(e.end.x,e.end.y));
   return {boxCount:boxes.length,edgeCount:edges.length,badEdges:badEdges.map(e=>e.d)};
 });
 record('drawn edges start and end on box boundaries (R4)',geo.boxCount>0&&geo.edgeCount>0&&geo.badEdges.length===0,geo);
 await page.screenshot({path:path.join(out,'01-real-workbench.png')});
 await page.locator('#run-shortcut').click();await page.locator('#exec-param-0').fill('2');await page.locator('#exec-param-1').fill('3');await page.locator('#exec-run').click();await page.waitForFunction(()=>document.getElementById('exec-result').textContent.includes('returned'));record('real browser execution',true,{result:await page.locator('#exec-result').innerText()});await page.screenshot({path:path.join(out,'02-real-run.png')});
 const diff=n=>'--- a/math.js\n+++ b/math.js\n@@ -1,1 +1,1 @@\n-export function add(a, b) { return a + b; }\n+export function add(a, b) { return a + b + '+n+'; }\n';
 const p1=await api('patch/propose',{entity:add.id,diff:diff(1),summary:'review probe first'});if(p1.status!==200)throw Error(JSON.stringify(p1));
 await select('caller');await select('add');await page.locator('[data-mode="review"]').click();const verify=page.locator('#patch-body button').filter({hasText:'验证（隔离副本重新派生分析）'});await verify.first().click();await page.waitForTimeout(250);await select('caller');await page.waitForTimeout(2300);
 const p2=await api('patch/propose',{entity:add.id,diff:diff(2),summary:'review probe second'});await select('add');await page.locator('[data-mode="review"]').click();let requests=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/patch/verify'))requests++;});await page.locator('#patch-body button').filter({hasText:'验证（隔离副本重新派生分析）'}).last().click();await page.waitForTimeout(500);record('verification remains usable after navigating away',requests>0,{verify_posts_after_second_click:requests,verifying:await page.evaluate(()=>state.verifying),second_proposal:p2.data.proposal?.id});await page.screenshot({path:path.join(out,'03-review-navigation.png')});
 // R3: submit with a custom request key; status must converge on the same job.
 // (R1 fixed, the step-5 click really verifies p2, so re-verifying p2 must be
 // refused with a stated reason; the identity check uses a fresh proposal p3.)
 const reverrify=await api('patch/verify',{id:p2.data.proposal.id,request_key:'independent-custom-key'});record('re-verifying a verified proposal is refused with a reason',reverrify.status===409&&Boolean(reverrify.data.detail),{status:reverrify.status,body:reverrify.data});
 const p3=await api('patch/propose',{entity:add.id,diff:diff(3),summary:'review probe identity'});if(p3.status!==200)throw Error(JSON.stringify(p3));
 const custom=await api('patch/verify',{id:p3.data.proposal.id,request_key:'independent-custom-key'});await sleep(700);const status=await api('patch/verify?id='+p3.data.proposal.id);record('custom request key status returns submitted job',custom.status===200&&status.data.job?.id===custom.data.job?.id,{post_status:custom.status,posted_job_id:custom.data.job?.id,status_job:status.data.job});
 record('browser has no uncaught errors',errors.length===0,{errors});
 }catch(e){checks.push({name:'probe harness',result:'ERROR',detail:String(e)});findings.push('probe harness');}
 finally{if(browser)await browser.close();if(server){server.kill('SIGINT');await Promise.race([new Promise(r=>server.once('exit',r)),sleep(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}fs.rmSync(temp,{recursive:true,force:true});const result={scope:'independent targeted product probes, not full release acceptance',checks,findings,exit_code:findings.length?1:0};fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exitCode=result.exit_code;}
})();

const $ = id => document.getElementById(id);
const state = {token:'',nodes:[],edges:[],nodePage:null,edgePage:null,selected:null,focus:null,focusIn:null,focusOut:null,request:0,exportUrl:null,execProfile:null,report:null,selection:null,pendingSelection:null,annotations:[],patches:[],execRender:0,ancestorChain:null,contract:null,level:'file',hierarchy:null,levelView:null,index:null,focusLayout:null,focusLayoutKey:null,layoutGen:0,mode:'understand',lens:'calls',history:[],recent:[],search:{query:'',items:[],total:null,nextCursor:null,loading:false,error:null},sourceRes:{status:'idle',error:null},reachRes:{status:'idle',error:null,errors:[]},execDrafts:{},execRecords:[],execRecordsError:null,execResult:null,pendingPanel:null};
const ns='http://www.w3.org/2000/svg';
function svg(tag, attrs={}, text) {const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
function text(tag,value,cls) {const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;}
// Error bodies carry the machine reason (`error`) and often a human `detail`.
// Dropping the body reduced every failure to an HTTP digit, which is exactly
// the information a reader cannot act on.
function errorText(status,body){
  const detail=body&&typeof body==='object'?(body.detail||body.error||''):null;
  if(detail)return `${detail} (${status})`;
  if(status===401)return '会话已失效或令牌不正确 (401)';
  return `查询未完成 (${status})`;
}
// A session that died is the one failure the reader can act on by themselves,
// so it keeps its own sentence no matter what body came with the status.
function resourceError(e){
  return e&&e.status===401?'会话已失效或令牌不正确 (401)':String((e&&e.message)||e);
}
async function api(name, params={}, method='GET') {
  const r=await fetch(`/api/${name}?${new URLSearchParams(params)}`,{method,headers:{Authorization:`Bearer ${state.token}`}});
  const body=await r.json().catch(()=>null);
  if(!r.ok){const e=new Error(errorText(r.status,body));e.status=r.status;e.body=body;throw e;}
  return body;
}
// A controlled run carries a JSON body. It is the only call the page makes that
// can start a process, and the server does not trust this body for the process
// boundary: the Node binary, the environment and the fs/child/network
// permissions stay server-side.
async function apiJson(name, body) {
  const r=await fetch(`/api/${name}`,{method:'POST',headers:{Authorization:`Bearer ${state.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const parsed=await r.json().catch(()=>null);
  if(!r.ok){const e=new Error(errorText(r.status,parsed));e.status=r.status;e.body=parsed;throw e;}
  return parsed;
}
function status(message){$('status').textContent=message;}
// The behavioural harness runs app.js against a minimal DOM that has
// getElementById but no querySelectorAll; tab/lens wiring degrades to nothing
// there and the tests drive setMode/setLens directly.
function qsa(selector){
  return typeof document.querySelectorAll==='function'?document.querySelectorAll(selector):[];
}
function clearContext(){if(state.exportUrl)URL.revokeObjectURL(state.exportUrl);state.exportUrl=null;$('context-panel').hidden=true;$('context-json').value='';$('context-download').removeAttribute('href');}
// A selection is the unit the two projections share: an entity plus the
// analysis version it was chosen in. It travels in the fragment (never in an
// HTTP request, never to a server log) and is written back on every selection
// so the URL is a pinned reference rather than a screenshot of one.
// 投影链接:同一选区、同一会话令牌、当前任务状态。fragment 是令牌唯一被
// 允许的传输通道(不进 HTTP 请求与日志),消费页会立刻从地址栏剥掉。
// 页签/镜头变化也要刷新它,否则 3D 拿到的是上一次的任务状态。
function projectionHref(){
  const params=new URLSearchParams();
  if(state.selection){params.set('selection',state.selection.entity_id);params.set('analysis',state.selection.analysis_id);}
  if(state.token)params.set('token',state.token);
  if(state.selection){params.set('mode',state.mode);if(state.mode==='understand')params.set('lens',state.lens);}
  return `/city3d#${params.toString()}`;
}
function refreshProjectionLink(){
  const link=$('open-3d');
  if(link)link.setAttribute('href',projectionHref());
}
function parseFragment(){
  if(typeof location==='undefined'||!location.hash)return {};
  return Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
}
function publishSelection(node){
  state.selection=node?{analysis_id:state.report?.id||'',entity_id:node.id}:null;
  const inspector=$('inspector');
  if(inspector){
    if(node){inspector.setAttribute('data-selection-entity',node.id);inspector.setAttribute('data-analysis-id',state.report?.id||'');}
    else{inspector.removeAttribute('data-selection-entity');inspector.removeAttribute('data-analysis-id');}
  }
  refreshProjectionLink();
  if(typeof history!=='undefined'){
    // 选区更新保留同一 fragment 里的视图状态(mode/lens),不整体覆盖。
    const params=new URLSearchParams(location.hash.slice(1));
    if(node){params.set('selection',node.id);params.set('analysis',state.report?.id||'');}
    else{params.delete('selection');params.delete('analysis');}
    // 镜头只在"理解代码"里有意义,其他页签不把过期的 lens 留在链接里。
    if(params.get('mode')&&params.get('mode')!=='understand')params.delete('lens');
    const query=params.toString();
    history.replaceState(null,'',location.pathname+(query?`#${query}`:''));
  }
}
// --- Intent / proposal surfaces (unchanged contracts) ------------------------
function renderAnnotations(annotations){
  const panel=$('annotation-panel'),body=$('annotation-body');if(!panel||!body)return;
  if(!state.selected){panel.hidden=true;body.replaceChildren();return;}
  panel.hidden=false;body.replaceChildren();
  body.append(flowNode('flow-line','Intent 与提案是声明，不是事实，也不是已存在的代码。'));
  if(!annotations.length){body.append(flowNode('flow-line','当前选区还没有 Intent。'));return;}
  for(const item of annotations.slice(0,12)){
    body.append(flowNode(item.exists?'flow-line':'flow-unknown',
      `${item.kind} · ${item.proposed_by} · ${item.exists?'标记为已存在':'提案（尚未存在）'} · ${item.body}`));
  }
}
// 可读 diff:统一 diff 文本 → 行级视图。文件头与 hunk 头是小节标题,+/− 行
// 各自着色并保留行号;长 diff 截断时明说,不静默吞掉。
const DIFF_MAX_LINES=600;
function renderDiffView(diffText){
  const wrap=flowNode('diff-view','');
  const lines=String(diffText).split('\n');
  if(!lines.filter(l=>l.trim()).length){wrap.append(flowNode('flow-line','（提案没有 diff 内容）'));return wrap;}
  let fileHead=null,oldLn=null,newLn=null,shown=0;
  for(const line of lines){
    if(shown>=DIFF_MAX_LINES){
      wrap.append(flowNode('diff-note',`…其余 ${lines.length-shown} 行未显示（显示上限 ${DIFF_MAX_LINES} 行，diff 全文保存在提案里）`));
      break;
    }
    if(line.startsWith('--- ')||line.startsWith('+++ ')){fileHead=line;continue;}
    if(line.startsWith('@@')){
      const m=/@@ -?(\d+)(?:,\d+)? \+?(\d+)?(?:,\d+)? @@/.exec(line);
      oldLn=m?Number(m[1]):null;newLn=m?Number(m[2]??m[1]):null;
      wrap.append(flowNode('diff-hunk',`${fileHead||''} ${line}`.trim()));
      shown++;continue;
    }
    const row=flowNode(`diff-line${line.startsWith('+')?' diff-add':line.startsWith('-')?' diff-del':''}`,'');
    if(line.startsWith('+')){row.append(text('span','+','diff-sign'),text('span',String(newLn??''),'diff-ln'),text('span',line.slice(1)||' ','diff-text'));if(newLn!==null)newLn++;}
    else if(line.startsWith('-')){row.append(text('span','−','diff-sign'),text('span',String(oldLn??''),'diff-ln'),text('span',line.slice(1)||' ','diff-text'));if(oldLn!==null)oldLn++;}
    else{row.append(text('span',' ','diff-sign'),text('span',String(oldLn??newLn??''),'diff-ln'),text('span',line||' ','diff-text'));if(oldLn!==null)oldLn++;if(newLn!==null)newLn++;}
    wrap.append(row);shown++;
  }
  return wrap;
}
// 图差异对象列表:新增/删除/变更逐一列出并带字节位置;基线版本仍可解析的
// 对象可点击定位到当前工作台的源码。仅存在于补丁版本的对象明确标注。
function renderGraphDiffObjects(graph){
  const wrap=flowNode('diff-objects','');
  const nodes=graph.nodes||{};
  const added=nodes.added||[],removed=nodes.removed||[],changed=nodes.changed||[];
  if(!added.length&&!removed.length&&!changed.length){wrap.append(flowNode('flow-line','图差异没有可列的对象级变化（或该版本的差异只报告计数）。'));return wrap;}
  const row=(label,item,click)=>{
    const line=flowNode(click?'flow-line wb-anchored':'flow-line',`${label} ${item.path||''} · ${item.name||''}${item.start!==undefined?` · 字节 ${item.start}–${item.end}`:''}`);
    if(click)line.onclick=click;
    wrap.append(line);
  };
  for(const item of changed.slice(0,10))row('变更',item.before||item,()=>locateBaseObject(item.before||item));
  for(const item of removed.slice(0,10))row('删除',item,()=>locateBaseObject(item));
  for(const item of added.slice(0,10))wrap.append(flowNode('flow-line',`新增 ${item.path||''} · ${item.name||''}${item.start!==undefined?` · 字节 ${item.start}–${item.end}`:''} · 仅存在于补丁版本（当前工作台读的是基线分析）`));
  const more=(a,r,c)=>Math.max(0,(a.length-r.length-c.length));
  const over=more(added,added.slice(0,10).length,0);
  if(over>0)wrap.append(flowNode('flow-line',`…其余 ${over} 个新增对象按显示上限省略`));
  return wrap;
}
async function locateBaseObject(item){
  if(!item||!item.node_id){status('这个对象没有可定位的身份');return;}
  try{
    const node=await resolveEntity(item.node_id);
    if(!node){status(`定位失败：${item.node_id} 不在当前分析里`);return;}
    await select(node);
  }catch(e){status(`定位失败：${String((e&&e.message)||e)}`);}
}
// 前后对照:同一输入,基线与补丁两个分析各自真实隔离运行。
async function runCompare(proposalId,proposal){
  const selected=state.selected;if(!selected)return;
  const profile=state.execProfile;
  let args;
  const box=document.getElementById(`compare-args-${proposalId.slice(0,8)}`);
  const raw=box?box.value:'[]';
  try{
    args=JSON.parse(raw);
    if(!Array.isArray(args))throw new Error('需要 JSON 数组');
  }catch(e){status(`对照输入格式不正确：${e.message}`);return;}
  const resultBox=document.getElementById(`compare-result-${proposalId.slice(0,8)}`);
  if(resultBox){resultBox.replaceChildren(flowNode('flow-line','对照运行中（两个隔离副本各执行一次）…'));}
  const request=state.request;
  // 与单次运行一致:画像要求的授权按需转发(例如读取 Math.round 之类外部名)。
  const allow_effects=profile?profile.required_grants.filter(name=>name==='unknown_calls'):[];
  try{
    const compare=await apiJson('exec-compare',{entity:selected.id,args,proposal_id:proposalId,allow_effects});
    if(request!==state.request)return;
    renderCompareResult(resultBox,compare);
    status('对照完成：两侧都是真实隔离运行。');
  }catch(e){
    if(request!==state.request)return;
    if(resultBox)resultBox.replaceChildren(flowNode('flow-unknown',`对照未完成：${e.message}`));
  }
}
function compareSide(name,side){
  const wrap=flowNode('flow-block','');
  wrap.append(text('b',name));
  if(!side){wrap.append(flowNode('flow-line','（无结果）'));return wrap;}
  if(side.refused){wrap.append(flowNode('flow-unknown',`未运行：${side.refused}`));return wrap;}
  const record=side.record||{};
  if(side.verdict==='refused'&&record.refusal){
    wrap.append(flowNode('flow-unknown',`拒绝执行：${record.refusal.code} — ${record.refusal.detail}`));
    wrap.append(flowNode('flow-line','这是预检拒绝:没有进程被启动。按拒绝原因调整后可重试。'));
    return wrap;
  }
  let valueLine='返回值/异常：';
  if(record.value!==null&&record.value!==undefined){const v=decodeEncoded(record.value);valueLine+=typeof v==='string'?v:JSON.stringify(v);}
  else if(record.thrown)valueLine+=`${record.thrown.name}: ${record.thrown.message}`;
  else valueLine+='（无返回值）';
  wrap.append(flowNode('flow-line',`verdict ${side.verdict} · ${record.duration_ms} ms · 退出码 ${record.exit_code===null?'无':record.exit_code}`));
  wrap.append(flowNode('flow-line',valueLine));
  wrap.append(flowNode('flow-line',`版本 ${String(record.analysis_id||'').slice(0,12)} · snapshot ${String(record.snapshot_id||'').slice(0,12)}`));
  return wrap;
}
function renderCompareResult(box,compare){
  if(!box)return;
  box.replaceChildren();
  box.append(flowNode('flow-head',`同一输入：${JSON.stringify(compare.args)}`));
  box.append(compareSide('基线（当前工作台版本）',compare.base));
  box.append(compareSide('补丁（验证派生的候选版本）',compare.patched));
  box.append(flowNode('flow-line',`版本固定：基线 ${String(compare.base_analysis_id||'').slice(0,12)} · 补丁 ${String(compare.patched_analysis_id||'').slice(0,12)}。两侧都是入口调用的真实结果，没有行级采样。`));
}
function renderPatches(proposals){
  const panel=$('patch-panel'),body=$('patch-body');if(!panel||!body)return;
  if(!state.selected){panel.hidden=true;body.replaceChildren();return;}
  panel.hidden=false;body.replaceChildren();
  body.append(flowNode('flow-line','提案是 Intent：它还没有写进任何检出目录，也没有改变已发布的分析。'));
  if(!proposals.length){
    body.append(flowNode('flow-line',state.patchesError?`提案查询失败：${state.patchesError}`:'当前选区还没有提案。'));
    return;
  }
  for(const proposal of proposals.slice(0,8)){
    const inner=proposal.proposal||{};
    const validation=inner.validation||{};
    body.append(flowNode('flow-head',`提案 ${proposal.id.slice(0,12)} · ${proposal.state} · ${proposal.proposed_by}${inner.summary?` · ${inner.summary}`:''}`));
    if(validation.ok){
      const forms=validation.forms||[];
      const formText=forms.map(entry=>`${entry.form==='create'?'新建':(entry.form==='delete'?'删除':'修改')} ${entry.path}`).join(' · ');
      body.append(flowNode('flow-line',`对固定快照校验通过：${validation.hunks} 个 hunk · ${formText||(validation.patched_paths||[]).join(', ')}`));
      if(forms.some(entry=>entry.form==='create'))body.append(flowNode('flow-line',`这份提案会新建文件（target_exists=${inner.target_exists===false?'false':'true'}）：apply 会创建它，revert 会删除它（只在文件仍是 apply 写下的字节时）。`));
      if(forms.some(entry=>entry.form==='delete'))body.append(flowNode('flow-line','这份提案会删除文件：apply 只在磁盘上仍是提案所依据的字节时删除，revert 会按固定快照的字节恢复。'));
      if((validation.deleted_paths||[]).length)body.append(flowNode('flow-line',`删除路径：${validation.deleted_paths.join(', ')}`));
    }else{
      body.append(flowNode('flow-unknown',`对固定快照校验未通过，因此它不可验证：${validation.reason||'未知原因'}`));
    }
    body.append(renderDiffView(inner.diff||''));
    const verification=proposal.verification;
    if(verification){
      const graph=verification.graph_diff||{};
      const counts=graph.counts||{};
      body.append(flowNode('flow-line',`静态：补丁树派生为新分析 ${String(verification.patched_analysis_id||'').slice(0,12)} · 变更节点 ${graph.nodes?.changed_count??'?'} · 新增 ${graph.nodes?.added_count??'?'} · 删除 ${graph.nodes?.removed_count??'?'}`));
      if(counts.unresolved_calls)body.append(flowNode('flow-line',`未解析调用 前 ${counts.unresolved_calls.before} → 后 ${counts.unresolved_calls.after}`));
      body.append(renderGraphDiffObjects(graph));
      const test=verification.test||{};
      if(test.ran){
        body.append(flowNode(test.passed?'flow-line':'flow-unknown',`观测：测试命令 ${JSON.stringify(test.argv)} 退出码 ${test.exit_code}${test.timed_out?'（超时，不算通过）':''}`));
      }else{
        body.append(flowNode('flow-unknown','观测：没有跑任何测试。这不是通过。'));
      }
    }else if(validation.ok){
      body.append(flowNode('flow-line','还没有验证：没有派生补丁树，也没有跑测试。'));
    }
    // 前后对照:同一输入在基线与补丁两个分析上真实运行。只对已验证的提案
    // 提供(补丁分析来自验证);默认带入运行页签最近一次的实参草稿。
    if(proposal.state==='verified'){
      const key=proposal.id.slice(0,8);
      const draft=execDraft(state.selected?.id);
      const section=flowNode('compare-section','');
      const label=flowNode('flow-head','前后对照（同一输入,两侧真实隔离运行）');
      section.append(label);
      const argsRow=document.createElement('div');argsRow.className='context-actions';
      const argsInput=document.createElement('textarea');
      argsInput.id=`compare-args-${key}`;argsInput.rows=1;argsInput.spellcheck=false;
      argsInput.value=draft.raw&&draft.raw!=='[]'?draft.raw:'[]';
      argsInput.setAttribute('aria-label','对照运行的实参 JSON 数组');
      const runBtn=document.createElement('button');
      runBtn.textContent='以相同输入运行两侧';
      runBtn.className='wb-retry';
      runBtn.onclick=()=>runCompare(proposal.id,proposal);
      argsRow.append(text('span','实参','subtle'),argsInput,runBtn);
      section.append(argsRow);
      const result=document.createElement('div');
      result.id=`compare-result-${key}`;
      section.append(result);
      body.append(section);
    }
    if(proposal.state==='applied'){
      body.append(flowNode('flow-line',`已应用到 ${proposal.target}。当前工作台仍读提出提案时的那份固定分析；重新索引该项目后，工作台会指向新版本（选区会尝试重定位）。`));
    }
    // 页面可以触发验证（服务端按自己的参数跑同一 patch_verify 路径）；
    // 应用/撤销仍受 --allow-writes 边界约束。
    if(proposal.state==='proposed'&&validation.ok){
      const actions=document.createElement('div');actions.className='context-actions';
      const verify=document.createElement('button');
      verify.textContent=verifyPolls[proposal.id]?'验证中…':'验证（隔离副本重新派生分析）';
      verify.disabled=Boolean(verifyPolls[proposal.id]);
      verify.onclick=()=>startVerify(proposal.id);
      actions.append(verify);
      body.append(flowNode('flow-line','验证会从不可变快照物化隔离副本并重新派生分析；未声明测试时如实写"没有跑任何测试"。'));
      body.append(actions);
    }
    const writes=state.contract&&state.contract.writes;
    if(writes&&writes.enabled){
      const actions=document.createElement('div');actions.className='context-actions';
      const apply=document.createElement('button');
      apply.textContent='应用（写入 '+writes.root+'）';
      apply.disabled=proposal.state!=='verified';
      apply.onclick=()=>writePatch('patch/apply',proposal.id,writes.root);
      const revert=document.createElement('button');
      revert.textContent='一键撤销';
      revert.disabled=proposal.state!=='applied';
      revert.onclick=()=>writePatch('patch/revert',proposal.id,writes.root);
      actions.append(apply,revert);
      body.append(actions);
      body.append(flowNode('flow-line',`写路径由启动参数 --allow-writes 指定：${writes.root}。页面不能指定目录，只能在请求里回显它；服务端逐字比对，不一致就拒绝且不写任何文件。`));
    }else{
      body.append(flowNode('flow-unknown','应用与撤销只能在本机 CLI 上做：atlas patch apply / revert。这个服务启动时没有 --allow-writes，因此 HTTP 没有写路径；验证可以在页面上触发。'));
    }
  }
}
// 触发验证并按提案轮询。轮询跟踪的是服务端作业,与当前选区解耦:切换函数
// 后轮询继续,回到该函数时按钮如实显示"验证中";每个提案一个轮询,互不抢占,
// 结束(或超过轮询预算)必清理,不会留下卡死的互斥状态。(R1)
const verifyPolls={};
const VERIFY_POLL_MS=2000,VERIFY_POLL_MAX=150;
async function startVerify(proposalId){
  if(verifyPolls[proposalId])return;
  status(`验证已排队：${proposalId.slice(0,12)} …`);
  renderPatches(state.patches);
  try{
    await apiJson('patch/verify',{id:proposalId});
  }catch(e){
    renderPatches(state.patches);
    status(`验证未排队：${e.message}`);
    return;
  }
  let attempts=0;
  verifyPolls[proposalId]=setInterval(async()=>{
    attempts+=1;
    const finish=(message)=>{
      clearInterval(verifyPolls[proposalId]);
      delete verifyPolls[proposalId];
      status(message);
      // 只有当前选区还列着这个提案时才刷新面板;否则静默结束,不跨选区写。
      if(state.selected&&state.patches.some(p=>p.id===proposalId))loadPatches(state.selected);
      else renderPatches(state.patches);
    };
    if(attempts>VERIFY_POLL_MAX){
      finish(`验证查询超时：${proposalId.slice(0,12)}。作业仍在服务端,可稍后重新打开审阅查看结果。`);
      return;
    }
    try{
      const answer=await api('patch/verify',{id:proposalId});
      const jobState=answer.job?answer.job.state:null;
      if(jobState==='completed'||jobState==='failed'||jobState==='cancelled'){
        finish(jobState==='completed'?`验证完成：${proposalId.slice(0,12)}`:`验证未完成：${jobState}（${(answer.job&&answer.job.terminal_reason)||'未给原因'}）`);
      }
    }catch{/* 单次查询失败不终止轮询；下次再试 */}
  },VERIFY_POLL_MS);
  renderPatches(state.patches);
}
async function writePatch(endpoint,id,root){
  try{
    const result=await apiJson(endpoint,{id,confirm_path:root});
    status(`提案 ${result.proposal.state==='applied'?'已应用':'已撤销'}：${id.slice(0,12)}`);
    await loadPatches(state.selected);
  }catch(e){
    status(`写入未发生：${e.message}（服务器拒绝时不写任何文件）`);
    await loadPatches(state.selected);
  }
}
async function loadPatches(node){
  // The answer names its generation twice: the request token of the selection
  // that asked, and the entity it asked about. A proposal page that finishes
  // after the reader moved to another function must land nowhere.
  const request=state.request;
  state.patchesError=null;
  if(!node){state.patches=[];renderPatches([]);return;}
  let page;
  try{page=await api('patches',{entity:node.id,limit:20});}
  catch(e){
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.patches=[];state.patchesError=e.message;renderPatches([]);return;
  }
  if(request!==state.request||state.selected?.id!==node.id)return;
  state.patches=page.proposals||[];
  renderPatches(state.patches);
}
async function proposePatch(){
  const selected=state.selected;
  if(!selected){status('先选择一个对象');return;}
  const diff=$('patch-input').value;
  if(!diff.trim()){status('先粘贴一份统一 diff');return;}
  $('patch-propose').disabled=true;
  try{
    const result=await apiJson('patch/propose',{entity:selected.id,diff});
    $('patch-input').value='';
    await loadPatches(selected);
    status(result.outcome==='proposed'?'提案已登记（未应用，也未验证）':'这份提案已经登记过');
    return result;
  }catch(e){
    await loadPatches(selected);
    status(`提案未通过固定快照校验：${e.message}。它被记录为 rejected，不可验证。`);
    return null;
  }finally{$('patch-propose').disabled=false;}
}
async function loadAnnotations(node){
  const request=state.request;
  if(!node){state.annotations=[];renderAnnotations([]);return;}
  let page;
  try{page=await api('annotations',{entity:node.id,limit:50});}
  catch(e){
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.annotations=[];state.annotationsError=e.message;renderAnnotations([]);return;
  }
  // A late answer from function A must never render under function B's name:
  // both the generation and the entity are checked before anything is shown.
  if(request!==state.request||state.selected?.id!==node.id)return;
  state.annotations=page.annotations||[];
  renderAnnotations(state.annotations);
}
async function proposeAnnotation(){
  const selected=state.selected;
  if(!selected){status('先选择一个对象');return;}
  const body=$('annotation-input').value.trim();
  if(!body){status('先写下要登记的意图');return;}
  try{
    const result=await apiJson('annotation',{entity:selected.id,kind:'constraint',body});
    $('annotation-input').value='';
    await loadAnnotations(selected);
    status(result.outcome==='created'?'Intent 已登记为提案（不是代码）':'这条 Intent 已经登记过');
  }catch(e){status(`Intent 未登记：${e.message}`);}
}
function installBridge(){
  if(typeof globalThis==='undefined')return;
  globalThis.atlasBridge={
    version:'atlas.agent-bridge.v1',
    bounded_actions:['getSelection','getAnnotations','getPatches','relocate','select','propose','proposePatch','openProjection','runControlled'],
    getSelection(){return state.selection?{...state.selection}:null;},
    getAnnotations(){return state.annotations;},
    getPatches(){return state.patches;},
    async relocate(fromAnalysis,entityId){if(!fromAnalysis||!entityId)return {ok:false,error:'from_and_entity_required'};const result=await api('relocate',{entity:entityId,from:fromAnalysis});return {ok:true,relocation:result.relocation,detail:result.detail,selection:result.selection};},
    async proposePatch(diff){if(!state.selected)return {ok:false,error:'no_selection'};$('patch-input').value=diff||'';const result=await proposePatch();return result?{ok:true,proposal:result.proposal}:{ok:false,error:'proposal_rejected'};},
    async select(entityId){const node=state.nodes.find(n=>n.id===entityId);if(!node)return {ok:false,error:'entity_not_loaded'};await select(node);return {ok:true,entity_id:node.id};},
    async propose(kind,body){if(!state.selected)return {ok:false,error:'no_selection'};const result=await apiJson('annotation',{entity:state.selected.id,kind:kind||'constraint',body});await loadAnnotations(state.selected);return {ok:true,annotation:result.annotation,exists:false};},
    openProjection(view){const target=view==='3d'?($('open-3d')?.getAttribute('href')||'/city3d'):'/';if(typeof location!=='undefined')location.href=target;return target;},
    runControlled(){return runControlled();},
  };
}
// 按身份取一个实体。
async function resolveEntity(reference){
  const loaded=state.nodes.find(n=>n.id===reference);
  if(loaded)return loaded;
  const answer=await api('node',{entity:reference});
  const node=answer&&answer.node;
  if(!node)return null;
  if(!state.nodes.some(n=>n.id===node.id))state.nodes.push(node);
  return node;
}
async function openUnloaded(box){
  status(`正在按身份解析 ${box.label} …`);
  try{
    const node=await resolveEntity(box.id);
    if(!node){status(`解析失败：${box.id} 不在这一份分析里，或名字有歧义`);return;}
    await select(node);
  }catch(error){
    status(`解析失败：${String((error&&error.message)||error)}`);
  }
}
async function loadNodes(){const page=await api('nodes',{limit:100,...(state.nodePage?.next_cursor?{cursor:state.nodePage.next_cursor}:{})});state.nodes.push(...page.items);state.nodePage=page;render();}
async function loadEdges(){const page=await api('edges',{limit:100,...(state.edgePage?.next_cursor?{cursor:state.edgePage.next_cursor}:{})});state.edges.push(...page.items);state.edgePage=page;render();}
async function connect(){
  const typed=$('token').value.trim();
  if(typed)state.token=typed;
  if(!state.token){status('请粘贴本地会话令牌（启动命令输出的 session_file）');return;}
  status('正在读取本地分析…');
  try {
    const report=await api('report');
    resetDetail();state.nodes=[];state.edges=[];state.nodePage=null;state.edgePage=null;state.report=report;
    try{state.contract=await api('contract');}catch{state.contract=null;}
    await loadNodes();await loadEdges();
    $('revision').textContent=`分析版本 ${report.id.slice(0,12)}`;$('revision').title=report.id;
    $('token').value='';status('已连接 · 固定版本 · 本地只读查询');
    runSearch();
    const pending=state.pendingSelection;
    if(pending&&pending.entity_id){
      if(pending.analysis&&pending.analysis!==report.id){
        try{
          const relocated=await api('relocate',{entity:pending.entity_id,from:pending.analysis});
          const summary=relocated.relocation||{};
          if(summary.relocated&&relocated.selection){
            const node=await resolveEntity(relocated.selection.entity_id);
            if(node){
              await select(node);
              status(`已从版本 ${String(pending.analysis).slice(0,8)} 重定位到当前版本：依据 ${summary.matched_by}${summary.bytes_changed?'，源码字节已变化':'，源码字节相同'}。`);
            }else{
              status('重定位找到了对应对象，但它不在当前已加载的节点里，未自动选中。');
            }
          }else{
            status(`该选区固定在另一个分析版本上，重定位被拒绝（${summary.refusal||'unknown'}）：${relocated.detail?.note||''}`);
          }
        }catch(e){
          status(`该选区固定在另一个分析版本上，且重定位查询失败：${e.message}。请在这里重新选择。`);
        }
      }else{
        const node=await resolveEntity(pending.entity_id);
        if(node)await select(node);
        else status('选区指向的对象不在当前已加载的节点里，未自动选中。');
      }
    }
  }catch(e){
    if(!typed){
      state.token='';
      try{localStorage.removeItem('atlas.session.v1');}catch{}
    }
    status(`${e.message} · ${typed?'请检查令牌':'会话已失效，请重新粘贴令牌'}`);
  }
}
// --- 左侧导航：服务端搜索 + 最近查看 + 返回 ---------------------------------
// 查找是服务端职责：/api/nodes 按 id 排序且目录文件在前，本地翻页过滤不能
// 承诺"全项目都找过了"。搜索词、总数、截断都按接口回显如实报告。
let searchSeq=0,searchTimer=null;
const SEARCH_LIMIT=100,SEARCH_DEBOUNCE_MS=180;
function scheduleSearch(){
  if(searchTimer)clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>{searchTimer=null;runSearch();},SEARCH_DEBOUNCE_MS);
}
async function runSearch(append){
  const q=($('fn-search')?.value||'').trim();
  const mine=++searchSeq;
  if(append){
    state.search.loading=true;renderSearch();
  }else{
    state.search={query:q,items:[],total:null,nextCursor:null,loading:true,error:null};
    renderSearch();
  }
  const cursor=append?state.search.nextCursor:null;
  try{
    const page=await api('search',{q,kind:'function',limit:SEARCH_LIMIT,...(cursor?{cursor}:{})});
    if(mine!==searchSeq)return;
    const items=page.items||[];
    for(const node of items)if(!state.nodes.some(n=>n.id===node.id))state.nodes.push(node);
    state.search={
      query:String(page.query??q),
      items:append?[...state.search.items,...items]:items,
      total:page.total,
      nextCursor:page.next_cursor||null,
      loading:false,error:null,
    };
  }catch(e){
    if(mine!==searchSeq)return;
    if(append){state.search.loading=false;state.search.error=e.message;}
    else state.search={query:q,items:[],total:null,nextCursor:null,loading:false,error:e.message};
  }
  renderSearch();
}
let searchSig='';
function renderSearch(){
  const box=$('fn-list');if(!box)return;
  const s=state.search;
  // The rail is rebuilt on every render() the page makes (layout completion,
  // lens switches, ...). Rebuilding identical DOM replaces buttons under the
  // user's cursor, so identical state keeps the existing nodes.
  const sig=JSON.stringify([s.query,s.items.map(n=>n.id),s.total,s.loading,s.error,state.selected?.id||'']);
  if(sig===searchSig)return;
  searchSig=sig;
  box.replaceChildren();
  const count=$('fn-count');
  if(count){
    if(s.loading&&!s.items.length)count.textContent='搜索中…';
    else if(s.error)count.textContent='搜索失败';
    else if(s.total===null)count.textContent='未加载';
    else{
      const scope=s.query?`匹配 ${s.total} 个`:`全部 ${s.total} 个函数`;
      count.textContent=s.items.length<s.total?`${scope} · 已显示前 ${s.items.length} 个`:`${scope}`;
      count.title=s.items.length<s.total?'按名称/路径匹配，稳定排序；分页加载，不是截断猜测':'';
    }
  }
  const more=$('fn-more');
  if(more)more.hidden=!s.nextCursor||s.loading;
  if(s.error){
    const row=text('div','搜索失败：'+s.error,'wb-side-error');
    const retry=text('button','重试','wb-retry');
    retry.onclick=()=>runSearch(false);
    box.append(row,retry);
    return;
  }
  if(!s.items.length){
    box.append(text('div',s.loading?'…':(s.query?'没有匹配的函数':'这一份分析里没有函数'),'wb-side-empty'));
    return;
  }
  // 按文件分组显示：同名函数靠路径区分，这是设计稿里"避免同名误选"的那一行。
  let lastPath=null;
  for(const node of s.items){
    if(node.path!==lastPath){lastPath=node.path;box.append(text('div',node.path||'(无路径)','wb-file'));}
    const row=text('button',node.name,`fn-hit${state.selected?.id===node.id?' selected':''}`);
    row.title=`${node.id}`;
    row.onclick=()=>select(node);
    box.append(row);
  }
  if(s.loading&&s.items.length)box.append(text('div','加载中…','wb-side-empty'));
}
let recentSig='';
function renderRecent(){
  const box=$('recent-list');if(!box)return;
  const sig=JSON.stringify([state.recent,state.history.length,state.selected?.id||'']);
  if(sig===recentSig)return;
  recentSig=sig;
  box.replaceChildren();
  const back=$('nav-back');
  if(back)back.disabled=!state.history.length;
  if(!state.recent.length){box.append(text('div','还没有浏览记录','wb-side-empty'));return;}
  for(const id of state.recent.slice(0,8)){
    const node=state.nodes.find(n=>n.id===id);
    const row=text('button',node?`${node.name}`:id,'fn-hit wb-recent-item');
    if(node)row.title=node.path||node.id;
    row.onclick=async()=>{try{const target=await resolveEntity(id);if(target)await select(target);}catch(e){status(`打开失败：${e.message}`);}};
    box.append(row);
  }
}
function navBack(){
  const previous=state.history.pop();
  if(!previous)return;
  (async()=>{
    try{
      const node=await resolveEntity(previous.id);
      if(!node){status(`返回失败：${previous.id} 不在这一份分析里`);renderRecent();return;}
      if(previous.mode&&previous.mode!==state.mode)setMode(previous.mode);
      if(previous.lens&&previous.lens!==state.lens)setLens(previous.lens);
      await select(node,{push:false});
    }catch(e){status(`返回失败：${String((e&&e.message)||e)}`);renderRecent();}
  })();
}
// --- 任务页签与理解镜头 ------------------------------------------------------
const MODES=['structure','understand','run','review'];
const LENSES=['calls','values','unknowns'];
// 页签与镜头写进 URL fragment:关闭再打开(或 3D 往返)后,用户还在同一个
// 任务里。fragment 不进 HTTP 请求,也不承载输入内容——那是草稿的事。
function updateViewFragment(){
  if(typeof history==='undefined')return;
  const params=new URLSearchParams(location.hash.slice(1));
  params.set('mode',state.mode);
  if(state.mode==='understand')params.set('lens',state.lens);else params.delete('lens');
  const rest=location.hash.slice(1)?`#${params.toString()}`:'';
  history.replaceState(null,'',location.pathname+rest);
}
function setMode(mode){
  if(!MODES.includes(mode)){status(`未知任务 ${mode}`);return false;}
  state.mode=mode;
  for(const b of qsa('.wb-tabs [data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===mode));
  renderTask();
  updateViewFragment();
  refreshProjectionLink();
  return true;
}
function setLens(lens){
  if(!LENSES.includes(lens)){status(`未知镜头 ${lens}`);return false;}
  state.lens=lens;
  renderTask();
  updateViewFragment();
  refreshProjectionLink();
  return true;
}
function renderTabs(){
  for(const b of qsa('.wb-tabs [data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode));
  renderTask();
}
function renderTask(){
  const structure=$('task-structure'),understand=$('task-understand'),run=$('task-run'),review=$('task-review');
  const canvas=$('canvas-host');
  const show=(el,on)=>{if(el)el.hidden=!on;};
  show(structure,state.mode==='structure');
  show(understand,state.mode==='understand');
  show(run,state.mode==='run'&&Boolean(state.selected));
  show(review,state.mode==='review'&&Boolean(state.selected));
  const fnSelected=state.selected&&state.selected.kind==='function';
  let canvasOn=false,lens='calls';
  if(state.mode==='structure')canvasOn=true;
  else if(state.mode==='understand'){
    for(const b of qsa('[data-lens]'))b.setAttribute('aria-pressed',String(b.dataset.lens===state.lens));
    lens=state.lens;
    canvasOn=!fnSelected||lens==='calls';
    show($('flow-panel'),fnSelected&&lens==='values'&&Boolean(state.flow||state.flowError));
    show($('unknown-panel'),lens==='unknowns'&&Boolean(state.unknownHasContent));
  }
  if(state.mode==='run'||state.mode==='review'){
    for(const b of qsa('[data-lens]'))b.setAttribute('aria-pressed','false');
  }
  show(canvas,canvasOn);
}
function renderHeading(){
  const node=state.selected;
  const crumb=$('selection-path'),title=$('selection-name');
  if(!node){
    if(crumb)crumb.textContent='固定分析版本';
    if(title)title.textContent='选择一个函数';
  }else{
    if(crumb)crumb.textContent=node.path||'(无路径)';
    if(title)title.textContent=node.name||node.id;
  }
  const runShortcut=$('run-shortcut');
  if(runShortcut)runShortcut.disabled=!(node&&node.kind==='function');
  const footer=$('selection-status');
  if(footer)footer.textContent=node?`当前选择：${node.path||''} · ${node.name||node.id} · ${state.report?String(state.report.id).slice(0,12):'未连接'}`:'当前选择：无';
  const sourcePath=$('sourcepath');
  if(sourcePath)sourcePath.textContent=node?`${node.path||''}${node.kind==='function'?` · 字节 ${node.start}–${node.end}`:''}`:'';
}
// The canvas answers one question: what is this object connected to?
function renderGraph(){
  const graph=$('graph');if(!graph)return;
  graph.replaceChildren();
  if($('empty'))$('empty').hidden=state.nodes.length>0;
  const defs=svg('defs');
  const marker=svg('marker',{id:'arrow',viewBox:'0 0 8 8',refX:7,refY:4,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});
  marker.append(svg('path',{d:'M 1 1 L 7 4 L 1 7',fill:'none',stroke:'#79a7bb'}));
  defs.append(marker);graph.append(defs);
  const byId=new Map(state.nodes.map(n=>[n.id,n]));for(const n of state.focus?.nodes||[])byId.set(n.id,n);
  const selected=state.selected&&state.selected.kind==='function'?state.selected:null;
  const wantFocus=selected&&state.mode==='understand'&&state.lens==='calls';
  // viewBox 用布局的真实宽度:硬编码 800 会把右列邻居裁出画布,用户看到的图
  // 缺一列却以为完整。
  const size=wantFocus?renderFocusGraph(graph,byId,selected):renderOverviewGraph(graph,byId);
  const width=Math.max(Number(size&&size.width)||800,800);
  const height=Math.max(Number(size&&size.height)||430,430);
  graph.setAttribute('viewBox',`0 0 ${width} ${height}`);
}
function graphNode(graph,{x,y,label,sub,cls,onClick,width=210,height=32}){
  const group=svg('g',{class:`node-group${cls?' '+cls:''}`,tabindex:0,role:'button','aria-label':String(label)});
  group.append(svg('rect',{x,y:y-height/2,width,height,rx:6,class:'function-row'}));
  group.append(svg('text',{x:x+12,y:sub?y-1:y+4,class:'function-text'},String(label).slice(0,26)));
  if(sub)group.append(svg('text',{x:x+12,y:y+14,class:'node-sub'},String(sub).slice(0,32)));
  group.append(svg('title',{},sub?`${label}\n${sub}`:String(label)));
  if(onClick){
    group.addEventListener('click',onClick);
    group.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onClick();}});
  }
  graph.append(group);
  return {x,y,w:width,h:height};
}
// The focus graph is laid out, not gridded.
const FOCUS_KEY_SEPARATOR='|';
function focusKey(root){
  const reach=state.focus||{edges:[]};
  return [root.id,(reach.edges||[]).length,(reach.unresolved||[]).length,state.layoutGen].join(FOCUS_KEY_SEPARATOR);
}
function focusEngine(){
  try{return typeof ELK!=='undefined'&&ELK?new ELK():null;}catch(error){return null;}
}
function focusPlanOptions(root,generation,elk){
  return {rootId:root.id,rootLabel:root.name,maxNodes:LAYOUT_MAX_NODES,generation,elk};
}
function drawFocusPlan(graph,plan,byId){
  const slotFor=(boxId,edgeId)=>{
    const entry=plan.ports.get(boxId);
    if(!entry)return null;
    return entry.slots.find(s=>s.edge===edgeId)||null;
  };
  for(const box of plan.boxes){
    const node=box.fileId?byId.get(box.fileId):null;
    const cls=[box.role==='target'?'selected':'',box.unresolved?'unresolved':'',box.folded?'folded':''].filter(Boolean).join(' ');
    // graphNode 的 x 是矩形左缘;布局端口也按左缘计算。传中心会把盒子画到
    // 端口右侧半个宽度,箭头看似停在框内(R4)。
    graphNode(graph,{x:box.x,y:box.y+box.h/2,label:box.label,sub:box.sub,width:box.w,height:box.h,cls,
      onClick:node?()=>select(node):()=>openUnloaded(box)});
  }
  for(const edge of plan.edges){
    const from=slotFor(edge.from,edge.id),to=slotFor(edge.to,edge.id);
    if(!from||!to)continue;
    const midX=(from.x+to.x)/2;
    const path=svg('path',{d:`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`,
      class:`edge${edge.kind==='direct'?'':' '+edge.kind}`,'marker-end':'url(#arrow)'});
    path.append(svg('title',{},edge.kind==='summary'
      ?`摘要边：折叠了 ${edge.viaCount} 个成员，不是直接调用`
      :`${edge.label}（${edge.kind==='unresolved'?'未解析目标':'静态调用候选'}）`));
    graph.append(path);
    const label=edge.kind==='summary'?`经 ${edge.viaCount} 个${edge.declared==='folded_tail'?'成员':'函数'}`:edge.label;
    graph.append(svg('text',{x:(from.x+to.x)/2,y:(from.y+to.y)/2-7,class:`edge-label ${edge.kind}`, 'text-anchor':'middle'},String(label).slice(0,18)));
  }
  const chainEdges=plan.edges.filter(e=>e.kind==='summary').length;
  const foldedTotal=plan.folded.reduce((total,entry)=>total+entry.viaCount,0);
  graph.append(svg('text',{x:20,y:20,class:'frame-label'},`调用视图 · 分层 ${plan.engine==='elk_pinned'?'（布局引擎）':'（本地回退）'}`));
  graph.append(svg('text',{x:20,y:36,class:'node-sub'},plan.engineLabel));
  if(foldedTotal)graph.append(svg('text',{x:20,y:52,class:'node-sub'},`折叠 ${foldedTotal} 个成员 → ${chainEdges} 条摘要边（虚线，不是直接调用）`));
  return {chainEdges,foldedTotal};
}
function drawFocusPending(graph,root){
  graph.append(svg('text',{x:20,y:20,class:'frame-label'},'调用视图 · 正在计算布局'));
  graphNode(graph,{x:110,y:129,label:root.name,sub:`${root.path} · 布局计算中`,cls:'selected',width:200,height:38});
}
function renderFocusGraph(graph,byId,root){
  const reach=state.focus||{edges:[],unresolved:[]};
  const key=focusKey(root);
  if(state.focusLayout&&state.focusLayoutKey===key){
    const drawn=drawFocusPlan(graph,state.focusLayout,byId);
    const plan=state.focusLayout;
    $('graph-status').textContent=`调用视图 ${plan.metrics.nodes} 块 / ${plan.metrics.edges} 边 · 未解析 ${plan.omitted.unresolved} · 引擎 ${plan.engine==='elk_pinned'?'布局引擎':'本地回退'}${plan.engineError?'（'+plan.engineError+'）':''} · 交叉 ${plan.metrics.crossings} · 标签碰撞 ${plan.metrics.labelCollisions} · 折叠 ${drawn.foldedTotal}${plan.budget.exceeded?' · 已按预算折叠':' · 未折叠'}${state.reachRes.errors.length?` · ${state.reachRes.errors.join('；')}`:''}`;
    $('graph-status').title='分层布局与端口由本地算法产生；边只表示静态候选，摘要边表示折叠，不是直接调用。';
    return {width:plan.bounds.width,height:Math.max(plan.bounds.height,240)};
  }
  const generation=++state.layoutGen;
  state.focusLayout=null;state.focusLayoutKey=null;
  const elk=focusEngine();
  if(!elk){
    state.focusLayout=planFocusLayout(reach,state.nodes,focusPlanOptions(root,null,elk));
    state.focusLayoutKey=focusKey(root);
    return renderFocusGraph(graph,byId,root);
  }
  // (async engine path returns above)
  drawFocusPending(graph,root);
  $('graph-status').textContent='调用视图 · 正在计算布局（完成前不显示上一次选区的结果）';
  const mine=generation;
  planFocusLayoutAsync(reach,state.nodes,focusPlanOptions(root,()=>state.layoutGen,elk)).then(plan=>{
    if(mine!==state.layoutGen||plan.stale)return;
    state.focusLayout=plan;state.focusLayoutKey=focusKey(root);
    renderGraph();
  }).catch(error=>{
    if(mine!==state.layoutGen)return;
    status(`布局失败：${String((error&&error.message)||error)}`);
  });
  return {width:800,height:240};
}
const LEVEL_MAX_FILES = 60;
const LEVEL_MAX_PIPES = 60;
const LEVEL_LABELS = ATLAS_LEVEL_LABELS;
const LEVELS = ATLAS_LEVELS;

function levelBlockSub(block, level){
  if(level==='project')return `${block.facts.files} 文件 · 声明 ${block.facts.declaredFunctions} 函数 · 聚合，不是一个对象`;
  if(level==='district'){
    const one=block.filePaths.length===1?' · 仅一个文件，可读出源码':'';
    return `${block.facts.files} 文件 · 声明 ${block.facts.declaredFunctions} 函数 · 聚合${one}`;
  }
  return `${block.path} · ${block.facts.declaredFunctions} 函数${block.analyzed?'':' · 未分析'}`;
}
function levelStatusLine(view,index,shownPipes){
  const loaded=state.nodes.length,total=state.nodePage?.total??state.nodes.length;
  const partial=loaded<total;
  const bits=[`层级 ${view.levelLabel}`,`块 ${view.blocks.length}`,
    `声明函数 ${view.totals.declaredFunctions}${partial?'（仅已加载子集）':''}`];
  if(partial)bits.push(`本页已加载 ${loaded}/${total} 对象，未加载的对象不在这个层级里`);
  if(view.omitted.files)bits.push(`层级未展开 ${view.omitted.files} 文件（不是丢失）`);
  if(view.budget.files)bits.push(`预算截断：文件层只画前 ${view.budget.maxFiles} 个文件（${view.totals.files} 中）`);
  if(view.pairUniverse>shownPipes)bits.push(`预算截断：管道 ${shownPipes}/${view.pairUniverse}`);
  bits.push(`索引 ${index.boxes} 盒 / ${index.cells} 格`);
  const scale = atlasScaleReport((state.nodes || []).filter((n) => n.kind === 'file')
    .map((n) => n.function_count || 0));
  bits.push(`柱高尺度（与 3D 同一函数）中位/最高 ${scale.ratios.medianOverMax.toFixed(3)} · 不足最高 1% 的列 ${scale.under.onePct}/${scale.under.of}` + (scale.linear.onePct ? `（线性尺度下 ${scale.linear.onePct}）` : ''));
  return bits.join(' · ');
}
function levelHitAt(x,y){
  const hit=atlasIndexHit(state.index,x,y);
  if(!hit.inBounds)return {ok:false,code:'outside_the_index',scanned:hit.scanned};
  if(!hit.hit)return {ok:false,code:'no_block_at_this_point',scanned:hit.scanned};
  return {ok:true,blockId:hit.hit.id,path:hit.hit.path,fileId:hit.hit.fileId,
    aggregate:hit.hit.aggregate,scanned:hit.scanned,candidates:hit.candidates};
}
function levelPickAt(x,y){
  const found=levelHitAt(x,y);
  if(!found.ok){status(`未选中：${found.code}`);return found;}
  if(!found.fileId){status(`该位置是聚合块 ${found.path}（${found.aggregate?'多个文件':'没有单一来源'}），不打开其中某个文件`);return found;}
  const node=state.nodes.find(n=>n.id===found.fileId);
  if(!node){status(`该位置的块 ${found.path} 不在已加载对象里`);return found;}
  select(node);
  return found;
}
function renderOverviewGraph(graph,byId){
  const hierarchy=buildAtlasHierarchy(state.nodes,state.edges);
  state.hierarchy=hierarchy;
  const view=atlasLevelBlocks(hierarchy,state.level,{maxFiles:LEVEL_MAX_FILES});
  state.levelView=view;
  const W=210,H=46,GX=40,GY=30,COLS=3;
  const pos=new Map(),boxes=[];
  let cursorY=62;
  for(const plate of view.plates){
    const blocks=plate.blockIds.map(id=>view.blocks.find(b=>b.id===id)).filter(Boolean);
    graph.append(svg('text',{x:40,y:cursorY-6,class:'folder-caption'},`${plate.label} · ${blocks.length} 块`));
    blocks.forEach((block,i)=>{
      const x=40+(i%COLS)*(W+GX),y=cursorY+14+Math.floor(i/COLS)*(H+GY);
      const selectedBlock=state.selected&&state.selected.id===block.fileId;
      graphNode(graph,{x,y,label:block.name,sub:levelBlockSub(block,view.level),width:W,height:H,cls:selectedBlock?'selected':'',
        onClick:()=>{
          const node=block.fileId?state.nodes.find(n=>n.id===block.fileId):null;
          if(node)select(node);
          else status(`聚合块 ${block.path}：${block.filePaths.length} 个文件，不是一个可打开的对象`);
        }});
      const box={id:block.id,path:block.path,fileId:block.fileId,aggregate:block.filePaths.length>1,x,y:y-H/2,w:W,h:H};
      boxes.push(box);pos.set(block.id,box);pos.set(block.path,box);
    });
    cursorY+=14+Math.ceil(blocks.length/COLS)*(H+GY)+14;
  }
  state.index=atlasSpatialIndex(boxes);
  const shown=view.pairs.slice(0,LEVEL_MAX_PIPES);
  for(const pair of shown){
    const pa=pos.get(pair.from)||pos.get(`file:${pair.from}`),pb=pos.get(pair.to)||pos.get(`file:${pair.to}`);
    if(!pa||!pb||pa===pb)continue;
    graphEdge(graph,pa,pb,`${pair.count} 候选`);
  }
  graph.append(svg('text',{x:40,y:20,class:'frame-label'},`层级：${view.levelLabel} — ${view.blocks.length} 个块，块的含义随层级改变`));
  graph.append(svg('text',{x:40,y:38,class:'node-sub'},view.level==='file'?'选择一个函数，画布切换为以它为中心的调用候选焦点图':'点击空白处用空间索引取块；粗层级的块没有单一源码'));
  $('graph-status').textContent=levelStatusLine(view,state.index,shown.length);
  $('graph-status').title=`同一份不可变分析的 ${view.levelLabel} 层视图；事实来自共享层级，预算、层级省略与"本页只加载了一页"分别报告。`;
  const overviewWidth=40+Math.min(Math.max(view.blocks.length,1),COLS)*(W+GX);
  return {width:overviewWidth,height:view.blocks.length?cursorY:430};
}
function graphEdge(graph,a,b,label,cls){
  const right=b.x>=a.x;
  const ax=right?a.x+a.w:a.x,bx=right?b.x:b.x+b.w;
  const away=right?46:-46,mid=(ax+bx)/2;
  const d=right?`M ${ax} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${bx} ${b.y}`
                :`M ${ax} ${a.y} C ${ax+away} ${a.y}, ${bx-away} ${b.y}, ${bx} ${b.y}`;
  const path=svg('path',{d,class:`edge${cls?' '+cls:''}`,'marker-end':'url(#arrow)'});
  path.append(svg('title',{},String(label)));
  graph.append(path);
  graph.append(svg('text',{x:(ax+bx)/2,y:(a.y+b.y)/2-7,class:'edge-label','text-anchor':'middle'},String(label).slice(0,14)));
}
function render(){renderSearch();renderRecent();renderHeading();renderGraph();renderTask();}

// --- 选区：资源独立加载，失败不连坐 ------------------------------------------
// 每个资源带自己的 generation（select 的 request 令牌）与状态；迟到的答案只被
// 丢弃，成功与失败互不覆盖。没有 Promise.all 把源码和关系绑在一起陪葬。
function resetDetail(){
  state.request++;state.selected=null;state.focus=null;state.focusIn=null;state.focusOut=null;state.execProfile=null;
  state.annotations=[];state.patches=[];state.sourceRes={status:'idle',error:null};state.reachRes={status:'idle',error:null,errors:[]};
  $('export').disabled=true;clearContext();
  $('selection-name').textContent='选择一个函数';$('selection-path').textContent='固定分析版本';
  $('selection-facts').textContent='选择对象以查询关联候选。';$('source').textContent='尚未选择对象';$('source-status').textContent='';
  publishSelection(null);renderAnnotations([]);renderFlow(null);renderExecution(null,null);render();
}
// Byte offsets from the engine are UTF-8; the loaded source is a JS string.
function byteLineMap(source){const encoder=new TextEncoder();const lines=[1];let bytes=0;for(const ch of source){bytes+=encoder.encode(ch).length;if(ch==='\n')lines.push(bytes+1);}return lines;}
function lineOf(map,byte){let line=1;for(let i=0;i<map.length;i++){if(map[i]<=byte)line=i+1;else break;}return line;}
async function loadSource(node,request){
  // 视图代数：完整加载与窗口定位共用一个令牌，后到的视图赢。
  const gen=++sourceViewGen;
  state.sourceRes={status:'loading',error:null};
  $('source').textContent='读取固定快照…';$('source-status').textContent='加载中…';
  try{
    const source=await api('source',{entity:node.id});
    if(gen!==sourceViewGen)return;
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.sourceRes={status:'ready',error:null};
    state.source=source;
    state.sourceLines=byteLineMap(source.content);
    $('source').textContent=source.content;
    $('source-status').textContent=`${source.start}–${source.end} 字节 · 第 ${source.start_line??1} 行起 · 共 ${source.file_total_bytes??'?'} 字节 · ${source.truncated?'已截断，不是完整对象':'完整对象'} · blob ${String(source.blob||'').slice(0,10)??''}`;
  }catch(e){
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.sourceRes={status:'error',error:e};
    $('source').textContent='源码读取失败';
    const box=$('source-status');box.replaceChildren();
    box.append(text('span',e&&e.status===401?'会话已失效或令牌不正确：请重新粘贴令牌后重试。':`源码读取失败：${resourceError(e)}`,'wb-error'));
    const retry=text('button','重试源码','wb-retry');
    retry.onclick=()=>{if(state.selected&&state.selected.id===node.id)loadSource(node,state.request);};
    box.append(retry);
  }
}
// --- 源码定位：按 UTF-8 字节窗口读取并高亮 -----------------------------------
// 结论（值来源、未知、调用点）到源码的通路：点击 → 计算带边距的窗口 →
// /api/source 的 start,end（限制在对象自身跨度内）→ 行号渲染 + 高亮 + 滚动。
// 找不到锚点时明说，不假装定位；窗口失败保留错误与重试，不回退读磁盘文件。
let sourceViewGen=0;
const SOURCE_WINDOW_PAD=300;
async function locateByteRange(start,end,label){
  const node=state.selected;if(!node)return;
  const gen=++sourceViewGen;
  const entStart=node.kind==='function'?node.start:0;
  const entEnd=node.kind==='function'?node.end:(state.source?.file_total_bytes||end);
  const ws=Math.max(entStart,Math.max(start-SOURCE_WINDOW_PAD,0));
  const we=Math.min(entEnd,end+SOURCE_WINDOW_PAD);
  try{
    const win=await api('source',{entity:node.id,start:ws,end:we});
    if(gen!==sourceViewGen)return;
    renderSourceWindow(win,{start,end});
    $('source-status').replaceChildren(
      text('span',`源码定位：${label||'所选区间'} · 字节 ${start}–${end} · 窗口 ${win.start}–${win.end}（第 ${win.start_line} 行起，共 ${win.file_total_bytes} 字节）`,''));
    const restore=text('button','显示完整对象','wb-retry');
    restore.onclick=()=>{if(state.selected)loadSource(state.selected,state.request);};
    $('source-status').append(restore);
  }catch(e){
    if(gen!==sourceViewGen)return;
    status(`源码定位失败：${resourceError(e)}`);
  }
}
function renderSourceWindow(win,highlight){
  const pre=$('source');if(!pre)return;
  const encoder=new TextEncoder();
  const rawLines=win.content.split('\n');
  let byte=win.start;
  pre.replaceChildren();
  for(let i=0;i<rawLines.length;i++){
    const lineStart=byte;
    const lineText=rawLines[i];
    byte+=encoder.encode(lineText).length+(i<rawLines.length-1?1:0);
    const isHl=highlight&&lineStart<highlight.end&&byte>highlight.start;
    const row=document.createElement('div');
    row.className='src-line'+(isHl?' src-hl':'');
    if(isHl)row.setAttribute('data-locate-line',String(win.start_line+i));
    row.append(text('span',String(win.start_line+i),'src-ln'));
    row.append(text('span',lineText.length?lineText:' ','src-code'));
    pre.append(row);
  }
  // 浏览器里把第一条高亮行滚进视野；测试 DOM 没有查询接口，跳过。
  try{
    const first=pre.querySelector('.src-hl');
    if(first&&first.scrollIntoView)first.scrollIntoView({block:'center'});
  }catch{}
}
// op index → op 的字节区间。ops 是 flow 事实的一部分，缺少就说明没有锚点。
function opSpan(flow,opIndex){
  const op=(flow?.ops||[]).find(o=>o.index===opIndex);
  if(!op||typeof op.start!=='number'||typeof op.end!=='number')return null;
  return {start:op.start,end:op.end};
}
function unknownAnchors(flow,code){
  // unknown_reasons 是语义码；能落到具体操作的才有源码锚点。码可能带家族前缀
  // （unmodeled_construct:x 对应 op detail 的 x），按后缀匹配，其余不猜。
  const hits=(flow?.ops||[]).filter(o=>{
    const d=String(o.detail||'');
    return d===code||code.endsWith(':'+d)||d.includes(code);
  });
  return hits.filter(o=>typeof o.start==='number'&&typeof o.end==='number');
}

// 焦点一跳：in/out 分别请求，按真实 edge ID 去重，保留两边各自的截断。
function mergeFocus(rootId,inReach,outReach){
  const edges=new Map(),unresolved=new Map(),nodes=new Map(),frontier=[];
  let truncated=false;
  for(const reach of [inReach,outReach]){
    if(!reach)continue;
    for(const n of reach.nodes||[])nodes.set(n.id,n);
    for(const e of reach.edges||[]){
      // 一跳：只保留根作为一端的边；reach 是多跳结果，不能整张贴成一跳。
      if(e.source===rootId||e.target===rootId)edges.set(e.id,e);
    }
    // in/out 各自返回自己的未解析边，按真实 edge ID 去重（接线表要求）。
    for(const u of reach.unresolved||[])if(u.source===rootId||u.target===rootId)unresolved.set(u.id,u);
    frontier.push(...(reach.frontier||[]));
    truncated=truncated||Boolean(reach.truncated);
  }
  if(!edges.size&&!unresolved.length&&!nodes.size)return null;
  return {analysis_id:state.report?.id||'',root:rootId,direction:'both',
    nodes:[...nodes.values()],edges:[...edges.values()],unresolved:[...unresolved.values()],
    frontier,truncated,semantics:'one-hop static candidates merged from in/out queries; not runtime paths'};
}
function describeReach(reach){
  const inCount=reach.edges.filter(e=>e.target===reach.root).length;
  const outCount=reach.edges.filter(e=>e.source===reach.root).length;
  const bits=[`${reach.nodes.length} 个相关对象`,`上游候选 ${inCount} 条 · 下游候选 ${outCount} 条`,`${reach.unresolved.length} 个未解析调用`];
  if(reach.truncated)bits.push('查询达到预算，仍有未展开边界');
  bits.push('这不是实际执行路线；分支可能互斥。');
  return bits.join('\n');
}
async function loadRelations(node,request){
  state.reachRes={status:'loading',error:null,errors:[]};
  $('selection-facts').textContent='查询关联候选…';
  $('graph-status').textContent='关系加载中…';
  const one=direction=>api('reach',{entity:node.id,direction});
  const [inResult,outResult]=await Promise.allSettled([one('in'),one('out')]);
  if(request!==state.request||state.selected?.id!==node.id)return;
  const errors=[];
  const inReach=inResult.status==='fulfilled'?inResult.value:null;
  const outReach=outResult.status==='fulfilled'?outResult.value:null;
  if(inResult.status==='rejected')errors.push(`上游查询失败：${resourceError(inResult.reason)}`);
  if(outResult.status==='rejected')errors.push(`下游查询失败：${resourceError(outResult.reason)}`);
  const merged=mergeFocus(node.id,inReach,outReach);
  if(!merged){
    state.reachRes={status:'error',error:errors.join('；')||'查询失败',errors};
    $('selection-facts').textContent=`关联候选不可用：${errors.join('；')}`;
    $('selection-facts').className='facts wb-error';
    const retry=text('button','重试关系','wb-retry');
    retry.onclick=()=>{if(state.selected&&state.selected.id===node.id)loadRelations(node,state.request);};
    $('selection-facts').append(document.createElement('br'),retry);
    render();
    return;
  }
  state.focusIn=inReach;state.focusOut=outReach;state.focus=merged;
  state.reachRes={status:errors.length?'partial':'ready',error:null,errors};
  $('selection-facts').className='facts';
  $('selection-facts').replaceChildren(text('span',describeReach(merged)+(errors.length?`\n${errors.join('；')}`:'')));
  $('export').disabled=false;
  render();
}
async function loadFlow(node,request){
  try{
    const flow=await api('flow',{entity:node.id});
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.flow=flow;
    renderFlow(flow,node.id);
  }catch(e){
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.flow=null;state.flowError=e.message;
    renderFlow(null);
    const body=$('flow-body');if(body)body.replaceChildren(flowNode('flow-unknown',`值事实加载失败：${e.message}`));
  }
}
async function loadProfile(node,request){
  try{
    const profile=await api('profile',{entity:node.id});
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.execProfile=profile;
    renderExecution(profile,null);
  }catch(e){
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.execProfile=null;
    renderExecution(null,null);
  }
}
async function select(node,opts={}){
  const request=++state.request;
  const push=opts.push!==false;
  if(push&&state.selected&&state.selected.id!==node.id){
    state.history.push({id:state.selected.id,mode:state.mode,lens:state.lens});
    if(state.history.length>50)state.history.shift();
  }
  state.selected=node;state.focus=null;state.focusIn=null;state.focusOut=null;state.execProfile=null;state.flow=null;state.flowError=null;
  state.sourceRes={status:'loading',error:null};state.reachRes={status:'loading',error:null,errors:[]};
  $('export').disabled=true;clearContext();
  if(node.id&&push){
    state.recent=[node.id,...state.recent.filter(id=>id!==node.id)].slice(0,12);
  }
  renderHeading();renderRecent();
  publishSelection(node);
  // Clear the previous selection's facts before the new ones arrive. Leaving
  // them up made the panel show function A's conclusion under function B's
  // name whenever the query failed.
  renderFlow(null);renderExecution(null,null);renderPatches([]);renderAnnotations([]);
  $('flow-panel').hidden=true;$('unknown-panel').hidden=true;
  renderTask();
  // Source, relations, flow, profile, annotations and patches load
  // independently: each one renders as it lands, each is generation-guarded,
  // and one failure never blanks the panels that succeeded. select awaits
  // them so a caller (test, bridge, deep link) observes a settled selection.
  await Promise.allSettled([
    loadSource(node,request),
    loadRelations(node,request),
    loadAnnotations(node),
    loadPatches(node),
    node.kind==='function'?loadFlow(node,request):Promise.resolve(),
    node.kind==='function'?loadProfile(node,request):Promise.resolve(),
    node.kind==='function'?loadExecRecords(node):Promise.resolve(),
  ]);
  if(request!==state.request)return;
  renderUnknowns();
  renderTask();
}

// --- 理解：值与未知 ----------------------------------------------------------
// `constants` is plain JSON, which has no token for undefined, NaN or Infinity.
function constantLabel(c){
  switch(c.kind){
    case 'number':return String(c.value);
    case 'string':return JSON.stringify(c.value);
    case 'boolean':return String(c.value);
    case 'null':return 'null';
    case 'undefined':return 'undefined';
    case 'nan':return 'NaN';
    case 'infinity':return 'Infinity';
    case 'negative_infinity':return '-Infinity';
    default:return c.kind;
  }
}
function flowValueSummary(value){
  if(!value)return '';
  const parts=[];
  const typed=value.typed_constants||[];
  if(typed.length)parts.push(`常量 ${typed.map(constantLabel).join(' | ')}`);
  else if(value.constants.length)parts.push(`常量 ${value.constants.map(c=>JSON.stringify(c)).join(' | ')}`);
  if(value.targets.length)parts.push(`函数目标 ${value.targets.length} 个`);
  if(value.origins.length)parts.push(`来源 ${value.origins.slice(0,4).join(', ')}${value.origins.length>4?' …':''}`);
  if(value.unknown&&value.reasons.length)parts.push(`未知: ${value.reasons.slice(0,3).join('; ')}${value.reasons.length>3?' …':''}`);
  return parts.join(' · ')||'空';
}
function flowNode(cls,value,tag){const e=document.createElement(tag||'div');e.className=cls;e.textContent=value;return e;}
// Minimal-DOM safe class append: the behavioural harness builds elements with
// a plain className string and no classList.
function markAnchored(el){el.className=el.className?`${el.className} wb-anchored`:'wb-anchored';}
const HEAT_MAX_BLOCKS=14,HEAT_MAX_BINDINGS=10;
function heatCellClass(binding){
  if(!binding)return 'heat-cell heat-empty';
  const value=binding.value||{};
  const hasConstant=Boolean((value.typed_constants&&value.typed_constants.length)||(value.constants&&value.constants.length));
  const hasTargets=Boolean(value.targets&&value.targets.length);
  const cls=['heat-cell'];
  if(hasConstant)cls.push('heat-const');
  else if(hasTargets)cls.push('heat-value');
  else if(value.unknown)cls.push(value.origins&&value.origins.length?'heat-origin':'heat-unknown');
  else cls.push('heat-value');
  if(value.unknown&&(hasConstant||hasTargets))cls.push('heat-partial');
  if(binding.init==='NotInitialized')cls.push('heat-init-none');
  else if(binding.init==='MaybeInitialized')cls.push('heat-init-maybe');
  return cls.join(' ');
}
const HEAT_LEGEND=[['heat-const','常量'],['heat-value','确定值'],['heat-origin','已知来源'],['heat-unknown','显式未知'],['heat-empty','该块无记录'],['heat-partial','角标=含未知分量'],['heat-init-none','描边=读取时未初始化'],['heat-init-maybe','描边=可能未初始化']];
function renderFlowHeat(flow){
  const termOf=new Map((flow.blocks||[]).map(b=>[b.id,b.term]));
  const states=(flow.block_states||[]).filter(s=>!['sink'].includes(termOf.get(s.block)));
  const names=[],seen=new Set();
  for(const state of states)for(const binding of state.bindings||[]){
    if(!seen.has(binding.name)){seen.add(binding.name);names.push(binding.name);}
  }
  const columns=names.slice(0,HEAT_MAX_BINDINGS);
  if(!columns.length||!states.length)return null;
  const shown=states.slice(0,HEAT_MAX_BLOCKS);
  const wrap=flowNode('flow-heat','');
  wrap.append(flowNode('heat-head',`绑定状态矩阵 · ${shown.length} 块 × ${columns.length} 绑定（行=基本块，列=绑定）`));
  const legend=flowNode('heat-legend','');
  for(const [kind,label] of HEAT_LEGEND){
    const key=flowNode('heat-key','');
    key.append(flowNode('heat-swatch '+kind,''));
    key.append(flowNode('heat-key-label',label));
    legend.append(key);
  }
  wrap.append(legend);
  for(const state of shown){
    const row=flowNode('heat-row'+(state.truncated?' heat-row-truncated':''),'');
    row.append(flowNode('heat-row-label',`块 ${state.block}`));
    for(const name of columns){
      const binding=(state.bindings||[]).find(b=>b.name===name);
      const cell=flowNode(heatCellClass(binding),'');
      cell.setAttribute('data-block',String(state.block));
      cell.setAttribute('data-binding',name);
      cell.title=binding
        ?`${name} · ${binding.init} · ${flowValueSummary(binding.value)}${binding.defs.length?` · defs ${binding.defs.join(',')}`:''}`
        :`${name} 在此块没有绑定记录：既不是未知，也不是未定义`;
      row.append(cell);
    }
    wrap.append(row);
  }
  const notes=[];
  if(states.length>shown.length)notes.push(`另有 ${states.length-shown.length} 个块未画出`);
  if(names.length>columns.length)notes.push(`另有 ${names.length-columns.length} 个绑定未画出`);
  if(shown.some(s=>s.truncated))notes.push('标记块的绑定状态已被预算截断');
  if(flow.frontier&&flow.frontier.length)notes.push(`frontier 含 ${flow.frontier.length} 个未收敛块`);
  if(notes.length)wrap.append(flowNode('heat-note',notes.join(' · ')));
  return wrap;
}
// 值来源行：绑定 → 来源摘要 → 可点源码依据。绑定与 op 都来自已发布事实；
// 每行只有真实给出的字段，缺失来源写缺失，不按函数名推导业务结论。
const VALUE_ROWS_MAX=8;
function valueOriginRows(flow){
  const host=[];
  const seen=new Set();let count=0;
  // block_states 的 defs 常为空；def_use 按同一绑定 id 给出 def op，作回退锚点。
  const defOpOf=new Map();
  for(const du of flow.def_use||[]){
    if(Array.isArray(du.defs)&&du.defs.length&&!defOpOf.has(du.binding))defOpOf.set(du.binding,du.defs[0]);
  }
  for(const state of flow.block_states||[]){
    for(const binding of state.bindings||[]){
      if(seen.has(binding.name))continue;
      seen.add(binding.name);
      if(count>=VALUE_ROWS_MAX)return host;
      const fallbackDef=defOpOf.get(binding.binding);
      const defOp=Array.isArray(binding.defs)&&binding.defs.length?binding.defs[0]:(fallbackDef===undefined?null:fallbackDef);
      const span=defOp===null?null:opSpan(flow,defOp);
      const summary=flowValueSummary(binding.value);
      const row=flowNode('flow-line',`${binding.name} [${binding.init}] ${summary||'（无已发布值摘要）'}`);
      if(span){
        markAnchored(row);
        row.title=`定位定义（字节 ${span.start}–${span.end}）`;
        row.onclick=()=>locateByteRange(span.start,span.end,`定义 ${binding.name}`);
      }else if(defOp!==null){
        row.append(flowNode('span','（定义 op 未带字节锚点）','wb-noanchor'));
      }
      host.push(row);
      count++;
    }
  }
  if(count===0){
    host.push(flowNode('flow-line','这一份分析没有发布绑定级值状态；来源摘要只有上面的返回/抛出行。'));
  }
  return host;
}
function renderFlow(flow,symbol){
  const panel=$('flow-panel');const body=$('flow-body');if(!panel||!body)return;
  if(!flow){panel.hidden=true;body.replaceChildren();return;}
  if(symbol&&flow.symbol!==symbol){
    panel.hidden=false;body.replaceChildren(flowNode('flow-unknown',`已拒绝显示：查询返回的 flow 属于 ${flow.symbol}，与选中的 ${symbol} 不一致。`));
    return;
  }
  panel.hidden=false;body.replaceChildren();
  body.append(flowNode('flow-head',`算法 ${flow.algorithm.id}@${flow.algorithm.version} · ${flow.status} · ${flow.coverage.cfg_blocks} 块 / ${flow.coverage.supported_op_transfers} 次操作求值`));
  // 返回值行带锚点：能落到 return 操作的字节区间就可点，落不到就只是文本。
  const returnsLine=flowNode('flow-line',`正常返回: ${flowValueSummary(flow.returns)}`);
  const returnSpan=(()=> {
    const block=(flow.blocks||[]).find(b=>b.term==='return'&&b.ops.length);
    if(!block)return null;
    return opSpan(flow,block.ops[block.ops.length-1]);
  })();
  if(returnSpan){
    markAnchored(returnsLine);
    returnsLine.title=`定位返回语句（字节 ${returnSpan.start}–${returnSpan.end}）`;
    returnsLine.onclick=()=>locateByteRange(returnSpan.start,returnSpan.end,'正常返回');
  }
  body.append(returnsLine);
  body.append(flowNode('flow-line',`潜在抛出: ${flowValueSummary(flow.throws)}`));
  for(const row of valueOriginRows(flow))body.append(row);
  const effects=[];
  if(flow.effects.may_call.length)effects.push(`可能调用 ${flow.effects.may_call.length} 个目标`);
  if(flow.effects.unknown_call)effects.push('存在未知外部调用');
  if(flow.effects.may_write_heap)effects.push('可能写入对象字段');
  if(flow.effects.may_access_global)effects.push('读取外部/全局名');
  if(flow.effects.registers_callback)effects.push('传递了函数值(潜在回调注册)');
  if(effects.length)body.append(flowNode('flow-line',`效果: ${effects.join(' · ')}`));
  if(flow.interprocedural){
    body.append(flowNode('flow-line',`跨过程摘要: ${flow.interprocedural.status} · SCC ${flow.interprocedural.scc_count}(递归 ${flow.interprocedural.recursive_sccs})`));
    for(const cs of flow.interprocedural.callsites.slice(0,8)){
      const target=cs.targets.length===1?`${cs.targets.length} 个确定目标`:cs.targets.length>1?`${cs.targets.length} 个候选目标`:null;
      const head=`调用点 op${cs.op} ${cs.unknown_component?'(含未知分量)':target?'→ '+target:'(无确定目标)'}`;
      const row=flowNode('flow-binding',`${head} · 实参来源 ${cs.args.map(a=>a.origins.slice(0,2).join('/')).join(', ')||'无'}`);
      if(typeof cs.start==='number'&&typeof cs.end==='number'){
        markAnchored(row);
        row.title=`定位调用点（字节 ${cs.start}–${cs.end}）`;
        row.onclick=()=>locateByteRange(cs.start,cs.end,`调用点 ${cs.label||''}`);
      }
      body.append(row);
    }
    if(flow.interprocedural.callsites.length>8)body.append(flowNode('flow-binding','…其余调用点按预算省略'));
  }
  for(const reason of flow.unknown_reasons.slice(0,6))body.append(flowNode('flow-unknown',`未知 · ${reason}`));
  const heat=renderFlowHeat(flow);if(heat)body.append(heat);
  const blocks=flow.blocks.filter(b=>!['sink'].includes(b.term)).slice(0,12);
  for(const block of blocks){
    const state=flow.block_states.find(s=>s.block===block.id);
    const line=flowNode('flow-block','');
    const label=`块 ${block.id} · ${block.term}${block.ops.length?` · ${block.ops.length} 操作`:''}`;
    line.append(text('b',label));
    if(state){
      for(const binding of state.bindings.slice(0,6)){
        if(binding.value.unknown&&!binding.value.reasons.length&&binding.init==='Initialized')continue;
        line.append(flowNode('flow-binding',`${binding.name} [${binding.init}] ${flowValueSummary(binding.value)}`));
      }
      if(state.truncated)line.append(flowNode('flow-binding','…绑定状态已按预算截断'));
    }
    const edgeText=block.successors.map(([to,kind])=>`→${to}(${kind})`).join(' ');
    if(edgeText)line.append(flowNode('flow-binding',`后继 ${edgeText}`));
    body.append(line);
  }
  if(flow.blocks.length>12)body.append(flowNode('flow-line',`…其余 ${flow.blocks.length-12} 块按预算省略，可查询完整 flow 记录`));
}
// 未知边界镜头：flow 的 unknown_reasons + 分析报告的 diagnostics，分来源列出。
const UNKNOWN_ROWS_PER_REASON=12;
function renderUnknowns(){
  const body=$('unknown-body');if(!body)return;
  body.replaceChildren();
  state.unknownHasContent=false;
  const flowReasons=(state.flow&&state.flow.unknown_reasons)||[];
  const diag=(state.report&&state.report.diagnostics)||[];
  if(!flowReasons.length&&!diag.length){
    if(state.selected&&state.selected.kind==='function'&&!state.flowError)
      body.append(flowNode('flow-line','这一份分析没有报告当前函数或项目级的显式未知区域。','matrix-note'));
    else if(state.flowError)body.append(flowNode('flow-unknown',`未知清单不可用：${state.flowError}`));
    return;
  }
  if(flowReasons.length){
    body.append(flowNode('h3','当前函数的未知（声明 profile 内）','wb-panel-title'));
    for(const reason of flowReasons.slice(0,8)){
      const anchors=unknownAnchors(state.flow,reason);
      const row=flowNode('flow-unknown',anchors.length
        ?`未知 · ${reason} · ${anchors.length} 处可定位`
        :`未知 · ${reason} · 无单一源码锚点（来自函数级语义总结，不是可点开的语句）`);
      if(anchors.length){
        markAnchored(row);
        row.title=`定位第一处（字节 ${anchors[0].start}–${anchors[0].end}）`;
        row.onclick=()=>locateByteRange(anchors[0].start,anchors[0].end,`未知 ${reason}`);
      }
      body.append(row);
    }
  }
  if(state.flowError)body.append(flowNode('flow-unknown',`flow 事实加载失败，函数级未知不完整：${state.flowError}`));
  state.unknownHasContent=body.childElementCount>0||body._children?.length>0||Boolean(flowReasons.length||diag.length);
  if(diag.length){
    body.append(flowNode('h3',`项目诊断中的未知区域 · 共 ${diag.length} 处`,'wb-panel-title'));
    const byReason=new Map();
    for(const item of diag){
      const reason=String(item.detail||'').split(' ')[0]||'未说明';
      if(!byReason.has(reason))byReason.set(reason,[]);
      byReason.get(reason).push(item);
    }
    for(const [reason,items] of [...byReason.entries()].sort((a,b)=>b[1].length-a[1].length)){
      for(const item of items.slice(0,UNKNOWN_ROWS_PER_REASON)){
        const span=String(item.detail||'').split(' ').slice(1).join(' ')||'（未给区间）';
        const row=text('button',`${item.path}  ${span}`,'fn-hit');
        row.title=`${item.code} · ${item.path} · ${item.detail}`;
        row.onclick=()=>openUnknownRegion(item);
        body.append(row);
      }
      if(items.length>UNKNOWN_ROWS_PER_REASON)body.append(text('p',`…其余 ${items.length-UNKNOWN_ROWS_PER_REASON} 处同因（${reason}，按显示上限省略，不是不存在）`,'matrix-note'));
    }
  }
}
// 点一处未知：打开它所在的文件（按身份解析），并真实加载该区间的源码窗口
// 高亮定位——不再只是打开文件头再打印一个大字节数。
async function openUnknownRegion(item){
  status(`正在打开 ${item.path} …`);
  try{
    const node=await resolveEntity(`file:${item.path}`);
    if(!node){status(`打不开：${item.path} 不在这份分析里`);return;}
    await select(node);
    const parts=String(item.detail||'').split(/\s+/);
    const start=Number(parts[parts.length-2]),end=Number(parts[parts.length-1]);
    if(Number.isFinite(start)&&Number.isFinite(end)&&end>start){
      await locateByteRange(start,end,`未知区域 ${parts[0]}`);
    }else{
      status(`已打开 ${item.path}；这条未知（${parts[0]}）没有给出可定位的字节区间。`);
    }
  }catch(error){
    status(`打不开：${String((error&&error.message)||error)}`);
  }
}

// --- 执行画像与受控运行 ------------------------------------------------------
function decodeEncoded(value){
  if(!value||typeof value!=='object'||typeof value.kind!=='string')return value;
  switch(value.kind){
    case 'null':return null;
    case 'number':case 'string':case 'boolean':case 'bigint':return value.value;
    case 'array':return (value.items||[]).map(decodeEncoded);
    case 'object':{const out={};for(const [k,v] of Object.entries(value.entries||{}))out[k]=decodeEncoded(v);return out;}
    default:return `<${value.kind}>`;
  }
}
function renderExecValue(node,label,value,cls){
  const line=flowNode(cls||'flow-binding',`${label} ${typeof value==='string'?value:JSON.stringify(value)}`);
  node.append(line);return line;
}
function renderExecution(profile,record){
  const panel=$('exec-panel'),body=$('exec-body');if(!panel||!body)return;
  if(!profile){panel.hidden=true;body.replaceChildren();$('exec-run').disabled=true;return;}
  panel.hidden=false;body.replaceChildren();
  if(state.selected&&profile.symbol&&profile.symbol!==state.selected.id){
    body.append(flowNode('flow-unknown',`已拒绝显示：执行画像属于 ${profile.symbol}，与选中的 ${state.selected.id} 不一致。`));
    $('exec-run').disabled=true;return;
  }
  const runnable=Boolean(profile.runnable);
  body.append(flowNode('flow-head',`执行画像 ${profile.classification} · ${profile.runnable?'可运行':'不可运行'} · 参数 ${profile.arity===null?'未知':profile.arity} · flow ${profile.flow_status}`));
  body.append(flowNode('exec-note','这是静态充分性分类，不是执行结果，也不是「已经跑过」的证据。'));
  for(const reason of profile.reasons.slice(0,8))body.append(flowNode('flow-unknown',`理由 · ${reason.code} — ${reason.detail}（证据：${reason.evidence}）`));
  if(!profile.reasons.length)body.append(flowNode('flow-line','没有降级理由：已发布事实中没有任何 unknown 分量。'));
  if(profile.required_grants.length)body.append(flowNode('flow-line',`需要显式授权：${profile.required_grants.join(', ')}`));
  const context=profile.required_context||[];
  if(context.length)body.append(flowNode('flow-unknown',`需要调用者声明的输入：${context.join(', ')}${(profile.required_globals||[]).length?`（全局：${profile.required_globals.join(', ')}）`:''}。Atlas 不发明这些值，页面也没有为它们提供输入框；请在 CLI 上用 --this / --global 声明。`));
  if((profile.unsatisfiable_context||[]).length)body.append(flowNode('flow-unknown',`Atlas 无法用数据声明：${profile.unsatisfiable_context.join(', ')}，因此该函数不可直接运行。`));
  const enclosing=profile.enclosing_symbol||null;
  const viaRow=$('exec-via-row');
  if(viaRow){
    viaRow.hidden=!enclosing;
    if(enclosing){
      $('exec-via-label').textContent=`包含函数 ${enclosing}`;
      body.append(flowNode('flow-line',`包含函数 ${enclosing}：闭包实例只能由它真实产生，页面不凭空构造作用域。`));
      const viaEnable=$('exec-via-enable');
      const captures=(profile.unsatisfiable_context||[]).includes('captures');
      viaEnable.checked=captures;
      if(captures)body.append(flowNode('flow-line',`捕获的绑定：${(profile.captures||[]).join(', ')||'（未命名）'}。勾选「经由包含函数」后，Atlas 会先调用 ${enclosing}，并只接受它返回、且源码与目标钉住字节一致的那个函数实例。`));
      const token=state.execRender+1;
      state.execRender=token;
      loadAncestorChain(profile).then(chainReport=>{
        if(token!==state.execRender)return;
        state.ancestorChain=chainReport;
        const chainField=$('exec-via-chain');
        if(chainField)chainField.value=chainReport.chain.length>1?JSON.stringify(chainReport.chain.slice(1)):'[]';
        if(chainReport.chain.length>1){
          body.append(flowNode('flow-line',`这个闭包嵌了 ${chainReport.chain.length} 层：${chainReport.chain.map(entry=>entry.symbol).join(' → ')}（由分析自身的 enclosing_symbol 逐级查出）→ 目标。每级都要给出实参，且每级返回的函数都会与下一级的钉住字节比对。`));
        }
        if(!chainReport.complete&&chainReport.reason==='profile_symbol_mismatch'){
          body.append(flowNode('flow-unknown','向上追溯包含函数时，画像与所查符号不一致，已停止追溯；请改用 CLI 明确给出 --via-chain。'));
        }
      }).catch(()=>{});
    }
  }
  body.append(flowNode('flow-line',`参数：${profile.params.map(p=>`${p.index}:${p.name}`).join(', ')||'无'}`));
  for(const note of profile.notes.slice(0,4))body.append(flowNode('flow-line',note));
  renderExecForm(profile);
  renderExecResult();
  const viaWanted=Boolean(enclosing&&$('exec-via-enable')?.checked);
  const known=profile.arity!==null;
  $('exec-run').disabled=!(((runnable)||viaWanted)&&known);
  $('exec-run').title=runnable?(known?'在隔离副本中以目标 Node 的权限模型执行一次固定调用':'参数个数未知，页面不猜测实参'):(viaWanted?`经由 ${enclosing} 取得闭包实例后执行`:'静态画像拒绝执行');
  const note=$('exec-run-note');
  if(note)note.textContent=runnable?'在隔离副本中以目标 Node 的权限模型执行一次固定调用':(viaWanted?`经由包含函数取得闭包实例后执行；同步等待，完成前不能取消`:'静态画像拒绝执行；不能运行，也不提供强行开关');
}
// --- 运行表单：按参数编辑与高级数组编辑共用一份草稿 --------------------------
// 草稿按选区保存：切换函数互不覆盖；切走再回来输入还在。没有类型/默认值证据
// 时不生成占位猜测，字段为空就明说。receiver/globals 是数据输入，按画像缺项
// 逐项出现；表单不提供任何扩大授权的开关。
// 草稿按选区保存并持久在本机 localStorage(只属于这个 origin,从不随请求
// 出本机):重启服务、重开浏览器后,同一函数的输入还在。令牌与源码不在此列。
function persistDrafts(){
  try{
    if(typeof localStorage!=='undefined')localStorage.setItem('atlas.execDrafts.v1',JSON.stringify(state.execDrafts));
  }catch{/* 私有模式等场景下持久化失败不影响使用,只是重开不恢复 */}
}
function restoreDrafts(){
  try{
    if(typeof localStorage==='undefined')return;
    const raw=localStorage.getItem('atlas.execDrafts.v1');
    if(raw){const parsed=JSON.parse(raw);if(parsed&&typeof parsed==='object')state.execDrafts=parsed;}
  }catch{/* 损坏的持久化数据当作没有 */}
}
function execDraft(entityId){
  const id=entityId||(state.selected&&state.selected.id);
  if(!state.execDrafts[id]){
    state.execDrafts[id]={fields:{},raw:'[]',advanced:false,receiver:'',globals:{},viaArgs:'',viaChain:''};
  }
  return state.execDrafts[id];
}
function renderExecForm(profile){
  const form=$('exec-form');if(!form)return;
  form.hidden=false;
  const draft=execDraft(profile.symbol);
  const mode=$('exec-mode');
  if(mode)mode.textContent=draft.advanced?'按参数编辑':'JSON 数组编辑';
  renderExecFields(profile,draft);
  renderExecContext(profile,draft);
  const err=$('exec-input-error');
  if(err){err.hidden=true;err.textContent='';}
}
function renderExecFields(profile,draft){
  const box=$('exec-fields');if(!box)return;
  box.replaceChildren();
  const advanced=draft.advanced;
  const argsArea=$('exec-args');
  if(argsArea){
    argsArea.hidden=!advanced;
    if(advanced&&!argsArea.value)argsArea.value=draft.raw||'[]';
  }
  if(advanced)return;
  if(!profile.params.length){
    box.append(text('p','这一份分析没有给出参数名（arity 未知或无参），请用「JSON 数组编辑」给出位置实参。','subtle'));
  }
  for(const param of profile.params){
    const wrap=document.createElement('div');
    wrap.className='exec-field';
    const label=document.createElement('label');
    label.setAttribute('for',`exec-param-${param.index}`);
    label.append(text('span',param.name||`参数 ${param.index}`,'exec-field-name'),text('span',` · 位置 ${param.index} · JSON 值`,'subtle'));
    const input=document.createElement('textarea');
    input.id=`exec-param-${param.index}`;
    input.rows=2;
    input.spellcheck=false;
    input.value=draft.fields[param.index]??'';
    input.setAttribute('data-param-index',String(param.index));
    input.oninput=()=>{execDraft(profile.symbol).fields[param.index]=input.value;persistDrafts();};
    wrap.append(label,input);
    box.append(wrap);
  }
}
function renderExecContext(profile,draft){
  const box=$('exec-context');if(!box)return;
  box.replaceChildren();
  const wantsReceiver=(profile.required_context||[]).includes('this_arg');
  const wantsGlobals=(profile.required_context||[]).includes('globals')&&(profile.required_globals||[]).length;
  if(wantsReceiver){
    const wrap=document.createElement('div');wrap.className='exec-field';
    const label=document.createElement('label');
    label.setAttribute('for','exec-receiver');
    label.append(text('span','receiver（this）','exec-field-name'),text('span',' · 画像声明该函数读取 this；JSON 值','subtle'));
    const input=document.createElement('textarea');
    input.id='exec-receiver';input.rows=2;input.spellcheck=false;
    input.value=draft.receiver||'';
    input.oninput=()=>{execDraft(profile.symbol).receiver=input.value;persistDrafts();};
    wrap.append(label,input);box.append(wrap);
  }
  if(wantsGlobals){
    const wrap=document.createElement('div');wrap.className='exec-field';
    const label=document.createElement('label');
    label.setAttribute('for',`exec-global-${0}`);
    label.append(text('span','globals','exec-field-name'),text('span',` · 画像声明读取：${(profile.required_globals||[]).join(', ')}；逐名 JSON 值`,'subtle'));
    wrap.append(label);
    (profile.required_globals||[]).slice(0,8).forEach((name,i)=>{
      const input=document.createElement('textarea');
      input.id=`exec-global-${i}`;input.rows=1;input.spellcheck=false;
      input.placeholder=`${name} 的 JSON 值`;
      input.value=draft.globals[name]??'';
      input.setAttribute('data-global-name',name);
      input.oninput=()=>{execDraft(profile.symbol).globals[name]=input.value;persistDrafts();};
      wrap.append(input);
    });
    box.append(wrap);
  }
}
function execInputError(message){
  const err=$('exec-input-error');if(!err)return;
  err.textContent=message;err.hidden=false;
}
// 把草稿变成请求体；失败以异常抛出，消息给字段附近的错误区。
function execFormValue(profile){
  const draft=execDraft(profile.symbol);
  let args;
  if(draft.advanced){
    let raw=( $('exec-args')&&$('exec-args').value!==''?$('exec-args').value:draft.raw)||'[]';
    args=JSON.parse(raw);
    if(!Array.isArray(args))throw new Error('位置实参需要 JSON 数组');
  }else{
    args=profile.params.map(p=>{
      const text=(draft.fields[p.index]??'').trim();
      if(text==='')throw new Error(`参数 ${p.name||p.index} 还没有输入（留空不会自动补默认值）`);
      const value=JSON.parse(text);
      return value;
    });
  }
  if(args.length>64)throw new Error('实参数量超过上限（64）');
  const out={args};
  const receiverText=(draft.receiver||'').trim();
  if(receiverText!=='')out.this_arg=JSON.parse(receiverText);
  const globals={};
  for(const [name,valueText] of Object.entries(draft.globals)){
    if(String(valueText).trim()==='')continue;
    globals[name]=JSON.parse(valueText);
  }
  if(Object.keys(globals).length)out.globals=globals;
  return out;
}
function loadExecRecords(node){
  const target=node||(state.selected);
  const request=state.request;
  if(!target||target.kind!=='function'){state.execRecords=[];renderExecHistory();return Promise.resolve();}
  return api('exec-records',{entity:target.id,limit:20}).then(records=>{
    if(request!==state.request||state.selected?.id!==target.id)return;
    state.execRecords=Array.isArray(records)?records:[];
    state.execRecordsError=null;
    renderExecHistory();
  }).catch(e=>{
    if(request!==state.request||state.selected?.id!==target.id)return;
    state.execRecords=[];state.execRecordsError=resourceError(e);
    renderExecHistory();
  });
}
function renderExecHistory(){
  const panel=$('exec-history-panel'),body=$('exec-history');
  if(!panel||!body)return;
  body.replaceChildren();
  const hasSelection=state.selected&&state.selected.kind==='function';
  panel.hidden=!hasSelection;
  if(!hasSelection)return;
  if(state.execRecordsError){body.append(flowNode('flow-unknown',`运行记录查询失败：${state.execRecordsError}`));return;}
  if(!state.execRecords.length){body.append(flowNode('flow-line','这个对象还没有运行记录。'));return;}
  for(const record of state.execRecords.slice(0,10)){
    const outcome=record.value!==null&&record.value!==undefined
      ?`返回 ${JSON.stringify(decodeEncoded(record.value)).slice(0,80)}`
      :record.thrown?`抛出 ${record.thrown.name}`:'无返回值';
    const row=flowNode('flow-line',`${record.verdict} · ${record.duration_ms} ms · ${outcome} · 实参 ${JSON.stringify((record.spec&&record.spec.args)||[])}`);
    const actions=document.createElement('div');actions.className='context-actions';
    const refill=document.createElement('button');
    refill.textContent='重填输入（不自动运行）';
    refill.className='wb-retry';
    refill.onclick=()=>refillFromRecord(record);
    actions.append(refill);
    row.append(actions);
    body.append(row);
  }
}
function refillFromRecord(record){
  const profile=state.execProfile;if(!profile)return;
  const draft=execDraft(profile.symbol);
  const args=(record.spec&&Array.isArray(record.spec.args))?record.spec.args:[];
  profile.params.forEach(param=>{draft.fields[param.index]=JSON.stringify(args[param.index]);});
  draft.raw=JSON.stringify(args);
  draft.receiver=(record.spec&&record.spec.this_arg!==undefined&&record.spec.this_arg!==null)?JSON.stringify(record.spec.this_arg):'';
  draft.globals={};
  const globals=(record.spec&&record.spec.globals)||{};
  for(const [name,value] of Object.entries(globals))draft.globals[name]=JSON.stringify(value);
  renderExecForm(profile);
  persistDrafts();
  status('已按该记录重填输入；检查后手动运行。');
}
function renderExecResult(){
  const box=$('exec-result');if(!box)return;
  box.replaceChildren();
  const result=state.execResult;
  if(!result||!result.record)return;
  const head=flowNode('flow-head',`本次目标 ${result.symbol} · 分析 ${String(state.report?.id||'').slice(0,12)}`);
  box.append(head);
  box.append(flowNode('flow-line',`实际输入：${JSON.stringify(result.args)}${result.via?` · 经由 ${result.via.symbol} ${JSON.stringify(result.via.args)}`:''}`));
  renderExecRecord(box,result.record);
}
function renderExecRecord(body,record){
  const verdict=record.verdict;
  body.append(flowNode('exec-verdict',`观测结果 ${verdict} · ${record.duration_ms} ms · 退出码 ${record.exit_code===null?'无':record.exit_code}`));
  if(verdict==='refused'){
    body.append(flowNode('flow-unknown',`拒绝执行：${record.refusal?.code} — ${record.refusal?.detail}`));
    body.append(flowNode('flow-line','没有进程被启动；这不是一次失败的执行。'));
    const viaRefusal=record.via&&record.via.decision&&record.via.decision.allowed===false?record.via.decision.refusal:null;
    if(viaRefusal)body.append(flowNode('flow-unknown',`包含函数 ${record.via.name}（${record.via.symbol}）自己的结论：${viaRefusal.code} — ${viaRefusal.detail}`));
    return;
  }
  if(record.isolation&&record.isolation.mocks)body.append(flowNode('exec-note',`本次运行声明使用了 mock/fixture：${record.isolation.fixture_note||'未注明'}；结果不得当作真实环境观测。`));
  if(record.via){
    const stage=record.via.stage_report||{};
    const stages=stage.stages||[stage];
    const ancestors=record.via.ancestors||[];
    if(ancestors.length)body.append(flowNode('flow-line',`祖先链（由外到内）${[...ancestors.map(entry=>entry.name),record.via.name].join(' → ')} · 共 ${record.via.chain_length||stages.length} 级，每一级都按源码同一性核对。`));
    for(const entry of stages){
      const label=`阶段 ${(entry.index===undefined?0:entry.index)+1} 调用 ${entry.name||'?'} · 返回 ${entry.value===null||entry.value===undefined?'无':JSON.stringify(decodeEncoded(entry.value))}`;
      body.append(flowNode(entry.closure&&entry.closure.matched_by?'flow-line':'flow-unknown',
        `${label} · 下一级源码同一性 ${entry.closure?(entry.closure.matched_by||'不匹配'):'未检查'}${entry.closure&&!entry.closure.matched_by?` · 观测到 ${String(entry.closure.observed_source||'').slice(0,160)}`:''}`));
      if(entry.thrown)body.append(flowNode('flow-unknown',`该级抛出 ${entry.thrown.name}: ${entry.thrown.message}`));
    }
    if(stage.failed_stage!==null&&stage.failed_stage!==undefined)body.append(flowNode('flow-unknown',`失败发生在第 ${stage.failed_stage+1} 级；目标没有被调用。`));
    body.append(flowNode('flow-line',`最近一级绑定 blob ${String(record.via.source_binding?.blob||'').slice(0,12)}（读取时重新哈希校验）；目标绑定的仍是本次 analysis 的 snapshot。`));
  }
  if(record.value!==null&&record.value!==undefined){
    const decoded=decodeEncoded(record.value);
    body.append(flowNode('flow-line',`返回值 ${typeof decoded==='string'?decoded:JSON.stringify(decoded)}`));
  }
  if(record.thrown){
    body.append(flowNode('flow-unknown',`抛出 ${record.thrown.name}: ${record.thrown.message}${record.thrown.code?`（${record.thrown.code}）`:''}`));
    const events=record.trace?.events||[];const last=events[events.length-1];
    if(last&&last.source_location)body.append(flowNode('flow-line',`观测位置 ${last.source_location.path}:${last.source_location.line}:${last.source_location.column} — ${last.source_location.line_text}`));
  }
  const lines=record.console?.harness_lines||[];
  if(lines.length)body.append(flowNode('flow-line',`console（受预算限制）${lines.slice(0,4).join(' | ')}`));
  if(record.console?.stdout)body.append(flowNode('flow-line',`stdout ${String(record.console.stdout).slice(0,200)}`));
  body.append(flowNode('exec-note',`观测边界：coverage=${record.trace?.coverage} · unknown_paths=${record.trace?.unknown_paths}。只有入口调用的返回/抛出被观测，没有行级覆盖采样；未观测路径保持未知，静态 BFS 不作为执行顺序。`));
  const journal=record.effect_journal;
  if(journal){
    const granted=journal.granted||{};
    body.append(flowNode('flow-line',`授予边界：fs_write=${granted.fs_write} · child_process=${granted.child_process} · network=${granted.network}`));
    if(journal.denied_count){
      for(const entry of journal.entries.slice(0,6))body.append(flowNode('flow-unknown',`被拒绝的尝试 · ${entry.permission} → ${entry.resource}`));
    }else{
      body.append(flowNode('flow-line','没有运行时报告的拒绝尝试。这不等于没有副作用：被允许的操作没有逐条日志，授予集合就是边界。'));
    }
  }
  if(record.isolation?.permission_model)body.append(flowNode('flow-line',`隔离：${record.isolation.permission_model}；授予 ${(record.isolation.effective_flags||[]).filter(f=>!f.startsWith('--allow-fs-read')).join(' ')||'（仅只读副本）'}`));
  if(record.source_binding)body.append(flowNode('flow-line',`绑定来源 analysis ${String(record.source_binding.analysis_id).slice(0,12)} · snapshot ${String(record.source_binding.snapshot_id).slice(0,12)} · blob ${String(record.source_binding.blob).slice(0,12)}（读取时重新哈希校验）`));
}
async function loadAncestorChain(profile){
  const chain=[];let symbol=profile.enclosing_symbol||null;let guard=0;
  while(symbol&&guard<8){
    chain.push({symbol,args:[]});
    guard++;
    let enclosingProfile=null;
    try{enclosingProfile=await api('profile',{entity:symbol});}catch{return {chain,complete:false,reason:'enclosing_profile_unavailable'};}
    if(enclosingProfile.symbol!==symbol)return {chain,complete:false,reason:'profile_symbol_mismatch'};
    symbol=enclosingProfile.enclosing_symbol||null;
  }
  return {chain,complete:!symbol,bounded:guard>=8};
}
async function runControlled(){
  const selected=state.selected;if(!selected||selected.kind!=='function'){status('先选择一个函数');return;}
  const profile=state.execProfile;
  if(!profile){status('该函数没有执行画像，页面不会直接执行');return;}
  if($('exec-run').disabled){status('静态画像拒绝执行或参数个数未知；页面不猜测输入');return;}
  const err=$('exec-input-error');
  if(err){err.hidden=true;err.textContent='';}
  let parsed;
  try{parsed=execFormValue(profile);}
  catch(e){execInputError(`输入格式不正确：${e.message}`);return;}
  const args=parsed.args;
  const allow_effects=profile.required_grants.filter(name=>name==='unknown_calls');
  const enclosing=profile.enclosing_symbol||null;
  const viaWanted=Boolean(enclosing&&$('exec-via-enable')?.checked);
  let via=null;
  let via_chain=null;
  if(viaWanted){
    let viaArgs;
    try{viaArgs=JSON.parse($('exec-via-args').value||'[]');}catch{execInputError('包含函数的实参不是合法 JSON 数组');return;}
    if(!Array.isArray(viaArgs)){execInputError('包含函数的实参必须是 JSON 数组');return;}
    via={symbol:enclosing,args:viaArgs};
    let chainArgs;
    try{chainArgs=JSON.parse($('exec-via-chain')?.value||'[]');}catch{execInputError('祖先链不是合法 JSON 数组');return;}
    if(!Array.isArray(chainArgs)){execInputError('祖先链必须是 JSON 数组');return;}
    if(chainArgs.length){
      if(!chainArgs.every(entry=>entry&&typeof entry.symbol==='string')){execInputError('祖先链的每一项都需要 symbol');return;}
      via_chain=chainArgs.map(entry=>({symbol:entry.symbol,args:Array.isArray(entry.args)?entry.args:[]}));
    }
  }
  const request=state.request;$('exec-run').disabled=true;status(via?'先调用包含函数取得闭包实例，再在隔离副本中执行…':'在隔离副本中执行…');
  try{
    const record=await apiJson('exec',{symbol:selected.id,args,allow_effects,via,via_chain,this_arg:parsed.this_arg,globals:parsed.globals});
    if(request!==state.request)return;
    state.execResult={record,args,via,symbol:selected.id};
    renderExecResult();
    status(`受控运行结束：${record.verdict}`);
    await loadExecRecords();
  }catch(e){
    if(request!==state.request)return;
    // 预检拒绝也带着 record：没有进程被启动，输入保留原样可修正。
    if(e.body&&e.body.refusal){
      state.execResult={record:e.body.refusal,args,via};
      renderExecResult();
    }
    status(`受控运行未开始或失败：${e.message}`);
  }finally{if(request===state.request&&state.execProfile){const wanted=Boolean(state.execProfile.enclosing_symbol&&$('exec-via-enable')?.checked);$('exec-run').disabled=!(((state.execProfile.runnable)||wanted)&&state.execProfile.arity!==null);}}
}

// --- 事件接线 ----------------------------------------------------------------
$('patch-propose').onclick=()=>proposePatch();
$('exec-run').onclick=()=>runControlled();
$('exec-mode').onclick=()=>{
  const profile=state.execProfile;if(!profile)return;
  const draft=execDraft(profile.symbol);
  try{
    if(draft.advanced){
      const raw=($('exec-args').value!==''?$('exec-args').value:draft.raw)||'[]';
      const parsed=JSON.parse(raw);
      if(!Array.isArray(parsed))throw new Error('位置实参需要 JSON 数组');
      profile.params.forEach(param=>{draft.fields[param.index]=parsed[param.index]===undefined?'':JSON.stringify(parsed[param.index]);});
    }else{
      draft.raw=JSON.stringify(execFormValue(profile).args,null,2);
      if($('exec-args'))$('exec-args').value=draft.raw;
    }
    draft.advanced=!draft.advanced;
    renderExecForm(profile);
  }catch(e){execInputError(e.message);}
};
installBridge();
$('annotation-add').onclick=()=>proposeAnnotation();
$('fn-search').oninput=()=>scheduleSearch();
$('fn-more').onclick=()=>runSearch(true);
$('connect-button').onclick=connect;
$('token').onkeydown=e=>{if(e.key==='Enter')connect();};
$('nav-back').onclick=()=>navBack();
$('run-shortcut').onclick=()=>{if(state.selected&&state.selected.kind==='function')setMode('run');};
$('source-toggle').onclick=()=>toggleSource();
$('source-close').onclick=()=>toggleSource();
function toggleSource(){
  const aside=$('inspector');
  if(!aside)return;
  const off=aside.classList.toggle('wb-source-off');
  $('source-toggle').textContent=off?'显示源码':'收起源码';
}
for(const name of LEVELS){const b=$(`level-${name}`);if(b)b.onclick=()=>setLevel(name);}
function setLevel(level){
  if(!LEVELS.includes(level)){status(`未知层级 ${level}`);return false;}
  state.level=level;
  for(const name of LEVELS){const b=$(`level-${name}`);if(b)b.setAttribute('aria-pressed',String(name===level));}
  renderGraph();
  if(state.selected&&state.selected.kind==='function')status(`层级已切到 ${LEVEL_LABELS[level]}；当前仍是焦点图，层级作用于概览（清除焦点后可见）`);
  return true;
}
for(const b of qsa('[data-lens]'))b.onclick=()=>setLens(b.dataset.lens);
for(const b of qsa('.wb-tabs [data-mode]'))b.onclick=()=>setMode(b.dataset.mode);
const graphEl=$('graph');
if(graphEl&&graphEl.addEventListener)graphEl.addEventListener('click',e=>{
  const focusOn=state.selected&&state.selected.kind==='function'&&state.mode==='understand'&&state.lens==='calls';
  if(focusOn)return;
  const box=e.target&&e.target.getBoundingClientRect?e.target.getBoundingClientRect():{left:0,top:0,width:800,height:600};
  const x=(e.clientX-box.left)*(800/Math.max(box.width,1)),y=(e.clientY-box.top)*(600/Math.max(box.height,1));
  levelPickAt(x,y);
});
if($('exec-via-enable'))$('exec-via-enable').onchange=()=>{const profile=state.execProfile;if(!profile)return;const wanted=Boolean(profile.enclosing_symbol&&$('exec-via-enable').checked);$('exec-run').disabled=!((profile.runnable||wanted)&&profile.arity!==null);};


$('reset').onclick=()=>{if(state.selected)select(state.selected,{push:false});else resetDetail();};
$('export').onclick=async()=>{try{const selected=state.selected,request=state.request;if(!selected)return;const context=await api('context',{entity:selected.id},'POST');if(request!==state.request)return;clearContext();const json=JSON.stringify(context,null,2);state.exportUrl=URL.createObjectURL(new Blob([json],{type:'application/json'}));$('context-json').value=json;$('context-download').href=state.exportUrl;$('context-download').download=`atlas-context-${context.selection_id.slice(0,12)}.json`;$('context-panel').hidden=false;$('context-panel').open=true;status('选区上下文已在本地生成，可复制或下载；未发送给 LLM');}catch(e){status(e.message);}};
$('context-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('context-json').value);status('上下文已复制；未发送给 LLM');}catch{status('浏览器未允许剪贴板写入，可在 JSON 文本框中手动复制');}};
restoreDrafts();
// A fragment never travels in an HTTP request. It carries the token and,
// optionally, the selection another projection was looking at.
{const fragment=parseFragment();
 if(fragment.selection||fragment.analysis){state.pendingSelection={entity_id:fragment.selection||'',analysis:fragment.analysis||''};}
 if(MODES.includes(fragment.mode)){state.mode=fragment.mode;
   for(const b of qsa('.wb-tabs [data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===fragment.mode));}
 if(LENSES.includes(fragment.lens))state.lens=fragment.lens;
 if(fragment.token){
   state.token=fragment.token;
   try{localStorage.setItem('atlas.session.v1',fragment.token);}catch{}
   const rest=new URLSearchParams(fragment);rest.delete('token');
   const q=rest.toString();
   history.replaceState(null,'',location.pathname+(q?`#${q}`:''));
   connect();
 } else if(typeof localStorage!=='undefined'&&localStorage.getItem('atlas.session.v1')){
   // 重开/刷新:令牌是本机会话的钥匙,存在本机 origin 里;选区与任务仍在 fragment。
   state.token=localStorage.getItem('atlas.session.v1');
   connect();
 }}
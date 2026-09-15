const $ = id => document.getElementById(id);
const state = {token:'',nodes:[],edges:[],nodePage:null,edgePage:null,selected:null,focus:null,focusIn:null,focusOut:null,request:0,exportUrl:null,execProfile:null,report:null,selection:null,pendingSelection:null,annotations:[],patches:[],execRender:0,ancestorChain:null,contract:null,level:'file',hierarchy:null,levelView:null,index:null,focusLayout:null,focusLayoutKey:null,layoutGen:0,page:'explore',lens:'calls',history:[],recent:[],projectName:'',agentGoal:'',currentRun:null,execBusy:false,search:{query:'',items:[],total:null,nextCursor:null,loading:false,error:null},sourceRes:{status:'idle',error:null},reachRes:{status:'idle',error:null,errors:[]},execDrafts:{},execRecords:[],execRecordsError:null,execResult:null,pendingPanel:null,execTab:'result',execResultMeta:null,reviewSelected:null,reviewFile:null,tasks:[],tasksError:null,tasksTimer:null,projects:[],projectsError:null,openOp:null,openState:null,settingsBusy:false};
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
async function apiJson(name, body, method='POST') {
  const r=await fetch(`/api/${name}`,{method,headers:{Authorization:`Bearer ${state.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const parsed=await r.json().catch(()=>null);
  if(!r.ok){const e=new Error(errorText(r.status,parsed));e.status=r.status;e.body=parsed;throw e;}
  return parsed;
}
function status(message){$('status').textContent=message;}
// The behavioural harness runs app.js against a minimal DOM that has
// getElementById but no querySelectorAll; tab/lens wiring degrades to nothing
// there and the tests drive setPage/setLens directly.
function qsa(selector){
  return typeof document.querySelectorAll==='function'?document.querySelectorAll(selector):[];
}
function clearContext(){if(state.exportUrl)URL.revokeObjectURL(state.exportUrl);state.exportUrl=null;const dialog=$('context-dialog');if(dialog&&dialog.open&&dialog.close)dialog.close();const area=$('context-json');if(area)area.value='';const link=$('context-download');if(link)link.removeAttribute('href');}
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
  if(state.selection){params.set('page',state.page);if(state.page==='explore')params.set('lens',state.lens);}
  return `/city3d#${params.toString()}`;
}
function refreshProjectionLink(){
  const link=$('city-open');
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
  scheduleSaveUiState();
  if(typeof history!=='undefined'){
    // 选区更新保留同一 fragment 里的视图状态(mode/lens),不整体覆盖。
    const params=new URLSearchParams(location.hash.slice(1));
    if(node){params.set('selection',node.id);params.set('analysis',state.report?.id||'');}
    else{params.delete('selection');params.delete('analysis');}
    // 镜头只在"理解代码"里有意义,其他页签不把过期的 lens 留在链接里。
    // 镜头只在探索页有意义，其他页面不把过期的 lens 留在链接里。
    if(params.get('page')&&params.get('page')!=='explore')params.delete('lens');
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
  // this/globals 是运行页签已经支持并声明过的输入。对照必须把它们一起带到两
  // 侧,否则对着一个读取 this 或全局的函数,基线侧会因缺输入被拒而补丁侧不
  // 被拒——那样的"差异"来自输入,不来自这次修改。
  let declared={};
  try{declared=draftDeclaredInputs(profile);}
  catch(e){
    if(resultBox)resultBox.replaceChildren(flowNode('flow-unknown',`对照未完成：声明的输入不是合法 JSON（${e.message}）。请先在「运行」页签填好 this/globals。`));
    return;
  }
  try{
    const compare=await apiJson('exec-compare',{entity:selected.id,args,proposal_id:proposalId,allow_effects,...declared});
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
// 对照的声明输入必须完整可见：args、this、globals 都是这一次运行真正发出的
// 内容（服务端回显），少传一个就不是"同一输入下的前后对照"。
function declaredInputsLine(compare){
  const d=compare.declared_inputs||{};
  const parts=[`args ${JSON.stringify(d.args??[])}`];
  if(d.this_arg!==undefined&&d.this_arg!==null)parts.push(`this ${JSON.stringify(d.this_arg)}`);
  const globals=d.globals&&Object.keys(d.globals).length?JSON.stringify(d.globals):null;
  if(globals)parts.push(`globals ${globals}`);
  return parts.join(' · ');
}
function renderCompareResult(box,compare){
  if(!box)return;
  box.replaceChildren();
  box.append(flowNode('flow-head',`两侧同一输入：${declaredInputsLine(compare)}`));
  box.append(compareSide('基线（当前工作台版本）',compare.base));
  box.append(compareSide('补丁（验证派生的候选版本）',compare.patched));
  box.append(flowNode('flow-line',`版本固定：基线 ${String(compare.base_analysis_id||'').slice(0,12)} · 补丁 ${String(compare.patched_analysis_id||'').slice(0,12)}。两侧都是入口调用的真实结果，没有行级采样。`));
}
// --- 修改审阅：提案列表 → 集中差异 → 验证证据 → 写入行动 ---------------------
// 三栏各答一个问题：改哪份提案？差异长什么样？证据与操作是什么？选择状态
// 保留在 state.reviewSelected，Agent 页与比较入口都落到同一份提案上。
function proposalStateLabel(proposalState){
  const label={proposed:'已登记',verified:'已验证',applied:'已应用',rejected:'校验未通过',reverted:'已撤销'}[proposalState]||proposalState;
  return `${label}（${proposalState}）`;
}
// 统一 diff → 按文件的分段。文件头（--- / +++）与 hunk 头决定归属；解析不了
// 的内容整体放进"完整 diff"，不吞掉。
function splitDiffFiles(diffText){
  const lines=String(diffText).split('\n');
  const files=[];let current=null;
  for(const line of lines){
    if(line.startsWith('--- ')||line.startsWith('+++ '))continue;
    if(line.startsWith('@@')){
      if(!current)current={name:'（未命名文件）',lines:[]};
      current.lines.push(line);
      continue;
    }
    if(!current&&line.trim())current={name:'（未命名文件）',lines:[]};
    if(current)current.lines.push(line);
  }
  if(current&&current.lines.some(l=>l.trim()))files.push(current);
  return files;
}
// 从 Agent 页（或任何入口）带着提案 id 进入审阅页：同一份提案被选中，
// 差异/证据/行动都围绕它展开。
function locateProposal(proposalId){
  state.reviewSelected=proposalId;
  setPage('review');
  renderPatches(state.patches);
  status(`已定位到提案 ${String(proposalId||'').slice(0,12)}。`);
}
function renderPatches(proposals){
  const panel=$('patch-panel'),body=$('patch-body');if(!panel||!body)return;
  if(!state.selected){panel.hidden=true;body.replaceChildren();return;}
  panel.hidden=false;
  if(!proposals.length)state.reviewSelected=null;
  // 选择合法性：记录的提案不在本次列表里就回到第一份（列表为空则清空）。
  if(state.reviewSelected&&!proposals.some(p=>p.id===state.reviewSelected))state.reviewSelected=null;
  const selected=state.reviewSelected
    ?proposals.find(p=>p.id===state.reviewSelected)
    :(proposals[0]||null);
  if(selected)state.reviewSelected=selected.id;
  // --- C2 提案列表（静态输入面板被带回来，未提交的 diff 不丢） ---------------
  const side=flowNode('review-side','');
  const count=$('review-count');
  if(count)count.textContent=proposals.length?`${proposals.length} 份`:'';
  if(!proposals.length){
    side.append(flowNode('flow-line',state.patchesError?`提案查询失败：${state.patchesError}`:'当前选区还没有提案。粘贴一份统一 diff 登记，或让外部 Agent 通过接口提交。'));
  }
  for(const proposal of proposals.slice(0,12)){
    const inner=proposal.proposal||{};
    const crossVersion=state.report&&proposal.analysis_id&&proposal.analysis_id!==state.report.id;
    const row=flowNode(`review-proposal${selected&&proposal.id===selected.id?' on':''}`,'');
    row.setAttribute('role','button');
    row.setAttribute('tabindex','0');
    row.setAttribute('aria-pressed',String(selected&&proposal.id===selected.id));
    row.append(flowNode('review-proposal-id',`${proposal.id.slice(0,12)} · ${proposalStateLabel(proposal.state)}`));
    row.append(flowNode('review-proposal-sub',`${proposal.proposed_by}${inner.summary?` · ${inner.summary}`:''}`));
    if(crossVersion)row.append(flowNode('flow-line',`提案固定在项目之前的分析上（${String(proposal.analysis_id||'').slice(0,8)}）；差异与撤销仍然可查。`));
    const validation=inner.validation||{};
    if(!validation.ok&&validation.reason)row.append(flowNode('flow-unknown',`对固定快照校验未通过：${validation.reason}`));
    const choose=()=>{state.reviewSelected=proposal.id;renderPatches(state.patches);};
    row.onclick=choose;
    row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}};
    side.append(row);
  }
  const inputPanel=$('patch-input-panel');
  if(inputPanel)side.append(inputPanel);
  // --- C3 集中差异 -----------------------------------------------------------
  const center=flowNode('review-center-inner','');
  center.id='review-center-inner';
  if(!selected){
    center.append(flowNode('flow-line','选择一份提案，或粘贴 diff 登记新的提案。差异与验证证据会显示在这里。'));
  }else{
    const inner=selected.proposal||{};
    const validation=inner.validation||{};
    center.append(flowNode('flow-head',`提案 ${selected.id.slice(0,12)} · ${proposalStateLabel(selected.state)} · ${selected.proposed_by}`));
    center.append(flowNode('flow-line','提案是 Intent：它还没有写进任何检出目录，也没有改变已发布的分析。'));
    if(validation.ok){
      const forms=validation.forms||[];
      const formText=forms.map(entry=>`${entry.form==='create'?'新建':(entry.form==='delete'?'删除':'修改')} ${entry.path}`).join(' · ');
      center.append(flowNode('flow-line',`对固定快照校验通过：${validation.hunks} 个 hunk · ${formText||(validation.patched_paths||[]).join(', ')}`));
      if(forms.some(entry=>entry.form==='create')){
        center.append(flowNode('flow-line',`这份提案会新建文件（target_exists=${inner.target_exists===false?'false':'true'}）：apply 会创建它，revert 会删除它（只在文件仍是 apply 写下的字节时）。`));
      }
      if(forms.some(entry=>entry.form==='delete')){
        center.append(flowNode('flow-line','这份提案会删除文件：apply 只在磁盘上仍是提案所依据的字节时删除，revert 会按固定快照的字节恢复。'));
      }
      if((validation.deleted_paths||[]).length)center.append(flowNode('flow-line',`删除路径：${validation.deleted_paths.join(', ')}`));
    }else{
      center.append(flowNode('flow-unknown',`对固定快照校验未通过，因此它不可验证：${validation.reason||'未知原因'}`));
    }
    const files=splitDiffFiles(inner.diff||'');
    if(files.length>1){
      const tabs=flowNode('diff-file-tabs','');
      if(state.reviewFile===null||state.reviewFile>=files.length)state.reviewFile=0;
      files.forEach((file,index)=>{
        const tab=flowNode(`diff-file-tab${index===state.reviewFile?' on':''}`,file.name);
        tab.setAttribute('role','button');
        tab.setAttribute('tabindex','0');
        tab.onclick=()=>{state.reviewFile=index;renderPatches(state.patches);};
        tab.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();state.reviewFile=index;renderPatches(state.patches);}};
        tabs.append(tab);
      });
      center.append(tabs);
      center.append(renderDiffView(files[state.reviewFile].lines.join('\n')));
    }else{
      center.append(renderDiffView(inner.diff||''));
    }
    const fullDiff=document.createElement('details');
    fullDiff.className='wb-details';
    fullDiff.append(text('summary','完整 diff（可选择复制）'));
    fullDiff.append(renderDiffView(inner.diff||''));
    center.append(fullDiff);
    const verification=selected.verification;
    if(verification){
      const graph=verification.graph_diff||{};
      const counts=graph.counts||{};
      const impact=flowNode('review-impact','');
      impact.append(flowNode('flow-head','静态影响（从补丁树派生的候选分析，不是运行结果）'));
      impact.append(flowNode('flow-line',`静态：补丁树派生为新分析 ${String(verification.patched_analysis_id||'').slice(0,12)} · 变更节点 ${graph.nodes?.changed_count??'?'} · 新增 ${graph.nodes?.added_count??'?'} · 删除 ${graph.nodes?.removed_count??'?'}`));
      if(counts.unresolved_calls)impact.append(flowNode('flow-line',`未解析调用 前 ${counts.unresolved_calls.before} → 后 ${counts.unresolved_calls.after}`));
      impact.append(renderGraphDiffObjects(graph));
      center.append(impact);
    }
    const seeGraph=text('button','在关系图中查看同一对象','wb-retry');
    seeGraph.onclick=()=>setPage('explore');
    center.append(seeGraph);
  }
  // --- C4/C5 验证证据与写入行动 ---------------------------------------------
  const evidence=flowNode('review-evidence-inner','');
  evidence.id='review-evidence-inner';
  if(selected){
    const inner=selected.proposal||{};
    const validation=inner.validation||{};
    const verification=selected.verification;
    const crossVersion=state.report&&selected.analysis_id&&selected.analysis_id!==state.report.id;
    evidence.append(flowNode('flow-head','验证证据'));
    if(crossVersion)evidence.append(flowNode('flow-line',`这份提案固定在项目之前的分析（${String(selected.analysis_id||'').slice(0,8)}）上；它的验证与对照结果属于那个版本。撤销与应用不受影响（由磁盘字节核对保护）。`));
    if(verification){
      const test=verification.test||{};
      if(test.ran){
        // 通过、失败、超时、没启动必须是四个不同的句子。把"没跑"显示成通过
        // 是这条链上最危险的呈现错误。
        const verdict=test.timed_out?'超时（按进程组杀死，不算通过）'
          :(test.error?`没有产生退出码：${test.error}`
          :(test.passed?'通过（退出码 0）':'失败（退出码非 0）'));
        evidence.append(flowNode(test.passed&&!test.timed_out?'flow-line':'flow-unknown',
          `观测：测试命令 ${JSON.stringify(test.argv)} · ${verdict}${test.exit_code===null||test.exit_code===undefined?'':` · 退出码 ${test.exit_code}`}${test.duration_ms!==undefined?` · ${test.duration_ms} ms`:''}`));
        const out=String(test.stdout||''),err=String(test.stderr||'');
        if(out.trim()||err.trim()){
          const details=document.createElement('details');details.className='wb-details';
          details.append(text('summary','查看输出（隔离副本内的真实 stdout/stderr）'));
          if(out.trim())details.append(flowNode('flow-line',`stdout：\n${out.slice(0,4000)}`));
          if(err.trim())details.append(flowNode('flow-line',`stderr：\n${err.slice(0,4000)}`));
          evidence.append(details);
        }
      }else{
        evidence.append(flowNode('flow-unknown',`观测：${test.note||'没有跑任何测试'}${test.error?`（${test.error}）`:''}这不是通过。`));
      }
      if(selected.state==='applied'&&selected.target)evidence.append(flowNode('flow-line',`已应用到 ${selected.target}。当前工作台仍读提出提案时的那份固定分析；「打开新版本」会重新索引并切换。`));
    }else if(validation.ok&&!crossVersion&&selected.state==='proposed'){
      evidence.append(flowNode('flow-line','还没有验证：没有派生补丁树，也没有跑测试。'));
      const actions=document.createElement('div');actions.className='context-actions';
      const verify=document.createElement('button');
      verify.textContent=verifyPolls[selected.id]?'验证中…':'验证（隔离副本重新派生分析）';
      verify.disabled=Boolean(verifyPolls[selected.id]);
      verify.onclick=()=>startVerify(selected.id);
      actions.append(verify);
      evidence.append(actions);
      const vcfg=state.contract&&state.contract.verification;
      if(vcfg){
        const argv=vcfg.test_argv&&vcfg.test_argv.length?JSON.stringify(vcfg.test_argv):null;
        evidence.append(flowNode(argv?'flow-line':'flow-unknown',
          argv?`验证配置：将在隔离副本内执行 ${argv}，超时 ${vcfg.test_timeout_ms} ms（本机操作者在项目设置里声明，可更新）。`
              :'验证配置：没有声明测试命令，因此验证会如实写"没有跑任何测试，这不是通过"。在项目页的「项目设置」里声明，或用 --test-argv 启动。'));
      }
      evidence.append(flowNode('flow-line','验证会从不可变快照物化隔离副本并重新派生分析；未声明测试时如实写"没有跑任何测试"。'));
    }
    // 前后对照:同一输入,基线与补丁两个分析各自真实隔离运行。只对当前分析的
    // 已验证提案提供(跨版本提案的对照属于它自己那一份分析)。
    if(!crossVersion&&(selected.state==='verified'||selected.state==='applied')){
      evidence.append(renderCompareSection(selected));
    }
    // C5 写入行动：先确认（真实目录、文件集合、状态），再写。
    const writes=state.contract&&state.contract.writes;
    const actions=document.createElement('div');actions.className='context-actions';
    if(writes&&writes.enabled){
      const apply=document.createElement('button');
      apply.textContent='检查并应用';
      apply.className='wb-primary';
      apply.disabled=selected.state!=='verified';
      apply.onclick=()=>openWriteDialog('patch/apply',selected,writes.root);
      const revert=document.createElement('button');
      revert.textContent='一键撤销';
      revert.disabled=selected.state!=='applied';
      revert.onclick=()=>openWriteDialog('patch/revert',selected,writes.root);
      actions.append(apply,revert);
      evidence.append(actions);
      evidence.append(flowNode('flow-line',`写路径由启动参数 --allow-writes 指定：${writes.root}。页面不能指定目录，只能在请求里回显它；服务端逐字比对，不一致就拒绝且不写任何文件。`));
      if(selected.state==='applied'){
        const newVersion=document.createElement('button');
        newVersion.textContent=reindexState.op?'正在重新索引…':'打开新版本（重新索引并切换）';
        newVersion.disabled=Boolean(reindexState.op);
        newVersion.onclick=()=>startReindex();
        evidence.append(newVersion);
        evidence.append(flowNode('flow-line','重新索引当前项目目录：完成后服务切换到新发布的分析，选区会按身份重定位，源码即更新后的字节。'));
      }
      if(selected.state==='reverted')evidence.append(flowNode('flow-line','这份提案已撤销：磁盘恢复为提案前的字节。'));
    }else if(state.contract&&state.contract.writes&&state.contract.writes.capable){
      evidence.append(flowNode('flow-unknown','当前项目没有写授权：应用与撤销不可用。到项目页重新打开它并勾选「以可写方式打开」，授权只落在这个目录。'));
    }else{
      evidence.append(flowNode('flow-unknown','应用与撤销只能在本机 CLI 上做：atlas patch apply / revert。这个服务启动时没有 --allow-writes，因此 HTTP 没有写路径；验证可以在页面上触发。'));
    }
  }else{
    evidence.append(flowNode('flow-line','没有选中的提案；验证与应用都从选择一份提案开始。'));
  }
  body.replaceChildren(side,center,evidence);
}
// 前后对照区（审阅页证据列）。输入框按提案保存，面板刷新不吞已改的值。
function renderCompareSection(proposal){
  const key=proposal.id.slice(0,8);
  const draft=execDraft(state.selected?.id);
  const section=flowNode('compare-section','');
  section.append(flowNode('flow-head','前后对照（同一输入,两侧真实隔离运行）'));
  const argsRow=document.createElement('div');argsRow.className='context-actions';
  const argsInput=document.createElement('textarea');
  argsInput.id=`compare-args-${key}`;argsInput.rows=1;argsInput.spellcheck=false;
  let initial='[]';
  try{
    if(state.execProfile){
      const declared=execFormValue(state.execProfile);
      if(Array.isArray(declared.args)&&declared.args.length)initial=JSON.stringify(declared.args);
    }
  }catch{/* 运行表单还没填完就保持 []，不替用户猜 */}
  if(draft.raw&&draft.raw!=='[]')initial=draft.raw;
  const previous=document.getElementById(`compare-args-${key}`);
  const typed=previous&&previous.value!==undefined?previous.value:null;
  argsInput.value=(typed!==null&&typed!==initial)?typed:initial;
  argsInput.setAttribute('aria-label','对照运行的实参 JSON 数组');
  const runBtn=document.createElement('button');
  runBtn.textContent='以相同输入运行两侧';
  runBtn.className='wb-retry';
  runBtn.onclick=()=>runCompare(proposal.id,proposal);
  argsRow.append(text('span','实参','subtle'),argsInput,runBtn);
  section.append(argsRow);
  try{
    const declared=draftDeclaredInputs(state.execProfile);
    const parts=[`实参 ${argsInput.value}`];
    if(declared.this_arg!==undefined)parts.push(`this ${JSON.stringify(declared.this_arg)}`);
    if(declared.globals)parts.push(`globals ${JSON.stringify(declared.globals)}`);
    section.append(flowNode('flow-line',`两侧使用同一份声明输入：${parts.join(' · ')}`));
  }catch{
    section.append(flowNode('flow-unknown','「运行」页签里的 this/globals 还不是合法 JSON，对照前请先在那一页修正。'));
  }
  const result=document.createElement('div');
  result.id=`compare-result-${key}`;
  section.append(result);
  return section;
}
// 写入确认：确认层展示真实目录、文件集合、基线与验证状态；首击不写文件。
let pendingWrite=null;
function openWriteDialog(endpoint,proposal,root){
  const inner=proposal.proposal||{};
  const validation=inner.validation||{};
  const paths=(validation.patched_paths||[]).concat(validation.deleted_paths||[]);
  pendingWrite={endpoint,id:proposal.id,root};
  const title=$('write-dialog-title');
  if(title)title.textContent=endpoint==='patch/apply'?'确认应用这份提案':'确认撤销这份提案';
  const body=$('write-dialog-body');
  if(body){
    body.replaceChildren();
    body.append(flowNode('flow-line',`写入目录（启动时授权的唯一目录）：${root}`));
    body.append(flowNode('flow-line',`涉及文件：${paths.length?paths.join(', '):'（提案没有列出路径）'}`));
    body.append(flowNode('flow-line',`提案 ${proposal.id.slice(0,12)} · 状态 ${proposalStateLabel(proposal.state)} · ${inner.summary||'（没有摘要）'}`));
    const verification=proposal.verification;
    if(verification){
      const test=verification.test||{};
      body.append(flowNode(test.ran?(test.passed&&!test.timed_out?'flow-line':'flow-unknown'):'flow-unknown',
        test.ran?(test.timed_out?'测试：超时（不算通过）':(test.passed?'测试：通过':'测试：失败')):'测试：没有运行（这不是通过）'));
      body.append(flowNode('flow-line',`派生分析 ${String(verification.patched_analysis_id||'').slice(0,12)}`));
    }
    if(endpoint==='patch/apply')body.append(flowNode('flow-line','应用只在磁盘仍是提案所依据的字节时进行；有漂移会被拒绝，不会覆盖别的编辑。'));
    else body.append(flowNode('flow-line','撤销会恢复提案应用前的字节；文件漂移时会被拒绝并指出具体文件。'));
  }
  const confirm=$('write-dialog-confirm');
  if(confirm)confirm.textContent=endpoint==='patch/apply'?'确认应用':'确认撤销';
  openDialog('write-dialog');
}
// 应用后的"打开新版本"：重新索引项目目录，服务切换到新分析。
const reindexState={op:null};
async function startReindex(){
  if(reindexState.op)return;
  try{
    const started=await apiJson('project/reindex',{});
    reindexState.op=started.op_id;
    status('正在重新索引项目目录；完成后切换到新分析。');
    pollReindex();
  }catch(e){status(`重新索引未开始：${e.message}`);}
}
const REINDEX_POLL_MS=1200,REINDEX_POLL_MAX=300;
async function pollReindex(attempt=0){
  const op=reindexState.op;
  if(!op)return;
  if(attempt>REINDEX_POLL_MAX){
    reindexState.op=null;
    status('重新索引查询超时：作业仍在服务端；稍后可再打开新版本。');
    renderPatches(state.patches);
    return;
  }
  try{
    const answer=await api('project/open',{id:op});
    if(answer.state==='switched'){
      reindexState.op=null;
      status(`已切换到新分析 ${String(answer.analysis_id||'').slice(0,12)}。正在恢复任务与选区。`);
      await connect();
      setPage('explore');
      loadProjects();
      status('新版本已加载：探索、运行、审阅都指向这份新分析。');
      return;
    }
    if(answer.state==='failed'||answer.state==='cancelled'){
      reindexState.op=null;
      status(`重新索引未完成：${answer.state}${answer.error?`（${answer.error}）`:''}`);
      renderPatches(state.patches);
      return;
    }
    const note=$('run-open-note');
    setTimeout(()=>pollReindex(attempt+1),REINDEX_POLL_MS);
  }catch(e){
    reindexState.op=null;
    status(`重新索引状态查询失败：${e.message}`);
    renderPatches(state.patches);
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
  let proposals=page.proposals||[];
  // 应用过的提案固定在它被提出时的分析上；"打开新版本"之后服务已切到新分析，
  // 按实体查不到它们。补一次按应用目录的查询（服务端只认自己的 write_root），
  // 让撤销入口在版本切换后仍然可达。
  const writes=state.contract&&state.contract.writes;
  if(writes&&writes.enabled){
    try{
      const appliedPage=await api('patches',{target:'here',limit:20});
      if(request!==state.request||state.selected?.id!==node.id)return;
      const known=new Set(proposals.map(p=>p.id));
      for(const proposal of (appliedPage.proposals||[])){
        if(!known.has(proposal.id))proposals=[...proposals,proposal];
      }
    }catch{/* 没有写路径或查询失败就只显示按实体查到的那份；不伪造。 */}
  }
  state.patches=proposals;
  renderPatches(state.patches);
  renderNavState();
  if(state.page==='agent')renderAgentProposals();
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
    // 登记成功就选中新提案：差异、验证与写入行动立刻围绕它展开。
    const proposalId=result&&result.proposal&&result.proposal.id;
    if(proposalId)state.reviewSelected=proposalId;
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
  // 项目地图页只有实体引用与固定版本。带着同一个对象进入运行/审阅/Agent 页
  // 走的是这里：按身份解析 → app.js 自己的 select() → setPage()，不另开一条
  // 捷径，因此运行、对照、提案与应用/撤销仍是同一条已验收的路径。
  globalThis.atlasUi={
    currentAnalysis(){return state.report?state.report.id:'';},
    currentProject(){return state.projectName||'';},
    async openInPage(page,reference){
      if(!PAGES.includes(page))return {ok:false,error:'unknown_page'};
      if(!reference)return {ok:false,error:'reference_required'};
      if(!state.token)return {ok:false,error:'not_connected'};
      let node=null;
      try{node=await resolveEntity(reference);}catch(e){return {ok:false,error:String((e&&e.message)||e)};}
      if(!node)return {ok:false,error:'entity_not_found'};
      await select(node);
      setPage(page);
      return {ok:true,entity_id:node.id,page};
    },
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
    $('revision').textContent=`当前代码 ${report.id.slice(0,8)}`;$('revision').title=report.id;
    // 顶栏与左导航显示真实项目身份：写权限目录就是本服务打开的那个项目目录。
    const contract=state.contract||{};
    const root=contract.writes&&contract.writes.root;
    const project=contract.project||{};
    state.projectName=String(project.name||(root?String(root).split('/').filter(Boolean).pop():'')||'');
    const projectName=$('project-name');if(projectName)projectName.textContent=state.projectName||'本机项目';
    const navProject=$('nav-project-button');if(navProject)navProject.textContent=state.projectName||'本机项目';
    renderNavState();
    // 项目地图页是另一个模块（只在浏览器里存在）：它按服务端的项目键恢复
    // 自己的工作区，所以项目或版本在这里换了之后要让它重新对齐。
    if(typeof window!=='undefined'&&window.atlasExplore&&typeof window.atlasExplore.connect==='function'){
      try{window.atlasExplore.connect();}catch{}
    }
    $('token').value='';status('已连接 · 固定版本 · 本地只读查询');
    runSearch();
    loadProjects();
    loadTasks();
    // 重启恢复：真正停止服务再启动后，浏览器是一个新 origin，localStorage 里
    // 的东西取不到。服务端这份按分析身份保存，因此这里能接上上次的任务。
    const saved=await restoreUiState();
    state.savedUi=saved||null;
    if(saved){
      if(PAGES.includes(saved.page))state.page=saved.page;
      if(LENSES.includes(saved.lens))state.lens=saved.lens;
      try{if(Array.isArray(LEVELS)&&LEVELS.includes(saved.level))state.level=saved.level;}catch{}
      // 整表替换，不与上一个项目的草稿合并：这里的存档按项目键保存在服务端，
      // 换项目（或换版本）时只有重定位明确迁移过的草稿才跟过来。
      state.execDrafts=(saved.execDrafts&&typeof saved.execDrafts==='object')
        ?JSON.parse(JSON.stringify(saved.execDrafts))
        :{};
      renderTabs();
    }
    let restored=null;
    if(!state.pendingSelection&&saved&&saved.selection&&saved.selection.entity_id){
      state.pendingSelection={entity_id:saved.selection.entity_id,analysis:saved.selection.analysis_id||report.id};
      restored=saved.selected||null;
    }
    const pending=state.pendingSelection;
    // 重定位的具体结论（依据、字节是否变化、为什么拒绝）比"恢复了上次任务"
    // 更有信息量，因此它一旦产生就不再被后面那句覆盖。
    let restoredNote=null;
    if(pending&&pending.entity_id){
      if(pending.analysis&&pending.analysis!==report.id){
        try{
          const relocated=await api('relocate',{entity:pending.entity_id,from:pending.analysis});
          const summary=relocated.relocation||{};
          if(summary.relocated&&relocated.selection){
            const node=await resolveEntity(relocated.selection.entity_id);
            if(node){
              await select(node);
              // 明确的重定位才迁移草稿：同一对象在新版本下继承旧版本的输入。
              const oldKey=`${pending.analysis}|${pending.entity_id}`;
              const newKey=`${state.report?.id||''}|${node.id}`;
              if(state.execDrafts[oldKey]&&!state.execDrafts[newKey]){
                state.execDrafts[newKey]=state.execDrafts[oldKey];
                delete state.execDrafts[oldKey];
                persistDrafts();
                if(state.execProfile&&state.execProfile.symbol===node.id)renderExecForm(state.execProfile);
              }
              restoredNote=`已从版本 ${String(pending.analysis).slice(0,8)} 重定位到当前版本：依据 ${summary.matched_by}${summary.bytes_changed?'，源码字节已变化':'，源码字节相同'}。页签 ${state.page} 与输入草稿一并恢复。`;
            }else{
              restoredNote='重定位找到了对应对象，但它不在当前已加载的节点里，未自动选中。';
            }
          }else{
            restoredNote=`该选区固定在另一个分析版本上，重定位被拒绝（${summary.refusal||'unknown'}）：${relocated.detail?.note||''}`;
          }
        }catch(e){
          restoredNote=`该选区固定在另一个分析版本上，且重定位查询失败：${e.message}。请在这里重新选择。`;
        }
      }else{
        const node=await resolveEntity(pending.entity_id);
        if(node)await select(node);
        else restoredNote='选区指向的对象不在当前已加载的节点里，未自动选中。';
      }
    }
    if(restored){
      if(!restoredNote)restoredNote=state.selected
        ?`已恢复上次任务：${state.selected.name||state.selected.id} · 页签 ${state.page}${Object.keys(state.execDrafts).length?' · 输入草稿已回填':''}`
        :`上次选中的对象（${restored.name||restored.id||'未知'}）不在当前这一份分析里，未自动选中。`;
      status(restoredNote);
    }else if(restoredNote){
      status(restoredNote);
    }
  }catch(e){
    if(!typed){
      state.token='';
      try{localStorage.removeItem('atlas.session.v1');}catch{}
    }
    // A dead session must stop the shell from claiming it is connected. Clearing
    // the token disables 「打开并分析」, and a header still reading 已连接 next to
    // a button that does nothing is the one failure a reader cannot act on:
    // nothing on screen says the session is gone. Re-render both, then speak.
    renderNavState();
    renderPageContent(state.page);
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
      if(previous.page&&previous.page!==state.page)setPage(previous.page,{save:false});
      if(previous.lens&&previous.lens!==state.lens)setLens(previous.lens);
      await select(node,{push:false});
    }catch(e){status(`返回失败：${String((e&&e.message)||e)}`);renderRecent();}
  })();
}
// --- 页面路由与理解镜头 ------------------------------------------------------
const PAGES=['home','explore','city','run','review','agent'];
const PAGE_TITLES={home:'项目',explore:'探索代码',city:'3D 地图',run:'运行验证',review:'修改审阅',agent:'Agent 协作'};
// 旧链接里 mode 的取值对应到新页面，避免收藏的地址落到不存在的页。
const LEGACY_PAGES={structure:'city',understand:'explore'};
const LENSES=['calls','values','unknowns'];
// 页面与镜头写进 URL fragment:关闭再打开(或 3D 往返)后,用户还在同一个
// 任务里。fragment 不进 HTTP 请求,也不承载输入内容——那是草稿的事。
function updateViewFragment(){
  if(typeof history==='undefined')return;
  const params=new URLSearchParams(location.hash.slice(1));
  params.set('page',state.page);
  if(state.page==='explore')params.set('lens',state.lens);else params.delete('lens');
  const rest=location.hash.slice(1)?`#${params.toString()}`:'';
  history.replaceState(null,'',location.pathname+rest);
}
function setPage(page,opts={}){
  if(!PAGES.includes(page)){status(`未知页面 ${page}`);return false;}
  const previous=state.page;
  state.page=page;
  renderTabs();
  updateViewFragment();
  refreshProjectionLink();
  if(opts.save!==false)scheduleSaveUiState();
  if(page!==previous&&typeof renderPageContent==='function')renderPageContent(page);
  return true;
}
function setLens(lens){
  if(!LENSES.includes(lens)){status(`未知镜头 ${lens}`);return false;}
  state.lens=lens;
  renderTask();
  updateViewFragment();
  refreshProjectionLink();
  scheduleSaveUiState();
  return true;
}
function renderTabs(){
  for(const b of qsa('.nav-button[data-go]'))b.setAttribute('aria-pressed',String(b.dataset.go===state.page));
  for(const b of qsa('[data-lens]'))b.setAttribute('aria-pressed',String(b.dataset.lens===state.lens));
  const title=$('page-title');if(title)title.textContent=PAGE_TITLES[state.page]||state.page;
  renderTask();
}
// 页面切换只做一件事：让当前页可见，并让它依赖的真实状态（有无选区）
// 决定内部是内容还是空态。数据归各页自己的渲染函数，这里不造任何假内容。
function renderTask(){
  for(const section of qsa('.wb-page[data-page]'))section.hidden=section.dataset.page!==state.page;
  const show=(el,on)=>{if(el)el.hidden=!on;};
  const fnSelected=Boolean(state.selected&&state.selected.kind==='function');
  show($('exec-panel'),fnSelected);
  show($('exec-empty'),!fnSelected);
  show($('patch-panel'),Boolean(state.selected));
  show($('patch-empty'),!state.selected);
  const execEmpty=$('exec-empty-body');
  if(execEmpty&&!fnSelected&&!execEmpty._filled){
    execEmpty._filled=true;
    execEmpty.append(flowNode('flow-line','先在探索里选一个函数：搜索或点关系图定位对象，然后「准备输入并运行」。运行记录、取消与后台任务都以选中的函数为目标。'));
  }
  const patchEmpty=$('patch-empty-body');
  if(patchEmpty&&!state.selected&&!patchEmpty._filled){
    patchEmpty._filled=true;
    patchEmpty.append(flowNode('flow-line','先在探索里选一个对象：修改审阅按对象列出提案、差异与验证证据。'));
  }
  const lensCalls=state.lens==='calls';
  show($('canvas-host'),!fnSelected||lensCalls);
  show($('overview-tools'),!fnSelected||lensCalls);
  show($('flow-panel'),fnSelected&&state.lens==='values'&&Boolean(state.flow||state.flowError));
  show($('unknown-panel'),state.lens==='unknowns'&&Boolean(state.unknownHasContent));
  renderRunBanner();
  if(state.page==='run')renderRunCompare();
  const runBack=$('run-back');if(runBack)runBack.disabled=!state.selected;
  const exploreBack=$('explore-back');if(exploreBack)exploreBack.disabled=!state.history.length;
  renderContextActions();
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
  const wantFocus=selected&&state.page==='explore'&&state.lens==='calls';
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
// 一个文件的数据流可能是被"整体撤下"的：那不是查询失败，而是这一份分析里明确登记过
// 的取舍（工程预算挡下了一个机器生成的巨型函数）。诊断就在当前报告里，所以这里如实
// 转述文件、数字与区间，而不是把一个已声明的未知报成一次故障。
function withheldFlowFor(node){
  return ((state.report&&state.report.diagnostics)||[])
    .find(d=>d.code==='flow_withheld_over_budget'&&d.path===(node&&node.path))||null;
}
function withheldFlowText(diagnostic){
  return `这个文件没有发布数据流：${diagnostic.detail}。它的符号、调用与源码照常列出，只是没有做数据流求值。`;
}
function flowLoadMessage(error,node){
  const withheld=withheldFlowFor(node);
  if(withheld)return withheldFlowText(withheld);
  return `值事实加载失败：${error.message}`;
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
    const body=$('flow-body');if(body)body.replaceChildren(flowNode('flow-unknown',flowLoadMessage(e,node)));
  }
}
async function loadProfile(node,request){
  try{
    const profile=await api('profile',{entity:node.id});
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.execProfile=profile;
    renderExecution(profile,null);
    // 提案面板的对照区要沿用画像里的参数与草稿，而它可能在画像到达之前就
    // 已经渲染过一次（提案列表比画像先到）。画像到达后补一次，否则对照的
    // 默认输入会停留在"还没有参数"的空数组上。
    if(state.patches.length)renderPatches(state.patches);
  }catch(e){
    if(request!==state.request||state.selected?.id!==node.id)return;
    state.execProfile=null;
    renderExecution(null,null);
    // 局部失败只说这一块：运行按钮保持禁用，已经填好的输入不动，重试只重试画像。
    const body=$('exec-body');
    if(body){
      body.replaceChildren();
      body.append(flowNode('flow-unknown',`执行画像加载失败：${resourceError(e)}。运行按钮保持禁用；已保存的输入不会被清空。`));
      const retry=text('button','重试画像','wb-retry');
      retry.onclick=()=>loadProfile(node,state.request);
      body.append(retry);
    }
  }
}
async function select(node,opts={}){
  const request=++state.request;
  const push=opts.push!==false;
  if(push&&state.selected&&state.selected.id!==node.id){
    state.history.push({id:state.selected.id,page:state.page,lens:state.lens});
    if(state.history.length>50)state.history.shift();
  }
  state.selected=node;state.focus=null;state.focusIn=null;state.focusOut=null;state.execProfile=null;state.flow=null;state.flowError=null;
  // 旧对象的结果卡不跟到新对象名下：结果以它自己的运行记录为准。
  state.execResult=null;state.execResultMeta=null;
  renderExecResult();
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
  // 被整体撤下数据的文件不是"事实加载失败"：原因就写在这一份分析的诊断里。
  const withheldFlow=withheldFlowFor(state.selected);
  if(!flowReasons.length&&!diag.length){
    if(state.selected&&state.selected.kind==='function'&&!state.flowError)
      body.append(flowNode('flow-line','这一份分析没有报告当前函数或项目级的显式未知区域。','matrix-note'));
    else if(withheldFlow)body.append(flowNode('flow-unknown',withheldFlowText(withheldFlow)));
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
  if(withheldFlow)body.append(flowNode('flow-unknown',withheldFlowText(withheldFlow)));
  else if(state.flowError)body.append(flowNode('flow-unknown',`flow 事实加载失败，函数级未知不完整：${state.flowError}`));
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
  if(profile.required_grants.length)body.append(flowNode('flow-line',`需要显式授权：${profile.required_grants.join(', ')}`));
  const context=profile.required_context||[];
  if(context.length)body.append(flowNode('flow-unknown',`需要调用者声明的输入：${context.join(', ')}${(profile.required_globals||[]).length?`（全局：${profile.required_globals.join(', ')}）`:''}。Atlas 不发明这些值；请在下方按字段填写（CLI 对应 --this / --global）。`));
  if((profile.unsatisfiable_context||[]).length)body.append(flowNode('flow-unknown',`Atlas 无法用数据声明：${profile.unsatisfiable_context.join(', ')}，因此该函数不可直接运行。`));
  // 分类依据与画像备注属于技术细节：收进 details，输入和运行按钮保持醒目。
  if(profile.reasons.length||profile.notes.length){
    const evidenceBox=document.createElement('details');
    evidenceBox.className='wb-details exec-evidence';
    evidenceBox.append(text('summary',`画像依据（${profile.reasons.length} 条理由 · ${profile.notes.length} 条备注）`));
    for(const reason of profile.reasons.slice(0,8))evidenceBox.append(flowNode('flow-unknown',`理由 · ${reason.code} — ${reason.detail}（证据：${reason.evidence}）`));
    if(!profile.reasons.length)evidenceBox.append(flowNode('flow-line','没有降级理由：已发布事实中没有任何 unknown 分量。'));
    for(const note of profile.notes.slice(0,4))evidenceBox.append(flowNode('flow-line',note));
    body.append(evidenceBox);
  }
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
  scheduleSaveUiState();
}
function restoreDrafts(){
  try{
    if(typeof localStorage==='undefined')return;
    const raw=localStorage.getItem('atlas.execDrafts.v1');
    if(raw){const parsed=JSON.parse(raw);if(parsed&&typeof parsed==='object')state.execDrafts=parsed;}
  }catch{/* 损坏的持久化数据当作没有 */}
}
// --- 重启恢复：同一份状态也存到服务端 ----------------------------------------
// localStorage 属于 origin（协议+主机+端口），而端口每次启动都换，所以"停止
// 服务再启动"就是一个新 origin：选区、页签、草稿全部丢失。这里把任务状态
// 同时写到服务端，键由服务端按当前分析钉定（页面只能给 name，换不了项目），
// 因此重启后能按项目和分析身份读回；两个项目里的同名函数不会串状态，因为它
// 们的 analysis id 不同。localStorage 仍然写：同一 origin 内刷新更快。
const UI_STATE_NAME='workbench';
let uiSaveTimer=null;
function collectUiState(){
  const drafts={};
  for(const [id,draft] of Object.entries(state.execDrafts||{})){
    if(!draft||typeof draft!=='object')continue;
    const used=(draft.raw&&draft.raw!=='[]')||Object.keys(draft.fields||{}).length>0
      ||String(draft.receiver||'').trim()!==''||Object.keys(draft.globals||{}).length>0;
    if(used)drafts[id]=draft;
  }
  return {
    schema:'atlas.ui-state.v1',
    page:state.page,lens:state.lens,level:state.level,
    selection:state.selection||null,
    selected:{id:state.selected?state.selected.id:null,path:state.selected?state.selected.path||'':'',name:state.selected?state.selected.name||'':''},
    execDrafts:drafts,
  };
}
function scheduleSaveUiState(){
  if(!state.token)return;
  if(uiSaveTimer)clearTimeout(uiSaveTimer);
  uiSaveTimer=setTimeout(()=>{uiSaveTimer=null;saveUiState();},600);
}
// 关页面时补一次保存：只靠 600ms 去抖，用户切完页签立刻关闭就会丢掉最后一次
// 变更（独立复审 R3 复现过）。keepalive 让请求在页面卸载后仍能发出。
function saveUiStateNow(){
  if(uiSaveTimer){clearTimeout(uiSaveTimer);uiSaveTimer=null;}
  if(!state.token)return;
  try{
    localStorage.setItem('atlas.uiState.v1',JSON.stringify(collectUiState()));
  }catch{}
  try{
    fetch('/api/ui-state',{method:'PUT',keepalive:true,headers:{Authorization:`Bearer ${state.token}`,'Content-Type':'application/json'},body:JSON.stringify({name:UI_STATE_NAME,state:collectUiState()})}).catch(()=>{});
  }catch{}
}
async function saveUiState(){
  if(!state.token)return;
  try{await apiJson('ui-state',{name:UI_STATE_NAME,state:collectUiState()},'PUT');}
  catch{/* 暂存失败不影响使用；只意味着下次重启不恢复 */}
}
// 返回服务端记住的任务状态；没有就是 null，不伪造一个"恢复成功"。
async function restoreUiState(){
  try{
    const answer=await api('ui-state',{name:UI_STATE_NAME});
    return answer&&answer.state&&typeof answer.state==='object'?answer.state:null;
  }catch{return null;}
}
// 草稿按 项目|版本|对象 归属：analysis id 唯一对应一个项目的一个版本，因此
// 同名同位置的同名函数在不同项目里不会共享输入。跨版本恢复只能经明确的
// 重定位迁移（见 connect），跨项目永不复用。
function draftKey(entityId){
  return `${state.report?.id||''}|${entityId||(state.selected&&state.selected.id)||''}`;
}
function execDraft(entityId){
  const id=draftKey(entityId);
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
// 运行草稿里已经声明的 this/globals。前后对照复用同一份声明，不重新问一遍，
// 也不静默丢掉：留空表示"没有声明"，而不是"用默认值"。
function draftDeclaredInputs(profile){
  const out={};
  if(!profile)return out;
  const draft=execDraft(profile.symbol);
  const receiver=String(draft.receiver||'').trim();
  if(receiver!=='')out.this_arg=JSON.parse(receiver);
  const globals={};
  for(const [name,valueText] of Object.entries(draft.globals||{})){
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
// 运行观测的信息层级：最上面是"这组输入得到了什么"（终态与值），其次是
// 本次输入与输出日志，全部技术依据收进「执行依据与边界」。终态只来自服务端
// 记录；拒绝不是失败，取消以服务端确认为准。
const EXEC_TABS=[['result','结果'],['inputs','本次输入'],['logs','输出日志']];
function execVerdictHero(record){
  const value=record.value!==null&&record.value!==undefined?decodeEncoded(record.value):null;
  if(record.verdict==='refused')return {cls:'run-hero refused',label:'拒绝执行',big:record.refusal?.code||'未知原因'};
  if(record.verdict==='cancelled')return {cls:'run-hero cancelled',label:'已取消',big:'服务端已确认进程结束'};
  if(record.verdict==='failed')return {cls:'run-hero failed',label:'执行失败',big:String(record.error||'runner 报告失败')};
  if(record.thrown)return {cls:'run-hero failed',label:`抛出 ${record.thrown.name}`,big:`${record.thrown.name}: ${record.thrown.message}`};
  if(record.value!==null&&record.value!==undefined){
    const shown=typeof value==='string'?value:JSON.stringify(value);
    return {cls:'run-hero returned',label:'返回值',big:shown.length>120?`${shown.slice(0,120)}…`:shown};
  }
  return {cls:'run-hero',label:'完成',big:'（无返回值）'};
}
function renderExecResult(){
  const box=$('exec-result');if(!box)return;
  box.replaceChildren();
  const result=state.execResult;
  if(!result||!result.record){
    box.append(flowNode('flow-line','还没有运行：填好左侧输入，点「运行这组输入」。结果会显示在这里，离开页面也不会丢。'));
    return;
  }
  const record=result.record;
  const hero=execVerdictHero(record);
  const heroNode=flowNode(hero.cls,'');
  heroNode.append(flowNode('run-hero-label',hero.label));
  heroNode.append(flowNode('run-hero-value',hero.big));
  // 版本标注以记录自身为准：跨版本/跨项目的记录不冒充当前工作台版本的观测。
  const recordAnalysis=String(record.analysis_id||'').slice(0,12);
  const crossVersion=record.analysis_id&&state.report&&record.analysis_id!==state.report.id;
  const meta=[`观测结果 ${record.verdict}`,`${record.duration_ms} ms`,`退出码 ${record.exit_code===null?'无':record.exit_code}`,`分析 ${recordAnalysis}`];
  if(state.execResultMeta&&state.execResultMeta.runId)meta.push(`run ${String(state.execResultMeta.runId).slice(0,8)}`);
  heroNode.append(flowNode('run-hero-meta',meta.join(' · ')));
  if(crossVersion)heroNode.append(flowNode('flow-unknown',`这条结果属于分析 ${recordAnalysis}，不是当前版本 ${String(state.report?.id||'').slice(0,12)} 的观测；只作历史记录查看。`));
  box.append(heroNode);
  // 页签：结果 / 本次输入 / 输出日志。tab 内容独立重绘，不重建 hero。
  const tabs=flowNode('run-tabs','');
  tabs.setAttribute('role','tablist');
  for(const [tab,label] of EXEC_TABS){
    const btn=flowNode('run-tab'+(state.execTab===tab?' on':''),label);
    btn.setAttribute('role','tab');
    btn.setAttribute('aria-pressed',String(state.execTab===tab));
    btn.onclick=()=>{state.execTab=tab;renderExecResult();};
    tabs.append(btn);
  }
  box.append(tabs);
  const body=flowNode('run-tab-body','');
  if(state.execTab==='inputs'){
    body.append(flowNode('flow-line',`实参 args ${JSON.stringify(result.args??[])}`));
    const declared=state.execResultMeta?state.execResultMeta.declared:{};
    if(declared&&declared.this_arg!==undefined)body.append(flowNode('flow-line',`this ${JSON.stringify(declared.this_arg)}`));
    if(declared&&declared.globals&&Object.keys(declared.globals).length)body.append(flowNode('flow-line',`globals ${JSON.stringify(declared.globals)}`));
    if(result.via)body.append(flowNode('flow-line',`经由 ${result.via.symbol} 实参 ${JSON.stringify(result.via.args||[])}${result.via_chain&&result.via_chain.length?` · 祖先链 ${result.via_chain.length} 级`:''}`));
    body.append(flowNode('flow-line','这是这一次请求真正发出的完整声明输入；左侧草稿后续的编辑不会改变它。'));
  }else if(state.execTab==='logs'){
    const stdout=String(record.console?.stdout||''),stderr=String(record.console?.stderr||'');
    const harness=record.console?.harness_lines||[];
    if(!stdout.trim()&&!stderr.trim()&&!harness.length)body.append(flowNode('flow-line','没有控制台输出。'));
    if(stdout.trim())body.append(flowNode('flow-line',`stdout：\n${stdout.slice(0,4000)}${(record.console?.truncated)?'\n（输出按预算截断）':''}`));
    if(stderr.trim())body.append(flowNode('flow-line',`stderr：\n${stderr.slice(0,4000)}`));
    if(harness.length)body.append(flowNode('flow-line',`console（受预算限制）${harness.slice(0,4).join(' | ')}`));
  }else{
    let shown=false;
    if(record.thrown){
      shown=true;
      body.append(flowNode('flow-unknown',`抛出 ${record.thrown.name}: ${record.thrown.message}${record.thrown.code?`（${record.thrown.code}）`:''}`));
      const events=record.trace?.events||[];const last=events[events.length-1];
      if(last&&last.source_location)body.append(flowNode('flow-line',`观测位置 ${last.source_location.path}:${last.source_location.line}:${last.source_location.column} — ${last.source_location.line_text}`));
    }
    if(record.verdict==='refused'){
      shown=true;
      body.append(flowNode('flow-line','没有进程被启动；这不是一次失败的执行。按拒绝原因调整输入或授权后可重试。'));
      if(record.refusal?.evidence)body.append(flowNode('flow-line',`依据：${record.refusal.evidence}`));
    }
    if(result.via&&record.via){
      shown=true;
      const stage=record.via.stage_report||{};
      const stages=stage.stages||[stage];
      body.append(flowNode('flow-line',`经由包含函数：${stages.length} 级；每级的返回与源码同一性核对在「执行依据与边界」里。`));
    }
    if(record.isolation&&record.isolation.mocks){
      shown=true;
      body.append(flowNode('flow-unknown',`本次运行声明使用了 mock/fixture：${record.isolation.fixture_note||'未注明'}；结果不得当作真实环境观测。`));
    }
    if(!shown)body.append(flowNode('flow-line','这次运行正常返回：终态与返回值就是上面的绿色结果卡；来源快照与观测方式见「执行依据与边界」。'));
  }
  box.append(body);
  // 全部技术依据收进一个 details：展开才占版面，但永远是 exec-result 的一部分。
  const evidence=document.createElement('details');
  evidence.className='wb-details exec-evidence';
  evidence.append(text('summary','执行依据与边界（隔离、授予、绑定、观测方式）'));
  renderExecRecord(evidence,record);
  box.append(evidence);
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
  const request=state.request;
  // 后台执行：请求立刻拿到 run id，进程在服务端继续。离开这一页不会停它，
  // 取消要等服务端确认进程结束——断开 HTTP 不再被当成"进程已停止"。
  setRunBusy(true);
  status(via?'先调用包含函数取得闭包实例，再在隔离副本中执行…':'在隔离副本中执行…');
  let started;
  try{
    started=await apiJson('exec',{symbol:selected.id,args,allow_effects,via,via_chain,this_arg:parsed.this_arg,globals:parsed.globals,background:true});
  }catch(e){
    setRunBusy(false);
    // 预检拒绝也带着 record：没有进程被启动，输入保留原样可修正。
    if(e.body&&e.body.refusal){
      state.execResultMeta={runId:null,declared:{this_arg:parsed.this_arg,globals:parsed.globals}};
      state.execResult={record:e.body.refusal,args,via,symbol:selected.id};
      state.execTab='result';
      renderExecResult();
    }
    status(`受控运行未开始或失败：${e.message}`);
    return;
  }
  state.currentRun={id:started.run_id,args,via,symbol:selected.id,analysis:state.report?.id||''};
  state.execResultMeta={runId:started.run_id,declared:{this_arg:parsed.this_arg,globals:parsed.globals}};
  renderRunBanner();
  loadTasks();
  status(`已在服务端开始执行（run ${String(started.run_id).slice(0,8)}）；离开页面不会停止它。`);
  return pollRun(started.run_id,request);
}
// 轮询服务端记录的终态。只有 runner 发布的终态才算数：running 期间不伪造进度。
const RUN_POLL_MS=700;
async function pollRun(runId,request){
  for(let attempt=0;;attempt++){
    // 第一次立刻问一次：短执行不必先等一个轮询间隔才被看见。
    if(attempt>0)await new Promise(r=>setTimeout(r,RUN_POLL_MS));
    let answer;
    try{answer=await api('exec/run',{id:runId});}
    catch(e){
      if(e.status===404){
        if(state.currentRun&&state.currentRun.id===runId)state.currentRun=null;
        setRunBusy(false);renderRunBanner();
        status('这次执行已不在服务端（服务可能重启过）；请按已发布的运行记录核对结果。');
        return;
      }
      continue;
    }
    if(answer.state==='running')continue;
    const run=state.currentRun&&state.currentRun.id===runId?state.currentRun:null;
    if(state.currentRun&&state.currentRun.id===runId)state.currentRun=null;
    setRunBusy(false);renderRunBanner();loadTasks();
    // 迟到的终态只落在它自己的对象上：读者已经切走时不覆盖新选区。
    if(request!==state.request||!state.selected||state.selected.id!==(run&&run.symbol)){status(`上一次执行结束：${answer.state}`);await loadExecRecords();return;}
    state.execResultMeta={runId,declared:state.execResultMeta&&state.execResultMeta.runId===runId?state.execResultMeta.declared:{}};
    state.execResult={record:answer.record,args:run.args,via:run.via,symbol:run.symbol};
    state.execTab='result';
    renderExecResult();
    status(answer.state==='cancelled'?'已取消：进程已结束（服务端确认）':`受控运行结束：${answer.record&&answer.record.verdict||answer.state}`);
    await loadExecRecords();
    return;
  }
}
// 运行按钮原位变成取消：busy 期间不允许重复派发，也不隐藏已经存在的记录。
function setRunBusy(busy){
  state.execBusy=Boolean(busy);
  const run=$('exec-run'),cancel=$('exec-cancel');
  if(run){run.disabled=Boolean(busy);run.textContent=busy?'运行中…':'运行这组输入';}
  if(cancel)cancel.hidden=!busy;
  if(!busy&&state.execProfile){
    const wanted=Boolean(state.execProfile.enclosing_symbol&&$('exec-via-enable')?.checked);
    if(run)run.disabled=!(((state.execProfile.runnable)||wanted)&&state.execProfile.arity!==null);
  }
  const note=$('exec-run-note');
  if(note)note.textContent=busy?'执行在服务端进行；可以离开这一页，回来仍能看到结果或取消。':'在隔离副本中以目标 Node 的权限模型执行一次固定调用';
}
// --- 后台任务：离页之后的执行仍然找得到 --------------------------------------
// 清单来自服务端句柄（exec/runs）；取消发信号并等服务端终态；「查看结果」把
// 读者带回运行页并选中同一个对象，结果按 run id 落在它自己的目标上。
const TASK_POLL_MS=2500;
async function loadTasks(){
  if(!state.token)return;
  try{
    const answer=await api('exec/runs');
    state.tasks=Array.isArray(answer.runs)?answer.runs:[];
    state.tasksError=null;
  }catch(e){
    state.tasksError=resourceError(e);
  }
  renderTasks();
}
const TASK_STATE_LABEL={running:'运行中',completed:'已完成',failed:'失败',cancelled:'已取消',cancelling:'取消中'};
function taskTargetLabel(task){
  const node=state.nodes.find(n=>n.id===task.symbol);
  if(node)return `${node.name||node.id} · ${node.path||''}`;
  return task.symbol;
}
function renderTasks(){
  const count=$('nav-task-count');
  if(count){
    const running=state.tasks.filter(t=>t.state==='running').length;
    count.hidden=running===0;
    count.textContent=running?String(running):'';
  }
  const body=$('tasks-body');if(!body)return;
  body.replaceChildren();
  if(!state.token){body.append(flowNode('flow-unknown','还没有连接本机服务。'));return;}
  if(state.tasksError){body.append(flowNode('flow-unknown',`任务清单查询失败：${state.tasksError}`));const retry=text('button','重试','wb-retry');retry.onclick=()=>loadTasks();body.append(retry);return;}
  if(!state.tasks.length){body.append(flowNode('flow-line','当前没有后台任务。运行一个函数或重新索引项目后，这里会列出它们。'));return;}
  for(const task of state.tasks.slice(0,12)){
    const row=flowNode('task-row','');
    row.append(flowNode(`task-state task-${task.state}`,TASK_STATE_LABEL[task.state]||task.state));
    row.append(flowNode('task-target',taskTargetLabel(task)));
    const foreign=task.analysis_id&&state.report&&task.analysis_id!==state.report.id;
    row.append(flowNode('flow-line',`run ${String(task.run_id||'').slice(0,8)} · ${task.state==='running'?'进行中（离页不停）':'终态：'+(task.verdict||task.state)}${foreign?` · 属于分析 ${String(task.analysis_id).slice(0,8)}（另一项目/版本）`:''}`));
    const actions=document.createElement('div');actions.className='context-actions';
    if(task.state==='running'){
      const cancel=text('button','取消','wb-retry');
      cancel.onclick=()=>cancelTaskRun(task.run_id);
      actions.append(cancel);
    }else{
      const open=text('button','查看结果','wb-retry');
      open.onclick=()=>openTaskResult(task);
      actions.append(open);
    }
    row.append(actions);
    body.append(row);
  }
}
function cancelCurrentRunNote(){
  const note=$('exec-run-note');
  if(note)note.textContent='已从后台任务发出取消；等进程被结束并发布记录后才算已取消。';
}
// 从任务面板取消一次运行：发信号并等服务端终态；这个函数与运行页上的
// 取消按钮走同一个服务端入口。
async function cancelTaskRun(runId){
  try{
    await apiJson('exec/cancel',{id:runId});
    status('已发出取消信号；等服务端确认进程结束后显示已取消。');
    if(state.currentRun&&state.currentRun.id===runId)cancelCurrentRunNote();
  }catch(e){status(`取消失败：${e.message}`);}
  loadTasks();
}
async function openTaskResult(task){
  const dialog=$('tasks-dialog');
  if(dialog&&dialog.close)dialog.close();
  // 任务固定在它自己的分析上：不是当前项目/版本的结果就不打开，不冒充当前对象。
  const served=state.report?.id||'';
  if(task.analysis_id&&served&&task.analysis_id!==served){
    status(`这条任务属于分析 ${String(task.analysis_id).slice(0,12)}，不是当前项目/版本的结果；切回它的项目后再查看。`);
    return;
  }
  try{
    const node=await resolveEntity(task.symbol);
    if(!node){status(`结果属于 ${task.symbol}，它不在当前分析里`);return;}
    if(node.id!==state.selected?.id)await select(node);
    setPage('run');
    if(node.kind==='function'&&state.selected?.id===node.id){
      const answer=await api('exec/run',{id:task.run_id});
      if(answer.record){
        state.execResultMeta={runId:task.run_id,declared:{}};
        state.execResult={record:answer.record,args:(answer.record.spec&&answer.record.spec.args)||[],via:null,symbol:node.id};
        state.execTab='result';
        renderExecResult();
        status(`已显示 run ${String(task.run_id).slice(0,8)} 的终态记录。`);
      }
    }
  }catch(e){status(`打开结果失败：${String((e&&e.message)||e)}`);}
}
function openTasksDialog(){
  openDialog('tasks-dialog');
  loadTasks();
  if(!state.tasksTimer)state.tasksTimer=setInterval(()=>{loadTasks();},TASK_POLL_MS);
}
function stopTasksTimer(){
  if(state.tasksTimer){clearInterval(state.tasksTimer);state.tasksTimer=null;}
}
// 运行页的"比较修改前后"：只在真的有已验证提案时才提供，两侧使用同一份
// 声明输入、各自保留自己的分析版本。没有提案时说清楚下一步去哪里。
function renderRunCompare(){
  const box=$('run-compare-body');if(!box)return;
  box.replaceChildren();
  if(!state.selected||state.selected.kind!=='function'){
    box.append(flowNode('flow-line','先选一个函数，再比较修改前后的行为。'));
    return;
  }
  const verified=state.patches.filter(p=>p.state==='verified'||p.state==='applied');
  if(!verified.length){
    box.append(flowNode('flow-line','这个选区还没有已验证的提案。先到修改审阅登记并验证一份提案，再回来比较行为。'));
    const go=text('button','去修改审阅','wb-retry');
    go.onclick=()=>setPage('review');
    box.append(go);
    return;
  }
  const row=document.createElement('div');row.className='row-actions';
  const select=document.createElement('select');
  select.id='run-compare-select';
  select.setAttribute('aria-label','选择要比较的已验证提案');
  for(const proposal of verified){
    const option=document.createElement('option');
    option.value=proposal.id;
    option.textContent=`${proposal.id.slice(0,12)} · ${proposal.state} · ${String(proposal.verification&&proposal.verification.patched_analysis_id||'').slice(0,8)}`;
    select.append(option);
  }
  const button=text('button','以相同输入比较','wb-primary');
  button.onclick=()=>runCompareFromRunPage(select.value);
  row.append(select,button);
  box.append(flowNode('flow-line','两侧使用同一份声明输入（args / this / globals），各自保留自己的分析版本；任一侧拒绝或异常都按它自己的终态呈现。'),row);
  const result=document.createElement('div');result.id='run-compare-result';
  box.append(result);
}
async function runCompareFromRunPage(proposalId){
  const node=state.selected;
  if(!node||node.kind!=='function'){status('先选一个函数');return;}
  let inputs;
  try{inputs=execFormValue(state.execProfile);}
  catch(e){status(`输入还不是合法的 JSON：${e.message}`);return;}
  const box=$('run-compare-result');
  if(box)box.replaceChildren(flowNode('flow-line','对照运行中（两个隔离副本各执行一次）…'));
  const allow_effects=(state.execProfile.required_grants||[]).filter(name=>name==='unknown_calls');
  try{
    const compare=await apiJson('exec-compare',{
      entity:node.id,args:inputs.args,proposal_id:proposalId,allow_effects,
      this_arg:inputs.this_arg,globals:inputs.globals,
    });
    if(box)renderCompareResult(box,compare);
    status('对照完成：两侧都是真实隔离运行。');
  }catch(e){
    if(box)box.replaceChildren(flowNode('flow-unknown',`对照未完成：${e.message}`));
  }
}
// R1 横幅：这次运行回答的是"谁、在哪个版本、什么签名"。签名来自画像的
// 真实参数名；没有画像时只有路径与名字，不猜参数。
function renderRunBanner(){
  const box=$('run-banner');if(!box)return;
  box.replaceChildren();
  if(!state.selected||state.selected.kind!=='function'){
    box.append(flowNode('flow-line','先在探索里选一个函数，再回到这里填输入。'));
    return;
  }
  const node=state.selected;
  const profile=state.execProfile;
  const params=profile&&Array.isArray(profile.params)?profile.params.map(p=>p.name||`参数${p.index}`):null;
  const signature=params?`${node.name||node.id}(${params.join(', ')})`:`${node.name||node.id}(…)`;
  box.append(flowNode('run-target',signature));
  box.append(flowNode('flow-line',`${node.path||''} · 固定分析版本 ${String(state.report?.id||'').slice(0,12)}`));
  if(state.currentRun)box.append(flowNode('flow-unknown',`一次执行仍在服务端进行（run ${String(state.currentRun.id).slice(0,8)}）。离开这一页不会停它；可在「后台任务」里管理。`));
}

// --- 事件接线 ----------------------------------------------------------------
$('patch-propose').onclick=()=>proposePatch();
$('exec-run').onclick=()=>runControlled();
$('exec-cancel').onclick=()=>cancelCurrentRun();
// 取消是请求，不是结果：发信号后仍然等 runner 发布 cancelled 记录。
async function cancelCurrentRun(){
  if(!state.currentRun)return false;
  const id=state.currentRun.id;
  status('取消中：已发出取消信号，等待服务端结束进程…');
  try{
    await apiJson('exec/cancel',{id});
    const note=$('exec-run-note');
    if(note)note.textContent='已发出取消信号；等进程被结束并发布记录后才算已取消。';
    return true;
  }catch(e){status(`取消失败：${e.message}`);return false;}
}
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
const exploreBackBtn=$('explore-back');if(exploreBackBtn)exploreBackBtn.onclick=()=>navBack();
$('run-shortcut').onclick=()=>{if(state.selected&&state.selected.kind==='function')setPage('run');};
const runBackBtn=$('run-back');if(runBackBtn)runBackBtn.onclick=()=>setPage('explore');
const sourceCloseBtn=$('source-close');if(sourceCloseBtn)sourceCloseBtn.onclick=()=>{const aside=$('inspector');if(aside)aside.hidden=!aside.hidden;};
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
for(const b of qsa('.nav-button[data-go]'))b.onclick=()=>setPage(b.dataset.go);
const graphEl=$('graph');
if(graphEl&&graphEl.addEventListener)graphEl.addEventListener('click',e=>{
  const focusOn=state.selected&&state.selected.kind==='function'&&state.page==='explore'&&state.lens==='calls';
  if(focusOn)return;
  const box=e.target&&e.target.getBoundingClientRect?e.target.getBoundingClientRect():{left:0,top:0,width:800,height:600};
  const x=(e.clientX-box.left)*(800/Math.max(box.width,1)),y=(e.clientY-box.top)*(600/Math.max(box.height,1));
  levelPickAt(x,y);
});
if($('exec-via-enable'))$('exec-via-enable').onchange=()=>{const profile=state.execProfile;if(!profile)return;const wanted=Boolean(profile.enclosing_symbol&&$('exec-via-enable').checked);$('exec-run').disabled=!((profile.runnable||wanted)&&profile.arity!==null);};


$('reset').onclick=()=>{if(state.selected)select(state.selected,{push:false});else resetDetail();};
$('export').onclick=async()=>{try{const selected=state.selected,request=state.request;if(!selected)return;const context=await api('context',{entity:selected.id},'POST');if(request!==state.request)return;clearContext();const json=JSON.stringify(context,null,2);state.exportUrl=URL.createObjectURL(new Blob([json],{type:'application/json'}));$('context-json').value=json;$('context-download').href=state.exportUrl;$('context-download').download=`atlas-context-${context.selection_id.slice(0,12)}.json`;openDialog('context-dialog');status('选区上下文已在本地生成，可复制或下载；未发送给 LLM');}catch(e){status(e.message);}};
$('context-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('context-json').value);status('上下文已复制；未发送给 LLM');}catch{status('浏览器未允许剪贴板写入，可在 JSON 文本框中手动复制');}};

// --- 顶栏、导航与对话框 ------------------------------------------------------
// 弹层用原生 dialog：Esc 关闭、焦点进入与返回由浏览器负责，长内容在内部滚动。
// 任何弹层都不发起隐藏的写操作，也不把令牌写进可复制的交接文本。
function openDialog(id){
  const dialog=$(id);
  if(!dialog||typeof dialog.showModal!=='function')return false;
  if(!dialog.open)dialog.showModal();
  return true;
}
function focusFirstField(dialog){
  const field=dialog&&dialog.querySelector?dialog.querySelector('input,textarea,button'):null;
  if(field&&field.focus)field.focus();
}
const helpOpen=$('help-open');if(helpOpen)helpOpen.onclick=()=>openDialog('help-dialog');
const navCommand=$('nav-command');if(navCommand)navCommand.onclick=()=>openCommandPalette();
const revisionBtn=$('revision');if(revisionBtn)revisionBtn.onclick=()=>openVersionDialog();
// 后台任务与项目设置都是真实入口：任务弹层列出服务端在途/终态；设置落在项目页。
const navTasksBtn=$('nav-tasks');if(navTasksBtn)navTasksBtn.onclick=()=>openTasksDialog();
const navSettingsBtn=$('nav-settings');if(navSettingsBtn)navSettingsBtn.onclick=()=>{
  setPage('home');renderPageContent('home');
  status('项目设置在项目页：声明的测试命令会真实用于之后的每一次验证。');
};
const tasksRefresh=$('tasks-refresh');if(tasksRefresh)tasksRefresh.onclick=()=>{loadTasks();return undefined;};
const tasksDialog=$('tasks-dialog');if(tasksDialog&&tasksDialog.addEventListener)tasksDialog.addEventListener('close',()=>{stopTasksTimer();});
// 写入确认：确认层关闭时才执行；取消或 Esc 不发任何写请求。
const writeDialog=$('write-dialog');if(writeDialog&&writeDialog.addEventListener)writeDialog.addEventListener('close',()=>{
  const action=writeDialog.returnValue;
  if(action!=='confirm'||!pendingWrite)return;
  const {endpoint,id,root}=pendingWrite;pendingWrite=null;
  writePatch(endpoint,id,root);
});
const runViewSource=$('run-view-source');if(runViewSource)runViewSource.onclick=()=>setPage('explore');
const homeOpenButton=$('home-open-button');if(homeOpenButton)homeOpenButton.onclick=()=>openProjectByPath();
const homeOpenPath=$('home-open-path');if(homeOpenPath)homeOpenPath.onkeydown=e=>{if(e.key==='Enter')openProjectByPath();};
const cityOpenBtn=$('city-open');if(cityOpenBtn)cityOpenBtn.onclick=()=>{window.location.href=projectionHref();};
const patchProposeBtn=$('patch-propose-open');if(patchProposeBtn)patchProposeBtn.onclick=()=>{
  setPage('review');
  const box=$('patch-input-panel');if(box)box.open=true;
  const area=$('patch-input');if(area&&area.focus)area.focus();
};
const reviewAgentBtn=$('review-agent');if(reviewAgentBtn)reviewAgentBtn.onclick=()=>setPage('agent');
const sourceAgentBtn=$('source-agent');if(sourceAgentBtn)sourceAgentBtn.onclick=()=>setPage('agent');
const sourceReviewBtn=$('source-review');if(sourceReviewBtn)sourceReviewBtn.onclick=()=>setPage('review');
const execClearBtn=$('exec-clear');if(execClearBtn)execClearBtn.onclick=()=>{
  const profile=state.execProfile;if(!profile)return;
  state.execDrafts[profile.symbol]={fields:{},raw:'[]',advanced:false,receiver:'',globals:{},viaArgs:'',viaChain:''};
  persistDrafts();renderExecForm(profile);
  status('已清空这组输入；下一次运行会在字段旁提示缺失的必填项。');
};
const agentConnection=$('agent-connection');if(agentConnection)agentConnection.onclick=()=>openDialog('agent-connection-dialog');
const agentPreview=$('agent-preview');if(agentPreview)agentPreview.onclick=()=>previewHandoff();
const agentExportBtn=$('agent-export');if(agentExportBtn)agentExportBtn.onclick=()=>exportAgentContext();
const agentOpenExplore=$('agent-open-explore');if(agentOpenExplore)agentOpenExplore.onclick=()=>setPage('explore');
if($('agent-goal'))$('agent-goal').oninput=()=>{state.agentGoal=$('agent-goal').value;scheduleSaveUiState();};
if($('command-input'))$('command-input').oninput=e=>renderCommandResults(e.target.value.trim());
const agentConnectionCopy=$('agent-connection-copy');if(agentConnectionCopy)agentConnectionCopy.onclick=()=>{
  const text=`Atlas 本机服务：${location.origin}/\n令牌：右上角「连接会话」或启动命令输出的 session_file 里的 token\n接口清单：GET /api/contract\n接入说明：docs/AGENT_ONBOARDING.md`;
  try{navigator.clipboard.writeText(text);status('连接信息已复制（令牌不写入任何日志或交接文本）');}
  catch{status('浏览器未允许剪贴板写入，请手动复制');}
};
if(agentConnection)agentConnection.onclick=()=>{
  const body=$('agent-connection-body');
  if(body){
    body.replaceChildren();
    body.append(flowNode('flow-line',`服务地址（回环）：${location.origin}/`));
    body.append(flowNode('flow-line',state.token?'令牌：已在本会话中；它只经 URL fragment 传入，不进入 HTTP 请求与日志。':'令牌：从启动命令输出的 session_file 里读取，填到右上角「连接会话」。'));
    body.append(flowNode('flow-line','接口清单：GET /api/contract（逐条列出保证与限制）。'));
  }
  openDialog('agent-connection-dialog');
};
if(document.addEventListener)document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&String(e.key).toLowerCase()==='k'){e.preventDefault();openCommandPalette();return;}
  if((e.metaKey||e.ctrlKey)&&/^[1-6]$/.test(e.key)){e.preventDefault();setPage(PAGES[Number(e.key)-1]);}
});
if(typeof window!=='undefined'&&window.addEventListener){window.addEventListener('beforeunload',()=>{saveUiStateNow();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')saveUiStateNow();});
  window.addEventListener('pagehide',()=>{saveUiStateNow();});}

// --- 页面内容：按需渲染，未接线的部分给明确状态，不放原型假数据 ----------------
function renderContextActions(){
  const has=Boolean(state.selected);
  for(const id of ['export','source-agent','source-review']){const b=$(id);if(b)b.disabled=!has;}
}
function renderPageContent(page){
  if(page==='home')renderHome();
  else if(page==='city')renderCity();
  else if(page==='agent')renderAgent();
}
function renderNavState(){
  const text=$('nav-connection-text'),dot=$('nav-connection');
  if(text)text.textContent=state.token?(state.report?`已连接 · ${String(state.report.id).slice(0,8)}`:'已连接'):'未连接';
  if(dot&&dot.setAttribute)dot.setAttribute('data-connected',state.token?'yes':'no');
  const stateText=$('connection-state');
  if(stateText)stateText.textContent=state.token?(state.report?`本机服务已连接 · 分析 ${String(state.report.id).slice(0,12)}`:'本机服务已连接'):'本机服务未连接';
  const reviewCount=$('nav-review-count');
  if(reviewCount){
    const n=state.patches.length;
    reviewCount.hidden=n===0;
    reviewCount.textContent=n?String(n):'';
  }
}
// 项目页：真实的项目入口。打开目录（索引并切换服务）、继续最近项目、声明
// 测试设置——这些操作都落在服务端编排上，不是页面里的假表单。
function renderHome(){
  const body=$('home-open-body');if(!body)return;
  body.replaceChildren();
  if(!state.token){
    body.append(flowNode('flow-unknown','还没有连接本机服务。先用启动命令打开一个项目：它会索引目录并打印带令牌的地址，把令牌填到右上角「连接会话」。之后就能在这个页面里打开、切换其他项目。'));
    // 服务重启会换令牌,而"打开那条带令牌的地址"只是换 fragment、不会重新加载页面:
    // 这一句既说明按钮为什么点不动,也说明恢复办法不只有手工粘贴。
    body.append(flowNode('flow-line','服务每次启动都会换一个新令牌。重启服务之后，重新打开它打印的那条带令牌地址：页面会就地接上新令牌（不用刷新页面），也可以把新令牌填到右上角「连接会话」。'));
    body.append(flowNode('flow-line','代码留在本机；建立索引不会运行你的项目。'));
  }else{
    const project=(state.contract&&state.contract.project)||{};
    body.append(flowNode('flow-line',state.report?`当前服务打开的是：${state.projectName||'（未命名项目）'} · 分析 ${String(state.report.id).slice(0,12)}`:'已连接，但还没有读取到分析版本'));
    if(project.key&&!project.is_analysis_id)body.append(flowNode('flow-line',`项目目录：${project.key}`));
    if(state.report){
      const actions=document.createElement('div');actions.className='row-actions';
      const goExplore=text('button','去探索代码','wb-primary');goExplore.onclick=()=>setPage('explore');
      const goRun=text('button','运行一个函数');goRun.onclick=()=>setPage('run');
      actions.append(goExplore,goRun);
      body.append(actions);
    }
  }
  renderHomeOpenForm();
  renderHomeRecent();
  renderHomeSettings();
  const facts=$('home-facts-body');
  if(facts){
    facts.replaceChildren();
    const report=state.report;
    if(!report){facts.append(flowNode('flow-line','连接后显示源文件、函数与未知边界的真实计数。'));}
    else{
      const coverage=report.coverage||{};
      for(const [label,value] of [
        ['源文件',coverage.parsed_source_files??report.file_count??'—'],
        ['函数',report.function_count??'—'],
        ['未知区域',coverage.flow_unknown_regions??'—'],
        ['调用候选边',report.edge_count??'—'],
      ]){
        const cell=document.createElement('div');cell.className='fact';
        cell.append(text('b',String(value)),text('span',label,'subtle'));
        facts.append(cell);
      }
      facts.append(flowNode('flow-line','计数来自这一份已发布分析；不是首屏的节点页。'));
    }
  }
}
// H1 打开：本机绝对路径 → 服务索引（有界、可取消）→ 完成后切换并刷新。
function renderHomeOpenForm(){
  const progress=$('home-open-progress');if(!progress)return;
  progress.replaceChildren();
  const openButton=$('home-open-button');
  if(openButton)openButton.disabled=!state.token||Boolean(state.openOp);
  // 可写授权是明确的本机操作者决定：勾选后打开的项目才能被应用/撤销写入。
  const writeOption=$('home-open-write');
  if(writeOption){
    const capable=Boolean(state.contract&&state.contract.writes&&state.contract.writes.capable);
    writeOption.disabled=!capable||!state.token||Boolean(state.openOp);
    if(!capable)writeOption.checked=false;
  }
  if(!state.openOp)return;
  const cancel=text('button','取消这次索引','wb-retry');
  cancel.onclick=async()=>{
    try{
      await apiJson('project/open/cancel',{id:state.openOp});
      status('已发出取消信号；索引在检查点停下后作业才是 cancelled。');
    }catch(e){status(`取消失败：${e.message}`);}
  };
  progress.append(flowNode('flow-line','正在索引（有界：超时与文件预算由服务端执行参数决定）。已用 '+openElapsedText()+'。'),cancel);
}
function openElapsedText(){
  return state.openStartedAt?`${Math.max(1,Math.round((Date.now()-state.openStartedAt)/1000))} 秒`:'刚开 始';
}
async function openProjectByPath(){
  if(!state.token){status('先连接本机服务');return;}
  const input=$('home-open-path');
  const path=(input&&input.value||'').trim();
  if(!path){status('先输入要打开的本机目录（绝对路径）');return;}
  const button=$('home-open-button');if(button)button.disabled=true;
  const writeChecked=Boolean($('home-open-write')&&$('home-open-write').checked);
  try{
    const started=await apiJson('project/open',{path,allow_writes:writeChecked});
    if(started.outcome==='indexing'){
      state.openOp=started.op_id;
      state.openStartedAt=Date.now();
      status(`正在索引 ${path}；完成后自动切换到新分析。`);
      renderHomeOpenForm();
      pollProjectOpen();
    }
  }catch(e){
    status(`打开失败：${e.message}`);
    if(button)button.disabled=false;
  }
}
const OPEN_POLL_MS=1200,OPEN_POLL_MAX=600;
async function pollProjectOpen(attempt=0){
  const op=state.openOp;
  if(!op)return;
  if(attempt>OPEN_POLL_MAX){
    state.openOp=null;renderHomeOpenForm();
    status('打开作业查询超时：索引仍在服务端有界进行；稍后在「最近项目」里确认。');
    return;
  }
  try{
    const answer=await api('project/open',{id:op});
    if(answer.state==='switched'){
      state.openOp=null;
      const path=$('home-open-path');if(path)path.value='';
      status(`已切换到 ${String(answer.analysis_id||'').slice(0,12)}：${state.projectName||'新项目'}。正在加载新项目的数据。`);
      await connect();
      setPage('explore');
      loadProjects();
      status('新项目已加载：探索、运行、审阅都指向这份新分析。');
      return;
    }
    if(answer.state==='failed'||answer.state==='cancelled'){
      state.openOp=null;
      status(`打开未完成：${answer.state}${answer.error?`（${answer.error}）`:''}`);
      renderHomeOpenForm();
      return;
    }
    renderHomeOpenForm();
    setTimeout(()=>pollProjectOpen(attempt+1),OPEN_POLL_MS);
  }catch(e){
    state.openOp=null;renderHomeOpenForm();
    status(`打开作业状态查询失败：${e.message}`);
  }
}
// H2 最近项目：本机 store 里的打开历史；点击按已发布分析直接切换。
async function loadProjects(){
  if(!state.token){state.projects=[];renderHomeRecent();return;}
  try{
    const answer=await api('projects');
    state.projects=Array.isArray(answer.projects)?answer.projects:[];
    state.projectsError=null;
  }catch(e){state.projectsError=resourceError(e);state.projects=[];}
  renderHomeRecent();
}
function renderHomeRecent(){
  const recent=$('home-recent-body');if(!recent)return;
  recent.replaceChildren();
  if(!state.token){recent.append(flowNode('flow-line','连接后显示本机打开过的项目。'));return;}
  if(state.projectsError){recent.append(flowNode('flow-unknown',`最近项目读取失败：${state.projectsError}`));return;}
  if(!state.projects.length){recent.append(flowNode('flow-line','本机还没有打开过其他项目。在上面输入目录打开第一个。'));}
  for(const project of state.projects.slice(0,8)){
    const row=flowNode('project-row','');
    row.append(flowNode('project-row-name',`${project.name}${project.current?' · 当前':''}${project.write?' · 可写':''}`));
    row.append(flowNode('flow-line',`${project.path||''} · 分析 ${String(project.analysis_id||'').slice(0,12)}`));
    if(!project.current){
      const open=text('button','继续这个项目','wb-retry');
      open.onclick=async()=>{
        open.disabled=true;
        try{
          await apiJson('project/open',{analysis:project.analysis_id});
          await connect();
          loadProjects();
          status(`已切换到 ${project.name}：探索、运行、审阅都指向这个项目。`);
        }catch(e){status(`切换失败：${e.message}`);open.disabled=false;}
      };
      row.append(open);
    }
    recent.append(row);
  }
  if(state.selected&&state.selected.kind==='function'){
    const row=text('button',`继续 ${state.selected.name||state.selected.id} →`,'nav-link');
    row.onclick=()=>setPage('explore');
    recent.append(row);
  }
}
// 项目设置：声明的测试命令与超时。保存即生效（服务端验证用它），并随 store
// 保留——重启服务后仍然是这份声明。页面不能替外部提案改命令。
function renderHomeSettings(){
  const body=$('home-settings-body');if(!body)return;
  body.replaceChildren();
  if(!state.token){body.append(flowNode('flow-line','连接后显示并更新测试设置。'));return;}
  const verification=(state.contract&&state.contract.verification)||{};
  const writes=(state.contract&&state.contract.writes)||{};
  const argvText=JSON.stringify(verification.test_argv&&verification.test_argv.length?verification.test_argv:[]);
  const wrap=flowNode('stack','');
  const label=flowNode('flow-line','测试命令（JSON argv 数组；空数组表示不运行测试）');
  wrap.append(label);
  const input=document.createElement('textarea');
  input.id='settings-test-argv';input.rows=2;input.spellcheck=false;input.value=argvText;
  input.setAttribute('aria-label','测试命令 argv JSON 数组');
  wrap.append(input);
  const timeoutRow=document.createElement('div');timeoutRow.className='context-actions';
  const timeoutLabel=text('span','测试超时（ms）','subtle');
  const timeoutInput=document.createElement('input');
  timeoutInput.id='settings-test-timeout';timeoutInput.type='number';timeoutInput.min='1000';timeoutInput.max='600000';
  timeoutInput.value=String(verification.test_timeout_ms??120000);
  timeoutInput.setAttribute('aria-label','测试超时毫秒');
  timeoutRow.append(timeoutLabel,timeoutInput);
  wrap.append(timeoutRow);
  const save=text('button','保存并生效','wb-primary');
  save.disabled=state.settingsBusy;
  save.onclick=async()=>{
    let argvParsed;
    try{argvParsed=JSON.parse(input.value||'[]');}catch(e){status(`测试命令不是合法 JSON：${e.message}`);return;}
    if(argvParsed&&!Array.isArray(argvParsed)){status('测试命令需要是 JSON 数组，例如 ["node","--test"]');return;}
    state.settingsBusy=true;save.disabled=true;
    try{
      const answer=await apiJson('project/settings',{test_argv:argvParsed.length?argvParsed:null,test_timeout_ms:Number(timeoutInput.value)||undefined},'PUT');
      if(state.contract&&state.contract.verification){
        state.contract.verification.test_argv=answer.test_argv;
        state.contract.verification.test_timeout_ms=answer.test_timeout_ms;
      }
      status('设置已生效：之后的验证按这份声明执行。');
      renderHomeSettings();renderPatches(state.patches);
    }catch(e){status(`设置未保存：${e.message}`);}
    state.settingsBusy=false;
    const again=$('home-settings-save');if(again)again.disabled=false;
  };
  save.id='home-settings-save';
  wrap.append(save);
  wrap.append(flowNode('flow-line',`当前生效（仅本项目）：${verification.test_argv&&verification.test_argv.length?JSON.stringify(verification.test_argv):'不运行测试'} · 超时 ${verification.test_timeout_ms??'—'} ms。切换项目时各自使用自己的声明。${writes.enabled?`写路径：${writes.root}（应用/撤销只写当前项目）。`:(writes.capable?'当前项目未以可写方式打开。':'本服务没有 --allow-writes：HTTP 不能应用或撤销补丁。')}`));
  body.append(wrap);
}
// 3D 页：真实说明当前选区与三维视图的关系，列出所选文件的函数成员，并提供
// 带同一选区的入口。3D 是真实 WebGL2 投影（/city3d），不是这里的示意。
function renderCity(){
  const body=$('city-body');if(!body)return;
  body.replaceChildren();
  body.append(flowNode('flow-line','三维视图读的是同一份分析和同一个选区：在探索里选中的函数，进入 3D 后落在它所属的文件上；从 3D 打开一个成员，回到工作台的仍是同一个对象。'));
  const link=$('city-open');
  if(link)link.disabled=!state.token;
  renderCityMembers();
}
// D2 文件成员：当前选区所在文件的真实函数成员（来自这一份分析），点击进入
// 工作台选中同一对象。搜索是服务端职责，这里不做本地过滤的假"全量"。
async function renderCityMembers(){
  const members=$('city-members');if(!members)return;
  const node=state.selected;
  const path=node?node.path:null;
  if(!path){members.replaceChildren(flowNode('flow-line','先在探索里选一个函数或文件，这里会列出它所在文件的成员。'));return;}
  members.replaceChildren(flowNode('flow-line','正在查询这个文件的成员…'));
  try{
    const answer=await api('search',{q:path,kind:'function',limit:50});
    if(state.selected?.id!==node.id)return; // 选区已切换，迟到的成员列表作废
    const hits=(answer.items||[]).filter(item=>item.path===path);
    members.replaceChildren();
    members.append(flowNode('flow-head',`${path} · ${hits.length} 个函数成员`));
    if(!hits.length){members.append(flowNode('flow-line','这一份分析没有给出这个文件的函数成员。'));return;}
    for(const member of hits){
      const row=text('button',`${member.name}（${member.kind}）`,'fn-hit');
      row.title=`进入工作台并选中 ${member.id}`;
      row.onclick=async()=>{try{const target=await resolveEntity(member.id);if(target)await select(target);}catch(e){status(`打开失败：${e.message}`);}};
      members.append(row);
    }
    if(answer.total&&answer.total>hits.length)members.append(flowNode('flow-line',`（显示前 ${hits.length} 个；这是当前分析的成员清单。）`));
  }catch(e){
    members.replaceChildren(flowNode('flow-unknown',`成员查询失败：${resourceError(e)}`));
  }
}
// Agent 页：真实交接草稿 + 真实提案与证据引用。没有内置模型，也不假派单。
function renderAgent(){
  const target=$('agent-target');if(!target)return;
  target.replaceChildren();
  if(!state.selected){
    target.append(flowNode('flow-unknown','还没有选中的函数。先在探索里选一个函数，再把它的上下文交接出去。'));
  }else{
    const node=state.selected;
    target.append(flowNode('flow-head',`${node.path||''} · ${node.name||node.id}`));
    target.append(flowNode('flow-line',`版本 ${String(state.report?.id||'').slice(0,12)} · 实体 ${node.id}`));
  }
  const goal=$('agent-goal');if(goal&&document.activeElement!==goal&&state.agentGoal!==undefined)goal.value=state.agentGoal;
  renderAgentProposals();
}
function renderAgentProposals(){
  const box=$('agent-proposals');if(!box)return;
  box.replaceChildren();
  if(!state.patches.length){box.append(flowNode('flow-line','当前选区还没有收到提案。提案以 Atlas 的记录为准，不推测外部 Agent 的过程。'));}
  else{
    for(const proposal of state.patches.slice(0,8)){
      const inner=proposal.proposal||{};
      const row=flowNode('agent-proposal','');
      row.append(flowNode('flow-head',`${proposal.id.slice(0,12)} · ${proposalStateLabel(proposal.state)} · ${proposal.proposed_by}`));
      if(inner.summary)row.append(flowNode('flow-line',inner.summary));
      const actions=document.createElement('div');actions.className='context-actions';
      const review=text('button','审阅这份提案','wb-retry');
      review.onclick=()=>locateProposal(proposal.id);
      actions.append(review);
      row.append(actions);
      // 证据引用：真实记录的身份与状态，可核对；没有的字段明说尚未产生。
      const refs=flowNode('agent-refs','');
      refs.append(flowNode('flow-line',`登记时间 ${proposal.created_at?new Date(proposal.created_at*1000).toLocaleString():'（记录未提供）'} · 来源 ${proposal.proposed_by}（会话/操作者自我声明，未认证）`));
      const verification=proposal.verification;
      if(verification){
        refs.append(flowNode('flow-line',`验证：派生分析 ${String(verification.patched_analysis_id||'').slice(0,12)}`));
        const test=verification.test||{};
        refs.append(flowNode(test.ran&&test.passed&&!test.timed_out?'flow-line':'flow-unknown',
          test.ran?`测试 ${JSON.stringify(test.argv)} · ${test.timed_out?'超时':(test.passed?'通过':'失败')}`:'测试：没有运行（这不是通过）'));
      }else{
        refs.append(flowNode('flow-line','验证：尚未产生（还没有派生分析与测试记录）。'));
      }
      if(proposal.state==='applied'&&proposal.target)refs.append(flowNode('flow-line',`应用：已写入 ${proposal.target}。`));
      row.append(refs);
      box.append(row);
    }
  }
  const activity=$('agent-activity');if(!activity)return;
  activity.replaceChildren();
  activity.append(flowNode('flow-line','记录：提案由服务端按会话写入作者；CLI 的 proposed_by 是本机操作者的自我声明，未认证。'));
  activity.append(flowNode('flow-line',`当前选区收到的提案 ${state.patches.length} 份。每份提案的状态（登记/验证/应用/撤销）以修改审阅页的同一记录为准。`));
  if(state.agentGoal&&state.agentGoal.trim())activity.append(flowNode('flow-line',`交接目标草稿：「${state.agentGoal.trim()}」（保存在本机与服务端任务状态里，尚未发送给任何 Agent）。`));
  const counts={};
  for(const proposal of state.patches)counts[proposal.state]=(counts[proposal.state]||0)+1;
  if(state.patches.length){
    activity.append(flowNode('flow-line','状态分布：'+Object.entries(counts).map(([k,v])=>`${proposalStateLabel(k)} ${v}`).join(' · ')));
  }
  const refresh=text('button','刷新提案与证据','wb-retry');
  refresh.onclick=async()=>{if(state.selected)await loadPatches(state.selected);status('已按 Atlas 记录刷新；这不是 Agent 运行进度。');};
  activity.append(refresh);
}
// 交接文本是本地生成的纯文本：说明目标、实体、版本与接口读法。
// 复制不等于发送；页面不声称 Agent 已经开始工作。
function handoffText(){
  const node=state.selected;
  const lines=[];
  lines.push('# Atlas 交接');
  lines.push('');
  lines.push(`目标：${(state.agentGoal||'').trim()||'（还没写目标）'}`);
  lines.push('');
  if(node)lines.push(`实体：${node.id}`, `位置：${node.path||''} · ${node.name||node.id}`);
  lines.push(`分析版本：${state.report?.id||'（未连接）'}`);
  lines.push('');
  lines.push('接入：读 docs/AGENT_ONBOARDING.md；接口清单用 GET /api/contract。');
  lines.push(`查询：GET /api/node?entity=<引用> · GET /api/reach?entity=<引用>&direction=in|out · GET /api/source?entity=<引用> · POST /api/context`);
  lines.push(`提案：POST /api/patch/propose → POST /api/patch/verify（轮询 GET /api/patch/verify?id=）`);
  lines.push('注意：测试没跑不等于通过；应用补丁由人决定，不要自行写入。');
  return lines.join('\n');
}
function previewHandoff(){
  const area=$('agent-text');
  if(area)area.value=handoffText();
  const note=$('agent-dialog-note');
  if(note)note.textContent='这是本地生成的文本。复制不等于发送，Atlas 不会替你联系任何 Agent。';
  openDialog('agent-dialog');
}
async function exportAgentContext(){
  const node=state.selected;
  if(!node){status('先在探索里选一个函数');return;}
  try{
    const context=await api('context',{entity:node.id},'POST');
    const json=JSON.stringify(context,null,2);
    $('context-json').value=json;
    const url=URL.createObjectURL(new Blob([json],{type:'application/json'}));
    const link=$('context-download');
    if(link){link.href=url;link.download=`atlas-context-${String(context.selection_id||'').slice(0,12)}.json`;}
    openDialog('context-dialog');
    status('上下文已导出（本地生成）；未发送给任何模型');
  }catch(e){status(`导出失败：${e.message}`);}
}
async function openCommandPalette(){
  const dialog=$('command-dialog');
  if(!dialog||typeof dialog.showModal!=='function'){setPage('explore');const f=$('fn-search');if(f&&f.focus)f.focus();return;}
  if(!dialog.open)dialog.showModal();
  const input=$('command-input');if(input&&input.focus)input.focus();
  renderCommandResults('');
}
let commandSeq=0;
async function renderCommandResults(query){
  const box=$('command-results');if(!box)return;
  const mine=++commandSeq;
  const actions=[['探索代码','explore'],['3D 地图','city'],['运行验证','run'],['修改审阅','review'],['Agent 协作','agent'],['项目','home']]
    .filter(([label])=>!query||label.includes(query));
  box.replaceChildren();
  for(const [label,page] of actions){
    const row=text('button',`前往 · ${label}`,'nav-link');
    row.onclick=()=>{const d=$('command-dialog');if(d&&d.close)d.close();setPage(page);};
    box.append(row);
  }
  if(!query){box.append(flowNode('flow-line','输入函数名或路径可搜索代码。'));return;}
  if(!state.token){box.append(flowNode('flow-unknown','还没有连接本机服务。'));return;}
  try{
    const answer=await api('search',{q:query,kind:'function',limit:20});
    if(mine!==commandSeq)return;
    const items=answer.items||[];
    if(!items.length){box.append(flowNode('flow-line','没有匹配的函数。'));return;}
    for(const node of items){
      const row=text('button',`${node.name} · ${node.path||''}`,'nav-link');
      row.onclick=async()=>{const d=$('command-dialog');if(d&&d.close)d.close();await openEntity(node.id);};
      box.append(row);
    }
    box.append(flowNode('flow-line',`匹配 ${answer.total??items.length} 个；这里显示前 ${items.length} 个。`));
  }catch(e){
    if(mine!==commandSeq)return;
    box.append(flowNode('flow-unknown',`搜索失败：${e.message}`));
  }
}
async function openEntity(reference){
  try{
    const node=await resolveEntity(reference);
    if(!node){status(`找不到 ${reference}`);return;}
    setPage('explore');
    await select(node);
  }catch(e){status(String((e&&e.message)||e));}
}
function openVersionDialog(){
  const body=$('version-dialog-body');if(!body)return;
  body.replaceChildren();
  if(!state.token){body.append(flowNode('flow-unknown','还没有连接本机服务。'));}
  else if(!state.report){body.append(flowNode('flow-line','已连接，但还没读到分析版本。'));}
  else{
    body.append(flowNode('flow-head',`当前服务提供的分析（基线）：${state.report.id}`));
    body.append(flowNode('flow-line','分析一旦发布就不可变。要换到另一个项目或新版本：项目页里「打开你的项目」（重新索引并切换）或「最近项目」（直接切换）。'));
    const candidates=state.patches.filter(p=>p.state==='verified'||p.state==='applied');
    for(const proposal of candidates.slice(0,6)){
      const derived=proposal.verification&&proposal.verification.patched_analysis_id;
      if(!derived)continue;
      body.append(flowNode('flow-line',`候选：${String(derived).slice(0,12)} ← 提案 ${proposal.id.slice(0,12)}（${proposal.state}）· 应用后用「打开新版本」切换过去`));
    }
    if(!candidates.length)body.append(flowNode('flow-line','还没有候选版本（先验证一份提案）。'));
  }
  openDialog('version-dialog');
}
restoreDrafts();
// A fragment never travels in an HTTP request. It carries the token and,
// optionally, the selection another projection was looking at.
{const fragment=parseFragment();
 if(fragment.selection||fragment.analysis){state.pendingSelection={entity_id:fragment.selection||'',analysis:fragment.analysis||''};}
 // fragment 里的页面优先；旧链接用 mode=understand/structure，按映射落到新页面。
 {const wanted=fragment.page||LEGACY_PAGES[fragment.mode]||fragment.mode;
  if(PAGES.includes(wanted))state.page=wanted;}
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
// 同一份文档里只换 fragment 不会重新加载页面（浏览器的行为），而"打开那条带令牌的
// 地址"正是这个工作台交付会话的方式：服务每次启动都换令牌，再打开一次新地址时，页面
// 会一直用着旧令牌——界面看着"已连接"，每个请求却都是 401，唯一能点的动作是灰的。
// 上面那段只在加载时读一次 fragment，所以这里补上运行中的那一次。
function adoptFragmentToken(){
  if(typeof location==='undefined')return;
  const fragment=parseFragment();
  if(!fragment.token||fragment.token===state.token)return;
  state.token=fragment.token;
  try{localStorage.setItem('atlas.session.v1',fragment.token);}catch{}
  const rest=new URLSearchParams(fragment);rest.delete('token');
  const q=rest.toString();
  if(typeof history!=='undefined')history.replaceState(null,'',location.pathname+(q?`#${q}`:''));
  connect();
}
if(typeof window!=='undefined'&&typeof window.addEventListener==='function')window.addEventListener('hashchange',adoptFragmentToken);
// 首屏先把壳立起来：当前页面可见，其余页隐藏；各页数据由自己的渲染函数负责。
renderTabs();
renderNavState();
renderPageContent(state.page);
const projectButton=$('project-name');
if(projectButton)projectButton.onclick=()=>{setPage('home');renderPageContent('home');};
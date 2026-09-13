const $ = id => document.getElementById(id);
const state = {token:'',nodes:[],edges:[],nodePage:null,edgePage:null,selected:null,focus:null,request:0,exportUrl:null,execProfile:null,report:null,selection:null,pendingSelection:null,annotations:[],patches:[],execRender:0,ancestorChain:null,contract:null,level:'file',hierarchy:null,levelView:null,index:null,focusLayout:null,focusLayoutKey:null,layoutGen:0};
const ns='http://www.w3.org/2000/svg';
function svg(tag, attrs={}, text) {const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
function text(tag,value,cls) {const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;}
async function api(name, params={}, method='GET') {
  const r=await fetch(`/api/${name}?${new URLSearchParams(params)}`,{method,headers:{Authorization:`Bearer ${state.token}`}});
  if(!r.ok)throw new Error(`查询未完成 (${r.status})`);return r.json();
}
// A controlled run carries a JSON body. It is the only call the page makes that
// can start a process, and the server does not trust this body for the process
// boundary: the Node binary, the environment and the fs/child/network
// permissions stay server-side.
async function apiJson(name, body) {
  const r=await fetch(`/api/${name}`,{method:'POST',headers:{Authorization:`Bearer ${state.token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok)throw new Error(`请求未完成 (${r.status})`);return r.json();
}
function status(message){$('status').textContent=message;}
function clearContext(){if(state.exportUrl)URL.revokeObjectURL(state.exportUrl);state.exportUrl=null;$('context-panel').hidden=true;$('context-json').value='';$('context-download').removeAttribute('href');}
// A selection is the unit the two projections share: an entity plus the
// analysis version it was chosen in. It travels in the fragment (never in an
// HTTP request, never to a server log) and is written back on every selection
// so the URL is a pinned reference rather than a screenshot of one.
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
  const link=$('open-3d');
  if(link)link.setAttribute('href',node?`/city3d#selection=${encodeURIComponent(node.id)}&analysis=${encodeURIComponent(state.report?.id||'')}`:'/city3d');
  if(typeof history!=='undefined'){
    const hash=node?`#selection=${encodeURIComponent(node.id)}&analysis=${encodeURIComponent(state.report?.id||'')}`:'';
    history.replaceState(null,'',location.pathname+hash);
  }
}
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
// --- W09: the patch review surface ------------------------------------------
// A page may register a proposal -- that is an Intent and changes nothing --
// and read what verification found. It deliberately cannot verify (which
// re-indexes) or apply (which writes a checkout): those stay on the CLI, where
// the person doing it can see which directory is about to be written.
function renderPatches(proposals){
  const panel=$('patch-panel'),body=$('patch-body');if(!panel||!body)return;
  if(!state.selected){panel.hidden=true;body.replaceChildren();return;}
  panel.hidden=false;body.replaceChildren();
  body.append(flowNode('flow-line','提案是 Intent：它还没有写进任何检出目录，也没有改变已发布的分析。'));
  if(!proposals.length){body.append(flowNode('flow-line','当前选区还没有提案。'));return;}
  for(const proposal of proposals.slice(0,8)){
    const inner=proposal.proposal||{};
    const validation=inner.validation||{};
    body.append(flowNode('flow-head',`提案 ${proposal.id.slice(0,12)} · ${proposal.state} · ${proposal.proposed_by}${inner.summary?` · ${inner.summary}`:''}`));
    if(validation.ok){
      // The form decides what apply and revert will do, so it is shown before
      // the diff rather than being left for the reader to infer from the header.
      const forms=validation.forms||[];
      const formText=forms.map(entry=>`${entry.form==='create'?'新建':(entry.form==='delete'?'删除':'修改')} ${entry.path}`).join(' · ');
      body.append(flowNode('flow-line',`对固定快照校验通过：${validation.hunks} 个 hunk · ${formText||(validation.patched_paths||[]).join(', ')}`));
      if(forms.some(entry=>entry.form==='create'))body.append(flowNode('flow-line',`这份提案会新建文件（target_exists=${inner.target_exists===false?'false':'true'}）：apply 会创建它，revert 会删除它（只在文件仍是 apply 写下的字节时）。`));
      if(forms.some(entry=>entry.form==='delete'))body.append(flowNode('flow-line','这份提案会删除文件：apply 只在磁盘上仍是提案所依据的字节时删除，revert 会按固定快照的字节恢复。'));
      if((validation.deleted_paths||[]).length)body.append(flowNode('flow-line',`删除路径：${validation.deleted_paths.join(', ')}`));
    }else{
      body.append(flowNode('flow-unknown',`对固定快照校验未通过，因此它不可验证：${validation.reason||'未知原因'}`));
    }
    body.append(flowNode('flow-binding',`diff（受预算截断）
${String(inner.diff||'').slice(0,1200)}`));
    const verification=proposal.verification;
    if(verification){
      const graph=verification.graph_diff||{};
      const counts=graph.counts||{};
      body.append(flowNode('flow-line',`静态：补丁树派生为新分析 ${String(verification.patched_analysis_id||'').slice(0,12)} · 变更节点 ${graph.nodes?.changed_count??'?'} · 新增 ${graph.nodes?.added_count??'?'} · 删除 ${graph.nodes?.removed_count??'?'}`));
      if(counts.unresolved_calls)body.append(flowNode('flow-line',`未解析调用 前 ${counts.unresolved_calls.before} → 后 ${counts.unresolved_calls.after}`));
      const test=verification.test||{};
      if(test.ran){
        body.append(flowNode(test.passed?'flow-line':'flow-unknown',`观测：测试命令 ${JSON.stringify(test.argv)} 退出码 ${test.exit_code}${test.timed_out?'（超时，不算通过）':''}`));
      }else{
        body.append(flowNode('flow-unknown','观测：没有跑任何测试。这不是通过。'));
      }
    }else if(validation.ok){
      body.append(flowNode('flow-line','还没有验证：没有派生补丁树，也没有跑测试。'));
    }
    if(proposal.state==='applied')body.append(flowNode('flow-line',`已应用到 ${proposal.target}`));
    const writes=state.contract&&state.contract.writes;
    if(writes&&writes.enabled){
      // The operator named exactly one directory at startup; the page shows it
      // and echoes it back, so a click can only write where it was told.
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
      body.append(flowNode('flow-unknown','验证与应用只能在本机 CLI 上做：atlas patch verify / apply / revert。这个服务启动时没有 --allow-writes，因此 HTTP 没有写路径。'));
    }
  }
}
// One click writes, but only through the boundary the operator opened at
// startup. The page does not choose the directory; it echoes the one the
// contract published, and the server refuses anything else.
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
  state.patches=[];
  if(!node){renderPatches([]);return;}
  try{const page=await api('patches',{entity:node.id,limit:20});state.patches=page.proposals||[];}
  catch{state.patches=[];}
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
  state.annotations=[];
  if(!node){renderAnnotations([]);return;}
  try{const page=await api('annotations',{entity:node.id,limit:50});state.annotations=page.annotations||[];}
  catch{state.annotations=[];}
  renderAnnotations(state.annotations);
}
async function proposeAnnotation(){
  const selected=state.selected;
  if(!selected){status('先选择一个对象');return;}
  const body=$('annotation-input').value.trim();
  if(!body){status('先写下要登记的意图');return;}
  try{
    // No `proposed_by`: authorship over HTTP is the service's to record, and
    // the page cannot claim to be someone else.
    const result=await apiJson('annotation',{entity:selected.id,kind:'constraint',body});
    $('annotation-input').value='';
    await loadAnnotations(selected);
    status(result.outcome==='created'?'Intent 已登记为提案（不是代码）':'这条 Intent 已经登记过');
  }catch(e){status(`Intent 未登记：${e.message}`);}
}
// The semantic surface an external agent is meant to use, instead of driving a
// private chat window or scraping pixels. Every entry is bounded: read the
// selection, read annotations, select, propose an Intent, or open the other
// projection. There is no action here that writes source or runs anything the
// static profile has not already allowed.
function installBridge(){
  if(typeof globalThis==='undefined')return;
  globalThis.atlasBridge={
    version:'atlas.agent-bridge.v1',
    bounded_actions:['getSelection','getAnnotations','getPatches','relocate','select','propose','proposePatch','openProjection','runControlled'],
    getSelection(){return state.selection?{...state.selection}:null;},
    getAnnotations(){return state.annotations;},
    getPatches(){return state.patches;},
    // Read-only: it asks the service what a pinned selection would become here,
    // and changes nothing until the caller acts on the answer.
    async relocate(fromAnalysis,entityId){if(!fromAnalysis||!entityId)return {ok:false,error:'from_and_entity_required'};const result=await api('relocate',{entity:entityId,from:fromAnalysis});return {ok:true,relocation:result.relocation,detail:result.detail,selection:result.selection};},
    // Registering a proposal is an Intent, so the bridge may do it; verifying
    // and applying are not exposed here at all.
    async proposePatch(diff){if(!state.selected)return {ok:false,error:'no_selection'};$('patch-input').value=diff||'';const result=await proposePatch();return result?{ok:true,proposal:result.proposal}:{ok:false,error:'proposal_rejected'};},
    async select(entityId){const node=state.nodes.find(n=>n.id===entityId);if(!node)return {ok:false,error:'entity_not_loaded'};await select(node);return {ok:true,entity_id:node.id};},
    async propose(kind,body){if(!state.selected)return {ok:false,error:'no_selection'};const result=await apiJson('annotation',{entity:state.selected.id,kind:kind||'constraint',body});await loadAnnotations(state.selected);return {ok:true,annotation:result.annotation,exists:false};},
    openProjection(view){const target=view==='3d'?($('open-3d')?.getAttribute('href')||'/city3d'):'/';if(typeof location!=='undefined')location.href=target;return target;},
    runControlled(){return runControlled();},
  };
}
// The inspector is one unit: name, path, source and flow must always describe
// the same selection. Clearing it in one place is what keeps a stale flow fact
// from sitting under a freshly selected name.
function resetDetail(){
  state.request++;state.selected=null;state.focus=null;state.execProfile=null;state.annotations=[];$('export').disabled=true;clearContext();
  $('selection-name').textContent='选择一个函数';$('selection-path').textContent='固定分析版本';
  $('selection-facts').textContent='选择对象以查询关联候选。';$('source').textContent='尚未选择对象';$('source-status').textContent='';
  publishSelection(null);renderAnnotations([]);renderFlow(null);renderExecution(null,null);render();
}
function metric(value,label){const box=text('div','');box.append(text('b',value),text('span',label));return box;}
async function loadNodes(){const page=await api('nodes',{limit:100,...(state.nodePage?.next_cursor?{cursor:state.nodePage.next_cursor}:{})});state.nodes.push(...page.items);state.nodePage=page;$('more').hidden=!page.next_cursor;render();}
async function loadEdges(){const page=await api('edges',{limit:100,...(state.edgePage?.next_cursor?{cursor:state.edgePage.next_cursor}:{})});state.edges.push(...page.items);state.edgePage=page;$('more-edges').hidden=!page.next_cursor;render();}
async function connect(){
  const typed=$('token').value.trim();
  // The field is cleared after a successful connect, so a second click — or an
  // Enter in the now-empty field — must NOT overwrite the live session with ''.
  // Before this guard it replaced the token silently and every later query
  // returned 401 while the tree still showed the previous analysis.
  if(typed)state.token=typed;
  if(!state.token){status('请粘贴本地会话令牌（启动命令输出的 session_file）');return;}
  status('正在读取本地分析…');
  try {
    const report=await api('report');
    resetDetail();state.nodes=[];state.edges=[];state.nodePage=null;state.edgePage=null;state.report=report;
    // The contract says whether this server has a write path at all, and into
    // which single directory. If the query fails the page assumes no writes:
    // guessing "yes" would offer a button that cannot work.
    try{state.contract=await api('contract');}catch{state.contract=null;}
    await loadNodes();await loadEdges();
    $('metrics').replaceChildren(metric(report.file_count,'文件'),metric(report.function_count,'函数'),metric(report.call_count,'调用点'));
    $('revision').textContent=`分析版本 ${report.id.slice(0,12)}`;$('revision').title=report.id;
    $('token').value='';status('已连接 · 固定版本 · 本地只读查询');
    const pending=state.pendingSelection;
    if(pending&&pending.entity_id){
      // A selection carries the version it was made in. If this server is
      // serving a different analysis, ask for a *reported* relocation: the
      // service either finds a counterpart and says what evidence carried it, or
      // refuses. What never happens is silently pointing the old name at
      // whatever now sits there.
      if(pending.analysis&&pending.analysis!==report.id){
        try{
          const relocated=await api('relocate',{entity:pending.entity_id,from:pending.analysis});
          const summary=relocated.relocation||{};
          if(summary.relocated&&relocated.selection){
            const node=state.nodes.find(n=>n.id===relocated.selection.entity_id);
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
        const node=state.nodes.find(n=>n.id===pending.entity_id);
        if(node)await select(node);
        else status('选区指向的对象不在当前已加载的节点里，未自动选中。');
      }
    }
  }catch(e){
    // A stored token that no longer authenticates is genuinely dead: drop it so
    // the next attempt asks for a fresh one instead of retrying forever.
    if(!typed)state.token='';
    status(`${e.message} · ${typed?'请检查令牌':'会话已失效，请重新粘贴令牌'}`);
  }
}
function renderTree(){
  $('node-count').textContent=`${state.nodes.length} / ${state.nodePage?.total??0}`;
  const q=$('search').value.trim().toLowerCase();const container=$('tree');container.replaceChildren();
  const dirs=state.nodes.filter(n=>n.kind==='directory');
  for(const dir of dirs){
    const files=state.nodes.filter(n=>n.kind==='file' && n.parent===dir.id);
    if(!files.length)continue;
    container.append(text('div',dir.path||'PROJECT ROOT','tree-directory'));
    for(const file of files){
      const children=state.nodes.filter(n=>n.kind==='function'&&n.path===file.path);
      if(q&&!`${file.path} ${children.map(n=>n.name).join(' ')}`.toLowerCase().includes(q))continue;
      const row=text('button',`${file.name}  · ${file.function_count}`,`tree-file${state.selected?.id===file.id?' selected':''}`);row.title=file.path;row.onclick=()=>select(file);container.append(row);
      for(const fn of children){const b=text('button',fn.name,`tree-function${state.selected?.id===fn.id?' selected':''}`);b.onclick=()=>select(fn);b.title=fn.id;container.append(b);}
    }
  }
}
// The canvas answers one question: what is this object connected to? It draws
// relationships, not a second copy of the project — the left explorer already
// owns the nested file/function list. With a function selected it becomes a
// focus graph (callers | selection | callees and unresolved targets); with
// nothing selected it aggregates call candidates between files.
function renderGraph(){
  const graph=$('graph');graph.replaceChildren();$('empty').hidden=state.nodes.length>0;
  const defs=svg('defs');
  const marker=svg('marker',{id:'arrow',viewBox:'0 0 8 8',refX:7,refY:4,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});
  marker.append(svg('path',{d:'M 1 1 L 7 4 L 1 7',fill:'none',stroke:'#79a7bb'}));
  defs.append(marker);graph.append(defs);
  const byId=new Map(state.nodes.map(n=>[n.id,n]));for(const n of state.focus?.nodes||[])byId.set(n.id,n);
  const selected=state.selected&&state.selected.kind==='function'?state.selected:null;
  const height=selected?renderFocusGraph(graph,byId,selected):renderOverviewGraph(graph,byId);
  graph.setAttribute('viewBox',`0 0 800 ${Math.max(height,430)}`);
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
// The focus graph is laid out, not gridded.
//
// What changed and why: this used to place callers in one column, the target in
// another and callees in a third, in load order, and to draw each edge from the
// middle of a box edge. That is not a layout. A call graph drawn that way has no
// layers the eye can follow and no port to tell two connections apart, so the
// picture could be wrong in ways nobody would notice.
//
// Now: the bounded focus model is built from the facts (layers by distance from
// the target, unresolved targets kept as boundary stubs), the pinned layout
// engine places the boxes, every edge leaves from its own port, and a fold
// caused by the node budget is drawn as a summary edge or a fold marker that
// says how many members it stands for. The status line reports the engine, the
// crossings, the label collisions and what was folded, so "readable" is a
// number here too.
const FOCUS_KEY_SEPARATOR='|';
function focusKey(root){
  const reach=state.focus||{edges:[]};
  return [root.id,(reach.edges||[]).length,(reach.unresolved||[]).length,state.layoutGen].join(FOCUS_KEY_SEPARATOR);
}
function focusEngine(){
  // `ELK` is the vendored, pinned engine loaded by index.html. Its absence is
  // not an error: the local layered ordering runs instead and the result says
  // so, because a fallback that looks like a layout is worse than an admitted one.
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
    graphNode(graph,{x:box.x+box.w/2,y:box.y+box.h/2,label:box.label,sub:box.sub,width:box.w,height:box.h,cls,
      onClick:node?()=>select(node):null});
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
  graphNode(graph,{x:150,y:110,label:root.name,sub:`${root.path} · 布局计算中`,cls:'selected',width:200,height:38});
}
function renderFocusGraph(graph,byId,root){
  const reach=state.focus||{edges:[],unresolved:[]};
  const key=focusKey(root);
  if(state.focusLayout&&state.focusLayoutKey===key){
    const drawn=drawFocusPlan(graph,state.focusLayout,byId);
    const plan=state.focusLayout;
    $('graph-status').textContent=`调用视图 ${plan.metrics.nodes} 块 / ${plan.metrics.edges} 边 · 未解析 ${plan.omitted.unresolved} · 引擎 ${plan.engine==='elk_pinned'?'布局引擎':'本地回退'}${plan.engineError?'（'+plan.engineError+'）':''} · 交叉 ${plan.metrics.crossings} · 标签碰撞 ${plan.metrics.labelCollisions} · 折叠 ${drawn.foldedTotal}${plan.budget.exceeded?' · 已按预算折叠':' · 未折叠'}`;
    $('graph-status').title='分层布局与端口由本地算法产生；边只表示静态候选，摘要边表示折叠，不是直接调用。';
    return Math.max(plan.bounds.height,240);
  }
  const generation=++state.layoutGen;
  state.focusLayout=null;state.focusLayoutKey=null;
  const elk=focusEngine();
  if(!elk){
    // Without the engine the local ordering is synchronous, so the page stays
    // usable and says which path it took.
    state.focusLayout=planFocusLayout(reach,state.nodes,focusPlanOptions(root,null,elk));
    state.focusLayoutKey=focusKey(root);
    return renderFocusGraph(graph,byId,root);
  }
  drawFocusPending(graph,root);
  $('graph-status').textContent='调用视图 · 正在计算布局（完成前不显示上一次选区的结果）';
  const mine=generation;
  planFocusLayoutAsync(reach,state.nodes,focusPlanOptions(root,()=>state.layoutGen,elk)).then(plan=>{
    // A layout that arrives after the selection moved on is dropped, and says so.
    if(mine!==state.layoutGen||plan.stale)return;
    state.focusLayout=plan;state.focusLayoutKey=focusKey(root);
    renderGraph();
  }).catch(error=>{
    if(mine!==state.layoutGen)return;
    status(`布局失败：${String((error&&error.message)||error)}`);
  });
  return 240;
}
// How many blocks the 2D canvas draws at the file level. The city can afford
// hundreds of columns; a workbench drawing one SVG group per block cannot, so
// the two projections carry different budgets over one hierarchy. That is a
// budget and it is reported as one -- never as a property of the level.
const LEVEL_MAX_FILES = 60;
const LEVEL_MAX_PIPES = 60;
const LEVEL_LABELS = ATLAS_LEVEL_LABELS;
const LEVELS = ATLAS_LEVELS;

/// The block line under a box. Aggregates say they are aggregates: a box
/// standing for a district must not read as a file with one source.
function levelBlockSub(block, level){
  if(level==='project')return `${block.facts.files} 文件 · 声明 ${block.facts.declaredFunctions} 函数 · 聚合，不是一个对象`;
  if(level==='district'){
    const one=block.filePaths.length===1?' · 仅一个文件，可读出源码':'';
    return `${block.facts.files} 文件 · 声明 ${block.facts.declaredFunctions} 函数 · 聚合${one}`;
  }
  return `${block.path} · ${block.facts.declaredFunctions} 函数${block.analyzed?'':' · 未分析'}`;
}

/// What the level drew, what it did not enumerate, and what the budget cut.
/// The last two are separate sentences on purpose.
function levelStatusLine(view,index,shownPipes){
  // This page holds one page of objects, not the whole analysis. Reporting the
  // loaded subset as if it were the project total would be the same class of
  // error as hiding a budget, so the loaded count travels with every number
  // derived from it.
  const loaded=state.nodes.length,total=state.nodePage?.total??state.nodes.length;
  const partial=loaded<total;
  const bits=[`层级 ${view.levelLabel}`,`块 ${view.blocks.length}`,
    `声明函数 ${view.totals.declaredFunctions}${partial?'（仅已加载子集）':''}`];
  if(partial)bits.push(`本页已加载 ${loaded}/${total} 对象，未加载的对象不在这个层级里`);
  if(view.omitted.files)bits.push(`层级未展开 ${view.omitted.files} 文件（不是丢失）`);
  if(view.budget.files)bits.push(`预算截断：文件层只画前 ${view.budget.maxFiles} 个文件（${view.totals.files} 中）`);
  if(view.pairUniverse>shownPipes)bits.push(`预算截断：管道 ${shownPipes}/${view.pairUniverse}`);
  bits.push(`索引 ${index.boxes} 盒 / ${index.cells} 格`);
  // The same scale function sizes the 3D columns. Saying it here is what makes
  // "one scale definition" checkable rather than a claim about the source.
  const scale = atlasScaleReport((state.nodes || []).filter((n) => n.kind === 'file')
    .map((n) => n.function_count || 0));
  bits.push(`柱高尺度（与 3D 同一函数）中位/最高 ${scale.ratios.medianOverMax.toFixed(3)} · 不足最高 1% 的列 ${scale.under.onePct}/${scale.under.of}` + (scale.linear.onePct ? `（线性尺度下 ${scale.linear.onePct}）` : ''));
  return bits.join(' · ');
}

/// The point under the pointer, resolved through the spatial index. Exposed so
/// the answer can be tested without a browser: it is the 2D counterpart of the
/// city's ray/box picking, and it reports a miss instead of guessing.
function levelHitAt(x,y){
  const hit=atlasIndexHit(state.index,x,y);
  if(!hit.inBounds)return {ok:false,code:'outside_the_index',scanned:hit.scanned};
  if(!hit.hit)return {ok:false,code:'no_block_at_this_point',scanned:hit.scanned};
  return {ok:true,blockId:hit.hit.id,path:hit.hit.path,fileId:hit.hit.fileId,
    aggregate:hit.hit.aggregate,scanned:hit.scanned,candidates:hit.candidates};
}

/// Pick the block at a point and select it -- or say why nothing was selected.
/// An aggregate has no single source to open, so it is named as an aggregate
/// rather than opening one file of many and pretending it stands for the block.
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
  return view.blocks.length?cursorY:430;
}
// 第一屏：这个项目最该先知道的五件事。
//
// 只用整份分析报告里的字段（全量事实），不从"本页已加载的一页"推算任何数字——
// 那就是之前会把 2080 当成项目函数总数的原因。推导类的数字留在这里说清口径。
function renderBrief(){
  const box=$('brief'),list=$('brief-list'),foot=$('brief-foot');
  if(!box||!list)return;
  const report=state.report;if(!report){box.hidden=true;return;}
  const c=report.coverage||{};
  const n=(v)=>Number(v||0).toLocaleString('en-US');
  const rows=[
    ['规模',`文件 <em>${n(c.encountered_source_files)}</em> · 函数 <em>${n(c.flow_functions)}</em> · 调用点 <em>${n(report.call_count)}</em>`],
    ['解析覆盖',`进入清单 <em>${n(c.catalog_entries)}</em> 项（其中目录 <em>${n(c['disposition:directory'])}</em>）· 已解析源文件 <em>${n(c.parsed_source_files)}</em>`],
    ['函数级完整度',`有局部事实的函数 <em>${n(c.flow_functions)}</em> · 部分完成 <em>${n(c.flow_partial)}</em> · 前沿未完成 <em>${n(c.flow_frontier_functions)}</em>`],
    ['显式未知',`<em>${n(c.flow_unknown_regions)}</em> 处未知区域——这些地方 Atlas <b>没有</b>结论，不是"看起来没问题"`],
    ['跨过程结构',`调用图强连通分量 <em>${n(c.interproc_sccs)}</em> 个，其中递归 <em>${n(c.interproc_recursive_sccs)}</em> 个（重构时要特别小心的地方）`],
  ];
  list.replaceChildren();
  for(const [title,body] of rows){
    const li=document.createElement('li');
    const b=document.createElement('b');b.textContent=title;
    const s=document.createElement('span');s.innerHTML=body;
    li.append(b,s);list.append(li);
  }
  const loaded=state.nodes.length,total=state.nodePage?.total??loaded;
  foot.textContent=loaded<total
    ? `上面是全量事实。本页只加载了 ${loaded}/${total} 个对象——画布与清单只画已加载的部分，且会自己说明这一点。`
    : `上面是全量事实；本页已加载全部 ${loaded} 个对象。`;
  box.hidden=false;
}

function render(){renderTree();renderGraph();renderBrief();}
// Byte offsets from the engine are UTF-8; the loaded source is a JS string.
function byteLineMap(source){const encoder=new TextEncoder();const lines=[1];let bytes=0;for(const ch of source){bytes+=encoder.encode(ch).length;if(ch==='\n')lines.push(bytes+1);}return lines;}
function lineOf(map,byte){let line=1;for(let i=0;i<map.length;i++){if(map[i]<=byte)line=i+1;else break;}return line;}
// `constants` is plain JSON, which has no token for undefined, NaN or Infinity:
// the value undefined and the string "undefined" both arrive as "undefined".
// Render the tagged view instead, so the panel never displays a value the
// engine did not claim. Analyses published before the tagged field existed
// remain readable through the fallback.
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
// Blocks x bindings state map. Three rules make it a fact view rather than
// decoration: a binding with no record in a block is drawn as "no record"
// (which is not a claim about the program); the three channels are
// independent, so a warning is never hidden by a value; and a value that is
// unknown never shares the mark of one that was folded to a constant.
const HEAT_MAX_BLOCKS=14,HEAT_MAX_BINDINGS=10;
function heatCellClass(binding){
  if(!binding)return 'heat-cell heat-empty';
  const value=binding.value||{};
  const hasConstant=Boolean((value.typed_constants&&value.typed_constants.length)||(value.constants&&value.constants.length));
  const hasTargets=Boolean(value.targets&&value.targets.length);
  const cls=['heat-cell'];
  // Fill = what the engine says the value is.
  if(hasConstant)cls.push('heat-const');
  else if(hasTargets)cls.push('heat-value');
  else if(value.unknown)cls.push(value.origins&&value.origins.length?'heat-origin':'heat-unknown');
  else cls.push('heat-value');
  // Additive marks. A constant that still carries an unknown component must
  // not read as a plain constant, and a MaybeInitialized binding must not read
  // as a plain one, so neither fact is allowed to erase the other.
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
  // A grid with no columns would look like "nothing is tracked" rather than
  // "this function has no binding states", so it is omitted entirely.
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
      // Machine-readable coordinates: an automated check (or an external
      // Agent reading the semantic DOM) can map a cell back to the exact
      // block and binding instead of inferring them from position.
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
function renderFlow(flow,symbol){
  const panel=$('flow-panel');const body=$('flow-body');if(!panel||!body)return;
  if(!flow){panel.hidden=true;body.replaceChildren();return;}
  if(symbol&&flow.symbol!==symbol){
    // The panel is titled with the selected object. A fact that belongs to a
    // different symbol would attach A's conclusion to B's name, so refuse it
    // rather than render something the header does not describe.
    panel.hidden=false;body.replaceChildren(flowNode('flow-unknown',`已拒绝显示：查询返回的 flow 属于 ${flow.symbol}，与选中的 ${symbol} 不一致。`));
    return;
  }
  panel.hidden=false;body.replaceChildren();
  body.append(flowNode('flow-head',`算法 ${flow.algorithm.id}@${flow.algorithm.version} · ${flow.status} · ${flow.coverage.cfg_blocks} 块 / ${flow.coverage.supported_op_transfers} 次操作求值`));
  body.append(flowNode('flow-line',`正常返回: ${flowValueSummary(flow.returns)}`));
  body.append(flowNode('flow-line',`潜在抛出: ${flowValueSummary(flow.throws)}`));
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
      body.append(flowNode('flow-binding',`${head} · 实参来源 ${cs.args.map(a=>a.origins.slice(0,2).join('/')).join(', ')||'无'}`));
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
// --- W08: execution sufficiency and controlled runs -------------------------
// The classification below is derived from published static facts. It is not an
// execution result, and the panel says so on every path: a profile that refuses
// is shown as a refusal, and a run that happened is shown with exactly what was
// observed (the entry call's outcome) and what was not (line coverage, paths,
// a run-time call graph).
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
  // Same rule as the flow panel: a profile that belongs to a different symbol
  // would attach A's verdict to B's name, so it is refused rather than shown.
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
  // A capture is not a value anybody can type in. It exists only while the
  // enclosing function runs, so the only honest way to obtain one is to call
  // that function and take the function it returns. The page offers exactly
  // that, names the exported enclosing function, and never fabricates a scope.
  const enclosing=profile.enclosing_symbol||null;
  const viaRow=$('exec-via-row');
  if(viaRow){
    viaRow.hidden=!enclosing;
    if(enclosing){
      $('exec-via-label').textContent=`包含函数 ${enclosing}`;
      body.append(flowNode('flow-line',`包含函数 ${enclosing}：闭包实例只能由它真实产生，页面不凭空构造作用域。`));
      const viaEnable=$('exec-via-enable');
      // Direct execution is impossible precisely because of the captures, so
      // the through-enclosing path is pre-selected whenever it is the only one.
      const captures=(profile.unsatisfiable_context||[]).includes('captures');
      viaEnable.checked=captures;
      if(captures)body.append(flowNode('flow-line',`捕获的绑定：${(profile.captures||[]).join(', ')||'（未命名）'}。勾选「经由包含函数」后，Atlas 会先调用 ${enclosing}，并只接受它返回、且源码与目标钉住字节一致的那个函数实例。`));
      // The enclosing function may itself be nested. The page asks the analysis
      // for each ancestor's profile in turn and pre-fills the chain, so the
      // symbols come from the graph and the user only supplies the arguments.
      // The token makes a late answer from a previous selection write nothing.
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
  if(record)renderExecRecord(body,record);
  // The run button is only enabled where the static profile allows a run and
  // the arity is known, so the page cannot promise what the engine will refuse.
  // A nested function is runnable *through its enclosing function* and nowhere
  // else, so the button follows the checkbox, not the classification alone.
  const viaWanted=Boolean(enclosing&&$('exec-via-enable')?.checked);
  const known=profile.arity!==null;
  $('exec-run').disabled=!(((runnable)||viaWanted)&&known);
  $('exec-run').title=runnable?(known?'在隔离副本中以目标 Node 的权限模型执行一次固定调用':'参数个数未知，页面不猜测实参'):(viaWanted?`经由 ${enclosing} 取得闭包实例后执行`:'静态画像拒绝执行');
}
function renderExecRecord(body,record){
  const verdict=record.verdict;
  body.append(flowNode('exec-verdict',`观测结果 ${verdict} · ${record.duration_ms} ms · 退出码 ${record.exit_code===null?'无':record.exit_code}`));
  if(verdict==='refused'){
    body.append(flowNode('flow-unknown',`拒绝执行：${record.refusal?.code} — ${record.refusal?.detail}`));
    body.append(flowNode('flow-line','没有进程被启动；这不是一次失败的执行。'));
    // A `via` refusal names which stage refused: the enclosing call has its own
    // profile and its own conclusion, and hiding it would leave the reader
    // blaming the target for a refusal that belongs to the enclosing function.
    const viaRefusal=record.via&&record.via.decision&&record.via.decision.allowed===false?record.via.decision.refusal:null;
    if(viaRefusal)body.append(flowNode('flow-unknown',`包含函数 ${record.via.name}（${record.via.symbol}）自己的结论：${viaRefusal.code} — ${viaRefusal.detail}`));
    return;
  }
  if(record.isolation&&record.isolation.mocks)body.append(flowNode('exec-note',`本次运行声明使用了 mock/fixture：${record.isolation.fixture_note||'未注明'}；结果不得当作真实环境观测。`));
  // A `via` run has two stages and both are shown, because "the enclosing
  // function returned something that is not this closure" is a real observation
  // that must not be hidden behind a single target verdict.
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
// Walk the *published* profiles upward to find the ancestors of the enclosing
// function. Each step is a query for a symbol the analysis itself named, so the
// page never invents a chain: if it cannot walk it, it says how far it got.
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
  if(!state.execProfile){status('该函数没有执行画像，页面不会直接执行');return;}
  let args;
  try{args=JSON.parse($('exec-args').value||'[]');}catch{status('实参不是合法 JSON 数组');return;}
  if(!Array.isArray(args)){status('实参必须是 JSON 数组');return;}
  // The page can only forward the acknowledgement. A receiver or a global is an
  // input the caller states, and there is no field for it here on purpose.
  const allow_effects=state.execProfile.required_grants.filter(name=>name==='unknown_calls');
  // A `via` run states the enclosing function and its arguments. The page never
  // picks the enclosing function itself: it comes from the published profile,
  // which is the analysis' own answer about where this closure is declared.
  const enclosing=state.execProfile.enclosing_symbol||null;
  const viaWanted=Boolean(enclosing&&$('exec-via-enable')?.checked);
  let via=null;
  let via_chain=null;
  if(viaWanted){
    let viaArgs;
    try{viaArgs=JSON.parse($('exec-via-args').value||'[]');}catch{status('包含函数的实参不是合法 JSON 数组');return;}
    if(!Array.isArray(viaArgs)){status('包含函数的实参必须是 JSON 数组');return;}
    via={symbol:enclosing,args:viaArgs};
    // The ancestors above the enclosing function, outermost first. Their
    // symbols were discovered from the analysis; the page only supplies args.
    let chainArgs;
    try{chainArgs=JSON.parse($('exec-via-chain')?.value||'[]');}catch{status('祖先链不是合法 JSON 数组');return;}
    if(!Array.isArray(chainArgs)){status('祖先链必须是 JSON 数组');return;}
    if(chainArgs.length){
      if(!chainArgs.every(entry=>entry&&typeof entry.symbol==='string')){status('祖先链的每一项都需要 symbol');return;}
      via_chain=chainArgs.map(entry=>({symbol:entry.symbol,args:Array.isArray(entry.args)?entry.args:[]}));
    }
  }
  const request=state.request;$('exec-run').disabled=true;status(via?'先调用包含函数取得闭包实例，再在隔离副本中执行…':'在隔离副本中执行…');
  try{
    const record=await apiJson('exec',{symbol:selected.id,args,allow_effects,via,via_chain});
    if(request!==state.request)return;
    renderExecution(state.execProfile,record);
    status(`受控运行结束：${record.verdict}`);
  }catch(e){
    if(request!==state.request)return;
    status(`受控运行未开始或失败：${e.message}`);
    renderExecution(state.execProfile,null);
  }finally{if(request===state.request&&state.execProfile)$('exec-run').disabled=!(((state.execProfile.runnable)||viaWanted)&&state.execProfile.arity!==null);}
}
async function select(node){
  const request=++state.request;state.selected=node;state.focus=null;state.execProfile=null;$('export').disabled=true;clearContext();
  $('selection-name').textContent=node.name;$('selection-path').textContent=node.path;$('source').textContent='读取固定快照…';$('selection-facts').textContent='查询关联候选…';
  publishSelection(node);loadAnnotations(node);loadPatches(node);
  // Clear the previous selection's facts before the new ones arrive. Leaving
  // them up made the panel show function A's conclusion under function B's
  // name whenever the query failed.
  renderFlow(null);renderExecution(null,null);renderPatches([]);render();
  try{
    const [source,reach]=await Promise.all([api('source',{entity:node.id}),api('reach',{entity:node.id})]);
    if(request!==state.request)return;
    state.focus=reach;render();$('source').textContent=source.content;
    state.sourceLines=byteLineMap(source.content);
    $('source-status').textContent=`${source.start}–${source.end} 字节 · ${source.truncated?'已截断':'本次选区已展示'} · ${source.blob?.slice(0,10)??''}`;
    $('selection-facts').textContent=`${reach.nodes.length} 个相关对象\n${reach.edges.length} 条调用候选 · ${reach.unresolved.length} 个未解析调用\n${reach.truncated?'查询达到预算，仍有未展开边界':'本次候选遍历结束'}\n这不是实际执行路线；分支可能互斥。`;
    $('export').disabled=false;
    if(node.kind==='function'){
      try{
        const flow=await api('flow',{entity:node.id});
        if(request!==state.request)return;
        renderFlow(flow,node.id);
      }catch{if(request===state.request)renderFlow(null);}
      // The static profile is separate from the flow fact on purpose: a symbol
      // can have flow facts and still be unclassifiable, and the panel must be
      // able to say "no profile" rather than defaulting to "runnable".
      try{
        const profile=await api('profile',{entity:node.id});
        if(request!==state.request)return;
        state.execProfile=profile;
        renderExecution(profile,null);
      }catch{if(request===state.request){state.execProfile=null;renderExecution(null,null);}}
    } else {renderFlow(null);renderExecution(null,null);renderPatches([]);}
  }catch(e){
    if(request!==state.request)return;
    renderFlow(null);renderExecution(null,null);renderPatches([]);
    $('source').textContent=e.message;
    $('selection-facts').textContent=/\(401\)/.test(e.message)
      ?'会话已失效或令牌不正确：请重新粘贴启动命令返回的 session_file 中的 token 后重试。'
      :'该对象可能没有可读取的源码，或查询不可用。';
  }
}
$('patch-propose').onclick=()=>proposePatch();
$('annotation-add').onclick=()=>proposeAnnotation();
$('exec-run').onclick=()=>runControlled();installBridge();$('connect-button').onclick=connect;$('token').onkeydown=e=>{if(e.key==='Enter')connect();};$('search').oninput=renderTree;
// The level switch only changes which blocks the overview draws. It does not
// clear the focus and does not re-anchor a selection: with a function focused
// the canvas is the focus graph, and the status line says so instead of
// silently swapping the picture under the cursor.
function setLevel(level){
  if(!LEVELS.includes(level)){status(`未知层级 ${level}`);return false;}
  state.level=level;
  for(const name of LEVELS){const b=$(`level-${name}`);if(b)b.setAttribute('aria-pressed',String(name===level));}
  renderGraph();
  if(state.selected&&state.selected.kind==='function')status(`层级已切到 ${LEVEL_LABELS[level]}；当前仍是焦点图，层级作用于概览（清除焦点后可见）`);
  return true;
}
for(const name of LEVELS){const b=$(`level-${name}`);if(b)b.onclick=()=>setLevel(name);}
const graphEl=$('graph');
if(graphEl&&graphEl.addEventListener)graphEl.addEventListener('click',e=>{
  if(state.selected&&state.selected.kind==='function')return;
  const box=e.target&&e.target.getBoundingClientRect?e.target.getBoundingClientRect():{left:0,top:0,width:800,height:600};
  const x=(e.clientX-box.left)*(800/Math.max(box.width,1)),y=(e.clientY-box.top)*(600/Math.max(box.height,1));
  levelPickAt(x,y);
});
// Toggling the enclosing-function path changes whether a run is possible at
// all, so the button follows it immediately instead of after a re-selection.
if($('exec-via-enable'))$('exec-via-enable').onchange=()=>{const profile=state.execProfile;if(!profile)return;const wanted=Boolean(profile.enclosing_symbol&&$('exec-via-enable').checked);$('exec-run').disabled=!((profile.runnable||wanted)&&profile.arity!==null);};
$('more').onclick=()=>loadNodes().catch(e=>status(e.message));$('more-edges').onclick=()=>loadEdges().catch(e=>status(e.message));
$('reset').onclick=resetDetail;
$('export').onclick=async()=>{try{const selected=state.selected,request=state.request;if(!selected)return;const context=await api('context',{entity:selected.id},'POST');if(request!==state.request)return;clearContext();const json=JSON.stringify(context,null,2);state.exportUrl=URL.createObjectURL(new Blob([json],{type:'application/json'}));$('context-json').value=json;$('context-download').href=state.exportUrl;$('context-download').download=`atlas-context-${context.selection_id.slice(0,12)}.json`;$('context-panel').hidden=false;$('context-panel').open=true;status('选区上下文已在本地生成，可复制或下载；未发送给 LLM');}catch(e){status(e.message);}};
$('context-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('context-json').value);status('上下文已复制；未发送给 LLM');}catch{status('浏览器未允许剪贴板写入，可在 JSON 文本框中手动复制');}};
// A fragment never travels in an HTTP request. It carries the token and,
// optionally, the selection another projection was looking at.
{const fragment=parseFragment();
 if(fragment.selection||fragment.analysis){state.pendingSelection={entity_id:fragment.selection||'',analysis:fragment.analysis||''};}
 if(fragment.token){history.replaceState(null,'',location.pathname);$('token').value=fragment.token;connect();}}

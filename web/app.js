const $ = id => document.getElementById(id);
const state = {token:'',nodes:[],edges:[],nodePage:null,edgePage:null,selected:null,focus:null,request:0,exportUrl:null};
const ns='http://www.w3.org/2000/svg';
function svg(tag, attrs={}, text) {const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;}
function text(tag,value,cls) {const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;}
async function api(name, params={}, method='GET') {
  const r=await fetch(`/api/${name}?${new URLSearchParams(params)}`,{method,headers:{Authorization:`Bearer ${state.token}`}});
  if(!r.ok)throw new Error(`查询未完成 (${r.status})`);return r.json();
}
function status(message){$('status').textContent=message;}
function clearContext(){if(state.exportUrl)URL.revokeObjectURL(state.exportUrl);state.exportUrl=null;$('context-panel').hidden=true;$('context-json').value='';$('context-download').removeAttribute('href');}
// The inspector is one unit: name, path, source and flow must always describe
// the same selection. Clearing it in one place is what keeps a stale flow fact
// from sitting under a freshly selected name.
function resetDetail(){
  state.request++;state.selected=null;state.focus=null;$('export').disabled=true;clearContext();
  $('selection-name').textContent='选择一个函数';$('selection-path').textContent='固定分析版本';
  $('selection-facts').textContent='选择对象以查询关联候选。';$('source').textContent='尚未选择对象';$('source-status').textContent='';
  renderFlow(null);render();
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
    await loadNodes();await loadEdges();
    $('metrics').replaceChildren(metric(report.file_count,'文件'),metric(report.function_count,'函数'),metric(report.call_count,'调用点'));
    $('revision').textContent=`分析版本 ${report.id.slice(0,12)}`;$('revision').title=report.id;
    $('token').value='';status('已连接 · 固定版本 · 本地只读查询');
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
function renderFocusGraph(graph,byId,root){
  const reach=state.focus||{edges:[],unresolved:[]};
  const known=new Map([...(reach.edges||[]),...state.edges].filter(e=>e.target).map(e=>[e.id,e]));
  const out=[...known.values()].filter(e=>e.source===root.id);
  const inc=[...known.values()].filter(e=>e.target===root.id);
  const unresolved=reach.unresolved||[];
  graph.append(svg('text',{x:60,y:22,class:'frame-label'},`调用者 ${inc.length}（已解析）`));
  graph.append(svg('text',{x:300,y:22,class:'frame-label'},'当前选区'));
  graph.append(svg('text',{x:560,y:22,class:'frame-label'},`被调用 ${out.length} · 未解析 ${unresolved.length}`));
  const rootBox=graphNode(graph,{x:300,y:104,label:root.name,sub:root.path,cls:'selected',width:200,height:38});
  let left=0;
  for(const e of inc){
    const n=byId.get(e.source),y=62+left*46;left++;
    const box=graphNode(graph,{x:60,y,label:n?n.name:e.source,sub:n?n.path:'（未载入本分析）',width:210,onClick:n?()=>select(n):null});
    graphEdge(graph,box,rootBox,e.label||'call');
  }
  let right=0;
  for(const e of out){
    const n=byId.get(e.target),y=62+right*46;right++;
    const box=graphNode(graph,{x:560,y,label:n?n.name:e.target,sub:n?n.path:'',width:210,onClick:n?()=>select(n):null});
    graphEdge(graph,rootBox,box,e.label||'call');
  }
  for(const u of unresolved){
    const y=62+right*46;right++;
    const box=graphNode(graph,{x:560,y,label:`? ${u.label}`,sub:'未解析目标：动态/外部/缺失绑定',cls:'unresolved',width:210});
    graphEdge(graph,rootBox,box,u.label||'call','unresolved');
  }
  if(!right)graph.append(svg('text',{x:560,y:62,class:'node-sub'},'没有已知的被调用目标'));
  $('graph-status').textContent=`焦点 ${root.name} · 被调用 ${out.length} · 未解析 ${unresolved.length} · 调用者 ${inc.length}`;
  $('graph-status').title=reach.semantics||'以选中函数为中心的静态调用候选，不是执行顺序。';
  return 62+Math.max(left,right,1)*46+30;
}
function renderOverviewGraph(graph,byId){
  const files=[...byId.values()].filter(n=>n.kind==='file'&&n.function_count>0).slice(0,12);
  if(!files.length)return 430;
  const fnFile=new Map();for(const n of byId.values())if(n.kind==='function')fnFile.set(n.id,n.parent);
  const aggregated=new Map();
  for(const e of state.edges){
    const a=fnFile.get(e.source),b=e.target?fnFile.get(e.target):null;
    if(!a||!b||a===b)continue;
    const key=`${a}||${b}`;aggregated.set(key,(aggregated.get(key)||0)+1);
  }
  const cols=3,W=210,H=46,GX=40,GY=30,pos=new Map();
  files.forEach((file,i)=>{
    const x=40+(i%cols)*(W+GX),y=62+Math.floor(i/cols)*(H+GY);
    pos.set(file.id,graphNode(graph,{x,y,label:file.name,sub:`${file.path} · ${file.function_count} 函数`,width:W,height:H,cls:state.selected?.id===file.id?'selected':'',onClick:()=>select(file)}));
  });
  let drawn=0;
  for(const [key,count] of aggregated){
    const [a,b]=key.split('||');const pa=pos.get(a),pb=pos.get(b);if(!pa||!pb)continue;
    drawn++;graphEdge(graph,pa,pb,`${count} 候选`);
  }
  graph.append(svg('text',{x:40,y:20,class:'frame-label'},'概览：文件之间的调用候选（聚合）'));
  graph.append(svg('text',{x:40,y:38,class:'node-sub'},'选择一个函数，画布切换为以它为中心的调用候选焦点图'));
  $('graph-status').textContent=`概览 ${files.length} 文件 · ${drawn} 条文件间候选 · 已加载关系 ${state.edges.length}/${state.edgePage?.total??0}`;
  $('graph-status').title='文件层聚合视图；调用候选不是执行顺序。';
  return 62+Math.ceil(files.length/cols)*(H+GY)+30;
}
function render(){renderTree();renderGraph();}
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
async function select(node){
  const request=++state.request;state.selected=node;state.focus=null;$('export').disabled=true;clearContext();
  $('selection-name').textContent=node.name;$('selection-path').textContent=node.path;$('source').textContent='读取固定快照…';$('selection-facts').textContent='查询关联候选…';
  // Clear the previous selection's facts before the new ones arrive. Leaving
  // them up made the panel show function A's conclusion under function B's
  // name whenever the query failed.
  renderFlow(null);render();
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
    } else renderFlow(null);
  }catch(e){
    if(request!==state.request)return;
    renderFlow(null);
    $('source').textContent=e.message;
    $('selection-facts').textContent=/\(401\)/.test(e.message)
      ?'会话已失效或令牌不正确：请重新粘贴启动命令返回的 session_file 中的 token 后重试。'
      :'该对象可能没有可读取的源码，或查询不可用。';
  }
}
$('connect-button').onclick=connect;$('token').onkeydown=e=>{if(e.key==='Enter')connect();};$('search').oninput=renderTree;
$('more').onclick=()=>loadNodes().catch(e=>status(e.message));$('more-edges').onclick=()=>loadEdges().catch(e=>status(e.message));
$('reset').onclick=resetDetail;
$('export').onclick=async()=>{try{const selected=state.selected,request=state.request;if(!selected)return;const context=await api('context',{entity:selected.id},'POST');if(request!==state.request)return;clearContext();const json=JSON.stringify(context,null,2);state.exportUrl=URL.createObjectURL(new Blob([json],{type:'application/json'}));$('context-json').value=json;$('context-download').href=state.exportUrl;$('context-download').download=`atlas-context-${context.selection_id.slice(0,12)}.json`;$('context-panel').hidden=false;$('context-panel').open=true;status('选区上下文已在本地生成，可复制或下载；未发送给 LLM');}catch(e){status(e.message);}};
$('context-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('context-json').value);status('上下文已复制；未发送给 LLM');}catch{status('浏览器未允许剪贴板写入，可在 JSON 文本框中手动复制');}};
// A fragment never travels in an HTTP request. Remove it before further navigation.
if(location.hash.startsWith('#token=')){const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);$('token').value=token||'';connect();}

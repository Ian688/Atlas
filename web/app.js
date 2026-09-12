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
function metric(value,label){const box=text('div','');box.append(text('b',value),text('span',label));return box;}
async function loadNodes(){const page=await api('nodes',{limit:100,...(state.nodePage?.next_cursor?{cursor:state.nodePage.next_cursor}:{})});state.nodes.push(...page.items);state.nodePage=page;$('more').hidden=!page.next_cursor;render();}
async function loadEdges(){const page=await api('edges',{limit:100,...(state.edgePage?.next_cursor?{cursor:state.edgePage.next_cursor}:{})});state.edges.push(...page.items);state.edgePage=page;$('more-edges').hidden=!page.next_cursor;render();}
async function connect(){
  state.token=$('token').value.trim();status('正在读取本地分析…');
  try {
    const report=await api('report');state.report=report;state.nodes=[];state.edges=[];state.nodePage=null;state.edgePage=null;state.selected=null;state.focus=null;state.request++;clearContext();
    await loadNodes();await loadEdges();
    $('metrics').replaceChildren(metric(report.file_count,'文件'),metric(report.function_count,'函数'),metric(report.call_count,'调用点'));
    $('revision').textContent=`分析版本 ${report.id.slice(0,12)}`;$('revision').title=report.id;
    $('token').value='';status('已连接 · 固定版本 · 本地只读查询');
  }catch(e){status(e.message);}
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
function renderGraph(){
  const graph=$('graph');graph.replaceChildren();$('empty').hidden=state.nodes.length>0;
  const defs=svg('defs');const gradient=svg('linearGradient',{id:'glass',x1:0,y1:0,x2:1,y2:1});gradient.append(svg('stop',{offset:'0%', 'stop-color':'#ffffff','stop-opacity':'.95'}),svg('stop',{offset:'100%','stop-color':'#d8e9f2','stop-opacity':'.8'}));
  const marker=svg('marker',{id:'arrow',viewBox:'0 0 8 8',refX:7,refY:4,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});marker.append(svg('path',{d:'M 1 1 L 7 4 L 1 7',fill:'none',stroke:'#79a7bb'}));defs.append(gradient,marker);graph.append(defs);
  const pool=new Map(state.nodes.map(n=>[n.id,n]));for(const n of state.focus?.nodes||[])pool.set(n.id,n);
  // The canvas deliberately bounds the projection. Exact repository totals live in the report.
  const files=[...pool.values()].filter(n=>n.kind==='file'&&n.function_count>0).slice(0,12);
  const pos=new Map();let y=35;const frames=[];const groups=[];
  for(const dir of [...new Set(files.map(f=>f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')):''))]){
    const members=files.filter(f=>(f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')):'')===dir);const start=y;let rowHeight=0;
    members.forEach((file,i)=>{
      if(i>0&&i%2===0){y+=rowHeight+32;rowHeight=0;}
      const x=45+(i%2)*380;const all=[...pool.values()].filter(n=>n.kind==='function'&&n.path===file.path).sort((a,b)=>a.start-b.start);const functions=all.slice(0,20);const h=68+functions.length*29;rowHeight=Math.max(rowHeight,h);
      const g=svg('g');g.append(svg('rect',{x,y:y+26,width:310,height:h,rx:10,class:'file-body'}));g.append(svg('text',{x:x+16,y:y+51,class:'file-title'},file.name));
      g.append(svg('text',{x:x+16,y:y+h+15,class:'folder-caption'},`${file.function_count} 函数 · 展示 ${functions.length}`));
      functions.forEach((fn,j)=>{
        const py=y+67+j*29;pos.set(fn.id,{x:x+14,y:py,w:282});
        const selected=state.selected?.id===fn.id;const dim=state.focus&&!state.focus.nodes.some(n=>n.id===fn.id);
        const group=svg('g',{class:`node-group${selected?' selected':''}${dim?' dim':''}`,tabindex:0,role:'button','aria-label':fn.name});
        group.append(svg('rect',{x:x+14,y:py-13,width:282,height:24,rx:5,class:'function-row'}),svg('text',{x:x+25,y:py+3,class:'function-text'},fn.name.slice(0,35)),svg('title',{},`${fn.name}\n${fn.path}`));
        group.addEventListener('click',()=>select(fn));group.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(fn);}});g.append(group);
        const unknown=state.edges.filter(e=>e.source===fn.id&&!e.target).length;
        if(unknown)g.append(svg('text',{x:x+273,y:py+3,class:'unknown-count'},`?${unknown}`));
      });groups.push(g);
    });
    y+=rowHeight+60;frames.push(svg('rect',{x:23,y:start+6,width:742,height:y-start-13,rx:9,class:'frame'}),svg('text',{x:36,y:start+20,class:'frame-label'},dir||'/'));
  }
  graph.setAttribute('viewBox',`0 0 800 ${Math.max(y+20,550)}`);graph.append(...frames);
  const edges=new Map(state.edges.map(e=>[e.id,e]));for(const e of state.focus?.edges||[])edges.set(e.id,e);
  let rendered=0;
  for(const edge of edges.values()){
    const a=pos.get(edge.source),b=pos.get(edge.target);if(!a||!b)continue;rendered++;
    const active=state.focus?.edges.some(e=>e.id===edge.id);let d;
    if(a.x===b.x){const x=a.x+a.w;const bend=x+15+(rendered%4)*7;d=`M ${x} ${a.y} C ${bend} ${a.y}, ${bend} ${b.y}, ${x} ${b.y}`;}
    else {const forward=a.x<b.x;const ax=forward?a.x+a.w:a.x,bx=forward?b.x:b.x+b.w;const mid=(ax+bx)/2;d=`M ${ax} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${bx} ${b.y}`;}
    const p=svg('path',{d,class:`edge${state.focus?(active?' active':' dim'):''}`,'marker-end':'url(#arrow)'});p.append(svg('title',{},`${edge.label} · ${edge.basis}`));graph.append(p);
  }
  graph.append(...groups);
  $('graph-status').textContent=`${files.length} 文件 / ${rendered} 连线 · 关系已取 ${state.edges.length}/${state.edgePage?.total??0}`;
  $('graph-status').title='画布最多展示 12 个含函数文件、每文件 20 个函数；未投影对象仍可从左侧选择和查询。';
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
function renderFlow(flow){
  const panel=$('flow-panel');const body=$('flow-body');if(!panel||!body)return;
  if(!flow){panel.hidden=true;body.replaceChildren();return;}
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
  $('selection-name').textContent=node.name;$('selection-path').textContent=node.path;$('source').textContent='读取固定快照…';$('selection-facts').textContent='查询关联候选…';render();
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
        renderFlow(flow);
      }catch{if(request===state.request)renderFlow(null);}
    } else renderFlow(null);
  }catch(e){if(request!==state.request)return;$('source').textContent=e.message;$('selection-facts').textContent='该对象可能没有可读取的源码，或查询不可用。';}
}
$('connect-button').onclick=connect;$('token').onkeydown=e=>{if(e.key==='Enter')connect();};$('search').oninput=renderTree;
$('more').onclick=()=>loadNodes().catch(e=>status(e.message));$('more-edges').onclick=()=>loadEdges().catch(e=>status(e.message));
$('reset').onclick=()=>{state.request++;state.focus=null;state.selected=null;clearContext();$('export').disabled=true;$('selection-name').textContent='选择一个函数';$('selection-path').textContent='固定分析版本';$('selection-facts').textContent='选择对象以查询关联候选。';$('source').textContent='尚未选择对象';$('source-status').textContent='';render();};
$('export').onclick=async()=>{try{const selected=state.selected,request=state.request;if(!selected)return;const context=await api('context',{entity:selected.id},'POST');if(request!==state.request)return;clearContext();const json=JSON.stringify(context,null,2);state.exportUrl=URL.createObjectURL(new Blob([json],{type:'application/json'}));$('context-json').value=json;$('context-download').href=state.exportUrl;$('context-download').download=`atlas-context-${context.selection_id.slice(0,12)}.json`;$('context-panel').hidden=false;$('context-panel').open=true;status('选区上下文已在本地生成，可复制或下载；未发送给 LLM');}catch(e){status(e.message);}};
$('context-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('context-json').value);status('上下文已复制；未发送给 LLM');}catch{status('浏览器未允许剪贴板写入，可在 JSON 文本框中手动复制');}};
// A fragment never travels in an HTTP request. Remove it before further navigation.
if(location.hash.startsWith('#token=')){const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);$('token').value=token||'';connect();}

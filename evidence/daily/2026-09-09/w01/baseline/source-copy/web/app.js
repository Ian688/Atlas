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
async function select(node){
  const request=++state.request;state.selected=node;state.focus=null;$('export').disabled=true;clearContext();
  $('selection-name').textContent=node.name;$('selection-path').textContent=node.path;$('source').textContent='读取固定快照…';$('selection-facts').textContent='查询关联候选…';render();
  try{
    const [source,reach]=await Promise.all([api('source',{entity:node.id}),api('reach',{entity:node.id})]);
    if(request!==state.request)return;
    state.focus=reach;render();$('source').textContent=source.content;
    $('source-status').textContent=`${source.start}–${source.end} 字节 · ${source.truncated?'已截断':'本次选区已展示'} · ${source.blob?.slice(0,10)??''}`;
    $('selection-facts').textContent=`${reach.nodes.length} 个相关对象\n${reach.edges.length} 条调用候选 · ${reach.unresolved.length} 个未解析调用\n${reach.truncated?'查询达到预算，仍有未展开边界':'本次候选遍历结束'}\n这不是实际执行路线；分支可能互斥。`;
    $('export').disabled=false;
  }catch(e){if(request!==state.request)return;$('source').textContent=e.message;$('selection-facts').textContent='该对象可能没有可读取的源码，或查询不可用。';}
}
$('connect-button').onclick=connect;$('token').onkeydown=e=>{if(e.key==='Enter')connect();};$('search').oninput=renderTree;
$('more').onclick=()=>loadNodes().catch(e=>status(e.message));$('more-edges').onclick=()=>loadEdges().catch(e=>status(e.message));
$('reset').onclick=()=>{state.request++;state.focus=null;state.selected=null;clearContext();$('export').disabled=true;$('selection-name').textContent='选择一个函数';$('selection-path').textContent='固定分析版本';$('selection-facts').textContent='选择对象以查询关联候选。';$('source').textContent='尚未选择对象';$('source-status').textContent='';render();};
$('export').onclick=async()=>{try{const selected=state.selected,request=state.request;if(!selected)return;const context=await api('context',{entity:selected.id},'POST');if(request!==state.request)return;clearContext();const json=JSON.stringify(context,null,2);state.exportUrl=URL.createObjectURL(new Blob([json],{type:'application/json'}));$('context-json').value=json;$('context-download').href=state.exportUrl;$('context-download').download=`atlas-context-${context.selection_id.slice(0,12)}.json`;$('context-panel').hidden=false;$('context-panel').open=true;status('选区上下文已在本地生成，可复制或下载；未发送给 LLM');}catch(e){status(e.message);}};
$('context-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('context-json').value);status('上下文已复制；未发送给 LLM');}catch{status('浏览器未允许剪贴板写入，可在 JSON 文本框中手动复制');}};
// A fragment never travels in an HTTP request. Remove it before further navigation.
if(location.hash.startsWith('#token=')){const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);$('token').value=token||'';connect();}

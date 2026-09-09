import {test} from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {parse} from '../src/parse.mjs';

const facts = files => parse({schema:'atlas.parse-request.v1',snapshot_id:'fixed-snapshot',files:Object.entries(files).map(([path,content])=>({path,content}))});
const names = f => Object.fromEntries(f.symbols.map(s=>[s.id,s.name]));

test('cross-file alias and re-export resolve using captured sources',()=>{
  const f=facts({'a.ts':'export function add(a:number,b:number){return a+b}', 'barrel.ts':"export {add as sum} from './a'",'b.ts':"import {sum} from './barrel'; export function calc(){return sum(1,2)}"});
  assert.deepEqual(f.parsed_files,['a.ts','b.ts','barrel.ts']);
  assert.equal(names(f)[f.calls.find(c=>c.label==='sum').target],'add');
  assert.equal(f.imports[0].target_path,'barrel.ts');
});
test('lexical shadowing does not bind to a global namesake',()=>{
  const f=facts({'a.ts':'function copy(){return 1} function use(copy:()=>number){return copy()} export {}'});
  assert.equal(f.calls[0].target,null);
});
test('reassigned function declarations are marked; indirect and constructor calls stay unknown',()=>{
  const f=facts({'a.js':'function f(){}; f=()=>2; f(); const o={f}; o.f(); new f(); f?.();'});
  assert.equal(f.symbols.find(s=>s.name==='f').mutated,true);
  assert.equal(f.calls.filter(c=>c.form==='dynamic').length,3);
  assert.ok(f.calls.filter(c=>c.form==='dynamic').every(c=>c.target===null));
});
test('duplicate script declarations are ambiguous, not first-declaration wins',()=>{
  const f=facts({'a.js':'function same(){}','b.js':'function same(){}; same();'});
  assert.equal(f.calls[0].target,null);
});
test('UTF-8 byte spans retain Chinese and emoji source anchors',()=>{
  const source='// 🫧 中文\nexport function 加(a){ return a; }\n加("水");';
  const f=facts({'中文.ts':source}), s=f.symbols[0], c=f.calls[0], bytes=Buffer.from(source);
  assert.equal(bytes.subarray(s.start,s.end).toString(),'export function 加(a){ return a; }');
  assert.equal(bytes.subarray(c.start,c.end).toString(),'加("水")');
});
test('nested calls with identical start offsets have distinct full-span IDs',()=>{
  const f=facts({'a.ts':'function factory(){return ()=>1}; factory()();'});
  assert.equal(f.calls.length,2);assert.equal(new Set(f.calls.map(c=>c.id)).size,2);
});
test('compiler host never falls back to ambient source or config reads',()=>{
  const read=ts.sys.readFile,exists=ts.sys.fileExists;let ambient=0;
  ts.sys.readFile=()=>{ambient++;throw Error('ambient read');};ts.sys.fileExists=()=>{ambient++;throw Error('ambient stat');};
  try{const f=facts({'a.ts':"import {x} from '/private/external'; x();"});assert.equal(f.imports[0].target_path,null);assert.equal(f.calls[0].target,null);assert.equal(ambient,0);}
  finally{ts.sys.readFile=read;ts.sys.fileExists=exists;}
});
test('syntax failures and dynamic language features are explicit',()=>{
  const f=facts({'broken.ts':'export function broken( {', 'dynamic.js':'function f(){}; eval("f = 3"); f();'});
  assert.ok(f.diagnostics.some(d=>d.path==='broken.ts'));assert.deepEqual(f.dynamic_files,['dynamic.js']);
});
test('request isolation rejects traversal and duplicates; source is never evaluated',()=>{
  assert.throws(()=>facts({'../outside.js':''}),/invalid_source_path/);
  assert.throws(()=>parse({schema:'atlas.parse-request.v1',snapshot_id:'x',files:[{path:'a.js',content:''},{path:'a.js',content:''}]}),/duplicate_source/);
  globalThis.__atlasShouldNeverRun=false;
  facts({'a.js':'globalThis.__atlasShouldNeverRun = true; throw new Error("do not execute");'});
  assert.equal(globalThis.__atlasShouldNeverRun,false);delete globalThis.__atlasShouldNeverRun;
});

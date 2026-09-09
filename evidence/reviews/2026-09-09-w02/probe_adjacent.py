import json,pathlib,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[3]
SOURCE='''
function set(o) { o.value=2; }
function wrap(o) { set(o); }
function fail(o) { o.value=2; throw 7; }
export function transitive() { const o={value:1}; wrap(o); return o.value; }
export function exceptional() { const o={value:1}; try { fail(o); } catch(e) { return o.value; } }
export function finiteNumber() { return 41; }
export function hugeString() { return ''+100000000000000000000; }
export function nestedUnknown(change) { const inner={value:1}; const outer={inner:inner}; change(outer); return inner.value; }
'''
def main():
 with tempfile.TemporaryDirectory() as td:
  b=pathlib.Path(td); p=b/'project'; p.mkdir(); (p/'sample.mjs').write_text(SOURCE)
  def cli(*args):
   r=subprocess.run([str(ROOT/'target/debug/atlas'),'--store',str(b/'store'),*args],cwd=ROOT,capture_output=True,text=True,timeout=60)
   if r.returncode: raise RuntimeError(r.stderr)
   return json.loads(r.stdout)
  oracle_script="import * as m from "+json.dumps((p/'sample.mjs').as_uri())+"; console.log(JSON.stringify({finiteNumber:m.finiteNumber(),transitive:m.transitive(),exceptional:m.exceptional(),hugeString:m.hugeString(),nestedUnknown:m.nestedUnknown(o=>{o.inner.value=2})}));"
  r=subprocess.run(['node','--input-type=module','-e',oracle_script],capture_output=True,text=True,check=True)
  expected=json.loads(r.stdout); a=cli('index',str(p)); ns=cli('nodes',a['id'],'--kind','function','--limit','500')['items']; results=[]
  for n in ns:
   if n['name'] not in expected: continue
   f=cli('flow',a['id'],n['id']); v=f['returns']; ok=v['unknown'] or expected[n['name']] in v['constants']
   if n['name']=='finiteNumber': ok=v['typed_constants']==[{'kind':'number','value':41}]
   results.append(dict(name=n['name'],expected=expected[n['name']],actual=v,status=f['status'],passed=ok))
  out=dict(source=SOURCE,analysis_id=a['id'],checks=results)
  (pathlib.Path(__file__).parent/'adjacent-results.json').write_text(json.dumps(out,indent=2)+'\n')
  print(json.dumps(results,indent=2)); return 0 if all(x['passed'] for x in results) else 1
if __name__=='__main__': raise SystemExit(main())

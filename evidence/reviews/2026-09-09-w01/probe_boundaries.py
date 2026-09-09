#!/usr/bin/env python3
"""Bounded CLI probes for valid syntax, malformed worker IR, and deadlines."""
import datetime, json, pathlib, sqlite3, subprocess, tempfile, time

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(__file__).resolve().parent

def main():
    results = []
    cases = [
        ('optional_catch', 'export function f() { try { throw 1; } catch { return 7; } }', None, []),
        ('duplicate_binding', 'export function f(x) { return x; }', 'result.flow.functions[0].bindings.push({...result.flow.functions[0].bindings[0]});', []),
        ('missing_flow_function', 'export function f(x) { return x; }', 'result.flow.functions = [];', []),
        ('dangling_local_reference', 'export function f(x) { return x; }', '''let changed = 0; function visit(x) {if (!x || typeof x !== 'object') return; if (x.expr === 'local') { x.binding = 'b:nonexistent'; changed++; } for (const v of Object.values(x)) visit(v); } visit(result.flow); if (changed !== 1) throw new Error('mutation_not_applied');''', []),
        ('pipeline_deadline', '\n'.join(f'export function f{i}() {{ return '+(f'f{i+1}(); }}' if i < 1199 else '0; }') for i in range(1200)), None, ['--index-deadline-seconds', '2']),
        ('rust_stage_deadline', '\n'.join(f'export function f{i}() {{ return '+(f'f{i+1}(); }}' if i < 1199 else '0; }') for i in range(1200)), 'CACHE_REAL_FACTS', ['--index-deadline-seconds', '1']),
    ]
    for name, source, mutate, options in cases:
        with tempfile.TemporaryDirectory(prefix='atlas-independent-boundary-') as directory:
            base = pathlib.Path(directory); project = base/'project'; project.mkdir()
            (project/'sample.mjs').write_text(source)
            store = base/'store'
            args = [str(ROOT/'target/debug/atlas'), '--store', str(store), 'index', str(project), *options]
            precompute = None
            if mutate == 'CACHE_REAL_FACTS':
                request = {'schema':'atlas.parse-request.v1', 'snapshot_id':'preflight', 'files':[{'path':'sample.mjs', 'content':source}]}
                p0 = subprocess.run(['node', str(ROOT/'workers/typescript/worker.mjs')], input=json.dumps(request), cwd=ROOT, capture_output=True, text=True, timeout=60)
                if p0.returncode: raise RuntimeError(p0.stderr)
                cache = base/'language-facts.json'; cache.write_text(p0.stdout)
                precompute = {'exit_code':p0.returncode, 'meaning':'Real worker output for identical source, prepared outside measured deadline to isolate Rust stage; only snapshot IDs are rebound.'}
                worker = base/'worker.mjs'
                worker.write_text(f"import fs from 'node:fs'; const chunks=[]; for await (const c of process.stdin) chunks.push(c); const req=JSON.parse(Buffer.concat(chunks)); const result=JSON.parse(fs.readFileSync({json.dumps(str(cache))},'utf8')); result.snapshot_id=req.snapshot_id; result.flow.snapshot_id=req.snapshot_id; process.stdout.write(JSON.stringify(result));")
                args += ['--worker', str(worker)]
            elif mutate:
                worker = base/'worker.mjs'
                worker.write_text(f"import {{parse}} from {json.dumps((ROOT/'workers/typescript/src/parse.mjs').as_uri())};\nconst chunks=[]; for await (const c of process.stdin) chunks.push(c); const result=parse(JSON.parse(Buffer.concat(chunks)));\n{mutate}\nprocess.stdout.write(JSON.stringify(result));\n")
                args += ['--worker', str(worker)]
            started = time.monotonic()
            p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=60)
            seconds = time.monotonic()-started
            databases = list(store.glob('*.db'))
            counts = {}
            for db in databases:
                if db.name.endswith(('-wal','-shm')): continue
                with sqlite3.connect(db) as c:
                    for table in ['snapshots', 'analyses', 'facts']:
                        counts[table] = c.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
            passed = p.returncode == 0 if name == 'optional_catch' else p.returncode != 0
            if name == 'pipeline_deadline': passed = passed and seconds < 4 and counts.get('analyses',0) == 0
            if name == 'rust_stage_deadline': passed = passed and seconds < 3 and counts.get('analyses',0) == 0
            result = {'case':name, 'argv': args, 'exit_code':p.returncode, 'seconds':round(seconds,3), 'stdout':p.stdout, 'stderr':p.stderr, 'published_counts':counts, 'expectation_met':passed, 'source':source, 'worker_mutation':mutate, 'precompute':precompute}
            results.append(result)
            print(json.dumps({k:result[k] for k in ['case','exit_code','seconds','stderr','published_counts','expectation_met']}), flush=True)
    record = {'time_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'cases':results}
    (OUT/'boundary-probes.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
    return 0 if all(r['expectation_met'] for r in results) else 1

if __name__ == '__main__': raise SystemExit(main())

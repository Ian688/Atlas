#!/usr/bin/env python3
"""Independent known-source oracle probes; executes only the fixture below."""
import datetime, hashlib, json, pathlib, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(__file__).resolve().parent
SOURCE = '''
function setValue(o) { o.value = 2; }
function one() { return 1; }
function identity(x) { return x; }
export function knownMutation() { const o = {value: 1}; setValue(o); return o.value; }
export function unknownMutation(change) { const o = {value: 1}; change(o); return o.value; }
export function mixedAddition() { return true + 1; }
export function nullAddition() { return null + 1; }
export function missingField(flag) { const o = flag ? {value: 1} : {}; return o.value; }
export function viaIdentity() { const f = identity(one); return f(); }
export function identityNumber() { return identity(41); }
export function captureChange() { function f() { return 1; } function inner() { return f(); } f = () => 2; return inner(); }
export function increment() { let x = 1; const previous = x++; return previous; }
export function finallyReturn() { try { return 1; } finally { const x = 2; } return 9; }
export function throwCatch() { function fail() { throw 7; } try { fail(); return 1; } catch (e) { return e; } }
export function exceptionState(change) { let x = 1; try { change(); x = 2; } catch (e) { return x; } return x; }
'''
ORACLE = '''
import * as m from './probe.mjs';
const cases = {knownMutation: [], unknownMutation: [o => {o.value = 2}], mixedAddition: [], nullAddition: [], missingField: [false], viaIdentity: [], identityNumber: [], captureChange: [], increment: [], finallyReturn: [], throwCatch: [], exceptionState: [() => {throw 0}]};
const out = {};
for (const [name,args] of Object.entries(cases)) { const value = m[name](...args); out[name] = value === undefined ? {kind: 'undefined'} : {kind: typeof value, value}; }
console.log(JSON.stringify(out));
'''

def main():
    OUT.mkdir(exist_ok=True)
    (OUT / 'fixture.mjs').write_text(SOURCE)
    with tempfile.TemporaryDirectory(prefix='atlas-independent-w01-') as directory:
        base = pathlib.Path(directory); project = base / 'project'; project.mkdir()
        (project / 'probe.mjs').write_text(SOURCE)
        # The oracle is outside the indexed project, and runs only our own fixture.
        (base / 'probe.mjs').write_text(SOURCE); (base / 'oracle.mjs').write_text(ORACLE)
        commands = []
        def run(args):
            p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=90)
            commands.append({'argv': [str(x) for x in args], 'exit_code': p.returncode, 'stderr': p.stderr})
            if p.returncode: raise RuntimeError(p.stderr)
            return json.loads(p.stdout)
        def cli(*args): return run([str(ROOT/'target/debug/atlas'), '--store', str(base/'store'), *args])
        oracle = run(['node', str(base/'oracle.mjs')])
        analysis = cli('index', str(project))
        nodes = cli('nodes', analysis['id'], '--kind', 'function', '--limit', '500')['items']
        facts = {n['name']: cli('flow', analysis['id'], n['id']) for n in nodes if n['name'] in oracle}
        checks = []
        for name in ['exceptionState','knownMutation','unknownMutation','mixedAddition','nullAddition','missingField']:
            value = facts[name]['returns']; expected = oracle[name]
            # Minimal soundness oracle. Ordinary primitive cases also require
            # precision after repair; blanket unknown is not full acceptance.
            concrete = expected.get('value', 'undefined')
            covered = value['unknown'] or concrete in value['constants']
            checks.append({'name': name, 'expected': expected, 'actual': value, 'status': 'PASS' if covered else 'FAIL'})
        record = {'time_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'fixture_sha256': hashlib.sha256(SOURCE.encode()).hexdigest(), 'analysis': analysis, 'oracle': oracle, 'facts': facts, 'commands': commands, 'checks':checks}
        (OUT/'semantic-probes.json').write_text(json.dumps(record, ensure_ascii=False, indent=2)+'\n')
        for name,fact in facts.items():
            print(name, 'oracle=', oracle[name], 'status=', fact['status'], 'returns=', fact['returns'])
    return 0 if all(c['status'] == 'PASS' for c in checks) else 1

if __name__ == '__main__': raise SystemExit(main())

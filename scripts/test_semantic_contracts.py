#!/usr/bin/env python3
"""Real worker/CLI checks for scalar contexts and partial-result contracts.

Node executes only this script's fixed, side-effect-free oracle fixture.
The indexer itself never executes the indexed JavaScript.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / 'target/debug/atlas'
SOURCE = '''
function first(a,b) { return a; }
function swap(a,b) { return first(b,a); }
function identity(x) { return x; }
function pick(x) { if(x === 5) return 1; return 2; }
export function swapped() { return swap(11,22); }
export function callA() { return pick(identity(5)); }
export function callB() { return pick(identity(6)); }
'''


class SemanticContracts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='atlas-semantic-contracts-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / 'project'
        self.project.mkdir()
        self.source = self.project / 'fixture.mjs'
        self.source.write_text(SOURCE)
        self.store = self.base / 'store'

    def cli(self, *args, budget=None):
        env = dict(os.environ)
        env.pop('ATLAS_MAX_TOTAL_TRANSFERS', None)
        env.pop('ATLAS_MAX_TRANSFERS', None)
        if budget is not None:
            env['ATLAS_MAX_TOTAL_TRANSFERS'] = str(budget)
        result = subprocess.run(
            [str(BIN), '--store', str(self.store), *map(str, args)],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def facts(self, analysis):
        nodes = self.cli('nodes', analysis['id'], '--kind', 'function', '--limit', '500')['items']
        return {n['name']: self.cli('flow', analysis['id'], n['id']) for n in nodes}

    def test_parameter_permutation_and_refined_scalar_contexts(self):
        script = ('import * as m from ' + json.dumps(self.source.as_uri()) + ';'
                  'console.log(JSON.stringify({swapped:m.swapped(),callA:m.callA(),callB:m.callB()}));')
        oracle = subprocess.run(['node', '--input-type=module', '-e', script],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(oracle.returncode, 0, oracle.stderr)
        expected = json.loads(oracle.stdout)
        self.assertEqual(expected, {'swapped': 22, 'callA': 1, 'callB': 2})
        facts = self.facts(self.cli('index', self.project))
        for name, value in expected.items():
            with self.subTest(name=name):
                fact = facts[name]
                self.assertEqual(fact['status'], 'complete_within_profile')
                self.assertEqual(fact['returns']['constants'], [value])
                self.assertFalse(fact['returns']['unknown'])
                self.assertEqual(fact['returns']['typed_constants'], [{'kind': 'number', 'value': value}])
                self.assertEqual(fact['frontier'], [])

    def test_reassigned_captured_function_does_not_claim_the_old_target(self):
        self.source.write_text(
            'export function captureChange() { function f() {return 1;} '
            'function inner() {return f();} f=()=>2; return inner(); }')
        script = ('import {captureChange} from ' + json.dumps(self.source.as_uri()) +
                  '; console.log(JSON.stringify(captureChange()));')
        oracle = subprocess.run(['node', '--input-type=module', '-e', script],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(oracle.returncode, 0, oracle.stderr)
        self.assertEqual(json.loads(oracle.stdout), 2)
        facts = self.facts(self.cli('index', self.project))
        value = facts['captureChange']['returns']
        self.assertTrue(value['unknown'] or 2 in value['constants'])
        self.assertTrue(facts['inner']['interprocedural']['callsites'][0]['unknown_component'])

    def test_context_cap_preserves_every_callers_possible_result(self):
        self.source.write_text(
            'function pick(x) { if(x === 5) return 1; return 2; }\n' +
            '\n'.join(f'export function caller{i}() {{ return pick({5 if i % 2 == 0 else 6}); }}' for i in range(12))
        )
        facts = self.facts(self.cli('index', self.project))
        for i in range(12):
            value = facts[f'caller{i}']['returns']
            self.assertTrue(value['unknown'] or (1 if i % 2 == 0 else 2) in value['constants'])
        self.assertTrue(any(len(facts[f'caller{i}']['returns']['constants']) > 1 for i in range(12)),
                        'calls above the context cap must retain the symbolic fallback')

    def test_number_to_string_matches_node_at_rounding_and_exponent_boundaries(self):
        literals = ['9223372036854775808', '1000000000000000100', '1e20', '-1e20',
                    '1e21', '1e-6', '1e-7', '-0', '0.5', '1/0', '-1/0', '0/0']
        self.source.write_text('\n'.join(
            f"export function number{i}() {{ return ''+({literal}); }}"
            for i, literal in enumerate(literals)))
        script = ('import * as m from ' + json.dumps(self.source.as_uri()) + ';'
                  'console.log(JSON.stringify(Object.fromEntries(Object.entries(m).map(([k,f])=>[k,f()]))));')
        oracle = subprocess.run(['node', '--input-type=module', '-e', script],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(oracle.returncode, 0, oracle.stderr)
        expected = json.loads(oracle.stdout)
        facts = self.facts(self.cli('index', self.project))
        for name, value in expected.items():
            with self.subTest(name=name, value=value):
                self.assertEqual(facts[name]['returns']['constants'], [value])
                self.assertFalse(facts[name]['returns']['unknown'])

    def test_budget_publication_is_partial_bounded_and_immutable(self):
        prior = []
        for budget in [0, 1, 15]:
            with self.subTest(budget=budget):
                analysis = self.cli('index', self.project, budget=budget)
                facts = self.facts(analysis)
                self.assertEqual(len(facts), 7)
                for fact in facts.values():
                    self.assertEqual(fact['status'], 'partial_budget')
                    self.assertEqual(fact['interprocedural']['status'], 'partial_budget')
                    self.assertTrue(fact['returns']['unknown'])
                    self.assertTrue(fact['throws']['unknown'])
                    # V-09: a function that solved locally and was only
                    # interrupted at job level *was* reached, so it reports no
                    # frontier; the degradation is carried by the attribution
                    # instead of by naming a block it already finished. A
                    # function that was genuinely cut must still report one
                    # (D19: truncation and frontier must not be lost).
                    job_only = 'job_interrupted_before_fixpoint' in fact['unknown_reasons']
                    if job_only:
                        self.assertEqual(fact['frontier'], [])
                    else:
                        self.assertTrue(fact['frontier'])
                    self.assertTrue(set(fact['frontier']).issubset({b['id'] for b in fact['blocks']}))
                    self.assertEqual(fact['budgets']['job_max_transfers'], budget)
                    self.assertLessEqual(fact['budgets']['job_total_transfers'], budget)
                    for call in fact['interprocedural']['callsites']:
                        self.assertTrue(call['unknown_component'])
                        self.assertFalse(call['targets_complete'])
                        self.assertTrue(call['result']['unknown'])
                # The symbol frontier must agree with that attribution: it holds
                # only the functions the budget could not reach.
                reached = sum(1 for f in facts.values()
                              if 'job_interrupted_before_fixpoint' in f['unknown_reasons'])
                self.assertEqual(analysis['coverage']['flow_frontier_functions'],
                                 len(facts) - reached)
                prior.append((analysis, facts))
        complete = self.facts(self.cli('index', self.project))
        self.assertEqual(complete['swapped']['returns']['constants'], [22])
        self.assertEqual(complete['callA']['returns']['constants'], [1])
        for analysis, facts in prior:
            self.assertEqual(self.facts(analysis), facts, 'full recomputation must not rewrite partial history')


    def test_a_call_that_cannot_return_has_no_normal_successor(self):
        # P0 #2. `after()` never returns 'after': alwaysThrows() throws 1 and has
        # no normal return, so everything after the call is unreachable. The
        # regression published a definite 'after' with unknown=false and dropped
        # the callee's definite throw from the caller's `throws`.
        self.source.write_text(
            'function alwaysThrows() { throw 1; }\n'
            "export function after() { let x = 'before'; alwaysThrows(); x = 'after'; return x; }\n"
            'function divideOrThrow(left, right) { if (right === 0) throw 2; return left / right; }\n'
            "export function unreachable() { divideOrThrow(1, 0); return 'reached'; }\n"
        )
        facts = self.facts(self.cli('index', self.project))
        after = facts['after']
        self.assertNotIn('after', after['returns']['constants'],
                         f'unreachable code must not produce a value: {after["returns"]}')
        self.assertTrue(after['returns']['unknown'], after['returns'])
        self.assertEqual(after['throws']['constants'], [1],
                         'the callee throw becomes the caller exceptional result')
        self.assertFalse(after['throws']['unknown'], after['throws'])
        # The symbolic divideOrThrow() has a `return`; only the concrete argument
        # prunes it, so this half proves the context summary is consulted.
        unreachable = facts['unreachable']
        self.assertNotIn('reached', unreachable['returns']['constants'],
                         f'a context-proven no-return must remove the normal successor: {unreachable["returns"]}')
        self.assertTrue(unreachable['returns']['unknown'], unreachable['returns'])


if __name__ == '__main__':
    unittest.main(verbosity=2)

//! Interprocedural summaries (W04 + k=1 contexts, M1).
//!
//! Symbolic summaries: origins may reference `Parameter(i)`, which callers
//! re-base with their actual arguments at each callsite, so returns never
//! stream across callers. On top of that, k=1 context summaries: for each
//! callee, up to [`MAX_CONTEXTS_PER_FUNCTION`] calling callsites get an
//! individual concrete-seeded solve, so parameter-value-dependent control flow
//! folds precisely per context. The call graph comes from the local solves'
//! observed callee targets and is re-derived when summaries resolve new
//! callees; SCCs are processed callees-first with bounded inner iteration for
//! cycles. Work-budget stops degrade to `partial_budget` with an explicit
//! frontier; deadline breaches refuse the derivation. A pending summary is
//! never read as "no return".
use crate::control::ExecutionControl;
use crate::flow::{LoweredFunction, build_cfg};
use crate::solve::{self, MAX_TRANSFERS, SolveOutput, Summary, Value};
use atlas_contract::{FlowFacts, FlowFunction};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_SCC_ROUNDS: usize = 32;
/// Bounded rescheduling rounds for graphs that grow through summary
/// substitution (M1).
pub const MAX_GRAPH_ROUNDS: usize = 4;
/// k=1 contexts per callee: at most this many calling callsites get an
/// individual concrete-seeded solve; remaining callers share the symbolic
/// summary (declared precision cap, M1/AL-07).
pub const MAX_CONTEXTS_PER_FUNCTION: usize = 8;
pub const MAX_TOTAL_TRANSFERS: usize = MAX_TRANSFERS * 8;

/// Test/debug hook for the whole-job work budget (see `max_transfers_budget`
/// in solve). Production default is unchanged.
fn max_total_transfers_budget() -> usize {
    if cfg!(debug_assertions)
        && let Ok(value) = std::env::var("ATLAS_MAX_TOTAL_TRANSFERS")
        && let Ok(parsed) = value.parse::<usize>()
    {
        return parsed;
    }
    MAX_TOTAL_TRANSFERS
}

pub struct FunctionInterproc {
    pub output: SolveOutput,
    pub lowered: LoweredFunction,
    pub status: &'static str,
}

pub struct InterprocResult {
    pub functions: BTreeMap<String, FunctionInterproc>,
    pub status: &'static str,
    pub scc_count: usize,
    pub recursive_sccs: usize,
    pub rounds_max: usize,
    pub budget_exhausted: bool,
    /// Symbols the work budget could not reach; published as an explicit
    /// frontier rather than silently missing facts (D19).
    pub frontier_symbols: Vec<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct CallEdge {
    targets: BTreeSet<String>,
}

/// One calling context of a callee: (caller symbol, callsite op, actual
/// argument values observed at that callsite).
#[derive(Clone, Debug)]
struct CallingContext {
    caller: String,
    op: u32,
    args: Vec<Value>,
}

impl PartialEq for CallingContext {
    fn eq(&self, other: &Self) -> bool {
        // Abstract NaN is a stable value even though f64 NaN != itself.
        solve::context_key("", &self.caller, self.op, &self.args)
            == solve::context_key("", &other.caller, other.op, &other.args)
    }
}

/// Iterative Kosaraju over the function-level call graph; components ordered
/// callees-first (reverse topological order of the condensation).
fn call_graph_components(
    call_graph: &BTreeMap<String, BTreeMap<u32, CallEdge>>,
    control: &ExecutionControl,
) -> Result<Vec<Vec<String>>, crate::Error> {
    let mut forward: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut reverse: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (caller, edges) in call_graph {
        control.checkpoint()?;
        let entry = forward.entry(caller.clone()).or_default();
        for edge in edges.values() {
            for target in &edge.targets {
                if call_graph.contains_key(target) {
                    entry.insert(target.clone());
                    reverse
                        .entry(target.clone())
                        .or_default()
                        .insert(caller.clone());
                }
            }
        }
        forward.entry(caller.clone()).or_default();
    }
    let mut seen = BTreeSet::new();
    let mut order: Vec<String> = Vec::new();
    for root in forward.keys() {
        let mut stack = vec![(root.clone(), false)];
        while let Some((node, finish)) = stack.pop() {
            control.checkpoint()?;
            if finish {
                order.push(node);
                continue;
            }
            if !seen.insert(node.clone()) {
                continue;
            }
            stack.push((node.clone(), true));
            for next in &forward[&node] {
                if !seen.contains(next) {
                    stack.push((next.clone(), false));
                }
            }
        }
    }
    let mut assigned: BTreeSet<String> = BTreeSet::new();
    let mut components: Vec<Vec<String>> = Vec::new();
    for root in order.into_iter().rev() {
        if assigned.contains(&root) {
            continue;
        }
        let mut component: Vec<String> = Vec::new();
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            control.checkpoint()?;
            if assigned.contains(&node) {
                continue;
            }
            assigned.insert(node.clone());
            component.push(node.clone());
            if let Some(parents) = reverse.get(&node) {
                stack.extend(parents.iter().cloned());
            }
        }
        // Callees first inside the working order: reverse of the finish order
        // of the reversed graph gives callee-before-caller components.
        components.push(component);
    }
    components.reverse();
    Ok(components)
}

fn summary(output: &SolveOutput) -> Summary {
    Summary {
        returns: Some(output.internal.returns.clone()),
        throws: Some(output.internal.throws.clone()),
        effects: Some(output.internal.effects.clone()),
        written: Some(output.internal.written.clone()),
    }
}

fn observed_graph(
    outputs: &BTreeMap<String, SolveOutput>,
) -> BTreeMap<String, BTreeMap<u32, CallEdge>> {
    outputs
        .iter()
        .map(|(symbol, output)| {
            (
                symbol.clone(),
                output
                    .internal
                    .callsites
                    .iter()
                    .map(|(op, obs)| {
                        (
                            *op,
                            CallEdge {
                                targets: obs.targets.iter().cloned().collect(),
                            },
                        )
                    })
                    .collect(),
            )
        })
        .collect()
}

fn derive_contexts(
    outputs: &BTreeMap<String, SolveOutput>,
    functions: &BTreeMap<String, &FlowFunction>,
    control: &ExecutionControl,
) -> Result<BTreeMap<String, Vec<CallingContext>>, crate::Error> {
    let mut contexts: BTreeMap<String, Vec<CallingContext>> = BTreeMap::new();
    for (caller, output) in outputs {
        control.checkpoint()?;
        if output.status != "complete_within_profile" {
            continue;
        }
        for (op, obs) in &output.internal.callsites {
            if obs.unknown_component || obs.targets.len() != 1 {
                continue;
            }
            let target = &obs.targets[0];
            if functions
                .get(target)
                .is_none_or(|function| function.params.is_empty())
            {
                continue;
            }
            let Some(args) = solve::context_arguments(&obs.args) else {
                continue;
            };
            let list = contexts.entry(target.clone()).or_default();
            // Iteration is already in caller/op order. A precision cap falls
            // back to the symbolic summary, never truncates possible values.
            if list.len() < MAX_CONTEXTS_PER_FUNCTION {
                list.push(CallingContext {
                    caller: caller.clone(),
                    op: *op,
                    args,
                });
            }
        }
    }
    Ok(contexts)
}

fn component_fingerprint(
    component: &[String],
    summaries: &BTreeMap<String, Summary>,
    contexts: &BTreeMap<String, Vec<CallingContext>>,
) -> String {
    let mut fingerprints = Vec::new();
    for symbol in component {
        fingerprints.push((
            symbol.clone(),
            summaries.get(symbol).map(Summary::fingerprint),
        ));
        if let Some(list) = contexts.get(symbol) {
            for ctx in list {
                if let Some(key) = solve::context_key(symbol, &ctx.caller, ctx.op, &ctx.args) {
                    fingerprints.push((key.clone(), summaries.get(&key).map(Summary::fingerprint)));
                }
            }
        }
    }
    format!("{fingerprints:?}")
}

/// Compatibility entry for callers that specify a deadline only.
pub fn analyze_interprocedural(
    flow: &FlowFacts,
    directory: &BTreeMap<String, String>,
    deadline: Option<std::time::Instant>,
) -> Result<InterprocResult, crate::Error> {
    analyze_interprocedural_controlled(flow, directory, &ExecutionControl::new(deadline))
}

pub fn analyze_interprocedural_controlled(
    flow: &FlowFacts,
    directory: &BTreeMap<String, String>,
    control: &ExecutionControl,
) -> Result<InterprocResult, crate::Error> {
    analyze_with_budget(flow, directory, control, max_total_transfers_budget())
}

fn analyze_with_budget(
    flow: &FlowFacts,
    directory: &BTreeMap<String, String>,
    control: &ExecutionControl,
    total_limit: usize,
) -> Result<InterprocResult, crate::Error> {
    control.checkpoint()?;
    let functions_by_symbol: BTreeMap<String, &FlowFunction> = flow
        .functions
        .iter()
        .map(|function| (function.symbol.clone(), function))
        .collect();
    let mut lowered: BTreeMap<String, LoweredFunction> = BTreeMap::new();
    for function in &flow.functions {
        control.checkpoint()?;
        lowered.insert(function.symbol.clone(), build_cfg(function)?);
    }
    let mut remaining = total_limit;
    let mut outputs: BTreeMap<String, SolveOutput> = BTreeMap::new();
    let mut summaries = BTreeMap::new();
    let empty = BTreeMap::new();
    let mut incomplete: Option<(&'static str, &'static str)> = None;
    // The first pass is included in the same job-wide operation budget. It
    // uses no ordering-dependent partially constructed callee summary map.
    for function in &flow.functions {
        control.checkpoint()?;
        if remaining == 0 {
            incomplete = Some(("partial_budget", "interprocedural_work_budget_exhausted"));
            break;
        }
        let output = solve::solve_controlled(
            &lowered[&function.symbol],
            function,
            directory,
            &empty,
            control,
            None,
            remaining,
        );
        remaining -= output.budgets.get("transfers").copied().unwrap_or(0);
        control.checkpoint()?;
        let partial = output.status != "complete_within_profile";
        summaries.insert(function.symbol.clone(), summary(&output));
        outputs.insert(function.symbol.clone(), output);
        if partial {
            incomplete = Some(("partial_budget", "local_work_budget_exhausted"));
            break;
        }
    }
    let mut graph = observed_graph(&outputs);
    let mut contexts = derive_contexts(&outputs, &functions_by_symbol, control)?;
    let mut scc_count = 0;
    let mut recursive_sccs = 0;
    let mut rounds_max = 0;
    let mut graph_stable = flow.functions.is_empty();
    'graph: for _ in 0..MAX_GRAPH_ROUNDS {
        control.checkpoint()?;
        if incomplete.is_some() {
            break;
        }
        let components = call_graph_components(&graph, control)?;
        scc_count = components.len();
        recursive_sccs = components
            .iter()
            .filter(|component| {
                component.len() > 1
                    || graph[&component[0]]
                        .values()
                        .any(|edge| edge.targets.contains(&component[0]))
            })
            .count();
        for component in &components {
            let mut stabilized = false;
            for round in 1..=MAX_SCC_ROUNDS {
                control.checkpoint()?;
                rounds_max = rounds_max.max(round);
                let before = component_fingerprint(component, &summaries, &contexts);
                for symbol in component {
                    control.checkpoint()?;
                    if remaining == 0 {
                        incomplete =
                            Some(("partial_budget", "interprocedural_work_budget_exhausted"));
                        break 'graph;
                    }
                    let function = functions_by_symbol[symbol];
                    let output = solve::solve_controlled(
                        &lowered[symbol],
                        function,
                        directory,
                        &summaries,
                        control,
                        None,
                        remaining,
                    );
                    remaining -= output.budgets.get("transfers").copied().unwrap_or(0);
                    control.checkpoint()?;
                    let partial = output.status != "complete_within_profile";
                    summaries.insert(symbol.clone(), summary(&output));
                    outputs.insert(symbol.clone(), output);
                    if partial {
                        incomplete = Some(("partial_budget", "local_work_budget_exhausted"));
                        break 'graph;
                    }
                    if let Some(list) = contexts.get(symbol) {
                        for ctx in list {
                            control.checkpoint()?;
                            if remaining == 0 {
                                incomplete = Some((
                                    "partial_budget",
                                    "interprocedural_work_budget_exhausted",
                                ));
                                break 'graph;
                            }
                            let seeds = context_seeds(function, &ctx.args);
                            let output = solve::solve_controlled(
                                &lowered[symbol],
                                function,
                                directory,
                                &summaries,
                                control,
                                Some(&seeds),
                                remaining,
                            );
                            remaining -= output.budgets.get("transfers").copied().unwrap_or(0);
                            control.checkpoint()?;
                            if output.status != "complete_within_profile" {
                                incomplete =
                                    Some(("partial_budget", "context_work_budget_exhausted"));
                                break 'graph;
                            }
                            let key = solve::context_key(symbol, &ctx.caller, ctx.op, &ctx.args)
                                .expect("validated scalar context");
                            summaries.insert(key, summary(&output));
                        }
                    }
                }
                if before == component_fingerprint(component, &summaries, &contexts) {
                    stabilized = true;
                    break;
                }
            }
            if !stabilized {
                incomplete = Some(("partial_recursion", "interprocedural_fixpoint_not_reached"));
                break 'graph;
            }
        }
        let next_graph = observed_graph(&outputs);
        let next_contexts = derive_contexts(&outputs, &functions_by_symbol, control)?;
        graph_stable = graph == next_graph && contexts == next_contexts;
        graph = next_graph;
        contexts = next_contexts;
        // Retired callsites or changed arguments must not leave a stale
        // specialized summary eligible for a later solve.
        let active_keys: BTreeSet<String> = contexts
            .iter()
            .flat_map(|(callee, list)| {
                list.iter()
                    .filter_map(|ctx| solve::context_key(callee, &ctx.caller, ctx.op, &ctx.args))
            })
            .collect();
        summaries
            .retain(|key, _| functions_by_symbol.contains_key(key) || active_keys.contains(key));
        if graph_stable {
            break;
        }
    }
    if incomplete.is_none() && !graph_stable {
        incomplete = Some((
            "partial_recursion",
            "interprocedural_graph_context_round_limit",
        ));
    }
    // Reuse the final fixed-point outputs. An extra uncharged solve here used
    // to bypass the total budget. Missing functions get zero-work partial
    // records, keeping the coverage denominator and explicit frontier intact.
    let mut functions = BTreeMap::new();
    let mut frontier_symbols = Vec::new();
    for function in &flow.functions {
        control.checkpoint()?;
        let cfg = lowered.remove(&function.symbol).expect("cached CFG");
        let solved = outputs.remove(&function.symbol);
        let missing = solved.is_none();
        let mut output = solved.unwrap_or_else(|| {
            solve::solve_controlled(&cfg, function, directory, &empty, control, None, 0)
        });
        if let Some((status, reason)) = incomplete {
            // FIXED(V-09): `incomplete` is a job-level event (it is only ever
            // set immediately before a `break`). It used to be stamped onto
            // every function *with its original reason*, so a function that
            // converged in 5 of 120 transfers reported
            // `local_work_budget_exhausted` -- a false statement about itself.
            //
            // Every function does stay incomplete: the interruption may happen
            // in the interprocedural phase, so any summary this function
            // consumed can be off its fixed point. Per AL-08/W04 a pending
            // summary is never a proof, so completeness cannot be claimed
            // here. Deciding exactly *which* functions are still trustworthy
            // needs the callee-summary read-set (V-04); until that exists,
            // stay conservative. What is fixed now is the attribution:
            // functions that solved fine on their own say so instead of
            // claiming a local budget they never exhausted.
            let self_incomplete = missing || output.status != "complete_within_profile";
            let attributed = if self_incomplete {
                reason
            } else {
                "job_interrupted_before_fixpoint"
            };
            // Only a function that was actually cut may claim an unprocessed
            // block; a converged one has no frontier to report.
            output.mark_incomplete(status, attributed, cfg.cfg.entry, self_incomplete);
            // V-09 (symbol level): `frontier_symbols` is documented as "symbols
            // the work budget could not reach" (see the field docs above). A
            // function that solved locally and was only interrupted at job
            // level *was* reached, so listing it made the set equal to every
            // symbol on any degradation -- no information. The job-level fact
            // is already carried honestly by `unknown_reasons` /
            // `returns.reasons`, which is what §26.4 asks to be separable.
            if self_incomplete {
                frontier_symbols.push(function.symbol.clone());
            }
        }
        output
            .budgets
            .insert("job_total_transfers".into(), total_limit - remaining);
        output
            .budgets
            .insert("job_max_transfers".into(), total_limit);
        output.budgets.insert(
            "max_contexts_per_function".into(),
            MAX_CONTEXTS_PER_FUNCTION,
        );
        output.budgets.insert(
            "scalar_contexts".into(),
            contexts.get(&function.symbol).map_or(0, Vec::len),
        );
        functions.insert(
            function.symbol.clone(),
            FunctionInterproc {
                status: output.status,
                output,
                lowered: cfg,
            },
        );
    }
    frontier_symbols.sort();
    control.checkpoint()?;
    Ok(InterprocResult {
        functions,
        status: incomplete
            .map(|(status, _)| status)
            .unwrap_or("complete_within_profile"),
        scc_count,
        recursive_sccs,
        rounds_max,
        budget_exhausted: incomplete.is_some_and(|(status, _)| status == "partial_budget"),
        frontier_symbols,
    })
}

fn context_seeds(function: &FlowFunction, args: &[Value]) -> Vec<(String, Value)> {
    function
        .params
        .iter()
        .enumerate()
        .map(|(index, binding)| {
            (
                binding.clone(),
                args.get(index)
                    .cloned()
                    .unwrap_or_else(solve::undefined_value),
            )
        })
        .collect()
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    #[test]
    fn truncated_frontier_names_real_pending_blocks_not_the_entry() {
        // V-11: the frontier of a budget-cut function has to name blocks that
        // were genuinely still queued. `mark_incomplete` used to backfill the
        // entry block whenever the frontier was empty, which is
        // indistinguishable from a real report -- and it is the same
        // fabrication the job-level fix removed one layer up.
        let leaf = atlas_contract::Stmt {
            start: 0,
            end: 1,
            kind: atlas_contract::StmtKind::Expression {
                expr: atlas_contract::Expr {
                    start: 0,
                    end: 1,
                    kind: atlas_contract::ExprKind::Const {
                        value: atlas_contract::ConstValue::Num { value: 1.0 },
                    },
                },
            },
        };
        let mut body = leaf;
        for _ in 0..4 {
            body = atlas_contract::Stmt {
                start: 0,
                end: 1,
                kind: atlas_contract::StmtKind::If {
                    cond: atlas_contract::Expr {
                        start: 0,
                        end: 1,
                        kind: atlas_contract::ExprKind::Const {
                            value: atlas_contract::ConstValue::Bool { value: true },
                        },
                    },
                    then_body: vec![body],
                    else_body: vec![],
                },
            };
        }
        let flow = FlowFacts {
            schema: atlas_contract::FLOW_SCHEMA.into(),
            snapshot_id: "test".into(),
            producer: "test".into(),
            profile: atlas_contract::FLOW_PROFILE.into(),
            diagnostics: vec![],
            functions: vec![FlowFunction {
                symbol: "branchy".into(),
                name: "branchy".into(),
                path: "test.js".into(),
                start: 0,
                end: 1,
                params: vec![],
                scopes: vec![],
                bindings: vec![],
                body: vec![body],
                captures: vec![],
                unknown_regions: vec![],
            }],
        };

        // D19: a function cut by its own budget must leave a frontier. Silent
        // truncation would hide that part of the CFG was never solved.
        //
        // This does NOT guard the `mark_incomplete` entry-block backfill. That
        // backfill only fires when the worklist is already empty, so a
        // genuinely cut function reports its real queue here either way -- the
        // assertion below was verified to stay green when the backfill is
        // reinstated. The backfill is guarded by the job-level assertion in
        // total_budget_includes_first_and_context_passes, which was verified to
        // go red when it is reinstated.
        // `run()` guarantees that `budget_exhausted` implies a non-empty
        // worklist: it either breaks before removing the block or puts the block
        // back. So a function cut by its own budget always has a frontier, and
        // this probe over several budgets is only looking for one that actually
        // cuts -- a single budget would be safe too, just less informative.
        let reported = [1usize, 2, 3, 5, 8].iter().find_map(|budget| {
            let result = analyze_with_budget(
                &flow,
                &BTreeMap::new(),
                &ExecutionControl::new(None),
                *budget,
            )
            .unwrap();
            let frontier = result.functions["branchy"].output.frontier.clone();
            (!frontier.is_empty()).then_some(frontier)
        });
        assert!(
            reported.is_some(),
            "a 4-deep branch cut by a small budget must report a non-empty frontier"
        );
    }

    #[test]
    fn mark_incomplete_backfill_is_controlled_by_the_caller() {
        // Proves the frontier assertions above are not vacuous: the same output
        // gains a frontier when the caller may claim an unprocessed block, and
        // does not when it may not. This is the cheap, parallel-safe half of the
        // reverse check; the environment hook `ATLAS_FORCE_ENTRY_BACKFILL` is
        // the half a reviewer can run by hand.
        let flow = FlowFacts {
            schema: atlas_contract::FLOW_SCHEMA.into(),
            snapshot_id: "test".into(),
            producer: "test".into(),
            profile: atlas_contract::FLOW_PROFILE.into(),
            diagnostics: vec![],
            functions: vec![FlowFunction {
                symbol: "f0".into(),
                name: "f0".into(),
                path: "test.js".into(),
                start: 0,
                end: 1,
                params: vec![],
                scopes: vec![],
                bindings: vec![],
                body: vec![atlas_contract::Stmt {
                    start: 0,
                    end: 1,
                    kind: atlas_contract::StmtKind::Return {
                        value: Some(atlas_contract::Expr {
                            start: 0,
                            end: 1,
                            kind: atlas_contract::ExprKind::Const {
                                value: atlas_contract::ConstValue::Num { value: 1.0 },
                            },
                        }),
                    },
                }],
                captures: vec![],
                unknown_regions: vec![],
            }],
        };
        let mut result =
            analyze_with_budget(&flow, &BTreeMap::new(), &ExecutionControl::new(None), 0).unwrap();
        let mut output = result.functions.remove("f0").unwrap().output;
        output.frontier.clear();
        output.mark_incomplete("partial_budget", "unit_hook", 7, false);
        assert!(
            output.frontier.is_empty(),
            "a function that converged must not claim an unprocessed block"
        );
        output.mark_incomplete("partial_budget", "unit_hook", 7, true);
        assert_eq!(
            output.frontier,
            vec![7],
            "a function that was cut may name the block it stopped at"
        );
    }

    #[test]
    fn total_budget_includes_context_passes() {
        // The sibling test named "…and context passes" never actually ran one,
        // because its fixture has no calls. This one does: f1 calls f0 with a
        // scalar argument, which is what triggers a per-callsite context solve.
        let call_f0 = atlas_contract::Stmt {
            start: 0,
            end: 1,
            kind: atlas_contract::StmtKind::Return {
                value: Some(atlas_contract::Expr {
                    start: 0,
                    end: 1,
                    kind: atlas_contract::ExprKind::Call {
                        callee: Box::new(atlas_contract::Expr {
                            start: 0,
                            end: 1,
                            kind: atlas_contract::ExprKind::FunctionRef {
                                symbol: "f0".into(),
                            },
                        }),
                        args: vec![atlas_contract::Expr {
                            start: 0,
                            end: 1,
                            kind: atlas_contract::ExprKind::Const {
                                value: atlas_contract::ConstValue::Num { value: 1.0 },
                            },
                        }],
                        optional: false,
                    },
                }),
            },
        };
        let flow = FlowFacts {
            schema: atlas_contract::FLOW_SCHEMA.into(),
            snapshot_id: "test".into(),
            producer: "test".into(),
            profile: atlas_contract::FLOW_PROFILE.into(),
            diagnostics: vec![],
            functions: vec![
                FlowFunction {
                    symbol: "f0".into(),
                    name: "f0".into(),
                    path: "test.js".into(),
                    start: 0,
                    end: 1,
                    params: vec!["f0:p0".into()],
                    scopes: vec![],
                    bindings: vec![],
                    body: vec![atlas_contract::Stmt {
                        start: 0,
                        end: 1,
                        kind: atlas_contract::StmtKind::Return {
                            value: Some(atlas_contract::Expr {
                                start: 0,
                                end: 1,
                                kind: atlas_contract::ExprKind::Local {
                                    binding: "f0:p0".into(),
                                },
                            }),
                        },
                    }],
                    captures: vec![],
                    unknown_regions: vec![],
                },
                FlowFunction {
                    symbol: "f1".into(),
                    name: "f1".into(),
                    path: "test.js".into(),
                    start: 0,
                    end: 1,
                    params: vec![],
                    scopes: vec![],
                    bindings: vec![],
                    body: vec![call_f0],
                    captures: vec![],
                    unknown_regions: vec![],
                },
            ],
        };
        let result =
            analyze_with_budget(&flow, &BTreeMap::new(), &ExecutionControl::new(None), 500)
                .unwrap();
        assert_eq!(
            result.functions["f0"].output.budgets["scalar_contexts"], 1,
            "f0 is called from one callsite with a scalar argument, so exactly \
             one context must have been solved -- otherwise the context pass is \
             not running and its cost is not in the job budget"
        );
        assert!(
            result.functions["f1"].output.internal.read.contains("f0"),
            "f1 consumes f0's summary",
        );
        assert!(
            result.functions["f0"].output.budgets["job_total_transfers"] <= 500,
            "the context pass must still be bounded by the job budget"
        );
    }

    /// Renamed. The old name promised that context passes were covered, but the
    /// fixture here is three call-free one-op returns, so no context solve ever
    /// runs -- the name was a claim the test did not make true. See
    /// `total_budget_includes_context_passes` for the real coverage.
    #[test]
    fn job_budget_is_bounded_and_attribution_matches_state() {
        let flow = FlowFacts {
            schema: atlas_contract::FLOW_SCHEMA.into(),
            snapshot_id: "test".into(),
            producer: "test".into(),
            profile: atlas_contract::FLOW_PROFILE.into(),
            diagnostics: vec![],
            functions: (0..3)
                .map(|index| FlowFunction {
                    symbol: format!("f{index}"),
                    name: format!("f{index}"),
                    path: "test.js".into(),
                    start: 0,
                    end: 1,
                    params: vec![],
                    scopes: vec![],
                    bindings: vec![],
                    body: vec![atlas_contract::Stmt {
                        start: 0,
                        end: 1,
                        kind: atlas_contract::StmtKind::Return {
                            value: Some(atlas_contract::Expr {
                                start: 0,
                                end: 1,
                                kind: atlas_contract::ExprKind::Const {
                                    value: atlas_contract::ConstValue::Num {
                                        value: index as f64,
                                    },
                                },
                            }),
                        },
                    }],
                    captures: vec![],
                    unknown_regions: vec![],
                })
                .collect(),
        };
        for budget in [0, 1, 3, 5] {
            let result = analyze_with_budget(
                &flow,
                &BTreeMap::new(),
                &ExecutionControl::new(None),
                budget,
            )
            .unwrap();
            assert_eq!(result.status, "partial_budget");
            assert_eq!(result.functions.len(), 3);
            let mut job_only_seen = false;
            for (symbol, function) in &result.functions {
                assert!(function.output.budgets["job_total_transfers"] <= budget);
                // Still partial: the job may have been cut during the
                // interprocedural phase, so a consumed summary can be off its
                // fixed point and completeness must not be claimed.
                assert_eq!(function.output.status, "partial_budget");
                assert!(function.output.returns.unknown);
                // V-04: these are one-op returns that consume no callee summary,
                // so the read set must stay empty. Guards against recording
                // dependencies that were never actually read.
                assert!(
                    function.output.internal.read.is_empty(),
                    "budget {budget}: {symbol} consumes no summary, so its read \
                     set must be empty"
                );

                let job_only = function
                    .output
                    .unknown_reasons
                    .contains("job_interrupted_before_fixpoint");
                job_only_seen |= job_only;

                // V-09 (symbol level): frontier membership and attribution must
                // agree. A function that solved locally and was only interrupted
                // at job level *was* reached, so it belongs in neither the
                // symbol frontier nor a claim of unprocessed work.
                assert_eq!(
                    result.frontier_symbols.contains(symbol),
                    !job_only,
                    "budget {budget}: {symbol} -- symbol frontier membership \
                     disagrees with its attribution"
                );
                // V-09 (block level): a converged function has no unprocessed
                // block to name. Asserting `!frontier.is_empty()` for every
                // function would freeze the old fabricated entry-block claim.
                if job_only {
                    assert!(
                        function.output.frontier.is_empty(),
                        "budget {budget}: {symbol} converged, so it must not \
                         claim an unprocessed block"
                    );
                } else {
                    // `run()` only sets `budget_exhausted` while the interrupted
                    // block is still on the worklist, so a function that was
                    // genuinely cut always has something to report.
                    assert!(
                        !function.output.frontier.is_empty(),
                        "budget {budget}: {symbol} was cut, so its worklist was \
                         non-empty and it must report a frontier"
                    );
                }
            }
            // Emptying the symbol frontier must not make the degradation
            // silent: if nothing is unreached, the job-level fact has to
            // survive as an attribution.
            assert!(
                !result.frontier_symbols.is_empty() || job_only_seen,
                "budget {budget}: job is partial but no signal survives"
            );
            // V-09: attribution has to match the function's own state. These
            // are one-op returns, so whenever the job reaches them they solve
            // well inside the budget -- they must never claim a local budget
            // they did not exhaust. (They are still partial: the job may have
            // been cut during the interprocedural phase, so any summary they
            // consumed can be off its fixed point.)
            if budget >= 3 {
                for (symbol, function) in &result.functions {
                    assert!(
                        !function
                            .output
                            .unknown_reasons
                            .contains("local_work_budget_exhausted"),
                        "budget {budget}: {symbol} solved within its own budget, so \
                         reporting local_work_budget_exhausted is a forged attribution"
                    );
                }
            }
        }
    }
}

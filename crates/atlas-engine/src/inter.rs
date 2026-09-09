//! Interprocedural summaries (W04).
//!
//! One symbolic summary per local function: origins may reference
//! `Parameter(i)`, which callers re-base with their actual arguments at each
//! callsite, so returns never stream across callers. The call graph comes from
//! the local solves' observed callee targets; SCCs are processed in reverse
//! topological order with bounded inner iteration for cycles. Budget stops are
//! reported as partial; a pending summary is never read as "no return".
use crate::flow::{LoweredFunction, build_cfg};
use crate::solve::{self, MAX_TRANSFERS, SolveInternal, SolveOutput, Summary};
use atlas_contract::FlowFacts;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_SCC_ROUNDS: usize = 32;
/// Bounded rescheduling rounds for graphs that grow through summary
/// substitution (M1).
pub const MAX_GRAPH_ROUNDS: usize = 4;
pub const MAX_TOTAL_TRANSFERS: usize = MAX_TRANSFERS * 8;

/// Test/debug hook for the whole-job work budget (see max_transfers_budget).
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

/// Run local solves, build the observed call graph, then refine with symbolic
/// summaries in SCC order. Returns final outputs with interprocedural values.
pub fn analyze_interprocedural(
    flow: &FlowFacts,
    directory: &BTreeMap<String, String>,
    deadline: Option<std::time::Instant>,
) -> Result<InterprocResult, crate::Error> {
    let expired = |deadline: Option<std::time::Instant>| {
        deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline)
    };
    if expired(deadline) {
        return Err(crate::invalid(
            "analysis_deadline_exceeded_no_analysis_published",
        ));
    }
    let mut lowered: BTreeMap<String, LoweredFunction> = BTreeMap::new();
    for function in &flow.functions {
        if expired(deadline) {
            return Err(crate::invalid(
                "analysis_deadline_exceeded_no_analysis_published",
            ));
        }
        lowered.insert(function.symbol.clone(), build_cfg(function)?);
    }
    let empty = BTreeMap::new();
    // Pass 1: local solves collect callsite observations for the call graph.
    let mut call_graph: BTreeMap<String, BTreeMap<u32, CallEdge>> = BTreeMap::new();
    let mut first_outputs: BTreeMap<String, SolveInternal> = BTreeMap::new();
    let mut total_transfers = 0usize;
    for function in &flow.functions {
        if expired(deadline) {
            return Err(crate::invalid(
                "analysis_deadline_exceeded_no_analysis_published",
            ));
        }
        let cfg = &lowered[function.symbol.as_str()];
        let output = solve::solve(cfg, function, directory, &empty, deadline);
        total_transfers += output.budgets.get("transfers").copied().unwrap_or(0);
        let mut edges: BTreeMap<u32, CallEdge> = BTreeMap::new();
        for (op, obs) in &output.internal.callsites {
            edges.insert(
                *op,
                CallEdge {
                    targets: obs.targets.iter().cloned().collect(),
                },
            );
        }
        call_graph.insert(function.symbol.clone(), edges);
        first_outputs.insert(function.symbol.clone(), extract_internal(&output.internal));
    }
    let mut summaries: BTreeMap<String, Summary> = BTreeMap::new();
    for (symbol, internal) in &first_outputs {
        summaries.insert(
            symbol.clone(),
            Summary {
                returns: Some(internal.returns.clone()),
                throws: Some(internal.throws.clone()),
                effects: Some(internal.effects.clone()),
                written: Some(internal.written.clone()),
            },
        );
    }
    let work_budget_exhausted =
        std::cell::Cell::new(total_transfers > max_total_transfers_budget());
    // M1: when summaries substitute argument values, callee target sets can
    // GROW (e.g. `const f = identity(one); f()`), adding call edges that the
    // pass-1 graph did not have. Re-derive the graph from the last solves and
    // re-run the SCC fixpoint until the graph stabilizes (bounded rounds).
    let mut graph = call_graph;
    let mut final_outputs = first_outputs.clone();
    let mut scc_count = 0usize;
    let mut recursive_sccs = 0usize;
    let mut rounds_max = 0usize;
    let budget_exhausted = std::cell::Cell::new(false);
    let mut status_by_symbol: BTreeMap<String, &'static str> = BTreeMap::new();
    for _reschedule_round in 0..MAX_GRAPH_ROUNDS {
        let order = call_graph_components(&graph);
        scc_count = order.len();
        for component in &order {
            let cyclic = component.len() > 1 || {
                let member = &component[0];
                graph[member.as_str()]
                    .values()
                    .any(|edge| edge.targets.contains(member))
            };
            if cyclic {
                recursive_sccs += 1;
            }
            let mut rounds = 0usize;
            let mut stabilized = false;
            // Bounded iteration inside SCCs; monotone summaries plus finite caps
            // guarantee convergence, the round cap only guards pathological size.
            for round in 1..=MAX_SCC_ROUNDS {
                rounds = round;
                let before: BTreeMap<String, String> = summaries
                    .iter()
                    .filter(|(symbol, _)| component.contains(symbol))
                    .map(|(symbol, summary)| (symbol.clone(), summary.fingerprint()))
                    .collect();
                for symbol in component {
                    if expired(deadline) {
                        return Err(crate::invalid(
                            "analysis_deadline_exceeded_no_analysis_published",
                        ));
                    }
                    if work_budget_exhausted.get() {
                        status_by_symbol.insert(symbol.clone(), "partial_budget");
                        continue;
                    }
                    let Some(function) = flow.functions.iter().find(|f| &f.symbol == symbol) else {
                        continue;
                    };
                    let cfg = &lowered[symbol.as_str()];
                    let output = solve::solve(cfg, function, directory, &summaries, deadline);
                    total_transfers += output.budgets.get("transfers").copied().unwrap_or(0);
                    if total_transfers > max_total_transfers_budget() {
                        work_budget_exhausted.set(true);
                    }
                    let internal = extract_internal(&output.internal);
                    final_outputs.insert(symbol.clone(), internal.clone());
                    // New edges discovered through summary substitution re-enter
                    // the graph for the next rescheduling round.
                    let mut edges: BTreeMap<u32, CallEdge> = BTreeMap::new();
                    for (op, obs) in &internal.callsites {
                        edges.insert(
                            *op,
                            CallEdge {
                                targets: obs.targets.iter().cloned().collect(),
                            },
                        );
                    }
                    graph.insert(symbol.clone(), edges);
                    let updated = Summary {
                        returns: Some(internal.returns.clone()),
                        throws: Some(internal.throws.clone()),
                        effects: Some(internal.effects.clone()),
                        written: Some(internal.written.clone()),
                    };
                    let merged = match summaries.get(symbol.as_str()) {
                        Some(existing) => existing.merge(&updated),
                        None => updated.clone(),
                    };
                    summaries.insert(symbol.clone(), merged);
                    status_by_symbol.insert(symbol.clone(), output.status);
                }
                let after: BTreeMap<String, String> = summaries
                    .iter()
                    .filter(|(symbol, _)| component.contains(symbol))
                    .map(|(symbol, summary)| (symbol.clone(), summary.fingerprint()))
                    .collect();
                if before == after {
                    stabilized = true;
                    break;
                }
            }
            rounds_max = rounds_max.max(rounds);
            if !stabilized {
                for symbol in component {
                    status_by_symbol.insert(symbol.clone(), "partial_recursion");
                }
            }
        }
        // Graph stabilization check: a changed graph means a later solve observed
        // new callees; rerun the fixpoint with the updated ordering.
        let mut next_graph: BTreeMap<String, BTreeMap<u32, CallEdge>> = BTreeMap::new();
        for (symbol, internal) in &final_outputs {
            let mut edges: BTreeMap<u32, CallEdge> = BTreeMap::new();
            for (op, obs) in &internal.callsites {
                edges.insert(
                    *op,
                    CallEdge {
                        targets: obs.targets.iter().cloned().collect(),
                    },
                );
            }
            next_graph.insert(symbol.clone(), edges);
        }
        let graph_changed = next_graph != graph;
        graph = next_graph;
        if !graph_changed {
            break;
        }
    }
    // Final pass: one solve per function with the converged summaries so the
    // served values include re-based interprocedural origins. Functions that
    // the work budget could not reach are reported as an explicit frontier
    // instead of silently disappearing (D19).
    let mut functions = BTreeMap::new();
    let mut frontier: Vec<String> = Vec::new();
    for function in &flow.functions {
        if expired(deadline) {
            return Err(crate::invalid(
                "analysis_deadline_exceeded_no_analysis_published",
            ));
        }
        let symbol = function.symbol.as_str();
        if work_budget_exhausted.get() && !final_outputs.contains_key(symbol) {
            frontier.push(symbol.to_string());
            continue;
        }
        let cfg = &lowered[symbol];
        let output = solve::solve(cfg, function, directory, &summaries, deadline);
        let status = match output.status {
            "partial_budget" => "partial_budget",
            other => status_by_symbol.get(symbol).copied().unwrap_or(other),
        };
        if status == "partial_budget" {
            budget_exhausted.set(true);
        }
        functions.insert(
            function.symbol.clone(),
            FunctionInterproc {
                output,
                lowered: lowered.remove(symbol).expect("cached cfg"),
                status,
            },
        );
    }
    frontier.sort();
    Ok(InterprocResult {
        functions,
        status: if budget_exhausted.get() {
            "partial_budget"
        } else {
            "complete_within_profile"
        },
        scc_count,
        recursive_sccs,
        rounds_max,
        budget_exhausted: budget_exhausted.get(),
        frontier_symbols: frontier,
    })
}

/// Iterative Kosaraju over the function-level call graph; components ordered
/// callees-first. Edge labels are ignored; unknown callees are not graph nodes.
fn call_graph_components(
    call_graph: &BTreeMap<String, BTreeMap<u32, CallEdge>>,
) -> Vec<Vec<String>> {
    let mut forward: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut reverse: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (caller, edges) in call_graph {
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
    }
    let mut seen = BTreeSet::new();
    let mut order: Vec<String> = Vec::new();
    for root in forward.keys() {
        let mut stack = vec![(root.clone(), false)];
        while let Some((node, finish)) = stack.pop() {
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
    components
}

fn extract_internal(internal: &SolveInternal) -> SolveInternal {
    SolveInternal {
        returns: internal.returns.clone(),
        throws: internal.throws.clone(),
        effects: internal.effects.clone(),
        written: internal.written.clone(),
        callsites: internal.callsites.clone(),
    }
}

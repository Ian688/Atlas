//! Derived flow facts: the serializable record stored per function and served
//! to CLI/HTTP consumers (W05).
use crate::flow::{OpKind, Term};
use crate::inter::FunctionInterproc;
use crate::solve::{self, BlockStateOut, completion_to_string, const_to_json, value_to_json};
use atlas_contract::FlowFunction;
use serde::Serialize;
use std::collections::BTreeMap;

pub const FACTS_KIND_FLOW: &str = "flow";

#[derive(Clone, Debug, Serialize)]
pub struct FunctionFlowFact {
    pub analysis_id: String,
    pub symbol: String,
    pub path: String,
    pub name: String,
    pub profile: String,
    pub algorithm: AlgorithmRef,
    pub status: String,
    /// Blocks whose results remain incomplete; never an execution trace.
    pub frontier: Vec<u32>,
    pub ops: Vec<OpOut>,
    pub blocks: Vec<BlockOut>,
    pub entry: u32,
    pub exit_normal: u32,
    pub exit_exceptional: u32,
    pub exception_edges: Vec<(u32, u32)>,
    pub looping_blocks: Vec<u32>,
    pub pruned_edges: Vec<PrunedEdgeOut>,
    pub block_states: Vec<BlockStateJson>,
    pub def_use: Vec<DefUseJson>,
    pub returns: solve::ValueJson,
    pub throws: solve::ValueJson,
    pub effects: EffectsJson,
    pub unknown_reasons: Vec<String>,
    pub coverage: BTreeMap<String, usize>,
    pub budgets: BTreeMap<String, usize>,
    /// binding id -> short name, for consumers.
    pub binding_names: BTreeMap<String, String>,
    pub binding_kinds: BTreeMap<String, String>,
    /// Runtime import local names. Reading one of these is module state, not a
    /// global the caller would have to declare.
    #[serde(default)]
    pub imports: Vec<String>,
    pub interprocedural: InterprocJson,
}

#[derive(Clone, Debug, Serialize)]
pub struct InterprocJson {
    pub status: String,
    pub summary_returns: solve::ValueJson,
    pub summary_throws: solve::ValueJson,
    pub summary_effects: EffectsJson,
    pub callsites: Vec<CallSiteJson>,
    pub scc_count: usize,
    pub recursive_sccs: usize,
    pub rounds_max: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallSiteJson {
    pub op: u32,
    pub start: usize,
    pub end: usize,
    pub label: String,
    pub targets: Vec<String>,
    /// True only when the target set is closed, complete, and non-empty.
    pub targets_complete: bool,
    pub unknown_component: bool,
    pub args: Vec<solve::ValueJson>,
    pub result: solve::ValueJson,
}

#[derive(Clone, Debug, Serialize)]
pub struct AlgorithmRef {
    pub id: String,
    pub version: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct OpOut {
    pub index: u32,
    pub kind: String,
    pub detail: String,
    pub start: usize,
    pub end: usize,
    pub may_throw: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct BlockOut {
    pub id: u32,
    pub term: String,
    pub successors: Vec<(u32, String)>,
    pub ops: Vec<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PrunedEdgeOut {
    pub cond: u32,
    pub to: u32,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct BlockStateJson {
    pub block: u32,
    pub completion: String,
    pub bindings: Vec<BindingStateJson>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct BindingStateJson {
    pub binding: String,
    pub name: String,
    pub init: String,
    pub defs: Vec<u32>,
    pub value: solve::ValueJson,
}

#[derive(Clone, Debug, Serialize)]
pub struct DefUseJson {
    pub binding: String,
    pub name: String,
    pub defs: Vec<u32>,
    pub uses: Vec<UseJson>,
}

#[derive(Clone, Debug, Serialize)]
pub struct UseJson {
    pub def: u32,
    pub uses: Vec<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct EffectsJson {
    pub may_call: Vec<String>,
    pub unknown_call: bool,
    pub may_throw: bool,
    pub may_write_heap: bool,
    pub may_read_heap: bool,
    pub may_access_global: bool,
    pub registers_callback: bool,
    pub escaped_local_value: bool,
}

fn op_label(kind: &OpKind) -> (String, String) {
    match kind {
        OpKind::Const(value) => (
            "const".into(),
            serde_json::to_string(&const_to_json(value)).unwrap_or_default(),
        ),
        OpKind::ReadLocal(binding) => ("read_local".into(), binding.clone()),
        OpKind::ReadExternal(name) => ("read_external".into(), name.clone()),
        OpKind::This => ("this".into(), String::new()),
        OpKind::FunctionRef(symbol) => ("function_ref".into(), symbol.clone()),
        OpKind::Binary { op, left, right } => {
            ("binary".into(), format!("{op} (op{left}, op{right})"))
        }
        OpKind::Unary { op, operand } => ("unary".into(), format!("{op} (op{operand})")),
        OpKind::AssignBinding {
            binding,
            value,
            compound,
        } => (
            "assign_binding".into(),
            format!(
                "{}{} <- op{}{}",
                binding,
                compound.as_deref().unwrap_or(""),
                value,
                if compound.is_some() {
                    " (compound)"
                } else {
                    ""
                }
            ),
        ),
        OpKind::PropertyRead {
            object,
            name,
            optional,
        } => (
            "property_read".into(),
            format!(
                "op{}.{}{}",
                object,
                name,
                if *optional { " (optional)" } else { "" }
            ),
        ),
        OpKind::PropertyWrite {
            object,
            name,
            value,
        } => (
            "property_write".into(),
            format!("op{}.{} <- op{}", object, name, value),
        ),
        OpKind::Call {
            callee,
            args,
            optional,
        } => (
            "call".into(),
            format!(
                "op{}({}){}",
                callee,
                args.iter()
                    .map(|a| format!("op{a}"))
                    .collect::<Vec<_>>()
                    .join(", "),
                if *optional { " (optional)" } else { "" }
            ),
        ),
        OpKind::New { callee, args } => (
            "new".into(),
            format!(
                "op{}({})",
                callee,
                args.iter()
                    .map(|a| format!("op{a}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ),
        OpKind::AllocObject { fields } => (
            "alloc_object".into(),
            fields
                .iter()
                .map(|(name, op)| format!("{name}: op{op}"))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        OpKind::AllocArray { elements } => {
            ("alloc_array".into(), format!("{} elements", elements.len()))
        }
        OpKind::CurrentException => ("current_exception".into(), String::new()),
        OpKind::SetCompletion { kind, value } => (
            "set_completion".into(),
            format!(
                "{:?}{}",
                kind,
                value.map(|v| format!(" (op{v})")).unwrap_or_default()
            ),
        ),
        OpKind::CaseTest { disc, test } => ("case_test".into(), format!("op{disc} === op{test}")),
        OpKind::NullishTest { value } => ("nullish_test".into(), format!("op{value}")),
        OpKind::UnknownOp { reason } => ("unknown".into(), reason.clone()),
    }
}

/// Assemble the stored/served record from one lowered and solved function.
pub fn assemble_flow_fact(
    analysis_id: &str,
    function: &FlowFunction,
    solved: &FunctionInterproc,
    interproc_meta: (usize, usize, usize),
) -> FunctionFlowFact {
    let lowered = &solved.lowered;
    let output = &solved.output;
    let inter_callsites = &output.internal.callsites;
    let ops = lowered
        .ops
        .iter()
        .enumerate()
        .map(|(index, op)| {
            let (kind, detail) = op_label(&op.kind);
            OpOut {
                index: index as u32,
                kind,
                detail,
                start: op.start,
                end: op.end,
                may_throw: op.may_throw,
            }
        })
        .collect();
    let blocks = lowered
        .cfg
        .blocks
        .iter()
        .enumerate()
        .map(|(id, block)| {
            let (term, successors) = match &block.term {
                Term::Goto(target) => ("goto".into(), vec![(*target, "normal".into())]),
                Term::Branch {
                    if_true, if_false, ..
                } => (
                    "branch".into(),
                    vec![(*if_true, "true".into()), (*if_false, "false".into())],
                ),
                Term::Return { .. } => ("return".into(), vec![]),
                Term::Throw { .. } => ("throw".into(), vec![]),
                Term::Dispatch {
                    normal,
                    on_return,
                    on_throw,
                    breaks,
                    continues,
                } => {
                    let mut successors = vec![
                        (*normal, "finally_normal".into()),
                        (*on_return, "finally_return".into()),
                        (*on_throw, "finally_throw".into()),
                    ];
                    for (label, target, consumed) in breaks {
                        successors.push((
                            *target,
                            format!(
                                "finally_break({label:?}){}",
                                if *consumed { "" } else { "!" }
                            ),
                        ));
                    }
                    for (label, target, consumed) in continues {
                        successors.push((
                            *target,
                            format!(
                                "finally_continue({label:?}){}",
                                if *consumed { "" } else { "!" }
                            ),
                        ));
                    }
                    ("dispatch".into(), successors)
                }
                Term::Sink => ("sink".into(), vec![]),
            };
            BlockOut {
                id: id as u32,
                term,
                successors,
                ops: block.ops.clone(),
            }
        })
        .collect();
    let binding_names: BTreeMap<String, String> = function
        .bindings
        .iter()
        .map(|binding| (binding.id.clone(), binding.name.clone()))
        .collect();
    let binding_kinds: BTreeMap<String, String> = function
        .bindings
        .iter()
        .map(|binding| (binding.id.clone(), binding.kind.clone()))
        .collect();
    let short = |id: &str| {
        binding_names
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.to_string())
    };
    let block_states = output
        .block_states
        .iter()
        .map(|(block, state)| {
            let BlockStateOut {
                completion,
                bindings,
                truncated,
            } = state;
            let truncated = *truncated;
            BlockStateJson {
                block: *block,
                completion: completion_to_string(completion).to_string(),
                bindings: bindings
                    .iter()
                    .map(|(id, slot)| BindingStateJson {
                        binding: id.clone(),
                        name: short(id),
                        init: format!("{:?}", slot.init),
                        defs: slot.defs.iter().copied().collect(),
                        value: value_to_json(&slot.value),
                    })
                    .collect(),
                truncated,
            }
        })
        .collect();
    let def_use = output
        .def_use
        .iter()
        .map(|(binding, (defs, uses))| DefUseJson {
            binding: binding.clone(),
            name: short(binding),
            defs: defs.iter().copied().collect(),
            uses: uses
                .iter()
                .map(|(def, use_ops)| UseJson {
                    def: *def,
                    uses: use_ops.iter().copied().collect(),
                })
                .collect(),
        })
        .collect();
    FunctionFlowFact {
        analysis_id: analysis_id.to_string(),
        symbol: function.symbol.clone(),
        path: function.path.clone(),
        name: function.name.clone(),
        profile: atlas_contract::FLOW_PROFILE.into(),
        algorithm: AlgorithmRef {
            id: solve::ALGORITHM_ID.into(),
            version: solve::ALGORITHM_VERSION.into(),
        },
        status: output.status.into(),
        frontier: output.frontier.clone(),
        ops,
        blocks,
        entry: lowered.cfg.entry,
        exit_normal: lowered.cfg.exit_normal,
        exit_exceptional: lowered.cfg.exit_exceptional,
        exception_edges: lowered.cfg.exception_edges.clone(),
        looping_blocks: lowered.cfg.looping_blocks.iter().copied().collect(),
        pruned_edges: output
            .pruned_edges
            .iter()
            .map(|(cond, to, reason)| PrunedEdgeOut {
                cond: *cond,
                to: *to,
                reason: reason.to_string(),
            })
            .collect(),
        block_states,
        def_use,
        returns: output.returns.clone(),
        throws: output.throws.clone(),
        effects: EffectsJson {
            may_call: output.effects.may_call.clone(),
            unknown_call: output.effects.unknown_call,
            may_throw: output.effects.may_throw,
            may_write_heap: output.effects.may_write_heap,
            may_read_heap: output.effects.may_read_heap,
            may_access_global: output.effects.may_access_global,
            registers_callback: output.effects.registers_callback,
            escaped_local_value: output.effects.escaped_local_value,
        },
        unknown_reasons: output.unknown_reasons.iter().cloned().collect(),
        coverage: output.coverage.clone(),
        budgets: output.budgets.clone(),
        binding_names,
        binding_kinds,
        imports: function.imports.clone(),
        interprocedural: {
            let callsites = inter_callsites
                .iter()
                .map(|(op, obs)| {
                    let op_data = &lowered.ops[*op as usize];
                    let (_, detail) = op_label(&op_data.kind);
                    let targets_complete = !obs.unknown_component && !obs.targets.is_empty();
                    CallSiteJson {
                        op: *op,
                        start: op_data.start,
                        end: op_data.end,
                        label: detail,
                        targets: obs.targets.clone(),
                        targets_complete,
                        unknown_component: obs.unknown_component,
                        args: obs.args.iter().map(value_to_json).collect(),
                        result: obs.result.as_ref().map(value_to_json).unwrap_or_else(|| {
                            solve::ValueJson {
                                constants: vec![],
                                typed: vec![],
                                targets: vec![],
                                origins: vec![],
                                unknown: true,
                                reasons: vec!["callsite_result_unobserved".into()],
                            }
                        }),
                    }
                })
                .collect();
            InterprocJson {
                status: solved.status.into(),
                summary_returns: value_to_json(&output.internal.returns),
                summary_throws: value_to_json(&output.internal.throws),
                summary_effects: EffectsJson {
                    may_call: output.internal.effects.may_call.iter().cloned().collect(),
                    unknown_call: output.internal.effects.unknown_call,
                    may_throw: output.internal.effects.may_throw,
                    may_write_heap: output.internal.effects.may_write_heap,
                    may_read_heap: output.internal.effects.may_read_heap,
                    may_access_global: output.internal.effects.may_access_global,
                    registers_callback: output.internal.effects.registers_callback,
                    escaped_local_value: output.internal.effects.escaped_local_value,
                },
                callsites,
                scc_count: interproc_meta.0,
                recursive_sccs: interproc_meta.1,
                rounds_max: interproc_meta.2,
            }
        },
    }
}

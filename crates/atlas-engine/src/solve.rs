//! Local abstract interpretation over the CFG (W03).
//!
//! Dimensions per §AL-06: reachability, binding environment with
//! initialization states, capped constant/target/origin sets, a flat abstract
//! heap with weak updates by default, effects, and the pending completion.
//! The worklist terminates by bounded lattice height plus explicit budgets;
//! budget exits are reported as `partial_budget` with a frontier, never as
//! negative proofs. JS operator semantics (NaN, `+` concatenation, division by
//! zero) follow the declared folding rules below.
use crate::flow::{BlockId, CompletionKind, LoweredFunction, MAX_OPS_PER_FUNCTION, OpKind, Term};
use atlas_contract::{ConstValue, FlowFunction};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

pub const ALGORITHM_ID: &str = "atlas-local-absint";
pub const ALGORITHM_VERSION: &str = "0.1.0";
pub const CAP_CONSTANTS: usize = 8;
pub const CAP_TARGETS: usize = 64;
pub const CAP_ORIGINS: usize = 8;
pub const CAP_HEAP: usize = 32;
/// Visits before a block's joined state is widened. Arrival waves per block
/// are bounded by value-set growth waves; deeply layered control flow (e.g.
/// dozens of nested finallys) must converge inside this budget instead of
/// re-transferring exponentially many path combinations.
pub const MAX_BLOCK_VISITS: usize = 48;
pub const MAX_TRANSFERS: usize = 300_000;
pub const MAX_OP_VALUES: usize = 2048;
pub const MAX_LISTED_BINDINGS: usize = 64;
/// Bounded transitive reachability steps for unknown-call heap invalidation.
pub const CAP_CLOBBER_REACH: usize = 64;

/// Binding id -> (definition ops, per-def use sites).
pub type DefUseMap = BTreeMap<String, (BTreeSet<u32>, BTreeMap<u32, BTreeSet<u32>>)>;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Origin {
    Parameter(usize),
    Constant,
    CallResult(u32),
    Allocation(u32),
    FunctionValue(u32),
    External(String),
    Capture(String),
    Derived(u32),
    Exception(u32),
    This,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Value {
    constants: Vec<ConstValue>,
    targets: Vec<String>,
    origins: Vec<Origin>,
    unknown: bool,
    reasons: BTreeSet<String>,
}

impl Value {
    fn top(reason: impl Into<String>) -> Self {
        Self {
            constants: Vec::new(),
            targets: Vec::new(),
            origins: Vec::new(),
            unknown: true,
            reasons: BTreeSet::from([reason.into()]),
        }
    }

    fn constant(value: ConstValue) -> Self {
        Self {
            constants: vec![value],
            targets: Vec::new(),
            origins: vec![Origin::Constant],
            unknown: false,
            reasons: BTreeSet::new(),
        }
    }

    fn with_origins(mut self, mut origins: Vec<Origin>) -> Self {
        origins.append(&mut self.origins);
        self.origins = cap_origins(origins, &mut self.unknown, &mut self.reasons);
        self
    }

    fn merge(&self, other: &Value) -> Value {
        let mut unknown = self.unknown || other.unknown;
        let mut reasons = self.reasons.clone();
        reasons.extend(other.reasons.iter().cloned());
        let mut constants = self.constants.clone();
        for value in &other.constants {
            if !constants.contains(value) {
                constants.push(value.clone());
            }
        }
        if constants.len() > CAP_CONSTANTS {
            constants.clear();
            unknown = true;
            reasons.insert("cap_exceeded:constants".into());
        }
        let mut targets = self.targets.clone();
        for target in &other.targets {
            if !targets.contains(target) {
                targets.push(target.clone());
            }
        }
        if targets.len() > CAP_TARGETS {
            targets.clear();
            unknown = true;
            reasons.insert("cap_exceeded:targets".into());
        }
        let origins = cap_origins(
            self.origins
                .iter()
                .chain(other.origins.iter())
                .cloned()
                .collect(),
            &mut unknown,
            &mut reasons,
        );
        Value {
            constants,
            targets,
            origins,
            unknown,
            reasons,
        }
    }

    fn single_constant(&self) -> Option<&ConstValue> {
        if !self.unknown && self.constants.len() == 1 {
            self.constants.first()
        } else {
            None
        }
    }

    fn truthiness(&self) -> Option<bool> {
        self.single_constant().map(js_truthiness)
    }

    fn is_nullish(&self) -> Option<bool> {
        match self.single_constant() {
            Some(ConstValue::Null | ConstValue::Undefined) => Some(true),
            Some(_) => Some(false),
            None => None,
        }
    }
}

fn cap_origins(
    origins: Vec<Origin>,
    unknown: &mut bool,
    reasons: &mut BTreeSet<String>,
) -> Vec<Origin> {
    let mut unique: Vec<Origin> = Vec::new();
    for origin in origins {
        if !unique.contains(&origin) {
            unique.push(origin);
        }
    }
    if unique.len() > CAP_ORIGINS {
        unknown_flag(unknown, reasons, "cap_exceeded:origins");
        return Vec::new();
    }
    unique
}

fn unknown_flag(unknown: &mut bool, reasons: &mut BTreeSet<String>, reason: &str) {
    *unknown = true;
    reasons.insert(reason.to_string());
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Init {
    Initialized,
    NotInitialized,
    MaybeInitialized,
}

impl Init {
    fn join(self, other: Init) -> Init {
        match (self, other) {
            (Init::Initialized, Init::Initialized) => Init::Initialized,
            (Init::NotInitialized, Init::NotInitialized) => Init::NotInitialized,
            _ => Init::MaybeInitialized,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Slot {
    pub(crate) value: Value,
    pub(crate) init: Init,
    /// Reaching definition op indices for this binding.
    pub(crate) defs: BTreeSet<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completion {
    Normal,
    Return,
    Throw,
    Break(usize),
    Continue(usize),
    Multiple,
}

#[derive(Clone, Debug)]
pub(crate) struct State {
    pub(crate) env: BTreeMap<String, Slot>,
    /// (allocation site, field) -> value. Sites are op indices; `"*"` is the
    /// wildcard heap written by unknown objects.
    heap: BTreeMap<(String, String), Value>,
    /// Pending completion value (return/throw payload).
    completion_value: Option<Value>,
    completion: Completion,
    thrown: Option<Value>,
    op_values: BTreeMap<u32, Value>,
    effects: Effects,
    /// Heap entries this state has WRITTEN (not merely read), keyed like
    /// `heap`. `"param{i}"` sites denote writes through parameter objects so
    /// callers can re-base them onto actual arguments.
    written: BTreeMap<(String, String), Value>,
}

#[derive(Clone, Debug, Default)]
pub struct Effects {
    pub(crate) may_call: BTreeSet<String>,
    pub(crate) unknown_call: bool,
    pub(crate) may_throw: bool,
    pub(crate) may_write_heap: bool,
    pub(crate) may_read_heap: bool,
    pub(crate) may_access_global: bool,
    pub(crate) registers_callback: bool,
    pub(crate) escaped_local_value: bool,
}

impl Effects {
    fn join(&self, other: &Effects) -> Effects {
        let mut may_call = self.may_call.clone();
        may_call.extend(other.may_call.iter().cloned());
        Effects {
            may_call,
            unknown_call: self.unknown_call || other.unknown_call,
            may_throw: self.may_throw || other.may_throw,
            may_write_heap: self.may_write_heap || other.may_write_heap,
            may_read_heap: self.may_read_heap || other.may_read_heap,
            may_access_global: self.may_access_global || other.may_access_global,
            registers_callback: self.registers_callback || other.registers_callback,
            escaped_local_value: self.escaped_local_value || other.escaped_local_value,
        }
    }
}

fn join_states(a: &State, b: &State) -> State {
    let mut env = a.env.clone();
    for (key, slot) in &b.env {
        match env.get_mut(key) {
            Some(existing) => {
                let mut defs = existing.defs.clone();
                defs.extend(slot.defs.iter().copied());
                *existing = Slot {
                    value: existing.value.merge(&slot.value),
                    init: existing.init.join(slot.init),
                    defs,
                };
            }
            None => {
                env.insert(key.clone(), slot.clone());
            }
        }
    }
    let mut heap = a.heap.clone();
    for (key, value) in &b.heap {
        match heap.get_mut(key) {
            Some(existing) => *existing = existing.merge(value),
            None => {
                heap.insert(key.clone(), value.clone());
            }
        }
    }
    if heap.len() > CAP_HEAP {
        // Merge everything into the wildcard field namespace.
        let mut wildcard: BTreeMap<String, Value> = BTreeMap::new();
        for ((_, field), value) in heap.iter() {
            wildcard
                .entry(field.clone())
                .and_modify(|existing| *existing = existing.merge(value))
                .or_insert_with(|| value.clone());
        }
        heap = wildcard
            .into_iter()
            .map(|(field, value)| (("*".to_string(), field), value))
            .collect();
    }
    let mut op_values = a.op_values.clone();
    for (op, value) in &b.op_values {
        match op_values.get_mut(op) {
            Some(existing) => *existing = existing.merge(value),
            None => {
                op_values.insert(*op, value.clone());
            }
        }
    }
    if op_values.len() > MAX_OP_VALUES {
        let keep: BTreeSet<u32> = op_values
            .keys()
            .rev()
            .take(MAX_OP_VALUES / 2)
            .copied()
            .collect();
        op_values.retain(|op, _| keep.contains(op));
    }
    let completion = if a.completion == b.completion {
        a.completion
    } else {
        Completion::Multiple
    };
    let completion_value = match (&a.completion_value, &b.completion_value) {
        (Some(x), Some(y)) => Some(x.merge(y)),
        (Some(x), None) | (None, Some(x)) => {
            let mut merged = x.clone();
            merged.unknown = true;
            merged.reasons.insert("completion_value_partial".into());
            Some(merged)
        }
        (None, None) => None,
    };
    // Monotone join: None means "no exception observed on this path" and is
    // the bottom element; mixing Some with None conservatively yields an
    // unknown exception. A non-monotone merge here livelocks the worklist.
    let thrown = match (&a.thrown, &b.thrown) {
        (Some(x), Some(y)) => Some(x.merge(y)),
        (Some(x), None) => Some(x.merge(&Value::top("exception_value_unknown"))),
        (None, Some(y)) => Some(y.merge(&Value::top("exception_value_unknown"))),
        (None, None) => None,
    };
    let mut written = a.written.clone();
    for (key, value) in &b.written {
        match written.get_mut(key) {
            Some(existing) => *existing = existing.merge(value),
            None => {
                written.insert(key.clone(), value.clone());
            }
        }
    }
    State {
        env,
        heap,
        completion_value,
        completion,
        thrown,
        op_values,
        effects: a.effects.join(&b.effects),
        written,
    }
}

struct Solver<'a> {
    lowered: &'a LoweredFunction,
    function: &'a FlowFunction,
    /// op index -> enclosing block, for loop-allocation weakening.
    block_of_op: Vec<BlockId>,
    exception_by_block: BTreeMap<BlockId, Vec<(u32, BlockId)>>,
    states: BTreeMap<BlockId, Option<State>>,
    queue: BTreeSet<BlockId>,
    visits: BTreeMap<BlockId, usize>,
    transfers: usize,
    budget_exhausted: bool,
    current_defs: BTreeMap<String, BTreeSet<u32>>,
    /// binding id -> symbol of the function that binding denotes (module peers).
    function_directory: &'a BTreeMap<String, String>,
    /// Pipeline deadline; a breach stops this function's work early and is
    /// reported through `budget_exhausted` (R5).
    deadline: Option<std::time::Instant>,
    /// Ops whose values later blocks read (short-circuit temps, switch
    /// discriminants): the only op values retained across block boundaries.
    cross_block_operands: &'a BTreeSet<u32>,
    has_return: bool,
    has_throw: bool,
    /// Last observed value per exit block; joined once at finish (not across
    /// worklist iterations, which would retain stale early states).
    return_values: BTreeMap<BlockId, Value>,
    throw_values: BTreeMap<BlockId, Value>,
    block_effects: BTreeMap<BlockId, Effects>,
    block_written: BTreeMap<BlockId, BTreeMap<(String, String), Value>>,
    pub def_use: DefUseMap,
    pub pruned_edges: Vec<(u32, BlockId, &'static str)>,
    unknown_reasons: BTreeSet<String>,
    supported_ops: usize,
    unknown_ops: usize,
    /// Callee summaries from the interprocedural fixpoint (empty = disabled).
    summaries: &'a BTreeMap<String, Summary>,
    /// Ops that allocate object literals: their field sets are known, so a
    /// missing key read is a known undefined instead of an unknown shape.
    object_literal_sites: BTreeSet<u32>,
    /// Observed callsites, overwritten per transfer like exit values.
    callsites: BTreeMap<u32, CallSiteObs>,
}

pub struct SolveOutput {
    pub status: &'static str,
    pub block_states: BTreeMap<BlockId, BlockStateOut>,
    pub frontier: Vec<BlockId>,
    pub def_use: DefUseMap,
    pub pruned_edges: Vec<(u32, BlockId, &'static str)>,
    pub returns: ValueJson,
    pub throws: ValueJson,
    pub effects: EffectsJsonOut,
    pub unknown_reasons: BTreeSet<String>,
    pub coverage: BTreeMap<String, usize>,
    pub budgets: BTreeMap<String, usize>,
    /// Internal interprocedural view (symbolic values, not JSON-projected).
    pub internal: SolveInternal,
}

/// Non-serialized payloads the interprocedural driver consumes.
#[derive(Clone)]
pub struct SolveInternal {
    pub returns: Value,
    pub throws: Value,
    pub effects: Effects,
    pub written: BTreeMap<(String, String), Value>,
    pub callsites: BTreeMap<u32, CallSiteObs>,
}

pub struct BlockStateOut {
    pub completion: Completion,
    pub bindings: Vec<(String, Slot)>,
    pub truncated: bool,
}

/// Public effect summary for fact assembly.
#[derive(Clone, Debug, Default)]
pub struct EffectsJsonOut {
    pub may_call: Vec<String>,
    pub unknown_call: bool,
    pub may_throw: bool,
    pub may_write_heap: bool,
    pub may_read_heap: bool,
    pub may_access_global: bool,
    pub registers_callback: bool,
    pub escaped_local_value: bool,
}

/// Structural equality of two states (Value carries f64 so Eq is manual).
fn states_equal(a: &State, b: &State) -> bool {
    a.completion == b.completion
        && a.completion_value.as_ref().map(value_fingerprint)
            == b.completion_value.as_ref().map(value_fingerprint)
        && a.thrown.as_ref().map(value_fingerprint) == b.thrown.as_ref().map(value_fingerprint)
        && a.env.len() == b.env.len()
        && a.env.iter().all(|(key, slot)| {
            b.env.get(key).map(|other| {
                slot.init == other.init
                    && slot.defs == other.defs
                    && value_fingerprint(&slot.value) == value_fingerprint(&other.value)
            }) == Some(true)
        })
        && a.heap.len() == b.heap.len()
        && a.heap.iter().all(|(key, value)| {
            b.heap
                .get(key)
                .map(|other| value_fingerprint(value) == value_fingerprint(other))
                == Some(true)
        })
        && a.op_values.len() == b.op_values.len()
        && a.op_values.iter().all(|(op, value)| {
            b.op_values
                .get(op)
                .map(|other| value_fingerprint(value) == value_fingerprint(other))
                == Some(true)
        })
        && a.effects.may_call == b.effects.may_call
        && a.effects.unknown_call == b.effects.unknown_call
        && a.effects.may_throw == b.effects.may_throw
        && a.effects.may_write_heap == b.effects.may_write_heap
        && a.effects.may_read_heap == b.effects.may_read_heap
        && a.effects.may_access_global == b.effects.may_access_global
        && a.effects.registers_callback == b.effects.registers_callback
        && a.effects.escaped_local_value == b.effects.escaped_local_value
}

fn value_fingerprint(value: &Value) -> String {
    let mut text = String::new();
    for constant in &value.constants {
        match constant {
            ConstValue::Num { value: n } => text.push_str(&format!("n{}", n.to_bits())),
            ConstValue::Str { value: s } => text.push_str(&format!("s{s}")),
            ConstValue::Bool { value: b } => text.push_str(&format!("b{b}")),
            ConstValue::Null => text.push('0'),
            ConstValue::Undefined => text.push('u'),
        }
    }
    text.push('|');
    for target in &value.targets {
        text.push_str(target);
        text.push(',');
    }
    text.push('|');
    for origin in &value.origins {
        text.push_str(&format!("{origin:?}"));
        text.push(',');
    }
    if value.unknown {
        text.push_str("|unknown:");
        for reason in &value.reasons {
            text.push_str(reason);
            text.push(',');
        }
    }
    text
}

pub fn solve(
    lowered: &LoweredFunction,
    function: &FlowFunction,
    function_directory: &BTreeMap<String, String>,
    summaries: &BTreeMap<String, Summary>,
    deadline: Option<std::time::Instant>,
) -> SolveOutput {
    let block_of_op: Vec<BlockId> = {
        let mut map = vec![0u32; lowered.ops.len()];
        for (index, block) in lowered.cfg.blocks.iter().enumerate() {
            for op in &block.ops {
                if (*op as usize) < map.len() {
                    map[*op as usize] = index as BlockId;
                }
            }
        }
        map
    };
    let mut cross_block_operands: BTreeSet<u32> = BTreeSet::new();
    {
        let mut note_refs = |op_index: usize, kind: &OpKind| {
            let mut refs: Vec<u32> = Vec::new();
            match kind {
                OpKind::Binary { left, right, .. }
                | OpKind::CaseTest {
                    disc: left,
                    test: right,
                } => {
                    refs.push(*left);
                    refs.push(*right);
                }
                OpKind::Unary { operand, .. } | OpKind::NullishTest { value: operand } => {
                    refs.push(*operand);
                }
                OpKind::AssignBinding { value, .. } => refs.push(*value),
                OpKind::PropertyRead { object, .. } => refs.push(*object),
                OpKind::PropertyWrite { object, value, .. } => {
                    refs.push(*object);
                    refs.push(*value);
                }
                OpKind::Call { callee, args, .. } | OpKind::New { callee, args } => {
                    refs.push(*callee);
                    refs.extend(args.iter().copied());
                }
                OpKind::AllocObject { fields } => {
                    refs.extend(fields.iter().map(|(_, value)| *value));
                }
                OpKind::AllocArray { elements } => refs.extend(elements.iter().copied()),
                OpKind::SetCompletion {
                    value: Some(value), ..
                } => refs.push(*value),
                _ => {}
            }
            for reference in refs {
                if block_of_op.get(reference as usize).copied()
                    != block_of_op.get(op_index).copied()
                {
                    cross_block_operands.insert(reference);
                }
            }
        };
        for (index, op) in lowered.ops.iter().enumerate() {
            note_refs(index, &op.kind);
        }
        for block in &lowered.cfg.blocks {
            match &block.term {
                Term::Branch { cond, .. } => {
                    cross_block_operands.insert(*cond);
                }
                Term::Return { value: Some(value) }
                | Term::Throw {
                    value: Some(value), ..
                } => {
                    cross_block_operands.insert(*value);
                }
                _ => {}
            }
        }
    }
    let mut exception_by_block: BTreeMap<BlockId, Vec<(u32, BlockId)>> = BTreeMap::new();
    for (op, handler) in &lowered.cfg.exception_edges {
        let block = block_of_op.get(*op as usize).copied().unwrap_or(0);
        exception_by_block
            .entry(block)
            .or_default()
            .push((*op, *handler));
    }
    let mut solver = Solver {
        lowered,
        function,
        block_of_op,
        exception_by_block,
        states: BTreeMap::new(),
        queue: BTreeSet::from([lowered.cfg.entry]),
        visits: BTreeMap::new(),
        transfers: 0,
        budget_exhausted: false,
        current_defs: BTreeMap::new(),
        def_use: BTreeMap::new(),
        pruned_edges: Vec::new(),
        function_directory,
        cross_block_operands: &cross_block_operands,
        deadline,
        unknown_reasons: BTreeSet::new(),
        supported_ops: 0,
        unknown_ops: 0,
        summaries,
        object_literal_sites: lowered
            .ops
            .iter()
            .enumerate()
            .filter(|(_, op)| matches!(op.kind, OpKind::AllocObject { .. }))
            .map(|(index, _)| index as u32)
            .collect(),
        callsites: BTreeMap::new(),
        has_return: false,
        has_throw: false,
        return_values: BTreeMap::new(),
        throw_values: BTreeMap::new(),
        block_effects: BTreeMap::new(),
        block_written: BTreeMap::new(),
    };
    solver.seed_entry();
    solver.run();
    solver.finish()
}

impl<'a> Solver<'a> {
    fn seed_entry(&mut self) {
        let mut env = BTreeMap::new();
        for (index, param) in self.function.params.iter().enumerate() {
            let mut value = Value {
                constants: Vec::new(),
                targets: Vec::new(),
                origins: vec![Origin::Parameter(index)],
                unknown: false,
                reasons: BTreeSet::new(),
            };
            // An argument may be `undefined`, activating the parameter default.
            if self
                .function
                .bindings
                .iter()
                .any(|b| &b.id == param && b.default_value.is_some())
            {
                value = value.merge(&Value::constant(ConstValue::Undefined));
            }
            env.insert(
                param.clone(),
                Slot {
                    value,
                    init: Init::Initialized,
                    defs: BTreeSet::new(),
                },
            );
        }
        // Local `let`/`const` bindings start uninitialized (TDZ) in the entry block.
        for binding in &self.function.bindings {
            if matches!(binding.kind.as_str(), "let" | "const")
                && !self.function.captures.contains(&binding.id)
            {
                env.insert(
                    binding.id.clone(),
                    Slot {
                        value: Value::top("value_not_yet_assigned"),
                        init: Init::NotInitialized,
                        defs: BTreeSet::new(),
                    },
                );
            }
        }
        let entry = self.lowered.cfg.entry;
        self.states.insert(
            entry,
            Some(State {
                env,
                heap: BTreeMap::new(),
                completion_value: None,
                completion: Completion::Normal,
                thrown: None,
                op_values: BTreeMap::new(),
                effects: Effects::default(),
                written: BTreeMap::new(),
            }),
        );
    }

    fn run(&mut self) {
        while let Some(block) = self.queue.iter().next().copied() {
            self.queue.remove(&block);
            if self.transfers >= MAX_TRANSFERS
                || self
                    .deadline
                    .is_some_and(|deadline| std::time::Instant::now() >= deadline)
            {
                self.budget_exhausted = true;
                break;
            }
            let Some(Some(input)) = self.states.get(&block).cloned() else {
                continue;
            };
            let visits = self.visits.entry(block).or_default();
            *visits += 1;
            let widen = *visits > MAX_BLOCK_VISITS;
            let (out, at_throw) =
                self.transfer_block(block, &input, widen, self.cross_block_operands);
            self.block_effects.insert(block, out.effects.clone());
            self.block_written.insert(block, out.written.clone());
            self.propagate(block, &out, &at_throw);
        }
    }

    fn note_unknown(&mut self, reason: &str) {
        self.unknown_reasons.insert(reason.to_string());
    }

    fn value_of(&self, state: &State, op: u32) -> Value {
        state
            .op_values
            .get(&op)
            .cloned()
            .unwrap_or_else(|| Value::top("operand_value_unavailable"))
    }

    fn record_def(&mut self, binding: &str, def: u32) {
        self.def_use
            .entry(binding.to_string())
            .or_default()
            .0
            .insert(def);
    }

    fn record_use(&mut self, binding: &str, use_op: u32) {
        let defs: Vec<u32> = self
            .current_defs
            .get(binding)
            .map(|defs| defs.iter().copied().collect())
            .unwrap_or_default();
        if defs.is_empty() {
            return;
        }
        let entry = self.def_use.entry(binding.to_string()).or_default();
        for def in defs {
            entry.1.entry(def).or_default().insert(use_op);
        }
    }

    /// Returns the block output plus, for every may-throw op, the state as of
    /// just before that op executed. Exception successors must observe this
    /// pre-state: assignments after the throwing operation have not happened
    /// on the exceptional path, and side effects before it have.
    fn transfer_block(
        &mut self,
        block: BlockId,
        input: &State,
        widen: bool,
        cross_block_operands: &BTreeSet<u32>,
    ) -> (State, BTreeMap<u32, State>) {
        let mut state = input.clone();
        if widen {
            for slot in state.env.values_mut() {
                if !slot.value.constants.is_empty() {
                    slot.value.constants.clear();
                    unknown_flag(
                        &mut slot.value.unknown,
                        &mut slot.value.reasons,
                        "widened_loop_value",
                    );
                }
            }
        }
        self.current_defs = state
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.defs.clone()))
            .collect();
        // Most operand values are consumed within the block that produced
        // them; carrying every historical op value across blocks made state
        // joins and clones quadratic memory traffic without any consumer.
        // Only ops referenced from other blocks (e.g. short-circuit skip-path
        // writes and switch discriminants) are retained.
        state
            .op_values
            .retain(|op, _| cross_block_operands.contains(op));
        let block_ops = self.lowered.cfg.blocks[block as usize].ops.clone();
        let mut at_throw: BTreeMap<u32, State> = BTreeMap::new();
        for op_index in block_ops {
            self.transfers += 1;
            if self.transfers >= MAX_TRANSFERS {
                self.budget_exhausted = true;
                break;
            }
            let may_throw = self.lowered.ops[op_index as usize].may_throw;
            self.transfer_op(&mut state, op_index);
            if may_throw {
                // Exception successors observe the state AFTER the throwing
                // operation: its own effects (calls may write heap/state
                // before throwing) are real, while LATER operations in the
                // block have not executed (R1/F3).
                let mut post = state.clone();
                post.completion = Completion::Normal;
                post.completion_value = None;
                at_throw.insert(op_index, post);
            }
        }
        (state, at_throw)
    }

    fn transfer_op(&mut self, state: &mut State, op_index: u32) {
        let op = self.lowered.ops[op_index as usize].clone();
        let result: Option<Value> = match &op.kind {
            OpKind::Const(value) => Some(Value::constant(value.clone())),
            OpKind::ReadLocal(binding) => {
                self.record_use(binding, op_index);
                match state.env.get(binding).cloned() {
                    Some(slot) => {
                        if slot.init == Init::NotInitialized {
                            self.note_unknown("tdz_read_possible_reference_error");
                            state.effects.may_throw = true;
                            Some(Value::top("tdz_read"))
                        } else {
                            Some(slot.value)
                        }
                    }
                    None => {
                        // Outer-scope (captured) or otherwise unseeded binding.
                        self.note_unknown("capture_or_untracked_binding_read");
                        match self.function_directory.get(binding) {
                            Some(symbol) => Some(Value {
                                constants: Vec::new(),
                                targets: vec![symbol.clone()],
                                origins: vec![Origin::Capture(binding.clone())],
                                unknown: false,
                                reasons: BTreeSet::from(["value_from_enclosing_scope".into()]),
                            }),
                            None => {
                                if std::env::var("ATLAS_DEBUG_SOLVE").is_ok() {
                                    eprintln!("[solve] untracked read: {binding} at op{op_index}");
                                }
                                Some(
                                    Value::top("untracked_binding")
                                        .with_origins(vec![Origin::Capture(binding.clone())]),
                                )
                            }
                        }
                    }
                }
            }
            OpKind::ReadExternal(name) => {
                state.effects.may_access_global = true;
                Some(
                    Value::top("external_value_unknown")
                        .with_origins(vec![Origin::External(name.clone())]),
                )
            }
            OpKind::This => Some(Value::top("receiver_unknown").with_origins(vec![Origin::This])),
            OpKind::FunctionRef(symbol) => Some(Value {
                constants: Vec::new(),
                targets: vec![symbol.clone()],
                origins: vec![Origin::FunctionValue(op_index)],
                unknown: false,
                reasons: BTreeSet::new(),
            }),
            OpKind::Binary { op, left, right } => {
                let lhs = self.value_of(state, *left);
                let rhs = self.value_of(state, *right);
                Some(fold_binary(state, op, &lhs, &rhs, op_index))
            }
            OpKind::Unary { op, operand } => {
                let value = self.value_of(state, *operand);
                Some(fold_unary(op, &value))
            }
            OpKind::AssignBinding {
                binding,
                value,
                compound,
            } => {
                self.record_use(binding, op_index);
                let mut new_value = self.value_of(state, *value);
                let previous = state.env.get(binding).cloned();
                if previous
                    .as_ref()
                    .is_some_and(|slot| slot.init == Init::NotInitialized)
                    && compound.is_some()
                {
                    self.note_unknown("tdz_compound_read");
                    state.effects.may_throw = true;
                }
                if let Some(compound) = compound {
                    let old = previous
                        .map(|slot| slot.value)
                        .unwrap_or_else(|| Value::top("compound_read_untracked"));
                    new_value = fold_binary(
                        state,
                        compound.trim_end_matches('='),
                        &old,
                        &new_value,
                        op_index,
                    );
                    if compound == "++" || compound == "--" {
                        new_value = Value::top("increment_result_unknown")
                            .with_origins(vec![Origin::Derived(op_index)]);
                    }
                }
                new_value = new_value.with_origins(vec![Origin::Derived(op_index)]);
                let defs: BTreeSet<u32> = BTreeSet::from([op_index]);
                self.record_def(binding, op_index);
                state.env.insert(
                    binding.clone(),
                    Slot {
                        value: new_value.clone(),
                        init: Init::Initialized,
                        defs,
                    },
                );
                self.current_defs
                    .insert(binding.clone(), BTreeSet::from([op_index]));
                Some(new_value)
            }
            OpKind::PropertyRead {
                object,
                name,
                optional,
            } => {
                let object_value = self.value_of(state, *object);
                state.effects.may_read_heap = true;
                if !*optional {
                    // A non-optional read may observe a getter: user code.
                    state
                        .effects
                        .may_call
                        .extend(self.may_call_targets(&object_value));
                    if object_value.unknown {
                        state.effects.unknown_call = true;
                        self.note_unknown("getter_on_unknown_object_possible");
                    }
                }
                // Every candidate object contributes its own read result: a
                // concrete field value when present, a known missing field
                // (object literal without that key) as undefined, and an
                // unknown shape/prototype as top. One candidate finding the
                // field must not erase another candidate's missing branch.
                let mut value = Value {
                    constants: Vec::new(),
                    targets: Vec::new(),
                    origins: vec![Origin::Derived(op_index)],
                    unknown: false,
                    reasons: BTreeSet::new(),
                };
                let mut possibilities = 0usize;
                for (origin, field_key) in site_keys(&object_value, name) {
                    if let Origin::Allocation(site) = origin {
                        if let Some(existing) = state.heap.get(&field_key) {
                            value = value.merge(existing);
                            possibilities += 1;
                        } else if self.object_literal_sites.contains(&site) {
                            // Known field set: the key is known missing here.
                            value = value.merge(&Value::constant(ConstValue::Undefined));
                            possibilities += 1;
                        } else {
                            value = value.merge(&Value::top("allocation_shape_unknown"));
                            possibilities += 1;
                        }
                    }
                }
                // Reads through a parameter object observe in-callee writes
                // recorded under the parameter key.
                for origin in &object_value.origins {
                    if let Origin::Parameter(index) = origin {
                        let param_key = (format!("param{index}"), name.clone());
                        if let Some(entry) = state
                            .heap
                            .get(&param_key)
                            .or_else(|| state.written.get(&param_key))
                        {
                            value = value.merge(entry);
                            possibilities += 1;
                        }
                    }
                }
                if let Some(wildcard) = state.heap.get(&("*".to_string(), name.clone())) {
                    value = value.merge(wildcard);
                    possibilities += 1;
                }
                if object_value.unknown {
                    // Unknown object shape or prototype chain: the read may
                    // still be a getter or inherited property.
                    value = value.merge(&Value::top("property_shape_unknown"));
                    possibilities += 1;
                }
                if possibilities == 0 {
                    value = value.merge(&Value::top("property_value_unknown"));
                }
                Some(value)
            }
            OpKind::PropertyWrite {
                object,
                name,
                value,
            } => {
                let object_value = self.value_of(state, *object);
                let written = self.value_of(state, *value);
                state.effects.may_write_heap = true;
                state
                    .effects
                    .may_call
                    .extend(self.may_call_targets(&object_value));
                if object_value.unknown {
                    state.effects.unknown_call = true;
                    self.note_unknown("setter_on_unknown_object_possible");
                }
                let sites = site_keys(&object_value, name);
                let unique_site = match (&object_value.origins.len(), object_value.origins.first())
                {
                    (1, Some(Origin::Allocation(site))) => Some(*site),
                    _ => None,
                };
                let strong = unique_site
                    .map(|site| {
                        !self
                            .lowered
                            .cfg
                            .looping_blocks
                            .contains(&self.block_of_op[site as usize])
                    })
                    .unwrap_or(false);
                if strong {
                    // Strong update: single concrete object proven outside loops.
                    if let Some((_, field_key)) = sites.first() {
                        state.heap.insert(field_key.clone(), written.clone());
                        state.written.insert(field_key.clone(), written.clone());
                    }
                } else {
                    // Writes through a parameter object are recorded under a
                    // parameter key so callers can re-base them onto the
                    // actual arguments (R2); unknown objects stay wildcard.
                    let param_origin =
                        object_value.origins.iter().find_map(|origin| match origin {
                            Origin::Parameter(index) => Some(*index),
                            _ => None,
                        });
                    if let Some(index) = param_origin.filter(|_| !object_value.unknown) {
                        let key = (format!("param{index}"), name.clone());
                        let merged = match state.written.get(&key) {
                            Some(existing) => existing.merge(&written),
                            None => written.clone(),
                        };
                        state.written.insert(key, merged);
                    } else {
                        // Weak update: merge into every candidate location.
                        for (_, field_key) in &sites {
                            let merged = match state.heap.get(field_key) {
                                Some(existing) => existing.merge(&written),
                                None => written.clone(),
                            };
                            state.heap.insert(field_key.clone(), merged);
                            let recorded = match state.written.get(field_key) {
                                Some(existing) => existing.merge(&written),
                                None => written.clone(),
                            };
                            state.written.insert(field_key.clone(), recorded);
                        }
                        let wildcard_key = ("*".to_string(), name.clone());
                        let merged = match state.heap.get(&wildcard_key) {
                            Some(existing) => existing.merge(&written),
                            None => written.clone(),
                        };
                        state.heap.insert(wildcard_key.clone(), merged);
                        let recorded = match state.written.get(&wildcard_key) {
                            Some(existing) => existing.merge(&written),
                            None => written.clone(),
                        };
                        state.written.insert(wildcard_key, recorded);
                        if object_value.unknown {
                            self.note_unknown("weak_heap_update_on_unknown_object");
                        }
                    }
                }
                if !written.targets.is_empty()
                    || written
                        .origins
                        .iter()
                        .any(|origin| matches!(origin, Origin::Allocation(_)))
                {
                    state.effects.escaped_local_value = true;
                }
                Some(written)
            }
            OpKind::Call { callee, args, .. } => {
                let callee_value = self.value_of(state, *callee);
                for target in &callee_value.targets {
                    state.effects.may_call.insert(target.clone());
                }
                let arg_values: Vec<Value> =
                    args.iter().map(|arg| self.value_of(state, *arg)).collect();
                let known_targets: Vec<&String> = callee_value
                    .targets
                    .iter()
                    .filter(|target| self.summaries.contains_key(*target))
                    .collect();
                let mut result = Value::top("call_result_unknown")
                    .with_origins(vec![Origin::CallResult(op_index)]);
                let mut summarized = false;
                if !callee_value.unknown
                    && !known_targets.is_empty()
                    && known_targets.len() == callee_value.targets.len()
                {
                    // Every target has a local summary: apply each, join, and
                    // fold the callees' effects into this state.
                    let mut joined: Option<Value> = None;
                    let mut callee_effects = Effects::default();
                    for target in &known_targets {
                        let summary = &self.summaries[target.as_str()];
                        if std::env::var("ATLAS_DEBUG_SOLVE").is_ok() {
                            eprintln!(
                                "[m1-call] op{op_index} args={:?} summary_returns={:?}",
                                arg_values
                                    .iter()
                                    .map(|v| (v.constants.clone(), v.origins.clone()))
                                    .collect::<Vec<_>>(),
                                summary
                                    .returns
                                    .as_ref()
                                    .map(|r| (r.constants.clone(), r.origins.clone()))
                            );
                        }
                        let applied = match &summary.returns {
                            Some(returns) => apply_summary_value(returns, &arg_values, op_index),
                            None => Value::top("callee_summary_pending")
                                .with_origins(vec![Origin::CallResult(op_index)]),
                        };
                        joined = Some(match joined {
                            Some(existing) => existing.merge(&applied),
                            None => applied,
                        });
                        if let Some(effects) = &summary.effects {
                            callee_effects = callee_effects.join(effects);
                        }
                    }
                    if let Some(joined) = joined {
                        result = joined;
                        summarized = true;
                        state.effects = state.effects.join(&callee_effects);
                    }
                }
                if callee_value.unknown || callee_value.targets.is_empty() {
                    state.effects.unknown_call = true;
                    self.note_unknown("unknown_callee_effects");
                }
                for value in &arg_values {
                    if !value.targets.is_empty() {
                        state.effects.registers_callback = true;
                    }
                    if state.effects.unknown_call && value.constants.is_empty() {
                        // An untyped argument passed into an unknown call may be
                        // a function value; registration stays possible.
                        state.effects.registers_callback = true;
                    }
                    if value
                        .origins
                        .iter()
                        .any(|origin| matches!(origin, Origin::Allocation(_)))
                    {
                        state.effects.escaped_local_value = true;
                    }
                    result.reasons.extend(value.reasons.iter().cloned());
                }
                if !summarized && !callee_value.unknown && !callee_value.targets.is_empty() {
                    result
                        .reasons
                        .insert("callee_summary_pending_interprocedural".into());
                }
                if summarized {
                    // Re-base the callees' recorded heap writes onto the
                    // actual arguments so later reads observe the call's
                    // write effects (R2).
                    for target in &known_targets {
                        if let Some(written) = &self.summaries[target.as_str()].written {
                            self.apply_summary_heap(state, written, &arg_values, op_index);
                        }
                    }
                }
                if state.effects.unknown_call {
                    // Unknown callees may modify any reachable object state;
                    // dissolve affected concrete entries into wildcard tops.
                    let arg_refs: Vec<Value> = arg_values.clone();
                    self.clobber_for_unknown_call(state, &arg_refs);
                }
                self.callsites.insert(
                    op_index,
                    CallSiteObs {
                        targets: callee_value.targets.clone(),
                        unknown_component: callee_value.unknown,
                        args: arg_values,
                        result: Some(result.clone()),
                    },
                );
                Some(result)
            }
            OpKind::New { .. } => {
                state.effects.unknown_call = true;
                self.note_unknown("constructor_effects_unknown");
                Some(Value {
                    constants: Vec::new(),
                    targets: Vec::new(),
                    origins: vec![Origin::Allocation(op_index)],
                    unknown: true,
                    reasons: BTreeSet::from(["constructed_object_fields_unknown".into()]),
                })
            }
            OpKind::AllocObject { fields } => {
                let in_loop = self
                    .lowered
                    .cfg
                    .looping_blocks
                    .contains(&self.block_of_op[op_index as usize]);
                let site = format!("op{op_index}");
                for (field_name, field_op) in fields {
                    let value = self.value_of(state, *field_op);
                    state.heap.insert((site.clone(), field_name.clone()), value);
                }
                if in_loop {
                    self.note_unknown("loop_allocation_site_multiple_objects");
                }
                Some(Value {
                    constants: Vec::new(),
                    targets: Vec::new(),
                    origins: vec![Origin::Allocation(op_index)],
                    unknown: false,
                    reasons: BTreeSet::new(),
                })
            }
            OpKind::AllocArray { .. } => Some(Value {
                constants: Vec::new(),
                targets: Vec::new(),
                origins: vec![Origin::Allocation(op_index)],
                unknown: false,
                reasons: BTreeSet::from(["array_elements_unknown".into()]),
            }),
            OpKind::CurrentException => Some(
                state
                    .thrown
                    .clone()
                    .unwrap_or_else(|| Value::top("exception_value_unknown"))
                    .with_origins(vec![Origin::Exception(op_index)]),
            ),
            OpKind::SetCompletion { kind, value } => {
                state.completion = match kind {
                    CompletionKind::Normal => Completion::Normal,
                    CompletionKind::Return => Completion::Return,
                    CompletionKind::Throw => Completion::Throw,
                    CompletionKind::Break(index) => Completion::Break(*index),
                    CompletionKind::Continue(index) => Completion::Continue(*index),
                };
                state.completion_value = value.as_ref().map(|value| self.value_of(state, *value));
                None
            }
            OpKind::CaseTest { disc, test } => {
                let lhs = self.value_of(state, *disc);
                let rhs = self.value_of(state, *test);
                match (lhs.single_constant(), rhs.single_constant()) {
                    (Some(lhs), Some(rhs)) => Some(Value::constant(ConstValue::Bool {
                        value: const_equals(lhs, rhs),
                    })),
                    _ => Some(
                        Value::top("case_test_unknown")
                            .with_origins(vec![Origin::Derived(op_index)]),
                    ),
                }
            }
            OpKind::NullishTest { value } => {
                let value = self.value_of(state, *value);
                match value.is_nullish() {
                    Some(nullish) => Some(Value::constant(ConstValue::Bool { value: nullish })),
                    None => Some(
                        Value::top("nullish_test_unknown")
                            .with_origins(vec![Origin::Derived(op_index)]),
                    ),
                }
            }
            OpKind::UnknownOp { reason } => {
                state.effects.unknown_call = true;
                state.effects.may_write_heap = true;
                state.effects.may_access_global = true;
                self.note_unknown(&format!("unmodeled_construct:{reason}"));
                Some(Value::top(reason).with_origins(vec![Origin::External("unmodeled".into())]))
            }
        };
        if op.may_throw {
            state.effects.may_throw = true;
        }
        match result {
            Some(value) => {
                state.op_values.insert(op_index, value);
                self.supported_ops += 1;
            }
            None => {
                self.unknown_ops += 0;
            }
        }
    }

    /// Best-known exception value for an op: known callee summaries contribute
    /// their throws; anything else stays an unknown exception value.
    fn thrown_value_for_op(&self, state: &State, op: u32) -> Value {
        if let OpKind::Call { callee, .. } = &self.lowered.ops[op as usize].kind {
            let callee_value = self.value_of(state, *callee);
            if !callee_value.unknown
                && !callee_value.targets.is_empty()
                && callee_value
                    .targets
                    .iter()
                    .all(|target| self.summaries.contains_key(target))
            {
                let mut joined: Option<Value> = None;
                for target in &callee_value.targets {
                    let summary = &self.summaries[target.as_str()];
                    if let Some(throws) = &summary.throws {
                        joined = Some(match joined {
                            Some(existing) => existing.merge(throws),
                            None => throws.clone(),
                        });
                    }
                }
                if let Some(joined) = joined {
                    return joined;
                }
            }
        }
        Value::top("exception_from_operation")
    }

    /// Conservative invalidation for operations whose write set is unknown:
    /// objects that escaped as arguments may have been modified, and every
    /// wildcard-reachable field may have been touched. Affected concrete
    /// entries dissolve into wildcard tops so later reads stay sound.
    /// Conservative invalidation for operations whose write set is unknown:
    /// every allocation site REACHABLE from escaped arguments (transitively
    /// through heap values, bounded) may have been modified, so its concrete
    /// entries dissolve into wildcard tops instead of being removed — a later
    /// read must observe unknown, never a confidently stale value (F4).
    fn clobber_for_unknown_call(&mut self, state: &mut State, arg_values: &[Value]) {
        let mut escaped_sites: BTreeSet<String> = BTreeSet::new();
        for value in arg_values {
            for origin in &value.origins {
                if let Origin::Allocation(site) = origin {
                    escaped_sites.insert(format!("op{site}"));
                }
            }
        }
        // Transitive reachability through heap entry values (bounded by the
        // heap budget; the heap itself is capped so this terminates).
        let mut pending: Vec<String> = escaped_sites.iter().cloned().collect();
        let mut visited: BTreeSet<String> = BTreeSet::new();
        let mut steps = 0usize;
        while let Some(site) = pending.pop() {
            if !visited.insert(site.clone()) {
                continue;
            }
            steps += 1;
            if steps > crate::solve::CAP_CLOBBER_REACH {
                self.note_unknown("clobber_reach_budget_exceeded");
                break;
            }
            let keys: Vec<(String, String)> = state
                .heap
                .keys()
                .filter(|(s, _)| s == &site)
                .cloned()
                .collect();
            for key in keys {
                let entry = state.heap.get(&key).cloned();
                let mut unknown_written = Value::top("unknown_call_may_modify");
                if let Some(existing) = entry {
                    // Child allocations reachable through this field value are
                    // escaped as well.
                    for origin in &existing.origins {
                        if let Origin::Allocation(child) = origin {
                            pending.push(format!("op{child}"));
                        }
                    }
                    unknown_written = unknown_written.merge(&existing);
                }
                // Replace (never remove): a known object-literal site whose
                // entry vanished would otherwise read as known-undefined.
                state.heap.insert(key, unknown_written);
            }
        }
        let wildcard_fields: Vec<String> = state
            .heap
            .keys()
            .filter(|(site, _)| site == "*")
            .map(|(_, field)| field.clone())
            .collect();
        for field in wildcard_fields {
            let wildcard_key = ("*".to_string(), field.clone());
            let unknown_written = Value::top("unknown_call_may_modify");
            let merged = match state.heap.get(&wildcard_key) {
                Some(existing) => existing.merge(&unknown_written),
                None => unknown_written,
            };
            state.heap.insert(wildcard_key, merged);
        }
    }

    /// Re-base a summarized callee's recorded heap writes onto this callsite's
    /// actual arguments and merge them into the caller's heap state.
    fn apply_summary_heap(
        &self,
        state: &mut State,
        written: &BTreeMap<(String, String), Value>,
        args: &[Value],
        op_index: u32,
    ) {
        for (key, value) in written {
            let (site, field) = key;
            let rebased = apply_summary_value(value, args, op_index);
            if site == "*" {
                let wildcard_key = ("*".to_string(), field.clone());
                let merged = match state.heap.get(&wildcard_key) {
                    Some(existing) => existing.merge(&rebased),
                    None => rebased.clone(),
                };
                state.heap.insert(wildcard_key, merged);
            } else if let Some(index) = site
                .strip_prefix("param")
                .and_then(|digits| digits.parse::<usize>().ok())
            {
                // The callee wrote through parameter {index}: re-base onto the
                // actual argument. A single known allocation site receives the
                // write on that site; anything else lands in the wildcard.
                let Some(actual) = args.get(index) else {
                    continue;
                };
                let mut applied = false;
                // A single known allocation site receives the write on that
                // site; a single parameter origin keeps the parameter identity
                // so the re-based write propagates through wrapper layers
                // (F2); anything else lands in the wildcard.
                if !actual.unknown
                    && actual.origins.len() == 1
                    && let Some(Origin::Allocation(site_op)) = actual.origins.first()
                    && !self
                        .lowered
                        .cfg
                        .looping_blocks
                        .contains(&self.block_of_op[*site_op as usize])
                {
                    let key = (format!("op{site_op}"), field.clone());
                    let merged = match state.heap.get(&key) {
                        Some(existing) => existing.merge(&rebased),
                        None => rebased.clone(),
                    };
                    state.heap.insert(key.clone(), merged);
                    let recorded = match state.written.get(&key) {
                        Some(existing) => existing.merge(&rebased),
                        None => rebased.clone(),
                    };
                    state.written.insert(key, recorded);
                    applied = true;
                } else if !actual.unknown
                    && actual.origins.len() == 1
                    && let Some(Origin::Parameter(inner)) = actual.origins.first()
                {
                    let key = (format!("param{inner}"), field.clone());
                    let merged = match state.written.get(&key) {
                        Some(existing) => existing.merge(&rebased),
                        None => rebased.clone(),
                    };
                    state.written.insert(key, merged);
                    applied = true;
                }
                if !applied {
                    let wildcard_key = ("*".to_string(), field.clone());
                    let merged = match state.heap.get(&wildcard_key) {
                        Some(existing) => existing.merge(&rebased),
                        None => rebased.clone(),
                    };
                    state.heap.insert(wildcard_key.clone(), merged);
                    let recorded = match state.written.get(&wildcard_key) {
                        Some(existing) => existing.merge(&rebased),
                        None => rebased.clone(),
                    };
                    state.written.insert(wildcard_key, recorded);
                }
            }
        }
    }

    fn may_call_targets(&self, value: &Value) -> BTreeSet<String> {
        value.targets.iter().cloned().collect()
    }

    fn propagate(&mut self, block: BlockId, out: &State, at_throw: &BTreeMap<u32, State>) {
        let term = self.lowered.cfg.blocks[block as usize].term.clone();
        match &term {
            Term::Goto(target) => self.send(*target, out.clone(), None),
            Term::Branch {
                cond,
                if_true,
                if_false,
            } => {
                let cond_value = self.value_of(out, *cond);
                let op_kind = self.lowered.ops[*cond as usize].kind.clone();
                let decision = match op_kind {
                    OpKind::CaseTest { .. } | OpKind::NullishTest { .. } => {
                        cond_value.single_constant().and_then(|value| match value {
                            ConstValue::Bool { value: b } => Some(*b),
                            _ => None,
                        })
                    }
                    _ => cond_value.truthiness(),
                };
                match decision {
                    Some(true) => {
                        self.pruned_edges
                            .push((*cond, *if_false, "constant_condition"));
                        self.send(*if_true, out.clone(), None);
                    }
                    Some(false) => {
                        self.pruned_edges
                            .push((*cond, *if_true, "constant_condition"));
                        self.send(*if_false, out.clone(), None);
                    }
                    None => {
                        self.send(*if_true, out.clone(), None);
                        self.send(*if_false, out.clone(), None);
                    }
                }
            }
            Term::Return { value } => {
                let returned = match value {
                    Some(op) => self.value_of(out, *op),
                    None => out
                        .completion_value
                        .clone()
                        .unwrap_or_else(|| Value::constant(ConstValue::Undefined)),
                };
                self.return_values.insert(block, returned);
                self.has_return = true;
            }
            Term::Throw { value, handler } => {
                let thrown = match value {
                    Some(op) => self.value_of(out, *op),
                    None => out
                        .completion_value
                        .clone()
                        .unwrap_or_else(|| Value::top("thrown_value_unknown")),
                };
                match handler {
                    Some(target) => {
                        // The throw is caught: the handler observes the state
                        // after the throw statement with the thrown value.
                        let mut handler_state = out.clone();
                        handler_state.completion = Completion::Normal;
                        handler_state.completion_value = None;
                        handler_state.thrown = Some(thrown);
                        self.send(*target, handler_state, None);
                    }
                    None => {
                        self.throw_values.insert(block, thrown);
                        self.has_throw = true;
                    }
                }
            }
            Term::Dispatch {
                normal,
                on_return,
                on_throw,
                breaks,
                continues,
            } => {
                // The normal continuation only executes when the finally
                // finished with no pending completion; a pending Return/Throw
                // must not revive code after the try statement (M2 precision).
                if matches!(out.completion, Completion::Normal | Completion::Multiple) {
                    let mut normal_state = out.clone();
                    normal_state.completion = Completion::Normal;
                    normal_state.completion_value = None;
                    self.send(*normal, normal_state, None);
                }
                if out.completion == Completion::Return || out.completion == Completion::Multiple {
                    let mut return_state = out.clone();
                    return_state.completion = Completion::Return;
                    self.send(*on_return, return_state, None);
                }
                if out.completion == Completion::Throw || out.completion == Completion::Multiple {
                    let mut throw_state = out.clone();
                    throw_state.completion = Completion::Throw;
                    self.send(*on_throw, throw_state, None);
                }
                if let Completion::Break(index) = out.completion {
                    if let Some((_, target, consumed)) = breaks.get(index) {
                        let mut state = out.clone();
                        if *consumed {
                            state.completion = Completion::Normal;
                            state.completion_value = None;
                        }
                        self.send(*target, state, None);
                    } else {
                        self.note_unknown("break_route_missing");
                        let mut state = out.clone();
                        state.completion = Completion::Normal;
                        self.send(*normal, state, None);
                    }
                }
                if let Completion::Continue(index) = out.completion {
                    if let Some((_, target, consumed)) = continues.get(index) {
                        let mut state = out.clone();
                        if *consumed {
                            state.completion = Completion::Normal;
                            state.completion_value = None;
                        }
                        self.send(*target, state, None);
                    } else {
                        self.note_unknown("continue_route_missing");
                    }
                }
                if out.completion == Completion::Multiple {
                    for (_, target, consumed) in breaks.iter().chain(continues.iter()) {
                        let mut state = out.clone();
                        if *consumed {
                            state.completion = Completion::Normal;
                            state.completion_value = None;
                        }
                        self.send(*target, state, None);
                    }
                }
            }
            Term::Sink => {}
        }
        // Exception edges from may-throw ops in this block observe the state
        // as of just before the throwing op, never the block end state.
        if let Some(edges) = self.exception_by_block.get(&block).cloned() {
            for (op, handler) in edges {
                let base = at_throw.get(&op).cloned().unwrap_or_else(|| out.clone());
                let thrown = self.thrown_value_for_op(&base, op);
                let mut handler_state = base;
                handler_state.completion = Completion::Normal;
                handler_state.completion_value = None;
                handler_state.thrown = Some(thrown);
                self.send(handler, handler_state, None);
            }
        }
    }

    fn send(&mut self, target: BlockId, state: State, _edge: Option<&'static str>) {
        let merged = match self.states.get(&target) {
            Some(Some(existing)) => join_states(existing, &state),
            Some(None) | None => state,
        };
        let changed = match self.states.get(&target) {
            Some(Some(existing)) => !states_equal(existing, &merged),
            Some(None) | None => true,
        };
        self.states.insert(target, Some(merged));
        if changed {
            self.queue.insert(target);
        }
    }

    fn finish(self) -> SolveOutput {
        let Self {
            lowered,
            queue,
            transfers,
            budget_exhausted,
            def_use,
            pruned_edges,
            visits,
            unknown_reasons,
            supported_ops: self_supported_ops,
            unknown_ops: self_unknown_ops,
            has_return,
            has_throw,
            block_effects,
            block_written,
            return_values,
            throw_values,
            ..
        } = self;
        let effects = block_effects
            .into_values()
            .fold(Effects::default(), |acc, effects| acc.join(&effects));
        let frontier: Vec<BlockId> = if budget_exhausted {
            queue.iter().copied().collect()
        } else {
            Vec::new()
        };
        let mut block_states = BTreeMap::new();
        let states = self.states;
        for (block, state) in &states {
            if let Some(state) = state {
                let mut bindings: Vec<(String, Slot)> = state
                    .env
                    .iter()
                    .map(|(key, slot)| (key.clone(), slot.clone()))
                    .collect();
                let truncated = bindings.len() > MAX_LISTED_BINDINGS;
                bindings.truncate(MAX_LISTED_BINDINGS);
                block_states.insert(
                    *block,
                    BlockStateOut {
                        completion: state.completion,
                        bindings,
                        truncated,
                    },
                );
            }
        }
        let status = if budget_exhausted {
            "partial_budget"
        } else {
            "complete_within_profile"
        };
        let mut coverage = BTreeMap::new();
        coverage.insert("supported_op_transfers".into(), self_supported_ops);
        coverage.insert("unknown_op_transfers".into(), self_unknown_ops);
        coverage.insert("reachable_blocks".into(), block_states.len());
        coverage.insert("cfg_blocks".into(), lowered.cfg.blocks.len());
        let mut budgets = BTreeMap::new();
        budgets.insert("transfers".into(), transfers);
        budgets.insert(
            "max_block_visits".into(),
            visits.values().copied().max().unwrap_or(0),
        );
        budgets.insert("cap_constants".into(), CAP_CONSTANTS);
        budgets.insert("cap_targets".into(), CAP_TARGETS);
        budgets.insert("cap_origins".into(), CAP_ORIGINS);
        budgets.insert("cap_heap".into(), CAP_HEAP);
        let mut returns = Value {
            constants: Vec::new(),
            targets: Vec::new(),
            origins: Vec::new(),
            unknown: false,
            reasons: BTreeSet::new(),
        };
        let mut throws = Value {
            constants: Vec::new(),
            targets: Vec::new(),
            origins: Vec::new(),
            unknown: false,
            reasons: BTreeSet::new(),
        };
        for value in return_values.into_values() {
            returns = returns.merge(&value);
        }
        for value in throw_values.into_values() {
            throws = throws.merge(&value);
        }
        let written: BTreeMap<(String, String), Value> =
            block_written
                .into_values()
                .fold(BTreeMap::new(), |mut acc, entries| {
                    for (key, value) in entries {
                        match acc.get_mut(&key) {
                            Some(existing) => *existing = existing.merge(&value),
                            None => {
                                acc.insert(key, value);
                            }
                        }
                    }
                    acc
                });
        let internal = SolveInternal {
            returns: returns.clone(),
            throws: throws.clone(),
            effects: effects.clone(),
            written,
            callsites: self.callsites,
        };
        if !has_return {
            returns.unknown = true;
            returns.reasons.insert("no_return_observed".into());
        }
        if !has_throw {
            throws.unknown = true;
            throws.reasons.insert("no_throw_observed".into());
        }
        SolveOutput {
            status,
            block_states,
            frontier,
            def_use,
            pruned_edges,
            returns: value_to_json(&returns),
            throws: value_to_json(&throws),
            effects: EffectsJsonOut {
                may_call: effects.may_call.iter().cloned().collect(),
                unknown_call: effects.unknown_call,
                may_throw: effects.may_throw,
                may_write_heap: effects.may_write_heap,
                may_read_heap: effects.may_read_heap,
                may_access_global: effects.may_access_global,
                registers_callback: effects.registers_callback,
                escaped_local_value: effects.escaped_local_value,
            },
            unknown_reasons,
            coverage,
            budgets,
            internal,
        }
    }
}

/// Threaded reaching definitions for use recording during transfer.
impl<'a> Solver<'a> {
    // `current_defs` is declared below to keep the public surface tidy.
}

fn site_keys(object_value: &Value, field: &str) -> Vec<(Origin, (String, String))> {
    let mut keys = Vec::new();
    for origin in &object_value.origins {
        if let Origin::Allocation(site) = origin {
            keys.push((origin.clone(), (format!("op{site}"), field.to_string())));
        }
    }
    keys
}

fn js_truthiness(value: &ConstValue) -> bool {
    match value {
        ConstValue::Num { value: n } => *n != 0.0 && !n.is_nan(),
        ConstValue::Str { value: s } => !s.is_empty(),
        ConstValue::Bool { value: b } => *b,
        ConstValue::Null | ConstValue::Undefined => false,
    }
}

fn const_equals(a: &ConstValue, b: &ConstValue) -> bool {
    match (a, b) {
        (ConstValue::Num { value: x }, ConstValue::Num { value: y }) => x == y,
        (ConstValue::Str { value: x }, ConstValue::Str { value: y }) => x == y,
        (ConstValue::Bool { value: x }, ConstValue::Bool { value: y }) => x == y,
        (ConstValue::Null, ConstValue::Null) => true,
        (ConstValue::Undefined, ConstValue::Undefined) => true,
        _ => false,
    }
}

fn fold_binary(state: &mut State, op: &str, lhs: &Value, rhs: &Value, op_index: u32) -> Value {
    let derived = Value {
        constants: Vec::new(),
        targets: Vec::new(),
        origins: vec![Origin::Derived(op_index)],
        unknown: false,
        reasons: BTreeSet::new(),
    }
    .with_origins(lhs.origins.clone())
    .with_origins(rhs.origins.clone());
    match (lhs.single_constant(), rhs.single_constant()) {
        (Some(a), Some(b)) => match fold_constants(op, a, b) {
            Some(value) => Value::constant(value),
            None => {
                state.effects.may_throw = true;
                derived_with_reason(derived, format!("operator_not_folded:{op}"))
            }
        },
        _ => derived_with_reason(derived, "non_constant_operands".to_string()),
    }
}

fn derived_with_reason(mut value: Value, reason: String) -> Value {
    value.unknown = true;
    value.reasons.insert(reason);
    value
}

/// Declared JS folding rules. Everything not listed stays unknown; when an
/// operand could invoke user code the op already carries may_throw.
pub fn fold_constants(op: &str, a: &ConstValue, b: &ConstValue) -> Option<ConstValue> {
    match op {
        "+" => fold_add(a, b),
        "-" | "*" | "/" | "%" | "**" => {
            let (ConstValue::Num { value: x }, ConstValue::Num { value: y }) = (a, b) else {
                return None;
            };
            let value = match op {
                "-" => x - y,
                "*" => x * y,
                "/" => x / y,
                "%" => x % y,
                _ => x.powf(*y),
            };
            Some(ConstValue::Num { value })
        }
        "===" => Some(ConstValue::Bool {
            value: const_equals(a, b),
        }),
        "!==" => Some(ConstValue::Bool {
            value: !const_equals(a, b),
        }),
        "==" if a == b && !matches!(a, ConstValue::Num { .. }) => {
            Some(ConstValue::Bool { value: true })
        }
        "!=" if a == b && !matches!(a, ConstValue::Num { .. }) => {
            Some(ConstValue::Bool { value: false })
        }
        "<" | ">" | "<=" | ">=" => match (a, b) {
            (ConstValue::Num { value: x }, ConstValue::Num { value: y }) => {
                let value = match op {
                    "<" => x < y,
                    ">" => x > y,
                    "<=" => x <= y,
                    _ => x >= y,
                };
                Some(ConstValue::Bool { value })
            }
            (ConstValue::Str { value: x }, ConstValue::Str { value: y }) => {
                let value = match op {
                    "<" => x < y,
                    ">" => x > y,
                    "<=" => x <= y,
                    _ => x >= y,
                };
                Some(ConstValue::Bool { value })
            }
            _ => None,
        },
        "&&" => {
            let truthy = match a {
                ConstValue::Num { value: n } => *n != 0.0 && !n.is_nan(),
                ConstValue::Str { value: s } => !s.is_empty(),
                ConstValue::Bool { value: v } => *v,
                ConstValue::Null | ConstValue::Undefined => false,
            };
            Some(if truthy { b.clone() } else { a.clone() })
        }
        "||" => {
            let truthy = match a {
                ConstValue::Num { value: n } => *n != 0.0 && !n.is_nan(),
                ConstValue::Str { value: s } => !s.is_empty(),
                ConstValue::Bool { value: v } => *v,
                ConstValue::Null | ConstValue::Undefined => false,
            };
            Some(if truthy { a.clone() } else { b.clone() })
        }
        "??" => {
            let nullish = matches!(a, ConstValue::Null | ConstValue::Undefined);
            Some(if nullish { b.clone() } else { a.clone() })
        }
        "," => Some(b.clone()),
        _ => None,
    }
}

/// JS ToString for primitives. Numbers convert only when integral and in the
/// exact range where Rust formatting matches JS; otherwise `None` keeps the
/// result unknown instead of guessing a format.
/// JavaScript `+`: if either operand is a string the operation concatenates
/// (both primitives have well-defined ToString here); otherwise both operands
/// convert to number (boolean/null/undefined have fixed numeric values) and
/// add numerically. Object/Symbol/BigInt conversion is out of scope and never
/// reaches this function because such operands are unknown values.
fn fold_add(a: &ConstValue, b: &ConstValue) -> Option<ConstValue> {
    let a_string = matches!(a, ConstValue::Str { .. });
    let b_string = matches!(b, ConstValue::Str { .. });
    if a_string || b_string {
        let left = js_string(a)?;
        let right = js_string(b)?;
        return Some(ConstValue::Str {
            value: format!("{left}{right}"),
        });
    }
    let left = js_number(a)?;
    let right = js_number(b)?;
    Some(ConstValue::Num {
        value: left + right,
    })
}

/// ToNumber for the modeled primitives. Strings are not converted here:
/// numeric strings only reach `+` via the concatenation branch above, and
/// arithmetic on numeric strings stays unknown instead of guessing.
fn js_number(value: &ConstValue) -> Option<f64> {
    match value {
        ConstValue::Num { value: n } => Some(*n),
        ConstValue::Bool { value: b } => Some(if *b { 1.0 } else { 0.0 }),
        ConstValue::Null => Some(0.0),
        // ToNumber(undefined) is NaN; f64 arithmetic propagates it exactly.
        ConstValue::Undefined => Some(f64::NAN),
        ConstValue::Str { .. } => None,
    }
}

pub fn js_string(value: &ConstValue) -> Option<String> {
    match value {
        ConstValue::Str { value: s } => Some(s.clone()),
        ConstValue::Bool { value: b } => Some(b.to_string()),
        ConstValue::Null => Some("null".into()),
        ConstValue::Undefined => Some("undefined".into()),
        ConstValue::Num { value: n } => {
            if n.is_nan() {
                return Some("NaN".into());
            }
            if *n == 0.0 {
                return Some("0".into()); // covers -0 too
            }
            if n.fract() == 0.0 && n.abs() < 1e21 {
                // JS prints plain digits below 1e21. `{:.0}` renders the exact
                // integer value of the f64 without narrow-integer saturation
                // (1e20 exceeds i64 but is exactly representable).
                return Some(format!("{:.0}", n));
            }
            // JS uses plain decimal notation roughly in [1e-6, 1e21); inside
            // that band Rust's shortest round-trip formatting matches, so the
            // concatenation result is exact. Outside it (exponent forms) the
            // result stays unknown rather than guessing the format.
            if n.abs() >= 1e-6 && n.abs() < 1e21 {
                let text = format!("{}", n);
                if !text.contains('e') && !text.contains('E') {
                    return Some(text);
                }
            }
            None
        }
    }
}

fn fold_unary(op: &str, value: &Value) -> Value {
    match (op, value.single_constant()) {
        ("!", Some(inner)) => {
            let truthy = match inner {
                ConstValue::Num { value: n } => *n != 0.0 && !n.is_nan(),
                ConstValue::Str { value: s } => !s.is_empty(),
                ConstValue::Bool { value: v } => *v,
                ConstValue::Null | ConstValue::Undefined => false,
            };
            Value::constant(ConstValue::Bool { value: !truthy })
        }
        ("-", Some(ConstValue::Num { value: n })) => Value::constant(ConstValue::Num { value: -n }),
        ("+", Some(ConstValue::Num { value: n })) => Value::constant(ConstValue::Num { value: *n }),
        ("typeof", Some(inner)) => {
            let name = match inner {
                ConstValue::Num { .. } => "number",
                ConstValue::Str { .. } => "string",
                ConstValue::Bool { .. } => "boolean",
                ConstValue::Null => "object",
                ConstValue::Undefined => "undefined",
            };
            Value::constant(ConstValue::Str { value: name.into() })
        }
        ("void", _) => Value::constant(ConstValue::Undefined),
        _ => Value::top(format!("unary_not_folded:{op}")),
    }
}

/// Serializable view for storage and queries.
#[derive(Clone, Debug, Serialize)]
pub struct ValueJson {
    /// Legacy plain-JSON constants; ambiguous for undefined/NaN/Infinity
    /// (serialized as strings). Consumers should prefer `typed_constants`.
    pub constants: Vec<serde_json::Value>,
    /// Machine-distinguishable tagged view of the same constants (M2).
    #[serde(rename = "typed_constants")]
    pub typed: Vec<TypedConstant>,
    pub targets: Vec<String>,
    pub origins: Vec<String>,
    pub unknown: bool,
    pub reasons: Vec<String>,
}

/// Tagged constant: `kind` distinguishes undefined/NaN/Infinity from strings.
#[derive(Clone, Debug, Serialize)]
pub struct TypedConstant {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

fn typed_constant(value: &ConstValue) -> TypedConstant {
    match value {
        ConstValue::Num { value: n } if n.is_nan() => TypedConstant {
            kind: "nan",
            value: None,
        },
        // Only non-finite magnitudes are infinities; every finite number
        // keeps its exact value in `number` (F1).
        ConstValue::Num { value: n } if n.is_infinite() && *n > 0.0 => TypedConstant {
            kind: "infinity",
            value: None,
        },
        ConstValue::Num { value: n } if n.is_infinite() => TypedConstant {
            kind: "negative_infinity",
            value: None,
        },
        ConstValue::Num { value: n } => TypedConstant {
            kind: "number",
            value: Some(serde_json::json!(n)),
        },
        ConstValue::Str { value: s } => TypedConstant {
            kind: "string",
            value: Some(serde_json::json!(s)),
        },
        ConstValue::Bool { value: b } => TypedConstant {
            kind: "boolean",
            value: Some(serde_json::json!(b)),
        },
        ConstValue::Null => TypedConstant {
            kind: "null",
            value: None,
        },
        ConstValue::Undefined => TypedConstant {
            kind: "undefined",
            value: None,
        },
    }
}

/// Build a value from constants (test/builder helper; applies caps and origins).
pub fn value_from_constants(constants: Vec<ConstValue>) -> Value {
    let mut value = Value {
        constants: Vec::new(),
        targets: Vec::new(),
        origins: Vec::new(),
        unknown: false,
        reasons: BTreeSet::new(),
    };
    for constant in constants {
        value = value.merge(&Value::constant(constant));
    }
    value
}

pub fn value_to_json(value: &Value) -> ValueJson {
    ValueJson {
        constants: value.constants.iter().map(const_to_json).collect(),
        typed: value.constants.iter().map(typed_constant).collect(),
        targets: value.targets.clone(),
        origins: value.origins.iter().map(origin_to_string).collect(),
        unknown: value.unknown,
        reasons: value.reasons.iter().cloned().collect(),
    }
}

pub fn const_to_json(value: &ConstValue) -> serde_json::Value {
    match value {
        ConstValue::Num { value: n } if n.is_finite() => serde_json::json!(n),
        ConstValue::Num { value: n } if n.is_nan() => serde_json::json!("NaN"),
        ConstValue::Num { value: n } if *n > 0.0 => serde_json::json!("Infinity"),
        ConstValue::Num { .. } => serde_json::json!("-Infinity"),
        ConstValue::Str { value: s } => serde_json::json!(s),
        ConstValue::Bool { value: b } => serde_json::json!(b),
        ConstValue::Null => serde_json::json!(null),
        ConstValue::Undefined => serde_json::json!("undefined"),
    }
}

fn origin_to_string(origin: &Origin) -> String {
    match origin {
        Origin::Parameter(index) => format!("Parameter({index})"),
        Origin::Constant => "Constant".into(),
        Origin::CallResult(op) => format!("CallResult(op{op})"),
        Origin::Allocation(op) => format!("Allocation(op{op})"),
        Origin::FunctionValue(op) => format!("FunctionValue(op{op})"),
        Origin::External(name) => format!("External({name})"),
        Origin::Capture(binding) => format!("Capture({binding})"),
        Origin::Derived(op) => format!("Derived(op{op})"),
        Origin::Exception(op) => format!("Exception(op{op})"),
        Origin::This => "This".into(),
    }
}

pub fn completion_to_string(completion: &Completion) -> &'static str {
    match completion {
        Completion::Normal => "normal",
        Completion::Return => "return",
        Completion::Throw => "throw",
        Completion::Break(_) => "break",
        Completion::Continue(_) => "continue",
        Completion::Multiple => "multiple",
    }
}

pub const MAX_OPS_NOTE: usize = MAX_OPS_PER_FUNCTION;

/// One interprocedural callsite observation (last solve pass wins).
#[derive(Clone, Debug)]
pub struct CallSiteObs {
    pub targets: Vec<String>,
    /// True when the callee set has an unknown/external component.
    pub unknown_component: bool,
    pub args: Vec<Value>,
    pub result: Option<Value>,
}

/// Symbolic function summary: origins may reference Parameter(i).
#[derive(Clone, Debug, Default)]
pub struct Summary {
    pub returns: Option<Value>,
    pub throws: Option<Value>,
    pub effects: Option<Effects>,
    /// Heap writes observed inside the function (`"*"` and `"param{i}"`
    /// sites are caller-visible; concrete sites stay callee-local).
    pub written: Option<BTreeMap<(String, String), Value>>,
}

impl Summary {
    pub fn fingerprint(&self) -> String {
        let written: BTreeMap<(String, String), String> = self
            .written
            .as_ref()
            .map(|map| {
                map.iter()
                    .map(|(key, value)| (key.clone(), value_fingerprint(value)))
                    .collect()
            })
            .unwrap_or_default();
        format!(
            "r={:?} t={:?} e={:?} w={written:?}",
            self.returns.as_ref().map(value_fingerprint),
            self.throws.as_ref().map(value_fingerprint),
            self.effects.as_ref().map(|e| format!("{e:?}"))
        )
    }

    pub fn merge(&self, other: &Summary) -> Summary {
        let mut written = self.written.clone().unwrap_or_default();
        if let Some(other_written) = &other.written {
            for (key, value) in other_written {
                match written.get_mut(key) {
                    Some(existing) => *existing = existing.merge(value),
                    None => {
                        written.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        let written = (!written.is_empty()).then_some(written);
        Summary {
            returns: match (&self.returns, &other.returns) {
                (Some(a), Some(b)) => Some(a.merge(b)),
                (a, b) => a.clone().or_else(|| b.clone()),
            },
            throws: match (&self.throws, &other.throws) {
                (Some(a), Some(b)) => Some(a.merge(b)),
                (a, b) => a.clone().or_else(|| b.clone()),
            },
            effects: match (&self.effects, &other.effects) {
                (Some(a), Some(b)) => Some(a.join(b)),
                (a, b) => a.clone().or_else(|| b.clone()),
            },
            written,
        }
    }
}

/// Re-base a symbolic summary value for one callsite: Parameter(i) origins are
/// replaced by the actual argument's origins; everything else flows through.
pub fn apply_summary_value(summary_value: &Value, args: &[Value], callsite_op: u32) -> Value {
    let mut value = summary_value.clone();
    let mut origins = Vec::new();
    for origin in &value.origins {
        match origin {
            Origin::Parameter(index) => match args.get(*index) {
                Some(actual) => {
                    if actual.unknown {
                        value.unknown = true;
                        value.reasons.extend(actual.reasons.iter().cloned());
                    }
                    origins.extend(actual.origins.iter().cloned());
                    // M1: substitute every abstract dimension of the actual
                    // argument, not just the origin tag — a caller passing a
                    // constant or a function value receives that constant or
                    // function through the callee's parameter.
                    for constant in &actual.constants {
                        if !value.constants.contains(constant) {
                            value.constants.push(constant.clone());
                        }
                    }
                    if value.constants.len() > CAP_CONSTANTS {
                        value.constants.clear();
                        unknown_flag(
                            &mut value.unknown,
                            &mut value.reasons,
                            "cap_exceeded:constants",
                        );
                    }
                    for target in &actual.targets {
                        if !value.targets.contains(target) {
                            value.targets.push(target.clone());
                        }
                    }
                    if value.targets.len() > CAP_TARGETS {
                        value.targets.clear();
                        unknown_flag(
                            &mut value.unknown,
                            &mut value.reasons,
                            "cap_exceeded:targets",
                        );
                    }
                }
                None => origins.push(origin.clone()),
            },
            other => origins.push(other.clone()),
        }
    }
    value.origins = Vec::new();
    value = value.with_origins(origins);
    value.with_origins(vec![Origin::CallResult(callsite_op)])
}

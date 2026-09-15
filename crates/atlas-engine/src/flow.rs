//! Flow IR validation and CFG construction (W01/W02).
//!
//! The worker's structured IR is validated against snapshot sources, then
//! lowered into basic blocks with completion-carrying edges. `finally` shares
//! one pending-completion dispatch (no combinatorial copying); short-circuit,
//! conditional expressions and switch tests become explicit branch edges so
//! dataflow consumes one consistent graph. Ops carry operand indices; the
//! solver folds values through them.
use crate::{Result, invalid};
use atlas_contract::*;
use std::collections::{BTreeMap, BTreeSet};

/// How many functions one analysis may hold.
///
/// Unlike the per-function budgets below, this one is not a guard against
/// unbounded work: a project's function count is a property of the project, the
/// cost is linear in it (measured at roughly 55 ms per function end to end) and
/// the pipeline deadline still bounds the run. It is a memory ceiling, and it
/// was raised from 20_000 to 50_000 after a real repository (a monorepo with
/// 34_635 functions) was refused by it while the pipeline itself was healthy.
/// The refusal names the count and the ceiling, so the next project over the
/// line says so instead of looking broken.
pub const MAX_FUNCTIONS: usize = 50_000;
pub const MAX_STATEMENTS_PER_FUNCTION: usize = 20_000;
/// Bindings and scopes are deliberately tighter than `MAX_STATEMENTS_PER_FUNCTION`.
///
/// They look inconsistent with it -- and a minified bundle can hold a function
/// with 16_054 statements and 10_975 bindings -- but they are not a formatting
/// preference: they are what keeps one machine-generated function from taking
/// the whole pipeline down. Raising them to the statement ceiling was measured:
/// the same project then spent the entire 120 s pipeline budget and ended in
/// `analysis_deadline_exceeded_no_analysis_published` at 1.65 GB peak RSS,
/// where this budget refuses it in about 90 s with a named reason. A project
/// rejected by one of these numbers needs the function excluded from flow with
/// its coverage recorded, not a larger ceiling.
pub const MAX_BINDINGS_PER_FUNCTION: usize = 4_000;
pub const MAX_SCOPES_PER_FUNCTION: usize = 4_000;
pub const MAX_OPS_PER_FUNCTION: usize = 200_000;
pub const MAX_BLOCKS_PER_FUNCTION: usize = 100_000;

/// A file whose dataflow is withheld because one of its functions cannot be
/// derived inside the per-function budgets.
#[derive(Clone, Debug, PartialEq)]
pub struct WithheldFlow {
    pub path: String,
    /// How many functions in this file lose their flow with it.
    pub functions: usize,
    /// How many of them reached a budget themselves.
    pub offenders: usize,
    /// The budget the representative offender reached, its count and ceiling,
    /// and the span to open when a reader follows this up.
    pub what: &'static str,
    pub count: usize,
    pub limit: usize,
    pub start: usize,
    pub end: usize,
}

/// Which budget this function reached, if any, with the number and the ceiling.
fn over_budget(function: &FlowFunction) -> Option<(&'static str, usize, usize)> {
    if function.bindings.len() > MAX_BINDINGS_PER_FUNCTION {
        return Some((
            "bindings",
            function.bindings.len(),
            MAX_BINDINGS_PER_FUNCTION,
        ));
    }
    (function.scopes.len() > MAX_SCOPES_PER_FUNCTION).then(|| {
        (
            "scopes",
            function.scopes.len(),
            MAX_SCOPES_PER_FUNCTION,
        )
    })
}

/// The files that must have their dataflow withheld, and why.
///
/// The unit is the file, not the function, and that is forced rather than
/// convenient: a nested function's `captures` point at bindings declared in its
/// enclosing function, so removing one function's flow from a file that keeps
/// another's leaves a dangling capture -- a protocol break, not an unknown.
/// Lexical captures never leave their file, so withholding a whole file removes
/// exactly the bindings that file declared and nothing outside can dangle.
///
/// This is what keeps one machine-generated function (a 16_054-statement span
/// in a vendored bundle declared 10_975 bindings) from taking a whole project
/// down with it: the file's symbols, calls and sources are still published, and
/// the withheld dataflow is listed rather than reported as analyzed.
pub fn withheld_files(functions: &[FlowFunction]) -> Vec<WithheldFlow> {
    let mut by_path: BTreeMap<&str, WithheldFlow> = BTreeMap::new();
    for function in functions {
        let Some((what, count, limit)) = over_budget(function) else {
            continue;
        };
        // The first offender names the file: it is one reason to look here and
        // one span to open. `offenders` below says how many there were, so
        // naming one does not claim it was the only one.
        let entry = by_path.entry(function.path.as_str()).or_insert(WithheldFlow {
            path: function.path.clone(),
            functions: 0,
            offenders: 0,
            what,
            count,
            limit,
            start: function.start,
            end: function.end,
        });
        entry.offenders += 1;
    }
    // Every function in a withheld file loses its flow with the file, so what is
    // withheld is counted by the file's functions, not by its offenders.
    for function in functions {
        if let Some(entry) = by_path.get_mut(function.path.as_str()) {
            entry.functions += 1;
        }
    }
    by_path.into_values().collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Op {
    pub start: usize,
    pub end: usize,
    pub kind: OpKind,
    pub may_throw: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OpKind {
    Const(ConstValue),
    ReadLocal(String),
    ReadExternal(String),
    This,
    FunctionRef(String),
    Binary {
        op: String,
        left: u32,
        right: u32,
    },
    Unary {
        op: String,
        operand: u32,
    },
    /// Write of a local binding. `compound` is `"+="`-style or `"++"`-style.
    AssignBinding {
        binding: String,
        value: u32,
        compound: Option<String>,
    },
    PropertyRead {
        object: u32,
        name: String,
        optional: bool,
    },
    PropertyWrite {
        object: u32,
        name: String,
        value: u32,
    },
    Call {
        callee: u32,
        args: Vec<u32>,
        optional: bool,
    },
    New {
        callee: u32,
        args: Vec<u32>,
    },
    AllocObject {
        fields: Vec<(String, u32)>,
    },
    AllocArray {
        elements: Vec<u32>,
    },
    /// Value of the exception currently being handled (catch/landing entry).
    CurrentException,
    /// Record the pending completion entering a shared `finally`.
    SetCompletion {
        kind: CompletionKind,
        value: Option<u32>,
    },
    /// `case ===` test between discriminant and case expression.
    CaseTest {
        disc: u32,
        test: u32,
    },
    /// Nullish test (`??` left operand): true when null/undefined.
    NullishTest {
        value: u32,
    },
    /// Construct outside the declared profile; value is top with a reason.
    UnknownOp {
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    Normal,
    Return,
    Throw,
    Break(usize),
    Continue(usize),
}

pub type BlockId = u32;

#[derive(Clone, Debug)]
pub struct Block {
    pub ops: Vec<u32>,
    pub term: Term,
}

#[derive(Clone, Debug)]
pub enum Term {
    Goto(BlockId),
    /// Conditional branch; the test applied to `cond` depends on its op kind
    /// (CaseTest / NullishTest / truthiness).
    Branch {
        cond: u32,
        if_true: BlockId,
        if_false: BlockId,
    },
    /// Normal function exit. Value operand for direct returns; the solver falls
    /// back to the pending completion value after a finally dispatch.
    Return {
        value: Option<u32>,
    },
    /// Throw statement. With `handler`, control goes to that block carrying
    /// the thrown value; without, it is an uncaught function exit.
    Throw {
        value: Option<u32>,
        handler: Option<BlockId>,
    },
    /// Shared finally epilogue: route by pending completion. `consumed` marks
    /// edges that terminate the pending completion at their target.
    Dispatch {
        normal: BlockId,
        on_return: BlockId,
        on_throw: BlockId,
        breaks: Vec<(Option<String>, BlockId, bool)>,
        continues: Vec<(Option<String>, BlockId, bool)>,
    },
    Sink,
}

#[derive(Clone, Debug)]
pub struct Cfg {
    pub entry: BlockId,
    pub exit_normal: BlockId,
    pub exit_exceptional: BlockId,
    pub blocks: Vec<Block>,
    /// (op, handler) for every may-throw op evaluated under a handler.
    pub exception_edges: Vec<(u32, BlockId)>,
    /// Blocks on a CFG cycle: allocation sites there are multi-object.
    pub looping_blocks: BTreeSet<BlockId>,
}

#[derive(Clone, Debug)]
pub struct LoweredFunction {
    pub symbol: String,
    pub ops: Vec<Op>,
    pub cfg: Cfg,
}

/// (label, continuation, router depth when created): completions crossing a
/// `finally` only run frames deeper than the entry's depth.
#[derive(Clone, Default)]
struct Ctx {
    breaks: Vec<(Option<String>, BlockId, usize)>,
    continues: Vec<(Option<String>, BlockId, usize)>,
}

#[derive(Clone)]
struct FinallyFrame {
    entry: BlockId,
}

struct Builder {
    ops: Vec<Op>,
    blocks: Vec<Block>,
    temp_prefix: String,
    temps: usize,
    exception_edges: Vec<(u32, BlockId)>,
    throw_handler: Option<BlockId>,
    completion_router: Vec<FinallyFrame>,
    overflow: bool,
}

/// Validate worker Flow IR against snapshot sources and symbol records.
pub fn validate_flow(
    flow: &FlowFacts,
    sources: &std::collections::HashMap<String, String>,
    symbols: &std::collections::HashMap<String, &Symbol>,
    snapshot_id: &str,
) -> Result<()> {
    validate_flow_with_symbols(
        flow,
        sources,
        symbols,
        &symbols.keys().map(|key| key.as_str()).collect(),
        &BTreeSet::new(),
        snapshot_id,
    )
}

/// Extended validation with the full symbol list, so references like
/// `FunctionRef` can be checked against every extracted symbol (R6), and the
/// per-function coverage contract can reject silently dropped functions.
///
/// `withheld` names the symbols whose file's dataflow was deliberately withheld
/// (see [`withheld_files`]). It is a whitelist, not a bypass: a symbol in it
/// must have no flow, must exist in the symbol list, and no other symbol may be
/// missing flow. Withholding therefore stays a declared, checked act instead of
/// a way for a derivation to forget a function quietly.
pub fn validate_flow_with_symbols(
    flow: &FlowFacts,
    sources: &std::collections::HashMap<String, String>,
    symbols: &std::collections::HashMap<String, &Symbol>,
    all_symbol_ids: &std::collections::HashSet<&str>,
    withheld: &BTreeSet<&str>,
    snapshot_id: &str,
) -> Result<()> {
    if flow.schema != FLOW_SCHEMA || flow.snapshot_id != snapshot_id || flow.profile != FLOW_PROFILE
    {
        return Err(invalid("flow_contract_mismatch"));
    }
    if flow.producer != atlas_contract::WORKER_PRODUCER {
        return Err(invalid(&format!(
            "flow_producer_mismatch:got={}:expected={}",
            flow.producer,
            atlas_contract::WORKER_PRODUCER
        )));
    }
    if flow.functions.len() > MAX_FUNCTIONS {
        return Err(invalid(&format!(
            "flow_function_budget_exceeded:functions={}:limit={MAX_FUNCTIONS}",
            flow.functions.len()
        )));
    }
    let mut binding_owner: BTreeMap<&str, &FlowFunction> = BTreeMap::new();
    let mut scope_ids: BTreeSet<&str> = BTreeSet::new();
    for function in &flow.functions {
        let symbol = symbols
            .get(function.symbol.as_str())
            .ok_or_else(|| invalid("flow_symbol_unknown"))?;
        if function.path != symbol.path
            || function.start != symbol.start
            || function.end != symbol.end
            || !span_valid(sources, &function.path, function.start, function.end)
        {
            return Err(invalid("flow_function_anchor_invalid"));
        }
        if function.bindings.len() > MAX_BINDINGS_PER_FUNCTION
            || function.scopes.len() > MAX_SCOPES_PER_FUNCTION
        {
            // Name the function and the number, not just the fact that some
            // budget was hit. One machine-generated file can be the entire
            // reason a project cannot be opened, and "flow_function_budget_
            // exceeded" alone leaves the reader with no file to look at.
            let (what, count, limit) = if function.bindings.len() > MAX_BINDINGS_PER_FUNCTION {
                (
                    "bindings",
                    function.bindings.len(),
                    MAX_BINDINGS_PER_FUNCTION,
                )
            } else {
                ("scopes", function.scopes.len(), MAX_SCOPES_PER_FUNCTION)
            };
            return Err(invalid(&format!(
                "flow_function_budget_exceeded:what={what}:count={count}:limit={limit}:path={}:start={}:end={}",
                function.path, function.start, function.end
            )));
        }
        let scope_ids_here: BTreeSet<&str> =
            function.scopes.iter().map(|s| s.id.as_str()).collect();
        if scope_ids_here.len() != function.scopes.len() {
            return Err(invalid("duplicate_flow_scope"));
        }
        for scope in &function.scopes {
            if !matches!(
                scope.kind.as_str(),
                "function" | "block" | "for" | "catch" | "switch"
            ) {
                return Err(invalid("invalid_flow_scope_kind"));
            }
            if !scope_ids.insert(scope.id.as_str()) {
                return Err(invalid("duplicate_flow_scope_id"));
            }
            for binding in &scope.bindings {
                if !function.bindings.iter().any(|b| b.id == *binding) {
                    return Err(invalid("flow_scope_reference_unknown_binding"));
                }
            }
        }
        for binding in &function.bindings {
            if !binding.id.starts_with("b:")
                || !span_valid(
                    sources,
                    &function.path,
                    binding.decl_start,
                    binding.decl_end,
                )
                || !function.scopes.iter().any(|s| s.id == binding.scope)
                || !matches!(
                    binding.kind.as_str(),
                    "param" | "var" | "let" | "const" | "function" | "catch"
                )
            {
                return Err(invalid("invalid_flow_binding"));
            }
            if let Some(expr) = &binding.default_value {
                check_expr_spans(expr, sources, &function.path, function.start, function.end)?;
                check_expr_refs(expr, function, all_symbol_ids)?;
            }
            if binding_owner
                .insert(binding.id.as_str(), function)
                .is_some()
            {
                // Duplicate binding ids are protocol damage even within one
                // function: they make reaching-definition and capture keys
                // ambiguous (R6).
                return Err(invalid("duplicate_flow_binding_id"));
            }
        }
        let param_set: BTreeSet<&str> = function.params.iter().map(String::as_str).collect();
        if param_set.len() != function.params.len()
            || function
                .params
                .iter()
                .any(|p| !function.bindings.iter().any(|b| &b.id == p))
        {
            return Err(invalid("invalid_flow_params"));
        }
        let mut count = 0usize;
        for stmt in &function.body {
            count += count_statements(stmt)?;
        }
        if count > MAX_STATEMENTS_PER_FUNCTION {
            return Err(invalid("flow_statement_budget_exceeded"));
        }
        for stmt in &function.body {
            check_stmt_spans(stmt, sources, &function.path, function.start, function.end)?;
            check_stmt_refs(stmt, function, all_symbol_ids)?;
        }
        for region in &function.unknown_regions {
            if region.end < region.start
                || !span_valid(sources, &function.path, region.start, region.end)
            {
                return Err(invalid("invalid_flow_unknown_region"));
            }
        }
    }
    let all_bindings: BTreeSet<&str> = binding_owner.keys().copied().collect();
    for function in &flow.functions {
        for capture in &function.captures {
            if !all_bindings.contains(capture.as_str()) {
                return Err(invalid("flow_capture_unknown_binding"));
            }
        }
        for stmt in &function.body {
            check_try_catch_params(stmt, function)?;
        }
    }
    // Per-function coverage reconciliation: every extracted symbol must have
    // flow material, or be one of the symbols whose file's dataflow was withheld
    // on purpose, or the whole derivation is refused. Silently dropping a
    // function would make coverage numbers lie by omission (R6).
    for symbol_id in symbols.keys() {
        let analyzed = flow
            .functions
            .iter()
            .any(|function| function.symbol == *symbol_id);
        if !analyzed && !withheld.contains(symbol_id.as_str()) {
            return Err(invalid("flow_coverage_mismatch"));
        }
    }
    // The other direction, so "withheld" cannot quietly hold a function whose
    // flow was dropped for some other reason: a withheld symbol must have no
    // flow and must be a symbol this snapshot actually has.
    for symbol_id in withheld {
        if flow
            .functions
            .iter()
            .any(|function| function.symbol == *symbol_id)
        {
            return Err(invalid("flow_withheld_but_present"));
        }
        if !symbols.contains_key(*symbol_id) {
            return Err(invalid("flow_withheld_symbol_unknown"));
        }
    }
    Ok(())
}

/// Every local read/write and function reference must resolve to a declared
/// binding of this function (own bindings or declared captures) and a known
/// symbol respectively. Dangling ids are protocol damage, not unknowns (R6).
fn check_stmt_refs(
    stmt: &Stmt,
    function: &FlowFunction,
    all_symbol_ids: &std::collections::HashSet<&str>,
) -> Result<()> {
    let visible = |binding: &str| -> Result<()> {
        if function.bindings.iter().any(|b| b.id == binding)
            || function.captures.iter().any(|c| c == binding)
        {
            Ok(())
        } else {
            Err(invalid("flow_reference_unknown_binding"))
        }
    };
    let check_expr =
        |expr: &Expr| -> Result<()> { check_expr_refs(expr, function, all_symbol_ids) };
    let check_body = |body: &[Stmt]| -> Result<()> {
        for child in body {
            check_stmt_refs(child, function, all_symbol_ids)?;
        }
        Ok(())
    };
    match &stmt.kind {
        StmtKind::VarDecl { declarators, .. } => {
            for declarator in declarators {
                visible(&declarator.binding)?;
                if let Some(init) = &declarator.init {
                    check_expr(init)?;
                }
            }
        }
        StmtKind::Expression { expr } => check_expr(expr)?,
        StmtKind::If {
            cond,
            then_body,
            else_body,
        } => {
            check_expr(cond)?;
            check_body(then_body)?;
            check_body(else_body)?;
        }
        StmtKind::While { cond, body } => {
            check_expr(cond)?;
            check_body(body)?;
        }
        StmtKind::DoWhile { body, cond } => {
            check_body(body)?;
            check_expr(cond)?;
        }
        StmtKind::For {
            init,
            cond,
            update,
            body,
        } => {
            if let Some(init) = init {
                check_stmt_refs(init, function, all_symbol_ids)?;
            }
            if let Some(cond) = cond {
                check_expr(cond)?;
            }
            if let Some(update) = update {
                check_expr(update)?;
            }
            check_body(body)?;
        }
        StmtKind::Switch {
            discriminant,
            cases,
        } => {
            check_expr(discriminant)?;
            for case in cases {
                if let Some(test) = &case.test {
                    check_expr(test)?;
                }
                check_body(&case.body)?;
            }
        }
        StmtKind::Return { value: Some(value) } => check_expr(value)?,
        StmtKind::Return { value: None } => {}
        StmtKind::Throw { expr } => check_expr(expr)?,
        StmtKind::Try {
            body, catch_body, ..
        } => {
            check_body(body)?;
            if let Some(catch_body) = catch_body {
                check_body(catch_body)?;
            }
        }
        StmtKind::Labeled { body, .. } => check_stmt_refs(body, function, all_symbol_ids)?,
        StmtKind::Block { body } => check_body(body)?,
        _ => {}
    }
    Ok(())
}

fn check_expr_refs(
    expr: &Expr,
    function: &FlowFunction,
    all_symbol_ids: &std::collections::HashSet<&str>,
) -> Result<()> {
    let visible = |binding: &str| -> Result<()> {
        if function.bindings.iter().any(|b| b.id == binding)
            || function.captures.iter().any(|c| c == binding)
        {
            Ok(())
        } else {
            Err(invalid("flow_reference_unknown_binding"))
        }
    };
    let check = |expr: &Expr| check_expr_refs(expr, function, all_symbol_ids);
    match &expr.kind {
        ExprKind::Local { binding } => visible(binding)?,
        ExprKind::FunctionRef { symbol } => {
            if !all_symbol_ids.contains(symbol.as_str()) {
                return Err(invalid("flow_function_ref_unknown_symbol"));
            }
        }
        ExprKind::Assign { target, value, .. } => {
            if let AssignTarget::Binding { binding } = target {
                visible(binding)?;
            }
            check(value)?;
        }
        ExprKind::Binary { left, right, .. } | ExprKind::ShortCircuit { left, right, .. } => {
            check(left)?;
            check(right)?;
        }
        ExprKind::Conditional {
            cond,
            then_value,
            else_value,
        } => {
            check(cond)?;
            check(then_value)?;
            check(else_value)?;
        }
        ExprKind::Unary { operand, .. } => check(operand)?,
        ExprKind::Call { callee, args, .. } | ExprKind::New { callee, args } => {
            check(callee)?;
            for arg in args {
                check(arg)?;
            }
        }
        ExprKind::PropertyRead { object, .. } => check(object)?,
        ExprKind::ArrayLiteral { elements } => {
            for element in elements.iter().flatten() {
                check(element)?;
            }
        }
        ExprKind::ObjectLiteral { fields } => {
            for field in fields {
                check(&field.value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn check_try_catch_params(stmt: &Stmt, function: &FlowFunction) -> Result<()> {
    match &stmt.kind {
        StmtKind::Try {
            catch_param,
            catch_body,
            ..
        } => {
            if let (Some(param), Some(true)) =
                (catch_param.as_ref(), catch_body.as_ref().map(|_| true))
            {
                let declared = function
                    .scopes
                    .iter()
                    .any(|s| s.kind == "catch" && s.bindings.iter().any(|b| b == param));
                if !declared {
                    return Err(invalid("flow_catch_param_unknown"));
                }
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn count_statements(stmt: &Stmt) -> Result<usize> {
    let children = match &stmt.kind {
        StmtKind::Block { body } | StmtKind::Try { body, .. } => {
            body.iter().map(count_statements).sum::<Result<usize>>()?
        }
        StmtKind::If {
            then_body,
            else_body,
            ..
        } => then_body
            .iter()
            .chain(else_body.iter())
            .map(count_statements)
            .sum::<Result<usize>>()?,
        StmtKind::While { body, .. }
        | StmtKind::DoWhile { body, .. }
        | StmtKind::For { body, .. } => body.iter().map(count_statements).sum::<Result<usize>>()?,
        StmtKind::Switch { cases, .. } => cases
            .iter()
            .flat_map(|case| case.body.iter())
            .map(count_statements)
            .sum::<Result<usize>>()?,
        StmtKind::Labeled { body, .. } => count_statements(body)?,
        _ => 0,
    };
    Ok(1 + children)
}

fn span_valid(
    sources: &std::collections::HashMap<String, String>,
    path: &str,
    start: usize,
    end: usize,
) -> bool {
    sources
        .get(path)
        .map(|source| {
            start <= end
                && end <= source.len()
                && source.is_char_boundary(start)
                && source.is_char_boundary(end)
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const SOURCE: &str = "function a(){} function b(){}";

    fn function(symbol: &str, path: &str, start: usize, end: usize) -> FlowFunction {
        FlowFunction {
            symbol: symbol.into(),
            name: symbol.into(),
            path: path.into(),
            start,
            end,
            params: vec![],
            imports: vec![],
            scopes: vec![FlowScope {
                id: format!("scope:{symbol}"),
                kind: "function".into(),
                parent: None,
                bindings: vec![],
            }],
            bindings: vec![],
            body: vec![],
            captures: vec![],
            unknown_regions: vec![],
        }
    }

    fn symbol(id: &str, path: &str, start: usize, end: usize) -> atlas_contract::Symbol {
        atlas_contract::Symbol {
            id: id.into(),
            path: path.into(),
            name: id.into(),
            kind: "function".into(),
            start,
            end,
            container: String::new(),
            mutated: false,
        }
    }

    /// Two functions in two files, the first one analyzed and the second one
    /// withheld, so the reconciliation has one of each to check.
    fn two_files() -> (
        FlowFacts,
        HashMap<String, String>,
        HashMap<String, atlas_contract::Symbol>,
    ) {
        let flow = FlowFacts {
            schema: atlas_contract::FLOW_SCHEMA.into(),
            snapshot_id: "snap".into(),
            producer: atlas_contract::WORKER_PRODUCER.into(),
            profile: atlas_contract::FLOW_PROFILE.into(),
            functions: vec![function("sym:a.ts:0:14", "a.ts", 0, 14)],
            diagnostics: vec![],
        };
        let sources = HashMap::from([
            ("a.ts".to_string(), SOURCE.to_string()),
            ("b.ts".to_string(), SOURCE.to_string()),
        ]);
        let symbols = HashMap::from([
            ("sym:a.ts:0:14".to_string(), symbol("sym:a.ts:0:14", "a.ts", 0, 14)),
            (
                "sym:b.ts:15:29".to_string(),
                symbol("sym:b.ts:15:29", "b.ts", 15, 29),
            ),
        ]);
        (flow, sources, symbols)
    }

    fn validate(
        flow: &FlowFacts,
        sources: &HashMap<String, String>,
        symbols: &HashMap<String, atlas_contract::Symbol>,
        withheld: &BTreeSet<&str>,
    ) -> Result<()> {
        let borrowed: HashMap<String, &atlas_contract::Symbol> =
            symbols.iter().map(|(id, s)| (id.clone(), s)).collect();
        let ids: std::collections::HashSet<&str> = symbols.keys().map(|k| k.as_str()).collect();
        validate_flow_with_symbols(flow, sources, &borrowed, &ids, withheld, "snap")
    }

    #[test]
    fn a_withheld_symbol_is_accepted_only_without_flow() {
        let (flow, sources, symbols) = two_files();
        let withheld: BTreeSet<&str> = ["sym:b.ts:15:29"].into_iter().collect();
        validate(&flow, &sources, &symbols, &withheld).expect("a withheld file's symbol must pass");

        // The whitelist is not a bypass: a symbol that simply lost its flow and
        // is not listed is still refused.
        let error = validate(&flow, &sources, &symbols, &BTreeSet::new()).unwrap_err();
        assert!(error.to_string().contains("flow_coverage_mismatch"), "{error}");

        // And a symbol cannot be both analyzed and withheld.
        let both = FlowFacts {
            functions: vec![
                function("sym:a.ts:0:14", "a.ts", 0, 14),
                function("sym:b.ts:15:29", "b.ts", 15, 29),
            ],
            ..flow.clone()
        };
        let error = validate(&both, &sources, &symbols, &withheld).unwrap_err();
        assert!(error.to_string().contains("flow_withheld_but_present"), "{error}");

        // An unknown symbol in the whitelist is refused too.
        let ghosts: BTreeSet<&str> = ["sym:b.ts:15:29", "sym:ghost"].into_iter().collect();
        let error = validate(&flow, &sources, &symbols, &ghosts).unwrap_err();
        assert!(error.to_string().contains("flow_withheld_symbol_unknown"), "{error}");
    }

    #[test]
    fn one_over_budget_function_withholds_its_file_and_names_the_budget() {
        let mut huge = function("sym:a.ts:0:14", "bundle.js", 0, 14);
        huge.scopes = (0..(MAX_SCOPES_PER_FUNCTION + 1))
            .map(|i| FlowScope {
                id: format!("s{i}"),
                kind: "block".into(),
                parent: None,
                bindings: vec![],
            })
            .collect();
        let small = function("sym:b.ts:15:29", "bundle.js", 15, 29);
        let other = function("sym:c.ts:0:14", "app.js", 0, 14);

        let withheld = withheld_files(&[small, huge, other]);
        assert_eq!(withheld.len(), 1, "only the file that reached a budget is withheld");
        assert_eq!(withheld[0].path, "bundle.js");
        assert_eq!(withheld[0].functions, 2, "the file is the unit, so both go");
        assert_eq!(withheld[0].offenders, 1, "one function reached the budget");
        assert_eq!(withheld[0].what, "scopes");
        assert_eq!(withheld[0].limit, MAX_SCOPES_PER_FUNCTION);
        assert_eq!(withheld[0].count, MAX_SCOPES_PER_FUNCTION + 1);

        // Nothing to withhold when every function is inside the budgets.
        assert!(withheld_files(&[function("sym:c.ts:0:14", "app.js", 0, 14)]).is_empty());
    }
}

fn check_stmt_spans(
    stmt: &Stmt,
    sources: &std::collections::HashMap<String, String>,
    path: &str,
    parent_start: usize,
    parent_end: usize,
) -> Result<()> {
    if stmt.start < parent_start
        || stmt.end > parent_end
        || !span_valid(sources, path, stmt.start, stmt.end)
    {
        return Err(invalid("invalid_flow_statement_anchor"));
    }
    let check_body = |body: &[Stmt]| -> Result<()> {
        for child in body {
            check_stmt_spans(child, sources, path, parent_start, parent_end)?;
        }
        Ok(())
    };
    let check_expr = |expr: &Expr| check_expr_spans(expr, sources, path, parent_start, parent_end);
    match &stmt.kind {
        StmtKind::Block { body } | StmtKind::Try { body, .. } => check_body(body)?,
        StmtKind::VarDecl { declarators, .. } => {
            for declarator in declarators {
                if let Some(init) = &declarator.init {
                    check_expr(init)?;
                }
            }
        }
        StmtKind::Expression { expr } => check_expr(expr)?,
        StmtKind::If {
            cond,
            then_body,
            else_body,
        } => {
            check_expr(cond)?;
            check_body(then_body)?;
            check_body(else_body)?;
        }
        StmtKind::While { cond, body } => {
            check_expr(cond)?;
            check_body(body)?;
        }
        StmtKind::DoWhile { body, cond } => {
            check_body(body)?;
            check_expr(cond)?;
        }
        StmtKind::For {
            init,
            cond,
            update,
            body,
        } => {
            if let Some(init) = init {
                check_stmt_spans(init, sources, path, parent_start, parent_end)?;
            }
            if let Some(cond) = cond {
                check_expr(cond)?;
            }
            if let Some(update) = update {
                check_expr(update)?;
            }
            check_body(body)?;
        }
        StmtKind::Switch {
            discriminant,
            cases,
        } => {
            check_expr(discriminant)?;
            for case in cases {
                if let Some(test) = &case.test {
                    check_expr(test)?;
                }
                check_body(&case.body)?;
            }
        }
        StmtKind::Return { value: Some(value) } => check_expr(value)?,
        StmtKind::Return { value: None } => {}
        StmtKind::Throw { expr } => check_expr(expr)?,
        StmtKind::Labeled { body, .. } => {
            check_stmt_spans(body, sources, path, parent_start, parent_end)?
        }
        _ => {}
    }
    Ok(())
}

fn check_expr_spans(
    expr: &Expr,
    sources: &std::collections::HashMap<String, String>,
    path: &str,
    parent_start: usize,
    parent_end: usize,
) -> Result<()> {
    if expr.start < parent_start
        || expr.end > parent_end
        || !span_valid(sources, path, expr.start, expr.end)
    {
        return Err(invalid("invalid_flow_expression_anchor"));
    }
    let check = |expr: &Expr| check_expr_spans(expr, sources, path, parent_start, parent_end);
    match &expr.kind {
        ExprKind::Assign { target, value, .. } => {
            check(value)?;
            match target {
                AssignTarget::Property { object, .. } => check(object)?,
                AssignTarget::Element { object, key } => {
                    check(object)?;
                    check(key)?;
                }
                _ => {}
            }
        }
        ExprKind::Binary { left, right, .. } | ExprKind::ShortCircuit { left, right, .. } => {
            check(left)?;
            check(right)?;
        }
        ExprKind::Conditional {
            cond,
            then_value,
            else_value,
        } => {
            check(cond)?;
            check(then_value)?;
            check(else_value)?;
        }
        ExprKind::Unary { operand, .. } => check(operand)?,
        ExprKind::Call { callee, args, .. } | ExprKind::New { callee, args } => {
            check(callee)?;
            for arg in args {
                check(arg)?;
            }
        }
        ExprKind::PropertyRead { object, .. } => check(object)?,
        ExprKind::ArrayLiteral { elements } => {
            for element in elements.iter().flatten() {
                check(element)?;
            }
        }
        ExprKind::ObjectLiteral { fields } => {
            for field in fields {
                check(&field.value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Lower one validated function into ops plus a completion-aware CFG.
pub fn build_cfg(function: &FlowFunction) -> Result<LoweredFunction> {
    let mut builder = Builder {
        ops: Vec::new(),
        blocks: Vec::new(),
        temp_prefix: function.symbol.clone(),
        temps: 0,
        exception_edges: Vec::new(),
        throw_handler: None,
        completion_router: Vec::new(),
        overflow: false,
    };
    let entry = builder.new_block();
    let ctx = Ctx::default();
    // Entry prologue: parameter defaults (`if (p === undefined) p = default`)
    // and local function-declaration bindings seeded with their values.
    let mut prologue_end = entry;
    for binding in &function.bindings {
        let Some(default_expr) = &binding.default_value else {
            continue;
        };
        if !function.params.contains(&binding.id) {
            continue;
        }
        let read = builder.emit(
            prologue_end,
            binding.decl_start,
            binding.decl_end,
            OpKind::ReadLocal(binding.id.clone()),
            false,
        );
        let test = builder.emit(
            prologue_end,
            binding.decl_start,
            binding.decl_end,
            OpKind::NullishTest { value: read },
            false,
        );
        let then_block = builder.new_block();
        let join = builder.new_block();
        builder.blocks[prologue_end as usize].term = crate::flow::Term::Branch {
            cond: test,
            if_true: join,
            if_false: then_block,
        };
        let mut current = Some(then_block);
        let value_op = builder.eval(&mut current, default_expr, &ctx)?;
        let end_block = current.ok_or_else(|| invalid("flow_default_after_terminator"))?;
        builder.emit(
            end_block,
            binding.decl_start,
            binding.decl_end,
            OpKind::AssignBinding {
                binding: binding.id.clone(),
                value: value_op,
                compound: None,
            },
            false,
        );
        builder.blocks[end_block as usize].term = Term::Goto(join);
        prologue_end = join;
    }
    for binding in &function.bindings {
        let Some(symbol) = &binding.function_symbol else {
            continue;
        };
        if binding.kind != "function" || function.captures.contains(&binding.id) {
            continue;
        }
        let reference = builder.emit(
            prologue_end,
            binding.decl_start,
            binding.decl_end,
            OpKind::FunctionRef(symbol.clone()),
            false,
        );
        builder.emit(
            prologue_end,
            binding.decl_start,
            binding.decl_end,
            OpKind::AssignBinding {
                binding: binding.id.clone(),
                value: reference,
                compound: None,
            },
            false,
        );
    }
    let body_end = builder.lower_stmts(&function.body, prologue_end, &ctx)?;
    let after_body = body_end.unwrap_or_else(|| builder.new_block());
    let exit_normal = builder.new_block();
    let exit_exceptional = builder.new_block();
    builder.blocks[after_body as usize].term = Term::Goto(exit_normal);
    builder.blocks[exit_normal as usize].term = Term::Sink;
    builder.blocks[exit_exceptional as usize].term = Term::Throw {
        value: None,
        handler: None,
    };
    if builder.overflow {
        return Err(invalid("flow_lowering_budget_exceeded"));
    }
    let looping_blocks = looping_blocks(&builder.blocks, entry);
    Ok(LoweredFunction {
        symbol: function.symbol.clone(),
        ops: builder.ops,
        cfg: Cfg {
            entry,
            exit_normal,
            exit_exceptional,
            blocks: builder.blocks,
            exception_edges: builder.exception_edges,
            looping_blocks,
        },
    })
}

impl Builder {
    fn new_block(&mut self) -> BlockId {
        if self.blocks.len() >= MAX_BLOCKS_PER_FUNCTION {
            // Record the breach; the function is rejected wholesale afterwards.
            self.overflow = true;
            return 0;
        }
        self.blocks.push(Block {
            ops: Vec::new(),
            term: Term::Sink,
        });
        (self.blocks.len() - 1) as BlockId
    }

    /// Internal expression temporary; written on every path before its read.
    fn temp(&mut self, hint: &str) -> String {
        self.temps += 1;
        format!("t:{}/{}:{}", self.temp_prefix, hint, self.temps)
    }

    fn emit(
        &mut self,
        block: BlockId,
        start: usize,
        end: usize,
        kind: OpKind,
        may_throw: bool,
    ) -> u32 {
        if self.ops.len() >= MAX_OPS_PER_FUNCTION {
            self.overflow = true;
            return 0;
        }
        let index = self.ops.len() as u32;
        self.ops.push(Op {
            start,
            end,
            kind,
            may_throw,
        });
        self.blocks[block as usize].ops.push(index);
        if may_throw && let Some(handler) = self.throw_handler {
            self.exception_edges.push((index, handler));
        }
        index
    }

    /// Evaluate `expr` into the current block chain; returns the value op.
    /// `current` becomes None once control definitively leaves.
    fn eval(&mut self, current: &mut Option<BlockId>, expr: &Expr, ctx: &Ctx) -> Result<u32> {
        let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
        match &expr.kind {
            ExprKind::Const { value } => Ok(self.emit(
                block,
                expr.start,
                expr.end,
                OpKind::Const(value.clone()),
                false,
            )),
            ExprKind::Local { binding } => Ok(self.emit(
                block,
                expr.start,
                expr.end,
                OpKind::ReadLocal(binding.clone()),
                false,
            )),
            ExprKind::External { name } => Ok(self.emit(
                block,
                expr.start,
                expr.end,
                OpKind::ReadExternal(name.clone()),
                false,
            )),
            ExprKind::This => Ok(self.emit(block, expr.start, expr.end, OpKind::This, false)),
            ExprKind::FunctionRef { symbol } => Ok(self.emit(
                block,
                expr.start,
                expr.end,
                OpKind::FunctionRef(symbol.clone()),
                false,
            )),
            ExprKind::Unknown { reason } => Ok(self.emit(
                block,
                expr.start,
                expr.end,
                OpKind::UnknownOp {
                    reason: reason.clone(),
                },
                true,
            )),
            ExprKind::Assign { op, target, value } => {
                self.eval_assign(block, expr, op, target, value, ctx)
            }
            ExprKind::Binary { op, left, right } => {
                let lhs = self.eval(current, left, ctx)?;
                let rhs = self.eval(current, right, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::Binary {
                        op: op.clone(),
                        left: lhs,
                        right: rhs,
                    },
                    binary_may_throw(op),
                ))
            }
            ExprKind::ShortCircuit { op, left, right } => {
                let lhs = self.eval(current, left, ctx)?;
                let block =
                    current.ok_or_else(|| invalid("flow_short_circuit_after_terminator"))?;
                let temp = self.temp("sc");
                let join = self.new_block();
                let skip_block = self.new_block();
                let rhs_block = self.new_block();
                match op.as_str() {
                    // Nullish (true) evaluates the RHS; non-nullish yields the
                    // left value directly.
                    "??" => {
                        let test = self.emit(
                            block,
                            expr.start,
                            left.end,
                            OpKind::NullishTest { value: lhs },
                            false,
                        );
                        self.blocks[block as usize].term = Term::Branch {
                            cond: test,
                            if_true: rhs_block,
                            if_false: skip_block,
                        };
                    }
                    "&&" => {
                        self.blocks[block as usize].term = Term::Branch {
                            cond: lhs,
                            if_true: rhs_block,
                            if_false: skip_block,
                        };
                    }
                    _ => {
                        self.blocks[block as usize].term = Term::Branch {
                            cond: lhs,
                            if_true: skip_block,
                            if_false: rhs_block,
                        };
                    }
                }
                // RHS path stores the evaluated right value.
                *current = Some(rhs_block);
                let rhs_value = self.eval(current, right, ctx)?;
                let rhs_end =
                    current.ok_or_else(|| invalid("flow_short_circuit_after_terminator"))?;
                self.emit(
                    rhs_end,
                    expr.start,
                    expr.end,
                    OpKind::AssignBinding {
                        binding: temp.clone(),
                        value: rhs_value,
                        compound: None,
                    },
                    false,
                );
                self.blocks[rhs_end as usize].term = Term::Goto(join);
                // Skip path stores the left value.
                self.emit(
                    skip_block,
                    expr.start,
                    expr.end,
                    OpKind::AssignBinding {
                        binding: temp.clone(),
                        value: lhs,
                        compound: None,
                    },
                    false,
                );
                self.blocks[skip_block as usize].term = Term::Goto(join);
                let result = self.emit(
                    join,
                    expr.start,
                    expr.end,
                    OpKind::ReadLocal(temp.clone()),
                    false,
                );
                *current = Some(join);
                Ok(result)
            }
            ExprKind::Conditional {
                cond,
                then_value,
                else_value,
            } => {
                let cond_op = self.eval(current, cond, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_conditional_after_terminator"))?;
                let temp = self.temp("cond");
                let join = self.new_block();
                let then_block = self.new_block();
                let else_block = self.new_block();
                self.blocks[block as usize].term = Term::Branch {
                    cond: cond_op,
                    if_true: then_block,
                    if_false: else_block,
                };
                *current = Some(then_block);
                let then_op = self.eval(current, then_value, ctx)?;
                let then_end =
                    current.ok_or_else(|| invalid("flow_conditional_after_terminator"))?;
                self.emit(
                    then_end,
                    expr.start,
                    expr.end,
                    OpKind::AssignBinding {
                        binding: temp.clone(),
                        value: then_op,
                        compound: None,
                    },
                    false,
                );
                self.blocks[then_end as usize].term = Term::Goto(join);
                *current = Some(else_block);
                let else_op = self.eval(current, else_value, ctx)?;
                let else_end =
                    current.ok_or_else(|| invalid("flow_conditional_after_terminator"))?;
                self.emit(
                    else_end,
                    expr.start,
                    expr.end,
                    OpKind::AssignBinding {
                        binding: temp.clone(),
                        value: else_op,
                        compound: None,
                    },
                    false,
                );
                self.blocks[else_end as usize].term = Term::Goto(join);
                let result = self.emit(
                    join,
                    expr.start,
                    expr.end,
                    OpKind::ReadLocal(temp.clone()),
                    false,
                );
                *current = Some(join);
                Ok(result)
            }
            ExprKind::Unary { op, operand } => {
                let value = self.eval(current, operand, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::Unary {
                        op: op.clone(),
                        operand: value,
                    },
                    matches!(op.as_str(), "-" | "+" | "~"),
                ))
            }
            ExprKind::Call {
                callee,
                args,
                optional,
            } => {
                let callee_op = self.eval(current, callee, ctx)?;
                let mut arg_ops = Vec::new();
                for arg in args {
                    arg_ops.push(self.eval(current, arg, ctx)?);
                }
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::Call {
                        callee: callee_op,
                        args: arg_ops,
                        optional: *optional,
                    },
                    true,
                ))
            }
            ExprKind::New { callee, args } => {
                let callee_op = self.eval(current, callee, ctx)?;
                let mut arg_ops = Vec::new();
                for arg in args {
                    arg_ops.push(self.eval(current, arg, ctx)?);
                }
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::New {
                        callee: callee_op,
                        args: arg_ops,
                    },
                    true,
                ))
            }
            ExprKind::PropertyRead {
                object,
                name,
                optional,
            } => {
                let object_op = self.eval(current, object, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::PropertyRead {
                        object: object_op,
                        name: name.clone(),
                        optional: *optional,
                    },
                    !optional,
                ))
            }
            ExprKind::ArrayLiteral { elements } => {
                let mut element_ops = Vec::new();
                for element in elements {
                    element_ops.push(
                        element
                            .as_ref()
                            .map(|e| self.eval(current, e, ctx))
                            .transpose()?
                            .unwrap_or(0),
                    );
                }
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::AllocArray {
                        elements: element_ops,
                    },
                    false,
                ))
            }
            ExprKind::ObjectLiteral { fields } => {
                let mut field_ops = Vec::new();
                for field in fields {
                    let value_op = self.eval(current, &field.value, ctx)?;
                    field_ops.push((field.name.clone(), value_op));
                }
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::AllocObject { fields: field_ops },
                    false,
                ))
            }
        }
    }

    fn eval_assign(
        &mut self,
        block: BlockId,
        expr: &Expr,
        op: &str,
        target: &AssignTarget,
        value: &Expr,
        ctx: &Ctx,
    ) -> Result<u32> {
        match target {
            AssignTarget::Binding { binding } => {
                let mut current = Some(block);
                let value_op = self.eval(&mut current, value, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                let compound = if op == "=" {
                    None
                } else {
                    Some(op.to_string())
                };
                let throwing = compound.is_some();
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::AssignBinding {
                        binding: binding.clone(),
                        value: value_op,
                        compound,
                    },
                    throwing,
                ))
            }
            AssignTarget::Property { object, name } => {
                // JS order: member target expression, then RHS, then write.
                let mut current = Some(block);
                let object_op = self.eval(&mut current, object, ctx)?;
                let value_op = self.eval(&mut current, value, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::PropertyWrite {
                        object: object_op,
                        name: name.clone(),
                        value: value_op,
                    },
                    true,
                ))
            }
            AssignTarget::Element { object, key } => {
                // JS order: object, then key, then the RHS, then the write.
                //
                // The location is not nameable, so this is honestly a write to
                // an unknown location -- not a claim that some binding was
                // written, and not the older claim that the target was not
                // modelled. The difference is measurable: object and key are
                // evaluated now, so a call inside either of them is a real op
                // with real effects instead of vanishing with the target.
                let mut current = Some(block);
                let object_op = self.eval(&mut current, object, ctx)?;
                let key_op = self.eval(&mut current, key, ctx)?;
                let value_op = self.eval(&mut current, value, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                let _ = (object_op, key_op, value_op);
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::UnknownOp {
                        reason: format!("element_write_location_unknown:{op}"),
                    },
                    true,
                ))
            }
            AssignTarget::Unknown => {
                let mut current = Some(block);
                let _value_op = self.eval(&mut current, value, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_expression_after_terminator"))?;
                Ok(self.emit(
                    block,
                    expr.start,
                    expr.end,
                    OpKind::UnknownOp {
                        reason: format!("unmodeled_assignment_target:{op}"),
                    },
                    true,
                ))
            }
        }
    }

    fn lower_stmts(
        &mut self,
        stmts: &[Stmt],
        entry: BlockId,
        ctx: &Ctx,
    ) -> Result<Option<BlockId>> {
        let mut current = Some(entry);
        for stmt in stmts {
            match current {
                Some(block) => current = self.lower_stmt(stmt, block, ctx)?,
                None => return Ok(None),
            }
        }
        Ok(current)
    }

    fn lower_stmt(&mut self, stmt: &Stmt, block: BlockId, ctx: &Ctx) -> Result<Option<BlockId>> {
        match &stmt.kind {
            StmtKind::Empty => Ok(Some(block)),
            StmtKind::Block { body } => self.lower_stmts(body, block, ctx),
            StmtKind::VarDecl { declarators, .. } => {
                let mut current = Some(block);
                for declarator in declarators {
                    if let Some(init) = &declarator.init {
                        let value_op = self.eval(&mut current, init, ctx)?;
                        let write_block =
                            current.ok_or_else(|| invalid("flow_declaration_after_terminator"))?;
                        self.emit(
                            write_block,
                            stmt.start,
                            stmt.end,
                            OpKind::AssignBinding {
                                binding: declarator.binding.clone(),
                                value: value_op,
                                compound: None,
                            },
                            false,
                        );
                    } else {
                        // `let x;` initializes to undefined at this point.
                        let write_block =
                            current.ok_or_else(|| invalid("flow_declaration_after_terminator"))?;
                        let undefined = self.emit(
                            write_block,
                            stmt.start,
                            stmt.end,
                            OpKind::Const(ConstValue::Undefined),
                            false,
                        );
                        self.emit(
                            write_block,
                            stmt.start,
                            stmt.end,
                            OpKind::AssignBinding {
                                binding: declarator.binding.clone(),
                                value: undefined,
                                compound: None,
                            },
                            false,
                        );
                    }
                }
                Ok(current)
            }
            StmtKind::Expression { expr } => {
                let mut current = Some(block);
                self.eval(&mut current, expr, ctx)?;
                Ok(current)
            }
            StmtKind::If {
                cond,
                then_body,
                else_body,
            } => {
                let mut current = Some(block);
                let cond_op = self.eval(&mut current, cond, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_condition_after_terminator"))?;
                let then_entry = self.new_block();
                let else_entry = self.new_block();
                self.blocks[block as usize].term = Term::Branch {
                    cond: cond_op,
                    if_true: then_entry,
                    if_false: else_entry,
                };
                let then_end = self.lower_stmts(then_body, then_entry, ctx)?;
                let else_end = self.lower_stmts(else_body, else_entry, ctx)?;
                match (then_end, else_end) {
                    (Some(t), Some(e)) => {
                        let join = self.new_block();
                        self.blocks[t as usize].term = Term::Goto(join);
                        self.blocks[e as usize].term = Term::Goto(join);
                        Ok(Some(join))
                    }
                    (Some(t), None) => {
                        let join = self.new_block();
                        self.blocks[t as usize].term = Term::Goto(join);
                        Ok(Some(join))
                    }
                    (None, Some(e)) => {
                        let join = self.new_block();
                        self.blocks[e as usize].term = Term::Goto(join);
                        Ok(Some(join))
                    }
                    (None, None) => Ok(None),
                }
            }
            StmtKind::While { cond, body } => {
                self.lower_loop(LoopKind::While { cond, body }, None, block, ctx)
            }
            StmtKind::DoWhile { body, cond } => {
                self.lower_loop(LoopKind::DoWhile { body, cond }, None, block, ctx)
            }
            StmtKind::For {
                init,
                cond,
                update,
                body,
            } => self.lower_loop(
                LoopKind::For {
                    init,
                    cond,
                    update,
                    body,
                },
                None,
                block,
                ctx,
            ),
            StmtKind::Switch {
                discriminant,
                cases,
            } => self.lower_switch(discriminant, cases, block, ctx),
            StmtKind::Return { value } => {
                let mut current = Some(block);
                let value_op = match value {
                    Some(value) => Some(self.eval(&mut current, value, ctx)?),
                    None => None,
                };
                let block = current.ok_or_else(|| invalid("flow_return_after_terminator"))?;
                if self.completion_router.last().is_some() {
                    let entry = self.completion_router.last().unwrap().entry;
                    self.emit(
                        block,
                        stmt.start,
                        stmt.end,
                        OpKind::SetCompletion {
                            kind: CompletionKind::Return,
                            value: value_op,
                        },
                        false,
                    );
                    self.blocks[block as usize].term = Term::Goto(entry);
                } else {
                    self.blocks[block as usize].term = Term::Return { value: value_op };
                }
                Ok(None)
            }
            StmtKind::Throw { expr } => {
                let mut current = Some(block);
                let value_op = self.eval(&mut current, expr, ctx)?;
                let block = current.ok_or_else(|| invalid("flow_throw_after_terminator"))?;
                self.blocks[block as usize].term = Term::Throw {
                    value: Some(value_op),
                    handler: self.throw_handler,
                };
                Ok(None)
            }
            StmtKind::Break { label } => {
                let matched = ctx
                    .breaks
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, (name, _, _))| name == label);
                if let Some((index, (_, target, depth))) = matched {
                    self.route_completion(
                        block,
                        stmt,
                        CompletionKind::Break(index),
                        None,
                        *target,
                        *depth,
                    );
                }
                Ok(None)
            }
            StmtKind::Continue { label } => {
                let matched = ctx
                    .continues
                    .iter()
                    .enumerate()
                    .rev()
                    .find(|(_, (name, _, _))| name == label);
                if let Some((index, (_, target, depth))) = matched {
                    self.route_completion(
                        block,
                        stmt,
                        CompletionKind::Continue(index),
                        None,
                        *target,
                        *depth,
                    );
                }
                Ok(None)
            }
            StmtKind::Try {
                body,
                catch_param,
                catch_body,
                finally_body,
            } => self.lower_try(
                stmt,
                body,
                (catch_param, catch_body),
                finally_body,
                block,
                ctx,
            ),
            StmtKind::Labeled { label, body } => match &body.kind {
                StmtKind::While { cond, body } => {
                    self.lower_loop(LoopKind::While { cond, body }, Some(label), block, ctx)
                }
                StmtKind::DoWhile { body, cond } => {
                    self.lower_loop(LoopKind::DoWhile { body, cond }, Some(label), block, ctx)
                }
                StmtKind::For {
                    init,
                    cond,
                    update,
                    body,
                } => self.lower_loop(
                    LoopKind::For {
                        init,
                        cond,
                        update,
                        body,
                    },
                    Some(label),
                    block,
                    ctx,
                ),
                StmtKind::Switch {
                    discriminant,
                    cases,
                } => {
                    let exit = self.new_block();
                    let mut switch_ctx = ctx.clone();
                    let depth = self.completion_router.len();
                    switch_ctx.breaks.push((Some(label.clone()), exit, depth));
                    self.lower_switch_inner(discriminant, cases, block, &switch_ctx, exit)
                }
                _ => {
                    let exit = self.new_block();
                    let mut inner = ctx.clone();
                    let depth = self.completion_router.len();
                    inner.breaks.push((Some(label.clone()), exit, depth));
                    if let Some(end) = self.lower_stmt(body, block, &inner)? {
                        self.blocks[end as usize].term = Term::Goto(exit);
                    }
                    Ok(Some(exit))
                }
            },
            StmtKind::Unknown { reason } => {
                self.emit(
                    block,
                    stmt.start,
                    stmt.end,
                    OpKind::UnknownOp {
                        reason: reason.clone(),
                    },
                    true,
                );
                Ok(Some(block))
            }
        }
    }

    /// Route a break/continue completion through `finally` frames deeper than
    /// the entry's own depth; frames at or above it are not crossed.
    fn route_completion(
        &mut self,
        block: BlockId,
        stmt: &Stmt,
        kind: CompletionKind,
        value: Option<u32>,
        target: BlockId,
        entry_depth: usize,
    ) {
        if self.completion_router.len() > entry_depth {
            let entry = self.completion_router.last().unwrap().entry;
            self.emit(
                block,
                stmt.start,
                stmt.end,
                OpKind::SetCompletion { kind, value },
                false,
            );
            self.blocks[block as usize].term = Term::Goto(entry);
        } else {
            self.blocks[block as usize].term = Term::Goto(target);
        }
    }

    fn lower_loop(
        &mut self,
        kind: LoopKind,
        label: Option<&String>,
        block: BlockId,
        ctx: &Ctx,
    ) -> Result<Option<BlockId>> {
        let exit = self.new_block();
        match &kind {
            LoopKind::While { cond, body } => {
                let cond_block = self.new_block();
                self.blocks[block as usize].term = Term::Goto(cond_block);
                let mut current = Some(cond_block);
                let cond_op = self.eval(&mut current, cond, ctx)?;
                let cond_block_end =
                    current.ok_or_else(|| invalid("flow_condition_after_terminator"))?;
                let body_entry = self.new_block();
                self.blocks[cond_block_end as usize].term = Term::Branch {
                    cond: cond_op,
                    if_true: body_entry,
                    if_false: exit,
                };
                let mut loop_ctx = ctx.clone();
                let depth = self.completion_router.len();
                if let Some(label) = label {
                    loop_ctx.breaks.push((Some(label.clone()), exit, depth));
                    loop_ctx
                        .continues
                        .push((Some(label.clone()), cond_block, depth));
                }
                loop_ctx.breaks.push((None, exit, depth));
                loop_ctx.continues.push((None, cond_block, depth));
                let body_end = self.lower_stmts(body, body_entry, &loop_ctx)?;
                if let Some(end) = body_end {
                    self.blocks[end as usize].term = Term::Goto(cond_block);
                }
                Ok(Some(exit))
            }
            LoopKind::DoWhile { body, cond } => {
                let body_entry = self.new_block();
                self.blocks[block as usize].term = Term::Goto(body_entry);
                let cond_block = self.new_block();
                let mut loop_ctx = ctx.clone();
                let depth = self.completion_router.len();
                if let Some(label) = label {
                    loop_ctx.breaks.push((Some(label.clone()), exit, depth));
                    loop_ctx
                        .continues
                        .push((Some(label.clone()), cond_block, depth));
                }
                loop_ctx.breaks.push((None, exit, depth));
                loop_ctx.continues.push((None, cond_block, depth));
                let body_end = self.lower_stmts(body, body_entry, &loop_ctx)?;
                let mut current = Some(cond_block);
                let cond_op = self.eval(&mut current, cond, ctx)?;
                let cond_end = current.ok_or_else(|| invalid("flow_condition_after_terminator"))?;
                self.blocks[cond_end as usize].term = Term::Branch {
                    cond: cond_op,
                    if_true: body_entry,
                    if_false: exit,
                };
                if let Some(end) = body_end {
                    self.blocks[end as usize].term = Term::Goto(cond_block);
                }
                Ok(Some(exit))
            }
            LoopKind::For {
                init,
                cond,
                update,
                body,
            } => {
                let mut current = Some(block);
                if let Some(init) = init {
                    current = self.lower_stmt(init, block, ctx)?;
                }
                let pre_body = current.ok_or_else(|| invalid("flow_for_init_terminated"))?;
                let cond_block = self.new_block();
                self.blocks[pre_body as usize].term = Term::Goto(cond_block);
                let mut cond_current = Some(cond_block);
                let cond_op = match cond {
                    Some(cond) => Some(self.eval(&mut cond_current, cond, ctx)?),
                    None => None,
                };
                let cond_end = cond_current.ok_or_else(|| invalid("flow_for_cond_terminated"))?;
                let body_entry = self.new_block();
                let update_block = self.new_block();
                match cond_op {
                    Some(cond_op) => {
                        self.blocks[cond_end as usize].term = Term::Branch {
                            cond: cond_op,
                            if_true: body_entry,
                            if_false: exit,
                        };
                    }
                    None => {
                        self.blocks[cond_end as usize].term = Term::Goto(body_entry);
                    }
                }
                let mut loop_ctx = ctx.clone();
                let depth = self.completion_router.len();
                if let Some(label) = label {
                    loop_ctx.breaks.push((Some(label.clone()), exit, depth));
                    loop_ctx
                        .continues
                        .push((Some(label.clone()), update_block, depth));
                }
                loop_ctx.breaks.push((None, exit, depth));
                loop_ctx.continues.push((None, update_block, depth));
                let body_end = self.lower_stmts(body, body_entry, &loop_ctx)?;
                if let Some(end) = body_end {
                    self.blocks[end as usize].term = Term::Goto(update_block);
                }
                let mut update_current = Some(update_block);
                if let Some(update) = update {
                    self.eval(&mut update_current, update, ctx)?;
                }
                if let Some(update_end) = update_current {
                    self.blocks[update_end as usize].term = Term::Goto(cond_block);
                } else {
                    self.blocks[update_block as usize].term = Term::Goto(cond_block);
                }
                Ok(Some(exit))
            }
        }
    }

    fn lower_switch(
        &mut self,
        discriminant: &Expr,
        cases: &[SwitchCase],
        block: BlockId,
        ctx: &Ctx,
    ) -> Result<Option<BlockId>> {
        let exit = self.new_block();
        let mut switch_ctx = ctx.clone();
        switch_ctx
            .breaks
            .push((None, exit, self.completion_router.len()));
        self.lower_switch_inner(discriminant, cases, block, &switch_ctx, exit)
    }

    fn lower_switch_inner(
        &mut self,
        discriminant: &Expr,
        cases: &[SwitchCase],
        block: BlockId,
        ctx: &Ctx,
        exit: BlockId,
    ) -> Result<Option<BlockId>> {
        let mut current = Some(block);
        let disc = self.eval(&mut current, discriminant, ctx)?;
        let block = current.ok_or_else(|| invalid("flow_switch_disc_terminated"))?;
        let body_entries: Vec<BlockId> = cases.iter().map(|_| self.new_block()).collect();
        let default_entry = cases
            .iter()
            .position(|case| case.test.is_none())
            .map(|position| body_entries[position]);
        let mut next_test: Option<BlockId> = default_entry.or(Some(exit));
        for (position, case) in cases.iter().enumerate().rev() {
            let Some(test) = &case.test else { continue };
            let test_block = self.new_block();
            let test_value = self.eval(&mut Some(test_block), test, ctx)?;
            let test_op = self.emit(
                test_block,
                test.start,
                test.end,
                OpKind::CaseTest {
                    disc,
                    test: test_value,
                },
                false,
            );
            self.blocks[test_block as usize].term = Term::Branch {
                cond: test_op,
                if_true: body_entries[position],
                if_false: next_test.unwrap_or(exit),
            };
            next_test = Some(test_block);
        }
        self.blocks[block as usize].term = Term::Goto(next_test.unwrap_or(exit));
        // Bodies fall through to the next case in source order.
        for (position, case) in cases.iter().enumerate().rev() {
            let fallthrough = body_entries.get(position + 1).copied().or(Some(exit));
            let end = self.lower_stmts(&case.body, body_entries[position], ctx)?;
            if let (Some(end), Some(next)) = (end, fallthrough) {
                self.blocks[end as usize].term = Term::Goto(next);
            }
        }
        Ok(Some(exit))
    }

    fn lower_try(
        &mut self,
        stmt: &Stmt,
        body: &[Stmt],
        catch: (&Option<String>, &Option<Vec<Stmt>>),
        finally_body: &Option<Vec<Stmt>>,
        block: BlockId,
        ctx: &Ctx,
    ) -> Result<Option<BlockId>> {
        let (catch_param, catch_body) = catch;
        if catch_body.is_none() && finally_body.is_none() {
            return self.lower_stmts(body, block, ctx);
        }
        let [start, end] = [stmt.start, stmt.end];
        let finally_entry = finally_body.is_some().then(|| self.new_block());
        let catch_entry = catch_body.is_some().then(|| self.new_block());
        // Exceptions leaving try/catch route through the landing pad so the
        // shared finally still runs.
        let landing = if finally_body.is_some() {
            Some(self.new_block())
        } else {
            None
        };

        let outer_throw_handler = self.throw_handler;
        let outer_router = std::mem::take(&mut self.completion_router);
        let captured_breaks = ctx.breaks.clone();
        let captured_continues = ctx.continues.clone();

        // try body: throws go to catch, else the landing pad; completions cross
        // this finally before any outer one.
        self.throw_handler = catch_entry.or(landing).or(outer_throw_handler);
        if let Some(finally_entry) = finally_entry {
            self.completion_router.push(FinallyFrame {
                entry: finally_entry,
            });
        }
        let try_end = self.lower_stmts(body, block, ctx)?;

        let mut normal_paths: Vec<BlockId> = Vec::new();
        if let Some(exit_block) = try_end {
            if let Some(finally_entry) = finally_entry {
                self.emit(
                    exit_block,
                    start,
                    end,
                    OpKind::SetCompletion {
                        kind: CompletionKind::Normal,
                        value: None,
                    },
                    false,
                );
                self.blocks[exit_block as usize].term = Term::Goto(finally_entry);
            } else {
                normal_paths.push(exit_block);
            }
        }

        if let (Some(catch_entry), Some(catch_body)) = (catch_entry, catch_body.clone()) {
            if let Some(param) = catch_param {
                // JS allows `catch {}` without a binding: only bind when the
                // worker declared one; the exception value stays available for
                // rethrow either way.
                let exception_op =
                    self.emit(catch_entry, start, end, OpKind::CurrentException, false);
                self.emit(
                    catch_entry,
                    start,
                    end,
                    OpKind::AssignBinding {
                        binding: param.clone(),
                        value: exception_op,
                        compound: None,
                    },
                    false,
                );
            }
            // A throw from inside catch must not re-enter the same catch.
            self.throw_handler = landing.or(outer_throw_handler);
            let catch_end = self.lower_stmts(&catch_body, catch_entry, ctx)?;
            if let Some(exit_block) = catch_end {
                if let Some(finally_entry) = finally_entry {
                    self.emit(
                        exit_block,
                        start,
                        end,
                        OpKind::SetCompletion {
                            kind: CompletionKind::Normal,
                            value: None,
                        },
                        false,
                    );
                    self.blocks[exit_block as usize].term = Term::Goto(finally_entry);
                } else {
                    normal_paths.push(exit_block);
                }
            }
        }

        if let (Some(finally_entry), Some(finally_body)) = (finally_entry, finally_body) {
            if let Some(landing) = landing {
                let exception_op = self.emit(landing, start, end, OpKind::CurrentException, false);
                self.emit(
                    landing,
                    start,
                    end,
                    OpKind::SetCompletion {
                        kind: CompletionKind::Throw,
                        value: Some(exception_op),
                    },
                    false,
                );
                self.blocks[landing as usize].term = Term::Goto(finally_entry);
            }
            // The finally body runs with the outer handler/router; its own
            // completions do not re-enter itself.
            self.throw_handler = outer_throw_handler;
            self.completion_router = outer_router.clone();
            let finally_end = self.lower_stmts(finally_body, finally_entry, ctx)?;
            let Some(dispatch_point) = finally_end else {
                // The finally always terminates (return/throw/break): the
                // pending completion never resumes and control cannot
                // continue normally after the try.
                self.throw_handler = outer_throw_handler;
                self.completion_router = outer_router;
                return Ok(None);
            };
            let normal_target = self.new_block();
            let return_target = self.new_block();
            let throw_target = self.new_block();
            // Entries deeper than the outer router are consumed here; shallower
            // ones continue through the outer frames.
            let route = |entries: &[(Option<String>, BlockId, usize)]| -> Vec<(Option<String>, BlockId, bool)> {
                entries
                    .iter()
                    .map(|(label, target, depth)| {
                        let consumed = *depth >= outer_router.len();
                        (label.clone(), if consumed { *target } else { outer_router.last().unwrap().entry }, consumed)
                    })
                    .collect()
            };
            self.blocks[dispatch_point as usize].term = Term::Dispatch {
                normal: normal_target,
                on_return: if outer_router.is_empty() {
                    return_target
                } else {
                    outer_router.last().unwrap().entry
                },
                on_throw: if outer_router.is_empty() {
                    throw_target
                } else {
                    outer_router.last().unwrap().entry
                },
                breaks: route(&captured_breaks),
                continues: route(&captured_continues),
            };
            self.blocks[return_target as usize].term = Term::Return { value: None };
            self.blocks[throw_target as usize].term = Term::Throw {
                value: None,
                handler: outer_throw_handler,
            };
            self.throw_handler = outer_throw_handler;
            self.completion_router = outer_router;
            return Ok(Some(normal_target));
        }

        self.throw_handler = outer_throw_handler;
        self.completion_router = outer_router;
        match normal_paths.len() {
            0 => Ok(None),
            1 => Ok(normal_paths.pop()),
            _ => {
                let join = self.new_block();
                for exit_block in normal_paths {
                    self.blocks[exit_block as usize].term = Term::Goto(join);
                }
                Ok(Some(join))
            }
        }
    }
}

enum LoopKind<'x> {
    While {
        cond: &'x Expr,
        body: &'x [Stmt],
    },
    DoWhile {
        body: &'x [Stmt],
        cond: &'x Expr,
    },
    For {
        init: &'x Option<Box<Stmt>>,
        cond: &'x Option<Expr>,
        update: &'x Option<Expr>,
        body: &'x [Stmt],
    },
}

fn binary_may_throw(op: &str) -> bool {
    // `===`/`!==` never invoke user code; `,` only evaluates operands.
    !matches!(op, "===" | "!==" | ",")
}

/// Blocks on a CFG cycle (iterative Kosaraju over the block graph).
fn looping_blocks(blocks: &[Block], entry: BlockId) -> BTreeSet<BlockId> {
    let mut forward: BTreeMap<BlockId, Vec<BlockId>> = BTreeMap::new();
    let mut reverse: BTreeMap<BlockId, Vec<BlockId>> = BTreeMap::new();
    for (index, block) in blocks.iter().enumerate() {
        let id = index as BlockId;
        for next in successors(block) {
            forward.entry(id).or_default().push(next);
            reverse.entry(next).or_default().push(id);
        }
        forward.entry(id).or_default();
    }
    let mut seen = BTreeSet::new();
    let mut order = Vec::new();
    let mut stack: Vec<(BlockId, bool)> = vec![(entry, false)];
    while let Some((node, finish)) = stack.pop() {
        if finish {
            order.push(node);
            continue;
        }
        if !seen.insert(node) {
            continue;
        }
        stack.push((node, true));
        for next in &forward[&node] {
            if !seen.contains(next) {
                stack.push((*next, false));
            }
        }
    }
    let mut assigned: BTreeMap<BlockId, BlockId> = BTreeMap::new();
    let mut components: Vec<BTreeSet<BlockId>> = Vec::new();
    for root in order.into_iter().rev() {
        if assigned.contains_key(&root) {
            continue;
        }
        let mut component = BTreeSet::new();
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            if assigned.contains_key(&node) {
                continue;
            }
            assigned.insert(node, root);
            component.insert(node);
            if let Some(parents) = reverse.get(&node) {
                stack.extend(parents.iter().copied());
            }
        }
        components.push(component);
    }
    let mut result = BTreeSet::new();
    for component in components {
        let cyclic =
            component.len() > 1 || component.iter().any(|node| forward[node].contains(node));
        if cyclic {
            result.extend(component);
        }
    }
    result
}

fn successors(block: &Block) -> Vec<BlockId> {
    match &block.term {
        Term::Goto(target) => vec![*target],
        Term::Branch {
            if_true, if_false, ..
        } => vec![*if_true, *if_false],
        Term::Dispatch {
            normal,
            on_return,
            on_throw,
            breaks,
            continues,
        } => {
            let mut all = vec![*normal, *on_return, *on_throw];
            all.extend(breaks.iter().map(|(_, target, _)| *target));
            all.extend(continues.iter().map(|(_, target, _)| *target));
            all
        }
        _ => vec![],
    }
}

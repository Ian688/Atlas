//! Semantic fixtures for the local CFG and abstract interpreter (W02/W03).
//!
//! Each expectation is written from JavaScript semantics first (see the
//! comment per fixture); the fixture IR mirrors the worker wire format. These
//! cover D02 (short-circuit), D03/D04 (finally completion), D05 (loop
//! fixpoint), D07/D08 (candidate sets and strong local updates), D12
//! (parameter origins) and D01-lite (TDZ).

use atlas_contract::*;
use serde_json::json;
use std::collections::BTreeMap;

fn expr(start: usize, end: usize, kind: ExprKind) -> Expr {
    Expr { start, end, kind }
}

fn stmt(start: usize, end: usize, kind: StmtKind) -> Stmt {
    Stmt { start, end, kind }
}

fn local(binding: &str) -> Expr {
    expr(
        0,
        1,
        ExprKind::Local {
            binding: binding.into(),
        },
    )
}

fn funcref(symbol: &str) -> Expr {
    expr(
        0,
        1,
        ExprKind::FunctionRef {
            symbol: symbol.into(),
        },
    )
}

fn call(callee: Expr) -> Expr {
    expr(
        0,
        1,
        ExprKind::Call {
            callee: Box::new(callee),
            args: vec![],
            optional: false,
        },
    )
}

fn function(name: &str, params: &[&str], body: Vec<Stmt>) -> FlowFunction {
    let mut bindings = Vec::new();
    let mut param_ids = Vec::new();
    for (index, param) in params.iter().enumerate() {
        let id = format!("b:f.ts:p{index}:{param}");
        param_ids.push(id.clone());
        bindings.push(FlowBinding {
            id,
            name: (*param).into(),
            kind: "param".into(),
            scope: "s:f.ts:0:function".into(),
            decl_start: 0,
            decl_end: 1,
            hoisted: false,
            default_value: None,
            function_symbol: None,
        });
    }
    FlowFunction {
        symbol: format!("symbol:f.ts:0:99:{name}"),
        name: name.into(),
        path: "f.ts".into(),
        start: 0,
        end: 99,
        params: param_ids,
        imports: Vec::new(),
        scopes: vec![FlowScope {
            id: "s:f.ts:0:function".into(),
            kind: "function".into(),
            parent: None,
            bindings: bindings.iter().map(|b| b.id.clone()).collect(),
        }],
        bindings,
        body,
        captures: vec![],
        unknown_regions: vec![],
    }
}

fn solve_one(
    function: &FlowFunction,
    directory: &BTreeMap<String, String>,
) -> atlas_engine::solve::SolveOutput {
    let lowered = atlas_engine::flow::build_cfg(function).expect("cfg");
    atlas_engine::solve::solve(&lowered, function, directory, &BTreeMap::new(), None, None)
}

fn param(function: &FlowFunction, name: &str) -> String {
    function
        .params
        .iter()
        .find(|id| id.ends_with(&format!(":{name}")))
        .cloned()
        .unwrap_or_else(|| panic!("param {name}"))
}

/// D02: `false && sideEffect()` must not evaluate the RHS; `false || g()`
/// must evaluate g. Short-circuit is control flow, not data merging.
#[test]
fn d02_short_circuit_rhs_reachability() {
    let directory = BTreeMap::from([(
        "b:f.ts:0:sideEffect".into(),
        "symbol:f.ts:0:99:sideEffect".into(),
    )]);
    let side_effect = local("b:f.ts:0:sideEffect");
    let body = vec![
        stmt(
            0,
            20,
            StmtKind::VarDecl {
                keyword: "let".into(),
                declarators: vec![Declarator {
                    binding: "b:f.ts:0:r".into(),
                    init: Some(expr(
                        0,
                        10,
                        ExprKind::ShortCircuit {
                            op: "&&".into(),
                            left: Box::new(expr(
                                0,
                                5,
                                ExprKind::Const {
                                    value: ConstValue::Bool { value: false },
                                },
                            )),
                            right: Box::new(call(side_effect.clone())),
                        },
                    )),
                }],
            },
        ),
        stmt(
            21,
            40,
            StmtKind::Return {
                value: Some(local("b:f.ts:0:r")),
            },
        ),
    ];
    let mut f = function("d02", &[], body);
    f.bindings.push(FlowBinding {
        id: "b:f.ts:0:r".into(),
        name: "r".into(),
        kind: "let".into(),
        scope: "s:f.ts:0:function".into(),
        decl_start: 0,
        decl_end: 1,
        hoisted: false,
        default_value: None,
        function_symbol: None,
    });
    f.scopes[0].bindings.push("b:f.ts:0:r".into());
    let output = solve_one(&f, &directory);
    // JS: `false && …` never calls sideEffect.
    assert!(
        !output
            .effects
            .may_call
            .iter()
            .any(|t| t == "symbol:f.ts:0:99:sideEffect"),
        "RHS of false && must be unreachable"
    );
    // The skipped branch is pruned by a constant condition and recorded.
    assert!(
        output
            .pruned_edges
            .iter()
            .any(|(_, _, reason)| *reason == "constant_condition"),
        "constant-true branch of `false &&` must be pruned with evidence"
    );
    // `false` still flows to the result of `&&`.
    assert_eq!(output.returns.constants, vec![json!(false)]);
}

/// D03/D04: finally preserves a pending return and its value, but does NOT
/// restore a clobbered environment: `let g=a; try { g=b; } finally {} return g;`
/// returns b, never a.
#[test]
fn d04_finally_preserves_completion_but_not_old_env() {
    let directory = BTreeMap::from([
        ("b:f.ts:0:a".into(), "symbol:f.ts:0:99:a".into()),
        ("b:f.ts:0:b".into(), "symbol:f.ts:0:99:b".into()),
    ]);
    let g = "b:f.ts:0:g";
    let body = vec![
        stmt(
            0,
            10,
            StmtKind::VarDecl {
                keyword: "let".into(),
                declarators: vec![Declarator {
                    binding: g.into(),
                    init: Some(funcref("symbol:f.ts:0:99:a")),
                }],
            },
        ),
        stmt(
            11,
            40,
            StmtKind::Try {
                body: vec![stmt(
                    12,
                    30,
                    StmtKind::Expression {
                        expr: expr(
                            12,
                            30,
                            ExprKind::Assign {
                                op: "=".into(),
                                target: AssignTarget::Binding { binding: g.into() },
                                value: Box::new(funcref("symbol:f.ts:0:99:b")),
                            },
                        ),
                    },
                )],
                catch_param: None,
                catch_body: None,
                finally_body: Some(vec![]),
            },
        ),
        stmt(
            41,
            60,
            StmtKind::Return {
                value: Some(local(g)),
            },
        ),
    ];
    let mut f = function("d04", &[], body);
    f.bindings.push(FlowBinding {
        id: g.into(),
        name: "g".into(),
        kind: "let".into(),
        scope: "s:f.ts:0:function".into(),
        decl_start: 0,
        decl_end: 1,
        hoisted: false,
        default_value: None,
        function_symbol: None,
    });
    f.scopes[0].bindings.push(g.into());
    let output = solve_one(&f, &directory);
    // JS: the finally runs but is empty; g stays b (strong update, no restore).
    assert_eq!(
        output.returns.targets,
        vec!["symbol:f.ts:0:99:b"],
        "empty finally must not restore g=a"
    );
}

/// D03: `try { return 1; } finally {}` returns 1; adding `return 2` in the
/// finally overrides it to 2. Completion values are preserved/overridden.
#[test]
fn d03_finally_completion_preserve_and_override() {
    let preserve = vec![stmt(
        0,
        30,
        StmtKind::Try {
            body: vec![stmt(
                1,
                15,
                StmtKind::Return {
                    value: Some(expr(
                        8,
                        15,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 1.0 },
                        },
                    )),
                },
            )],
            catch_param: None,
            catch_body: None,
            finally_body: Some(vec![]),
        },
    )];
    let f = function("d03", &[], preserve);
    let output = solve_one(&f, &BTreeMap::new());
    // JS: pending return(1) passes through the empty finally.
    assert_eq!(
        output.returns.constants,
        vec![json!(1.0)],
        "finally must preserve the pending return value"
    );

    let override_body = vec![stmt(
        0,
        40,
        StmtKind::Try {
            body: vec![stmt(
                1,
                15,
                StmtKind::Return {
                    value: Some(expr(
                        8,
                        15,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 1.0 },
                        },
                    )),
                },
            )],
            catch_param: None,
            catch_body: None,
            finally_body: Some(vec![stmt(
                20,
                38,
                StmtKind::Return {
                    value: Some(expr(
                        27,
                        37,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 2.0 },
                        },
                    )),
                },
            )]),
        },
    )];
    let f2 = function("d03b", &[], override_body);
    let output2 = solve_one(&f2, &BTreeMap::new());
    // JS: the finally's own return replaces the pending completion.
    assert_eq!(
        output2.returns.constants,
        vec![json!(2.0)],
        "finally return must override the pending return"
    );
}

/// D05: a while loop reaches a fixpoint; the exit value joins the initial and
/// loop-carried definitions, and the loop body blocks are marked as looping.
#[test]
fn d05_loop_fixpoint_and_carried_update() {
    let x = "b:f.ts:p0:x";
    let cond = expr(
        0,
        10,
        ExprKind::Binary {
            op: "<".into(),
            left: Box::new(local(x)),
            right: Box::new(expr(
                0,
                10,
                ExprKind::Const {
                    value: ConstValue::Num { value: 3.0 },
                },
            )),
        },
    );
    let increment = expr(
        0,
        20,
        ExprKind::Assign {
            op: "=".into(),
            target: AssignTarget::Binding { binding: x.into() },
            value: Box::new(expr(
                0,
                20,
                ExprKind::Binary {
                    op: "+".into(),
                    left: Box::new(local(x)),
                    right: Box::new(expr(
                        0,
                        20,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 1.0 },
                        },
                    )),
                },
            )),
        },
    );
    let body = vec![
        stmt(
            0,
            5,
            StmtKind::VarDecl {
                keyword: "let".into(),
                declarators: vec![Declarator {
                    binding: x.into(),
                    init: Some(expr(
                        0,
                        5,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 0.0 },
                        },
                    )),
                }],
            },
        ),
        stmt(
            6,
            30,
            StmtKind::While {
                cond,
                body: vec![stmt(6, 30, StmtKind::Expression { expr: increment })],
            },
        ),
        stmt(
            31,
            50,
            StmtKind::Return {
                value: Some(local(x)),
            },
        ),
    ];
    let mut f = function("d05", &[], body);
    f.bindings.push(FlowBinding {
        id: x.into(),
        name: "x".into(),
        kind: "let".into(),
        scope: "s:f.ts:0:function".into(),
        decl_start: 0,
        decl_end: 1,
        hoisted: false,
        default_value: None,
        function_symbol: None,
    });
    f.scopes[0].bindings.push(x.into());
    let lowered = atlas_engine::flow::build_cfg(&f).expect("cfg");
    // JS: the loop runs at least the edge structure; a back edge must exist.
    assert!(
        !lowered.cfg.looping_blocks.is_empty(),
        "while loop must produce looping blocks"
    );
    let output =
        atlas_engine::solve::solve(&lowered, &f, &BTreeMap::new(), &BTreeMap::new(), None, None);
    assert_eq!(
        output.status, "complete_within_profile",
        "bounded loop lattice must converge"
    );
    // JS: exit value is either 0 (loop skipped) or the incremented result.
    let initial_zero = output.returns.constants.iter().any(|c| c == &json!("0"));
    let carried_unknown = output.returns.unknown
        && output.returns.reasons.iter().any(|reason| {
            reason.contains("non_constant") || reason.contains("widened") || reason.contains("cap")
        });
    assert!(
        initial_zero || carried_unknown,
        "exit state must join the initial and loop-carried values: {:?}",
        output.returns
    );
    // def-use: the return uses both the initial definition and the loop definition.
    let defs = &output.def_use.get(x).expect("def-use for x").0;
    assert!(
        defs.len() >= 2,
        "x must have the init def and the loop def, got {defs:?}"
    );
}

/// D07/D08: two-branch assignment keeps both candidates; an unconditional
/// reassignment kills the previous one.
#[test]
fn d07_d08_candidate_sets_and_strong_update() {
    let directory = BTreeMap::from([
        ("b:f.ts:0:fa".into(), "symbol:f.ts:0:99:a".into()),
        ("b:f.ts:0:fb".into(), "symbol:f.ts:0:99:b".into()),
    ]);
    // D07: let g = fa; if (cond) { g = fb; } g();  -> both a and b possible.
    let cond = param(&function("probe", &["cond"], vec![]), "cond");
    let g = "b:f.ts:0:g";
    let d07 = vec![
        stmt(
            0,
            10,
            StmtKind::VarDecl {
                keyword: "let".into(),
                declarators: vec![Declarator {
                    binding: g.into(),
                    init: Some(local("b:f.ts:0:fa")),
                }],
            },
        ),
        stmt(
            11,
            30,
            StmtKind::If {
                cond: local(&cond),
                then_body: vec![stmt(
                    12,
                    29,
                    StmtKind::Expression {
                        expr: expr(
                            12,
                            29,
                            ExprKind::Assign {
                                op: "=".into(),
                                target: AssignTarget::Binding { binding: g.into() },
                                value: Box::new(local("b:f.ts:0:fb")),
                            },
                        ),
                    },
                )],
                else_body: vec![],
            },
        ),
        stmt(
            31,
            50,
            StmtKind::Expression {
                expr: call(local(g)),
            },
        ),
    ];
    let mut f = function("d07", &["cond"], d07);
    f.bindings.push(FlowBinding {
        id: g.into(),
        name: "g".into(),
        kind: "let".into(),
        scope: "s:f.ts:0:function".into(),
        decl_start: 0,
        decl_end: 1,
        hoisted: false,
        default_value: None,
        function_symbol: None,
    });
    f.scopes[0].bindings.push(g.into());
    let output = solve_one(&f, &directory);
    let mut sorted = output.effects.may_call.to_vec();
    sorted.sort();
    assert_eq!(
        sorted,
        vec![
            "symbol:f.ts:0:99:a".to_string(),
            "symbol:f.ts:0:99:b".to_string()
        ],
        "both branch candidates must survive the join"
    );

    // D08: let g = fa; g = fb; g();  -> only b (kill of the earlier def).
    let d08 = vec![
        stmt(
            0,
            10,
            StmtKind::VarDecl {
                keyword: "let".into(),
                declarators: vec![Declarator {
                    binding: g.into(),
                    init: Some(local("b:f.ts:0:fa")),
                }],
            },
        ),
        stmt(
            11,
            30,
            StmtKind::Expression {
                expr: expr(
                    11,
                    30,
                    ExprKind::Assign {
                        op: "=".into(),
                        target: AssignTarget::Binding { binding: g.into() },
                        value: Box::new(local("b:f.ts:0:fb")),
                    },
                ),
            },
        ),
        stmt(
            31,
            50,
            StmtKind::Expression {
                expr: call(local(g)),
            },
        ),
    ];
    let f2 = function("d08", &[], d08);
    let output2 = solve_one(&f2, &directory);
    assert_eq!(
        output2.effects.may_call.as_slice(),
        &["symbol:f.ts:0:99:b".to_string()][..],
        "strong local update must kill the earlier candidate"
    );
}

/// D12: `function identity(x) { return x; }` keeps the Parameter(0) origin.
#[test]
fn d12_identity_preserves_parameter_origin() {
    let f = function(
        "identity",
        &["x"],
        vec![stmt(
            0,
            20,
            StmtKind::Return {
                value: Some(local("b:f.ts:p0:x")),
            },
        )],
    );
    let output = solve_one(&f, &BTreeMap::new());
    assert!(
        output
            .returns
            .origins
            .iter()
            .any(|origin| origin == "Parameter(0)"),
        "parameter origin must flow through identity: {:?}",
        output.returns.origins
    );
    assert!(
        !output.returns.unknown,
        "a plain parameter read is a known-origin unknown, not untracked"
    );
}

/// D01-lite: reading a `let` before its declarator executes is a TDZ read, not
/// an undefined value.
#[test]
fn d01_tdz_read_is_reported() {
    let x = "b:f.ts:0:x";
    let body = vec![
        stmt(
            0,
            10,
            StmtKind::Expression {
                expr: call(local(x)),
            },
        ),
        stmt(
            11,
            20,
            StmtKind::VarDecl {
                keyword: "let".into(),
                declarators: vec![Declarator {
                    binding: x.into(),
                    init: Some(expr(
                        0,
                        5,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 1.0 },
                        },
                    )),
                }],
            },
        ),
    ];
    let mut f = function("tdz", &[], body);
    f.bindings.push(FlowBinding {
        id: x.into(),
        name: "x".into(),
        kind: "let".into(),
        scope: "s:f.ts:0:function".into(),
        decl_start: 0,
        decl_end: 1,
        hoisted: false,
        default_value: None,
        function_symbol: None,
    });
    f.scopes[0].bindings.push(x.into());
    let output = solve_one(&f, &BTreeMap::new());
    assert!(
        output
            .unknown_reasons
            .contains("tdz_read_possible_reference_error"),
        "use before let-declaration must be reported as a TDZ read"
    );
    assert!(
        output.effects.may_throw,
        "TDZ read can throw a ReferenceError"
    );
}

/// D09: writes through an alias are visible on reads of the original binding,
/// and writes to unknown objects land in the wildcard heap that later reads merge.
#[test]
fn d09_alias_and_wildcard_heap_updates() {
    // const a = {}; const b = a; b.x = 1; return a.x;  -> 1 via the alias.
    let obj = expr(0, 5, ExprKind::ObjectLiteral { fields: vec![] });
    let alloc = expr(
        0,
        5,
        ExprKind::Const {
            value: ConstValue::Num { value: 0.0 },
        },
    ); // placeholder value op below
    let _ = alloc;
    let body = vec![
        stmt(
            0,
            10,
            StmtKind::VarDecl {
                keyword: "const".into(),
                declarators: vec![Declarator {
                    binding: "b:f.ts:0:a".into(),
                    init: Some(obj),
                }],
            },
        ),
        stmt(
            11,
            20,
            StmtKind::VarDecl {
                keyword: "const".into(),
                declarators: vec![Declarator {
                    binding: "b:f.ts:0:b".into(),
                    init: Some(local("b:f.ts:0:a")),
                }],
            },
        ),
        stmt(
            21,
            40,
            StmtKind::Expression {
                expr: expr(
                    21,
                    40,
                    ExprKind::Assign {
                        op: "=".into(),
                        target: AssignTarget::Property {
                            object: Box::new(local("b:f.ts:0:b")),
                            name: "x".into(),
                        },
                        value: Box::new(expr(
                            0,
                            5,
                            ExprKind::Const {
                                value: ConstValue::Num { value: 1.0 },
                            },
                        )),
                    },
                ),
            },
        ),
        stmt(
            41,
            60,
            StmtKind::Return {
                value: Some(expr(
                    41,
                    60,
                    ExprKind::PropertyRead {
                        object: Box::new(local("b:f.ts:0:a")),
                        name: "x".into(),
                        optional: false,
                    },
                )),
            },
        ),
    ];
    let mut f = function("alias", &[], body);
    for id in ["b:f.ts:0:a", "b:f.ts:0:b"] {
        f.bindings.push(FlowBinding {
            id: id.into(),
            name: id.rsplit(':').next().unwrap().into(),
            kind: "const".into(),
            scope: "s:f.ts:0:function".into(),
            decl_start: 0,
            decl_end: 1,
            hoisted: false,
            default_value: None,
            function_symbol: None,
        });
        f.scopes[0].bindings.push(id.into());
    }
    let output = solve_one(&f, &BTreeMap::new());
    assert!(
        output.returns.constants.contains(&json!(1.0)),
        "the alias write must be visible on the original binding read: {:?}",
        output.returns
    );

    // function g(o) { o.x = 1; return o.x; }  -> unknown object write lands in
    // the wildcard heap; the read merges it (weak update is still visible).
    let g = function(
        "wild",
        &["o"],
        vec![
            stmt(
                0,
                20,
                StmtKind::Expression {
                    expr: expr(
                        0,
                        20,
                        ExprKind::Assign {
                            op: "=".into(),
                            target: AssignTarget::Property {
                                object: Box::new(local("b:f.ts:p0:o")),
                                name: "x".into(),
                            },
                            value: Box::new(expr(
                                0,
                                5,
                                ExprKind::Const {
                                    value: ConstValue::Num { value: 1.0 },
                                },
                            )),
                        },
                    ),
                },
            ),
            stmt(
                21,
                40,
                StmtKind::Return {
                    value: Some(expr(
                        21,
                        40,
                        ExprKind::PropertyRead {
                            object: Box::new(local("b:f.ts:p0:o")),
                            name: "x".into(),
                            optional: false,
                        },
                    )),
                },
            ),
        ],
    );
    let out2 = solve_one(&g, &BTreeMap::new());
    assert!(
        out2.returns.constants.contains(&json!(1.0)),
        "wildcard weak update must be merged on read: {:?}",
        out2.returns
    );
    assert!(
        out2.effects.may_write_heap,
        "property write must report heap effects"
    );
}

/// D10: joining more constants than the cap yields Top with a cap reason,
/// never a silently truncated "these are all the values" claim.
#[test]
fn d10_cap_overflow_becomes_top_with_reason() {
    // Nine guarded assignments of distinct constants exceed CAP_CONSTANTS=8.
    let mut body = Vec::new();
    for index in 1..=9 {
        body.push(stmt(
            0,
            5,
            StmtKind::If {
                cond: expr(
                    0,
                    5,
                    ExprKind::Binary {
                        op: "===".into(),
                        left: Box::new(local("b:f.ts:p0:n")),
                        right: Box::new(expr(
                            0,
                            5,
                            ExprKind::Const {
                                value: ConstValue::Num {
                                    value: index as f64,
                                },
                            },
                        )),
                    },
                ),
                then_body: vec![stmt(
                    0,
                    5,
                    StmtKind::Expression {
                        expr: expr(
                            0,
                            5,
                            ExprKind::Assign {
                                op: "=".into(),
                                target: AssignTarget::Binding {
                                    binding: "b:f.ts:0:v".into(),
                                },
                                value: Box::new(expr(
                                    0,
                                    5,
                                    ExprKind::Const {
                                        value: ConstValue::Num {
                                            value: index as f64,
                                        },
                                    },
                                )),
                            },
                        ),
                    },
                )],
                else_body: vec![],
            },
        ));
    }
    body.push(stmt(
        0,
        5,
        StmtKind::Return {
            value: Some(local("b:f.ts:0:v")),
        },
    ));
    let mut f = function("caps", &["n"], body);
    f.bindings.push(FlowBinding {
        id: "b:f.ts:0:v".into(),
        name: "v".into(),
        kind: "let".into(),
        scope: "s:f.ts:0:function".into(),
        decl_start: 0,
        decl_end: 1,
        hoisted: false,
        default_value: None,
        function_symbol: None,
    });
    f.scopes[0].bindings.push("b:f.ts:0:v".into());
    let output = solve_one(&f, &BTreeMap::new());
    assert!(
        output.returns.unknown,
        "nine joined constants must exceed the cap and become top"
    );
    assert!(
        output
            .returns
            .reasons
            .iter()
            .any(|reason| reason.contains("cap_exceeded")),
        "cap overflow must be reported with a reason, got {:?}",
        output.returns.reasons
    );
    assert!(
        output.returns.constants.len() <= 8,
        "capped sets never pretend a truncated set is exhaustive"
    );
}

/// W04 helpers: build a multi-function FlowFacts and run the interprocedural
/// driver with a hand-made binding directory (mirrors the worker wire format).
fn call_args(callee: Expr, args: Vec<Expr>) -> Expr {
    expr(
        0,
        1,
        ExprKind::Call {
            callee: Box::new(callee),
            args,
            optional: false,
        },
    )
}

fn simple_function(name: &str, params: &[&str], body: Vec<Stmt>) -> FlowFunction {
    function(name, params, body)
}

fn run_interproc(
    functions: Vec<FlowFunction>,
    directory: BTreeMap<String, String>,
) -> atlas_engine::inter::InterprocResult {
    let flow = FlowFacts {
        schema: FLOW_SCHEMA.into(),
        snapshot_id: "t".into(),
        producer: atlas_contract::WORKER_PRODUCER.into(),
        profile: FLOW_PROFILE.into(),
        functions,
        diagnostics: vec![],
    };
    atlas_engine::inter::analyze_interprocedural(&flow, &directory, None).expect("interproc")
}

fn binding(id: &str) -> FlowBinding {
    FlowBinding {
        id: id.into(),
        name: id.rsplit(':').next().unwrap().into(),
        kind: "function".into(),
        scope: "s:f.ts:0:function".into(),
        decl_start: 0,
        decl_end: 1,
        hoisted: true,
        default_value: None,
        function_symbol: Some(format!(
            "symbol:f.ts:0:99:{}",
            id.rsplit(':').next().unwrap()
        )),
    }
}

/// D13/ET-21: two callers of `identity` get their own argument origins back;
/// nothing streams across callsites.
#[test]
fn d13_caller_isolation_through_summary() {
    let identity = simple_function(
        "identity",
        &["v"],
        vec![stmt(
            0,
            20,
            StmtKind::Return {
                value: Some(local("b:f.ts:0:identity")),
            },
        )],
    );
    // identity returns its parameter; the parameter read resolves via the body.
    let identity_body = simple_function(
        "identity",
        &["v"],
        vec![stmt(
            0,
            20,
            StmtKind::Return {
                value: Some(local("b:f.ts:p0:v")),
            },
        )],
    );
    let caller_a = simple_function(
        "callerA",
        &[],
        vec![stmt(
            0,
            30,
            StmtKind::Return {
                value: Some(call_args(
                    local("b:f.ts:0:identity"),
                    vec![expr(
                        0,
                        5,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 5.0 },
                        },
                    )],
                )),
            },
        )],
    );
    let caller_b = simple_function(
        "callerB",
        &["g"],
        vec![stmt(
            0,
            30,
            StmtKind::Return {
                value: Some(call_args(
                    local("b:f.ts:0:identity"),
                    vec![local("b:f.ts:p0:g")],
                )),
            },
        )],
    );
    let directory = BTreeMap::from([(
        "b:f.ts:0:identity".to_string(),
        "symbol:f.ts:0:99:identity".to_string(),
    )]);
    let result = run_interproc(vec![identity_body, caller_a, caller_b], directory);
    assert_eq!(result.status, "complete_within_profile");
    let a = &result.functions["symbol:f.ts:0:99:callerA"].output;
    let b = &result.functions["symbol:f.ts:0:99:callerB"].output;
    assert!(
        a.returns.origins.iter().any(|origin| origin == "Constant"),
        "callerA must receive its own constant through identity: {:?}",
        a.returns.origins
    );
    assert!(
        !a.returns
            .origins
            .iter()
            .any(|origin| origin.starts_with("Parameter")),
        "callerA must not see callerB's parameter origin"
    );
    assert!(
        b.returns
            .origins
            .iter()
            .any(|origin| origin == "Parameter(0)"),
        "callerB must receive its own parameter origin: {:?}",
        b.returns.origins
    );
    assert!(
        !b.returns.origins.iter().any(|origin| origin == "Constant"),
        "callerB must not see callerA's constant"
    );
    let _ = identity;
}

/// D14: a five-layer call chain forwards its argument to the deepest function
/// and the origin survives all five re-bases.
#[test]
fn d14_five_layer_chain_propagates_origin() {
    let mut functions = Vec::new();
    functions.push(simple_function(
        "chain0",
        &["x"],
        vec![stmt(
            0,
            20,
            StmtKind::Return {
                value: Some(local("b:f.ts:p0:x")),
            },
        )],
    ));
    for level in 1..=4 {
        functions.push(simple_function(
            &format!("chain{level}"),
            &["x"],
            vec![stmt(
                0,
                30,
                StmtKind::Return {
                    value: Some(call_args(
                        local(&format!("b:f.ts:0:chain{}", level - 1)),
                        vec![local("b:f.ts:p0:x")],
                    )),
                },
            )],
        ));
    }
    let mut directory = BTreeMap::new();
    for level in 0..=5 {
        directory.insert(
            format!("b:f.ts:0:chain{level}"),
            format!("symbol:f.ts:0:99:chain{level}"),
        );
    }
    let chain5 = simple_function(
        "chain5",
        &["x"],
        vec![stmt(
            0,
            30,
            StmtKind::Return {
                value: Some(call_args(
                    local("b:f.ts:0:chain4"),
                    vec![local("b:f.ts:p0:x")],
                )),
            },
        )],
    );
    let entry = simple_function(
        "entry",
        &[],
        vec![stmt(
            0,
            30,
            StmtKind::Return {
                value: Some(call_args(
                    local("b:f.ts:0:chain5"),
                    vec![expr(
                        0,
                        5,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 7.0 },
                        },
                    )],
                )),
            },
        )],
    );
    functions.push(chain5);
    functions.push(entry);
    let result = run_interproc(functions, directory);
    assert_eq!(
        result.status, "complete_within_profile",
        "{:?}",
        result.status
    );
    let entry_out = &result.functions["symbol:f.ts:0:99:entry"].output;
    assert!(
        entry_out
            .returns
            .origins
            .iter()
            .any(|origin| origin == "Constant"),
        "origin must survive five summary re-bases: {:?}",
        entry_out.returns.origins
    );
}

/// D15: mutual recursion converges inside a bounded SCC iteration; pending
/// summaries never become a "no return" proof.
#[test]
fn d15_mutual_recursion_converges_without_negative_proof() {
    let is_even = simple_function(
        "isEven",
        &["n"],
        vec![
            stmt(
                0,
                10,
                StmtKind::If {
                    cond: expr(
                        0,
                        5,
                        ExprKind::Binary {
                            op: "===".into(),
                            left: Box::new(local("b:f.ts:p0:n")),
                            right: Box::new(expr(
                                0,
                                5,
                                ExprKind::Const {
                                    value: ConstValue::Num { value: 0.0 },
                                },
                            )),
                        },
                    ),
                    then_body: vec![stmt(
                        0,
                        10,
                        StmtKind::Return {
                            value: Some(expr(
                                0,
                                10,
                                ExprKind::Const {
                                    value: ConstValue::Bool { value: true },
                                },
                            )),
                        },
                    )],
                    else_body: vec![],
                },
            ),
            stmt(
                11,
                30,
                StmtKind::Return {
                    value: Some(call_args(
                        local("b:f.ts:0:isOdd"),
                        vec![expr(
                            0,
                            10,
                            ExprKind::Binary {
                                op: "-".into(),
                                left: Box::new(local("b:f.ts:p0:n")),
                                right: Box::new(expr(
                                    0,
                                    10,
                                    ExprKind::Const {
                                        value: ConstValue::Num { value: 1.0 },
                                    },
                                )),
                            },
                        )],
                    )),
                },
            ),
        ],
    );
    let is_odd = simple_function(
        "isOdd",
        &["n"],
        vec![
            stmt(
                0,
                10,
                StmtKind::If {
                    cond: expr(
                        0,
                        5,
                        ExprKind::Binary {
                            op: "===".into(),
                            left: Box::new(local("b:f.ts:p0:n")),
                            right: Box::new(expr(
                                0,
                                5,
                                ExprKind::Const {
                                    value: ConstValue::Num { value: 0.0 },
                                },
                            )),
                        },
                    ),
                    then_body: vec![stmt(
                        0,
                        10,
                        StmtKind::Return {
                            value: Some(expr(
                                0,
                                10,
                                ExprKind::Const {
                                    value: ConstValue::Bool { value: false },
                                },
                            )),
                        },
                    )],
                    else_body: vec![],
                },
            ),
            stmt(
                11,
                30,
                StmtKind::Return {
                    value: Some(call_args(
                        local("b:f.ts:0:isEven"),
                        vec![expr(
                            0,
                            10,
                            ExprKind::Binary {
                                op: "-".into(),
                                left: Box::new(local("b:f.ts:p0:n")),
                                right: Box::new(expr(
                                    0,
                                    10,
                                    ExprKind::Const {
                                        value: ConstValue::Num { value: 1.0 },
                                    },
                                )),
                            },
                        )],
                    )),
                },
            ),
        ],
    );
    let directory = BTreeMap::from([
        (
            "b:f.ts:0:isOdd".to_string(),
            "symbol:f.ts:0:99:isOdd".to_string(),
        ),
        (
            "b:f.ts:0:isEven".to_string(),
            "symbol:f.ts:0:99:isEven".to_string(),
        ),
    ]);
    let result = run_interproc(vec![is_even, is_odd], directory);
    assert_eq!(
        result.recursive_sccs, 1,
        "isEven/isOdd form one recursive SCC"
    );
    assert_eq!(
        result.status, "complete_within_profile",
        "bounded mutual recursion must converge"
    );
    for symbol in ["symbol:f.ts:0:99:isEven", "symbol:f.ts:0:99:isOdd"] {
        let output = &result.functions[symbol].output;
        assert_eq!(output.status, "complete_within_profile");
        assert!(
            !output
                .returns
                .reasons
                .iter()
                .any(|reason| reason == "no_return_observed"),
            "pending recursion must not be reported as a no-return proof"
        );
        assert!(
            output.returns.constants.contains(&json!(true))
                || output.returns.constants.contains(&json!(false)),
            "base-case booleans must survive the SCC fixpoint: {:?}",
            output.returns.constants
        );
    }
}

/// D17: `compute` forwards its input to `parse`; the call edge and the
/// forwarded data origin are separate observable facts, with no invented edge.
#[test]
fn d17_forwarding_keeps_call_and_data_edges_distinct() {
    let parse = simple_function(
        "parse",
        &["tokens"],
        vec![stmt(
            0,
            20,
            StmtKind::Return {
                value: Some(local("b:f.ts:p0:tokens")),
            },
        )],
    );
    let compute = simple_function(
        "compute",
        &["input"],
        vec![stmt(
            0,
            30,
            StmtKind::Return {
                value: Some(call_args(
                    local("b:f.ts:0:parse"),
                    vec![local("b:f.ts:p0:input")],
                )),
            },
        )],
    );
    let directory = BTreeMap::from([(
        "b:f.ts:0:parse".to_string(),
        "symbol:f.ts:0:99:parse".to_string(),
    )]);
    let result = run_interproc(vec![parse, compute], directory);
    let compute_inter = &result.functions["symbol:f.ts:0:99:compute"];
    let callsite = compute_inter
        .output
        .internal
        .callsites
        .values()
        .next()
        .expect("compute must record its callsite");
    // The call edge targets exactly parse.
    assert_eq!(callsite.targets, vec!["symbol:f.ts:0:99:parse".to_string()]);
    assert!(!callsite.unknown_component);
    // The forwarded data edge: the argument origin is compute's own parameter.
    let arg_json = atlas_engine::solve::value_to_json(&callsite.args[0]);
    assert!(
        arg_json
            .origins
            .iter()
            .any(|origin| origin == "Parameter(0)"),
        "the argument record must show compute's input origin: {:?}",
        arg_json.origins
    );
    // The returned value re-bases through parse back to compute's parameter.
    assert!(
        compute_inter
            .output
            .returns
            .origins
            .iter()
            .any(|origin| origin == "Parameter(0)"),
        "compute returns what parse returned, which is compute's input: {:?}",
        compute_inter.output.returns.origins
    );
    let _ = binding;
}

/// D18: contradictory/unknown path conditions keep both branches statically
/// possible; the solver never claims which one executed.
#[test]
fn d18_branch_conditions_stay_possible_without_execution_claims() {
    let x = "b:f.ts:0:x";
    let cond = |negated: bool| {
        let operand = local("b:f.ts:p0:a");
        if negated {
            expr(
                0,
                5,
                ExprKind::Unary {
                    op: "!".into(),
                    operand: Box::new(operand),
                },
            )
        } else {
            operand
        }
    };
    let return_const_at = |start: usize, end: usize, value: f64| -> Stmt {
        stmt(
            start,
            end,
            StmtKind::Return {
                value: Some(expr(
                    0,
                    5,
                    ExprKind::Const {
                        value: ConstValue::Num { value },
                    },
                )),
            },
        )
    };
    #[allow(clippy::redundant_closure)]
    let return_const = |value: f64| -> Stmt {
        stmt(
            0,
            5,
            StmtKind::Return {
                value: Some(expr(
                    0,
                    5,
                    ExprKind::Const {
                        value: ConstValue::Num { value },
                    },
                )),
            },
        )
    };
    let body = vec![
        stmt(
            0,
            20,
            StmtKind::If {
                cond: cond(false),
                then_body: vec![return_const(1.0)],
                else_body: vec![stmt(
                    0,
                    20,
                    StmtKind::If {
                        cond: cond(true),
                        then_body: vec![return_const(2.0)],
                        else_body: vec![],
                    },
                )],
            },
        ),
        return_const_at(21, 30, 3.0),
    ];
    let mut f = function("d18", &["a"], body);
    f.bindings.push(FlowBinding {
        id: x.into(),
        name: "x".into(),
        kind: "let".into(),
        scope: "s:f.ts:0:function".into(),
        decl_start: 0,
        decl_end: 1,
        hoisted: false,
        default_value: None,
        function_symbol: None,
    });
    let output = solve_one(&f, &BTreeMap::new());
    for value in [1.0, 2.0, 3.0] {
        assert!(
            output.returns.constants.contains(&json!(value)),
            "all statically possible returns stay present: missing {value} in {:?}",
            output.returns.constants
        );
    }
    assert!(
        !output
            .unknown_reasons
            .iter()
            .any(|reason| reason.contains("executed") || reason.contains("always")),
        "no execution or termination claim may appear in static facts"
    );
}

/// R5: an expired pipeline deadline aborts the interprocedural derivation
/// before any Analysis could be published.
#[test]
fn r5_expired_deadline_aborts_derivation() {
    let f = simple_function(
        "f",
        &["x"],
        vec![stmt(
            0,
            20,
            StmtKind::Return {
                value: Some(local("b:f.ts:p0:x")),
            },
        )],
    );
    let flow = FlowFacts {
        schema: FLOW_SCHEMA.into(),
        snapshot_id: "t".into(),
        producer: atlas_contract::WORKER_PRODUCER.into(),
        profile: FLOW_PROFILE.into(),
        functions: vec![f],
        diagnostics: vec![],
    };
    let result = atlas_engine::inter::analyze_interprocedural(
        &flow,
        &BTreeMap::new(),
        Some(std::time::Instant::now() - std::time::Duration::from_secs(1)),
    );
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("expired deadline must abort the derivation"),
    };
    assert!(
        error.to_string().contains("analysis_deadline_exceeded"),
        "got: {error}"
    );
}

// ===================== W02 formal regression tests =====================
// Extracted from the independent review probes (evidence/reviews/2026-09-09-w01)
// plus adjacent perturbations that do not copy the probe fixtures.

/// Append plain local bindings to a hand-built function.
fn with_local_bindings(mut function: FlowFunction, bindings: &[(&str, &str)]) -> FlowFunction {
    for (id, kind) in bindings {
        function.bindings.push(FlowBinding {
            id: (*id).into(),
            name: id.rsplit(':').next().unwrap().into(),
            kind: (*kind).into(),
            scope: function.scopes[0].id.clone(),
            decl_start: 0,
            decl_end: 1,
            hoisted: false,
            default_value: None,
            function_symbol: None,
        });
        function.scopes[0].bindings.push((*id).into());
    }
    function
}

fn interproc_value(
    functions: Vec<FlowFunction>,
    directory: BTreeMap<String, String>,
    entry: &str,
) -> atlas_engine::solve::ValueJson {
    let flow = FlowFacts {
        schema: FLOW_SCHEMA.into(),
        snapshot_id: "t".into(),
        producer: atlas_contract::WORKER_PRODUCER.into(),
        profile: FLOW_PROFILE.into(),
        functions,
        diagnostics: vec![],
    };
    let result =
        atlas_engine::inter::analyze_interprocedural(&flow, &directory, None).expect("interproc");
    assert_eq!(result.status, "complete_within_profile");
    result.functions[entry].output.returns.clone()
}

/// R2: a known setter's heap write re-bases onto the caller's object.
#[test]
fn r2_known_setter_write_rebases_to_caller_object() {
    let set_value = simple_function(
        "setValue",
        &["o"],
        vec![stmt(
            0,
            30,
            StmtKind::Expression {
                expr: expr(
                    0,
                    30,
                    ExprKind::Assign {
                        op: "=".into(),
                        target: AssignTarget::Property {
                            object: Box::new(local("b:f.ts:p0:o")),
                            name: "value".into(),
                        },
                        value: Box::new(expr(
                            0,
                            5,
                            ExprKind::Const {
                                value: ConstValue::Num { value: 2.0 },
                            },
                        )),
                    },
                ),
            },
        )],
    );
    let caller = simple_function(
        "knownMutation",
        &[],
        vec![
            stmt(
                0,
                10,
                StmtKind::VarDecl {
                    keyword: "const".into(),
                    declarators: vec![Declarator {
                        binding: "b:f.ts:0:o".into(),
                        init: Some(expr(
                            0,
                            10,
                            ExprKind::ObjectLiteral {
                                fields: vec![ObjectField {
                                    name: "value".into(),
                                    value: expr(
                                        0,
                                        5,
                                        ExprKind::Const {
                                            value: ConstValue::Num { value: 1.0 },
                                        },
                                    ),
                                }],
                            },
                        )),
                    }],
                },
            ),
            stmt(
                11,
                30,
                StmtKind::Expression {
                    expr: call_args(local("b:f.ts:0:setValue"), vec![local("b:f.ts:0:o")]),
                },
            ),
            stmt(
                31,
                50,
                StmtKind::Return {
                    value: Some(expr(
                        31,
                        50,
                        ExprKind::PropertyRead {
                            object: Box::new(local("b:f.ts:0:o")),
                            name: "value".into(),
                            optional: false,
                        },
                    )),
                },
            ),
        ],
    );
    let caller = with_local_bindings(caller, &[("b:f.ts:0:o", "const")]);
    let directory = BTreeMap::from([(
        "b:f.ts:0:setValue".to_string(),
        "symbol:f.ts:0:99:setValue".to_string(),
    )]);
    let functions = vec![set_value, caller];
    let returns = interproc_value(functions, directory, "symbol:f.ts:0:99:knownMutation");
    assert!(
        returns.constants.contains(&json!(2.0)),
        "the setter's write must be visible after the call: {:?}",
        returns.constants
    );
}

/// R2 perturbation: an unknown callee dissolves escaped heap entries into
/// wildcard tops, so the read stays sound instead of returning a stale value.
#[test]
fn r2_unknown_call_clobbers_escaped_objects() {
    let caller = simple_function(
        "unknownMutation",
        &["change"],
        vec![
            stmt(
                0,
                10,
                StmtKind::VarDecl {
                    keyword: "const".into(),
                    declarators: vec![Declarator {
                        binding: "b:f.ts:0:o".into(),
                        init: Some(expr(
                            0,
                            10,
                            ExprKind::ObjectLiteral {
                                fields: vec![ObjectField {
                                    name: "value".into(),
                                    value: expr(
                                        0,
                                        5,
                                        ExprKind::Const {
                                            value: ConstValue::Num { value: 1.0 },
                                        },
                                    ),
                                }],
                            },
                        )),
                    }],
                },
            ),
            stmt(
                11,
                30,
                StmtKind::Expression {
                    expr: call_args(local("b:f.ts:p0:change"), vec![local("b:f.ts:0:o")]),
                },
            ),
            stmt(
                31,
                50,
                StmtKind::Return {
                    value: Some(expr(
                        31,
                        50,
                        ExprKind::PropertyRead {
                            object: Box::new(local("b:f.ts:0:o")),
                            name: "value".into(),
                            optional: false,
                        },
                    )),
                },
            ),
        ],
    );
    let caller = with_local_bindings(caller, &[("b:f.ts:0:o", "const")]);
    let output = solve_one(&caller, &BTreeMap::new());
    assert!(
        output.effects.unknown_call,
        "the external call must be unknown"
    );
    assert!(
        output.returns.unknown,
        "the read must stay sound against a possible external write: {:?}",
        output.returns
    );
}

/// R4: declared JS primitive addition matrix, driven by the language rules
/// (numeric conversion for bool/null, concatenation only when a string is
/// present, NaN propagation for undefined, exact decimal text).
#[test]
fn r4_primitive_addition_matrix() {
    let num = |n: f64| ConstValue::Num { value: n };
    let cases: Vec<(ConstValue, ConstValue, ConstValue)> = vec![
        (num(1.0), ConstValue::Bool { value: true }, num(2.0)),
        (ConstValue::Null, num(1.0), num(1.0)),
        (ConstValue::Bool { value: true }, ConstValue::Null, num(1.0)),
        (
            ConstValue::Bool { value: false },
            ConstValue::Bool { value: false },
            num(0.0),
        ),
        (ConstValue::Undefined, num(1.0), num(f64::NAN)),
        (
            ConstValue::Str { value: "a".into() },
            ConstValue::Bool { value: true },
            ConstValue::Str {
                value: "atrue".into(),
            },
        ),
        (
            ConstValue::Str { value: "".into() },
            num(0.5),
            ConstValue::Str {
                value: "0.5".into(),
            },
        ),
        (
            num(1.0),
            ConstValue::Str { value: "1".into() },
            ConstValue::Str { value: "11".into() },
        ),
    ];
    for (a, b, expected) in cases {
        let folded = atlas_engine::solve::fold_constants("+", &a, &b);
        let is_nan = matches!(
            &expected,
            ConstValue::Num { value: n } if n.is_nan()
        );
        let ok = match &folded {
            Some(ConstValue::Num { value: n2 }) if n2.is_nan() => is_nan,
            Some(actual) => actual == &expected,
            None => false,
        };
        assert!(
            ok,
            "{a:?} + {b:?} folded to {folded:?}, expected {expected:?}"
        );
    }
}

/// R1 perturbation: a throw between two assignments keeps only the first
/// assignment visible on the exceptional path, and both paths feed the join.
#[test]
fn r1_perturbation_throw_ordering_keeps_partial_state() {
    let x = "b:f.ts:0:x";
    let try_stmt = stmt(
        10,
        30,
        StmtKind::Try {
            body: vec![
                stmt(
                    11,
                    18,
                    StmtKind::Expression {
                        expr: expr(
                            11,
                            18,
                            ExprKind::Assign {
                                op: "=".into(),
                                target: AssignTarget::Binding { binding: x.into() },
                                value: Box::new(expr(
                                    0,
                                    5,
                                    ExprKind::Const {
                                        value: ConstValue::Num { value: 5.0 },
                                    },
                                )),
                            },
                        ),
                    },
                ),
                stmt(
                    19,
                    26,
                    StmtKind::Throw {
                        expr: expr(
                            19,
                            26,
                            ExprKind::Const {
                                value: ConstValue::Num { value: 9.0 },
                            },
                        ),
                    },
                ),
                stmt(
                    27,
                    33,
                    StmtKind::Expression {
                        expr: expr(
                            27,
                            33,
                            ExprKind::Assign {
                                op: "=".into(),
                                target: AssignTarget::Binding { binding: x.into() },
                                value: Box::new(expr(
                                    0,
                                    5,
                                    ExprKind::Const {
                                        value: ConstValue::Num { value: 99.0 },
                                    },
                                )),
                            },
                        ),
                    },
                ),
            ],
            catch_param: None,
            catch_body: None,
            finally_body: None,
        },
    );
    let return_stmt = stmt(
        34,
        50,
        StmtKind::Return {
            value: Some(local(x)),
        },
    );
    let decl = stmt(
        0,
        10,
        StmtKind::VarDecl {
            keyword: "let".into(),
            declarators: vec![Declarator {
                binding: x.into(),
                init: Some(expr(
                    0,
                    5,
                    ExprKind::Const {
                        value: ConstValue::Num { value: 1.0 },
                    },
                )),
            }],
        },
    );
    let body = [decl, try_stmt.clone(), return_stmt.clone()];
    let body = vec![body[0].clone(), try_stmt, return_stmt];
    let mut f = function("throwOrder", &[], body);
    f.bindings.push(FlowBinding {
        id: x.into(),
        name: "x".into(),
        kind: "let".into(),
        scope: "s:f.ts:0:function".into(),
        decl_start: 0,
        decl_end: 1,
        hoisted: false,
        default_value: None,
        function_symbol: None,
    });
    f.scopes[0].bindings.push(x.into());
    let output = solve_one(&f, &BTreeMap::new());
    // JS: throw after x=5 leaves x=5; the x=99 assignment never runs.
    assert!(
        !output.returns.constants.contains(&json!(99.0)),
        "state after a throw must not flow into the exceptional successor: {:?}",
        output.returns.constants
    );
    assert!(
        output.throws.constants.contains(&json!(9.0)),
        "the thrown value must reach the exceptional exit: {:?}",
        output.throws.constants
    );
}

// ===================== w03 formal regression tests =====================
// Extracted from the second review's adjacent probes
// (evidence/reviews/2026-09-09-w02/probe_adjacent.py) plus perturbations.

/// F1: typed_constants must distinguish finite numbers from NaN/±Infinity and
/// from same-text strings.
#[test]
fn f1_typed_constants_are_machine_distinguishable() {
    let value = atlas_engine::solve::value_from_constants(vec![
        ConstValue::Num { value: 41.0 },
        ConstValue::Num { value: -5.0 },
        ConstValue::Num { value: 0.5 },
        ConstValue::Num { value: f64::NAN },
        ConstValue::Num {
            value: f64::INFINITY,
        },
        ConstValue::Num {
            value: f64::NEG_INFINITY,
        },
        ConstValue::Str {
            value: "NaN".into(),
        },
        ConstValue::Str {
            value: "Infinity".into(),
        },
    ]);
    let json = atlas_engine::solve::value_to_json(&value);
    let kinds: Vec<&str> = json.typed.iter().map(|t| t.kind).collect();
    assert_eq!(
        kinds,
        vec![
            "number",
            "number",
            "number",
            "nan",
            "infinity",
            "negative_infinity",
            "string",
            "string"
        ]
    );
    // Finite numbers keep their exact value in the tag.
    assert_eq!(
        json.typed[0].value.as_ref().and_then(|v| v.as_f64()),
        Some(41.0)
    );
    // The legacy plain field still shows the ambiguity for strings, which is
    // why the tagged sidecar exists: index 3 is real NaN, index 6 is the
    // string "NaN", and both serialize to the same legacy value.
    assert_eq!(json.constants[3], json!("NaN"));
    assert_eq!(json.constants[6], json!("NaN"));
    assert_ne!(json.typed[3].kind, json.typed[6].kind);
}

/// F5: JS number text uses shortest round-tripping decimals, including
/// magnitudes beyond i64 and the exponent threshold.
#[test]
fn f5_big_number_to_string_is_exact() {
    let big = ConstValue::Num { value: 1e20 };
    assert_eq!(
        atlas_engine::solve::js_string(&big).as_deref(),
        Some("100000000000000000000")
    );
    let i64_boundary = ConstValue::Num {
        value: 9223372036854775808.0,
    };
    assert_eq!(
        atlas_engine::solve::js_string(&i64_boundary).as_deref(),
        Some("9223372036854776000")
    );
    let negative_big = ConstValue::Num { value: -1e20 };
    assert_eq!(
        atlas_engine::solve::js_string(&negative_big).as_deref(),
        Some("-100000000000000000000")
    );
    // At and above 1e21 JS switches to exponential notation.
    assert_eq!(
        atlas_engine::solve::js_string(&ConstValue::Num { value: 1e21 }).as_deref(),
        Some("1e+21")
    );
    // Concatenation folds the exact digits.
    let folded = atlas_engine::solve::fold_constants(
        "+",
        &ConstValue::Str { value: "".into() },
        &ConstValue::Num { value: 1e20 },
    );
    assert_eq!(
        folded,
        Some(ConstValue::Str {
            value: "100000000000000000000".into()
        })
    );
}

/// F2: a heap write through a wrapper layer propagates to the caller's read.
#[test]
fn f2_wrapper_layer_heap_write_is_visible() {
    let set = simple_function(
        "set",
        &["o"],
        vec![stmt(
            0,
            30,
            StmtKind::Expression {
                expr: expr(
                    0,
                    30,
                    ExprKind::Assign {
                        op: "=".into(),
                        target: AssignTarget::Property {
                            object: Box::new(local("b:f.ts:p0:o")),
                            name: "value".into(),
                        },
                        value: Box::new(expr(
                            0,
                            5,
                            ExprKind::Const {
                                value: ConstValue::Num { value: 2.0 },
                            },
                        )),
                    },
                ),
            },
        )],
    );
    let wrap = simple_function(
        "wrap",
        &["o"],
        vec![stmt(
            0,
            30,
            StmtKind::Expression {
                expr: call_args(local("b:f.ts:0:set"), vec![local("b:f.ts:p0:o")]),
            },
        )],
    );
    let caller = simple_function(
        "transitive",
        &[],
        vec![
            stmt(
                0,
                10,
                StmtKind::VarDecl {
                    keyword: "const".into(),
                    declarators: vec![Declarator {
                        binding: "b:f.ts:0:o".into(),
                        init: Some(expr(
                            0,
                            10,
                            ExprKind::ObjectLiteral {
                                fields: vec![ObjectField {
                                    name: "value".into(),
                                    value: expr(
                                        0,
                                        5,
                                        ExprKind::Const {
                                            value: ConstValue::Num { value: 1.0 },
                                        },
                                    ),
                                }],
                            },
                        )),
                    }],
                },
            ),
            stmt(
                11,
                30,
                StmtKind::Expression {
                    expr: call_args(local("b:f.ts:0:wrap"), vec![local("b:f.ts:0:o")]),
                },
            ),
            stmt(
                31,
                50,
                StmtKind::Return {
                    value: Some(expr(
                        31,
                        50,
                        ExprKind::PropertyRead {
                            object: Box::new(local("b:f.ts:0:o")),
                            name: "value".into(),
                            optional: false,
                        },
                    )),
                },
            ),
        ],
    );
    let caller = with_local_bindings(caller, &[("b:f.ts:0:o", "const")]);
    let directory = BTreeMap::from([
        (
            "b:f.ts:0:set".to_string(),
            "symbol:f.ts:0:99:set".to_string(),
        ),
        (
            "b:f.ts:0:wrap".to_string(),
            "symbol:f.ts:0:99:wrap".to_string(),
        ),
    ]);
    let returns = interproc_value(
        vec![set, wrap, caller],
        directory,
        "symbol:f.ts:0:99:transitive",
    );
    assert!(
        returns.constants.contains(&json!(2.0)),
        "the write must survive the wrapper layer: {:?}",
        returns.constants
    );
}

/// F4: an unknown call invalidates objects reachable transitively through
/// heap fields, so a nested read stays sound.
#[test]
fn f4_nested_reachable_objects_dissolve_on_unknown_call() {
    let caller = simple_function(
        "nestedUnknown",
        &["change"],
        vec![
            stmt(
                0,
                10,
                StmtKind::VarDecl {
                    keyword: "const".into(),
                    declarators: vec![Declarator {
                        binding: "b:f.ts:0:inner".into(),
                        init: Some(expr(
                            0,
                            10,
                            ExprKind::ObjectLiteral {
                                fields: vec![ObjectField {
                                    name: "value".into(),
                                    value: expr(
                                        0,
                                        5,
                                        ExprKind::Const {
                                            value: ConstValue::Num { value: 1.0 },
                                        },
                                    ),
                                }],
                            },
                        )),
                    }],
                },
            ),
            stmt(
                11,
                20,
                StmtKind::VarDecl {
                    keyword: "const".into(),
                    declarators: vec![Declarator {
                        binding: "b:f.ts:0:outer".into(),
                        init: Some(expr(
                            0,
                            20,
                            ExprKind::ObjectLiteral {
                                fields: vec![ObjectField {
                                    name: "inner".into(),
                                    value: local("b:f.ts:0:inner"),
                                }],
                            },
                        )),
                    }],
                },
            ),
            stmt(
                21,
                40,
                StmtKind::Expression {
                    expr: call_args(local("b:f.ts:p0:change"), vec![local("b:f.ts:0:outer")]),
                },
            ),
            stmt(
                41,
                60,
                StmtKind::Return {
                    value: Some(expr(
                        41,
                        60,
                        ExprKind::PropertyRead {
                            object: Box::new(local("b:f.ts:0:inner")),
                            name: "value".into(),
                            optional: false,
                        },
                    )),
                },
            ),
        ],
    );
    let caller = with_local_bindings(
        caller,
        &[("b:f.ts:0:inner", "const"), ("b:f.ts:0:outer", "const")],
    );
    let output = solve_one(&caller, &BTreeMap::new());
    assert!(
        output.returns.unknown,
        "a nested field reachable from the escaped argument must stay sound: {:?}",
        output.returns
    );
    assert!(
        !output.returns.constants.contains(&json!(1.0)) || output.returns.unknown,
        "old value must not be reported as the certain result"
    );
}

/// k=1: `pick(5)` folds the callee's parameter-value branch per calling
/// context — [1] for one caller and [2] for the other, instead of the merged
/// {1,2}.
#[test]
fn k1_context_sensitive_branch_folding() {
    let pick = simple_function(
        "pick",
        &["x"],
        vec![stmt(
            0,
            10,
            StmtKind::If {
                cond: expr(
                    0,
                    10,
                    ExprKind::Binary {
                        op: "===".into(),
                        left: Box::new(local("b:f.ts:p0:x")),
                        right: Box::new(expr(
                            0,
                            10,
                            ExprKind::Const {
                                value: ConstValue::Num { value: 5.0 },
                            },
                        )),
                    },
                ),
                then_body: vec![stmt(
                    0,
                    10,
                    StmtKind::Return {
                        value: Some(expr(
                            0,
                            10,
                            ExprKind::Const {
                                value: ConstValue::Num { value: 1.0 },
                            },
                        )),
                    },
                )],
                else_body: vec![stmt(
                    0,
                    10,
                    StmtKind::Return {
                        value: Some(expr(
                            0,
                            10,
                            ExprKind::Const {
                                value: ConstValue::Num { value: 2.0 },
                            },
                        )),
                    },
                )],
            },
        )],
    );
    let caller_a = simple_function(
        "callA",
        &[],
        vec![stmt(
            0,
            30,
            StmtKind::Return {
                value: Some(call_args(
                    local("b:f.ts:0:pick"),
                    vec![expr(
                        0,
                        10,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 5.0 },
                        },
                    )],
                )),
            },
        )],
    );
    let caller_b = simple_function(
        "callB",
        &[],
        vec![stmt(
            0,
            30,
            StmtKind::Return {
                value: Some(call_args(
                    local("b:f.ts:0:pick"),
                    vec![expr(
                        0,
                        10,
                        ExprKind::Const {
                            value: ConstValue::Num { value: 6.0 },
                        },
                    )],
                )),
            },
        )],
    );
    let directory = BTreeMap::from([(
        "b:f.ts:0:pick".to_string(),
        "symbol:f.ts:0:99:pick".to_string(),
    )]);
    let flow = FlowFacts {
        schema: FLOW_SCHEMA.into(),
        snapshot_id: "t".into(),
        producer: atlas_contract::WORKER_PRODUCER.into(),
        profile: FLOW_PROFILE.into(),
        functions: vec![pick, caller_a, caller_b],
        diagnostics: vec![],
    };
    let result =
        atlas_engine::inter::analyze_interprocedural(&flow, &directory, None).expect("interproc");
    let a = &result.functions["symbol:f.ts:0:99:callA"].output.returns;
    let b = &result.functions["symbol:f.ts:0:99:callB"].output.returns;
    assert_eq!(
        a.constants,
        vec![json!(1.0)],
        "pick(5) must fold to 1: {a:?}"
    );
    assert_eq!(
        b.constants,
        vec![json!(2.0)],
        "pick(6) must fold to 2: {b:?}"
    );
}

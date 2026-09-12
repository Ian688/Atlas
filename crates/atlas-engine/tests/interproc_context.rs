//! Independent regressions for scalar k=1 contexts and shared work control.
//! Expected values follow JS argument order and branch semantics.
use atlas_contract::*;
use atlas_engine::{control::ExecutionControl, inter};
use serde_json::json;
use std::collections::BTreeMap;

fn expr(kind: ExprKind) -> Expr {
    Expr {
        start: 0,
        end: 1,
        kind,
    }
}
fn stmt(kind: StmtKind) -> Stmt {
    Stmt {
        start: 0,
        end: 1,
        kind,
    }
}
fn num(value: f64) -> Expr {
    expr(ExprKind::Const {
        value: ConstValue::Num { value },
    })
}
fn local(function: &str, index: usize) -> Expr {
    expr(ExprKind::Local {
        binding: format!("{function}:p{index}"),
    })
}
fn call_with(callee: Expr, args: Vec<Expr>) -> Expr {
    expr(ExprKind::Call {
        callee: Box::new(callee),
        args,
        optional: false,
    })
}
fn call(function: &str, args: Vec<Expr>) -> Expr {
    call_with(
        expr(ExprKind::FunctionRef {
            symbol: function.into(),
        }),
        args,
    )
}
fn ret(value: Expr) -> Stmt {
    stmt(StmtKind::Return { value: Some(value) })
}
fn binding(id: &str) -> Expr {
    expr(ExprKind::Local { binding: id.into() })
}
fn external(name: &str) -> Expr {
    expr(ExprKind::External { name: name.into() })
}
fn throw(value: Expr) -> Stmt {
    stmt(StmtKind::Throw { expr: value })
}
fn object(fields: Vec<(&str, Expr)>) -> Expr {
    expr(ExprKind::ObjectLiteral {
        fields: fields
            .into_iter()
            .map(|(name, value)| ObjectField {
                name: name.into(),
                value,
            })
            .collect(),
    })
}
fn property(object: Expr, name: &str) -> Expr {
    expr(ExprKind::PropertyRead {
        object: Box::new(object),
        name: name.into(),
        optional: false,
    })
}
fn try_catch(body: Vec<Stmt>, catch_binding: &str, catch_body: Vec<Stmt>) -> Stmt {
    stmt(StmtKind::Try {
        body,
        catch_param: Some(catch_binding.into()),
        catch_body: Some(catch_body),
        finally_body: None,
    })
}
/// Declares a local binding the way the worker does, so fixtures that use a
/// catch parameter or a local object match the wire format rather than relying
/// on the solver's implicit env insertion.
fn with_binding(mut function: FlowFunction, id: &str, kind: &str) -> FlowFunction {
    function.scopes[0].bindings.push(id.into());
    function.bindings.push(FlowBinding {
        id: id.into(),
        name: id.into(),
        kind: kind.into(),
        scope: function.scopes[0].id.clone(),
        decl_start: 0,
        decl_end: 1,
        hoisted: false,
        default_value: None,
        function_symbol: None,
    });
    function
}
fn function(name: &str, param_count: usize, body: Vec<Stmt>) -> FlowFunction {
    let params: Vec<String> = (0..param_count).map(|i| format!("{name}:p{i}")).collect();
    FlowFunction {
        symbol: name.into(),
        name: name.into(),
        path: "test.js".into(),
        start: 0,
        end: 1,
        imports: Vec::new(),
        scopes: vec![FlowScope {
            id: format!("{name}:scope"),
            kind: "function".into(),
            parent: None,
            bindings: params.clone(),
        }],
        bindings: params
            .iter()
            .map(|id| FlowBinding {
                id: id.clone(),
                name: id.clone(),
                kind: "param".into(),
                scope: format!("{name}:scope"),
                decl_start: 0,
                decl_end: 1,
                hoisted: false,
                default_value: None,
                function_symbol: None,
            })
            .collect(),
        params,
        body,
        captures: vec![],
        unknown_regions: vec![],
    }
}
fn flow(functions: Vec<FlowFunction>) -> FlowFacts {
    FlowFacts {
        schema: FLOW_SCHEMA.into(),
        snapshot_id: "test".into(),
        producer: "test".into(),
        profile: FLOW_PROFILE.into(),
        functions,
        diagnostics: vec![],
    }
}
fn analyze(functions: Vec<FlowFunction>) -> inter::InterprocResult {
    inter::analyze_interprocedural(&flow(functions), &BTreeMap::new(), None).unwrap()
}
fn pick() -> FlowFunction {
    function(
        "pick",
        1,
        vec![stmt(StmtKind::If {
            cond: expr(ExprKind::Binary {
                op: "===".into(),
                left: Box::new(local("pick", 0)),
                right: Box::new(num(5.0)),
            }),
            then_body: vec![ret(num(1.0))],
            else_body: vec![ret(num(2.0))],
        })],
    )
}

#[test]
fn caller_parameter_origins_are_not_reinterpreted_in_the_callee() {
    let result = analyze(vec![
        function("first", 2, vec![ret(local("first", 0))]),
        function(
            "swap",
            2,
            vec![ret(call("first", vec![local("swap", 1), local("swap", 0)]))],
        ),
        function(
            "caller",
            0,
            vec![ret(call("swap", vec![num(11.0), num(22.0)]))],
        ),
    ]);
    assert_eq!(result.status, "complete_within_profile");
    assert_eq!(
        result.functions["caller"].output.returns.constants,
        vec![json!(22.0)]
    );
    assert!(!result.functions["caller"].output.returns.unknown);
    assert!(
        result.functions["swap"]
            .output
            .returns
            .origins
            .contains(&"Parameter(1)".into())
    );
    assert!(
        !result.functions["swap"]
            .output
            .returns
            .origins
            .contains(&"Parameter(0)".into())
    );
}

#[test]
fn contexts_are_bound_to_arguments_after_summary_refinement() {
    let result = analyze(vec![
        pick(),
        function("identity", 1, vec![ret(local("identity", 0))]),
        function(
            "a",
            0,
            vec![ret(call("pick", vec![call("identity", vec![num(5.0)])]))],
        ),
        function(
            "b",
            0,
            vec![ret(call("pick", vec![call("identity", vec![num(6.0)])]))],
        ),
    ]);
    assert_eq!(result.status, "complete_within_profile");
    assert_eq!(
        result.functions["a"].output.returns.constants,
        vec![json!(1.0)]
    );
    assert_eq!(
        result.functions["b"].output.returns.constants,
        vec![json!(2.0)]
    );
}

#[test]
fn context_cap_falls_back_to_sound_symbolic_summary() {
    let mut functions = vec![pick()];
    for i in 0..12 {
        functions.push(function(
            &format!("caller{i:02}"),
            0,
            vec![ret(call(
                "pick",
                vec![num(if i % 2 == 0 { 5.0 } else { 6.0 })],
            ))],
        ));
    }
    let result = analyze(functions);
    assert_eq!(result.status, "complete_within_profile");
    for i in 0..12 {
        let value = &result.functions[&format!("caller{i:02}")].output.returns;
        assert!(
            value
                .constants
                .contains(&json!(if i % 2 == 0 { 1.0 } else { 2.0 }))
        );
        if i < inter::MAX_CONTEXTS_PER_FUNCTION {
            assert_eq!(value.constants.len(), 1);
        }
    }
    // Count the fallbacks instead of branching on the cap. Branching on
    // `MAX_CONTEXTS_PER_FUNCTION` makes the assertion follow the constant, so a
    // broken cap silently moves the branch and the test keeps passing -- it was
    // verified to stay green with the cap raised to 20. Counting pins the
    // *relationship*: exactly the callers past the cap may keep both branches.
    let fell_back = (0..12)
        .filter(|i| {
            result.functions[&format!("caller{i:02}")]
                .output
                .returns
                .constants
                .len()
                == 2
        })
        .count();
    assert_eq!(
        fell_back,
        12usize.saturating_sub(inter::MAX_CONTEXTS_PER_FUNCTION),
        "exactly the callers past the context cap must fall back to the \
         symbolic summary and keep both branches"
    );
}

#[test]
fn omitted_argument_context_is_undefined() {
    let callee = function(
        "optional",
        1,
        vec![stmt(StmtKind::If {
            cond: expr(ExprKind::Binary {
                op: "===".into(),
                left: Box::new(local("optional", 0)),
                right: Box::new(expr(ExprKind::Const {
                    value: ConstValue::Undefined,
                })),
            }),
            then_body: vec![ret(num(7.0))],
            else_body: vec![ret(num(8.0))],
        })],
    );
    let result = analyze(vec![
        callee,
        function("caller", 0, vec![ret(call("optional", vec![]))]),
    ]);
    assert_eq!(
        result.functions["caller"].output.returns.constants,
        vec![json!(7.0)]
    );
}

#[test]
fn cancelled_and_expired_controls_refuse_interprocedural_results() {
    let facts = flow(vec![pick()]);
    let control = ExecutionControl::new(None);
    assert!(control.cancel());
    assert!(inter::analyze_interprocedural_controlled(&facts, &BTreeMap::new(), &control).is_err());
    let expired = ExecutionControl::new(Some(std::time::Instant::now()));
    assert!(inter::analyze_interprocedural_controlled(&facts, &BTreeMap::new(), &expired).is_err());
}

#[test]
fn nan_arguments_do_not_prevent_context_convergence() {
    let result = analyze(vec![
        function("identity", 1, vec![ret(local("identity", 0))]),
        function(
            "caller",
            0,
            vec![ret(call("identity", vec![num(f64::NAN)]))],
        ),
    ]);
    assert_eq!(result.status, "complete_within_profile");
    let value = &result.functions["caller"].output.returns;
    assert!(!value.unknown);
    assert_eq!(
        serde_json::to_value(value).unwrap()["typed_constants"],
        json!([{"kind":"nan"}])
    );
}

#[test]
fn callee_allocations_cannot_alias_caller_local_operation_numbers() {
    let object = |value| {
        expr(ExprKind::ObjectLiteral {
            fields: vec![ObjectField {
                name: "v".into(),
                value,
            }],
        })
    };
    let result = analyze(vec![
        function("make", 1, vec![ret(object(local("make", 0)))]),
        function(
            "caller",
            0,
            vec![
                stmt(StmtKind::Expression {
                    expr: object(num(99.0)),
                }),
                ret(expr(ExprKind::PropertyRead {
                    object: Box::new(call("make", vec![num(1.0)])),
                    name: "v".into(),
                    optional: false,
                })),
            ],
        ),
    ]);
    let value = &result.functions["caller"].output.returns;
    assert!(
        value.unknown,
        "returned heap import is explicitly unsupported: {value:?}"
    );
    assert!(
        !value.constants.contains(&json!(99.0)),
        "caller object cannot impersonate callee allocation"
    );
    let callsite = result.functions["caller"]
        .output
        .internal
        .callsites
        .values()
        .next()
        .unwrap();
    let result_value = atlas_engine::solve::value_to_json(callsite.result.as_ref().unwrap());
    assert!(
        result_value
            .reasons
            .contains(&"callee_allocation_heap_not_imported".into())
    );
}

#[test]
fn local_budget_marks_callsites_and_bindings_as_incomplete() {
    let caller = function(
        "caller",
        1,
        vec![
            stmt(StmtKind::Expression {
                expr: call("known", vec![]),
            }),
            ret(num(7.0)),
        ],
    );
    let cfg = atlas_engine::flow::build_cfg(&caller).unwrap();
    let summaries = BTreeMap::from([(
        "known".into(),
        atlas_engine::solve::Summary {
            returns: Some(atlas_engine::solve::value_from_constants(vec![
                ConstValue::Num { value: 1.0 },
            ])),
            ..Default::default()
        },
    )]);
    let output = atlas_engine::solve::solve_controlled(
        &cfg,
        &caller,
        &BTreeMap::new(),
        &summaries,
        &ExecutionControl::new(None),
        None,
        2,
    );
    assert_eq!(output.status, "partial_budget");
    assert_eq!(output.budgets["transfers"], 2);
    assert!(!output.frontier.is_empty());
    assert!(output.returns.unknown);
    assert!(output.pruned_edges.is_empty());
    assert!(output.effects.may_write_heap);
    assert!(output.block_states.values().all(|state| state.truncated));
    let observation = output
        .internal
        .callsites
        .values()
        .next()
        .expect("call transferred before stop");
    assert!(observation.unknown_component);
    assert!(atlas_engine::solve::value_to_json(observation.result.as_ref().unwrap()).unknown);
}

/// P0: a callee's `throws` is a callee-relative value and must be rebased
/// through the call arguments exactly like its `returns`.
///
/// JS: `h(a,b){throw b}`; `g(y){try{h(42,y)}catch(e){return e}}`;
/// `caller(){return g(7)}` -> Node returns 7.
///
/// The regression produced `undefined`: the raw summary carried `Parameter(1)`
/// (the callee's index), and the caller has no second argument, so
/// `apply_summary_value` was never consulted and the missing slot became a
/// *known* undefined instead of 7.
#[test]
fn thrown_callee_parameter_is_rebased_to_the_call_argument() {
    let result = analyze(vec![
        function("h", 2, vec![throw(local("h", 1))]),
        with_binding(
            function(
                "g",
                1,
                vec![try_catch(
                    vec![stmt(StmtKind::Expression {
                        expr: call("h", vec![num(42.0), local("g", 0)]),
                    })],
                    "g:catch",
                    vec![ret(binding("g:catch"))],
                )],
            ),
            "g:catch",
            "catch",
        ),
        function("caller", 0, vec![ret(call("g", vec![num(7.0)]))]),
    ]);
    let returns = &result.functions["caller"].output.returns;
    assert_eq!(
        returns.constants,
        vec![json!(7.0)],
        "the thrown value must be the caller's argument rebased through g, \
         not the callee's Parameter(1) resolved to undefined"
    );
    assert!(
        !returns.unknown,
        "7 is a known constant reachable from a known argument"
    );
}

/// P0 (allocation variant): a thrown callee allocation must not alias a
/// caller-local heap operation by integer collision.
///
/// JS: `h(){throw {v:1}}`; `g(){const o={v:99};try{h()}catch(e){return e.v}}`.
/// The profile does not import callee heap graphs, so the honest answer is an
/// explicit unknown — never the caller-local 99, and never a claimed 1.
#[test]
fn thrown_callee_allocation_does_not_alias_the_caller_heap() {
    let result = analyze(vec![
        function("h", 0, vec![throw(object(vec![("v", num(1.0))]))]),
        with_binding(
            with_binding(
                function(
                    "g",
                    0,
                    vec![
                        stmt(StmtKind::VarDecl {
                            keyword: "const".into(),
                            declarators: vec![Declarator {
                                binding: "g:o".into(),
                                init: Some(object(vec![("v", num(99.0))])),
                            }],
                        }),
                        try_catch(
                            vec![stmt(StmtKind::Expression {
                                expr: call("h", vec![]),
                            })],
                            "g:catch",
                            vec![ret(property(binding("g:catch"), "v"))],
                        ),
                    ],
                ),
                "g:o",
                "const",
            ),
            "g:catch",
            "catch",
        ),
        function("caller", 0, vec![ret(call("g", vec![]))]),
    ]);
    let returns = &result.functions["caller"].output.returns;
    assert!(
        !returns.constants.contains(&json!(99.0)),
        "unimported callee heap must not borrow the caller-local object value: {:?}",
        returns.constants
    );
    assert!(
        returns.unknown,
        "a thrown callee allocation stays an explicit unknown: {:?}",
        returns
    );
}

/// An unknown callee's exception value must remain unknown; rebasing must not
/// turn "we know nothing" into a definite caught value.
#[test]
fn unknown_callee_exception_value_stays_unknown() {
    let result = analyze(vec![with_binding(
        function(
            "caller",
            0,
            vec![try_catch(
                vec![stmt(StmtKind::Expression {
                    expr: call_with(external("external_fn"), vec![num(1.0)]),
                })],
                "caller:catch",
                vec![ret(binding("caller:catch"))],
            )],
        ),
        "caller:catch",
        "catch",
    )]);
    let returns = &result.functions["caller"].output.returns;
    assert!(
        returns.unknown,
        "an unknown callee cannot yield a known caught value: {:?}",
        returns
    );
    assert!(
        returns.constants.is_empty(),
        "no constant may be invented for an unknown callee: {:?}",
        returns.constants
    );
}

#[test]
fn read_set_records_the_callee_summaries_actually_consumed() {
    // V-04. The positive half: deleting the `self.read.extend(..)` collection
    // in solve.rs empties the read set, so this assertion goes red on its own
    // and needs no reverse check -- unlike a "must be empty" assertion, which
    // stays green when the implementation is removed.
    let result = analyze(vec![
        function("first", 2, vec![ret(local("first", 0))]),
        function(
            "swap",
            2,
            vec![ret(call("first", vec![local("swap", 1), local("swap", 0)]))],
        ),
        function(
            "caller",
            0,
            vec![ret(call("swap", vec![num(11.0), num(22.0)]))],
        ),
    ]);
    assert!(
        result.functions["caller"]
            .output
            .internal
            .read
            .contains("swap"),
        "caller consumes swap's summary: {:?}",
        result.functions["caller"].output.internal.read
    );
    assert!(
        result.functions["swap"]
            .output
            .internal
            .read
            .contains("first"),
        "swap consumes first's summary: {:?}",
        result.functions["swap"].output.internal.read
    );
    // The negative half: a leaf must not invent dependencies.
    assert!(
        result.functions["first"].output.internal.read.is_empty(),
        "first is a leaf and consumes nothing: {:?}",
        result.functions["first"].output.internal.read
    );
    assert!(
        !result.functions["caller"].output.internal.read_truncated,
        "a complete solve must not report a truncated read set"
    );
}

#[test]
fn probed_absent_records_resolved_targets_that_had_no_summary() {
    // V-04, positive half: a target that resolves to a symbol but had no
    // summary is a NEGATIVE dependency -- it can gain one later (its file gets
    // fixed, or its budget is raised) and must then invalidate this function.
    // `read_truncated` cannot carry this: that flag only says *this* solve was
    // cut, not that a callee's was.
    let caller = function(
        "caller",
        0,
        vec![
            stmt(StmtKind::Expression {
                expr: call("late_target", vec![]),
            }),
            ret(num(7.0)),
        ],
    );
    let cfg = atlas_engine::flow::build_cfg(&caller).unwrap();
    let output = atlas_engine::solve::solve_controlled(
        &cfg,
        &caller,
        &BTreeMap::new(),
        &BTreeMap::new(), // no summaries at all: every target is absent
        &ExecutionControl::new(None),
        None,
        atlas_engine::solve::MAX_TRANSFERS,
    );
    assert!(
        output.internal.probed_absent.contains("late_target"),
        "a resolved target with no summary must be recorded: {:?}",
        output.internal.probed_absent
    );
    assert!(
        output.internal.read.is_empty(),
        "nothing was consumed, so the read set stays empty: {:?}",
        output.internal.read
    );
}

fn str_expr(value: &str) -> Expr {
    expr(ExprKind::Const {
        value: ConstValue::Str {
            value: value.into(),
        },
    })
}
fn assign(binding_id: &str, value: Expr) -> Stmt {
    stmt(StmtKind::Expression {
        expr: expr(ExprKind::Assign {
            op: "=".into(),
            target: AssignTarget::Binding {
                binding: binding_id.into(),
            },
            value: Box::new(value),
        }),
    })
}
fn divide(left: Expr, right: Expr) -> Expr {
    expr(ExprKind::Binary {
        op: "/".into(),
        left: Box::new(left),
        right: Box::new(right),
    })
}

/// P0 #2: a callee that provably never returns normally gives its caller no
/// normal successor, so the code after the call is unreachable.
///
/// JS: `alwaysThrows(){throw 1}`; `after(){let x='before'; alwaysThrows(); x='after'; return x;}`
/// -> Node throws 1 and never returns.
///
/// The regression reported `正常返回: 常量 "after"` with `unknown=false`: the
/// caller treated the call as returning, ran the unreachable assignment, and
/// published a value that can never occur.
#[test]
fn a_call_that_cannot_return_has_no_normal_successor() {
    let result = analyze(vec![
        function("alwaysThrows", 0, vec![throw(num(1.0))]),
        with_binding(
            function(
                "after",
                0,
                vec![
                    stmt(StmtKind::VarDecl {
                        keyword: "let".into(),
                        declarators: vec![Declarator {
                            binding: "after:x".into(),
                            init: Some(str_expr("before")),
                        }],
                    }),
                    stmt(StmtKind::Expression {
                        expr: call("alwaysThrows", vec![]),
                    }),
                    assign("after:x", str_expr("after")),
                    ret(binding("after:x")),
                ],
            ),
            "after:x",
            "let",
        ),
    ]);
    let after = &result.functions["after"].output;
    assert!(
        !after.returns.constants.contains(&json!("after")),
        "a value that can never be produced must not be reported: {:?}",
        after.returns
    );
    assert!(
        after.returns.unknown,
        "the caller has no normal return, so its return value is unknown: {:?}",
        after.returns
    );
    assert_eq!(
        after.throws.constants,
        vec![json!(1.0)],
        "the callee's definite throw is now the caller's exceptional result"
    );
    assert!(
        !after.throws.unknown,
        "a known throw must not be reported as an unknown one: {:?}",
        after.throws
    );
}

/// The same rule, but the proof only exists in the k=1 context summary: the
/// symbolic `divideOrThrow` has a `return`, and only the concrete `right = 0`
/// argument prunes it. The control-flow decision must consult the same summary
/// the returns path already prefers.
#[test]
fn a_context_that_proves_no_return_removes_the_normal_successor() {
    let result = analyze(vec![
        function(
            "divideOrThrow",
            2,
            vec![
                stmt(StmtKind::If {
                    cond: expr(ExprKind::Binary {
                        op: "===".into(),
                        left: Box::new(local("divideOrThrow", 1)),
                        right: Box::new(num(0.0)),
                    }),
                    then_body: vec![throw(object(vec![("v", num(1.0))]))],
                    else_body: vec![],
                }),
                ret(divide(local("divideOrThrow", 0), local("divideOrThrow", 1))),
            ],
        ),
        function(
            "callerZero",
            0,
            vec![
                stmt(StmtKind::Expression {
                    expr: call("divideOrThrow", vec![num(1.0), num(0.0)]),
                }),
                ret(str_expr("after")),
            ],
        ),
    ]);
    let caller = &result.functions["callerZero"].output;
    assert!(
        !caller.returns.constants.contains(&json!("after")),
        "the concrete argument prunes the returning branch, so the code after \
         the call is unreachable: {:?}",
        caller.returns
    );
    assert!(
        caller.returns.unknown,
        "no normal return survives: {:?}",
        caller.returns
    );
}

/// A callee with no `return` statement still falls off the end and returns
/// undefined, so its caller keeps its normal successor.
///
/// This guards the exact mistake the must-throw fix first made: equating
/// "`has_return` is false" with "does not return". That deleted live code after
/// every call to a setter-style function and turned the existing `f2`/`r2`
/// fixtures red.
#[test]
fn a_callee_without_a_return_statement_still_completes_normally() {
    let result = analyze(vec![
        function("noReturn", 1, vec![assign("noReturn:p0", num(2.0))]),
        function(
            "caller",
            0,
            vec![
                stmt(StmtKind::Expression {
                    expr: call("noReturn", vec![num(1.0)]),
                }),
                ret(str_expr("reached")),
            ],
        ),
    ]);
    assert!(
        result.functions["caller"]
            .output
            .returns
            .constants
            .contains(&json!("reached")),
        "falling off the end is a normal return, so the caller continues: {:?}",
        result.functions["caller"].output.returns
    );
}

/// The suppression must not fire for a callee that may return: dropping a real
/// normal successor would lose values. `sometimes(0)` returns 2.
#[test]
fn a_callee_that_may_return_keeps_the_normal_successor() {
    let result = analyze(vec![
        function(
            "sometimes",
            1,
            vec![
                stmt(StmtKind::If {
                    cond: local("sometimes", 0),
                    then_body: vec![throw(num(1.0))],
                    else_body: vec![],
                }),
                ret(num(2.0)),
            ],
        ),
        function(
            "caller",
            0,
            vec![
                stmt(StmtKind::Expression {
                    expr: call("sometimes", vec![num(0.0)]),
                }),
                ret(str_expr("reached")),
            ],
        ),
    ]);
    assert!(
        result.functions["caller"]
            .output
            .returns
            .constants
            .contains(&json!("reached")),
        "a callee that can return keeps its normal successor: {:?}",
        result.functions["caller"].output.returns
    );
}

//! Versioned Flow IR wire contract (W01).
//!
//! The language worker lowers parsed function bodies into structured
//! statements and expressions with UTF-8 `[start,end)` anchors, scopes and
//! bindings. Rust validates this material and derives the CFG, ordered
//! operations and dataflow results; it never guesses language rules the
//! worker did not declare. Constructs outside the declared profile are
//! carried as explicit unknowns with anchors and reasons.

use serde::{Deserialize, Serialize};

pub const FLOW_SCHEMA: &str = "atlas.flow-ir.v1";
/// Declared JS/TS subset for this profile. Everything else must arrive as an
/// explicit unknown; ordinary supported assignments/parameters/conditions must
/// not be blanket-unknowned to pass acceptance.
pub const FLOW_PROFILE: &str = "js-structured-control.v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FlowFacts {
    pub schema: String,
    pub snapshot_id: String,
    pub producer: String,
    pub profile: String,
    pub functions: Vec<FlowFunction>,
    #[serde(default)]
    pub diagnostics: Vec<crate::Diagnostic>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FlowFunction {
    /// Must equal an existing symbol id from the same parse.
    pub symbol: String,
    /// Display name from the declaration site.
    pub name: String,
    pub path: String,
    pub start: usize,
    pub end: usize,
    /// Parameter binding ids in declaration order.
    pub params: Vec<String>,
    /// Local names this module imports (runtime imports only; a type-only
    /// import has no runtime binding and is not listed). Reading one of these
    /// is reading module state the module itself provides -- not a global the
    /// caller would have to supply.
    #[serde(default)]
    pub imports: Vec<String>,
    pub scopes: Vec<FlowScope>,
    #[serde(default)]
    pub bindings: Vec<FlowBinding>,
    pub body: Vec<Stmt>,
    /// Outer binding ids referenced by this closure (declared in ancestors).
    #[serde(default)]
    pub captures: Vec<String>,
    #[serde(default)]
    pub unknown_regions: Vec<UnknownRegion>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FlowScope {
    pub id: String,
    /// function | block | for | catch | switch
    pub kind: String,
    pub parent: Option<String>,
    #[serde(default)]
    pub bindings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FlowBinding {
    pub id: String,
    pub name: String,
    /// param | var | let | const | function | catch
    pub kind: String,
    pub scope: String,
    pub decl_start: usize,
    pub decl_end: usize,
    /// var/function declarations hoist to their function scope.
    pub hoisted: bool,
    /// Parameter default value, lowered as a conditional reassignment.
    #[serde(default)]
    pub default_value: Option<Expr>,
    /// For `function` bindings: the symbol record of the function itself.
    #[serde(default)]
    pub function_symbol: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct UnknownRegion {
    pub start: usize,
    pub end: usize,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Stmt {
    pub start: usize,
    pub end: usize,
    #[serde(flatten)]
    pub kind: StmtKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "stmt", rename_all = "snake_case")]
pub enum StmtKind {
    Empty,
    Block {
        body: Vec<Stmt>,
    },
    VarDecl {
        /// let | const | var
        keyword: String,
        declarators: Vec<Declarator>,
    },
    Expression {
        expr: Expr,
    },
    If {
        cond: Expr,
        then_body: Vec<Stmt>,
        #[serde(default)]
        else_body: Vec<Stmt>,
    },
    While {
        cond: Expr,
        body: Vec<Stmt>,
    },
    DoWhile {
        body: Vec<Stmt>,
        cond: Expr,
    },
    For {
        init: Option<Box<Stmt>>,
        cond: Option<Expr>,
        update: Option<Expr>,
        body: Vec<Stmt>,
    },
    Switch {
        discriminant: Expr,
        cases: Vec<SwitchCase>,
    },
    Return {
        #[serde(default)]
        value: Option<Expr>,
    },
    Throw {
        expr: Expr,
    },
    Break {
        #[serde(default)]
        label: Option<String>,
    },
    Continue {
        #[serde(default)]
        label: Option<String>,
    },
    Try {
        body: Vec<Stmt>,
        /// catch parameter binding id.
        #[serde(default)]
        catch_param: Option<String>,
        #[serde(default)]
        catch_body: Option<Vec<Stmt>>,
        #[serde(default)]
        finally_body: Option<Vec<Stmt>>,
    },
    Labeled {
        label: String,
        body: Box<Stmt>,
    },
    /// Statement outside the declared profile; carries its influence.
    Unknown {
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Declarator {
    pub binding: String,
    #[serde(default)]
    pub init: Option<Expr>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SwitchCase {
    /// None = default clause.
    #[serde(default)]
    pub test: Option<Expr>,
    pub body: Vec<Stmt>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Expr {
    pub start: usize,
    pub end: usize,
    #[serde(flatten)]
    pub kind: ExprKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "expr", rename_all = "snake_case")]
pub enum ExprKind {
    Const {
        value: ConstValue,
    },
    /// Read of a binding resolved inside the analyzed file (local or capture).
    Local {
        binding: String,
    },
    /// Global/imported/unresolved name; value and effects stay unknown.
    External {
        name: String,
    },
    This,
    /// Creation of a nested function value (not a call of it).
    FunctionRef {
        symbol: String,
    },
    Assign {
        op: String,
        target: AssignTarget,
        value: Box<Expr>,
    },
    /// Non-short-circuit binary operator with JS semantics.
    Binary {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    /// `&&` / `||` / `??`: evaluation order and conditional RHS reachability
    /// are preserved by the CFG builder.
    ShortCircuit {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Conditional {
        cond: Box<Expr>,
        then_value: Box<Expr>,
        else_value: Box<Expr>,
    },
    Unary {
        op: String,
        operand: Box<Expr>,
    },
    Call {
        callee: Box<Expr>,
        #[serde(default)]
        args: Vec<Expr>,
        #[serde(default)]
        optional: bool,
    },
    New {
        callee: Box<Expr>,
        #[serde(default)]
        args: Vec<Expr>,
    },
    /// Literal-name member read; may observe a getter.
    PropertyRead {
        object: Box<Expr>,
        name: String,
        #[serde(default)]
        optional: bool,
    },
    ArrayLiteral {
        #[serde(default)]
        elements: Vec<Option<Expr>>,
    },
    ObjectLiteral {
        #[serde(default)]
        fields: Vec<ObjectField>,
    },
    /// Expression outside the declared profile; value is top with a reason.
    Unknown {
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "target", rename_all = "snake_case")]
pub enum AssignTarget {
    Binding {
        binding: String,
    },
    Property {
        object: Box<Expr>,
        name: String,
    },
    /// Destructuring, element access, computed members and other targets:
    /// may write bindings/heap in unmodeled ways.
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ObjectField {
    pub name: String,
    pub value: Expr,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "const", rename_all = "snake_case")]
pub enum ConstValue {
    Num { value: f64 },
    Str { value: String },
    Bool { value: bool },
    Null,
    Undefined,
}

impl FlowFacts {
    pub fn binding_ids(&self) -> std::collections::HashSet<&str> {
        let mut ids = std::collections::HashSet::new();
        for f in &self.functions {
            for b in &f.bindings {
                ids.insert(b.id.as_str());
            }
        }
        ids
    }
}

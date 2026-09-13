//! Host-neutral wire types. Static candidates are never execution observations.
use serde::{Deserialize, Serialize};

pub mod flow;
pub use flow::{
    AssignTarget, ConstValue, Declarator, Expr, ExprKind, FLOW_PROFILE, FLOW_SCHEMA, FlowBinding,
    FlowFacts, FlowFunction, FlowScope, ObjectField, Stmt, StmtKind, SwitchCase, UnknownRegion,
};

pub const SNAPSHOT_SCHEMA: &str = "atlas.snapshot.v1";
pub const FACTS_SCHEMA: &str = "atlas.language-facts.v1";
pub const ANALYSIS_SCHEMA: &str = "atlas.analysis.v1";
pub const ENGINE_VERSION: &str = "foundation-flow-0.2.2";
/// The one worker producer string this engine accepts.
///
/// One constant rather than a list of tolerated versions: the flow IR gained a
/// field whose absence changes meaning (an older worker cannot say which
/// externals are imports, so its output would be read as "this function reads a
/// global" when it reads its own module). A version that cannot express the
/// current semantics is refused by name instead of being interpreted wrongly.
pub const WORKER_PRODUCER: &str = "typescript/5.9.3;worker/0.2.2";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanLimits {
    pub max_entries: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}
impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_entries: 20_000,
            max_file_bytes: 2 * 1024 * 1024,
            max_total_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogEntry {
    pub path: String,
    pub kind: String,
    pub disposition: String,
    pub bytes: u64,
    pub blob: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub schema: String,
    pub id: String,
    pub scan_profile: String,
    pub limits: ScanLimits,
    pub entries: Vec<CatalogEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ParseRequest {
    pub schema: String,
    pub snapshot_id: String,
    pub files: Vec<SourceFile>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Symbol {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub start: usize,
    pub end: usize,
    pub container: String,
    pub mutated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CallSite {
    pub id: String,
    pub path: String,
    pub start: usize,
    pub end: usize,
    pub owner: String,
    pub label: String,
    pub form: String,
    pub target: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Import {
    pub id: String,
    pub path: String,
    pub specifier: String,
    pub target_path: Option<String>,
    pub type_only: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Diagnostic {
    pub path: String,
    pub code: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LanguageFacts {
    pub schema: String,
    pub snapshot_id: String,
    pub producer: String,
    pub parsed_files: Vec<String>,
    pub symbols: Vec<Symbol>,
    pub calls: Vec<CallSite>,
    pub imports: Vec<Import>,
    pub diagnostics: Vec<Diagnostic>,
    pub dynamic_files: Vec<String>,
    /// Versioned Flow IR (W01). Absent means the producer emitted no
    /// semantic material; present means the engine must validate and derive
    /// CFG/dataflow facts from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<FlowFacts>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub parent: Option<String>,
    pub start: usize,
    pub end: usize,
    pub function_count: usize,
    pub disposition: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: Option<String>,
    pub kind: String,
    pub path: String,
    pub start: usize,
    pub end: usize,
    pub label: String,
    pub basis: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Analysis {
    pub schema: String,
    pub id: String,
    pub snapshot_id: String,
    pub engine: String,
    pub producer: String,
    pub coverage: std::collections::BTreeMap<String, usize>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub diagnostics: Vec<Diagnostic>,
    pub recursive_components: Vec<Vec<String>>,
    pub limitations: Vec<String>,
    /// Digest over the derived flow facts; binds their content to this
    /// analysis identity so two derivations cannot share one id.
    #[serde(default)]
    pub flow_digest: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Page<T> {
    pub analysis_id: String,
    pub total: usize,
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Reachability {
    pub analysis_id: String,
    pub root: String,
    pub direction: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub unresolved: Vec<Edge>,
    pub frontier: Vec<String>,
    pub truncated: bool,
    pub semantics: String,
}

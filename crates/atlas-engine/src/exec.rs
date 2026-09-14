//! W08: execution sufficiency profiles and pinned run specs.
//!
//! Nothing in this module executes user code. It derives, from *published*
//! static facts, whether a function may be called in a controlled runner, what
//! the run must be pinned to, and what permissions it needs. Execution itself
//! lives in the app crate, where a supervisor can own the process tree.
//!
//! The classification is deliberately conservative and every reason cites the
//! fact field it came from, because "this function is pure" is a claim about
//! code Atlas has only modelled partially.
use crate::{Result, digest, invalid, store::Store};
use atlas_contract::Snapshot;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

pub const PROFILE_SCHEMA: &str = "atlas.execution-profile.v1";
pub const RUN_SPEC_SCHEMA: &str = "atlas.run-spec.v1";
pub const EXEC_RECORD_SCHEMA: &str = "atlas.execution-record.v1";
pub const SCENARIO_SCHEMA: &str = "atlas.scenario.v1";
pub const HARNESS_SCHEMA: &str = "atlas.execution-harness.v1";

/// What an isolated copy is made of. `snapshot` writes every captured file,
/// which is what a run always did; `dependencies` writes the transitive static
/// import closure of the target's file plus the `package.json` files Node needs
/// for module resolution. The second is a *tighter read boundary*, not a
/// smaller project: a file the target reads at runtime but never imports is
/// absent from it, and that is reported rather than papered over.
pub const MATERIALISE_SNAPSHOT: &str = "snapshot";
pub const MATERIALISE_DEPENDENCIES: &str = "dependencies";
/// A bound on the closure walk. Reaching it is reported (`bounded: true`) rather
/// than silently producing a copy that is missing files.
const SLICE_MAX_FILES: usize = 20_000;
const SLICE_MAX_EDGES: usize = 400_000;
const SLICE_MAX_PACKAGE_JSON: usize = 512;
/// How many ancestors a `via` chain may name. Each one is a real call that has
/// to happen, so an unbounded chain would be an unbounded run.
pub const MAX_VIA_CHAIN: usize = 8;
/// How many written paths a record lists before it only reports the count.
const SLICE_LIST_LIMIT: usize = 200;

pub fn materialise_mode(value: Option<&str>) -> Result<&'static str> {
    match value {
        None | Some(MATERIALISE_SNAPSHOT) => Ok(MATERIALISE_SNAPSHOT),
        Some(MATERIALISE_DEPENDENCIES) => Ok(MATERIALISE_DEPENDENCIES),
        Some(_) => Err(invalid("invalid_materialise_mode")),
    }
}

/// The static import closure of one file, read from the published graph.
pub struct ImportClosure {
    pub files: BTreeSet<String>,
    /// Relative specifiers on reached files that the worker could not map onto a
    /// snapshot path. These are the ones that can break a sliced run, so they
    /// are named rather than counted.
    pub unresolved_relative: Vec<String>,
    /// Bare specifiers on reached files: builtins and installed packages. Node
    /// resolves them outside the copy; the closure neither contains nor needs
    /// them, and a package that is not installed was never in the snapshot in
    /// either mode.
    pub unresolved_bare: usize,
    pub edges_read: usize,
    pub bounded: bool,
}

/// A specifier is "relative" when Node would resolve it against the file's own
/// directory -- exactly the case a copy can break, because the file it names is
/// supposed to be beside it.
fn is_relative_specifier(specifier: &str) -> bool {
    specifier.starts_with("./")
        || specifier.starts_with("../")
        || specifier == "."
        || specifier == ".."
}

/// Walk published `import` edges from `seed` to a fixed point.
///
/// Type-only imports are not followed: they are erased before the module ever
/// runs, so the file they name is not needed to execute it. An unresolved
/// import (a specifier the worker could not map onto a snapshot path) is counted
/// and not invented -- a run that needs one fails to load, and saying so is more
/// useful than a copy that silently contains nothing for it.
pub fn import_closure(store: &Store, analysis: &str, seed: &str) -> Result<ImportClosure> {
    // (target, specifier) per source file, so an unresolved edge can be told
    // apart from a resolved one without re-reading the graph.
    let mut forward: BTreeMap<String, Vec<(Option<String>, String)>> = BTreeMap::new();
    let mut cursor: Option<String> = None;
    let mut edges_read = 0usize;
    let mut bounded = false;
    // `Store::edges` caps a page at 500.
    for _ in 0..(SLICE_MAX_EDGES / 500 + 1) {
        let page = store.edges(analysis, "import", 500, cursor.as_deref())?;
        for edge in &page.items {
            edges_read += 1;
            let Some(source) = edge.source.strip_prefix("file:") else {
                continue;
            };
            let target = edge
                .target
                .as_deref()
                .map(|target| target.strip_prefix("file:").unwrap_or(target).to_string());
            forward
                .entry(source.to_string())
                .or_default()
                .push((target, edge.label.clone()));
        }
        if edges_read >= SLICE_MAX_EDGES {
            bounded = true;
            break;
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    let mut files: BTreeSet<String> = BTreeSet::new();
    files.insert(seed.to_string());
    let mut unresolved_relative: BTreeSet<String> = BTreeSet::new();
    let mut unresolved_bare = 0usize;
    let mut queue: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    queue.push_back(seed.to_string());
    while let Some(path) = queue.pop_front() {
        let Some(edges) = forward.get(&path) else {
            continue;
        };
        for (target, specifier) in edges {
            let Some(target) = target else {
                // Only the specifiers on files the closure actually reaches can
                // affect this run; counting the whole graph's would report
                // other modules' imports as if they were this run's problem.
                if is_relative_specifier(specifier) {
                    unresolved_relative.insert(specifier.clone());
                } else {
                    unresolved_bare += 1;
                }
                continue;
            };
            if files.contains(target) {
                continue;
            }
            if files.len() >= SLICE_MAX_FILES {
                bounded = true;
                queue.clear();
                break;
            }
            files.insert(target.clone());
            queue.push_back(target.clone());
        }
    }
    Ok(ImportClosure {
        files,
        unresolved_relative: unresolved_relative.into_iter().take(20).collect(),
        unresolved_bare,
        edges_read,
        bounded,
    })
}

pub const CLASS_PURE: &str = "pure_callable";
pub const CLASS_CONTEXT: &str = "needs_context";
pub const CLASS_DRIVER: &str = "needs_entry_driver";
pub const CLASS_UNSUPPORTED: &str = "unsupported";

/// One classification reason. `evidence` names the published fact field the
/// reason was read from, so a consumer can check the claim instead of trusting
/// the label.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Reason {
    pub code: String,
    pub detail: String,
    pub evidence: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ParamProfile {
    pub binding: String,
    pub name: String,
    /// Declaration order recovered from the binding's declaration offset.
    pub index: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecutionProfile {
    pub schema: String,
    pub analysis_id: String,
    pub symbol: String,
    pub path: String,
    pub name: String,
    pub classification: String,
    pub runnable: bool,
    pub reasons: Vec<Reason>,
    pub params: Vec<ParamProfile>,
    pub arity: Option<usize>,
    pub flow_status: String,
    pub flow_profile: String,
    pub unknown_reasons: Vec<String>,
    pub effects: serde_json::Value,
    pub required_grants: Vec<String>,
    /// Context the caller must *declare* for this function to run: `this_arg`
    /// and/or `globals`. These are not capabilities -- they do not widen the
    /// sandbox -- they are inputs Atlas refuses to invent.
    pub required_context: Vec<String>,
    /// The external names behind the `globals` requirement. Empty means the
    /// effect flag was set without a name Atlas could recover.
    pub required_globals: Vec<String>,
    /// Context Atlas cannot accept a declaration for. A captured binding is an
    /// instance of an enclosing scope, and the only honest way to obtain one is
    /// to run the enclosing function (see `via`), never to invent a value.
    pub unsatisfiable_context: Vec<String>,
    /// The captured binding names behind that requirement, so the caller can
    /// see what the closure instance would have to carry.
    pub captures: Vec<String>,
    /// The enclosing function symbol, when the target is nested. `via.symbol`
    /// must equal this value exactly.
    pub enclosing_symbol: Option<String>,
    /// The enclosing function's declared name. The symbol id is the identity;
    /// the name is only a label for messages a human reads.
    #[serde(default)]
    pub enclosing_name: Option<String>,
    pub notes: Vec<String>,
}

/// Runtime permissions a run may ask for. Absent means "not granted", so a
/// missing field can never silently widen a run.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Grants {
    #[serde(default)]
    pub fs_write: bool,
    #[serde(default)]
    pub child_process: bool,
    #[serde(default)]
    pub network: bool,
    /// Static opt-in for calling code Atlas did not model, and for acting on
    /// facts Atlas could not finish. One acknowledgement, because it is one
    /// statement: "I accept that this run goes beyond what was proved".
    #[serde(default)]
    pub unknown_calls: bool,
}

impl Grants {
    pub fn names(&self) -> Vec<String> {
        let mut names = Vec::new();
        if self.fs_write {
            names.push("fs_write".into());
        }
        if self.child_process {
            names.push("child_process".into());
        }
        if self.network {
            names.push("network".into());
        }
        if self.unknown_calls {
            names.push("unknown_calls".into());
        }
        names
    }

    pub fn parse(names: &[String]) -> Result<Self> {
        let mut grants = Self::default();
        for name in names {
            match name.trim() {
                "" => {}
                "fs_write" => grants.fs_write = true,
                "child_process" => grants.child_process = true,
                "network" => grants.network = true,
                "unknown_calls" => grants.unknown_calls = true,
                other => return Err(invalid(&format!("unknown_effect_grant:{other}"))),
            }
        }
        Ok(grants)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunSpec {
    pub schema: String,
    /// The analysis this run is pinned to. The runner re-verifies that the
    /// bytes it materialises hash to this analysis' snapshot.
    pub analysis_id: String,
    pub symbol: String,
    /// Call arguments as JSON literals. Object/function arguments are not
    /// synthesised: they must already be JSON.
    #[serde(default)]
    pub args: Vec<serde_json::Value>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_output_limit")]
    pub output_limit: usize,
    #[serde(default)]
    pub grants: Grants,
    #[serde(default = "default_node")]
    pub node: String,
    /// Explicit environment allowlist; the child gets nothing else.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The receiver to call with, when the function reads `this`. Atlas does
    /// not synthesise one: the caller declares it, and the record says so.
    #[serde(default)]
    pub this_arg: Option<serde_json::Value>,
    /// Globals the function is known to read, declared explicitly. Set on the
    /// global object before the module is imported, because a module reads its
    /// globals at import time as often as at call time.
    #[serde(default)]
    pub globals: BTreeMap<String, serde_json::Value>,
    /// A run that used mocks/fixtures must say so, so its result can never be
    /// read as an observation of the real project environment.
    #[serde(default)]
    pub fixtures: bool,
    #[serde(default)]
    pub fixture_note: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    /// How to obtain an instance of a nested function. Atlas never synthesises
    /// a closure: it calls the function that encloses the target and accepts
    /// only the function that call returns, after checking that value's source
    /// against the pinned bytes of the target symbol.
    #[serde(default)]
    pub via: Option<ViaSpec>,
    /// What the isolated copy is made of: `snapshot` (every captured file, the
    /// default) or `dependencies` (the target's static import closure plus the
    /// package.json files Node reads). The second is a tighter read boundary
    /// and is recorded as such; it is never the silent default.
    #[serde(default)]
    pub materialise: Option<String>,
    /// Ancestors of `via`, outermost first. `via` stays "the target's enclosing
    /// function"; this is the chain *above* it, for a closure that is nested
    /// more than one level deep. Every link is verified by source identity
    /// against its own pinned bytes, so the chain is never taken on trust.
    #[serde(default)]
    pub via_chain: Vec<ViaSpec>,
}

/// One stage of a `via` run, as the harness receives it: what to call, and the
/// pinned source of the function that call must return.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ViaStage {
    pub name: String,
    #[serde(default)]
    pub args: Vec<serde_json::Value>,
    #[serde(default)]
    pub this_arg: Option<serde_json::Value>,
    pub expects_source: String,
}

/// One stage of a `via` run: the enclosing function Atlas calls first.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ViaSpec {
    /// Must be the *exact* enclosing symbol of the target. A closure is only
    /// reachable through its real enclosing scope, never through whichever
    /// symbol a caller believes returns a similar function.
    pub symbol: String,
    #[serde(default)]
    pub args: Vec<serde_json::Value>,
    /// The receiver for the enclosing call, when it is a method. Distinct from
    /// the target's own `this_arg`.
    #[serde(default)]
    pub this_arg: Option<serde_json::Value>,
}

fn default_timeout_ms() -> u64 {
    5_000
}
fn default_output_limit() -> usize {
    64 * 1024
}
fn default_node() -> String {
    "node".into()
}

impl RunSpec {
    pub fn validate(&self) -> Result<()> {
        if self.schema != RUN_SPEC_SCHEMA {
            return Err(invalid("invalid_run_spec_schema"));
        }
        if self.timeout_ms == 0 || self.timeout_ms > 600_000 {
            return Err(invalid("invalid_run_timeout"));
        }
        if self.output_limit == 0 || self.output_limit > 4 * 1024 * 1024 {
            return Err(invalid("invalid_output_limit"));
        }
        if self.args.len() > 64 {
            return Err(invalid("too_many_arguments"));
        }
        if self.globals.len() > 32 {
            return Err(invalid("too_many_declared_globals"));
        }
        for key in self.globals.keys() {
            if key.is_empty()
                || key.len() > 128
                || !key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
            {
                return Err(invalid("invalid_global_name"));
            }
        }
        for key in self.env.keys() {
            if key.is_empty() || key.contains('=') || key.contains('\0') {
                return Err(invalid("invalid_env_key"));
            }
        }
        materialise_mode(self.materialise.as_deref())?;
        if !self.via_chain.is_empty() && self.via.is_none() {
            // Ancestors without the enclosing function describe no chain: the
            // last stage would have no defined target to produce.
            return Err(invalid("via_chain_without_via"));
        }
        if self.via_chain.len() > MAX_VIA_CHAIN {
            return Err(invalid("via_chain_too_long"));
        }
        for stage in &self.via_chain {
            if stage.symbol.is_empty() || stage.symbol.len() > 512 || stage.symbol.contains('\0') {
                return Err(invalid("invalid_via_symbol"));
            }
            if stage.symbol == self.symbol {
                return Err(invalid("via_symbol_is_the_target"));
            }
            if stage.args.len() > 64 {
                return Err(invalid("too_many_via_arguments"));
            }
        }
        if let Some(via) = &self.via {
            if via.symbol.is_empty() || via.symbol.len() > 512 || via.symbol.contains('\0') {
                return Err(invalid("invalid_via_symbol"));
            }
            if via.symbol == self.symbol {
                return Err(invalid("via_symbol_is_the_target"));
            }
            if via.args.len() > 64 {
                return Err(invalid("too_many_via_arguments"));
            }
        }
        Ok(())
    }

    /// Identity of the request. Two runs with the same digest asked the same
    /// question of the same pinned analysis.
    pub fn digest(&self) -> Result<String> {
        Ok(digest(&serde_json::to_vec(self)?))
    }
}

/// Static plan for one call, before any process exists.
#[derive(Clone, Debug, Serialize)]
pub struct ExecutionDecision {
    pub allowed: bool,
    pub refusal: Option<Reason>,
    pub required_grants: Vec<String>,
    pub missing_grants: Vec<String>,
    pub missing_context: Vec<String>,
}

/// The facts the profile is derived from, read from the published flow record.
fn strings(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn flag(value: &serde_json::Value, key: &str) -> bool {
    value.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Recover declaration order for `param` bindings. Binding ids are
/// `b:<path>:<declStartByte>:<name>`, so the offset is orderable. An id that
/// does not carry an offset leaves the arity unknown rather than guessed.
fn params_from_fact(fact: &serde_json::Value) -> (Vec<ParamProfile>, Option<usize>) {
    let names = fact.get("binding_names").and_then(|v| v.as_object());
    let kinds = fact.get("binding_kinds").and_then(|v| v.as_object());
    let (Some(names), Some(kinds)) = (names, kinds) else {
        return (Vec::new(), None);
    };
    let mut found: Vec<(usize, ParamProfile)> = Vec::new();
    let mut unorderable = false;
    for (binding, kind) in kinds {
        if kind.as_str() != Some("param") {
            continue;
        }
        let declared = binding
            .split(':')
            .nth(2)
            .and_then(|offset| offset.parse::<usize>().ok());
        match declared {
            Some(offset) => found.push((
                offset,
                ParamProfile {
                    binding: binding.clone(),
                    name: names
                        .get(binding)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    index: 0,
                },
            )),
            None => unorderable = true,
        }
    }
    found.sort_by_key(|(offset, _)| *offset);
    let params: Vec<ParamProfile> = found
        .into_iter()
        .enumerate()
        .map(|(index, (_, mut param))| {
            param.index = index;
            param
        })
        .collect();
    let arity = if unorderable || params.is_empty() {
        None
    } else {
        Some(params.len())
    };
    (params, arity)
}

/// Names the JavaScript runtime itself provides.
///
/// A caller cannot "declare" these: `--global Error=null` does not supply an
/// Error constructor, it removes one -- and a run that overwrites the runtime's
/// own globals fails for a reason that has nothing to do with the function under
/// test. They are built-ins or Node globals, present in whatever runtime the
/// copy is executed with, so they are never asked for as inputs.
const RUNTIME_GLOBALS: &[&str] = &[
    "AggregateError",
    "Array",
    "ArrayBuffer",
    "AsyncFunction",
    "Atomics",
    "BigInt",
    "BigInt64Array",
    "BigUint64Array",
    "Boolean",
    "DataView",
    "Date",
    "Error",
    "EvalError",
    "FinalizationRegistry",
    "Float32Array",
    "Float64Array",
    "Function",
    "Infinity",
    "Int16Array",
    "Int32Array",
    "Int8Array",
    "Intl",
    "JSON",
    "Map",
    "Math",
    "NaN",
    "Number",
    "Object",
    "Promise",
    "Proxy",
    "RangeError",
    "ReferenceError",
    "Reflect",
    "RegExp",
    "Set",
    "SharedArrayBuffer",
    "String",
    "Symbol",
    "SyntaxError",
    "TypeError",
    "URIError",
    "Uint16Array",
    "Uint32Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "WeakMap",
    "WeakRef",
    "WeakSet",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "escape",
    "eval",
    "globalThis",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
    "undefined",
    "unescape",
    "queueMicrotask",
    "structuredClone",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "setImmediate",
    "clearImmediate",
    "console",
    "process",
    "performance",
    "fetch",
    "URL",
    "URLSearchParams",
    "TextEncoder",
    "TextDecoder",
    "AbortController",
    "AbortSignal",
    "Event",
    "EventTarget",
    "Buffer",
    "__dirname",
    "__filename",
    "require",
    "module",
    "exports",
];

fn is_runtime_global(name: &str) -> bool {
    RUNTIME_GLOBALS.contains(&name)
}

/// The names this function reads from outside its own bindings, minus the ones
/// it imports.
///
/// Three sources, because none is complete on its own: `read_external` ops name
/// every external read including ones that never reach a value origin, and
/// `External(name)` origins catch a name that reached a summary. Imports are
/// subtracted because an imported binding is module state the copied module
/// provides; asking a caller to declare it would be asking for a value that is
/// already there.
fn external_names(
    fact: &serde_json::Value,
    blocks: Option<&Vec<serde_json::Value>>,
) -> Vec<String> {
    let mut names = std::collections::BTreeSet::new();
    // Imports are recorded with a sentinel prefix so they can be subtracted
    // after every other source has contributed.
    if let Some(imports) = fact.get("imports").and_then(|v| v.as_array()) {
        for name in imports.iter().filter_map(|v| v.as_str()) {
            names.insert(format!("\u{0}import:{name}"));
        }
    }
    // `read_external` is decided by the language worker at the read site with
    // full scope information (a block-scoped `let CONFIG` must not hide the
    // outer global `CONFIG`, and a shorthand `{ written }` read is a local).
    // Filtering here by binding names would need lexical scoping this layer
    // does not have, so the ops are trusted as classified.
    if let Some(ops) = fact.get("ops").and_then(|v| v.as_array()) {
        for op in ops {
            if op.get("kind").and_then(|v| v.as_str()) == Some("read_external")
                && let Some(name) = op.get("detail").and_then(|v| v.as_str())
            {
                names.insert(name.to_string());
            }
        }
    }
    let mut collect = |origins: &serde_json::Value| {
        if let Some(items) = origins.as_array() {
            for origin in items.iter().filter_map(|v| v.as_str()) {
                if let Some(name) = origin
                    .strip_prefix("External(")
                    .and_then(|rest| rest.strip_suffix(')'))
                {
                    // `<unmodeled>` is the engine's marker for a construct it
                    // does not model. It is not a name a caller could declare,
                    // and an identifier cannot contain angle brackets, so it
                    // cannot collide with a real name either.
                    if !name.starts_with('<') {
                        names.insert(name.to_string());
                    }
                }
            }
        }
    };
    for key in ["returns", "throws"] {
        if let Some(value) = fact.get(key).and_then(|v| v.get("origins")) {
            collect(value);
        }
    }
    if let Some(blocks) = blocks {
        for block in blocks {
            if let Some(bindings) = block.get("bindings").and_then(|v| v.as_array()) {
                for binding in bindings {
                    if let Some(origins) = binding.get("value").and_then(|v| v.get("origins")) {
                        collect(origins);
                    }
                }
            }
        }
    }
    // Imports are only used to exclude; a name that appears both as an import
    // and as a read is module state.
    let imports: std::collections::BTreeSet<String> = names
        .iter()
        .filter_map(|name| name.strip_prefix("\u{0}import:").map(str::to_string))
        .collect();
    names
        .into_iter()
        .filter(|name| !name.starts_with("\u{0}import:"))
        .filter(|name| !imports.contains(name))
        .filter(|name| !is_runtime_global(name))
        .collect()
}

/// Origins observed anywhere in the published facts, counted by kind.
///
/// Block states alone are not enough: a value that only flows to the return (or
/// the throw) never lands in a binding, so a function like `self() { return
/// this; }` would look context-free. The returns and throws summaries carry
/// their own origins and are scanned too.
fn origin_kinds(fact: &serde_json::Value) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    let count_origins = |value: &serde_json::Value, counts: &mut BTreeMap<String, usize>| {
        let Some(origins) = value.get("origins").and_then(|v| v.as_array()) else {
            return;
        };
        for origin in origins.iter().filter_map(|v| v.as_str()) {
            let kind = origin.split('(').next().unwrap_or(origin).to_string();
            *counts.entry(kind).or_insert(0) += 1;
        }
    };
    for key in ["returns", "throws"] {
        if let Some(value) = fact.get(key) {
            count_origins(value, &mut counts);
        }
    }
    let Some(blocks) = fact.get("block_states").and_then(|v| v.as_array()) else {
        return counts;
    };
    for block in blocks {
        let Some(bindings) = block.get("bindings").and_then(|v| v.as_array()) else {
            continue;
        };
        for binding in bindings {
            let Some(origins) = binding
                .get("value")
                .and_then(|v| v.get("origins"))
                .and_then(|v| v.as_array())
            else {
                continue;
            };
            for origin in origins.iter().filter_map(|v| v.as_str()) {
                let kind = origin.split('(').next().unwrap_or(origin).to_string();
                *counts.entry(kind).or_insert(0) += 1;
            }
        }
    }
    counts
}

/// The captured binding names, sorted and deduplicated.
///
/// A capture origin is `Capture(<binding id>)`; the published `binding_names`
/// map turns that id into the name the caller would recognise. A capture whose
/// binding is not in the map is reported by its id rather than dropped, because
/// an unexplained capture is exactly what must not be silently omitted.
fn capture_names(fact: &serde_json::Value, blocks: Option<&Vec<serde_json::Value>>) -> Vec<String> {
    fn collect(
        origins: &serde_json::Value,
        names: Option<&serde_json::Map<String, serde_json::Value>>,
        found: &mut BTreeSet<String>,
    ) {
        let Some(origins) = origins.as_array() else {
            return;
        };
        for origin in origins.iter().filter_map(|v| v.as_str()) {
            let Some(binding) = origin
                .strip_prefix("Capture(")
                .and_then(|rest| rest.strip_suffix(')'))
            else {
                continue;
            };
            let short = names
                .and_then(|map| map.get(binding))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                // A capture's binding is declared in the *enclosing* function,
                // so it is usually absent from this function's `binding_names`.
                // The id ends with the declared name; that name is only used
                // when it looks like an identifier, never a path segment.
                .or_else(|| {
                    let last = binding.rsplit(':').next().unwrap_or(binding);
                    (!last.is_empty()
                        && last
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$'))
                    .then(|| last.to_string())
                })
                .unwrap_or_else(|| binding.to_string());
            found.insert(short);
        }
    }
    let names = fact.get("binding_names").and_then(|v| v.as_object());
    let mut found: BTreeSet<String> = BTreeSet::new();
    for key in ["returns", "throws"] {
        if let Some(value) = fact.get(key) {
            collect(value.get("origins").unwrap_or(value), names, &mut found);
        }
    }
    if let Some(blocks) = blocks {
        for block in blocks {
            let Some(bindings) = block.get("bindings").and_then(|v| v.as_array()) else {
                continue;
            };
            for binding in bindings {
                if let Some(value) = binding.get("value").and_then(|v| v.get("origins")) {
                    collect(value, names, &mut found);
                }
            }
        }
    }
    found.into_iter().collect()
}

/// Derive the sufficiency profile of one function from its published fact.
///
/// Ordering of the rules is the whole argument: `unsupported` wins over
/// `needs_entry_driver`, which wins over `needs_context`, which wins over
/// `pure_callable`. A function is only `pure_callable` when nothing in its
/// published fact says otherwise, and any partial analysis is at best
/// `needs_context` because unknown facts cannot prove purity.
///
/// `enclosing` is the symbol of the function this one is declared inside, as
/// published by the analysis graph. `None` means the target is top-level.
pub fn profile(
    analysis_id: &str,
    symbol: &str,
    path: &str,
    name: &str,
    fact: &serde_json::Value,
    enclosing: Option<&str>,
) -> ExecutionProfile {
    let top_level = enclosing.is_none();
    let mut reasons: Vec<Reason> = Vec::new();
    let mut required: BTreeSet<String> = BTreeSet::new();

    let status = fact
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let flow_profile = fact
        .get("profile")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let unknown_reasons = strings(fact, "unknown_reasons");
    let effects = fact
        .get("effects")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let mut push = |code: &str, detail: String, evidence: &str| {
        reasons.push(Reason {
            code: code.into(),
            detail,
            evidence: evidence.into(),
        });
    };

    // A partial derivation is not a proof of purity: the frontier blocks are
    // exactly the ones whose facts are missing. `complete_within_profile` is
    // the engine's name for "nothing was left unfinished inside the declared
    // profile"; anything else is partial. None of these can be supplied by a
    // caller, so all of them need the explicit acknowledgement instead.
    let complete = status == "complete_within_profile";
    if !complete {
        push(
            "analysis_partial",
            format!("函数分析状态为 {status}，因此「无未知副作用」没有被证明"),
            "status",
        );
        required.insert("unknown_calls".into());
    }
    for reason in &unknown_reasons {
        push(
            "unknown_region",
            format!("存在显式未知分量：{reason}"),
            "unknown_reasons",
        );
        required.insert("unknown_calls".into());
    }
    if let Some(frontier) = fact.get("frontier").and_then(|v| v.as_array())
        && !frontier.is_empty()
    {
        push(
            "frontier_blocks",
            format!("{} 个基本块留在 frontier，其事实不完整", frontier.len()),
            "frontier",
        );
        required.insert("unknown_calls".into());
    }

    // Unsupported constructs cannot be isolated by this runner at all.
    if unknown_reasons.iter().any(|reason| {
        reason.contains("dynamic") || reason.contains("eval") || reason.contains("with")
    }) {
        push(
            "dynamic_code",
            "函数包含 eval/with/动态代码，无法在隔离副本内界定其行为".into(),
            "unknown_reasons",
        );
    }
    for reason in &unknown_reasons {
        if reason.contains("dynamic") || reason.contains("eval") {
            required.insert("unknown_calls".into());
        }
    }

    let unknown_call = flag(&effects, "unknown_call");
    if unknown_call {
        push(
            "unknown_call",
            "调用了 Atlas 无法解析的目标，其行为不在事实内".into(),
            "effects.unknown_call",
        );
        required.insert("unknown_calls".into());
    }
    let may_call = effects
        .get("may_call")
        .and_then(|v| v.as_array())
        .map(|v| v.len())
        .unwrap_or(0);
    if may_call > 0 {
        push(
            "may_call",
            format!("存在 {may_call} 个被调用目标，其效果不全部在本函数事实内"),
            "effects.may_call",
        );
    }
    if flag(&effects, "registers_callback") {
        push(
            "registers_callback",
            "把回调交给外部代码，回调何时被调用不可知".into(),
            "effects.registers_callback",
        );
        required.insert("unknown_calls".into());
    }
    if flag(&effects, "escaped_local_value") {
        push(
            "escaped_value",
            "本地值逃逸到分析范围之外".into(),
            "effects.escaped_local_value",
        );
        required.insert("unknown_calls".into());
    }
    if flag(&effects, "may_access_global") {
        push(
            "reads_global",
            "读取了全局状态，其值由运行环境决定而不是由参数决定".into(),
            "effects.may_access_global",
        );
    }
    if flag(&effects, "may_read_heap") || flag(&effects, "may_write_heap") {
        push(
            "heap_state",
            "读写堆对象，结果依赖被传入对象的身份与历史".into(),
            "effects.may_read_heap / may_write_heap",
        );
        required.insert("unknown_calls".into());
    }

    let origins = origin_kinds(fact);
    let blocks = fact.get("block_states").and_then(|v| v.as_array());
    let globals = external_names(fact, blocks);
    let mut required_context: BTreeSet<String> = BTreeSet::new();
    let mut unsatisfiable: BTreeSet<String> = BTreeSet::new();
    // A named external is an input the caller can state. An unnamed external
    // read is only "this function reads something outside its parameters", and
    // a requirement nobody can act on belongs with the acknowledgement, not
    // with the inputs.
    if !globals.is_empty() {
        required_context.insert("globals".into());
    } else if flag(&effects, "may_access_global") {
        required.insert("unknown_calls".into());
    }
    for kind in ["Capture", "External", "This"] {
        if let Some(count) = origins.get(kind) {
            let code = match kind {
                "Capture" => "captured_binding",
                "External" => "external_binding",
                _ => "receiver_this",
            };
            push(
                code,
                format!("{count} 个值来源是 {kind}，不属于参数命名空间"),
                "block_states[].bindings[].value.origins",
            );
            match kind {
                // A caller can state its receiver and its globals, and the
                // record then says exactly what was stated.
                "This" => {
                    required_context.insert("this_arg".into());
                }
                // External names are handled above, from the names themselves.
                "External" => {}
                // A capture is module-level state when the function is
                // top-level: the module is copied, so that state exists at
                // import time and needs no declaration. A capture in a nested
                // function is an instance of an enclosing scope: it cannot be
                // declared as a value, it can only be produced by running the
                // enclosing function, and that is what `via` does.
                _ if top_level => {
                    required.insert("unknown_calls".into());
                }
                _ => {
                    unsatisfiable.insert("captures".into());
                }
            }
        }
    }
    let captures = capture_names(fact, blocks);

    let interprocedural_incomplete = fact
        .get("interprocedural")
        .and_then(|v| v.get("callsites"))
        .and_then(|v| v.as_array())
        .map(|sites| {
            sites
                .iter()
                .any(|site| !flag(site, "targets_complete") || flag(site, "unknown_component"))
        })
        .unwrap_or(false);
    if interprocedural_incomplete {
        push(
            "callsite_incomplete",
            "至少一个调用点的目标集合不完整".into(),
            "interprocedural.callsites[].targets_complete",
        );
        required.insert("unknown_calls".into());
    }

    let unsupported = reasons.iter().any(|r| r.code == "dynamic_code");
    let driver = !unsupported
        && reasons.iter().any(|r| {
            matches!(
                r.code.as_str(),
                "unknown_call" | "registers_callback" | "escaped_value" | "callsite_incomplete"
            )
        });
    let context = !unsupported
        && !driver
        && reasons.iter().any(|r| {
            matches!(
                r.code.as_str(),
                "analysis_partial"
                    | "unknown_region"
                    | "frontier_blocks"
                    | "heap_state"
                    | "captured_binding"
                    | "external_binding"
                    | "receiver_this"
                    | "reads_global"
                    | "may_call"
            )
        });

    let classification = if unsupported {
        CLASS_UNSUPPORTED
    } else if driver {
        CLASS_DRIVER
    } else if context {
        CLASS_CONTEXT
    } else {
        CLASS_PURE
    };

    let (params, arity) = params_from_fact(fact);
    let mut notes = vec![
        "分类来自已发布的静态事实，不是执行观测；unknown 一律降级而不是忽略。".to_string(),
        "纯调用判定不包含文件/网络/子进程副作用的静态建模：这些权限由运行时的 Node 权限模型强制，未授予即被拒绝。".to_string(),
    ];
    if classification == CLASS_CONTEXT {
        if unsatisfiable.contains("captures") {
            notes.push(
                "needs_context：捕获的绑定不是可声明的值，无法用数据提供；它只能由包含它的函数真实产生。\
                 直接调用按 unsatisfiable 拒绝，改用 --via <enclosing-symbol> 让 Atlas 先调用该外层函数，\
                 并只接受它返回的函数实例（返回值会与目标符号的钉住字节做源码同一性比对）。"
                    .to_string(),
            );
        } else {
            notes.push(
                "needs_context：需要调用者用 --this / --global 显式声明输入才能运行；Atlas 不发明这些值。"
                    .to_string(),
            );
        }
    }
    if classification == CLASS_DRIVER {
        notes.push(
            "needs_entry_driver 需要显式 --allow-effects unknown_calls 才可运行。".to_string(),
        );
    }
    if !complete {
        notes.push("partial 分析的部分结果不作为 no-effect 证明。".to_string());
    }
    if let Some(enclosing) = enclosing {
        notes.push(format!(
            "目标嵌套在 {enclosing} 内：模块命名空间里通常没有它；用 --via {enclosing} 让 Atlas 调用包含函数并只接受它返回的那个函数实例。"
        ));
    }

    ExecutionProfile {
        schema: PROFILE_SCHEMA.into(),
        analysis_id: analysis_id.into(),
        symbol: symbol.into(),
        path: path.into(),
        name: name.into(),
        classification: classification.into(),
        runnable: (classification == CLASS_PURE || classification == CLASS_DRIVER)
            || (classification == CLASS_CONTEXT && unsatisfiable.is_empty()),
        reasons,
        params,
        arity,
        flow_status: status,
        flow_profile,
        unknown_reasons,
        effects,
        required_grants: required.into_iter().collect(),
        required_context: required_context.into_iter().collect(),
        required_globals: globals,
        unsatisfiable_context: unsatisfiable.into_iter().collect(),
        captures,
        enclosing_symbol: enclosing.map(str::to_string),
        enclosing_name: None,
        notes,
    }
}

/// How an enclosing function is named in a message: the declared name when it
/// is known, always with the symbol id that is the actual identity.
pub fn enclosing_label(profile: &ExecutionProfile) -> String {
    match (&profile.enclosing_name, &profile.enclosing_symbol) {
        (Some(name), Some(symbol)) => format!("{name}（{symbol}）"),
        (None, Some(symbol)) => symbol.clone(),
        _ => "无（目标是顶层函数）".to_string(),
    }
}

/// Decide whether the spec grants everything the profile requires.
pub fn decide(profile: &ExecutionProfile, spec: &RunSpec) -> ExecutionDecision {
    let missing: Vec<String> = profile
        .required_grants
        .iter()
        .filter(|grant| !granted(&spec.grants, grant))
        .cloned()
        .collect();
    if profile.classification == CLASS_UNSUPPORTED {
        return ExecutionDecision {
            allowed: false,
            refusal: Some(Reason {
                code: "profile_unsupported".into(),
                detail: "该函数含无法在隔离副本内界定的构造，本切片拒绝执行".into(),
                evidence: "execution_profile.classification".into(),
            }),
            required_grants: profile.required_grants.clone(),
            missing_grants: Vec::new(),
            missing_context: Vec::new(),
        };
    }
    // A `via` run may only enter through the target's real enclosing function.
    // Anything else would be a different instance wearing a similar source, so
    // the mismatch is refused instead of being left to the run to notice.
    if let Some(via) = &spec.via
        && profile.enclosing_symbol.as_deref() != Some(via.symbol.as_str())
    {
        return ExecutionDecision {
            allowed: false,
            refusal: Some(Reason {
                code: "via_not_the_enclosing_symbol".into(),
                detail: format!(
                    "--via {} 不是目标的包含函数；目标的包含函数是 {}。闭包实例只能从真实的包含作用域产生。",
                    via.symbol,
                    enclosing_label(profile)
                ),
                evidence: "execution_profile.enclosing_symbol".into(),
            }),
            required_grants: profile.required_grants.clone(),
            missing_grants: Vec::new(),
            missing_context: Vec::new(),
        };
    }
    let via_enters_enclosing = spec
        .via
        .as_ref()
        .is_some_and(|via| profile.enclosing_symbol.as_deref() == Some(via.symbol.as_str()));
    if !profile.unsatisfiable_context.is_empty() && !via_enters_enclosing {
        let captures = if profile.captures.is_empty() {
            String::new()
        } else {
            format!("（捕获的绑定：{}）", profile.captures.join(", "))
        };
        let how = match &profile.enclosing_symbol {
            Some(symbol) => format!(
                "；该函数只能通过 --via {symbol} 运行，由包含函数 {} 真实产生这个实例",
                enclosing_label(profile)
            ),
            None => String::new(),
        };
        return ExecutionDecision {
            allowed: false,
            refusal: Some(Reason {
                code: "context_required".into(),
                detail: format!(
                    "函数依赖 Atlas 无法用数据声明的上下文：{}{captures}{how}",
                    profile.unsatisfiable_context.join(", ")
                ),
                evidence: "execution_profile.unsatisfiable_context".into(),
            }),
            required_grants: profile.required_grants.clone(),
            missing_grants: Vec::new(),
            missing_context: profile.required_context.clone(),
        };
    }
    let mut missing_context: Vec<String> = Vec::new();
    for item in &profile.required_context {
        match item.as_str() {
            "this_arg" if spec.this_arg.is_none() => missing_context.push(item.clone()),
            // Globals are checked by name, so the refusal says exactly which
            // value has to be stated rather than "some global".
            "globals" => {
                for name in &profile.required_globals {
                    if !spec.globals.contains_key(name) {
                        missing_context.push(format!("global:{name}"));
                    }
                }
            }
            _ => {}
        }
    }
    // Everything that is missing is reported at once. Reporting only the first
    // kind would make a caller fix one thing, re-run, and discover the next.
    if !missing.is_empty() || !missing_context.is_empty() {
        let mut parts = Vec::new();
        if !missing.is_empty() {
            parts.push(format!("未授予：{}", missing.join(", ")));
        }
        if !missing_context.is_empty() {
            parts.push(format!("上下文未声明：{}", missing_context.join(", ")));
        }
        return ExecutionDecision {
            allowed: false,
            refusal: Some(Reason {
                code: "missing_requirements".into(),
                detail: parts.join("；"),
                evidence: "execution_profile.required_grants / required_context".into(),
            }),
            required_grants: profile.required_grants.clone(),
            missing_grants: missing,
            missing_context,
        };
    }
    ExecutionDecision {
        allowed: true,
        refusal: None,
        required_grants: profile.required_grants.clone(),
        missing_grants: Vec::new(),
        missing_context: Vec::new(),
    }
}

fn granted(grants: &Grants, name: &str) -> bool {
    match name {
        "unknown_calls" => grants.unknown_calls,
        "fs_write" => grants.fs_write,
        "child_process" => grants.child_process,
        "network" => grants.network,
        _ => false,
    }
}

/// Validate a snapshot-relative path before it is written to the host
/// filesystem. The worker validates too, but the copy is a host operation.
pub fn safe_relative(path: &str) -> Result<&Path> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains('\0')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(invalid("unsafe_snapshot_path"));
    }
    Ok(Path::new(path))
}

/// An isolated working copy materialised from the immutable snapshot.
///
/// The copy is the *only* thing the child process is allowed to read. Because
/// every byte comes from a content-addressed blob whose hash was verified, the
/// run is bound to the pinned snapshot by construction: source drift between
/// analysis and execution is not merely detected, it is impossible.
pub struct PreparedRun {
    pub _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub harness: PathBuf,
    pub module_path: String,
    /// Sorted `path -> blob` of everything written.
    pub manifest: Vec<(String, String)>,
    pub workdir_digest: String,
    pub target_source: String,
    /// What was written and on what basis, as it will appear in the record.
    pub materialisation: serde_json::Value,
}

/// The bytes of one symbol slice, read from the pinned snapshot blobs. Every
/// read re-verifies the blob hash, so a slice is bound to the snapshot rather
/// than to whatever the file happens to contain now.
pub fn source_slice(
    store: &Store,
    snapshot: &Snapshot,
    path: &str,
    start: usize,
    end: usize,
) -> Result<String> {
    let blob = snapshot
        .entries
        .iter()
        .find(|entry| entry.path == path)
        .and_then(|entry| entry.blob.clone())
        .ok_or_else(|| invalid("target_source_missing"))?;
    let bytes = store.read_blob(&blob)?;
    if end > bytes.len() || start > end {
        return Err(invalid("invalid_symbol_span"));
    }
    Ok(std::str::from_utf8(&bytes[start..end])
        .map_err(|_| invalid("target_source_not_utf8"))?
        .to_string())
}

/// What a `dependencies` copy keeps, and the evidence for why.
pub struct SliceSpec {
    pub seed: String,
    pub files: BTreeSet<String>,
    pub unresolved_relative: Vec<String>,
    pub unresolved_bare: usize,
    pub edges_read: usize,
    pub bounded: bool,
}

pub fn prepare(
    store: &Store,
    snapshot: &Snapshot,
    symbol_path: &str,
    symbol_start: usize,
    symbol_end: usize,
    slice: Option<&SliceSpec>,
) -> Result<PreparedRun> {
    // The copy must live on a canonical path. On macOS `$TMPDIR` is reached
    // through the `/var -> /private/var` symlink, and Node's module loader
    // calls `realpathSync` on its entry; that resolution would need read access
    // to a directory the run was never granted, so the process would die inside
    // the loader instead of inside the code under test.
    let base = std::fs::canonicalize(std::env::temp_dir())?;
    let dir = tempfile::Builder::new()
        .prefix("atlas-run-")
        .tempdir_in(base)?;
    let root = dir.path().to_path_buf();
    // A sliced copy always carries the target file and every `package.json` in
    // the snapshot: Node reads the nearest one for module type resolution, and a
    // copy that dropped them would change how the same bytes are interpreted.
    // The second is a bounded, reported inclusion rather than a hidden one.
    let mut package_json_kept = 0usize;
    let mut package_json_skipped = 0usize;
    let keep = |path: &str| -> bool {
        match slice {
            None => true,
            Some(slice) => slice.files.contains(path) || path == symbol_path,
        }
    };
    let mut manifest = Vec::new();
    let mut bytes_written = 0usize;
    for entry in &snapshot.entries {
        let Some(blob) = &entry.blob else {
            continue;
        };
        let is_package_json = entry.path == "package.json" || entry.path.ends_with("/package.json");
        if slice.is_some() && is_package_json {
            if package_json_kept >= SLICE_MAX_PACKAGE_JSON {
                package_json_skipped += 1;
                continue;
            }
            package_json_kept += 1;
        } else if !keep(&entry.path) {
            continue;
        }
        let relative = safe_relative(&entry.path)?;
        let bytes = store.read_blob(blob)?;
        bytes_written += bytes.len();
        let target = root.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, &bytes)?;
        manifest.push((entry.path.clone(), blob.clone()));
    }
    // Never start a process whose target is not in the copy. With the closure
    // above this cannot happen, which is exactly why it is asserted here rather
    // than assumed.
    if !manifest.iter().any(|(path, _)| path == symbol_path) {
        return Err(invalid("slice_missing_target"));
    }
    manifest.sort();
    let mut identity = String::new();
    for (path, blob) in &manifest {
        identity.push_str(path);
        identity.push('\0');
        identity.push_str(blob);
        identity.push('\n');
    }
    let workdir_digest = digest(identity.as_bytes());
    let module_path = safe_relative(symbol_path)?.to_string_lossy().to_string();
    let target_source = source_slice(store, snapshot, symbol_path, symbol_start, symbol_end)?;
    let snapshot_files = snapshot
        .entries
        .iter()
        .filter(|entry| entry.blob.is_some())
        .count();
    let written: Vec<String> = manifest.iter().map(|(path, _)| path.clone()).collect();
    let materialisation = serde_json::json!({
        "mode": if slice.is_some() { MATERIALISE_DEPENDENCIES } else { MATERIALISE_SNAPSHOT },
        "basis": if slice.is_some() {
            "已发布 import 边上的传递闭包（type-only import 不跟随：它在运行前就被擦除），加上快照里所有 package.json（Node 用它决定模块类型）"
        } else {
            "快照里每一个被捕获的文件"
        },
        "files_written": manifest.len(),
        "files_in_snapshot": snapshot_files,
        "bytes_written": bytes_written,
        "written": if written.len() <= SLICE_LIST_LIMIT { serde_json::json!(written) } else { serde_json::json!([]) },
        "written_listed": written.len().min(SLICE_LIST_LIMIT),
        "written_truncated": written.len() > SLICE_LIST_LIMIT,
        "package_json": { "kept": package_json_kept, "skipped_by_cap": package_json_skipped },
        "closure": slice.map(|slice| serde_json::json!({
            "seed": slice.seed,
            "reached": slice.files.len(),
            // A relative import the graph could not map is the one kind that can
            // break a sliced run, so it is named. A bare specifier is resolved
            // by Node outside the copy and is counted only.
            "unresolved_relative": slice.unresolved_relative,
            "unresolved_bare": slice.unresolved_bare,
            "import_edges_read": slice.edges_read,
            "bounded": slice.bounded,
        })),
        "workdir_digest": workdir_digest,
        "known_risk": if slice.is_some() {
            serde_json::json!([
                "动态 import 的计算型 specifier 不在静态图里，因此可能不在副本中",
                "函数运行时按相对路径读取的其它项目文件不在副本里：这是更紧的读边界，缺失会以 ENOENT 出现",
            ])
        } else {
            serde_json::json!([])
        },
        "fallback": if slice.is_some() {
            "若本次运行以 module_load_failed / ENOENT 失败，可用 --materialise snapshot 复核；切片是静态闭包，不是运行时依赖追踪"
        } else {
            ""
        },
    });
    let harness = root.join("atlas-harness.mjs");
    fs::write(&harness, HARNESS)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    }
    Ok(PreparedRun {
        _dir: dir,
        root,
        harness,
        module_path,
        manifest,
        workdir_digest,
        target_source,
        materialisation,
    })
}

/// The generated harness. It resolves the call target by *source identity*
/// against the pinned snapshot slice instead of trusting a name, so a rename or
/// a shadowed export cannot silently run a different function. It never
/// evaluates `Function`/`eval` over the source.
///
/// The report is written last, behind a per-run random marker, and the process
/// exits explicitly once it is flushed. That makes the process terminate even
/// if the called code left timers behind, and it keeps a target that writes to
/// stdout from being mistaken for the harness report.
pub const HARNESS: &str = r#"// Atlas execution harness (generated). Runs exactly one pinned call.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const marker = payload.report_marker;
const normalise = text => String(text).replace(/\s+/g, ' ').trim();
const strip = text => normalise(text).replace(/^(export\s+)?(default\s+)?(async\s+)?(export\s+)?/, '');
const encode = (value, depth, seen) => {
  if (depth > 6) return { kind: 'depth_limit' };
  if (value === null) return { kind: 'null' };
  const type = typeof value;
  if (type === 'undefined') return { kind: 'undefined' };
  if (type === 'number') {
    if (Number.isNaN(value)) return { kind: 'nan' };
    if (value === Infinity) return { kind: 'infinity' };
    if (value === -Infinity) return { kind: 'negative_infinity' };
    return { kind: 'number', value };
  }
  if (type === 'string') return { kind: 'string', value: value.length > 2000 ? value.slice(0, 2000) : value, truncated: value.length > 2000 };
  if (type === 'boolean') return { kind: 'boolean', value };
  if (type === 'bigint') return { kind: 'bigint', value: value.toString() };
  if (type === 'symbol') return { kind: 'symbol', description: String(value.description === undefined ? '' : value.description) };
  if (type === 'function') return { kind: 'function', name: String(value.name || '') };
  if (Array.isArray(value)) {
    if (seen.has(value)) return { kind: 'cycle' };
    seen.add(value);
    const items = value.slice(0, 200).map(item => encode(item, depth + 1, seen));
    seen.delete(value);
    return { kind: 'array', items, truncated: value.length > 200 };
  }
  if (seen.has(value)) return { kind: 'cycle' };
  seen.add(value);
  const keys = Object.keys(value).slice(0, 200);
  const entries = {};
  for (const key of keys) {
    let item;
    try { item = encode(value[key], depth + 1, seen); } catch (error) { item = { kind: 'unreadable', detail: String(error && error.message).slice(0, 120) }; }
    entries[key] = item;
  }
  seen.delete(value);
  const proto = Object.getPrototypeOf(value);
  return { kind: 'object', constructor: proto && proto.constructor ? String(proto.constructor.name) : 'null', entries, truncated: Object.keys(value).length > 200 };
};
const describe = error => ({
  name: error && error.name ? String(error.name) : typeof error,
  message: String(error && error.message !== undefined ? error.message : error).slice(0, 500),
  code: error && error.code ? String(error.code) : null,
  // Node's permission model puts the attempted operation and its target on the
  // error. That is the only per-operation evidence the runtime gives us, so it
  // is carried out verbatim instead of being summarised away.
  permission: error && error.permission ? String(error.permission) : null,
  resource: error && error.resource !== undefined ? String(error.resource).slice(0, 500) : null,
  stack: String(error && error.stack ? error.stack : '').split('\n').slice(0, 16)
});
const lines = [];
let truncated = false;
const consoleLimit = payload.console_limit || 16384;
const capture = name => (...args) => {
  if (lines.length > 200 || lines.join('\n').length > consoleLimit) { truncated = true; return; }
  lines.push(name + ': ' + args.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ').slice(0, 500));
};
const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
console.log = capture('log'); console.warn = capture('warn'); console.error = capture('error'); console.info = capture('info');
const report = { schema: 'atlas.execution-harness.v1', verdict: 'failed', detail: null, export_name: null, matched_by: null, candidates: [], awaited: false, value: null, thrown: null, async_events: [], via: null, console: { lines, truncated } };
// One call, awaited if it returns a thenable. Shared by the two stages of a
// `via` run so both stages are observed by exactly the same rules.
const callStage = async (fn, args, thisArg) => {
  const raw = thisArg === null || thisArg === undefined ? fn(...args) : fn.apply(thisArg, args);
  const thenable = raw !== null && (typeof raw === 'object' || typeof raw === 'function') && typeof raw.then === 'function';
  return { awaited: thenable, settled: thenable ? await raw : raw };
};
// The identity rule used for the module namespace is used for a closure the
// enclosing call returned: the value is only accepted when its source is the
// pinned source of the target symbol.
const sourceMatches = (fn, source) => {
  const actual = strip(Function.prototype.toString.call(fn));
  const want = strip(source || '');
  if (actual === want) return true;
  return want.length > 0 && want.endsWith(actual) && actual.length >= want.length * 0.9;
};
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  console.log = original.log; console.warn = original.warn; console.error = original.error; console.info = original.info;
  process.stdout.write(marker + JSON.stringify(report), () => process.exit(0));
};
process.on('unhandledRejection', reason => { report.async_events.push({ kind: 'unhandled_rejection', thrown: describe(reason) }); if (report.verdict === 'returned') report.verdict = 'returned_with_async_error'; finish(); });
process.on('uncaughtException', error => { report.async_events.push({ kind: 'uncaught_exception', thrown: describe(error) }); if (report.verdict === 'returned') report.verdict = 'returned_with_async_error'; finish(); });
// Declared globals are installed before the import: a module reads its globals
// at import time as often as at call time. Atlas does not invent them -- each
// one is a value the caller stated, and the record says which.
report.declared_globals = Object.keys(payload.globals || {});
// A `via` run is two calls. The enclosing stage is created up front so a run in
// which it could not even be resolved still says which stage failed.
if (payload.via) {
  // One stage per ancestor, outermost first. The stage that produces the target
  // is the last one; `stage_report` is that stage, and `stages` keeps all of
  // them so a chain can never be summarised down to its last step.
  report.via = { stage: 'enclosing', stage_count: payload.via.stages.length, export_name: null, matched_by: null, awaited: false, value: null, thrown: null, closure: null, stages: [], failed_stage: null };
}
for (const [name, value] of Object.entries(payload.globals || {})) globalThis[name] = value;
try {
  const namespace = await import(payload.module_url);
  const candidates = [];
  const push = (name, fn) => { if (!candidates.some(([existing]) => existing === name)) candidates.push([name, fn]); };
  if (payload.export_name && typeof namespace[payload.export_name] === 'function') push(payload.export_name, namespace[payload.export_name]);
  for (const [key, value] of Object.entries(namespace)) if (typeof value === 'function') push(key, value);
  const matches = candidates.filter(([, fn]) => sourceMatches(fn, payload.resolve_source));
  report.candidates = candidates.map(([name]) => name);
  // The stage that could not be resolved is named: "the enclosing function is
  // not reachable from the namespace" is a different fact from "the target is
  // not exported", and the caller acting on it differs.
  if (matches.length === 0) { report.detail = payload.via ? 'enclosing_not_exported' : 'target_not_exported'; }
  else if (matches.length > 1) { report.detail = payload.via ? 'enclosing_ambiguous' : 'target_ambiguous'; report.matched_by = matches.map(([name]) => name).join(','); }
  else {
    report.export_name = matches[0][0];
    report.matched_by = 'source_identity';
    if (report.via) { report.via.export_name = matches[0][0]; report.via.matched_by = 'source_identity'; }
    // A `via` run calls each ancestor in turn and only then the target. Every
    // stage is checked by the same rule: the value it returned must be a
    // function whose source is the pinned source of the symbol that stage is
    // supposed to produce. A chain is therefore not "trust the middle": each
    // link is verified against bytes.
    const runTarget = async (fn) => {
      report.receiver_declared = payload.this_arg !== null && payload.this_arg !== undefined;
      try {
        const settled = await callStage(fn, payload.args, payload.this_arg);
        report.closure_awaited = settled.awaited;
        report.value = encode(settled.settled, 0, new Set());
        report.verdict = 'returned';
      } catch (error) {
        report.verdict = 'threw';
        report.thrown = describe(error);
      }
    };
    let fn = matches[0][1];
    if (!payload.via) {
      // A throw from the target is the target throwing. Letting it reach the
      // outer catch would report it as a module load failure instead.
      try {
        report.receiver_declared = payload.this_arg !== null && payload.this_arg !== undefined;
        const only = await callStage(fn, payload.args, payload.this_arg);
        report.awaited = only.awaited;
        report.value = encode(only.settled, 0, new Set());
        report.verdict = 'returned';
      } catch (error) {
        report.verdict = 'threw';
        report.thrown = describe(error);
      }
    } else {
      let produced = null;
      for (let index = 0; index < payload.via.stages.length && !report.detail; index++) {
        const spec = payload.via.stages[index];
        const stageReport = {
          stage: 'enclosing', index, name: spec.name || null, args: spec.args,
          awaited: false, value: null, thrown: null, closure: null
        };
        report.via.stages.push(stageReport);
        try {
          produced = await callStage(fn, spec.args, spec.this_arg);
        } catch (error) {
          stageReport.thrown = describe(error);
          report.via.failed_stage = index;
          report.via.thrown = describe(error);
          report.verdict = 'threw';
          report.thrown = describe(error);
          break;
        }
        stageReport.awaited = produced.awaited;
        stageReport.value = encode(produced.settled, 0, new Set());
        report.via.failed_stage = index;
        if (typeof produced.settled !== 'function') {
          // The stage ran and its result is reported verbatim. Nothing further
          // was called, so this is not a failed call of the target.
          report.detail = 'closure_not_returned';
          break;
        }
        const observed = strip(Function.prototype.toString.call(produced.settled));
        const matched = sourceMatches(produced.settled, spec.source);
        stageReport.closure = {
          matched_by: matched ? 'source_identity' : null,
          name: String(produced.settled.name || ''),
          expected: String(spec.name || ''),
          observed_source: observed.slice(0, 2000)
        };
        if (!matched) {
          report.detail = 'closure_identity_mismatch';
          break;
        }
        fn = produced.settled;
        report.via.failed_stage = null;
      }
      // The last stage's report is the one that produced the target instance.
      const last = report.via.stages[report.via.stages.length - 1];
      if (last) {
        report.via.awaited = last.awaited;
        report.via.value = last.value;
        report.via.thrown = last.thrown;
        report.via.closure = last.closure;
      }
      if (!report.detail && report.verdict !== 'threw') await runTarget(fn);
    }
  }
} catch (error) {
  report.detail = 'module_load_failed';
  report.thrown = describe(error);
}
finish();
"#;

/// Build the harness input document. `report_marker` is unique per run so the
/// harness report cannot be confused with output the called code produced.
pub fn harness_payload(
    prepared: &PreparedRun,
    spec: &RunSpec,
    export_name: Option<&str>,
    report_marker: &str,
    // The source of the function the module namespace is searched for. For a
    // `via` run that is the *outermost* ancestor, because that is the one the
    // namespace can actually contain; a closure is never looked up by name.
    resolve_source: Option<&str>,
    // One entry per ancestor, outermost first: the arguments for that call and
    // the pinned source of the symbol it must return. The last entry must
    // return the target, so the chain is verified link by link.
    via_stages: &[ViaStage],
) -> Result<String> {
    let module_url = format!(
        "file://{}",
        prepared.root.join(&prepared.module_path).display()
    );
    Ok(serde_json::to_string(&serde_json::json!({
        "schema": HARNESS_SCHEMA,
        "module_url": module_url,
        "module_path": prepared.module_path,
        "resolve_source": resolve_source.unwrap_or(&prepared.target_source),
        "export_name": export_name,
        "args": spec.args,
        "this_arg": spec.this_arg,
        "globals": spec.globals,
        "via": if via_stages.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::json!({
                "stages": via_stages.iter().map(|stage| serde_json::json!({
                    "name": stage.name,
                    "args": stage.args,
                    "this_arg": stage.this_arg,
                    "source": stage.expects_source,
                })).collect::<Vec<_>>(),
                "target_source": prepared.target_source,
            })
        },
        "report_marker": report_marker,
        "console_limit": spec.output_limit.min(64 * 1024),
    }))?)
}

/// Map an observed stack frame inside the isolated copy back to the pinned
/// source path and the byte offset of its line. Only frames that are actually
/// inside the copy are reported; anything else stays unknown.
pub fn map_stack_frame(root: &Path, frame: &str, source: &str) -> Option<serde_json::Value> {
    let marker = format!("{}/", root.display());
    // A V8 frame looks like `    at f (file:///tmp/atlas-run-x/src/a.ts:3:9)`.
    // Strip the wrapper before splitting, or the column keeps its `)`.
    let cleaned = frame.trim().trim_end_matches(')');
    let mut parts = cleaned.rsplitn(3, ':');
    let column = parts.next()?.parse::<usize>().ok()?;
    let line = parts.next()?.parse::<usize>().ok()?;
    let url = parts.next()?;
    let start = url.find(&marker)?;
    let path = url[start + marker.len()..].to_string();
    if line == 0 || path.is_empty() {
        return None;
    }
    // Byte offset of the line start in UTF-8, counted exactly.
    let mut offset = 0usize;
    for (index, text) in source.split_inclusive('\n').enumerate() {
        if index + 1 == line {
            break;
        }
        offset += text.len();
    }
    let line_text = source
        .split_inclusive('\n')
        .nth(line - 1)
        .unwrap_or("")
        .trim_end_matches(['\n', '\r']);
    Some(serde_json::json!({
        "path": path,
        "line": line,
        "column": column,
        "byte_offset": offset,
        "line_text": line_text.chars().take(200).collect::<String>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(status: &str, effects: serde_json::Value, reasons: Vec<&str>) -> serde_json::Value {
        serde_json::json!({
            "status": status,
            "profile": "js-structured-control.v1",
            "frontier": [],
            "unknown_reasons": reasons,
            "effects": effects,
            "binding_names": {"b:x.ts:10:a": "a", "b:x.ts:30:b": "b"},
            "binding_kinds": {"b:x.ts:10:a": "param", "b:x.ts:30:b": "param"},
            "block_states": [],
            "interprocedural": {"callsites": []},
        })
    }

    fn clean() -> serde_json::Value {
        fact(
            "complete_within_profile",
            serde_json::json!({"unknown_call": false, "may_call": [], "may_throw": false,
                "may_write_heap": false, "may_read_heap": false, "may_access_global": false,
                "registers_callback": false, "escaped_local_value": false}),
            vec![],
        )
    }

    /// A spec that grants the acknowledgement, so a test about context is not
    /// silently a test about grants.
    fn spec_for(symbol: &str) -> RunSpec {
        RunSpec {
            schema: RUN_SPEC_SCHEMA.into(),
            analysis_id: "a".into(),
            symbol: symbol.into(),
            args: vec![],
            timeout_ms: 1000,
            output_limit: 1024,
            grants: Grants {
                unknown_calls: true,
                ..Grants::default()
            },
            node: "node".into(),
            env: BTreeMap::new(),
            this_arg: None,
            globals: BTreeMap::new(),
            fixtures: false,
            fixture_note: None,
            label: None,
            via: None,
            materialise: None,
            via_chain: Vec::new(),
        }
    }

    #[test]
    fn clean_function_is_pure_and_params_are_ordered() {
        let p = profile("a", "s", "x.ts", "add", &clean(), None);
        assert_eq!(p.classification, CLASS_PURE);
        assert!(p.runnable);
        assert_eq!(p.arity, Some(2));
        assert_eq!(p.params[0].name, "a");
        assert_eq!(p.params[1].name, "b");
        assert!(p.reasons.is_empty());
    }

    #[test]
    fn unknown_call_requires_explicit_grant() {
        let mut f = clean();
        f["effects"]["unknown_call"] = true.into();
        let p = profile("a", "s", "x.ts", "f", &f, None);
        assert_eq!(p.classification, CLASS_DRIVER);
        assert!(p.required_grants.contains(&"unknown_calls".to_string()));
        let mut spec = RunSpec {
            schema: RUN_SPEC_SCHEMA.into(),
            analysis_id: "a".into(),
            symbol: "s".into(),
            args: vec![],
            timeout_ms: 1000,
            output_limit: 1024,
            grants: Grants::default(),
            node: "node".into(),
            env: BTreeMap::new(),
            this_arg: None,
            globals: BTreeMap::new(),
            fixtures: false,
            fixture_note: None,
            label: None,
            via: None,
            materialise: None,
            via_chain: Vec::new(),
        };
        let refused = decide(&p, &spec);
        assert!(!refused.allowed);
        assert_eq!(refused.refusal.unwrap().code, "missing_requirements");
        assert_eq!(refused.missing_grants, vec!["unknown_calls".to_string()]);
        spec.grants.unknown_calls = true;
        assert!(decide(&p, &spec).allowed);
    }

    #[test]
    fn partial_analysis_is_never_pure_and_needs_an_acknowledgement() {
        let mut f = clean();
        f["status"] = "partial_budget".into();
        f["frontier"] = serde_json::json!([3]);
        let p = profile("a", "s", "x.ts", "f", &f, None);
        assert_eq!(p.classification, CLASS_CONTEXT);
        assert!(p.reasons.iter().any(|r| r.code == "analysis_partial"));
        assert!(p.reasons.iter().any(|r| r.code == "frontier_blocks"));
        // Missing facts are not something a caller can supply, so the only way
        // to run this is to acknowledge that it goes beyond what was proved.
        let mut spec = RunSpec {
            schema: RUN_SPEC_SCHEMA.into(),
            analysis_id: "a".into(),
            symbol: "s".into(),
            args: vec![],
            timeout_ms: 1000,
            output_limit: 1024,
            grants: Grants::default(),
            node: "node".into(),
            env: BTreeMap::new(),
            this_arg: None,
            globals: BTreeMap::new(),
            fixtures: false,
            fixture_note: None,
            label: None,
            via: None,
            materialise: None,
            via_chain: Vec::new(),
        };
        assert_eq!(
            decide(&p, &spec).refusal.unwrap().code,
            "missing_requirements"
        );
        spec.grants.unknown_calls = true;
        assert!(decide(&p, &spec).allowed);
    }

    #[test]
    fn an_imported_binding_is_not_a_global_the_caller_must_declare() {
        // `import fs from 'node:fs'` is module state the copied module provides.
        // Reporting it as a global access made the profile ask the caller to
        // declare a value that was already there -- and hid the true global,
        // which is the one the caller can actually act on.
        let mut f = clean();
        f["imports"] = serde_json::json!(["fs", "helper"]);
        f["ops"] = serde_json::json!([
            {"index": 0, "kind": "read_external", "detail": "fs"},
            {"index": 1, "kind": "read_external", "detail": "CONFIG"},
        ]);
        f["effects"]["may_access_global"] = true.into();
        let p = profile("a", "s", "x.ts", "f", &f, None);
        assert_eq!(p.required_globals, vec!["CONFIG".to_string()]);
        assert_eq!(p.required_context, vec!["globals".to_string()]);
        let spec = RunSpec {
            schema: RUN_SPEC_SCHEMA.into(),
            analysis_id: "a".into(),
            symbol: "s".into(),
            args: vec![],
            timeout_ms: 1000,
            output_limit: 1024,
            grants: Grants::default(),
            node: "node".into(),
            env: BTreeMap::new(),
            this_arg: None,
            globals: BTreeMap::new(),
            fixtures: false,
            fixture_note: None,
            label: None,
            via: None,
            materialise: None,
            via_chain: Vec::new(),
        };
        let refused = decide(&p, &spec);
        assert!(!refused.allowed);
        assert_eq!(refused.missing_context, vec!["global:CONFIG".to_string()]);
        let declared = RunSpec {
            globals: BTreeMap::from([("CONFIG".to_string(), serde_json::json!(1))]),
            ..spec
        };
        assert!(decide(&p, &declared).allowed);
    }

    #[test]
    fn a_receiver_or_a_global_must_be_declared_and_is_then_runnable() {
        let mut f = clean();
        f["block_states"] = serde_json::json!([
            {"block": 0, "bindings": [
                {"binding": "b:x.ts:30:b", "name": "b", "value": {"origins": ["This"]}},
                {"binding": "b:x.ts:10:a", "name": "a", "value": {"origins": ["External(CONFIG)"]}}
            ]}
        ]);
        let p = profile("a", "s", "x.ts", "method", &f, None);
        assert_eq!(p.classification, CLASS_CONTEXT);
        assert_eq!(
            p.required_context,
            vec!["globals".to_string(), "this_arg".to_string()]
        );
        assert!(p.unsatisfiable_context.is_empty());
        let spec = RunSpec {
            schema: RUN_SPEC_SCHEMA.into(),
            analysis_id: "a".into(),
            symbol: "s".into(),
            args: vec![],
            timeout_ms: 1000,
            output_limit: 1024,
            grants: Grants::default(),
            node: "node".into(),
            env: BTreeMap::new(),
            this_arg: None,
            globals: BTreeMap::new(),
            fixtures: false,
            fixture_note: None,
            label: None,
            via: None,
            materialise: None,
            via_chain: Vec::new(),
        };
        assert!(!decide(&p, &spec).allowed);
        assert_eq!(decide(&p, &spec).missing_context.len(), 2);
        let declared = RunSpec {
            this_arg: Some(serde_json::json!({"n": 1})),
            globals: BTreeMap::from([("CONFIG".to_string(), serde_json::json!({"value": 1}))]),
            ..spec
        };
        assert!(decide(&p, &declared).allowed);
    }

    #[test]
    fn dynamic_code_is_unsupported_and_refused() {
        let mut f = clean();
        f["unknown_reasons"] = serde_json::json!(["dynamic_code:with"]);
        let p = profile("a", "s", "x.ts", "f", &f, None);
        assert_eq!(p.classification, CLASS_UNSUPPORTED);
        assert!(!p.runnable);
        let spec = RunSpec {
            schema: RUN_SPEC_SCHEMA.into(),
            analysis_id: "a".into(),
            symbol: "s".into(),
            args: vec![],
            timeout_ms: 1000,
            output_limit: 1024,
            grants: Grants {
                unknown_calls: true,
                ..Grants::default()
            },
            node: "node".into(),
            env: BTreeMap::new(),
            this_arg: None,
            globals: BTreeMap::new(),
            fixtures: false,
            fixture_note: None,
            label: None,
            via: None,
            materialise: None,
            via_chain: Vec::new(),
        };
        // Even a fully permissive spec cannot run an unsupported function.
        assert_eq!(
            decide(&p, &spec).refusal.unwrap().code,
            "profile_unsupported"
        );
    }

    #[test]
    fn captured_binding_is_context() {
        let mut f = clean();
        f["block_states"] = serde_json::json!([
            {"block": 0, "bindings": [{"binding": "b:x.ts:30:b", "name": "b", "value": {"origins": ["Capture(b:x.ts:1:c)"]}}]}
        ]);
        let p = profile("a", "s", "x.ts", "f", &f, None);
        assert_eq!(p.classification, CLASS_CONTEXT);
        assert!(p.reasons.iter().any(|r| r.code == "captured_binding"));
    }

    #[test]
    fn a_nested_capture_names_the_enclosing_function_and_cannot_be_declared() {
        let mut f = clean();
        f["block_states"] = serde_json::json!([
            {"block": 0, "bindings": [{"binding": "b:x.ts:30:b", "name": "b", "value": {"origins": ["Capture(b:x.ts:1:value)"]}}]}
        ]);
        let enclosing = "symbol:x.ts:0:40";
        let p = profile("a", "s", "x.ts", "increment", &f, Some(enclosing));
        assert_eq!(p.classification, CLASS_CONTEXT);
        assert_eq!(p.unsatisfiable_context, vec!["captures".to_string()]);
        assert_eq!(
            p.captures,
            vec!["value".to_string()],
            "the captured binding must be named from the id it is published under"
        );
        assert_eq!(p.enclosing_symbol.as_deref(), Some(enclosing));
        assert!(!p.runnable, "a capture is never a declared input");

        let spec = spec_for("s");
        let refused = decide(&p, &spec);
        assert_eq!(refused.refusal.as_ref().unwrap().code, "context_required");
        assert!(refused.refusal.as_ref().unwrap().detail.contains(enclosing));

        // Through the real enclosing function it is allowed -- the instance is
        // produced by code, not typed in by a caller.
        let via = RunSpec {
            via: Some(ViaSpec {
                symbol: enclosing.into(),
                args: vec![],
                this_arg: None,
            }),
            ..spec_for("s")
        };
        assert!(decide(&p, &via).allowed);
    }

    #[test]
    fn a_via_that_is_not_the_enclosing_function_is_refused() {
        let mut f = clean();
        f["block_states"] = serde_json::json!([
            {"block": 0, "bindings": [{"binding": "b:x.ts:30:b", "name": "b", "value": {"origins": ["Capture(b:x.ts:1:value)"]}}]}
        ]);
        let p = profile("a", "s", "x.ts", "increment", &f, Some("symbol:x.ts:0:40"));
        let spec = RunSpec {
            via: Some(ViaSpec {
                symbol: "symbol:x.ts:100:140".into(),
                args: vec![],
                this_arg: None,
            }),
            ..spec_for("s")
        };
        let decision = decide(&p, &spec);
        assert!(!decision.allowed);
        assert_eq!(
            decision.refusal.as_ref().unwrap().code,
            "via_not_the_enclosing_symbol"
        );
    }

    #[test]
    fn a_via_spec_cannot_point_at_its_own_target() {
        let spec = RunSpec {
            via: Some(ViaSpec {
                symbol: "s".into(),
                args: vec![],
                this_arg: None,
            }),
            ..spec_for("s")
        };
        let error = spec.validate().unwrap_err().to_string();
        assert!(error.contains("via_symbol_is_the_target"), "{error}");
    }

    #[test]
    fn materialise_modes_are_closed_and_the_default_is_the_whole_snapshot() {
        assert_eq!(materialise_mode(None).unwrap(), MATERIALISE_SNAPSHOT);
        assert_eq!(
            materialise_mode(Some(MATERIALISE_SNAPSHOT)).unwrap(),
            MATERIALISE_SNAPSHOT
        );
        assert_eq!(
            materialise_mode(Some(MATERIALISE_DEPENDENCIES)).unwrap(),
            MATERIALISE_DEPENDENCIES
        );
        // An unknown mode must fail loudly: silently falling back to the whole
        // snapshot would report a tighter boundary than the one that was used.
        let error = materialise_mode(Some("everything"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("invalid_materialise_mode"), "{error}");
    }

    #[test]
    fn only_relative_specifiers_can_break_a_sliced_copy() {
        for specifier in ["./a.js", "../b.js", ".", ".."] {
            assert!(is_relative_specifier(specifier), "{specifier}");
        }
        for specifier in ["node:fs", "rxjs", "@scope/pkg", "/abs/path.js", ""] {
            assert!(!is_relative_specifier(specifier), "{specifier}");
        }
    }

    #[test]
    fn unsafe_paths_are_rejected() {
        for path in ["/etc/passwd", "../x.ts", "a/../../b", "a//b", "a\\b", ""] {
            assert!(safe_relative(path).is_err(), "{path} was accepted");
        }
        assert!(safe_relative("src/index.ts").is_ok());
    }

    #[test]
    fn stack_frames_map_to_pinned_offsets() {
        let source = "line one\nline two\n  throw new Error('x');\n";
        let root = Path::new("/tmp/atlas-run-abc");
        let frame = "    at f (file:///tmp/atlas-run-abc/src/a.ts:3:9)";
        let mapped = map_stack_frame(root, frame, source).unwrap();
        assert_eq!(mapped["path"], "src/a.ts");
        assert_eq!(mapped["line"], 3);
        assert_eq!(mapped["byte_offset"], 18);
        assert!(map_stack_frame(root, "    at f (file:///elsewhere/a.ts:3:9)", source).is_none());
    }

    #[test]
    fn grants_parse_rejects_unknown_names() {
        assert!(Grants::parse(&["fs_write".into(), "network".into()]).is_ok());
        assert!(Grants::parse(&["everything".into()]).is_err());
    }
}

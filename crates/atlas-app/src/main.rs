mod agent;
mod patchwork;
mod runner;
mod server;
mod worker;

use atlas_contract::{ParseRequest, ScanLimits};
use atlas_engine::bridge;
use atlas_engine::exec::{Grants, RunSpec};
use atlas_engine::job::{self, Lease, STATE_COMPLETED, STATE_FAILED};
use atlas_engine::patch;
use atlas_engine::{analyze, control::ExecutionControl, incremental, scan, store::Store};
use clap::{Args, Parser, Subcommand};
use serde_json::json;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

#[derive(Parser)]
#[command(
    name = "atlas",
    about = "Local code facts and review workbench; independent of Modus and LLMs"
)]
struct Cli {
    #[arg(long, global = true, default_value = "local-state")]
    store: PathBuf,
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    Index {
        root: PathBuf,
        #[arg(long, default_value = "node")]
        node: PathBuf,
        #[arg(long, default_value = "workers/typescript/worker.mjs")]
        worker: PathBuf,
        #[arg(long, default_value_t = 60)]
        timeout_seconds: u64,
        /// Overall deadline for the filesystem scan stage.
        #[arg(long, default_value_t = 300)]
        scan_deadline_seconds: u64,
        /// Overall deadline for the whole index pipeline (scan + worker +
        /// publish); each stage gets the smaller of its own budget and the
        /// remaining pipeline budget.
        #[arg(long, default_value_t = 600)]
        index_deadline_seconds: u64,
        /// Reuse an already-published analysis when the bytes and the versions
        /// are unchanged, and report what a partial change would invalidate.
        #[arg(long)]
        incremental: bool,
        /// Heap ceiling for the language worker, in MiB.
        #[arg(long, default_value_t = 1024)]
        worker_heap_mb: u32,
    },
    Report {
        analysis: String,
    },
    Nodes {
        analysis: String,
        #[arg(long, default_value = "all")]
        kind: String,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        cursor: Option<String>,
    },
    Edges {
        analysis: String,
        #[arg(long, default_value = "call_candidate")]
        kind: String,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        cursor: Option<String>,
    },
    Reach {
        analysis: String,
        entity: String,
        #[arg(long, default_value = "out")]
        direction: String,
        #[arg(long, default_value_t = 100)]
        max_nodes: usize,
        #[arg(long, default_value_t = 400)]
        max_edges: usize,
    },
    Source {
        analysis: String,
        entity: String,
    },
    Context {
        analysis: String,
        entity: String,
    },
    /// List symbols with published local flow facts.
    Flows {
        analysis: String,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        cursor: Option<String>,
    },
    /// CFG, block value states, def-use and unknowns for one function.
    Flow {
        analysis: String,
        entity: String,
    },
    /// Static execution sufficiency profile for one function (W08).
    Profile {
        analysis: String,
        entity: String,
    },
    /// Controlled execution of one pinned function call in an isolated copy of
    /// the immutable snapshot, under the target Node's permission model.
    Exec {
        analysis: String,
        /// Symbol id, `path:name`, or a bare function name.
        entity: String,
        /// JSON array of literal arguments.
        #[arg(long, default_value = "[]")]
        args: String,
        /// A scenario file: {"schema":"atlas.scenario.v1","cases":[...]}.
        #[arg(long)]
        scenario: Option<PathBuf>,
        /// Print the static plan and stop before any process is started.
        #[arg(long)]
        plan: bool,
        #[arg(long, default_value_t = 5000)]
        timeout_ms: u64,
        #[arg(long, default_value_t = 65536)]
        output_limit: usize,
        /// Comma-separated grants: fs_write, child_process, network,
        /// unknown_calls (accepts work beyond what was proved).
        #[arg(long, default_value = "")]
        allow_effects: String,
        #[arg(long, default_value = "node")]
        node: PathBuf,
        /// Repeatable explicit environment entry `KEY=VALUE`; nothing else is
        /// inherited except PATH.
        #[arg(long = "env")]
        env: Vec<String>,
        /// The receiver to call with, as JSON, when the function reads `this`.
        /// Atlas does not synthesise a receiver; it records the one declared.
        #[arg(long = "this")]
        this_arg: Option<String>,
        /// Repeatable `NAME=<json>` global the function is known to read. Set on
        /// the global object before the module is imported.
        #[arg(long = "global")]
        global: Vec<String>,
        /// Run a nested function by first calling the function that encloses it
        /// and taking the function it returns. The value must be the target's
        /// exact enclosing symbol; a returned function is only accepted when its
        /// source matches the target's pinned bytes.
        #[arg(long)]
        via: Option<String>,
        /// Arguments for the enclosing (`--via`) call, as a JSON array.
        #[arg(long = "via-args", default_value = "[]")]
        via_args: String,
        /// The receiver for the enclosing (`--via`) call, as JSON.
        #[arg(long = "via-this")]
        via_this: Option<String>,
        /// Ancestors of `--via`, outermost first, as a JSON array of
        /// `{"symbol": "...", "args": [...]}`. `--via` stays "the target's
        /// enclosing function"; these are the functions enclosing *it*.
        #[arg(long = "via-chain", default_value = "[]")]
        via_chain: String,
        /// What the isolated copy is made of: `snapshot` (every captured file,
        /// the default) or `dependencies` (the target's static import closure
        /// plus package.json files). A slice is a tighter read boundary and is
        /// recorded as such.
        #[arg(long, default_value = "snapshot")]
        materialise: String,
        /// Declare that this run used mocks/fixtures, so its result can never
        /// be read as an observation of the real project environment.
        #[arg(long)]
        fixtures: bool,
        #[arg(long)]
        fixture_note: Option<String>,
        /// List previously published execution records for this symbol.
        #[arg(long)]
        history: bool,
        /// List previously published scenario results for this symbol.
        #[arg(long)]
        scenario_history: bool,
    },
    Serve {
        analysis: String,
        #[arg(long, default_value_t = 0)]
        port: u16,
        /// Allow the local page to apply and revert patch proposals, but only
        /// inside this one directory. Absent means HTTP has no write path at
        /// all; a request cannot turn it on.
        #[arg(long, value_name = "DIR")]
        allow_writes: Option<PathBuf>,
    },
    /// Durable job identity: idempotent submit, lease, and crash recovery.
    Job {
        #[command(subcommand)]
        command: JobAction,
    },
    /// Relocate a selection pinned to another analysis onto this one.
    Relocate {
        /// The analysis the selection was pinned to.
        from: String,
        entity: String,
        /// The analysis to relocate into.
        #[arg(long)]
        to: String,
    },
    /// Pin a selection: an entity plus the analysis version it was chosen in.
    Select {
        analysis: String,
        entity: String,
    },
    /// Register an Intent against a selection. An annotation is never code.
    Annotate {
        analysis: String,
        entity: String,
        #[arg(long, default_value = "intent")]
        kind: String,
        #[arg(long)]
        body: String,
        #[arg(long, default_value = "human")]
        proposed_by: String,
    },
    /// List annotations for one entity, or for the whole analysis.
    Annotations {
        analysis: String,
        #[arg(long)]
        entity: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Bounded Agent Bridge: queued requests, leases, ACKs, and the bounded
    /// actions themselves.
    Agent {
        #[command(subcommand)]
        command: AgentAction,
    },
    /// AI Coding chain: propose a diff against pinned bytes, verify it in an
    /// isolated copy, then apply or revert it against a checkout.
    Patch {
        #[command(subcommand)]
        command: PatchAction,
    },
}

#[derive(Subcommand)]
enum PatchAction {
    /// Record a unified diff as a proposal. It is applied in memory against the
    /// pinned snapshot bytes before anything else happens.
    Propose {
        analysis: String,
        entity: String,
        #[arg(long)]
        diff: PathBuf,
        #[arg(long, default_value = "human")]
        proposed_by: String,
        #[arg(long)]
        summary: Option<String>,
    },
    /// Apply the proposal in an isolated copy, re-index it, diff the two graphs
    /// and optionally run a declared test command there.
    Verify {
        id: String,
        /// Queue the verification as a durable job instead of running it now.
        /// `atlas job work` performs it, with the same code path.
        #[arg(long)]
        enqueue: bool,
        /// Required with `--enqueue`: a queued request needs an owner.
        #[command(flatten)]
        identity: QueueIdentityArgs,
        #[arg(long, default_value_t = 0)]
        priority: i64,
        #[arg(long, default_value = "node")]
        node: PathBuf,
        #[arg(long, default_value = "workers/typescript/worker.mjs")]
        worker: PathBuf,
        #[arg(long, default_value_t = 60)]
        timeout_seconds: u64,
        #[arg(long, default_value_t = 300)]
        scan_deadline_seconds: u64,
        #[arg(long, default_value_t = 600)]
        index_deadline_seconds: u64,
        /// A JSON argv array, e.g. '["node","--test"]'. Never a shell string.
        #[arg(long)]
        test_argv: Option<String>,
        #[arg(long, default_value_t = 120000)]
        test_timeout_ms: u64,
        /// Heap ceiling for the language worker, in MiB.
        #[arg(long, default_value_t = 1024)]
        worker_heap_mb: u32,
    },
    /// Write the verified files into a checkout, refusing if its bytes moved.
    Apply {
        id: String,
        #[arg(long)]
        target: PathBuf,
    },
    /// Restore the pinned bytes, refusing if the target was modified since apply.
    Revert {
        id: String,
    },
    Status {
        id: String,
    },
    List {
        analysis: String,
        #[arg(long)]
        entity: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
}

#[derive(Subcommand)]
enum AgentAction {
    /// Enqueue a bounded request. The analysis is pinned into the request.
    Request {
        analysis: String,
        #[arg(long)]
        owner: String,
        #[arg(long)]
        key: String,
        #[arg(long, default_value = "inspect")]
        kind: String,
        #[arg(long)]
        entity: Option<String>,
        /// JSON payload for the action.
        #[arg(long)]
        payload: Option<String>,
    },
    /// Claim the oldest queued request and perform its bounded action.
    Work {
        #[arg(long)]
        once: bool,
        #[arg(long, default_value_t = 0)]
        max: usize,
        #[arg(long, default_value_t = 60)]
        lease_seconds: u64,
    },
    /// Claim without performing: the claim is the acknowledgement.
    Claim {
        #[arg(long, default_value_t = 60)]
        lease_seconds: u64,
    },
    /// Finish a claimed request. Only its lease holder may.
    Complete {
        id: String,
        #[arg(long)]
        holder: String,
        #[arg(long, default_value = "done")]
        state: String,
        #[arg(long)]
        result: Option<String>,
        #[arg(long)]
        reason: Option<String>,
    },
    Status {
        id: String,
    },
    List {
        #[arg(long)]
        state: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Return expired leases to the queue.
    Reap,
}

#[derive(Args)]
struct IdentityArgs {
    /// Who is asking. Part of the job identity, so it cannot be defaulted.
    #[arg(long)]
    owner: String,
    /// Defaults to the given root; part of the job identity.
    #[arg(long)]
    project: Option<String>,
    /// Idempotency key. A completed request with the same key never runs again.
    #[arg(long)]
    request_key: Option<String>,
}

/// Identity for a request that only needs one when it is queued. A foreground
/// command has no owner, and demanding one would be a flag that exists to be
/// ignored.
#[derive(Args)]
struct QueueIdentityArgs {
    #[arg(long)]
    owner: Option<String>,
    #[arg(long)]
    request_key: Option<String>,
}

#[derive(Args)]
struct RunnerArgs {
    #[arg(long, default_value = "node")]
    node: PathBuf,
    #[arg(long, default_value = "workers/typescript/worker.mjs")]
    worker: PathBuf,
    #[arg(long, default_value_t = 60)]
    timeout_seconds: u64,
    #[arg(long, default_value_t = 300)]
    scan_deadline_seconds: u64,
    #[arg(long, default_value_t = 600)]
    index_deadline_seconds: u64,
    /// Reuse an already-published analysis when the bytes and the versions are
    /// unchanged, and report what a partial change would invalidate.
    #[arg(long)]
    incremental: bool,
    /// Heap ceiling for the language worker, in MiB. The worker holds the whole
    /// program, so this has to scale with the project.
    #[arg(long, default_value_t = 1024)]
    worker_heap_mb: u32,
}

#[derive(Subcommand)]
enum JobAction {
    /// Claim and run one index request under a persistent job identity.
    Submit {
        root: PathBuf,
        #[command(flatten)]
        identity: IdentityArgs,
        #[command(flatten)]
        runner: RunnerArgs,
        #[arg(long, default_value_t = 60)]
        lease_seconds: u64,
    },
    /// Queue a request without running it, for a worker to pick up.
    Enqueue {
        root: PathBuf,
        #[command(flatten)]
        identity: IdentityArgs,
        #[command(flatten)]
        runner: RunnerArgs,
        /// Higher runs first; equal priority is served oldest first.
        #[arg(long, default_value_t = 0)]
        priority: i64,
    },
    /// Run queued jobs until the queue is empty.
    Work {
        /// Claim and run at most one job, then stop.
        #[arg(long)]
        once: bool,
        /// How many jobs this process runs at once. Each slot claims under its
        /// own holder id, so two slots can never share a lease. Bounded on
        /// purpose: there is no unbounded fan-out.
        #[arg(long, default_value_t = 1)]
        parallel: usize,
        #[arg(long, default_value_t = 60)]
        lease_seconds: u64,
        /// Stop after this many jobs; 0 means "until the queue is empty".
        #[arg(long, default_value_t = 0)]
        max: usize,
    },
    /// Cancel a job that has not started. A running job belongs to its lease.
    Cancel {
        id: String,
        #[arg(long)]
        reason: Option<String>,
    },
    Status {
        id: String,
    },
    List {
        #[arg(long)]
        state: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
    /// Reap runs whose lease stopped being renewed; this is crash recovery.
    Reap,
}

fn print(value: impl serde::Serialize) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

struct IndexOptions {
    node: PathBuf,
    worker: PathBuf,
    timeout: Duration,
    scan_deadline: Duration,
    index_deadline: Duration,
    incremental: bool,
    /// Heap ceiling for the language worker. Configurable because the worker
    /// holds the whole program, so its footprint scales with the project; a
    /// fixed cap turns a large project into an unexplained failure.
    worker_heap_mb: u32,
}

impl IndexOptions {
    fn from_args(runner: RunnerArgs) -> Result<Self, Box<dyn std::error::Error>> {
        Self::new(
            runner.node,
            runner.worker,
            runner.timeout_seconds,
            runner.scan_deadline_seconds,
            runner.index_deadline_seconds,
            runner.incremental,
            runner.worker_heap_mb,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        node: PathBuf,
        worker: PathBuf,
        timeout_seconds: u64,
        scan_deadline_seconds: u64,
        index_deadline_seconds: u64,
        incremental: bool,
        worker_heap_mb: u32,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if timeout_seconds == 0 || timeout_seconds > 600 {
            return Err("timeout must be 1..600 seconds".into());
        }
        if scan_deadline_seconds == 0 || scan_deadline_seconds > 3600 {
            return Err("scan deadline must be 1..3600 seconds".into());
        }
        if index_deadline_seconds == 0 || index_deadline_seconds > 3600 {
            return Err("index deadline must be 1..3600 seconds".into());
        }
        if !(128..=8192).contains(&worker_heap_mb) {
            return Err("worker heap must be 128..8192 MiB".into());
        }
        Ok(Self {
            node,
            worker,
            timeout: Duration::from_secs(timeout_seconds),
            scan_deadline: Duration::from_secs(scan_deadline_seconds),
            index_deadline: Duration::from_secs(index_deadline_seconds),
            incremental,
            worker_heap_mb,
        })
    }

    /// Identity of the work itself, used when a caller supplies no request key.
    /// Two identical invocations must address the same request.
    fn fingerprint(&self, root: &Path) -> String {
        atlas_engine::digest(
            format!(
                "atlas.index-request.v1|{}|{}|{:?}|{:?}|{:?}|{}",
                root.display(),
                self.node.display(),
                self.timeout,
                self.scan_deadline,
                self.index_deadline,
                self.worker_heap_mb
            )
            .as_bytes(),
        )
    }

    /// The runner's parameters as stored on the job row, so a queued request
    /// describes how to execute itself instead of depending on whichever worker
    /// happens to pick it up.
    fn stored(&self) -> Result<String, Box<dyn std::error::Error>> {
        Ok(serde_json::to_string(&StoredOptions {
            node: self.node.display().to_string(),
            worker: self.worker.display().to_string(),
            timeout_seconds: self.timeout.as_secs(),
            scan_deadline_seconds: self.scan_deadline.as_secs(),
            index_deadline_seconds: self.index_deadline.as_secs(),
            incremental: self.incremental,
            worker_heap_mb: self.worker_heap_mb,
        })?)
    }

    fn from_job(job: &job::Job) -> Result<Self, Box<dyn std::error::Error>> {
        let stored: StoredOptions =
            serde_json::from_str(job.options.as_deref().ok_or("job_has_no_stored_options")?)?;
        Self::new(
            PathBuf::from(stored.node),
            PathBuf::from(stored.worker),
            stored.timeout_seconds,
            stored.scan_deadline_seconds,
            stored.index_deadline_seconds,
            stored.incremental,
            stored.worker_heap_mb,
        )
    }
}

/// A queued patch verification describes itself, exactly like a queued index
/// request: the worker reads how to run it from the row rather than from its own
/// defaults.
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredVerify {
    proposal_id: String,
    node: String,
    worker: String,
    timeout_seconds: u64,
    scan_deadline_seconds: u64,
    index_deadline_seconds: u64,
    #[serde(default)]
    test_argv: Option<Vec<String>>,
    test_timeout_ms: u64,
    /// Defaulted so a row enqueued before this option existed still runs.
    #[serde(default = "default_worker_heap_mb")]
    worker_heap_mb: u32,
}

impl StoredVerify {
    /// Refuse a stored row that cannot describe how to run, rather than
    /// substituting this worker's own parameters for someone else's request.
    fn options(&self) -> Result<patchwork::VerifyOptions, Box<dyn std::error::Error>> {
        if self.timeout_seconds == 0
            || self.timeout_seconds > 600
            || self.scan_deadline_seconds == 0
            || self.scan_deadline_seconds > 3600
            || self.index_deadline_seconds == 0
            || self.index_deadline_seconds > 3600
            || !(128..=8192).contains(&self.worker_heap_mb)
        {
            return Err("stored_verify_deadlines_out_of_range".into());
        }
        Ok(patchwork::VerifyOptions {
            node: PathBuf::from(&self.node),
            worker: PathBuf::from(&self.worker),
            timeout: Duration::from_secs(self.timeout_seconds),
            scan_deadline: Duration::from_secs(self.scan_deadline_seconds),
            index_deadline: Duration::from_secs(self.index_deadline_seconds),
            test_argv: self.test_argv.clone(),
            test_timeout: Duration::from_millis(self.test_timeout_ms.max(1)),
            worker_heap_mb: self.worker_heap_mb,
        })
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredOptions {
    node: String,
    worker: String,
    timeout_seconds: u64,
    scan_deadline_seconds: u64,
    index_deadline_seconds: u64,
    /// Defaulted so a job enqueued before this option existed still runs.
    #[serde(default)]
    incremental: bool,
    /// Defaulted for the same reason; 1024 is the current default ceiling.
    #[serde(default = "default_worker_heap_mb")]
    worker_heap_mb: u32,
}

fn default_worker_heap_mb() -> u32 {
    1024
}

/// A lease holder identity: unique per process run, so two runs of the same
/// binary can never be mistaken for one holder.
fn new_holder() -> String {
    format!("{}-{}", std::process::id(), uuid::Uuid::new_v4())
}

/// Repeatable `NAME=<json>` globals a controlled run declares. Each value is
/// real JSON, so a caller cannot smuggle an expression in as a string.
fn parse_globals(
    entries: &[String],
) -> Result<std::collections::BTreeMap<String, serde_json::Value>, Box<dyn std::error::Error>> {
    let mut globals = std::collections::BTreeMap::new();
    for entry in entries {
        let (name, value) = entry
            .split_once('=')
            .ok_or_else(|| format!("global must be NAME=<json>: {entry}"))?;
        if name.is_empty() {
            return Err(format!("invalid global name in {entry}").into());
        }
        globals.insert(name.to_string(), serde_json::from_str(value)?);
    }
    Ok(globals)
}

/// Explicit `KEY=VALUE` environment for a controlled run. Nothing is inherited
/// except PATH, so a variable the caller did not name cannot reach the child.
fn parse_env(
    entries: &[String],
) -> Result<std::collections::BTreeMap<String, String>, Box<dyn std::error::Error>> {
    let mut env = std::collections::BTreeMap::new();
    for entry in entries {
        let (key, value) = entry
            .split_once('=')
            .ok_or_else(|| format!("environment entry must be KEY=VALUE: {entry}"))?;
        if key.is_empty() || key.contains('\0') || key.contains('=') {
            return Err(format!("invalid environment key: {key}").into());
        }
        env.insert(key.to_string(), value.to_string());
    }
    Ok(env)
}

struct PipelineResult {
    analysis_id: String,
    metadata: serde_json::Value,
    /// Present only under `--incremental`: what was reused, what changed, and
    /// what it cost. Absent means the caller asked for a plain full run.
    incremental: Option<serde_json::Value>,
}

/// The index pipeline: scan -> worker -> analyze -> atomic publish.
async fn run_pipeline(
    store: &Store,
    root: &Path,
    options: &IndexOptions,
    control: &ExecutionControl,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<PipelineResult, Box<dyn std::error::Error>> {
    let started = std::time::Instant::now();
    let scan_store = store.clone();
    let scan_control = control.clone();
    let scan_deadline = options.scan_deadline;
    let root = root.to_path_buf();
    // Filesystem and Rust work must not occupy the async runtime that receives
    // signals. The same control remains live through commit.
    let (snapshot, request) = tokio::task::spawn_blocking(move || {
        let snapshot = scan::scan_controlled(
            &root,
            &scan_store,
            ScanLimits::default(),
            Some(scan_deadline),
            &scan_control,
        )?;
        let request = ParseRequest {
            schema: "atlas.parse-request.v1".into(),
            snapshot_id: snapshot.id.clone(),
            files: scan_store.sources_controlled(&snapshot, &scan_control)?,
        };
        Ok::<_, atlas_engine::Error>((snapshot, request))
    })
    .await??;
    let scan_seconds = started.elapsed();
    control.checkpoint()?;

    let remaining = options.index_deadline.saturating_sub(scan_seconds);
    let worker_started = std::time::Instant::now();
    let facts = worker::parse(
        &options.node,
        &options.worker,
        &request,
        options.timeout.min(remaining),
        32 * 1024 * 1024,
        options.worker_heap_mb,
        cancel_rx,
    )
    .await?;
    let worker_seconds = worker_started.elapsed();
    control.checkpoint()?;

    // The run key folds the version bundle together with the snapshot id, and
    // the snapshot id is itself a digest of every catalog entry with its blob.
    // Same key therefore means the same bytes derived by the same versions.
    let bundle = incremental::bundle(&facts.producer);
    let run_key = incremental::run_key(&bundle, &snapshot.id);

    if options.incremental
        && let Some(previous) = store.incremental_run(&run_key)?
        && let Ok(metadata) = store.metadata(&previous.analysis_id)
    {
        let report = json!({
            "outcome": "reused",
            "run_key": run_key,
            "snapshot_id": snapshot.id,
            "analysis_id": previous.analysis_id,
            "seconds": {
                "scan": scan_seconds.as_secs_f64(),
                "worker": worker_seconds.as_secs_f64(),
                "derivation": 0.0,
                "total": started.elapsed().as_secs_f64(),
            },
            "note": "相同的字节与相同的版本已经派生过；直接返回已发布的分析，未重新派生任何事实。",
        });
        return Ok(PipelineResult {
            analysis_id: previous.analysis_id,
            metadata,
            incremental: Some(report),
        });
    }

    // Everything the incremental report needs must be read before `facts` and
    // `snapshot` move into the derivation task.
    let content_hashes = incremental::source_hashes(&request.files);
    let parsed_files: BTreeSet<String> = facts.parsed_files.iter().cloned().collect();
    let graph = incremental::import_graph(&facts, &parsed_files);
    let components = incremental::components(&graph);
    let file_keys = incremental::file_keys(&graph, &components, &content_hashes, &bundle);

    let analysis_store = store.clone();
    let analysis_control = control.clone();
    let derivation_started = std::time::Instant::now();
    let analysis = tokio::task::spawn_blocking(move || {
        analyze::analyze_controlled(&analysis_store, &snapshot, facts, &analysis_control)
    })
    .await??;
    let derivation_seconds = derivation_started.elapsed();

    let mut report = None;
    if options.incremental {
        let previous = store.latest_incremental_run()?;
        let (changes, withdrawn, reusable) = match previous.as_ref() {
            Some(previous) => (
                incremental::verdicts(
                    &previous.file_keys,
                    &file_keys,
                    &previous.file_hashes,
                    &content_hashes,
                    &graph,
                ),
                incremental::withdrawn(&previous.source_files, &parsed_files),
                file_keys
                    .iter()
                    .filter(|(path, key)| previous.file_keys.get(*path) == Some(*key))
                    .count(),
            ),
            None => (Vec::new(), Vec::new(), 0),
        };
        let own_content = changes
            .iter()
            .filter(|change| change.change == incremental::Change::OwnContent)
            .count();
        let by_dependency = changes
            .iter()
            .filter(|change| change.change == incremental::Change::Dependency)
            .count();
        let new_files = changes
            .iter()
            .filter(|change| change.change == incremental::Change::New)
            .count();
        store.record_incremental_run(&incremental::IncrementalRun {
            run_key: run_key.clone(),
            bundle: bundle.clone(),
            snapshot_id: analysis.snapshot_id.clone(),
            analysis_id: analysis.id.clone(),
            file_keys,
            file_hashes: content_hashes,
            source_files: parsed_files.clone(),
            created_at: job::now_ms(),
        })?;
        report = Some(json!({
            "outcome": "derived",
            "run_key": run_key,
            "snapshot_id": analysis.snapshot_id,
            "files": {
                "parsed": parsed_files.len(),
                "reusable": reusable,
                "own_content": own_content,
                "by_dependency": by_dependency,
                "new": new_files,
            },
            "withdrawn": withdrawn,
            "changes": changes,
            "seconds": {
                "scan": scan_seconds.as_secs_f64(),
                "worker": worker_seconds.as_secs_f64(),
                "derivation": derivation_seconds.as_secs_f64(),
                "total": started.elapsed().as_secs_f64(),
            },
            "note": "派生流程控制流与抽象解释是全程序 SCC 不动点，因此一次局部改动仍会重新派生全部函数；reusable 表示下一次若实现增量不动点后可跳过的函数所在文件数。",
        }));
    }

    let metadata = store.metadata(&analysis.id)?;
    Ok(PipelineResult {
        analysis_id: analysis.id,
        metadata,
        incremental: report,
    })
}

/// Renew the lease while the run is alive. A lease that stops being renewed is
/// how a crashed owner is detected; losing it cancels the run, because a result
/// published under an identity we no longer hold would be someone else's.
fn spawn_heartbeat(
    store: Store,
    id: String,
    holder: String,
    lease_ms: i64,
    control: ExecutionControl,
    stop: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let interval = Duration::from_millis(((lease_ms / 3).max(500)) as u64);
        // Wake often and count, instead of sleeping the whole interval: the
        // main thread joins this handle once the run ends, so a single long
        // sleep made a job that finished in under a second still take lease/3
        // seconds to report back.
        let tick = Duration::from_millis(100);
        let mut waited = Duration::ZERO;
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(tick);
            waited += tick;
            if waited < interval {
                continue;
            }
            waited = Duration::ZERO;
            match store.heartbeat_job(&id, &holder, lease_ms) {
                Ok(true) => {}
                // The lease is no longer ours. Stop the run rather than let it
                // publish under an identity it does not hold; `finish_job`
                // would reject the result anyway.
                _ => {
                    control.cancel();
                    break;
                }
            }
        }
    })
}

/// What a claimed row describes how to run.
enum Claimed {
    Index(IndexOptions),
    PatchVerify(StoredVerify),
}

/// Read a claimed row's own instructions. Dispatch is by kind, so the queue
/// carries more than one operation without either kind knowing about the other.
fn claimed_kind(row: &job::Job) -> Result<Claimed, Box<dyn std::error::Error>> {
    match row.kind.as_str() {
        job::KIND_INDEX => Ok(Claimed::Index(IndexOptions::from_job(row)?)),
        job::KIND_PATCH_VERIFY => {
            let stored: StoredVerify =
                serde_json::from_str(row.options.as_deref().ok_or("job_has_no_stored_options")?)?;
            stored.options()?;
            Ok(Claimed::PatchVerify(stored))
        }
        other => Err(format!("job_kind_unknown:{other}").into()),
    }
}

/// Run one claimed job to a terminal state, renewing its lease while it works.
///
/// Returns the outcome object and whether the job itself succeeded. The outer
/// error is reserved for failures of the job store, which are a different kind
/// of problem from the job failing.
/// How many jobs one process may run at once. A bound, not a measurement.
const MAX_JOB_PARALLELISM: usize = 4;

/// Run up to `parallel` jobs at once, until the queue is empty or `max` jobs
/// have been attempted.
///
/// Every slot claims under its **own** holder id: a lease identifies a single
/// runner, so two slots sharing one would make "who is running this" false and
/// would let one slot's heartbeat keep the other's lease alive. The store's
/// writer is serialised (see `Store`), so the slots contend for the database
/// rather than corrupt it.
async fn work_in_parallel(
    store: &Store,
    lease_ms: i64,
    max: usize,
    parallel: usize,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let outcomes: Arc<tokio::sync::Mutex<Vec<serde_json::Value>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let claimed_total = Arc::new(AtomicUsize::new(0));
    let holders: Arc<tokio::sync::Mutex<Vec<String>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let mut slots = Vec::new();
    for slot in 0..parallel {
        let store = store.clone();
        let outcomes = outcomes.clone();
        let claimed_total = claimed_total.clone();
        let holders = holders.clone();
        slots.push(tokio::spawn(async move {
            loop {
                // The cap is checked and taken in one step, so two slots cannot
                // both observe room for the last allowed job.
                if max > 0 && claimed_total.fetch_add(1, Ordering::SeqCst) >= max {
                    claimed_total.fetch_sub(1, Ordering::SeqCst);
                    break;
                }
                let holder = format!("{}-slot{slot}", new_holder());
                let row = match store.claim_next(&holder, lease_ms) {
                    Ok(Some(row)) => row,
                    Ok(None) => {
                        if max > 0 {
                            claimed_total.fetch_sub(1, Ordering::SeqCst);
                        }
                        break;
                    }
                    Err(error) => {
                        // `error` is not Send, so it must not be held across the
                        // await below; the message is what the record needs.
                        let message = error.to_string();
                        outcomes.lock().await.push(serde_json::json!({
                            "outcome": "failed", "error": message, "slot": slot,
                        }));
                        break;
                    }
                };
                holders.lock().await.push(holder.clone());
                // The stored-spec error is not `Send`; converting it here keeps
                // it out of the awaited part of the slot's future.
                let claimed = match claimed_kind(&row).map_err(|error| error.to_string()) {
                    Ok(claimed) => claimed,
                    Err(message) => {
                        let recorded = store.finish_job(
                            &row.id,
                            &holder,
                            STATE_FAILED,
                            Some("job_options_unusable"),
                            None,
                        )?;
                        outcomes.lock().await.push(serde_json::json!({
                            "outcome": "failed", "recorded": recorded,
                            "job": store.job(&row.id)?, "error": message, "slot": slot,
                        }));
                        continue;
                    }
                };
                let outcome = match run_claimed_job(&store, &row, &claimed, lease_ms, &holder).await
                {
                    Ok((outcome, _succeeded)) => outcome,
                    Err(error) => {
                        let message = error.to_string();
                        serde_json::json!({
                            "outcome": "failed",
                            "job": store.job(&row.id)?,
                            "error": message,
                            "slot": slot,
                        })
                    }
                };
                outcomes.lock().await.push(outcome);
            }
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        }));
    }
    for slot in slots {
        // A slot that died takes its job down with it; the lease expires and
        // `job reap` returns it to the queue, so the failure is reported rather
        // than hidden.
        if let Err(error) = slot.await {
            outcomes.lock().await.push(serde_json::json!({
                "outcome": "failed", "error": format!("job_slot_task_failed:{error}"),
            }));
        }
    }
    let outcomes = outcomes.lock().await.clone();
    Ok(serde_json::json!({
        "ran": outcomes.len(),
        "parallelism": parallel,
        // The distinct holders are the evidence that the slots really claimed
        // separately, rather than one slot doing everything.
        "holders": holders.lock().await.clone(),
        "max_parallelism": MAX_JOB_PARALLELISM,
        "outcomes": outcomes,
    }))
}

async fn run_claimed_job(
    store: &Store,
    job: &job::Job,
    claimed: &Claimed,
    lease_ms: i64,
    holder: &str,
) -> Result<(serde_json::Value, bool), Box<dyn std::error::Error>> {
    let deadline = match claimed {
        Claimed::Index(options) => options.index_deadline,
        Claimed::PatchVerify(stored) => Duration::from_secs(stored.index_deadline_seconds),
    };
    let control = ExecutionControl::new(Some(std::time::Instant::now() + deadline));
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let _signal_watcher = signal_watcher(control.clone(), cancel_tx)?;
    let stop = Arc::new(AtomicBool::new(false));
    let heartbeat = spawn_heartbeat(
        store.clone(),
        job.id.clone(),
        holder.to_string(),
        lease_ms,
        control.clone(),
        stop.clone(),
    );
    let outcome: Result<serde_json::Value, Box<dyn std::error::Error>> = match claimed {
        Claimed::Index(options) => {
            let root = PathBuf::from(&job.root);
            match run_pipeline(store, &root, options, &control, cancel_rx).await {
                Ok(result) => Ok(json!({
                    "kind": job::KIND_INDEX,
                    "analysis_id": result.analysis_id,
                    "metadata": result.metadata,
                    "incremental": result.incremental,
                })),
                Err(error) => Err(error),
            }
        }
        Claimed::PatchVerify(stored) => {
            let options = stored.options()?;
            patchwork::verify_proposal(store, &stored.proposal_id, &options)
                .await
                .map(|proposal| {
                    json!({
                        "kind": job::KIND_PATCH_VERIFY,
                        "proposal_id": stored.proposal_id,
                        "proposal": proposal,
                    })
                })
                .map_err(|error| error.into())
        }
    };
    stop.store(true, Ordering::Relaxed);
    let _ = heartbeat.join();
    match outcome {
        Ok(value) => {
            // The terminal artifact differs by kind: an index publishes an
            // analysis, a verification publishes the patched analysis it
            // derived. Both are recorded in the same column because both answer
            // "what did this request produce".
            let artifact = match job.kind.as_str() {
                job::KIND_PATCH_VERIFY => value["proposal"]["verification"]["patched_analysis_id"]
                    .as_str()
                    .map(str::to_string),
                _ => value["analysis_id"].as_str().map(str::to_string),
            };
            let recorded =
                store.finish_job(&job.id, holder, STATE_COMPLETED, None, artifact.as_deref())?;
            let mut payload = json!({
                "outcome": "completed",
                "recorded": recorded,
                "kind": job.kind,
                "job": store.job(&job.id)?,
            });
            if let (Some(object), Some(source)) = (payload.as_object_mut(), value.as_object()) {
                for (key, item) in source {
                    object.insert(key.clone(), item.clone());
                }
            }
            Ok((payload, true))
        }
        Err(error) => {
            let recorded = store.finish_job(
                &job.id,
                holder,
                STATE_FAILED,
                Some(&error.to_string()),
                None,
            )?;
            Ok((
                json!({
                    "outcome": "failed",
                    "recorded": recorded,
                    "kind": job.kind,
                    "job": store.job(&job.id)?,
                    "error": error.to_string(),
                }),
                false,
            ))
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let store = Store::open(cli.store)?;
    match cli.command {
        Action::Index {
            root,
            node,
            worker,
            timeout_seconds,
            scan_deadline_seconds,
            index_deadline_seconds,
            incremental: want_incremental,
            worker_heap_mb,
        } => {
            let options = IndexOptions::new(
                node,
                worker,
                timeout_seconds,
                scan_deadline_seconds,
                index_deadline_seconds,
                want_incremental,
                worker_heap_mb,
            )?;
            let control =
                ExecutionControl::new(Some(std::time::Instant::now() + options.index_deadline));
            let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
            let _signal_watcher = signal_watcher(control.clone(), cancel_tx)?;
            let result = run_pipeline(&store, &root, &options, &control, cancel_rx).await?;
            let mut metadata = result.metadata;
            if let Some(report) = result.incremental
                && let Some(object) = metadata.as_object_mut()
            {
                object.insert("incremental".into(), report);
            }
            print(metadata)?;
        }
        Action::Report { analysis } => print(store.metadata(&analysis)?)?,
        Action::Nodes {
            analysis,
            kind,
            limit,
            cursor,
        } => print(store.nodes(&analysis, &kind, limit, cursor.as_deref())?)?,
        Action::Edges {
            analysis,
            kind,
            limit,
            cursor,
        } => print(store.edges(&analysis, &kind, limit, cursor.as_deref())?)?,
        Action::Reach {
            analysis,
            entity,
            direction,
            max_nodes,
            max_edges,
        } => print(store.reachable(&analysis, &entity, &direction, max_nodes, max_edges)?)?,
        Action::Source { analysis, entity } => print(store.source(&analysis, &entity, 16000)?)?,
        Action::Context { analysis, entity } => print(store.context(&analysis, &entity)?)?,
        Action::Flows {
            analysis,
            limit,
            cursor,
        } => print(store.flow_symbols(&analysis, limit, cursor.as_deref())?)?,
        Action::Flow { analysis, entity } => print(store.flow_fact(&analysis, &entity)?)?,
        Action::Profile { analysis, entity } => {
            let symbol = runner::resolve_symbol(&store, &analysis, &entity)?;
            print(runner::profile_for(&store, &analysis, &symbol)?)?
        }
        Action::Exec {
            analysis,
            entity,
            args,
            scenario,
            plan,
            timeout_ms,
            output_limit,
            allow_effects,
            node,
            env,
            this_arg,
            global,
            via,
            via_args,
            via_this,
            via_chain,
            materialise,
            fixtures,
            fixture_note,
            history,
            scenario_history,
        } => {
            let symbol = runner::resolve_symbol(&store, &analysis, &entity)?;
            if scenario_history {
                print(json!({
                    "analysis_id": analysis,
                    "symbol": symbol,
                    "scenarios": store.scenario_results(&analysis, Some(&symbol), 20)?,
                }))?;
                return Ok(());
            }
            if history {
                print(json!({
                    "analysis_id": analysis,
                    "symbol": symbol,
                    "records": store.exec_records(&analysis, &symbol, 20)?,
                }))?;
                return Ok(());
            }
            let names: Vec<String> = allow_effects
                .split(',')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect();
            let spec = RunSpec {
                schema: atlas_engine::exec::RUN_SPEC_SCHEMA.into(),
                analysis_id: analysis.clone(),
                symbol: symbol.clone(),
                args: serde_json::from_str(&args)?,
                timeout_ms,
                output_limit,
                grants: Grants::parse(&names)?,
                node: node.display().to_string(),
                env: parse_env(&env)?,
                this_arg: match this_arg {
                    Some(text) => Some(serde_json::from_str(&text)?),
                    None => None,
                },
                globals: parse_globals(&global)?,
                fixtures,
                fixture_note,
                label: None,
                materialise: Some(materialise),
                // Resolved like `--via`: each ancestor is a real published
                // symbol, and the engine checks that the chain is connected.
                via_chain: serde_json::from_str::<Vec<atlas_engine::exec::ViaSpec>>(&via_chain)?
                    .into_iter()
                    .map(|stage| {
                        Ok(atlas_engine::exec::ViaSpec {
                            symbol: runner::resolve_symbol(&store, &analysis, &stage.symbol)?,
                            args: stage.args,
                            this_arg: stage.this_arg,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?,
                via: match via {
                    // Resolved like the target: `--via` names a real published
                    // symbol, and `decide` then compares it against the
                    // target's actual enclosing symbol.
                    Some(reference) => Some(atlas_engine::exec::ViaSpec {
                        symbol: runner::resolve_symbol(&store, &analysis, &reference)?,
                        args: serde_json::from_str(&via_args)?,
                        this_arg: match via_this {
                            Some(text) => Some(serde_json::from_str(&text)?),
                            None => None,
                        },
                    }),
                    None => None,
                },
            };
            if plan {
                print(runner::plan(&store, &spec)?)?;
                return Ok(());
            }
            // Ctrl-C must reach the child process group, not just this process.
            let control = ExecutionControl::new(None);
            let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
            let _signal_watcher = signal_watcher(control, cancel_tx)?;
            match scenario {
                Some(path) => {
                    let text = std::fs::read_to_string(&path)?;
                    let document: serde_json::Value = serde_json::from_str(&text)?;
                    let mut result =
                        runner::run_scenario(&store, &spec, &document, cancel_rx).await?;
                    // A scenario is evidence, so it is published rather than
                    // only printed: a consumer should not have to capture a
                    // stream to ask what a scenario did.
                    let id = store.publish_scenario_result(&mut result)?;
                    if let Some(object) = result.as_object_mut() {
                        object.insert("id".into(), json!(id));
                    }
                    print(result)?
                }
                None => print(runner::execute(&store, &spec, cancel_rx).await?)?,
            }
        }
        Action::Job { command } => match command {
            JobAction::Status { id } => print(store.job(&id)?)?,
            JobAction::List { state, limit } => print(store.jobs(state.as_deref(), limit)?)?,
            JobAction::Reap => {
                let reaped = store.reap_expired_jobs(job::now_ms())?;
                print(json!({"reaped": reaped, "count": reaped.len()}))?;
            }
            JobAction::Cancel { id, reason } => {
                let cancelled = store.cancel_queued(&id, reason.as_deref())?;
                print(json!({"cancelled": cancelled, "job": store.job(&id)?}))?;
                if !cancelled {
                    return Err(
                        "only a queued job can be cancelled; a running job belongs to its lease"
                            .into(),
                    );
                }
            }
            JobAction::Enqueue {
                root,
                identity,
                runner,
                priority,
            } => {
                let options = IndexOptions::from_args(runner)?;
                let root_display = root.display().to_string();
                let project = identity.project.unwrap_or_else(|| root_display.clone());
                let request_key = identity
                    .request_key
                    .unwrap_or_else(|| options.fingerprint(&root));
                let stored = options.stored()?;
                let request = job::JobRequest {
                    kind: job::KIND_INDEX,
                    owner: &identity.owner,
                    project: &project,
                    request_key: &request_key,
                    root: &root_display,
                    options: &stored,
                };
                let (row, created) = store.enqueue_job(&request, priority)?;
                // "already_queued" for a request that finished long ago would
                // make a completed verification look like it is still waiting.
                print(json!({
                    "outcome": if created { "queued".to_string() } else { format!("already_{}", row.state) },
                    "job": row}))?;
            }
            JobAction::Work {
                once,
                lease_seconds,
                max,
                parallel,
            } => {
                if !(5..=3600).contains(&lease_seconds) {
                    return Err("lease must be 5..3600 seconds".into());
                }
                if !(1..=MAX_JOB_PARALLELISM).contains(&parallel) {
                    return Err(
                        format!("job_parallelism_out_of_range:1..={MAX_JOB_PARALLELISM}").into(),
                    );
                }
                if once && parallel > 1 {
                    // "one job, then stop" and "N at once" are different
                    // requests; running them together would silently pick one.
                    return Err("job_once_with_parallelism".into());
                }
                let lease_ms = (lease_seconds as i64) * 1000;
                if parallel > 1 {
                    print(work_in_parallel(&store, lease_ms, max, parallel).await?)?;
                    return Ok(());
                }
                let mut outcomes = Vec::new();
                loop {
                    if max > 0 && outcomes.len() >= max {
                        break;
                    }
                    let holder = new_holder();
                    let Some(row) = store.claim_next(&holder, lease_ms)? else {
                        break;
                    };
                    let claimed = match claimed_kind(&row) {
                        Ok(claimed) => claimed,
                        Err(error) => {
                            // A row that cannot describe how to run itself is
                            // failed, not guessed at: executing it with this
                            // worker's defaults would attribute someone else's
                            // request to different parameters.
                            let recorded = store.finish_job(
                                &row.id,
                                &holder,
                                STATE_FAILED,
                                Some("job_options_unusable"),
                                None,
                            )?;
                            outcomes.push(json!({
                                "outcome":"failed",
                                "recorded":recorded,
                                "job":store.job(&row.id)?,
                                "error":error.to_string()}));
                            if once {
                                break;
                            }
                            continue;
                        }
                    };
                    let (outcome, _succeeded) =
                        run_claimed_job(&store, &row, &claimed, lease_ms, &holder).await?;
                    outcomes.push(outcome);
                    if once {
                        break;
                    }
                }
                let ran = outcomes.len();
                print(json!({"ran": ran, "outcomes": outcomes}))?;
            }
            JobAction::Submit {
                root,
                identity,
                runner,
                lease_seconds,
            } => {
                if !(5..=3600).contains(&lease_seconds) {
                    return Err("lease must be 5..3600 seconds".into());
                }
                let options = IndexOptions::from_args(runner)?;
                let lease_ms = (lease_seconds as i64) * 1000;
                let root_display = root.display().to_string();
                let project = identity.project.unwrap_or_else(|| root_display.clone());
                let request_key = identity
                    .request_key
                    .unwrap_or_else(|| options.fingerprint(&root));
                // Recover before claiming: a run abandoned by a crashed process
                // must not be able to block the retry of its own request.
                let reaped = store.reap_expired_jobs(job::now_ms())?;
                let holder = new_holder();
                let stored = options.stored()?;
                let request = job::JobRequest {
                    kind: job::KIND_INDEX,
                    owner: &identity.owner,
                    project: &project,
                    request_key: &request_key,
                    root: &root_display,
                    options: &stored,
                };
                match store.submit_job(&request, &holder, lease_ms)? {
                    Lease::Settled(row) => {
                        print(json!({"outcome":"already_completed","job":row,"reaped":reaped}))?
                    }
                    Lease::Held(row) => {
                        print(json!({"outcome":"held_by_another_run","job":row,"reaped":reaped}))?
                    }
                    Lease::Acquired(row) => {
                        let claimed = claimed_kind(&row)?;
                        let (mut outcome, succeeded) =
                            run_claimed_job(&store, &row, &claimed, lease_ms, &holder).await?;
                        let message = outcome["error"]
                            .as_str()
                            .unwrap_or("job failed")
                            .to_string();
                        if let Some(object) = outcome.as_object_mut() {
                            object.insert("reaped".into(), json!(reaped));
                        }
                        print(outcome)?;
                        if !succeeded {
                            return Err(message.into());
                        }
                    }
                }
            }
        },
        Action::Relocate { from, entity, to } => {
            let entity = runner::resolve_entity(&store, &from, &entity)?;
            let relocation = atlas_engine::relocate::relocate(&store, &from, &entity, &to)?;
            let selection = relocation
                .matched_entity_id
                .as_ref()
                .map(|matched| bridge::selection(&to, matched, "entity"));
            print(json!({
                "relocation": atlas_engine::relocate::summary(&relocation),
                "detail": relocation,
                "selection": selection,
                "note": "重定位只给出建议与依据，不改变任何已存记录；是否采用由调用方决定。",
            }))?
        }
        Action::Select { analysis, entity } => {
            // A selection must name something that exists. Returning a pin for
            // an invented id would make "no such object" indistinguishable from
            // a real selection.
            let entity = runner::resolve_entity(&store, &analysis, &entity)?;
            print(bridge::selection(&analysis, &entity, "entity"))?
        }
        Action::Annotate {
            analysis,
            entity,
            kind,
            body,
            proposed_by,
        } => {
            let entity = runner::resolve_entity(&store, &analysis, &entity)?;
            let selection = bridge::selection(&analysis, &entity, "entity");
            let (annotation, created) =
                store.create_annotation(&selection, &kind, &body, &proposed_by)?;
            print(
                json!({"outcome": if created {"created"} else {"already_proposed"}, "annotation": annotation}),
            )?
        }
        Action::Annotations {
            analysis,
            entity,
            limit,
        } => {
            let entity = match entity {
                Some(reference) => Some(runner::resolve_entity(&store, &analysis, &reference)?),
                None => None,
            };
            print(json!({
                "analysis_id": analysis,
                "entity_id": entity,
                "annotations": store.annotations(&analysis, entity.as_deref(), limit)?,
            }))?
        }
        Action::Agent { command } => match command {
            AgentAction::Request {
                analysis,
                owner,
                key,
                kind,
                entity,
                payload,
            } => {
                // Resolve the entity only when the analysis exists. A request
                // against an unknown analysis must be *recorded* as rejected
                // rather than die in argument parsing, or the refusal would be
                // invisible to whoever is waiting for the answer.
                let known = store.metadata(&analysis).is_ok();
                let entity = match entity {
                    Some(reference) if known => {
                        Some(runner::resolve_entity(&store, &analysis, &reference)?)
                    }
                    other => other,
                };
                let spec = bridge::AgentRequestSpec {
                    owner: &owner,
                    request_key: &key,
                    kind: &kind,
                    analysis_id: &analysis,
                    entity_id: entity.as_deref(),
                    payload: payload.as_deref(),
                };
                let (request, created) = store.enqueue_agent_request(&spec)?;
                print(
                    json!({"outcome": if created {"enqueued"} else {"already_requested"}, "request": request}),
                )?;
                if request.state == bridge::STATE_REJECTED {
                    return Err(format!(
                        "request rejected: {}",
                        request.terminal_reason.unwrap_or_else(|| "unknown".into())
                    )
                    .into());
                }
            }
            AgentAction::Claim { lease_seconds } => {
                if !(5..=3600).contains(&lease_seconds) {
                    return Err("lease must be 5..3600 seconds".into());
                }
                let holder = new_holder();
                let claimed = store.claim_agent_request(&holder, (lease_seconds as i64) * 1000)?;
                print(json!({"holder": holder, "request": claimed}))?
            }
            AgentAction::Complete {
                id,
                holder,
                state,
                result,
                reason,
            } => {
                let recorded = store.finish_agent_request(
                    &id,
                    &holder,
                    &state,
                    result.as_deref(),
                    reason.as_deref(),
                )?;
                print(json!({"recorded": recorded, "request": store.agent_request(&id)?}))?;
                if !recorded {
                    return Err(
                        "only the current lease holder can finish a request; a stale holder cannot"
                            .into(),
                    );
                }
            }
            AgentAction::Status { id } => print(store.agent_request(&id)?)?,
            AgentAction::List { state, limit } => {
                print(json!({"requests": store.agent_requests(state.as_deref(), limit)?}))?
            }
            AgentAction::Reap => {
                let reaped = store.reap_agent_requests(job::now_ms())?;
                print(json!({"reaped": reaped, "count": reaped.len()}))?
            }
            AgentAction::Work {
                once,
                max,
                lease_seconds,
            } => {
                if !(5..=3600).contains(&lease_seconds) {
                    return Err("lease must be 5..3600 seconds".into());
                }
                let lease_ms = (lease_seconds as i64) * 1000;
                let mut outcomes = Vec::new();
                loop {
                    if max > 0 && outcomes.len() >= max {
                        break;
                    }
                    let holder = new_holder();
                    let Some(request) = store.claim_agent_request(&holder, lease_ms)? else {
                        break;
                    };
                    let outcome = match agent::perform(&store, &request) {
                        Ok(result) => {
                            let encoded = serde_json::to_string(&result)?;
                            let recorded = store.finish_agent_request(
                                &request.id,
                                &holder,
                                bridge::STATE_DONE,
                                Some(&encoded),
                                None,
                            )?;
                            json!({"outcome":"done","recorded":recorded,"request":store.agent_request(&request.id)?,"result":result})
                        }
                        Err(error) => {
                            let recorded = store.finish_agent_request(
                                &request.id,
                                &holder,
                                bridge::STATE_FAILED,
                                None,
                                Some(&error),
                            )?;
                            json!({"outcome":"failed","recorded":recorded,"request":store.agent_request(&request.id)?,"error":error})
                        }
                    };
                    outcomes.push(outcome);
                    if once {
                        break;
                    }
                }
                let ran = outcomes.len();
                print(json!({"ran": ran, "outcomes": outcomes}))?
            }
        },
        Action::Patch { command } => match command {
            PatchAction::Propose {
                analysis,
                entity,
                diff,
                proposed_by,
                summary,
            } => {
                let text = std::fs::read_to_string(&diff)?;
                // A proposal that creates a file names a path with no entity
                // yet; every other reference must resolve.
                let (entity, adds_target) =
                    patchwork::resolve_proposal_entity(&store, &analysis, &entity, &text)?;
                // The diff is checked against the pinned bytes before the
                // proposal is stored. Storing an unapplicable proposal would
                // make it look reviewable when it is not.
                let (stored, created) = patchwork::propose_from_diff(
                    &store,
                    &analysis,
                    &entity,
                    &text,
                    &proposed_by,
                    summary.as_deref(),
                )?;
                let _ = adds_target;
                let valid = stored.state != patch::STATE_REJECTED;
                print(json!({
                    "outcome": if created { if valid {"proposed"} else {"rejected"} } else {"already_proposed"},
                    "proposal": stored,
                }))?;
                if !valid {
                    return Err(
                        "proposal_rejected:the diff does not apply to the pinned snapshot".into(),
                    );
                }
            }
            PatchAction::Verify {
                id,
                enqueue,
                identity,
                priority,
                node,
                worker,
                timeout_seconds,
                scan_deadline_seconds,
                index_deadline_seconds,
                test_argv,
                test_timeout_ms,
                worker_heap_mb,
            } => {
                let test_argv: Option<Vec<String>> = match test_argv.as_deref() {
                    Some(text) => Some(serde_json::from_str(text)?),
                    None => None,
                };
                let options = patchwork::VerifyOptions {
                    node,
                    worker,
                    worker_heap_mb,
                    timeout: Duration::from_secs(timeout_seconds),
                    scan_deadline: Duration::from_secs(scan_deadline_seconds),
                    index_deadline: Duration::from_secs(index_deadline_seconds),
                    test_argv,
                    test_timeout: Duration::from_millis(test_timeout_ms),
                };
                if enqueue {
                    let owner = identity
                        .owner
                        .clone()
                        .ok_or("--enqueue requires --owner: a queued request needs an owner")?;
                    // The queue stores how to run the request, so a worker that
                    // picks it up later performs exactly this verification.
                    let proposal = store.patch_proposal(&id)?;
                    let stored = serde_json::to_string(&StoredVerify {
                        proposal_id: id.clone(),
                        node: options.node.display().to_string(),
                        worker: options.worker.display().to_string(),
                        timeout_seconds: options.timeout.as_secs(),
                        scan_deadline_seconds: options.scan_deadline.as_secs(),
                        index_deadline_seconds: options.index_deadline.as_secs(),
                        test_argv: options.test_argv.clone(),
                        test_timeout_ms: options.test_timeout.as_millis() as u64,
                        worker_heap_mb: options.worker_heap_mb,
                    })?;
                    // Identity: the base analysis groups the request, and the
                    // proposal id is the key, so one proposal is verified once
                    // per owner rather than once per invocation.
                    let project = proposal.analysis_id.clone();
                    let request_key = identity.request_key.clone().unwrap_or_else(|| id.clone());
                    let request = job::JobRequest {
                        kind: job::KIND_PATCH_VERIFY,
                        owner: &owner,
                        project: &project,
                        request_key: &request_key,
                        root: "",
                        options: &stored,
                    };
                    let (row, created) = store.enqueue_job(&request, priority)?;
                    print(json!({
                        "outcome": if created { "queued".to_string() } else { format!("already_{}", row.state) },
                        "job": row,
                    }))?;
                } else {
                    print(patchwork::verify_proposal(&store, &id, &options).await?)?;
                }
            }
            PatchAction::Apply { id, target } => {
                let proposal = store.patch_proposal(&id)?;
                print(patchwork::apply_proposal(
                    &store, &proposal, &target, "cli",
                )?)?
            }
            PatchAction::Revert { id } => {
                let proposal = store.patch_proposal(&id)?;
                print(patchwork::revert_proposal(&store, &proposal, "cli")?)?
            }
            PatchAction::Status { id } => print(store.patch_proposal(&id)?)?,
            PatchAction::List {
                analysis,
                entity,
                limit,
            } => {
                let entity = match entity {
                    Some(reference) => Some(runner::resolve_entity(&store, &analysis, &reference)?),
                    None => None,
                };
                print(json!({
                    "analysis_id": analysis,
                    "entity_id": entity,
                    "proposals": store.patch_proposals(&analysis, entity.as_deref(), limit)?,
                }))?
            }
        },
        Action::Serve {
            analysis,
            port,
            allow_writes,
        } => {
            store.metadata(&analysis)?;
            server::serve(store, analysis, port, allow_writes).await?;
        }
    }
    Ok(())
}

/// Every exit path drops the listener; cancellation uses cooperative cleanup,
/// not process::exit, so the owned worker is always waited on.
struct SignalWatcher(tokio::task::JoinHandle<()>);

impl Drop for SignalWatcher {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn signal_watcher(
    control: ExecutionControl,
    cancel: tokio::sync::watch::Sender<bool>,
) -> std::io::Result<SignalWatcher> {
    #[cfg(unix)]
    let wait = {
        use tokio::signal::unix::{SignalKind, signal};
        // Register before starting the pipeline, including on one-core hosts.
        let mut sigint = signal(SignalKind::interrupt())?;
        let mut sigterm = signal(SignalKind::terminate())?;
        async move {
            tokio::select! {
                _ = sigint.recv() => {}
                _ = sigterm.recv() => {}
            }
        }
    };
    #[cfg(not(unix))]
    let wait = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    Ok(SignalWatcher(tokio::spawn(async move {
        wait.await;
        if control.cancel() {
            let _ = cancel.send(true);
            eprintln!("index_cancellation_requested");
        }
    })))
}

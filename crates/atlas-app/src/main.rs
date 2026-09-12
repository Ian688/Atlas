mod runner;
mod server;
mod worker;

use atlas_contract::{ParseRequest, ScanLimits};
use atlas_engine::exec::{Grants, RunSpec};
use atlas_engine::job::{self, Lease, STATE_COMPLETED, STATE_FAILED};
use atlas_engine::{analyze, control::ExecutionControl, incremental, scan, store::Store};
use clap::{Args, Parser, Subcommand};
use serde_json::json;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
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
        /// Comma-separated runtime permissions: fs_write, child_process,
        /// network, unknown_calls, globals.
        #[arg(long, default_value = "")]
        allow_effects: String,
        #[arg(long, default_value = "node")]
        node: PathBuf,
        /// Repeatable explicit environment entry `KEY=VALUE`; nothing else is
        /// inherited except PATH.
        #[arg(long = "env")]
        env: Vec<String>,
        /// Declare that this run used mocks/fixtures, so its result can never
        /// be read as an observation of the real project environment.
        #[arg(long)]
        fixtures: bool,
        #[arg(long)]
        fixture_note: Option<String>,
        /// List previously published execution records for this symbol.
        #[arg(long)]
        history: bool,
    },
    Serve {
        analysis: String,
        #[arg(long, default_value_t = 0)]
        port: u16,
    },
    /// Durable job identity: idempotent submit, lease, and crash recovery.
    Job {
        #[command(subcommand)]
        command: JobAction,
    },
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
        )
    }

    fn new(
        node: PathBuf,
        worker: PathBuf,
        timeout_seconds: u64,
        scan_deadline_seconds: u64,
        index_deadline_seconds: u64,
        incremental: bool,
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
        Ok(Self {
            node,
            worker,
            timeout: Duration::from_secs(timeout_seconds),
            scan_deadline: Duration::from_secs(scan_deadline_seconds),
            index_deadline: Duration::from_secs(index_deadline_seconds),
            incremental,
        })
    }

    /// Identity of the work itself, used when a caller supplies no request key.
    /// Two identical invocations must address the same request.
    fn fingerprint(&self, root: &Path) -> String {
        atlas_engine::digest(
            format!(
                "atlas.index-request.v1|{}|{}|{:?}|{:?}|{:?}",
                root.display(),
                self.node.display(),
                self.timeout,
                self.scan_deadline,
                self.index_deadline
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
        )
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
}

/// A lease holder identity: unique per process run, so two runs of the same
/// binary can never be mistaken for one holder.
fn new_holder() -> String {
    format!("{}-{}", std::process::id(), uuid::Uuid::new_v4())
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

/// Run one claimed job to a terminal state, renewing its lease while it works.
///
/// Returns the outcome object and whether the job itself succeeded. The outer
/// error is reserved for failures of the job store, which are a different kind
/// of problem from the job failing.
async fn run_claimed_job(
    store: &Store,
    job: &job::Job,
    options: &IndexOptions,
    lease_ms: i64,
    holder: &str,
) -> Result<(serde_json::Value, bool), Box<dyn std::error::Error>> {
    let root = PathBuf::from(&job.root);
    let control = ExecutionControl::new(Some(std::time::Instant::now() + options.index_deadline));
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
    let outcome = run_pipeline(store, &root, options, &control, cancel_rx).await;
    stop.store(true, Ordering::Relaxed);
    let _ = heartbeat.join();
    // `recorded` is false when the lease was lost mid-run: the analysis is
    // still valid and immutable, but it belongs to no job we own.
    match outcome {
        Ok(result) => {
            let recorded = store.finish_job(
                &job.id,
                holder,
                STATE_COMPLETED,
                None,
                Some(&result.analysis_id),
            )?;
            Ok((
                json!({
                    "outcome": "completed",
                    "recorded": recorded,
                    "job": store.job(&job.id)?,
                    "analysis_id": result.analysis_id,
                    "metadata": result.metadata,
                    "incremental": result.incremental,
                }),
                true,
            ))
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
        } => {
            let options = IndexOptions::new(
                node,
                worker,
                timeout_seconds,
                scan_deadline_seconds,
                index_deadline_seconds,
                want_incremental,
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
            fixtures,
            fixture_note,
            history,
        } => {
            let symbol = runner::resolve_symbol(&store, &analysis, &entity)?;
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
                fixtures,
                fixture_note,
                label: None,
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
                    print(runner::run_scenario(&store, &spec, &document, cancel_rx).await?)?
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
                    owner: &identity.owner,
                    project: &project,
                    request_key: &request_key,
                    root: &root_display,
                    options: &stored,
                };
                let (row, created) = store.enqueue_job(&request, priority)?;
                print(json!({
                    "outcome": if created {"queued"} else {"already_queued"},
                    "job": row}))?;
            }
            JobAction::Work {
                once,
                lease_seconds,
                max,
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
                    let Some(row) = store.claim_next(&holder, lease_ms)? else {
                        break;
                    };
                    let options = match IndexOptions::from_job(&row) {
                        Ok(options) => options,
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
                        run_claimed_job(&store, &row, &options, lease_ms, &holder).await?;
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
                        let (mut outcome, succeeded) =
                            run_claimed_job(&store, &row, &options, lease_ms, &holder).await?;
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
        Action::Serve { analysis, port } => {
            store.metadata(&analysis)?;
            server::serve(store, analysis, port).await?;
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

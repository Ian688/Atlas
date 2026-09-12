mod server;
mod worker;

use atlas_contract::{ParseRequest, ScanLimits};
use atlas_engine::{analyze, control::ExecutionControl, scan, store::Store};
use clap::{Parser, Subcommand};
use std::{path::PathBuf, time::Duration};

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
    Serve {
        analysis: String,
        #[arg(long, default_value_t = 0)]
        port: u16,
    },
}
fn print(value: impl serde::Serialize) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
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
        } => {
            if timeout_seconds == 0 || timeout_seconds > 600 {
                return Err("timeout must be 1..600 seconds".into());
            }
            if scan_deadline_seconds == 0 || scan_deadline_seconds > 3600 {
                return Err("scan deadline must be 1..3600 seconds".into());
            }
            if index_deadline_seconds == 0 || index_deadline_seconds > 3600 {
                return Err("index deadline must be 1..3600 seconds".into());
            }
            let pipeline_started = std::time::Instant::now();
            let control = ExecutionControl::new(Some(
                pipeline_started + Duration::from_secs(index_deadline_seconds),
            ));
            let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
            let _signal_watcher = signal_watcher(control.clone(), cancel_tx)?;
            // Filesystem and Rust work must not occupy the async runtime that
            // receives signals. The same control remains live through commit.
            let scan_store = store.clone();
            let scan_control = control.clone();
            let (snapshot, request) = tokio::task::spawn_blocking(move || {
                let snapshot = scan::scan_controlled(
                    &root,
                    &scan_store,
                    ScanLimits::default(),
                    Some(Duration::from_secs(scan_deadline_seconds)),
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
            control.checkpoint()?;
            let remaining = Duration::from_secs(index_deadline_seconds)
                .saturating_sub(pipeline_started.elapsed());
            let facts = worker::parse(
                &node,
                &worker,
                &request,
                Duration::from_secs(timeout_seconds).min(remaining),
                32 * 1024 * 1024,
                cancel_rx,
            )
            .await?;
            control.checkpoint()?;
            let analysis_store = store.clone();
            let analysis = tokio::task::spawn_blocking(move || {
                analyze::analyze_controlled(&analysis_store, &snapshot, facts, &control)
            })
            .await??;
            print(store.metadata(&analysis.id)?)?;
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

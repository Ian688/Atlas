mod server;
mod worker;

use atlas_contract::{ParseRequest, ScanLimits};
use atlas_engine::{analyze, scan, store::Store};
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
        } => {
            if timeout_seconds == 0 || timeout_seconds > 600 {
                return Err("timeout must be 1..600 seconds".into());
            }
            let snapshot = scan::scan(&root, &store, ScanLimits::default())?;
            let request = ParseRequest {
                schema: "atlas.parse-request.v1".into(),
                snapshot_id: snapshot.id.clone(),
                files: store.sources(&snapshot)?,
            };
            let facts = worker::parse(
                &node,
                &worker,
                &request,
                Duration::from_secs(timeout_seconds),
                32 * 1024 * 1024,
            )
            .await?;
            let analysis = analyze::analyze(&store, &snapshot, facts)?;
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
        Action::Serve { analysis, port } => {
            store.metadata(&analysis)?;
            server::serve(store, analysis, port).await?;
        }
    }
    Ok(())
}

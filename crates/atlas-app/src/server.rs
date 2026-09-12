use atlas_engine::bridge;
use atlas_engine::exec::{Grants, RunSpec};
use atlas_engine::store::Store;
use axum::{
    Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use std::{
    fs,
    net::{Ipv4Addr, SocketAddrV4},
    sync::Arc,
};
use tokio::sync::Semaphore;

#[derive(Clone)]
struct App {
    store: Store,
    analysis: String,
    token: String,
    authority: String,
    slots: Arc<Semaphore>,
}
#[derive(Deserialize)]
struct Request {
    kind: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
    entity: Option<String>,
    direction: Option<String>,
}

fn allowed(app: &App, headers: &HeaderMap) -> bool {
    headers.get(header::HOST).and_then(|v| v.to_str().ok()) == Some(app.authority.as_str())
        && headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            == Some(format!("Bearer {}", app.token).as_str())
        && headers
            .get(header::ORIGIN)
            .map(|v| v.to_str().ok() == Some(format!("http://{}", app.authority).as_str()))
            .unwrap_or(true)
}
async fn query(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<Request>,
    path: &'static str,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let Ok(permit) = app.slots.clone().try_acquire_owned() else {
        return (StatusCode::TOO_MANY_REQUESTS, "busy").into_response();
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let id = &app.analysis;
        match path {
            "report" => app.store.metadata(id),
            "nodes" => serde_json::to_value(app.store.nodes(
                id,
                q.kind.as_deref().unwrap_or("all"),
                q.limit.unwrap_or(100),
                q.cursor.as_deref(),
            )?)
            .map_err(Into::into),
            "edges" => serde_json::to_value(app.store.edges(
                id,
                q.kind.as_deref().unwrap_or("call_candidate"),
                q.limit.unwrap_or(100),
                q.cursor.as_deref(),
            )?)
            .map_err(Into::into),
            "reach" => serde_json::to_value(app.store.reachable(
                id,
                q.entity.as_deref().unwrap_or(""),
                q.direction.as_deref().unwrap_or("out"),
                100,
                400,
            )?)
            .map_err(Into::into),
            "source" => app
                .store
                .source(id, q.entity.as_deref().unwrap_or(""), 16000),
            "context" => app.store.context(id, q.entity.as_deref().unwrap_or("")),
            "flow" => app.store.flow_fact(id, q.entity.as_deref().unwrap_or("")),
            "flows" => serde_json::to_value(app.store.flow_symbols(
                id,
                q.limit.unwrap_or(100),
                q.cursor.as_deref(),
            )?)
            .map_err(Into::into),
            // The same reference forms as the CLI: a symbol id, `path:name`, or
            // a bare name, resolved under this analysis only.
            "profile" => {
                let reference = q.entity.as_deref().unwrap_or("");
                let symbol = crate::runner::resolve_symbol(&app.store, id, reference)
                    .map_err(|error| atlas_engine::invalid(&error))?;
                serde_json::to_value(
                    crate::runner::profile_for(&app.store, id, &symbol)
                        .map_err(|error| atlas_engine::invalid(&error))?,
                )
                .map_err(Into::into)
            }
            // A selection is pinned to the analysis this server is serving, so
            // a page cannot ask about a version it was not opened on.
            "selection" => {
                let reference = q.entity.as_deref().unwrap_or("");
                let symbol = crate::runner::resolve_symbol(&app.store, id, reference)
                    .map_err(|error| atlas_engine::invalid(&error))?;
                serde_json::to_value(bridge::selection(id, &symbol, "entity")).map_err(Into::into)
            }
            "annotations" => {
                let entity = q.entity.as_deref().unwrap_or("");
                let entity = if entity.is_empty() {
                    None
                } else {
                    Some(
                        crate::runner::resolve_symbol(&app.store, id, entity)
                            .map_err(|error| atlas_engine::invalid(&error))?,
                    )
                };
                serde_json::to_value(serde_json::json!({
                    "analysis_id": id,
                    "entity_id": entity,
                    "annotations": app.store.annotations(id, entity.as_deref(), q.limit.unwrap_or(50))?,
                }))
                .map_err(Into::into)
            }
            "agent-requests" => serde_json::to_value(serde_json::json!({
                "requests": app.store.agent_requests(q.kind.as_deref(), q.limit.unwrap_or(50))?,
            }))
            .map_err(Into::into),
            "exec-records" => {
                let reference = q.entity.as_deref().unwrap_or("");
                let symbol = crate::runner::resolve_symbol(&app.store, id, reference)
                    .map_err(|error| atlas_engine::invalid(&error))?;
                serde_json::to_value(app.store.exec_records(id, &symbol, q.limit.unwrap_or(20))?)
                    .map_err(Into::into)
            }
            _ => Err(atlas_engine::invalid("unknown_query")),
        }
    })
    .await;
    match result {
        Ok(Ok(value)) => match serde_json::to_vec(&value) {
            Ok(bytes) if bytes.len() <= 2 * 1024 * 1024 => (
                [
                    (header::CACHE_CONTROL, "no-store"),
                    (header::CONTENT_TYPE, "application/json"),
                ],
                bytes,
            )
                .into_response(),
            _ => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "response_byte_budget_exceeded",
            )
                .into_response(),
        },
        Ok(Err(_)) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error":"invalid_or_unavailable_query"})),
        )
            .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "query failed").into_response(),
    }
}
macro_rules! endpoint {
    ($name:ident,$path:literal) => {
        async fn $name(
            state: State<App>,
            headers: HeaderMap,
            query_arg: Query<Request>,
        ) -> Response {
            query(state, headers, query_arg, $path).await
        }
    };
}
endpoint!(report, "report");
endpoint!(nodes, "nodes");
endpoint!(edges, "edges");
endpoint!(reach, "reach");
endpoint!(source, "source");
endpoint!(context, "context");
endpoint!(flow, "flow");
endpoint!(flows, "flows");
endpoint!(profile, "profile");
endpoint!(exec_records, "exec-records");
endpoint!(selection, "selection");
endpoint!(annotations, "annotations");
endpoint!(agent_requests, "agent-requests");

#[derive(Deserialize)]
struct AnnotationRequest {
    entity: String,
    #[serde(default = "default_intent")]
    kind: String,
    body: String,
    #[serde(default = "default_human")]
    proposed_by: String,
}

fn default_intent() -> String {
    "intent".into()
}
fn default_human() -> String {
    "human".into()
}

/// Register an Intent. This is the only write the page can make, and it writes
/// a proposal -- never source, never a fact.
async fn annotate(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<AnnotationRequest>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let symbol = match crate::runner::resolve_symbol(&app.store, &app.analysis, &request.entity) {
        Ok(symbol) => symbol,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error})),
            )
                .into_response();
        }
    };
    let selection = bridge::selection(&app.analysis, &symbol, "entity");
    match app.store.create_annotation(
        &selection,
        &request.kind,
        &request.body,
        &request.proposed_by,
    ) {
        Ok((annotation, created)) => axum::Json(serde_json::json!({
            "outcome": if created {"created"} else {"already_proposed"},
            "annotation": annotation,
        }))
        .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct AgentRequestBody {
    owner: String,
    request_key: String,
    #[serde(default = "default_inspect")]
    kind: String,
    entity: Option<String>,
    payload: Option<String>,
}

fn default_inspect() -> String {
    "inspect".into()
}

/// Enqueue a bounded bridge request. The analysis is the server's, not the
/// caller's: a page cannot pin work to a version this service is not serving.
async fn agent_request(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<AgentRequestBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let entity = match body.entity {
        Some(reference) => {
            match crate::runner::resolve_symbol(&app.store, &app.analysis, &reference) {
                Ok(symbol) => Some(symbol),
                Err(error) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        axum::Json(serde_json::json!({"error": error})),
                    )
                        .into_response();
                }
            }
        }
        None => None,
    };
    let spec = bridge::AgentRequestSpec {
        owner: &body.owner,
        request_key: &body.request_key,
        kind: &body.kind,
        analysis_id: &app.analysis,
        entity_id: entity.as_deref(),
        payload: body.payload.as_deref(),
    };
    match app.store.enqueue_agent_request(&spec) {
        Ok((request, created)) => {
            let rejected = request.state == bridge::STATE_REJECTED;
            let payload = serde_json::json!({
                "outcome": if created {"enqueued"} else {"already_requested"},
                "request": request,
            });
            if rejected {
                (StatusCode::BAD_REQUEST, axum::Json(payload)).into_response()
            } else {
                axum::Json(payload).into_response()
            }
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct AgentWorkBody {
    #[serde(default)]
    max: usize,
}

/// Perform queued bounded actions. The server decides what a bounded action is;
/// the caller only decides how many to run, so this cannot be used to make the
/// service do something the CLI could not.
async fn agent_work(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<AgentWorkBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let limit = body.max.clamp(1, 32);
    let store = app.store.clone();
    let holder = format!("http-{}", uuid::Uuid::new_v4().simple());
    let outcome = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let mut outcomes = Vec::new();
        for _ in 0..limit {
            let Some(request) = store
                .claim_agent_request(&holder, 30_000)
                .map_err(|e| e.to_string())?
            else {
                break;
            };
            let outcome = match crate::agent::perform(&store, &request) {
                Ok(result) => {
                    let encoded = serde_json::to_string(&result).map_err(|e| e.to_string())?;
                    store
                        .finish_agent_request(
                            &request.id,
                            &holder,
                            bridge::STATE_DONE,
                            Some(&encoded),
                            None,
                        )
                        .map_err(|e| e.to_string())?;
                    serde_json::json!({"outcome":"done","request_id":request.id,"result":result})
                }
                Err(error) => {
                    store
                        .finish_agent_request(
                            &request.id,
                            &holder,
                            bridge::STATE_FAILED,
                            None,
                            Some(&error),
                        )
                        .map_err(|e| e.to_string())?;
                    serde_json::json!({"outcome":"failed","request_id":request.id,"error":error})
                }
            };
            outcomes.push(outcome);
        }
        Ok(serde_json::json!({"holder": holder, "ran": outcomes.len(), "outcomes": outcomes}))
    })
    .await;
    match outcome {
        Ok(Ok(value)) => axum::Json(value).into_response(),
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error})),
        )
            .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "agent work failed").into_response(),
    }
}

/// The body a local page may send to start a controlled run.
///
/// Deliberately narrow: the page cannot choose the Node binary, cannot inject
/// environment variables, and cannot grant filesystem-write, child-process or
/// network permissions. Those are operator decisions made on the CLI, where the
/// person making them can see the flag. A page that could widen its own
/// sandbox would be a privilege-escalation path, not a feature.
#[derive(Deserialize)]
struct ExecRequest {
    symbol: String,
    #[serde(default)]
    args: Vec<serde_json::Value>,
    timeout_ms: Option<u64>,
    allow_effects: Option<Vec<String>>,
    #[serde(default)]
    fixtures: bool,
    fixture_note: Option<String>,
    #[serde(default)]
    plan: bool,
}

async fn exec(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<ExecRequest>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let Ok(permit) = app.slots.clone().try_acquire_owned() else {
        return (StatusCode::TOO_MANY_REQUESTS, "busy").into_response();
    };
    let symbol = match crate::runner::resolve_symbol(&app.store, &app.analysis, &request.symbol) {
        Ok(symbol) => symbol,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error})),
            )
                .into_response();
        }
    };
    let grants = Grants {
        fs_write: false,
        child_process: false,
        network: false,
        // Only the two grants that do not widen the process boundary are
        // accepted from the page.
        unknown_calls: request
            .allow_effects
            .as_ref()
            .is_some_and(|names| names.iter().any(|name| name == "unknown_calls")),
        globals: request
            .allow_effects
            .as_ref()
            .is_some_and(|names| names.iter().any(|name| name == "globals")),
    };
    let plan_only = request.plan;
    let spec = RunSpec {
        schema: atlas_engine::exec::RUN_SPEC_SCHEMA.into(),
        analysis_id: app.analysis.clone(),
        symbol,
        args: request.args.into_iter().take(64).collect(),
        timeout_ms: request.timeout_ms.unwrap_or(5_000).min(30_000),
        output_limit: 64 * 1024,
        grants,
        node: "node".into(),
        env: std::collections::BTreeMap::new(),
        fixtures: request.fixtures,
        fixture_note: request.fixture_note,
        label: Some("http".into()),
    };
    let store = app.store.clone();
    let outcome = tokio::spawn(async move {
        let _permit = permit;
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        if plan_only {
            crate::runner::plan(&store, &spec)
        } else {
            crate::runner::execute(&store, &spec, cancel_rx).await
        }
    })
    .await;
    match outcome {
        Ok(Ok(value)) => match serde_json::to_vec(&value) {
            Ok(bytes) if bytes.len() <= 2 * 1024 * 1024 => (
                [
                    (header::CACHE_CONTROL, "no-store"),
                    (header::CONTENT_TYPE, "application/json"),
                ],
                bytes,
            )
                .into_response(),
            _ => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "response_byte_budget_exceeded",
            )
                .into_response(),
        },
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error})),
        )
            .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "exec failed").into_response(),
    }
}

fn asset(content: &'static str, mime: &'static str) -> Response {
    ([(header::CONTENT_TYPE,mime),(header::CACHE_CONTROL,"no-store"),(header::CONTENT_SECURITY_POLICY,"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"),(header::X_CONTENT_TYPE_OPTIONS,"nosniff")],content).into_response()
}

pub async fn serve(
    store: Store,
    analysis: String,
    port: u16,
) -> Result<(), Box<dyn std::error::Error>> {
    let listener =
        tokio::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await?;
    let address = listener.local_addr()?;
    let token = uuid::Uuid::new_v4().to_string();
    let session_file = store
        .root
        .join(format!("web-session-{}.json", uuid::Uuid::new_v4()));
    let session = serde_json::json!({"url":format!("http://{address}/"),"token":token,"analysis_id":analysis});
    let bytes = serde_json::to_vec_pretty(&session)?;
    #[cfg(unix)]
    {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&session_file)?;
        file.write_all(&bytes)?;
    }
    #[cfg(not(unix))]
    fs::write(&session_file, &bytes)?;
    println!(
        "{}",
        serde_json::json!({"listening":format!("http://{address}/"),"session_file":session_file,"analysis_id":analysis})
    );
    let app = App {
        store,
        analysis,
        token,
        authority: address.to_string(),
        slots: Arc::new(Semaphore::new(8)),
    };
    let router = Router::new()
        .route(
            "/",
            get(|| async {
                asset(
                    include_str!("../../../web/index.html"),
                    "text/html; charset=utf-8",
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async {
                asset(
                    include_str!("../../../web/app.js"),
                    "text/javascript; charset=utf-8",
                )
            }),
        )
        .route(
            "/style.css",
            get(|| async {
                asset(
                    include_str!("../../../web/style.css"),
                    "text/css; charset=utf-8",
                )
            }),
        )
        // The 3D city is a second projection of the same fixed Analysis, served
        // through the same `asset()` so it inherits the CSP, the Host/Origin
        // boundary and the session token without a second security path.
        .route(
            "/city3d",
            get(|| async {
                asset(
                    include_str!("../../../web/city3d.html"),
                    "text/html; charset=utf-8",
                )
            }),
        )
        .route(
            "/city3d.js",
            get(|| async {
                asset(
                    include_str!("../../../web/city3d.js"),
                    "text/javascript; charset=utf-8",
                )
            }),
        )
        .route("/api/report", get(report))
        .route("/api/nodes", get(nodes))
        .route("/api/edges", get(edges))
        .route("/api/reach", get(reach))
        .route("/api/source", get(source))
        .route("/api/context", post(context))
        .route("/api/flow", get(flow))
        .route("/api/flows", get(flows))
        .route("/api/profile", get(profile))
        .route("/api/exec-records", get(exec_records))
        .route("/api/exec", post(exec))
        .route("/api/selection", get(selection))
        .route("/api/annotations", get(annotations))
        .route("/api/annotation", post(annotate))
        .route("/api/agent/requests", get(agent_requests))
        .route("/api/agent/request", post(agent_request))
        .route("/api/agent/work", post(agent_work))
        .with_state(app);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    let _ = fs::remove_file(session_file);
    Ok(())
}

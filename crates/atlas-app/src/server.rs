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
    /// The authenticated principal for everything that arrives over HTTP.
    ///
    /// The only identity this service can actually verify is "holds the session
    /// token", so that is the owner every request is attributed to. A page that
    /// declares a different owner is not believed -- letting one page write rows
    /// under another's name would make the owner column meaningless.
    owner: String,
    /// The one directory this server is allowed to write into, if the operator
    /// started it with `--allow-writes`. `None` means every write endpoint
    /// refuses, and no request can turn that on: an HTTP request may not widen
    /// the boundary it arrives through.
    write_root: Option<std::path::PathBuf>,
}
#[derive(Deserialize)]
struct Request {
    kind: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
    entity: Option<String>,
    direction: Option<String>,
    /// Name/path substring for `/api/search`; trimmed server-side.
    q: Option<String>,
    /// Byte window for `/api/source`, bounded by the entity's own span.
    start: Option<usize>,
    end: Option<usize>,
    /// A direct object reference where `entity` would be ambiguous, as in
    /// `/api/patch?id=<proposal id>`.
    id: Option<String>,
    /// The analysis a selection was pinned to, for `/api/relocate`.
    #[serde(rename = "from")]
    from_analysis: Option<String>,
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
            // Whole-analysis name/path search. The page filters nothing
            // locally: paging to the end of 500-node pages is not a promise
            // that the answer covers the project, and this query is.
            "search" => serde_json::to_value(app.store.search_nodes(
                id,
                q.q.as_deref().unwrap_or(""),
                q.kind.as_deref().unwrap_or("function"),
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
            // Query endpoints accept the same reference forms as the CLI -- a
            // symbol id, `path:name` or a bare name -- resolved under this
            // analysis only. Requiring a raw id here but not on the CLI made
            // the HTTP surface the awkward one for no benefit.
            "reach" => {
                let entity = crate::runner::resolve_entity(&app.store, id, q.entity.as_deref().unwrap_or(""))
                    .map_err(|error| atlas_engine::invalid(&error))?;
                serde_json::to_value(app.store.reachable(
                    id,
                    &entity,
                    q.direction.as_deref().unwrap_or("out"),
                    100,
                    400,
                )?)
                .map_err(Into::into)
            }
            // One entity, by the same reference forms as everywhere else.
            //
            // The page needs this because a focus graph or a deep link names
            // entities that this tab never paged in: /api/nodes walks objects in
            // id order, so the first page holds directories and files and not a
            // single function. Without a way to ask for one entity by identity,
            // the only way to open a neighbour is to page through thousands of
            // unrelated objects -- which is why boxes on the canvas used to be
            // labelled "not loaded in this analysis" and could not be clicked.
            "node" => {
                let entity = crate::runner::resolve_entity(&app.store, id, q.entity.as_deref().unwrap_or(""))
                    .map_err(|error| atlas_engine::invalid(&error))?;
                let node = app.store.node(id, &entity)?;
                serde_json::to_value(serde_json::json!({
                    "analysis_id": id,
                    "node": node,
                }))
                .map_err(Into::into)
            }
            "source" => {
                let entity = crate::runner::resolve_entity(&app.store, id, q.entity.as_deref().unwrap_or(""))
                    .map_err(|error| atlas_engine::invalid(&error))?;
                app.store.source_window(
                    id,
                    &entity,
                    q.start,
                    q.end,
                    16000,
                )
            }
            "context" => {
                let entity = crate::runner::resolve_entity(&app.store, id, q.entity.as_deref().unwrap_or(""))
                    .map_err(|error| atlas_engine::invalid(&error))?;
                app.store.context(id, &entity)
            }
            "flow" => {
                let entity = crate::runner::resolve_symbol(&app.store, id, q.entity.as_deref().unwrap_or(""))
                    .map_err(|error| atlas_engine::invalid(&error))?;
                app.store.flow_fact(id, &entity)
            }
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
            "patches" => {
                let entity = q.entity.as_deref().unwrap_or("");
                let entity = if entity.is_empty() {
                    None
                } else {
                    Some(
                        crate::runner::resolve_entity(&app.store, id, entity)
                            .map_err(|error| atlas_engine::invalid(&error))?,
                    )
                };
                serde_json::to_value(serde_json::json!({
                    "analysis_id": id,
                    "entity_id": entity,
                    "proposals": app.store.patch_proposals(id, entity.as_deref(), q.limit.unwrap_or(50))?,
                }))
                .map_err(Into::into)
            }
            "patch" => {
                let reference = q
                    .id
                    .as_deref()
                    .or(q.entity.as_deref())
                    .unwrap_or("");
                let proposal = app
                    .store
                    .patch_proposal(reference)
                    .map_err(|error| atlas_engine::invalid(&error.to_string()))?;
                // A proposal belongs to one analysis; serving it under another
                // would attach someone else's diff to this version.
                if proposal.analysis_id.as_str() != id.as_str() {
                    return Err(atlas_engine::invalid("proposal_belongs_to_another_analysis"));
                }
                serde_json::to_value(proposal).map_err(Into::into)
            }
            "agent-requests" => serde_json::to_value(serde_json::json!({
                "requests": app.store.agent_requests(q.kind.as_deref(), q.limit.unwrap_or(50))?,
            }))
            .map_err(Into::into),
            "relocate" => {
                let reference = q.entity.as_deref().unwrap_or("");
                // Relocation is defined relative to a *pinned* analysis, so the
                // caller must say which one; defaulting to the served analysis
                // would make every call a no-op.
                let from = q
                    .from_analysis
                    .as_deref()
                    .ok_or_else(|| atlas_engine::invalid("relocate_requires_from_analysis"))?;
                let entity = crate::runner::resolve_entity(&app.store, from, reference)
                    .map_err(|error| atlas_engine::invalid(&error))?;
                let relocation = atlas_engine::relocate::relocate(&app.store, from, &entity, id)
                    .map_err(|error| atlas_engine::invalid(&error.to_string()))?;
                let selection = relocation
                    .matched_entity_id
                    .as_ref()
                    .map(|matched| atlas_engine::bridge::selection(id, matched, "entity"));
                serde_json::to_value(serde_json::json!({
                    "relocation": atlas_engine::relocate::summary(&relocation),
                    "detail": relocation,
                    "selection": selection,
                    "note": "重定位只给出建议与依据，不改变任何已存记录；调用方决定是否采用。",
                }))
                .map_err(Into::into)
            }
            "scenarios" => {
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
                    "symbol": entity,
                    "scenarios": app.store.scenario_results(id, entity.as_deref(), q.limit.unwrap_or(50))?,
                }))
                .map_err(Into::into)
            }
            "scenario" => {
                let result = app
                    .store
                    .scenario_result(q.id.as_deref().or(q.entity.as_deref()).unwrap_or(""))
                    .map_err(|error| atlas_engine::invalid(&error.to_string()))?;
                if result["analysis_id"].as_str() != Some(id.as_str()) {
                    return Err(atlas_engine::invalid("scenario_belongs_to_another_analysis"));
                }
                serde_json::to_value(result).map_err(Into::into)
            }
            "run-markers" => {
                let markers = app.store.run_markers(id, q.limit.unwrap_or(200))?;
                serde_json::to_value(serde_json::json!({
                    "schema": "atlas.run-markers.v1",
                    "analysis_id": id,
                    "markers": markers,
                    "note": "这些是执行观测：某个入口被运行过并得到这个结论。它们不是调用路径，也不改变静态候选图。",
                }))
                .map_err(Into::into)
            }
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
        // A refusal has to be named. The resolver already says which one it is
        // -- "entity_not_found:<ref>", "ambiguous_entity:<ref>:<n>" -- and
        // collapsing every failure into one generic code threw away the only
        // part a caller can act on: "that entity is not in this analysis" and
        // "your query is malformed" are different answers, and a caller who
        // cannot tell them apart will retry the wrong one.
        Ok(Err(error)) => {
            let reason = match &error {
                atlas_engine::Error::Invalid(text) => text.clone(),
                other => other.to_string(),
            };
            let code = reason
                .split(':')
                .next()
                .unwrap_or("invalid_or_unavailable_query")
                .to_string();
            (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": code, "detail": reason})),
            )
                .into_response()
        }
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
endpoint!(search_nodes, "search");
endpoint!(node, "node");
endpoint!(edges, "edges");
endpoint!(reach, "reach");
endpoint!(source, "source");

/// `POST /api/context` accepts the entity as a query parameter (what the local
/// page sends) or as a JSON body (what a host client naturally sends). Both
/// resolve the same way; the body wins when both are present, and that rule is
/// written down here rather than left to whichever path ran first.
#[derive(Deserialize)]
struct ContextBody {
    entity: Option<String>,
}

async fn context_endpoint(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<Request>,
    body: Option<axum::Json<ContextBody>>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let reference = body
        .and_then(|axum::Json(body)| body.entity)
        .or(query.entity)
        .unwrap_or_default();
    let entity = match crate::runner::resolve_entity(&app.store, &app.analysis, &reference) {
        Ok(entity) => entity,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error})),
            )
                .into_response();
        }
    };
    match app.store.context(&app.analysis, &entity) {
        Ok(value) => axum::Json(value).into_response(),
        Err(_) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "invalid_or_unavailable_query"})),
        )
            .into_response(),
    }
}
endpoint!(flow, "flow");
endpoint!(flows, "flows");
endpoint!(profile, "profile");
endpoint!(exec_records, "exec-records");
endpoint!(run_markers, "run-markers");
endpoint!(relocate, "relocate");
endpoint!(scenarios, "scenarios");
endpoint!(scenario_detail, "scenario");
endpoint!(selection, "selection");
endpoint!(annotations, "annotations");
endpoint!(agent_requests, "agent-requests");
endpoint!(patches, "patches");
endpoint!(patch_detail, "patch");

#[derive(Deserialize)]
struct ProposeBody {
    entity: String,
    diff: String,
    summary: Option<String>,
}

/// Register a proposal over HTTP. This is the review surface's entry point: a
/// page may *register* a diff (which is an Intent and changes nothing), but
/// verifying and applying it stay on the CLI, where the person doing it can see
/// which directory is about to be written.
#[derive(Deserialize)]
struct PatchWriteBody {
    id: String,
    /// The absolute directory the page believes it is writing into. The write
    /// only happens if this equals the directory the operator named, so the page
    /// cannot target a path the operator never saw.
    confirm_path: String,
}

/// The shared gate for both write endpoints.
///
/// Returns the refused response boxed: a `Response` is much larger than the
/// directory it stands beside, and every caller turns the error straight into a
/// reply anyway.
fn write_gate(
    app: &App,
    confirm_path: &str,
) -> std::result::Result<std::path::PathBuf, Box<Response>> {
    let Some(root) = app.write_root.clone() else {
        return Err(Box::new(
            (
                StatusCode::FORBIDDEN,
                axum::Json(serde_json::json!({
                    "error": "http_writes_disabled",
                    "detail": "这个服务启动时没有 --allow-writes，因此 HTTP 不提供写路径；请在 CLI 上执行 atlas patch apply/revert。",
                })),
            )
                .into_response(),
        ));
    };
    if std::path::Path::new(confirm_path) != root {
        return Err(Box::new(
            (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({
                    "error": "confirmation_mismatch",
                    "expected": root.display().to_string(),
                    "got": confirm_path,
                    "detail": "写入只发生在启动时指定的那个目录；请求里的 confirm_path 必须与它逐字相同。",
                })),
            )
                .into_response(),
        ));
    }
    Ok(root)
}

async fn apply_patch(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<PatchWriteBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let root = match write_gate(&app, &body.confirm_path) {
        Ok(root) => root,
        Err(response) => return *response,
    };
    let store = app.store.clone();
    let owner = app.owner.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let proposal = store.patch_proposal(&body.id).map_err(|e| e.to_string())?;
        crate::patchwork::apply_proposal(&store, &proposal, &root, &owner)
    })
    .await;
    patch_write_response(outcome)
}

async fn revert_patch(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<PatchWriteBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let root = match write_gate(&app, &body.confirm_path) {
        Ok(root) => root,
        Err(response) => return *response,
    };
    let store = app.store.clone();
    let owner = app.owner.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let proposal = store.patch_proposal(&body.id).map_err(|e| e.to_string())?;
        // A revert writes back the bytes the proposal recorded, so the recorded
        // directory must be the one this server is allowed to write into. A
        // proposal applied somewhere else is not this server's to undo.
        let recorded = proposal
            .target
            .clone()
            .ok_or("proposal_has_no_target")
            .map(std::path::PathBuf::from)?;
        let recorded = recorded.canonicalize().unwrap_or_else(|_| recorded.clone());
        if recorded != root {
            return Err(format!(
                "revert_target_is_not_this_checkout:recorded={}:allowed={}",
                recorded.display(),
                root.display()
            ));
        }
        crate::patchwork::revert_proposal(&store, &proposal, &owner)
    })
    .await;
    patch_write_response(outcome)
}

/// One shape for both write outcomes: a refusal is a named error with the state
/// it refused from, never a 200 that reads as success.
fn patch_write_response(
    outcome: std::result::Result<
        std::result::Result<atlas_engine::patch::PatchProposal, String>,
        tokio::task::JoinError,
    >,
) -> Response {
    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": format!("patch_task_failed:{error}")})),
            )
                .into_response();
        }
    };
    match outcome {
        Ok(proposal) => match serde_json::to_vec(&serde_json::json!({"proposal": proposal})) {
            Ok(bytes) => (
                [
                    (header::CONTENT_TYPE, "application/json"),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                bytes,
            )
                .into_response(),
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response(),
        },
        Err(error) => (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    }
}

async fn propose_patch(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<ProposeBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    // A proposal that creates a file names a path with no entity yet; the same
    // resolver the CLI uses decides whether the diff really creates it.
    let entity = match crate::patchwork::resolve_proposal_entity(
        &app.store,
        &app.analysis,
        &body.entity,
        &body.diff,
    ) {
        Ok((entity, _adds_target)) => entity,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error})),
            )
                .into_response();
        }
    };
    let store = app.store.clone();
    let analysis = app.analysis.clone();
    let owner = app.owner.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        crate::patchwork::propose_from_diff(
            &store,
            &analysis,
            &entity,
            &body.diff,
            &owner,
            body.summary.as_deref(),
        )
    })
    .await;
    match outcome {
        Ok(Ok((proposal, created))) => {
            let rejected = proposal.state == "rejected";
            let payload = serde_json::json!({
                "outcome": if created { if rejected {"rejected"} else {"proposed"} } else {"already_proposed"},
                "proposal": proposal,
            });
            if rejected {
                (StatusCode::BAD_REQUEST, axum::Json(payload)).into_response()
            } else {
                axum::Json(payload).into_response()
            }
        }
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error})),
        )
            .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "propose failed").into_response(),
    }
}

#[derive(Deserialize)]
struct AnnotationRequest {
    entity: String,
    #[serde(default = "default_intent")]
    kind: String,
    body: String,
}

fn default_intent() -> String {
    "intent".into()
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
    // `proposed_by` is the session, not a string the caller chose: a page that
    // could claim authorship could attribute its own proposal to a person.
    match app
        .store
        .create_annotation(&selection, &request.kind, &request.body, &app.owner)
    {
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
        // The session is the owner. `owner` is deliberately absent from this
        // request type, so a page cannot address another owner's request
        // identity -- there is no field to read.
        owner: &app.owner,
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
    /// Run a nested function through its enclosing function. The symbol is
    /// resolved inside this analysis; the enclosing call's receiver stays
    /// unstated, exactly like the target's.
    #[serde(default)]
    via: Option<ViaRequest>,
    /// Ancestors above `via`, outermost first, for a closure nested more than
    /// one level deep. Each is resolved inside this analysis too.
    #[serde(default)]
    via_chain: Option<Vec<ViaRequest>>,
    /// The receiver for functions that read `this`. A declared *input*: it
    /// never widens the fs/child/network boundary, which stays server-side.
    #[serde(default)]
    this_arg: Option<serde_json::Value>,
    /// Named globals the analysis says this function reads, declared openly
    /// and recorded in the published spec. Same boundary rule as `this_arg`.
    #[serde(default)]
    globals: Option<std::collections::BTreeMap<String, serde_json::Value>>,
}

/// Page-triggered proposal verification. The page names a proposal; the
/// server owns every execution parameter (worker, Node, deadlines) and runs
/// the same `patch_verify` code path the CLI queue uses. First slice runs no
/// test unless an operator declared one: `test.ran:false` is the honest answer,
/// never "passed".
// A client may still send `request_key`; serde ignores unknown fields here.
// That is deliberate: a client-supplied key would fork the verification
// identity, and a status query built from a different key could never find the
// job it started. The persistent identity of a verification is
// (owner, analysis, proposal id), so submits, retries and status queries all
// converge on one row.
#[derive(serde::Deserialize)]
struct PatchVerifyRequest {
    id: String,
}

fn server_verify_options(proposal_id: &str) -> crate::StoredVerify {
    crate::StoredVerify {
        proposal_id: proposal_id.to_string(),
        node: "node".into(),
        worker: "workers/typescript/worker.mjs".into(),
        timeout_seconds: 60,
        scan_deadline_seconds: 300,
        index_deadline_seconds: 600,
        // No page-declared shell strings: a declared test stays an operator
        // decision made at startup, not something a page can attach.
        test_argv: None,
        test_timeout_ms: 120_000,
        worker_heap_mb: 1024,
    }
}

async fn patch_verify(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<PatchVerifyRequest>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let proposal = match app.store.patch_proposal(&request.id) {
        Ok(proposal) => proposal,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };
    if proposal.state != atlas_engine::patch::STATE_PROPOSED {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "error": "proposal_not_verifiable",
                "detail": format!("proposal_state:{}", proposal.state),
            })),
        )
            .into_response();
    }
    let stored = server_verify_options(&request.id);
    let options = serde_json::to_string(&stored)
        .map_err(|e| e.to_string())
        .unwrap_or_else(|e| format!("stored_verify_serialize_failed:{e}"));
    // Same derivation as the status endpoint reads back: one proposal, one
    // verification row per owner, whatever key a client sent along.
    let request_key = request.id.clone();
    let job_request = atlas_engine::job::JobRequest {
        kind: atlas_engine::job::KIND_PATCH_VERIFY,
        owner: &app.owner,
        project: &proposal.analysis_id,
        request_key: &request_key,
        root: "",
        options: &options,
    };
    let (row, created) = match app.store.enqueue_job(&job_request, 0) {
        Ok(pair) => pair,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };
    // The server is also the worker for its own queue: without this, a page
    // could only ever enqueue and wait for an external `job work` process.
    // Claiming by id means this runner cannot pick up anyone else's row.
    if created {
        let store = app.store.clone();
        let job_id = row.id.clone();
        tokio::spawn(async move {
            run_verify_job(store, job_id).await;
        });
    }
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({
            "outcome": if created { "queued" } else { "already_enqueued" },
            "job": row,
        })),
    )
        .into_response()
}

async fn run_verify_job(store: Store, job_id: String) {
    let holder = format!("server-{}", uuid::Uuid::new_v4());
    // A lease longer than the strictest deadline inside the request: the
    // in-process runner does not heartbeat, so the lease must outlive the work.
    let Some(job) = store.claim_job(&job_id, &holder, 900_000).unwrap_or(None) else {
        return; // already claimed elsewhere; that runner owns the outcome
    };
    let outcome = async {
        let stored: crate::StoredVerify = serde_json::from_str(
            job.options
                .as_deref()
                .ok_or_else(|| "job_has_no_stored_options".to_string())?,
        )
        .map_err(|e| format!("stored_verify_unreadable:{e}"))?;
        let options = stored
            .options()
            .map_err(|e| format!("stored_verify_invalid:{e}"))?;
        crate::patchwork::verify_proposal(&store, &stored.proposal_id, &options).await
    }
    .await;
    match outcome {
        Ok(proposal) => {
            let artifact = proposal["verification"]["patched_analysis_id"]
                .as_str()
                .map(str::to_string);
            let _ = store.finish_job(
                &job_id,
                &holder,
                atlas_engine::job::STATE_COMPLETED,
                None,
                artifact.as_deref(),
            );
        }
        Err(error) => {
            let _ = store.finish_job(
                &job_id,
                &holder,
                atlas_engine::job::STATE_FAILED,
                Some(&error),
                None,
            );
        }
    }
}

/// Owner-bound status: the page asks "what happened to my verification" by
/// proposal id. The job row carries the state machine, the proposal carries
/// the verification result once it exists.
async fn patch_verify_status(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<Request>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let Some(id) = q.id.as_deref().filter(|id| !id.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "id_required"})),
        )
            .into_response();
    };
    let proposal = match app.store.patch_proposal(id) {
        Ok(proposal) => proposal,
        Err(error) => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };
    let request_key = id.to_string();
    let job_id = atlas_engine::job::job_id(&app.owner, &proposal.analysis_id, &request_key);
    let job = app.store.job(&job_id).ok();
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({
            "proposal": proposal,
            "job": job,
        })),
    )
        .into_response()
}

/// Side-by-side execution: the same declared inputs run against the base
/// analysis and against a verified proposal's patched analysis. Both sides are
/// real isolated runs; the records keep their own analysis identities, so a
/// comparison can never overwrite either side.
#[derive(serde::Deserialize)]
struct ExecCompareRequest {
    entity: String,
    #[serde(default)]
    args: Vec<serde_json::Value>,
    proposal_id: String,
    timeout_ms: Option<u64>,
    allow_effects: Option<Vec<String>>,
}

async fn exec_compare(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<ExecCompareRequest>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let Ok(permit) = app.slots.clone().try_acquire_owned() else {
        return (StatusCode::TOO_MANY_REQUESTS, "busy").into_response();
    };
    let proposal = match app.store.patch_proposal(&request.proposal_id) {
        Ok(proposal) => proposal,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };
    if proposal.analysis_id != app.analysis {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "error": "proposal_from_other_analysis",
                "detail": format!("proposal pins {}, server serves {}", proposal.analysis_id, app.analysis),
            })),
        )
            .into_response();
    }
    let Some(verification) = proposal.verification.as_ref() else {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "error": "proposal_not_verified",
                "detail": "对照运行需要先完成隔离验证；没有补丁分析就无法运行补丁侧。",
            })),
        )
            .into_response();
    };
    let Some(patched_analysis) = verification["patched_analysis_id"]
        .as_str()
        .map(str::to_string)
    else {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({"error": "verification_has_no_patched_analysis"})),
        )
            .into_response();
    };
    let grants = Grants {
        fs_write: false,
        child_process: false,
        network: false,
        unknown_calls: request
            .allow_effects
            .as_ref()
            .is_some_and(|names| names.iter().any(|name| name == "unknown_calls")),
    };
    let grants_for_spec = grants.clone();
    let args_for_spec = request.args.clone();
    let mk_spec = move |analysis_id: String, symbol: String| {
        let args = args_for_spec.clone();
        RunSpec {
            schema: atlas_engine::exec::RUN_SPEC_SCHEMA.into(),
            analysis_id,
            symbol,
            args,
            timeout_ms: request.timeout_ms.unwrap_or(5_000).min(30_000),
            output_limit: 64 * 1024,
            grants: grants_for_spec.clone(),
            node: "node".into(),
            env: std::collections::BTreeMap::new(),
            this_arg: None,
            globals: std::collections::BTreeMap::new(),
            fixtures: false,
            fixture_note: None,
            label: Some("http-compare".into()),
            via: None,
            materialise: None,
            via_chain: Vec::new(),
        }
    };
    // The base side keeps the caller's entity reference; the patched side
    // resolves the same path:name in the patched tree, where byte positions
    // may have moved. A side that cannot resolve is a reported refusal, not a
    // fabricated result.
    let base_symbol =
        match crate::runner::resolve_symbol(&app.store, &app.analysis, &request.entity) {
            Ok(symbol) => symbol,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({"error": error})),
                )
                    .into_response();
            }
        };
    let base_node = match app.store.node(&app.analysis, &base_symbol) {
        Ok(node) => node,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };
    let patched_reference = format!("{}:{}", base_node.path, base_node.name);
    let patched_symbol =
        match crate::runner::resolve_symbol(&app.store, &patched_analysis, &patched_reference) {
            Ok(symbol) => Ok(symbol),
            Err(error) => Err(format!("patched_side_unresolved:{error}")),
        };
    let store = app.store.clone();
    let base_spec = mk_spec(app.analysis.clone(), base_symbol);
    let outcome = tokio::spawn(async move {
        let _permit = permit;
        let base_run = {
            let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
            crate::runner::execute(&store, &base_spec, cancel_rx)
                .await
                .map_err(|e| format!("base_side:{e}"))
        };
        let patched_run = match &patched_symbol {
            Ok(symbol) => {
                let spec = mk_spec(patched_analysis.clone(), symbol.clone());
                let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
                crate::runner::execute(&store, &spec, cancel_rx)
                    .await
                    .map_err(|e| format!("patched_side:{e}"))
            }
            Err(reason) => Err(reason.clone()),
        };
        (base_run, patched_run, patched_analysis)
    })
    .await;
    let (base_run, patched_run, patched_analysis) = match outcome {
        Ok(parts) => parts,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "compare failed").into_response();
        }
    };
    let side = |run: &Result<serde_json::Value, String>| match run {
        Ok(record) => serde_json::json!({"verdict": record["verdict"], "record": record}),
        Err(reason) => serde_json::json!({"refused": reason}),
    };
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({
            "schema": "atlas.exec-compare.v1",
            "entity": request.entity,
            "args": request.args,
            "base": side(&base_run),
            "patched": side(&patched_run),
            "base_analysis_id": app.analysis,
            "patched_analysis_id": patched_analysis,
        })),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
struct ViaRequest {
    symbol: String,
    #[serde(default)]
    args: Vec<serde_json::Value>,
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
        // The only grant that does not widen the process boundary is accepted
        // from the page. A receiver or a global is an input, and inputs are not
        // something a page states on someone else's behalf.
        unknown_calls: request
            .allow_effects
            .as_ref()
            .is_some_and(|names| names.iter().any(|name| name == "unknown_calls")),
    };
    let plan_only = request.plan;
    // Ancestors above the enclosing function, outermost first. Same rule as
    // `via`: the page names symbols, the analysis decides whether they are a
    // chain, and a receiver stays unstated.
    let via_chain = match request.via_chain {
        Some(chain) => {
            let mut resolved = Vec::new();
            for stage in chain.into_iter().take(atlas_engine::exec::MAX_VIA_CHAIN) {
                match crate::runner::resolve_symbol(&app.store, &app.analysis, &stage.symbol) {
                    Ok(symbol) => resolved.push(atlas_engine::exec::ViaSpec {
                        symbol,
                        args: stage.args.into_iter().take(64).collect(),
                        this_arg: None,
                    }),
                    Err(error) => {
                        return (
                            StatusCode::BAD_REQUEST,
                            axum::Json(serde_json::json!({"error": error})),
                        )
                            .into_response();
                    }
                }
            }
            resolved
        }
        None => Vec::new(),
    };
    let via = match request.via {
        Some(via) => match crate::runner::resolve_symbol(&app.store, &app.analysis, &via.symbol) {
            Ok(symbol) => Some(atlas_engine::exec::ViaSpec {
                symbol,
                args: via.args.into_iter().take(64).collect(),
                this_arg: None,
            }),
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({"error": error})),
                )
                    .into_response();
            }
        },
        None => None,
    };
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
        // A receiver or a global is an input the caller states. It is recorded
        // in the published spec and grants nothing: fs/child/network stay
        // governed by the server-built `grants` above.
        this_arg: request.this_arg,
        globals: request.globals.unwrap_or_default(),
        fixtures: request.fixtures,
        fixture_note: request.fixture_note,
        label: Some("http".into()),
        via,
        // The page does not choose the copy's extent: narrowing a read boundary
        // is a decision for whoever can see the record, not for a page that
        // states inputs for someone else's function.
        materialise: None,
        via_chain,
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

/// The host-facing contract, as data.
///
/// A host integration is only a seam if both sides can see the same list. This
/// table is the list: every entry names its transport, what it guarantees, and
/// what it does not. `scripts/test_host_adapter.py` reads it back and fails if
/// the adapter uses something that is not here, so the adapter cannot quietly
/// grow a dependency the service does not promise.
///
/// (name, method, transport, purpose, guarantee, limit)
const CONTRACT: &[(&str, &str, &str, &str, &str, &str)] = &[
    (
        "node",
        "GET",
        "http",
        "按身份取一个实体（符号 id、path:name 或裸名）",
        "只在这一份分析内解析；跨分析的名字不会被改指到当前版本的同名对象",
        "只返回单个对象，不做遍历；未命中就是未命中",
    ),
    (
        "contract",
        "GET",
        "http",
        "这份接口清单本身",
        "与实现同源，因此不会与实现漂移",
        "只描述接口，不构成产品验收",
    ),
    (
        "report",
        "GET",
        "http",
        "固定分析版本的元数据",
        "同一 analysis id 内容不可变",
        "只反映已发布的那个版本",
    ),
    (
        "nodes",
        "GET",
        "http",
        "分页读取对象",
        "快照内对象与版本绑定",
        "单页上限 500",
    ),
    (
        "edges",
        "GET",
        "http",
        "分页读取调用候选",
        "未解析目标以 target=null 保留，不丢弃",
        "单页上限 500",
    ),
    (
        "reach",
        "GET",
        "http",
        "有界多跳遍历",
        "显式 frontier 与 truncated",
        "预算内结果，不是执行顺序",
    ),
    (
        "flow",
        "GET",
        "http",
        "一个函数的 CFG/值来源/未知",
        "显式 unknown 与预算计数",
        "声明 profile 内的静态推导",
    ),
    (
        "flows",
        "GET",
        "http",
        "分页列出有 flow 事实的符号",
        "与 flow 同源",
        "单页上限 500",
    ),
    (
        "source",
        "GET",
        "http",
        "读取快照源码窗口",
        "字节来自不可变快照，读取时校验哈希",
        "单次上限 65536 字节",
    ),
    (
        "context",
        "POST",
        "http",
        "固定选区上下文导出",
        "内容寻址、可重复取回",
        "entity 可用查询参数或 JSON body 提供，body 优先；不自动发送给任何模型",
    ),
    (
        "profile",
        "GET",
        "http",
        "执行充分性分类",
        "每条理由带 evidence 字段",
        "静态分类，不是执行结果",
    ),
    (
        "run-markers",
        "GET",
        "http",
        "已运行过的入口（投影给视图用）",
        "只读投影，不改变静态候选图",
        "单次上限 500；只说明入口运行结论，不是调用路径",
    ),
    (
        "scenarios",
        "GET",
        "http",
        "已发布的场景结果（可按符号过滤）",
        "结果是证据：逐用例结局与计数",
        "单页上限 200",
    ),
    (
        "scenario",
        "GET",
        "http",
        "读取一份场景结果（`id=<场景 id>`）",
        "内容不可变；id 是结果摘要",
        "只含该分析的结果",
    ),
    (
        "relocate",
        "GET",
        "http",
        "把固定版本上的选区重定位到当前版本（`from=<分析 id>`）",
        "只给建议与依据；不确定就拒绝，绝不静默改指",
        "依据限于 path+name / 字节相同 / 仅同名；改名到无法识别即拒绝",
    ),
    (
        "exec-records",
        "GET",
        "http",
        "已发布的受控执行记录",
        "记录不可变，身份=问题+答案",
        "不含耗时与临时路径于身份",
    ),
    (
        "exec",
        "POST",
        "http",
        "隔离受控执行一次固定调用",
        "Node 权限模型强制，探针验证",
        "页面不能放宽沙箱；超时上限 30s",
    ),
    (
        "selection",
        "GET",
        "http",
        "钉定选区（实体+分析版本）",
        "版本相同是可判定的等式",
        "跨版本由调用方拒绝，不重指",
    ),
    (
        "annotations",
        "GET",
        "http",
        "读取 Intent 注解",
        "exists 恒为 false",
        "声明，不是事实",
    ),
    (
        "annotation",
        "POST",
        "http",
        "登记一条 Intent",
        "内容寻址、幂等",
        "不写源码",
    ),
    (
        "agent/requests",
        "GET",
        "http",
        "读取桥接请求队列",
        "终态与 terminal_reason 落库",
        "单页上限 200",
    ),
    (
        "agent/request",
        "POST",
        "http",
        "入队一个有界请求",
        "越界动作在入队时即被拒绝并记录",
        "analysis 由服务端钉定",
    ),
    (
        "agent/work",
        "POST",
        "http",
        "执行队列中的有界动作",
        "只做 inspect/annotate/propose_patch",
        "单次最多 32 个",
    ),
    (
        "patches",
        "GET",
        "http",
        "列出某个分析的提案",
        "提案内容不可变（diff 与校验结果）",
        "单页上限 100",
    ),
    (
        "patch",
        "GET",
        "http",
        "读取一份提案及其验证结果（`id=<提案 id>`）",
        "状态单向：proposed→verified→applied→reverted",
        "不含检出目录写入",
    ),
    (
        "patch/propose",
        "POST",
        "http",
        "登记一份统一 diff 提案并对固定快照校验",
        "与 CLI 同一校验路径；不匹配即拒绝",
        "不写源码；验证与应用只在 CLI；新建/删除与修改同一路径",
    ),
    (
        "patch propose",
        "CLI",
        "cli",
        "把统一 diff 登记为提案并对固定快照校验",
        "不匹配即带行拒绝",
        "支持修改/新建（--- /dev/null）/删除（+++ /dev/null）；重命名拒绝 rename_not_expressible_in_unified_diff",
    ),
    (
        "patch verify",
        "CLI",
        "cli",
        "隔离副本重新索引 + 图差异 + 声明的 argv 测试",
        "用户检出目录零改动",
        "可用 --enqueue 作为 patch_verify 作业排队，由 job work 用同一代码路径执行",
    ),
    (
        "patch apply",
        "CLI",
        "cli",
        "把已验证字节写入检出目录",
        "目标字节漂移即拒绝",
        "无备份/无合并/无文件锁",
    ),
    (
        "patch revert",
        "CLI",
        "cli",
        "恢复固定快照字节",
        "apply 之后被修改即拒绝",
        "同上",
    ),
    (
        "patch/apply",
        "POST",
        "http",
        "把已验证的提案写进检出目录",
        "只在启动时用 --allow-writes <目录> 指定的那一个目录内写入；请求必须回显该绝对路径",
        "未启用时一律 403 http_writes_disabled；按形式校验字节（新建要求路径为空）",
    ),
    (
        "patch/revert",
        "POST",
        "http",
        "撤销已应用的提案",
        "只撤销记录里那个目录，且必须等于启动时指定的目录",
        "撤销新建=删文件、撤销删除=按钉住字节恢复；目标被改动即拒绝",
    ),
];

fn contract(analysis: &str, write_root: Option<&std::path::Path>) -> serde_json::Value {
    let endpoints: Vec<serde_json::Value> = CONTRACT
        .iter()
        .map(|(name, method, transport, purpose, guarantee, limit)| {
            serde_json::json!({
                "name": name, "method": method, "transport": transport,
                "purpose": purpose, "guarantee": guarantee, "limit": limit,
            })
        })
        .collect();
    serde_json::json!({
        "schema": "atlas.host-contract.v1",
        "analysis_id": analysis,
        "engine": atlas_contract::ENGINE_VERSION,
        "transport": {
            "http": "loopback only; Bearer session token; Host must match; Origin, when present, must match",
            "cli": "local process; exit code is the verdict, stdout is JSON",
        },
        "endpoints": endpoints,
        "host_rules": [
            "宿主通过这个接口工作，不读取 Atlas 的存储文件；存储布局不是合同的一部分。",
            "任何写操作都在 Atlas 内部完成，宿主不直接改 Atlas 的数据。",
            "未解析、未知与截断必须原样呈现给最终用户，不能因为界面上不好看而丢掉。",
            "静态候选、静态推导与执行观测是三类证据，展示时必须能分辨。",
        ],
        "writes": {
            "enabled": write_root.is_some(),
            "root": write_root.map(|root| root.display().to_string()),
            "how_to_enable": "atlas --store S serve <analysis> --allow-writes <目录>",
            "scope": "只有 patch/apply 与 patch/revert；页面不能指定目录，只能在请求里回显这里给出的 root",
        },
        "qualification": "只描述本服务当前的接口；不构成完整 AL/ET/GE/MT/HI/DV 或成熟产品验收。",
    })
}

#[derive(Deserialize)]
struct ContractQuery {
    transport: Option<String>,
}

async fn contract_endpoint(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<ContractQuery>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let mut value = contract(&app.analysis, app.write_root.as_deref());
    if let Some(transport) = query.transport.as_deref()
        && let Some(list) = value["endpoints"].as_array()
    {
        let filtered: Vec<serde_json::Value> = list
            .iter()
            .filter(|entry| entry["transport"].as_str() == Some(transport))
            .cloned()
            .collect();
        value["endpoints"] = serde_json::Value::Array(filtered);
    }
    axum::Json(value).into_response()
}

fn asset(content: &'static str, mime: &'static str) -> Response {
    ([(header::CONTENT_TYPE,mime),(header::CACHE_CONTROL,"no-store"),(header::CONTENT_SECURITY_POLICY,"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"),(header::X_CONTENT_TYPE_OPTIONS,"nosniff")],content).into_response()
}

pub async fn serve(
    store: Store,
    analysis: String,
    port: u16,
    write_root: Option<std::path::PathBuf>,
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
        token: token.clone(),
        authority: address.to_string(),
        slots: Arc::new(Semaphore::new(8)),
        owner: format!("session-{}", &token[..12]),
        // Canonicalised once, at startup: every later comparison is between two
        // absolute paths, and a page cannot contribute to either.
        write_root: match write_root {
            Some(root) => Some(
                root.canonicalize()
                    .map_err(|error| format!("write_root_unreadable:{}:{error}", root.display()))?,
            ),
            None => None,
        },
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
        // The formal hierarchy is the one definition both projections read, so
        // it is served like any other asset: the pages load it before their own
        // script and neither page may carry a private copy of the levels.
        .route(
            "/hierarchy.js",
            get(|| async {
                asset(
                    include_str!("../../../web/hierarchy.js"),
                    "text/javascript; charset=utf-8",
                )
            }),
        )
        // Vendored layout engine, unmodified and pinned (see web/vendor/README.md).
        // It computes coordinates and nothing else: it never sees the analysis.
        .route(
            "/vendor/elk.bundled.js",
            get(|| async {
                asset(
                    include_str!("../../../web/vendor/elk.bundled.js"),
                    "text/javascript; charset=utf-8",
                )
            }),
        )
        .route(
            "/layout.js",
            get(|| async {
                asset(
                    include_str!("../../../web/layout.js"),
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
        .route("/api/search", get(search_nodes))
        .route("/api/node", get(node))
        .route("/api/edges", get(edges))
        .route("/api/reach", get(reach))
        .route("/api/source", get(source))
        .route("/api/context", post(context_endpoint))
        .route("/api/flow", get(flow))
        .route("/api/flows", get(flows))
        .route("/api/profile", get(profile))
        .route("/api/exec-records", get(exec_records))
        .route("/api/run-markers", get(run_markers))
        .route("/api/relocate", get(relocate))
        .route("/api/scenarios", get(scenarios))
        .route("/api/scenario", get(scenario_detail))
        .route("/api/exec", post(exec))
        .route("/api/selection", get(selection))
        .route("/api/annotations", get(annotations))
        .route("/api/annotation", post(annotate))
        .route("/api/agent/requests", get(agent_requests))
        .route("/api/agent/request", post(agent_request))
        .route("/api/agent/work", post(agent_work))
        // Review surface for the AI Coding chain: register and read proposals.
        // Verify (which re-indexes) and apply (which writes a checkout) stay on
        // the CLI.
        .route("/api/patches", get(patches))
        .route("/api/patch", get(patch_detail))
        .route("/api/patch/propose", post(propose_patch))
        // Writes exist only when the operator allowed them at startup, and even
        // then the page must echo the exact directory it was shown.
        .route(
            "/api/patch/verify",
            get(patch_verify_status).post(patch_verify),
        )
        .route("/api/exec-compare", post(exec_compare))
        .route("/api/patch/apply", post(apply_patch))
        .route("/api/patch/revert", post(revert_patch))
        // The seam, published as data so a host integration can be checked
        // against it instead of against prose.
        .route("/api/contract", get(contract_endpoint))
        .with_state(app);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    let _ = fs::remove_file(session_file);
    Ok(())
}

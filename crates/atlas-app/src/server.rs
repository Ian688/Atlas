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
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::Semaphore;

/// What the server itself needs in order to re-index a proposal's isolated
/// copy: the language worker and the declared test command.
///
/// These are operator decisions made at startup, not page inputs. A page may
/// ask for a verification but never gets to say which worker runs it or which
/// command counts as a test -- and because they are fixed here, a queued or
/// retried verification resolves the same resources as the first one instead
/// of depending on whoever happens to be asking.
#[derive(Clone)]
pub struct ServerConfig {
    pub node: PathBuf,
    pub worker: PathBuf,
    pub test_argv: Option<Vec<String>>,
    pub test_timeout_ms: u64,
    pub worker_heap_mb: u32,
    /// Response ceiling for the same worker, in MiB. The page's "打开并分析"
    /// re-indexes through this configuration, so a project the command line can
    /// index is a project the page can open.
    pub worker_output_mb: u32,
    /// How much of the project that re-index may capture. Same reason: a
    /// monorepo needs the budget raised once, at the server, not per page click.
    pub scan_limits: atlas_contract::ScanLimits,
    pub timeout_seconds: u64,
    pub scan_deadline_seconds: u64,
    pub index_deadline_seconds: u64,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            node: PathBuf::from("node"),
            worker: PathBuf::from("workers/typescript/worker.mjs"),
            test_argv: None,
            test_timeout_ms: 120_000,
            worker_heap_mb: 1024,
            worker_output_mb: crate::DEFAULT_WORKER_OUTPUT_MB,
            scan_limits: atlas_contract::ScanLimits::default(),
            timeout_seconds: 60,
            scan_deadline_seconds: 300,
            index_deadline_seconds: 600,
        }
    }
}

#[derive(Clone)]
struct App {
    store: Store,
    /// The analysis this service currently serves. Behind a shared cell because
    /// opening another project (or re-indexing after an apply) publishes a new
    /// immutable analysis and switches to it while running; every request
    /// resolves the id once, so a switch never re-anchors a query mid-flight.
    analysis: Arc<std::sync::RwLock<String>>,
    token: String,
    authority: String,
    slots: Arc<Semaphore>,
    /// The resources a verification runs with. Startup decisions by default;
    /// the local operator may update the declared test command from the page
    /// (`/api/project/settings`), and that update applies to every later
    /// verification the same way the startup flag did.
    verify: Arc<std::sync::RwLock<ServerConfig>>,
    /// 正在跑与刚跑完的受控执行句柄：取消与"离页后回来查结果"都靠它。
    runs: Arc<Runs>,
    /// 打开/切换项目的后台作业：索引有界，页面轮询状态或取消。
    opens: Arc<OpenOps>,
    /// 按需模型解释的进行中作业。句柄留在这里，取消才能到达子进程；结果本身
    /// 仍然写进 store，不在这里复制一份。
    llm_jobs: Arc<crate::llm::Jobs>,
    /// What the remembered task is keyed by. The served analysis by default;
    /// the project directory when the operator said which project this is, so
    /// re-indexing the same project does not read as a different task.
    /// Follows the served project when the page opens another one.
    project_key: Arc<std::sync::RwLock<String>>,
    /// The authenticated principal for everything that arrives over HTTP.
    ///
    /// The only identity this service can actually verify is "holds the session
    /// token", so that is the owner every request is attributed to. A page that
    /// declares a different owner is not believed -- letting one page write rows
    /// under another's name would make the owner column meaningless.
    owner: String,
    /// 当前项目的写授权目录。启动 --allow-writes 打开的是"本服务允许 HTTP 写入"
    /// 这个能力；具体写哪个目录跟随当前项目：页面以可写方式打开项目（明确的
    /// 本机操作者动作）时授权随之建立，切走即换。任何时刻至多一个目录可写，
    /// 因此查看 beta 时不可能把补丁写进 alpha。
    write_root: Arc<std::sync::RwLock<Option<std::path::PathBuf>>>,
    /// 启动时是否给了 --allow-writes。False 时任何请求都建立不了写授权。
    writes_capable: bool,
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
    /// `target=here`：按本服务授权目录列出已应用的提案（跨分析版本）。
    target: Option<String>,
    /// `/api/tree` 的父节点；缺省是项目根。
    parent: Option<String>,
    /// `/api/interpretations`、`/api/handoffs` 的跨版本身份。缺省由实体推导。
    anchor: Option<String>,
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
        let current = app.current_analysis();
        let id = &current;
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
            // 项目地图：按父节点加载直接成员。这是"不丢中间目录"的实现基础——
            // 页面按需展开，而不是一次读完整个项目再在前端过滤。
            "tree" => {
                let parent = q.parent.as_deref().or(q.entity.as_deref());
                let mut members = atlas_engine::tree::members(
                    &app.store,
                    id,
                    parent,
                    q.limit.unwrap_or(40),
                    q.cursor.as_deref(),
                )?;
                // 根节点用真实项目名，而不是目录节点里的空路径。
                if let Some(root) = members.root.as_mut() {
                    let key = app.current_project_key();
                    root.name = key
                        .rsplit('/')
                        .next()
                        .filter(|name| !name.is_empty())
                        .unwrap_or(&key)
                        .to_string();
                }
                serde_json::to_value(members).map_err(Into::into)
            }
            // 节点 i：算法摘要 + 源码注释。不需要模型。
            "knowledge" => {
                let raw = q.entity.as_deref().unwrap_or("");
                let entity = resolve_node_reference(&app, id, raw)?;
                crate::knowledge::knowledge(&app.store, id, &entity)
                    .map_err(|error| atlas_engine::invalid(&error))
            }
            // 解析记录按"项目 + 跨版本身份(anchor)"读取，因此同一个节点的旧修订
            // 在代码更新后仍然可见，并可以标记为待核对。
            "interpretations" => {
                let raw = q.entity.as_deref().unwrap_or("");
                let anchor = match q.anchor.as_deref() {
                    Some(anchor) => anchor.to_string(),
                    None => {
                        let entity = resolve_node_reference(&app, id, raw)?;
                        anchor_of(&app.store, id, &entity)?
                    }
                };
                serde_json::to_value(serde_json::json!({
                    "analysis_id": id,
                    "anchor": anchor,
                    "interpretations": app.store.interpretations(
                        &app.current_project_key(), &anchor, q.limit.unwrap_or(50))?,
                }))
                .map_err(Into::into)
            }
            "handoffs" => {
                let anchor = q.anchor.as_deref().unwrap_or("").to_string();
                serde_json::to_value(serde_json::json!({
                    "analysis_id": id,
                    "anchor": anchor,
                    "handoffs": app.store.handoffs(
                        &app.current_project_key(), &anchor, q.limit.unwrap_or(50))?,
                }))
                .map_err(Into::into)
            }
            // 批注可以挂在任意节点上（文件/目录/文档），不只是函数。
            "node-annotations" => {
                let raw = q.entity.as_deref().unwrap_or("");
                let entity = if raw.is_empty() {
                    None
                } else {
                    Some(resolve_node_reference(&app, id, raw)?)
                };
                serde_json::to_value(serde_json::json!({
                    "analysis_id": id,
                    "entity_id": entity,
                    "annotations": app.store.annotations(id, entity.as_deref(), q.limit.unwrap_or(50))?,
                }))
                .map_err(Into::into)
            }
            "patches" => {
                // `target=here`：列出"应用到了本服务授权目录"的提案，不限分析版本。
                // 应用 → 重新索引切换新版本之后，同一提案（撤销入口）必须仍然可达。
                // 路径由服务端自己填 write_root：页面指定不了别的目录。
                if q.target.as_deref() == Some("here") {
                    // 按当前项目的写授权目录归组：切换项目后，看到的都是这个项目自己的提案。
                    let Some(root) = app.current_write_root() else {
                        return Err(atlas_engine::invalid(
                            "no_write_root:当前项目没有写授权（以可写方式打开后才有应用记录）",
                        ));
                    };
                    return serde_json::to_value(serde_json::json!({
                        "analysis_id": id,
                        "entity_id": null,
                        "target": root.display().to_string(),
                        "proposals": app.store.patch_proposals_by_target(
                            &root.display().to_string(), q.limit.unwrap_or(50))?,
                    }))
                    .map_err(Into::into);
                }
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
endpoint!(tree, "tree");
endpoint!(knowledge, "knowledge");
endpoint!(interpretations, "interpretations");
endpoint!(handoffs, "handoffs");
endpoint!(node_annotations, "node-annotations");

/// The map addresses document sections by byte span (`section:<path>:<start>:<end>`),
/// which are content, not indexed nodes. Everything else resolves like any other
/// reference, so the page can pass a node id, a `path:name` or a bare name.
fn resolve_node_reference(
    app: &App,
    analysis: &str,
    raw: &str,
) -> Result<String, atlas_engine::Error> {
    if raw.starts_with("section:") {
        return Ok(raw.to_string());
    }
    crate::runner::resolve_entity(&app.store, analysis, raw).map_err(|e| atlas_engine::invalid(&e))
}

/// The identity an interpretation or handoff is filed under.
///
/// A symbol id embeds byte offsets, so it changes when the code above it moves.
/// The anchor deliberately drops the span and keeps path + name, which is what a
/// reader means by "the same function"; the record still stores the exact
/// `entity_id` and `basis_analysis` it was written against, so a later version
/// can be honest about what changed.
fn anchor_of(
    store: &Store,
    analysis: &str,
    entity: &str,
) -> Result<String, atlas_engine::Error> {
    if entity.starts_with("section:") {
        return Ok(entity.to_string());
    }
    let node = store.node(analysis, entity)?;
    Ok(match node.kind.as_str() {
        "function" => format!("symbol:{}:{}", node.path, node.name),
        "file" => format!("file:{}", node.path),
        "directory" => format!("dir:{}", node.path),
        _ => node.id.clone(),
    })
}

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
    let entity =
        match crate::runner::resolve_entity(&app.store, &app.current_analysis(), &reference) {
            Ok(entity) => entity,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({"error": error})),
                )
                    .into_response();
            }
        };
    match app.store.context(&app.current_analysis(), &entity) {
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
    let Some(root) = app.current_write_root() else {
        let detail = if app.writes_capable {
            "当前项目没有写授权：以可写方式重新打开这个项目后，应用/撤销才可用。"
        } else {
            "这个服务启动时没有 --allow-writes，因此 HTTP 不提供写路径；请在 CLI 上执行 atlas patch apply/revert。"
        };
        return Err(Box::new(
            (
                StatusCode::FORBIDDEN,
                axum::Json(serde_json::json!({
                    "error": "http_writes_disabled",
                    "detail": detail,
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
        &app.current_analysis(),
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
    let analysis = app.current_analysis();
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
    let symbol =
        match crate::runner::resolve_symbol(&app.store, &app.current_analysis(), &request.entity) {
            Ok(symbol) => symbol,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({"error": error})),
                )
                    .into_response();
            }
        };
    let selection = bridge::selection(&app.current_analysis(), &symbol, "entity");
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

// --- 节点知识：解析记录、批注与交接 -----------------------------------------
// 这三类都是"读者的记录"，不是分析事实。作者由会话决定，页面不能冒充他人；
// 记录里保留依据版本与来源引用，以便代码更新后标出"待核对"。

#[derive(Deserialize)]
struct InterpretationBody {
    entity: String,
    #[serde(default)]
    anchor: Option<String>,
    body: String,
    #[serde(default)]
    source_refs: Vec<String>,
    #[serde(default)]
    revises: Option<String>,
}

async fn save_interpretation(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<InterpretationBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let analysis = app.current_analysis();
    let entity = match resolve_node_reference(&app, &analysis, &request.entity) {
        Ok(entity) => entity,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };
    let anchor = match request.anchor {
        Some(anchor) => anchor,
        None => match anchor_of(&app.store, &analysis, &entity) {
            Ok(anchor) => anchor,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({"error": error.to_string()})),
                )
                    .into_response();
            }
        },
    };
    match app.store.create_interpretation(
        &app.current_project_key(),
        &anchor,
        &analysis,
        &entity,
        &app.owner,
        &request.body,
        &request.source_refs,
        request.revises.as_deref(),
    ) {
        Ok(record) => axum::Json(serde_json::json!({"outcome": "saved", "interpretation": record}))
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct NodeAnnotationBody {
    entity: String,
    #[serde(default = "default_intent")]
    kind: String,
    body: String,
}

/// A comment on any node, not only a function. It is stored as the same Intent
/// row the function-level endpoint writes, so there is one annotation concept.
async fn annotate_node(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<NodeAnnotationBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let analysis = app.current_analysis();
    let entity = match resolve_node_reference(&app, &analysis, &request.entity) {
        Ok(entity) => entity,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };
    let selection = bridge::selection(&analysis, &entity, "entity");
    match app
        .store
        .create_annotation(&selection, &request.kind, &request.body, &app.owner)
    {
        Ok((annotation, created)) => axum::Json(serde_json::json!({
            "outcome": if created { "created" } else { "already_proposed" },
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
struct HandoffBody {
    #[serde(default)]
    id: Option<String>,
    entity: String,
    #[serde(default)]
    anchor: Option<String>,
    #[serde(default)]
    title: Option<String>,
    goal: String,
    #[serde(default)]
    scope: Option<serde_json::Value>,
    #[serde(default)]
    annotations: Vec<String>,
}

async fn save_handoff(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<HandoffBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let analysis = app.current_analysis();
    let entity = match resolve_node_reference(&app, &analysis, &request.entity) {
        Ok(entity) => entity,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response();
        }
    };
    let anchor = match request.anchor {
        Some(anchor) => anchor,
        None => match anchor_of(&app.store, &analysis, &entity) {
            Ok(anchor) => anchor,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({"error": error.to_string()})),
                )
                    .into_response();
            }
        },
    };
    let default_title = app
        .store
        .node(&analysis, &entity)
        .map(|node| node.name)
        .unwrap_or_else(|_| {
            entity
                .rsplit(':')
                .find(|part| !part.is_empty())
                .unwrap_or(&entity)
                .to_string()
        });
    let title = request
        .title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| format!("{default_title} 的交接"));
    let scope = request.scope.unwrap_or_else(|| {
        serde_json::json!({"analysis_id": analysis, "entity_id": entity})
    });
    match app.store.save_handoff(
        request.id.as_deref(),
        &app.current_project_key(),
        &analysis,
        &entity,
        &anchor,
        &app.owner,
        &title,
        &request.goal,
        &scope,
        &request.annotations,
    ) {
        Ok(handoff) => axum::Json(serde_json::json!({"outcome": "saved", "handoff": handoff}))
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct HandoffMessageBody {
    id: String,
    text: String,
}

async fn handoff_message(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<HandoffMessageBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    // 消息只追加到已有交接上，作者是会话；页面不能改写他人记录。
    match app
        .store
        .append_handoff_message(&request.id, &app.owner, &request.text)
    {
        Ok(handoff) => axum::Json(serde_json::json!({"outcome": "appended", "handoff": handoff}))
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct HandoffExportBody {
    id: String,
}

async fn handoff_exported(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<HandoffExportBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    // 复制/导出是本地动作，服务端只记"已经导出"，不把复制当成已发送。
    match app.store.mark_handoff_exported(&request.id) {
        Ok(handoff) => axum::Json(serde_json::json!({"outcome": "exported", "handoff": handoff}))
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct HandoffProposalBody {
    id: String,
    proposal_id: String,
}

/// Link a real proposal to a handoff. The proposal must belong to the analysis
/// this service is serving: a handoff cannot claim a diff from another version.
async fn handoff_proposal(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(request): axum::Json<HandoffProposalBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
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
    if proposal.analysis_id != app.current_analysis() {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "error": "proposal_belongs_to_another_analysis",
                "detail": format!(
                    "proposal pins {}, server serves {}",
                    proposal.analysis_id,
                    app.current_analysis()
                ),
            })),
        )
            .into_response();
    }
    match app
        .store
        .link_handoff_proposal(&request.id, &request.proposal_id)
    {
        Ok(handoff) => axum::Json(serde_json::json!({"outcome": "linked", "handoff": handoff}))
            .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

// ===== 按需 LLM 解释（M5） ==================================================
//
// 模型解释不是 Atlas 的内置能力，也不由页面直接发起：连接是按项目保存的配置，
// 请求只对"用户点了生成"发生，并且始终经一个独立进程发出。没有配置时下面所有
// 端点都如实报未配置，绝不返回固定文本冒充生成结果。

#[derive(Deserialize)]
struct LlmExplainBody {
    entity: String,
    #[serde(default)]
    question: String,
}

#[derive(Deserialize)]
struct LlmIdBody {
    id: String,
}

/// 当前项目的模型连接。返回体里永远没有 api_key，只有"是否配置过"。
async fn llm_config_get(State(app): State<App>, headers: HeaderMap) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let store = app.store.clone();
    let key = app.current_project_key();
    axum::Json(tokio::task::block_in_place(|| crate::llm::describe(&store, &key))).into_response()
}

/// 清除当前项目的模型连接，连保存的 key 一起删掉。
async fn llm_config_delete(State(app): State<App>, headers: HeaderMap) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let store = app.store.clone();
    let key = app.current_project_key();
    axum::Json(tokio::task::block_in_place(|| crate::llm::clear(&store, &key))).into_response()
}

async fn llm_config_put(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<crate::llm::ConfigBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let store = app.store.clone();
    let key = app.current_project_key();
    match tokio::task::block_in_place(|| crate::llm::configure(&store, &key, &body)) {
        Ok(value) => axum::Json(value).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    }
}

/// 发送前的范围预览：把将要离开本机的片段逐条列出来，并给出字节数。
async fn llm_context(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<Request>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let analysis = app.current_analysis();
    let entity = match resolve_node_reference(&app, &analysis, &query.entity.clone().unwrap_or_default())
    {
        Ok(entity) => entity,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response()
        }
    };
    let store = app.store.clone();
    let key = app.current_project_key();
    let question = query.q.clone().unwrap_or_default();
    match tokio::task::block_in_place(|| {
        let config = crate::llm::load(&store, &key);
        crate::llm::preview(&store, &analysis, &entity, config.as_ref(), &question)
    }) {
        Ok(value) => axum::Json(value).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    }
}

/// 一次显式生成。返回作业 id；状态、正文、失败原因都从 store 读回。
async fn llm_explain(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<LlmExplainBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let analysis = app.current_analysis();
    let entity = match resolve_node_reference(&app, &analysis, &body.entity) {
        Ok(entity) => entity,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response()
        }
    };
    let anchor = match anchor_of(&app.store, &analysis, &entity) {
        Ok(anchor) => anchor,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response()
        }
    };
    let key = app.current_project_key();
    let store = app.store.clone();
    let config = match tokio::task::block_in_place(|| crate::llm::load(&store, &key)) {
        Some(config) => config,
        None => {
            return (
                StatusCode::CONFLICT,
                axum::Json(serde_json::json!({
                    "error": "llm_not_configured",
                    "detail": "还没有配置模型连接；算法摘要与源码注释不依赖它，可以先继续用。",
                })),
            )
                .into_response()
        }
    };
    if !config.is_configured() {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "error": "llm_not_configured",
                "detail": "配置不完整：需要 base_url、model 与一个存在的适配器命令。",
            })),
        )
            .into_response();
    }
    match crate::llm::spawn(
        app.store.clone(),
        app.llm_jobs.clone(),
        key,
        anchor,
        analysis,
        entity,
        config,
        body.question.clone(),
    ) {
        Ok(id) => axum::Json(serde_json::json!({
            "schema": "atlas.llm.v1",
            "id": id,
            "state": "running",
            "note": "生成中。离开页面不会丢：结果写进 store，可以按 id 读回。",
        }))
        .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    }
}

async fn llm_explain_status(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<Request>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let Some(id) = query.id.as_deref().filter(|id| !id.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "id_required"})),
        )
            .into_response();
    };
    let store = app.store.clone();
    match tokio::task::block_in_place(|| crate::llm::job(&store, id)) {
        Some(row) => axum::Json(serde_json::json!({"schema": "atlas.llm.v1", "job": row})).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "llm_job_not_found", "id": id})),
        )
            .into_response(),
    }
}

async fn llm_explain_cancel(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<LlmIdBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let store = app.store.clone();
    let jobs = app.llm_jobs.clone();
    let sent = tokio::task::block_in_place(|| crate::llm::cancel_job(&jobs, &store, &body.id));
    axum::Json(serde_json::json!({
        "schema": "atlas.llm.v1",
        "id": body.id,
        "cancelled": sent,
        "note": if sent { "取消信号已发出；子进程被终止后状态才是 cancelled。" } else { "这个作业已经结束，或不在本轮会话里，没有可取消的进程。" },
    }))
    .into_response()
}

/// 这个节点已经生成过的解释，最新在前。它们与用户保存的解析记录分开存放。
async fn llm_explanations(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<Request>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let analysis = app.current_analysis();
    let entity = match resolve_node_reference(&app, &analysis, &query.entity.clone().unwrap_or_default())
    {
        Ok(entity) => entity,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response()
        }
    };
    let anchor = match anchor_of(&app.store, &analysis, &entity) {
        Ok(anchor) => anchor,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response()
        }
    };
    let store = app.store.clone();
    let key = app.current_project_key();
    let rows = tokio::task::block_in_place(|| store.llm_explanations(&key, &anchor, 10))
        .unwrap_or_default();
    axum::Json(serde_json::json!({
        "schema": "atlas.llm.v1",
        "entity_id": entity,
        "analysis_id": analysis,
        "explanations": rows,
        "note": "模型解释：不是 Atlas 的分析结论，也不是你保存的解析记录。",
    }))
    .into_response()
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
            match crate::runner::resolve_symbol(&app.store, &app.current_analysis(), &reference) {
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
        analysis_id: &app.current_analysis(),
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
    /// 后台执行：立刻拿到 run id，执行在服务端继续，页面可以离开、取消或回来查结果。
    #[serde(default)]
    background: bool,
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

impl App {
    fn current_analysis(&self) -> String {
        self.analysis
            .read()
            .map(|id| id.clone())
            .unwrap_or_default()
    }
    fn current_project_key(&self) -> String {
        self.project_key
            .read()
            .map(|key| key.clone())
            .unwrap_or_default()
    }
    /// 当前项目的写授权目录；None 表示当前项目不可写（或服务没有写能力）。
    fn current_write_root(&self) -> Option<std::path::PathBuf> {
        self.write_root.read().ok().and_then(|root| root.clone())
    }
    fn set_write_root(&self, root: Option<std::path::PathBuf>) {
        if let Ok(mut slot) = self.write_root.write() {
            *slot = root;
        }
    }
    fn verify_config(&self) -> ServerConfig {
        self.verify
            .read()
            .map(|config| config.clone())
            .unwrap_or_default()
    }
    /// The verification a page may trigger runs with the resources *this
    /// server* was started with. Nothing here comes from the request: a page
    /// cannot point a verification at another worker, and a retry or a queued
    /// run resolves the same one the first attempt used.
    fn server_verify_options(&self, proposal_id: &str) -> crate::StoredVerify {
        let verify = self.verify_config();
        crate::StoredVerify {
            proposal_id: proposal_id.to_string(),
            node: verify.node.display().to_string(),
            worker: verify.worker.display().to_string(),
            timeout_seconds: verify.timeout_seconds,
            scan_deadline_seconds: verify.scan_deadline_seconds,
            index_deadline_seconds: verify.index_deadline_seconds,
            // An operator decision made at startup (or updated by the local
            // operator from the project page). When nothing was declared the
            // verification says no test ran, which is not the same as a pass.
            test_argv: verify.test_argv.clone(),
            test_timeout_ms: verify.test_timeout_ms,
            worker_heap_mb: verify.worker_heap_mb,
            worker_output_mb: verify.worker_output_mb,
            scan_limits: verify.scan_limits,
        }
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
    let stored = app.server_verify_options(&request.id);
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
    // A verification that failed is retryable, and "try again" is the natural
    // next thing to ask for: the historical `worker_missing` left the row
    // failed, and a page that could only ever enqueue once would have to be
    // restarted to get a second attempt. Claiming is what increments the
    // attempt, so a failed or cancelled row is re-claimed here; a row that is
    // already queued, running or completed keeps its single runner.
    let retrying = !created
        && matches!(
            row.state.as_str(),
            atlas_engine::job::STATE_FAILED | atlas_engine::job::STATE_CANCELLED
        );
    // The server is also the worker for its own queue: without this, a page
    // could only ever enqueue and wait for an external `job work` process.
    // Claiming by id means this runner cannot pick up anyone else's row.
    if created || retrying {
        let store = app.store.clone();
        let job_id = row.id.clone();
        tokio::spawn(async move {
            run_verify_job(store, job_id).await;
        });
    }
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({
            "outcome": if created { "queued" } else if retrying { "retrying" } else { "already_enqueued" },
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

/// Where a person left off.
///
/// A browser tab's own storage is keyed by origin, and the port is chosen at
/// startup, so a restart is a different origin and therefore a different
/// storage: the selection, the open task tab and the input drafts were all
/// lost exactly when someone stopped and restarted the service. Remembering
/// them here, keyed by analysis and an explicit name, keeps the task across a
/// restart and keeps two projects apart even when they contain a function with
/// the same name.
///
/// It is a scratchpad, not a fact: last write wins, and nothing published is
/// read from it.
#[derive(Deserialize)]
struct UiStateQuery {
    name: Option<String>,
}

#[derive(Deserialize)]
struct UiStateBody {
    name: Option<String>,
    state: serde_json::Value,
}

/// The key a page may address. The analysis is the server's, so a page can
/// never reach another project's state by asking for another name.
fn ui_state_key(project: &str, name: Option<&str>) -> String {
    let name = name.unwrap_or("workbench");
    let clean: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    format!(
        "{}|{}",
        project,
        if clean.is_empty() {
            "workbench"
        } else {
            &clean
        }
    )
}

async fn ui_state_get(
    State(app): State<App>,
    headers: HeaderMap,
    Query(query): Query<UiStateQuery>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let key = ui_state_key(&app.current_project_key(), query.name.as_deref());
    let store = app.store.clone();
    let outcome = tokio::task::spawn_blocking(move || store.ui_state(&key)).await;
    match outcome {
        Ok(Ok(state)) => axum::Json(serde_json::json!({
            "schema": "atlas.ui-state.v1",
            "analysis_id": app.current_analysis(),
            "state": state,
        }))
        .into_response(),
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "ui state read failed").into_response(),
    }
}

async fn ui_state_put(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<UiStateBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let key = ui_state_key(&app.current_project_key(), body.name.as_deref());
    let store = app.store.clone();
    let outcome = tokio::task::spawn_blocking(move || store.set_ui_state(&key, &body.state)).await;
    match outcome {
        Ok(Ok(())) => axum::Json(serde_json::json!({
            "schema": "atlas.ui-state.v1",
            "analysis_id": app.current_analysis(),
            "saved": true,
        }))
        .into_response(),
        Ok(Err(error)) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "ui state write failed").into_response(),
    }
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
    /// The receiver, when the function reads `this`. An input, like `args`:
    /// a comparison that silently dropped it would run a different question on
    /// each side, or on one side only.
    #[serde(default)]
    this_arg: Option<serde_json::Value>,
    /// Named globals the analysis says this function reads. Same rule as
    /// `this_arg`: a declared input has to reach both sides, not just the one
    /// where it happens to be recorded.
    #[serde(default)]
    globals: Option<std::collections::BTreeMap<String, serde_json::Value>>,
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
    if proposal.analysis_id != app.current_analysis() {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "error": "proposal_from_other_analysis",
                "detail": format!("proposal pins {}, server serves {}", proposal.analysis_id, app.current_analysis()),
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
    let this_for_spec = request.this_arg.clone();
    let globals_for_spec = request.globals.clone().unwrap_or_default();
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
            // The same declared inputs on both sides. Comparing a receiver or
            // a global on one side and not the other would not be a comparison
            // of the change; it would be a comparison of two questions.
            this_arg: this_for_spec.clone(),
            globals: globals_for_spec.clone(),
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
        match crate::runner::resolve_symbol(&app.store, &app.current_analysis(), &request.entity) {
            Ok(symbol) => symbol,
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({"error": error})),
                )
                    .into_response();
            }
        };
    let base_node = match app.store.node(&app.current_analysis(), &base_symbol) {
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
    let base_spec = mk_spec(app.current_analysis(), base_symbol);
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
            "declared_inputs": {
                "args": request.args,
                "this_arg": request.this_arg,
                "globals": request.globals,
                "note": "两侧使用同一份声明输入；这里回显实际发出的内容，便于核对没有被丢弃的输入。",
            },
            "base": side(&base_run),
            "patched": side(&patched_run),
            "base_analysis_id": app.current_analysis(),
            "patched_analysis_id": patched_analysis,
        })),
    )
        .into_response()
}

/// 正在运行、以及刚跑完的受控执行。
///
/// 一次执行就是服务端的一个子进程。做成"一个 HTTP 请求从头等到尾"意味着
/// 关掉页面就再也够不到那个进程：取消无处发送，结果也没人能读回来。这里
/// 只保存句柄与终态；执行记录本身仍然由 runner 发布到 store，不在这里复制。
#[derive(Default)]
struct Runs {
    slots: std::sync::Mutex<std::collections::HashMap<String, RunSlot>>,
}
struct RunSlot {
    cancel: tokio::sync::watch::Sender<bool>,
    terminal: Option<serde_json::Value>,
    /// 谁在跑：任务面板要按对象展示运行，而不是只给一串裸 id。
    symbol: String,
    analysis: String,
    started_ms: u64,
}
/// 一轮会话里保留多少个执行句柄。超出时丢掉最旧的终态记录；正在跑的不动。
const RUN_SLOTS_MAX: usize = 64;

/// 任务面板用的摘要：状态只有服务端发布的三种终态，或在跑。
struct RunSummary {
    id: String,
    symbol: String,
    analysis: String,
    started_ms: u64,
    state: &'static str,
    verdict: Option<String>,
}

impl Runs {
    fn start(&self, id: &str, symbol: &str, analysis: &str) -> tokio::sync::watch::Receiver<bool> {
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        if let Ok(mut slots) = self.slots.lock() {
            if slots.len() >= RUN_SLOTS_MAX {
                let finished: Vec<String> = slots
                    .iter()
                    .filter(|(_, slot)| slot.terminal.is_some())
                    .map(|(key, _)| key.clone())
                    .collect();
                for key in finished.into_iter().take(RUN_SLOTS_MAX / 2) {
                    slots.remove(&key);
                }
            }
            slots.insert(
                id.to_string(),
                RunSlot {
                    cancel,
                    terminal: None,
                    symbol: symbol.to_string(),
                    analysis: analysis.to_string(),
                    started_ms: now_ms(),
                },
            );
        }
        receiver
    }
    fn finish(&self, id: &str, value: serde_json::Value) {
        if let Ok(mut slots) = self.slots.lock()
            && let Some(slot) = slots.get_mut(id)
        {
            slot.terminal = Some(value);
        }
    }
    /// `None` 表示这个 id 从来没存在过；`Some(None)` 表示还在跑。
    fn terminal(&self, id: &str) -> Option<Option<serde_json::Value>> {
        self.slots
            .lock()
            .ok()
            .and_then(|slots| slots.get(id).map(|slot| slot.terminal.clone()))
    }
    fn cancel(&self, id: &str) -> Option<bool> {
        self.slots.lock().ok().and_then(|slots| {
            slots.get(id).map(|slot| {
                // 取消是协作式的：这里只是把信号发出去，进程由 runner 按进程组
                // 结束并发布 cancelled 记录。所以立即回答"取消中"，终态以记录为准。
                slot.cancel.send(true).is_ok()
            })
        })
    }
    /// 全部句柄的状态。终态里的 verdict 覆盖 running 之外的三种：completed /
    /// failed / cancelled 都来自 runner 发布的记录，不是猜测。
    fn list(&self) -> Vec<RunSummary> {
        let slots = match self.slots.lock() {
            Ok(slots) => slots,
            Err(_) => return Vec::new(),
        };
        let mut rows: Vec<RunSummary> = slots
            .iter()
            .map(|(id, slot)| {
                let verdict = slot
                    .terminal
                    .as_ref()
                    .and_then(|record| record["verdict"].as_str().map(str::to_string));
                let state = if slot.terminal.is_none() {
                    "running"
                } else {
                    match verdict.as_deref() {
                        Some("cancelled") => "cancelled",
                        Some("failed") => "failed",
                        _ => "completed",
                    }
                };
                RunSummary {
                    id: id.clone(),
                    symbol: slot.symbol.clone(),
                    analysis: slot.analysis.clone(),
                    started_ms: slot.started_ms,
                    state,
                    verdict,
                }
            })
            .collect();
        rows.sort_by_key(|run| std::cmp::Reverse(run.started_ms));
        rows
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// 打开/切换项目的后台作业。索引是有界工作（deadline 与取消通道），页面拿着
/// op id 轮询状态；切换完成时服务真正换到新分析，而不是只改页面标题。
#[derive(Default)]
struct OpenOps {
    slots: std::sync::Mutex<std::collections::HashMap<String, OpenSlot>>,
}
struct OpenSlot {
    cancel: tokio::sync::watch::Sender<bool>,
    path: String,
    state: &'static str,
    analysis: Option<String>,
    error: Option<String>,
    started_ms: u64,
}

/// 打开作业的状态元组：路径、状态、产出的分析、错误、开始时间。
type OpenStatus = (String, &'static str, Option<String>, Option<String>, u64);

impl OpenOps {
    fn start(&self, id: &str, path: &str) -> tokio::sync::watch::Receiver<bool> {
        let (cancel, receiver) = tokio::sync::watch::channel(false);
        if let Ok(mut slots) = self.slots.lock() {
            // 一轮会话保留有限个作业；只淘汰已终态的旧记录。
            if slots.len() >= 16 {
                let finished: Vec<String> = slots
                    .iter()
                    .filter(|(_, slot)| slot.state != "indexing")
                    .map(|(key, _)| key.clone())
                    .collect();
                for key in finished.into_iter().take(8) {
                    slots.remove(&key);
                }
            }
            slots.insert(
                id.to_string(),
                OpenSlot {
                    cancel,
                    path: path.to_string(),
                    state: "indexing",
                    analysis: None,
                    error: None,
                    started_ms: now_ms(),
                },
            );
        }
        receiver
    }
    fn set_state(
        &self,
        id: &str,
        state: &'static str,
        analysis: Option<String>,
        error: Option<String>,
    ) {
        if let Ok(mut slots) = self.slots.lock()
            && let Some(slot) = slots.get_mut(id)
        {
            slot.state = state;
            slot.analysis = analysis;
            slot.error = error;
        }
    }
    fn status(&self, id: &str) -> Option<OpenStatus> {
        self.slots.lock().ok().and_then(|slots| {
            slots.get(id).map(|slot| {
                (
                    slot.path.clone(),
                    slot.state,
                    slot.analysis.clone(),
                    slot.error.clone(),
                    slot.started_ms,
                )
            })
        })
    }
    fn cancel(&self, id: &str) -> Option<bool> {
        self.slots
            .lock()
            .ok()
            .and_then(|slots| slots.get(id).map(|slot| slot.cancel.send(true).is_ok()))
    }
}

/// 最近项目列表存放在 store 根目录：本机数据，随服务可读；不属于任何合同。
const PROJECTS_FILE: &str = "projects.json";
const PROJECTS_MAX: usize = 8;

fn load_projects(store: &Store) -> Vec<serde_json::Value> {
    let Ok(text) = fs::read_to_string(store.root.join(PROJECTS_FILE)) else {
        return Vec::new();
    };
    serde_json::from_str(&text)
        .ok()
        .and_then(|value: serde_json::Value| {
            value
                .get("projects")
                .and_then(|list| list.as_array().cloned())
        })
        .unwrap_or_default()
}

fn save_projects(store: &Store, projects: &[serde_json::Value]) {
    let value = serde_json::json!({"schema": "atlas.projects.v1", "projects": projects});
    if let Ok(bytes) = serde_json::to_vec_pretty(&value) {
        let _ = fs::write(store.root.join(PROJECTS_FILE), bytes);
    }
}

fn remember_project(store: &Store, path: &str, analysis: &str, write: bool) {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|name| name.display().to_string())
        .unwrap_or_else(|| path.to_string());
    let mut projects: Vec<serde_json::Value> = load_projects(store)
        .into_iter()
        .filter(|entry| entry.get("path").and_then(|p| p.as_str()) != Some(path))
        .collect();
    projects.insert(
        0,
        serde_json::json!({
            "path": path,
            "name": name,
            "analysis_id": analysis,
            "opened_ms": now_ms(),
            "write": write,
        }),
    );
    projects.truncate(PROJECTS_MAX);
    save_projects(store, &projects);
}

fn project_record_by_analysis(store: &Store, analysis: &str) -> Option<(String, bool)> {
    load_projects(store)
        .into_iter()
        .find(|entry| entry.get("analysis_id").and_then(|a| a.as_str()) == Some(analysis))
        .and_then(|entry| {
            let path = entry.get("path").and_then(|p| p.as_str())?.to_string();
            let write = entry
                .get("write")
                .and_then(|w| w.as_bool())
                .unwrap_or(false);
            Some((path, write))
        })
}

/// 把一次执行跑成后台任务，句柄留在 `runs` 里等页面来问。
fn spawn_run(store: Store, runs: Arc<Runs>, run_id: String, spec: RunSpec) {
    let cancel_rx = runs.start(&run_id, &spec.symbol, &spec.analysis_id);
    tokio::spawn(async move {
        let record = match crate::runner::execute(&store, &spec, cancel_rx).await {
            Ok(record) => record,
            Err(error) => serde_json::json!({"verdict": "failed", "error": error}),
        };
        runs.finish(&run_id, record);
    });
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
    let symbol =
        match crate::runner::resolve_symbol(&app.store, &app.current_analysis(), &request.symbol) {
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
                match crate::runner::resolve_symbol(
                    &app.store,
                    &app.current_analysis(),
                    &stage.symbol,
                ) {
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
        Some(via) => {
            match crate::runner::resolve_symbol(&app.store, &app.current_analysis(), &via.symbol) {
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
            }
        }
        None => None,
    };
    let spec = RunSpec {
        schema: atlas_engine::exec::RUN_SPEC_SCHEMA.into(),
        analysis_id: app.current_analysis(),
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
    if request.background && !plan_only {
        // 后台执行：请求立刻返回 run id。页面可以离开、回来查状态、或者取消；
        // 取消等到 runner 真的按进程组结束进程并发布 cancelled 记录才算终态。
        let run_id = uuid::Uuid::new_v4().simple().to_string();
        spawn_run(store, app.runs.clone(), run_id.clone(), spec);
        return axum::Json(serde_json::json!({
            "schema": "atlas.exec-run.v1",
            "run_id": run_id,
            "state": "running",
            "note": "执行在服务端继续；GET /api/exec/run?id= 查状态，POST /api/exec/cancel 取消。",
        }))
        .into_response();
    }
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

/// 后台执行的状态：只有服务端记录的终态才算终态。
async fn exec_run_status(
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
    match app.runs.terminal(id) {
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "run_not_found", "run_id": id})),
        )
            .into_response(),
        Some(None) => axum::Json(serde_json::json!({
            "schema": "atlas.exec-run.v1",
            "run_id": id,
            "state": "running",
        }))
        .into_response(),
        Some(Some(record)) => {
            let verdict = record["verdict"].as_str().unwrap_or("");
            let state = match verdict {
                "cancelled" => "cancelled",
                "failed" => "failed",
                _ => "completed",
            };
            axum::Json(serde_json::json!({
                "schema": "atlas.exec-run.v1",
                "run_id": id,
                "state": state,
                "record": record,
                "note": "state 来自 runner 发布的执行记录，不是 HTTP 连接的状态。",
            }))
            .into_response()
        }
    }
}

#[derive(serde::Deserialize)]
struct RunCancelBody {
    id: String,
}

/// 取消一次后台执行。回答是"取消中"：进程按进程组结束、记录发布之后才算终态。
async fn exec_cancel(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<RunCancelBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    match app.runs.cancel(&body.id) {
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "run_not_found", "run_id": body.id})),
        )
            .into_response(),
        Some(_) => axum::Json(serde_json::json!({
            "schema": "atlas.exec-run.v1",
            "run_id": body.id,
            "state": "cancelling",
            "note": "取消信号已发出；等 runner 结束进程并发布记录后，run 状态才变成 cancelled。",
        }))
        .into_response(),
    }
}

/// 后台执行清单：任务面板按对象展示在途与刚完成的运行。
async fn exec_runs_list(State(app): State<App>, headers: HeaderMap) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let runs: Vec<serde_json::Value> = app
        .runs
        .list()
        .into_iter()
        .map(|run| {
            serde_json::json!({
                "run_id": run.id,
                "symbol": run.symbol,
                "analysis_id": run.analysis,
                "started_ms": run.started_ms,
                "state": run.state,
                "verdict": run.verdict,
            })
        })
        .collect();
    axum::Json(serde_json::json!({
        "schema": "atlas.exec-runs.v1",
        "runs": runs,
        "note": "状态来自服务端句柄与 runner 发布的记录；running 表示进程仍在服务端进行。",
    }))
    .into_response()
}

// --- 项目编排：页面内打开、切换、重新索引与可信设置 ---------------------------
// 一个服务实例固定一份分析，直到本机操作者通过页面打开另一个目录（或应用补丁
// 后重新索引）。打开=索引+切换：索引有界（deadline 与取消），完成后服务换到
// 新发布的不可变分析。目录路径只在本机解析；浏览器不会拿到伪造的目录语义。

#[derive(serde::Deserialize)]
struct ProjectOpenBody {
    /// 本机绝对路径。给出时执行"索引并切换"。
    path: Option<String>,
    /// 已分析过的版本。给出时直接切换（继续最近项目，不重新索引）。
    analysis: Option<String>,
    /// 明确的本机操作者决定：以可写方式打开这个项目（应用/撤销写入它）。
    /// 只有服务启动时给了 --allow-writes 才可能生效；缺省为不可写。
    #[serde(default)]
    allow_writes: bool,
}

#[derive(serde::Deserialize)]
struct OpBody {
    id: String,
}

#[derive(serde::Deserialize)]
struct ProjectSettingsBody {
    /// 声明的测试命令（argv 数组）。null 表示不运行测试。
    test_argv: Option<Vec<String>>,
    test_timeout_ms: Option<u64>,
}

const SETTINGS_FILE: &str = "project-settings.json";

/// 设置按项目持久化：`{"schema":..., "projects":{ <项目键>: {...} }}`。
/// 切换项目时服务读取该项目自己的声明；没有声明就是"没有声明测试"，
/// 不借用别的项目的命令。
fn load_settings_map(store: &Store) -> serde_json::Map<String, serde_json::Value> {
    let Ok(text) = fs::read_to_string(store.root.join(SETTINGS_FILE)) else {
        return serde_json::Map::new();
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.get("projects").and_then(|p| p.as_object()).cloned())
        .unwrap_or_default()
}

fn saved_project_settings(store: &Store, key: &str) -> Option<(Option<Vec<String>>, u64)> {
    let map = load_settings_map(store);
    let entry = map.get(key)?;
    let argv = entry.get("test_argv").and_then(|argv| {
        argv.as_array().map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<String>>()
        })
    });
    let timeout = entry.get("test_timeout_ms").and_then(|t| t.as_u64());
    Some((argv, timeout.unwrap_or(120_000)))
}

fn save_project_settings(store: &Store, key: &str, argv: &Option<Vec<String>>, timeout_ms: u64) {
    let mut map = load_settings_map(store);
    map.insert(
        key.to_string(),
        serde_json::json!({
            "test_argv": argv,
            "test_timeout_ms": timeout_ms,
            "updated_ms": now_ms(),
        }),
    );
    let value = serde_json::json!({"schema": "atlas.project-settings.v2", "projects": map});
    if let Ok(bytes) = serde_json::to_vec_pretty(&value) {
        let _ = fs::write(store.root.join(SETTINGS_FILE), bytes);
    }
}

/// 当前生效的验证/运行设置，页面据此显示"现在声明的是什么"。
async fn project_settings_get(State(app): State<App>, headers: HeaderMap) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let verify = app.verify_config();
    axum::Json(serde_json::json!({
        "schema": "atlas.project-settings.v1",
        "test_argv": verify.test_argv,
        "test_timeout_ms": verify.test_timeout_ms,
        "worker_heap_mb": verify.worker_heap_mb,
        "applies_to": "当前项目的之后每一次验证（隔离副本内的测试）；切换项目时服务换读该项目的声明；已在队列里的作业用它入队时保存的快照",
        "updated_note": "按项目保存，由本机操作者更新；页面不能替外部提案改测试命令",
    }))
    .into_response()
}

async fn project_settings_put(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<ProjectSettingsBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    // 输入校验先于一切副作用：argv 是字符串数组、个数与长度有界，超时在
    // 合理区间。校验失败原样拒绝，不改服务状态。
    if let Some(argv) = &body.test_argv {
        if argv.is_empty() || argv.len() > 24 {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "test_argv_must_have_1_to_24_entries"})),
            )
                .into_response();
        }
        for item in argv {
            let trimmed = item.trim();
            if trimmed.is_empty() || trimmed.len() > 240 {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(serde_json::json!({"error": "test_argv_entry_empty_or_too_long"})),
                )
                    .into_response();
            }
        }
    }
    let timeout = body
        .test_timeout_ms
        .unwrap_or_else(|| app.verify_config().test_timeout_ms);
    if !(1_000..=600_000).contains(&timeout) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "test_timeout_ms_out_of_range_1000_600000"})),
        )
            .into_response();
    }
    {
        let mut verify = match app.verify.write() {
            Ok(verify) => verify,
            Err(_) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, "settings lock poisoned")
                    .into_response();
            }
        };
        verify.test_argv = body.test_argv.clone();
        verify.test_timeout_ms = timeout;
    }
    save_project_settings(
        &app.store,
        &app.current_project_key(),
        &body.test_argv,
        timeout,
    );
    let verify = app.verify_config();
    axum::Json(serde_json::json!({
        "schema": "atlas.project-settings.v1",
        "saved": true,
        "test_argv": verify.test_argv,
        "test_timeout_ms": verify.test_timeout_ms,
        "note": "已生效：之后的验证按这份声明执行（没有声明就如实写没有运行测试）。",
    }))
    .into_response()
}

/// 最近项目：本机 store 里记录的打开历史，当前服务中的项目标记 current。
async fn projects_list(State(app): State<App>, headers: HeaderMap) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let store = app.store.clone();
    let outcome = tokio::task::spawn_blocking(move || load_projects(&store)).await;
    let current = app.current_analysis();
    let mut projects = outcome.unwrap_or_default();
    for entry in projects.iter_mut() {
        let analysis = entry
            .get("analysis_id")
            .and_then(|a| a.as_str())
            .map(str::to_string);
        if let (Some(object), Some(analysis)) = (entry.as_object_mut(), analysis) {
            object.insert(
                "current".into(),
                serde_json::Value::Bool(analysis == current),
            );
        }
    }
    axum::Json(serde_json::json!({
        "schema": "atlas.projects.v1",
        "projects": projects,
        "note": "记录来自本机 store；不包含本机之外的任何位置。",
    }))
    .into_response()
}

/// 切换当前项目：分析、项目键、写授权与该项目自己的测试声明一起换。
/// 写授权只在服务有写能力、且这个项目被明确以可写方式打开时建立；因此
/// 查看 beta 时写入只可能落在 beta，alpha 的字节不会被触碰。
fn switch_served(app: &App, analysis: String, project_key: String, write: bool) {
    if let Ok(mut id) = app.analysis.write() {
        *id = analysis.clone();
    }
    if let Ok(mut key) = app.project_key.write() {
        *key = project_key.clone();
    }
    let authorized = app.writes_capable && write && std::path::Path::new(&project_key).is_dir();
    app.set_write_root(if authorized {
        Some(std::path::PathBuf::from(&project_key))
    } else {
        None
    });
    let mut verify = app.verify_config();
    if let Some((argv, timeout)) = saved_project_settings(&app.store, &project_key) {
        verify.test_argv = argv;
        verify.test_timeout_ms = timeout;
    } else {
        // 没有声明就是没有声明：验证会如实写"没有跑任何测试"，不借用别的项目的命令。
        verify.test_argv = None;
        verify.test_timeout_ms = 120_000;
    }
    if let Ok(mut slot) = app.verify.write() {
        *slot = verify;
    }
    remember_project(&app.store, &project_key, &analysis, write);
}

/// 索引并切换：有界管线在后台跑，页面轮询 op 状态或取消。
async fn spawn_open_index(app: App, op_id: String, path: PathBuf, write: bool) {
    let verify = app.verify_config();
    let options = match crate::IndexOptions::new(
        verify.node.clone(),
        verify.worker.clone(),
        verify.timeout_seconds,
        verify.scan_deadline_seconds,
        verify.index_deadline_seconds,
        false,
        verify.worker_heap_mb,
        verify.worker_output_mb,
        verify.scan_limits,
    ) {
        Ok(options) => options,
        Err(error) => {
            app.opens
                .set_state(&op_id, "failed", None, Some(error.to_string()));
            return;
        }
    };
    let control =
        crate::ExecutionControl::new(Some(std::time::Instant::now() + options.index_deadline));
    let cancel_rx = app.opens.start(&op_id, &path.display().to_string());
    let store = app.store.clone();
    let result = crate::run_pipeline(&store, &path, &options, &control, cancel_rx).await;
    match result {
        Ok(pipeline) => {
            switch_served(
                &app,
                pipeline.analysis_id.clone(),
                path.display().to_string(),
                write,
            );
            app.opens
                .set_state(&op_id, "switched", Some(pipeline.analysis_id), None);
        }
        Err(error) => {
            let cancelled =
                error.to_string().contains("cancel") || error.to_string().contains("cancelled");
            app.opens.set_state(
                &op_id,
                if cancelled { "cancelled" } else { "failed" },
                None,
                Some(error.to_string()),
            );
        }
    }
}

/// 打开项目：给 path 就索引并切换（后台作业）；给 analysis 就直接切换到那
/// 份已发布的分析。同一时刻只允许一个索引作业。
async fn project_open(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<ProjectOpenBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    if let Some(analysis) = body.analysis.as_deref().filter(|id| !id.trim().is_empty()) {
        let analysis = analysis.trim().to_string();
        let store = app.store.clone();
        let id = analysis.clone();
        let metadata = tokio::task::spawn_blocking(move || store.metadata(&id)).await;
        match metadata {
            Ok(Ok(report)) => {
                // 项目键优先用最近记录里登记的目录；没有就用分析 id（与启动默认一致）。
                let store_for_recent = app.store.clone();
                // 项目键与写授权都来自这个项目的登记记录：切回来时还是它自己的
                // 授权与设置；没有记录就当作未授权的新项目。
                let (project_key, write) = project_record_by_analysis(&store_for_recent, &analysis)
                    .unwrap_or_else(|| (analysis.clone(), false));
                switch_served(&app, analysis.clone(), project_key, write);
                axum::Json(serde_json::json!({
                    "schema": "atlas.project-open.v1",
                    "outcome": "switched",
                    "analysis_id": analysis,
                    "report": report,
                    "note": "已切换到这份已发布的分析；没有重新索引。",
                }))
                .into_response()
            }
            Ok(Err(error)) => (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": format!("analysis_unreadable:{error}")})),
            )
                .into_response(),
            Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "metadata read failed").into_response(),
        }
    } else if let Some(path) = body
        .path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        // 并发索引会让两次切换互相覆盖，先拒绝并说明。作业有界，等它结束。
        {
            let slots = match app.opens.slots.lock() {
                Ok(slots) => slots,
                Err(_) => {
                    return (StatusCode::INTERNAL_SERVER_ERROR, "opens lock poisoned")
                        .into_response();
                }
            };
            if slots.values().any(|slot| slot.state == "indexing") {
                return (
                    StatusCode::CONFLICT,
                    axum::Json(serde_json::json!({"error": "open_already_running", "detail": "一次只索引一个目录；等当前作业结束或取消它。"})),
                )
                    .into_response();
            }
        }
        let resolved = std::path::Path::new(path).to_path_buf();
        if !resolved.is_dir() {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "path_not_a_directory", "path": path})),
            )
                .into_response();
        }
        let canonical = resolved
            .canonicalize()
            .map_err(|error| format!("path_unreadable:{}:{error}", resolved.display()))
            .ok();
        let Some(path) = canonical else {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"error": "path_unreadable", "path": path})),
            )
                .into_response();
        };
        // 写授权是这次打开的明确决定：服务有写能力且操作者选择"以可写方式打开"。
        let write = app.writes_capable && body.allow_writes;
        let op_id = uuid::Uuid::new_v4().simple().to_string();
        let task_app = app.clone();
        let task_op = op_id.clone();
        tokio::spawn(async move {
            spawn_open_index(task_app, task_op, path, write).await;
        });
        axum::Json(serde_json::json!({
            "schema": "atlas.project-open.v1",
            "outcome": "indexing",
            "op_id": op_id,
            "note": "索引在服务端进行（有界，可取消）；GET /api/project/open?id= 查状态。",
        }))
        .into_response()
    } else {
        (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "path_or_analysis_required"})),
        )
            .into_response()
    }
}

/// 打开作业的状态与取消。
async fn project_open_status(
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
    match app.opens.status(id) {
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "op_not_found", "op_id": id})),
        )
            .into_response(),
        Some((path, state, analysis, error, started_ms)) => axum::Json(serde_json::json!({
            "schema": "atlas.project-open.v1",
            "op_id": id,
            "path": path,
            "state": state,
            "analysis_id": analysis,
            "error": error,
            "started_ms": started_ms,
            "elapsed_ms": now_ms().saturating_sub(started_ms),
        }))
        .into_response(),
    }
}

async fn project_open_cancel(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<OpBody>,
) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    match app.opens.cancel(&body.id) {
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "op_not_found", "op_id": body.id})),
        )
            .into_response(),
        Some(sent) => axum::Json(serde_json::json!({
            "schema": "atlas.project-open.v1",
            "op_id": body.id,
            "state": if sent { "cancelling" } else { "indexing" },
            "note": "取消信号已发出；索引管线在检查点停下后作业才是 cancelled。",
        }))
        .into_response(),
    }
}

/// 应用补丁后的"打开新版本"：重新索引已授权的写入目录并切换到新分析。
async fn project_reindex(State(app): State<App>, headers: HeaderMap) -> Response {
    if !allowed(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "local session required").into_response();
    }
    let Some(root) = app.current_write_root() else {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "error": "no_write_root",
                "detail": "当前项目没有写授权：以可写方式打开它之后，才能重新索引出它的更新版本。",
            })),
        )
            .into_response();
    };
    {
        let slots = match app.opens.slots.lock() {
            Ok(slots) => slots,
            Err(_) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, "opens lock poisoned").into_response();
            }
        };
        if slots.values().any(|slot| slot.state == "indexing") {
            return (
                StatusCode::CONFLICT,
                axum::Json(serde_json::json!({"error": "open_already_running"})),
            )
                .into_response();
        }
    }
    let write = app.current_write_root().is_some();
    let op_id = uuid::Uuid::new_v4().simple().to_string();
    let task_app = app.clone();
    let task_op = op_id.clone();
    tokio::spawn(async move {
        spawn_open_index(task_app, task_op, root, write).await;
    });
    axum::Json(serde_json::json!({
        "schema": "atlas.project-open.v1",
        "outcome": "indexing",
        "op_id": op_id,
        "note": "正在重新索引项目目录；完成后服务切到新分析。",
    }))
    .into_response()
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
        "tree",
        "GET",
        "http",
        "按父节点加载项目树的直接成员（缺省父节点是项目根）",
        "成员来自已发布的包含结构；成员总数、已加载量与下一页游标都是真实数字",
        "单页 1..500；不支持的语言仍返回文件节点并标明没有语义分析；Markdown 章节按标题现算",
    ),
    (
        "knowledge",
        "GET",
        "http",
        "一个节点的 Atlas 算法摘要与源码注释",
        "全部来自已发布事实与捕获字节；没有注释就返回空，不编造解释",
        "不调用模型；LLM 解释由页面在配置连接后显式发起",
    ),
    (
        "llm/config",
        "GET/PUT",
        "http",
        "查看/更新当前项目的模型连接（base_url、model、可选 key、适配器、超时与上下文预算）",
        "GET 永不返回 api_key，只报 has_api_key；配置按项目保存，切换项目不共用",
        "base_url 必须是 http(s)；超时 1000..300000 ms；上下文 512..200000 字节；适配器不存在即拒绝且保留原配置",
    ),
    (
        "llm/context",
        "GET",
        "http",
        "生成前预览将要发送的范围：逐条列出片段、文件、原因与字节数",
        "只含列出的片段，不是整个项目；超预算整段不入，不做半截截断",
        "未配置时返回 llm_not_configured；页面不得自行拼接上下文",
    ),
    (
        "llm/explain",
        "POST",
        "http",
        "对当前分析的一个节点显式发起一次模型解释",
        "只在用户点击后发出；结果写入 store 并带 model/base_url/节点/版本；与用户解析记录分开存放",
        "未配置即拒绝，不返回任何占位文本；一次一个作业，可取消",
    ),
    (
        "llm/explanations",
        "GET",
        "http",
        "读回某个节点已生成的解释（running/done/failed/cancelled 都是真实状态）",
        "模型解释不是 Atlas 的分析结论，也不覆盖用户保存的解析",
        "按项目与节点锚点隔离",
    ),
    (
        "interpretations",
        "GET",
        "http",
        "读一个跨版本身份(anchor)上的解析记录修订历史",
        "按项目 + anchor 隔离；记录保留作者、依据版本、来源引用与时间",
        "上限 200；不读其他项目或其他锚点的记录",
    ),
    (
        "interpretation",
        "POST",
        "http",
        "保存一条解析记录（可引用来源、可作为上一版的修订）",
        "每次都写新修订，不覆盖旧记录；作者由会话决定",
        "正文 1..32768 字节；来源引用最多 16 条",
    ),
    (
        "handoffs",
        "GET",
        "http",
        "读交接记录（可按 anchor 过滤）",
        "同一项目内可见；复制/导出与「已发送」在状态里区分",
        "上限 200；不代表对方已经收到",
    ),
    (
        "handoff",
        "POST",
        "http",
        "创建或更新一份交接草稿（目标、范围、关联批注）",
        "交接有稳定 id，可跨刷新/重启找回；不会修改源码",
        "goal 1..8192 字节；只登记意图",
    ),
    (
        "handoff/message",
        "POST",
        "http",
        "在交接里追加一条讨论消息",
        "只追加，不覆盖已有解析记录；作者是会话",
        "单条 1..8192 字节",
    ),
    (
        "handoff/proposal",
        "POST",
        "http",
        "把一个真实提案关联到交接",
        "提案必须属于当前服务的分析版本；否则具名拒绝",
        "只建立关联，不改变提案状态",
    ),
    (
        "node-annotations",
        "GET",
        "http",
        "读任意节点（文件/目录/文档/函数）上的批注",
        "批注绑定分析与实体；kind 限 intent/constraint/scenario/patch",
        "上限 200；批注是声明，不是已存在的代码",
    ),
    (
        "node-annotation",
        "POST",
        "http",
        "在任意节点上登记一条批注（Intent）",
        "作者由会话写入，页面不能冒充；内容摘要幂等",
        "不写源码；重复内容不会重复登记",
    ),
    (
        "exec/runs",
        "GET",
        "http",
        "本轮会话的后台执行清单（对象、状态、终态）",
        "状态来自服务端句柄与 runner 发布的记录；在途即 running",
        "只保留本会话最近一批句柄（上限 64），更早的终态以运行记录查询为准",
    ),
    (
        "projects",
        "GET",
        "http",
        "本机最近打开过的项目（store 内记录）",
        "只列本机 store 里登记过的目录；当前服务的项目标 current",
        "最近 8 个；不包含本机之外的任何位置",
    ),
    (
        "project/open",
        "POST/GET",
        "http",
        "打开并索引一个本机目录（POST），或按 analysis 切换（POST）；GET 查作业状态",
        "切换是真实的服务切换：完成后所有查询落在新的不可变分析上",
        "同一时刻只允许一个索引作业；索引有界可取消；不读 store 之外的位置",
    ),
    (
        "project/open/cancel",
        "POST",
        "http",
        "取消一个正在索引的打开作业",
        "协作式取消：管线在检查点停下，作业状态才变 cancelled",
        "只影响本会话的作业",
    ),
    (
        "project/reindex",
        "POST",
        "http",
        "重新索引 --allow-writes 指定的项目目录（应用补丁后的新版本）",
        "完成后服务切换到新分析；旧分析仍不可变",
        "需要启动时给过 --allow-writes；同一时刻一个索引作业",
    ),
    (
        "project/settings",
        "GET/PUT",
        "http",
        "查看/更新本机操作者声明的测试命令与超时",
        "更新对之后的每一次验证生效，并随 store 保留；GET 返回当前生效值",
        "argv 为 1..24 个非空字符串；超时 1000..600000 ms；页面不能替外部提案改命令",
    ),
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
        "search",
        "GET",
        "http",
        "按名字或路径子串查找对象（`q=<子串>`，`kind` 默认 function）",
        "在整个分析内搜索并回显总数与截断，不是本地翻页过滤",
        "单页上限 500；子串匹配，不是正则",
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
        "exec",
        "POST",
        "http",
        "后台执行一次固定调用（`background:true` 时立刻返回 run id）",
        "执行在服务端继续；取消是协作式的，终态以发布的执行记录为准",
        "只有服务端记录的终态才算终态；run 句柄只在本服务进程内有效",
    ),
    (
        "exec/run",
        "GET",
        "http",
        "查一次后台执行的状态（`id=<run id>`）",
        "running / completed / failed / cancelled 来自执行记录，不来自 HTTP 连接",
        "run id 只在本服务进程内有效；重启后请按已发布的执行记录查询",
    ),
    (
        "exec/cancel",
        "POST",
        "http",
        "取消一次后台执行",
        "回答只是取消中；等进程被结束并发布记录后状态才变 cancelled",
        "不能取消别人的 run id；不存在的 id 返回 run_not_found",
    ),
    (
        "exec-compare",
        "POST",
        "http",
        "同一份声明输入（args / this / globals）在基线与已验证补丁两个分析上各跑一次",
        "两侧都是真实隔离运行，各自保留自己的分析身份；请求回显实际发出的声明输入",
        "需要先完成隔离验证；页面不能放宽沙箱，因此缺授权的函数两侧都会被具名拒绝",
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
        "ui-state",
        "GET",
        "http",
        "读取这份分析上次的选区、任务页签与输入草稿",
        "按分析身份保存，重启服务后可恢复；不同项目互不串用",
        "只是工作台的暂存位置，不是已发布事实；读不到就是没有",
    ),
    (
        "ui-state",
        "PUT",
        "http",
        "保存当前的选区、任务页签与输入草稿",
        "重启服务后按同一分析身份恢复",
        "上限 512KB；覆盖式写入，不保留旧值",
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

fn contract(
    analysis: &str,
    write_root: Option<&std::path::Path>,
    writes_capable: bool,
    verify: &ServerConfig,
    project: &str,
) -> serde_json::Value {
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
        // 项目身份来自启动参数 --project（启动器传项目目录）。页面用它显示
        // "现在打开的是哪个项目"，而不是拿分析 id 冒充项目名。打开其他目录
        // 走 project/open：索引并真实切换服务。
        "project": {
            "key": project,
            "name": project.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or(project),
            "is_analysis_id": project == analysis,
            "how_to_set": "atlas --store S serve <analysis> --project <项目目录>；页面内切换用 POST /api/project/open",
        },
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
        // Published so a reader can see what a verification will actually do
        // before asking for one. An undeclared test is not a hidden default:
        // it is the honest answer "no test ran", and it is stated here rather
        // than discovered from a verification row.
        "verification": {
            "node": verify.node.display().to_string(),
            "worker": verify.worker.display().to_string(),
            "test_argv": verify.test_argv,
            "test_timeout_ms": verify.test_timeout_ms,
            "note": "测试命令由本机操作者声明（启动参数或项目设置）；页面不能临时附加，外部提案不能自行决定要执行的命令。",
        },
        "writes": {
            // capable：启动时给了 --allow-writes（本服务有 HTTP 写能力）。
            // enabled/root：当前项目是否可写、写哪个目录。root 跟随当前项目：
            // 以可写方式打开另一个项目时授权随之移动，任何时刻至多一个目录。
            "capable": writes_capable,
            "enabled": write_root.is_some(),
            "root": write_root.map(|root| root.display().to_string()),
            "how_to_enable": "atlas --store S serve <analysis> --allow-writes <目录>；页内切换项目时勾选「以可写方式打开」",
            "scope": "只有 patch/apply 与 patch/revert，且只写当前项目目录；提案固定在别的项目/版本上时由字节核对与服务端归属检查拒绝",
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
    let mut value = contract(
        &app.current_analysis(),
        app.current_write_root().as_deref(),
        app.writes_capable,
        &app.verify_config(),
        &app.current_project_key(),
    );
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
    verify: ServerConfig,
    project_key: Option<String>,
) -> Result<(), Box<dyn std::error::Error>> {
    // A launcher may ask for a stable port so that restarting the service
    // keeps the same origin (and therefore the page's own local storage). That
    // port belongs to some other process sometimes, and a launcher is not in a
    // position to tell. Falling back to an ephemeral port keeps the service
    // usable; the launcher reads the port it actually got from the session
    // file either way.
    let listener =
        match tokio::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => listener,
            Err(error) if port != 0 => {
                eprintln!(
                    "port {} unavailable ({error}); falling back to an ephemeral port",
                    port
                );
                tokio::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).await?
            }
            Err(error) => return Err(error.into()),
        };
    let address = listener.local_addr()?;
    let token = uuid::Uuid::new_v4().to_string();
    let session_file = store
        .root
        .join(format!("web-session-{}.json", uuid::Uuid::new_v4()));
    let session = serde_json::json!({"url":format!("http://{address}/"),"token":token,"analysis_id":analysis});
    let bytes = serde_json::to_vec_pretty(&session)?;
    let project_key = project_key
        .filter(|key| !key.trim().is_empty())
        .unwrap_or_else(|| analysis.clone());
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
    // 操作者在项目页保存过的声明（测试命令）按项目随 store 保留：重启后仍然
    // 生效。本次启动显式传了 --test-argv 时，以这次启动的决定为准，并把它
    // 记成启动项目自己的声明（切换走再回来仍然读它）。
    let mut verify = verify;
    if verify.test_argv.is_none()
        && let Some((saved_argv, saved_timeout)) = saved_project_settings(&store, &project_key)
    {
        if saved_argv.is_some() {
            verify.test_argv = saved_argv;
        }
        verify.test_timeout_ms = saved_timeout;
    } else if verify.test_argv.is_some() {
        save_project_settings(
            &store,
            &project_key,
            &verify.test_argv,
            verify.test_timeout_ms,
        );
    }
    // 写能力来自启动参数；授权目录是启动给定的那个项目。之后的页内切换按
    // "以可写方式打开"逐项目重新授权（见 switch_served）。
    let canonical_write_root = match write_root {
        Some(root) => Some(
            root.canonicalize()
                .map_err(|error| format!("write_root_unreadable:{}:{error}", root.display()))?,
        ),
        None => None,
    };
    let writes_capable = canonical_write_root.is_some();
    if writes_capable {
        remember_project(&store, &project_key, &analysis, true);
    }
    let app = App {
        store,
        analysis: Arc::new(std::sync::RwLock::new(analysis)),
        token: token.clone(),
        authority: address.to_string(),
        slots: Arc::new(Semaphore::new(8)),
        runs: Arc::new(Runs::default()),
        opens: Arc::new(OpenOps::default()),
        llm_jobs: Arc::new(crate::llm::Jobs::default()),
        verify: Arc::new(std::sync::RwLock::new(verify)),
        project_key: Arc::new(std::sync::RwLock::new(project_key)),
        owner: format!("session-{}", &token[..12]),
        write_root: Arc::new(std::sync::RwLock::new(canonical_write_root)),
        writes_capable,
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
        // The project map page: the real containment tree, the multi-area
        // workspace and the node inspector. Same `asset()` boundary as the rest.
        .route(
            "/explore.js",
            get(|| async {
                asset(
                    include_str!("../../../web/explore.js"),
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
        .route("/api/exec/run", get(exec_run_status))
        .route("/api/exec/cancel", post(exec_cancel))
        .route("/api/exec/runs", get(exec_runs_list))
        .route("/api/projects", get(projects_list))
        .route(
            "/api/project/open",
            get(project_open_status).post(project_open),
        )
        .route("/api/project/open/cancel", post(project_open_cancel))
        .route("/api/project/reindex", post(project_reindex))
        .route(
            "/api/project/settings",
            get(project_settings_get).put(project_settings_put),
        )
        .route("/api/selection", get(selection))
        .route("/api/annotations", get(annotations))
        .route("/api/annotation", post(annotate))
        // 项目地图：按父节点加载成员、节点摘要与注释。
        .route("/api/tree", get(tree))
        .route("/api/knowledge", get(knowledge))
        // 节点知识：解析记录、任意节点的批注、交接与讨论。
        .route("/api/interpretations", get(interpretations))
        .route("/api/interpretation", post(save_interpretation))
        .route("/api/handoffs", get(handoffs))
        .route("/api/handoff", post(save_handoff))
        .route("/api/handoff/message", post(handoff_message))
        .route("/api/handoff/exported", post(handoff_exported))
        .route("/api/handoff/proposal", post(handoff_proposal))
        .route("/api/node-annotations", get(node_annotations))
        .route("/api/node-annotation", post(annotate_node))
        // 按需 LLM：连接配置、发送范围预览、显式生成、取消、生成记录。
        .route(
            "/api/llm/config",
            get(llm_config_get)
                .put(llm_config_put)
                .delete(llm_config_delete),
        )
        .route("/api/llm/context", get(llm_context))
        .route("/api/llm/explain", post(llm_explain))
        .route("/api/llm/explain/status", get(llm_explain_status))
        .route("/api/llm/explain/cancel", post(llm_explain_cancel))
        .route("/api/llm/explanations", get(llm_explanations))
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
        .route("/api/ui-state", get(ui_state_get).put(ui_state_put))
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

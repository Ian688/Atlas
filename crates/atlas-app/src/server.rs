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
        .with_state(app);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    let _ = fs::remove_file(session_file);
    Ok(())
}

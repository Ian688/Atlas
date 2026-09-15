//! On-demand model explanations: one node, one version, one explicit click.
//!
//! Atlas never calls a model on its own. This module holds everything the
//! "generate an explanation" button needs, and everything that keeps it honest:
//!
//! - **The connection is configuration, not a built-in.** A base URL, a model
//!   name and an optional key are saved per project by the local operator. With
//!   no configuration there is no request, and the page says so instead of
//!   showing a canned answer.
//! - **The request goes through a separate process.** The server has no HTTP
//!   client of its own and does not read anyone's credentials: it writes the
//!   configured base URL, model, key and the finished prompt to the adapter's
//!   stdin and reads one JSON object back. Cancelling is killing that process.
//! - **The scope is shown before it is sent.** A reader can see exactly which
//!   bytes of which files would leave the machine, and shrink it.
//! - **A generated answer is stored apart from what a person wrote.** A
//!   regeneration can therefore never overwrite an interpretation, and the
//!   model, the endpoint and the version stay visible next to the text.
use atlas_engine::store::Store;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const LLM_SCHEMA: &str = "atlas.llm.v1";
/// The bundled minimal adapter: one OpenAI-compatible call, no dependencies.
pub const DEFAULT_ADAPTER_RELATIVE: &str = "adapters/llm/openai-compatible.mjs";

const CONFIG_FILE: &str = "llm-config.json";
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 300_000;
const MIN_CONTEXT_BYTES: usize = 512;
const MAX_CONTEXT_BYTES: usize = 200_000;

/// What a generation may include beyond the node's own source.
#[derive(Clone, Serialize, Deserialize)]
pub struct Scope {
    pub comments: bool,
    pub callees: bool,
    pub callers: bool,
}

impl Default for Scope {
    fn default() -> Self {
        Self {
            comments: true,
            callees: false,
            callers: false,
        }
    }
}

/// The connection, saved per project.
#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub base_url: String,
    pub model: String,
    /// Never returned to the page: `GET /api/llm/config` reports only whether a
    /// key is present, because a page that can read a key can leak it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default = "default_adapter")]
    pub adapter: String,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_context")]
    pub max_context_bytes: usize,
    #[serde(default)]
    pub scope: Scope,
}

fn default_adapter() -> String {
    DEFAULT_ADAPTER_RELATIVE.to_string()
}
fn default_timeout() -> u64 {
    60_000
}
fn default_context() -> usize {
    24_000
}

impl Config {
    /// Configured means capable of making a request: an endpoint, a model and a
    /// command that exists. A key is optional -- a local server may not want one.
    pub fn is_configured(&self) -> bool {
        !self.base_url.trim().is_empty()
            && !self.model.trim().is_empty()
            && resolve_adapter(&self.adapter).is_some()
    }
}

/// The adapter is resolved by walking upwards from the working directory when
/// the configured path is relative, so a copied distribution finds its own
/// bundled adapter no matter which directory it was started from.
fn resolve_adapter(configured: &str) -> Option<PathBuf> {
    let configured = configured.trim();
    if configured.is_empty() {
        return None;
    }
    let path = PathBuf::from(configured);
    if path.is_file() {
        return Some(path);
    }
    let mut cursor = std::env::current_dir().ok()?;
    for _ in 0..6 {
        let candidate = cursor.join(&path);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

fn config_path(store: &Store) -> PathBuf {
    store.root.join(CONFIG_FILE)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_all(store: &Store) -> BTreeMap<String, Config> {
    let Ok(text) = fs::read_to_string(config_path(store)) else {
        return BTreeMap::new();
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| value.get("projects").cloned())
        .and_then(|projects| serde_json::from_value(projects).ok())
        .unwrap_or_default()
}

fn persist_all(store: &Store, all: &BTreeMap<String, Config>) -> Result<(), String> {
    let body = json!({"schema": LLM_SCHEMA, "projects": all});
    let encoded = serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?;
    let path = config_path(store);
    fs::write(&path, encoded).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn load(store: &Store, key: &str) -> Option<Config> {
    load_all(store).get(key).cloned()
}

/// The shape the page gets: everything needed to show "what is connected", and
/// never the key itself.
pub fn describe(store: &Store, key: &str) -> Value {
    let (config, configured, base_url, model, has_key, adapter, timeout, budget, scope, note) =
        match load(store, key) {
            Some(config) => {
                let configured = config.is_configured();
                (
                    Some(()),
                    configured,
                    config.base_url.clone(),
                    config.model.clone(),
                    config.api_key.as_deref().map(|k| !k.is_empty()).unwrap_or(false),
                    config.adapter.clone(),
                    config.timeout_ms,
                    config.max_context_bytes,
                    json!({"comments": config.scope.comments, "callees": config.scope.callees, "callers": config.scope.callers}),
                    if configured {
                        "已配置：只有你在节点上点击生成时才发出请求。"
                    } else {
                        "配置不完整：需要 base_url、model 与一个存在的适配器命令。"
                    },
                )
            }
            None => (
                None,
                false,
                String::new(),
                String::new(),
                false,
                default_adapter(),
                default_timeout(),
                default_context(),
                json!({"comments": true, "callees": false, "callers": false}),
                "还没有配置模型连接。算法摘要、源码注释与你的解析记录都不依赖它。",
            ),
        };
    let _ = config;
    json!({
        "schema": LLM_SCHEMA,
        "configured": configured,
        "base_url": base_url,
        "model": model,
        "has_api_key": has_key,
        "adapter": adapter,
        "adapter_present": resolve_adapter(&adapter).is_some(),
        "timeout_ms": timeout,
        "max_context_bytes": budget,
        "scope": scope,
        "note": note,
    })
}

#[derive(Deserialize)]
pub struct ConfigBody {
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// Absent means "keep the stored key"; an empty string means "remove it".
    pub api_key: Option<String>,
    pub adapter: Option<String>,
    pub timeout_ms: Option<u64>,
    pub max_context_bytes: Option<usize>,
    pub comments: Option<bool>,
    pub callees: Option<bool>,
    pub callers: Option<bool>,
}

/// Validate first, then persist: a rejected configuration leaves the previous
/// one untouched rather than half-updating it.
pub fn configure(store: &Store, key: &str, body: &ConfigBody) -> Result<Value, String> {
    let previous = load(store, key);
    let base_url = body
        .base_url
        .clone()
        .or_else(|| previous.as_ref().map(|p| p.base_url.clone()))
        .unwrap_or_default()
        .trim()
        .to_string();
    let model = body
        .model
        .clone()
        .or_else(|| previous.as_ref().map(|p| p.model.clone()))
        .unwrap_or_default()
        .trim()
        .to_string();
    let adapter = body
        .adapter
        .clone()
        .or_else(|| previous.as_ref().map(|p| p.adapter.clone()))
        .unwrap_or_else(default_adapter);
    let timeout_ms = body
        .timeout_ms
        .or_else(|| previous.as_ref().map(|p| p.timeout_ms))
        .unwrap_or_else(default_timeout);
    let max_context_bytes = body
        .max_context_bytes
        .or_else(|| previous.as_ref().map(|p| p.max_context_bytes))
        .unwrap_or_else(default_context);

    if !base_url.is_empty() {
        if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
            return Err("base_url_must_be_http_or_https".into());
        }
        if base_url.len() > 2048 {
            return Err("base_url_too_long".into());
        }
    }
    if model.len() > 256 {
        return Err("model_too_long".into());
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err("timeout_ms_out_of_range_1000_300000".into());
    }
    if !(MIN_CONTEXT_BYTES..=MAX_CONTEXT_BYTES).contains(&max_context_bytes) {
        return Err("max_context_bytes_out_of_range_512_200000".into());
    }
    if !adapter.trim().is_empty() && resolve_adapter(&adapter).is_none() {
        return Err(format!("adapter_not_found:{adapter}"));
    }
    let api_key = match &body.api_key {
        Some(value) if value.is_empty() => None,
        Some(value) => Some(value.clone()),
        None => previous.as_ref().and_then(|p| p.api_key.clone()),
    };
    let previous_scope = previous.map(|p| p.scope).unwrap_or_default();
    let config = Config {
        base_url,
        model,
        api_key,
        adapter,
        timeout_ms,
        max_context_bytes,
        scope: Scope {
            comments: body.comments.unwrap_or(previous_scope.comments),
            callees: body.callees.unwrap_or(previous_scope.callees),
            callers: body.callers.unwrap_or(previous_scope.callers),
        },
    };
    let mut all = load_all(store);
    all.insert(key.to_string(), config);
    persist_all(store, &all)?;
    Ok(describe(store, key))
}

/// Forget a project's configuration, and with it any stored key.
pub fn clear(store: &Store, key: &str) -> Value {
    let mut all = load_all(store);
    all.remove(key);
    let _ = persist_all(store, &all);
    describe(store, key)
}

// --- the scope that would be sent ------------------------------------------

struct Piece {
    label: String,
    path: String,
    reason: String,
    text: String,
}

fn source_bytes(store: &Store, analysis: &str, path: &str) -> Option<String> {
    let meta = store.metadata(analysis).ok()?;
    let snapshot = store.snapshot(meta["snapshot_id"].as_str()?).ok()?;
    let entry = snapshot.entries.iter().find(|entry| entry.path == path)?;
    let hash = entry.blob.as_ref()?;
    String::from_utf8(store.read_blob(hash).ok()?).ok()
}

fn slice_of(store: &Store, analysis: &str, path: &str, name: &str) -> String {
    let Some(source) = source_bytes(store, analysis, path) else {
        return String::new();
    };
    let found = store
        .search_nodes(analysis, name, "all", 8, None)
        .map(|page| page.items)
        .unwrap_or_default()
        .into_iter()
        .find(|n| n.path == path && n.kind == "function");
    match found {
        Some(target) => source
            .get(target.start..target.end.min(source.len()))
            .unwrap_or("")
            .to_string(),
        None => String::new(),
    }
}

/// A document section reference (`section:path:start:end`) has no node row, so
/// it is read straight out of the captured bytes.
fn section_piece(store: &Store, analysis: &str, entity: &str) -> Option<Piece> {
    let rest = entity.strip_prefix("section:")?;
    let mut parts = rest.rsplitn(3, ':');
    let end: usize = parts.next()?.parse().ok()?;
    let start: usize = parts.next()?.parse().ok()?;
    let path = parts.next()?.to_string();
    let source = source_bytes(store, analysis, &path)?;
    let text = source.get(start..end.min(source.len()))?.to_string();
    Some(Piece {
        label: "文档章节".into(),
        path,
        reason: format!("字节 {start}–{end}"),
        text,
    })
}

/// Assemble the context for one node. Every piece names the file it came from
/// and why it is included, so the preview reads as a disclosure rather than a
/// debug dump.
/// The running context budget. A piece is either fully in or fully out: a
/// half-sent function would let a model invent the missing half, and the reader
/// could not tell which lines actually left the machine.
struct Budget {
    total: usize,
    truncated: bool,
    limit: usize,
}

impl Budget {
    fn push(&mut self, pieces: &mut Vec<Piece>, piece: Piece) {
        if piece.text.is_empty() {
            return;
        }
        if self.total + piece.text.len() > self.limit {
            self.truncated = true;
            return;
        }
        self.total += piece.text.len();
        pieces.push(piece);
    }
}

fn gather(
    store: &Store,
    analysis: &str,
    entity: &str,
    scope: &Scope,
    budget: usize,
) -> Result<(Vec<Piece>, bool), String> {
    let mut pieces: Vec<Piece> = Vec::new();
    let mut budget = Budget {
        total: 0,
        truncated: false,
        limit: budget,
    };

    if let Some(piece) = section_piece(store, analysis, entity) {
        budget.push(&mut pieces, piece);
        return Ok((pieces, budget.truncated));
    }

    let node = store
        .node(analysis, entity)
        .map_err(|e| format!("entity_not_found:{e}"))?;

    match node.kind.as_str() {
        "function" => {
            if let Some(source) = source_bytes(store, analysis, &node.path) {
                let slice = source
                    .get(node.start..node.end.min(source.len()))
                    .unwrap_or("");
                budget.push(
                    &mut pieces,
                    Piece {
                        label: "节点源码".into(),
                        path: node.path.clone(),
                        reason: format!("{} 的字节 {}–{}", node.name, node.start, node.end),
                        text: slice.to_string(),
                    },
                );
            }
        }
        "file" => {
            if let Some(source) = source_bytes(store, analysis, &node.path) {
                // A file longer than the budget is cut, and the cut is marked
                // in the text itself: a silent prefix would read as the whole
                // file to a model that cannot see the byte count.
                let end = source.len().min(budget.limit);
                if end < source.len() {
                    budget.truncated = true;
                }
                let mut cut = source[..end].to_string();
                if end < source.len() {
                    cut.push_str("\n…（超出上下文预算，已截断）");
                }
                budget.push(
                    &mut pieces,
                    Piece {
                        label: "文件全文".into(),
                        path: node.path.clone(),
                        reason: format!("{} 字节", source.len()),
                        text: cut,
                    },
                );
            }
        }
        _ => {
            // A directory or the project root: the member list is the honest
            // unit, not a guess at which file matters.
            let members = atlas_engine::tree::members(store, analysis, Some(&node.id), 200, None)
                .map_err(|e| e.to_string())?;
            let text: String = members
                .items
                .iter()
                .map(|item| format!("{} {}", item.kind, item.path))
                .collect::<Vec<_>>()
                .join("\n");
            budget.push(
                &mut pieces,
                Piece {
                    label: "成员清单".into(),
                    path: node.path.clone(),
                    reason: format!("{} 个直接成员", members.items.len()),
                    text,
                },
            );
        }
    }

    if node.kind == "function" {
        if scope.comments
            && let Ok(value) = crate::knowledge::knowledge(store, analysis, entity)
        {
            let comments: Vec<String> = value["comments"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|c| c["text"].as_str().map(str::to_string))
                .collect();
            if !comments.is_empty() {
                budget.push(
                    &mut pieces,
                    Piece {
                        label: "源码注释".into(),
                        path: node.path.clone(),
                        reason: format!("{} 条", comments.len()),
                        text: comments.join("\n"),
                    },
                );
            }
            let lines: Vec<String> = value["summary"]["lines"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|l| {
                    format!(
                        "{}: {}",
                        l["label"].as_str().unwrap_or(""),
                        l["text"].as_str().unwrap_or("")
                    )
                })
                .collect();
            if !lines.is_empty() {
                budget.push(
                    &mut pieces,
                    Piece {
                        label: "Atlas 算法摘要".into(),
                        path: node.path.clone(),
                        reason: "已发布事实，不是模型推断".into(),
                        text: lines.join("\n"),
                    },
                );
            }
        }
        let neighbours = |direction: &str| -> Vec<(String, String)> {
            store
                .reachable(analysis, &node.id, direction, 10, 30)
                .map(|reach| {
                    reach
                        .nodes
                        .iter()
                        .filter(|n| n.id != node.id)
                        .map(|n| (n.path.clone(), n.name.clone()))
                        .collect()
                })
                .unwrap_or_default()
        };
        if scope.callees {
            for (path, name) in neighbours("out") {
                budget.push(
                    &mut pieces,
                    Piece {
                        label: "被调用方源码".into(),
                        path: path.clone(),
                        reason: name.clone(),
                        text: slice_of(store, analysis, &path, &name),
                    },
                );
            }
        }
        if scope.callers {
            for (path, name) in neighbours("in") {
                budget.push(
                    &mut pieces,
                    Piece {
                        label: "调用方源码".into(),
                        path: path.clone(),
                        reason: name.clone(),
                        text: slice_of(store, analysis, &path, &name),
                    },
                );
            }
        }
    }
    Ok((pieces, budget.truncated))
}

fn build_prompt(analysis: &str, node: &Value, pieces: &[Piece], question: &str) -> String {
    let mut out = String::new();
    out.push_str("你是代码阅读助手。只依据下面给出的真实源码与已发布事实回答；\n");
    out.push_str("不要猜测没有给出的代码，不要声称运行过或测试过任何东西。\n");
    out.push_str("不确定的地方直接说不确定，并说明缺什么。\n\n");
    out.push_str(&format!(
        "【对象】{} {}（analysis {}）\n",
        node["kind"].as_str().unwrap_or(""),
        node["path"].as_str().unwrap_or(""),
        &analysis[..analysis.len().min(12)]
    ));
    if let Some(name) = node["name"].as_str()
        && !name.is_empty()
    {
        out.push_str(&format!("【名称】{name}\n"));
    }
    if !question.trim().is_empty() {
        out.push_str(&format!("【问题】{}\n", question.trim()));
    }
    out.push('\n');
    for piece in pieces {
        out.push_str(&format!(
            "----- {} · {}（{}）-----\n{}\n",
            piece.label, piece.path, piece.reason, piece.text
        ));
    }
    out.push_str("\n请用中文回答：这段代码做什么、读什么、返回什么、有哪些边界或风险。\n");
    out
}

fn node_value(store: &Store, analysis: &str, entity: &str) -> Value {
    store
        .node(analysis, entity)
        .map(|n| {
            json!({"id": n.id, "kind": n.kind, "path": n.path, "name": n.name, "start": n.start, "end": n.end})
        })
        .unwrap_or_else(|_| json!({"id": entity}))
}

/// What would be sent, described before anything is sent.
pub fn preview(
    store: &Store,
    analysis: &str,
    entity: &str,
    config: Option<&Config>,
    question: &str,
) -> Result<Value, String> {
    let config = config.ok_or_else(|| "llm_not_configured".to_string())?;
    let (pieces, truncated) = gather(store, analysis, entity, &config.scope, config.max_context_bytes)?;
    let total: usize = pieces.iter().map(|p| p.text.len()).sum();
    let node = node_value(store, analysis, entity);
    let prompt = build_prompt(analysis, &node, &pieces, question);
    Ok(json!({
        "schema": LLM_SCHEMA,
        "entity_id": entity,
        "analysis_id": analysis,
        "node": node,
        "model": config.model,
        "base_url": config.base_url,
        "pieces": pieces.iter().map(|p| json!({
            "label": p.label, "path": p.path, "reason": p.reason, "bytes": p.text.len(),
        })).collect::<Vec<_>>(),
        "total_bytes": total,
        "truncated": truncated,
        "prompt_bytes": prompt.len(),
        "prompt_preview": prompt.chars().take(1200).collect::<String>(),
        "note": "这就是将要发送的全部内容：只含上面列出的片段，不是整个项目。",
    }))
}

// --- running one generation -------------------------------------------------

/// Handles for generations in flight, so a cancel can reach the process and a
/// late answer can still be read back after the page moved on.
#[derive(Default)]
pub struct Jobs {
    cancel: Mutex<BTreeMap<String, tokio::sync::watch::Sender<bool>>>,
}

impl Jobs {
    fn register(&self, id: &str, sender: tokio::sync::watch::Sender<bool>) {
        if let Ok(mut slots) = self.cancel.lock() {
            slots.insert(id.to_string(), sender);
        }
    }
    fn signal(&self, id: &str) -> bool {
        if let Ok(mut slots) = self.cancel.lock()
            && let Some(sender) = slots.remove(id)
        {
            return sender.send(true).is_ok();
        }
        false
    }
    fn forget(&self, id: &str) {
        if let Ok(mut slots) = self.cancel.lock() {
            slots.remove(id);
        }
    }
}

/// Start one generation. The answer, the failure or the cancellation is written
/// to the store as its own record, so it survives a restart and stays attached
/// to the node and version it was asked about.
pub fn spawn(
    store: Store,
    jobs: Arc<Jobs>,
    project: String,
    anchor: String,
    analysis: String,
    entity: String,
    config: Config,
    question: String,
) -> Result<String, String> {
    let salt = now_ms();
    let id = atlas_engine::digest(
        format!("{project}\u{0}{anchor}\u{0}{analysis}\u{0}{salt}\u{0}{entity}\u{0}{question}")
            .as_bytes(),
    );
    let (pieces, _) = gather(
        &store,
        &analysis,
        &entity,
        &config.scope,
        config.max_context_bytes,
    )?;
    let node = node_value(&store, &analysis, &entity);
    let prompt = build_prompt(&analysis, &node, &pieces, &question);
    let adapter = resolve_adapter(&config.adapter).ok_or_else(|| "adapter_not_found".to_string())?;

    let write = |state: &str, body: &str, error: Option<String>| {
        let _ = store.save_llm_explanation(&json!({
            "id": id.clone(),
            "project": project,
            "anchor": anchor,
            "analysis_id": analysis,
            "entity_id": entity,
            "model": config.model,
            "base_url": config.base_url,
            "body": body,
            "state": state,
            "error": error,
            "created_at": now_ms(),
        }));
    };
    write("running", "", None);

    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    jobs.register(&id, cancel_tx);
    let handle = jobs.clone();
    let task_id = id.clone();
    let task_store = store.clone();
    let task_project = project.clone();
    let task_anchor = anchor.clone();
    let task_analysis = analysis.clone();
    let task_entity = entity.clone();
    tokio::spawn(async move {
        let outcome = run_adapter(&adapter, &config, &prompt, cancel_rx).await;
        let (state, body, error) = match outcome {
            Ok(text) => ("done", text, None),
            Err(error) if error == "cancelled" => ("cancelled", String::new(), Some("cancelled".to_string())),
            Err(error) => ("failed", String::new(), Some(error)),
        };
        let _ = task_store.save_llm_explanation(&json!({
            "id": task_id.clone(),
            "project": task_project,
            "anchor": task_anchor,
            "analysis_id": task_analysis,
            "entity_id": task_entity,
            "model": config.model,
            "base_url": config.base_url,
            "body": body,
            "state": state,
            "error": error,
            "created_at": now_ms(),
        }));
        handle.forget(&task_id);
    });
    Ok(id)
}

/// One request to the adapter process: the connection and the prompt go in on
/// stdin, one JSON object comes back on stdout.
async fn run_adapter(
    adapter: &Path,
    config: &Config,
    prompt: &str,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let input = json!({
        "base_url": config.base_url,
        "model": config.model,
        "api_key": config.api_key.clone().unwrap_or_default(),
        "prompt": prompt,
        "timeout_ms": config.timeout_ms,
    });
    let encoded = serde_json::to_vec(&input).map_err(|e| e.to_string())?;
    let mut child = tokio::process::Command::new("node")
        .arg(adapter)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("adapter_spawn_failed:{e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(&encoded)
            .await
            .map_err(|e| format!("adapter_stdin_failed:{e}"))?;
    }
    drop(child.stdin.take());

    let mut stdout = child.stdout.take().ok_or("adapter_stdout_missing")?;
    let mut stderr = child.stderr.take().ok_or("adapter_stderr_missing")?;
    // Read both pipes as they arrive: an adapter that writes a warning to
    // stderr would otherwise fill the pipe buffer and never get to the answer.
    let mut out = Vec::new();
    let mut err = Vec::new();
    let out_task = stdout.read_to_end(&mut out);
    let err_task = stderr.read_to_end(&mut err);
    tokio::pin!(out_task);
    tokio::pin!(err_task);
    // The adapter enforces its own timeout; this one is only the outer bound
    // for a process that stopped answering at all.
    let guard = tokio::time::sleep(std::time::Duration::from_millis(
        config.timeout_ms.saturating_add(15_000),
    ));
    tokio::pin!(guard);

    let status = loop {
        tokio::select! {
            _ = &mut out_task => {}
            _ = &mut err_task => {}
            _ = &mut guard => {
                let _ = child.kill().await;
                return Err("adapter_timeout".into());
            }
            changed = cancel.changed() => {
                if changed.is_ok() && *cancel.borrow() {
                    let _ = child.kill().await;
                    return Err("cancelled".into());
                }
            }
            status = child.wait() => break status,
        }
    };
    // Drain whatever is still buffered after the process exited.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), out_task).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), err_task).await;
    match status {
        Ok(_) => {}
        Err(error) => return Err(format!("adapter_wait_failed:{error}")),
    }
    let text = String::from_utf8_lossy(&out).to_string();
    let parsed: Option<Value> = serde_json::from_str(text.trim()).ok();
    match parsed {
        Some(value) if value["ok"] == true => Ok(value["text"].as_str().unwrap_or("").to_string()),
        Some(value) => Err(format!(
            "{}:{}",
            value["error"].as_str().unwrap_or("adapter_failed"),
            value["detail"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect::<String>()
        )),
        None => Err(format!(
            "adapter_output_not_json:{}",
            text.chars().take(300).collect::<String>()
        )),
    }
}

/// Read one generation's current state back: a page that navigated away and
/// returned, or one polling while it runs, reads the same record.
pub fn job(store: &Store, id: &str) -> Option<Value> {
    store.llm_explanation(id).ok().flatten()
}

/// Cancel a running generation. The record keeps its own state, so "cancelled"
/// is a real outcome and not an absence.
pub fn cancel_job(jobs: &Jobs, store: &Store, id: &str) -> bool {
    let signalled = jobs.signal(id);
    if signalled
        && let Ok(Some(mut row)) = store.llm_explanation(id)
        && row["state"] == "running"
        && let Some(object) = row.as_object_mut()
    {
        object.insert("state".into(), json!("cancelled"));
        object.insert("error".into(), json!("cancelled_by_user"));
        let _ = store.save_llm_explanation(&row);
    }
    signalled
}

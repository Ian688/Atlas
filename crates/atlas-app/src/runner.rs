//! W08 controlled execution: one pinned call, in an isolated copy of the
//! immutable snapshot, under the target's own Node with the permission model
//! switched on.
//!
//! What this module does NOT do, and must never be described as doing:
//! it does not sample line coverage, it does not build a run-time call graph,
//! and it does not turn a static BFS into an execution order. It observes the
//! entry call's return/throw, the process output, the exit status and the
//! source location the runtime reported. Everything else stays unknown.
use atlas_contract::Snapshot;
use atlas_engine::{
    exec::{self, ExecutionProfile, RunSpec},
    store::Store,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io,
    path::Path,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};

/// One probe result per node binary, for the life of this process.
fn probes() -> &'static Mutex<BTreeMap<String, Value>> {
    static PROBES: OnceLock<Mutex<BTreeMap<String, Value>>> = OnceLock::new();
    PROBES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Verify that the permission model actually *denies* something.
///
/// Presence of the `--permission` flag is not evidence of enforcement: a Node
/// that accepted the flag and ignored it would silently run every call
/// unsandboxed. The probe therefore attempts a write and requires the denial.
fn probe_permission_model(node: &str) -> Value {
    let script = "const fs=require('fs');\
        const p='/tmp/atlas-permission-probe-'+process.pid;\
        try{fs.writeFileSync(p,'x');try{fs.unlinkSync(p)}catch{};console.log('ATLAS_PROBE=ALLOWED')}\
        catch(e){console.log('ATLAS_PROBE=DENIED:'+(e&&e.code))}";
    let version = std::process::Command::new(node)
        .arg("--version")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .output();
    let version = match version {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => {
            return json!({"available": false, "reason": "node_not_runnable", "node": node});
        }
    };
    let probe = std::process::Command::new(node)
        .args(["--permission", "--eval", script])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .output();
    match probe {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let enforced = stdout.contains("ATLAS_PROBE=DENIED");
            json!({
                "available": true,
                "node": node,
                "node_version": version,
                "enforced": enforced,
                "probe_stdout": stdout.trim(),
                "reason": if enforced {Value::Null} else {json!("permission_model_not_enforcing")},
            })
        }
        Err(error) => {
            json!({"available": false, "reason": format!("node_probe_failed:{error}"), "node": node, "node_version": version})
        }
    }
}

fn permission_probe(node: &str) -> Value {
    if let Ok(cache) = probes().lock()
        && let Some(found) = cache.get(node)
    {
        return found.clone();
    }
    let probed = probe_permission_model(node);
    if let Ok(mut cache) = probes().lock() {
        cache.insert(node.to_string(), probed.clone());
    }
    probed
}

async fn bounded(mut reader: impl AsyncRead + Unpin, limit: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            return Ok((result, truncated));
        }
        if result.len() + n > limit {
            let room = limit.saturating_sub(result.len());
            result.extend_from_slice(&buffer[..room]);
            truncated = true;
            // Keep draining so the child is not blocked on a full pipe.
            continue;
        }
        result.extend_from_slice(&buffer[..n]);
    }
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    // The child is its own process-group leader, so a negative pid reaches any
    // process it spawned. Without this a leaked grandchild would outlive the
    // timeout that was supposed to contain it.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_tree(_pid: u32) {}

struct Supervised {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
    exit_code: Option<i32>,
    signal: Option<i32>,
    timed_out: bool,
    cancelled: bool,
    io_error: Option<String>,
    duration_ms: u64,
}

#[allow(clippy::too_many_arguments)]
async fn supervise(
    node: &str,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    payload: &str,
    timeout: Duration,
    output_limit: usize,
    mut cancel: watch::Receiver<bool>,
) -> Result<Supervised, String> {
    let mut command = Command::new(node);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    if *cancel.borrow() {
        return Err("cancelled_before_spawn".into());
    }
    let started = Instant::now();
    let mut child = command.spawn().map_err(|e| format!("spawn_failed:{e}"))?;
    let pid = child.id().ok_or("child_has_no_pid")?;
    let mut stdin = child.stdin.take().ok_or("child_stdin_missing")?;
    let stdout = child.stdout.take().ok_or("child_stdout_missing")?;
    let stderr = child.stderr.take().ok_or("child_stderr_missing")?;
    let input = payload.as_bytes().to_vec();
    let io_task = async move {
        let write = async move {
            stdin.write_all(&input).await?;
            stdin.shutdown().await?;
            drop(stdin);
            Ok::<_, io::Error>(())
        };
        let (_, out, err) = tokio::try_join!(
            write,
            bounded(stdout, output_limit),
            bounded(stderr, output_limit)
        )?;
        Ok::<_, io::Error>((out, err))
    };
    let mut outcome = Supervised {
        stdout: Vec::new(),
        stderr: Vec::new(),
        stdout_truncated: false,
        stderr_truncated: false,
        exit_code: None,
        signal: None,
        timed_out: false,
        cancelled: false,
        io_error: None,
        duration_ms: 0,
    };
    let mut finished = false;
    tokio::select! {
        biased;
        () = cancelled(&mut cancel) => {
            outcome.cancelled = true;
            kill_tree(pid);
        }
        () = tokio::time::sleep(timeout) => {
            outcome.timed_out = true;
            kill_tree(pid);
        }
        result = io_task => {
            match result {
                Ok(((out, out_truncated), (err, err_truncated))) => {
                    outcome.stdout = out;
                    outcome.stdout_truncated = out_truncated;
                    outcome.stderr = err;
                    outcome.stderr_truncated = err_truncated;
                    finished = true;
                }
                Err(error) => outcome.io_error = Some(error.to_string()),
            }
        }
    }
    if !finished {
        // The pipes are dropped here (select! dropped the losing future), so a
        // child blocked on write is released before it is reaped.
        kill_tree(pid);
        let _ = child.start_kill();
    }
    // A cancellation that arrives as the process exits must still be reported.
    if *cancel.borrow() {
        outcome.cancelled = true;
    }
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                outcome.signal = status.signal();
            }
            outcome.exit_code = status.code();
        }
        Ok(Err(error)) => {
            if outcome.io_error.is_none() {
                outcome.io_error = Some(format!("wait_failed:{error}"));
            }
        }
        Err(_) => {
            if outcome.io_error.is_none() {
                outcome.io_error = Some("child_did_not_exit_after_kill".into());
            }
        }
    }
    outcome.duration_ms = started.elapsed().as_millis() as u64;
    Ok(outcome)
}

/// Everything the runner needs that comes from the store, resolved once.
struct Pinned {
    snapshot: Snapshot,
    path: String,
    name: String,
    start: usize,
    end: usize,
    blob: String,
    profile: ExecutionProfile,
}

fn load_pinned(store: &Store, spec: &RunSpec) -> Result<Pinned, String> {
    let node = store
        .node(&spec.analysis_id, &spec.symbol)
        .map_err(|e| format!("symbol_not_found:{e}"))?;
    if node.kind != "function" {
        return Err("symbol_is_not_a_function".into());
    }
    let metadata = store
        .metadata(&spec.analysis_id)
        .map_err(|e| format!("analysis_not_found:{e}"))?;
    let snapshot_id = metadata["snapshot_id"]
        .as_str()
        .ok_or("analysis_has_no_snapshot")?;
    let snapshot = store
        .snapshot(snapshot_id)
        .map_err(|e| format!("snapshot_not_found:{e}"))?;
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.path == node.path)
        .ok_or("target_source_missing")?;
    let blob = entry.blob.clone().ok_or("target_source_not_captured")?;
    let fact = store
        .flow_fact(&spec.analysis_id, &spec.symbol)
        .map_err(|e| format!("flow_fact_not_found:{e}"))?;
    // A top-level function's captures are module-level state, which the copied
    // module initialises on import; a nested function's captures are an
    // enclosing scope that would have to be constructed.
    let top_level = node
        .parent
        .as_deref()
        .is_some_and(|parent| parent.starts_with("file:"));
    let profile = exec::profile(
        &spec.analysis_id,
        &spec.symbol,
        &node.path,
        &node.name,
        &fact,
        top_level,
    );
    Ok(Pinned {
        snapshot,
        path: node.path,
        name: node.name,
        start: node.start,
        end: node.end,
        blob,
        profile,
    })
}

/// The declared `engines.node` of the project under test, read from the pinned
/// snapshot. Atlas records it and refuses to pretend it evaluated it.
fn declared_node_range(store: &Store, snapshot: &Snapshot) -> Option<String> {
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.path == "package.json")?;
    let blob = entry.blob.as_ref()?;
    let bytes = store.read_blob(blob).ok()?;
    let parsed: Value = serde_json::from_slice(&bytes).ok()?;
    parsed
        .get("engines")?
        .get("node")?
        .as_str()
        .map(str::to_string)
}

fn base_record(spec: &RunSpec, pinned: &Pinned, spec_digest: &str) -> Value {
    json!({
        "schema": exec::EXEC_RECORD_SCHEMA,
        "analysis_id": spec.analysis_id,
        "snapshot_id": pinned.snapshot.id,
        "symbol": spec.symbol,
        "path": pinned.path,
        "name": pinned.name,
        "spec_digest": spec_digest,
        "spec": spec,
        "profile": pinned.profile,
    })
}

fn source_binding(pinned: &Pinned, spec: &RunSpec) -> Value {
    json!({
        "analysis_id": spec.analysis_id,
        "snapshot_id": pinned.snapshot.id,
        "path": pinned.path,
        "blob": pinned.blob,
        "start": pinned.start,
        "end": pinned.end,
        "bytes_verified": true,
        "verified_how": "每个字节都从内容寻址 blob 读取并在读取时重新哈希校验；执行副本由这些字节生成，因此分析与执行之间的源码漂移不可能发生，而不是被检测到。",
    })
}

fn refused_record(
    spec: &RunSpec,
    pinned: &Pinned,
    spec_digest: &str,
    reason: &exec::Reason,
) -> Value {
    let mut record = base_record(spec, pinned, spec_digest);
    let object = record.as_object_mut().unwrap();
    object.insert("verdict".into(), json!("refused"));
    object.insert("refusal".into(), json!(reason));
    object.insert("value".into(), Value::Null);
    object.insert("thrown".into(), Value::Null);
    object.insert(
        "console".into(),
        json!({"stdout": "", "stderr": "", "truncated": false}),
    );
    object.insert("duration_ms".into(), json!(0));
    object.insert("exit_code".into(), Value::Null);
    object.insert("source_binding".into(), source_binding(pinned, spec));
    object.insert(
        "trace".into(),
        json!({
            "kind": "none",
            "events": [],
            "coverage": "not_sampled",
            "unknown_paths": "not_observed",
            "note": "没有进程被启动：静态画像的结论就是拒绝，而不是一次失败的执行。",
        }),
    );
    object.insert(
        "isolation".into(),
        json!({"started": false, "reason": "refused_before_spawn"}),
    );
    record
}

/// Derive the profile for one published symbol without running anything.
pub fn profile_for(
    store: &Store,
    analysis: &str,
    symbol: &str,
) -> Result<ExecutionProfile, String> {
    let node = store
        .node(analysis, symbol)
        .map_err(|e| format!("symbol_not_found:{e}"))?;
    let fact = store
        .flow_fact(analysis, symbol)
        .map_err(|e| format!("flow_fact_not_found:{e}"))?;
    let top_level = node
        .parent
        .as_deref()
        .is_some_and(|parent| parent.starts_with("file:"));
    Ok(exec::profile(
        analysis, symbol, &node.path, &node.name, &fact, top_level,
    ))
}

/// The static plan for a spec: what would run, and what it would be refused
/// for. No process is started, so a caller can inspect the decision first.
pub fn plan(store: &Store, spec: &RunSpec) -> Result<Value, String> {
    spec.validate().map_err(|e| e.to_string())?;
    let spec_digest = spec.digest().map_err(|e| e.to_string())?;
    let pinned = load_pinned(store, spec)?;
    let decision = exec::decide(&pinned.profile, spec);
    Ok(json!({
        "schema": "atlas.execution-plan.v1",
        "analysis_id": spec.analysis_id,
        "snapshot_id": pinned.snapshot.id,
        "symbol": spec.symbol,
        "path": pinned.path,
        "name": pinned.name,
        "spec_digest": spec_digest,
        "profile": pinned.profile,
        "decision": decision,
        "will_start_process": decision.allowed,
        "note": "计划阶段不启动任何进程；allowed=false 表示静态画像或权限声明已经拒绝，不需要先失败一次。",
    }))
}

/// Execute one pinned call and publish the record.
pub async fn execute(
    store: &Store,
    spec: &RunSpec,
    cancel: watch::Receiver<bool>,
) -> Result<Value, String> {
    spec.validate().map_err(|e| e.to_string())?;
    let spec_digest = spec.digest().map_err(|e| e.to_string())?;
    let pinned = load_pinned(store, spec)?;
    let decision = exec::decide(&pinned.profile, spec);
    if !decision.allowed {
        let missing_grants = decision.missing_grants.clone();
        let missing_context = decision.missing_context.clone();
        let reason = decision.refusal.unwrap_or(exec::Reason {
            code: "refused".into(),
            detail: "决策拒绝了本次执行".into(),
            evidence: "execution_decision".into(),
        });
        let mut record = refused_record(spec, &pinned, &spec_digest, &reason);
        if let Some(refusal) = record
            .get_mut("refusal")
            .and_then(|value| value.as_object_mut())
        {
            // A refusal that does not say *what* is missing makes the caller
            // guess and re-run; the lists are the actionable part.
            refusal.insert("missing_grants".into(), json!(missing_grants));
            refusal.insert("missing_context".into(), json!(missing_context));
        }
        let identity =
            serde_json::to_string(&answer_identity(&record)).map_err(|e| e.to_string())?;
        store
            .publish_exec_record(&mut record, &identity)
            .map_err(|e| e.to_string())?;
        return Ok(record);
    }

    let probe = tokio::task::spawn_blocking({
        let node = spec.node.clone();
        move || permission_probe(&node)
    })
    .await
    .map_err(|e| e.to_string())?;
    if probe["enforced"].as_bool() != Some(true) {
        let reason = exec::Reason {
            code: "permission_model_unavailable".into(),
            detail: format!(
                "目标 Node 没有可验证的权限模型（{}），Atlas 拒绝在无强制边界的进程里执行用户代码",
                probe["reason"].as_str().unwrap_or("unknown")
            ),
            evidence: "node --permission capability probe".into(),
        };
        let mut record = refused_record(spec, &pinned, &spec_digest, &reason);
        if let Some(object) = record.as_object_mut() {
            object.insert(
                "isolation".into(),
                json!({"started": false, "probe": probe}),
            );
        }
        let identity =
            serde_json::to_string(&answer_identity(&record)).map_err(|e| e.to_string())?;
        store
            .publish_exec_record(&mut record, &identity)
            .map_err(|e| e.to_string())?;
        return Ok(record);
    }

    let prepared = exec::prepare(
        store,
        &pinned.snapshot,
        &pinned.path,
        pinned.start,
        pinned.end,
    )
    .map_err(|e| format!("prepare_failed:{e}"))?;
    let marker = format!(
        "@@ATLAS-REPORT-{}-{}@@",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    );
    let payload = exec::harness_payload(&prepared, spec, Some(&pinned.name), &marker)
        .map_err(|e| e.to_string())?;

    let mut args: Vec<String> = vec!["--permission".into()];
    let copy_root = prepared.root.display().to_string();
    args.push(format!("--allow-fs-read={copy_root}"));
    if spec.grants.fs_write {
        args.push(format!("--allow-fs-write={copy_root}"));
    }
    if spec.grants.child_process {
        args.push("--allow-child-process".into());
    }
    if spec.grants.network {
        args.push("--allow-net".into());
    }
    args.push(prepared.harness.display().to_string());

    let supervised = supervise(
        &spec.node,
        &args,
        &prepared.root,
        &spec.env,
        &payload,
        Duration::from_millis(spec.timeout_ms),
        spec.output_limit,
        cancel.clone(),
    )
    .await?;

    let mut record = base_record(spec, &pinned, &spec_digest);
    let isolation = json!({
        "started": true,
        "node_binary": spec.node,
        "node_version": probe["node_version"],
        "permission_model": "node --permission (probe-verified: an attempted write was denied)",
        "permission_probe": probe,
        "effective_flags": args,
        "workdir_digest": prepared.workdir_digest,
        "files_materialised": prepared.manifest.len(),
        "environment_allowlist": spec.env.keys().collect::<Vec<_>>(),
        "path_inherited": true,
        "mocks": spec.fixtures,
        "fixture_note": spec.fixture_note,
        // What the caller declared, not what Atlas invented. A receiver or a
        // global is an input to the run, and the record has to say which ones
        // were stated so a reader can judge the result.
        "declared_context": {
            "this_arg": spec.this_arg.is_some(),
            "globals": spec.globals.keys().collect::<Vec<_>>(),
        },
        "cwd": "隔离副本根目录",
    });
    let source_binding = source_binding(&pinned, spec);
    let declared = declared_node_range(store, &pinned.snapshot);

    let mut verdict: String;
    let mut value = Value::Null;
    let mut thrown = Value::Null;
    let mut source_location = Value::Null;
    let mut trace_async_events: Value = json!([]);
    let mut events: Vec<Value> = vec![json!({
        "kind": "call",
        "symbol": spec.symbol,
        "path": pinned.path,
        "start": pinned.start,
        "end": pinned.end,
        "args": spec.args,
    })];
    let mut console = json!({
        "stdout": visible_stdout(&supervised.stdout, &marker),
        "stderr": String::from_utf8_lossy(&supervised.stderr).chars().take(8192).collect::<String>(),
        "truncated": supervised.stdout_truncated || supervised.stderr_truncated,
    });

    if supervised.cancelled {
        verdict = "cancelled".into();
        events.push(json!({"kind": "cancelled"}));
    } else if supervised.timed_out {
        verdict = "timeout".into();
        events.push(json!({"kind": "timeout", "timeout_ms": spec.timeout_ms}));
    } else if let Some(error) = &supervised.io_error {
        verdict = "failed".into();
        events.push(json!({"kind": "io_error", "detail": error}));
    } else if let Some(report) = parse_report(&supervised.stdout, &marker) {
        verdict = report["verdict"].as_str().unwrap_or("failed").to_string();
        // A harness-level failure is named precisely: "the target was not
        // exported" is a different fact from "the call failed", and a consumer
        // that confuses them would treat a never-run function as a result.
        if let Some(detail) = report["detail"].as_str() {
            verdict = detail.to_string();
        }
        value = report["value"].clone();
        thrown = report["thrown"].clone();
        if let Some(lines) = report["console"]["lines"].as_array() {
            console = json!({
                "stdout": visible_stdout(&supervised.stdout, &marker),
                "stderr": String::from_utf8_lossy(&supervised.stderr).chars().take(8192).collect::<String>(),
                "harness_lines": lines,
                "harness_truncated": report["console"]["truncated"],
                "truncated": supervised.stdout_truncated || supervised.stderr_truncated,
            });
        }
        if let Some(frames) = report["thrown"]["stack"].as_array() {
            let source = read_target_source(store, &pinned);
            for frame in frames.iter().filter_map(|v| v.as_str()) {
                if let Some(mapped) = source
                    .as_deref()
                    .and_then(|text| exec::map_stack_frame(&prepared.root, frame, text))
                {
                    source_location = mapped;
                    break;
                }
            }
        }
        // The event kind comes from the harness' own verdict, not from the
        // (possibly overridden) record verdict: a target that was never called
        // must not produce a "returned" event.
        let event_kind = match report["verdict"].as_str().unwrap_or("failed") {
            "returned" => "returned",
            "threw" | "returned_with_async_error" => "threw",
            _ => "not_run",
        };
        trace_async_events = report["async_events"].clone();
        events.push(json!({
            "kind": event_kind,
            "export_name": report["export_name"],
            "matched_by": report["matched_by"],
            "awaited": report["awaited"],
            "source_location": source_location,
            "async_events": report["async_events"],
            "harness_detail": report["detail"],
            "candidates": report["candidates"],
            "declared_globals": report["declared_globals"],
            "receiver_declared": report["receiver_declared"],
        }));
    } else {
        // No report. Two very different causes must not share one label: an
        // exhausted output budget is a bound Atlas chose and can raise, while a
        // missing report with output left over is a harness failure. Calling
        // the first a "harness error" would point the reader at the wrong
        // component.
        verdict = if supervised.stdout_truncated {
            "output_limit_exceeded".into()
        } else {
            "harness_error".into()
        };
        events.push(json!({
            "kind": verdict,
            "detail": if supervised.stdout_truncated {
                "输出预算耗尽，执行报告被截断；退出码与已捕获输出原样保留，不推测返回值"
            } else {
                "子进程没有产出带标记的执行报告；退出码与输出原样保留，不推测结果"
            },
            "stdout_truncated": supervised.stdout_truncated,
            "stderr_truncated": supervised.stderr_truncated,
            "exit_code": supervised.exit_code,
        }));
    }

    let object = record.as_object_mut().unwrap();
    object.insert("verdict".into(), json!(verdict));
    object.insert("refusal".into(), Value::Null);
    object.insert("value".into(), value);
    object.insert("thrown".into(), thrown.clone());
    object.insert("console".into(), console);
    object.insert("duration_ms".into(), json!(supervised.duration_ms));
    object.insert("exit_code".into(), json!(supervised.exit_code));
    object.insert("signal".into(), json!(supervised.signal));
    object.insert("source_binding".into(), source_binding);
    object.insert("isolation".into(), isolation);
    object.insert(
        "effect_journal".into(),
        effect_journal(&thrown, &trace_async_events, spec),
    );
    object.insert(
        "environment".into(),
        json!({
            "declared_node_range_in_snapshot": declared,
            "actual_node_version": probe["node_version"],
            "qualified": false,
            "note": "Atlas 记录目标项目声明的 engines.node 与实际使用的 Node 版本，但不声称二者兼容；没有用 Atlas 自己的 Node 冒充目标环境，二进制由调用者指定。",
        }),
    );
    object.insert(
        "trace".into(),
        json!({
            "kind": "observed-entry-call",
            "events": events,
            "coverage": "not_sampled",
            "unknown_paths": "not_observed",
            "note": "只观测到入口调用的返回/抛出、进程输出与退出状态，以及运行时报告的源码位置。没有行级覆盖采样；未观测路径保持未知；静态 BFS 不作为执行顺序。",
        }),
    );
    let identity = serde_json::to_string(&answer_identity(&record)).map_err(|e| e.to_string())?;
    store
        .publish_exec_record(&mut record, &identity)
        .map_err(|e| e.to_string())?;
    Ok(record)
}

fn read_target_source(store: &Store, pinned: &Pinned) -> Option<String> {
    store
        .read_blob(&pinned.blob)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

/// What the run *tried* to do outside the sandbox, as far as the runtime reports
/// it.
///
/// Only denials are individually observable: Node attaches the attempted
/// permission and its target to the error it throws. Allowed operations leave no
/// per-operation trace, so the journal does not pretend to list them -- the
/// granted set is the bound, and the note says so. Reporting "no denied
/// attempts" as "no effects" would be exactly the kind of claim this project
/// refuses to make.
fn effect_journal(thrown: &Value, async_events: &Value, spec: &RunSpec) -> Value {
    let mut entries: Vec<Value> = Vec::new();
    let mut collect = |error: &Value| {
        if let Some(permission) = error.get("permission").and_then(|value| value.as_str()) {
            entries.push(json!({
                "outcome": "denied",
                "permission": permission,
                "resource": error.get("resource"),
                "error_code": error.get("code"),
                "evidence": "运行时抛出 ERR_ACCESS_DENIED，并带回被尝试的操作与目标",
            }));
        }
    };
    collect(thrown);
    if let Some(events) = async_events.as_array() {
        for event in events {
            if let Some(error) = event.get("thrown") {
                collect(error);
            }
        }
    }
    json!({
        "schema": "atlas.effect-journal.v1",
        "entries": entries,
        "denied_count": entries.len(),
        "granted": {
            "fs_write": spec.grants.fs_write,
            "child_process": spec.grants.child_process,
            "network": spec.grants.network,
        },
        "observed": entries.len(),
        "note": "只记录运行时明确报告的拒绝尝试（含权限种类与目标）。被允许的操作没有逐条日志，因此这里不声称'没有效果'；授予集合就是这次运行的边界。",
    })
}

/// What the called code itself wrote to stdout. The harness report is removed,
/// because it carries a per-run marker and absolute temporary paths that must
/// never reach a record: they would make the same answer look like a new one.
fn visible_stdout(stdout: &[u8], marker: &str) -> String {
    let text = String::from_utf8_lossy(stdout);
    let cut = text.rfind(marker).unwrap_or(text.len());
    text[..cut].chars().take(8192).collect()
}

/// The canonical answer a record is identified by: the pinned question plus the
/// observed outcome, with timing and machine-specific paths excluded.
fn answer_identity(record: &Value) -> Value {
    json!({
        "schema": exec::EXEC_RECORD_SCHEMA,
        "analysis_id": record["analysis_id"],
        "snapshot_id": record["snapshot_id"],
        "symbol": record["symbol"],
        "spec_digest": record["spec_digest"],
        "profile_classification": record["profile"]["classification"],
        "verdict": record["verdict"],
        "refusal": record["refusal"],
        "value": record["value"],
        "thrown": {
            "name": record["thrown"]["name"],
            "message": record["thrown"]["message"],
            "code": record["thrown"]["code"],
        },
        "console_lines": record["console"]["harness_lines"],
        "exit_code": record["exit_code"],
        "signal": record["signal"],
    })
}

/// The harness writes `<marker><json>` as the last thing on stdout.
fn parse_report(stdout: &[u8], marker: &str) -> Option<Value> {
    let text = String::from_utf8_lossy(stdout);
    let index = text.rfind(marker)?;
    let body = text[index + marker.len()..].trim();
    serde_json::from_str(body).ok()
}

/// Compare one observed record against an expected outcome.
fn case_matches(expected: &Value, record: &Value) -> (bool, Vec<String>) {
    let mut failures = Vec::new();
    let verdict = record["verdict"].as_str().unwrap_or("failed");
    if let Some(want) = expected.get("returns") {
        if verdict != "returned" {
            failures.push(format!("期望返回，实际 verdict={verdict}"));
        } else {
            let observed = decode_encoded(&record["value"]);
            if &observed != want {
                failures.push(format!("返回 {observed}，期望 {want}"));
            }
        }
    }
    if let Some(want) = expected.get("throws") {
        if !matches!(verdict, "threw" | "returned_with_async_error") {
            failures.push(format!("期望抛出，实际 verdict={verdict}"));
        } else {
            if let Some(name) = want.get("name").and_then(|v| v.as_str())
                && record["thrown"]["name"].as_str() != Some(name)
            {
                failures.push(format!("抛出 {}，期望 {name}", record["thrown"]["name"]));
            }
            if let Some(text) = want.get("message_contains").and_then(|v| v.as_str()) {
                let message = record["thrown"]["message"].as_str().unwrap_or("");
                if !message.contains(text) {
                    failures.push(format!("错误消息 {message:?} 不含 {text:?}"));
                }
            }
            if let Some(code) = want.get("code").and_then(|v| v.as_str())
                && record["thrown"]["code"].as_str() != Some(code)
            {
                failures.push(format!("错误码 {}，期望 {code}", record["thrown"]["code"]));
            }
        }
    }
    if expected.get("denied").and_then(|v| v.as_bool()) == Some(true) {
        let code = record["thrown"]["code"].as_str().unwrap_or("");
        if code != "ERR_ACCESS_DENIED" {
            failures.push(format!("期望被权限模型拒绝，实际错误码 {code:?}"));
        }
    }
    if let Some(want) = expected.get("awaited").and_then(|v| v.as_bool()) {
        let actual = record["trace"]["events"]
            .as_array()
            .and_then(|events| events.last())
            .and_then(|event| event.get("awaited"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if actual != want {
            failures.push(format!("awaited={actual}，期望 {want}"));
        }
    }
    (failures.is_empty(), failures)
}

/// Decode the harness' tagged value encoding back to plain JSON where it is
/// unambiguous. Types that JSON cannot express stay tagged, so a comparison
/// against `{"kind":"nan"}` is exact rather than accidental.
pub fn decode_encoded(value: &Value) -> Value {
    let Some(kind) = value.get("kind").and_then(|v| v.as_str()) else {
        return value.clone();
    };
    match kind {
        "null" => Value::Null,
        "number" | "string" | "boolean" | "bigint" => {
            value.get("value").cloned().unwrap_or(Value::Null)
        }
        "undefined" => json!({"kind": "undefined"}),
        "nan" => json!({"kind": "nan"}),
        "infinity" => json!({"kind": "infinity"}),
        "negative_infinity" => json!({"kind": "negative_infinity"}),
        "array" => Value::Array(
            value
                .get("items")
                .and_then(|v| v.as_array())
                .map(|items| items.iter().map(decode_encoded).collect())
                .unwrap_or_default(),
        ),
        "object" => {
            let mut object = serde_json::Map::new();
            if let Some(entries) = value.get("entries").and_then(|v| v.as_object()) {
                for (key, entry) in entries {
                    object.insert(key.clone(), decode_encoded(entry));
                }
            }
            Value::Object(object)
        }
        other => json!({"kind": other}),
    }
}

/// Run a scenario file: every case is a separate pinned execution, and a case
/// that is refused is reported as refused rather than as a failed assertion.
pub async fn run_scenario(
    store: &Store,
    base: &RunSpec,
    scenario: &Value,
    cancel: watch::Receiver<bool>,
) -> Result<Value, String> {
    if scenario.get("schema").and_then(|v| v.as_str()) != Some(exec::SCENARIO_SCHEMA) {
        return Err("invalid_scenario_schema".into());
    }
    let name = scenario
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("scenario")
        .to_string();
    let cases = scenario
        .get("cases")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or("scenario_has_no_cases")?;
    if cases.is_empty() || cases.len() > 64 {
        return Err("scenario_case_count_out_of_range".into());
    }
    let total = cases.len();
    let mut results = Vec::new();
    let mut passed = 0usize;
    let mut refused = 0usize;
    let mut failed = 0usize;
    let mut stopped: Option<String> = None;
    for (index, case) in cases.iter().enumerate() {
        let case_name = case
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("case{index}"));
        let mut spec = base.clone();
        if let Some(args) = case.get("args").and_then(|v| v.as_array()) {
            spec.args = args.clone();
        }
        if *cancel.borrow() {
            // A cancelled scenario must stop, not march through the remaining
            // cases producing a row of immediately-cancelled entries that make
            // it look like every case was attempted.
            stopped = Some("cancelled".into());
            break;
        }
        let record = execute(store, &spec, cancel.clone()).await?;
        let verdict = record["verdict"].as_str().unwrap_or("failed").to_string();
        if verdict == "cancelled" {
            stopped = Some("cancelled".into());
            results.push(json!({
                "name": case_name,
                "outcome": "cancelled",
                "record_id": record["id"],
            }));
            break;
        }
        if verdict == "refused" {
            refused += 1;
            results.push(json!({
                "name": case_name,
                "outcome": "refused",
                "refusal": record["refusal"],
                "record_id": record["id"],
            }));
            continue;
        }
        let expected = case.get("expect").cloned().unwrap_or(json!({}));
        let (ok, failures) = case_matches(&expected, &record);
        if ok {
            passed += 1;
        } else {
            failed += 1;
        }
        results.push(json!({
            "name": case_name,
            "outcome": if ok {"passed"} else {"failed"},
            "expected": expected,
            "verdict": verdict,
            "value": record["value"],
            "thrown": record["thrown"],
            "failures": failures,
            "record_id": record["id"],
        }));
    }
    Ok(json!({
        "schema": "atlas.scenario-result.v1",
        "analysis_id": base.analysis_id,
        "symbol": base.symbol,
        "name": name,
        "declared_cases": total,
        "attempted_cases": results.len(),
        "stopped": stopped,
        "passed": passed,
        "failed": failed,
        "refused": refused,
        "cases": results,
        "note": "每个用例都是一次独立的固定执行；refused 表示静态画像拒绝执行，不是断言失败，也不是执行成功。stopped=cancelled 表示取消后剩余用例没有被尝试，attempted_cases 会小于 declared_cases。",
    }))
}

/// Resolve any published entity: a function by id/`path:name`/name, or a file by
/// path/name. Unlike a display lookup this never falls back to the raw string:
/// a selection that names something the analysis does not have is an error, and
/// inventing an entity id for it would make an empty answer look like a fact.
pub fn resolve_entity(store: &Store, analysis: &str, reference: &str) -> Result<String, String> {
    if let Ok(node) = store.node(analysis, reference) {
        return Ok(node.id);
    }
    if let Ok(symbol) = resolve_symbol(store, analysis, reference) {
        return Ok(symbol);
    }
    let mut cursor: Option<String> = None;
    let mut files: Vec<String> = Vec::new();
    for _ in 0..20 {
        let page = store
            .nodes(analysis, "file", 500, cursor.as_deref())
            .map_err(|e| e.to_string())?;
        for node in &page.items {
            if node.path == reference || node.name == reference || node.id == reference {
                files.push(node.id.clone());
            }
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    match files.len() {
        0 => Err(format!("entity_not_found:{reference}")),
        1 => Ok(files[0].clone()),
        _ => Err(format!("ambiguous_entity:{reference}:{}", files.len())),
    }
}

/// Resolve a symbol id, or a `path:name` / bare `name` reference, to a symbol.
pub fn resolve_symbol(store: &Store, analysis: &str, reference: &str) -> Result<String, String> {
    if reference.starts_with("symbol:") {
        return Ok(reference.to_string());
    }
    let mut matches: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    // Page boundedly: a large project must not be resolved by loading every
    // node at once, and an ambiguous name must stay ambiguous instead of
    // resolving to whichever page happened to be loaded.
    for _ in 0..20 {
        let page = store
            .nodes(analysis, "function", 500, cursor.as_deref())
            .map_err(|e| e.to_string())?;
        for node in &page.items {
            if node.name == reference
                || format!("{}:{}", node.path, node.name) == reference
                || node.id == reference
            {
                matches.push(node.id.clone());
            }
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    match matches.len() {
        0 => Err(format!("symbol_not_found:{reference}")),
        1 => Ok(matches[0].clone()),
        _ => Err(format!("ambiguous_symbol:{reference}:{}", matches.len())),
    }
}

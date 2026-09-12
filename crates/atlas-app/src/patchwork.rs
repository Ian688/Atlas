//! W09 continuation: the rest of the AI Coding chain.
//!
//! propose (validated against pinned bytes) -> verify (isolated copy, re-index,
//! graph diff, optional declared test) -> apply / revert against a checkout
//! whose bytes are checked first.
//!
//! Two rules shape every step:
//!
//! * **A proposal never touches the user's checkout until `apply`**, and
//!   `apply` refuses if the target's bytes are no longer the bytes the proposal
//!   was verified against. Overwriting work that happened after review is not a
//!   merge, it is a loss.
//! * **Intent, Static and Observed stay separate.** The diff is Intent, the
//!   re-derived analysis and graph diff are Static, and the test run is
//!   Observed -- each labelled, with "no test was run" never rendered as a pass.
use atlas_engine::{
    control::ExecutionControl,
    patch::{self, FilePatch},
    store::Store,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

/// Compare two published analyses in the way an edit is actually shaped.
///
/// Node ids are content-addressed over their source span, so editing a function
/// changes its id. Keying on the id would report every edit as a removal plus an
/// addition; keying on `path:name` reports it as the change it is. The ids are
/// still reported, because a consumer that needs byte-exact identity should have
/// it.
pub fn graph_diff(store: &Store, base: &str, patched: &str) -> Result<Value, String> {
    let base_nodes = all_nodes(store, base)?;
    let patched_nodes = all_nodes(store, patched)?;
    let base_edges = all_edges(store, base)?;
    let patched_edges = all_edges(store, patched)?;

    let key = |node: &Value| -> String {
        let path = node["path"].as_str().unwrap_or("");
        let name = node["name"].as_str().unwrap_or("");
        format!("{}|{}|{}", node["kind"].as_str().unwrap_or(""), path, name)
    };
    let index = |nodes: &[Value]| -> BTreeMap<String, Value> {
        let mut map = BTreeMap::new();
        for node in nodes {
            map.insert(key(node), node.clone());
        }
        map
    };
    let before = index(&base_nodes);
    let after = index(&patched_nodes);
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    for (id, node) in &after {
        match before.get(id) {
            None => added.push(json!({
                "kind": node["kind"], "path": node["path"], "name": node["name"],
                "node_id": node["id"], "start": node["start"], "end": node["end"],
            })),
            Some(old) => {
                let moved = old["start"] != node["start"] || old["end"] != node["end"];
                let renamed = old["name"] != node["name"];
                if moved || renamed || old["id"] != node["id"] {
                    changed.push(json!({
                        "kind": node["kind"], "path": node["path"], "name": node["name"],
                        "before": {"node_id": old["id"], "start": old["start"], "end": old["end"], "name": old["name"]},
                        "after": {"node_id": node["id"], "start": node["start"], "end": node["end"], "name": node["name"]},
                    }));
                }
            }
        }
    }
    for (id, node) in &before {
        if !after.contains_key(id) {
            removed.push(json!({
                "kind": node["kind"], "path": node["path"], "name": node["name"],
                "node_id": node["id"],
            }));
        }
    }

    // Edges are compared by what a reader can act on: kind, label and the paths
    // at both ends. The ids move with the source spans for the same reason.
    let edge_key = |edge: &Value| -> String {
        format!(
            "{}|{}|{}|{}",
            edge["kind"].as_str().unwrap_or(""),
            edge["label"].as_str().unwrap_or(""),
            edge["path"].as_str().unwrap_or(""),
            edge["target"].as_str().unwrap_or("<unresolved>")
        )
    };
    let before_edges: std::collections::BTreeSet<String> =
        base_edges.iter().map(edge_key).collect();
    let after_edges: std::collections::BTreeSet<String> =
        patched_edges.iter().map(edge_key).collect();
    let edges_added: Vec<&String> = after_edges.difference(&before_edges).take(200).collect();
    let edges_removed: Vec<&String> = before_edges.difference(&after_edges).take(200).collect();

    let base_meta = store.metadata(base).map_err(|e| e.to_string())?;
    let patched_meta = store.metadata(patched).map_err(|e| e.to_string())?;
    let count = |meta: &Value, key: &str| meta[key].as_u64().unwrap_or(0);
    Ok(json!({
        "schema": "atlas.graph-diff.v1",
        "base_analysis_id": base,
        "patched_analysis_id": patched,
        "nodes": {
            "added": added, "removed": removed, "changed": changed,
            "added_count": added.len(), "removed_count": removed.len(), "changed_count": changed.len(),
            "truncated": added.len() + removed.len() + changed.len() > 600,
        },
        "edges": {
            "added": edges_added, "removed": edges_removed,
            "added_count": after_edges.difference(&before_edges).count(),
            "removed_count": before_edges.difference(&after_edges).count(),
        },
        "counts": {
            "functions": {"before": count(&base_meta, "function_count"), "after": count(&patched_meta, "function_count")},
            "files": {"before": count(&base_meta, "file_count"), "after": count(&patched_meta, "file_count")},
            "calls": {"before": count(&base_meta, "call_count"), "after": count(&patched_meta, "call_count")},
            "unresolved_calls": {"before": count(&base_meta, "unresolved_call_count"), "after": count(&patched_meta, "unresolved_call_count")},
        },
        "note": "节点按 path+name 重新配对：节点 id 绑定源码字节区间，编辑函数会改变 id，按 id 比较会把每次编辑读成一次删除加一次新增。id 仍然原样给出。",
    }))
}

fn all_nodes(store: &Store, analysis: &str) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..40 {
        let page = store
            .nodes(analysis, "all", 500, cursor.as_deref())
            .map_err(|e| e.to_string())?;
        out.extend(
            page.items
                .iter()
                .map(|node| serde_json::to_value(node).unwrap_or(Value::Null)),
        );
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(out)
}

fn all_edges(store: &Store, analysis: &str) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..40 {
        let page = store
            .edges(analysis, "call_candidate", 500, cursor.as_deref())
            .map_err(|e| e.to_string())?;
        out.extend(
            page.items
                .iter()
                .map(|edge| serde_json::to_value(edge).unwrap_or(Value::Null)),
        );
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(out)
}

/// How to verify a proposal. Kept separate from the CLI so the same code serves
/// a foreground `patch verify` and a queued `patch_verify` job: a queued request
/// that took a different path would not be the same operation.
pub struct VerifyOptions {
    pub node: PathBuf,
    pub worker: PathBuf,
    /// Heap ceiling for the language worker, in MiB, carried through from the
    /// caller exactly like the other runner parameters.
    pub worker_heap_mb: u32,
    pub timeout: Duration,
    pub scan_deadline: Duration,
    pub index_deadline: Duration,
    pub test_argv: Option<Vec<String>>,
    pub test_timeout: Duration,
}

/// Verify a stored proposal: isolated copy, full re-index, graph diff, optional
/// declared test. Returns the updated proposal.
pub async fn verify_proposal(
    store: &Store,
    proposal_id: &str,
    options: &VerifyOptions,
) -> Result<Value, String> {
    let proposal = store
        .patch_proposal(proposal_id)
        .map_err(|e| e.to_string())?;
    if proposal.state != patch::STATE_PROPOSED {
        return Err(format!("proposal_not_verifiable:{}", proposal.state));
    }
    let parsed = reparsed(&proposal)?;
    let metadata = store
        .metadata(&proposal.analysis_id)
        .map_err(|e| e.to_string())?;
    let snapshot = store
        .snapshot(
            metadata["snapshot_id"]
                .as_str()
                .ok_or("analysis_has_no_snapshot")?,
        )
        .map_err(|e| e.to_string())?;
    let files = patch::snapshot_files(store, &snapshot).map_err(|e| e.to_string())?;
    let outcome = patch::apply(&files, &parsed).map_err(|e| e.to_string())?;
    // An isolated copy: the user's checkout is never the thing that gets
    // re-indexed, so a proposal cannot affect the analysis it was proposed
    // against. A `create` adds a file the analysis never saw and a `delete`
    // leaves one out, so the copy is assembled from the outcome, not from the
    // snapshot plus edits.
    let dir = patch::materialize(store, &snapshot, &outcome).map_err(|e| e.to_string())?;
    let options_for_index = crate::IndexOptions::new(
        options.node.clone(),
        options.worker.clone(),
        options.timeout.as_secs(),
        options.scan_deadline.as_secs(),
        options.index_deadline.as_secs(),
        false,
        options.worker_heap_mb,
    )
    .map_err(|e| e.to_string())?;
    let control = ExecutionControl::new(Some(
        std::time::Instant::now() + options_for_index.index_deadline,
    ));
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let _signal_watcher =
        crate::signal_watcher(control.clone(), cancel_tx).map_err(|e| e.to_string())?;
    let result = crate::run_pipeline(store, dir.path(), &options_for_index, &control, cancel_rx)
        .await
        .map_err(|e| e.to_string())?;
    let graph = graph_diff(store, &proposal.analysis_id, &result.analysis_id)?;
    let test = match options.test_argv.as_deref() {
        Some(argv) if !argv.is_empty() => {
            run_declared_test(argv, dir.path(), options.test_timeout, 64 * 1024).await
        }
        _ => json!({
            "observed": false,
            "ran": false,
            "note": "没有声明测试命令，因此没有跑任何测试。这不是通过。",
        }),
    };
    let verification = json!({
        "schema": "atlas.patch-verification.v1",
        "base_analysis_id": proposal.analysis_id,
        "patched_snapshot_id": result.metadata["snapshot_id"],
        "patched_analysis_id": result.analysis_id,
        "applied_files": outcome.report,
        "deleted_paths": outcome.deleted.iter().collect::<Vec<_>>(),
        "graph_diff": graph,
        "test": test,
        "isolation": {
            "method": "从不可变快照的内容寻址 blob 物化到 0700 临时目录，补丁只写在这个副本里",
            "user_checkout_touched": false,
        },
        "note": "Intent（diff）→ Static（重新派生的分析与图差异）→ Observed（测试命令的退出码）三类证据在这里分开存放，不互相冒充。",
    });
    if !store
        .mark_patch_verified(proposal_id, &verification)
        .map_err(|e| e.to_string())?
    {
        return Err("proposal_verification_lost_a_race".into());
    }
    let updated = store
        .patch_proposal(proposal_id)
        .map_err(|e| e.to_string())?;
    serde_json::to_value(updated).map_err(|e| e.to_string())
}

/// Run a declared test command in an isolated copy.
///
/// The command is an argv array, never a shell string, so there is no shell to
/// interpret a metacharacter. It is observed evidence and is labelled as such,
/// including the case where no command was declared at all.
pub async fn run_declared_test(
    argv: &[String],
    cwd: &std::path::Path,
    timeout: std::time::Duration,
    output_limit: usize,
) -> Value {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let Some(program) = argv.first() else {
        return json!({"observed": false, "ran": false, "note": "没有声明测试命令，因此没有跑任何测试；这不是通过。"});
    };
    let mut command = tokio::process::Command::new(program);
    command
        .args(&argv[1..])
        .current_dir(cwd)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let started = std::time::Instant::now();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return json!({"observed": true, "ran": false, "argv": argv, "error": format!("spawn_failed:{error}"), "note": "测试命令没有启动；这既不是通过也不是失败。"});
        }
    };
    let pid = child.id();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let read = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        if let Some(handle) = stdout.as_mut() {
            let _ = handle.take(output_limit as u64).read_to_end(&mut out).await;
        }
        if let Some(handle) = stderr.as_mut() {
            let _ = handle.take(output_limit as u64).read_to_end(&mut err).await;
        }
        (out, err)
    };
    let outcome = tokio::time::timeout(timeout, async {
        let (out, err) = read.await;
        let status = child.wait().await;
        (out, err, status)
    })
    .await;
    match outcome {
        Ok((out, err, Ok(status))) => json!({
            "observed": true,
            "ran": true,
            "argv": argv,
            "exit_code": status.code(),
            "passed": status.success(),
            "duration_ms": started.elapsed().as_millis() as u64,
            "stdout": String::from_utf8_lossy(&out).chars().take(8192).collect::<String>(),
            "stderr": String::from_utf8_lossy(&err).chars().take(8192).collect::<String>(),
            "note": "这是执行观测：命令的退出码与输出。它只说明这条命令在这个隔离副本里的结果。",
        }),
        Ok((_, _, Err(error))) => {
            json!({"observed": true, "ran": true, "argv": argv, "error": format!("wait_failed:{error}")})
        }
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = pid {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
            json!({
                "observed": true,
                "ran": true,
                "argv": argv,
                "timed_out": true,
                "duration_ms": started.elapsed().as_millis() as u64,
                "note": "测试命令超时后被按进程组杀死；超时不是通过。",
            })
        }
    }
}

/// Record a proposal from a unified diff.
///
/// Shared by the CLI and the HTTP review surface so that "a proposal was
/// validated against the pinned bytes" means the same thing on both, and so a
/// page cannot register something the CLI would have refused.
/// Resolve the entity a proposal is about.
///
/// A proposal that *creates* a file names a path the analysis does not have --
/// there is no entity to resolve. That is allowed only when the diff really
/// creates exactly that path; anything else stays an unresolved reference,
/// because "I could not find this entity" and "this proposal adds it" are
/// different statements and only one of them is in the diff.
pub fn resolve_proposal_entity(
    store: &Store,
    analysis: &str,
    reference: &str,
    diff: &str,
) -> Result<(String, bool), String> {
    match crate::runner::resolve_entity(store, analysis, reference) {
        Ok(entity) => Ok((entity, false)),
        Err(error) => {
            let parsed = patch::parse_unified_diff(diff).map_err(|e| e.to_string())?;
            let wanted = reference.strip_prefix("file:").unwrap_or(reference);
            let creates = parsed
                .iter()
                .filter(|file| file.form == patch::PatchForm::Create)
                .count();
            let names_it = parsed
                .iter()
                .any(|file| file.form == patch::PatchForm::Create && file.path == wanted);
            if creates == parsed.len() && names_it {
                Ok((format!("file:{wanted}"), true))
            } else {
                Err(error)
            }
        }
    }
}

pub fn propose_from_diff(
    store: &Store,
    analysis: &str,
    entity: &str,
    diff: &str,
    proposed_by: &str,
    summary: Option<&str>,
) -> Result<(patch::PatchProposal, bool), String> {
    let metadata = store.metadata(analysis).map_err(|e| e.to_string())?;
    let snapshot_id = metadata["snapshot_id"]
        .as_str()
        .ok_or("analysis_has_no_snapshot")?;
    let snapshot = store.snapshot(snapshot_id).map_err(|e| e.to_string())?;
    let files = patch::snapshot_files(store, &snapshot).map_err(|e| e.to_string())?;
    let selection = atlas_engine::bridge::selection(analysis, entity, "entity");
    let outcome = patch::parse_unified_diff(diff)
        .and_then(|parsed| patch::apply(&files, &parsed).map(|applied| (parsed, applied)));
    let proposal = match outcome {
        Ok((parsed, applied)) => json!({
            "schema": patch::PATCH_SCHEMA,
            "analysis_id": analysis,
            "entity_id": entity,
            "selection_id": selection.id,
            "proposed_by": proposed_by,
            "summary": summary,
            "diff": diff,
            "intent": true,
            "code_exists": false,
            // A proposal that creates a file names a path the analysis does not
            // have. Saying so is the difference between "this file exists and
            // would change" and "this file does not exist yet".
            "target_exists": parsed.iter().all(|file| file.form != patch::PatchForm::Create),
            "validation": {
                "ok": true,
                "files": applied.report,
                "hunks": parsed.iter().map(|file| file.hunks.len()).sum::<usize>(),
                "patched_paths": applied.files.keys().collect::<Vec<_>>(),
                "deleted_paths": applied.deleted.iter().collect::<Vec<_>>(),
                // The form of every file in the diff, so a reviewer sees that a
                // proposal adds or removes a file rather than editing one.
                "forms": parsed.iter().map(|file| json!({
                    "path": file.path, "form": file.form.as_str(),
                })).collect::<Vec<_>>(),
            },
            "note": "这是 Intent：一份提案。它还没有写进任何检出目录，也没有改变已发布的分析。",
        }),
        Err(error) => json!({
            "schema": patch::PATCH_SCHEMA,
            "analysis_id": analysis,
            "entity_id": entity,
            "selection_id": selection.id,
            "proposed_by": proposed_by,
            "summary": summary,
            "diff": diff,
            "intent": true,
            "code_exists": false,
            "validation": {"ok": false, "reason": error.to_string()},
            "note": "这份提案没有通过固定快照的校验，因此它不会进入可验证状态。",
        }),
    };
    let valid = proposal["validation"]["ok"].as_bool() == Some(true);
    let (stored, created) = store
        .record_patch_proposal(
            analysis,
            entity,
            proposed_by,
            &proposal,
            if valid {
                patch::STATE_PROPOSED
            } else {
                patch::STATE_REJECTED
            },
            if valid {
                None
            } else {
                proposal["validation"]["reason"].as_str()
            },
        )
        .map_err(|e| e.to_string())?;
    Ok((stored, created))
}

/// Re-parse a stored diff. The stored text is authoritative: what was reviewed
/// is what gets applied.
pub fn reparsed(proposal: &patch::PatchProposal) -> Result<Vec<FilePatch>, String> {
    let diff = proposal
        .proposal
        .get("diff")
        .and_then(|value| value.as_str())
        .ok_or("proposal_has_no_diff")?;
    patch::parse_unified_diff(diff).map_err(|error| error.to_string())
}

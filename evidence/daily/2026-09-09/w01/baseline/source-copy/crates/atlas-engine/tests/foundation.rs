use atlas_contract::*;
use atlas_engine::{
    analyze::{analyze, recursive_components},
    scan::scan,
    store::Store,
};
use std::{collections::HashSet, fs};

fn chain(
    store: &Store,
    root: &std::path::Path,
    count: usize,
    recursive: bool,
) -> (Snapshot, LanguageFacts) {
    let mut source = String::new();
    let mut symbols = Vec::new();
    let mut calls = Vec::new();
    for n in 0..count {
        let start = source.len();
        let next = if n + 1 < count {
            format!("f{}", n + 1)
        } else if recursive {
            "f0".into()
        } else {
            "external".into()
        };
        let line = format!("function f{n}(){{return {next}();}}\n");
        let end = start + line.trim_end().len();
        let call_start = start + line.find("return ").unwrap() + 7;
        let id = format!("symbol:a.js:{start}:{end}");
        symbols.push(Symbol {
            id: id.clone(),
            path: "a.js".into(),
            name: format!("f{n}"),
            kind: "function".into(),
            start,
            end,
            container: "file:a.js".into(),
            mutated: false,
        });
        calls.push(CallSite {
            id: format!("call:a.js:{call_start}:{}", call_start + next.len() + 2),
            path: "a.js".into(),
            start: call_start,
            end: call_start + next.len() + 2,
            owner: id,
            label: next,
            form: "identifier".into(),
            target: None,
        });
        source.push_str(&line);
    }
    for n in 0..count {
        calls[n].target = if n + 1 < count {
            Some(symbols[n + 1].id.clone())
        } else if recursive {
            Some(symbols[0].id.clone())
        } else {
            None
        };
    }
    fs::write(root.join("a.js"), source).unwrap();
    let snapshot = scan(root, store, ScanLimits::default()).unwrap();
    let facts = LanguageFacts {
        schema: FACTS_SCHEMA.into(),
        snapshot_id: snapshot.id.clone(),
        producer: "typescript/5.9.3;worker/0.1.0".into(),
        parsed_files: vec!["a.js".into()],
        symbols,
        calls,
        imports: vec![],
        diagnostics: vec![],
        dynamic_files: vec![],
    };
    (snapshot, facts)
}

#[test]
fn immutable_snapshots_survive_source_and_catalog_changes() {
    let project = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let store = Store::open(db.path()).unwrap();
    fs::write(
        project.path().join("a.js"),
        "export function a(){return '旧';}",
    )
    .unwrap();
    let first = scan(project.path(), &store, ScanLimits::default()).unwrap();
    assert_eq!(
        first.id,
        scan(project.path(), &store, ScanLimits::default())
            .unwrap()
            .id
    );
    let hash = first
        .entries
        .iter()
        .find(|e| e.path == "a.js")
        .unwrap()
        .blob
        .clone()
        .unwrap();
    fs::write(project.path().join("a.js"), "new contents").unwrap();
    fs::create_dir(project.path().join("empty")).unwrap();
    let second = scan(project.path(), &store, ScanLimits::default()).unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(store.snapshot(&first.id).unwrap(), first);
    assert!(
        String::from_utf8(store.read_blob(&hash).unwrap())
            .unwrap()
            .contains('旧')
    );
}

#[test]
fn concurrent_blob_publication_is_immutable_and_corruption_fails_closed() {
    let db = tempfile::tempdir().unwrap();
    let store = Store::open(db.path()).unwrap();
    let threads: Vec<_> = (0..24)
        .map(|_| {
            let s = store.clone();
            std::thread::spawn(move || s.put_blob(b"same immutable bytes").unwrap())
        })
        .collect();
    let hashes: HashSet<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(hashes.len(), 1);
    let hash = hashes.iter().next().unwrap();
    fs::write(store.blob_path(hash).unwrap(), b"corruption").unwrap();
    assert!(store.read_blob(hash).is_err());
    assert!(store.put_blob(b"same immutable bytes").is_err());
}

#[test]
fn nested_ignore_rules_and_budgets_keep_explicit_boundaries() {
    let project = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let s = Store::open(db.path()).unwrap();
    fs::write(project.path().join(".gitignore"), "*.log\npruned/\n").unwrap();
    fs::create_dir(project.path().join("sub")).unwrap();
    fs::write(project.path().join("sub/.gitignore"), "!keep.log\n").unwrap();
    for p in ["sub/keep.log", "sub/drop.log"] {
        fs::write(project.path().join(p), "log").unwrap();
    }
    fs::create_dir(project.path().join("pruned")).unwrap();
    fs::write(project.path().join("pruned/secret.js"), "secret").unwrap();
    let a = scan(project.path(), &s, ScanLimits::default()).unwrap();
    let disposition = |p| {
        a.entries
            .iter()
            .find(|e| e.path == p)
            .map(|e| e.disposition.as_str())
    };
    assert_eq!(disposition("sub/keep.log"), Some("captured"));
    assert_eq!(disposition("sub/drop.log"), Some("ignored"));
    assert_eq!(disposition("pruned"), Some("ignored"));
    assert_eq!(disposition("pruned/secret.js"), None);
    let before: i64 = s
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM snapshots", [], |r| r.get(0))
        .unwrap();
    assert!(
        scan(
            project.path(),
            &s,
            ScanLimits {
                max_entries: 2,
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(
        scan(
            project.path(),
            &s,
            ScanLimits {
                max_total_bytes: 1,
                ..Default::default()
            }
        )
        .is_err()
    );
    let after: i64 = s
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM snapshots", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
}

#[cfg(unix)]
#[test]
fn symlinks_never_import_external_contents_and_targets_affect_identity() {
    use std::os::unix::fs::symlink;
    let p = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let s = Store::open(db.path()).unwrap();
    fs::write(outside.path().join("private"), "not to be read").unwrap();
    symlink(outside.path().join("private"), p.path().join("link.js")).unwrap();
    let a = scan(p.path(), &s, ScanLimits::default()).unwrap();
    let link = &a.entries[1];
    assert_eq!(link.kind, "symlink");
    assert!(link.blob.is_none());
    fs::remove_file(p.path().join("link.js")).unwrap();
    symlink(outside.path().join("missing"), p.path().join("link.js")).unwrap();
    let b = scan(p.path(), &s, ScanLimits::default()).unwrap();
    assert_ne!(a.id, b.id);
}

#[test]
fn reachability_is_transitive_bounded_and_revision_bound() {
    let p = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let s = Store::open(db.path()).unwrap();
    let (snapshot, facts) = chain(&s, p.path(), 7, false);
    let root = facts.symbols[0].id.clone();
    let a = analyze(&s, &snapshot, facts.clone()).unwrap();
    let reach = s.reachable(&a.id, &root, "out", 100, 100).unwrap();
    assert_eq!(reach.nodes.len(), 7);
    assert_eq!(reach.edges.len(), 6);
    assert_eq!(reach.unresolved.len(), 1);
    assert!(!reach.truncated);
    let small = s.reachable(&a.id, &root, "out", 2, 2).unwrap();
    assert!(small.truncated);
    assert!(!small.frontier.is_empty());
    let ids: HashSet<_> = small.nodes.iter().map(|n| &n.id).collect();
    assert!(
        small
            .edges
            .iter()
            .all(|e| ids.contains(&e.source) && ids.contains(e.target.as_ref().unwrap()))
    );
    let page = s.nodes(&a.id, "function", 2, None).unwrap();
    assert_eq!(page.total, 7);
    assert_eq!(page.items.len(), 2);
    let cursor = page.next_cursor.unwrap();
    assert_eq!(
        s.nodes(&a.id, "function", 2, Some(&cursor))
            .unwrap()
            .items
            .len(),
        2
    );
    assert!(s.nodes(&a.id, "all", 2, Some(&cursor)).is_err());
    assert!(s.nodes(&a.id, "function", 3, Some(&cursor)).is_err());
    let mut f = facts.clone();
    f.symbols[1].mutated = true;
    let b = analyze(&s, &snapshot, f).unwrap();
    assert_ne!(a.id, b.id);
    assert!(s.nodes(&b.id, "function", 2, Some(&cursor)).is_err());
    assert_eq!(
        s.reachable(&b.id, &root, "out", 100, 100)
            .unwrap()
            .nodes
            .len(),
        1
    );
    let old = s.source(&a.id, &root, 16000).unwrap();
    fs::write(p.path().join("a.js"), "changed").unwrap();
    assert_eq!(s.source(&a.id, &root, 16000).unwrap(), old);
    assert_eq!(
        s.context(&a.id, &root).unwrap(),
        s.context(&a.id, &root).unwrap()
    );
}

#[test]
fn reject_incomplete_worker_results_and_invalid_anchors_without_publication() {
    let p = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let s = Store::open(db.path()).unwrap();
    let (snapshot, facts) = chain(&s, p.path(), 3, false);
    let mut bad = facts.clone();
    bad.parsed_files.clear();
    assert!(analyze(&s, &snapshot, bad).is_err());
    let mut bad = facts.clone();
    bad.calls[0].target = Some("invented".into());
    assert!(analyze(&s, &snapshot, bad).is_err());
    let mut bad = facts.clone();
    bad.symbols[0].end = usize::MAX;
    assert!(analyze(&s, &snapshot, bad).is_err());
    let mut bad = facts.clone();
    bad.symbols.push(bad.symbols[0].clone());
    assert!(analyze(&s, &snapshot, bad).is_err());
    let count: i64 = s
        .connection()
        .unwrap()
        .query_row("SELECT count(*) FROM analyses", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn scc_handles_deep_graph_without_recursion_and_reports_cycles() {
    let edges: Vec<_> = (0..10000)
        .map(|n| Edge {
            id: n.to_string(),
            source: n.to_string(),
            target: Some(((n + 1) % 10000).to_string()),
            kind: "call_candidate".into(),
            path: "".into(),
            start: 0,
            end: 0,
            label: "".into(),
            basis: "test_graph".into(),
        })
        .collect();
    let groups = recursive_components(&edges);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].len(), 10000);
    let p = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let s = Store::open(db.path()).unwrap();
    let (snap, f) = chain(&s, p.path(), 4, true);
    let a = analyze(&s, &snap, f).unwrap();
    assert_eq!(a.recursive_components[0].len(), 4);
}

#[test]
fn byte_windows_never_split_utf8_and_unparseable_bytes_are_reported() {
    let p = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let s = Store::open(db.path()).unwrap();
    fs::write(p.path().join("note.txt"), "水🫧abc").unwrap();
    fs::write(p.path().join("binary.js"), [255, 254]).unwrap();
    let snap = scan(p.path(), &s, ScanLimits::default()).unwrap();
    let f = LanguageFacts {
        schema: FACTS_SCHEMA.into(),
        snapshot_id: snap.id.clone(),
        producer: "typescript/5.9.3;worker/0.1.0".into(),
        parsed_files: vec![],
        symbols: vec![],
        calls: vec![],
        imports: vec![],
        diagnostics: vec![],
        dynamic_files: vec![],
    };
    let a = analyze(&s, &snap, f).unwrap();
    assert!(a.diagnostics.iter().any(|d| d.code == "SOURCE_NOT_UTF8"));
    let source = s.source(&a.id, "file:note.txt", 4).unwrap();
    assert_eq!(source["content"], "水");
    assert_eq!(source["end"], 3);
    assert_eq!(source["truncated"], true);
    assert!(s.source(&a.id, "file:binary.js", 10).is_err());
}

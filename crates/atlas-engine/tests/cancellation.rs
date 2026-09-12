use atlas_contract::{FACTS_SCHEMA, LanguageFacts, ScanLimits};
use atlas_engine::{
    analyze::analyze_controlled, control::ExecutionControl, scan::scan_controlled, store::Store,
};
use std::{
    fs,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

fn publication_counts(store: &Store) -> (usize, usize, usize) {
    store
        .connection()
        .unwrap()
        .query_row(
            "SELECT (SELECT count(*) FROM snapshots),
                    (SELECT count(*) FROM analyses),
                    (SELECT count(*) FROM facts)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

#[test]
fn scan_stage_deadline_interrupts_publication_lock_wait() {
    let project = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    fs::write(project.path().join("a.js"), "export const a = 1;").unwrap();
    let store = Store::open(db.path()).unwrap();
    let writer = store.connection().unwrap();
    // Hold the real SQLite writer for the entire observation. Completion must
    // come from the scan deadline, not from releasing the contested resource.
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let scan_store = store.clone();
    let root = project.path().to_path_buf();
    let (sender, receiver) = mpsc::channel();
    let task = thread::spawn(move || {
        let control = ExecutionControl::new(Some(Instant::now() + Duration::from_secs(10)));
        let result = scan_controlled(
            &root,
            &scan_store,
            ScanLimits::default(),
            Some(Duration::from_millis(100)),
            &control,
        );
        sender.send(result).unwrap();
    });
    let observed = receiver.recv_timeout(Duration::from_secs(2));
    // Release and join even if the deadline check regresses, leaving no test
    // thread or database writer behind when the following assertion fails.
    writer.execute_batch("ROLLBACK").unwrap();
    task.join().unwrap();
    let error = observed
        .expect("scan must end while the publication lock is still held")
        .expect_err("scan deadline must prevent snapshot publication");
    assert!(
        error.to_string().contains("scan_deadline_exceeded"),
        "{error}"
    );
    assert_eq!(publication_counts(&store), (0, 0, 0));
}

#[test]
fn pre_cancelled_scan_publishes_nothing() {
    let project = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    fs::write(project.path().join("a.js"), "export const a = 1;").unwrap();
    let store = Store::open(db.path()).unwrap();
    let control = ExecutionControl::new(None);
    assert!(control.cancel());
    let error = scan_controlled(
        project.path(),
        &store,
        ScanLimits::default(),
        Some(Duration::from_secs(30)),
        &control,
    )
    .expect_err("a cancelled operation cannot start scanning");
    assert!(error.to_string().contains("index_cancelled"), "{error}");
    assert_eq!(publication_counts(&store), (0, 0, 0));
    assert_eq!(fs::read_dir(store.root.join("blobs")).unwrap().count(), 0);
}

#[test]
fn cancellation_is_shared_with_stages_but_isolated_between_jobs() {
    let project = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let store = Store::open(db.path()).unwrap();
    let cancelled_job = ExecutionControl::new(None);
    let active_job = ExecutionControl::new(None);
    let stage = cancelled_job.with_stage_deadline(
        Instant::now() + Duration::from_secs(30),
        "test_stage_deadline",
    );
    assert!(stage.cancel());
    assert!(cancelled_job.is_cancelled());
    assert!(!active_job.is_cancelled());
    let error = scan_controlled(
        project.path(),
        &store,
        ScanLimits::default(),
        None,
        &cancelled_job,
    )
    .unwrap_err();
    assert!(error.to_string().contains("index_cancelled"), "{error}");
    let snapshot = scan_controlled(
        project.path(),
        &store,
        ScanLimits::default(),
        None,
        &active_job,
    )
    .unwrap();
    active_job.checkpoint().unwrap();
    assert_eq!(store.snapshot(&snapshot.id).unwrap().id, snapshot.id);
    assert_eq!(publication_counts(&store), (1, 0, 0));
}

#[test]
fn late_cancellation_cannot_relabel_a_committed_analysis() {
    let project = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let store = Store::open(db.path()).unwrap();
    let control = ExecutionControl::new(None);
    let snapshot = scan_controlled(
        project.path(),
        &store,
        ScanLimits::default(),
        None,
        &control,
    )
    .unwrap();
    let analysis = analyze_controlled(
        &store,
        &snapshot,
        LanguageFacts {
            schema: FACTS_SCHEMA.into(),
            snapshot_id: snapshot.id.clone(),
            producer: atlas_contract::WORKER_PRODUCER.into(),
            parsed_files: vec![],
            symbols: vec![],
            calls: vec![],
            imports: vec![],
            diagnostics: vec![],
            dynamic_files: vec![],
            flow: None,
        },
        &control,
    )
    .unwrap();
    let metadata = store.metadata(&analysis.id).unwrap();
    assert!(
        !control.cancel(),
        "publication already reached its terminal state"
    );
    assert!(!control.is_cancelled());
    control.checkpoint().unwrap();
    assert_eq!(store.metadata(&analysis.id).unwrap(), metadata);
    assert_eq!(publication_counts(&store), (1, 1, 0));
}

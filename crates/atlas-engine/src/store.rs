use crate::{Error, Result, control::ExecutionControl, digest, invalid};
use atlas_contract::{Analysis, Snapshot, SourceFile};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
}

/// Retry an operation that can lose a race for the SQLite writer.
///
/// A busy timeout alone is not enough: SQLite reports SQLITE_BUSY immediately
/// for some lock states instead of consulting the busy handler, so the caller
/// has to retry. This lives here rather than in one caller because the job
/// store is exactly where two processes are expected to collide on purpose.
pub(crate) fn retry_on_busy<T>(mut operation: impl FnMut() -> Result<T>) -> Result<T> {
    let started = std::time::Instant::now();
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(Error::Sql(error))
                if matches!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
                ) && started.elapsed() < Duration::from_secs(5) =>
            {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(error),
        }
    }
}

/// Wait for the SQLite writer in short, cancellable intervals. Acquire the
/// write lock before reading existing metadata to avoid a deferred transaction
/// read-to-write upgrade racing another publisher.
pub(crate) fn publication_transaction<'a>(
    conn: &'a Connection,
    control: &ExecutionControl,
) -> Result<rusqlite::Transaction<'a>> {
    conn.busy_timeout(Duration::from_millis(25))?;
    retry_on_busy(|| {
        control.checkpoint()?;
        rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
            .map_err(Into::into)
    })
}

impl Store {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        let store = Self {
            root: root.as_ref().canonicalize()?,
        };
        fs::create_dir_all(store.root.join("blobs"))?;
        let conn = store.connection()?;
        // Idempotent schema creation still takes the writer for a moment, and
        // two processes starting together must not read that race as an error.
        retry_on_busy(|| {
            conn.execute_batch("PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS analyses(id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, metadata TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS nodes(analysis TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(analysis,id));
          CREATE TABLE IF NOT EXISTS edges(analysis TEXT NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,target TEXT,kind TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(analysis,id));
          CREATE INDEX IF NOT EXISTS node_kind ON nodes(analysis,kind,id);
          CREATE INDEX IF NOT EXISTS edge_source ON edges(analysis,source,id);
          CREATE INDEX IF NOT EXISTS edge_target ON edges(analysis,target,id);
          CREATE TABLE IF NOT EXISTS selections(id TEXT PRIMARY KEY,analysis TEXT NOT NULL,body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS facts(analysis TEXT NOT NULL,symbol TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(analysis,symbol,kind));
          CREATE INDEX IF NOT EXISTS facts_kind ON facts(analysis,kind,symbol);
          CREATE TABLE IF NOT EXISTS jobs(
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL DEFAULT 'index',
            owner TEXT NOT NULL,
            project TEXT NOT NULL,
            request_key TEXT NOT NULL,
            root TEXT NOT NULL,
            options TEXT,
            state TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 0,
            priority INTEGER NOT NULL DEFAULT 0,
            lease_holder TEXT,
            lease_expires_at INTEGER,
            heartbeat_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            terminal_reason TEXT,
            analysis_id TEXT,
            UNIQUE(owner,project,request_key));
          CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,lease_expires_at);
          CREATE TABLE IF NOT EXISTS incremental_runs(
            run_key TEXT PRIMARY KEY,
            bundle TEXT NOT NULL,
            snapshot_id TEXT NOT NULL,
            analysis_id TEXT NOT NULL,
            file_keys TEXT NOT NULL,
            file_hashes TEXT NOT NULL,
            source_files TEXT NOT NULL,
            created_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS incremental_runs_recent ON incremental_runs(created_at);
          CREATE TABLE IF NOT EXISTS exec_records(
            id TEXT PRIMARY KEY,
            analysis TEXT NOT NULL,
            symbol TEXT NOT NULL,
            spec_digest TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS exec_records_symbol ON exec_records(analysis,symbol,created_at);
          CREATE TABLE IF NOT EXISTS annotations(
            id TEXT PRIMARY KEY,
            analysis_id TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            selection_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            body TEXT NOT NULL,
            proposed_by TEXT NOT NULL,
            intent_exists INTEGER NOT NULL,
            created_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS annotations_entity ON annotations(analysis_id,entity_id,created_at);
          CREATE TABLE IF NOT EXISTS agent_requests(
            id TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            request_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 0,
            analysis_id TEXT NOT NULL,
            entity_id TEXT,
            payload TEXT,
            result TEXT,
            terminal_reason TEXT,
            lease_holder TEXT,
            lease_expires_at INTEGER,
            ack_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(owner,request_key));
          CREATE INDEX IF NOT EXISTS agent_requests_state ON agent_requests(state,created_at);
          CREATE TABLE IF NOT EXISTS patch_proposals(
            id TEXT PRIMARY KEY,
            analysis_id TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            proposed_by TEXT NOT NULL,
            state TEXT NOT NULL,
            proposal TEXT NOT NULL,
            verification TEXT,
            target TEXT,
            terminal_reason TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS patch_proposals_entity ON patch_proposals(analysis_id,entity_id,created_at);")?;
            Ok(())
        })?;
        // Additive migration. A store created before the queue existed has a
        // jobs table without `priority` or `options`. Only additive, always-safe
        // changes are handled here; there is still no general migration or
        // rollback strategy, and a change that is not purely additive would need
        // one before it could ship.
        for (column, definition) in [
            ("priority", "priority INTEGER NOT NULL DEFAULT 0"),
            ("options", "options TEXT"),
            // A store created before the queue had kinds holds index requests,
            // and that is exactly what the default says.
            ("kind", "kind TEXT NOT NULL DEFAULT 'index'"),
        ] {
            let present = {
                let mut statement =
                    conn.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name=?1")?;
                statement.exists([column])?
            };
            if !present {
                retry_on_busy(|| {
                    conn.execute(&format!("ALTER TABLE jobs ADD COLUMN {definition}"), [])?;
                    Ok(())
                })?;
            }
        }
        // Anything that depends on a migrated column must come after the
        // migration, not in the batch above: an index over `priority` created
        // before the column exists fails, and the store never opens.
        retry_on_busy(|| {
            conn.execute(
                "CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state,priority,created_at)",
                [],
            )?;
            Ok(())
        })?;
        Ok(store)
    }
    pub fn connection(&self) -> Result<Connection> {
        let conn = Connection::open(self.root.join("atlas.db"))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(conn)
    }
    pub fn blob_path(&self, hash: &str) -> Result<PathBuf> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(invalid("invalid_blob_id"));
        }
        Ok(self.root.join("blobs").join(hash))
    }
    pub fn put_blob(&self, bytes: &[u8]) -> Result<String> {
        let hash = digest(bytes);
        let target = self.blob_path(&hash)?;
        // Content addressing makes publication idempotent: the name is the
        // hash, so a blob that already exists already holds exactly these
        // bytes. Checking first is not a micro-optimisation -- writing a
        // temporary file and fsyncing it only to discover the blob was already
        // there cost one fsync per unchanged file, which is what made a re-scan
        // of an unmodified tree take seconds instead of milliseconds.
        if target.exists() {
            // The integrity check is kept: a blob whose contents no longer
            // match its name is corruption, and reading it must fail.
            if digest(&fs::read(&target)?) != hash {
                return Err(invalid("corrupt_existing_blob"));
            }
            return Ok(hash);
        }
        let mut temporary = tempfile::NamedTempFile::new_in(self.root.join("blobs"))?;
        temporary.write_all(bytes)?;
        temporary.as_file().sync_all()?;
        match temporary.persist_noclobber(&target) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if digest(&fs::read(&target)?) != hash {
                    return Err(invalid("corrupt_existing_blob"));
                }
            }
            Err(e) => return Err(e.error.into()),
        }
        Ok(hash)
    }
    pub fn read_blob(&self, hash: &str) -> Result<Vec<u8>> {
        let bytes = fs::read(self.blob_path(hash)?)?;
        if digest(&bytes) != hash {
            return Err(invalid("blob_integrity_failed"));
        }
        Ok(bytes)
    }
    pub fn publish_snapshot(&self, snapshot: &Snapshot) -> Result<()> {
        self.publish_snapshot_controlled(snapshot, &ExecutionControl::new(None))
    }
    pub fn publish_snapshot_controlled(
        &self,
        snapshot: &Snapshot,
        control: &ExecutionControl,
    ) -> Result<()> {
        control.checkpoint()?;
        let mut identity = snapshot.clone();
        identity.id.clear();
        if digest(&serde_json::to_vec(&identity)?) != snapshot.id {
            return Err(invalid("snapshot_identity_mismatch"));
        }
        for entry in &snapshot.entries {
            control.checkpoint()?;
            if let Some(hash) = &entry.blob {
                self.read_blob(hash)?;
            }
        }
        let body = serde_json::to_string(snapshot)?;
        let conn = self.connection()?;
        let tx = publication_transaction(&conn, control)?;
        control.checkpoint()?;
        tx.execute(
            "INSERT OR IGNORE INTO snapshots VALUES(?1,?2)",
            params![snapshot.id, body],
        )?;
        let existing: String = tx.query_row(
            "SELECT body FROM snapshots WHERE id=?1",
            [&snapshot.id],
            |r| r.get(0),
        )?;
        if existing != body {
            return Err(invalid("immutable_snapshot_conflict"));
        }
        control.publish(|| Ok(tx.commit()?))
    }
    pub fn snapshot(&self, id: &str) -> Result<Snapshot> {
        let body: Option<String> = self
            .connection()?
            .query_row("SELECT body FROM snapshots WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        serde_json::from_str(&body.ok_or_else(|| invalid("snapshot_not_found"))?)
            .map_err(Into::into)
    }
    pub fn sources(&self, snapshot: &Snapshot) -> Result<Vec<SourceFile>> {
        self.sources_controlled(snapshot, &ExecutionControl::new(None))
    }
    pub fn sources_controlled(
        &self,
        snapshot: &Snapshot,
        control: &ExecutionControl,
    ) -> Result<Vec<SourceFile>> {
        let mut files = Vec::new();
        for entry in &snapshot.entries {
            control.checkpoint()?;
            if let Some(hash) = &entry.blob {
                // JSON is read only by TypeScript's virtual module resolver, never executed.
                if (crate::scan::is_source(&entry.path)
                    || entry.path.ends_with("/package.json")
                    || entry.path == "package.json")
                    && let Ok(content) = String::from_utf8(self.read_blob(hash)?)
                {
                    files.push(SourceFile {
                        path: entry.path.clone(),
                        content,
                    });
                }
            }
        }
        Ok(files)
    }
    pub fn publish_analysis(&self, analysis: &Analysis) -> Result<()> {
        self.publish_analysis_with_flow(analysis, &[])
    }

    /// Publish the analysis and its derived flow facts in one transaction.
    /// Existing analysis versions are never updated in place.
    pub fn publish_analysis_with_flow(
        &self,
        analysis: &Analysis,
        flow: &[crate::facts::FunctionFlowFact],
    ) -> Result<()> {
        self.publish_analysis_with_flow_controlled(analysis, flow, &ExecutionControl::new(None))
    }

    pub fn publish_analysis_with_flow_controlled(
        &self,
        analysis: &Analysis,
        flow: &[crate::facts::FunctionFlowFact],
        control: &ExecutionControl,
    ) -> Result<()> {
        control.checkpoint()?;
        self.snapshot(&analysis.snapshot_id)?;
        let mut identity = analysis.clone();
        identity.id.clear();
        if digest(&serde_json::to_vec(&identity)?) != analysis.id {
            return Err(invalid("analysis_identity_mismatch"));
        }
        let mut metadata = serde_json::to_value(analysis)?;
        metadata.as_object_mut().unwrap().remove("nodes");
        metadata.as_object_mut().unwrap().remove("edges");
        metadata["node_count"] = analysis.nodes.len().into();
        metadata["edge_count"] = analysis.edges.len().into();
        metadata["function_count"] = analysis
            .nodes
            .iter()
            .filter(|n| n.kind == "function")
            .count()
            .into();
        metadata["file_count"] = analysis
            .nodes
            .iter()
            .filter(|n| n.kind == "file")
            .count()
            .into();
        metadata["call_count"] = analysis
            .edges
            .iter()
            .filter(|e| e.kind == "call_candidate")
            .count()
            .into();
        metadata["unresolved_call_count"] = analysis
            .edges
            .iter()
            .filter(|e| e.kind == "call_candidate" && e.target.is_none())
            .count()
            .into();
        let encoded = serde_json::to_string(&metadata)?;
        let conn = self.connection()?;
        let tx = publication_transaction(&conn, control)?;
        control.checkpoint()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT metadata FROM analyses WHERE id=?1",
                [&analysis.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = old {
            if old != encoded {
                return Err(invalid("immutable_analysis_conflict"));
            }
            return control.finish_publication(|| Ok(()));
        }
        tx.execute(
            "INSERT INTO analyses VALUES(?1,?2,?3)",
            params![analysis.id, analysis.snapshot_id, encoded],
        )?;
        for node in &analysis.nodes {
            control.checkpoint()?;
            tx.execute(
                "INSERT INTO nodes VALUES(?1,?2,?3,?4,?5)",
                params![
                    analysis.id,
                    node.id,
                    node.kind,
                    node.path,
                    serde_json::to_string(node)?
                ],
            )?;
        }
        for edge in &analysis.edges {
            control.checkpoint()?;
            tx.execute(
                "INSERT INTO edges VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    analysis.id,
                    edge.id,
                    edge.source,
                    edge.target,
                    edge.kind,
                    serde_json::to_string(edge)?
                ],
            )?;
        }
        for record in flow {
            control.checkpoint()?;
            tx.execute(
                "INSERT INTO facts VALUES(?1,?2,?3,?4)",
                params![
                    analysis.id,
                    record.symbol,
                    crate::facts::FACTS_KIND_FLOW,
                    serde_json::to_string(record)?
                ],
            )?;
        }
        control.finish_publication(|| Ok(tx.commit()?))
    }
    pub fn flow_fact(&self, analysis: &str, symbol: &str) -> Result<serde_json::Value> {
        let body: Option<String> = self
            .connection()?
            .query_row(
                "SELECT body FROM facts WHERE analysis=?1 AND symbol=?2 AND kind=?3",
                params![analysis, symbol, crate::facts::FACTS_KIND_FLOW],
                |r| r.get(0),
            )
            .optional()?;
        serde_json::from_str(&body.ok_or_else(|| invalid("flow_fact_not_found"))?)
            .map_err(Into::into)
    }
    /// Symbols with published flow facts (bounded by the page limit).
    pub fn flow_symbols(
        &self,
        analysis: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<crate::query::SymbolPage> {
        crate::query::flow_symbols(self, analysis, limit, cursor)
    }
    pub fn metadata(&self, analysis: &str) -> Result<serde_json::Value> {
        let value: Option<String> = self
            .connection()?
            .query_row(
                "SELECT metadata FROM analyses WHERE id=?1",
                [analysis],
                |r| r.get(0),
            )
            .optional()?;
        let mut parsed: serde_json::Value =
            serde_json::from_str(&value.ok_or_else(|| invalid("analysis_not_found"))?)?;
        // Injected at response time, never persisted. `analysis.id` is a digest
        // over the stored structure, so a per-build value inside it would give
        // the same snapshot + source a different identity on every rebuild and
        // break reproducible publication. A top-level key keeps existing
        // consumers (`coverage`, `id`, ...) reading exactly what they read
        // before.
        if let Some(object) = parsed.as_object_mut() {
            object.insert(
                "binary_fingerprint".into(),
                serde_json::json!(env!("ATLAS_BUILD_FINGERPRINT")),
            );
        }
        Ok(parsed)
    }
    pub fn source(
        &self,
        analysis: &str,
        entity: &str,
        max_bytes: usize,
    ) -> Result<serde_json::Value> {
        if max_bytes == 0 || max_bytes > 65536 {
            return Err(invalid("invalid_source_budget"));
        }
        let node = self.node(analysis, entity)?;
        let meta = self.metadata(analysis)?;
        let snapshot = self.snapshot(meta["snapshot_id"].as_str().unwrap())?;
        let entry = snapshot
            .entries
            .iter()
            .find(|e| e.path == node.path)
            .ok_or_else(|| invalid("source_not_found"))?;
        let hash = entry
            .blob
            .as_ref()
            .ok_or_else(|| invalid("source_not_captured"))?;
        // Capture limits bound each blob; validate bytes before serving historical source.
        let bytes = self.read_blob(hash)?;
        let start = node.start;
        let expected_end = if node.kind == "function" {
            node.end
        } else {
            bytes.len()
        };
        if expected_end > bytes.len() || start > expected_end {
            return Err(invalid("invalid_source_span"));
        }
        let source = std::str::from_utf8(&bytes).map_err(|_| invalid("source_not_utf8"))?;
        let mut end = expected_end.min(start.saturating_add(max_bytes));
        while end > start && !source.is_char_boundary(end) {
            end -= 1;
        }
        let content = source
            .get(start..end)
            .ok_or_else(|| invalid("invalid_utf8_span"))?;
        Ok(
            serde_json::json!({"analysis_id":analysis,"snapshot_id":snapshot.id,"entity_id":entity,"path":node.path,"blob":hash,"start":start,"end":end,"content":content,"truncated":end<expected_end}),
        )
    }

    /// Publish one controlled-execution record.
    ///
    /// `identity` is the canonical *answer*: the pinned question plus the
    /// observed outcome, with timing and absolute temporary paths left out. The
    /// full record is stored, but the id comes from `identity`, so re-running
    /// the same question against the same analysis and getting the same answer
    /// addresses the same row. A run that answered differently is a different
    /// record rather than a silent overwrite -- and timing noise can never
    /// masquerade as a new result.
    pub fn publish_exec_record(
        &self,
        record: &mut serde_json::Value,
        identity: &str,
    ) -> Result<String> {
        let analysis = record
            .get("analysis_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid("exec_record_missing_analysis"))?
            .to_string();
        let symbol = record
            .get("symbol")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid("exec_record_missing_symbol"))?
            .to_string();
        let spec_digest = record
            .get("spec_digest")
            .and_then(|v| v.as_str())
            .ok_or_else(|| invalid("exec_record_missing_spec_digest"))?
            .to_string();
        let id = digest(identity.as_bytes());
        if let Some(object) = record.as_object_mut() {
            object.insert("id".into(), serde_json::json!(id));
        }
        let body = serde_json::to_string(record)?;
        let created_at = crate::job::now_ms();
        let conn = self.connection()?;
        retry_on_busy(|| {
            let tx = rusqlite::Transaction::new_unchecked(
                &conn,
                rusqlite::TransactionBehavior::Immediate,
            )?;
            let existing: Option<String> = tx
                .query_row("SELECT body FROM exec_records WHERE id=?1", [&id], |r| {
                    r.get(0)
                })
                .optional()?;
            match existing {
                // The id already encodes the pinned question and the observed
                // answer, so a second run that answered the same question the
                // same way is the same record. Timing and absolute temporary
                // paths legitimately differ between two observations of one
                // answer; treating that as a conflict would make a deterministic
                // result look unstable. The first stored body stays
                // authoritative and is never rewritten.
                Some(_) => tx.commit()?,
                None => {
                    tx.execute(
                        "INSERT INTO exec_records VALUES(?1,?2,?3,?4,?5,?6)",
                        params![id, analysis, symbol, spec_digest, body, created_at],
                    )?;
                    tx.commit()?;
                }
            }
            Ok(())
        })?;
        Ok(id)
    }

    pub fn exec_record(&self, id: &str) -> Result<serde_json::Value> {
        let body: Option<String> = self
            .connection()?
            .query_row("SELECT body FROM exec_records WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        serde_json::from_str(&body.ok_or_else(|| invalid("exec_record_not_found"))?)
            .map_err(Into::into)
    }

    /// Published execution records projected for a projection view: which
    /// entries were actually run, with the verdict each run reached.
    ///
    /// This is deliberately a projection and not a second query language: a
    /// marker says "this symbol was run and ended like this", never "this call
    /// path was taken". The static call candidates stay exactly what they were.
    pub fn run_markers(&self, analysis: &str, limit: usize) -> Result<Vec<serde_json::Value>> {
        let limit = limit.clamp(1, 500);
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT body FROM exec_records WHERE analysis=?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![analysis, limit as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut markers = Vec::new();
        for row in rows {
            let body: serde_json::Value = serde_json::from_str(&row?)?;
            markers.push(serde_json::json!({
                "record_id": body["id"],
                "symbol": body["symbol"],
                "path": body["path"],
                "name": body["name"],
                "verdict": body["verdict"],
                "duration_ms": body["duration_ms"],
                "mocked": body["isolation"]["mocks"],
                "denied_effects": body["effect_journal"]["denied_count"],
            }));
        }
        Ok(markers)
    }

    /// Execution records for one symbol, newest first, bounded by `limit`.
    pub fn exec_records(
        &self,
        analysis: &str,
        symbol: &str,
        limit: usize,
    ) -> Result<Vec<serde_json::Value>> {
        if limit == 0 || limit > 200 {
            return Err(invalid("invalid_exec_record_limit"));
        }
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT body FROM exec_records WHERE analysis=?1 AND symbol=?2 ORDER BY created_at DESC, id DESC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![analysis, symbol, limit as i64], |row| {
            row.get::<_, String>(0)
        })?;
        let mut records = Vec::new();
        for row in rows {
            records.push(serde_json::from_str(&row?)?);
        }
        Ok(records)
    }
}

use crate::{Result, digest, invalid};
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

impl Store {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        let store = Self {
            root: root.as_ref().canonicalize()?,
        };
        fs::create_dir_all(store.root.join("blobs"))?;
        let conn = store.connection()?;
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
          CREATE INDEX IF NOT EXISTS facts_kind ON facts(analysis,kind,symbol);")?;
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
        let mut identity = snapshot.clone();
        identity.id.clear();
        if digest(&serde_json::to_vec(&identity)?) != snapshot.id {
            return Err(invalid("snapshot_identity_mismatch"));
        }
        for entry in &snapshot.entries {
            if let Some(hash) = &entry.blob {
                self.read_blob(hash)?;
            }
        }
        let body = serde_json::to_string(snapshot)?;
        let conn = self.connection()?;
        conn.execute(
            "INSERT OR IGNORE INTO snapshots VALUES(?1,?2)",
            params![snapshot.id, body],
        )?;
        let existing: String = conn.query_row(
            "SELECT body FROM snapshots WHERE id=?1",
            [&snapshot.id],
            |r| r.get(0),
        )?;
        if existing != body {
            return Err(invalid("immutable_snapshot_conflict"));
        }
        Ok(())
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
        let mut files = Vec::new();
        for entry in &snapshot.entries {
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
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
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
            return Ok(());
        }
        tx.execute(
            "INSERT INTO analyses VALUES(?1,?2,?3)",
            params![analysis.id, analysis.snapshot_id, encoded],
        )?;
        for node in &analysis.nodes {
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
        tx.commit()?;
        Ok(())
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
        Ok(serde_json::from_str(
            &value.ok_or_else(|| invalid("analysis_not_found"))?,
        )?)
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
}

//! W09 first slice: one selection object shared by every projection, immutable
//! annotations, and a bounded Agent Bridge with a durable request queue.
//!
//! Three separations are load-bearing here:
//!
//! * A selection carries the analysis it was pinned against. A selection from a
//!   different version is *refused* rather than quietly re-pointed at whatever
//!   analysis is currently served: silently re-anchoring a name is how an old
//!   conclusion ends up attached to a new function.
//! * An annotation is an Intent, not a fact. It is stored with `exists: false`
//!   and `proposed_by`, so a consumer can never mistake a proposal for code
//!   that is present in the snapshot.
//! * The bridge accepts a closed set of action kinds. Everything a model wants
//!   to do has to be one of them, and each one is bounded by what the engine
//!   already publishes.
use crate::{Result, digest, invalid, store::Store};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub const SELECTION_SCHEMA: &str = "atlas.selection.v1";
pub const ANNOTATION_SCHEMA: &str = "atlas.annotation.v1";
pub const AGENT_REQUEST_SCHEMA: &str = "atlas.agent-request.v1";

pub const STATE_QUEUED: &str = "queued";
pub const STATE_LEASED: &str = "leased";
pub const STATE_DONE: &str = "done";
pub const STATE_FAILED: &str = "failed";
pub const STATE_REJECTED: &str = "rejected";

pub const REASON_STALE_SELECTION: &str = "stale_selection_version";
pub const REASON_UNBOUNDED_ACTION: &str = "action_not_in_bounded_set";
pub const REASON_LEASE_EXPIRED: &str = "lease_expired";

/// The complete set of actions the bridge will accept. A request for anything
/// else is rejected at enqueue time, with the reason recorded, rather than
/// stored and hoped about.
pub const BOUNDED_ACTIONS: [&str; 3] = ["inspect", "annotate", "propose_patch"];

pub fn is_bounded(kind: &str) -> bool {
    BOUNDED_ACTIONS.contains(&kind)
}

/// A proposal is never code. This constant exists so the "not real yet" flag
/// has one definition instead of being re-typed at each site.
pub const PROPOSAL_EXISTS: bool = false;

/// A pinned selection: an entity, the analysis version it was chosen in, and an
/// id derived from both.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Selection {
    pub schema: String,
    pub id: String,
    pub analysis_id: String,
    pub entity_id: String,
    pub entity_kind: String,
    /// The analysis the selection was pinned against. Immutable, so comparing
    /// it is a real version check rather than a timestamp guess.
    pub version: String,
}

pub fn selection(analysis_id: &str, entity_id: &str, entity_kind: &str) -> Selection {
    Selection {
        schema: SELECTION_SCHEMA.into(),
        id: digest(format!("{SELECTION_SCHEMA}|{analysis_id}|{entity_id}").as_bytes()),
        analysis_id: analysis_id.into(),
        entity_id: entity_id.into(),
        entity_kind: entity_kind.into(),
        version: analysis_id.into(),
    }
}

/// Why a selection could not be used as given.
#[derive(Clone, Debug, Serialize)]
pub struct StaleSelection {
    pub code: String,
    pub selection_analysis: String,
    pub served_analysis: String,
    pub detail: String,
}

/// Check a selection against the analysis a projection is actually serving.
pub fn check_selection(selection: &Selection, served_analysis: &str) -> Option<StaleSelection> {
    if selection.version == served_analysis && selection.analysis_id == served_analysis {
        return None;
    }
    Some(StaleSelection {
        code: REASON_STALE_SELECTION.into(),
        selection_analysis: selection.analysis_id.clone(),
        served_analysis: served_analysis.to_string(),
        detail: "选区固定在另一个分析版本上。这里不会把它静默地改指到当前分析——那会把旧结论挂到新函数上。请重新选择，或打开该版本。".into(),
    })
}

/// An Intent attached to a selection by a person or an agent.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Annotation {
    pub schema: String,
    pub id: String,
    pub analysis_id: String,
    pub entity_id: String,
    pub selection_id: String,
    /// intent | constraint | scenario | patch
    pub kind: String,
    pub body: String,
    /// human | agent | <caller name>
    pub proposed_by: String,
    /// Always false in this slice: an annotation is a proposal, never code that
    /// exists in the snapshot. A consumer that wanted to render it as present
    /// would have to ignore this field, which is the point of having it.
    pub exists: bool,
    pub created_at: i64,
}

/// A durable bridge request. Identity is `(owner, request_key)`, exactly like a
/// job: the same request asked twice is the same row.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentRequest {
    pub schema: String,
    pub id: String,
    pub owner: String,
    pub request_key: String,
    pub kind: String,
    pub state: String,
    pub attempt: i64,
    pub analysis_id: String,
    pub entity_id: Option<String>,
    pub payload: Option<String>,
    pub result: Option<String>,
    pub terminal_reason: Option<String>,
    pub lease_holder: Option<String>,
    pub lease_expires_at: Option<i64>,
    pub ack_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct AgentRequestSpec<'a> {
    pub owner: &'a str,
    pub request_key: &'a str,
    pub kind: &'a str,
    pub analysis_id: &'a str,
    pub entity_id: Option<&'a str>,
    pub payload: Option<&'a str>,
}

pub fn agent_request_id(owner: &str, request_key: &str) -> String {
    digest(format!("{AGENT_REQUEST_SCHEMA}|{owner}|{request_key}").as_bytes())
}

fn row_to_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRequest> {
    Ok(AgentRequest {
        schema: AGENT_REQUEST_SCHEMA.into(),
        id: row.get("id")?,
        owner: row.get("owner")?,
        request_key: row.get("request_key")?,
        kind: row.get("kind")?,
        state: row.get("state")?,
        attempt: row.get("attempt")?,
        analysis_id: row.get("analysis_id")?,
        entity_id: row.get("entity_id")?,
        payload: row.get("payload")?,
        result: row.get("result")?,
        terminal_reason: row.get("terminal_reason")?,
        lease_holder: row.get("lease_holder")?,
        lease_expires_at: row.get("lease_expires_at")?,
        ack_at: row.get("ack_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_annotation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        schema: ANNOTATION_SCHEMA.into(),
        id: row.get("id")?,
        analysis_id: row.get("analysis_id")?,
        entity_id: row.get("entity_id")?,
        selection_id: row.get("selection_id")?,
        kind: row.get("kind")?,
        body: row.get("body")?,
        proposed_by: row.get("proposed_by")?,
        exists: row.get::<_, i64>("intent_exists")? != 0,
        created_at: row.get("created_at")?,
    })
}

impl Store {
    /// Create an annotation. The id is a digest of its content, so the same
    /// Intent proposed twice is one row, and a different body is a different
    /// row rather than an edit of someone else's.
    pub fn create_annotation(
        &self,
        selection: &Selection,
        kind: &str,
        body: &str,
        proposed_by: &str,
    ) -> Result<(Annotation, bool)> {
        if !["intent", "constraint", "scenario", "patch"].contains(&kind) {
            return Err(invalid("annotation_kind_not_supported"));
        }
        if body.trim().is_empty() || body.len() > 8192 {
            return Err(invalid("annotation_body_out_of_range"));
        }
        if proposed_by.trim().is_empty() || proposed_by.len() > 128 {
            return Err(invalid("annotation_author_out_of_range"));
        }
        let id = digest(
            format!(
                "{ANNOTATION_SCHEMA}|{}|{}|{}|{}|{}",
                selection.analysis_id, selection.entity_id, kind, proposed_by, body
            )
            .as_bytes(),
        );
        let created_at = crate::job::now_ms();
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let created = tx.execute(
            "INSERT OR IGNORE INTO annotations VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                id,
                selection.analysis_id,
                selection.entity_id,
                selection.id,
                kind,
                body,
                proposed_by,
                0i64,
                created_at
            ],
        )? == 1;
        let annotation = tx.query_row(
            "SELECT * FROM annotations WHERE id=?1",
            [&id],
            row_to_annotation,
        )?;
        tx.commit()?;
        Ok((annotation, created))
    }

    pub fn annotation(&self, id: &str) -> Result<Annotation> {
        self.connection()?
            .query_row(
                "SELECT * FROM annotations WHERE id=?1",
                [id],
                row_to_annotation,
            )
            .optional()?
            .ok_or_else(|| invalid("annotation_not_found"))
    }

    pub fn annotations(
        &self,
        analysis: &str,
        entity: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Annotation>> {
        let limit = limit.clamp(1, 200);
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT * FROM annotations WHERE analysis_id=?1 AND (?2 IS NULL OR entity_id=?2)
             ORDER BY created_at ASC, id ASC LIMIT ?3",
        )?;
        let rows =
            statement.query_map(params![analysis, entity, limit as i64], row_to_annotation)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Enqueue a bridge request.
    ///
    /// Two checks happen here rather than later, because a request that cannot
    /// be honoured should never look like work in progress: the action must be
    /// in the bounded set, and it must name an analysis that exists. A request
    /// against an analysis that is not in this store is stored as `rejected`
    /// with the reason, so the refusal is durably visible.
    pub fn enqueue_agent_request(
        &self,
        spec: &AgentRequestSpec<'_>,
    ) -> Result<(AgentRequest, bool)> {
        let id = agent_request_id(spec.owner, spec.request_key);
        let now = crate::job::now_ms();
        let bounded = is_bounded(spec.kind);
        let analysis_known = self.metadata(spec.analysis_id).is_ok();
        let (state, reason) = if !bounded {
            (STATE_REJECTED, Some(REASON_UNBOUNDED_ACTION))
        } else if !analysis_known {
            (STATE_REJECTED, Some("unknown_analysis"))
        } else {
            (STATE_QUEUED, None)
        };
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT state FROM agent_requests WHERE id=?1",
                [&id],
                |row| row.get(0),
            )
            .optional()?;
        if existing.is_some() {
            let row = tx.query_row(
                "SELECT * FROM agent_requests WHERE id=?1",
                [&id],
                row_to_request,
            )?;
            tx.commit()?;
            return Ok((row, false));
        }
        tx.execute(
            "INSERT INTO agent_requests
             (id,owner,request_key,kind,state,attempt,analysis_id,entity_id,payload,result,
              terminal_reason,lease_holder,lease_expires_at,ack_at,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,0,?6,?7,?8,NULL,?9,NULL,NULL,NULL,?10,?10)",
            params![
                id,
                spec.owner,
                spec.request_key,
                spec.kind,
                state,
                spec.analysis_id,
                spec.entity_id,
                spec.payload,
                reason,
                now
            ],
        )?;
        let row = tx.query_row(
            "SELECT * FROM agent_requests WHERE id=?1",
            [&id],
            row_to_request,
        )?;
        tx.commit()?;
        Ok((row, true))
    }

    pub fn agent_request(&self, id: &str) -> Result<AgentRequest> {
        self.connection()?
            .query_row(
                "SELECT * FROM agent_requests WHERE id=?1",
                [id],
                row_to_request,
            )
            .optional()?
            .ok_or_else(|| invalid("agent_request_not_found"))
    }

    pub fn agent_requests(&self, state: Option<&str>, limit: usize) -> Result<Vec<AgentRequest>> {
        let limit = limit.clamp(1, 200);
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT * FROM agent_requests WHERE (?1 IS NULL OR state=?1)
             ORDER BY created_at ASC, id ASC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![state, limit as i64], row_to_request)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Claim the oldest queued request. Claiming *is* the acknowledgement: the
    /// holder is recorded with a lease, so a claim is observable and expirable
    /// rather than an implicit promise.
    pub fn claim_agent_request(&self, holder: &str, lease_ms: i64) -> Result<Option<AgentRequest>> {
        let lease_ms = lease_ms.max(1000);
        let now = crate::job::now_ms();
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let candidate: Option<String> = tx
            .query_row(
                "SELECT id FROM agent_requests
                 WHERE state='queued'
                    OR (state='leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?1)
                 ORDER BY created_at ASC, id ASC LIMIT 1",
                params![now],
                |row| row.get(0),
            )
            .optional()?;
        let Some(id) = candidate else {
            tx.commit()?;
            return Ok(None);
        };
        let claimed = tx.execute(
            "UPDATE agent_requests SET state='leased', attempt=attempt+1, lease_holder=?2,
                    lease_expires_at=?3, ack_at=?4, updated_at=?4
             WHERE id=?1 AND (state='queued'
                    OR (state='leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?5))",
            params![id, holder, now + lease_ms, now, now],
        )?;
        if claimed != 1 {
            tx.commit()?;
            return Ok(None);
        }
        let row = tx.query_row(
            "SELECT * FROM agent_requests WHERE id=?1",
            [&id],
            row_to_request,
        )?;
        tx.commit()?;
        Ok(Some(row))
    }

    /// Finish a request, but only while the lease is still ours.
    pub fn finish_agent_request(
        &self,
        id: &str,
        holder: &str,
        state: &str,
        result: Option<&str>,
        reason: Option<&str>,
    ) -> Result<bool> {
        if ![STATE_DONE, STATE_FAILED].contains(&state) {
            return Err(invalid("agent_terminal_state_invalid"));
        }
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let updated = tx.execute(
            "UPDATE agent_requests SET state=?3, result=?4, terminal_reason=?5, updated_at=?6,
                    lease_expires_at=NULL
             WHERE id=?1 AND state='leased' AND lease_holder=?2",
            params![id, holder, state, result, reason, crate::job::now_ms()],
        )?;
        tx.commit()?;
        Ok(updated == 1)
    }

    pub fn heartbeat_agent_request(&self, id: &str, holder: &str, lease_ms: i64) -> Result<bool> {
        let now = crate::job::now_ms();
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let updated = tx.execute(
            "UPDATE agent_requests SET lease_expires_at=?3, updated_at=?4
             WHERE id=?1 AND state='leased' AND lease_holder=?2",
            params![id, holder, now + lease_ms.max(1000), now],
        )?;
        tx.commit()?;
        Ok(updated == 1)
    }

    /// Reap leases that stopped being renewed. The request goes back to
    /// `queued`, because a bridge action is cheap and idempotent by design:
    /// giving up on it entirely would lose a request somebody is waiting for.
    pub fn reap_agent_requests(&self, now: i64) -> Result<Vec<String>> {
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let mut statement = tx.prepare(
            "SELECT id FROM agent_requests WHERE state='leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?1",
        )?;
        let ids: Vec<String> = statement
            .query_map([now], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);
        for id in &ids {
            tx.execute(
                "UPDATE agent_requests SET state='queued', lease_holder=NULL, lease_expires_at=NULL,
                        terminal_reason=?2, updated_at=?3 WHERE id=?1",
                params![id, REASON_LEASE_EXPIRED, now],
            )?;
        }
        tx.commit()?;
        Ok(ids)
    }
}

/// The result shape every bounded action returns. `exists` is always false for
/// a proposal; `observed` is false for anything derived rather than executed.
pub fn action_result(kind: &str, detail: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "schema": "atlas.agent-action-result.v1",
        "action": kind,
        "observed": false,
        "code_exists": PROPOSAL_EXISTS,
        "detail": detail,
        "note": "桥接动作只做有界的事：读取已发布事实，或登记一份 Intent。它不执行用户代码，也不写源码。",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_contract::{Analysis, SNAPSHOT_SCHEMA, ScanLimits, Snapshot};

    fn store_with_analysis() -> (Store, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        // The store owns the directory for the test's lifetime.
        std::mem::forget(dir);
        // Identities are digests over the structure with `id` cleared, so the
        // test has to build them the same way the engine does.
        let mut snapshot = Snapshot {
            schema: SNAPSHOT_SCHEMA.into(),
            id: String::new(),
            scan_profile: "test".into(),
            limits: ScanLimits::default(),
            entries: vec![],
        };
        snapshot.id = digest(&serde_json::to_vec(&snapshot).unwrap());
        store.publish_snapshot(&snapshot).unwrap();
        let mut analysis = Analysis {
            schema: atlas_contract::ANALYSIS_SCHEMA.into(),
            id: String::new(),
            snapshot_id: snapshot.id.clone(),
            engine: "test".into(),
            producer: "test".into(),
            coverage: Default::default(),
            nodes: vec![],
            edges: vec![],
            diagnostics: vec![],
            recursive_components: vec![],
            limitations: vec![],
            flow_digest: digest(b"flow"),
        };
        analysis.id = digest(&serde_json::to_vec(&analysis).unwrap());
        store.publish_analysis(&analysis).unwrap();
        (store, analysis.id)
    }

    #[test]
    fn a_selection_is_pinned_to_its_analysis_version() {
        let pinned = selection("analysis-a", "symbol:x", "function");
        assert!(check_selection(&pinned, "analysis-a").is_none());
        let stale = check_selection(&pinned, "analysis-b").unwrap();
        assert_eq!(stale.code, REASON_STALE_SELECTION);
        assert_eq!(stale.selection_analysis, "analysis-a");
        // The id is stable and content-derived, so two views computing it
        // independently agree without exchanging anything.
        assert_eq!(
            selection("analysis-a", "symbol:x", "function").id,
            pinned.id
        );
        assert_ne!(
            selection("analysis-b", "symbol:x", "function").id,
            pinned.id
        );
    }

    #[test]
    fn an_annotation_is_idempotent_and_never_claims_to_exist() {
        let (store, analysis) = store_with_analysis();
        let selection = selection(&analysis, "symbol:x", "function");
        let (first, created) = store
            .create_annotation(&selection, "constraint", "must not raise", "human")
            .unwrap();
        assert!(created);
        assert!(!first.exists, "an Intent is not code that exists");
        assert_eq!(first.proposed_by, "human");
        let (again, created) = store
            .create_annotation(&selection, "constraint", "must not raise", "human")
            .unwrap();
        assert!(!created, "the same Intent is the same annotation");
        assert_eq!(again.id, first.id);
        let (other, created) = store
            .create_annotation(&selection, "constraint", "must not raise", "agent")
            .unwrap();
        assert!(created);
        assert_ne!(
            other.id, first.id,
            "a different author is a different proposal"
        );
        assert_eq!(store.annotations(&analysis, None, 10).unwrap().len(), 2);
        assert_eq!(
            store
                .annotations(&analysis, Some("symbol:x"), 10)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .annotations(&analysis, Some("symbol:y"), 10)
                .unwrap()
                .len(),
            0
        );
        assert!(
            store
                .create_annotation(&selection, "fact", "no", "human")
                .is_err()
        );
    }

    #[test]
    fn unbounded_actions_are_rejected_at_enqueue() {
        let (store, analysis) = store_with_analysis();
        let spec = AgentRequestSpec {
            owner: "agent-1",
            request_key: "k1",
            kind: "write_source",
            analysis_id: &analysis,
            entity_id: None,
            payload: None,
        };
        let (request, created) = store.enqueue_agent_request(&spec).unwrap();
        assert!(created);
        assert_eq!(request.state, STATE_REJECTED);
        assert_eq!(
            request.terminal_reason.as_deref(),
            Some(REASON_UNBOUNDED_ACTION)
        );
        // A rejected request is never claimable.
        assert!(store.claim_agent_request("h", 60_000).unwrap().is_none());
    }

    #[test]
    fn a_request_for_an_unknown_analysis_is_rejected_not_queued() {
        let (store, _) = store_with_analysis();
        let spec = AgentRequestSpec {
            owner: "agent-1",
            request_key: "k2",
            kind: "inspect",
            analysis_id: "analysis-that-does-not-exist",
            entity_id: None,
            payload: None,
        };
        let (request, _) = store.enqueue_agent_request(&spec).unwrap();
        assert_eq!(request.state, STATE_REJECTED);
        assert_eq!(request.terminal_reason.as_deref(), Some("unknown_analysis"));
    }

    #[test]
    fn identity_is_the_owner_and_request_key_pair() {
        let (store, analysis) = store_with_analysis();
        let spec = |owner: &'static str, key: &'static str| AgentRequestSpec {
            owner,
            request_key: key,
            kind: "inspect",
            analysis_id: &analysis,
            entity_id: Some("symbol:x"),
            payload: None,
        };
        let (first, created) = store
            .enqueue_agent_request(&spec("agent-1", "same"))
            .unwrap();
        assert!(created);
        let (again, created) = store
            .enqueue_agent_request(&spec("agent-1", "same"))
            .unwrap();
        assert!(!created, "the same request asked twice is one row");
        assert_eq!(again.id, first.id);
        let (other_owner, created) = store
            .enqueue_agent_request(&spec("agent-2", "same"))
            .unwrap();
        assert!(created);
        assert_ne!(
            other_owner.id, first.id,
            "a different owner is a different request"
        );
    }

    #[test]
    fn only_the_lease_holder_can_finish_a_request() {
        let (store, analysis) = store_with_analysis();
        let spec = AgentRequestSpec {
            owner: "agent-1",
            request_key: "k3",
            kind: "inspect",
            analysis_id: &analysis,
            entity_id: None,
            payload: None,
        };
        store.enqueue_agent_request(&spec).unwrap();
        let claimed = store
            .claim_agent_request("holder-a", 60_000)
            .unwrap()
            .unwrap();
        assert_eq!(claimed.state, STATE_LEASED);
        assert!(claimed.ack_at.is_some(), "claiming is the acknowledgement");
        // A bystander cannot finish someone else's claim.
        assert!(
            !store
                .finish_agent_request(&claimed.id, "holder-b", STATE_DONE, Some("{}"), None)
                .unwrap()
        );
        // A stale holder cannot either, once the lease has been taken over.
        store
            .reap_agent_requests(crate::job::now_ms() + 120_000)
            .unwrap();
        let reclaimed = store
            .claim_agent_request("holder-c", 60_000)
            .unwrap()
            .unwrap();
        assert_eq!(reclaimed.attempt, 2, "an expired lease is claimable again");
        assert!(
            !store
                .finish_agent_request(&claimed.id, "holder-a", STATE_DONE, Some("{}"), None)
                .unwrap()
        );
        assert!(
            store
                .finish_agent_request(&reclaimed.id, "holder-c", STATE_DONE, Some("{}"), None)
                .unwrap()
        );
        let done = store.agent_request(&reclaimed.id).unwrap();
        assert_eq!(done.state, STATE_DONE);
        assert_eq!(done.result.as_deref(), Some("{}"));
    }
}

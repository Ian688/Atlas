//! Persistent job ownership (W06).
//!
//! A job is the durable identity of "this request, for this project, on behalf
//! of this owner". Three properties make it useful rather than decorative:
//!
//! * **Idempotency.** The identity is derived from (owner, project,
//!   request_key), so two processes submitting the same request address the
//!   same row. A completed request is never silently re-run.
//! * **Ownership.** Only the holder of a live lease may move a job to a
//!   terminal state, so a slow or resurrected runner cannot overwrite the
//!   result of the run that actually finished.
//! * **Recovery.** A lease that stops being renewed is reaped, which is how a
//!   crashed process is detected. Because publication is already atomic and
//!   immutable, a reaped job leaves either a complete Analysis or nothing --
//!   never a half-written one.
//!
//! This module owns no analysis logic: it decides *who may run*, not *what a
//! run means*.

use crate::store::Store;
use crate::{Result, digest, invalid};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a lease stays valid without a heartbeat.
pub const DEFAULT_LEASE_MS: i64 = 60_000;

pub const STATE_QUEUED: &str = "queued";
pub const STATE_RUNNING: &str = "running";
pub const STATE_COMPLETED: &str = "completed";
pub const STATE_FAILED: &str = "failed";
pub const STATE_CANCELLED: &str = "cancelled";

pub const REASON_LEASE_EXPIRED: &str = "lease_expired";

/// The kind of work a queued request describes. The queue is not index-specific:
/// `job work` claims whatever is queued and dispatches on this, so a second kind
/// of work joins the same identity, lease and crash-recovery machinery instead
/// of growing a parallel one.
pub const KIND_INDEX: &str = "index";
pub const KIND_PATCH_VERIFY: &str = "patch_verify";

pub fn is_known_kind(kind: &str) -> bool {
    matches!(kind, KIND_INDEX | KIND_PATCH_VERIFY)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub id: String,
    /// `index` or `patch_verify`; see `is_known_kind`.
    pub kind: String,
    pub owner: String,
    pub project: String,
    pub request_key: String,
    pub root: String,
    /// Opaque to this module: the runner's own parameters, stored so a queued
    /// request describes how to execute itself instead of depending on whichever
    /// worker happens to pick it up.
    pub options: Option<String>,
    pub priority: i64,
    pub state: String,
    pub attempt: u32,
    pub lease_holder: Option<String>,
    pub lease_expires_at: Option<i64>,
    pub heartbeat_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub terminal_reason: Option<String>,
    pub analysis_id: Option<String>,
}

/// Outcome of asking "may I run this request?".
///
/// The three cases are kept distinct on purpose: collapsing `Held` into
/// `Acquired` would let two runners believe they own the same job, and
/// collapsing `Settled` into `Held` would make a finished request look busy
/// forever.
#[derive(Clone, Debug)]
pub enum Lease {
    /// This caller holds the lease and may run the request.
    Acquired(Job),
    /// Somebody else holds a live lease; nothing was started.
    Held(Job),
    /// The request already reached a terminal state in a previous run.
    Settled(Job),
}

impl Lease {
    pub fn job(&self) -> &Job {
        match self {
            Lease::Acquired(job) | Lease::Held(job) | Lease::Settled(job) => job,
        }
    }
}

/// The identity and payload of one request.
///
/// Grouped rather than passed positionally: these five strings are all
/// interchangeable at the type level, so argument order would be the only thing
/// keeping an owner out of the project field.
pub struct JobRequest<'a> {
    /// Defaults to `index` so existing callers keep their meaning.
    pub kind: &'a str,
    pub owner: &'a str,
    pub project: &'a str,
    pub request_key: &'a str,
    pub root: &'a str,
    /// Opaque runner parameters, stored so the request describes how to run.
    pub options: &'a str,
}

impl JobRequest<'_> {
    fn validate(&self) -> Result<()> {
        if self.owner.is_empty() || self.project.is_empty() || self.request_key.is_empty() {
            return Err(invalid("job_identity_must_be_non_empty"));
        }
        // Only an index request is about a filesystem root. A patch
        // verification is about a stored proposal, and inventing a root for it
        // would be a field that means nothing.
        if self.root.is_empty() && self.kind == KIND_INDEX {
            return Err(invalid("job_root_must_be_non_empty"));
        }
        if !is_known_kind(self.kind) {
            return Err(invalid("job_kind_unknown"));
        }
        Ok(())
    }
}

fn row_to_job(row: &rusqlite::Row) -> rusqlite::Result<Job> {
    Ok(Job {
        id: row.get("id")?,
        kind: row.get("kind")?,
        owner: row.get("owner")?,
        project: row.get("project")?,
        request_key: row.get("request_key")?,
        root: row.get("root")?,
        options: row.get("options")?,
        priority: row.get("priority")?,
        state: row.get("state")?,
        attempt: row.get::<_, i64>("attempt")? as u32,
        lease_holder: row.get("lease_holder")?,
        lease_expires_at: row.get("lease_expires_at")?,
        heartbeat_at: row.get("heartbeat_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        terminal_reason: row.get("terminal_reason")?,
        analysis_id: row.get("analysis_id")?,
    })
}

/// Job mutations take the writer through the same immediate-transaction and
/// retry discipline as publication. The job store is where concurrent processes
/// are supposed to collide, so a bare statement that can lose that race would
/// defeat the mechanism it implements.
fn write_tx(conn: &rusqlite::Connection) -> Result<rusqlite::Transaction<'_>> {
    crate::store::publication_transaction(conn, &crate::control::ExecutionControl::new(None))
}

/// Stable identity for a request. Two processes that agree on the request must
/// agree on the id without coordinating.
pub fn job_id(owner: &str, project: &str, request_key: &str) -> String {
    digest(format!("atlas.job.v1\u{0}{owner}\u{0}{project}\u{0}{request_key}").as_bytes())
}

impl Store {
    /// Register the request and try to take its lease.
    ///
    /// `completed` jobs are returned as `Settled` without running again: the
    /// whole point of a request key is that the same request does not execute
    /// twice. `failed` and `cancelled` jobs are retryable, because the request
    /// was never satisfied.
    pub fn submit_job(
        &self,
        request: &JobRequest<'_>,
        holder: &str,
        lease_ms: i64,
    ) -> Result<Lease> {
        request.validate()?;
        let (owner, project, request_key) = (request.owner, request.project, request.request_key);
        let lease_ms = lease_ms.max(1000);
        let preferred = job_id(owner, project, request_key);
        let now = now_ms();
        let conn = self.connection()?;
        // Insert, identity lookup and claim live in one immediate transaction:
        // two processes must not both observe a claimable row and then both
        // claim it, and a claim that reads a half-applied insert is worse than
        // no claim at all.
        let tx = write_tx(&conn)?;
        tx.execute(
            "INSERT OR IGNORE INTO jobs(id,kind,owner,project,request_key,root,options,state,attempt,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,'queued',0,?8,?8)",
            params![
                preferred,
                request.kind,
                owner,
                project,
                request_key,
                request.root,
                request.options,
                now
            ],
        )?;
        // Resolve the handle from the request triple instead of assuming it is
        // the digest. The triple is the request's identity and the UNIQUE
        // constraint keeps exactly one row per triple, but a row that arrived
        // through a migration, import or repair may carry a different handle.
        // Assuming the two always agreed meant such a request failed closed
        // with `job_not_found` even though its row was right there.
        let id: String = tx.query_row(
            "SELECT id FROM jobs WHERE owner=?1 AND project=?2 AND request_key=?3",
            params![owner, project, request_key],
            |row| row.get(0),
        )?;
        // Only a queued, retryable, or expired-running job can be claimed. The
        // predicate and the update are one statement, so a claim cannot be
        // split by a concurrent claim of the same row.
        let claimed = tx.execute(
            "UPDATE jobs SET state='running', attempt=attempt+1, lease_holder=?2,
                    lease_expires_at=?3, heartbeat_at=?4, updated_at=?4, terminal_reason=NULL
             WHERE id=?1 AND (state IN ('queued','failed','cancelled')
                    OR (state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?4))",
            params![id, holder, now + lease_ms, now],
        )?;
        let job = tx.query_row("SELECT * FROM jobs WHERE id=?1", [&id], row_to_job)?;
        tx.commit()?;
        if claimed == 1 {
            return Ok(Lease::Acquired(job));
        }
        // Not claimable: say precisely why instead of reporting a generic busy.
        if job.state == STATE_COMPLETED {
            return Ok(Lease::Settled(job));
        }
        Ok(Lease::Held(job))
    }

    /// Register a request without running it. Returns the row and whether this
    /// call created it, so a caller can tell "queued now" from "already there".
    pub fn enqueue_job(&self, request: &JobRequest<'_>, priority: i64) -> Result<(Job, bool)> {
        request.validate()?;
        let (owner, project, request_key) = (request.owner, request.project, request.request_key);
        let preferred = job_id(owner, project, request_key);
        let now = now_ms();
        let conn = self.connection()?;
        let tx = write_tx(&conn)?;
        let created = tx.execute(
            "INSERT OR IGNORE INTO jobs(id,kind,owner,project,request_key,root,options,state,attempt,priority,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,'queued',0,?8,?9,?9)",
            params![
                preferred,
                request.kind,
                owner,
                project,
                request_key,
                request.root,
                request.options,
                priority,
                now
            ],
        )? == 1;
        let id: String = tx.query_row(
            "SELECT id FROM jobs WHERE owner=?1 AND project=?2 AND request_key=?3",
            params![owner, project, request_key],
            |row| row.get(0),
        )?;
        // Re-enqueueing a request that has not started may raise its priority.
        // The same goes for one that already failed or was cancelled: asking
        // again is a new submission of how to run it now, so it carries this
        // call's parameters rather than replaying the ones that failed. A row
        // that is queued or running is left exactly as it is -- a running job
        // belongs to its lease holder, and quietly rewriting its instructions
        // underneath it would make the terminal reason unreadable.
        if !created {
            tx.execute(
                "UPDATE jobs SET priority=?2, options=?3, updated_at=?4
                 WHERE id=?1 AND state IN ('queued','failed','cancelled')",
                params![id, priority, request.options, now],
            )?;
        }
        let job = tx.query_row("SELECT * FROM jobs WHERE id=?1", [&id], row_to_job)?;
        tx.commit()?;
        Ok((job, created))
    }

    /// Claim the next runnable job: highest priority first, then oldest first.
    ///
    /// An expired `running` row is runnable again. That is the point of a lease
    /// in a queue -- a crashed owner's work should be resumed by whoever is
    /// available, not stall the queue until an operator notices. Re-running is
    /// safe here because publication is idempotent and immutable: the same
    /// snapshot and sources can only ever produce one Analysis. `reap` remains
    /// the way to *give up* on such a run instead of resuming it.
    pub fn claim_next(&self, holder: &str, lease_ms: i64) -> Result<Option<Job>> {
        let lease_ms = lease_ms.max(1000);
        let now = now_ms();
        let conn = self.connection()?;
        let tx = write_tx(&conn)?;
        // Selecting then updating is safe inside one immediate transaction:
        // no other writer can interleave, so the row cannot be claimed twice.
        let candidate: Option<String> = tx
            .query_row(
                "SELECT id FROM jobs
                 WHERE state='queued'
                    OR (state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?1)
                 ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1",
                params![now],
                |row| row.get(0),
            )
            .optional()?;
        let Some(id) = candidate else {
            tx.commit()?;
            return Ok(None);
        };
        let claimed = tx.execute(
            "UPDATE jobs SET state='running', attempt=attempt+1, lease_holder=?2,
                    lease_expires_at=?3, heartbeat_at=?4, updated_at=?4, terminal_reason=NULL
             WHERE id=?1 AND (state='queued'
                    OR (state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?5))",
            params![id, holder, now + lease_ms, now, now],
        )?;
        if claimed != 1 {
            tx.commit()?;
            return Ok(None);
        }
        let job = tx.query_row("SELECT * FROM jobs WHERE id=?1", [&id], row_to_job)?;
        tx.commit()?;
        Ok(Some(job))
    }

    /// Cancel a job that has not started.
    ///
    /// A running job is deliberately not cancellable here: it belongs to a
    /// lease holder, and letting a bystander end it would make the lease
    /// meaningless. Ending a running job is the holder's cooperative
    /// cancellation, which already exists.
    pub fn cancel_queued(&self, id: &str, reason: Option<&str>) -> Result<bool> {
        let conn = self.connection()?;
        let tx = write_tx(&conn)?;
        let updated = tx.execute(
            "UPDATE jobs SET state='cancelled', terminal_reason=?2, updated_at=?3,
                    lease_expires_at=NULL, heartbeat_at=NULL
             WHERE id=?1 AND state='queued'",
            params![id, reason, now_ms()],
        )?;
        tx.commit()?;
        Ok(updated == 1)
    }

    /// Claim one specific row by id, for a runner that already knows exactly
    /// which request it owns (the HTTP server runs the verifications its own
    /// page enqueues). Same lease semantics as `claim_next`: the holder check
    /// is what stops two runners from sharing one job.
    ///
    /// A failed or cancelled row is claimable, and so is a running row whose
    /// lease expired. "Try again" is the normal thing to ask for after a
    /// failure, and a by-id claim is already a statement that this runner owns
    /// the request -- making the caller re-queue it first would only add a
    /// window in which somebody else's claim could land. A row that is
    /// currently held is not claimable, so a retry never doubles a running job.
    pub fn claim_job(&self, id: &str, holder: &str, lease_ms: i64) -> Result<Option<Job>> {
        let now = now_ms();
        let conn = self.connection()?;
        let tx = write_tx(&conn)?;
        let updated = tx.execute(
            "UPDATE jobs SET state='running', lease_holder=?2, lease_expires_at=?3,
                    heartbeat_at=?3, attempt=attempt+1, updated_at=?3, terminal_reason=NULL
             WHERE id=?1 AND (state IN ('queued','failed','cancelled')
                    OR (state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?4))",
            params![id, holder, now + lease_ms.max(1000), now],
        )?;
        tx.commit()?;
        if updated == 0 {
            return Ok(None);
        }
        self.job(id).map(Some)
    }

    pub fn job(&self, id: &str) -> Result<Job> {
        let job = self
            .connection()?
            .query_row("SELECT * FROM jobs WHERE id=?1", [id], row_to_job)
            .optional()?;
        job.ok_or_else(|| invalid("job_not_found"))
    }

    pub fn jobs(&self, state: Option<&str>, limit: usize) -> Result<Vec<Job>> {
        let limit = limit.clamp(1, 500);
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT * FROM jobs WHERE (?1 IS NULL OR state=?1) ORDER BY created_at DESC, id LIMIT ?2",
        )?;
        let rows = statement.query_map(params![state, limit], row_to_job)?;
        let mut jobs = Vec::new();
        for row in rows {
            jobs.push(row?);
        }
        Ok(jobs)
    }

    /// Renew the lease. Returns false when the lease is no longer ours, which
    /// is the signal that another holder took over (or the job was reaped).
    pub fn heartbeat_job(&self, id: &str, holder: &str, lease_ms: i64) -> Result<bool> {
        let now = now_ms();
        let conn = self.connection()?;
        let tx = write_tx(&conn)?;
        let updated = tx.execute(
            "UPDATE jobs SET lease_expires_at=?3, heartbeat_at=?4, updated_at=?4
             WHERE id=?1 AND state='running' AND lease_holder=?2",
            params![id, holder, now + lease_ms.max(1000), now],
        )?;
        tx.commit()?;
        Ok(updated == 1)
    }

    /// Move a job to a terminal state, but only while it is still ours.
    ///
    /// The holder check is the whole point: a runner whose lease expired while
    /// it was suspended must not be able to stamp its result onto a job that
    /// somebody else has since taken over.
    pub fn finish_job(
        &self,
        id: &str,
        holder: &str,
        state: &str,
        reason: Option<&str>,
        analysis_id: Option<&str>,
    ) -> Result<bool> {
        if ![STATE_COMPLETED, STATE_FAILED, STATE_CANCELLED].contains(&state) {
            return Err(invalid("job_terminal_state_invalid"));
        }
        if state == STATE_COMPLETED && analysis_id.is_none() {
            return Err(invalid("completed_job_requires_analysis_id"));
        }
        let now = now_ms();
        let conn = self.connection()?;
        let tx = write_tx(&conn)?;
        let updated = tx.execute(
            "UPDATE jobs SET state=?3, terminal_reason=?4, analysis_id=?5, updated_at=?6,
                    lease_expires_at=NULL, heartbeat_at=NULL
             WHERE id=?1 AND state='running' AND lease_holder=?2",
            params![id, holder, state, reason, analysis_id, now],
        )?;
        tx.commit()?;
        Ok(updated == 1)
    }

    /// Crash recovery: any run whose lease stopped being renewed is declared
    /// failed. This is what makes an abandoned process recoverable without
    /// guessing -- the lease is the evidence that the owner stopped.
    pub fn reap_expired_jobs(&self, lease_now: i64) -> Result<Vec<String>> {
        let conn = self.connection()?;
        let tx = write_tx(&conn)?;
        let mut statement = tx.prepare(
            "SELECT id FROM jobs WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?1 ORDER BY id",
        )?;
        let rows = statement.query_map([lease_now], |row| row.get::<_, String>(0))?;
        let mut reaped = Vec::new();
        for row in rows {
            reaped.push(row?);
        }
        drop(statement);
        for id in &reaped {
            tx.execute(
                "UPDATE jobs SET state='failed', terminal_reason=?2, updated_at=?3,
                        lease_expires_at=NULL, heartbeat_at=NULL
                 WHERE id=?1 AND state='running'",
                params![id, REASON_LEASE_EXPIRED, lease_now],
            )?;
        }
        tx.commit()?;
        Ok(reaped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("store")).unwrap();
        (dir, store)
    }

    fn request<'a>(key: &'a str, options: &'a str) -> JobRequest<'a> {
        JobRequest {
            kind: KIND_INDEX,
            owner: "alice",
            project: "proj",
            request_key: key,
            root: "/tmp/proj",
            options,
        }
    }

    fn submit(store: &Store, key: &str, holder: &str) -> Lease {
        store
            .submit_job(&request(key, "{}"), holder, DEFAULT_LEASE_MS)
            .unwrap()
    }

    fn enqueue(store: &Store, key: &str, priority: i64) -> Job {
        store.enqueue_job(&request(key, "{}"), priority).unwrap().0
    }

    fn backdate(store: &Store, id: &str, created_at: i64) {
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE jobs SET created_at=?2 WHERE id=?1",
                params![id, created_at],
            )
            .unwrap();
    }

    fn expire(store: &Store, id: &str) {
        store
            .connection()
            .unwrap()
            .execute(
                "UPDATE jobs SET lease_expires_at=1 WHERE id=?1",
                params![id],
            )
            .unwrap();
    }

    #[test]
    fn the_same_request_is_the_same_job_for_anyone_who_asks() {
        let (_dir, store) = store();
        let first = submit(&store, "r1", "host-a");
        let second = submit(&store, "r1", "host-b");
        assert_eq!(
            first.job().id,
            second.job().id,
            "identity must not depend on the caller"
        );
        assert!(matches!(first, Lease::Acquired(_)));
        assert!(
            matches!(second, Lease::Held(_)),
            "a live lease must not be shared"
        );
        assert_eq!(second.job().attempt, 1, "a refused claim is not an attempt");
    }

    #[test]
    fn a_completed_request_is_never_silently_re_run() {
        let (_dir, store) = store();
        let acquired = submit(&store, "r1", "host-a");
        let id = acquired.job().id.clone();
        assert!(
            store
                .finish_job(&id, "host-a", STATE_COMPLETED, None, Some("analysis-1"))
                .unwrap()
        );
        let again = submit(&store, "r1", "host-a");
        assert!(
            matches!(again, Lease::Settled(_)),
            "a finished request must report its result, not run again"
        );
        assert_eq!(again.job().analysis_id.as_deref(), Some("analysis-1"));
        assert_eq!(again.job().attempt, 1, "no second attempt was made");
    }

    #[test]
    fn a_failed_request_may_be_retried_with_the_same_key() {
        let (_dir, store) = store();
        let first = submit(&store, "r1", "host-a");
        let id = first.job().id.clone();
        assert!(
            store
                .finish_job(&id, "host-a", STATE_FAILED, Some("worker_crashed"), None)
                .unwrap()
        );
        let retry = submit(&store, "r1", "host-a");
        assert!(
            matches!(retry, Lease::Acquired(_)),
            "an unsatisfied request must be retryable"
        );
        assert_eq!(
            retry.job().attempt,
            2,
            "the retry must be visible as a second attempt"
        );
    }

    #[test]
    fn an_expired_lease_is_the_evidence_of_a_crashed_owner() {
        let (_dir, store) = store();
        let acquired = submit(&store, "r1", "host-a");
        let id = acquired.job().id.clone();
        // host-a stops renewing. Nothing else changes on disk.
        let reaped = store
            .reap_expired_jobs(now_ms() + DEFAULT_LEASE_MS + 1)
            .unwrap();
        assert_eq!(reaped, vec![id.clone()], "only the stale run may be reaped");
        let job = store.job(&id).unwrap();
        assert_eq!(job.state, STATE_FAILED);
        assert_eq!(job.terminal_reason.as_deref(), Some(REASON_LEASE_EXPIRED));
        assert!(
            job.lease_expires_at.is_none(),
            "a terminal job holds no lease"
        );
        // And the request can be retried, which is the point of recovering.
        assert!(matches!(submit(&store, "r1", "host-b"), Lease::Acquired(_)));
    }

    #[test]
    fn a_live_lease_survives_a_reap_pass() {
        let (_dir, store) = store();
        let acquired = submit(&store, "r1", "host-a");
        let id = acquired.job().id.clone();
        assert!(
            store
                .heartbeat_job(&id, "host-a", DEFAULT_LEASE_MS)
                .unwrap()
        );
        let reaped = store.reap_expired_jobs(now_ms()).unwrap();
        assert!(reaped.is_empty(), "a renewed lease must not be reaped");
        assert_eq!(store.job(&id).unwrap().state, STATE_RUNNING);
    }

    #[test]
    fn a_stale_holder_cannot_stamp_a_terminal_state() {
        let (_dir, store) = store();
        let acquired = submit(&store, "r1", "host-a");
        let id = acquired.job().id.clone();
        // host-a is suspended past its lease; host-b takes over.
        store
            .reap_expired_jobs(now_ms() + DEFAULT_LEASE_MS + 1)
            .unwrap();
        assert!(matches!(submit(&store, "r1", "host-b"), Lease::Acquired(_)));
        // host-a wakes up and tries to publish its result.
        assert!(
            !store
                .finish_job(&id, "host-a", STATE_COMPLETED, None, Some("stale"))
                .unwrap(),
            "a holder without the lease must not be able to finish the job"
        );
        assert!(
            !store
                .heartbeat_job(&id, "host-a", DEFAULT_LEASE_MS)
                .unwrap()
        );
        let job = store.job(&id).unwrap();
        assert_eq!(job.state, STATE_RUNNING);
        assert_eq!(job.lease_holder.as_deref(), Some("host-b"));
        assert!(
            job.analysis_id.is_none(),
            "the stale result must not reach the job"
        );
    }

    #[test]
    fn identity_separates_owners_projects_and_keys() {
        let (_dir, store) = store();
        let base = job_id("alice", "proj", "r1");
        assert_ne!(base, job_id("bob", "proj", "r1"));
        assert_ne!(base, job_id("alice", "other", "r1"));
        assert_ne!(base, job_id("alice", "proj", "r2"));
        assert_eq!(base, job_id("alice", "proj", "r1"));
        let cases = [
            JobRequest {
                kind: KIND_INDEX,
                owner: "",
                project: "proj",
                request_key: "r1",
                root: "/p",
                options: "{}",
            },
            JobRequest {
                kind: KIND_INDEX,
                owner: "a",
                project: "p",
                request_key: "r1",
                root: "",
                options: "{}",
            },
        ];
        for case in &cases {
            assert!(store.submit_job(case, "h", DEFAULT_LEASE_MS).is_err());
        }
        let no_key = JobRequest {
            kind: KIND_INDEX,
            owner: "a",
            project: "p",
            request_key: "",
            root: "/p",
            options: "{}",
        };
        assert!(store.enqueue_job(&no_key, 0).is_err());
    }

    #[test]
    fn enqueueing_does_not_run_and_keeps_one_row_per_request() {
        let (_dir, store) = store();
        let (job, created) = store
            .enqueue_job(&request("q1", "{\"node\":\"node\"}"), 0)
            .unwrap();
        assert!(created, "the first enqueue creates the request");
        assert_eq!(job.state, STATE_QUEUED, "enqueue must not start anything");
        assert_eq!(job.attempt, 0);
        assert!(
            job.lease_expires_at.is_none(),
            "a queued job holds no lease"
        );

        let (again, created_again) = store.enqueue_job(&request("q1", "{}"), 3).unwrap();
        assert!(
            !created_again,
            "the same request must not create a second row"
        );
        assert_eq!(again.id, job.id);
        assert_eq!(again.attempt, 0);
        assert_eq!(
            again.priority, 3,
            "a not-yet-started request may be re-prioritised"
        );
        assert_eq!(store.jobs(None, 10).unwrap().len(), 1);
    }

    #[test]
    fn the_queue_serves_priority_first_then_the_oldest() {
        let (_dir, store) = store();
        let low_old = enqueue(&store, "low-old", 0);
        let urgent = enqueue(&store, "urgent", 5);
        let low_new = enqueue(&store, "low-new", 0);
        backdate(&store, &low_old.id, 1_000);
        backdate(&store, &urgent.id, 2_000);
        backdate(&store, &low_new.id, 3_000);

        let first = store
            .claim_next("worker", DEFAULT_LEASE_MS)
            .unwrap()
            .unwrap();
        assert_eq!(first.id, urgent.id, "priority outranks age");
        assert_eq!(first.attempt, 1, "claiming is an attempt");
        let second = store
            .claim_next("worker", DEFAULT_LEASE_MS)
            .unwrap()
            .unwrap();
        assert_eq!(
            second.id, low_old.id,
            "equal priority falls back to the oldest"
        );
        let third = store
            .claim_next("worker", DEFAULT_LEASE_MS)
            .unwrap()
            .unwrap();
        assert_eq!(third.id, low_new.id);
        assert!(
            store
                .claim_next("worker", DEFAULT_LEASE_MS)
                .unwrap()
                .is_none(),
            "a drained queue yields nothing rather than re-serving a running job"
        );
    }

    #[test]
    fn a_run_whose_lease_expired_is_resumed_by_whoever_is_available() {
        let (_dir, store) = store();
        let queued = enqueue(&store, "q1", 0);
        let first = store
            .claim_next("worker-a", DEFAULT_LEASE_MS)
            .unwrap()
            .unwrap();
        assert_eq!(first.id, queued.id);
        expire(&store, &queued.id);
        // The owner died without anyone reaping it. A queue must not stall on
        // that: the lease is expired, so the work is available again.
        let resumed = store
            .claim_next("worker-b", DEFAULT_LEASE_MS)
            .unwrap()
            .unwrap();
        assert_eq!(resumed.id, queued.id, "the abandoned run must be resumable");
        assert_eq!(
            resumed.attempt, 2,
            "the resume is visible as a second attempt"
        );
        assert_eq!(resumed.lease_holder.as_deref(), Some("worker-b"));
    }

    #[test]
    fn a_cancelled_queued_job_is_never_claimed() {
        let (_dir, store) = store();
        let queued = enqueue(&store, "q1", 9);
        assert!(store.cancel_queued(&queued.id, Some("superseded")).unwrap());
        let job = store.job(&queued.id).unwrap();
        assert_eq!(job.state, STATE_CANCELLED);
        assert_eq!(job.terminal_reason.as_deref(), Some("superseded"));
        assert!(
            store
                .claim_next("worker", DEFAULT_LEASE_MS)
                .unwrap()
                .is_none(),
            "a cancelled request must not be served"
        );
        assert!(
            !store.cancel_queued(&queued.id, None).unwrap(),
            "cancelling a terminal job is not a second cancellation"
        );
    }

    #[test]
    fn a_running_job_cannot_be_cancelled_by_a_bystander() {
        let (_dir, store) = store();
        let queued = enqueue(&store, "q1", 0);
        store
            .claim_next("worker-a", DEFAULT_LEASE_MS)
            .unwrap()
            .unwrap();
        assert!(
            !store.cancel_queued(&queued.id, Some("stop")).unwrap(),
            "a running job belongs to its lease holder"
        );
        assert_eq!(store.job(&queued.id).unwrap().state, STATE_RUNNING);
    }

    #[test]
    fn a_request_is_addressable_even_when_its_handle_was_not_derived_from_the_triple() {
        let (_dir, store) = store();
        // A row written by a migration, an import or a hand repair may carry a
        // different handle. The request identity is the (owner, project, key)
        // triple, so the job must still be found and claimed rather than
        // reporting `job_not_found` for a request that plainly exists.
        store
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO jobs(id,owner,project,request_key,root,state,attempt,created_at,updated_at)
                 VALUES('legacy-handle','alice','proj','r1','/tmp/proj','failed',1,0,0)",
                [],
            )
            .unwrap();
        let lease = submit(&store, "r1", "host-a");
        assert!(
            matches!(lease, Lease::Acquired(_)),
            "an existing row must still be claimable"
        );
        assert_eq!(
            lease.job().id,
            "legacy-handle",
            "the existing handle must be reused"
        );
        assert_eq!(
            store.jobs(None, 10).unwrap().len(),
            1,
            "no duplicate row may be created"
        );
    }

    #[test]
    fn a_completed_job_requires_a_result_to_point_at() {
        let (_dir, store) = store();
        let acquired = submit(&store, "r1", "host-a");
        let id = acquired.job().id.clone();
        assert!(
            store
                .finish_job(&id, "host-a", STATE_COMPLETED, None, None)
                .is_err()
        );
        assert!(
            store
                .finish_job(&id, "host-a", "queued", None, None)
                .is_err()
        );
    }
}

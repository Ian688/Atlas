//! W09 continuation: the AI Coding chain's foundation -- applying a proposed
//! unified diff to *pinned snapshot bytes*, never to a working checkout.
//!
//! Everything here is deliberately strict. A diff applies at the position its
//! hunk header names, or it is refused with the exact line that disagreed;
//! there is no fuzzy search for "somewhere it fits". A fuzzy apply can silently
//! relocate a change into a similar-looking function, and the whole point of
//! pinning a version is that the bytes under discussion are known.
use crate::{Result, digest, invalid, store::Store};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub const STATE_PROPOSED: &str = "proposed";
pub const STATE_REJECTED: &str = "rejected";
pub const STATE_VERIFIED: &str = "verified";
pub const STATE_APPLIED: &str = "applied";
pub const STATE_REVERTED: &str = "reverted";

/// A stored proposal: the immutable part is the diff and the result of applying
/// it to the pinned bytes. State and verification are appended, never rewritten,
/// so the change a reviewer read is the change that gets applied.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PatchProposal {
    pub schema: String,
    pub id: String,
    pub analysis_id: String,
    pub entity_id: String,
    pub proposed_by: String,
    pub state: String,
    pub proposal: serde_json::Value,
    pub verification: Option<serde_json::Value>,
    pub target: Option<String>,
    pub terminal_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_to_proposal(row: &rusqlite::Row<'_>) -> rusqlite::Result<PatchProposal> {
    Ok(PatchProposal {
        schema: PATCH_SCHEMA.into(),
        id: row.get("id")?,
        analysis_id: row.get("analysis_id")?,
        entity_id: row.get("entity_id")?,
        proposed_by: row.get("proposed_by")?,
        state: row.get("state")?,
        proposal: serde_json::from_str(&row.get::<_, String>("proposal")?)
            .unwrap_or(serde_json::Value::Null),
        verification: row
            .get::<_, Option<String>>("verification")?
            .and_then(|text| serde_json::from_str(&text).ok()),
        target: row.get("target")?,
        terminal_reason: row.get("terminal_reason")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl Store {
    /// Store a proposal. The id is a digest of the pinned analysis, the target
    /// entity and the diff, so the same proposal twice is one row and a
    /// different diff against the same function is a different proposal.
    pub fn record_patch_proposal(
        &self,
        analysis_id: &str,
        entity_id: &str,
        proposed_by: &str,
        proposal: &serde_json::Value,
        state: &str,
        reason: Option<&str>,
    ) -> Result<(PatchProposal, bool)> {
        if ![STATE_PROPOSED, STATE_REJECTED].contains(&state) {
            return Err(invalid("patch_initial_state_invalid"));
        }
        let diff = proposal
            .get("diff")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let id = digest(format!("{PATCH_SCHEMA}|{analysis_id}|{entity_id}|{diff}").as_bytes());
        let encoded = serde_json::to_string(proposal)?;
        let now = crate::job::now_ms();
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let created = tx.execute(
            "INSERT OR IGNORE INTO patch_proposals
             (id,analysis_id,entity_id,proposed_by,state,proposal,verification,target,terminal_reason,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,NULL,NULL,?7,?8,?8)",
            params![id, analysis_id, entity_id, proposed_by, state, encoded, reason, now],
        )? == 1;
        let row = tx.query_row(
            "SELECT * FROM patch_proposals WHERE id=?1",
            [&id],
            row_to_proposal,
        )?;
        tx.commit()?;
        Ok((row, created))
    }

    pub fn patch_proposal(&self, id: &str) -> Result<PatchProposal> {
        self.connection()?
            .query_row(
                "SELECT * FROM patch_proposals WHERE id=?1",
                [id],
                row_to_proposal,
            )
            .optional()?
            .ok_or_else(|| invalid("patch_proposal_not_found"))
    }

    pub fn patch_proposals(
        &self,
        analysis: &str,
        entity: Option<&str>,
        limit: usize,
    ) -> Result<Vec<PatchProposal>> {
        let limit = limit.clamp(1, 100);
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT * FROM patch_proposals WHERE analysis_id=?1 AND (?2 IS NULL OR entity_id=?2)
             ORDER BY created_at DESC, id LIMIT ?3",
        )?;
        let rows = statement.query_map(params![analysis, entity, limit as i64], row_to_proposal)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Attach verification. Only a proposal that was accepted can be verified:
    /// a rejected diff has nothing to re-index.
    pub fn mark_patch_verified(&self, id: &str, verification: &serde_json::Value) -> Result<bool> {
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let updated = tx.execute(
            "UPDATE patch_proposals SET state=?2, verification=?3, updated_at=?4
             WHERE id=?1 AND state=?5",
            params![
                id,
                STATE_VERIFIED,
                serde_json::to_string(verification)?,
                crate::job::now_ms(),
                STATE_PROPOSED
            ],
        )?;
        tx.commit()?;
        Ok(updated == 1)
    }

    /// Record that the verified bytes were written to a target checkout.
    /// Mark a proposal applied. `actor` is recorded, not trusted: the CLI and
    /// the local page are different ways to reach the same write, and a record
    /// that does not say which one was used cannot be reviewed.
    pub fn mark_patch_applied(&self, id: &str, target: &str, actor: &str) -> Result<bool> {
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let updated = tx.execute(
            "UPDATE patch_proposals SET state=?2, target=?3, terminal_reason=?6, updated_at=?4
             WHERE id=?1 AND state=?5",
            params![
                id,
                STATE_APPLIED,
                target,
                crate::job::now_ms(),
                STATE_VERIFIED,
                format!("applied_by:{actor}")
            ],
        )?;
        tx.commit()?;
        Ok(updated == 1)
    }

    pub fn mark_patch_reverted(&self, id: &str, reason: Option<&str>) -> Result<bool> {
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let updated = tx.execute(
            "UPDATE patch_proposals SET state=?2, updated_at=?3, terminal_reason=?4
             WHERE id=?1 AND state=?5",
            params![
                id,
                STATE_REVERTED,
                crate::job::now_ms(),
                reason,
                STATE_APPLIED
            ],
        )?;
        tx.commit()?;
        Ok(updated == 1)
    }
}

/// Write an isolated working copy of a snapshot, with `overrides` replacing the
/// named files. The sandbox never receives the user's checkout, and every byte
/// that is not overridden still comes from a re-hashed content-addressed blob.
pub fn materialize(
    store: &Store,
    snapshot: &atlas_contract::Snapshot,
    outcome: &PatchOutcome,
) -> Result<tempfile::TempDir> {
    let base = fs::canonicalize(std::env::temp_dir())?;
    let dir = tempfile::Builder::new()
        .prefix("atlas-patch-")
        .tempdir_in(base)?;
    for entry in &snapshot.entries {
        let Some(blob) = &entry.blob else {
            continue;
        };
        let relative = crate::exec::safe_relative(&entry.path)?;
        let target = dir.path().join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        // A deleted file is simply not written into the copy. Nothing else in
        // the copy changes: every byte still comes from a re-hashed blob.
        if outcome.deleted.contains(&entry.path) {
            continue;
        }
        match outcome.files.get(&entry.path) {
            Some(bytes) => fs::write(&target, bytes)?,
            None => fs::write(&target, store.read_blob(blob)?)?,
        }
    }
    let in_snapshot = |path: &str| snapshot.entries.iter().any(|entry| entry.path == path);
    // A written path must be either a snapshot entry (a modify) or a real
    // creation. Anything else is a caller bug, and this is where it is caught
    // rather than in a copy that silently has an extra file in it.
    for entry in &outcome.report {
        let path = entry.path.as_str();
        crate::exec::safe_relative(path)?;
        match entry.form.as_str() {
            "modify" if !in_snapshot(path) => {
                return Err(invalid(&format!("patched_path_not_in_snapshot:{path}")));
            }
            "create" if in_snapshot(path) => {
                return Err(invalid(&format!("created_path_already_in_snapshot:{path}")));
            }
            "delete" if !in_snapshot(path) => {
                return Err(invalid(&format!("deleted_path_not_in_snapshot:{path}")));
            }
            _ => {}
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Read every snapshot entry that has a blob, for in-memory patching.
pub fn snapshot_files(
    store: &Store,
    snapshot: &atlas_contract::Snapshot,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut files = BTreeMap::new();
    for entry in &snapshot.entries {
        if let Some(blob) = &entry.blob {
            files.insert(entry.path.clone(), store.read_blob(blob)?);
        }
    }
    Ok(files)
}

/// Write one file under a root, after checking the bytes currently there.
///
/// `expect` is the digest the file must have right now. Refusing on a mismatch
/// is what keeps "apply" from silently overwriting work that happened after the
/// proposal was verified.
pub fn write_checked(root: &Path, relative: &str, bytes: &[u8], expect: &str) -> Result<()> {
    let relative_path = crate::exec::safe_relative(relative)?;
    let target = root.join(relative_path);
    let current = fs::read(&target)
        .map_err(|error| invalid(&format!("target_unreadable:{relative}:{error}")))?;
    if digest(&current) != expect {
        return Err(invalid(&format!("target_changed_since_apply:{relative}")));
    }
    let temporary = target.with_extension("atlas-incoming");
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, &target)?;
    Ok(())
}

/// The name of the lock file an apply/revert holds for the whole operation.
///
/// The byte check and the write are two steps, so without a lock two Atlas
/// processes can both pass the check and then both write: the second one wins
/// even though its check described a checkout that no longer exists. The lock is
/// taken before the first check and released when the guard drops, including on
/// every error path.
pub const APPLY_LOCK_FILE: &str = ".atlas-apply.lock";

/// An exclusive lock on one checkout, held for one apply or revert.
///
/// `create_new` is the whole mechanism: the operating system refuses the second
/// creator. The holder's identity is written inside so the refusal can say who
/// holds it instead of just "locked".
pub struct ApplyLock {
    path: PathBuf,
}

impl ApplyLock {
    pub fn acquire(root: &Path, holder: &str) -> Result<Self> {
        let relative = crate::exec::safe_relative(APPLY_LOCK_FILE)?;
        let path = root.join(relative);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                let _ = writeln!(file, "{holder}");
                Ok(ApplyLock { path })
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = fs::read_to_string(&path).unwrap_or_default();
                Err(invalid(&format!(
                    "apply_lock_held:{}:holder={}",
                    path.display(),
                    existing.trim()
                )))
            }
            Err(error) => Err(invalid(&format!(
                "apply_lock_unavailable:{}:{error}",
                path.display()
            ))),
        }
    }
}

impl Drop for ApplyLock {
    fn drop(&mut self) {
        // Best effort: a lock left behind by a crash is reported by the next
        // attempt, which is better than a lock silently disappearing while a
        // process still holds it.
        let _ = fs::remove_file(&self.path);
    }
}

/// Create one file under a root, refusing if anything is already there.
///
/// The drift check for a creation is the absence itself: a file that appeared
/// after review is somebody's work, and overwriting it would be the same loss
/// `write_checked` exists to prevent.
pub fn create_checked(root: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    let relative_path = crate::exec::safe_relative(relative)?;
    let target = root.join(relative_path);
    if target.exists() {
        return Err(invalid(&format!("create_target_already_exists:{relative}")));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = target.with_extension("atlas-incoming");
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, &target)?;
    Ok(())
}

/// Remove one file under a root, after checking the bytes currently there.
pub fn remove_checked(root: &Path, relative: &str, expect: &str) -> Result<()> {
    let relative_path = crate::exec::safe_relative(relative)?;
    let target = root.join(relative_path);
    let current = fs::read(&target)
        .map_err(|error| invalid(&format!("target_unreadable:{relative}:{error}")))?;
    if digest(&current) != expect {
        return Err(invalid(&format!("target_changed_since_apply:{relative}")));
    }
    fs::remove_file(&target)?;
    Ok(())
}

/// Restore a deleted file, refusing if something took its place.
pub fn restore_checked(root: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    let relative_path = crate::exec::safe_relative(relative)?;
    let target = root.join(relative_path);
    if target.exists() {
        return Err(invalid(&format!(
            "target_recreated_since_delete:{relative}"
        )));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = target.with_extension("atlas-incoming");
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, &target)?;
    Ok(())
}

pub const PATCH_SCHEMA: &str = "atlas.patch-proposal.v1";

/// What a whole diff does to a snapshot: the contents it writes, the paths it
/// removes, and one report entry per file.
///
/// The three are kept apart on purpose. A deletion is not "a file whose new
/// content is empty" -- that is a file edited to be empty, which is a different
/// change and has a different revert.
#[derive(Clone, Debug, Default)]
pub struct PatchOutcome {
    pub files: BTreeMap<String, Vec<u8>>,
    pub deleted: std::collections::BTreeSet<String>,
    pub report: Vec<AppliedPatch>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiffLine {
    Context(String),
    Remove(String),
    Add(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
    pub lines: Vec<DiffLine>,
    /// A hunk touching the last line of a file without a trailing newline.
    pub old_no_newline: bool,
    pub new_no_newline: bool,
}

/// What a file patch does to the path it names.
///
/// The form is not inferred from the shape of the hunks alone: it is what the
/// diff headers say (`--- /dev/null` creates, `+++ /dev/null` deletes), and the
/// hunks are then checked to agree. Inferring it would let a diff that edits a
/// file to empty read as a deletion.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchForm {
    Modify,
    Create,
    Delete,
}

impl PatchForm {
    pub fn as_str(self) -> &'static str {
        match self {
            PatchForm::Modify => "modify",
            PatchForm::Create => "create",
            PatchForm::Delete => "delete",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FilePatch {
    /// Snapshot-relative path, with any `a/` or `b/` prefix removed.
    pub path: String,
    pub form: PatchForm,
    pub hunks: Vec<Hunk>,
}

/// Parse a unified diff.
///
/// Only the subset a proposal actually needs is accepted: `---`/`+++` headers
/// and `@@` hunks with ` `, `-`, `+` and `\` lines. Anything else is an error,
/// because guessing at an unrecognised construct is how a proposal becomes a
/// different change than the one that was reviewed.
pub fn parse_unified_diff(text: &str) -> Result<Vec<FilePatch>> {
    let mut files: Vec<FilePatch> = Vec::new();
    let mut current: Option<FilePatch> = None;
    let mut hunk: Option<Hunk> = None;
    let mut seen_old_header = false;
    let mut old_path: Option<String> = None;
    for line in text.lines() {
        // A rename is not expressible as a byte patch: `delete` plus `create`
        // would lose the identity link between the two paths, and this project
        // would rather refuse than model it as something it is not.
        for marker in ["rename from ", "rename to ", "copy from ", "copy to "] {
            if line.starts_with(marker) {
                return Err(invalid("rename_not_expressible_in_unified_diff"));
            }
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            // Close the previous file completely: its last hunk ends here, and
            // forgetting that made the first of two files carry zero hunks.
            if let Some(finished) = hunk.take()
                && let Some(patch) = current.as_mut()
            {
                patch.hunks.push(finished);
            }
            if let Some(patch) = current.take() {
                files.push(patch);
            }
            let path = header_path(rest).ok_or_else(|| invalid("diff_header_path_missing"))?;
            old_path = Some(path.to_string());
            seen_old_header = true;
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            if !seen_old_header {
                return Err(invalid("diff_plus_header_without_minus_header"));
            }
            seen_old_header = false;
            if let Some(finished) = hunk.take()
                && let Some(patch) = current.as_mut()
            {
                patch.hunks.push(finished);
            }
            let new_path = header_path(rest).ok_or_else(|| invalid("diff_header_path_missing"))?;
            let old = old_path
                .take()
                .ok_or_else(|| invalid("diff_missing_old_header"))?;
            let (path, form) = match (old.as_str(), new_path) {
                ("/dev/null", "/dev/null") => return Err(invalid("diff_has_no_path")),
                // A create names the file only on the new side.
                ("/dev/null", new) => (new.to_string(), PatchForm::Create),
                // A delete names it only on the old side.
                (old, "/dev/null") => (old.to_string(), PatchForm::Delete),
                // Anything else must agree, or the patch would be applied to a
                // path the reviewer never saw on the other header.
                (old, new) if old != new => {
                    return Err(invalid(&format!("diff_headers_disagree:{old}:{new}")));
                }
                (_, new) => (new.to_string(), PatchForm::Modify),
            };
            current = Some(FilePatch {
                path,
                form,
                hunks: Vec::new(),
            });
            continue;
        }
        if let Some(rest) = line.strip_prefix("@@") {
            let Some(patch) = current.as_mut() else {
                return Err(invalid("diff_hunk_without_file_header"));
            };
            // The first hunk of a file has no previous hunk to close.
            if let Some(finished) = hunk.take() {
                patch.hunks.push(finished);
            }
            hunk = Some(parse_hunk_header(rest)?);
            continue;
        }
        let Some(active) = hunk.as_mut() else {
            // File-level metadata (`diff --git`, `index`, mode lines) is
            // ignored on purpose; it does not change which bytes are applied.
            continue;
        };
        if line.starts_with('\\') {
            // `\ No newline at end of file` belongs to the line above it. It is
            // recorded rather than acted on: `apply_file` keeps the original
            // file's final-newline state and refuses CRLF instead of silently
            // normalising either.
            match active.lines.last() {
                Some(DiffLine::Add(_)) => active.new_no_newline = true,
                Some(DiffLine::Context(_)) | Some(DiffLine::Remove(_)) => {
                    active.old_no_newline = true;
                    active.new_no_newline = true;
                }
                None => {}
            }
            continue;
        }
        if line.is_empty() {
            // A truly empty line in a hunk body means a context line for an
            // empty line; some tools omit the leading space.
            active.lines.push(DiffLine::Context(String::new()));
            continue;
        }
        let (marker, rest) = line.split_at(1);
        match marker {
            " " => active.lines.push(DiffLine::Context(rest.to_string())),
            "-" => active.lines.push(DiffLine::Remove(rest.to_string())),
            "+" => active.lines.push(DiffLine::Add(rest.to_string())),
            other => return Err(invalid(&format!("diff_line_marker_unknown:{other}"))),
        }
    }
    if let Some(hunk) = hunk.take()
        && let Some(patch) = current.as_mut()
    {
        patch.hunks.push(hunk);
    }
    if let Some(patch) = current.take() {
        files.push(patch);
    }
    if files.is_empty() {
        return Err(invalid("diff_has_no_file_patch"));
    }
    for patch in &files {
        if patch.hunks.is_empty() {
            return Err(invalid("diff_file_has_no_hunks"));
        }
    }
    Ok(files)
}

fn header_path(rest: &str) -> Option<&str> {
    // `+++ b/src/a.js\t2026-01-01` -- the path ends at the first tab.
    let path = rest.split('\t').next()?.trim();
    let path = path
        .strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path);
    if path.is_empty() { None } else { Some(path) }
}

fn parse_hunk_header(rest: &str) -> Result<Hunk> {
    // rest looks like ` -1,3 +1,4 @@ optional section heading`
    let rest = rest.trim_start();
    let close = rest
        .find("@@")
        .ok_or_else(|| invalid("diff_hunk_header_unterminated"))?;
    let ranges = rest[..close].trim();
    let mut parts = ranges.split_whitespace();
    let old = parts
        .next()
        .ok_or_else(|| invalid("diff_hunk_old_range_missing"))?;
    let new = parts
        .next()
        .ok_or_else(|| invalid("diff_hunk_new_range_missing"))?;
    if parts.next().is_some() {
        return Err(invalid("diff_hunk_range_has_extra_tokens"));
    }
    let (old_start, old_len) = parse_range(old.strip_prefix('-').unwrap_or(old))?;
    let (new_start, new_len) = parse_range(new.strip_prefix('+').unwrap_or(new))?;
    Ok(Hunk {
        old_start,
        old_len,
        new_start,
        new_len,
        lines: Vec::new(),
        old_no_newline: false,
        new_no_newline: false,
    })
}

fn parse_range(text: &str) -> Result<(usize, usize)> {
    let mut parts = text.splitn(2, ',');
    let start: usize = parts
        .next()
        .ok_or_else(|| invalid("diff_range_missing"))?
        .parse()
        .map_err(|_| invalid("diff_range_not_a_number"))?;
    let len: usize = match parts.next() {
        None => 1,
        Some(value) => value
            .parse()
            .map_err(|_| invalid("diff_range_length_not_a_number"))?,
    };
    Ok((start, len))
}

/// Where a hunk failed to apply.
#[derive(Clone, Debug, serde::Serialize)]
pub struct ApplyFailure {
    pub path: String,
    pub hunk: usize,
    pub line: usize,
    pub expected: String,
    pub found: String,
    pub detail: String,
}

/// Apply one file patch to its original text.
///
/// Line endings are handled explicitly rather than by trimming: a patch
/// authored against LF is refused on a CRLF file instead of quietly rewriting
/// every line, because "the file changed in a way nobody reviewed" is exactly
/// the failure this chain exists to prevent.
pub fn apply_file(original: &str, patch: &FilePatch) -> std::result::Result<String, ApplyFailure> {
    let fail =
        |hunk: usize, line: usize, expected: String, found: String, detail: &str| ApplyFailure {
            path: patch.path.clone(),
            hunk,
            line,
            expected,
            found,
            detail: detail.to_string(),
        };
    if original.contains("\r\n") {
        return Err(fail(
            0,
            0,
            "LF 行尾".into(),
            "CRLF 行尾".into(),
            "本切片只对 LF 文件应用补丁；规范化行尾会在审查之外改写整个文件。",
        ));
    }
    let trailing_newline = original.ends_with('\n');
    let mut lines: Vec<String> = if original.is_empty() {
        Vec::new()
    } else {
        original.split('\n').map(str::to_string).collect()
    };
    if trailing_newline {
        lines.pop();
    }
    let mut offset: isize = 0;
    for (index, hunk) in patch.hunks.iter().enumerate() {
        let old_lines: Vec<&String> = hunk
            .lines
            .iter()
            .filter_map(|line| match line {
                DiffLine::Context(text) | DiffLine::Remove(text) => Some(text),
                DiffLine::Add(_) => None,
            })
            .collect();
        let start = hunk.old_start as isize - 1 + offset;
        if start < 0 {
            return Err(fail(
                index,
                1,
                format!("起始行 {}", hunk.old_start),
                "行 0".into(),
                "hunk 起始位置在文件之前",
            ));
        }
        let start = start as usize;
        if start > lines.len() || start + old_lines.len() > lines.len() {
            return Err(fail(
                index,
                start + 1,
                format!("{} 行上下文", old_lines.len()),
                format!("文件只剩 {} 行", lines.len().saturating_sub(start)),
                "hunk 超出了固定快照文件的范围",
            ));
        }
        for (position, want) in old_lines.iter().enumerate() {
            let have = &lines[start + position];
            if have != *want {
                return Err(fail(
                    index,
                    start + position + 1,
                    (*want).clone(),
                    have.clone(),
                    "上下文不匹配：固定快照的字节与提案假设的不同。Atlas 不做模糊匹配，因为那会把改动挪到另一个长得像的地方。",
                ));
            }
        }
        let mut replacement: Vec<String> = Vec::new();
        for line in &hunk.lines {
            match line {
                DiffLine::Context(text) | DiffLine::Add(text) => replacement.push(text.clone()),
                DiffLine::Remove(_) => {}
            }
        }
        let removed = old_lines.len();
        offset += replacement.len() as isize - removed as isize;
        lines.splice(start..start + removed, replacement);
    }
    let mut result = lines.join("\n");
    if trailing_newline && !result.is_empty() {
        result.push('\n');
    }
    Ok(result)
}

/// The result of applying a whole diff to a set of snapshot files.
#[derive(Clone, Debug, serde::Serialize)]
pub struct AppliedPatch {
    pub path: String,
    /// What this patch does at that path: modify, create or delete.
    pub form: String,
    pub hunks: usize,
    /// sha256 of the bytes this change leaves at the path. A deletion leaves
    /// nothing, so this is the digest of the empty byte string; `removed_digest`
    /// carries what was there instead.
    pub patched_digest: String,
    /// sha256 of the snapshot bytes this change removes, for a deletion. `None`
    /// for a modify or a create, where nothing is removed.
    pub removed_digest: Option<String>,
    pub added_lines: usize,
    pub removed_lines: usize,
}

/// The bytes a `create` patch installs: every line it adds, and nothing else.
///
/// A create that carries context or removal lines is not a create, and is
/// refused rather than reinterpreted: it would mean the author's `--- /dev/null`
/// disagreed with the body.
fn create_contents(patch: &FilePatch) -> Result<Vec<u8>> {
    let mut lines: Vec<String> = Vec::new();
    let mut trailing_newline = true;
    for hunk in &patch.hunks {
        if hunk.old_len != 0 || hunk.old_start != 0 {
            return Err(invalid(&format!(
                "create_patch_touches_existing_lines:{}",
                patch.path
            )));
        }
        if hunk.new_no_newline {
            trailing_newline = false;
        }
        for line in &hunk.lines {
            match line {
                DiffLine::Add(text) => lines.push(text.clone()),
                DiffLine::Context(_) | DiffLine::Remove(_) => {
                    return Err(invalid(&format!(
                        "create_patch_has_non_added_lines:{}",
                        patch.path
                    )));
                }
            }
        }
    }
    if lines.is_empty() {
        return Err(invalid(&format!("create_patch_is_empty:{}", patch.path)));
    }
    let mut text = lines.join("\n");
    if trailing_newline {
        text.push('\n');
    }
    Ok(text.into_bytes())
}

/// Check that a `delete` patch really deletes: no added lines, no context, and a
/// hunk that ends at line zero on the new side.
fn check_delete(patch: &FilePatch) -> Result<()> {
    for hunk in &patch.hunks {
        if hunk.new_len != 0 || hunk.new_start != 0 {
            return Err(invalid(&format!(
                "delete_patch_leaves_lines_behind:{}",
                patch.path
            )));
        }
        for line in &hunk.lines {
            if !matches!(line, DiffLine::Remove(_)) {
                return Err(invalid(&format!(
                    "delete_patch_has_context_or_added_lines:{}",
                    patch.path
                )));
            }
        }
    }
    Ok(())
}

/// Apply a parsed diff to snapshot contents.
///
/// A create must name a path the snapshot does not have, and a delete must name
/// one it does: the form is the author's statement, and it is checked against
/// what is really there rather than trusted. A path touched twice in one diff is
/// refused, because the order two patches apply in would otherwise decide the
/// result.
pub fn apply(files: &BTreeMap<String, Vec<u8>>, patches: &[FilePatch]) -> Result<PatchOutcome> {
    let mut outcome = PatchOutcome::default();
    let mut seen: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for patch in patches {
        crate::exec::safe_relative(&patch.path)?;
        if !seen.insert(patch.path.as_str()) {
            return Err(invalid(&format!(
                "diff_touches_a_path_twice:{}",
                patch.path
            )));
        }
        let added = patch
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .filter(|line| matches!(line, DiffLine::Add(_)))
            .count();
        let removed = patch
            .hunks
            .iter()
            .flat_map(|hunk| &hunk.lines)
            .filter(|line| matches!(line, DiffLine::Remove(_)))
            .count();
        let (bytes, removed_digest) = match patch.form {
            PatchForm::Create => {
                if files.contains_key(&patch.path) {
                    return Err(invalid(&format!(
                        "create_target_already_exists:{}",
                        patch.path
                    )));
                }
                (create_contents(patch)?, None)
            }
            PatchForm::Delete => {
                let original = files.get(&patch.path).ok_or_else(|| {
                    invalid(&format!("delete_target_not_in_snapshot:{}", patch.path))
                })?;
                check_delete(patch)?;
                let removed_digest = crate::digest(original);
                outcome.deleted.insert(patch.path.clone());
                (Vec::new(), Some(removed_digest))
            }
            PatchForm::Modify => {
                let original = files.get(&patch.path).ok_or_else(|| {
                    invalid(&format!("patch_target_not_in_snapshot:{}", patch.path))
                })?;
                let text = std::str::from_utf8(original)
                    .map_err(|_| invalid(&format!("patch_target_not_utf8:{}", patch.path)))?;
                let result = apply_file(text, patch).map_err(|failure| {
                    invalid(&format!(
                        "patch_does_not_apply:{}:{}",
                        failure.path,
                        serde_json::to_string(&failure).unwrap_or_default()
                    ))
                })?;
                (result.into_bytes(), None)
            }
        };
        outcome.report.push(AppliedPatch {
            path: patch.path.clone(),
            form: patch.form.as_str().to_string(),
            hunks: patch.hunks.len(),
            patched_digest: crate::digest(&bytes),
            removed_digest,
            added_lines: added,
            removed_lines: removed,
        });
        if patch.form != PatchForm::Delete {
            outcome.files.insert(patch.path.clone(), bytes);
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(entries: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        entries
            .iter()
            .map(|(path, text)| (path.to_string(), text.as_bytes().to_vec()))
            .collect()
    }

    #[test]
    fn a_single_hunk_replaces_one_line() {
        let diff = "--- a/src/a.js\n+++ b/src/a.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a + b;\n+  return a + b + 0;\n }\n";
        let patches = parse_unified_diff(diff).unwrap();
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0].path, "src/a.js");
        let outcome = apply(
            &files(&[(
                "src/a.js",
                "export function add(a, b) {\n  return a + b;\n}\n",
            )]),
            &patches,
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(outcome.files["src/a.js"].clone()).unwrap(),
            "export function add(a, b) {\n  return a + b + 0;\n}\n"
        );
        assert_eq!(outcome.report[0].added_lines, 1);
        assert_eq!(outcome.report[0].removed_lines, 1);
    }

    #[test]
    fn hunks_apply_in_order_with_the_offset_carried_forward() {
        let source = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
        let diff = "--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,3 @@\n one\n+one-and-a-half\n two\n@@ -7,2 +8,2 @@\n seven\n-eight\n+VIII\n";
        let patches = parse_unified_diff(diff).unwrap();
        let outcome = apply(&files(&[("x.txt", source)]), &patches).unwrap();
        assert_eq!(
            String::from_utf8(outcome.files["x.txt"].clone()).unwrap(),
            "one\none-and-a-half\ntwo\nthree\nfour\nfive\nsix\nseven\nVIII\n"
        );
    }

    #[test]
    fn a_context_mismatch_is_refused_with_the_line_that_disagreed() {
        // The same hunk, but the snapshot does not contain the line it expects.
        let diff = "--- a/src/a.js\n+++ b/src/a.js\n@@ -2,1 +2,1 @@\n-  return a + b;\n+  return a + b + 0;\n";
        let patches = parse_unified_diff(diff).unwrap();
        let error = apply(
            &files(&[(
                "src/a.js",
                "export function add(a, b) {\n  return a - b;\n}\n",
            )]),
            &patches,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("patch_does_not_apply"), "{error}");
        assert!(
            error.contains("return a - b;"),
            "the actual line must be quoted: {error}"
        );
    }

    #[test]
    fn a_hunk_beyond_the_end_of_the_file_is_refused() {
        let diff = "--- a/x.txt\n+++ b/x.txt\n@@ -9,1 +9,1 @@\n-nine\n+NINE\n";
        let patches = parse_unified_diff(diff).unwrap();
        let error = apply(&files(&[("x.txt", "one\n")]), &patches)
            .unwrap_err()
            .to_string();
        assert!(error.contains("超出了固定快照文件的范围"), "{error}");
    }

    #[test]
    fn a_target_that_is_not_in_the_snapshot_is_refused() {
        let diff = "--- a/new.js\n+++ b/new.js\n@@ -1,1 +1,1 @@\n-x\n+y\n";
        let patches = parse_unified_diff(diff).unwrap();
        let error = apply(&files(&[("src/a.js", "x\n")]), &patches)
            .unwrap_err()
            .to_string();
        assert!(error.contains("patch_target_not_in_snapshot"), "{error}");
    }

    #[test]
    fn a_create_names_a_new_path_and_installs_exactly_its_added_lines() {
        let creation = "--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+hello\n+world\n";
        let patches = parse_unified_diff(creation).unwrap();
        assert_eq!(patches[0].form, PatchForm::Create);
        assert_eq!(patches[0].path, "new.js");
        let outcome = apply(&files(&[("old.js", "x\n")]), &patches).unwrap();
        assert_eq!(
            String::from_utf8(outcome.files["new.js"].clone()).unwrap(),
            "hello\nworld\n"
        );
        assert!(outcome.deleted.is_empty());
        assert_eq!(outcome.report[0].form, "create");
        assert_eq!(outcome.report[0].removed_digest, None);
        // A create against a path that already exists would silently replace a
        // file the analysis has; that is a different change and is refused.
        let error = apply(&files(&[("new.js", "there\n")]), &patches)
            .unwrap_err()
            .to_string();
        assert!(error.contains("create_target_already_exists"), "{error}");
        // `--- /dev/null` with context or removal lines contradicts itself.
        let contradictory = "--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,2 @@\n+hello\n world\n";
        let patches = parse_unified_diff(contradictory).unwrap();
        let error = apply(&files(&[]), &patches).unwrap_err().to_string();
        assert!(
            error.contains("create_patch_has_non_added_lines"),
            "{error}"
        );
    }

    #[test]
    fn a_delete_removes_the_path_and_is_not_an_edit_to_empty() {
        let deletion = "--- a/gone.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n";
        let patches = parse_unified_diff(deletion).unwrap();
        assert_eq!(patches[0].form, PatchForm::Delete);
        assert_eq!(patches[0].path, "gone.js");
        let outcome = apply(
            &files(&[("gone.js", "a\nb\n"), ("kept.js", "k\n")]),
            &patches,
        )
        .unwrap();
        assert!(outcome.deleted.contains("gone.js"));
        assert!(
            outcome.files.is_empty(),
            "a deletion leaves no content behind, not empty content"
        );
        assert_eq!(outcome.report[0].form, "delete");
        assert!(outcome.report[0].removed_digest.is_some());
        // Deleting something that is not there is refused, not a no-op.
        let error = apply(&files(&[]), &patches).unwrap_err().to_string();
        assert!(error.contains("delete_target_not_in_snapshot"), "{error}");
        // A hunk that leaves lines behind is not a deletion of the file.
        let partial = "--- a/gone.js\n+++ /dev/null\n@@ -1,2 +1,1 @@\n a\n-b\n";
        assert!(parse_unified_diff(partial).is_ok());
        let error = apply(
            &files(&[("gone.js", "a\nb\n")]),
            &parse_unified_diff(partial).unwrap(),
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("delete_patch_leaves_lines_behind"),
            "{error}"
        );
    }

    #[test]
    fn structure_that_would_change_which_bytes_are_meant_is_refused() {
        // A rename is not a byte patch: delete+create would lose the link
        // between the two paths, so it is refused by name.
        let rename = "diff --git a/old.js b/new.js\nrename from old.js\nrename to new.js\n--- a/old.js\n+++ b/new.js\n@@ -1,1 +1,1 @@\n-a\n+b\n";
        assert_eq!(
            parse_unified_diff(rename).unwrap_err().to_string(),
            "rename_not_expressible_in_unified_diff"
        );
        // Headers that name different files would apply a patch to a path the
        // reviewer never saw on the other side.
        let disagree = "--- a/one.js\n+++ b/two.js\n@@ -1,1 +1,1 @@\n-a\n+b\n";
        let error = parse_unified_diff(disagree).unwrap_err().to_string();
        assert!(error.contains("diff_headers_disagree"), "{error}");
        // Two forms for one path in one diff: the order they apply in would
        // decide the result.
        let twice = "--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,1 @@\n-a\n+b\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,1 @@\n-b\n+c\n";
        let patches = parse_unified_diff(twice).unwrap();
        let error = apply(&files(&[("x.js", "a\n")]), &patches)
            .unwrap_err()
            .to_string();
        assert!(error.contains("diff_touches_a_path_twice"), "{error}");
    }

    #[test]
    fn an_unknown_line_marker_is_refused_rather_than_guessed() {
        assert!(parse_unified_diff("--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n?what\n").is_err());
    }

    #[test]
    fn a_pure_insertion_and_a_pure_deletion_both_work() {
        let insertion = "--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,2 @@\n one\n+inserted\n";
        let deletion = "--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,1 @@\n one\n-inserted\n";
        for (diff, expected) in [(insertion, "one\ninserted\n"), (deletion, "one\n")] {
            let patches = parse_unified_diff(diff).unwrap();
            let source = if diff == insertion {
                "one\n"
            } else {
                "one\ninserted\n"
            };
            let outcome = apply(&files(&[("x.txt", source)]), &patches).unwrap();
            assert_eq!(
                String::from_utf8(outcome.files["x.txt"].clone()).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn two_files_in_one_diff_are_both_applied() {
        let diff = "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/b.js\n+++ b/b.js\n@@ -1,1 +1,1 @@\n-b\n+B\n";
        let patches = parse_unified_diff(diff).unwrap();
        assert_eq!(patches.len(), 2);
        let outcome = apply(&files(&[("a.js", "a\n"), ("b.js", "b\n")]), &patches).unwrap();
        assert_eq!(
            String::from_utf8(outcome.files["a.js"].clone()).unwrap(),
            "A\n"
        );
        assert_eq!(
            String::from_utf8(outcome.files["b.js"].clone()).unwrap(),
            "B\n"
        );
        assert_eq!(outcome.report.len(), 2);
    }

    #[test]
    fn a_crlf_target_is_refused_instead_of_being_normalised() {
        let diff = "--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n";
        let patches = parse_unified_diff(diff).unwrap();
        let error = apply(&files(&[("x.txt", "one\r\ntwo\r\n")]), &patches)
            .unwrap_err()
            .to_string();
        assert!(error.contains("CRLF"), "{error}");
        assert!(error.contains("patch_does_not_apply"), "{error}");
    }

    #[test]
    fn the_final_newline_state_is_preserved() {
        let with_newline = "--- a/x.txt\n+++ b/x.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n";
        let patches = parse_unified_diff(with_newline).unwrap();
        let outcome = apply(&files(&[("x.txt", "one\n")]), &patches).unwrap();
        assert_eq!(
            String::from_utf8(outcome.files["x.txt"].clone()).unwrap(),
            "ONE\n"
        );
    }
}

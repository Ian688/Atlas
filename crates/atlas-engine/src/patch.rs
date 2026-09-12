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
use std::{collections::BTreeMap, fs, path::Path};

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
    pub fn mark_patch_applied(&self, id: &str, target: &str) -> Result<bool> {
        let conn = self.connection()?;
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        let updated = tx.execute(
            "UPDATE patch_proposals SET state=?2, target=?3, updated_at=?4
             WHERE id=?1 AND state=?5",
            params![
                id,
                STATE_APPLIED,
                target,
                crate::job::now_ms(),
                STATE_VERIFIED
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
    overrides: &BTreeMap<String, Vec<u8>>,
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
        match overrides.get(&entry.path) {
            Some(bytes) => fs::write(&target, bytes)?,
            None => fs::write(&target, store.read_blob(blob)?)?,
        }
    }
    // A file that was overridden but is not a snapshot entry is a bug in the
    // caller, not a feature: this slice cannot create files.
    for path in overrides.keys() {
        crate::exec::safe_relative(path)?;
        if !snapshot.entries.iter().any(|entry| &entry.path == path) {
            return Err(invalid(&format!("patched_path_not_in_snapshot:{path}")));
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

pub const PATCH_SCHEMA: &str = "atlas.patch-proposal.v1";

/// The patched contents of every file the diff touched, keyed by path, plus one
/// report entry per file.
pub type PatchOutcome = (BTreeMap<String, Vec<u8>>, Vec<AppliedPatch>);

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FilePatch {
    /// Snapshot-relative path, with any `a/` or `b/` prefix removed.
    pub path: String,
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
    for line in text.lines() {
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
            if path == "/dev/null" {
                return Err(invalid(
                    "diff_creates_or_deletes_a_file_which_this_slice_refuses",
                ));
            }
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
            let path = header_path(rest).ok_or_else(|| invalid("diff_header_path_missing"))?;
            if path == "/dev/null" {
                return Err(invalid(
                    "diff_creates_or_deletes_a_file_which_this_slice_refuses",
                ));
            }
            current = Some(FilePatch {
                path: path.to_string(),
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
    pub hunks: usize,
    /// sha256 of the patched bytes, so the outcome is content-addressed too.
    pub patched_digest: String,
    pub added_lines: usize,
    pub removed_lines: usize,
}

/// Apply a parsed diff to snapshot contents.
///
/// Every file it touches must already exist in the snapshot: this slice does
/// not create or delete files, because a proposal that adds a file is a
/// different kind of change than one that edits a function, and mixing them
/// would make the review step ambiguous.
pub fn apply(files: &BTreeMap<String, Vec<u8>>, patches: &[FilePatch]) -> Result<PatchOutcome> {
    let mut patched = BTreeMap::new();
    let mut report = Vec::new();
    for patch in patches {
        crate::exec::safe_relative(&patch.path)?;
        let original = files
            .get(&patch.path)
            .ok_or_else(|| invalid(&format!("patch_target_not_in_snapshot:{}", patch.path)))?;
        let text = std::str::from_utf8(original)
            .map_err(|_| invalid(&format!("patch_target_not_utf8:{}", patch.path)))?;
        let result = apply_file(text, patch).map_err(|failure| {
            invalid(&format!(
                "patch_does_not_apply:{}:{}",
                failure.path,
                serde_json::to_string(&failure).unwrap_or_default()
            ))
        })?;
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
        let bytes = result.into_bytes();
        report.push(AppliedPatch {
            path: patch.path.clone(),
            hunks: patch.hunks.len(),
            patched_digest: crate::digest(&bytes),
            added_lines: added,
            removed_lines: removed,
        });
        patched.insert(patch.path.clone(), bytes);
    }
    Ok((patched, report))
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
        let (patched, report) = apply(
            &files(&[(
                "src/a.js",
                "export function add(a, b) {\n  return a + b;\n}\n",
            )]),
            &patches,
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(patched["src/a.js"].clone()).unwrap(),
            "export function add(a, b) {\n  return a + b + 0;\n}\n"
        );
        assert_eq!(report[0].added_lines, 1);
        assert_eq!(report[0].removed_lines, 1);
    }

    #[test]
    fn hunks_apply_in_order_with_the_offset_carried_forward() {
        let source = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
        let diff = "--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,3 @@\n one\n+one-and-a-half\n two\n@@ -7,2 +8,2 @@\n seven\n-eight\n+VIII\n";
        let patches = parse_unified_diff(diff).unwrap();
        let (patched, _) = apply(&files(&[("x.txt", source)]), &patches).unwrap();
        assert_eq!(
            String::from_utf8(patched["x.txt"].clone()).unwrap(),
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
    fn creating_or_deleting_a_file_is_refused() {
        let creation = "--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,1 @@\n+hello\n";
        assert!(parse_unified_diff(creation).is_err());
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
            let (patched, _) = apply(&files(&[("x.txt", source)]), &patches).unwrap();
            assert_eq!(
                String::from_utf8(patched["x.txt"].clone()).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn two_files_in_one_diff_are_both_applied() {
        let diff = "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/b.js\n+++ b/b.js\n@@ -1,1 +1,1 @@\n-b\n+B\n";
        let patches = parse_unified_diff(diff).unwrap();
        assert_eq!(patches.len(), 2);
        let (patched, report) =
            apply(&files(&[("a.js", "a\n"), ("b.js", "b\n")]), &patches).unwrap();
        assert_eq!(String::from_utf8(patched["a.js"].clone()).unwrap(), "A\n");
        assert_eq!(String::from_utf8(patched["b.js"].clone()).unwrap(), "B\n");
        assert_eq!(report.len(), 2);
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
        let (patched, _) = apply(&files(&[("x.txt", "one\n")]), &patches).unwrap();
        assert_eq!(
            String::from_utf8(patched["x.txt"].clone()).unwrap(),
            "ONE\n"
        );
    }
}

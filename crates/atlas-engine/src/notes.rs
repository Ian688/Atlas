//! Durable node knowledge: the reader's own interpretations and the handoffs
//! they send to an agent.
//!
//! These are not analysis facts. An interpretation is what a person understood
//! and chose to save; a handoff is a request with its own identity so the same
//! request can be found again after the page, the browser or the service
//! restarts. Both therefore live in the store rather than in the page, and both
//! are scoped by *project* and by a reader-chosen anchor, because two projects
//! in one store legitimately contain the same path and the same function name.
//!
//! Nothing here rewrites source, and nothing here is derived from a model: an
//! interpretation records who wrote it, which analysis version it was written
//! against, and which sources it cites, so a later version can mark it as
//! needing review instead of silently inheriting it.
use crate::{Result, digest, invalid, store::Store};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

pub const INTERPRETATION_SCHEMA: &str = "atlas.interpretation.v1";
pub const HANDOFF_SCHEMA: &str = "atlas.handoff.v1";

fn row_value(
    row: &rusqlite::Row<'_>,
    with_refs: bool,
) -> rusqlite::Result<Value> {
    let refs: String = row.get("source_refs")?;
    let mut value = serde_json::json!({
        "id": row.get::<_, String>("id")?,
        "schema": INTERPRETATION_SCHEMA,
        "anchor": row.get::<_, String>("anchor")?,
        "analysis_id": row.get::<_, String>("analysis_id")?,
        "entity_id": row.get::<_, String>("entity_id")?,
        "author": row.get::<_, String>("author")?,
        "body": row.get::<_, String>("body")?,
        "basis_analysis": row.get::<_, String>("basis_analysis")?,
        "revises": row.get::<_, Option<String>>("revises")?,
        "created_at": row.get::<_, i64>("created_at")?,
    });
    let _ = with_refs;
    value["source_refs"] = serde_json::from_str(&refs).unwrap_or(Value::Array(Vec::new()));
    Ok(value)
}

fn clean_refs(refs: &[String]) -> Result<String> {
    if refs.len() > 16 {
        return Err(invalid("interpretation_source_refs_too_many"));
    }
    let mut out = Vec::new();
    for reference in refs {
        let trimmed = reference.trim();
        if trimmed.is_empty() || trimmed.len() > 256 {
            return Err(invalid("interpretation_source_ref_out_of_range"));
        }
        out.push(trimmed.to_string());
    }
    Ok(serde_json::to_string(&out)?)
}

impl Store {
    /// Save one interpretation revision. Each save is a new row: the earlier
    /// understanding is evidence of how the reader got here, not something to
    /// overwrite.
    #[allow(clippy::too_many_arguments)]
    pub fn create_interpretation(
        &self,
        project: &str,
        anchor: &str,
        analysis_id: &str,
        entity_id: &str,
        author: &str,
        body: &str,
        source_refs: &[String],
        revises: Option<&str>,
    ) -> Result<Value> {
        if anchor.trim().is_empty() || anchor.len() > 512 {
            return Err(invalid("interpretation_anchor_out_of_range"));
        }
        if analysis_id.trim().is_empty() {
            return Err(invalid("interpretation_analysis_required"));
        }
        if author.trim().is_empty() || author.len() > 128 {
            return Err(invalid("interpretation_author_out_of_range"));
        }
        if body.trim().is_empty() || body.len() > 32768 {
            return Err(invalid("interpretation_body_out_of_range"));
        }
        let refs = clean_refs(source_refs)?;
        let created_at = crate::job::now_ms();
        let id = digest(
            format!(
                "{INTERPRETATION_SCHEMA}|{project}|{anchor}|{author}|{body}|{created_at}"
            )
            .as_bytes(),
        );
        if let Some(previous) = revises {
            let known: bool = self
                .connection()?
                .query_row(
                    "SELECT 1 FROM interpretations WHERE id=?1 AND project=?2",
                    params![previous, project],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);
            if !known {
                return Err(invalid("interpretation_revision_parent_unknown"));
            }
        }
        let conn = self.connection()?;
        conn.execute(
            "INSERT INTO interpretations(id,project,anchor,analysis_id,entity_id,author,body,source_refs,basis_analysis,revises,created_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                id,
                project,
                anchor,
                analysis_id,
                entity_id,
                author,
                body,
                refs,
                analysis_id,
                revises,
                created_at
            ],
        )?;
        self.interpretation(&id)
    }

    pub fn interpretation(&self, id: &str) -> Result<Value> {
        let value = self
            .connection()?
            .query_row(
                "SELECT * FROM interpretations WHERE id=?1",
                [id],
                |row| row_value(row, true),
            )
            .optional()?
            .ok_or_else(|| invalid("interpretation_not_found"))?;
        Ok(value)
    }

    /// Revisions for one anchor, newest first, across analysis versions.
    pub fn interpretations(&self, project: &str, anchor: &str, limit: usize) -> Result<Vec<Value>> {
        let limit = limit.clamp(1, 200);
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT * FROM interpretations WHERE project=?1 AND anchor=?2 \
             ORDER BY created_at DESC, id DESC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![project, anchor, limit as i64], |row| {
            row_value(row, true)
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Create a handoff, or update the draft it names.
    #[allow(clippy::too_many_arguments)]
    pub fn save_handoff(
        &self,
        existing: Option<&str>,
        project: &str,
        analysis_id: &str,
        entity_id: &str,
        anchor: &str,
        author: &str,
        title: &str,
        goal: &str,
        scope: &Value,
        annotation_ids: &[String],
    ) -> Result<Value> {
        if goal.trim().is_empty() || goal.len() > 8192 {
            return Err(invalid("handoff_goal_out_of_range"));
        }
        if anchor.trim().is_empty() || anchor.len() > 512 {
            return Err(invalid("handoff_anchor_out_of_range"));
        }
        if author.trim().is_empty() || author.len() > 128 {
            return Err(invalid("handoff_author_out_of_range"));
        }
        let annotations = serde_json::to_string(&annotation_ids)?;
        let scope = serde_json::to_string(scope)?;
        let now = crate::job::now_ms();
        let conn = self.connection()?;
        if let Some(id) = existing {
            let changed = conn.execute(
                "UPDATE handoffs SET title=?1, goal=?2, scope=?3, annotations=?4, updated_at=?5 \
                 WHERE id=?6 AND project=?7",
                params![title, goal, scope, annotations, now, id, project],
            )?;
            if changed == 0 {
                return Err(invalid("handoff_not_found_for_project"));
            }
            return self.handoff(id);
        }
        let id = digest(
            format!("{HANDOFF_SCHEMA}|{project}|{anchor}|{author}|{goal}|{now}").as_bytes(),
        );
        conn.execute(
            "INSERT INTO handoffs(id,project,analysis_id,entity_id,anchor,created_by,title,goal,scope,annotations,messages,state,proposal_id,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,NULL,?13,?13)",
            params![
                id,
                project,
                analysis_id,
                entity_id,
                anchor,
                author,
                title,
                goal,
                scope,
                annotations,
                "[]",
                "draft",
                now
            ],
        )?;
        self.handoff(&id)
    }

    pub fn handoff(&self, id: &str) -> Result<Value> {
        let conn = self.connection()?;
        let row = conn
            .query_row(
                "SELECT * FROM handoffs WHERE id=?1",
                [id],
                handoff_value,
            )
            .optional()?
            .ok_or_else(|| invalid("handoff_not_found"))?;
        Ok(row)
    }

    pub fn handoffs(&self, project: &str, anchor: &str, limit: usize) -> Result<Vec<Value>> {
        let limit = limit.clamp(1, 200);
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT * FROM handoffs WHERE project=?1 AND (?2='' OR anchor=?2) \
             ORDER BY updated_at DESC, id DESC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![project, anchor, limit as i64], handoff_value)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Append one discussion message. It never edits a saved interpretation.
    pub fn append_handoff_message(&self, id: &str, author: &str, text: &str) -> Result<Value> {
        if text.trim().is_empty() || text.len() > 8192 {
            return Err(invalid("handoff_message_out_of_range"));
        }
        let conn = self.connection()?;
        let current: String = conn
            .query_row("SELECT messages FROM handoffs WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or_else(|| invalid("handoff_not_found"))?;
        let mut messages: Vec<Value> = serde_json::from_str(&current).unwrap_or_default();
        messages.push(serde_json::json!({
            "author": author,
            "text": text.trim(),
            "at": crate::job::now_ms(),
        }));
        let encoded = serde_json::to_string(&messages)?;
        let state = if messages.len() > 1 { "discussing" } else { "draft" };
        conn.execute(
            "UPDATE handoffs SET messages=?1, state=CASE WHEN state='draft' THEN ?2 ELSE state END, updated_at=?3 WHERE id=?4",
            params![encoded, state, crate::job::now_ms(), id],
        )?;
        self.handoff(id)
    }

    /// Attach a real proposal. The caller has already checked that the proposal
    /// belongs to the analysis being served; refusing to invent one is the whole
    /// point, so an unknown id is a named error.
    pub fn link_handoff_proposal(&self, id: &str, proposal_id: &str) -> Result<Value> {
        let conn = self.connection()?;
        let changed = conn.execute(
            "UPDATE handoffs SET proposal_id=?1, state='proposal_linked', updated_at=?2 WHERE id=?3",
            params![proposal_id, crate::job::now_ms(), id],
        )?;
        if changed == 0 {
            return Err(invalid("handoff_not_found"));
        }
        self.handoff(id)
    }

    pub fn mark_handoff_exported(&self, id: &str) -> Result<Value> {
        let conn = self.connection()?;
        conn.execute(
            "UPDATE handoffs SET state=CASE WHEN state='draft' THEN 'exported' ELSE state END, updated_at=?1 WHERE id=?2",
            params![crate::job::now_ms(), id],
        )?;
        self.handoff(id)
    }
}

fn handoff_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let scope: String = row.get("scope")?;
    let annotations: String = row.get("annotations")?;
    let messages: String = row.get("messages")?;
    let mut value = serde_json::json!({
        "id": row.get::<_, String>("id")?,
        "schema": HANDOFF_SCHEMA,
        "analysis_id": row.get::<_, String>("analysis_id")?,
        "entity_id": row.get::<_, String>("entity_id")?,
        "anchor": row.get::<_, String>("anchor")?,
        "created_by": row.get::<_, String>("created_by")?,
        "title": row.get::<_, String>("title")?,
        "goal": row.get::<_, String>("goal")?,
        "state": row.get::<_, String>("state")?,
        "proposal_id": row.get::<_, Option<String>>("proposal_id")?,
        "created_at": row.get::<_, i64>("created_at")?,
        "updated_at": row.get::<_, i64>("updated_at")?,
    });
    value["scope"] = serde_json::from_str(&scope).unwrap_or(Value::Null);
    value["annotations"] = serde_json::from_str(&annotations).unwrap_or(Value::Array(Vec::new()));
    value["messages"] = serde_json::from_str(&messages).unwrap_or(Value::Array(Vec::new()));
    Ok(value)
}

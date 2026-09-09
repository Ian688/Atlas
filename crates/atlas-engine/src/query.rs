use crate::{Result, digest, invalid, store::Store};
use atlas_contract::{Edge, Node, Page, Reachability};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// Page of symbols that have derived flow facts for an analysis.
#[derive(Debug, Serialize)]
pub struct SymbolPage {
    pub analysis_id: String,
    pub total: usize,
    pub items: Vec<String>,
    pub next_cursor: Option<String>,
}

pub fn flow_symbols(
    store: &Store,
    analysis: &str,
    limit: usize,
    cursor: Option<&str>,
) -> Result<SymbolPage> {
    page_limit(limit)?;
    store.metadata(analysis)?;
    let key = digest(&serde_json::to_vec(&(analysis, "flow_symbols", limit))?);
    let offset = offset(&key, cursor)?;
    let conn = store.connection()?;
    let total: usize = conn.query_row(
        "SELECT count(*) FROM facts WHERE analysis=?1 AND kind='flow'",
        params![analysis],
        |r| r.get(0),
    )?;
    if offset > total {
        return Err(invalid("cursor_outside_result"));
    }
    let mut statement = conn.prepare(
        "SELECT symbol FROM facts WHERE analysis=?1 AND kind='flow' ORDER BY symbol LIMIT ?2 OFFSET ?3",
    )?;
    let rows = statement.query_map(params![analysis, limit, offset], |r| r.get::<_, String>(0))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row?);
    }
    let next = offset + items.len();
    Ok(SymbolPage {
        analysis_id: analysis.into(),
        total,
        items,
        next_cursor: (next < total).then(|| format!("{key}:{next}")),
    })
}

fn offset(key: &str, cursor: Option<&str>) -> Result<usize> {
    if let Some(cursor) = cursor {
        let (owner, value) = cursor
            .split_once(':')
            .ok_or_else(|| invalid("invalid_cursor"))?;
        if owner != key {
            return Err(invalid("cursor_query_mismatch"));
        }
        value
            .parse::<usize>()
            .map_err(|_| invalid("invalid_cursor"))
    } else {
        Ok(0)
    }
}
fn page_limit(limit: usize) -> Result<()> {
    if limit == 0 || limit > 500 {
        Err(invalid("page_limit_must_be_1_to_500"))
    } else {
        Ok(())
    }
}

impl Store {
    pub fn node(&self, analysis: &str, id: &str) -> Result<Node> {
        let body: Option<String> = self
            .connection()?
            .query_row(
                "SELECT body FROM nodes WHERE analysis=?1 AND id=?2",
                params![analysis, id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(serde_json::from_str(
            &body.ok_or_else(|| invalid("entity_not_found"))?,
        )?)
    }
    pub fn nodes(
        &self,
        analysis: &str,
        kind: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<Page<Node>> {
        page_limit(limit)?;
        self.metadata(analysis)?;
        if !["all", "directory", "file", "function"].contains(&kind) {
            return Err(invalid("invalid_entity_kind"));
        }
        let key = digest(&serde_json::to_vec(&(analysis, "nodes", kind, limit))?);
        let offset = offset(&key, cursor)?;
        let conn = self.connection()?;
        let total: usize = conn.query_row(
            "SELECT count(*) FROM nodes WHERE analysis=?1 AND (?2='all' OR kind=?2)",
            params![analysis, kind],
            |r| r.get(0),
        )?;
        if offset > total {
            return Err(invalid("cursor_outside_result"));
        }
        let mut statement=conn.prepare("SELECT body FROM nodes WHERE analysis=?1 AND (?2='all' OR kind=?2) ORDER BY id LIMIT ?3 OFFSET ?4")?;
        let rows = statement.query_map(params![analysis, kind, limit, offset], |r| {
            r.get::<_, String>(0)
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(serde_json::from_str(&row?)?);
        }
        let next = offset + items.len();
        Ok(Page {
            analysis_id: analysis.into(),
            total,
            items,
            next_cursor: (next < total).then(|| format!("{key}:{next}")),
        })
    }
    pub fn edges(
        &self,
        analysis: &str,
        kind: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<Page<Edge>> {
        page_limit(limit)?;
        self.metadata(analysis)?;
        if !["all", "contains", "call_candidate", "import", "type_import"].contains(&kind) {
            return Err(invalid("invalid_edge_kind"));
        }
        let key = digest(&serde_json::to_vec(&(analysis, "edges", kind, limit))?);
        let offset = offset(&key, cursor)?;
        let conn = self.connection()?;
        let total: usize = conn.query_row(
            "SELECT count(*) FROM edges WHERE analysis=?1 AND (?2='all' OR kind=?2)",
            params![analysis, kind],
            |r| r.get(0),
        )?;
        if offset > total {
            return Err(invalid("cursor_outside_result"));
        }
        let mut statement=conn.prepare("SELECT body FROM edges WHERE analysis=?1 AND (?2='all' OR kind=?2) ORDER BY id LIMIT ?3 OFFSET ?4")?;
        let rows = statement.query_map(params![analysis, kind, limit, offset], |r| {
            r.get::<_, String>(0)
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(serde_json::from_str(&row?)?);
        }
        let next = offset + items.len();
        Ok(Page {
            analysis_id: analysis.into(),
            total,
            items,
            next_cursor: (next < total).then(|| format!("{key}:{next}")),
        })
    }
    /// Bounded breadth-first traversal over indexed adjacency. Unknown edges and pending work survive.
    pub fn reachable(
        &self,
        analysis: &str,
        root: &str,
        direction: &str,
        max_nodes: usize,
        max_edges: usize,
    ) -> Result<Reachability> {
        if !["out", "in"].contains(&direction)
            || max_nodes == 0
            || max_nodes > 500
            || max_edges == 0
            || max_edges > 2000
        {
            return Err(invalid("invalid_traversal_budget"));
        }
        let root_node = self.node(analysis, root)?;
        let conn = self.connection()?;
        let mut nodes = BTreeMap::from([(root.to_string(), root_node)]);
        let mut edges = BTreeMap::new();
        let mut unresolved = Vec::new();
        let mut frontier = BTreeSet::new();
        let mut queue = VecDeque::from([root.to_string()]);
        let mut expanded = BTreeSet::new();
        let mut budget_hit = false;
        let mut examined = 0usize;
        while let Some(current) = queue.pop_front() {
            if !expanded.insert(current.clone()) {
                continue;
            }
            let column = if direction == "out" {
                "source"
            } else {
                "target"
            };
            let sql = format!(
                "SELECT body FROM edges WHERE analysis=?1 AND {column}=?2 AND kind='call_candidate' ORDER BY id LIMIT ?3"
            );
            let remaining = max_edges.saturating_sub(examined);
            let mut statement = conn.prepare(&sql)?;
            let rows = statement.query_map(params![analysis, current, remaining + 1], |r| {
                r.get::<_, String>(0)
            })?;
            for (n, row) in rows.enumerate() {
                if n >= remaining {
                    budget_hit = true;
                    frontier.insert(current.clone());
                    break;
                }
                examined += 1;
                let edge: Edge = serde_json::from_str(&row?)?;
                let next = if direction == "out" {
                    edge.target.clone()
                } else {
                    Some(edge.source.clone())
                };
                if let Some(next) = next {
                    if !nodes.contains_key(&next) {
                        if nodes.len() >= max_nodes {
                            frontier.insert(next);
                            budget_hit = true;
                            continue;
                        }
                        nodes.insert(next.clone(), self.node(analysis, &next)?);
                        queue.push_back(next);
                    }
                    edges.insert(edge.id.clone(), edge);
                } else {
                    unresolved.push(edge);
                }
            }
            if examined >= max_edges {
                if !queue.is_empty() {
                    budget_hit = true;
                    frontier.extend(queue.drain(..));
                }
                break;
            }
        }
        Ok(Reachability{analysis_id:analysis.into(),root:root.into(),direction:direction.into(),nodes:nodes.into_values().collect(),edges:edges.into_values().collect(),unresolved,frontier:frontier.into_iter().collect(),truncated:budget_hit,semantics:"transitive lexical candidate reachability; not runtime paths; inbound unresolved callers cannot be enumerated".into()})
    }
    /// Frozen, content-addressed selection; no implicit model invocation or code write.
    pub fn context(&self, analysis: &str, entity: &str) -> Result<serde_json::Value> {
        let source = self.source(analysis, entity, 16000)?;
        let graph = self.reachable(analysis, entity, "out", 40, 120)?;
        let body = serde_json::json!({"schema":"atlas.selection-context.v1","analysis_id":analysis,"entity_id":entity,"source":source,"relations":graph,"disclosure":"local_only_until_explicitly_shared","evidence_kind":"static_candidates","limitations":self.metadata(analysis)?["limitations"]});
        let encoded = serde_json::to_string(&body)?;
        let id = digest(encoded.as_bytes());
        let conn = self.connection()?;
        conn.execute(
            "INSERT OR IGNORE INTO selections VALUES(?1,?2,?3)",
            params![id, analysis, encoded],
        )?;
        let existing: String =
            conn.query_row("SELECT body FROM selections WHERE id=?1", [&id], |r| {
                r.get(0)
            })?;
        if existing != encoded {
            return Err(invalid("immutable_selection_conflict"));
        }
        Ok(serde_json::json!({"selection_id":id,"context":body}))
    }
}

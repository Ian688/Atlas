//! Project map: the recursive containment tree behind the explore page.
//!
//! The published `Analysis` already carries the real containment structure: every
//! directory and file node has a `parent`, every symbol's parent is either its
//! file or its enclosing symbol, and the `contains` edges restate exactly that.
//! What it does not carry is a way to ask for *one level* of it, which is what a
//! page needs: loading a whole project to draw one folder is the thing the
//! design explicitly forbids.
//!
//! So this module answers one question -- "what are the direct members of this
//! object?" -- against the published index, with a bounded page, a real total,
//! and file categories that say whether semantic analysis even applies. Markdown
//! headings are derived from the captured bytes at query time (they are content,
//! not analysis output) and are addressed by byte span so the existing source
//! window endpoint can serve them without a second file reader.
use crate::{Result, digest, invalid, store::Store};
use atlas_contract::{Edge, Node};
use rusqlite::params;
use serde::Serialize;
use std::collections::BTreeMap;

/// One node as the map draws it.
#[derive(Clone, Debug, Serialize)]
pub struct TreeNode {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub parent: Option<String>,
    pub start: usize,
    pub end: usize,
    pub function_count: usize,
    pub bytes: Option<u64>,
    pub disposition: String,
    pub detail: Option<String>,
    /// For files: code | markdown | config | text | binary. `None` for
    /// directories and symbols, which are not classified by extension.
    pub file_kind: Option<String>,
    /// Known direct members of this node. Zero is a real answer ("a leaf"), and
    /// so is a large one; the page uses it to decide between "展开" and
    /// "继续加载".
    pub child_count: usize,
    pub has_children: bool,
    /// True when this object cannot have language semantics: a document, a
    /// binary, a text file, a directory. The page says so instead of implying
    /// that "no functions" means "no functions were found".
    pub unsupported_semantics: bool,
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Members {
    pub analysis_id: String,
    pub parent: Option<String>,
    /// Present when the caller asked for the root: the project node itself.
    pub root: Option<TreeNode>,
    pub total: usize,
    pub items: Vec<TreeNode>,
    pub next_cursor: Option<String>,
    pub notes: Vec<String>,
}

const PROJECT_ROOT_ID: &str = "dir:";

pub fn file_kind(path: &str) -> &'static str {
    if crate::scan::is_source(path) {
        return "code";
    }
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "md" | "markdown" | "mdx" => "markdown",
        "json" | "jsonc" | "toml" | "yaml" | "yml" | "ini" | "cfg" | "conf" | "env" => "config",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "pdf" | "zip" | "gz" | "tar"
        | "woff" | "woff2" | "ttf" | "otf" | "mp4" | "mov" | "webm" | "mp3" | "wav" | "wasm"
        | "so" | "dylib" | "dll" | "exe" | "class" | "jar" | "pyc" => "binary",
        _ => "text",
    }
}

fn is_markdown(path: &str) -> bool {
    file_kind(path) == "markdown"
}

fn has_child_capability(node: &Node) -> bool {
    match node.kind.as_str() {
        "directory" => true,
        // A code file's members are its declarations; a document's are its
        // headings; anything else is read whole.
        "file" => node.function_count > 0 || is_markdown(&node.path),
        "function" => true,
        _ => false,
    }
}

fn tree_node(node: &Node, bytes: Option<u64>, detail: Option<String>) -> TreeNode {
    let file_kind = (node.kind == "file").then(|| file_kind(&node.path).to_string());
    let unsupported = match node.kind.as_str() {
        "file" => file_kind.as_deref() != Some("code"),
        "directory" => true,
        _ => false,
    };
    TreeNode {
        id: node.id.clone(),
        path: node.path.clone(),
        name: node.name.clone(),
        kind: node.kind.clone(),
        parent: node.parent.clone(),
        start: node.start,
        end: node.end,
        function_count: node.function_count,
        bytes,
        disposition: node.disposition.clone(),
        detail,
        file_kind,
        child_count: node.function_count,
        has_children: has_child_capability(node),
        unsupported_semantics: unsupported,
        note: None,
    }
}

fn catalog_of(store: &Store, analysis: &str) -> Result<BTreeMap<String, (u64, Option<String>)>> {
    let meta = store.metadata(analysis)?;
    let snapshot = store.snapshot(meta["snapshot_id"].as_str().unwrap_or(""))?;
    Ok(snapshot
        .entries
        .into_iter()
        .map(|entry| {
            (
                entry.path,
                (entry.bytes, entry.detail.map(|d| d.to_string())),
            )
        })
        .collect())
}

/// Direct members of `parent`, or the project root when `parent` is absent.
pub fn members(
    store: &Store,
    analysis: &str,
    parent: Option<&str>,
    limit: usize,
    cursor: Option<&str>,
) -> Result<Members> {
    if limit == 0 || limit > 500 {
        return Err(invalid("page_limit_must_be_1_to_500"));
    }
    store.metadata(analysis)?;
    let key = digest(&serde_json::to_vec(&(
        analysis,
        "members",
        parent.unwrap_or(""),
        limit,
    ))?);
    let offset = offset(&key, cursor)?;

    let requested = match parent {
        None | Some("") | Some("project") => None,
        Some(value) => Some(value.to_string()),
    };

    // The project root: the empty-path directory the catalog always emits.
    let root_node = match requested {
        None => Some(store.node(analysis, PROJECT_ROOT_ID)?),
        Some(_) => None,
    };

    // A section is a leaf: it is a byte span inside its file, not a container.
    if let Some(parent_id) = requested.as_deref() {
        if parent_id.starts_with("section:") {
            return Ok(Members {
                analysis_id: analysis.into(),
                parent: Some(parent_id.into()),
                root: None,
                total: 0,
                items: Vec::new(),
                next_cursor: None,
                notes: vec!["这是文档章节，没有下级成员；正文用内容视图读取。".into()],
            });
        }
    }

    let parent_id = match (&root_node, requested.as_deref()) {
        (Some(node), None) => node.id.clone(),
        (None, Some(id)) => id.to_string(),
        _ => unreachable!(),
    };
    let parent_node = match &root_node {
        Some(node) => node.clone(),
        None => store.node(analysis, &parent_id)?,
    };

    let mut notes = Vec::new();
    let mut items: Vec<TreeNode> = Vec::new();

    if is_markdown(&parent_node.path) && parent_node.kind == "file" {
        let sections = markdown_sections(store, analysis, &parent_node.path)?;
        if sections.is_empty() {
            notes.push("这个文档没有可解析的标题章节；内容视图可以读全文。".into());
        }
        items = sections;
    } else {
        let catalog = catalog_of(store, analysis)?;
        let conn = store.connection()?;
        let mut statement = conn.prepare(
            "SELECT body FROM nodes WHERE analysis=?1 AND json_extract(body,'$.parent')=?2 \
             ORDER BY CASE kind WHEN 'directory' THEN 0 WHEN 'file' THEN 1 ELSE 2 END, path, id",
        )?;
        let rows =
            statement.query_map(params![analysis, parent_id], |row| row.get::<_, String>(0))?;
        for row in rows {
            let node: Node = serde_json::from_str(&row?)?;
            let (bytes, detail) = catalog
                .get(&node.path)
                .cloned()
                .unwrap_or((0, None));
            items.push(tree_node(&node, (node.kind != "function").then_some(bytes), detail));
        }
        if items.is_empty() && parent_node.kind == "file" {
            notes.push(match file_kind(&parent_node.path) {
                "code" => "这个代码文件没有解析出可定位的声明（当前语言链只提供函数级声明）。".into(),
                _ => "该文件类型没有函数级分析能力；内容视图可以读原文。".into(),
            });
        }
    }

    // Real direct-child counts for the page, in one query rather than one per
    // row: the map must not print "3 个直属成员" for a node that has thirty.
    let counts = child_counts(store, analysis, &items)?;
    for item in &mut items {
        if let Some(count) = counts.get(&item.id) {
            item.child_count = *count;
            item.has_children = *count > 0 || item.has_children;
        }
    }

    let total = items.len();
    if offset > total {
        return Err(invalid("cursor_outside_result"));
    }
    let items: Vec<TreeNode> = items.into_iter().skip(offset).take(limit).collect();
    let next = offset + items.len();

    Ok(Members {
        analysis_id: analysis.into(),
        parent: requested,
        root: root_node.as_ref().map(|node| {
            let mut tree = tree_node(node, None, None);
            tree.kind = "project".into();
            tree.child_count = total;
            tree.has_children = total > 0;
            tree
        }),
        total,
        items,
        next_cursor: (next < total).then(|| format!("{key}:{next}")),
        notes,
    })
}

fn child_counts(
    store: &Store,
    analysis: &str,
    items: &[TreeNode],
) -> Result<BTreeMap<String, usize>> {
    let ids: Vec<&str> = items
        .iter()
        .filter(|item| item.kind != "function" && item.file_kind.as_deref() != Some("markdown"))
        .map(|item| item.id.as_str())
        .collect();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let conn = store.connection()?;
    let placeholders = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 2))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT json_extract(body,'$.parent') AS p, count(*) FROM nodes \
         WHERE analysis=?1 AND p IN ({placeholders}) GROUP BY p"
    );
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    params_vec.push(Box::new(analysis.to_string()));
    for id in &ids {
        params_vec.push(Box::new(id.to_string()));
    }
    let refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(refs.as_slice(), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut counts = BTreeMap::new();
    for row in rows {
        let (parent, count) = row?;
        counts.insert(parent, count.max(0) as usize);
    }
    // Markdown files count their headings, which are derived rather than stored.
    for item in items {
        if item.file_kind.as_deref() == Some("markdown") {
            let sections = markdown_sections(store, analysis, &item.path)?;
            counts.insert(item.id.clone(), sections.len());
        }
    }
    Ok(counts)
}

/// Markdown headings as byte-spanned section nodes.
///
/// The span is the heading line through the byte before the next heading of any
/// level, so `/api/source` can serve a section through the same window it
/// already serves a function through. Headings inside fenced code blocks are
/// not headings.
pub fn markdown_sections(store: &Store, analysis: &str, path: &str) -> Result<Vec<TreeNode>> {
    let meta = store.metadata(analysis)?;
    let snapshot = store.snapshot(meta["snapshot_id"].as_str().unwrap_or(""))?;
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.path == path)
        .ok_or_else(|| invalid("source_not_found"))?;
    let hash = entry
        .blob
        .as_ref()
        .ok_or_else(|| invalid("source_not_captured"))?;
    let bytes = store.read_blob(hash)?;
    let Ok(source) = String::from_utf8(bytes) else {
        return Ok(Vec::new());
    };
    let headings = scan_headings(&source);
    let file_id = format!("file:{path}");
    let mut out = Vec::new();
    for (i, (start, line_end, level, title)) in headings.iter().enumerate() {
        let end = headings
            .get(i + 1)
            .map(|(next, _, _, _)| *next)
            .unwrap_or(source.len());
        out.push(TreeNode {
            id: format!("section:{path}:{start}:{end}"),
            path: path.into(),
            name: title.clone(),
            kind: "section".into(),
            parent: Some(file_id.clone()),
            start: *start,
            end,
            function_count: 0,
            bytes: Some((end - start) as u64),
            disposition: format!("markdown_heading_h{level}"),
            detail: Some(format!("标题行结束于字节 {line_end}")),
            file_kind: None,
            child_count: 0,
            has_children: false,
            unsupported_semantics: true,
            note: Some(format!("H{level} 章节")),
        });
    }
    Ok(out)
}

/// `(start, end of heading line, level, text)` for each ATX heading outside code fences.
fn scan_headings(source: &str) -> Vec<(usize, usize, u8, String)> {
    let mut out = Vec::new();
    let mut fenced = false;
    let mut offset = 0usize;
    for line in source.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            offset += line.len();
            continue;
        }
        if !fenced {
            let hashes = trimmed.chars().take_while(|c| *c == '#').count();
            if (1..=6).contains(&hashes) {
                let rest = &trimmed[hashes..];
                if rest.starts_with(' ') || rest.starts_with('\t') || rest.is_empty() {
                    let title = rest.trim().trim_end_matches('#').trim().to_string();
                    let start = offset + (line.len() - trimmed.len());
                    let end = offset + line.len();
                    out.push((start, end, hashes as u8, title));
                }
            }
        }
        offset += line.len();
    }
    out
}

/// Call/candidate edges leaving or entering one object.
///
/// `reachable` walks transitively and only over call candidates; the node
/// inspector needs the immediate hops and the unresolved ones as separate facts,
/// so this is the one-hop query it reads instead.
pub fn edges_touching(
    store: &Store,
    analysis: &str,
    entity: &str,
    direction: &str,
    kind: &str,
    limit: usize,
) -> Result<Vec<Edge>> {
    if !["in", "out"].contains(&direction) || limit == 0 || limit > 500 {
        return Err(invalid("invalid_edge_query"));
    }
    let column = if direction == "out" { "source" } else { "target" };
    let sql = format!(
        "SELECT body FROM edges WHERE analysis=?1 AND {column}=?2 AND (?3='all' OR kind=?3) ORDER BY id LIMIT ?4"
    );
    let conn = store.connection()?;
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![analysis, entity, kind, limit as i64], |row| {
        row.get::<_, String>(0)
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(serde_json::from_str(&row?)?);
    }
    Ok(out)
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

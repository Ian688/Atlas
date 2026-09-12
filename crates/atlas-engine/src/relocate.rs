//! Relocating a selection across analysis versions.
//!
//! A selection is pinned to the analysis it was made in. Opening it against a
//! different version has exactly two honest outcomes: a *reported* relocation to
//! a counterpart, or a refusal. What is never allowed is silently pointing the
//! old name at whatever now sits there -- that is how a conclusion reached about
//! one function ends up displayed under another.
//!
//! The match is deliberately conservative and its basis is always published:
//!
//! * `same_version` -- nothing to relocate.
//! * `path_and_name` -- the same kind, path and name. The span may have moved
//!   and the bytes may have changed; both are reported.
//! * `identical_bytes` -- a unique counterpart with byte-identical source
//!   elsewhere, which is what a move or a rename looks like.
//! * `name_only` -- a unique same-kind, same-name counterpart at a different
//!   path; reported as such, because a name alone is weak evidence.
//!
//! Zero confident candidates is a refusal with the candidates it did find, and
//! more than one is an ambiguity rather than a coin toss.
use crate::{Result, digest, store::Store};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const SCHEMA: &str = "atlas.selection-relocation.v1";

pub const WHY_SAME_VERSION: &str = "same_version";
pub const WHY_PATH_AND_NAME: &str = "path_and_name";
pub const WHY_IDENTICAL_BYTES: &str = "identical_bytes";
pub const WHY_NAME_ONLY: &str = "name_only";

pub const REFUSAL_NO_COUNTERPART: &str = "no_counterpart";
pub const REFUSAL_AMBIGUOUS: &str = "ambiguous_counterparts";
pub const REFUSAL_WITHDRAWN: &str = "entity_withdrawn";
pub const REFUSAL_UNKNOWN_ENTITY: &str = "entity_not_in_source_analysis";

#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub entity_id: String,
    pub kind: String,
    pub path: String,
    pub name: String,
    pub identical_bytes: bool,
    pub same_path: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Relocation {
    pub schema: String,
    pub from_analysis: String,
    pub to_analysis: String,
    pub entity_id: String,
    pub relocated: bool,
    pub matched_entity_id: Option<String>,
    pub matched_by: Option<String>,
    pub bytes_changed: Option<bool>,
    pub refusal: Option<String>,
    pub candidates: Vec<Candidate>,
    pub note: String,
}

/// `(kind, path, name, bytes)` for one entity, read straight from its immutable
/// snapshot: `kind`, `path`, `name` and the exact source bytes of its span.
type EntityBytes = (String, String, String, Vec<u8>);

/// The exact bytes of one entity, straight from the immutable snapshot.
fn entity_bytes(store: &Store, analysis: &str, entity: &str) -> Result<Option<EntityBytes>> {
    let node = match store.node(analysis, entity) {
        Ok(node) => node,
        Err(_) => return Ok(None),
    };
    let metadata = store.metadata(analysis)?;
    let snapshot = store.snapshot(
        metadata["snapshot_id"]
            .as_str()
            .ok_or_else(|| crate::invalid("analysis_has_no_snapshot"))?,
    )?;
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.path == node.path);
    let Some(blob) = entry.and_then(|entry| entry.blob.clone()) else {
        return Ok(None);
    };
    let bytes = store.read_blob(&blob)?;
    let end = if node.kind == "function" {
        node.end
    } else {
        bytes.len()
    }
    .min(bytes.len());
    let start = node.start.min(end);
    Ok(Some((
        node.kind.clone(),
        node.path.clone(),
        node.name.clone(),
        bytes[start..end].to_vec(),
    )))
}

/// One entity's identity for candidate matching.
struct Identity {
    kind: String,
    path: String,
    name: String,
    bytes: Vec<u8>,
}

fn identity(store: &Store, analysis: &str, entity: &str) -> Result<Option<Identity>> {
    Ok(
        entity_bytes(store, analysis, entity)?.map(|(kind, path, name, bytes)| Identity {
            kind,
            path,
            name,
            bytes,
        }),
    )
}

/// Every node in an analysis, keyed by nothing in particular: the caller filters.
fn all_nodes(store: &Store, analysis: &str) -> Result<Vec<(String, String, String, String)>> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..40 {
        let page = store.nodes(analysis, "all", 500, cursor.as_deref())?;
        for node in &page.items {
            out.push((
                node.id.clone(),
                node.kind.clone(),
                node.path.clone(),
                node.name.clone(),
            ));
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    Ok(out)
}

/// Find the counterpart of `entity` (pinned to `from_analysis`) in `to_analysis`.
pub fn relocate(
    store: &Store,
    from_analysis: &str,
    entity: &str,
    to_analysis: &str,
) -> Result<Relocation> {
    let base = Relocation {
        schema: SCHEMA.into(),
        from_analysis: from_analysis.into(),
        to_analysis: to_analysis.into(),
        entity_id: entity.into(),
        relocated: false,
        matched_entity_id: None,
        matched_by: None,
        bytes_changed: None,
        refusal: None,
        candidates: Vec::new(),
        note: String::new(),
    };
    if from_analysis == to_analysis {
        return Ok(Relocation {
            relocated: true,
            matched_entity_id: Some(entity.to_string()),
            matched_by: Some(WHY_SAME_VERSION.into()),
            bytes_changed: Some(false),
            note: "同一版本：选区无需重定位。".into(),
            ..base
        });
    }
    let Some(source) = identity(store, from_analysis, entity)? else {
        return Ok(Relocation {
            refusal: Some(REFUSAL_UNKNOWN_ENTITY.into()),
            note: "选区指向的对象不在它自己的分析版本里；这通常意味着存储被外部改动过。".into(),
            ..base
        });
    };

    // Candidates: same kind, and either the same path or the same name. Grouped
    // by the strongest reason it could be the same entity.
    let mut by_path_and_name: Vec<String> = Vec::new();
    let mut by_name: Vec<String> = Vec::new();
    let mut by_bytes: Vec<String> = Vec::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut digests: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for (id, kind, path, name) in all_nodes(store, to_analysis)? {
        if kind != source.kind {
            continue;
        }
        let same_path = path == source.path;
        let same_name = name == source.name;
        if !same_path && !same_name {
            continue;
        }
        let bytes = match identity(store, to_analysis, &id)? {
            Some(identity) => identity.bytes,
            None => Vec::new(),
        };
        let identical = bytes == source.bytes;
        if identical {
            by_bytes.push(id.clone());
        }
        if same_path && same_name {
            by_path_and_name.push(id.clone());
        } else if same_name {
            by_name.push(id.clone());
        }
        candidates.push(Candidate {
            entity_id: id.clone(),
            kind,
            path,
            name,
            identical_bytes: identical,
            same_path,
        });
        digests.insert(id, bytes);
    }

    let decide = |id: &str, why: &str| -> Relocation {
        let changed = digests.get(id).map(|bytes| *bytes != source.bytes);
        Relocation {
            relocated: true,
            matched_entity_id: Some(id.to_string()),
            matched_by: Some(why.into()),
            bytes_changed: changed,
            refusal: None,
            candidates: candidates.clone(),
            note: match (why, changed) {
                (WHY_PATH_AND_NAME, Some(true)) => {
                    "路径与名字都对上，但源码字节变了：这是同一个对象的**改动后**版本。".into()
                }
                (WHY_PATH_AND_NAME, _) => "路径与名字都对上，源码字节相同。".into(),
                (WHY_IDENTICAL_BYTES, _) => {
                    "字节完全相同但位置不同：这看起来是一次移动或重命名，请确认。".into()
                }
                (WHY_NAME_ONLY, _) => {
                    "只有名字相同、路径不同：证据较弱，重定位依据仅此一条，请确认。".into()
                }
                _ => String::new(),
            },
            ..base.clone()
        }
    };

    if by_path_and_name.len() == 1 {
        return Ok(decide(&by_path_and_name[0], WHY_PATH_AND_NAME));
    }
    if by_path_and_name.len() > 1 {
        return Ok(Relocation {
            refusal: Some(REFUSAL_AMBIGUOUS.into()),
            note: format!(
                "目标版本里有 {} 个对象的路径与名字都相同；不猜。",
                by_path_and_name.len()
            ),
            candidates,
            ..base
        });
    }
    if by_bytes.len() == 1 {
        return Ok(decide(&by_bytes[0], WHY_IDENTICAL_BYTES));
    }
    if by_bytes.len() > 1 {
        return Ok(Relocation {
            refusal: Some(REFUSAL_AMBIGUOUS.into()),
            note: format!(
                "目标版本里有 {} 个对象源码字节完全相同；无法判断是哪一个。",
                by_bytes.len()
            ),
            candidates,
            ..base
        });
    }
    if by_name.len() == 1 {
        return Ok(decide(&by_name[0], WHY_NAME_ONLY));
    }
    if by_name.len() > 1 {
        return Ok(Relocation {
            refusal: Some(REFUSAL_AMBIGUOUS.into()),
            note: format!(
                "目标版本里有 {} 个同名对象，无法确定是哪一个。",
                by_name.len()
            ),
            candidates,
            ..base
        });
    }
    // No name match and no byte match. Same-path neighbours are *not* matches:
    // they are simply the other functions in that file, and presenting them as
    // candidates would invite picking one arbitrarily.
    //
    // A missing *file* and a missing entity inside a live file are different
    // facts, and they are named differently: the first is a withdrawal (the same
    // word the incremental report uses), the second is "this file is still here,
    // this entity is not".
    let path_alive = all_nodes(store, to_analysis)?
        .iter()
        .any(|(_, _, path, _)| *path == source.path);
    Ok(Relocation {
        refusal: Some(if path_alive {
            REFUSAL_NO_COUNTERPART.into()
        } else {
            REFUSAL_WITHDRAWN.into()
        }),
        note: if path_alive {
            format!(
                "没有同名或字节相同的对应物；同一路径下的 {} 个对象只是邻居，不是匹配。选区保持原样，不重指。",
                candidates.len()
            )
        } else {
            "目标版本里这个文件已经不存在（撤回）。选区保持原样，不重指。".into()
        },
        candidates,
        ..base
    })
}

/// A bounded projection for consumers that only need to show what happened.
pub fn summary(relocation: &Relocation) -> Value {
    json!({
        "schema": relocation.schema,
        "from_analysis": relocation.from_analysis,
        "to_analysis": relocation.to_analysis,
        "entity_id": relocation.entity_id,
        "relocated": relocation.relocated,
        "matched_entity_id": relocation.matched_entity_id,
        "matched_by": relocation.matched_by,
        "bytes_changed": relocation.bytes_changed,
        "refusal": relocation.refusal,
        "candidate_count": relocation.candidates.len(),
    })
}

/// Digest of an entity's pinned bytes, for callers that want to compare without
/// reading the whole record.
pub fn entity_digest(store: &Store, analysis: &str, entity: &str) -> Result<Option<String>> {
    Ok(entity_bytes(store, analysis, entity)?.map(|(_, _, _, bytes)| digest(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_contract::{Analysis, Node, SNAPSHOT_SCHEMA, ScanLimits, Snapshot};

    /// Build a store with two analyses over different bytes of the same tree,
    /// which is what a re-index after an edit looks like.
    fn two_versions(
        before: &[(&str, &str, &str)],
        after: &[(&str, &str, &str)],
    ) -> (Store, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        std::mem::forget(dir);
        let build = |files: &[(&str, &str, &str)]| {
            let mut by_path: BTreeMap<&str, String> = BTreeMap::new();
            for (path, _name, text) in files {
                let entry = by_path.entry(path).or_default();
                entry.push_str(text);
                entry.push('\n');
            }
            let mut entries = Vec::new();
            for (path, text) in by_path {
                let blob = store.put_blob(text.as_bytes()).unwrap();
                entries.push(atlas_contract::CatalogEntry {
                    path: path.to_string(),
                    kind: "file".into(),
                    disposition: "captured".into(),
                    bytes: text.len() as u64,
                    blob: Some(blob),
                    detail: None,
                });
            }
            let mut snapshot = Snapshot {
                schema: SNAPSHOT_SCHEMA.into(),
                id: String::new(),
                scan_profile: "test".into(),
                limits: ScanLimits::default(),
                entries,
            };
            snapshot.id = digest(&serde_json::to_vec(&snapshot).unwrap());
            store.publish_snapshot(&snapshot).unwrap();
            snapshot
        };
        // One node per name we care about, with a real span inside the file.
        // The offset matters: an entity's bytes are read from its span, so a
        // fixture that gave every function start 0 would compare the first line
        // of the file for all of them.
        let nodes_for = |files: &[(&str, &str, &str)]| -> Vec<Node> {
            let mut offsets: BTreeMap<&str, usize> = BTreeMap::new();
            let mut nodes = Vec::new();
            for (path, name, text) in files {
                let start = *offsets.get(path).unwrap_or(&0);
                nodes.push(Node {
                    id: format!("symbol:{path}:{start}:{}", start + text.len()),
                    path: (*path).into(),
                    name: (*name).into(),
                    kind: "function".into(),
                    parent: Some(format!("file:{path}")),
                    start,
                    end: start + text.len(),
                    function_count: 0,
                    disposition: "syntax_extracted".into(),
                });
                offsets.insert(path, start + text.len() + 1);
            }
            nodes
        };
        let analyse = |snapshot: &Snapshot, nodes: Vec<Node>| {
            let mut analysis = Analysis {
                schema: atlas_contract::ANALYSIS_SCHEMA.into(),
                id: String::new(),
                snapshot_id: snapshot.id.clone(),
                engine: "test".into(),
                producer: "test".into(),
                coverage: Default::default(),
                nodes,
                edges: vec![],
                diagnostics: vec![],
                recursive_components: vec![],
                limitations: vec![],
                flow_digest: digest(b"flow"),
            };
            analysis.id = digest(&serde_json::to_vec(&analysis).unwrap());
            store.publish_analysis(&analysis).unwrap();
            analysis.id
        };
        let before_snapshot = build(before);
        let after_snapshot = build(after);
        let before_nodes = nodes_for(before);
        let after_nodes = nodes_for(after);
        let a = analyse(&before_snapshot, before_nodes);
        let b = analyse(&after_snapshot, after_nodes);
        (store, a, b)
    }

    #[test]
    fn the_same_version_needs_no_relocation() {
        let (store, a, _) = two_versions(
            &[("add.js", "add", "export function add(x){return x+1;}")],
            &[("add.js", "add", "export function add(x){return x+2;}")],
        );
        let entity = store.nodes(&a, "function", 10, None).unwrap().items[0]
            .id
            .clone();
        let relocation = relocate(&store, &a, &entity, &a).unwrap();
        assert!(relocation.relocated);
        assert_eq!(relocation.matched_by.as_deref(), Some(WHY_SAME_VERSION));
    }

    #[test]
    fn a_changed_body_is_relocated_by_path_and_name_and_says_the_bytes_changed() {
        let (store, a, b) = two_versions(
            &[("add.js", "add", "export function add(x){return x+1;}")],
            &[("add.js", "add", "export function add(x){return x+42;}")],
        );
        let entity = store.nodes(&a, "function", 10, None).unwrap().items[0]
            .id
            .clone();
        let relocation = relocate(&store, &a, &entity, &b).unwrap();
        assert!(relocation.relocated);
        assert_eq!(relocation.matched_by.as_deref(), Some(WHY_PATH_AND_NAME));
        assert_eq!(
            relocation.bytes_changed,
            Some(true),
            "an edit must be reported as a byte change"
        );
        assert!(relocation.matched_entity_id.is_some());
    }

    #[test]
    fn identical_bytes_at_another_path_are_reported_as_a_move() {
        let body = "export function add(x){return x+1;}";
        let (store, a, b) = two_versions(
            &[("src/one.js", "add", body)],
            &[("lib/two.js", "add", body)],
        );
        let entity = store.nodes(&a, "function", 10, None).unwrap().items[0]
            .id
            .clone();
        let relocation = relocate(&store, &a, &entity, &b).unwrap();
        // Same name, different path, identical bytes: `path_and_name` cannot
        // match, so the byte comparison is what carries it.
        assert!(relocation.relocated);
        assert_eq!(relocation.matched_by.as_deref(), Some(WHY_IDENTICAL_BYTES));
        assert_eq!(relocation.bytes_changed, Some(false));
    }

    #[test]
    fn a_withdrawn_entity_is_refused_rather_than_re_pointed() {
        let (store, a, b) = two_versions(
            &[
                ("add.js", "add", "export function add(x){return x+1;}"),
                ("gone.js", "gone", "export function gone(x){return x;}"),
            ],
            &[("add.js", "add", "export function add(x){return x+1;}")],
        );
        let nodes = store.nodes(&a, "function", 10, None).unwrap().items;
        let gone = nodes
            .iter()
            .find(|node| node.path == "gone.js")
            .unwrap()
            .id
            .clone();
        let relocation = relocate(&store, &a, &gone, &b).unwrap();
        assert!(
            !relocation.relocated,
            "a deleted entity must not be relocated onto something else"
        );
        assert_eq!(relocation.refusal.as_deref(), Some(REFUSAL_WITHDRAWN));
    }

    #[test]
    fn same_path_neighbours_are_not_offered_as_matches() {
        // `drop` is renamed to `moved`; the name is part of the bytes, so this
        // is neither a same-name nor a same-bytes match. The other functions in
        // the file are neighbours, not candidates.
        let (store, a, b) = two_versions(
            &[
                ("lib.js", "add", "export function add(a){return a+1;}"),
                ("lib.js", "drop", "export function drop(a){return a-1;}"),
            ],
            &[
                ("lib.js", "add", "export function add(a){return a+1;}"),
                ("lib.js", "moved", "export function moved(a){return a-1;}"),
            ],
        );
        let nodes = store.nodes(&a, "function", 10, None).unwrap().items;
        let drop = nodes
            .iter()
            .find(|node| node.name == "drop")
            .unwrap()
            .id
            .clone();
        let relocation = relocate(&store, &a, &drop, &b).unwrap();
        assert!(!relocation.relocated);
        assert_eq!(relocation.refusal.as_deref(), Some(REFUSAL_NO_COUNTERPART));
        assert!(
            !relocation.candidates.is_empty(),
            "the neighbours are still reported as context"
        );
        assert!(relocation.note.contains("邻居"), "{}", relocation.note);
    }

    #[test]
    fn an_unknown_entity_is_named_as_such() {
        let (store, a, b) = two_versions(
            &[("add.js", "add", "export function add(x){return x;}")],
            &[("add.js", "add", "export function add(x){return x + 0;}")],
        );
        let relocation = relocate(&store, &a, "symbol:not-here:0:1", &b).unwrap();
        assert_eq!(relocation.refusal.as_deref(), Some(REFUSAL_UNKNOWN_ENTITY));
    }
}

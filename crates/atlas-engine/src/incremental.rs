//! Incremental reuse of published analyses (W07).
//!
//! Two keys, and the difference between them is the whole design:
//!
//! * The **run key** answers "is this the analysis I already have?". It folds
//!   the version bundle together with the snapshot id, and the snapshot id is
//!   itself a digest over the schema, the scan profile, the limits and every
//!   catalog entry with its blob hash. Two runs sharing a run key saw the same
//!   bytes and the same versions, so they must have derived the same facts.
//! * The **file keys** answer a different question: "what would a partial
//!   change actually cost?". A file's key folds its own content, the version
//!   bundle, and a digest over the transitive closure of what it imports,
//!   computed on the SCC condensation of the import graph so that files which
//!   import each other invalidate as one unit rather than as a cycle that
//!   cannot be ordered. Invalidation needs no separate pass: a file's key
//!   changes exactly when it or anything it depends on changes.
//!
//! What this module deliberately does **not** claim: that a partial change is
//! cheap. Deriving flow facts is a whole-program fixpoint
//! (`inter::analyze_interprocedural_controlled`), so one edited file still
//! forces every function to be re-derived. The file keys exist so that this
//! cost is measured and reported rather than assumed, and so the next step --
//! an incremental fixpoint with summary stability -- has something to stand on.

use crate::Result;
use crate::digest;
use crate::store::Store;
use atlas_contract::{LanguageFacts, SourceFile};
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// Everything that can change the meaning of a derivation while the input bytes
/// stay identical.
pub fn bundle(producer: &str) -> String {
    format!(
        "{producer}|{}|{}|{}|{}|{}|{}",
        atlas_contract::ENGINE_VERSION,
        atlas_contract::FACTS_SCHEMA,
        atlas_contract::ANALYSIS_SCHEMA,
        atlas_contract::flow::FLOW_SCHEMA,
        atlas_contract::flow::FLOW_PROFILE,
        crate::solve::ALGORITHM_VERSION,
    )
}

/// Identity of one derivation input. The snapshot id already covers the whole
/// catalog, so this only has to add the versions.
pub fn run_key(bundle: &str, snapshot_id: &str) -> String {
    digest(format!("atlas.run-key.v1\u{0}{bundle}\u{0}{snapshot_id}").as_bytes())
}

pub fn source_hashes(files: &[SourceFile]) -> BTreeMap<String, String> {
    files
        .iter()
        .map(|file| (file.path.clone(), digest(file.content.as_bytes())))
        .collect()
}

/// File-level import graph, restricted to files that were actually parsed.
/// An import that resolves outside the parsed set cannot make one parsed file
/// depend on another, so it is not an edge.
pub fn import_graph(
    facts: &LanguageFacts,
    parsed: &BTreeSet<String>,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut graph: BTreeMap<String, BTreeSet<String>> = parsed
        .iter()
        .map(|path| (path.clone(), BTreeSet::new()))
        .collect();
    for import in &facts.imports {
        let Some(target) = import.target_path.as_ref() else {
            continue;
        };
        if target == &import.path || !parsed.contains(&import.path) || !parsed.contains(target) {
            continue;
        }
        if let Some(edges) = graph.get_mut(&import.path) {
            edges.insert(target.clone());
        }
    }
    graph
}

fn children(graph: &BTreeMap<String, BTreeSet<String>>, node: &str) -> Vec<String> {
    graph
        .get(node)
        .map(|set| set.iter().cloned().collect())
        .unwrap_or_default()
}

/// Iterative Kosaraju. Recursion would overflow on a deep import chain, and a
/// deep chain is exactly what a real project has.
pub fn components(graph: &BTreeMap<String, BTreeSet<String>>) -> Vec<Vec<String>> {
    struct Frame {
        node: String,
        children: Vec<String>,
        next: usize,
    }
    let mut visited: BTreeSet<String> = BTreeSet::new();
    let mut finish: Vec<String> = Vec::with_capacity(graph.len());
    for start in graph.keys() {
        if visited.contains(start) {
            continue;
        }
        visited.insert(start.clone());
        let mut stack = vec![Frame {
            node: start.clone(),
            children: children(graph, start),
            next: 0,
        }];
        while let Some(frame) = stack.last_mut() {
            if frame.next < frame.children.len() {
                let child = frame.children[frame.next].clone();
                frame.next += 1;
                if visited.insert(child.clone()) {
                    stack.push(Frame {
                        node: child.clone(),
                        children: children(graph, &child),
                        next: 0,
                    });
                }
            } else {
                finish.push(frame.node.clone());
                stack.pop();
            }
        }
    }

    let mut reverse: BTreeMap<String, BTreeSet<String>> = graph
        .keys()
        .map(|path| (path.clone(), BTreeSet::new()))
        .collect();
    for (from, targets) in graph {
        for target in targets {
            if let Some(edges) = reverse.get_mut(target) {
                edges.insert(from.clone());
            }
        }
    }

    let mut assigned: BTreeSet<String> = BTreeSet::new();
    let mut found: Vec<Vec<String>> = Vec::new();
    for node in finish.into_iter().rev() {
        if !assigned.insert(node.clone()) {
            continue;
        }
        let mut component = vec![node.clone()];
        let mut stack = vec![node];
        while let Some(current) = stack.pop() {
            for next in reverse.get(&current).into_iter().flatten() {
                if assigned.insert(next.clone()) {
                    component.push(next.clone());
                    stack.push(next.clone());
                }
            }
        }
        component.sort();
        found.push(component);
    }
    // Canonical order, so the digest cannot depend on traversal luck.
    found.sort();
    found
}

/// Merkle digest of each file's transitive dependency closure, folded on the
/// condensation so a cycle is one unit instead of an unwinnable ordering.
pub fn closure_digests(
    graph: &BTreeMap<String, BTreeSet<String>>,
    components: &[Vec<String>],
    content_hashes: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut index_of: BTreeMap<&str, usize> = BTreeMap::new();
    for (index, component) in components.iter().enumerate() {
        for member in component {
            index_of.insert(member.as_str(), index);
        }
    }
    let mut successors: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); components.len()];
    for (from, targets) in graph {
        let Some(&from_index) = index_of.get(from.as_str()) else {
            continue;
        };
        for target in targets {
            let Some(&to_index) = index_of.get(target.as_str()) else {
                continue;
            };
            if from_index != to_index {
                successors[from_index].insert(to_index);
            }
        }
    }

    // Kahn over the condensation. A component's digest needs its successors'
    // digests, so they have to be computed first.
    let mut indegree = vec![0usize; components.len()];
    for targets in &successors {
        for target in targets {
            indegree[*target] += 1;
        }
    }
    let mut queue: VecDeque<usize> = (0..components.len())
        .filter(|index| indegree[*index] == 0)
        .collect();
    let mut order = Vec::with_capacity(components.len());
    while let Some(index) = queue.pop_front() {
        order.push(index);
        for target in successors[index].clone() {
            indegree[target] -= 1;
            if indegree[target] == 0 {
                queue.push_back(target);
            }
        }
    }

    let mut digests = vec![String::new(); components.len()];
    for index in order.into_iter().rev() {
        let mut material = String::new();
        for member in &components[index] {
            material.push_str(member);
            material.push('\u{0}');
            material.push_str(content_hashes.get(member).map(String::as_str).unwrap_or(""));
            material.push('\u{0}');
        }
        let mut inherited: Vec<String> = successors[index]
            .iter()
            .map(|target| digests[*target].clone())
            .collect();
        inherited.sort();
        for digest_of_child in inherited {
            material.push_str(&digest_of_child);
            material.push('\u{0}');
        }
        digests[index] = digest(material.as_bytes());
    }

    graph
        .keys()
        .filter_map(|path| {
            index_of
                .get(path.as_str())
                .map(|index| (path.clone(), digests[*index].clone()))
        })
        .collect()
}

pub fn file_keys(
    graph: &BTreeMap<String, BTreeSet<String>>,
    components: &[Vec<String>],
    content_hashes: &BTreeMap<String, String>,
    bundle: &str,
) -> BTreeMap<String, String> {
    let closures = closure_digests(graph, components, content_hashes);
    graph
        .keys()
        .map(|path| {
            let key = digest(
                format!(
                    "atlas.file-key.v1\u{0}{bundle}\u{0}{path}\u{0}{}\u{0}{}",
                    content_hashes.get(path).map(String::as_str).unwrap_or(""),
                    closures.get(path).map(String::as_str).unwrap_or(""),
                )
                .as_bytes(),
            );
            (path.clone(), key)
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    /// Not present in the previous run.
    New,
    /// Its own bytes differ.
    OwnContent,
    /// Its bytes are identical, but something it depends on changed.
    Dependency,
}

/// Why a file's key moved. This is the invalidation answer the ledger asks for,
/// and it is derived from the keys themselves rather than from a second pass
/// that could disagree with them.
#[derive(Clone, Debug, Serialize)]
pub struct Verdict {
    pub path: String,
    pub change: Change,
    /// Direct dependencies whose own key moved, for a `Dependency` change.
    pub via: Vec<String>,
}

pub fn verdicts(
    previous: &BTreeMap<String, String>,
    current: &BTreeMap<String, String>,
    previous_content: &BTreeMap<String, String>,
    current_content: &BTreeMap<String, String>,
    graph: &BTreeMap<String, BTreeSet<String>>,
) -> Vec<Verdict> {
    let mut out = Vec::new();
    for (path, key) in current {
        match previous.get(path) {
            None => out.push(Verdict {
                path: path.clone(),
                change: Change::New,
                via: Vec::new(),
            }),
            Some(old) if old == key => {}
            Some(_) => {
                let own_content_changed = previous_content.get(path) != current_content.get(path);
                let via: Vec<String> = graph
                    .get(path)
                    .into_iter()
                    .flatten()
                    .filter(|dependency| previous.get(*dependency) != current.get(*dependency))
                    .cloned()
                    .collect();
                out.push(Verdict {
                    path: path.clone(),
                    change: if own_content_changed {
                        Change::OwnContent
                    } else {
                        Change::Dependency
                    },
                    via,
                });
            }
        }
    }
    out
}

/// Files the previous run analysed that this one no longer contains. Their
/// facts must not survive into the new analysis, which is why the analysis is
/// always assembled from the current file set and never merged into.
pub fn withdrawn(previous: &BTreeSet<String>, current: &BTreeSet<String>) -> Vec<String> {
    previous.difference(current).cloned().collect()
}

/// One recorded derivation: what was run, and what each file's key was.
///
/// The per-file keys are stored so the *next* run can report what a partial
/// change would cost. They are a measurement, not a cache of derived facts:
/// nothing here lets a single file's flow facts be reused, because deriving
/// them is a whole-program fixpoint.
#[derive(Clone, Debug, Serialize)]
pub struct IncrementalRun {
    pub run_key: String,
    pub bundle: String,
    pub snapshot_id: String,
    pub analysis_id: String,
    pub file_keys: BTreeMap<String, String>,
    pub file_hashes: BTreeMap<String, String>,
    pub source_files: BTreeSet<String>,
    pub created_at: i64,
}

impl Store {
    pub fn record_incremental_run(&self, run: &IncrementalRun) -> Result<()> {
        let conn = self.connection()?;
        // Routed through the same writer discipline as publication and the job
        // store: this is another place two processes are expected to collide.
        let tx = crate::store::publication_transaction(
            &conn,
            &crate::control::ExecutionControl::new(None),
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO incremental_runs(
                 run_key,bundle,snapshot_id,analysis_id,file_keys,file_hashes,source_files,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                run.run_key,
                run.bundle,
                run.snapshot_id,
                run.analysis_id,
                serde_json::to_string(&run.file_keys)?,
                serde_json::to_string(&run.file_hashes)?,
                serde_json::to_string(&run.source_files)?,
                run.created_at,
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The run key already folds in the version bundle, so a hit means the same
    /// bytes were derived by the same versions.
    pub fn incremental_run(&self, run_key: &str) -> Result<Option<IncrementalRun>> {
        let row = self
            .connection()?
            .query_row(
                "SELECT run_key,bundle,snapshot_id,analysis_id,file_keys,file_hashes,source_files,created_at
                 FROM incremental_runs WHERE run_key=?1",
                [run_key],
                decode_run,
            )
            .optional()?;
        Ok(row)
    }

    /// The most recent recorded run, whichever it was, used only to explain
    /// what changed since.
    pub fn latest_incremental_run(&self) -> Result<Option<IncrementalRun>> {
        let row = self
            .connection()?
            .query_row(
                "SELECT run_key,bundle,snapshot_id,analysis_id,file_keys,file_hashes,source_files,created_at
                 FROM incremental_runs ORDER BY created_at DESC, run_key LIMIT 1",
                [],
                decode_run,
            )
            .optional()?;
        Ok(row)
    }
}

fn decode_run(row: &rusqlite::Row) -> rusqlite::Result<IncrementalRun> {
    Ok(IncrementalRun {
        run_key: row.get("run_key")?,
        bundle: row.get("bundle")?,
        snapshot_id: row.get("snapshot_id")?,
        analysis_id: row.get("analysis_id")?,
        file_keys: decode_json(row.get("file_keys")?)?,
        file_hashes: decode_json(row.get("file_hashes")?)?,
        source_files: decode_json(row.get("source_files")?)?,
        created_at: row.get("created_at")?,
    })
}

/// Generic so each column infers its own target type; a shared closure would
/// be pinned to whichever type was inferred first.
fn decode_json<T: serde::de::DeserializeOwned>(text: String) -> rusqlite::Result<T> {
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_contract::{Import, LanguageFacts};

    fn graph_of(pairs: &[(&str, &[&str])]) -> BTreeMap<String, BTreeSet<String>> {
        pairs
            .iter()
            .map(|(node, targets)| {
                (
                    (*node).to_string(),
                    targets.iter().map(|t| (*t).to_string()).collect(),
                )
            })
            .collect()
    }

    fn hashes(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(path, hash)| ((*path).to_string(), (*hash).to_string()))
            .collect()
    }

    fn facts_with_imports(pairs: &[(&str, &str, Option<&str>)]) -> LanguageFacts {
        LanguageFacts {
            schema: atlas_contract::FACTS_SCHEMA.into(),
            snapshot_id: "s".into(),
            producer: "p".into(),
            parsed_files: Vec::new(),
            symbols: Vec::new(),
            calls: Vec::new(),
            imports: pairs
                .iter()
                .enumerate()
                .map(|(index, (path, specifier, target))| Import {
                    id: format!("import:{index}"),
                    path: (*path).to_string(),
                    specifier: (*specifier).to_string(),
                    target_path: target.map(str::to_string),
                    type_only: false,
                })
                .collect(),
            diagnostics: Vec::new(),
            dynamic_files: Vec::new(),
            flow: None,
        }
    }

    #[test]
    fn the_run_key_follows_both_the_bytes_and_the_versions() {
        let versions = bundle("typescript/5.9.3;worker/0.2.0");
        let key = run_key(&versions, "snapshot-a");
        assert_eq!(
            key,
            run_key(&versions, "snapshot-a"),
            "must be deterministic"
        );
        assert_ne!(
            key,
            run_key(&versions, "snapshot-b"),
            "different bytes must differ"
        );
        assert_ne!(
            key,
            run_key(&bundle("typescript/5.9.4;worker/0.2.0"), "snapshot-a"),
            "a producer upgrade must invalidate even when the bytes are untouched"
        );
        // Every version component must actually participate.
        let base = bundle("producer");
        for marker in [
            atlas_contract::ENGINE_VERSION,
            atlas_contract::FACTS_SCHEMA,
            atlas_contract::ANALYSIS_SCHEMA,
            atlas_contract::flow::FLOW_SCHEMA,
            atlas_contract::flow::FLOW_PROFILE,
            crate::solve::ALGORITHM_VERSION,
        ] {
            assert!(base.contains(marker), "the bundle must pin {marker}");
        }
    }

    #[test]
    fn the_file_graph_only_keeps_edges_between_parsed_files() {
        let facts = facts_with_imports(&[
            ("a.js", "./b.js", Some("b.js")),
            ("a.js", "./missing.js", None),
            ("a.js", "./outside.js", Some("outside.js")),
            ("a.js", "a.js", Some("a.js")),
            ("b.js", "./a.js", Some("a.js")),
        ]);
        let parsed: BTreeSet<String> = ["a.js", "b.js"].iter().map(|s| s.to_string()).collect();
        let graph = import_graph(&facts, &parsed);
        assert_eq!(
            graph["a.js"].iter().cloned().collect::<Vec<_>>(),
            vec!["b.js"]
        );
        assert_eq!(
            graph["b.js"].iter().cloned().collect::<Vec<_>>(),
            vec!["a.js"]
        );
        assert_eq!(graph.len(), 2, "a file that was never parsed is not a node");
    }

    #[test]
    fn files_that_import_each_other_form_one_unit() {
        let graph = graph_of(&[("a.js", &["b.js"]), ("b.js", &["a.js"]), ("c.js", &[])]);
        let found = components(&graph);
        assert_eq!(found.len(), 2, "a cycle is one component, not an error");
        assert_eq!(found[0], vec!["a.js".to_string(), "b.js".to_string()]);
        assert_eq!(found[1], vec!["c.js".to_string()]);
    }

    #[test]
    fn a_deep_chain_does_not_overflow_and_orders_dependencies_first() {
        let chain: Vec<(String, Vec<String>)> = (0..2000)
            .map(|i| (format!("f{i}.js"), vec![format!("f{}.js", i + 1)]))
            .chain(std::iter::once(("f2000.js".to_string(), Vec::new())))
            .collect();
        let graph: BTreeMap<String, BTreeSet<String>> = chain
            .iter()
            .map(|(node, targets)| (node.clone(), targets.iter().cloned().collect()))
            .collect();
        let found = components(&graph);
        assert_eq!(found.len(), 2001, "every file is its own component");
        let hashes: BTreeMap<String, String> = graph
            .keys()
            .map(|path| (path.clone(), format!("h:{path}")))
            .collect();
        let closures = closure_digests(&graph, &found, &hashes);
        // The tail reaches nothing, the head reaches everything.
        assert_ne!(closures["f0.js"], closures["f1.js"]);
        assert_eq!(
            closures["f2000.js"],
            digest("f2000.js\u{0}h:f2000.js\u{0}".as_bytes()),
            "a leaf's closure is just itself"
        );
    }

    #[test]
    fn a_file_is_invalidated_by_anything_it_depends_on() {
        let graph = graph_of(&[
            ("app.js", &["util.js"]),
            ("util.js", &["core.js"]),
            ("core.js", &[]),
            ("island.js", &[]),
        ]);
        let found = components(&graph);
        let before = file_keys(
            &graph,
            &found,
            &hashes(&[
                ("app.js", "a1"),
                ("util.js", "u1"),
                ("core.js", "c1"),
                ("island.js", "i1"),
            ]),
            "bundle",
        );
        // Only the deepest file changes.
        let after = file_keys(
            &graph,
            &found,
            &hashes(&[
                ("app.js", "a1"),
                ("util.js", "u1"),
                ("core.js", "c2"),
                ("island.js", "i1"),
            ]),
            "bundle",
        );
        assert_ne!(before["core.js"], after["core.js"]);
        assert_ne!(before["util.js"], after["util.js"], "a dependency changed");
        assert_ne!(
            before["app.js"], after["app.js"],
            "propagation is transitive"
        );
        assert_eq!(
            before["island.js"], after["island.js"],
            "an unrelated file must not be dragged in"
        );
    }

    #[test]
    fn invalidation_reports_whether_it_was_our_bytes_or_a_dependency() {
        let graph = graph_of(&[("app.js", &["util.js"]), ("util.js", &[])]);
        let found = components(&graph);
        let previous_content = hashes(&[("app.js", "a1"), ("util.js", "u1")]);
        let current_content = hashes(&[("app.js", "a2"), ("util.js", "u1")]);
        let previous = file_keys(&graph, &found, &previous_content, "bundle");
        let current = file_keys(&graph, &found, &current_content, "bundle");

        let report = verdicts(
            &previous,
            &current,
            &previous_content,
            &current_content,
            &graph,
        );
        let by_path: BTreeMap<&str, &Verdict> =
            report.iter().map(|v| (v.path.as_str(), v)).collect();
        assert_eq!(report.len(), 1, "only the file that actually changed moves");
        assert_eq!(by_path["app.js"].change, Change::OwnContent);
        assert!(
            by_path["app.js"].via.is_empty(),
            "a file that changed explains itself; it is not blamed on a dependency"
        );
        assert!(
            !by_path.contains_key("util.js"),
            "app depends on util, so changing app must not invalidate util"
        );

        // And the reverse direction: changing the dependency invalidates the
        // dependent, which must be attributed to the dependency.
        let current2 = hashes(&[("app.js", "a1"), ("util.js", "u2")]);
        let keys2 = file_keys(&graph, &found, &current2, "bundle");
        let report2 = verdicts(&previous, &keys2, &previous_content, &current2, &graph);
        let app = report2
            .iter()
            .find(|v| v.path == "app.js")
            .expect("a changed dependency must invalidate its dependent");
        assert_eq!(app.change, Change::Dependency);
        assert_eq!(app.via, vec!["util.js".to_string()]);
        let util = report2.iter().find(|v| v.path == "util.js").unwrap();
        assert_eq!(util.change, Change::OwnContent);
    }

    #[test]
    fn a_new_file_is_new_and_a_removed_file_is_withdrawn() {
        let graph = graph_of(&[("a.js", &[])]);
        let found = components(&graph);
        let previous_content = hashes(&[("a.js", "a1")]);
        let previous = file_keys(&graph, &found, &previous_content, "bundle");

        let graph2 = graph_of(&[("a.js", &[]), ("b.js", &[])]);
        let found2 = components(&graph2);
        let current_content = hashes(&[("a.js", "a1"), ("b.js", "b1")]);
        let current = file_keys(&graph2, &found2, &current_content, "bundle");

        let report = verdicts(
            &previous,
            &current,
            &previous_content,
            &current_content,
            &graph2,
        );
        assert_eq!(report.len(), 1, "only the new file is reported");
        assert_eq!(report[0].path, "b.js");
        assert_eq!(report[0].change, Change::New);

        let before: BTreeSet<String> = ["a.js", "gone.js"].iter().map(|s| s.to_string()).collect();
        let now: BTreeSet<String> = ["a.js", "b.js"].iter().map(|s| s.to_string()).collect();
        assert_eq!(withdrawn(&before, &now), vec!["gone.js".to_string()]);
    }

    #[test]
    fn an_empty_graph_is_not_a_special_case_that_panics() {
        let graph: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let found = components(&graph);
        assert!(found.is_empty());
        let keys = file_keys(&graph, &found, &BTreeMap::new(), "bundle");
        assert!(keys.is_empty());
    }
}

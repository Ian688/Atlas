use crate::{Result, digest, invalid, store::Store};
use atlas_contract::*;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

fn parent(path: &str) -> String {
    format!(
        "dir:{}",
        path.rsplit_once('/').map(|(a, _)| a).unwrap_or("")
    )
}
fn valid_span(source: &str, start: usize, end: usize) -> bool {
    start <= end
        && end <= source.len()
        && source.is_char_boundary(start)
        && source.is_char_boundary(end)
}

/// Validate every foreign ID and source range before building Rust-owned derived facts.
pub fn analyze(store: &Store, snapshot: &Snapshot, mut facts: LanguageFacts) -> Result<Analysis> {
    if facts.schema != FACTS_SCHEMA
        || facts.snapshot_id != snapshot.id
        || facts.producer != "typescript/5.9.3;worker/0.1.0"
    {
        return Err(invalid("language_contract_mismatch"));
    }
    let sources: HashMap<_, _> = store
        .sources(snapshot)?
        .into_iter()
        .map(|f| (f.path, f.content))
        .collect();
    let expected: BTreeSet<_> = sources
        .keys()
        .filter(|p| crate::scan::is_source(p))
        .cloned()
        .collect();
    let acknowledged: BTreeSet<_> = facts.parsed_files.iter().cloned().collect();
    if expected != acknowledged || acknowledged.len() != facts.parsed_files.len() {
        return Err(invalid("worker_file_coverage_mismatch"));
    }
    if facts
        .diagnostics
        .iter()
        .any(|d| !expected.contains(&d.path))
        || facts.dynamic_files.iter().any(|p| !expected.contains(p))
    {
        return Err(invalid("diagnostic_outside_parse_inputs"));
    }
    let mut coverage = BTreeMap::from([
        ("catalog_entries".into(), snapshot.entries.len()),
        ("parsed_source_files".into(), expected.len()),
    ]);
    for entry in &snapshot.entries {
        *coverage
            .entry(format!("disposition:{}", entry.disposition))
            .or_default() += 1;
        if crate::scan::is_source(&entry.path) && entry.kind == "file" {
            *coverage
                .entry("encountered_source_files".into())
                .or_default() += 1;
            if entry.blob.is_some() && !sources.contains_key(&entry.path) {
                facts.diagnostics.push(Diagnostic {
                    path: entry.path.clone(),
                    code: "SOURCE_NOT_UTF8".into(),
                    detail: "Captured bytes retained; language parsing skipped.".into(),
                });
            }
        }
    }
    let mut ids = HashSet::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    let symbols: HashMap<_, _> = facts.symbols.iter().map(|s| (s.id.as_str(), s)).collect();
    if symbols.len() != facts.symbols.len() {
        return Err(invalid("duplicate_symbol"));
    }
    for symbol in &facts.symbols {
        let source = sources
            .get(&symbol.path)
            .ok_or_else(|| invalid("symbol_source_outside_snapshot"))?;
        if symbol.kind != "function"
            || !expected.contains(&symbol.path)
            || !valid_span(source, symbol.start, symbol.end)
            || symbol.id != format!("symbol:{}:{}:{}", symbol.path, symbol.start, symbol.end)
        {
            return Err(invalid("invalid_symbol_anchor"));
        }
        if symbol.container != format!("file:{}", symbol.path) {
            let container = symbols
                .get(symbol.container.as_str())
                .ok_or_else(|| invalid("missing_symbol_container"))?;
            if container.id == symbol.id
                || container.path != symbol.path
                || container.start > symbol.start
                || container.end < symbol.end
            {
                return Err(invalid("invalid_symbol_containment"));
            }
        }
        *counts.entry(symbol.path.clone()).or_default() += 1;
    }
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for entry in &snapshot.entries {
        let kind = if entry.kind == "directory" {
            "directory"
        } else {
            "file"
        };
        let id = format!(
            "{}:{}",
            if kind == "directory" { "dir" } else { "file" },
            entry.path
        );
        let parent = if entry.path.is_empty() {
            None
        } else {
            Some(parent(&entry.path))
        };
        if let Some(source) = &parent {
            edges.push(Edge {
                id: format!("contains:{id}"),
                source: source.clone(),
                target: Some(id.clone()),
                kind: "contains".into(),
                path: entry.path.clone(),
                start: 0,
                end: 0,
                label: String::new(),
                basis: "snapshot_catalog".into(),
            });
        }
        ids.insert(id.clone());
        nodes.push(Node {
            id,
            path: entry.path.clone(),
            name: entry.path.rsplit('/').next().unwrap_or("").into(),
            kind: kind.into(),
            parent,
            start: 0,
            end: entry.bytes as usize,
            function_count: *counts.get(&entry.path).unwrap_or(&0),
            disposition: entry.disposition.clone(),
        });
    }
    for symbol in &facts.symbols {
        ids.insert(symbol.id.clone());
        edges.push(Edge {
            id: format!("contains:{}", symbol.id),
            source: symbol.container.clone(),
            target: Some(symbol.id.clone()),
            kind: "contains".into(),
            path: symbol.path.clone(),
            start: symbol.start,
            end: symbol.end,
            label: String::new(),
            basis: "syntax_containment".into(),
        });
        nodes.push(Node {
            id: symbol.id.clone(),
            path: symbol.path.clone(),
            name: symbol.name.clone(),
            kind: "function".into(),
            parent: Some(symbol.container.clone()),
            start: symbol.start,
            end: symbol.end,
            function_count: 0,
            disposition: if symbol.mutated {
                "binding_written"
            } else {
                "syntax_extracted"
            }
            .into(),
        });
    }
    let bad_files: HashSet<_> = facts
        .diagnostics
        .iter()
        .map(|d| d.path.as_str())
        .chain(facts.dynamic_files.iter().map(String::as_str))
        .collect();
    for call in &facts.calls {
        let source = sources
            .get(&call.path)
            .ok_or_else(|| invalid("call_source_outside_snapshot"))?;
        if !valid_span(source, call.start, call.end)
            || call.id != format!("call:{}:{}:{}", call.path, call.start, call.end)
            || !ids.contains(&call.owner)
        {
            return Err(invalid("invalid_call_anchor"));
        }
        if call.owner != format!("file:{}", call.path) {
            let owner = symbols
                .get(call.owner.as_str())
                .ok_or_else(|| invalid("invalid_call_owner"))?;
            if owner.path != call.path || owner.start > call.start || owner.end < call.end {
                return Err(invalid("call_outside_owner"));
            }
        }
        let target = call
            .target
            .as_ref()
            .map(|id| {
                symbols
                    .get(id.as_str())
                    .copied()
                    .ok_or_else(|| invalid("unknown_binding_target"))
            })
            .transpose()?;
        let (target, basis) = match target {
            Some(s)
                if call.form == "identifier"
                    && !s.mutated
                    && !bad_files.contains(call.path.as_str())
                    && !bad_files.contains(s.path.as_str()) =>
            {
                (Some(s.id.clone()), "lexical_declaration_candidate")
            }
            Some(_) => (None, "mutable_or_unmodeled_semantics"),
            None => (None, "dynamic_external_or_missing_binding"),
        };
        edges.push(Edge {
            id: call.id.clone(),
            source: call.owner.clone(),
            target,
            kind: "call_candidate".into(),
            path: call.path.clone(),
            start: call.start,
            end: call.end,
            label: call.label.clone(),
            basis: basis.into(),
        });
    }
    for import in &facts.imports {
        if !sources.contains_key(&import.path) {
            return Err(invalid("import_source_outside_snapshot"));
        }
        let target = import.target_path.as_ref().map(|p| format!("file:{p}"));
        if target.as_ref().is_some_and(|t| !ids.contains(t)) {
            return Err(invalid("import_target_outside_snapshot"));
        }
        edges.push(Edge {
            id: import.id.clone(),
            source: format!("file:{}", import.path),
            target,
            kind: if import.type_only {
                "type_import"
            } else {
                "import"
            }
            .into(),
            path: import.path.clone(),
            start: 0,
            end: 0,
            label: import.specifier.clone(),
            basis: "typescript_virtual_module_resolution".into(),
        });
    }
    let mut edge_ids = HashSet::new();
    for edge in &edges {
        if !edge_ids.insert(&edge.id)
            || !ids.contains(&edge.source)
            || edge.target.as_ref().is_some_and(|id| !ids.contains(id))
        {
            return Err(invalid("invalid_graph_reference"));
        }
    }
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    edges.sort_by(|a, b| a.id.cmp(&b.id));
    let recursive_components = recursive_components(&edges);
    let mut analysis=Analysis{schema:ANALYSIS_SCHEMA.into(),id:String::new(),snapshot_id:snapshot.id.clone(),engine:ENGINE_VERSION.into(),producer:facts.producer,coverage,nodes,edges,diagnostics:facts.diagnostics,recursive_components,limitations:vec![
        "Lexical declaration candidates, not a complete runtime call graph or execution trace.".into(),
        "No CFG, abstract interpretation, heap/alias flow, framework models or runtime execution in this slice.".into(),
        "Snapshot captures files over an interval; it is not an atomic filesystem transaction.".into(),
        "Only captured UTF-8 JS/TS inputs; external dependencies, standard library and project tsconfig are not loaded.".into(),
        "Ignored directories are explicit boundaries; their unvisited descendants are not counted.".into(),
    ]};
    analysis.id = digest(&serde_json::to_vec(&analysis)?);
    store.publish_analysis(&analysis)?;
    Ok(analysis)
}

/// Iterative Kosaraju: no recursive Rust stack proportional to repository depth.
pub fn recursive_components(edges: &[Edge]) -> Vec<Vec<String>> {
    let mut forward: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut reverse: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in edges.iter().filter(|e| e.kind == "call_candidate") {
        if let Some(target) = &edge.target {
            forward
                .entry(edge.source.clone())
                .or_default()
                .push(target.clone());
            forward.entry(target.clone()).or_default();
            reverse
                .entry(target.clone())
                .or_default()
                .push(edge.source.clone());
        }
    }
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    for root in forward.keys() {
        let mut stack = vec![(root.clone(), false)];
        while let Some((node, finish)) = stack.pop() {
            if finish {
                order.push(node);
                continue;
            }
            if !seen.insert(node.clone()) {
                continue;
            }
            stack.push((node.clone(), true));
            for next in &forward[&node] {
                if !seen.contains(next) {
                    stack.push((next.clone(), false));
                }
            }
        }
    }
    seen.clear();
    let mut result = Vec::new();
    for root in order.into_iter().rev() {
        if seen.contains(&root) {
            continue;
        }
        let mut component = BTreeSet::new();
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            if !seen.insert(node.clone()) {
                continue;
            }
            component.insert(node.clone());
            if let Some(parents) = reverse.get(&node) {
                stack.extend(parents.iter().cloned());
            }
        }
        if component.len() > 1 || component.iter().any(|n| forward[n].contains(n)) {
            result.push(component.into_iter().collect());
        }
    }
    result.sort();
    result
}

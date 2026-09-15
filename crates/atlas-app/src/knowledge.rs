//! Node knowledge: the Atlas summary and the code comments behind an `i`.
//!
//! Both are assembled from things Atlas already published -- the containment
//! structure, the flow facts, the call candidates, the captured bytes -- and
//! neither invents a conclusion. The summary is prose over stated facts, so a
//! reader without any model configured still gets an answer for every node; the
//! comments are the original bytes with a file and line, so a reader can go and
//! check them.
//!
//! Where a fact is missing the answer says so: an unresolved call stays
//! unresolved, a document says it has no language analysis, and a function whose
//! dataflow was withheld says exactly that instead of "no effects".
use crate::runner;
use atlas_engine::store::Store;
use atlas_engine::tree;
use serde_json::{Value, json};

pub const KNOWLEDGE_SCHEMA: &str = "atlas.node-knowledge.v1";

fn bytes_of(store: &Store, analysis: &str, path: &str) -> Option<Vec<u8>> {
    let meta = store.metadata(analysis).ok()?;
    let snapshot = store.snapshot(meta["snapshot_id"].as_str()?).ok()?;
    let entry = snapshot.entries.iter().find(|entry| entry.path == path)?;
    let hash = entry.blob.as_ref()?;
    store.read_blob(hash).ok()
}

fn source_of(store: &Store, analysis: &str, path: &str) -> Option<String> {
    String::from_utf8(bytes_of(store, analysis, path)?).ok()
}

fn line_of(source: &str, byte: usize) -> usize {
    source[..byte.min(source.len())].matches('\n').count() + 1
}

/// The comment block immediately before `start`, or the file header when
/// `start` is 0. Returns `(byte_start, byte_end, text)`.
fn leading_comment(source: &str, start: usize) -> Option<(usize, usize, String)> {
    let mut cursor = start.min(source.len());
    if start == 0 {
        // Skip a shebang so a CLI entry point's first comment is found.
        if source.starts_with("#!") {
            cursor = source.find('\n').map(|i| i + 1).unwrap_or(source.len());
        }
    }
    // Walk back over whitespace to the end of whatever precedes the declaration.
    while cursor > 0 {
        let ch = source[..cursor].chars().next_back()?;
        if ch.is_whitespace() {
            cursor -= ch.len_utf8();
        } else {
            break;
        }
    }
    if cursor == 0 {
        return None;
    }
    if source[..cursor].ends_with("*/") {
        let open = source[..cursor - 2].rfind("/*")?;
        let text = source[open..cursor].trim().to_string();
        return (!text.is_empty()).then_some((open, cursor, text));
    }
    // Contiguous `//` lines directly above the declaration.
    let mut block_start = cursor;
    let mut found = false;
    loop {
        let line_start = source[..block_start]
            .rfind('\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        let line = &source[line_start..block_start];
        if line.trim_start().starts_with("//") {
            found = true;
            if line_start == 0 {
                block_start = 0;
                break;
            }
            block_start = line_start;
        } else {
            break;
        }
    }
    if !found {
        return None;
    }
    let text = source[block_start..cursor].trim().to_string();
    (!text.is_empty()).then_some((block_start, cursor, text))
}

fn comment_entry(
    origin: &str,
    path: &str,
    source: &str,
    start: usize,
    end: usize,
    text: String,
) -> Value {
    json!({
        "origin": origin,
        "path": path,
        "start": start,
        "end": end,
        "start_line": line_of(source, start),
        "end_line": line_of(source, end),
        "text": text,
    })
}

fn value_lines(label: &str, value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let constants = value["constants"].as_array().cloned().unwrap_or_default();
    let origins = value["origins"].as_array().cloned().unwrap_or_default();
    if !constants.is_empty() {
        let rendered: Vec<String> = constants.iter().map(render_constant).collect();
        out.push(format!("{label}常量：{}", rendered.join(", ")));
    }
    if !origins.is_empty() {
        let rendered: Vec<String> = origins
            .iter()
            .filter_map(|v| v.as_str())
            .map(str::to_string)
            .collect();
        out.push(format!("{label}来源：{}", rendered.join(", ")));
    }
    if value["unknown"].as_bool() == Some(true) {
        out.push(format!("{label}结论不完整（显式未知）"));
    }
    out
}

fn render_constant(value: &Value) -> String {
    let kind = value["kind"].as_str().unwrap_or("unknown");
    match kind {
        "string" => format!("\"{}\"", value["value"].as_str().unwrap_or("")),
        "undefined" | "nan" | "infinity" | "negative_infinity" => kind.into(),
        _ => value
            .get("value")
            .map(|v| v.to_string())
            .unwrap_or_else(|| kind.into()),
    }
}

/// The Atlas summary and comment anchors for one node.
pub fn knowledge(store: &Store, analysis: &str, entity: &str) -> Result<Value, String> {
    let mut lines: Vec<Value> = Vec::new();
    let mut facts = json!({});
    let mut comments: Vec<Value> = Vec::new();
    let mut limitations: Vec<String> = Vec::new();
    let node_value;
    let mut unsupported = false;

    if let Some((path, start, end)) = parse_section(entity) {
        let source = source_of(store, analysis, &path);
        let title = source
            .as_ref()
            .and_then(|s| s.get(start..end))
            .map(|section| {
                section
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_start_matches('#')
                    .trim()
                    .to_string()
            })
            .unwrap_or_else(|| "(文档章节)".into());
        node_value = json!({
            "id": entity, "kind": "section", "path": path, "name": title,
            "start": start, "end": end,
        });
        lines.push(line("这是什么", format!("{path} 中的文档章节，字节 {start}–{end}（{} 字节）", end - start)));
        lines.push(line("能做什么", "读原文、写批注、引用进解析记录、交给 Agent 修改文档".into()));
        lines.push(line("分析能力", "文档章节没有代码语义分析：这里不会出现函数、调用或值来源。".into()));
        unsupported = true;
        if let Some(source) = source {
            let text = source
                .get(start..end)
                .unwrap_or("")
                .lines()
                .take(40)
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                comments.push(comment_entry("章节原文", &path, &source, start, end, text));
            }
        }
        return Ok(assemble(
            analysis,
            entity,
            node_value,
            lines,
            facts,
            comments,
            limitations,
            unsupported,
        ));
    }

    let node = store
        .node(analysis, entity)
        .map_err(|error| format!("entity_not_found:{error}"))?;
    node_value = serde_json::to_value(&node).map_err(|e| e.to_string())?;
    let source = source_of(store, analysis, &node.path);

    match node.kind.as_str() {
        "function" => {
            let fact = store
                .flow_fact(analysis, &node.id)
                .map_err(|error| format!("flow_fact_not_found:{error}"))?;
            facts["flow_status"] = fact["status"].clone();
            facts["algorithm"] = fact["algorithm"].clone();
            let profile = runner::profile_for(store, analysis, &node.id)?;
            let params: Vec<String> = profile
                .params
                .iter()
                .map(|param| param.name.clone())
                .collect();
            lines.push(line(
                "签名",
                format!(
                    "{}({})",
                    node.name,
                    if params.is_empty() {
                        profile
                            .arity
                            .map(|n| format!("{n} 个位置参数"))
                            .unwrap_or_else(|| "参数形状未知".into())
                    } else {
                        params.join(", ")
                    }
                ),
            ));
            lines.push(line(
                "可运行性",
                format!(
                    "{}（{}）",
                    if profile.runnable { "可以受控运行" } else { "当前不可直接运行" },
                    profile.classification
                ),
            ));
            for value in value_lines("返回", &fact["returns"]) {
                lines.push(line("返回", value));
            }
            for value in value_lines("抛出", &fact["throws"]) {
                lines.push(line("抛出", value));
            }
            let effects = &fact["effects"];
            let mut flagged: Vec<&str> = Vec::new();
            for (key, label) in [
                ("may_call", "可能调用未建模代码"),
                ("unknown_call", "有未知调用"),
                ("may_write_heap", "可能写堆"),
                ("may_read_heap", "可能读堆"),
                ("may_access_global", "可能读全局"),
                ("registers_callback", "注册回调"),
                ("escaped_local_value", "局部值逃逸"),
                ("may_throw", "可能抛出"),
            ] {
                if effects[key].as_bool() == Some(true) {
                    flagged.push(label);
                }
            }
            lines.push(line(
                "副作用",
                if flagged.is_empty() {
                    "在当前分析 profile 内没有观察到副作用".into()
                } else {
                    flagged.join("；")
                },
            ));
            let out = store
                .reachable(analysis, &node.id, "out", 50, 100)
                .map_err(|e| e.to_string())?;
            let incoming = store
                .reachable(analysis, &node.id, "in", 50, 100)
                .map_err(|e| e.to_string())?;
            let callees: Vec<String> = out
                .nodes
                .iter()
                .filter(|n| n.id != node.id)
                .map(|n| n.name.clone())
                .collect();
            let callers: Vec<String> = incoming
                .nodes
                .iter()
                .filter(|n| n.id != node.id)
                .map(|n| n.name.clone())
                .collect();
            lines.push(line(
                "调用",
                format!(
                    "调用 {} 个已解析目标{}；被 {} 个已解析调用方引用{}",
                    callees.len(),
                    if callees.is_empty() { String::new() } else { format!("（{}）", callees.join(", ")) },
                    callers.len(),
                    if callers.is_empty() { String::new() } else { format!("（{}）", callers.join(", ")) },
                ),
            ));
            if !out.unresolved.is_empty() || !incoming.unresolved.is_empty() {
                lines.push(line(
                    "未解析调用",
                    format!(
                        "本函数有 {} 个调用点没有解析出目标；{} 个调用点指向本函数但无法确认调用方。这些是候选，不是运行轨迹。",
                        out.unresolved.len(),
                        incoming.unresolved.len()
                    ),
                ));
            }
            facts["callee_count"] = json!(callees.len());
            facts["caller_count"] = json!(callers.len());
            facts["unresolved_out"] = json!(out.unresolved.len());
            facts["unresolved_in"] = json!(incoming.unresolved.len());
            if out.truncated || incoming.truncated {
                limitations.push("调用方/被调用方列表达到查询预算，列表可能不完整。".into());
            }
            let unknown_reasons = fact["unknown_reasons"].as_array().cloned().unwrap_or_default();
            if !unknown_reasons.is_empty() {
                let rendered: Vec<String> = unknown_reasons
                    .iter()
                    .filter_map(|v| v.as_str())
                    .map(str::to_string)
                    .collect();
                lines.push(line("未知", rendered.join("；")));
            }
            if node.disposition == "binding_written" {
                limitations.push("这个函数的绑定在运行期被重新赋值，调用候选可能不唯一。".into());
            }
            limitations.push("调用关系是静态词法候选，不是这次运行实际走过的路径。".into());
        }
        "file" => {
            let kind = tree::file_kind(&node.path);
            facts["file_kind"] = json!(kind);
            facts["bytes"] = json!(node.end);
            let imports = tree::edges_touching(store, analysis, &node.id, "out", "import", 200)
                .map_err(|e| e.to_string())?;
            let type_imports =
                tree::edges_touching(store, analysis, &node.id, "out", "type_import", 200)
                    .map_err(|e| e.to_string())?;
            let members = tree::members(store, analysis, Some(&node.id), 500, None)
                .map_err(|e| e.to_string())?;
            let declarations: Vec<String> = members
                .items
                .iter()
                .filter(|item| item.kind == "function")
                .map(|item| item.name.clone())
                .collect();
            match kind {
                "code" => {
                    lines.push(line(
                        "这是什么",
                        format!(
                            "代码文件，{} 字节，声明了 {} 个可定位函数",
                            node.end,
                            declarations.len()
                        ),
                    ));
                    if !declarations.is_empty() {
                        lines.push(line("声明", declarations.join(", ")));
                    }
                    let modules: Vec<String> = imports
                        .iter()
                        .map(|edge| {
                            edge.label
                                .clone()
                                .trim_matches(|c| c == '"' || c == '\'')
                                .to_string()
                        })
                        .collect();
                    lines.push(line(
                        "导入",
                        if modules.is_empty() {
                            "没有解析出 import（可能是入口文件或分析范围外）".into()
                        } else {
                            format!(
                                "{} 个导入：{}",
                                modules.len(),
                                modules.join(", ")
                            )
                        },
                    ));
                    if !type_imports.is_empty() {
                        lines.push(line("类型导入", format!("{} 个（仅类型，运行时不加载）", type_imports.len())));
                    }
                    facts["declaration_count"] = json!(declarations.len());
                    facts["import_count"] = json!(imports.len());
                }
                "markdown" => {
                    let sections = tree::markdown_sections(store, analysis, &node.path)
                        .map_err(|e| e.to_string())?;
                    lines.push(line(
                        "这是什么",
                        format!("Markdown 文档，{} 字节，{} 个标题章节", node.end, sections.len()),
                    ));
                    if !sections.is_empty() {
                        let titles: Vec<String> = sections
                            .iter()
                            .take(12)
                            .map(|s| s.name.clone())
                            .collect();
                        lines.push(line("章节", titles.join(" / ")));
                    }
                    lines.push(line(
                        "分析能力",
                        "文档没有函数级分析；可以按章节阅读、批注并交给 Agent 修改。".into(),
                    ));
                    unsupported = true;
                }
                "binary" => {
                    lines.push(line(
                        "这是什么",
                        format!("二进制文件（按扩展名判定），{} 字节；不提供文本内容。", node.end),
                    ));
                    unsupported = true;
                }
                _ => {
                    lines.push(line(
                        "这是什么",
                        format!("普通文本/配置文件，{} 字节；内容视图可读原文。", node.end),
                    ));
                    lines.push(line(
                        "分析能力",
                        "这类文件没有函数级分析；如果它包含代码所读的键值，Atlas 不会把它们当作事实。".into(),
                    ));
                    unsupported = true;
                }
            }
            limitations.push("文件成员只覆盖当前语言链能解析的声明（JS/TS 的函数级）。".into());
        }
        "directory" => {
            let members = tree::members(store, analysis, Some(&node.id), 500, None)
                .map_err(|e| e.to_string())?;
            let dirs = members
                .items
                .iter()
                .filter(|item| item.kind == "directory")
                .count();
            let files = members
                .items
                .iter()
                .filter(|item| item.kind == "file")
                .count();
            let functions: usize = members
                .items
                .iter()
                .map(|item| item.function_count)
                .sum();
            let is_root = node.path.is_empty();
            lines.push(line(
                "这是什么",
                if is_root {
                    format!(
                        "项目根目录：{} 个直接子目录、{} 个直接文件；这些文件里已解析出 {} 个函数。",
                        dirs, files, functions
                    )
                } else {
                    format!(
                        "目录 {}/：{} 个直接子目录、{} 个直接文件（它们的函数数合计 {}）。",
                        node.path, dirs, files, functions
                    )
                },
            ));
            let entries: Vec<String> = members
                .items
                .iter()
                .filter(|item| item.kind == "file")
                .filter(|item| tree::file_kind(&item.path) == "code")
                .take(8)
                .map(|item| item.path.clone())
                .collect();
            if !entries.is_empty() {
                lines.push(line("代码入口", entries.join(", ")));
            }
            facts["direct_directories"] = json!(dirs);
            facts["direct_files"] = json!(files);
            facts["direct_functions"] = json!(functions);
            limitations.push("目录只统计直接成员；深层文件数与函数数请在子树里继续展开。".into());
        }
        other => {
            lines.push(line("这是什么", format!("{other} 类型的对象")));
            unsupported = true;
        }
    }

    // Comment anchors: the function's own leading comment, a file's header.
    if let Some(source) = &source {
        match node.kind.as_str() {
            "function" => {
                if let Some((start, end, text)) = leading_comment(source, node.start) {
                    comments.push(comment_entry(
                        "源码注释",
                        &node.path,
                        source,
                        start,
                        end,
                        text,
                    ));
                }
            }
            "file" => {
                if let Some((start, end, text)) = leading_comment(source, 0) {
                    comments.push(comment_entry(
                        "文件头注释",
                        &node.path,
                        source,
                        start,
                        end,
                        text,
                    ));
                }
            }
            _ => {}
        }
    }

    // A project (the empty-path directory) may quote its README as a source,
    // naming where the quote came from.
    if node.kind == "directory" && node.path.is_empty() {
        if let Some(readme) = source_of(store, analysis, "README.md").or_else(|| {
            ["Readme.md", "readme.md", "README.markdown"]
                .iter()
                .find_map(|name| source_of(store, analysis, name))
        }) {
            let excerpt: String = readme
                .lines()
                .filter(|line| !line.trim().is_empty())
                .take(12)
                .collect::<Vec<_>>()
                .join("\n");
            comments.push(json!({
                "origin": "README.md",
                "path": "README.md",
                "start": 0,
                "end": excerpt.len(),
                "start_line": 1,
                "end_line": excerpt.lines().count(),
                "text": excerpt,
            }));
        }
    }

    if let Ok(meta) = store.metadata(analysis) {
        if let Some(list) = meta["limitations"].as_array() {
            for item in list.iter().filter_map(|v| v.as_str()).take(3) {
                limitations.push(item.to_string());
            }
        }
    }

    Ok(assemble(
        analysis,
        entity,
        node_value,
        lines,
        facts,
        comments,
        limitations,
        unsupported,
    ))
}

fn line(label: &str, text: String) -> Value {
    json!({"label": label, "text": text})
}

fn parse_section(entity: &str) -> Option<(String, usize, usize)> {
    let rest = entity.strip_prefix("section:")?;
    let mut parts = rest.rsplitn(3, ':');
    let end = parts.next()?.parse::<usize>().ok()?;
    let start = parts.next()?.parse::<usize>().ok()?;
    let path = parts.next()?.to_string();
    Some((path, start, end))
}

#[allow(clippy::too_many_arguments)]
fn assemble(
    analysis: &str,
    entity: &str,
    node: Value,
    lines: Vec<Value>,
    facts: Value,
    comments: Vec<Value>,
    limitations: Vec<String>,
    unsupported: bool,
) -> Value {
    let comments_available = !comments.is_empty();
    json!({
        "schema": KNOWLEDGE_SCHEMA,
        "analysis_id": analysis,
        "entity_id": entity,
        "node": node,
        "summary": {
            "origin": "Atlas 算法摘要",
            "basis": "已发布的静态分析事实（结构、调用候选、数据流事实、捕获字节）",
            "lines": lines,
            "facts": facts,
        },
        "comments": comments,
        "sources": [
            {"id": "facts", "label": "Atlas 摘要", "available": true, "origin": "静态分析事实（不需要模型）"},
            {"id": "comments", "label": "代码注释", "available": comments_available,
             "reason": if comments_available { Value::Null } else { json!("这个节点没有可引用的源码注释") }},
            {"id": "llm", "label": "LLM 解释", "available": false,
             "reason": "尚未生成：需要先配置模型连接，并在节点上显式点击生成"},
        ],
        "limitations": limitations,
        "unsupported_semantics": unsupported,
    })
}

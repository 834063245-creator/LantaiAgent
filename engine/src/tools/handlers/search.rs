use std::path::Path;

use serde_json::{json, Value};
use crate::analysis::*;
use crate::engine;
use crate::tools::{get_usize, project_root};
use crate::tools::node_to_value;
use crate::tools::ToolResponse;
use crate::tools::with_graph;
use crate::tools::with_store;

pub(crate) fn handler_search(args: &Value) -> ToolResponse {
    let query_str = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let limit = get_usize(args, "limit", 20);
    if query_str.is_empty() {
        return ToolResponse::Degraded {
            guidance: "query is required".into(),
            fallback: "Provide a search query string".into(),
            details: json!({}),
        };
    }
    // 1. FTS5 精确搜索
    if let Ok(results) = engine::engine_fts_search(query_str, limit) {
        if !results.is_empty() {
            let mut out = json!({
                "query": query_str,
                "count": results.len(),
                "results": results.iter().map(node_to_value).collect::<Vec<_>>(),
                "engine": "fts5",
            });
            // 如果可用，附加向量搜索结果
            merge_vector_hits(&mut out, query_str, limit);
            return ToolResponse::Success(out);
        }
    }
    // 2. 线性模糊回退
    let mut out = with_graph(|g| {
        let results = g.search_nodes(query_str);
        let count = results.len().min(limit);
        json!({
            "query": query_str,
            "count": count,
            "results": results.iter().take(limit).map(|n| node_to_value(n)).collect::<Vec<_>>(),
            "engine": "linear",
        })
    });
    // 附加向量搜索结果
    merge_vector_hits(&mut out, query_str, limit);
    ToolResponse::Success(out)
}

/// 将向量（语义）搜索结果附加到输出（如果可用）。
/// ponytail：即发即忘 —— 如果向量索引未构建，静默跳过。
/// 过滤策略：低于后端阈值丢弃、与主结果去重、最多 5 条。
/// （HNSW 永远返回 top-k 个最近邻，不过滤会把无关噪音塞给 Agent。）
/// 向量检索核心：加载（进程级缓存的）向量索引 → 嵌入查询 → top-k → (node_id, 相似度)。
/// 索引不可用 / 为空时返回 None，由调用方决定降级行为。
/// search_symbols/explore_deps 的边车附加（merge_vector_hits）与 semantic_search
/// 一等工具共用此路径。
pub(crate) fn vector_query_hits(root: &Path, query: &str, top_k: usize) -> Option<Vec<(String, f32)>> {
    // 使用缓存的索引 —— 避免每次搜索都从磁盘重新加载 40+ MB
    let (index, slots) = hologram_vector::get_or_load_index(root).ok()?;
    let idx = index.read().unwrap_or_else(|e| e.into_inner());
    let idx = idx.as_ref()?;
    let slot_data = slots.read().unwrap_or_else(|e| e.into_inner());
    if slot_data.is_empty() { return None; }

    let q_vec = hologram_vector::embed(query);
    let results = idx.search(&q_vec, top_k).ok()?;

    // usearch 按距离升序返回 → 相似度降序
    Some(results.keys.iter().zip(results.distances.iter())
        .filter_map(|(slot_key, distance)| {
            let slot = *slot_key as usize;
            if slot >= slot_data.len() { return None; }
            let similarity = 1.0 - (*distance).min(2.0).max(0.0);
            Some((slot_data[slot].clone(), similarity))
        })
        .collect())
}

pub(crate) fn merge_vector_hits(out: &mut Value, query: &str, limit: usize) {
    let root = project_root();
    if root.as_os_str().is_empty() { return; }
    // 多取候选：阈值过滤与去重会淘汰一部分
    let fetch = (limit * 2).max(20);
    let raw = match vector_query_hits(&root, query, fetch) {
        Some(r) => r,
        None => return,
    };

    let threshold = hologram_vector::score_threshold();
    let max_hits = 5usize.min(limit.max(1));

    // 与主结果集去重（FTS/linear 已覆盖的节点不再重复出现）
    let existing: std::collections::HashSet<&str> = out["results"].as_array()
        .map(|a| a.iter().filter_map(|v| v["id"].as_str()).collect())
        .unwrap_or_default();

    let hits = hologram_vector::filter_hits(&raw, threshold, max_hits, &existing);
    if hits.is_empty() { return; }

    let top = &hits[0];
    tracing::info!(
        "[vector] {} hits for \"{}\" — top: {} ({:.0}%)",
        hits.len(), query, top.0, top.1 * 100.0
    );
    let vec_results: Vec<Value> = hits.into_iter()
        .map(|(node_id, score)| json!({"node_id": node_id, "vector_score": (score * 100.0).round() as u32}))
        .collect();
    let count = vec_results.len();
    out["vector_hits"] = json!(vec_results);
    out["vector_backend"] = json!(hologram_vector::backend_id());
    if let Some(obj) = out.as_object_mut() {
        // 不计入 count —— vector_hits 是独立字段。
        // count 仅反映主（FTS5/linear）结果集。
        obj.insert("vector_count".into(), json!(count));
    }
}

/// 语义检索一等入口（2026-08 工具面迭代）：与 merge_vector_hits 的「边车附加」
/// （node_id + 分数，最多 5 条）不同，这是独立工具 —— 按含义找符号，
/// 返回完整节点信息 + 相似度，top-k 可控。
pub(crate) fn handler_semantic_search(args: &Value) -> ToolResponse {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let limit = get_usize(args, "limit", 10).clamp(1, 50);
    if query.is_empty() {
        return ToolResponse::Degraded {
            guidance: "query is required".into(),
            fallback: "Provide a natural-language query describing what you're looking for, e.g. 'memory lifecycle management'".into(),
            details: json!({}),
        };
    }
    let root = project_root();
    if root.as_os_str().is_empty() {
        return ToolResponse::Degraded {
            guidance: "engine not initialized — project root unknown".into(),
            fallback: "Run analyze_project first, then retry".into(),
            details: json!({}),
        };
    }
    semantic_search_at(&root, &query, limit)
}

/// 可单测版本：对指定项目根执行语义检索（绕过 engine 全局状态）。
pub(crate) fn semantic_search_at(root: &Path, query: &str, limit: usize) -> ToolResponse {
    // 多取候选：阈值过滤会淘汰一部分
    let fetch = (limit * 2).max(20);
    let raw = match vector_query_hits(root, query, fetch) {
        Some(r) if !r.is_empty() => r,
        _ => {
            return ToolResponse::Degraded {
                guidance: "vector index unavailable or empty".into(),
                fallback: "Run analyze_project to build the vector index, or use search_symbols for name matching".into(),
                details: json!({ "backend": hologram_vector::backend_id() }),
            };
        }
    };

    let threshold = hologram_vector::score_threshold();
    let hits = hologram_vector::filter_hits(&raw, threshold, limit, &std::collections::HashSet::new());
    if hits.is_empty() {
        // 阈值全滤掉时不静默空手而归 —— 带 top 候选的降级响应引导换词
        let preview: Vec<Value> = raw.iter().take(3)
            .map(|(id, s)| json!({ "node_id": id, "score": (s * 100.0).round() as u32 }))
            .collect();
        return ToolResponse::Degraded {
            guidance: format!("no results above similarity threshold ({}%)", (threshold * 100.0).round() as u32),
            fallback: "Rephrase the query with domain vocabulary, or fall back to search_symbols (exact-name matching)".into(),
            details: json!({ "closest_candidates": preview, "backend": hologram_vector::backend_id() }),
        };
    }

    let out = with_store(|idx| {
        let results = resolve_hits_in_index(idx, &hits);
        json!({
            "query": query,
            "count": results.len(),
            "results": results,
            "engine": "vector",
            "backend": hologram_vector::backend_id(),
        })
    });
    if out.get("error").is_some() {
        return ToolResponse::Degraded {
            guidance: "graph store unavailable — cannot resolve node details".into(),
            fallback: "Check engine readiness via engine_status, then retry".into(),
            details: out,
        };
    }
    ToolResponse::Success(out)
}

/// 把向量命中解析为完整节点值（附加 vector_score）；未知 id 跳过。
pub(crate) fn resolve_hits_in_index(idx: &hologram_storage::MemoryIndex, hits: &[(String, f32)]) -> Vec<Value> {
    hits.iter().filter_map(|(id, score)| {
        let node = idx.get_node(id)?;
        let mut v = node_to_value(node);
        if let Some(obj) = v.as_object_mut() {
            obj.insert("vector_score".into(), json!((score * 100.0).round() as u32));
        }
        Some(v)
    }).collect()
}

pub(crate) fn handler_explore(args: &Value) -> ToolResponse {
    let symbols: Vec<String> = args
        .get("symbols")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let query_str = args.get("query").and_then(|v| v.as_str()).map(|s| s.to_string());
    if symbols.is_empty() && query_str.is_none() {
        return ToolResponse::Degraded {
            guidance: "symbols array or query string is required".into(),
            fallback: "Provide either a list of symbols or a natural language query".into(),
            details: json!({}),
        };
    }
    let include_source = args.get("includeSource").and_then(|v| v.as_bool()).unwrap_or(true);
    let root = project_root();
    ToolResponse::Success(with_graph(|g| {
        let mut out = explore(g, &root, &symbols, query_str.as_deref(), include_source);
        // 语义召回附加（仅 NL query 场景）：parse_nl_query 是名称匹配，
        // 词汇不匹配的查询（如 "memory management"）由向量命中补齐。
        // 与 search_symbols 共用 merge_vector_hits：即发即忘，无索引静默跳过。
        if let Some(q) = query_str.as_deref() {
            if !q.trim().is_empty() {
                merge_vector_hits(&mut out, q, 5);
            }
        }
        out
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hologram_graph::{Node, NodeKind};

    /// 唯一临时根目录（每个用例独立，避免进程级索引缓存串扰）。
    fn tmp_root(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("hologram_semantic_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(hologram_graph::data_dir(&tmp)).unwrap();
        tmp
    }

    #[test]
    fn test_semantic_search_empty_query_degrades() {
        let resp = handler_semantic_search(&json!({}));
        let v = resp.to_mcp_value(&json!(1));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("_isDegraded"), "空 query 必须降级: {}", text);
        assert!(text.contains("query is required"));
    }

    #[test]
    fn test_semantic_search_no_index_degrades() {
        let root = tmp_root("noindex");
        let resp = semantic_search_at(&root, "anything", 5);
        let v = resp.to_mcp_value(&json!(1));
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("_isDegraded"), "无索引必须降级而非空结果: {}", text);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_semantic_search_hits_and_resolution() {
        let root = tmp_root("hit");
        let mut n1 = Node::new("demo/parser.ts.parse_widget", "parse_widget", NodeKind::Function);
        n1.snippet = Some("parse the widget configuration from yaml and validate the schema".into());
        let mut n2 = Node::new("demo/mail.ts.send_email", "send_email", NodeKind::Function);
        n2.snippet = Some("send email notification via smtp to the end user".into());
        let nodes = vec![n1, n2];

        let vi = hologram_vector::CodeVectorIndex::new(hologram_graph::data_dir(&root).join("vectors.usearch"));
        vi.build(&nodes).expect("build index");
        vi.save().expect("save index");

        // 检索核心：查询词与 parse_widget 的 snippet 强相关
        let raw = vector_query_hits(&root, "parse widget configuration yaml", 10).expect("hits");
        assert!(!raw.is_empty(), "必须有命中");

        // 节点解析：MemoryIndex 直测（with_store 依赖 engine 全局态，单测不可用）
        let mut idx = hologram_storage::MemoryIndex::default();
        for n in &nodes {
            idx.insert_node(n.clone());
        }
        let hits = hologram_vector::filter_hits(&raw, 0.0, 5, &std::collections::HashSet::new());
        let resolved = resolve_hits_in_index(&idx, &hits);
        assert!(!resolved.is_empty());
        assert!(resolved[0].get("vector_score").is_some(), "结果必须带 vector_score");
        let names: Vec<&str> = resolved.iter().filter_map(|v| v["name"].as_str()).collect();
        assert!(names.contains(&"parse_widget"), "top 命中应含 parse_widget: {:?}", names);
        let _ = std::fs::remove_dir_all(&root);
    }
}



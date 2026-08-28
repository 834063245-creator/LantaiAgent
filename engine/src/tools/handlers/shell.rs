// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 壳专属方法（engine-plugin-extraction Phase 1）——host API，永不进模型
//! `tools/list`。契约真源：`crate::contract::SHELL_METHODS`（v2，10 方法）。
//!
//! hidden 机制与 `symbol_history` 同型：schema 注册进 `all_schemas` 但不进
//! `DEFAULT_MCP_TOOLS` —— tools/list 不可见、tools/call 可达；契约守卫
//! （引擎 4 用例 + `src-ui/tests/engine-contract.test.ts` 5 用例）钉住两层不串。
//!
//! watcher 推送：事件桥在 `engine::watcher`（进程级队列，自动 watcher 自带
//! 回调），本模块只负责「确保 watcher 在跑」（ensure_watching，不重启——
//! notify 同目录重注册存在事件丢失窗口）与 `take_watcher_events` 转发。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::engine;
use crate::engine::Engine;
use crate::tools::{get_str, get_usize, project_root};
use crate::tools::ToolResponse;

// ═══════════════════════════════════════════════════════════════
// watcher 订阅（ensure,不重启）
// ═══════════════════════════════════════════════════════════════

/// 确保 watcher 在跑（回调随实例永驻 —— maybe_autostart_watcher 已带
/// 进程级事件桥，这里只在未监听时补起，绝不 stop+start 重启）。
pub(crate) fn ensure_watching(engine: &Engine, root: PathBuf) {
    if !engine.is_watching() {
        engine.start_watcher(
            root,
            Some(Box::new(crate::engine::watcher::push_watcher_event)),
        );
    }
}

// ═══════════════════════════════════════════════════════════════
// 图数据面：graph_snapshot / file_nodes
// ═══════════════════════════════════════════════════════════════

/// 聚合快照 —— 契约 v2 的 graphData 消费面：进程外形态下前端不搬原始图，
/// nodes/edges 计数、kind/边类型分布、社区规模、top 扇入/扇出一次返回。
/// 聚合逻辑单一真源 = `tools::graph_snapshot_value`（壳侧内嵌形态同源复用）。
pub(crate) fn handler_graph_snapshot(_args: &Value) -> ToolResponse {
    match engine::engine_read(|idx| {
        let g = engine::graph_from_index(idx);
        crate::tools::graph_snapshot_value(&g, &project_root().to_string_lossy())
    }) {
        Ok(v) => ToolResponse::Success(v),
        Err(e) => ToolResponse::Fault {
            message: format!("graph_snapshot failed: {e}"),
            retry: false,
        },
    }
}

/// 按文件返回符号索引 —— 取代壳侧 buildFileNodeIndex 的全量构建
///（Phase 1.5 起前端 GraphContext.getNodesInFile 每文件一次轻查询）。
/// 匹配逻辑单一真源 = `tools::file_nodes_value`（壳侧内嵌形态同源复用）。
pub(crate) fn handler_file_nodes(args: &Value) -> ToolResponse {
    let file = get_str(args, &["file", "path"]);
    if file.is_empty() {
        return ToolResponse::Degraded {
            guidance: "file is required".into(),
            fallback: "Provide the file path (relative to project root or absolute)".into(),
            details: json!({}),
        };
    }
    match engine::engine_read(|idx| {
        let g = engine::graph_from_index(idx);
        crate::tools::file_nodes_value(&g, &project_root().to_string_lossy(), &file)
    }) {
        Ok(v) => ToolResponse::Success(v),
        Err(e) => ToolResponse::Fault {
            message: format!("file_nodes failed: {e}"),
            retry: false,
        },
    }
}

// ═══════════════════════════════════════════════════════════════
// 生命周期：analyze_with_progress / ensure_ready / cache_stale / save
// ═══════════════════════════════════════════════════════════════

/// 全量分析（后台）—— 进度经 `notifications/progress` 推送
///（mcp.rs 空闲轮询引擎状态机；`is_long_running` 已列入本方法）。
/// path 必填 —— 与 analyze_project 同纪律：显式根，杜绝兜底误分析。
pub(crate) fn handler_analyze_with_progress(args: &Value) -> ToolResponse {
    let root: PathBuf = match get_str(args, &["path"]) {
        p if !p.is_empty() => PathBuf::from(p),
        _ => {
            return ToolResponse::Degraded {
                guidance: "path is required".into(),
                fallback: "Provide the project root directory path".into(),
                details: json!({}),
            };
        }
    };
    if !root.exists() {
        return ToolResponse::Degraded {
            guidance: format!("Path not found: {}", root.display()),
            fallback: "Verify the path exists and try again".into(),
            details: json!({}),
        };
    }
    if let Err(e) = engine::engine_init(&root) {
        return ToolResponse::Degraded {
            guidance: format!("Engine init failed: {e}"),
            fallback: "Check engine logs and retry".into(),
            details: json!({}),
        };
    }
    if engine::engine_state().is_analyzing() {
        return ToolResponse::Success(json!({
            "status": "already_running",
            "message": "Analysis already in progress; progress arrives via notifications/progress.",
        }));
    }
    let spawn_root = root.clone();
    std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            if engine::engine_analyze(&spawn_root).is_ok() {
                engine::with_engine(|eng| {
                    ensure_watching(eng, spawn_root.clone());
                });
            }
        })
        .ok();
    ToolResponse::Success(json!({
        "status": "started",
        "project_root": root.to_string_lossy(),
        "message": "Analysis running in background; progress arrives via notifications/progress.",
    }))
}

/// 确保引擎就绪 —— 同根幂等（Engine::init no-op）、异根拒绝
///（引擎进程绑定单根，异根消费方起新进程）。返回就绪状态供宿主
/// 决定下一步（ready=false 时调 analyze_with_progress）。
pub(crate) fn handler_ensure_ready(args: &Value) -> ToolResponse {
    let requested = get_str(args, &["path"]);
    let bound = project_root();
    if !requested.is_empty() && !same_root(Path::new(&requested), &bound) {
        return ToolResponse::Refused {
            reason: format!(
                "engine is bound to {} — a different project root requires a separate engine process",
                bound.display()
            ),
        };
    }
    if let Err(e) = engine::engine_init(&bound) {
        return ToolResponse::Fault {
            message: format!("ensure_ready: {e}"),
            retry: false,
        };
    }
    let (nodes, edges) = engine::engine_read(|idx| (idx.node_count(), idx.edge_count()))
        .unwrap_or((0, 0));
    ToolResponse::Success(json!({
        "ready": nodes > 0,
        "node_count": nodes,
        "edge_count": edges,
        "project_root": bound.to_string_lossy(),
        "watching": engine::with_engine(|e| e.is_watching()).unwrap_or(false),
    }))
}

/// 根路径等价（canonicalize 优先，串比较兜底；Windows 大小写不敏感）。
fn same_root(a: &Path, b: &Path) -> bool {
    if let (Ok(x), Ok(y)) = (a.canonicalize(), b.canonicalize()) {
        return x == y;
    }
    a.to_string_lossy()
        .replace('/', "\\")
        .eq_ignore_ascii_case(&b.to_string_lossy().replace('/', "\\"))
}

/// 图是否过期 —— 壳侧冷启动 fast path 的判定原语（graph_io cache_is_stale
/// 的引擎侧化，Phase 1.5 起核心在 `tools::staleness::compute_cache_stale`，
/// 壳层内嵌形态同源复用）。
pub(crate) fn handler_cache_stale(args: &Value) -> ToolResponse {
    let root: PathBuf = match get_str(args, &["path"]) {
        p if !p.is_empty() => PathBuf::from(p),
        _ => project_root(),
    };
    if !root.exists() {
        return ToolResponse::Degraded {
            guidance: format!("Path not found: {}", root.display()),
            fallback: "Verify the path exists and try again".into(),
            details: json!({}),
        };
    }
    let generated_at_ms: Option<u64> =
        engine::with_engine(|e| e.graph_generated_at().ok().flatten())
            .unwrap_or(None)
            .and_then(|s| s.parse().ok());
    let r = crate::tools::staleness::compute_cache_stale(&root, generated_at_ms);
    ToolResponse::Success(json!({
        "stale": r.stale,
        "reason": r.reason,
        "baseline": r.baseline,
    }))
}

/// 持久化 store 到磁盘（.lantai/hologram.db）。
pub(crate) fn handler_save(_args: &Value) -> ToolResponse {
    match engine::engine_save() {
        Ok(()) => ToolResponse::Success(json!({ "saved": true })),
        Err(e) => ToolResponse::Fault {
            message: format!("save failed: {e}"),
            retry: true,
        },
    }
}

// ═══════════════════════════════════════════════════════════════
// 检索 / 时间线 / diff / watcher 订阅
// ═══════════════════════════════════════════════════════════════

/// FTS5 全文搜索（内容级，区别于 search_symbols 的符号名模糊）。
pub(crate) fn handler_fts_search(args: &Value) -> ToolResponse {
    let query = get_str(args, &["query"]);
    if query.is_empty() {
        return ToolResponse::Degraded {
            guidance: "query is required".into(),
            fallback: "Provide a full-text search query".into(),
            details: json!({}),
        };
    }
    let limit = get_usize(args, "limit", 20);
    match engine::with_engine(|eng| eng.fts_search(&query, limit)) {
        Some(Ok(nodes)) => {
            let results: Vec<Value> = nodes
                .iter()
                .map(|n| {
                    json!({
                        "id": n.id, "name": n.name, "kind": n.kind.as_str(),
                        "location": n.location,
                    })
                })
                .collect();
            ToolResponse::Success(json!({ "query": query, "count": results.len(), "results": results }))
        }
        Some(Err(e)) => ToolResponse::Fault {
            message: format!("fts_search failed: {e}"),
            retry: false,
        },
        None => ToolResponse::Fault {
            message: "engine not initialized".into(),
            retry: false,
        },
    }
}

/// 记录时间线事件（写动作）。event 必填；detail/node_id/props 可选。
pub(crate) fn handler_timeline_record(args: &Value) -> ToolResponse {
    let event = get_str(args, &["event"]);
    if event.is_empty() {
        return ToolResponse::Degraded {
            guidance: "event is required".into(),
            fallback: "Provide a timeline event name".into(),
            details: json!({}),
        };
    }
    let detail = get_str(args, &["detail", "summary"]);
    let node_id = get_str(args, &["node_id", "nodeId"]);
    let props = args.get("props").cloned().unwrap_or_else(|| json!({}));
    let summary = if detail.is_empty() { event.as_str() } else { detail.as_str() };
    match engine::engine_record_timeline_with_props(&event, Some(node_id.as_str()), summary, &props) {
        Ok(()) => ToolResponse::Success(json!({ "recorded": true, "event": event })),
        Err(e) => ToolResponse::Fault {
            message: format!("timeline_record failed: {e}"),
            retry: false,
        },
    }
}

/// 基线 diff —— baseline.json（缺省 `<root>/.lantai/baseline.json`，可传
/// baseline_path 覆盖）与当前图比对。JSON 形态与旧壳侧 diff_to_json 一致
///（契约面稳定）。
pub(crate) fn handler_diff(args: &Value) -> ToolResponse {
    let baseline_path = get_str(args, &["baseline_path", "baselinePath"]);
    let root = project_root();
    let before: hologram_graph::Graph = if baseline_path.is_empty() {
        crate::routing::preflight::load_baseline(&root)
    } else {
        std::fs::read_to_string(&baseline_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    };
    match engine::engine_read(|idx| {
        let after = engine::graph_from_index(idx);
        let d = before.diff(&after);
        let added_nodes: Vec<Value> = d
            .added_nodes
            .iter()
            .map(|n| json!({"id": n.id, "name": n.name, "type": n.kind.as_str(), "location": n.location}))
            .collect();
        let removed_nodes: Vec<Value> = d
            .removed_nodes
            .iter()
            .map(|n| json!({"id": n.id, "name": n.name, "type": n.kind.as_str()}))
            .collect();
        let modified_nodes: Vec<Value> = d
            .modified_nodes
            .iter()
            .map(|(old, new)| json!({
                "node_id": new.id, "name": new.name,
                "old_kind": old.kind.as_str(), "new_kind": new.kind.as_str(),
            }))
            .collect();
        let is_empty = added_nodes.is_empty() && removed_nodes.is_empty() && modified_nodes.is_empty();
        json!({
            "is_empty": is_empty,
            "added_nodes": added_nodes,
            "removed_nodes": removed_nodes,
            "modified_nodes": modified_nodes,
            "added_edges": d.added_edges.len(),
            "removed_edges": d.removed_edges.len(),
        })
    }) {
        Ok(v) => ToolResponse::Success(v),
        Err(e) => ToolResponse::Fault {
            message: format!("diff failed: {e}"),
            retry: false,
        },
    }
}

/// 订阅 watcher 通知 —— 确保 watcher 以事件桥回调运行（回调随实例永驻，
/// 这里只 ensure 不重启）。变更摘要经 `notifications/message` 推送
/// （data = JSON 串），graph-updated 语义由宿主转译。
pub(crate) fn handler_watcher_subscribe(_args: &Value) -> ToolResponse {
    let root = project_root();
    match engine::with_engine(|eng| {
        ensure_watching(eng, root.clone());
        eng.is_watching()
    }) {
        Some(watching) => ToolResponse::Success(json!({
            "subscribed": true,
            "watching": watching,
            "transport": "notifications/message",
        })),
        None => ToolResponse::Fault {
            message: "engine not initialized".into(),
            retry: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::watcher::take_watcher_events;
    use crate::engine::{engine_bind_global_shared, engine_init, global_engine_test_guard, with_engine};
    use serde_json::json;
    use std::sync::Arc;

    fn tmp_root(tag: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "hologram_shell_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    fn resp_text(resp: &ToolResponse) -> String {
        let v = resp.to_mcp_value(&json!(1));
        v["result"]["content"][0]["text"].as_str().unwrap_or("").to_string()
    }

    /// 裸实例换绑全局槽（无 watcher；需要 watcher 的用例自行 start）。
    fn bind_test_engine(root: &Path) {
        let eng = Engine::open(root).expect("open test engine");
        engine_bind_global_shared(Arc::new(eng));
    }

    /// 写源文件 + engine_init（全局共享实例）+ 全量分析。
    fn seed_graph(root: &Path, files: &[(&str, &str)]) {
        for (rel, body) in files {
            let p = root.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, body).unwrap();
        }
        engine_init(root).expect("engine_init");
        with_engine(|e| {
            e.analyze(root).expect("analyze");
        });
    }

    // ── graph_snapshot ──

    #[test]
    fn test_graph_snapshot_counts_and_kinds() {
        let _guard = global_engine_test_guard();
        let root = tmp_root("snapshot");
        seed_graph(
            &root,
            &[("alpha.rs", "fn alpha_one() {}\nstruct AlphaTwo;\n")],
        );
        let v = serde_json::from_str::<Value>(&resp_text(&handler_graph_snapshot(&json!({}))))
            .expect("snapshot json");
        assert!(v["node_count"].as_u64().unwrap_or(0) > 0, "非空图必须有节点: {v}");
        let kind_sum: u64 = v["kind_counts"]
            .as_object()
            .map(|m| m.values().filter_map(|x| x.as_u64()).sum())
            .unwrap_or(0);
        assert_eq!(v["node_count"].as_u64(), Some(kind_sum), "kind_counts 求和应等于 node_count");
        assert!(v["edge_kind_counts"].is_object());
        assert!(v["top_fan_in"].is_array() && v["top_fan_out"].is_array());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_graph_snapshot_empty_engine_is_zeroed_not_error() {
        let _guard = global_engine_test_guard();
        let root = tmp_root("snapshot_empty");
        bind_test_engine(&root);
        let v = serde_json::from_str::<Value>(&resp_text(&handler_graph_snapshot(&json!({}))))
            .expect("snapshot json");
        assert_eq!(v["node_count"].as_u64(), Some(0));
        assert_eq!(v["edge_count"].as_u64(), Some(0));
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── file_nodes ──

    #[test]
    fn test_file_nodes_returns_symbols_for_file() {
        let _guard = global_engine_test_guard();
        let root = tmp_root("filenodes");
        seed_graph(
            &root,
            &[
                ("src/alpha.rs", "fn alpha_one() {}\nstruct AlphaTwo;\n"),
                ("src/beta.rs", "fn beta_one() {}\n"),
            ],
        );
        for arg in ["src/alpha.rs", "src\\alpha.rs"] {
            let v = serde_json::from_str::<Value>(
                &resp_text(&handler_file_nodes(&json!({ "file": arg }))),
            )
            .expect("file_nodes json");
            let names: Vec<String> = v["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|n| n["name"].as_str().map(String::from))
                .collect();
            assert!(
                !names.is_empty() && names.iter().all(|n| n.to_lowercase().contains("alpha")),
                "{arg} 应只含 alpha.rs 的符号: {names:?}"
            );
            assert!(
                v["nodes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|n| n["fan_in"].is_number() && n["fan_out"].is_number()),
                "每条符号必须带 fan_in/fan_out"
            );
        }
        // beta.rs 不应混入 alpha 查询
        let v = serde_json::from_str::<Value>(
            &resp_text(&handler_file_nodes(&json!({ "file": "src/beta.rs" }))),
        )
        .expect("file_nodes json");
        let names: Vec<String> = v["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|n| n["name"].as_str().map(String::from))
            .collect();
        assert!(!names.is_empty() && names.iter().all(|n| n.to_lowercase().contains("beta")), "beta.rs 查询不得串入 alpha 符号: {names:?}");
        // 无关文件 → 0 命中而不是错误
        let v = serde_json::from_str::<Value>(
            &resp_text(&handler_file_nodes(&json!({ "file": "src/none.rs" }))),
        )
        .expect("file_nodes json");
        assert_eq!(v["count"].as_u64(), Some(0));
        // 缺参 → 降级
        assert!(resp_text(&handler_file_nodes(&json!({}))).contains("_isDegraded"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── ensure_ready / cache_stale ──

    #[test]
    fn test_ensure_ready_reports_not_ready_on_empty_engine() {
        let _guard = global_engine_test_guard();
        let root = tmp_root("ensure");
        bind_test_engine(&root);
        let v = serde_json::from_str::<Value>(&resp_text(&handler_ensure_ready(&json!({}))))
            .expect("ensure_ready json");
        assert_eq!(v["ready"].as_bool(), Some(false));
        assert_eq!(v["node_count"].as_u64(), Some(0));
        // 异根 → 拒绝
        let other = tmp_root("ensure_other");
        let refused = handler_ensure_ready(&json!({ "path": other.to_string_lossy() }));
        assert!(matches!(refused, ToolResponse::Refused { .. }), "异根必须拒绝");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn test_cache_stale_handler_shape() {
        let _guard = global_engine_test_guard();
        let root = tmp_root("stale_handler");
        bind_test_engine(&root);
        let v = serde_json::from_str::<Value>(&resp_text(&handler_cache_stale(&json!({}))))
            .expect("cache_stale json");
        assert!(v["stale"].is_boolean() && v["baseline"].is_string());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── save / fts_search / timeline_record ──

    #[test]
    fn test_save_and_fts_and_timeline() {
        let _guard = global_engine_test_guard();
        let root = tmp_root("persist");
        seed_graph(&root, &[("alpha.rs", "fn alpha_one() { let marker = 1; }\n")]);
        // save
        let v = serde_json::from_str::<Value>(&resp_text(&handler_save(&json!({})))).expect("save json");
        assert_eq!(v["saved"].as_bool(), Some(true));
        // fts_search（FTS5 内容级；analyze 填充索引后应命中）
        let v = serde_json::from_str::<Value>(
            &resp_text(&handler_fts_search(&json!({ "query": "marker", "limit": 5 }))),
        )
        .expect("fts json");
        assert!(v["results"].is_array());
        if v["count"].as_u64().unwrap_or(0) > 0 {
            let first = &v["results"][0];
            assert!(first["id"].is_string() && first["name"].is_string(), "命中项必须带 id/name: {first}");
        }
        // timeline_record
        let v = serde_json::from_str::<Value>(
            &resp_text(&handler_timeline_record(&json!({ "event": "shell_test", "detail": "记录一条", "node_id": "alpha.rs:1" }))),
        )
        .expect("timeline json");
        assert_eq!(v["recorded"].as_bool(), Some(true));
        assert!(resp_text(&handler_timeline_record(&json!({}))).contains("_isDegraded"), "缺 event 必须降级");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── diff ──

    #[test]
    fn test_diff_against_saved_baseline() {
        let _guard = global_engine_test_guard();
        let root = tmp_root("diff");
        seed_graph(&root, &[("alpha.rs", "fn alpha_one() {}\n")]);
        let baseline = engine::engine_read(engine::graph_from_index).expect("read graph");
        crate::routing::preflight::save_baseline(&root, &baseline);
        // 基线之后新增符号 → diff 非空
        std::fs::write(root.join("beta.rs"), "fn beta_one() {}\n").unwrap();
        with_engine(|e| {
            e.analyze(&root).expect("re-analyze");
        });
        let v = serde_json::from_str::<Value>(&resp_text(&handler_diff(&json!({})))).expect("diff json");
        assert_eq!(v["is_empty"].as_bool(), Some(false), "新增 beta_one 后 diff 不应为空: {v}");
        assert!(
            v["added_nodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|n| n["name"].as_str() == Some("beta_one")),
            "added_nodes 应含 beta_one: {v}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── watcher_subscribe（事件桥）──

    /// 桥链路端到端（确定性，不经 OS watcher/防抖）：回调随实例永驻
    /// （maybe_autostart 已带进程级桥），增量更新完成 → 桥回调 push →
    /// take_watcher_events 可取。并行敏感性说明：真实 FS 事件路径受
    /// 同进程其他测试的 notify 干扰（全量跑偶发丢事件），故增量走
    /// pub API try_incremental —— 它与 OS watcher 共享同一条
    /// handle_watcher_changes → on_change 链路。
    #[test]
    fn test_watcher_subscribe_bridges_events() {
        let _guard = global_engine_test_guard();
        let root = tmp_root("watcher");
        seed_graph(&root, &[("alpha.rs", "fn alpha_one() {}\n")]);
        let v = serde_json::from_str::<Value>(&resp_text(&handler_watcher_subscribe(&json!({}))))
            .expect("watcher json");
        assert_eq!(v["subscribed"].as_bool(), Some(true));
        assert_eq!(v["transport"].as_str(), Some("notifications/message"));
        assert_eq!(v["watching"].as_bool(), Some(true), "subscribe 后 watcher 必须在跑");
        // 触发一次真实增量更新（源文件已变更）→ 防抖之后的同一条链路
        std::fs::write(root.join("alpha.rs"), "fn alpha_changed() {}\n").unwrap();
        with_engine(|e| {
            e.try_incremental(&root, &[(root.join("alpha.rs"), "modified".to_string())])
                .expect("incremental update");
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut got = false;
        while std::time::Instant::now() < deadline {
            if !take_watcher_events().is_empty() {
                got = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        with_engine(|e| e.stop_watcher());
        assert!(got, "增量更新完成后事件必须入队（桥接通）");
        let _ = std::fs::remove_dir_all(&root);
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 引擎图 IO — 分析/快照/索引查询（engine-plugin-extraction Phase 1.5 缩水：
// 图分页运输栈整链删除——分页只为已退役 3D 星图 + IPC 128MB 护栏服务的双重
// 死代码；graphData 改为轻量聚合快照，跨边界只传聚合面与按文件查询）。

use hologram_engine as engine;
use tauri::Emitter;

use crate::utils::regenerate_file_graph;

/// 全量/缓存分析（L1 起显式引擎版）：engine 必须已 init 到 path
/// （数据上下文 ensure 时完成）。返回轻状态 JSON——不再序列化全量图
/// （前端 graphData = get_graph_snapshot 聚合查询，不再消费分析返回的图体）。
pub(crate) fn direct_analyze(
    engine: &engine::engine::Engine,
    path: &str,
    force: bool,
) -> Result<String, String> {
    let root = std::path::PathBuf::from(path);
    if !root.exists() {
        return Err(format!("路径不存在: {path}"));
    }

    // ponytail: 如果 SQLite 缓存已有图数据且未强制重新分析，
    // 则跳过完整流水线。冷启动约需 420s；热重载 <1s。
    // 但首先需验证缓存新鲜度 — 若任何源文件在上次分析后被修改，
    // 缓存已过期，必须重建。否则在兰台外部所做的代码修改
    // （例如在 VS Code 中跨会话修改）将静默不可见，直到用户手动点击"重新分析"。
    if !force {
        let cached_node_count = engine.read(|idx| idx.node_count()).unwrap_or(0);
        if cached_node_count > 0 && !cache_stale(engine, &root) {
            eprintln!("[direct_analyze] 使用缓存图 ({cached_node_count} 个节点)，跳过完整分析");
            return Ok(serde_json::json!({
                "status": "ok", "cached": true, "total_nodes": cached_node_count,
                "node_count": cached_node_count,
                "edge_count": engine.read(|idx| idx.edge_count()).unwrap_or(0),
            }).to_string());
        }
    } // if !force 结束

    let result = engine
        .analyze(&root)
        .map_err(|e| format!("Analyze failed: {e}"))?;

    // result.graph 已被引擎消费（节点/边已移至 MemoryIndex/store）。
    // 图数据统一从 store 读（get_graph_snapshot 聚合查询），这里只留标量。
    let nc = result.node_count;
    let ec = result.edge_count;

    // 每次全量分析后都更新基线，使后续检查
    // 与最新快照进行对比 — 防止基线过期导致的误报
    // （例如图结构在两次分析间演化时出现"53 个新循环"）。
    let _ = engine.read(|idx| {
        let g = engine::engine::graph_from_index(idx);
        engine::routing::preflight::save_baseline(&root, &g)
    });
    // hologram_graph.json 归档已退役（Phase 1.5）：SQLite 是唯一持久化，
    // 快照按需算——冷启动缓存路径改走 get_graph_snapshot。
    let _ = std::fs::remove_file(format!("{}/hologram_graph.json", path));
    // .hologram MsgPack 已废弃 — MemoryIndex 是唯一的运行时真相
    let _ = std::fs::remove_file(format!("{}/hologram_graph.hologram", path));
    let _ = regenerate_file_graph(path);

    // 记录时间线事件（与引擎二进制的 handle_analyze 对应）
    let _ = engine.record_timeline(
        "analyze",
        None::<&str>,
        &format!("全量分析完成：{} 节点, {} 边, {:.1}s", nc, ec, result.elapsed_secs),
    );

    Ok(serde_json::json!({
        "status": "ok", "cached": false, "total_nodes": nc, "total_edges": ec,
        "communities": result.community_count, "elapsed_secs": result.elapsed_secs,
        "node_count": nc, "edge_count": ec,
    }).to_string())
}

/// 缓存新鲜度（薄包装）：核心在引擎 `tools::staleness::compute_cache_stale`
/// （单一真源，壳方法 cache_stale 同源）；基准 = graph_generated_at，
/// 无 meta 回退 .lantai/hologram.db mtime。
fn cache_stale(engine: &engine::engine::Engine, root: &std::path::Path) -> bool {
    let generated_at_ms: Option<u64> = engine
        .graph_generated_at()
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok());
    engine::tools::staleness::compute_cache_stale(root, generated_at_ms).stale
}

/// 聚合快照 JSON —— graphData 的唯一装载形态（Phase 1.5）：计数/kind 分布/
/// 边类型分布/社区规模/top 扇入扇出。聚合逻辑单一真源 =
/// `hologram_engine::tools::graph_snapshot_value`（与引擎 graph_snapshot
/// 壳方法同构同源；Phase 2 transport 后壳侧改经 MCP 调同一方法）。
pub(crate) fn graph_snapshot_json(
    engine: &engine::engine::Engine,
) -> Result<String, String> {
    let root = engine.project_root().to_string_lossy().to_string();
    engine
        .read(|idx| {
            let g = engine::engine::graph_from_index(idx);
            serde_json::to_string(&engine::tools::graph_snapshot_value(
                &g,
                &engine::path_utils::normalize_path(&root),
            ))
            .unwrap_or_default()
        })
        .map_err(|e| format!("Engine error: {e}"))
}

pub(crate) async fn run_analyze_with_progress(
    engine: std::sync::Arc<engine::engine::Engine>,
    target: String,
    app: tauri::AppHandle,
    force: bool,
) -> Result<String, String> {
    let target_clone = target.clone();
    let app_clone = app.clone();
    let scheduled = std::time::Instant::now();

    // 在阻塞线程中启动分析
    let engine_for_task = engine.clone();
    let mut analyze_handle = tokio::task::spawn_blocking(move || {
        direct_analyze(&engine_for_task, &target_clone, force)
    });

    // 轮询进度直到阻塞任务完成（不要在 Ready 时提前退出 —
    // 排队中的分析在 analyze_lock 上等待，此时状态保持 Ready）。
    loop {
        tokio::select! {
            res = &mut analyze_handle => {
                match res {
                    Ok(result) => return result,
                    Err(e) => return Err(format!("分析任务失败: {}", e)),
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                let state = engine.state();
                match state {
                    engine::engine::EngineState::Analyzing { phase, current, total, file, started_at_ms, .. } => {
                        let _ = app_clone.emit("analyze-phase", serde_json::json!({
                            "phase": phase.clone(),
                            "message": phase,
                        }));
                        if total > 0 {
                            let _ = app_clone.emit("analyze-progress", serde_json::json!({
                                "current": current,
                                "total": total,
                                "file": file,
                            }));
                        }
                        let now_ms = chrono::Utc::now().timestamp_millis() as u64;
                        let elapsed = now_ms.saturating_sub(started_at_ms);
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": phase,
                            "elapsed": format!("{:.1}s", elapsed as f64 / 1000.0),
                        }));
                    }
                    _ => {
                        let elapsed_s = scheduled.elapsed().as_secs_f64();
                        let _ = app_clone.emit("analyze-heartbeat", serde_json::json!({
                            "label": "等待分析引擎",
                            "elapsed": format!("{:.1}s", elapsed_s),
                        }));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "hologram_shell_graphio_{}_{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    /// direct_analyze 轻状态契约：缓存快路径与全量路径都只回标量，
    /// 不再序列化全量 nodes/edges（graphData 改快照装载的根基）。
    #[test]
    fn direct_analyze_returns_lightweight_status() {
        let tmp = tmp_root("light");
        std::fs::write(tmp.join("a.rs"), "fn a_one() {}\n").unwrap();
        let eng = hologram_engine::engine::Engine::open(&tmp).unwrap();
        let full = direct_analyze(&eng, tmp.to_str().unwrap(), true).unwrap();
        let v: serde_json::Value = serde_json::from_str(&full).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["cached"], false);
        assert!(v["node_count"].as_u64().unwrap() > 0);
        assert!(v.get("nodes").is_none(), "全量路径不得回传图体");
        // 缓存快路径
        let cached = direct_analyze(&eng, tmp.to_str().unwrap(), false).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&cached).unwrap();
        assert_eq!(v2["cached"], true);
        assert!(v2.get("nodes").is_none());
        // 归档 JSON 不再产出
        assert!(!tmp.join("hologram_graph.json").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 快照组装契约：与引擎 graph_snapshot 壳方法同构（计数/分布/top 扇入）。
    #[test]
    fn graph_snapshot_json_shape() {
        let tmp = tmp_root("snap");
        std::fs::write(tmp.join("a.rs"), "fn a_one() {}\n").unwrap();
        let eng = hologram_engine::engine::Engine::open(&tmp).unwrap();
        direct_analyze(&eng, tmp.to_str().unwrap(), true).unwrap();
        let raw = graph_snapshot_json(&eng).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(v["node_count"].as_u64().unwrap() > 0);
        assert!(v["kind_counts"].is_object());
        assert!(v["top_fan_in"].is_array());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

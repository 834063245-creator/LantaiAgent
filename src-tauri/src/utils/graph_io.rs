// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 引擎图 IO —— Phase 3（engine-plugin-extraction 摘依赖）后本模块只剩
// 分析编排的壳侧等待循环：分析本体（含缓存新鲜度门 / 基线推进 / 完成桥
// 推送）已上收引擎 `analyze_with_progress` 壳方法（契约 v3）；
// 聚合快照与新鲜度单一真源在引擎（graph_snapshot / cache_stale）。

use tauri::Emitter;

/// 分析编排（transport 形态，Phase 3 自 direct_analyze + 轮询重写）：
/// 1. 发起 `analyze_with_progress`（引擎侧新鲜缓存 → 直接回 cached，
///    不重分析——与旧 direct_analyze 缓存快路径逐语义等价）；
/// 2. 轮询 `engine_status` 等待分析完成（进度事件流由工作区 pump 从
///    notifications/progress 转译，本循环不再本地轮询引擎状态机）；
/// 3. 完成后 `graph_snapshot` 重查 → emit `graph-updated`（前端 warming
///    清理与快照刷新的确定性信号——旧形态 watcher 只覆盖增量路径，
///    全量分析完成后快照从不重拉，本步一并补直）。
pub(crate) async fn run_analyze_with_progress(
    transport: std::sync::Arc<crate::engine_transport::McpRemoteTransport>,
    target: String,
    app: tauri::AppHandle,
    force: bool,
) -> Result<String, String> {
    let started = std::time::Instant::now();

    // 1. 发起（started / already_running / cached）
    let t = transport.clone();
    let target_for_call = target.clone();
    let resp = tokio::task::spawn_blocking(move || {
        t.call(
            "analyze_with_progress",
            &serde_json::json!({ "path": target_for_call, "force": force }),
        )
    })
    .await
    .map_err(|e| format!("分析任务失败: {e}"))??;

    let v: serde_json::Value = serde_json::from_str(&resp).unwrap_or(serde_json::json!({}));
    if v.get("status").and_then(|s| s.as_str()) == Some("cached") {
        // 新鲜缓存：load_graph_json 已装载快照，无需等待与推送
        return Ok(resp);
    }

    // 2. 等待分析完成（engine_status.phase 离开 analyzing）
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let t = transport.clone();
        let raw = tokio::task::spawn_blocking(move || {
            t.call("engine_status", &serde_json::json!({}))
        })
        .await
        .map_err(|e| format!("分析任务失败: {e}"))??;
        let st: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
        let phase = st.get("phase").and_then(|p| p.as_str()).unwrap_or("ready");
        if phase != "analyzing" {
            break;
        }
        if started.elapsed() > std::time::Duration::from_secs(3600) {
            return Err("分析超时（3600s）".into());
        }
    }

    // 3. 快照重查 → graph-updated（确定性信号，双保险于 pump 的
    //    analyze_done 转译——pump 可能晚于本 RPC 启动）
    let t = transport.clone();
    let snap = tokio::task::spawn_blocking(move || {
        t.call("graph_snapshot", &serde_json::json!({}))
    })
    .await
    .map_err(|e| format!("分析任务失败: {e}"))??;
    let sv: serde_json::Value = serde_json::from_str(&snap).unwrap_or(serde_json::json!({}));
    let nc = sv.get("node_count").and_then(|x| x.as_u64()).unwrap_or(0);
    let ec = sv.get("edge_count").and_then(|x| x.as_u64()).unwrap_or(0);
    let _ = app.emit(
        "graph-updated",
        serde_json::json!({
            "total_nodes": nc,
            "node_count": nc,
            "edge_count": ec,
            "meta": { "source_root": target },
        })
        .to_string(),
    );

    Ok(serde_json::json!({
        "status": "ok", "cached": false, "total_nodes": nc, "total_edges": ec,
        "node_count": nc, "edge_count": ec,
    })
    .to_string())
}

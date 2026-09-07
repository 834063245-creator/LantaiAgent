// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 图命令业务（L3 自 commands/graph.rs 迁入）。
//! 引擎一律经 AppContexts 决议（显式 path → 活动工作区单槽），
//! 不再以「会话/焦点投影」为决议依据（workspace-session-ownership-rework
//! 2026-08-27：会话只在所属工作区内打开）。
//!
//! engine-plugin-extraction Phase 1.5：图分页运输栈整链拆除——
//! graphData 改为轻量聚合快照（get_graph_snapshot / load_graph_json），
//! 按文件符号索引走 hologram_file_nodes 轻查询；跨边界不再传全量图体，
//! 128MB IPC 护栏问题消失。

use std::sync::Arc;

use crate::app::AppContexts;

/// 命令层传输解析：显式根优先，其后活动工作区（单槽）回退。
/// Phase 3 起唯一形态 = 每工作区一个引擎进程的 stdio MCP 通道。
pub(crate) fn resolve_transport(
    app_ctx: &Arc<AppContexts>,
    state: &crate::WorkspaceState,
    explicit: Option<&str>,
) -> Result<(std::sync::Arc<crate::engine_transport::McpRemoteTransport>, String), String> {
    let fallback = crate::utils::workspace_path(state).ok();
    let (transport, root) = app_ctx.resolve_transport(explicit, fallback.as_deref())?;
    let root = root.to_string_lossy().to_string();
    Ok((transport, root))
}

/// load_graph_json 业务体（Phase 1.5 重定义）：返回聚合快照 JSON。
/// 旧「分页 meta 优先 + 磁盘 hologram_graph.json 兜底」形态随分页栈退役
/// —— SQLite 是唯一持久化，快照按需算，跨边界不再传全量图体。
/// 候选根解析（path → 单槽 → .last_project）由壳层完成传入。
pub(crate) async fn load_graph_json(
    root: Option<String>,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let mut candidate: Option<String> = None;
    if let Some(ref p) = root {
        candidate = Some(p.clone());
    } else if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
        candidate = Some(handle.path.clone());
    }
    let root: Option<String> = match candidate {
        Some(r) => Some(r),
        None => {
            let last_path_file = crate::utils::project_root().join(".last_project");
            std::fs::read_to_string(&last_path_file)
                .ok()
                .map(|s| s.trim().to_string())
        }
    };
    let Some(root) = root else {
        return Err("No cached graph found".into());
    };
    if root.contains("..") || root.contains('\0') {
        return Err("路径包含非法字符".into());
    }
    // 引擎图（内存/SQLite 缓存）优先 — 传输接缝（Phase 2）：内嵌/进程外
    // 两形态同方法面（graph_snapshot / cache_stale），差分对拍钉等价。
    if let Ok((transport, root_disp)) = resolve_transport(&app_ctx, &state, Some(&root)) {
        let stale_transport = transport.clone();
        let stale_root = root_disp.clone();
        let stale = tokio::task::spawn_blocking(move || {
            let raw = stale_transport
                .call("cache_stale", &serde_json::json!({ "path": stale_root }))
                .unwrap_or_else(|_| r#"{"stale":false}"#.into());
            serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|v| v.get("stale").and_then(|b| b.as_bool()))
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false);
        if stale {
            eprintln!(
                "[hologram] ⚠ 冷启动：SQLite 缓存的图已过期（源文件在上次分析后被修改），将触发重新分析"
            );
        }
        let snap = tokio::task::spawn_blocking(move || transport.call("graph_snapshot", &serde_json::json!({})))
            .await
            .map_err(|e| format!("任务失败: {e}"))?
            ?;
        return Ok(snap);
    }
    Err("No cached graph found".into())
}

/// analyze_and_load 业务体：写 .last_project + 窗口标题（壳层）+ transport
/// 分析编排（graph_io::run_analyze_with_progress——发起 / 等待 / graph-updated）。
/// Phase 1.5：不再回分页 meta —— 前端分析完成后经 get_graph_snapshot
/// 装载快照，graph-updated 事件驱动后续刷新。
pub(crate) async fn analyze_and_load(
    path: String,
    force: bool,
    app: tauri::AppHandle,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let _ = std::fs::write(crate::utils::project_root().join(".last_project"), &path);

    // 目标根显式 → 数据上下文 + 传输句柄（引擎子进程惰性 spawn，
    // 全部 stdio 调用在 spawn_blocking 内）。
    let (transport, _root_disp) = resolve_transport(&app_ctx, &state, Some(&path))?;
    crate::utils::run_analyze_with_progress(transport, path, app, force).await
}

/// get_graph_snapshot 业务体：活动工作区（单槽）决议，返回聚合快照 JSON。
pub(crate) async fn get_graph_snapshot(
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let (transport, _root) = resolve_transport(&app_ctx, &state, None)?;
    let snap = tokio::task::spawn_blocking(move || {
        transport.call("graph_snapshot", &serde_json::json!({}))
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;
    crate::utils::guard_ipc_size(snap, "图谱快照")
}

/// hologram_file_nodes 业务体：按文件返回符号索引（id/name/kind/fanIn/fanOut）
/// —— 前端 GraphContext 的按文件轻查询（取代全量建索引）。
/// 匹配逻辑单一真源在引擎侧（file_nodes 壳方法消费的 file_nodes_value）。
pub(crate) async fn hologram_file_nodes(
    file: String,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let (transport, _root) = resolve_transport(&app_ctx, &state, None)?;
    tokio::task::spawn_blocking(move || {
        transport.call("file_nodes", &serde_json::json!({ "file": file }))
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

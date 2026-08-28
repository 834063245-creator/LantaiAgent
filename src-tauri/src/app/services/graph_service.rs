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

use hologram_engine::engine::Engine;

use crate::app::AppContexts;

/// 命令层引擎决议：显式根优先，其后活动工作区（单槽）回退。
/// 返回 (引擎, 根路径展示形)——引擎必属该根（ensure_context 语义）。
pub(crate) fn resolve(
    app_ctx: &Arc<AppContexts>,
    state: &crate::WorkspaceState,
    explicit: Option<&str>,
) -> Result<(Arc<Engine>, String), String> {
    let fallback = crate::utils::workspace_path(state).ok();
    let root = explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| fallback.clone());
    let engine = app_ctx
        .resolve_engine(explicit, fallback.as_deref())
        .ok_or_else(|| "未打开工作区，请先打开项目".to_string())?;
    let root = root.unwrap_or_else(|| {
        hologram_engine::path_utils::normalize_path(
            &engine.project_root().to_string_lossy(),
        )
    });
    Ok((engine, root))
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
    // 引擎图（内存/SQLite 缓存）优先 — ensure_context 只加载缓存不分析。
    if let Ok((engine, root_disp)) = resolve(&app_ctx, &state, Some(&root)).map(|(e, r)| (e.clone(), r)) {
        if crate::utils::ensure_engine_ready(&engine, &root_disp).is_ok() {
            // 冷启动新鲜度门禁：SQLite 缓存可能过期（源文件在上次分析后
            // 被修改）。过期时不阻断快照返回，但必须留痕 —— 前端紧随其后
            // 的 analyze_and_load(force=false) 触发重分析，graph-updated
            // 事件随后把图面换到最新快照。
            let stale = tokio::task::spawn_blocking({
                let engine = engine.clone();
                let root = root.clone();
                move || {
                    let generated_at_ms: Option<u64> = engine
                        .graph_generated_at()
                        .ok()
                        .flatten()
                        .and_then(|s| s.parse().ok());
                    hologram_engine::tools::staleness::compute_cache_stale(
                        std::path::Path::new(&root),
                        generated_at_ms,
                    )
                    .stale
                }
            })
            .await
            .unwrap_or(false);
            if stale {
                eprintln!(
                    "[hologram] ⚠ 冷启动：SQLite 缓存的图已过期（源文件在上次分析后被修改），将触发重新分析"
                );
            }
            let snap = tokio::task::spawn_blocking(move || crate::utils::graph_snapshot_json(&engine))
                .await
                .map_err(|e| format!("任务失败: {e}"))??;
            return Ok(snap);
        }
    }
    Err("No cached graph found".into())
}

/// analyze_and_load 业务体：写 .last_project + 窗口标题 + 分析 + 回轻状态。
/// （窗口标题联动留在壳层——UI 表现属通道职责，此处只做分析编排。）
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

    // L1：目标根显式 → 数据上下文（不存在则创建，引擎 init 落在 spawn_blocking 内）
    let (engine, _root_disp) = resolve(&app_ctx, &state, Some(&path))?;
    let analyze_future = crate::utils::run_analyze_with_progress(
        engine.clone(),
        path.clone(),
        app.clone(),
        force,
    );
    analyze_future.await.map_err(|e| format!("Rust 引擎分析失败: {e}"))?;

    let files_path = format!("{}/hologram_graph_files.json", path);
    if !std::path::Path::new(&files_path).exists() {
        let _ = crate::utils::regenerate_file_graph(&path);
    }
    Ok(serde_json::json!({ "status": "ok", "analyzed": true }).to_string())
}

/// get_graph_snapshot 业务体：活动工作区（单槽）决议，返回聚合快照 JSON。
pub(crate) async fn get_graph_snapshot(
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let (engine, root) = resolve(&app_ctx, &state, None)?;
    let snap = tokio::task::spawn_blocking(move || {
        crate::utils::ensure_engine_ready(&engine, &root)?;
        crate::utils::graph_snapshot_json(&engine)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;
    crate::utils::guard_ipc_size(snap, "图谱快照")
}

/// hologram_file_nodes 业务体：按文件返回符号索引（id/name/kind/fanIn/fanOut）
/// —— 前端 GraphContext 的按文件轻查询（取代全量建索引）。
/// 匹配逻辑单一真源 = `hologram_engine::tools::file_nodes_value`。
pub(crate) async fn hologram_file_nodes(
    file: String,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let (engine, root) = resolve(&app_ctx, &state, None)?;
    let value = tokio::task::spawn_blocking(move || {
        engine.read(|idx| {
            let g = hologram_engine::engine::graph_from_index(idx);
            hologram_engine::tools::file_nodes_value(
                &g,
                &hologram_engine::path_utils::normalize_path(&root),
                &file,
            )
        })
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
    .map_err(|e| format!("Engine error: {e}"))?;
    serde_json::to_string(&value).map_err(|e| format!("序列化失败: {e}"))
}

/// engine_impact 业务体：决议链命中最左；全空回落全局（MCP 时代语义）。
pub(crate) async fn engine_impact(
    node_id: String,
    max_depth: usize,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let fallback = crate::utils::workspace_path(&state).ok();
    match app_ctx.resolve_engine(None, fallback.as_deref()) {
        Some(engine) => {
            tokio::task::spawn_blocking(move || {
                crate::utils::with_index(&engine, move |idx| {
                    let layers = idx.impact(&node_id, max_depth);
                    serde_json::json!({"layers": layers})
                })
            })
            .await
            .map_err(|e| format!("任务失败: {e}"))?
        }
        None => tokio::task::spawn_blocking(move || {
            hologram_engine::engine::engine_read(|idx| {
                let layers = idx.impact(&node_id, max_depth);
                serde_json::to_string(&serde_json::json!({"layers": layers}))
                    .unwrap_or_default()
            })
            .map_err(|e| format!("Engine error: {e}"))
        })
        .await
        .map_err(|e| format!("任务失败: {e}"))?,
    }
}

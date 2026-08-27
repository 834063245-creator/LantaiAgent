// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 图命令业务（L3 自 commands/graph.rs 迁入，零语义改写）。
//! 引擎一律经 AppContexts 决议（显式 path → 活动工作区单槽），
//! 不再以「会话/焦点投影」为决议依据（workspace-session-ownership-rework
//! 2026-08-27：会话只在所属工作区内打开）。

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

/// load_graph_json 业务体：冷启动分页 meta 优先，磁盘 JSON 兜底。
/// 候选根解析（path → 单槽 → .last_project）由壳层完成传入。
pub(crate) async fn load_graph_json(
    root: Option<String>,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    // P0-2 分页化（landmine-map.md 雷 2）：冷启动优先返回引擎图 meta + 分页信息，
    // 不再一次性回传全量 JSON（大仓库 267MB 级会击穿 128MB IPC 护栏）。
    // 磁盘 hologram_graph.json 仅作无引擎缓存时的兜底（小图兼容旧路径）。
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
    if let Some(root) = root {
        if root.contains("..") || root.contains('\0') {
            return Err("路径包含非法字符".into());
        }
        // 引擎图（内存/SQLite 缓存）优先 — ensure_context 只加载缓存不分析。
        if let Ok((engine, root_disp)) = resolve(&app_ctx, &state, Some(&root)) {
            if crate::utils::ensure_engine_ready(&engine, &root_disp).is_ok() {
                // 冷启动新鲜度门禁（2026-08-18 修复）：SQLite 缓存可能过期
                // （源文件在上次分析后被修改）。过期时不阻断渲染，但必须留痕，
                // 由前端紧随其后的 analyze_and_load(force=false) 触发重分析，
                // graph-updated 事件随后把 UI 换到最新图。
                if crate::utils::cache_is_stale(&engine, std::path::Path::new(&root)) {
                    eprintln!(
                        "[hologram] ⚠ 冷启动：SQLite 缓存的图已过期（源文件在上次分析后被修改），将触发重新分析"
                    );
                }
                let page_default = crate::utils::GRAPH_PAGE_DEFAULT_NODES;
                let meta = tokio::task::spawn_blocking(move || {
                    crate::utils::graph_meta_json(&engine, &root_disp, page_default)
                })
                .await
                .map_err(|e| format!("任务失败: {e}"))??;
                return Ok(meta);
            }
        }
        // 磁盘兜底：小图走旧路径全量返回；大文件（>64MB）不白读，直接放弃。
        let p = std::path::PathBuf::from(&root).join("hologram_graph.json");
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.len() <= 64 * 1024 * 1024 {
                if let Ok(content) = std::fs::read_to_string(&p) {
                    if !content.trim().is_empty() {
                        return crate::utils::guard_ipc_size(content, "Graph JSON");
                    }
                }
            }
        }
    }

    Err("No cached graph found".into())
}

/// analyze_and_load 业务体：写 .last_project + 窗口标题 + 分析 + 回 meta。
/// （窗口标题联动留在壳层——UI 表现属通道职责，此处只做分析编排。）
pub(crate) async fn analyze_and_load(
    path: String,
    force: bool,
    app: tauri::AppHandle,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let _ = std::fs::write(crate::utils::project_root().join(".last_project"), &path);

    // L1：目标根显式 → 数据上下文（不存在则创建，引擎 init 落在 spawn_blocking 内）
    let (engine, root_disp) = resolve(&app_ctx, &state, Some(&path))?;
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

    // P0-2 分页化：只回 meta + 分页信息，全量图由 get_graph_page 逐页拉取。
    let page_default = crate::utils::GRAPH_PAGE_DEFAULT_NODES;
    let meta = tokio::task::spawn_blocking(move || {
        crate::utils::graph_meta_json(&engine, &root_disp, page_default)
    })
    .await
    .map_err(|e| format!("序列化任务失败: {e}"))??;
    Ok(meta)
}

/// get_graph_meta 业务体：活动工作区（单槽）决议。
pub(crate) async fn get_graph_meta(
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let (engine, root) = resolve(&app_ctx, &state, None)?;
    let page_default = crate::utils::GRAPH_PAGE_DEFAULT_NODES;
    tokio::task::spawn_blocking(move || {
        crate::utils::ensure_engine_ready(&engine, &root)?;
        crate::utils::graph_meta_json(&engine, &root, page_default)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// get_graph_page 业务体：边只含 max(两端点页号) == page 的边（增量下发，
/// 每边恰好一次）；最后一页附带社区数据。
pub(crate) async fn get_graph_page(
    page: usize,
    page_size: Option<usize>,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let (engine, root) = resolve(&app_ctx, &state, None)?;
    let size = page_size.unwrap_or(crate::utils::GRAPH_PAGE_DEFAULT_NODES).clamp(500, 60_000);
    let serialized = tokio::task::spawn_blocking(move || {
        crate::utils::ensure_engine_ready(&engine, &root)?;
        crate::utils::serialize_graph_page(&engine, &root, page, size)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;
    crate::utils::guard_ipc_size(serialized, "图谱分页")
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

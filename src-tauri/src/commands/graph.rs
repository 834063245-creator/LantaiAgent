// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 图谱命令薄壳（L3）：参数提取 + State 转换 + 调应用层服务
// （app/services/graph_service）。业务实现不在壳层。

use tauri::Manager;

#[tauri::command]
pub(crate) async fn load_graph_json(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    crate::app::services::graph_service::load_graph_json(
        path,
        state.inner().clone(),
        app_ctx.inner().clone(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn analyze_and_load(
    path: String,
    force: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    // 窗口标题联动是 UI 表现（通道职责），留壳层。
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("兰台 — 分析中...");
    }
    let result = crate::app::services::graph_service::analyze_and_load(
        path,
        force.unwrap_or(false),
        app.clone(),
        state.inner().clone(),
        app_ctx.inner().clone(),
    )
    .await;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("兰台");
    }
    result
}

/// 当前工作区图的 meta + 分页信息。
#[tauri::command]
pub(crate) async fn get_graph_meta(
    session_id: Option<u64>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    crate::app::services::graph_service::get_graph_meta(
        session_id,
        state.inner().clone(),
        app_ctx.inner().clone(),
    )
    .await
}

/// 分页拉取当前工作区图的第 page 页（0 基）。
#[tauri::command]
pub(crate) async fn get_graph_page(
    page: usize,
    page_size: Option<usize>,
    session_id: Option<u64>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    crate::app::services::graph_service::get_graph_page(
        page,
        page_size,
        session_id,
        state.inner().clone(),
        app_ctx.inner().clone(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn engine_impact(
    node_id: String,
    max_depth: usize,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    crate::app::services::graph_service::engine_impact(
        node_id,
        max_depth,
        state.inner().clone(),
        app_ctx.inner().clone(),
    )
    .await
}

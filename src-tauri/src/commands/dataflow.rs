// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Dataflow 命令薄壳（L3）：工作区根解析 + 调应用层服务
// （app/services/dataflow_service）。

use tauri;

#[tauri::command]
pub(crate) async fn dataflow_save(
    query: String,
    content: Option<String>,
    explore_result: Option<String>,
    dataflow_result: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let root = crate::utils::workspace_path(&state)?;
    crate::app::services::dataflow_service::save(root, query, content, explore_result, dataflow_result).await
}

#[tauri::command]
pub(crate) async fn dataflow_query(
    trace_id: Option<String>,
    list: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let root = crate::utils::workspace_path(&state)?;
    crate::app::services::dataflow_service::query(root, trace_id, list).await
}

#[tauri::command]
pub(crate) async fn dataflow_delete(
    trace_id: String,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<String, String> {
    let root = crate::utils::workspace_path(&state)?;
    crate::app::services::dataflow_service::delete(root, trace_id).await
}

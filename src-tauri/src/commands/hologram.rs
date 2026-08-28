// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Hologram 命令薄壳（L3）：参数提取 + 权限检查（横切）+ 调应用层服务
// （app/services/hologram_service）。

use tauri;

#[tauri::command]
pub(crate) async fn hologram_run_check(
    path: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_run_check", &state)?;
    // 在派生阻塞任务前提取并清除 changed_files。
    // 提前清除可防止检查期间新变更到达时的竞态。
    let changed_files: Vec<String> = crate::utils::lock_or_recover(&state).as_ref()
        .and_then(|h| {
            let mut files = h.changed_files.lock().ok()?;
            let snapshot = files.clone();
            files.clear();
            Some(snapshot)
        })
        .unwrap_or_default();
    crate::app::services::hologram_service::run_check(
        path,
        state.inner().clone(),
        app_ctx.inner().clone(),
        changed_files,
    )
    .await
}

/// 在统一时间轴 (hologram.db) 中记录面向用户的事件。
#[tauri::command]
pub(crate) async fn hologram_record_event(
    event_type: String,
    file: Option<String>,
    summary: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    crate::utils::check_mcp_permission("hologram_record_event", &state)?;
    crate::app::services::hologram_service::record_event(
        event_type,
        file,
        summary,
        state.inner().clone(),
        app_ctx.inner().clone(),
    )
    .await?;
    Ok("ok".into())
}

// ═══════════════════════════════════════════════════════
// （2026-08-04 清理：hologram_hotspots / hologram_gate_check 前端零调用，已删）
// ═══════════════════════════════════════════════════════

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 引擎工具分发薄壳（L3）：validate_project 的 changed_files 注入（单槽横切）
// + 调应用层服务（app/services/dispatch_service）。

#[tauri::command]
pub(crate) async fn hologram_call(
    tool: String,
    mut args: serde_json::Value,
    workspace: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    if tool == "validate_project" {
        let changed_files: Vec<String> = crate::utils::lock_or_recover(&state).as_ref()
            .and_then(|h| {
                let mut files = h.changed_files.lock().ok()?;
                let snapshot = files.clone();
                files.clear();
                Some(snapshot)
            })
            .unwrap_or_default();
        if let serde_json::Value::Object(ref mut map) = args {
            map.insert("changed_files".to_string(), serde_json::json!(changed_files));
        }
    }
    let app_ctx = app_ctx.inner().clone();
    let ws_state: crate::WorkspaceState = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        crate::app::services::dispatch_service::call_dispatched(
            &app_ctx,
            &ws_state,
            tool,
            args,
            workspace,
        )
    })
    .await
    .map_err(|e| format!("引擎调用任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn hologram_tools_list(
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    crate::app::services::dispatch_service::tools_list(state.inner().clone(), app_ctx.inner().clone())
        .await
}

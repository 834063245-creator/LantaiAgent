// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 工作区生命周期命令薄壳（L3）：State 转换 + 调应用层服务
// （app/services/workspace_service）。

use tauri;

#[tauri::command]
pub(crate) async fn workspace_activate(
    path: String,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<(), String> {
    let mut handle = crate::workspace::WorkspaceHandle::new(&path);
    crate::app::services::workspace_service::activate(
        path,
        app_ctx.inner().clone(),
        &mut handle,
    )
    .await?;
    *crate::utils::lock_or_recover(&state) = Some(handle);
    Ok(())
}

/// 停用当前工作区。停止文件监视器，清除已变更文件。
#[tauri::command]
pub(crate) async fn workspace_deactivate(
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<(), String> {
    // 在短暂持有锁时取出句柄，然后在停用前释放锁。
    // deactivate() 停止监视器；在 state 互斥锁下执行此操作
    // 会在整个停止期间阻塞所有需要 state 的其他命令。
    let handle = {
        let mut guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
        guard.take()
    };
    if let Some(mut h) = handle {
        let old_path = h.path.clone();
        h.deactivate();
        crate::app::services::workspace_service::deactivate(old_path, app_ctx.inner().clone()).await?;
    }
    Ok(())
}

/// 启动活跃工作区的文件监视器。
/// 必须在 workspace_activate 之后调用。
#[tauri::command]
pub(crate) async fn workspace_start_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    if let Some(ref mut handle) = *crate::utils::lock_or_recover(&state) {
        handle.start_watcher(app);
        Ok(())
    } else {
        Err("没有活跃的工作区".into())
    }
}

/// 读取最近工作区路径（.last_project——workspace_activate 每次绑定都写，
/// 与图谱引擎无关）。冷启动恢复信号之一；图谱引擎停用时是**唯一**信号。
#[tauri::command]
pub(crate) fn get_last_project() -> Result<Option<String>, String> {
    let last = std::fs::read_to_string(crate::utils::project_root().join(".last_project"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(last)
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 应用层命令（L1）——会话 attach/detach/focus + 上下文清单。
//! 薄壳形态：参数提取在 rpc.rs，这里只做 spawn_blocking 包装与回包序列化；
//! 业务语义（事实校验 / GC / 决议链）全在 `AppContexts`。

use std::sync::Arc;

use tauri;

use super::AppContexts;
use crate::commands::filesystem::user_sessions_root;

/// 会话 attach（事实校验）：卷快照 workspace 字段为准，新生会话可用
/// `workspace` 声明（出生与绑定分离）。回包 = AttachOutcome JSON。
/// 归零重建（2026-08-25）：legacy_root 参数已拆（旧目录归档，回退面不存在）。
#[tauri::command]
pub(crate) async fn session_attach(
    session_id: u64,
    workspace: Option<String>,
    app: tauri::State<'_, Arc<AppContexts>>,
) -> Result<String, String> {
    let app = app.inner().clone();
    tokio::task::spawn_blocking(move || {
        let out = app.attach_session(session_id, workspace.as_deref(), &user_sessions_root())?;
        serde_json::to_string(&out).map_err(|e| format!("session_attach: 序列化失败: {e}"))
    })
    .await
    .map_err(|e| format!("session_attach: task failed: {e}"))?
}

/// 会话 detach：解绑 + 空闲上下文 GC（单槽活跃根由命令层并入保留集）。
#[tauri::command]
pub(crate) async fn session_detach(
    session_id: u64,
    app: tauri::State<'_, Arc<AppContexts>>,
    ws: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    let app = app.inner().clone();
    let keep_roots: Vec<std::path::PathBuf> = {
        crate::utils::lock_or_recover(ws.inner())
            .as_ref()
            .map(|h| std::path::PathBuf::from(&h.path))
            .into_iter()
            .collect()
    };
    tokio::task::spawn_blocking(move || app.detach_session(session_id, &keep_roots))
        .await
        .map_err(|e| format!("session_detach: task failed: {e}"))?;
    Ok(())
}

/// 焦点会话（UI 投影锚）。回包 = 该会话工作区（Option<String> serde 形）。
#[tauri::command]
pub(crate) fn session_focus(
    session_id: u64,
    app: tauri::State<'_, Arc<AppContexts>>,
) -> Result<String, String> {
    let ws = app.focus_session(session_id);
    serde_json::to_string(&ws).map_err(|e| format!("session_focus: 序列化失败: {e}"))
}

/// 上下文清单（诊断 / 守护测试）。
#[tauri::command]
pub(crate) fn context_list(app: tauri::State<'_, Arc<AppContexts>>) -> Result<String, String> {
    let list = app.list_contexts();
    serde_json::to_string(&list).map_err(|e| format!("context_list: 序列化失败: {e}"))
}

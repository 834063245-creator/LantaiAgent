// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 应用层命令（L1）——上下文清单。
//! 薄壳形态：参数提取在 rpc.rs，这里只做 spawn_blocking 包装与回包序列化；
//! 业务语义（ensure/GC/决议链）全在 `AppContexts`。
//! workspace-session-ownership-rework（2026-08-27）：会话 attach/detach/focus
//! 三命令退役——会话只在所属工作区内打开，引擎上下文只看活动工作区。

use std::sync::Arc;

use tauri;

use super::AppContexts;

/// 上下文清单（诊断 / 守护测试）。
#[tauri::command]
pub(crate) fn context_list(app: tauri::State<'_, Arc<AppContexts>>) -> Result<String, String> {
    let list = app.list_contexts();
    serde_json::to_string(&list).map_err(|e| format!("context_list: 序列化失败: {e}"))
}

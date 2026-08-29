// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 引擎工具分发业务（L3 自 commands/engine_dispatch.rs 迁入）。
//! Phase 3（engine-plugin-extraction 摘依赖）：内嵌 dispatch 与全空回落
//! 全局臂退役——hologram_call 必须有工作区，经每工作区引擎进程的
//! stdio MCP 通道调用；工具清单同样经 transport `tools/list`。

use std::sync::Arc;

use crate::app::AppContexts;

/// hologram_call 业务体：决议传输 → 同一方法面调用。
/// validate_project 的 changed_files 注入由壳层命令完成（读单槽 state）。
/// 无工作区 → 显式报错（「未打开工作区」；旧全局引擎回落臂已随内嵌
/// 形态退役）。
pub(crate) fn call_dispatched(
    app_ctx: &Arc<AppContexts>,
    ws_state: &crate::WorkspaceState,
    tool: String,
    args: serde_json::Value,
    workspace: Option<String>,
) -> Result<String, String> {
    let (transport, _root) =
        crate::app::services::graph_service::resolve_transport(app_ctx, ws_state, workspace.as_deref())?;
    transport.call(&tool, &args)
}

/// 工具清单（transport `tools/list`——模型默认面；壳方法 hidden 不可见）。
pub(crate) async fn tools_list(
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let (transport, _root) = crate::app::services::graph_service::resolve_transport(&app_ctx, &state, None)?;
    tokio::task::spawn_blocking(move || {
        let resp = transport.request_mcp("tools/list", &serde_json::json!({}))?;
        let result = resp
            .get("result")
            .ok_or_else(|| "引擎响应无 result".to_string())?;
        let tools = result.get("tools").cloned().unwrap_or(serde_json::json!([]));
        Ok(tools.to_string())
    })
    .await
    .map_err(|e| format!("工具清单任务失败: {e}"))?
}

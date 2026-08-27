// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 引擎工具分发业务（L3 自 commands/engine_dispatch.rs 迁入，零语义改写）。
//! 决议链（workspace-session-ownership-rework 2026-08-27：显式 root → 活动
//! 工作区单槽）+ TLS 绑定 dispatch。

use std::sync::Arc;

use hologram_engine::tools::ToolRegistry;

use crate::app::AppContexts;

/// 引擎调用的同步核心 —— 大图上单次 dispatch 可达秒级，
/// 必须经 spawn_blocking 调用，绝不能在 async worker 上内联执行
/// （见 docs/adr/project-constitution.md 异步纪律）。
pub(crate) fn dispatch_engine(tool: &str, args: &serde_json::Value) -> Result<String, String> {
    let dummy_id = serde_json::json!(null);
    let result = ToolRegistry::dispatch(tool, args, &dummy_id);
    // 解包 MCP JSON-RPC 信封 → 返回原始工具输出文本。
    // 所有 Tauri 调用者（timeline、check、dataflow、graph-partitioner、Agent）
    // 期望原始工具 JSON，而非信封。
    let text = result
        .get("result")
        .and_then(|r| r.get("content"))
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    if text.is_empty() {
        // 回退：可能是 Degraded 响应或错误
        if let Some(err) = result.get("error") {
            return Err(format!("Engine error: {:?}", err));
        }
        return Err("Engine returned empty result".to_string());
    }
    Ok(text.to_string())
}

/// hologram_call 业务体：决议引擎 → TLS 绑定（with_current）dispatch；
/// 全空回落全局（MCP 时代语义）。validate_project 的 changed_files 注入
/// 由壳层命令完成（读单槽 state）。
pub(crate) fn call_dispatched(
    app_ctx: &Arc<AppContexts>,
    ws_state: &crate::WorkspaceState,
    tool: String,
    args: serde_json::Value,
    workspace: Option<String>,
) -> Result<String, String> {
    let engine = {
        let fallback = crate::utils::workspace_path(ws_state).ok();
        app_ctx.resolve_engine(workspace.as_deref(), fallback.as_deref())
    };
    match engine {
        Some(engine) => {
            hologram_engine::engine::with_current(engine, || dispatch_engine(&tool, &args))
        }
        None => dispatch_engine(&tool, &args),
    }
}

/// 工具清单（无状态——注册表全局）。
pub(crate) fn tools_list() -> Result<String, String> {
    let schemas = ToolRegistry::global().tools_list();
    Ok(serde_json::to_string(&schemas).unwrap_or_default())
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! tool_plugins — Rust 内核插件运行时（kernel-plugin-runtime，docs/plans/kernel-plugin-runtime-plan.md）。
//!
//! 内核保留「安全能力和插件运行时」，不保留工具业务：web/fs/git/shell/browser/uia/pty/lsp
//! 等工具实现逐步以 ToolPlugin 形态注册进来，rpc.rs 的细粒度分支逐批退役，
//! 统一收敛到 `tool_call` 单一入口。执行流：
//! 查注册表 → 启用校验（信任分级）→ 工具存在 → 权限引擎（PluginToolAdapter）→
//! 插件 execute（内部走既有路径级真权）→ 返回。

pub mod browser;
pub mod constraints;
pub mod editor;
pub mod fs;
pub mod git;
pub mod lsp;
pub mod manifest;
pub mod plugin;
pub mod pty;
pub mod registry;
pub mod search;
pub mod shell;
pub mod uia;
pub mod web;

pub use plugin::ToolContext;
pub use registry::PluginRegistry;

/// `tool_call` 的内核分派（rpc.rs 单一入口的业务体）。
/// `args` 说 manifest schema 的语言（camelCase 键）；`_agent_id` meta 嵌在 args 内透传。
pub async fn dispatch_tool_call(
    registry: &PluginRegistry,
    plugin_id: &str,
    tool_name: &str,
    args: serde_json::Value,
    is_agent: bool,
    state: &tauri::State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    let plugin = registry
        .get(plugin_id)
        .ok_or_else(|| format!("tool_call: 未知插件 '{plugin_id}'"))?;
    if !registry.is_enabled(plugin_id) {
        return Err(format!("tool_call: 插件 '{plugin_id}' 未启用"));
    }
    let spec = plugin
        .manifest()
        .tools
        .iter()
        .find(|t| t.name == tool_name)
        .ok_or_else(|| format!("tool_call: 插件 '{plugin_id}' 无工具 '{tool_name}'"))?;

    // meta 抽取：_agent_id / _callId 嵌在 args 内（INVARIANTS #9 透传纪律），
    // 其余原样交插件。
    let agent_id = args
        .get("_agent_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    let call_id = args
        .get("_callId")
        .and_then(|v| v.as_str())
        .map(String::from);

    // 权限引擎过闸（PluginToolAdapter）。P2-0 §3.5：仅 Agent 工具链路径过闸——
    // 用户 UI 路径（内部直呼 canvas/chat 持久化等）零规则零弹窗，插件内按
    // ctx.is_agent 分流用户态解析。声明了 permission 的工具由 adapter 承载
    // 工具级门（family 委托 + plugin:<id>.<tool> 精确规则寻址）；未声明的
    // 保持 v1 Passthrough（真权在插件内路径级授权，search/web 同款）。
    if is_agent {
        let perm_ctx = crate::utils::get_ctx(state)?;
        let adapter =
            plugin::PluginToolAdapter::build(plugin_id, tool_name, spec, &args, agent_id.as_deref(), &perm_ctx);
        crate::utils::check_permission(&adapter, &perm_ctx, app).await?;
    }

    let ctx = ToolContext {
        agent_id,
        is_agent,
        call_id,
        state,
        app,
    };
    plugin
        .execute(&ctx, tool_name, args)
        .await
        // 值形态分流：文本结果（如 web_fetch 的网页文本）字节精确直通——
        // Value::String 的 to_string() 会多包一层 JSON 引号，破坏 Text 铁律；
        // 结构化结果照常 JSON 序列化。
        .map(|v| match v {
            serde_json::Value::String(s) => s,
            other => other.to_string(),
        })
        .map_err(|e| e.message())
}

/// `plugin_tool_manifests` 的业务体：全量清单（供前端/Phase 4 UI 消费）。
pub fn registry_manifests(registry: &PluginRegistry) -> serde_json::Value {
    serde_json::json!(registry.manifests())
}

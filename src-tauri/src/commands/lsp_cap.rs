// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// lsp 能力口（R4 小面清偿，kernel-capability-d4-handle-design.md §6 R4-4）——
// LSP 会话族直呼入口，不经 tool_call 信封 / PluginRegistry / PluginToolAdapter
// （builtin.lsp 插件随本批退役）。v3 §4：原生引用（LSP）留 Rust（无编排业务）
// ——lsp_manager（起用户机器 language server + stdio 转发）本体零改动，口只
// 换信封为直呼。
//
// 权限形状（插件原语义 §8.5）：无家族规则——Passthrough（口内无闸；TS 侧
// 无模型面工具，ui/lsp-client.ts 内部消费路径 is_agent=false）。
//
// 事件通道零改：lsp-message 事件由 lsp_manager 内部 app.emit 发射（TS
// typedListen('lsp-message') 消费）——本口不碰事件面。键语言：manifest 键本就
// snake_case（session_id/method/params/language/root_uri）——无映射。

use serde_json::Value;
use tauri::State;

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
}

fn opt_u32_of(args: &Value, k: &str) -> Option<u32> {
    args.get(k).and_then(|v| v.as_u64()).map(|n| n as u32)
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 tool_plugins/lsp/mod.rs 逐行为迁入；错误串即最终形态）
// ═══════════════════════════════════════════════════════════════

async fn lsp_start(app: &tauri::AppHandle, args: &Value) -> Result<String, String> {
    let language = arg_str(args, "language")
        .ok_or_else(|| "lsp_start: missing 'language'".to_string())?;
    let root_uri = arg_str(args, "root_uri")
        .ok_or_else(|| "lsp_start: missing 'root_uri'".to_string())?;
    let id = crate::lsp_manager::lsp_start(app.clone(), language, root_uri).await?;
    Ok(id.to_string())
}

async fn lsp_request(args: &Value) -> Result<String, String> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| "lsp_request: missing 'session_id'".to_string())?;
    let method = arg_str(args, "method")
        .ok_or_else(|| "lsp_request: missing 'method'".to_string())?;
    let lsp_params = args.get("params").cloned().unwrap_or(Value::Null);
    // lsp_manager::lsp_request 返回 JSON-RPC result 的 Value——序列化成字符串
    // 返回（Text shape 字节直通；TS kernelLspRequest parseJson 恢复对象语义，
    // 与信封 dispatch 的 Value 序列化字节一致）。
    let result = crate::lsp_manager::lsp_request(session_id, method, lsp_params).await?;
    Ok(result.to_string())
}

async fn lsp_stop(args: &Value) -> Result<String, String> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| "lsp_stop: missing 'session_id'".to_string())?;
    crate::lsp_manager::lsp_stop(session_id).await?;
    Ok("null".into())
}

/// lsp_cap 能力口分派（R4 小面清偿立口即唯一入口——builtin.lsp 同批退役，
/// 无信封过渡面）。action = 退役前 builtin.lsp 3 工具名；参数顶层 snake；
/// 返回文本（start = 会话 id；request = JSON 字符串；stop = "null"）。
pub(crate) async fn lsp_cap(
    action: String,
    params: Value,
    is_agent: bool,
    agent_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    // 统一契约键 + 身份参数：lsp 无权限闸（Passthrough 原语义），口内不消费。
    let _ = (is_agent, agent_id, state);
    match action.as_str() {
        "lsp_start" => lsp_start(app, &params).await,
        "lsp_request" => lsp_request(&params).await,
        "lsp_stop" => lsp_stop(&params).await,
        other => Err(format!("lsp_cap: 未知 action '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    /// 3 动作全集（= 退役前 builtin.lsp manifest.tools 名单）。
    #[test]
    fn action_table_is_exactly_three() {
        let actions = ["lsp_start", "lsp_request", "lsp_stop"];
        assert_eq!(actions.len(), 3);
        assert!(actions.iter().all(|a| a.starts_with("lsp_")));
    }
}

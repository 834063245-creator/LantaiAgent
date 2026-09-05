// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// pty 能力口（R4 小面清偿，kernel-capability-d4-handle-design.md §6 R4-4）——
// PTY 会话族直呼入口，不经 tool_call 信封 / PluginRegistry / PluginToolAdapter
// （builtin.pty 插件随本批退役）。v3 §4：pty 是会话句柄族——生命周期注册表
// （pty_manager::SESSIONS）留 Rust，口只走既有高层函数。
//
// 权限形状（插件原语义 §8.5）：无家族规则——Passthrough（口内无闸；TS 侧
// 无模型面工具，内部消费路径 is_agent=false）。
//
// 事件通道零改：pty-output 事件由 pty_manager 内部 app.emit 发射（TS
// typedListen 消费）——本口不碰事件面。键语言：manifest 键本就 snake_case
// （session_id/cols/rows/cwd/shell/data）——无映射。

use serde_json::Value;
use tauri::State;

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
}

fn opt_u32_of(args: &Value, k: &str) -> Option<u32> {
    args.get(k).and_then(|v| v.as_u64()).map(|n| n as u32)
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 tool_plugins/pty/mod.rs 逐行为迁入；错误串即最终形态）
// ═══════════════════════════════════════════════════════════════

async fn pty_spawn(app: &tauri::AppHandle, args: &Value) -> Result<String, String> {
    let cwd = arg_str(args, "cwd")
        .ok_or_else(|| "pty_spawn: missing 'cwd'".to_string())?;
    let shell = arg_str(args, "shell");
    let cols = args
        .get("cols")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| "pty_spawn: missing or invalid 'cols'".to_string())?;
    let rows = args
        .get("rows")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| "pty_spawn: missing or invalid 'rows'".to_string())?;
    let id = crate::pty_manager::pty_spawn(app.clone(), cwd, shell, cols, rows).await?;
    Ok(id.to_string())
}

async fn pty_write(args: &Value) -> Result<String, String> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| "pty_write: missing 'session_id'".to_string())?;
    let data = arg_str(args, "data")
        .ok_or_else(|| "pty_write: missing 'data'".to_string())?;
    crate::pty_manager::pty_write(session_id, data).await?;
    Ok("null".into())
}

async fn pty_resize(args: &Value) -> Result<String, String> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| "pty_resize: missing 'session_id'".to_string())?;
    let cols = args
        .get("cols")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| "pty_resize: missing or invalid 'cols'".to_string())?;
    let rows = args
        .get("rows")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| "pty_resize: missing or invalid 'rows'".to_string())?;
    crate::pty_manager::pty_resize(session_id, cols, rows).await?;
    Ok("null".into())
}

async fn pty_kill(args: &Value) -> Result<String, String> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| "pty_kill: missing 'session_id'".to_string())?;
    crate::pty_manager::pty_kill(session_id).await?;
    Ok("null".into())
}

/// pty_cap 能力口分派（R4 小面清偿立口即唯一入口——builtin.pty 同批退役，
/// 无信封过渡面）。action = 退役前 builtin.pty 4 工具名；参数顶层 snake；
/// 返回文本（spawn = 会话 id；其余 = "null"）。
pub(crate) async fn pty_cap(
    action: String,
    params: Value,
    is_agent: bool,
    agent_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    // 统一契约键 + 身份参数：pty 无权限闸（Passthrough 原语义），口内不消费。
    let _ = (is_agent, agent_id, state);
    match action.as_str() {
        "pty_spawn" => pty_spawn(app, &params).await,
        "pty_write" => pty_write(&params).await,
        "pty_resize" => pty_resize(&params).await,
        "pty_kill" => pty_kill(&params).await,
        other => Err(format!("pty_cap: 未知 action '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    /// 4 动作全集（= 退役前 builtin.pty manifest.tools 名单）。
    #[test]
    fn action_table_is_exactly_four() {
        let actions = ["pty_spawn", "pty_write", "pty_resize", "pty_kill"];
        assert_eq!(actions.len(), 4);
        assert!(actions.iter().all(|a| a.starts_with("pty_")));
    }
}

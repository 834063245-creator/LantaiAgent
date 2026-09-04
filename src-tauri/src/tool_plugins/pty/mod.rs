
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

//! builtin.pty 插件——内核插件运行时 Phase 6（自 rpc.rs PTY 分区拆出）。
//! 工具面真源 = 同目录 manifest.json（npm run gen:kernel-manifest pty 发射）。
//!
//! 权限形状（§8.5 裁决）：无家族规则，不进 manifest permission——dispatch 侧
//! adapter 恒 Passthrough；生命周期注册表（pty_manager::SESSIONS）不暴露给
//! ToolContext，插件只走既有高层函数（pty_manager::pty_spawn/write/resize/kill，
//! 均为 #[tauri::command] pub async——AppHandle 经 ctx.app 传入）。pty-output
//! 事件通道原样保留（pty_manager 内部 app.emit，TS typedListen 消费）。
//!
//! 单键语言延续：参数键 = manifest schema 键（snake_case：session_id/cols/rows/
//! cwd/shell/data）。

use serde_json::Value;

use super::manifest::ToolManifest;
use super::plugin::{ToolContext, ToolError, ToolPlugin};

pub struct PtyPlugin {
    manifest: ToolManifest,
}

impl PtyPlugin {
    pub fn new() -> Self {
        let manifest: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("builtin.pty manifest 是随 exe 编译的静态资源");
        Self { manifest }
    }
}

impl Default for PtyPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlugin for PtyPlugin {
    fn id(&self) -> &str {
        "builtin.pty"
    }

    fn manifest(&self) -> &ToolManifest {
        &self.manifest
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a ToolContext<'a>,
        tool_name: &'a str,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, ToolError>> + Send + 'a>,
    > {
        Box::pin(async move {
            match tool_name {
                "pty_spawn" => pty_spawn(ctx, &args).await,
                "pty_write" => pty_write(ctx, &args).await,
                "pty_resize" => pty_resize(ctx, &args).await,
                "pty_kill" => pty_kill(ctx, &args).await,
                other => Err(ToolError::InvalidArgs(format!("builtin.pty: 未知工具 '{other}'"))),
            }
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 rpc.rs PTY 分区原样迁入；参数键 = manifest 语言 snake_case；
// 权限 = Passthrough——§8.5 裁决）
// ═══════════════════════════════════════════════════════════════

/// text 结果直通。
fn text(s: String) -> Result<Value, ToolError> {
    Ok(Value::String(s))
}

fn opt_u32_of(args: &Value, k: &str) -> Option<u32> {
    args.get(k).and_then(|v| v.as_u64()).map(|n| n as u32)
}

async fn pty_spawn(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let cwd = super::plugin::arg_str(args, "cwd")
        .ok_or_else(|| ToolError::InvalidArgs("pty_spawn: missing 'cwd'".into()))?;
    let shell = super::plugin::arg_str(args, "shell");
    let cols = args
        .get("cols")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| ToolError::InvalidArgs("pty_spawn: missing or invalid 'cols'".into()))?;
    let rows = args
        .get("rows")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| ToolError::InvalidArgs("pty_spawn: missing or invalid 'rows'".into()))?;
    let id = crate::pty_manager::pty_spawn(ctx.app.clone(), cwd, shell, cols, rows)
        .await
        .map_err(ToolError::Tool)?;
    text(id.to_string())
}

async fn pty_write(_ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| ToolError::InvalidArgs("pty_write: missing 'session_id'".into()))?;
    let data = super::plugin::arg_str(args, "data")
        .ok_or_else(|| ToolError::InvalidArgs("pty_write: missing 'data'".into()))?;
    crate::pty_manager::pty_write(session_id, data)
        .await
        .map_err(ToolError::Tool)?;
    text("null".into())
}

async fn pty_resize(_ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| ToolError::InvalidArgs("pty_resize: missing 'session_id'".into()))?;
    let cols = args
        .get("cols")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| ToolError::InvalidArgs("pty_resize: missing or invalid 'cols'".into()))?;
    let rows = args
        .get("rows")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .ok_or_else(|| ToolError::InvalidArgs("pty_resize: missing or invalid 'rows'".into()))?;
    crate::pty_manager::pty_resize(session_id, cols, rows)
        .await
        .map_err(ToolError::Tool)?;
    text("null".into())
}

async fn pty_kill(_ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| ToolError::InvalidArgs("pty_kill: missing 'session_id'".into()))?;
    crate::pty_manager::pty_kill(session_id)
        .await
        .map_err(ToolError::Tool)?;
    text("null".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        let m: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.pty");
        assert_eq!(m.trust, super::super::manifest::TrustLevel::System);
        assert_eq!(m.tools.len(), 4);
        // §8.6：pty/lsp 不进 manifest permission。
        for t in &m.tools {
            assert!(t.permission.is_none(), "builtin.pty {}.permission 必须为 None（§8 裁决）", t.name);
        }
        for name in ["pty_spawn", "pty_write", "pty_resize", "pty_kill"] {
            assert!(m.tools.iter().any(|t| t.name == name), "{name} 在清单内");
        }
    }
}

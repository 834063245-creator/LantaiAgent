
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

//! builtin.lsp 插件——内核插件运行时 Phase 6（自 rpc.rs LSP 分区拆出）。
//! 工具面真源 = 同目录 manifest.json（npm run gen:kernel-manifest lsp 发射）。
//!
//! 权限形状（§8.5 裁决）：无家族规则，不进 manifest permission——dispatch 侧
//! adapter 恒 Passthrough；生命周期注册表不暴露给 ToolContext，插件只走既有
//! 高层函数（lsp_manager::lsp_start/request/stop，#[tauri::command] pub async，
//! AppHandle 经 ctx.app 传入）。lsp-message 事件通道原样保留（lsp_manager 内部
//! app.emit，TS ui/lsp-client.ts 继续 typedListen('lsp-message') 消费）。
//!
//! 单键语言延续：参数键 = manifest schema 键（snake_case：session_id/method/
//! params/language/root_uri）。

use serde_json::Value;

use super::manifest::ToolManifest;
use super::plugin::{ToolContext, ToolError, ToolPlugin};

pub struct LspPlugin {
    manifest: ToolManifest,
}

impl LspPlugin {
    pub fn new() -> Self {
        let manifest: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("builtin.lsp manifest 是随 exe 编译的静态资源");
        Self { manifest }
    }
}

impl Default for LspPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlugin for LspPlugin {
    fn id(&self) -> &str {
        "builtin.lsp"
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
                "lsp_start" => lsp_start(ctx, &args).await,
                "lsp_request" => lsp_request(ctx, &args).await,
                "lsp_stop" => lsp_stop(ctx, &args).await,
                other => Err(ToolError::InvalidArgs(format!("builtin.lsp: 未知工具 '{other}'"))),
            }
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 rpc.rs LSP 分区原样迁入；参数键 = manifest 语言 snake_case；
// 权限 = Passthrough——§8.5 裁决）
// ═══════════════════════════════════════════════════════════════

fn opt_u32_of(args: &Value, k: &str) -> Option<u32> {
    args.get(k).and_then(|v| v.as_u64()).map(|n| n as u32)
}

async fn lsp_start(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let language = super::plugin::arg_str(args, "language")
        .ok_or_else(|| ToolError::InvalidArgs("lsp_start: missing 'language'".into()))?;
    let root_uri = super::plugin::arg_str(args, "root_uri")
        .ok_or_else(|| ToolError::InvalidArgs("lsp_start: missing 'root_uri'".into()))?;
    let id = crate::lsp_manager::lsp_start(ctx.app.clone(), language, root_uri)
        .await
        .map_err(ToolError::Tool)?;
    Ok(Value::String(id.to_string()))
}

async fn lsp_request(_ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| ToolError::InvalidArgs("lsp_request: missing 'session_id'".into()))?;
    let method = super::plugin::arg_str(args, "method")
        .ok_or_else(|| ToolError::InvalidArgs("lsp_request: missing 'method'".into()))?;
    let lsp_params = args.get("params").cloned().unwrap_or(Value::Null);
    // lsp_manager::lsp_request 返回 JSON-RPC result 的 Value；旧 rpc 经 ok_json
    // 序列化成字符串（rpc_result_shape JsonValue 再展开）。插件直接返回 Value，
    // dispatch 统一序列化——TS 侧 parse 语义不变。
    crate::lsp_manager::lsp_request(session_id, method, lsp_params)
        .await
        .map_err(ToolError::Tool)
}

async fn lsp_stop(_ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let session_id = opt_u32_of(args, "session_id")
        .ok_or_else(|| ToolError::InvalidArgs("lsp_stop: missing 'session_id'".into()))?;
    crate::lsp_manager::lsp_stop(session_id)
        .await
        .map_err(ToolError::Tool)?;
    Ok(Value::String("null".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        let m: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.lsp");
        assert_eq!(m.trust, super::super::manifest::TrustLevel::System);
        assert_eq!(m.tools.len(), 3);
        for t in &m.tools {
            assert!(t.permission.is_none(), "builtin.lsp {}.permission 必须为 None（§8 裁决）", t.name);
        }
        for name in ["lsp_start", "lsp_request", "lsp_stop"] {
            assert!(m.tools.iter().any(|t| t.name == name), "{name} 在清单内");
        }
    }
}

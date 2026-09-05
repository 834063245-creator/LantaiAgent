// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

//! builtin.browser 插件——内核插件运行时 Phase 5（自 rpc.rs CDP 分区拆出）。
//! 工具面真源 = 同目录 manifest.json（npm run gen:kernel-manifest browser 发射）。
//!
//! **R4-1（2026-09-05，kernel-capability-d4-handle-design.md）起：业务单一实现
//! 迁 commands/browser_cap.rs（browser 能力口），本插件退化为信封薄壳——
//! execute 把 (agent_id, tool_name, args) 原样委托口内，行为零漂移。
//! builtin.browser 整目录随 R4-2（模型族换 browser_cap 直呼）退役。**

use serde_json::Value;

use super::manifest::ToolManifest;
use super::plugin::{ToolContext, ToolError, ToolPlugin};

pub struct BrowserPlugin {
    manifest: ToolManifest,
}

impl BrowserPlugin {
    pub fn new() -> Self {
        let manifest: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("builtin.browser manifest 是随 exe 编译的静态资源");
        Self { manifest }
    }
}

impl Default for BrowserPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlugin for BrowserPlugin {
    fn id(&self) -> &str {
        "builtin.browser"
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
            // 信封薄壳：37 工具名 = 能力口 action（一位一动作），原样委托。
            crate::commands::browser_cap::envelope_execute(ctx, tool_name, args).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        let m: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.browser");
        assert_eq!(m.trust, super::super::manifest::TrustLevel::System);
        assert_eq!(m.tools.len(), 37);
        // §8.6：browser/uia 不写 manifest permission（权限整体留插件内业务自检）。
        for t in &m.tools {
            assert!(t.permission.is_none(), "builtin.browser {}.permission 必须为 None（§8 裁决）", t.name);
        }
        for name in ["browser_launch", "browser_click", "browser_status"] {
            assert!(m.tools.iter().any(|t| t.name == name), "{name} 在清单内");
        }
    }
}


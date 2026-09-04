// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! PluginRegistry — 内核插件注册表。装载期防线：插件 id 重复、工具名跨插件重复、
//! schema 缺形，一律拒绝。与 TS 侧 ToolRegistry 的「装载期重名 throw」同一纪律。

use std::collections::HashMap;
use std::sync::Arc;

use super::manifest::{ToolManifest, TrustLevel};
use super::plugin::ToolPlugin;

pub struct PluginRegistry {
    plugins: Vec<Arc<dyn ToolPlugin>>,
    /// 工具名 → 插件 id（跨插件全局唯一索引）。
    tool_index: HashMap<String, String>,
}

impl Default for PluginRegistry {
    fn default() -> Self {
        Self {
            plugins: Vec::new(),
            tool_index: HashMap::new(),
        }
    }
}

impl PluginRegistry {
    /// 出厂装配：system/official 信任级插件随 exe 分发，启动时注册。
    /// 出厂清单是编译期常量——装载失败即构建错误，fail-loud。
    /// 注册序 = tool_plugins/ 目录序（gen-plugin-manifests 的镜像装载序锚）。
    pub fn with_system_defaults() -> Self {
        let mut registry = PluginRegistry::default();
        let browser: Arc<dyn ToolPlugin> = Arc::new(super::browser::BrowserPlugin::new());
        registry.register(browser).expect("出厂插件清单装载失败");
        let uia: Arc<dyn ToolPlugin> = Arc::new(super::uia::UiaPlugin::new());
        registry.register(uia).expect("出厂插件清单装载失败");
        let constraints: Arc<dyn ToolPlugin> = Arc::new(super::constraints::ConstraintsPlugin::new());
        registry.register(constraints).expect("出厂插件清单装载失败");
        let editor: Arc<dyn ToolPlugin> = Arc::new(super::editor::EditorPlugin::new());
        registry.register(editor).expect("出厂插件清单装载失败");
        let fs: Arc<dyn ToolPlugin> = Arc::new(super::fs::FsPlugin::new());
        registry.register(fs).expect("出厂插件清单装载失败");
        let git: Arc<dyn ToolPlugin> = Arc::new(super::git::GitPlugin::new());
        registry.register(git).expect("出厂插件清单装载失败");
        let lsp: Arc<dyn ToolPlugin> = Arc::new(super::lsp::LspPlugin::new());
        registry.register(lsp).expect("出厂插件清单装载失败");
        let pty: Arc<dyn ToolPlugin> = Arc::new(super::pty::PtyPlugin::new());
        registry.register(pty).expect("出厂插件清单装载失败");
        let shell: Arc<dyn ToolPlugin> = Arc::new(super::shell::ShellPlugin::new());
        registry.register(shell).expect("出厂插件清单装载失败");
        let web: Arc<dyn ToolPlugin> = Arc::new(super::web::WebPlugin::new());
        registry.register(web).expect("出厂插件清单装载失败");
        registry
    }

    pub fn register(&mut self, plugin: Arc<dyn ToolPlugin>) -> Result<(), String> {
        let manifest = plugin.manifest();
        if manifest.id.is_empty() {
            return Err("插件 id 不能为空".to_string());
        }
        if self.plugins.iter().any(|p| p.id() == manifest.id) {
            return Err(format!("插件 id 重复: {}", manifest.id));
        }
        for tool in &manifest.tools {
            if tool.name.is_empty() {
                return Err(format!("插件 {} 存在空工具名", manifest.id));
            }
            if tool.schema.get("type").is_none() {
                return Err(format!("工具 {}.{} 的 schema 缺 type 形", manifest.id, tool.name));
            }
            // 权限声明装载期校验：未知 family fail-loud（拼错家族名 = 权限门
            // 静默降级为 Passthrough，不可静默放过）。
            if let Some(perm) = &tool.permission {
                if super::manifest::parse_family(&perm.family).is_none() {
                    return Err(format!(
                        "工具 {}.{} 的 permission.family 非法: '{}'（合法值 {:?}）",
                        manifest.id, tool.name, perm.family, super::manifest::KNOWN_FAMILIES
                    ));
                }
            }
            if self.tool_index.contains_key(&tool.name) {
                let owner = &self.tool_index[&tool.name];
                return Err(format!(
                    "工具名跨插件重复: '{}'（{} 与 {}）",
                    tool.name, owner, manifest.id
                ));
            }
        }
        for tool in &manifest.tools {
            self.tool_index.insert(tool.name.clone(), manifest.id.clone());
        }
        self.plugins.push(plugin);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn ToolPlugin>> {
        self.plugins.iter().find(|p| p.id() == id).cloned()
    }

    pub fn manifests(&self) -> Vec<&ToolManifest> {
        self.plugins.iter().map(|p| p.manifest()).collect()
    }

    /// 启用判定。v1：system/official 出厂即信任启用；Phase 4 接用户持久化
    /// 启停/卸载状态（plugin_* 通道），第三方默认不启用直到显式授予。
    pub fn is_enabled(&self, id: &str) -> bool {
        self.get(id)
            .map(|p| {
                matches!(
                    p.manifest().trust,
                    TrustLevel::System | TrustLevel::Official
                )
            })
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_plugins::manifest::{ToolManifest, TrustLevel};
    use crate::tool_plugins::plugin::{ToolContext, ToolError, ToolPlugin};
    use std::future::Future;
    use std::pin::Pin;

    struct FakePlugin {
        manifest: ToolManifest,
    }

    fn fake_manifest(id: &str, tools: &[&str]) -> ToolManifest {
        ToolManifest {
            id: id.to_string(),
            version: "0.0.1".into(),
            trust: TrustLevel::System,
            description: String::new(),
            capabilities: vec![],
            tools: tools
                .iter()
                .map(|n| super::super::manifest::ToolSpec {
                    name: n.to_string(),
                    description: "fake".into(),
                    schema: serde_json::json!({"type": "object"}),
                    read_only: true,
                    permission: None,
                })
                .collect(),
        }
    }

    impl ToolPlugin for FakePlugin {
        fn id(&self) -> &str {
            &self.manifest.id
        }
        fn manifest(&self) -> &ToolManifest {
            &self.manifest
        }
        fn execute<'a>(
            &'a self,
            _ctx: &'a ToolContext<'a>,
            _tool_name: &'a str,
            _args: serde_json::Value,
        ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, ToolError>> + Send + 'a>> {
            Box::pin(async { Ok(serde_json::json!({"ok": true})) })
        }
    }

    #[test]
    fn register_rejects_duplicate_plugin_id() {
        let mut r = PluginRegistry::default();
        r.register(std::sync::Arc::new(FakePlugin { manifest: fake_manifest("a.x", &["t1"]) }))
            .expect("首发注册");
        let err = r
            .register(std::sync::Arc::new(FakePlugin { manifest: fake_manifest("a.x", &["t2"]) }))
            .expect_err("同 id 二发必须拒绝");
        assert!(err.contains("重复"), "err = {err}");
    }

    #[test]
    fn register_rejects_cross_plugin_tool_name() {
        let mut r = PluginRegistry::default();
        r.register(std::sync::Arc::new(FakePlugin { manifest: fake_manifest("a.x", &["same"]) }))
            .expect("首发注册");
        let err = r
            .register(std::sync::Arc::new(FakePlugin { manifest: fake_manifest("b.y", &["same"]) }))
            .expect_err("跨插件同名工具必须拒绝");
        assert!(err.contains("same"), "err = {err}");
    }

    #[test]
    fn register_rejects_schema_without_type() {
        let mut manifest = fake_manifest("a.z", &["t"]);
        manifest.tools[0].schema = serde_json::json!({"properties": {}});
        let mut r = PluginRegistry::default();
        let err = r
            .register(std::sync::Arc::new(FakePlugin { manifest }))
            .expect_err("缺 type 形必须拒绝");
        assert!(err.contains("schema"), "err = {err}");
    }

    /// P2-0：permission.family 未知 → 装载期拒绝（静默 Passthrough 不可接受）。
    #[test]
    fn register_rejects_unknown_permission_family() {
        let mut manifest = fake_manifest("a.perm", &["t"]);
        manifest.tools[0].permission = Some(super::super::manifest::ToolPermission {
            family: "Writeln".into(),
            path_key: Some("filePath".into()),
            command_key: None,
            subcommand: None,
        });
        let mut r = PluginRegistry::default();
        let err = r
            .register(std::sync::Arc::new(FakePlugin { manifest }))
            .expect_err("未知 family 必须拒绝");
        assert!(err.contains("Writeln"), "err = {err}");
    }

    #[test]
    fn enabled_follows_trust_level() {
        let mut r = PluginRegistry::default();
        let mut third = fake_manifest("c.third", &["t"]);
        third.trust = TrustLevel::ThirdParty;
        r.register(std::sync::Arc::new(FakePlugin { manifest: third })).expect("注册");
        let sys = fake_manifest("b.sys", &["t2"]);
        r.register(std::sync::Arc::new(FakePlugin { manifest: sys })).expect("注册");
        assert!(!r.is_enabled("c.third"), "third_party 默认不启用");
        assert!(r.is_enabled("b.sys"), "system 信任级启用");
        assert!(!r.is_enabled("nope"), "未知插件不启用");
    }
}

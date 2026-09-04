// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! ToolManifest — 插件清单契约（前后端工具面唯一真源的形状）。
//!
//! manifest.json 文件本身是真源载体：Rust 侧 `include_str!` 编译期内嵌
//! （见 `search/mod.rs`），TS 侧经 `scripts/gen-plugin-manifests.cjs` 生成镜像模块
//! （`src-ui/src/agent/tools/kernel-manifests.generated.ts`），doc-sync 门禁防漂移。
//! 工具的 `schema` 是面向模型的 JSON Schema（draft-7，键序 = zod 发射序——
//! convergence 字节契约依赖此序，勿规整）。

use serde::{Deserialize, Serialize};

/// 插件信任分级（kernel-plugin-runtime §3 裁决）。
/// - system：随 exe 分发的内核/高权限插件，出厂即信任。
/// - official：官方普通插件，出厂即信任，可卸载。
/// - third_party：第三方插件，默认不信任，需用户显式授予（Phase 4 落地）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    System,
    Official,
    ThirdParty,
}

/// 单个工具的声明。schema 与 description 的字节 = 模型可见工具面字节。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    /// 工具机器名（跨插件全局唯一，注册表装载期拒绝重复）。
    pub name: String,
    /// 面向模型的描述。
    pub description: String,
    /// 参数 JSON Schema（draft-7）。
    pub schema: serde_json::Value,
    #[serde(default)]
    pub read_only: bool,
    /// 权限声明（可选，非模型面——schema 字节不动）。声明了 permission 的
    /// 工具，dispatch 侧 PluginToolAdapter 即是其工具级权限门（family 委托 +
    /// `plugin:<id>.<tool>` 精确规则寻址 + 家族回退）；未声明保持 v1 语义
    /// （adapter Passthrough，真权在插件内的路径级授权——resolve_read_dispatch 等）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<ToolPermission>,
}

/// 工具级权限声明（P2-0 §3.2）。family 是权限家族名（"Read"/"Edit"/"Bash"/"Git"）；
/// path_key/command_key 声明从 args 提取目标的键，subcommand 是 Git 家族的
/// 子命令（require_git_dispatch 的 subcommand 位）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolPermission {
    pub family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subcommand: Option<String>,
}

/// 已知权限家族全集（registry 装载期校验 manifest 声明用）。
pub const KNOWN_FAMILIES: &[&str] = &["Read", "Edit", "Bash", "Git"];

/// 家族名字符串 → 静态家族名。未知家族返回 None（装载期拒绝）。
pub fn parse_family(family: &str) -> Option<&'static str> {
    match family {
        "Read" => Some("Read"),
        "Edit" => Some("Edit"),
        "Bash" => Some("Bash"),
        "Git" => Some("Git"),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolManifest {
    /// 插件 id，如 "builtin.search"。
    pub id: String,
    pub version: String,
    pub trust: TrustLevel,
    #[serde(default)]
    pub description: String,
    /// 插件声明需要的能力（如 "filesystem_read" / "network"）——
    /// 工具级真权仍在权限引擎/路径沙箱，能力面服务于 Phase 4 的用户授予与 UI 展示。
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub tools: Vec<ToolSpec>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        // 出厂锚（builtin.fs 已随 fs 域收口退役——2026-09-04，kernel-capability-
        // c3-design.md R3-b 后 UI/模型族全量换 fs_cap 能力口直呼，插件信封无
        // 消费方）。锚改指向 builtin.editor——同为 filesystem_read/write 能力 +
        // 只读 object schema 工具，锚语义等价。
        let m: ToolManifest =
            serde_json::from_str(include_str!("editor/manifest.json")).expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.editor");
        assert_eq!(m.trust, TrustLevel::System);
        assert_eq!(m.capabilities, vec!["filesystem_read".to_string(), "filesystem_write".to_string()]);
        let tool = m.tools.iter().find(|t| t.name == "edit_file").expect("edit_file 在清单内");
        assert!(!tool.read_only);
        // 契约锚：schema 必须是 object 形（模型面）。
        assert_eq!(tool.schema.get("type").and_then(|v| v.as_str()), Some("object"));
    }

    #[test]
    fn trust_level_serializes_snake_case() {
        let t = serde_json::to_string(&TrustLevel::ThirdParty).expect("serde");
        assert_eq!(t, "\"third_party\"");
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! builtin.constraints 插件——内核插件运行时 Phase 2 首批（自 commands/constraints.rs 拆出）。
//! 工具面（名称/描述/schema）真源 = 同目录 manifest.json（双端共享）。
//! 原命令本就无权限检查（constraints.rs 只做 `..` 穿越校验）——插件保持同款
//! 语义，不声明 permission（v1 Passthrough）。

use serde_json::Value;

use super::manifest::ToolManifest;
use super::plugin::{ToolContext, ToolError, ToolPlugin};

pub struct ConstraintsPlugin {
    manifest: ToolManifest,
}

impl ConstraintsPlugin {
    pub fn new() -> Self {
        let manifest: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("builtin.constraints manifest 是随 exe 编译的静态资源");
        Self { manifest }
    }
}

impl Default for ConstraintsPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlugin for ConstraintsPlugin {
    fn id(&self) -> &str {
        "builtin.constraints"
    }

    fn manifest(&self) -> &ToolManifest {
        &self.manifest
    }

    fn execute<'a>(
        &'a self,
        _ctx: &'a ToolContext<'a>,
        tool_name: &'a str,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, ToolError>> + Send + 'a>,
    > {
        Box::pin(async move {
            match tool_name {
                "read_constraints" => read_constraints(&args).await,
                "write_constraints" => write_constraints(&args).await,
                other => Err(ToolError::InvalidArgs(format!(
                    "builtin.constraints: 未知工具 '{other}'"
                ))),
            }
        })
    }
}

/// read_constraints — 读 hologram.constraints.yaml（业务自 commands/constraints.rs
/// 原样迁入；参数键改说 manifest schema 的语言，camelCase）。
async fn read_constraints(args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("read_constraints: missing '{k}'"));
    let project_path = super::plugin::arg_str(args, "projectPath").ok_or_else(|| missing("projectPath"))?;
    if project_path.contains("..") || project_path.contains('\0') {
        return Err(ToolError::InvalidArgs("路径包含非法字符".into()));
    }
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    if !yaml_path.exists() {
        let default_path = crate::utils::project_root().join("hologram.constraints.yaml");
        let content = std::fs::read_to_string(&default_path)
            .map_err(|e| ToolError::Tool(format!("无法读取默认约束文件: {}", e)))?;
        return Ok(Value::String(content));
    }
    let content = std::fs::read_to_string(&yaml_path)
        .map_err(|e| ToolError::Tool(format!("无法读取约束文件: {}", e)))?;
    Ok(Value::String(content))
}

/// write_constraints — 临时文件原子替换 hologram.constraints.yaml（业务原样迁入）。
async fn write_constraints(args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("write_constraints: missing '{k}'"));
    let project_path = super::plugin::arg_str(args, "projectPath").ok_or_else(|| missing("projectPath"))?;
    let content = super::plugin::arg_str(args, "content").ok_or_else(|| missing("content"))?;
    if project_path.contains("..") || project_path.contains('\0') {
        return Err(ToolError::InvalidArgs("路径包含非法字符".into()));
    }
    let yaml_path = std::path::PathBuf::from(&project_path).join("hologram.constraints.yaml");
    let tmp_path = yaml_path.with_extension("yaml.tmp");
    std::fs::write(&tmp_path, &content)
        .map_err(|e| ToolError::Tool(format!("无法写入临时文件: {}", e)))?;
    std::fs::rename(&tmp_path, &yaml_path)
        .map_err(|e| ToolError::Tool(format!("无法保存约束文件: {}", e)))?;
    // ok_unit 同款：unit → JSON null（与旧 RPC 分支的返回字节一致）。
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        let m: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.constraints");
        assert_eq!(m.trust, super::super::manifest::TrustLevel::System);
        assert_eq!(m.capabilities, vec!["filesystem_read".to_string(), "filesystem_write".to_string()]);
        let read = m.tools.iter().find(|t| t.name == "read_constraints").expect("read_constraints 在清单内");
        assert!(read.read_only);
        assert_eq!(read.schema["required"][0].as_str(), Some("projectPath"));
        let write = m.tools.iter().find(|t| t.name == "write_constraints").expect("write_constraints 在清单内");
        assert!(!write.read_only);
        // 两个工具都无权限声明（原命令无权限检查）。
        assert!(read.permission.is_none());
        assert!(write.permission.is_none());
    }
}

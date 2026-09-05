// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! PluginToolAdapter — 能力口内闸的权限适配器（Rust 强制层的闸构造形状）。
//!
//! v3 终态改判（kernel-plugin-architecture-decision.md §2，2026-09-05）：
//! tool_call 信封退役后本类型**不是**待拆脚手架，而是强制层的闸构造形状——
//! 能力口（git_cap Read/Git 两段闸、editor_cap Edit 家族）在口内构造它直接喂
//! `crate::utils::check_permission`。自 tool_plugins/plugin.rs 迁入（R5 脚手架
//! 拆除批，git mv 保历史）；`build()` 构造器（manifest permission 声明驱动）
//! 随 manifest/PluginRegistry 脚手架一并退役——现役消费方全部是口内 struct
//! 字面量构造（D4 §4：browser/uia 口直用 BrowserTool/DesktopTool，不经本类型）。
//!
//! 权限形状（P2-0 起，请求级构造）：
//! - `name()` = `"plugin:<id>.<tool>"` 精确名——规则寻址第一级 + 审计名；
//! - `rule_fallback_name()` = 家族名——既有用户规则（"Edit" deny 等）与
//!   auto 白名单经家族回退继续生效（§3.3/§3.4）；
//! - `check_permissions` 按 family 委托到家族检查函数（Edit→check_write_permission、
//!   Read→check_read_permission、Bash→bash::check、Git→git::check+子命令）；
//!   family = None → Passthrough（真权在口内业务自检/路径级授权）。

use std::borrow::Cow;

use super::Tool;

/// 权限引擎适配器：把「能力口 action」投给 `permissions::Tool` 面。
pub(crate) struct PluginToolAdapter {
    /// "plugin:builtin.git.git_commit"（口内构造期一次，精确规则寻址名）。
    pub(crate) full_name: String,
    pub(crate) read_only: bool,
    /// forward-map 后的物理路径（agent worktree 隔离下的执行真路径；规则匹配
    /// 在 check_permissions 内经 reverse_map 回逻辑路径——与 EditTool/ReadTool
    /// 同款，spec §5.6）。
    pub(crate) path: Option<String>,
    pub(crate) agent_id: Option<String>,
    /// 权限家族名（"Read"/"Edit"/"Bash"/"Git"）。
    pub(crate) family: Option<&'static str>,
    /// 命令原文（Bash 家族位）。
    pub(crate) command: Option<String>,
    /// Git 家族的子命令位（精确子命令 deny/allow/ask 规则依赖它）。
    pub(crate) subcommand: Option<String>,
}

impl Tool for PluginToolAdapter {
    fn name(&self) -> Cow<'static, str> {
        Cow::Owned(self.full_name.clone())
    }

    fn rule_fallback_name(&self) -> Option<&'static str> {
        self.family
    }

    fn get_path(&self) -> Option<std::path::PathBuf> {
        self.path.as_ref().map(std::path::PathBuf::from)
    }

    fn is_read_only(&self) -> bool {
        self.read_only
    }

    fn is_destructive(&self) -> bool {
        matches!(self.family, Some("Edit") | Some("Bash") | Some("Git"))
    }

    fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    fn check_permissions(
        &self,
        ctx: &crate::permissions::PermissionContext,
    ) -> crate::permissions::PermissionResult {
        use crate::permissions::{PermissionResult, bash, filesystem, git};

        let rules = ctx.read_rules();
        let Some(family) = self.family else {
            return PermissionResult::Passthrough;
        };
        match family {
            "Read" => {
                let Some(path) = self.path.as_deref() else {
                    return PermissionResult::Passthrough;
                };
                let logical =
                    ctx.reverse_map_path(std::path::Path::new(path), self.agent_id.as_deref());
                let logical_str = logical.to_string_lossy().replace('\\', "/");
                filesystem::check_read_permission(path, &ctx.sandbox, &rules, Some(&logical_str))
            }
            "Edit" => {
                let Some(path) = self.path.as_deref() else {
                    return PermissionResult::Passthrough;
                };
                let logical =
                    ctx.reverse_map_path(std::path::Path::new(path), self.agent_id.as_deref());
                let logical_str = logical.to_string_lossy().replace('\\', "/");
                filesystem::check_write_permission(path, &ctx.sandbox, &rules, Some(&logical_str))
            }
            "Bash" => {
                let Some(command) = self.command.as_deref() else {
                    return PermissionResult::Passthrough;
                };
                bash::check(command, &ctx.sandbox, &rules)
            }
            "Git" => {
                // GitTool 同款两段：仓库路径读检查 + 子命令规则。
                let (Some(path), Some(sub)) =
                    (self.path.as_deref(), self.subcommand.as_deref())
                else {
                    return PermissionResult::Passthrough;
                };
                let path_check = filesystem::check_read_permission(path, &ctx.sandbox, &rules, None);
                if let PermissionResult::Deny { .. } = path_check {
                    return path_check;
                }
                git::check(sub, &rules)
            }
            _ => PermissionResult::Passthrough,
        }
    }
}

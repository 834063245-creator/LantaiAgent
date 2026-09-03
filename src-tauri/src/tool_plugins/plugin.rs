// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! ToolPlugin trait + ToolContext + 权限适配器——内核插件的执行契约。
//!
//! 插件不直接摸全局，只经 `ToolContext` 使用内核能力。v1 有意收窄：
//! sandbox / process / network / credential 句柄随各自迁移批（Phase 2/3）进场，
//! 不预建空壳。异步分发用手写 boxed future（仓内无 async-trait 依赖，不为此引入）。

use std::future::Future;
use std::pin::Pin;

use super::manifest::ToolManifest;

/// 插件执行错误。边界上经 `message()` 折成 RPC 错误字符串。
#[derive(Debug)]
pub enum ToolError {
    /// 参数缺失/非法（manifest schema 之外的契约违规）。
    InvalidArgs(String),
    /// 权限/沙箱拒绝。
    Permission(String),
    /// 工具业务失败。
    Tool(String),
}

impl ToolError {
    pub fn message(&self) -> String {
        match self {
            ToolError::InvalidArgs(m) => m.clone(),
            ToolError::Permission(m) => format!("权限拒绝: {m}"),
            ToolError::Tool(m) => m.clone(),
        }
    }
}

/// 内核提供给插件的受限能力上下文。
pub struct ToolContext<'a> {
    /// Agent 归属（显式传参，无共享状态——并行子 Agent 不串扰，见 INVARIANTS/权限引擎纪律）。
    pub agent_id: Option<String>,
    /// 是否来自 Agent 工具链（agentInvoke 恒注入；用户 UI 路径为 false）。
    pub is_agent: bool,
    /// 工具调用关联键（args._callId，INVARIANTS #9 meta——streaming-executor 注入，
    /// 子 Agent 工具卡事件关联）。None = 用户路径 / 无关联，进度发射 no-op。
    pub call_id: Option<String>,
    pub(crate) state: &'a tauri::State<'a, crate::WorkspaceState>,
    pub(crate) app: &'a tauri::AppHandle,
}

impl<'a> ToolContext<'a> {
    /// 路径级读授权 + 沙箱决议（与旧命令 `resolve_read_dispatch` 同一真权路径）。
    pub async fn resolve_read(&self, directory: &str) -> Result<std::path::PathBuf, String> {
        crate::utils::resolve_read_dispatch(
            directory,
            self.is_agent,
            self.agent_id.as_deref(),
            self.state,
            self.app,
        )
        .await
    }

    /// 工具级权限过闸（与旧命令 `check_permission` 同路径——Ask 事件 + 回包等待）。
    /// 插件内的二次真权用：如 web 域的 WebFetchTool（域名规则 + SSRF）。
    pub async fn check_permission(&self, tool: &dyn crate::permissions::Tool) -> Result<(), String> {
        let perm_ctx = crate::utils::get_ctx(self.state)?;
        crate::utils::check_permission(tool, &perm_ctx, self.app).await
    }

    /// 增量输出型工具的进度发射（P2-4 §4.1）：`tool_call:progress` 事件按
    /// `_callId` 键控回推（与 shell 自有的 shell:output 通道正交——shell 不迁，
    /// 见 §4.3 裁决）。call_id 为 None（用户路径 / 无关联）时 no-op。
    /// TS 侧由 manifest 工具的 withProgressStream 自持订阅转发到 onProgress。
    // 首个生产消费者 = editor 大 diff 读 / fs 长扫描等增量输出型工具（P2-4
    // 落地机制，消费者随后续需求进场）。
    #[allow(dead_code)]
    pub fn emit_progress(&self, chunk: &str) {
        use tauri::Emitter;
        if let Some(call_id) = &self.call_id {
            let _ = self.app.emit(
                "tool_call:progress",
                serde_json::json!({ "callId": call_id, "chunk": chunk }),
            );
        }
    }
}

/// 进程内 Rust 插件接口。工具业务的家；内核只做注册表/权限/审计/分派。
pub trait ToolPlugin: Send + Sync {
    fn id(&self) -> &str;
    fn manifest(&self) -> &ToolManifest;

    /// 执行插件内一个工具。`args` 说模型的语言（manifest schema 声明的键，
    /// camelCase），`_agent_id` 等 meta 键嵌在 args 内原样透传（INVARIANTS #9）。
    fn execute<'a>(
        &'a self,
        ctx: &'a ToolContext<'a>,
        tool_name: &'a str,
        args: serde_json::Value,
    ) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, ToolError>> + Send + 'a>>;
}

/// 权限引擎适配器：把「插件工具」投给 `permissions::Tool` 面。
/// P2-0 起为**请求级形态**（dispatch 构造期生成，不再共享常量）：
/// - `name()` = `"plugin:<id>.<tool>"` 精确名——规则寻址第一级 + 审计名；
/// - `rule_fallback_name()` = manifest 声明的家族名——既有用户规则（"Edit" deny
///   等）与 auto 白名单经家族回退继续生效（§3.3/§3.4）；
/// - `check_permissions` 按 family 委托到家族检查函数（Edit→check_write_permission、
///   Read→check_read_permission、Bash→bash::check、Git→git::check+子命令）；
///   未声明 family = Passthrough（v1 语义，真权在插件内路径级授权——
///   resolve_read_dispatch / ctx.check_permission）。
pub(crate) struct PluginToolAdapter {
    /// "plugin:builtin.fs.write_file"（dispatch 构造期一次）。
    pub full_name: String,
    pub read_only: bool,
    /// manifest permission.path_key 从 args 提取并 forward-map 后的物理路径
    /// （agent worktree 隔离下的执行真路径；规则匹配在 check_permissions 内
    /// 经 reverse_map 回逻辑路径——与 EditTool/ReadTool 同款，spec §5.6）。
    pub path: Option<String>,
    pub agent_id: Option<String>,
    /// manifest 声明的家族名（"Edit"/"Read"/"Bash"/"Git"）。
    pub family: Option<&'static str>,
    /// manifest permission.command_key 从 args 提取的命令原文（Bash 家族）。
    pub command: Option<String>,
    /// manifest permission.subcommand 声明（Git 家族）。
    pub subcommand: Option<String>,
}

impl PluginToolAdapter {
    /// dispatch 侧构造：按 manifest 声明从 args 抽 path/command；path 过
    /// forward-map（与 require_write 的取路一致——先映射物理路径再过检查）。
    pub(crate) fn build(
        plugin_id: &str,
        tool_name: &str,
        spec: &super::manifest::ToolSpec,
        args: &serde_json::Value,
        agent_id: Option<&str>,
        perm_ctx: &crate::permissions::PermissionContext,
    ) -> Self {
        let perm = spec.permission.as_ref();
        let family = perm.and_then(|p| super::manifest::parse_family(&p.family));
        let path = perm
            .and_then(|p| p.path_key.as_deref())
            .and_then(|k| args.get(k))
            .and_then(|v| v.as_str())
            .map(|p| {
                perm_ctx
                    .forward_map_path(std::path::Path::new(p), agent_id)
                    .to_string_lossy()
                    .to_string()
            });
        let command = perm
            .and_then(|p| p.command_key.as_deref())
            .and_then(|k| args.get(k))
            .and_then(|v| v.as_str())
            .map(String::from);
        Self {
            full_name: format!("plugin:{plugin_id}.{tool_name}"),
            read_only: spec.read_only,
            path,
            agent_id: agent_id.map(String::from),
            family,
            command,
            subcommand: perm.and_then(|p| p.subcommand.clone()),
        }
    }
}

impl crate::permissions::Tool for PluginToolAdapter {
    fn name(&self) -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Owned(self.full_name.clone())
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

// ── args 提取辅助（manifest 驱动工具的参数抽取，键 = schema 声明键）──

pub(crate) fn arg_str(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
}

pub(crate) fn arg_bool(args: &serde_json::Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

pub(crate) fn arg_usize(args: &serde_json::Value, key: &str) -> Option<usize> {
    args.get(key).and_then(|v| v.as_u64()).map(|n| n as usize)
}

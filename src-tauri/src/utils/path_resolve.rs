// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 路径解析 + 权限检查（从 utils.rs 拆出）

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::permissions;
use crate::permissions::{PermissionContext, PermissionDecision, has_permission_to_use_tool, register_ask};
use crate::tools;
use crate::workspace;

pub(crate) fn project_root() -> PathBuf {
    // 生产环境（已安装应用）：使用 exe 所在目录 — python/ 和 src_python/ 打包在旁边
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dir_str = dir.to_string_lossy();
            // 路径中含 "target" = cargo 构建目录 → 开发模式；否则为已安装应用
            if !dir_str.contains("target") {
                return dir.to_path_buf();
            }
        }
    }
    // 开发模式：CARGO_MANIFEST_DIR 是 src-tauri/，项目根目录在上一级
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(PathBuf::from(".").as_path())
        .to_path_buf()
}

/// 设置活动工作区 — 现为空操作桩函数。请改用 workspace_activate。
/// 仅为 API 兼容性保留；前端不会直接调用此函数。

type WorkspaceState = Arc<Mutex<Option<workspace::WorkspaceHandle>>>;

/// 辅助函数：从 WorkspaceHandle 状态获取活动工作区路径。
/// 若未打开工作区则返回错误（而非静默回退到全局变量）。
pub(crate) fn workspace_path(state: &WorkspaceState) -> Result<String, String> {
    state.lock()
        .map_err(|e| format!("工作区状态错误: {e}"))?
        .as_ref()
        .map(|h| h.path.clone())
        .ok_or_else(|| "未打开工作区，请先打开项目".into())
}

/// 拒绝可能用于路径穿越的 ID。
/// 允许字母数字、连字符、下划线、点、冒号和空格。
pub(crate) fn sanitize_path_id(id: &str, label: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err(format!("{label} 不能为空"));
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") || id.contains('\0') {
        return Err(format!("{label} 包含非法字符"));
    }
    Ok(())
}

/// 验证路径是否在某个项目根目录的 `.lantai` 目录内。
/// 拒绝 `..` 穿越和 hologram 工作区之外的路径。
pub(crate) fn validate_hologram_path(path: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err("路径包含非法字符".into());
    }
    let canonical = std::path::Path::new(path);
    let normalized = canonical.to_string_lossy().replace('\\', "/");
    if normalized.contains("/../") || normalized.starts_with("../") || normalized.ends_with("/..") {
        return Err("路径包含目录穿越序列".into());
    }
    if !normalized.contains(".lantai") {
        return Err("路径不在 .lantai 目录范围内".into());
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════
// Phase 2：权限辅助函数（2026-08-04：with_workspace 已删 — 全库零调用）

/// 从工作区状态获取 PermissionContext，并立即释放锁。
pub(crate) fn get_ctx(state: &WorkspaceState) -> Result<Arc<PermissionContext>, String> {
    let guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
    let handle = guard.as_ref().ok_or("未打开工作区，请先打开项目")?;
    Ok(handle.permission_ctx.clone())
}

// （check_mcp_permission——引擎 MCP 工具的 RPC 级权限闸——随图谱全量退役
//  删除，2026-09-09：唯一调用方 hologram_run_check 已退役；外部 MCP 工具
//  的权限面在 TS 执行器（agent 权限系统），不经壳 RPC。）

/// 检查工具权限。若为 Ask，则发送事件并等待用户响应。
pub(crate) async fn check_permission(
    tool: &dyn permissions::Tool,
    ctx: &PermissionContext,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    match has_permission_to_use_tool(tool, ctx) {
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Deny { reason } => Err(reason),
        PermissionDecision::Ask { request_id, reason, suggestions, danger } => {
            // 先注册 receiver 再 emit：yolo/auto 模式下前端收到事件会零延迟
            // 自动回包，若回包先于 register_ask 到达，resolve_ask 查不到条目
            // 会静默丢弃答案，命令只能等满 300s 超时——表现为工具
            // 「挂起 5 分钟后报权限超时」。注册先行后该窗口结构性关闭
            // （回包不可能早于事件本身到达）。
            let rx = register_ask(request_id.clone());
            // Ask 载荷的工具名（P2-0 §3.4）：有家族回退用家族名——前端
            // AUTO_WHITELIST 按家族名匹配 auto 模式白名单（"Edit"），插件
            // 精确名（"plugin:builtin.fs.write_file"）会让 auto 静默失效；
            // 无回退保持原名（七家族工具本名即家族名，字节不变）。
            let ask_tool = match tool.rule_fallback_name() {
                Some(f) => f.to_string(),
                None => tool.name().to_string(),
            };
            let _ = app.emit("permission-ask", serde_json::json!({
                "requestId": request_id,
                "tool": ask_tool,
                "path": tool.get_path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                "reason": reason,
                "danger": danger,
                "agentId": tool.agent_id(),
                "suggestions": suggestions.iter().map(|s| serde_json::json!({
                    "rule": s.rule,
                    "behavior": s.behavior,
                })).collect::<Vec<_>>(),
            }));
            match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
                Ok(Ok(true)) => {
                    // 异步 Ask→Allow 路径此前完全静默（探索报告确认）——补审计
                    let target = tool
                        .get_path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();
                    ctx.audit_allow(&tool.name(), &target);
                    Ok(())
                }
                Ok(Ok(false)) | Ok(Err(_)) => {
                    let target = tool
                        .get_path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();
                    ctx.audit_deny(&tool.name(), &target, "用户在确认弹窗中拒绝");
                    Err("用户拒绝了此操作".into())
                }
                Err(_) => {
                    // ⚡ 2026-08-04 状态治理：超时后移除残留的 Sender，
                    // 防止 PENDING_ASKS 只增不减地泄漏。
                    crate::permissions::remove_ask(&request_id);
                    let target = tool
                        .get_path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();
                    ctx.audit_deny(&tool.name(), &target, "权限请求超时（300s）自动拒绝");
                    Err("权限请求超时".into())
                }
            }
        }
    }
}

/// 同步检查权限（无 Await — 用于后台任务：Ask → 记录日志 + 拒绝并给出明确原因）。
/// 权限模式旁路（与前端 permission-ask 旁路对齐）：yolo → 全部 Ask 自动放行；
/// auto → 白名单工具放行。仅旁路 Ask — Deny（Critical 危险）始终拒绝。
pub(crate) fn check_permission_sync(
    tool: &dyn permissions::Tool,
    ctx: &PermissionContext,
) -> Result<(), String> {
    match has_permission_to_use_tool(tool, ctx) {
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Deny { reason } => Err(reason),
        PermissionDecision::Ask { reason, suggestions, .. } => {
            let target = tool
                .get_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            let mode = permissions::current_permission_mode();
            // auto 白名单两级（P2-0 §3.4）：插件工具的精确名不在白名单，
            // 经 rule_fallback_name 家族回退命中——否则 fs 写工具迁移后
            // auto 模式对它们静默失效（path_resolve L209 静默失效点）。
            if mode == permissions::PermissionMode::Yolo
                || (mode == permissions::PermissionMode::Auto
                    && (permissions::auto_mode_allows(&tool.name())
                        || tool
                            .rule_fallback_name()
                            .is_some_and(permissions::auto_mode_allows)))
            {
                ctx.audit_allow(&tool.name(), &target);
                return Ok(());
            }
            ctx.audit_deny(&tool.name(), &target, &format!("后台任务无法交互，自动拒绝: {}", reason));
            let hint = match suggestions.first() {
                Some(s) => format!("\n建议在 .lantai/permissions.json 添加: \"allow\": [\"{}\"]", s.rule),
                None => String::new(),
            };
            Err(format!("后台任务需要用户确认但无法交互: {}。请将对应操作加入 allow 规则或使用前台 Agent 执行。{}", reason, hint))
        }
    }
}

pub(crate) async fn require_read(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::ReadTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission(&tool, &ctx, app).await?;
    // 权限已授予 — 沙箱已在 check_permission 内部检查过。
    // 不再重复检查沙箱边界；用户批准的外部读取必须放行。
    std::fs::canonicalize(&physical)
        .map_err(|e| format!("无法解析路径 {}: {}", physical_str, e))
}

pub(crate) async fn require_write(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::EditTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission(&tool, &ctx, app).await?;
    ctx.resolve_write(&physical_str)
}

/// ponytail: 用户 UI 操作的路径解析 — 只做 forward-map + sandbox resolve,
/// 不检查权限规则. 权限系统是给 Agent 的, 用户在 UI 上的操作不受权限限制.
/// safety check 仍然保留在写路径 (防误操作系统文件).
pub(crate) fn resolve_path_user_read(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), None);
    let physical_str = physical.to_string_lossy().to_string();
    ctx.resolve_read(&physical_str)
}

pub(crate) fn resolve_path_user_write(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), None);
    let physical_str = physical.to_string_lossy().to_string();
    ctx.resolve_write(&physical_str)
}

/// ponytail: 根据 is_agent 标志选择路径解析方式 — Agent 走权限检查(弹 Ask), UI 只解析.
/// 前端必须发 isAgent(camelCase) 匹配 Rust 参数 is_agent; 旧的 _agent 因 Tauri 默认
/// camelCase 重命名永远对不上, 导致 agent 外部读走 user 路径被沙箱静默硬拒.
pub(crate) async fn resolve_read_dispatch(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    if is_agent {
        require_read(file_path, agent_id, state, app).await
    } else {
        resolve_path_user_read(file_path, state)
    }
}

pub(crate) async fn resolve_write_dispatch(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    if is_agent {
        require_write(file_path, agent_id, state, app).await
    } else {
        resolve_path_user_write(file_path, state)
    }
}

// ═══════════════════════════════════════════════════════════════
// 免检解析（kernel-plugin-runtime P2-0 §3.5）——口内已过闸的工具专用：
// 能力口（editor_cap 等）的权限门在口内构造 PluginToolAdapter 过
// check_permission（permissions/adapter.rs），口内业务走免检解析——
// 与命令 is_agent 分流的差别只是省去规则引擎检查（同一语义已在口内
// 过闸），forward-map 与沙箱决议逐字保留。
// ═══════════════════════════════════════════════════════════════

/// 读路径免检解析：agent = forward-map + canonicalize（require_read 的收尾
/// 语义）；用户 = resolve_path_user_read（forward-map(None) + 沙箱）。
pub(crate) fn resolve_read_unchecked(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<PathBuf, String> {
    if !is_agent {
        return resolve_path_user_read(file_path, state);
    }
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    std::fs::canonicalize(&physical)
        .map_err(|e| format!("无法解析路径 {}: {}", file_path, e))
}

/// 写路径免检解析：forward-map（agent 带归属）+ sandbox resolve_write。
pub(crate) fn resolve_write_unchecked(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    let agent = if is_agent { agent_id } else { None };
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent);
    ctx.resolve_write(&physical.to_string_lossy())
}

// （require_git_dispatch / require_git 已随 commands/git_cmds.rs 退役——
//  kernel-plugin-runtime P2-3 权限检查移 dispatch 侧 adapter；git 域收口
//  （2026-09-05，R3-c）后 git 权限闸在 git_cap 能力口内（PluginToolAdapter
//  构造——commands/git_cap.rs），本文件只留 git_exec_path。）

/// git 命令的执行路径换算 — 权限检查（dispatch 侧 Git/Read 家族 adapter）
/// 保持现状不动；本函数只解决「权限检查按 _agent_id 映射进 worktree 做规则匹配，
/// 执行却在主仓」的错位：agent 有活跃 worktree 隔离时返回 worktree 内对应路径，
/// 否则原样返回（无隔离 / 非 agent 的用户 UI 操作均幂等，不触碰工作区状态）。
pub(crate) fn git_exec_path(
    repo_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<String, String> {
    if !is_agent {
        return Ok(repo_path.to_string());
    }
    let ctx = get_ctx(state)?;
    Ok(ctx
        .forward_map_path(std::path::Path::new(repo_path), agent_id)
        .to_string_lossy()
        .to_string())
}

pub(crate) async fn require_command(command: &str, state: &tauri::State<'_, WorkspaceState>, app: &tauri::AppHandle) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    let tool = tools::BashTool { command: command.to_string() };
    check_permission(&tool, &ctx, app).await
}

pub(crate) fn require_command_sync(command: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    let tool = tools::BashTool { command: command.to_string() };
    check_permission_sync(&tool, &ctx)
}

pub(crate) fn require_read_sync(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(std::path::Path::new(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::ReadTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission_sync(&tool, &ctx)?;
    std::fs::canonicalize(&physical)
        .map_err(|e| format!("无法解析路径 {}: {}", physical_str, e))
}
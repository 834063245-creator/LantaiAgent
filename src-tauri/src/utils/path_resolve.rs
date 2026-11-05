// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 路径解析 + 权限检查（从 utils.rs 拆出）

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::permissions;
use crate::permissions::{PermissionContext, PermissionDecision, has_permission_to_use_tool, register_ask};
use crate::sandbox::{Sandbox, expand_home, is_symlink_or_junction, logical_path};
use crate::tools;
use crate::workspace;

/// fs 路径解析入口统一前置：`~/` → home 展开（2026-09-13 修）。
///
/// 背景：`fs_cap` 的 read/write 全链路此前**不认波浪号**——`~/.lantai/mcp.json`
/// 被当相对路径解析，落到 "parent directory not found"；而设置页 MCP 面板正是用
/// 这个路径读写用户级 mcp.json，错误又被 UI 的 catch 吞成"文件不存在"⇒
/// **面板恒显示空、且新增 server 存不进去**（实测复现，见
/// docs/plans/office-cli-integration-plan.md §5 坑账）。
///
/// 展开只对 `~`/`~/`/`~\` 前缀生效，其余路径原样——归属裁决仍由沙箱负责。
fn expand_input(file_path: &str) -> PathBuf {
    expand_home(file_path)
}

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
            // 越界标记（2026-10-30）：前端 auto 模式的自动放行据此**不**生效——
            // 「auto = 安全编辑自动放行」不覆盖工作区外写入（它不在项目内，不是安全编辑）。
            let outside_project = tool
                .get_path()
                .map(|p| ctx.sandbox.is_outside_project(&p))
                .unwrap_or(false);
            let _ = app.emit("permission-ask", serde_json::json!({
                "requestId": request_id,
                "tool": ask_tool,
                "path": tool.get_path().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
                "outsideProject": outside_project,
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
    let physical = ctx.forward_map_path(&expand_input(file_path), agent_id);
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
    let physical = ctx.forward_map_path(&expand_input(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::EditTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission(&tool, &ctx, app).await?;
    // 权限层已放行（用户确认卡 / yolo 自动放行）——越界写**不再由沙箱二次否决**
    // （2026-10-30 修：旧实现「批准了仍被沙箱拒」，同一件事判两次）。项目内写零变化；
    // 符号链接 / junction 拒绝保留（resolve_write_approved 内）。
    let p = std::path::Path::new(&physical_str);
    if ctx.sandbox.is_outside_project(p) {
        ctx.sandbox.resolve_write_approved(p).into_result()
    } else {
        ctx.resolve_write(&physical_str)
    }
}

/// 已登记工作区的 `.lantai/**` 只读解析（2026-11-05 入口 UX 批）。
///
/// 为什么需要：首页（案头）要读**每个已登记工作区**的卷目录投影（上卷 / 同区其他卷），
/// 而它不属于任何一个「正在打开」的工作区。旧路径靠冷启动先把上次工作区激活
/// （`get_ctx` 要求有活动工作区）——副作用是启动即装配 Agent / 恢复会话，用户从
/// 首页点进来时还撞上 `isBusy` 被拦。入口改成「进区才物化」后，首页读面必须能在
/// **不开工作区**的前提下读到这些目录。
///
/// 判据（最小豁免，边界不放宽）：
///   1. 目标真实路径必须落在**注册表里某个工作区根**的 `.lantai/` 子树内
///      （`~/.lantai/workspaces.json` = 用户绑定过的目录清单，不是任意路径）；
///   2. 只服务**用户通道只读**（`resolve_path_user_read`）：agent 通道走
///      `require_read`（权限 + forward-map），写通道 `resolve_path_user_write` 不调用；
///   3. 与 `Sandbox::resolve_read` 同两件：拒绝符号链接 / junction；返回解析后的真实路径。
///
/// 返回 `None` = 不属于任何已登记工作区的 `.lantai`（调用方照旧 `get_ctx` 走工作区沙箱）。
pub(crate) fn registered_workspace_read(file_path: &Path) -> Option<Result<PathBuf, String>> {
    let reg = crate::commands::workspace::registry::read_registry();
    let roots: Vec<&str> = reg.workspaces.iter().map(|e| e.path.as_str()).collect();
    read_under_workspace_lantai(file_path, &roots)
}

/// 前缀归属（组件级；Windows 上大小写不敏感——盘符/目录段大小写不作为身份）。
#[cfg(windows)]
fn path_under(path: &Path, root: &Path) -> bool {
    let fold = |p: &Path| -> Vec<String> {
        logical_path(p)
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let p = fold(path);
    let r = fold(root);
    p.len() >= r.len() && p[..r.len()] == r[..]
}

#[cfg(not(windows))]
fn path_under(path: &Path, root: &Path) -> bool {
    logical_path(path).starts_with(logical_path(root))
}

/// 判据本体（纯函数——注册表真源在调用方，测试直接给根清单，不碰进程级 home/注册表）。
fn read_under_workspace_lantai(file_path: &Path, roots: &[&str]) -> Option<Result<PathBuf, String>> {
    if roots.is_empty() {
        return None;
    }
    // 归属判定 = 逻辑路径（去 Windows verbatim 前缀，与 Sandbox::contains 同规）。
    // Windows 上大小写不敏感：注册表路径与 `.last_project`/前端拼出的路径可能只有
    // 盘符或目录段大小写不同，字节比较会误判「不在已登记工作区内」。
    let mut owned = false;
    for root in roots {
        if root.trim().is_empty() {
            continue;
        }
        if path_under(file_path, &Path::new(root).join(".lantai")) {
            owned = true;
            break;
        }
    }
    if !owned {
        return None;
    }
    // 归属成立后再规范化：符号链接 / junction 一律不进豁免（与 Sandbox::resolve_read 同判）。
    if is_symlink_or_junction(file_path) {
        return Some(Err("user data path symlinks are not allowed".into()));
    }
    // 缺失文件按「父目录 + 文件名」解析（首页读 `_index.json` 这类可能缺席的投影缓存）；
    // 解析不出 = 不是可读目标，交回调用方（照旧 get_ctx）。
    let real = match std::fs::canonicalize(file_path) {
        Ok(real) => real,
        Err(_) => {
            let parent = file_path.parent()?;
            let name = file_path.file_name()?;
            std::fs::canonicalize(parent).ok()?.join(name)
        }
    };
    // 规范化后必须仍在某个已登记工作区的 .lantai 内（防父级 junction 把路径带出边界）。
    let inside = roots.iter().any(|root| {
        if root.trim().is_empty() {
            return false;
        }
        let lantai_real = std::fs::canonicalize(Path::new(root).join(".lantai")).ok();
        lantai_real.is_some_and(|l| path_under(&real, &l))
    });
    if inside {
        Some(Ok(real))
    } else {
        None
    }
}

/// ponytail: 用户 UI 操作的路径解析 — 只做 forward-map + sandbox resolve,
/// 不检查权限规则. 权限系统是给 Agent 的, 用户在 UI 上的操作不受权限限制.
/// safety check 仍然保留在写路径 (防误操作系统文件).
///
/// ⚡ 用户级白名单路径（`~/.lantai/**`，判据见 `Sandbox::user_data_read/write`）
/// **先于工作区**解析：它们放行与否只看 home，而拿到 `ctx`（Sandbox 实例）必须
/// 工作区已打开——壳启动早期（provider 配方存量迁移写盘 = bootShell 第 0 步、
/// 用户级 mcp.json 读取 = main.ts）工作区还没开，豁免会被
/// 「未打开工作区，请先打开项目」挡死（2026-09-26 真机事故：providers.yml
/// 永远建不出来）。非白名单路径照旧 `get_ctx`，边界不放宽。
pub(crate) fn resolve_path_user_read(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let expanded = expand_input(file_path);
    if let Some(r) = Sandbox::user_data_read(&expanded) {
        return r.into_result();
    }
    // 已登记工作区的 .lantai/**：首页读面不依赖「哪个工作区正被打开」（见函数注）。
    if let Some(r) = registered_workspace_read(&expanded) {
        return r;
    }
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(&expanded, None);
    let physical_str = physical.to_string_lossy().to_string();
    ctx.resolve_read(&physical_str)
}

pub(crate) fn resolve_path_user_write(file_path: &str, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let expanded = expand_input(file_path);
    if let Some(r) = Sandbox::user_data_write(&expanded) {
        return r.into_result();
    }
    let ctx = get_ctx(state)?;
    let physical = ctx.forward_map_path(&expanded, None);
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
    let physical = ctx.forward_map_path(&expand_input(file_path), agent_id);
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
    let physical = ctx.forward_map_path(&expand_input(file_path), agent);
    let p = physical.to_string_lossy().to_string();
    // 免检 = 口内已过闸：agent 的越界写在闸里已拿到 Allow（用户确认 / yolo），
    // 这里不再由沙箱二次否决（与 require_write 同一语义，2026-10-30）。
    if is_agent && ctx.sandbox.is_outside_project(std::path::Path::new(&p)) {
        return ctx.sandbox.resolve_write_approved(std::path::Path::new(&p)).into_result();
    }
    ctx.resolve_write(&p)
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

/// office 域工具过闸（2026-09-15 R3，见 docs/plans/office-cli-integration-plan.md §11.3）：
/// 只审**声明的目标文件**（OfficeTool），不把 officecli 的 DOM 路径 / JSON 载荷
/// 当成文件系统路径去猜——那条启发式正是"默认模式每次调用都弹卡"的根因。
pub(crate) async fn require_office(
    targets: &[(String, bool)],
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let ctx = get_ctx(state)?;
    let tool = tools::OfficeTool {
        targets: targets.to_vec(),
        agent_id: agent_id.map(|s| s.to_string()),
    };
    check_permission(&tool, &ctx, app).await
}

pub(crate) fn require_read_sync(file_path: &str, agent_id: Option<&str>, state: &tauri::State<'_, WorkspaceState>) -> Result<PathBuf, String> {
    let ctx = get_ctx(state)?;
    // Phase 3：当隔离模式为 Worktree 时，前向映射到 worktree 物理路径 (spec §5.6)
    let physical = ctx.forward_map_path(&expand_input(file_path), agent_id);
    let physical_str = physical.to_string_lossy().to_string();
    let tool = tools::ReadTool { path: physical_str.clone(), agent_id: agent_id.map(|s| s.to_string()) };
    check_permission_sync(&tool, &ctx)?;
    std::fs::canonicalize(&physical)
        .map_err(|e| format!("无法解析路径 {}: {}", physical_str, e))
}
#[cfg(test)]
mod tests {
    use super::*;

    /// 临时根（自清理）——判据本体是纯函数，不碰进程级 home / 注册表，故可并行跑。
    struct TempRoot(std::path::PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "lantai_ws_read_{tag}_{}",
                crate::audit::now_iso().replace([':', '.', '+'], "-")
            ));
            std::fs::create_dir_all(&dir).expect("建临时目录");
            Self(std::fs::canonicalize(&dir).unwrap_or(dir))
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 首页读面（2026-11-05 入口 UX 批）：已登记工作区的 .lantai/** 免活动工作区可读。
    #[test]
    fn registered_workspace_lantai_reads_without_active_workspace() {
        let root = TempRoot::new("allow");
        let ws = root.path().join("ws");
        let sessions = ws.join(".lantai").join("sessions");
        std::fs::create_dir_all(&sessions).expect("建会话根");
        std::fs::write(sessions.join("1.ndjson"), "{\"type\":\"head\"}\n").expect("写卷");
        let roots = vec![ws.to_string_lossy().to_string()];
        let roots: Vec<&str> = roots.iter().map(String::as_str).collect();

        // 目录（list_volumes）与已落盘文件都放行。
        assert!(
            matches!(read_under_workspace_lantai(&sessions, &roots), Some(Ok(_))),
            "已登记工作区的会话根应免工作区可读"
        );
        assert!(
            matches!(read_under_workspace_lantai(&sessions.join("1.ndjson"), &roots), Some(Ok(_))),
            "已登记工作区的卷文件应免工作区可读"
        );
        // 缺失的投影缓存（_index.json）按「父目录 + 文件名」解析——首页首启常态。
        assert!(
            matches!(read_under_workspace_lantai(&sessions.join("_index.json"), &roots), Some(Ok(_))),
            "缺失的 _index.json 也应可解析（读失败留到读面）"
        );

        // 规范化后的真实路径必须落在该工作区的 .lantai 内。
        let allowed = read_under_workspace_lantai(&sessions.join("1.ndjson"), &roots).unwrap().unwrap();
        assert!(allowed.starts_with(&ws.canonicalize().unwrap().join(".lantai")));
    }

    /// 边界不放宽：工作区源码目录 / 未登记的 .lantai / 空注册表一律 None（照旧 get_ctx）。
    #[test]
    fn registered_workspace_lantai_denies_everything_else() {
        let root = TempRoot::new("deny");
        let ws = root.path().join("ws");
        let sessions = ws.join(".lantai").join("sessions");
        std::fs::create_dir_all(&sessions).expect("建会话根");
        std::fs::create_dir_all(ws.join("src")).expect("建源码目录");
        std::fs::write(ws.join("src").join("main.rs"), "fn main() {}").expect("写源码");
        let other = root.path().join("other");
        std::fs::create_dir_all(other.join(".lantai").join("sessions")).expect("建别家会话根");
        let roots = vec![ws.to_string_lossy().to_string()];
        let roots: Vec<&str> = roots.iter().map(String::as_str).collect();

        assert!(
            read_under_workspace_lantai(&ws.join("src").join("main.rs"), &roots).is_none(),
            "工作区源码不在 .lantai 内——不放行"
        );
        assert!(
            read_under_workspace_lantai(&other.join(".lantai").join("sessions"), &roots).is_none(),
            "未登记工作区的 .lantai——不放行"
        );
        assert!(
            read_under_workspace_lantai(&sessions.join("1.ndjson"), &[]).is_none(),
            "空注册表——不放行"
        );
        // 相邻名字（.lantai2）不得冒充 .lantai（Path 组件前缀，不是字符串前缀）。
        let adjacent = ws.join(".lantai2").join("sessions");
        assert!(
            read_under_workspace_lantai(&adjacent, &roots).is_none(),
            ".lantai2 不是 .lantai 子树——不放行"
        );
    }

    /// 符号链接 / junction 一律拒绝（与 Sandbox::resolve_read 同判）——只测得上符号链接的平台。
    #[cfg(unix)]
    #[test]
    fn registered_workspace_lantai_rejects_symlinks() {
        let root = TempRoot::new("link");
        let ws = root.path().join("ws");
        let sessions = ws.join(".lantai").join("sessions");
        std::fs::create_dir_all(&sessions).expect("建会话根");
        let link = sessions.join("link.ndjson");
        std::os::unix::fs::symlink(sessions.join("target.ndjson"), &link).expect("建符号链接");
        let roots = vec![ws.to_string_lossy().to_string()];
        let roots: Vec<&str> = roots.iter().map(String::as_str).collect();
        assert!(
            matches!(read_under_workspace_lantai(&link, &roots), Some(Err(_))),
            "符号链接必须拒绝"
        );
    }

    /// Windows：注册表路径与前端拼出的路径大小写不同（盘符/目录段）也必须命中
    /// ——否则首页上卷会退回「未打开工作区」。
    #[cfg(windows)]
    #[test]
    fn registered_workspace_lantai_is_case_insensitive_on_windows() {
        let root = TempRoot::new("case");
        let ws = root.path().join("ws");
        let sessions = ws.join(".lantai").join("sessions");
        std::fs::create_dir_all(&sessions).expect("建会话根");
        std::fs::write(sessions.join("1.ndjson"), "{}\n").expect("写卷");
        let upper = ws.to_string_lossy().to_uppercase();
        let roots = vec![upper];
        let roots: Vec<&str> = roots.iter().map(String::as_str).collect();
        assert!(
            matches!(read_under_workspace_lantai(&sessions.join("1.ndjson"), &roots), Some(Ok(_))),
            "Windows 路径归属必须大小写不敏感"
        );
    }
}

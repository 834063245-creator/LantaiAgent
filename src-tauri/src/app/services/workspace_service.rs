// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 工作区生命周期业务（L3 自 commands/workspace.rs 迁入，零语义改写）。
//! 迁移/日志/孤儿收养/上下文 GC 归应用层；权限与进程清理横切留壳。

use std::sync::Arc;

use crate::app::AppContexts;

/// workspace_activate 业务体：数据目录迁移 + 结构化日志 + 上下文确保 +
/// 孤儿 worktree 收养（句柄装配由壳层完成）。
pub(crate) async fn activate(
    path: String,
    app_ctx: Arc<AppContexts>,
    handle: &mut crate::workspace::WorkspaceHandle,
) -> Result<(), String> {
    // .hologram → .lantai 迁移（2026-08-23 改名）：每个打开的工作区根
    // 各自迁移。先于日志初始化与 watcher 启动，避免新目录还没就位就写新数据。
    let project_path = std::path::Path::new(&path);
    if !path.trim().is_empty() {
        if let Err(e) = crate::utils::migrate_hologram_to_lantai(project_path) {
            eprintln!("[lantai] 工作区数据目录迁移失败 {path}: {e}");
        }
    }
    // 在首次打开项目时初始化结构化日志
    let _ = crate::utils::LOG_GUARD.get_or_init(|| crate::logging::init_logging(project_path));
    handle.activate(&crate::utils::project_root());

    // L1 兼容腰：单槽激活同时确保数据上下文——壳层 watcher / 图命令
    // 与上下文见到的永远是同一引擎实例（杜绝同根双实例漂移）。
    // 引擎初始化（开 SQLite）是阻塞 IO，在 spawn_blocking 中执行。
    if !path.trim().is_empty() {
        let path_for_ctx = path.trim().to_string();
        let engine = tokio::task::spawn_blocking(move || {
            app_ctx.ensure_context(&path_for_ctx).map(|c| c.engine.clone())
        })
        .await
        .map_err(|e| format!("上下文初始化任务失败: {e}"))?;
        match engine {
            Ok(engine) => handle.engine = Some(engine),
            Err(e) => {
                // 上下文失败不阻断激活（无图可用的降级与既有语义一致——
                // 引擎损坏时命令层各自报错），但必须可见。
                eprintln!("[lantai] 数据上下文初始化失败 {path}: {e}");
            }
        }
    }

    // 孤儿 worktree 收养（2026-08-15 收口）：isolation 注册表是内存态，
    // 重启后 .lantai/worktrees/ 里未合并的 worktree 会变成无法
    // diff/merge/discard 的死账。启动时扫描并重建记录，前端再把它
    // 重挂到新主 Agent 的 TaskBoard，agent_merge 即恢复可用。
    let adopted = crate::agent_isolation::AgentIsolation::scan_orphan_worktrees(std::path::Path::new(&path));
    for (slug, wt_path) in &adopted {
        match crate::agent_isolation::AgentIsolation::adopt_worktree(std::path::Path::new(&path), wt_path) {
            Ok(iso) => handle.permission_ctx.set_isolation(slug, iso),
            Err(e) => eprintln!("[isolation] 孤儿 worktree 收养失败 {slug}: {e}"),
        }
    }
    if !adopted.is_empty() {
        eprintln!("[isolation] 收养 {} 个重启前遗留的孤儿 worktree", adopted.len());
    }
    Ok(())
}

/// workspace_deactivate 业务体：上下文 GC + 进程池清理（横切）。
pub(crate) async fn deactivate(old_path: String, app_ctx: Arc<AppContexts>) -> Result<(), String> {
    // L1：停用时释放该根的数据上下文（workspace-session-ownership-rework
    // 2026-08-27：无会话绑定判定——引擎上下文只跟活动工作区走，切走即关）——
    // 引擎实例停 watcher、Arc 落 Drop 关库连接。
    if !old_path.trim().is_empty() {
        if let Some(canon) = crate::app::canonical_root(&old_path) {
            app_ctx.gc_if_unused(&canon, &[]);
        }
    }
    // ⚡ 2026-08-04 状态治理：workspace 切换时清理进程池全局，
    // 防止旧项目的 LSP / PTY / 后台任务跨 workspace 串场或泄漏。
    // - LSP/PTY 绑项目根，切走必须停；引擎子进程随上下文 GC/remote.shutdown 走；
    // - 后台 shell 任务（BG_JOBS）kill_tree 防 cargo/rustc 孙进程占锁。
    crate::utils::kill_all_bg();
    crate::pty_manager::kill_all();
    crate::lsp_manager::stop_all();
    // 粘性 cwd 全清 — 旧项目的目录状态不得带进新工作区（代际递增使
    // 在途捕获不落新账）。
    crate::utils::sticky_cwd::clear_all();
    Ok(())
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 工作区生命周期 Tauri 命令。

use tauri;

#[tauri::command]
pub(crate) async fn workspace_activate(
    path: String,
    state: tauri::State<'_, crate::WorkspaceState>,
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

    let handle = crate::workspace::WorkspaceHandle::new(&path);
    handle.activate(&crate::utils::project_root());

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

    *crate::utils::lock_or_recover(&state) = Some(handle);
    Ok(())
}

/// 停用当前工作区。停止文件监视器，清除已变更文件。
/// 在切换到新工作区或关闭应用之前调用。
#[tauri::command]
pub(crate) async fn workspace_deactivate(
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    // 在短暂持有锁时取出句柄，然后在停用前释放锁。
    // deactivate() 停止监视器；在 state 互斥锁下执行此操作
    // 会在整个停止期间阻塞所有需要 state 的其他命令
    // （workspace_activate、get_full_graph、…）。
    let handle = {
        let mut guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
        guard.take() // take() 同时把 state 内的 Option 置 None
    };
    if let Some(mut h) = handle {
        h.deactivate();
        // ⚡ 2026-08-04 状态治理：workspace 切换时清理进程池全局，
        // 防止旧项目的 LSP / PTY / 后台任务 / 引擎(MCP) 跨 workspace 串场或泄漏。
        // - LSP/PTY/MCP 绑项目根，切走必须停；
        // - 后台 shell 任务（BG_JOBS）kill_tree 防 cargo/rustc 孙进程占锁。
        crate::utils::kill_all_bg();
        crate::pty_manager::kill_all();
        crate::lsp_manager::stop_all();
        crate::commands::external::stop_mcp();
        // 粘性 cwd 全清 — 旧项目的目录状态不得带进新工作区（代际递增使
        // 在途捕获不落新账）。
        crate::utils::sticky_cwd::clear_all();
    }
    Ok(())
}

/// 启动活跃工作区的文件监视器。
/// 必须在 workspace_activate 之后调用。
#[tauri::command]
pub(crate) async fn workspace_start_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    if let Some(ref mut handle) = *crate::utils::lock_or_recover(&state) {
        handle.start_watcher(app);
        Ok(())
    } else {
        Err("没有活跃的工作区".into())
    }
}

/// 读取最近工作区路径（.last_project——workspace_activate 每次绑定都写，
/// 与图谱引擎无关）。冷启动恢复信号之一；图谱引擎停用时是**唯一**信号
/// （load_graph_json 的引擎路径会顺手 engine_init，关图冷启动不可走）。
#[tauri::command]
pub(crate) fn get_last_project() -> Result<Option<String>, String> {
    let last = std::fs::read_to_string(crate::utils::project_root().join(".last_project"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(last)
}

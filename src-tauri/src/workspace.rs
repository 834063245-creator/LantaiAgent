// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WorkspaceHandle — 持有一个打开项目的所有后端状态。
// 替代分散的全局变量: ACTIVE_PROJECT, SANDBOX, AUDIT_LOGGER。
//
// v4 Phase 2: Sandbox 降级，权限系统升级为 PermissionContext（两层自治架构）。
// check_read/check_write/check_command 已删除 — 替换为 has_permission_to_use_tool()。
//
// 生命周期:
//   let mut handle = WorkspaceHandle::new(path);
//   handle.activate(project_root);           // 注册为活跃工作区
//   // ... 用户操作 ...
//   handle.deactivate();                     // 清理状态
//
// 作为 Tauri state 管理: State<Arc<Mutex<Option<WorkspaceHandle>>>>
//
// （图谱全量退役 2026-09-09：引擎传输句柄 / 通知泵（start_watcher——
//  订阅引擎 watcher + drain 通知队列转译 analyze-* 与 graph-updated 事件）/
//  changed_files 登记簿（唯一消费方 run_check 与引擎分发已随批退役）一并
//  移除——引擎进程不再被兰台拉起，文件监控归引擎自有 serve 形态。）

use std::fs;
use std::path::Path;
use std::sync::Arc;

use crate::permissions::PermissionContext;

// ── 工作区范围的状态 ──────────────────────────────────────────

pub struct WorkspaceHandle {
    /// 规范化的工作区目录。
    pub path: String,

    /// 权限系统（替代旧 Sandbox）。
    /// 用 Arc 以便在不持有 state Mutex 的情况下跨异步 Tauri command 共享。
    pub permission_ctx: Arc<PermissionContext>,
}

impl WorkspaceHandle {
    /// 创建新的工作区句柄。不会激活它。
    pub fn new(path: &str) -> Self {
        let project_path = Path::new(path);
        Self {
            path: path.to_string(),
            permission_ctx: Arc::new(PermissionContext::new(project_path)),
        }
    }

    /// 激活此工作区: 持久化到 .last_project 以便冷启动恢复。
    /// 空路径（占位工作区解绑）不写——「最近工作区」记忆只记真实绑定。
    pub fn activate(&self, project_root: &Path) {
        if self.path.trim().is_empty() {
            return;
        }
        let last_path = project_root.join(".last_project");
        let _ = fs::write(&last_path, &self.path);
    }

    /// 停用此工作区: 清理状态（幂等）。
    pub fn deactivate(&mut self) {}
}

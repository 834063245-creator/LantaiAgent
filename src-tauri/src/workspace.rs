// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WorkspaceHandle — 持有一个打开项目的所有后端状态。
// 替代分散的全局变量: ACTIVE_PROJECT, SANDBOX, AUDIT_LOGGER,
// LAST_CHANGED_FILES, WatcherState。
//
// v4 Phase 2: Sandbox 降级，权限系统升级为 PermissionContext（两层自治架构）。
// check_read/check_write/check_command 已删除 — 替换为 has_permission_to_use_tool()。
//
// 生命周期:
//   let mut handle = WorkspaceHandle::new(path);
//   handle.activate(project_root);           // 注册为活跃工作区
//   handle.start_watcher(app_handle);       // 开始文件监控
//   // ... 用户操作 ...
//   handle.deactivate();                     // 停止监控，清理状态
//
// 作为 Tauri state 管理: State<Arc<Mutex<Option<WorkspaceHandle>>>>

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::permissions::PermissionContext;

// ── 工作区范围的状态 ──────────────────────────────────────────

pub struct WorkspaceHandle {
    /// 规范化的工作区目录。
    pub path: String,

    /// 权限系统（替代旧 Sandbox）。
    /// 用 Arc 以便在不持有 state Mutex 的情况下跨异步 Tauri command 共享。
    pub permission_ctx: Arc<PermissionContext>,

    /// 自上次检查以来的变更文件（原 LAST_CHANGED_FILES 全局变量）。
    pub changed_files: Arc<Mutex<Vec<String>>>,

    /// 该工作区的引擎进程通道（每工作区一个 `engine serve` 子进程的
    /// stdio MCP 传输；workspace_activate 时自数据上下文取用）。
    /// 占位工作区（path=''）为 None。引擎子进程惰性 spawn——首次
    /// transport 调用才拉起。
    pub(crate) transport: Option<Arc<crate::engine_transport::McpRemoteTransport>>,

    // 监控器内部状态
    watcher_running: Arc<AtomicBool>,
    watcher_thread: Option<JoinHandle<()>>,
}

/// 句柄被丢弃时兜底停用（防 activate 直接覆盖旧句柄导致 watcher 线程泄漏）。
/// deactivate() 幂等：未启动 watcher 时快速返回。
impl Drop for WorkspaceHandle {
    fn drop(&mut self) {
        self.deactivate();
    }
}

impl WorkspaceHandle {
    /// 创建新的工作区句柄。不会激活它或启动监控器。
    pub fn new(path: &str) -> Self {        let project_path = Path::new(path);
        Self {
            path: path.to_string(),
            permission_ctx: Arc::new(PermissionContext::new(project_path)),
            changed_files: Arc::new(Mutex::new(Vec::new())),
            transport: None,
            watcher_running: Arc::new(AtomicBool::new(false)),
            watcher_thread: None,
        }
    }

    /// 激活此工作区: 持久化到 .last_project 以便冷启动恢复。
    /// 空路径（占位工作区解绑）不写——「最近工作区」记忆只记真实绑定，
    /// 占位启动清空 .last_project 会摧毁引擎关态冷启动的唯一恢复信号
    ///（get_last_project——2026-08-22 引擎开关配套，实测踩中）。
    pub fn activate(&self, project_root: &Path) {
        if self.path.trim().is_empty() {
            return;
        }
        let last_path = project_root.join(".last_project");
        let _ = fs::write(&last_path, &self.path);
    }

    /// 停用此工作区: 停止文件监控器并清理临时状态。
    /// 监控线程有 2s 的优雅退出时间；超时后将被分离。
    pub fn deactivate(&mut self) {
        self.watcher_running.store(false, Ordering::SeqCst);
        if let Some(handle) = self.watcher_thread.take() {
            // 轮询最多 2s 等待线程自行退出。
            // 监控器每 1s 检查一次 `running`，所以 2s 足够一个轮询周期。
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                if handle.is_finished() {
                    let _ = handle.join();
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            // 如果 2s 后仍未结束，句柄被丢弃（分离）。
            // 线程将在下次检查 `running` 时退出。
        }
        if let Ok(mut files) = self.changed_files.lock() {
            files.clear();
        }
    }

    /// 启动此工作区的通知泵（Phase 3：引擎进程自带 notify watcher，壳侧
    /// mtime 轮询 watcher 退役）。
    ///
    /// 职责两件：
    /// 1. **watcher 订阅**——确保引擎进程的文件 watcher 以事件桥回调运行
    ///   （启动时一次；崩溃重启后新进程 engine_init 自动重起 watcher）；
    /// 2. **通知出泵**——drain transport 通知队列并转译：
    ///    - `notifications/progress` → analyze-phase / analyze-progress /
    ///      analyze-heartbeat（分析进度流，载荷形状与旧 run_analyze_with_progress
    ///      轮询一致）；
    ///    - `notifications/message`（watcher 变更摘要 / analyze_done）→
    ///      graph_snapshot 重查 → emit `graph-updated`（载荷形状与旧壳侧
    ///      watcher 一致：计数 + source_root，前端 `nc > 0` 守卫通过）。
    pub fn start_watcher(&mut self, app_handle: AppHandle) {
        self.watcher_running.store(false, Ordering::SeqCst);
        self.watcher_thread.take();

        // 占位工作区（无传输）不起泵。
        let Some(ref transport) = self.transport else {
            return;
        };
        let transport = transport.clone();
        let path = self.path.clone();
        let running = self.watcher_running.clone();

        self.watcher_running.store(true, Ordering::SeqCst);

        let handle = thread::spawn(move || {
            // 订阅（best-effort：失败仅可见于日志——引擎进程未起时 pump
            // 不 spawn，等首次图命令拉起后下一轮 message 自然接上）。
            if let Err(e) = transport.call("watcher_subscribe", &serde_json::json!({})) {
                eprintln!("[lantai-watch] watcher_subscribe 失败（drain 继续跑）: {e}");
            }

            let poll_interval = Duration::from_millis(300);
            let mut analyze_started: Option<std::time::Instant> = None;

            while running.load(Ordering::SeqCst) {
                thread::sleep(poll_interval);

                if !running.load(Ordering::SeqCst) {
                    break;
                }

                for notif in transport.take_notifications() {
                    match notif.get("method").and_then(|m| m.as_str()) {
                        Some("notifications/progress") => {
                            let params = notif.get("params").cloned().unwrap_or_default();
                            let message = params
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("")
                                .to_string();
                            let current = params.get("progress").and_then(|v| v.as_u64()).unwrap_or(0);
                            let total = params.get("total").and_then(|v| v.as_u64()).unwrap_or(0);
                            let start = *analyze_started.get_or_insert_with(std::time::Instant::now);
                            let _ = app_handle.emit("analyze-phase", serde_json::json!({
                                "phase": message,
                                "message": message,
                            }));
                            if total > 0 {
                                let _ = app_handle.emit("analyze-progress", serde_json::json!({
                                    "current": current,
                                    "total": total,
                                    "file": message,
                                }));
                            }
                            let _ = app_handle.emit("analyze-heartbeat", serde_json::json!({
                                "label": message,
                                "elapsed": format!("{:.1}s", start.elapsed().as_secs_f64()),
                            }));
                        }
                        Some("notifications/message") => {
                            // 图变更信号（watcher 增量摘要 / analyze_done）：
                            // 快照重查（毫秒级轻查询）→ graph-updated。
                            let Ok(raw) =
                                transport.call("graph_snapshot", &serde_json::json!({}))
                            else {
                                continue;
                            };
                            let Ok(snap) = serde_json::from_str::<serde_json::Value>(&raw) else {
                                continue;
                            };
                            let nc = snap.get("node_count").and_then(|v| v.as_u64()).unwrap_or(0);
                            let ec = snap.get("edge_count").and_then(|v| v.as_u64()).unwrap_or(0);
                            if nc == 0 {
                                // 与旧 watcher 同语义：前端 `nc > 0` 守卫，空图不推
                                continue;
                            }
                            let summary = serde_json::json!({
                                "total_nodes": nc,
                                "node_count": nc,
                                "edge_count": ec,
                                "meta": { "source_root": &path },
                            });
                            if let Err(e) = app_handle.emit("graph-updated", summary.to_string()) {
                                eprintln!("[lantai-watch] emit graph-updated failed: {e}");
                            }
                            // message 到达意味着一段长任务（分析/增量）已落定
                            analyze_started = None;
                        }
                        _ => {}
                    }
                }
            }
        });

        self.watcher_thread = Some(handle);
    }
}


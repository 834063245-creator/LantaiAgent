// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 外部服务 — MCP Server、沙箱状态。

use std::sync::{Arc, Mutex};
use crate::mcp_manager::McpManager;

pub(crate) static MCP_MANAGER: std::sync::LazyLock<Arc<Mutex<McpManager>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(McpManager::new())));

/// memory-bundle.exe 的保留 Child 句柄 — 在关闭时由 ResourceLedger 终止。
pub(crate) static MEMORY_BUNDLE_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

#[tauri::command]
pub(crate) async fn start_mcp_server(project_root: String) -> Result<String, String> {
    let engine = crate::utils::engine_binary();
    // P1-19：长等待（read_ready 最长 600s）既不持 MCP_MANAGER 锁、也不占
    // tokio worker——旧实现两者皆占，期间 stop_mcp 的 try_lock 静默跳过
    // → 旧 serve 进程残留 + 新 start 卡死（"切换项目卡死"）。
    tokio::task::spawn_blocking(move || {
        let (epoch, mut child) = {
            let mut mgr = crate::utils::lock_or_recover(&MCP_MANAGER);
            mgr.begin_start(&project_root, &engine)?
        };
        let mut request_id = 0u64;
        let result = McpManager::wait_ready(&mut child)
            .and_then(|_| McpManager::request_on(&mut child, &mut request_id, "tools/list", "{}"));
        match result {
            Ok(tools) => {
                let mut mgr = crate::utils::lock_or_recover(&MCP_MANAGER);
                mgr.finish_start(epoch, child, tools)
            }
            Err(e) => {
                // 清理未安装的子进程（原 start 的 kill_inner 职责）
                let _ = child.kill();
                let _ = child.wait();
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("MCP 启动任务异常: {e}"))?
}

#[tauri::command]
pub(crate) async fn stop_mcp_server() -> Result<String, String> {
    let mut mgr = crate::utils::lock_or_recover(&MCP_MANAGER);
    mgr.stop();
    Ok("MCP Server 已停止".into())
}

/// 停掉 MCP 引擎子进程（workspace 切换时调用）。
/// P1-19：start 的长等待已不再持锁，锁持有时间为微秒级——
/// 可以安全地阻塞取锁，不再用 try_lock 静默跳过（旧注释的死锁理由已消除）。
pub(crate) fn stop_mcp() {
    let mut mgr = crate::utils::lock_or_recover(&MCP_MANAGER);
    mgr.stop();
}

#[tauri::command]
pub(crate) fn sandbox_status() -> Result<String, String> {
    let s = crate::os_sandbox::status();
    let (available, degraded, reason) = match s {
        crate::os_sandbox::SandboxStatus::Available => (true, false, String::new()),
        crate::os_sandbox::SandboxStatus::Unavailable => (false, true, "OS sandbox 不可用 — 仅权限引擎生效".into()),
    };
    Ok(serde_json::json!({
        "available": available,
        "degraded": degraded,
        "reason": reason,
    }).to_string())
}
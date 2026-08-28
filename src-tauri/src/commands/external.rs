// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 外部服务 — 沙箱状态、memory-bundle 句柄。
// （MCP Server 生命周期面已随 legacy McpManager 退役——引擎子进程统一走
//  engine_transport::McpRemoteTransport，每工作区一个，随上下文关停。）

use std::sync::Mutex;

/// memory-bundle.exe 的保留 Child 句柄 — 在关闭时由 ResourceLedger 终止。
pub(crate) static MEMORY_BUNDLE_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

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
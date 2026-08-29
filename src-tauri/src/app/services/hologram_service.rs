// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Hologram 查询业务（L3 自 commands/hologram.rs 迁入）。
//! Phase 3（engine-plugin-extraction 摘依赖）：简报编排真源在引擎
//! `run_check` 壳方法（契约 v3）；时间线记录走 `timeline_record` 壳方法。
//! 引擎经 AppContexts 决议（显式 path → 活动工作区单槽）——无工作区
//! 显式报错（壳内已无全局引擎，回落臂随内嵌形态退役）。

use std::sync::Arc;

use crate::app::AppContexts;
use crate::app::services::graph_service;

/// hologram_run_check 业务体（changed_files 快取由壳层完成传入）。
/// 编排真源 = 引擎 `run_check`（基线 load/diff/save + 时间线记录）。
pub(crate) async fn run_check(
    path: Option<String>,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
    changed_files: Vec<String>,
) -> Result<String, String> {
    // 默认 target = 当前工作区根（而非应用安装目录 project_root()）。
    let (transport, _target) = graph_service::resolve_transport(&app_ctx, &state, path.as_deref())?;
    tokio::task::spawn_blocking(move || {
        transport.call(
            "run_check",
            &serde_json::json!({ "changed_files": changed_files }),
        )
    })
    .await
    .map_err(|e| format!("简报任务失败: {e}"))?
}

/// hologram_record_event 业务体：时间线事件落引擎进程的 hologram.db。
pub(crate) async fn record_event(
    event_type: String,
    file: Option<String>,
    summary: String,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<(), String> {
    let (transport, _root) = graph_service::resolve_transport(&app_ctx, &state, None)?;
    tokio::task::spawn_blocking(move || {
        transport.call(
            "timeline_record",
            &serde_json::json!({
                "event": event_type,
                // 引擎 record_timeline 的第二参为 node_id 语义（文件路径
                // 即旧壳侧的传法）；detail 缺省时用事件名，这里始终带 summary。
                "node_id": file.unwrap_or_default(),
                "detail": summary,
            }),
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| format!("时间轴写入失败: {e}"))?
}

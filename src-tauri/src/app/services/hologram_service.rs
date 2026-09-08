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

// （record_event 已退役 2026-09-08：RPC 死链——前端零调用；时间线记录的
//  活路径是 utils::record_timeline_transport_detached（Rust 侧直达 transport）。）

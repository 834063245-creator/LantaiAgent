// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! Hologram 查询业务（L3 自 commands/hologram.rs 迁入，零语义改写）。
//! 引擎经 AppContexts 决议（显式 path → 会话 → 焦点 → 单槽），
//! 时间线/简报落点跟随会话绑定的引擎实例。

use std::sync::Arc;

use hologram_engine::engine::Engine;
use hologram_engine::routing::preflight::{check_timeline_props, load_baseline, save_baseline};

use crate::app::AppContexts;
use crate::app::services::graph_service;

/// get_full_graph 业务体。
pub(crate) async fn get_full_graph(
    session_id: Option<u64>,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<String, String> {
    let (engine, root) = graph_service::resolve(&app_ctx, &state, None, session_id)?;
    let serialized = tokio::task::spawn_blocking(move || crate::utils::serialize_cached_graph(&engine, &root))
        .await.map_err(|e| format!("任务失败: {e}"))??;
    crate::utils::guard_ipc_size(serialized, "序列化图")
}

/// hologram_run_check 业务体（changed_files 快取由壳层完成传入）。
pub(crate) async fn run_check(
    path: Option<String>,
    session_id: Option<u64>,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
    changed_files: Vec<String>,
) -> Result<String, String> {
    // 默认 target = 当前工作区根（而非应用安装目录 project_root()）。
    // L1：显式 path → 会话/焦点/单槽决议；引擎实例与根天然绑定。
    let (engine, target) = graph_service::resolve(&app_ctx, &state, path.as_deref(), session_id)?;
    tokio::task::spawn_blocking(move || {
        use hologram_engine::routing::preflight::run_full_check;
        let root = std::path::PathBuf::from(&target);
        let before = load_baseline(&root);
        // 优先使用内存/SQLite 缓存；仅在真正为空时才运行完整分析。
        let after = engine.read(hologram_engine::engine::graph_from_index).ok();
        let after = match after {
            Some(g) if g.node_count() > 0 || g.edge_count() > 0 => g,
            _ => {
                crate::utils::direct_analyze(&engine, &target, true)?;
                engine
                    .read(hologram_engine::engine::graph_from_index)
                    .map_err(|e| format!("分析后无图谱: {}", e))?
            }
        };
        let result = run_full_check(&before, &after, &changed_files, &target);

        // 始终推进基线 — 下次检查将与此快照进行差异比较。
        save_baseline(&root, &after);

        // 将有意义的检查记录到时间轴（跳过静默的项目打开轮询）。
        let quiet = result.get("quiet").and_then(|v| v.as_bool()).unwrap_or(false);
        let baseline_seed = result.get("baseline_seed").and_then(|v| v.as_bool()).unwrap_or(false);
        if !quiet || baseline_seed {
            let passed = result["passed"].as_bool().unwrap_or(true);
            let violation_count = result["violation_count"].as_u64().unwrap_or(0);
            let event_type = if passed { "commit_clean" } else { "commit_violation" };
            let summary = if baseline_seed {
                "基线已建立".to_string()
            } else if passed {
                format!("简报通过（{} 违规）", violation_count)
            } else {
                format!("简报未通过：{} 条违规", violation_count)
            };
            let props = check_timeline_props(&result);
            let _ = engine.record_timeline_with_props(event_type, None::<&str>, &summary, &props);
        }

        Ok(serde_json::to_string(&result).unwrap_or_default())
    }).await.map_err(|e| format!("简报任务失败: {e}"))?
}

/// record_event 的决议（无显式根；会话/焦点优先，全局兜底）。
fn resolve_engine_or_global(
    app_ctx: &Arc<AppContexts>,
    state: &crate::WorkspaceState,
    session_id: Option<u64>,
) -> Option<Arc<Engine>> {
    let fallback = crate::utils::workspace_path(state).ok();
    app_ctx.resolve_engine(None, session_id, fallback.as_deref())
}

/// hologram_record_event 业务体。
pub(crate) async fn record_event(
    event_type: String,
    file: Option<String>,
    summary: String,
    session_id: Option<u64>,
    state: crate::WorkspaceState,
    app_ctx: Arc<AppContexts>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        match resolve_engine_or_global(&app_ctx, &state, session_id) {
            Some(engine) => engine
                .record_timeline(&event_type, file.as_deref(), &summary)
                .map_err(|e| format!("时间轴写入失败: {}", e)),
            None => hologram_engine::engine::engine_record_timeline(
                &event_type,
                file.as_deref(),
                &summary,
            )
            .map_err(|e| format!("时间轴写入失败: {}", e)),
        }
    }).await.map_err(|e| format!("时间轴写入失败: {e}"))?
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 引擎工具分发薄壳（L3）：validate_project 的 changed_files 注入（单槽横切）
// + 调应用层服务（app/services/dispatch_service）。

use serde_json;

#[tauri::command]
pub(crate) async fn hologram_call(
    tool: String,
    mut args: serde_json::Value,
    session_id: Option<u64>,
    workspace: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<String, String> {
    if tool == "validate_project" {
        let changed_files: Vec<String> = crate::utils::lock_or_recover(&state).as_ref()
            .and_then(|h| {
                let mut files = h.changed_files.lock().ok()?;
                let snapshot = files.clone();
                files.clear();
                Some(snapshot)
            })
            .unwrap_or_default();
        if let serde_json::Value::Object(ref mut map) = args {
            map.insert("changed_files".to_string(), serde_json::json!(changed_files));
        }
    }
    let app_ctx = app_ctx.inner().clone();
    let ws_state: crate::WorkspaceState = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        crate::app::services::dispatch_service::call_dispatched(
            &app_ctx,
            &ws_state,
            tool,
            args,
            session_id,
            workspace,
        )
    })
    .await
    .map_err(|e| format!("引擎调用任务失败: {e}"))?
}

#[tauri::command]
pub(crate) fn hologram_tools_list() -> Result<String, String> {
    crate::app::services::dispatch_service::tools_list()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hologram_tools_list_returns_tools() {
        let raw = hologram_tools_list().expect("hologram_tools_list should succeed");
        let tools: Vec<serde_json::Value> = serde_json::from_str(&raw).expect("should parse");
        assert!(!tools.is_empty(), "must return at least one hologram tool");
        for tool in &tools {
            let name = tool["name"].as_str().expect("every tool must have a name");
            assert!(!name.is_empty(), "every tool must have a non-empty name");
            assert!(
                tool["inputSchema"].is_object(),
                "tool '{name}' must have an inputSchema"
            );
        }
    }

    #[test]
    fn hologram_call_dispatches_all_tools_no_not_found() {
        let raw = hologram_tools_list().expect("hologram_tools_list should succeed");
        let tools: Vec<serde_json::Value> = serde_json::from_str(&raw).expect("should parse");
        let dummy_id = serde_json::json!(null);
        for tool in &tools {
            let name = tool["name"].as_str().unwrap();
            let result = hologram_engine::tools::ToolRegistry::dispatch(name, &serde_json::json!({}), &dummy_id);
            // 未知工具返回 Degraded（带 _isDegraded 的成功响应）
            if let Some(err) = result.get("error").and_then(|e| e.as_str()) {
                if err.starts_with("Tool not found") {
                    panic!(
                        "Tool '{name}' not found in ToolRegistry::dispatch — did you add it to the match block?"
                    );
                }
            }
        }
    }

    /// 回归：引擎 dispatch 必须在 spawn_blocking 中运行（宪法·异步纪律）。
    /// 大图上单次 dispatch 秒级，内联在 async worker 上会饿死全部并发 IPC
    /// （含权限弹窗）——2026-08 雷区地图 P0-1。
    #[test]
    fn dispatch_engine_in_spawn_blocking_does_not_starve_runtime() {
        let raw = hologram_tools_list().expect("hologram_tools_list should succeed");
        let tools: Vec<serde_json::Value> = serde_json::from_str(&raw).expect("should parse");
        let any_tool = tools[0]["name"].as_str().unwrap().to_string();

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let heavy = tokio::task::spawn_blocking(move || {
                // Ok/Err 都是合法完成（空 args 对多数工具是参数错误）；
                // JoinError（panic）才是致命。
                crate::app::services::dispatch_service::dispatch_engine(&any_tool, &serde_json::json!({}))
            });
            let light = tokio::spawn(async { 42 });
            let (heavy, light) = tokio::join!(heavy, light);
            assert_eq!(light.unwrap(), 42, "轻量任务必须不被引擎 dispatch 饿死");
            let _ = heavy.unwrap();
        });
    }
}

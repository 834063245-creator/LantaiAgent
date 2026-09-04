// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// fs 能力口（R3-a，kernel-capability-c3-design.md）——内核能力层的 fs 族
// （v3 §4：fs = 字节/搜索能力族；search_cap 是 fs 族变体先例）。
//
// 能力口语义：被 TS 工具经 RPC 直呼（不经 tool_call 信封 / PluginRegistry /
// PluginToolAdapter）。单方法 + action 分派（read/list/glob/write/delete/rename/
// create_dir/append）——能力口数量 = 能力族数，与工具名无关（v3 §4）。
// 口内入口即裁决：每个 action 走 confined_fs 的 *_cap 变体（resolve_*_dispatch
// = Agent 过闸 + Ask / UI 只解析），字节执行 + guards 一体。
//
// 参数语言：顶层 snake_case（bridge.rpc() 顶层转换幂等——search_cap R2-a 键位
// 断层教训）；is_agent/agent_id 显式传（resolve_*_dispatch 需要 agent_id 做
// worktree 前向映射）。返回 Value（rpc.rs ok_json 序列化；read 的 content 是
// JSON 字符串值——出口 parse 无损）。

use serde_json::{json, Value};
use tauri::State;

/// fs_cap 能力口分派。action ∈ {read, list, glob, write, delete, rename,
/// create_dir, append}——纯能力面（编排/输出格式归 TS，R3-b 迁）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn fs_cap(
    action: String,
    path: Option<String>,
    from: Option<String>,
    to: Option<String>,
    file_path: Option<String>,
    pattern: Option<String>,
    dir: Option<String>,
    content: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    line_numbers: Option<bool>,
    filter_ignored: Option<bool>,
    is_agent: bool,
    agent_id: Option<String>,
    workspace_root: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<Value, String> {
    match action.as_str() {
        "read" => {
            let fp = file_path.or(path).ok_or_else(|| "fs_cap read: missing 'file_path'".to_string())?;
            let ln = line_numbers.unwrap_or(false);
            let (real, text) = crate::confined_fs::read_text_cap(
                &fp,
                is_agent,
                agent_id.as_deref(),
                state,
                app,
                ln,
                offset,
                limit,
            )
            .await?;
            Ok(json!({
                "path": real.to_string_lossy(),
                "content": text,
            }))
        }
        "list" => {
            let p = path.ok_or_else(|| "fs_cap list: missing 'path'".to_string())?;
            let filter = filter_ignored.unwrap_or(true);
            let entries = crate::confined_fs::list_tree_cap(&p, is_agent, agent_id.as_deref(), state, app, filter).await?;
            Ok(json!({ "entries": entries }))
        }
        "glob" => {
            let pat = pattern.ok_or_else(|| "fs_cap glob: missing 'pattern'".to_string())?;
            let results = crate::confined_fs::glob_cap(
                &pat,
                dir.as_deref(),
                workspace_root.as_deref(),
                is_agent,
                agent_id.as_deref(),
                state,
                app,
            )
            .await?;
            Ok(json!({
                "pattern": pat,
                "count": results.len(),
                "truncated": results.len() >= 200,
                "results": results,
            }))
        }
        "write" => {
            let fp = file_path.or(path).ok_or_else(|| "fs_cap write: missing 'file_path'".to_string())?;
            let c = content.ok_or_else(|| "fs_cap write: missing 'content'".to_string())?;
            let real = crate::confined_fs::write_text_cap(&fp, &c, is_agent, agent_id.as_deref(), state, app).await?;
            Ok(json!({ "path": real.to_string_lossy() }))
        }
        "delete" => {
            let p = path.ok_or_else(|| "fs_cap delete: missing 'path'".to_string())?;
            let real = crate::confined_fs::delete_cap(&p, is_agent, agent_id.as_deref(), state, app).await?;
            Ok(json!({ "path": real.to_string_lossy() }))
        }
        "rename" => {
            let f = from.or(file_path).ok_or_else(|| "fs_cap rename: missing 'from'".to_string())?;
            let t = to.ok_or_else(|| "fs_cap rename: missing 'to'".to_string())?;
            let (_, real_to) = crate::confined_fs::rename_cap(&f, &t, is_agent, agent_id.as_deref(), state, app).await?;
            Ok(json!({ "path": real_to.to_string_lossy() }))
        }
        "create_dir" => {
            let p = path.ok_or_else(|| "fs_cap create_dir: missing 'path'".to_string())?;
            let real = crate::utils::resolve_write_dispatch(&p, is_agent, agent_id.as_deref(), state, app).await?;
            tokio::task::spawn_blocking({
                let rp = real.clone();
                move || std::fs::create_dir_all(&rp)
            })
            .await
            .map_err(|e| format!("创建目录任务失败: {}", e))?
            .map_err(|e| format!("无法创建目录 {}: {}", p, e))?;
            Ok(json!({ "path": real.to_string_lossy() }))
        }
        "append" => {
            let p = path.ok_or_else(|| "fs_cap append: missing 'path'".to_string())?;
            let c = content.ok_or_else(|| "fs_cap append: missing 'content'".to_string())?;
            let real = crate::utils::resolve_write_dispatch(&p, is_agent, agent_id.as_deref(), state, app).await?;
            crate::confined_fs::append_text_unchecked(&real.to_string_lossy(), &c)?;
            Ok(json!({ "path": real.to_string_lossy() }))
        }
        other => Err(format!("fs_cap: 未知 action '{other}'")),
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// fs 能力口（R3-a，kernel-capability-c3-design.md）——内核能力层的 fs 族
// （v3 §4：fs = 字节/搜索能力族；search_cap 是 fs 族变体先例）。
//
// 能力口语义：被 TS 工具经 RPC 直呼（不经 tool_call 信封 / PluginRegistry /
// PluginToolAdapter）。单方法 + action 分派（read/list/glob/write/delete/rename/
// create_dir/append/read_base64/write_base64——能力口数量 = 能力族数，v3 §4）。
// write_base64（multimodal-image-plan D-13）：附图字节写，只开用户通道（agent
// 工具面不注册）；口内入口即裁决：每个 action 走 confined_fs 的 *_cap 变体
// （resolve_*_dispatch = Agent 过闸 + Ask / UI 只解析），字节执行 + guards 一体。
//
// 副作用（R3-b → 图谱退役收口，2026-09-09）：write/delete/rename 原随
// fs_cap 承接 builtin.fs 插件的 timeline / changed_files 记录——两者均属
// 引擎图数据面（timeline_record 直达引擎进程；changed_files 唯一消费方
// run_check 已退役），随图谱全量退役删除。
//
// 参数语言：顶层 snake_case（bridge.rpc() 顶层转换幂等——search_cap R2-a 键位
// 断层教训）；is_agent/agent_id 显式传（resolve_*_dispatch 需要 agent_id 做
// worktree 前向映射）。返回 Value（rpc.rs ok_json 序列化；read 的 content 是
// JSON 字符串值——出口 parse 无损）。

use serde_json::{json, Value};
use tauri::State;

/// fs_cap 能力口分派。action ∈ {read, list, list_flat, glob, write, delete,
/// rename, create_dir, append, truncate, read_base64, write_base64, memory_batch,
/// global_memory_dir}。
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
    paths: Option<Vec<String>>,
    is_agent: bool,
    agent_id: Option<String>,
    workspace_root: Option<String>,
    durable: Option<bool>,
    truncate_to: Option<u64>,
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
        "read_base64" => {
            let fp = file_path.or(path).ok_or_else(|| "fs_cap read_base64: missing 'file_path'".to_string())?;
            let b64 = crate::confined_fs::read_base64_cap(&fp, is_agent, agent_id.as_deref(), state, app).await?;
            Ok(json!({ "path": fp, "base64": b64 }))
        }
        "list" => {
            let p = path.ok_or_else(|| "fs_cap list: missing 'path'".to_string())?;
            let filter = filter_ignored.unwrap_or(true);
            let entries = crate::confined_fs::list_tree_cap(&p, is_agent, agent_id.as_deref(), state, app, filter).await?;
            Ok(json!({ "entries": entries }))
        }
        "list_flat" => {
            let p = path.ok_or_else(|| "fs_cap list_flat: missing 'path'".to_string())?;
            let entries = crate::confined_fs::list_flat_cap(&p, is_agent, agent_id.as_deref(), state, app).await?;
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
        "global_memory_dir" => {
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".to_string());
            Ok(json!({ "path": format!("{}/.lantai/global_memory", home.replace('\\', "/")) }))
        }
        "memory_batch" => {
            // 自 builtin.fs read_memory_batch 迁入（内部消费：memory/会话读 .lantai
            // 内存文件）。安全语义保留：validate_hologram_path（拒绝 .. 穿越与非
            // .lantai 路径）+ std::fs 批量读——读失败路径记 null（原实现）。
            let paths = paths.ok_or_else(|| "fs_cap memory_batch: missing 'paths'".to_string())?;
            let mut map = serde_json::Map::new();
            for p in &paths {
                crate::utils::validate_hologram_path(p)
                    .map_err(|e| format!("fs_cap memory_batch: {e}"))?;
                match tokio::task::spawn_blocking({
                    let p = p.clone();
                    move || std::fs::read_to_string(&p)
                })
                .await
                .map_err(|e| format!("fs_cap memory_batch 任务失败: {e}"))?
                {
                    Ok(content) => {
                        map.insert(p.clone(), Value::String(content));
                    }
                    Err(_) => {
                        map.insert(p.clone(), Value::Null);
                    }
                }
            }
            Ok(Value::Object(map))
        }
        "write" => {
            let fp = file_path.or(path).ok_or_else(|| "fs_cap write: missing 'file_path'".to_string())?;
            let c = content.ok_or_else(|| "fs_cap write: missing 'content'".to_string())?;
            let real = crate::confined_fs::write_text_cap(&fp, &c, is_agent, agent_id.as_deref(), state, app).await?;
            let rp = real.to_string_lossy().to_string();
            Ok(json!({ "path": rp }))
        }
        "write_base64" => {
            // 附图字节写（multimodal-image-plan D-13）：content 键承载 base64
            // （action-scoped 语义——与 write 的文本 content 同键不同义）。
            let fp = file_path.or(path).ok_or_else(|| "fs_cap write_base64: missing 'file_path'".to_string())?;
            let c = content.ok_or_else(|| "fs_cap write_base64: missing 'content' (base64)".to_string())?;
            let real = crate::confined_fs::write_base64_cap(&fp, &c, is_agent, agent_id.as_deref(), state, app).await?;
            let rp = real.to_string_lossy().to_string();
            Ok(json!({ "path": rp }))
        }
        "delete" => {
            let p = path.ok_or_else(|| "fs_cap delete: missing 'path'".to_string())?;
            let real = crate::confined_fs::delete_cap(&p, is_agent, agent_id.as_deref(), state, app).await?;
            let rp = real.to_string_lossy().to_string();
            Ok(json!({ "path": rp }))
        }
        "rename" => {
            let f = from.or(file_path).ok_or_else(|| "fs_cap rename: missing 'from'".to_string())?;
            let t = to.ok_or_else(|| "fs_cap rename: missing 'to'".to_string())?;
            let (_, real_to) = crate::confined_fs::rename_cap(&f, &t, is_agent, agent_id.as_deref(), state, app).await?;
            let rp = real_to.to_string_lossy().to_string();
            Ok(json!({ "path": rp }))
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
            let rp = real.to_string_lossy().to_string();
            // 会话事件日志换轨（2026-09-15 DSH 参照）：durable=true 走 fsync 变体
            // （append 返回即已落盘——检查点的天花板语义）；缺省仍是旧 log_append
            // 语义（无 fsync，应用日志用）。
            if let Some(parent) = real.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {}", e))?;
            }
            if durable.unwrap_or(false) {
                crate::confined_fs::append_text_durable(&rp, &c)?;
            } else {
                crate::confined_fs::append_text_unchecked(&rp, &c)?;
            }
            Ok(json!({ "path": rp }))
        }
        "truncate" => {
            // 断尾修复原语（Phase 2）：把日志截到扫描器给的 committedBytes。
            let p = path.ok_or_else(|| "fs_cap truncate: missing 'path'".to_string())?;
            let off = truncate_to.ok_or_else(|| "fs_cap truncate: missing 'truncate_to'".to_string())?;
            let real = crate::utils::resolve_write_dispatch(&p, is_agent, agent_id.as_deref(), state, app).await?;
            let rp = real.to_string_lossy().to_string();
            crate::confined_fs::truncate_file(&rp, off)?;
            Ok(json!({ "path": rp, "truncate_to": off }))
        }
        other => Err(format!("fs_cap: 未知 action '{other}'")),
    }
}

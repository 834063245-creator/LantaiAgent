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
/// global_memory_dir, stat, open_with_system}。
///
/// stat（P2 2026-09-23）：**尺寸预检**——查看器面在此之前只能「整份读回来再判超限」，
/// 大文件会把 payload 推进 IPC（白屏先例 INVARIANTS #11 那类形态）。本动作先只给
/// {size, is_dir}，宿主据此在读取前拦下超限档。
/// open_with_system（P2 · B5）：把文件交给系统默认程序（ShellExecuteW）——应用内
/// 没有这条出口（desktop 域是 UIA 控件面、shell/process 口没有 start），旧 Office
/// 与「想用 Excel 打开 csv」这类偏好都走它。**只开用户通道**（is_agent=true 直接拒：
/// agent 侧要开文件走 fs/office 域工具，不给它一条拉起任意程序的口子）。
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
            let out = crate::confined_fs::read_cap(
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
            // 附图结局（2026-09-18 按路径读图）：输出 JSON 带 image 引用（形状与
            // browser 截图口一致）——模型侧 executor 经 parseToolImageOutput 把它
            // 挂进上下文；`content` 键缺席是两形态的判据（fs-builtin 读分支透传）。
            Ok(match out {
                crate::confined_fs::ReadCapOutcome::Text { real, content } => json!({
                    "path": real.to_string_lossy(),
                    "content": content,
                }),
                crate::confined_fs::ReadCapOutcome::Image { real, image } => json!({
                    "path": real.to_string_lossy(),
                    "image": {
                        "id": image.id,
                        "mediaType": image.media_type,
                        "bytes": image.bytes,
                        "width": image.width,
                        "height": image.height,
                        "name": image.name,
                    },
                    "attachment": image.attachment.to_string_lossy(),
                    "imageNote": "本图已作为附图进入上下文：视觉模型可直接观察（纯文本模型只看到本占位说明）。",
                }),
            })
        }
        "read_base64" => {
            let fp = file_path.or(path).ok_or_else(|| "fs_cap read_base64: missing 'file_path'".to_string())?;
            let b64 = crate::confined_fs::read_base64_cap(&fp, is_agent, agent_id.as_deref(), state, app).await?;
            Ok(json!({ "path": fp, "base64": b64 }))
        }
        // 尺寸预检（P2）：只 stat，不读字节——宿主据此在读取前拦超限档
        "stat" => {
            let fp = file_path.or(path).ok_or_else(|| "fs_cap stat: missing 'file_path'".to_string())?;
            let real = crate::utils::resolve_read_dispatch(&fp, is_agent, agent_id.as_deref(), state, app).await?;
            let meta = std::fs::metadata(&real).map_err(|e| format!("stat 失败 {}: {}", fp, e))?;
            Ok(json!({
                "path": real.to_string_lossy(),
                "size": meta.len(),
                "is_dir": meta.is_dir(),
            }))
        }
        // 用系统默认程序打开（P2 · B5）：用户通道专用（agent 侧走 fs/office 域工具）
        "open_with_system" => {
            if is_agent {
                return Err("fs_cap open_with_system: 仅用户通道（agent 侧请用 fs/office 域工具）".to_string());
            }
            let fp = file_path.or(path).ok_or_else(|| "fs_cap open_with_system: missing 'file_path'".to_string())?;
            let real = crate::utils::resolve_read_dispatch(&fp, is_agent, agent_id.as_deref(), state, app).await?;
            if !real.exists() {
                return Err(format!("用系统程序打开失败：文件不存在 {}", real.to_string_lossy()));
            }
            shell_open_with_default(&real)?;
            Ok(json!({ "path": real.to_string_lossy() }))
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

/// 把文件交给系统默认程序（P2 · B5）。
///
/// Windows：`ShellExecuteW(…, "open", path, …)`——shell 关联的唯一正确入口，不经
/// `cmd /c start`（少一层 shell 解析面；与 `commands/composition.rs` 的 explorer
/// 先例同一纪律）。非 Windows：`open` / `xdg-open` 兜底。
///
/// 调用后不等待进程（用户程序自己活），故不持锁、不阻塞 tokio 线程。
fn shell_open_with_default(real: &std::path::Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let wide = |s: &std::ffi::OsStr| -> Vec<u16> { s.encode_wide().chain(std::iter::once(0)).collect() };
        let verb = wide(std::ffi::OsStr::new("open"));
        let file = wide(real.as_os_str());
        // SAFETY: 三个指针都指向本函数栈上、以 NUL 结尾的 UTF-16 缓冲，调用期间存活；
        // ShellExecuteW 只读它们。返回值 ≤32 表示失败（不是句柄）。
        let rc = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(verb.as_ptr()),
                PCWSTR(file.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        let code = rc.0 as isize;
        if code <= 32 {
            return Err(format!(
                "用系统程序打开失败（ShellExecuteW 返回 {code}）：{}",
                real.to_string_lossy()
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(opener)
            .arg(real)
            .spawn()
            .map_err(|e| format!("用系统程序打开失败 {}: {}", real.to_string_lossy(), e))?;
        Ok(())
    }
}

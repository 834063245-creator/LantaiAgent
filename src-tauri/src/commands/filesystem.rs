// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 文件系统操作 — 列表、读取、写入、删除、重命名、移动。

use std::io::Write;
use base64::Engine;
use hologram_graph::is_ignored_path;

#[tauri::command]
pub(crate) async fn list_directory(
    path: String,
    is_agent: Option<bool>,
    filter_ignored: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<Vec<crate::utils::DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let filter = filter_ignored.unwrap_or(true);
    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", path));
        }
        Ok(crate::utils::list_dir_recursive(&root, filter))
    })
    .await
    .map_err(|e| format!("目录列表任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn list_directory_flat(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<Vec<crate::utils::DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", path));
        }
        Ok(crate::utils::list_dir_flat(&root))
    })
    .await
    .map_err(|e| format!("目录列表任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn read_file_content(
    file_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let (_, content) = crate::confined_fs::read_text(&file_path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    Ok(crate::confined_fs::format_lines(&content, offset, limit))
}

#[tauri::command]
pub(crate) fn read_memory_batch(
    paths: Vec<String>,
) -> Result<String, String> {
    let mut map = serde_json::Map::new();
    for path in &paths {
        crate::utils::validate_hologram_path(path)?;
        match std::fs::read_to_string(path) {
            Ok(content) => { map.insert(path.clone(), serde_json::Value::String(content)); }
            Err(_) => { map.insert(path.clone(), serde_json::Value::Null); }
        }
    }
    serde_json::to_string(&map).map_err(|e| format!("序列化失败: {}", e))
}

#[tauri::command]
pub(crate) async fn read_file_base64(
    file_path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let (_, bytes) = crate::confined_fs::read_bytes(&file_path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    // base64 体积膨胀 4/3：8MiB 源文件 → ~11MB IPC 响应，再大就有击毁 WebView2 的风险
    const MAX_BASE64_SOURCE_BYTES: usize = 8 * 1024 * 1024;
    if bytes.len() > MAX_BASE64_SOURCE_BYTES {
        return Err(format!(
            "文件 {}MiB 超过预览上限 {}MiB——base64 编码后 IPC 传不动",
            bytes.len() / (1024 * 1024),
            MAX_BASE64_SOURCE_BYTES / (1024 * 1024),
        ));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// fs 命令的 timeline 记录（Phase 3 transport 形态）：落工作区引擎进程的
/// hologram.db（占位工作区无传输，不记录）。
/// (event, 路径, 短名) → 事件文案约定与既有完全一致。
fn record_fs_timeline(state: &crate::WorkspaceState, event: &str, path: &str, short: &str) {
    let verb = match event {
        "agent_write" => "写入",
        "agent_delete" => "删除",
        "agent_rename" => "重命名",
        "agent_move" => "移动",
        _ => "操作",
    };
    let summary = format!("Agent {}: {}", verb, short);
    let transport = {
        let handle = crate::utils::lock_or_recover(state);
        handle.as_ref().and_then(|h| h.transport.clone())
    };
    crate::utils::record_timeline_transport(transport.as_ref(), event, Some(path), &summary);
}

#[tauri::command]
pub(crate) async fn write_file_content(
    file_path: String,
    content: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let real_path = crate::confined_fs::write_text(&file_path, &content, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let rp = real_path.to_string_lossy().to_string();

    if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit(['/', '\\']).next().unwrap_or(&rp);
            record_fs_timeline(&state, "agent_write", &rp, &short);
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) { changed.push(rp.clone()); }
            }
        }
    }

    let size = content.len();
    let preview = crate::confined_fs::preview(&content, 80, 20);
    Ok(format!(
        "已写入 {} ({})\n```\n{}\n```",
        rp,
        if size < 1024 { format!("{} B", size) } else { format!("{:.1} KB", size as f64 / 1024.0) },
        preview
    ))
}

#[tauri::command]
pub(crate) fn log_append(
    path: String,
    content: String,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    let ctx = crate::utils::get_ctx(&state)?;
    let physical = ctx.forward_map_path(std::path::Path::new(&path), _agent_id.as_deref());
    let physical_str = physical.to_string_lossy().to_string();
    let tool = crate::tools::EditTool { path: physical_str.clone(), agent_id: _agent_id.clone() };
    crate::utils::check_permission_sync(&tool, &ctx)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&physical)
        .map_err(|e| format!("log_append: cannot open {}: {}", path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("log_append: write failed: {}", e))
}

#[tauri::command]
pub(crate) async fn create_directory(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    crate::confined_fs::create_dir(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    Ok(())
}

#[tauri::command]
pub(crate) fn get_global_memory_dir() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    format!("{}/.lantai/global_memory", home.replace("\\", "/"))
}

/// 用户级数据根：~/.lantai（会话/工作区注册表等用户数据的共同家目录）。
/// 独立于 workspace 根——用户级数据不随项目走。
pub(crate) fn user_lantai_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".lantai")
}

/// 工作区会话根（workspace-session-ownership-rework 2026-08-27）：
/// 会话**物理归属工作区**——唯一存储位 = `{workspace}/.lantai/sessions/`。
/// 全局位 ~/.lantai/sessions 已归档，本函数是新模型的唯一存储路径真源。
pub(crate) fn workspace_sessions_root(ws: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(ws).join(".lantai").join("sessions")
}

/// 工作区会话摘要（workspace-session-ownership-rework 2026-08-27：内部计数用——
/// workspace 字段已不再写入卷文件；scan_sessions_dir 只被 workspace 注册表
/// 计数消费，`workspace` 字段保留为 None 兼容旧返回形状，无前端序列化面）。
#[derive(serde::Serialize, Clone)]
pub(crate) struct UserSessionEntry {
    pub id: u64,
    pub label: String,
    pub msg_count: usize,
    pub saved_at: String,
    pub workspace: Option<String>,
}

/// 扫描单个会话目录为摘要列表。读取容忍毒化（INVARIANTS #11.2）：坏 JSON /
/// 超大文件（>4MB）/ 非数字文件名 / 删除标记全跳过不炸列表；目录不存在 =
/// 空列表（首启常态）。归属只认卷内 workspace 字段（无字段 = 零目录卷）。
/// pub(crate)：工作区注册表（workspace_registry::list）复用做计数/最近合并。
pub(crate) fn scan_sessions_dir(dir: &std::path::Path) -> Vec<UserSessionEntry> {
    let entries = match std::fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return Vec::new(), // 目录不存在 = 空列表（非错误）
    };
    let mut out: Vec<UserSessionEntry> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name == "_active.json" || name == "_ledger.json" {
            continue;
        }
        let id: u64 = match name.trim_end_matches(".json").parse() {
            Ok(v) => v,
            Err(_) => continue, // 非数字文件名（毒化容忍）
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // 长度护栏：>4MB 的会话文件跳过（毒化数据不拖垮列表）
        if meta.len() > 4 * 1024 * 1024 {
            continue;
        }
        let content = match std::fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let parsed: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue, // 坏 JSON 跳过
        };
        if parsed.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue; // 删除标记（listSavedSessions 同语义）
        }
        let label = parsed
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(120)
            .collect::<String>(); // 标签长度护栏
        let msg_count = parsed
            .get("messages")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let saved_at = parsed
            .get("savedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let workspace = parsed
            .get("workspace")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.replace('\\', "/"));
        out.push(UserSessionEntry { id, label, msg_count, saved_at, workspace });
    }
    out
}

#[tauri::command]
pub(crate) async fn delete_file_or_dir(
    path: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let real = crate::confined_fs::delete(&path, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;
    let rp = real.to_string_lossy().replace('\\', "/");
    if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit('/').next().unwrap_or(&rp);
            record_fs_timeline(&state, "agent_delete", &rp, &short);
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) { changed.push(rp.clone()); }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn rename_file_or_dir(
    file_path: String,
    new_name: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let is_agent = is_agent.unwrap_or(false);
    let parent = std::path::Path::new(&file_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let to = if parent.is_empty() {
        new_name.clone()
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), new_name.trim_start_matches('/'))
    };
    let (_, resolved_to) = crate::confined_fs::rename(&file_path, &to, is_agent, _agent_id.as_deref(), &state, &app).await?;
    let rp = resolved_to.to_string_lossy().replace('\\', "/");
    if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit('/').next().unwrap_or(&rp);
            record_fs_timeline(&state, "agent_rename", &rp, &short);
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) { changed.push(rp.clone()); }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn move_file(
    from: String,
    to: String,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let is_agent = is_agent.unwrap_or(false);
    let (_, resolved_to) = crate::confined_fs::rename(&from, &to, is_agent, _agent_id.as_deref(), &state, &app).await?;
    let rp = resolved_to.to_string_lossy().replace('\\', "/");
    if let Some(ref handle) = *crate::utils::lock_or_recover(&state) {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit('/').next().unwrap_or(&rp);
            record_fs_timeline(&state, "agent_move", &rp, &short);
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) { changed.push(rp.clone()); }
            }
        }
    }
    Ok(())
}

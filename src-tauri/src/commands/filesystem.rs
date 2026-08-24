// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 文件系统操作 — 列表、读取、写入、删除、重命名、移动。

use std::io::Write;
use base64::Engine;
use hologram_engine::engine as engine_api;
use hologram_engine::pipeline::discovery::is_ignored_path;

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

/// fs 命令的 timeline 记录（L1）：优先落单槽工作区绑定的引擎实例
/// （workspace_activate 时确保的数据上下文），无实例回落全局。
/// (event, 路径, 短名) → 事件文案约定与既有完全一致。
fn record_fs_timeline(state: &crate::WorkspaceState, event: &str, path: &str, short: &str) -> Result<(), String> {
    let verb = match event {
        "agent_write" => "写入",
        "agent_delete" => "删除",
        "agent_rename" => "重命名",
        "agent_move" => "移动",
        _ => "操作",
    };
    let summary = format!("Agent {}: {}", verb, short);
    let handle = crate::utils::lock_or_recover(state);
    if let Some(ref h) = *handle {
        if let Some(ref engine) = h.engine {
            return engine.record_timeline(event, Some(path), &summary);
        }
    }
    drop(handle);
    engine_api::engine_record_timeline(event, Some(path), &summary)
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
            let _ = record_fs_timeline(&state, "agent_write", &rp, &short);
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

/// 用户级会话目录（workspace-flip 批 1）：~/.lantai/sessions/（零目录会话的落盘位）。
/// HOLOGRAM_SESSIONS_ROOT 环境变量可覆盖（测试隔离与目录重定位——plugins_root 同款惯例）。
pub(crate) fn user_sessions_root() -> std::path::PathBuf {
    if let Some(custom) = std::env::var_os("HOLOGRAM_SESSIONS_ROOT") {
        if !custom.is_empty() {
            return std::path::PathBuf::from(custom);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".lantai").join("sessions")
}

/// 会话摘要（全局会话列表行——TS UserSession 同形）。
/// workspace（会话统一 U2，2026-08-24）：卷归属工作区（正斜杠归一）；None = 零目录卷。
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
/// 空列表（首启常态）。default_workspace：条目无 workspace 字段时的归属推导
/// （旧目录卷按位置归属——卷躺在哪个工作区目录就归属谁）。
fn scan_sessions_dir(dir: &std::path::Path, default_workspace: Option<&str>) -> Vec<UserSessionEntry> {
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
            .map(|s| s.replace('\\', "/"))
            .or_else(|| default_workspace.map(|s| s.replace('\\', "/")));
        out.push(UserSessionEntry { id, label, msg_count, saved_at, workspace });
    }
    out
}

/// 全局会话列表（会话统一 U2）：全局位 ~/.lantai/sessions/ 恒扫；legacy_root
/// 提供时加扫项目内旧目录（U1 迁移期兼容源——未吸收旧卷一并可见，打开即吸收
/// 自然迁入全局位）。同卷（id + workspace 同键）去重保 savedAt 较新者（吸收后
/// 全局位与旧目录两份，全局位新）；同号异归属卷各自保留（workspace 消解，
/// 不重号）。savedAt 倒序 + 50 条上限（home 呈现预算，沿用既有护栏）。
#[tauri::command]
pub(crate) async fn user_sessions_list(
    legacy_root: Option<String>,
) -> Result<Vec<UserSessionEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let mut out = scan_sessions_dir(&user_sessions_root(), None);
        if let Some(root) = legacy_root.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if root.contains("..") || root.contains('\0') {
                return Err("user_sessions_list: legacy_root 路径包含非法字符".into());
            }
            let legacy_dir = std::path::PathBuf::from(root).join(".lantai").join("sessions");
            if legacy_dir != user_sessions_root() {
                out.extend(scan_sessions_dir(&legacy_dir, Some(root)));
            }
        }
        // 同键去重：保留 savedAt 较新者
        let mut by_key = std::collections::HashMap::<(u64, Option<String>), UserSessionEntry>::new();
        for e in out {
            let key = (e.id, e.workspace.clone());
            match by_key.get(&key) {
                Some(prev) if prev.saved_at >= e.saved_at => {}
                _ => {
                    by_key.insert(key, e);
                }
            }
        }
        let mut merged: Vec<UserSessionEntry> = by_key.into_values().collect();
        merged.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
        merged.truncate(50); // 列表上限 50（home 呈现预算）
        Ok(merged)
    })
    .await
    .map_err(|e| format!("user_sessions_list: task failed: {e}"))?
}

/// 用户级会话目录路径（workspace-flip 批 1：TS 侧 sessionsDir('') 路由的真源——
/// 与 user_sessions_root 同一解析，保持单一事实源）。
#[tauri::command]
pub(crate) fn get_user_sessions_dir() -> String {
    user_sessions_root().to_string_lossy().replace('\\', "/")
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
            let _ = record_fs_timeline(&state, "agent_delete", &rp, &short);
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
            let _ = record_fs_timeline(&state, "agent_rename", &rp, &short);
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
            let _ = record_fs_timeline(&state, "agent_move", &rp, &short);
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) { changed.push(rp.clone()); }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时会话目录 + 环境变量隔离（composition_watcher 测试同款惯例：
    /// std::env::temp_dir + 进程 id 命名，测试尾部自清）。
    /// 注意：env var 是进程全局——用互斥锁串行化（cargo test 默认多线程）。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn write_session(root: &std::path::Path, name: &str, body: &str) {
        std::fs::write(root.join(name), body).unwrap();
    }

    #[tokio::test]
    async fn user_sessions_list_empty_dir_is_empty_not_error() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("hologram_user_sessions_empty_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("HOLOGRAM_SESSIONS_ROOT", &tmp);
        let list = user_sessions_list(None).await.unwrap();
        assert!(list.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::remove_var("HOLOGRAM_SESSIONS_ROOT");
    }

    #[tokio::test]
    async fn user_sessions_list_missing_dir_is_empty_not_error() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 目录本身不存在（首启常态）——空列表，非错误
        let missing = std::env::temp_dir().join(format!("hologram_user_sessions_missing_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        std::env::set_var("HOLOGRAM_SESSIONS_ROOT", &missing);
        let list = user_sessions_list(None).await.unwrap();
        assert!(list.is_empty());
        std::env::remove_var("HOLOGRAM_SESSIONS_ROOT");
    }

    #[tokio::test]
    async fn user_sessions_list_parses_sorts_and_filters() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("hologram_user_sessions_full_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        write_session(&tmp, "1.json", r#"{"label":"旧","messages":[1,2],"savedAt":"2026-08-01","deleted":false}"#);
        write_session(&tmp, "2.json", r#"{"label":"新","messages":[1,2,3],"savedAt":"2026-08-22","deleted":false,"workspace":"D:/proj/x"}"#);
        // 删除标记过滤（listSavedSessions 同语义）
        write_session(&tmp, "3.json", r#"{"label":"已删","messages":[],"savedAt":"2026-08-23","deleted":true}"#);
        // 毒化容忍：坏 JSON / 非数字名 / _active.json / _ledger.json 全跳过
        write_session(&tmp, "4.json", "{not json");
        write_session(&tmp, "junk.json", "{}");
        write_session(&tmp, "_active.json", "{}");
        write_session(&tmp, "_ledger.json", "{}");

        std::env::set_var("HOLOGRAM_SESSIONS_ROOT", &tmp);
        let list = user_sessions_list(None).await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].label, "新"); // savedAt 倒序
        assert_eq!(list[0].msg_count, 3);
        assert_eq!(list[0].workspace.as_deref(), Some("D:/proj/x")); // workspace 字段透出
        assert_eq!(list[1].label, "旧");
        assert_eq!(list[1].workspace, None); // 无字段 = 零目录卷
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::remove_var("HOLOGRAM_SESSIONS_ROOT");
    }

    #[tokio::test]
    async fn user_sessions_list_poisoned_oversize_skipped() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("hologram_user_sessions_big_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // 超长文件跳过（>4MB 毒化护栏）
        let big = "x".repeat(5 * 1024 * 1024);
        write_session(&tmp, "9.json", &big);
        std::env::set_var("HOLOGRAM_SESSIONS_ROOT", &tmp);
        let list = user_sessions_list(None).await.unwrap();
        assert!(list.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::remove_var("HOLOGRAM_SESSIONS_ROOT");
    }

    /// 会话统一 U2：legacy_root 兼容源加扫 + 同键去重保新 + 同号异归属共存。
    #[tokio::test]
    async fn user_sessions_list_legacy_merge_and_dedup() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let global = std::env::temp_dir().join(format!("hologram_u2_global_{}", std::process::id()));
        let legacy = std::env::temp_dir().join(format!("hologram_u2_legacy_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&global);
        let _ = std::fs::remove_dir_all(&legacy);
        let legacy_sessions = legacy.join(".lantai").join("sessions");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::create_dir_all(&legacy_sessions).unwrap();

        // 全局位：已吸收卷 5（ws=legacy 真实路径，新）+ 零目录卷 1
        let ws_norm = legacy.to_string_lossy().replace('\\', "/");
        write_session(
            &global,
            "5.json",
            &format!(r#"{{"label":"吸收后的卷","savedAt":"2026-08-24","messages":[1],"workspace":"{ws_norm}"}}"#),
        );
        write_session(&global, "1.json", r#"{"label":"零目录卷","savedAt":"2026-08-20","messages":[1]}"#);
        // 旧目录：卷 5 陈旧副本（无 ws 字段 → 按位置归属 legacy-ws，同键去重被淘汰）
        //          + 卷 230 未吸收（仅旧目录，独占行）
        write_session(&legacy_sessions, "5.json", r#"{"label":"吸收前的旧卷","savedAt":"2026-08-23","messages":[1]}"#);
        write_session(&legacy_sessions, "230.json", r#"{"label":"未吸收大号卷","savedAt":"2026-08-22","messages":[1]}"#);

        std::env::set_var("HOLOGRAM_SESSIONS_ROOT", &global);
        let list = user_sessions_list(Some(legacy.to_string_lossy().into_owned()))
            .await
            .unwrap();
        // 卷 5 去重后保留全局位新副本；卷 1（零目录）与卷 230（legacy 归属）共存；
        // 同号异归属（如全局 1 零目录 vs 旧目录 1 归属 legacy）如出现则各自成行
        let vol5 = list.iter().find(|e| e.id == 5).expect("vol 5 present");
        assert_eq!(vol5.label, "吸收后的卷");
        assert_eq!(vol5.workspace.as_deref(), Some(ws_norm.as_str()));
        assert_eq!(list.iter().filter(|e| e.id == 5).count(), 1, "同键去重——旧目录陈旧副本被淘汰");
        let vol230 = list.iter().find(|e| e.id == 230).expect("vol 230 present");
        assert_eq!(vol230.workspace.as_deref(), Some(ws_norm.as_str())); // 按位置归属推导
        let vol1 = list.iter().find(|e| e.id == 1).expect("vol 1 present");
        assert_eq!(vol1.workspace, None);
        assert_eq!(list.len(), 3);
        // savedAt 倒序：5(08-24) > 1(08-20) > 230(08-22) → 序 5, 230, 1
        assert_eq!(list.iter().map(|e| e.id).collect::<Vec<_>>(), vec![5, 230, 1]);

        // legacy_root 非法字符拒绝（fail-closed）
        let bad = user_sessions_list(Some("..\\evil".into())).await;
        assert!(bad.is_err());
        let _ = std::fs::remove_dir_all(&global);
        let _ = std::fs::remove_dir_all(&legacy);
        std::env::remove_var("HOLOGRAM_SESSIONS_ROOT");
    }

    #[test]
    fn get_user_sessions_dir_matches_root() {
        // env var 竞态防护：与 user_sessions 系列共用 ENV_LOCK（无锁并行会在
        // 他测 set_var 窗口内劫持全局位路径——假非空/假空来源）
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("hologram_user_sessions_dir_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("HOLOGRAM_SESSIONS_ROOT", &tmp);
        let dir = get_user_sessions_dir();
        assert!(dir.contains('/'), "路径分隔符统一为 /: {dir}");
        assert!(!dir.contains('\\'), "无反斜杠: {dir}");
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::remove_var("HOLOGRAM_SESSIONS_ROOT");
    }
}

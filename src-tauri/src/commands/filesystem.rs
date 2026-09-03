// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 文件系统命令的会话扫描助手——工具业务已迁内核插件 builtin.fs
// （tool_plugins/fs/，kernel-plugin-runtime P2-2）；本文件保留工作区
// 注册表消费的内部助手（非 #[tauri::command]）。

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

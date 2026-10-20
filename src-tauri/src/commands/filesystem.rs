// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 文件系统命令的会话扫描助手——fs 工具业务已迁 fs_cap 能力口直呼
// （commands/fs_cap.rs；builtin.fs 插件已退役，kernel-capability-c3-design.md
// fs 域收口）。本文件保留工作区注册表消费的内部助手（非 #[tauri::command]）。

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

/// 会话清单投影文件名与版本（TS 侧真源：`chat-session.ts` 的 `CATALOG_ID` /
/// `CATALOG_VERSION`，2026-09-18 P0 侧栏载入审计落地的 `{root}/_index.json`）。
/// **TS 侧升版时必须同步这里**：版本对不上会退回文件口径（空卷不再被剔除）。
const SESSION_INDEX_FILE: &str = "_index.json";
const SESSION_INDEX_VERSION: u64 = 2;

/// 工作区会话根的扫描结果（首页工作区卡片的「N 卷 · 最近 MM-DD」）。
pub(crate) struct SessionScan {
    pub count: usize,
    /// 最近落盘时间（ISO 8601 UTC）；无卷 = None。
    pub latest_saved_at: Option<String>,
}

/// 扫描单个工作区会话根（`{workspace}/.lantai/sessions/`）→ 卷数与最近落盘时间。
///
/// **卷集真源 = 事件日志 `.ndjson`**（Phase 3b 权威翻转，2026-09-15 commit
/// `1a200bad`：`{id}.ndjson` 是卷本体，`{id}.json` 只是 UI 投影缓存）。旧口径按
/// `{id}.json` 数卷，会把两类非卷文件算成卷——**旧格式化石**（Phase 3b 之前的
/// `.json` 卷，拍板不做兼容读）与**删除竞态残留**（真机 `10.json` 的 savedAt 恰是
/// 删卷时刻，见 `chat-session.ts` `cacheOfThisVolume` 注）——同时漏掉只有 `.ndjson`
/// 的真实卷。首页数字因此与画布侧栏（`listSavedSessions`）长期不同源。
///
/// **空卷**：建卷即物化日志（`seedVolumeLog`），但只有 system 消息、从没说过话的
/// 卷不进清单投影 `_index.json` 的行，画布侧栏也不列——故计数 = 目录里在 **且**
/// 清单里有行的卷。清单缺失/版本不认（旧工作区，下次打开会重建）退回「目录里有
/// 就算」，不至于把历史工作区显示成 0 卷（最坏多算一个空壳）。
///
/// 读取容忍毒化（INVARIANTS #11.2）：目录不存在 = 空（首启常态）；非数字文件名 /
/// 下划线保留名跳过；清单坏 JSON = 退回文件口径，都不炸列表。
pub(crate) fn scan_sessions_dir(dir: &std::path::Path) -> SessionScan {
    let mut ids: Vec<u64> = Vec::new();
    let mut latest_mtime: Option<std::time::SystemTime> = None;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // 下划线保留名（_index.json / _issue.json / _active.json）天然不是卷
            if name.starts_with('_') || !name.ends_with(".ndjson") {
                continue;
            }
            let Ok(id) = name.trim_end_matches(".ndjson").parse::<u64>() else {
                continue; // 非数字文件名（毒化容忍）
            };
            ids.push(id);
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                if latest_mtime.is_none_or(|prev| modified > prev) {
                    latest_mtime = Some(modified);
                }
            }
        }
    }
    match read_session_index(dir) {
        Some(rows) => {
            // 清单在：只认「目录里有 + 清单有行」的卷；最近取清单行的 savedAt
            // （与画布侧栏读同一份投影，MM-DD 显示逐字一致）。
            let mut count = 0usize;
            let mut latest: Option<String> = None;
            for id in &ids {
                let Some(saved_at) = rows.get(id) else {
                    continue; // 空卷：清单无行，侧栏也不列
                };
                count += 1;
                if !saved_at.is_empty()
                    && latest.as_deref().is_none_or(|cur| saved_at.as_str() > cur)
                {
                    latest = Some(saved_at.clone());
                }
            }
            // 清单行没有 savedAt（老投影/毒化）时退回文件 mtime——不显示「——」
            SessionScan {
                count,
                latest_saved_at: latest.or_else(|| latest_mtime.map(iso_utc_secs)),
            }
        }
        // 清单缺席/不认：退回文件口径（卷在盘上就算），最近取文件 mtime。
        None => SessionScan {
            count: ids.len(),
            latest_saved_at: latest_mtime.map(iso_utc_secs),
        },
    }
}

/// 读清单投影 `_index.json`：`{ver, rows: {"<id>": {savedAt, ...}}}`。
/// 缺失 / 坏 JSON / 版本不认 ⇒ `None`（调用方退回文件口径；版本不认是旧工作区，
/// 不是损坏——TS 侧下次清点会整份重建）。
fn read_session_index(dir: &std::path::Path) -> Option<std::collections::HashMap<u64, String>> {
    let raw = std::fs::read_to_string(dir.join(SESSION_INDEX_FILE)).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if parsed.get("ver").and_then(|v| v.as_u64()) != Some(SESSION_INDEX_VERSION) {
        return None;
    }
    let rows = parsed.get("rows")?.as_object()?;
    let mut out = std::collections::HashMap::new();
    for (key, row) in rows {
        let Ok(id) = key.parse::<u64>() else {
            continue; // 毒化键容忍
        };
        let saved_at = row.get("savedAt").and_then(|v| v.as_str()).unwrap_or("");
        out.insert(id, saved_at.to_string());
    }
    Some(out)
}

/// `SystemTime` → RFC3339 UTC（秒精度，与前端 `savedAt` 同形）。
fn iso_utc_secs(t: std::time::SystemTime) -> String {
    let dt: chrono::DateTime<chrono::Utc> = t.into();
    dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

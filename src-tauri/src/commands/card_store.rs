// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 卡片库（card library）—— 架阁（docs/plans/entity-shelf-plan.md）的存储底座，B1。
//
// 契约：
//   - 卡片包 = `<cardsRoot>/<cardId>/{card.json, state.json}`；
//     根 = 用户主目录 `.lantai/cards/`（与插件数据根 `plugins-data` **分立**——
//     一个是「住进来的软件」，一个是「我收起来的卡片」，两族互不牵连），
//     `HOLOGRAM_CARD_ROOT` 可覆盖（测试隔离 / 目录重定位）。
//   - **拓印不覆盖**：`card_shelve` 目标已存在 ⇒ 显式拒绝（卡片是拓印语义，
//     不是 upsert；同一 assetId 重复收由前端拦，Rust 侧兜底）。
//   - 状态纪律（与 `src-ui/src/agent/asset-state.ts` 逐字同值）：浅合并 patch、
//     值必须 JSON 可序列化、**合并后序列化字节数 ≤ 64 KiB**——超限整笔拒绝、
//     绝不半写；写盘一律 `.tmp` + rename（`crate::utils::write_atomic`）。
//   - 删除 = 挪 `<cardsRoot>/.trash/<cardId>-<秒>-<纳秒>`（备份一个目录全家走，
//     与 `plugin_uninstall` 的数据回收同族；回收失败不静默——返回错误）。
//   - 围栏：cardId 名字围栏（非空、≤128 字符、拒 `\` `/` NUL 盘符、拒 `.`/`..`、
//     禁前导点）+ 根目录锁死。
//
// 强制层定位：webview 无盘权 ⇒ 卡片库 I/O 必须 Rust；**非能力口**——不进 Agent
// 工具面（收进架阁是用户手势，不是模型动作，见 entity-shelf-plan D3）。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// 单卡状态上限（合并后 UTF-8 序列化字节数）——与前端 `ASSET_STATE_MAX_BYTES` 同值。
pub(crate) const MAX_CARD_STATE_BYTES: usize = 64 * 1024;

/// `card.json` 读取上限（防无界内存读入）。
const MAX_CARD_JSON_BYTES: u64 = 1024 * 1024;

/// 卡片达到上限时的错误消息（前端可直接展示，措辞与资产状态同族）。
fn over_budget_msg(bytes: usize) -> String {
    format!("卡片状态超过 64 KiB 上限（合并后 {bytes} 字节）——整笔拒绝，未写入")
}

/// 卡片库根：用户主目录 `.lantai/cards/`。
pub(crate) fn cards_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("HOLOGRAM_CARD_ROOT") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".lantai").join("cards")
}

/// cardId 围栏：非空、≤128 字符、拒路径段与盘符形态、拒 `.`/`..`/前导点
/// （前导点会与 `.trash` 等内部目录混族）。
fn fence_card_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("cardId 不能为空".to_string());
    }
    if id.chars().count() > 128 {
        return Err(format!("非法 cardId（超过 128 字符）: {id}"));
    }
    if id.contains('/') || id.contains('\\') || id.contains('\0') || id.contains(':') {
        return Err(format!("非法 cardId（含路径段/NUL/盘符）: {id}"));
    }
    if id == "." || id == ".." || id.starts_with('.') {
        return Err(format!("非法 cardId（回溯段或前导点）: {id}"));
    }
    Ok(())
}

fn card_dir_at(root: &Path, id: &str) -> Result<PathBuf, String> {
    fence_card_id(id)?;
    Ok(root.join(id))
}

/// 读一个已存在文件（带上限与 UTF-8 契约）。不存在 = Ok(None)。
fn read_optional(path: &Path, limit: u64) -> Result<Option<String>, String> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            if !meta.is_file() {
                return Err(format!("不是常规文件: {}", path.display()));
            }
            if meta.len() > limit {
                return Err(format!(
                    "文件超过上限（{} > {} 字节）: {}",
                    meta.len(),
                    limit,
                    path.display()
                ));
            }
            let text = std::fs::read_to_string(path)
                .map_err(|e| format!("读取失败（{}）: {e}", path.display()))?;
            Ok(Some(text))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取失败（{}）: {e}", path.display())),
    }
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    let s = path.to_string_lossy().into_owned();
    crate::utils::write_atomic(&s, text)
}

/// 校验并规范化状态对象（浅合并语义的前提：顶层必须是 object）。
fn normalize_state(text: &str) -> Result<String, String> {
    let raw = if text.trim().is_empty() { "{}" } else { text };
    let value: Value = serde_json::from_str(raw)
        .map_err(|e| format!("卡片状态不是合法 JSON: {e}"))?;
    if !value.is_object() {
        return Err("卡片状态必须是 JSON 对象（顶层 object）".to_string());
    }
    let normalized =
        serde_json::to_string(&value).map_err(|e| format!("卡片状态序列化失败: {e}"))?;
    if normalized.len() > MAX_CARD_STATE_BYTES {
        return Err(over_budget_msg(normalized.len()));
    }
    Ok(normalized)
}

/// 收进架阁（拓印）：写入 `card.json` + `state.json`，返回 `{cardId, dir}`。
/// 目标已存在 ⇒ 拒绝（不覆盖）；写入途中失败 ⇒ 清掉半成品目录再返回错误。
pub(crate) fn card_shelve_at(
    root: &Path,
    card_json: &str,
    state_json: &str,
) -> Result<Value, String> {
    if card_json.len() as u64 > MAX_CARD_JSON_BYTES {
        return Err(format!(
            "card.json 超过上限（{} > {MAX_CARD_JSON_BYTES} 字节）",
            card_json.len()
        ));
    }
    let card: Value =
        serde_json::from_str(card_json).map_err(|e| format!("card.json 不是合法 JSON: {e}"))?;
    let card_id = card
        .get("cardId")
        .and_then(Value::as_str)
        .ok_or_else(|| "card.json 缺 cardId 字段".to_string())?;
    if !card.get("kind").is_some_and(Value::is_string) {
        return Err("card.json 缺 kind 字段（必须是字符串）".to_string());
    }
    let dir = card_dir_at(root, card_id)?;
    if dir.exists() {
        return Err(format!("卡片已存在（拓印不覆盖，请换一个 cardId）: {card_id}"));
    }
    let state_text = normalize_state(state_json)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建卡片目录失败（{}）: {e}", dir.display()))?;
    let written = write_text(&dir.join("card.json"), card_json)
        .and_then(|()| write_text(&dir.join("state.json"), &state_text));
    if let Err(e) = written {
        // 半成品不留在盘上（拓印要么整份成立，要么什么都不发生）。
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(json!({ "cardId": card_id, "dir": dir.to_string_lossy() }))
}

pub(crate) fn card_shelve(card_json: &str, state_json: &str) -> Result<Value, String> {
    card_shelve_at(&cards_root(), card_json, state_json)
}

/// 枚举卡片库（摘要）：按 `source.shelvedAt` 倒序（ISO 串字典序 = 时间序），
/// 缺该字段的排在后面。坏卡不炸全表——逐条进 `skipped`（错误可见）。
pub(crate) fn card_list_at(root: &Path) -> Result<Value, String> {
    let mut cards: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let read_dir = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "cards": [], "skipped": [] }));
        }
        Err(e) => return Err(format!("枚举卡片库失败（{}）: {e}", root.display())),
    };
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("枚举卡片库失败（{}）: {e}", root.display()))?;
        let ft = entry
            .file_type()
            .map_err(|e| format!("枚举卡片库失败（{}）: {e}", root.display()))?;
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // .trash 等内部目录
        }
        match summarize_card(&entry.path(), &name) {
            Ok(summary) => cards.push(summary),
            Err(e) => skipped.push(json!({ "cardId": name, "error": e })),
        }
    }
    cards.sort_by(|a, b| {
        let ta = a.get("shelvedAt").and_then(Value::as_str).unwrap_or("");
        let tb = b.get("shelvedAt").and_then(Value::as_str).unwrap_or("");
        tb.cmp(ta)
    });
    Ok(json!({ "cards": cards, "skipped": skipped }))
}

pub(crate) fn card_list() -> Result<Value, String> {
    card_list_at(&cards_root())
}

fn summarize_card(dir: &Path, card_id: &str) -> Result<Value, String> {
    let text = read_optional(&dir.join("card.json"), MAX_CARD_JSON_BYTES)?
        .ok_or_else(|| "缺 card.json".to_string())?;
    let card: Value = serde_json::from_str(&text)
        .map_err(|e| format!("card.json 不是合法 JSON: {e}"))?;
    let state_bytes = std::fs::metadata(dir.join("state.json"))
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(json!({
        "cardId": card.get("cardId").and_then(Value::as_str).unwrap_or(card_id),
        "kind": card.get("kind").cloned().unwrap_or(Value::Null),
        "title": card.get("title").cloned().unwrap_or(Value::Null),
        "shelvedAt": card.pointer("/source/shelvedAt").cloned().unwrap_or(Value::Null),
        "stateBytes": state_bytes,
        "dirBytes": dir_size(dir),
    }))
}

/// 目录总字节数（不递归符号链接；失败按 0 计——纯展示读数，不影响判定）。
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in read_dir.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_file() {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// 读一张卡：`{card, state}`（state 缺文件 = 空对象）。
pub(crate) fn card_read_at(root: &Path, card_id: &str) -> Result<Value, String> {
    let dir = card_dir_at(root, card_id)?;
    let card_text = read_optional(&dir.join("card.json"), MAX_CARD_JSON_BYTES)?
        .ok_or_else(|| format!("卡片不存在: {card_id}"))?;
    let card: Value = serde_json::from_str(&card_text)
        .map_err(|e| format!("card.json 不是合法 JSON（{card_id}）: {e}"))?;
    let state_text = read_optional(&dir.join("state.json"), MAX_CARD_STATE_BYTES as u64)?
        .unwrap_or_else(|| "{}".to_string());
    let state: Value = serde_json::from_str(&state_text)
        .map_err(|e| format!("state.json 不是合法 JSON（{card_id}）: {e}"))?;
    Ok(json!({ "card": card, "state": state }))
}

pub(crate) fn card_read(card_id: &str) -> Result<Value, String> {
    card_read_at(&cards_root(), card_id)
}

/// 浅合并写状态：读旧 → 顶层逐键覆盖 → 64 KiB 校验 → 原子写。返回 `{bytes}`。
pub(crate) fn card_state_write_at(
    root: &Path,
    card_id: &str,
    patch_json: &str,
) -> Result<Value, String> {
    let dir = card_dir_at(root, card_id)?;
    if !dir.is_dir() {
        return Err(format!("卡片不存在: {card_id}"));
    }
    let old_text = read_optional(&dir.join("state.json"), MAX_CARD_STATE_BYTES as u64)?
        .unwrap_or_else(|| "{}".to_string());
    let mut base: Value = serde_json::from_str(&old_text)
        .map_err(|e| format!("state.json 不是合法 JSON（{card_id}）: {e}"))?;
    let patch: Value = serde_json::from_str(patch_json)
        .map_err(|e| format!("patch 不是合法 JSON: {e}"))?;
    let patch_map = match patch {
        Value::Object(map) => map,
        _ => return Err("patch 必须是 JSON 对象（顶层 object）".to_string()),
    };
    let base_map = match &mut base {
        Value::Object(map) => map,
        _ => {
            // 旧文件坏成非 object：不静默覆盖，让用户看见。
            return Err(format!("state.json 顶层不是 object（{card_id}）——拒绝合并"));
        }
    };
    for (k, v) in patch_map {
        base_map.insert(k, v);
    }
    let text = serde_json::to_string(&base)
        .map_err(|e| format!("卡片状态序列化失败: {e}"))?;
    if text.len() > MAX_CARD_STATE_BYTES {
        return Err(over_budget_msg(text.len()));
    }
    write_text(&dir.join("state.json"), &text)?;
    Ok(json!({ "bytes": text.len() }))
}

pub(crate) fn card_state_write(card_id: &str, patch_json: &str) -> Result<Value, String> {
    card_state_write_at(&cards_root(), card_id, patch_json)
}

/// 删除（挪 `.trash/<cardId>-<秒>-<纳秒>`）：回收失败**不静默**（返回错误）。
pub(crate) fn card_delete_at(root: &Path, card_id: &str) -> Result<Value, String> {
    let dir = card_dir_at(root, card_id)?;
    if !dir.exists() {
        return Ok(json!({ "cardId": card_id, "trashed": Value::Null }));
    }
    let trash_root = root.join(".trash");
    std::fs::create_dir_all(&trash_root)
        .map_err(|e| format!("创建 .trash 失败（{}）: {e}", trash_root.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{}-{}", d.as_secs(), d.subsec_nanos()))
        .unwrap_or_else(|_| "0-0".to_string());
    let dest = trash_root.join(format!("{card_id}-{stamp}"));
    std::fs::rename(&dir, &dest).map_err(|e| {
        format!(
            "回收失败（{} → {}）: {e}",
            dir.display(),
            dest.display()
        )
    })?;
    Ok(json!({ "cardId": card_id, "trashed": dest.to_string_lossy() }))
}

pub(crate) fn card_delete(card_id: &str) -> Result<Value, String> {
    card_delete_at(&cards_root(), card_id)
}

/// 改标题（只动 `card.json` 的 `title` 字段；其余字段逐字不动——拓印语义下
/// 内容归作者，重命名是宿主允许改的**唯一**一项，且不改身份）。
pub(crate) fn card_rename_at(root: &Path, card_id: &str, title: &str) -> Result<Value, String> {
    let dir = card_dir_at(root, card_id)?;
    let text = read_optional(&dir.join("card.json"), MAX_CARD_JSON_BYTES)?
        .ok_or_else(|| format!("卡片不存在: {card_id}"))?;
    let mut card: Value =
        serde_json::from_str(&text).map_err(|e| format!("card.json 不是合法 JSON（{card_id}）: {e}"))?;
    let trimmed = title.trim();
    if trimmed.chars().count() > 120 {
        return Err(format!("标题超过 120 字符（{}）", trimmed.chars().count()));
    }
    let obj = card
        .as_object_mut()
        .ok_or_else(|| format!("card.json 顶层不是 object（{card_id}）"))?;
    obj.insert("title".to_string(), Value::String(trimmed.to_string()));
    let out =
        serde_json::to_string_pretty(&card).map_err(|e| format!("card.json 序列化失败: {e}"))?;
    write_text(&dir.join("card.json"), &out)?;
    Ok(json!({ "cardId": card_id, "title": trimmed }))
}

pub(crate) fn card_rename(card_id: &str, title: &str) -> Result<Value, String> {
    card_rename_at(&cards_root(), card_id, title)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时根（每测试一个唯一目录，零环境变量污染——测试可并行）。
    fn temp_root(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lantai-card-test-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("建临时根");
        dir
    }

    fn card_json(id: &str) -> String {
        json!({
            "cardId": id,
            "kind": "html",
            "title": "本周待办",
            "payload": { "code": "<div>x</div>" },
            "source": { "sessionId": "s1", "assetId": "a1", "shelvedAt": "2026-12-08T10:00:00.000Z" },
            "v": 1
        })
        .to_string()
    }

    #[test]
    fn fence_rejects_path_segments_and_dots() {
        for bad in ["", "  ", "..", ".", ".hidden", "a/b", "a\\b", "C:x", "a:b"] {
            assert!(fence_card_id(bad).is_err(), "应拒: {bad:?}");
        }
        assert!(fence_card_id("card-1733654321-a8f3").is_ok());
    }

    #[test]
    fn shelve_writes_both_files_and_rejects_overwrite() {
        let root = temp_root("shelve");
        let r = card_shelve_at(&root, &card_json("c1"), r#"{"done":true}"#).unwrap();
        assert_eq!(r["cardId"], "c1");
        assert!(root.join("c1").join("card.json").is_file());
        assert!(root.join("c1").join("state.json").is_file());
        // 拓印不覆盖
        let again = card_shelve_at(&root, &card_json("c1"), "{}");
        assert!(again.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn shelve_rejects_invalid_payloads() {
        let root = temp_root("bad");
        assert!(card_shelve_at(&root, "not json", "{}").is_err());
        assert!(card_shelve_at(&root, r#"{"kind":"html"}"#, "{}").is_err()); // 缺 cardId
        assert!(card_shelve_at(&root, r#"{"cardId":"c1"}"#, "{}").is_err()); // 缺 kind
        assert!(card_shelve_at(&root, &card_json("c1"), "[1,2]").is_err()); // state 非 object
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn state_shallow_merge_and_budget() {
        let root = temp_root("state");
        card_shelve_at(&root, &card_json("c1"), r#"{"a":1,"b":2}"#).unwrap();
        let r = card_state_write_at(&root, "c1", r#"{"b":9,"c":3}"#).unwrap();
        assert!(r["bytes"].as_u64().unwrap() > 0);
        let read = card_read_at(&root, "c1").unwrap();
        assert_eq!(read["state"]["a"], 1);
        assert_eq!(read["state"]["b"], 9);
        assert_eq!(read["state"]["c"], 3);
        // 超额整笔拒绝（不半写）
        let big = format!(r#"{{"big":"{}"}}"#, "x".repeat(70 * 1024));
        assert!(card_state_write_at(&root, "c1", &big).is_err());
        let after = card_read_at(&root, "c1").unwrap();
        assert_eq!(after["state"]["a"], 1, "超额拒绝后旧状态必须原样");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_sorts_desc_and_skips_broken() {
        let root = temp_root("list");
        card_shelve_at(&root, &card_json("c1"), "{}").unwrap();
        let mut c2 = card_json("c2");
        c2 = c2.replace("2026-12-08T10:00:00.000Z", "2026-12-09T10:00:00.000Z");
        card_shelve_at(&root, &c2, "{}").unwrap();
        // 坏卡：目录在、card.json 坏
        std::fs::create_dir_all(root.join("bad")).unwrap();
        std::fs::write(root.join("bad").join("card.json"), "{oops").unwrap();
        let listed = card_list_at(&root).unwrap();
        let ids: Vec<&str> = listed["cards"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["cardId"].as_str())
            .collect();
        assert_eq!(ids, vec!["c2", "c1"], "按 shelvedAt 倒序");
        assert_eq!(listed["skipped"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_moves_to_trash() {
        let root = temp_root("delete");
        card_shelve_at(&root, &card_json("c1"), "{}").unwrap();
        let r = card_delete_at(&root, "c1").unwrap();
        assert!(!root.join("c1").exists());
        let trashed = r["trashed"].as_str().unwrap();
        assert!(trashed.contains(".trash"));
        assert!(std::path::Path::new(trashed).exists());
        // 幂等：再删 = 无操作
        assert!(card_delete_at(&root, "c1").is_ok());
        // 越界 id 拒
        assert!(card_delete_at(&root, "../c1").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}

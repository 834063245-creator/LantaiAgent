// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// search 能力口（R2 试点，kernel-capability-r2-search-pilot.md）——内核能力层的
// search 变体（v3 §4：search/glob 的全文扫描 = fs 能力族实现）。
//
// 能力口语义：被 TS 工具经 RPC 直呼（不再 tool_call 信封 / PluginRegistry /
// PluginToolAdapter）。入口即裁决：directory 走 resolve_read_dispatch（Agent =
// require_read 过闸 + Ask，UI = 只解析），扫描/预算/忽略/向量召回归本口物理实现。
// 编排（参数缺省/输出形态/分页）仍在 TS 侧（R2-d 迁）；本口返回与 builtin.search
// 现 search_content 相同的 JSON 形状，保证换轨期行为零漂移。
//
// 真权路径与 builtin.search::search_content 相同（resolve_read_dispatch），权限
// 回归 = 同一闸；search 无 permission 声明（v1 Passthrough），无家族规则差异。

use hologram_graph::is_ignored_path;
use serde_json::Value;
use tauri::State;

/// search_content 能力口（R2-a 从 builtin.search::search_content 迁扫描体；
/// 参数说 manifest schema 的语言 camelCase；_agent_id 由调用方显式传 agent_id）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_content_cap(
    directory: String,
    pattern: String,
    file_types: Option<String>,
    max_results: Option<usize>,
    use_regex: Option<bool>,
    context_lines: Option<usize>,
    output_mode: Option<String>,
    show_line_numbers: Option<bool>,
    head_limit: Option<usize>,
    offset: Option<usize>,
    glob_filter: Option<String>,
    is_agent: bool,
    agent_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<Value, String> {
    let root = crate::utils::resolve_read_dispatch(&directory, is_agent, agent_id.as_deref(), state, app).await?;

    let is_regex = use_regex.unwrap_or(false);
    let regex = if is_regex {
        Some(
            regex::RegexBuilder::new(&pattern)
                .case_insensitive(true)
                .multi_line(true)
                .build()
                .map_err(|e| format!("正则表达式无效: {e}"))?,
        )
    } else {
        None
    };
    let sub_patterns: Vec<String> = if is_regex {
        Vec::new()
    } else {
        pattern
            .to_lowercase()
            .split('|')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };
    let extensions: Vec<String> = file_types
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().trim_start_matches('.').to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    let max = max_results.unwrap_or(50).min(200);
    let ctx_lines = context_lines.unwrap_or(0).min(10);
    let mode = output_mode.unwrap_or_else(|| "content".into());
    let show_ln = show_line_numbers.unwrap_or(true);
    let head = head_limit.unwrap_or(250);
    let skip = offset.unwrap_or(0);
    let glob_re = glob_filter.as_deref().and_then(glob_filter_to_regex);

    let pat = pattern.clone();
    let root = root.clone();

    tokio::task::spawn_blocking(move || {
        let mut results: Vec<Value> = Vec::new();
        let mut file_sets: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut file_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let skip_extensions: Vec<&str> = vec![
            "exe", "dll", "so", "dylib", "bin", "o", "a",
            "png", "jpg", "jpeg", "gif", "ico", "svg",
            "woff", "woff2", "ttf", "eot",
            "zip", "tar", "gz", "bz2", "7z", "rar",
            "mp3", "mp4", "avi", "mov", "wav",
            "pdf", "doc", "docx", "xls", "xlsx",
            "pyc", "pyo", "class", "wasm",
            "lock", "map", "min.js", "min.css",
        ];

        // ── 扫描预算：防止在巨大目录树中无限遍历 ──
        const MAX_SCAN_FILES: usize = 20_000;
        const TIME_BUDGET_SECS: u64 = 60;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(TIME_BUDGET_SECS);
        let mut scanned_files: usize = 0;
        let mut truncated_by_budget = false;

        // 相对路径匹配用：去掉 root 前缀
        let root_str = root.to_string_lossy().replace('\\', "/");
        let root_str = root_str.trim_end_matches('/').to_string();

        let mut builder = ignore::WalkBuilder::new(&root);
        builder
            .hidden(false)
            .require_git(false)
            .filter_entry(|e| {
                e.file_type().map_or(true, |ft| !ft.is_dir())
                    || !is_ignored_path(
                        &e.path().to_string_lossy().replace('\\', "/"),
                    )
            });
        for entry in builder.build() {
            if scanned_files >= MAX_SCAN_FILES || std::time::Instant::now() > deadline {
                truncated_by_budget = true;
                break;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().map_or(false, |ft| ft.is_file()) {
                continue;
            }
            scanned_files += 1;

            let fp = entry.path();
            let ext = fp.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            let name = fp.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if skip_extensions.iter().any(|skip| ext == *skip || name.ends_with(skip)) {
                continue;
            }
            if !extensions.is_empty() && !extensions.contains(&ext) {
                continue;
            }
            let fp_str = fp.to_string_lossy().to_string();
            if let Some(ref re) = &glob_re {
                let rel = fp_str.replace('\\', "/");
                let rel = rel.strip_prefix(&root_str).unwrap_or(&rel);
                let rel = rel.trim_start_matches('/');
                if !re.is_match(rel) { continue; }
            }

            let content = match std::fs::read_to_string(fp) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let lines: Vec<&str> = content.lines().collect();

            let mut file_has_match = false;
            for (line_no, line) in lines.iter().enumerate() {
                let matched = if let Some(ref re) = regex {
                    re.is_match(line)
                } else {
                    let line_lower = line.to_lowercase();
                    sub_patterns.iter().any(|p| line_lower.contains(p))
                };
                if matched {
                    file_has_match = true;
                    *file_counts.entry(fp_str.clone()).or_insert(0) += 1;

                    if mode == "content" {
                        let start = line_no.saturating_sub(ctx_lines);
                        let end = (line_no + ctx_lines + 1).min(lines.len());
                        let context_block: Vec<Value> = lines[start..end].iter().enumerate().map(|(i, l)| {
                            let ln = start + i + 1;
                            serde_json::json!({
                                "line": if show_ln { Some(ln) } else { None },
                                "content": l,
                                "is_match": ln == line_no + 1,
                            })
                        }).collect();
                        results.push(serde_json::json!({
                            "file": fp_str,
                            "match_line": line_no + 1,
                            "match_content": line,
                            "context": ctx_lines,
                            "context_block": context_block,
                        }));
                    }
                    if results.len() >= max { break; }
                }
            }
            if file_has_match { file_sets.insert(fp_str.clone()); }
            if mode != "content" && file_sets.len() >= max {
                truncated_by_budget = true;
                break;
            }
            if results.len() >= max { break; }
        }

        let output = match mode.as_str() {
            "files_with_matches" => {
                let mut files: Vec<&String> = file_sets.iter().collect();
                files.sort();
                let total = files.len();
                let files = if head > 0 { files.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { files };
                serde_json::json!({
                    "pattern": pat,
                    "count": total,
                    "truncated": (head > 0 && skip + head < total) || truncated_by_budget,
                    "scanned_files": scanned_files,
                    "budget_truncated": truncated_by_budget,
                    "files": files,
                })
            }
            "count" => {
                let mut counts: Vec<(&String, &usize)> = file_counts.iter().collect();
                counts.sort_by(|a, b| b.1.cmp(a.1));
                let total = counts.len();
                let counts = if head > 0 { counts.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { counts };
                serde_json::json!({
                    "pattern": pat,
                    "total_matches": file_counts.values().sum::<usize>(),
                    "file_count": total,
                    "truncated": (head > 0 && skip + head < total) || truncated_by_budget,
                    "scanned_files": scanned_files,
                    "budget_truncated": truncated_by_budget,
                    "files": counts.into_iter().map(|(f, c)| serde_json::json!({"file": f, "matches": c})).collect::<Vec<_>>(),
                })
            }
            _ => {
                let total = results.len();
                let results = if head > 0 { results.into_iter().skip(skip).take(head).collect::<Vec<_>>() } else { results };
                serde_json::json!({
                    "pattern": pat,
                    "count": total,
                    "truncated": (head > 0 && skip + head < total) || truncated_by_budget,
                    "scanned_files": scanned_files,
                    "budget_truncated": truncated_by_budget,
                    "context_lines": ctx_lines,
                    "results": results,
                })
            }
        };

        let mut output_val = output;
        if !is_regex {
            append_vector_hits(&mut output_val, &root, &pat);
        }

        Ok(output_val)
    })
    .await
    .map_err(|e| format!("搜索任务失败: {e}"))?
}

/// glob_filter（相对模式）→ 正则。* 不跨目录（[^/]*），** 跨目录（.*），**/ 可选前缀。
fn glob_filter_to_regex(gf: &str) -> Option<regex::Regex> {
    let gf = gf.replace('\\', "/");
    let mut re = String::from("^");
    let chars: Vec<char> = gf.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    if i + 2 < chars.len() && chars[i + 2] == '/' {
                        re.push_str("(?:.*/)?");
                        i += 3;
                    } else {
                        re.push_str(".*");
                        i += 2;
                    }
                } else {
                    re.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => { re.push_str("[^/]"); i += 1; }
            '.' => { re.push_str("\\."); i += 1; }
            '\\' => { re.push_str("\\\\"); i += 1; }
            '+' => { re.push_str("\\+"); i += 1; }
            '(' => { re.push_str("\\("); i += 1; }
            ')' => { re.push_str("\\)"); i += 1; }
            '[' => { re.push_str("\\["); i += 1; }
            ']' => { re.push_str("\\]"); i += 1; }
            '{' => { re.push_str("\\{"); i += 1; }
            '}' => { re.push_str("\\}"); i += 1; }
            '^' => { re.push_str("\\^"); i += 1; }
            '$' => { re.push_str("\\$"); i += 1; }
            '|' => { re.push_str("\\|"); i += 1; }
            c => { re.push(c); i += 1; }
        }
    }
    re.push('$');
    regex::Regex::new(&re).ok()
}

/// 将向量（语义）搜索命中附加到输出。走引擎的进程级缓存索引（mtime 失效
/// 自动重载）。与引擎 search_symbols 同一套过滤策略：低于阈值丢弃、最多 5 条。
fn append_vector_hits(output_val: &mut Value, root: &std::path::Path, pattern: &str) {
    use hologram_vector as vector;
    let (index, slots) = match vector::get_or_load_index(root) {
        Ok(pair) => pair,
        Err(_) => return,
    };
    let idx = crate::utils::read_or_recover(&index);
    let idx = match idx.as_ref() {
        Some(i) => i,
        None => return,
    };
    let slot_data = crate::utils::read_or_recover(&slots);
    if slot_data.is_empty() { return; }

    let q_vec = vector::embed(pattern);
    let results = match idx.search(&q_vec, 20) {
        Ok(r) => r,
        Err(_) => return,
    };

    let threshold = vector::score_threshold();
    let raw: Vec<(String, f32)> = results.keys.iter().zip(results.distances.iter())
        .filter_map(|(slot_key, distance)| {
            let slot = *slot_key as usize;
            if slot >= slot_data.len() { return None; }
            let similarity = 1.0 - (*distance).min(2.0).max(0.0);
            Some((slot_data[slot].clone(), similarity))
        })
        .collect();
    let hits = vector::filter_hits(&raw, threshold, 5, &std::collections::HashSet::new());
    if hits.is_empty() { return; }

    let vec_results: Vec<Value> = hits.into_iter()
        .map(|(id, score)| serde_json::json!({"node_id": id, "score": (score * 100.0).round() as u32}))
        .collect();
    output_val["vector_hits"] = serde_json::json!(vec_results);
    output_val["vector_backend"] = serde_json::json!(vector::backend_id());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_to_regex_simple_filename() {
        let re = glob_filter_to_regex("config.py").expect("glob_to_regex failed");
        assert!(re.is_match("config.py"));
        assert!(!re.is_match("src/config.py"));
        assert!(!re.is_match("D:/x/config.py"));
    }

    #[test]
    fn glob_to_regex_wildcard() {
        let re = glob_filter_to_regex("core/*.py").expect("glob_to_regex failed");
        assert!(re.is_match("core/main.py"));
        assert!(re.is_match("core/utils.py"));
        assert!(!re.is_match("core/sub/main.py"));
    }

    #[test]
    fn glob_to_regex_double_star() {
        let re = glob_filter_to_regex("**/*.rs").expect("glob_to_regex failed");
        assert!(re.is_match("main.rs"));
        assert!(re.is_match("src/main.rs"));
        assert!(re.is_match("src/engine/core/mod.rs"));
    }

    #[test]
    fn glob_to_regex_question_mark() {
        let re = glob_filter_to_regex("file?.txt").expect("glob_to_regex failed");
        assert!(re.is_match("file1.txt"));
        assert!(re.is_match("fileA.txt"));
        assert!(!re.is_match("file10.txt"));
        assert!(!re.is_match("file.txt"));
    }
}

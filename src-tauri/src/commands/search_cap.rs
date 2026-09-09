// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// search 能力口（R2 试点，kernel-capability-r2-search-pilot.md）——内核能力层的
// search 变体（v3 §4：search/glob 的全文扫描 = fs 能力族实现）。
//
// 能力口语义：被 TS 工具经 RPC 直呼（不再 tool_call 信封 / PluginRegistry /
// PluginToolAdapter）。入口即裁决：directory 走 resolve_read_dispatch（Agent =
// require_read 过闸 + Ask，UI = 只解析），扫描/预算/忽略/向量召回归本口物理实现。
//
// R2-d(2)（输出组装编排回 TS，r2-search-pilot §8）：能力口收窄为**纯扫描返回
// 统一原始命中集**——不再认识 output_mode/show_line_numbers/head_limit/offset
// （三形态组装/行号显示/分页/截断判定全部在 TS 编排层
// src/agent/tools/search-assembly.ts，与 schema 真源同域）。口收两组收窄键：
//   - max_matches：总命中条数上限（content 形态的扫描终止位）
//   - max_files：命中文件数上限（files/count 形态的扫描终止位——触顶即
//     budget_truncated=true，与退役前「file_sets.len() >= max」同款语义）
//   - collect_lines：是否随行携带命中内容与上下文（content 形态 true）
// 逐行为等价于退役前的模式分派扫描（content：行循环在总命中达 max 处断；
// files/count：文件循环在命中文件数达 max 处断并置 truncated）。
//
// 真权路径与 builtin.search::search_content 相同（resolve_read_dispatch），权限
// 回归 = 同一闸；search 无 permission 声明（v1 Passthrough），无家族规则差异。

use crate::ignored_paths::is_ignored_path;
use serde_json::Value;
use tauri::State;

/// search_content 能力口（纯扫描：返回统一原始命中集；编排归 TS）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn search_content_cap(
    directory: String,
    pattern: String,
    file_types: Option<String>,
    max_matches: Option<usize>,
    max_files: Option<usize>,
    use_regex: Option<bool>,
    context_lines: Option<usize>,
    collect_lines: Option<bool>,
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
    // 上下文行数（收集命中邻居——物理读盘范畴；上限 10 与退役前口内 clamp 同款）
    let ctx_lines = context_lines.unwrap_or(0).min(10);
    let collect = collect_lines.unwrap_or(false);
    let glob_re = glob_filter.as_deref().and_then(glob_filter_to_regex);

    let pat = pattern.clone();
    let root = root.clone();

    // （向量召回边车（经引擎子进程 semantic_search）随图谱全量退役删除，
    //  2026-09-09——扫描本体不受影响；vector_hits 尾键不再出现。）

    tokio::task::spawn_blocking(move || {
        // ── 统一原始命中集：per-file {file, match_count, matches[]} ──
        let mut files: Vec<Value> = Vec::new();
        let mut total_matches: usize = 0;
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
        'walk: for entry in builder.build() {
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

            let mut file_match_count: usize = 0;
            let mut file_matches: Vec<Value> = Vec::new();
            for (line_no, line) in lines.iter().enumerate() {
                let matched = if let Some(ref re) = &regex {
                    re.is_match(line)
                } else {
                    let line_lower = line.to_lowercase();
                    sub_patterns.iter().any(|p| line_lower.contains(p))
                };
                if matched {
                    file_match_count += 1;
                    total_matches += 1;
                    if collect {
                        // 上下文邻居（含命中行自身——ctx=0 时即单行块）
                        let start = line_no.saturating_sub(ctx_lines);
                        let end = (line_no + ctx_lines + 1).min(lines.len());
                        let context: Vec<Value> = lines[start..end].iter().enumerate().map(|(i, l)| {
                            serde_json::json!({ "line": start + i + 1, "content": l })
                        }).collect();
                        file_matches.push(serde_json::json!({
                            "line": line_no + 1,
                            "content": line,
                            "context": context,
                        }));
                    }
                    // content 形态的行级断（退役前 results.len() >= max 同款）
                    if let Some(m) = max_matches {
                        if total_matches >= m { break; }
                    }
                }
            }
            if file_match_count > 0 {
                files.push(serde_json::json!({
                    "file": fp_str,
                    "match_count": file_match_count,
                    "matches": file_matches,
                }));
                // files/count 形态的文件级断（退役前 file_sets.len() >= max 同款
                // ——触顶置 truncated，分页截断判定在 TS）
                if let Some(mf) = max_files {
                    if files.len() >= mf {
                        truncated_by_budget = true;
                        break 'walk;
                    }
                }
            }
            // content 形态的文件级断（不置 truncated——同退役前）
            if let Some(m) = max_matches {
                if total_matches >= m { break; }
            }
        }

        let output_val = serde_json::json!({
            "pattern": pat,
            "scanned_files": scanned_files,
            "budget_truncated": truncated_by_budget,
            "files": files,
        });

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

// （向量召回边车 append_vector_hits / same_canonical_root 随图谱全量退役
//  删除，2026-09-09——semantic_search 经引擎 transport，壳内零引擎接线后
//  无调用面。）

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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 受限文件 I/O — 内核 fs 能力口（C 模型定稿形态，2026-09-04）。
//
// 架构史：
//   Phase 0-2  每个工具一 Rust 模块（工具业务仍在内核）——用户否决
//   D0-D2      字节执行搬 primitives-server 进程 + 每工具一后端接口——
//              用户否决（「要给每个工具准备接口？」）→ 终态 = C 模型
//   C 模型     内核留极少数能力口，每个口内嵌闸门（认能力+目标），工具
//              代码（schema/编排/解析）回 TS。本文件 = fs 能力口的实现：
//              裁决（resolve_*_unchecked：worktree 映射 + 沙箱）+ 字节执行一体。
//
// 语义：每个能力口函数被 TS 工具经 RPC 调用，入口即裁决（Read/Edit 家族门
// 在 dispatch 侧 adapter 或口内 Tool 构造）——「不管什么工具调，都过同一闸」。
//
// 本文件与 D2 前 confined_fs 同构（字节执行回迁自退役的 primitives-server
// fs_ops——错误文案/guards 逐字一致），不再转发子进程：webview 无盘权但 exe
// 有，TS 工具经本能力口碰盘即可，无需第二个进程（C 模型 §6）。

use std::io;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

use crate::WorkspaceState;

// ═══════════════════════════════════════════════════════════════
// Guards — 文件大小限制、读取超时、重试预算（confined_fs 原样）
// ═══════════════════════════════════════════════════════════════

/// 读取文件的最大大小 (100 MiB)。
const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;
/// 写入内容的最大大小 (100 MiB)。
const MAX_WRITE_BYTES: usize = 100 * 1024 * 1024;
/// 读取超时。
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// 瞬态 I/O 错误重试次数。
const IO_RETRY_COUNT: u32 = 3;
/// 重试间延迟（翻倍）。
const IO_RETRY_BASE_DELAY: Duration = Duration::from_millis(100);

/// 在瞬态错误时最多重试 IO_RETRY_COUNT 次。
fn with_io_retry<T, F>(mut op: F, label: &str) -> Result<T, String>
where
    F: FnMut() -> io::Result<T>,
{
    let mut last_err: Option<io::Error> = None;
    for attempt in 0..=IO_RETRY_COUNT {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => {
                let retryable = matches!(
                    e.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                );
                if !retryable || attempt == IO_RETRY_COUNT {
                    return Err(format!("{} (尝试 {} 次后失败): {}", label, attempt + 1, e));
                }
                let delay = IO_RETRY_BASE_DELAY * 2u32.pow(attempt);
                eprintln!(
                    "[confined_fs] {}: retryable error, attempt {}/{} — {:?} (retrying in {:?})",
                    label, attempt + 1, IO_RETRY_COUNT, e, delay
                );
                std::thread::sleep(delay);
                last_err = Some(e);
            }
        }
    }
    Err(format!(
        "{} (尝试 {} 次后失败): {}",
        label,
        IO_RETRY_COUNT + 1,
        last_err.map(|e| e.to_string()).unwrap_or_else(|| "未知 I/O 错误".to_string())
    ))
}

// ═══════════════════════════════════════════════════════════════
// fs 能力口 — 读取（裁决 + 字节执行一体）
// ═══════════════════════════════════════════════════════════════

/// 文本读取（行号格式化可选）。裁决（resolve_read_unchecked）→ 就地字节执行。
pub(crate) async fn read_text_unchecked(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    line_numbers: bool,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<(PathBuf, String), String> {
    let real_path = crate::utils::resolve_read_unchecked(file_path, is_agent, agent_id, state)?;
    let rp = real_path.clone();
    let meta = with_io_retry(|| std::fs::metadata(&rp), "stat")?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大 ({} MiB)，超过读取上限 ({} MiB): {}",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024),
            file_path
        ));
    }
    let content = tokio::time::timeout(READ_TIMEOUT, tokio::task::spawn_blocking(move || {
        with_io_retry(|| std::fs::read_to_string(&rp), "read_to_string")
    }))
    .await
    .map_err(|_| format!("读取文件超时 ({}s): {}", READ_TIMEOUT.as_secs(), file_path))?
    .map_err(|e| format!("读取任务失败: {}", e))?
    .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    let content = if line_numbers {
        format_lines(&content, offset, limit)
    } else {
        content
    };
    Ok((real_path, content))
}

/// 二进制读取（裁决 + 就地执行）。返回字节。
pub(crate) async fn read_bytes_unchecked(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<(PathBuf, Vec<u8>), String> {
    let real_path = crate::utils::resolve_read_unchecked(file_path, is_agent, agent_id, state)?;
    let rp = real_path.clone();
    let meta = with_io_retry(|| std::fs::metadata(&rp), "stat")?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大 ({} MiB)，超过读取上限 ({} MiB): {}",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024),
            file_path
        ));
    }
    let bytes = tokio::time::timeout(READ_TIMEOUT, tokio::task::spawn_blocking(move || {
        with_io_retry(|| std::fs::read(&rp), "read_bytes")
    }))
    .await
    .map_err(|_| format!("读取文件超时 ({}s): {}", READ_TIMEOUT.as_secs(), file_path))?
    .map_err(|e| format!("读取任务失败: {}", e))?
    .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    Ok((real_path, bytes))
}

// ═══════════════════════════════════════════════════════════════
// fs 能力口 — 写入（裁决 + 字节执行一体）
// ═══════════════════════════════════════════════════════════════

/// 原子写文本（tmp → rename；含 .bak 备份）。裁决 → 就地执行。
pub(crate) async fn write_text_unchecked(
    file_path: &str,
    content: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<PathBuf, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "内容过大 ({} MiB)，超过写入上限 ({} MiB)",
            content.len() / (1024 * 1024),
            MAX_WRITE_BYTES / (1024 * 1024)
        ));
    }
    let real_path = crate::utils::resolve_write_unchecked(file_path, is_agent, agent_id, state)?;
    let rp = real_path.to_string_lossy().to_string();
    if let Some(parent) = real_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录: {}", e))?;
    }
    write_atomic(&rp, content)?;
    Ok(real_path)
}

/// 原子写入：tmp → rename（含 .bak 备份与失败恢复）。
fn write_atomic(file_path: &str, content: &str) -> Result<(), String> {
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = format!("{}.tmp.{}", file_path, seq);
    let bak_path = format!("{}.bak", file_path);

    with_io_retry(|| std::fs::write(&tmp_path, content), "write_atomic(tmp)")?;

    let had_original = std::path::Path::new(file_path).exists();
    if had_original {
        let _ = std::fs::remove_file(&bak_path);
        let _ = std::fs::rename(file_path, &bak_path);
    }
    match std::fs::rename(&tmp_path, file_path) {
        Ok(()) => {
            if had_original {
                let _ = std::fs::remove_file(&bak_path);
            }
            Ok(())
        }
        Err(e) => {
            if had_original && std::path::Path::new(&bak_path).exists() {
                let _ = std::fs::rename(&bak_path, file_path);
            }
            Err(format!("write_atomic(rename): {}", e))
        }
    }
}

/// 追加内容到文件（不存在则创建）。log_append 用。
pub(crate) fn append_text_unchecked(real_path: &str, content: &str) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(real_path)
        .map_err(|e| format!("log_append: cannot open {}: {}", real_path, e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("log_append: write failed: {}", e))?;
    Ok(())
}

/// 创建目录（含父目录）。裁决 → 就地执行。
pub(crate) async fn create_dir_unchecked(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<PathBuf, String> {
    let resolved = crate::utils::resolve_write_unchecked(path, is_agent, agent_id, state)?;
    std::fs::create_dir_all(&resolved)
        .map_err(|e| format!("无法创建目录 {}: {}", path, e))?;
    Ok(resolved)
}

/// 删除文件或目录树。裁决 → 就地执行。
pub(crate) async fn delete_unchecked(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
) -> Result<PathBuf, String> {
    let real = crate::utils::resolve_write_unchecked(path, is_agent, agent_id, state)?;
    if !real.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    if real.is_dir() {
        std::fs::remove_dir_all(&real)
            .map_err(|e| format!("无法删除目录 {}: {}", path, e))?;
    } else {
        std::fs::remove_file(&real)
            .map_err(|e| format!("无法删除文件 {}: {}", path, e))?;
    }
    Ok(real)
}

/// 重命名/移动。`from`/`to` 双路径检查（read+write）→ 就地执行。
pub(crate) async fn rename(
    from: &str,
    to: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf), String> {
    let resolved_from = crate::utils::resolve_read_dispatch(from, is_agent, agent_id, state, app).await?;
    let resolved_to = crate::utils::resolve_write_dispatch(to, is_agent, agent_id, state, app).await?;
    let rf = resolved_from.clone();
    let rt = resolved_to.clone();
    with_io_retry(
        || std::fs::rename(&rf, &rt),
        &format!("rename {} -> {}", from, to),
    )?;
    Ok((resolved_from, resolved_to))
}

// ═══════════════════════════════════════════════════════════════
// 目录条目与展示辅助（utils.rs 迁回——字节执行随能力口回 exe）
// ═══════════════════════════════════════════════════════════════

#[derive(serde::Serialize)]
pub(crate) struct DirEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) children: Option<Vec<DirEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) truncated: Option<bool>,
}

/// 递归列出目录内容（深度受限）。filter_ignored 用 hologram-graph 排除规则。
pub(crate) fn list_dir_recursive(root: &std::path::Path, filter_ignored: bool) -> Vec<DirEntry> {
    fn recurse(
        dir: &std::path::Path,
        depth: usize,
        entries: &mut Vec<DirEntry>,
        entry_count: &mut usize,
        truncated: &mut bool,
        filter_ignored: bool,
    ) {
        const MAX_DEPTH: usize = 3;
        const MAX_ENTRIES: usize = 2000;

        if depth > MAX_DEPTH || *entry_count >= MAX_ENTRIES {
            *truncated = true;
            return;
        }
        let readdir = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        for entry in readdir.flatten() {
            if *entry_count >= MAX_ENTRIES {
                *truncated = true;
                break;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = path.is_dir();
            if filter_ignored && is_dir
                && hologram_graph::is_ignored_path(&path.to_string_lossy().replace('\\', "/"))
            {
                continue;
            }
            let children = if is_dir {
                let mut child_entries = Vec::new();
                recurse(&path, depth + 1, &mut child_entries, entry_count, truncated, filter_ignored);
                if child_entries.is_empty() { None } else { Some(child_entries) }
            } else {
                None
            };
            *entry_count += 1;
            entries.push(DirEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                children,
                truncated: None,
            });
        }
    }

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut entry_count = 0usize;
    let mut truncated = false;
    recurse(root, 0, &mut entries, &mut entry_count, &mut truncated, filter_ignored);
    if truncated && !entries.is_empty() {
        entries[0].truncated = Some(true);
    }
    entries
}

/// 平铺列出（只隐藏 VCS 内部目录）。
pub(crate) fn list_dir_flat(root: &std::path::Path) -> Vec<DirEntry> {
    let mut entries: Vec<DirEntry> = Vec::new();
    let skip_dirs: std::collections::HashSet<&str> = [".git", ".hg", ".svn"].iter().cloned().collect();
    let readdir = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return entries,
    };
    for entry in readdir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        if is_dir && skip_dirs.contains(name.as_str()) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children: None,
            truncated: None,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// cat -n 风格行号输出（offset/limit）。
pub(crate) fn format_lines(content: &str, offset: Option<usize>, limit: Option<usize>) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let start = offset.unwrap_or(0).min(lines.len());
    let end = limit
        .map(|l| (start + l).min(lines.len()))
        .unwrap_or(lines.len());
    let numbered: Vec<String> = lines[start..end]
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{:>6}\t{}", start + i + 1, l))
        .collect();
    numbered.join("\n")
}

/// 预览前 max_lines 行，每行截断 max_width。
pub(crate) fn preview(content: &str, max_width: usize, max_lines: usize) -> String {
    content
        .lines()
        .take(max_lines)
        .map(|l| {
            if l.len() <= max_width {
                l.to_string()
            } else {
                let truncated: String = l.chars().take(max_width).collect();
                format!("{}…", truncated)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ═══════════════════════════════════════════════════════════════
// 测试 — 字节层（自 primitives-server fs_ops 测试迁回）
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── glob 花括号展开（字节层随能力口回 exe）──

    #[test]
    fn expand_braces_simple() {
        let result = expand_braces("**/*.{ts,rs}");
        assert_eq!(result, vec!["**/*.ts".to_string(), "**/*.rs".to_string()]);
    }

    #[test]
    fn expand_braces_nested() {
        let result = expand_braces("a/{b,c}/{d,e}");
        assert_eq!(
            result,
            vec!["a/b/d".to_string(), "a/b/e".to_string(), "a/c/d".to_string(), "a/c/e".to_string()]
        );
    }

    #[test]
    fn expand_braces_at_start() {
        let result = expand_braces("{a,b}.ts");
        assert_eq!(result, vec!["a.ts".to_string(), "b.ts".to_string()]);
    }

    // ── 目录列表 ──

    fn make_tree(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("confined_fs_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("sub")).unwrap();
        std::fs::create_dir_all(tmp.join(".git")).unwrap();
        std::fs::write(tmp.join("a.txt"), "a").unwrap();
        std::fs::write(tmp.join("b.txt"), "b").unwrap();
        std::fs::write(tmp.join("sub").join("c.txt"), "c").unwrap();
        std::fs::write(tmp.join(".git").join("config"), "x").unwrap();
        tmp
    }

    #[test]
    fn list_dir_flat_lists_direct_children_only() {
        let tmp = make_tree("flat");
        let entries = list_dir_flat(&tmp);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a.txt"));
        assert!(names.contains(&"sub"));
        assert!(!names.contains(&"c.txt"), "sub/ 内不应出现在平铺层");
        assert!(!names.contains(&".git"), ".git 应被隐藏");
        assert!(entries.iter().all(|e| e.children.is_none()), "平铺无 children");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_dir_recursive_descends_and_filters_ignored() {
        let tmp = make_tree("rec");
        let entries = list_dir_recursive(&tmp, true);
        let flat_names: Vec<String> = {
            fn walk(e: &DirEntry, out: &mut Vec<String>) {
                out.push(e.name.clone());
                if let Some(ch) = &e.children {
                    for c in ch {
                        walk(c, out);
                    }
                }
            }
            let mut v = Vec::new();
            for e in &entries {
                walk(e, &mut v);
            }
            v
        };
        assert!(flat_names.iter().any(|n| n == "a.txt"));
        assert!(flat_names.iter().any(|n| n == "c.txt"), "递归应含 sub/c.txt");
        assert!(!flat_names.iter().any(|n| n == "config"), ".git 应被 is_ignored_path 过滤");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn glob_matches_pattern_and_skips_excluded() {
        let tmp = make_tree("glob");
        let results = glob_entries(&tmp.to_string_lossy(), &["**/*.txt".to_string()]).unwrap();
        assert_eq!(results.len(), 3, "a/b/sub/c 三 txt: {results:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn glob_invalid_pattern_errors() {
        let tmp = make_tree("globerr");
        let err = glob_entries(&tmp.to_string_lossy(), &["[".to_string()]).unwrap_err();
        assert!(err.contains("无效的 glob 模式"), "err = {err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── 展示辅助 ──

    #[test]
    fn format_lines_numbers() {
        assert_eq!(format_lines("aa\nbb\ncc", None, None), "     1\taa\n     2\tbb\n     3\tcc");
        assert_eq!(format_lines("aa\nbb\ncc", Some(1), Some(1)), "     2\tbb");
    }

    #[test]
    fn preview_truncates_and_respects_lines() {
        let p = preview(&"x".repeat(100), 10, 2);
        assert!(p.contains('\u{2026}'), "截断应带省略号: {p}");
    }
}

// ═══════════════════════════════════════════════════════════════
// glob — 字节层（花括号展开 + 目录遍历匹配；自 fs 插件随能力口回迁）
// ═══════════════════════════════════════════════════════════════

#[derive(serde::Serialize, Debug)]
pub(crate) struct GlobEntry {
    pub(crate) path: String,
    pub(crate) name: String,
}

/// 展开 glob 模式中的花括号表达式。
fn expand_braces(pattern: &str) -> Vec<String> {
    if let Some(start) = pattern.find('{') {
        if let Some(end) = pattern[start..].find('}') {
            let end = start + end;
            let prefix = &pattern[..start];
            let suffix = &pattern[end + 1..];
            let alternatives: Vec<&str> = pattern[start + 1..end].split(',').collect();
            let mut result = Vec::new();
            for alt in &alternatives {
                let expanded = format!("{}{}{}", prefix, alt, suffix);
                result.extend(expand_braces(&expanded));
            }
            return result;
        }
    }
    vec![pattern.to_string()]
}

/// 目录遍历 + glob 匹配（root 已裁决）。
pub(crate) fn glob_entries(root: &str, patterns: &[String]) -> Result<Vec<GlobEntry>, String> {
    let p = std::path::Path::new(root);
    if !p.is_dir() {
        return Err(format!("不是有效目录: {}", root));
    }
    let expanded: Vec<String> = patterns.iter().flat_map(|pat| expand_braces(pat)).collect();
    let compiled: Vec<glob::Pattern> = expanded
        .iter()
        .map(|pat| {
            glob::Pattern::new(pat)
                .map_err(|e| format!("无效的 glob 模式 '{}': {}", pat, e))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut results: Vec<GlobEntry> = Vec::new();
    let max = 200;
    for entry in walkdir::WalkDir::new(p)
        .max_depth(12)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let entry_path = entry.path();
        let eps = entry_path.to_string_lossy();
        if eps.contains("/.git/") || eps.contains("\\.git\\")
            || eps.contains("/node_modules/") || eps.contains("\\node_modules\\")
            || eps.contains("/target/") || eps.contains("\\target\\")
            || eps.contains("/dist/") || eps.contains("\\dist\\")
            || eps.contains("/build/") || eps.contains("\\build\\")
            || eps.contains("/.lantai/") || eps.contains("\\.lantai\\")
        {
            continue;
        }
        let rel = entry_path.strip_prefix(p).unwrap_or(entry_path);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if compiled.iter().any(|gp| gp.matches(&rel_str)) {
            results.push(GlobEntry {
                path: entry_path.to_string_lossy().to_string(),
                name: rel
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| rel_str.clone()),
            });
        }
        if results.len() >= max {
            break;
        }
    }
    Ok(results)
}

// ═══════════════════════════════════════════════════════════════
// fs_cap 能力口入口（R3-a，kernel-capability-c3-design.md）——
// 与 *_unchecked 的区别：口内过 resolve_*_dispatch（Agent 过闸 + Ask /
// UI 只解析），因为 fs_cap 直呼不经 PluginToolAdapter（search_cap 同款：
// 能力口入口即裁决）。unchecked 变体保留给 builtin.fs 插件（dispatch
// adapter 已在别处过闸）——R3-b TS 换轨后插件退役，unchecked 随之删。
// ═══════════════════════════════════════════════════════════════

/// fs_cap.read 文本读（能力口入口：dispatch 闸 + 行号格式化）。
pub(crate) async fn read_text_cap(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
    line_numbers: bool,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<(PathBuf, String), String> {
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, agent_id, state, app).await?;
    let rp = real_path.clone();
    let meta = with_io_retry(|| std::fs::metadata(&rp), "stat")?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大 ({} MiB)，超过读取上限 ({} MiB): {}",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024),
            file_path
        ));
    }
    let content = tokio::time::timeout(READ_TIMEOUT, tokio::task::spawn_blocking(move || {
        with_io_retry(|| std::fs::read_to_string(&rp), "read_to_string")
    }))
    .await
    .map_err(|_| format!("读取文件超时 ({}s): {}", READ_TIMEOUT.as_secs(), file_path))?
    .map_err(|e| format!("读取任务失败: {}", e))?
    .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
    let content = if line_numbers {
        format_lines(&content, offset, limit)
    } else {
        content
    };
    Ok((real_path, content))
}

/// fs_cap.write 文本写（能力口入口：dispatch 闸 + 原子写）。返回解析后路径。
pub(crate) async fn write_text_cap(
    file_path: &str,
    content: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "内容过大 ({} MiB)，超过写入上限 ({} MiB)",
            content.len() / (1024 * 1024),
            MAX_WRITE_BYTES / (1024 * 1024)
        ));
    }
    let real_path = crate::utils::resolve_write_dispatch(file_path, is_agent, agent_id, state, app).await?;
    let rp = real_path.to_string_lossy().to_string();
    if let Some(parent) = real_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录: {}", e))?;
    }
    write_atomic(&rp, content)?;
    Ok(real_path)
}

/// fs_cap.list 目录树（能力口入口：dispatch 闸 + list_dir_recursive）。
pub(crate) async fn list_tree_cap(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
    filter_ignored: bool,
) -> Result<Vec<DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(path, is_agent, agent_id, state, app).await?;
    if !root.is_dir() {
        return Err(format!("不是有效目录: {}", path));
    }
    let entries = tokio::task::spawn_blocking(move || list_dir_recursive(&root, filter_ignored))
        .await
        .map_err(|e| format!("目录列表任务失败: {}", e))?;
    Ok(entries)
}

/// fs_cap.delete（能力口入口：dispatch 写闸 + 删）。返回解析后路径。
pub(crate) async fn delete_cap(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    let real = crate::utils::resolve_write_dispatch(path, is_agent, agent_id, state, app).await?;
    if !real.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    let rp = real.clone();
    if real.is_dir() {
        tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&rp))
            .await
            .map_err(|e| format!("删除任务失败: {}", e))?
            .map_err(|e| format!("无法删除目录 {}: {}", path, e))?;
    } else {
        tokio::task::spawn_blocking(move || std::fs::remove_file(&rp))
            .await
            .map_err(|e| format!("删除任务失败: {}", e))?
            .map_err(|e| format!("无法删除文件 {}: {}", path, e))?;
    }
    Ok(real)
}

/// fs_cap.rename（能力口入口：read+write 双 dispatch 闸 + rename）。
pub(crate) async fn rename_cap(
    from: &str,
    to: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf), String> {
    rename(from, to, is_agent, agent_id, state, app).await
}

/// fs_cap.glob（能力口入口：dispatch 读闸解析 root 后 glob_entries）。
pub(crate) async fn glob_cap(
    pattern: &str,
    dir: Option<&str>,
    workspace_root: Option<&str>,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<Vec<GlobEntry>, String> {
    let dir = match dir {
        Some(p) => p.to_string(),
        None => workspace_root
            .map(String::from)
            .ok_or_else(|| "glob: 无目录参数且无工作区根".to_string())?,
    };
    let root = crate::utils::resolve_read_dispatch(&dir, is_agent, agent_id, state, app).await?;
    if !root.is_dir() {
        return Err(format!("不是有效目录: {}", dir));
    }
    let real = root.to_string_lossy().to_string();
    let pat_owned = pattern.to_string();
    let results = tokio::task::spawn_blocking(move || glob_entries(&real, &[pat_owned]))
        .await
        .map_err(|e| format!("glob 任务失败: {}", e))??;
    Ok(results)
}

/// fs_cap 读字节并 base64（媒体渲染消费——8MiB 源上限防 IPC 击穿 WebView2）。
pub(crate) async fn read_base64_cap(
    file_path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<String, String> {
    use base64::Engine;
    let real_path = crate::utils::resolve_read_dispatch(file_path, is_agent, agent_id, state, app).await?;
    let rp = real_path.clone();
    let meta = with_io_retry(|| std::fs::metadata(&rp), "stat")?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大 ({} MiB)，超过读取上限 ({} MiB): {}",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024),
            file_path
        ));
    }
    let bytes = tokio::time::timeout(READ_TIMEOUT, tokio::task::spawn_blocking(move || {
        with_io_retry(|| std::fs::read(&rp), "read_bytes")
    }))
    .await
    .map_err(|_| format!("读取文件超时 ({}s): {}", READ_TIMEOUT.as_secs(), file_path))?
    .map_err(|e| format!("读取任务失败: {}", e))?
    .map_err(|e| format!("无法读取文件 {}: {}", file_path, e))?;
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

/// fs_cap.list_flat 平铺列目录（dispatch 读闸 + list_dir_flat）。
pub(crate) async fn list_flat_cap(
    path: &str,
    is_agent: bool,
    agent_id: Option<&str>,
    state: &tauri::State<'_, WorkspaceState>,
    app: &AppHandle,
) -> Result<Vec<DirEntry>, String> {
    let root = crate::utils::resolve_read_dispatch(path, is_agent, agent_id, state, app).await?;
    if !root.is_dir() {
        return Err(format!("不是有效目录: {}", path));
    }
    let entries = tokio::task::spawn_blocking(move || list_dir_flat(&root))
        .await
        .map_err(|e| format!("目录列表任务失败: {}", e))?;
    Ok(entries)
}

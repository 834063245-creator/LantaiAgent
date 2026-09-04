// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! fs_ops — 已授权物理路径上的纯字节执行（自 src-tauri confined_fs.rs / utils.rs 搬出）。
//!
//! **本模块无权限判断**。调用方（壳 exe）必须已把逻辑路径经 worktree 映射 + 规则
//! 裁决，拿到物理 real_path 再调这里。这里只做 I/O 本身——与 confined_fs 的
//! *_resolved / write_atomic / list_dir_* / format_lines 逐字同行为（错误文案一致，
//! guards 大小/超时/重试一致），迁出时只剥掉 resolve_* 裁决层。

use std::io;
use std::path::PathBuf;
use std::time::Duration;

// ═══════════════════════════════════════════════════════════════
// Guards — 文件大小限制、读取超时、重试预算（confined_fs 原样）
// ═══════════════════════════════════════════════════════════════

/// 读取文件的最大大小 (100 MiB)。
const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;
/// 写入内容的最大大小 (100 MiB)。
const MAX_WRITE_BYTES: usize = 100 * 1024 * 1024;
/// 瞬态 I/O 错误重试次数。
const IO_RETRY_COUNT: u32 = 3;
/// 重试间延迟（翻倍）。
const IO_RETRY_BASE_DELAY: Duration = Duration::from_millis(100);

/// 在瞬态错误时最多重试 IO_RETRY_COUNT 次（confined_fs::with_io_retry 原样）。
pub(crate) fn with_io_retry<T, F>(mut op: F, label: &str) -> Result<T, String>
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
// 读取 — real_path 上的纯字节操作（confined_fs read_*_resolved 原样）
// ═══════════════════════════════════════════════════════════════

/// 文本读取（real_path 已裁决）。返回内容字符串。
pub(crate) fn read_text(real_path: &str) -> Result<String, String> {
    let rp = PathBuf::from(real_path);
    let meta = with_io_retry(|| std::fs::metadata(&rp), "stat")?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大 ({} MiB)，超过读取上限 ({} MiB): {}",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024),
            real_path
        ));
    }
    with_io_retry(|| std::fs::read_to_string(&rp), "read_to_string")
        .map_err(|e| format!("无法读取文件 {}: {}", real_path, e))
}

/// 二进制读取（real_path 已裁决）。返回字节（base64 在壳侧编码——体积守卫也在壳侧）。
pub(crate) fn read_bytes(real_path: &str) -> Result<Vec<u8>, String> {
    let rp = PathBuf::from(real_path);
    let meta = with_io_retry(|| std::fs::metadata(&rp), "stat")?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件过大 ({} MiB)，超过读取上限 ({} MiB): {}",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024),
            real_path
        ));
    }
    with_io_retry(|| std::fs::read(&rp), "read_bytes")
        .map_err(|e| format!("无法读取文件 {}: {}", real_path, e))
}

/// 原子写入（real_path 已裁决）——confined_fs write_text_resolved / utils write_atomic 原样。
pub(crate) fn write_text(real_path: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "内容过大 ({} MiB)，超过写入上限 ({} MiB)",
            content.len() / (1024 * 1024),
            MAX_WRITE_BYTES / (1024 * 1024)
        ));
    }
    if let Some(parent) = PathBuf::from(real_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建目录: {}", e))?;
    }
    write_atomic(real_path, content)
}

/// 原子写入：tmp → rename（utils::write_atomic 原样）。
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

/// 创建目录（含父目录；real_path 已裁决）。
pub(crate) fn create_dir(real_path: &str) -> Result<(), String> {
    std::fs::create_dir_all(real_path)
        .map_err(|e| format!("无法创建目录 {}: {}", real_path, e))
}

/// 删除文件或目录树（real_path 已裁决）。
pub(crate) fn delete(real_path: &str) -> Result<(), String> {
    let real = PathBuf::from(real_path);
    if !real.exists() {
        return Err(format!("路径不存在: {}", real_path));
    }
    if real.is_dir() {
        std::fs::remove_dir_all(&real)
            .map_err(|e| format!("无法删除目录 {}: {}", real_path, e))?;
    } else {
        std::fs::remove_file(&real)
            .map_err(|e| format!("无法删除文件 {}: {}", real_path, e))?;
    }
    Ok(())
}

/// 追加内容到文件（不存在则创建；real_path 已裁决）。log_append 用。
pub(crate) fn append_text(real_path: &str, content: &str) -> Result<(), String> {
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

/// 重命名/移动（from/to 均已由壳裁决；confined_fs::rename 的 I/O 段原样）。
pub(crate) fn rename(from: &str, to: &str) -> Result<(), String> {
    with_io_retry(
        || std::fs::rename(from, to),
        &format!("rename {} -> {}", from, to),
    )
}

// ═══════════════════════════════════════════════════════════════
// 目录条目 — utils.rs DirEntry/GlobEntry 原样（纯数据，无壳依赖）
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

// ═══════════════════════════════════════════════════════════════
// glob — utils GlobEntry + fs 插件 glob 纯执行段（无权限/无 workspace 决议）
// ═══════════════════════════════════════════════════════════════

#[derive(serde::Serialize, Debug)]
pub(crate) struct GlobEntry {
    pub(crate) path: String,
    pub(crate) name: String,
}

/// 展开 glob 模式中的花括号表达式（fs 插件 expand_braces 原样）。
/// "**/*.{ts,rs}" → ["**/*.ts", "**/*.rs"]
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

/// 目录遍历 + glob 匹配（fs 插件 glob 的纯执行段原样；root 已裁决）。
pub(crate) fn glob(root: &str, patterns: &[String]) -> Result<Vec<GlobEntry>, String> {
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

/// 递归列出（utils::list_dir_recursive 原样——hologram-graph is_ignored_path 过滤）。
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

/// 平铺列出（utils::list_dir_flat 原样）。
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

// ═══════════════════════════════════════════════════════════════
// 展示辅助 — confined_fs format_lines/preview 原样（无 I/O）
// ═══════════════════════════════════════════════════════════════

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

#[cfg(test)]
mod tests {
    use super::*;

    // ── glob 花括号展开（自壳 fs 插件随字节层迁入）──

    #[test]
    fn expand_braces_simple() {
        let result = expand_braces("**/*.{ts,rs}");
        assert_eq!(result, vec!["**/*.ts".to_string(), "**/*.rs".to_string()]);
    }

    #[test]
    fn expand_braces_no_brace() {
        let result = expand_braces("**/*.ts");
        assert_eq!(result, vec!["**/*.ts".to_string()]);
    }

    #[test]
    fn expand_braces_many_extensions() {
        let result = expand_braces("**/*.{ts,js,py,rs,html,css,vue,svelte,json,toml,yaml,yml,md}");
        assert_eq!(result.len(), 13);
        assert!(result.contains(&"**/*.ts".to_string()));
        assert!(result.contains(&"**/*.json".to_string()));
        assert!(result.contains(&"**/*.yaml".to_string()));
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

    #[test]
    fn expand_braces_empty_braces() {
        let result = expand_braces("src/{}");
        assert_eq!(result, vec!["src/".to_string()]);
    }

    // ── 目录列表（utils::list_dir_* 迁入的字节层锚定）──

    fn make_tree(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("primitives_fsops_{tag}_{}", std::process::id()));
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
        let results = glob(&tmp.to_string_lossy(), &["**/*.txt".to_string()]).unwrap();
        assert_eq!(results.len(), 3, "a/b/sub/c 三 txt: {results:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn glob_invalid_pattern_errors() {
        let tmp = make_tree("globerr");
        let err = glob(&tmp.to_string_lossy(), &["[".to_string()]).unwrap_err();
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

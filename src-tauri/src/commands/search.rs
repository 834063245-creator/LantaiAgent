// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// glob — 编码 agent 工具。
// search_content 已迁内核插件 builtin.search（tool_plugins/search/，2026-09-03）；
// glob 属 fs 域工具，随 kernel-plugin-runtime Phase 2 fs 批迁移。

/// 展开 glob 模式中的花括号表达式。
/// "**/*.{ts,rs}" → ["**/*.ts", "**/*.rs"]
/// 支持嵌套花括号："a/{b,c}/{d,e}" 可正确展开。
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

#[tauri::command]
pub(crate) async fn glob(
    pattern: String,
    path: Option<String>,
    is_agent: Option<bool>,
    _agent_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // 默认搜索目录 = 当前工作区根（而非应用安装目录 project_root()），理由同 exec_command。
    let dir = match path {
        Some(p) => p,
        None => crate::utils::workspace_path(&state)?,
    };
    let root = crate::utils::resolve_read_dispatch(&dir, is_agent.unwrap_or(false), _agent_id.as_deref(), &state, &app).await?;

    // 展开花括号表达式 ({a,b,c}) — glob crate 不支持它们。
    let expanded = expand_braces(&pattern);
    let glob_patterns: Vec<glob::Pattern> = expanded.iter()
        .map(|p| glob::Pattern::new(p).map_err(|e| format!("无效的 glob 模式 '{}': {}", p, e)))
        .collect::<Result<Vec<_>, _>>()?;
    let pat = pattern.clone();

    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", dir));
        }
        let mut results: Vec<crate::utils::GlobEntry> = Vec::new();
        let max = 200;

        for entry in walkdir::WalkDir::new(&root)
            .max_depth(12)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() { continue; }
            let entry_path = entry.path();
            let eps = entry_path.to_string_lossy();
            if eps.contains("/.git/") || eps.contains("\\.git\\")
                || eps.contains("/node_modules/") || eps.contains("\\node_modules\\")
                || eps.contains("/target/") || eps.contains("\\target\\")
                || eps.contains("/dist/") || eps.contains("\\dist\\")
                || eps.contains("/build/") || eps.contains("\\build\\")
                || eps.contains("/.lantai/") || eps.contains("\\.lantai\\")
            { continue; }

            let rel = entry_path.strip_prefix(&root).unwrap_or(entry_path);
            let rel_str = rel.to_string_lossy().replace('\\', "/");

            if glob_patterns.iter().any(|gp| gp.matches(&rel_str)) {
                results.push(crate::utils::GlobEntry {
                    path: entry_path.to_string_lossy().to_string(),
                    name: rel.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| rel_str.clone()),
                });
            }
            if results.len() >= max { break; }
        }

        Ok(serde_json::json!({
            "pattern": pat,
            "count": results.len(),
            "truncated": results.len() >= max,
            "results": results,
        }).to_string())
    }).await.map_err(|e| format!("glob 任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expand_braces_simple() {
        let result = expand_braces("**/*.{ts,rs}");
        assert_eq!(result, vec!["**/*.ts", "**/*.rs"]);
    }

    #[test]
    fn test_expand_braces_no_brace() {
        let result = expand_braces("**/*.ts");
        assert_eq!(result, vec!["**/*.ts"]);
    }

    #[test]
    fn test_expand_braces_many_extensions() {
        let result = expand_braces("**/*.{ts,js,py,rs,html,css,vue,svelte,json,toml,yaml,yml,md}");
        assert_eq!(result.len(), 13);
        assert!(result.contains(&"**/*.ts".to_string()));
        assert!(result.contains(&"**/*.json".to_string()));
        assert!(result.contains(&"**/*.yaml".to_string()));
    }

    #[test]
    fn test_expand_braces_nested() {
        let result = expand_braces("a/{b,c}/{d,e}");
        assert_eq!(result, vec!["a/b/d", "a/b/e", "a/c/d", "a/c/e"]);
    }

    #[test]
    fn test_expand_braces_single_alternative() {
        let result = expand_braces("src/{x}");
        assert_eq!(result, vec!["src/x"]);
    }

    #[test]
    fn test_expand_braces_empty_braces() {
        let result = expand_braces("src/{}");
        assert_eq!(result, vec!["src/"]);
    }

    #[test]
    fn test_expand_braces_at_start() {
        let result = expand_braces("{a,b}.ts");
        assert_eq!(result, vec!["a.ts", "b.ts"]);
    }
}

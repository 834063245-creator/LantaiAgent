// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! builtin.fs 插件——内核插件运行时 Phase 2 fs 主体（自 commands/filesystem.rs
//! 与 commands/search.rs 的 glob 拆出）。工具面真源 = 同目录 manifest.json。
//!
//! 权限形状：单路径工具声明 `permission {family Read|Edit, path_key}`——工具级
//! 门在 dispatch 侧 PluginToolAdapter，插件内业务走免检解析（resolve_*_unchecked /
//! confined_fs *_unchecked，guards 同款）。rename/move（双路径：read(from)+write(to)）
//! 与 log_append（同步检查——后台日志链不弹窗）保持业务内自检（v1 形态，无 family
//! 声明）；read_memory_batch / get_global_memory_dir 本就无权限检查。
//!
//! 内部工具（read_file_base64 / read_memory_batch / log_append / get_global_memory_dir）
//! 消费方是 renderer-host / memory / 日志内部链——manifest 声明但 TS 不注册进
//! 模型族（manifest 驱动的注册面是白名单式）。

use std::io::Write;

use base64::Engine;
use hologram_graph::is_ignored_path;
use serde_json::Value;

use super::manifest::ToolManifest;
use super::plugin::{ToolContext, ToolError, ToolPlugin};

pub struct FsPlugin {
    manifest: ToolManifest,
}

impl FsPlugin {
    pub fn new() -> Self {
        let manifest: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("builtin.fs manifest 是随 exe 编译的静态资源");
        Self { manifest }
    }
}

impl Default for FsPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlugin for FsPlugin {
    fn id(&self) -> &str {
        "builtin.fs"
    }

    fn manifest(&self) -> &ToolManifest {
        &self.manifest
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a ToolContext<'a>,
        tool_name: &'a str,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, ToolError>> + Send + 'a>,
    > {
        Box::pin(async move {
            match tool_name {
                "list_directory" => list_directory(ctx, &args).await,
                "list_directory_flat" => list_directory_flat(ctx, &args).await,
                "read_file_content" => read_file_content(ctx, &args).await,
                "read_memory_batch" => read_memory_batch(&args),
                "read_file_base64" => read_file_base64(ctx, &args).await,
                "write_file_content" => write_file_content(ctx, &args).await,
                "log_append" => log_append(ctx, &args),
                "create_directory" => create_directory(ctx, &args).await,
                "get_global_memory_dir" => Ok(Value::String(get_global_memory_dir())),
                "delete_file_or_dir" => delete_file_or_dir(ctx, &args).await,
                "rename_file_or_dir" => rename_file_or_dir(ctx, &args).await,
                "move_file" => move_file(ctx, &args).await,
                "glob" => glob(ctx, &args).await,
                other => Err(ToolError::InvalidArgs(format!(
                    "builtin.fs: 未知工具 '{other}'"
                ))),
            }
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// 读侧（业务自 commands/filesystem.rs 原样迁入；参数键 camelCase；
// 解析走免检变体——Read 家族门已在 dispatch 侧过闸）
// ═══════════════════════════════════════════════════════════════

async fn list_directory(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("list_directory: missing '{k}'"));
    let path = super::plugin::arg_str(args, "path").ok_or_else(|| missing("path"))?;
    let filter_ignored = super::plugin::arg_bool(args, "filterIgnored").unwrap_or(true);
    let root = crate::utils::resolve_read_unchecked(&path, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
        .map_err(ToolError::Tool)?;
    let filter = filter_ignored;
    let entries = tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", path));
        }
        Ok(crate::utils::list_dir_recursive(&root, filter))
    })
    .await
    .map_err(|e| ToolError::Tool(format!("目录列表任务失败: {e}")))?
    .map_err(ToolError::Tool)?;
    serde_json::to_value(entries).map_err(|e| ToolError::Tool(format!("序列化失败: {e}")))
}

async fn list_directory_flat(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("list_directory_flat: missing '{k}'"));
    let path = super::plugin::arg_str(args, "path").ok_or_else(|| missing("path"))?;
    let root = crate::utils::resolve_read_unchecked(&path, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
        .map_err(ToolError::Tool)?;
    let entries = tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("不是有效目录: {}", path));
        }
        Ok(crate::utils::list_dir_flat(&root))
    })
    .await
    .map_err(|e| ToolError::Tool(format!("目录列表任务失败: {e}")))?
    .map_err(ToolError::Tool)?;
    serde_json::to_value(entries).map_err(|e| ToolError::Tool(format!("序列化失败: {e}")))
}

/// read_file_content — 文本读（cat -n 行号格式 / raw 原文）。
/// raw 是 IPC 内部参数（P1-3 JSON 读取面）——不在 manifest schema 里声明，
/// args 透传（INVARIANTS #8 修订：manifest 是模型契约不是 IPC 硬边界）。
async fn read_file_content(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("read_file_content: missing '{k}'"));
    let file_path = super::plugin::arg_str(args, "filePath").ok_or_else(|| missing("filePath"))?;
    let offset = super::plugin::arg_usize(args, "offset");
    let limit = super::plugin::arg_usize(args, "limit");
    let (_, content) =
        crate::confined_fs::read_text_unchecked(&file_path, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
            .await
            .map_err(ToolError::Tool)?;
    // P1-3（2026-09-02）：raw=true 跳过 format_lines 行号——JSON 文件读取面
    //（canvas.json / 会话卷 / memory）此前每次读都要「加行号 → 前端剥行号」
    // 双重 O(n) 字符串变换。raw 模式直接返回原文；offset/limit 只对行号模式
    // 有意义（raw 模式忽略——消费方都是全量读）。
    if super::plugin::arg_bool(args, "raw").unwrap_or(false) {
        Ok(Value::String(content))
    } else {
        Ok(Value::String(crate::confined_fs::format_lines(&content, offset, limit)))
    }
}

/// read_memory_batch — .lantai 内多文件批量读（内部工具；业务原样迁入）。
fn read_memory_batch(args: &Value) -> Result<Value, ToolError> {
    let paths: Vec<String> = args
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let mut map = serde_json::Map::new();
    for path in &paths {
        crate::utils::validate_hologram_path(path).map_err(ToolError::InvalidArgs)?;
        match std::fs::read_to_string(path) {
            Ok(content) => {
                map.insert(path.clone(), Value::String(content));
            }
            Err(_) => {
                map.insert(path.clone(), Value::Null);
            }
        }
    }
    serde_json::to_value(map).map_err(|e| ToolError::Tool(format!("序列化失败: {}", e)))
}

/// read_file_base64 — 媒体渲染读（内部工具；业务原样迁入）。
async fn read_file_base64(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("read_file_base64: missing '{k}'"));
    let file_path = super::plugin::arg_str(args, "filePath").ok_or_else(|| missing("filePath"))?;
    let (_, bytes) =
        crate::confined_fs::read_bytes_unchecked(&file_path, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
            .await
            .map_err(ToolError::Tool)?;
    // base64 体积膨胀 4/3：8MiB 源文件 → ~11MB IPC 响应，再大就有击毁 WebView2 的风险
    const MAX_BASE64_SOURCE_BYTES: usize = 8 * 1024 * 1024;
    if bytes.len() > MAX_BASE64_SOURCE_BYTES {
        return Err(ToolError::Tool(format!(
            "文件 {}MiB 超过预览上限 {}MiB——base64 编码后 IPC 传不动",
            bytes.len() / (1024 * 1024),
            MAX_BASE64_SOURCE_BYTES / (1024 * 1024),
        )));
    }
    Ok(Value::String(
        base64::engine::general_purpose::STANDARD.encode(&bytes),
    ))
}

// ═══════════════════════════════════════════════════════════════
// 写侧（Edit 家族门在 dispatch 侧；timeline / changed_files 副作用原样）
// ═══════════════════════════════════════════════════════════════

/// fs 写路径副作用：timeline 记录（fire-and-forget）。
///
/// 锁纪律与 editor 插件 `record_edit_side_effects` 同款：transport 由调用方
/// 在 WorkspaceState 锁内克隆出来，本函数内部**零锁**、引擎调用在 detached
/// 线程——引擎卡死/缺席只丢观测事件，绝不拖住写命令。
fn record_fs_timeline(
    transport: Option<std::sync::Arc<crate::engine_transport::McpRemoteTransport>>,
    event: &str,
    path: &str,
    short: &str,
) {
    let verb = match event {
        "agent_write" => "写入",
        "agent_delete" => "删除",
        "agent_rename" => "重命名",
        "agent_move" => "移动",
        _ => "操作",
    };
    let summary = format!("Agent {}: {}", verb, short);
    crate::utils::record_timeline_transport_detached(transport, event, Some(path), &summary);
}

async fn write_file_content(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("write_file_content: missing '{k}'"));
    let file_path = super::plugin::arg_str(args, "filePath").ok_or_else(|| missing("filePath"))?;
    let content = super::plugin::arg_str(args, "content").ok_or_else(|| missing("content"))?;
    let real_path =
        crate::confined_fs::write_text_unchecked(&file_path, &content, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
            .await
            .map_err(ToolError::Tool)?;
    let rp = real_path.to_string_lossy().to_string();

    if let Some(ref handle) = *crate::utils::lock_or_recover(ctx.state) {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit(['/', '\\']).next().unwrap_or(&rp);
            record_fs_timeline(handle.transport.clone(), "agent_write", &rp, short);
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) {
                    changed.push(rp.clone());
                }
            }
        }
    }

    let size = content.len();
    let preview = crate::confined_fs::preview(&content, 80, 20);
    Ok(Value::String(format!(
        "已写入 {} ({})\n```\n{}\n```",
        rp,
        if size < 1024 { format!("{} B", size) } else { format!("{:.1} KB", size as f64 / 1024.0) },
        preview
    )))
}

/// log_append — 日志追加（内部工具；业务原样迁入——同步权限检查保持：
/// 后台日志链无弹窗可等，Ask 在 ask/auto 模式下同步自动拒绝）。
fn log_append(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("log_append: missing '{k}'"));
    let path = super::plugin::arg_str(args, "path").ok_or_else(|| missing("path"))?;
    let content = super::plugin::arg_str(args, "content").ok_or_else(|| missing("content"))?;
    let perm_ctx = crate::utils::get_ctx(ctx.state).map_err(ToolError::Tool)?;
    let physical = perm_ctx.forward_map_path(std::path::Path::new(&path), ctx.agent_id.as_deref());
    let physical_str = physical.to_string_lossy().to_string();
    let tool = crate::tools::EditTool { path: physical_str.clone(), agent_id: ctx.agent_id.clone() };
    crate::utils::check_permission_sync(&tool, &perm_ctx).map_err(ToolError::Tool)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&physical)
        .map_err(|e| ToolError::Tool(format!("log_append: cannot open {}: {}", path, e)))?;
    file.write_all(content.as_bytes())
        .map_err(|e| ToolError::Tool(format!("log_append: write failed: {}", e)))?;
    Ok(Value::Null)
}

async fn create_directory(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("create_directory: missing '{k}'"));
    let path = super::plugin::arg_str(args, "path").ok_or_else(|| missing("path"))?;
    crate::confined_fs::create_dir_unchecked(&path, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
        .await
        .map_err(ToolError::Tool)?;
    Ok(Value::Null)
}

fn get_global_memory_dir() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    format!("{}/.lantai/global_memory", home.replace("\\", "/"))
}

async fn delete_file_or_dir(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("delete_file_or_dir: missing '{k}'"));
    let path = super::plugin::arg_str(args, "path").ok_or_else(|| missing("path"))?;
    let real = crate::confined_fs::delete_unchecked(&path, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
        .await
        .map_err(ToolError::Tool)?;
    let rp = real.to_string_lossy().replace('\\', "/");
    if let Some(ref handle) = *crate::utils::lock_or_recover(ctx.state) {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit('/').next().unwrap_or(&rp);
            record_fs_timeline(handle.transport.clone(), "agent_delete", &rp, short);
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) {
                    changed.push(rp.clone());
                }
            }
        }
    }
    Ok(Value::Null)
}

/// rename_file_or_dir — 同目录改名（双路径 read(from)+write(to) 检查保留在
/// confined_fs::rename 业务内——无 family 声明，v1 形态；业务原样迁入）。
/// 参数键：模型面 schema 是 path/new_name（TS 历史契约），工具层派发前折写
/// 为 filePath/newName（与旧 RPC 的 bridge camel→snake 转换等价——信封内
/// args 不再被转换，插件直收折写后的 camelCase 键）。
async fn rename_file_or_dir(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("rename_file_or_dir: missing '{k}'"));
    let file_path = super::plugin::arg_str(args, "filePath").ok_or_else(|| missing("filePath"))?;
    let new_name = super::plugin::arg_str(args, "newName").ok_or_else(|| missing("newName"))?;
    let parent = std::path::Path::new(&file_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let to = if parent.is_empty() {
        new_name.clone()
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), new_name.trim_start_matches('/'))
    };
    let (_, resolved_to) = crate::confined_fs::rename(
        &file_path,
        &to,
        ctx.is_agent,
        ctx.agent_id.as_deref(),
        ctx.state,
        ctx.app,
    )
    .await
    .map_err(ToolError::Tool)?;
    let rp = resolved_to.to_string_lossy().replace('\\', "/");
    if let Some(ref handle) = *crate::utils::lock_or_recover(ctx.state) {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit('/').next().unwrap_or(&rp);
            record_fs_timeline(handle.transport.clone(), "agent_rename", &rp, short);
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) {
                    changed.push(rp.clone());
                }
            }
        }
    }
    Ok(Value::Null)
}

/// move_file — 跨目录移动（同 rename_file_or_dir 的双路径形态；业务原样迁入）。
async fn move_file(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("move_file: missing '{k}'"));
    let from = super::plugin::arg_str(args, "from").ok_or_else(|| missing("from"))?;
    let to = super::plugin::arg_str(args, "to").ok_or_else(|| missing("to"))?;
    let (_, resolved_to) = crate::confined_fs::rename(
        &from,
        &to,
        ctx.is_agent,
        ctx.agent_id.as_deref(),
        ctx.state,
        ctx.app,
    )
    .await
    .map_err(ToolError::Tool)?;
    let rp = resolved_to.to_string_lossy().replace('\\', "/");
    if let Some(ref handle) = *crate::utils::lock_or_recover(ctx.state) {
        if !is_ignored_path(&rp) {
            let short = rp.rsplit('/').next().unwrap_or(&rp);
            record_fs_timeline(handle.transport.clone(), "agent_move", &rp, short);
            if let Ok(mut changed) = handle.changed_files.lock() {
                if !changed.contains(&rp) {
                    changed.push(rp.clone());
                }
            }
        }
    }
    Ok(Value::Null)
}

// ═══════════════════════════════════════════════════════════════
// glob（自 commands/search.rs 原样迁入；path 键 camelCase，解析走免检变体）
// ═══════════════════════════════════════════════════════════════

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

async fn glob(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("glob: missing '{k}'"));
    let pattern = super::plugin::arg_str(args, "pattern").ok_or_else(|| missing("pattern"))?;
    let path = super::plugin::arg_str(args, "path");
    // 默认搜索目录 = 当前工作区根（而非应用安装目录 project_root()），理由同 exec_command。
    let dir = match path {
        Some(p) => p,
        None => crate::utils::workspace_path(ctx.state).map_err(ToolError::Tool)?,
    };
    let root = crate::utils::resolve_read_unchecked(&dir, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
        .map_err(ToolError::Tool)?;

    // 展开花括号表达式 ({a,b,c}) — glob crate 不支持它们。
    let expanded = expand_braces(&pattern);
    let glob_patterns: Vec<glob::Pattern> = expanded.iter()
        .map(|p| glob::Pattern::new(p).map_err(|e| ToolError::InvalidArgs(format!("无效的 glob 模式 '{}': {}", p, e))))
        .collect::<Result<Vec<_>, _>>()?;
    let pat = pattern.clone();

    let out = tokio::task::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| ToolError::Tool(format!("glob 任务失败: {e}")))?
    .map_err(ToolError::Tool)?;
    Ok(Value::String(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        let m: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.fs");
        assert_eq!(m.trust, super::super::manifest::TrustLevel::System);
        assert_eq!(m.tools.len(), 13);
        // 模型面工具的权限声明形状：单路径工具带 family；双路径/内部自检工具不带。
        let read = m.tools.iter().find(|t| t.name == "read_file_content").expect("read_file_content 在清单内");
        assert!(read.read_only);
        assert_eq!(read.permission.as_ref().expect("read 声明 permission").family, "Read");
        let write = m.tools.iter().find(|t| t.name == "write_file_content").expect("write_file_content 在清单内");
        assert!(!write.read_only);
        assert_eq!(write.permission.as_ref().expect("write 声明 permission").family, "Edit");
        for name in ["rename_file_or_dir", "move_file", "log_append", "read_memory_batch", "get_global_memory_dir"] {
            let t = m.tools.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("{name} 在清单内"));
            assert!(t.permission.is_none(), "{name} 应无权限声明（业务自检/无检查形态）");
        }
    }

    #[test]
    fn test_expand_braces_simple() {
        let result = expand_braces("**/*.{ts,rs}");
        assert_eq!(result, vec!["**/*.ts".to_string(), "**/*.rs".to_string()]);
    }

    #[test]
    fn test_expand_braces_no_brace() {
        let result = expand_braces("**/*.ts");
        assert_eq!(result, vec!["**/*.ts".to_string()]);
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
        assert_eq!(result, vec!["a/b/d".to_string(), "a/b/e".to_string(), "a/c/d".to_string(), "a/c/e".to_string()]);
    }

    #[test]
    fn test_expand_braces_single_alternative() {
        let result = expand_braces("src/{x}");
        assert_eq!(result, vec!["src/x".to_string()]);
    }

    #[test]
    fn test_expand_braces_empty_braces() {
        let result = expand_braces("src/{}");
        assert_eq!(result, vec!["src/".to_string()]);
    }

    #[test]
    fn test_expand_braces_at_start() {
        let result = expand_braces("{a,b}.ts");
        assert_eq!(result, vec!["a.ts".to_string(), "b.ts".to_string()]);
    }
}

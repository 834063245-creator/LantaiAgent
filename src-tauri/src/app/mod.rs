// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 应用层（L1 数据上下文抽象）—— 壳内新生的业务与数据归属层。
//!
//! [`WorkspaceDataContext`] 按工作区实例化：**壳对引擎零内置接线**
//! （图谱全量退役 2026-09-09，commit 51047f99——`engine_transport.rs` 连同
//! 「每工作区 spawn 引擎」的传输层整批删除，壳内零 spawn 引擎的代码）。壳对
//! 引擎的全部知识 = 二进制在磁盘上的位置（`engine_assets.rs` 的只读探测）+
//! MCP 协议；零 hologram-* crate 依赖。
//!
//! 引擎消费现状（engine-bundled-mcp-distribution，2026-09-16）：
//! 引擎**随安装包分发**（`tauri.conf.json` bundle.resources，实测 196MB），
//! 接线在**前端** `src-ui/src/plugins/bundled-engine.ts`——用户启用后按工作区
//! 经既有 MCP 受治进程通道拉起（治理/生命周期/回收全在 TS 侧 `mcp-bridge.ts`）。
//! 本模块只提供「二进制在哪」的探测（`engine_assets`），不参与拉起。
//!
//! 工作区 = 容器（workspace-session-ownership-rework 2026-08-27）：
//! 会话物理归属工作区，会话只在所属工作区内打开——因此**不再需要**会话
//! 绑定表与焦点投影。
//!
//! 设计参照 DSH 五条铁律（docs/archive/layering-rework-plan.md §4 L1）：
//! 1. 会话是第一公民（按区归属）；
//! 2. 工作区 = 注册表容器（canonical 路径为键）+ 目录实体；
//! 3. 归属 = 存储结构（`{ws}/.lantai/sessions/`），不是元数据标签；
//! 4. 引擎上下文按需 ensure（幂等复用）；
//! 5. 运行时锚点 = 活动工作区（单槽），会话是其内的作用域。
//!
//! 线程/锁纪律：std::sync 锁 + `unwrap_or_else(|e| e.into_inner())` 中毒
//! 恢复（壳层惯例，见 CONVENTIONS）；本层保持同步纯逻辑，阻塞的引擎
//! RPC（transport .call）由命令层包 spawn_blocking。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

pub(crate) mod commands;
pub(crate) mod services;

/// 锁中毒恢复（std RwLock 惯例）。
fn read_or_recover<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|e| e.into_inner())
}
fn write_or_recover<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|e| e.into_inner())
}

// ═══════════════════════════════════════════════════════════════
// 路径归一
// ═══════════════════════════════════════════════════════════════

/// canonical 化工作区根：必须存在且是目录；去除 Windows verbatim 前缀
/// （`\\?\C:\...` → `C:\...`、`\\?\UNC\srv\share` → `\\srv\share`）。
/// 不存在 / 非目录 → None（绑定校验的「目录在」判据）。
pub(crate) fn canonical_root(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return None;
    }
    let p = Path::new(trimmed);
    if !p.is_dir() {
        return None;
    }
    let canon = std::fs::canonicalize(p).ok()?;
    Some(strip_verbatim(&canon))
}

/// 去 Windows verbatim 前缀（canonicalize 副作用），键比较与展示两用。
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    p.to_path_buf()
}

/// 展示形（正斜杠，前端/卷快照同形）。
pub(crate) fn display_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

// ═══════════════════════════════════════════════════════════════
// 数据上下文
// ═══════════════════════════════════════════════════════════════

/// 按工作区实例化的数据上下文。引擎-宿主逻辑全断（2026-09-08）后：
/// 引擎数据所有权（hologram.db/FTS5/快照/向量/基线）完全归引擎进程与其
/// 自有的 `.hologram/` 目录。图谱全量退役（2026-09-09）后壳不再拉起/持有
/// 引擎进程——本结构只剩 canonical 根（注册表锚点）。
pub(crate) struct WorkspaceDataContext {
    /// canonical 工作区根（注册表键）。
    pub root: PathBuf,
    pub created_at_ms: u64,
}

// ═══════════════════════════════════════════════════════════════
// 注册表（Tauri managed state：Arc<AppContexts>）
// ═══════════════════════════════════════════════════════════════

pub struct AppContexts {
    /// canonical root → context。
    contexts: RwLock<HashMap<PathBuf, Arc<WorkspaceDataContext>>>,
}

impl Default for AppContexts {
    fn default() -> Self {
        Self::new()
    }
}

impl AppContexts {
    pub fn new() -> Self {
        Self {
            contexts: RwLock::new(HashMap::new()),
        }
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// 确保工作区上下文存在（幂等——同根复用同一实例）。纯注册表操作，
    /// 不触碰引擎数据（图谱退役后本结构只持根路径）。
    pub(crate) fn ensure_context(&self, root: &str) -> Result<Arc<WorkspaceDataContext>, String> {
        let canon = canonical_root(root)
            .ok_or_else(|| format!("工作区目录不存在或不可访问: {}", root.trim()))?;
        if let Some(ctx) = read_or_recover(&self.contexts).get(&canon) {
            return Ok(ctx.clone());
        }
        let mut guard = write_or_recover(&self.contexts);
        // 双检：等写锁期间他人可能已建
        if let Some(ctx) = guard.get(&canon) {
            return Ok(ctx.clone());
        }
        let ctx = Arc::new(WorkspaceDataContext {
            root: canon.clone(),
            created_at_ms: Self::now_ms(),
        });
        guard.insert(canon, ctx.clone());
        Ok(ctx)
    }

    /// 上下文空闲判定回收：非活动工作区（不在保留集）→ 移除出注册表。
    /// 保留集由命令层传入（单槽活动根）。
    /// 归零：会话绑定判定已退役——上下文只跟「活动工作区」走。
    pub(crate) fn gc_if_unused(&self, root: &Path, keep_roots: &[PathBuf]) {
        let kept = keep_roots.iter().any(|k| k == root);
        if kept {
            return;
        }
        write_or_recover(&self.contexts).remove(root);
    }

    /// 上下文清单（诊断 / 守护测试）。
    pub(crate) fn list_contexts(&self) -> Vec<ContextInfo> {
        read_or_recover(&self.contexts)
            .values()
            .map(|c| ContextInfo {
                workspace: display_path(&c.root),
                created_at_ms: c.created_at_ms,
                ready: true,
            })
            .collect()
    }

    /// 上下文数（测试）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn context_count(&self) -> usize {
        read_or_recover(&self.contexts).len()
    }
}

/// 上下文摘要（context_list 回包）。
#[derive(serde::Serialize)]
pub struct ContextInfo {
    pub workspace: String,
    pub created_at_ms: u64,
    pub ready: bool,
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    /// 双工作区并行：各持各的数据上下文，互不串扰（L1 验收判据的注册
    /// 表面）。（图谱退役后上下文只持根路径——进程级隔离已无壳侧面。）
    #[test]
    fn two_workspaces_get_distinct_contexts() {
        let ws_a = temp_dir("lantai_ctx_par_a");
        let ws_b = temp_dir("lantai_ctx_par_b");
        let app = AppContexts::new();

        let ctx_a1 = app.ensure_context(&display_path(&ws_a)).unwrap();
        let ctx_a2 = app.ensure_context(&display_path(&ws_a)).unwrap();
        let ctx_b = app.ensure_context(&display_path(&ws_b)).unwrap();

        assert!(Arc::ptr_eq(&ctx_a1, &ctx_a2), "同根幂等复用");
        assert!(!Arc::ptr_eq(&ctx_a1, &ctx_b), "异根各持实例");
        assert_ne!(ctx_a1.root, ctx_b.root);
        assert_eq!(app.context_count(), 2);

        let _ = std::fs::remove_dir_all(&ws_a);
        let _ = std::fs::remove_dir_all(&ws_b);
    }

    /// GC：非保留根回收；保留根不回收。
    #[test]
    fn gc_if_unused_honors_keep_roots() {
        let ws = temp_dir("lantai_ctx_gc");
        let app = AppContexts::new();
        app.ensure_context(&display_path(&ws)).unwrap();
        assert_eq!(app.context_count(), 1);

        // 保留集包含该根 → 不回收
        app.gc_if_unused(&ws, &[ws.clone()]);
        assert_eq!(app.context_count(), 1, "保留根不回收");

        // 无保留 → 回收
        app.gc_if_unused(&ws, &[]);
        assert_eq!(app.context_count(), 0, "空闲上下文应回收");
    }

    /// L4 守卫：壳层对 engine 全局函数的直连点必须**为零**——Phase 3 摘除
    /// hologram-engine 依赖后壳内已无全局引擎（hologram_call 必须有工作区，
    /// 经 transport），新增直连即红。
    #[test]
    fn engine_global_direct_calls_are_whitelisted() {
        // 扫描模式：全局 engine_ 函数的直连调用形态（含 engine_api 前缀），即
        // 「:: 函数名 (」连续序列；本注释刻意断开书写避免自匹配。
        // 拼接构造避免本测试文件自匹配（模式串不出现连续的 "::engine_read" 字面）。
        let fns = [
            "engine_" , "read", "|engine_write", "|engine_init",
            "|engine_state", "|with_engine", "|engine_record_timeline",
            "|engine_record_timeline_with_props", "|engine_save", "|engine_analyze",
            "|engine_try_incremental", "|engine_fts_search", "|engine_query_timeline",
            "|engine_graph_generated_at",
        ].concat();
        let pattern = format!("::({fns})\\s*\\(");
        let re = regex_lite(&pattern);

        // 白名单：Phase 3 后为空——壳内不允许任何 engine 全局直连
        let whitelist: &[(&str, &[&str])] = &[];

        let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut violations: Vec<String> = Vec::new();
        let mut hits: Vec<(String, String)> = Vec::new();
        for entry in walkdir::WalkDir::new(&src_dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "rs"))
        {
            let rel = entry
                .path()
                .strip_prefix(&src_dir)
                .unwrap()
                .to_string_lossy()
                .replace('/', r"\");
            let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
            for (_pos, fname) in re.captures_iter(&content) {
                hits.push((rel.clone(), fname.clone()));
                let allowed = whitelist
                    .iter()
                    .find(|(f, _)| *f == rel)
                    .map(|(_, fns)| fns.contains(&fname.as_str()))
                    .unwrap_or(false);
                if !allowed {
                    violations.push(format!("{rel} :: {}", fname));
                }
            }
        }
        assert!(
            violations.is_empty(),
            "壳层出现未白名单的 engine 全局直连（应走 app::services 决议链/实例方法）: {violations:?}"
        );
        // 白名单条目必须真实存在（防腐烂）
        for (file, fns) in whitelist {
            for f in *fns {
                assert!(
                    hits.iter().any(|(rf, rfn)| rf == *file && rfn == *f),
                    "白名单条目未命中（已过期？）: {file} :: {f}"
                );
            }
        }
    }

    /// 逻辑全断守卫（engine-host-severance 2026-09-08）：壳内不得存在任何
    /// 引擎族 crate 直连——源代码 `hologram_` 前缀 crate 路径引用与
    /// Cargo.toml 的 hologram-* 依赖条目双双为零。壳对引擎的全部知识 =
    /// 二进制位置探测（engine_assets.rs）+ MCP 协议（接线在前端 TS 侧）；
    /// 文件忽略语义壳内自有一份（ignored_paths.rs）。新增直连即红。
    /// 本测试文件自身写着这些字面量（断言消息），跳过防自匹配。
    #[test]
    fn shell_has_zero_hologram_crate_refs() {
        let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut violations: Vec<String> = Vec::new();
        for entry in walkdir::WalkDir::new(&src_dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "rs"))
        {
            let rel = entry
                .path()
                .strip_prefix(&src_dir)
                .unwrap()
                .to_string_lossy()
                .to_string();
            if rel.replace('\\', "/").starts_with("app/mod.rs") {
                continue;
            }
            let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
            for bad in [
                "hologram_graph::",
                "hologram_storage::",
                "hologram_vector::",
                "hologram_engine::",
            ] {
                if content.contains(bad) {
                    violations.push(format!("{rel} 含 {bad} —— 壳禁直连引擎族 crate（引擎=进程外 MCP，接线在前端 TS 侧）"));
                }
            }
        }
        // Cargo.toml 依赖条目必须为零（跳过注释行）
        let manifest = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"),
        )
        .unwrap_or_default();
        for line in manifest.lines() {
            let t = line.trim();
            if !t.starts_with('#') && t.starts_with("hologram-") {
                violations.push(format!("Cargo.toml 依赖条目未摘除: {t}"));
            }
        }
        assert!(
            violations.is_empty(),
            "壳层存在引擎族 crate 直连（引擎知识面必须收敛为二进制 + MCP 协议）: {violations:?}"
        );
    }
}

/// 极简正则（守卫测试专用）：只支持 `::name(` 交替字面量形态，
/// 无第三方 regex 依赖（src-tauri 无 regex crate——守卫测试不得引入新依赖）。
#[cfg(test)]
fn regex_lite(pattern: &str) -> LiteRe {
    // pattern 形如 "::(a|b|c)\s*\(" → 提取交替名集合
    let names: Vec<String> = pattern
        .trim_start_matches("::(")
        .trim_end_matches(r"\s*\(")
        .split('|')
        .map(|s| s.to_string())
        .collect();
    LiteRe { names }
}

#[cfg(test)]
struct LiteRe {
    names: Vec<String>,
}

#[cfg(test)]
impl LiteRe {
    fn captures_iter<'a>(&self, text: &'a str) -> Vec<(usize, String)> {
        let mut out = Vec::new();
        for name in &self.names {
            let needle = format!("::{name}(");
            let mut start = 0;
            while let Some(pos) = text[start..].find(&needle) {
                out.push((start + pos, name.clone()));
                start += pos + needle.len();
            }
        }
        out.sort_by_key(|(pos, _)| *pos);
        out
    }
}

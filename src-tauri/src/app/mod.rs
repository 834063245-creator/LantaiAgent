// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 应用层（L1 数据上下文抽象）—— 壳内新生的业务与数据归属层。
//!
//! [`WorkspaceDataContext`] 按工作区实例化：每个工作区一个专属引擎实例
//! （图库 / 索引 / 时间线连接 / watcher 全在该实例内部）。
//! 工作区 = 容器（workspace-session-ownership-rework 2026-08-27）：
//! 会话物理归属工作区，会话只在所属工作区内打开——因此**不再需要**会话
//! 绑定表与焦点投影；引擎决议只看「显式 root → 活动工作区（单槽
//! WorkspaceState）→ None」两条臂。
//!
//! 设计参照 DSH 五条铁律（docs/plans/layering-rework-plan.md §4 L1）：
//! 1. 会话是第一公民（按区归属）；
//! 2. 工作区 = 注册表容器（canonical 路径为键）+ 目录实体；
//! 3. 归属 = 存储结构（`{ws}/.lantai/sessions/`），不是元数据标签；
//! 4. 引擎上下文按需 ensure（幂等复用）；
//! 5. 运行时锚点 = 活动工作区（单槽），会话是其内的作用域。
//!
//! 线程/锁纪律：std::sync 锁 + `unwrap_or_else(|e| e.into_inner())` 中毒
//! 恢复（壳层惯例，见 CONVENTIONS）；所有会阻塞的引擎操作（Engine init
//! 开 SQLite）由命令层包 spawn_blocking，本层保持同步纯逻辑。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

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

/// 按工作区实例化的数据上下文。显式持**数据宿主共享句柄**——
/// 图库（hologram.db/FTS5/快照）与 timeline 连接的归属单元在
/// [`hologram_storage::StoreHost`]（L2 crate 化：engine/src/storage 物理拆出
/// 为独立 crate）。Phase 3（engine-plugin-extraction）起宿主自开 StoreHost
/// （`StoreHost::open`，与引擎进程同库并发，SQLite 侧已并发安全）——
/// 计算与访问的执行方是引擎子进程（经 `remote` transport）。
pub(crate) struct WorkspaceDataContext {
    /// canonical 工作区根（注册表键）。
    pub root: PathBuf,
    /// 进程外传输（每工作区一个引擎子进程的 stdio MCP 通道；惰性构造，
    /// 经 resolve_transport 取用）。
    pub(crate) remote: std::sync::Mutex<Option<std::sync::Arc<crate::engine_transport::McpRemoteTransport>>>,
    /// 数据宿主共享句柄（L2 存储外置；Phase 3 起宿主自开，与引擎进程
    /// 同库并发）。
    /// ponytail: 生产面暂无直接消费（L3 业务归位时接入），e2e 测试直查
    /// ——dead_code 豁免。
    #[allow(dead_code)]
    pub(crate) store_host: Arc<Mutex<hologram_storage::StoreHost>>,
    pub created_at_ms: u64,
}

impl WorkspaceDataContext {
    /// 优雅停机：进程外形态下随上下文回收关停引擎子进程（惰性 spawn 的
    /// 对称清理）。GC 释放上下文前调用；幂等。
    pub(crate) fn shutdown(&self) {
        if let Ok(mut guard) = self.remote.lock() {
            if let Some(t) = guard.take() {
                t.shutdown();
            }
        }
    }
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

    /// 确保工作区上下文存在（幂等——同根复用同一实例）。
    /// ⚠ 会开 SQLite（阻塞 IO）——命令层须包 spawn_blocking。
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
        // Phase 3：数据宿主自开（与引擎进程同库并发，SQLite 侧已并发安全）。
        let store_host = hologram_storage::StoreHost::open(&canon)
            .map_err(|e| format!("工作区数据宿主初始化失败 {}: {}", display_path(&canon), e))?;
        let ctx = Arc::new(WorkspaceDataContext {
            root: canon.clone(),
            store_host: Arc::new(Mutex::new(store_host)),
            remote: std::sync::Mutex::new(None),
            created_at_ms: Self::now_ms(),
        });
        guard.insert(canon, ctx.clone());
        Ok(ctx)
    }

    /// 工作区传输句柄（具体型，供 WorkspaceHandle pump / timeline 记录等
    /// 长生命周期消费方持有）。ensure_context + 惰性构造 McpRemoteTransport。
    pub(crate) fn transport_of(
        &self,
        root: &str,
    ) -> Result<Arc<crate::engine_transport::McpRemoteTransport>, String> {
        let ctx = self.ensure_context(root)?;
        let mut guard = crate::utils::lock_or_recover(&ctx.remote);
        if guard.is_none() {
            *guard = Some(std::sync::Arc::new(
                crate::engine_transport::McpRemoteTransport::new(&ctx.root.to_string_lossy()),
            ));
        }
        Ok(guard.clone().expect("just set"))
    }

    /// 传输解析（命令层入口）：与旧 resolve_engine 同决议链（显式 → 活动
    /// 单槽），产出每工作区引擎进程的 stdio MCP 通道。调用方 spawn_blocking
    /// 后 .call(method, args)。
    pub(crate) fn resolve_transport(
        &self,
        explicit_root: Option<&str>,
        fallback_root: Option<&str>,
    ) -> Result<(std::sync::Arc<crate::engine_transport::McpRemoteTransport>, PathBuf), String> {
        let root = explicit_root
            .or(fallback_root)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "未打开工作区，请先打开项目".to_string())?;
        let ctx = self.ensure_context(root)?;
        let transport = self.transport_of(&ctx.root.to_string_lossy())?;
        Ok((transport, ctx.root.clone()))
    }

    /// 上下文空闲判定回收：非活动工作区（不在保留集）→ 停 watcher + 移除
    /// （Arc 落 Drop 关库连接）。保留集由命令层传入（单槽活动根）。
    /// 归零：会话绑定判定已退役——引擎上下文只跟「活动工作区」走。
    pub(crate) fn gc_if_unused(&self, root: &Path, keep_roots: &[PathBuf]) {
        let kept = keep_roots.iter().any(|k| k == root);
        if kept {
            return;
        }
        if let Some(ctx) = write_or_recover(&self.contexts).remove(root) {
            ctx.shutdown();
        }
    }

    /// 上下文清单（诊断 / 守护测试）。
    pub(crate) fn list_contexts(&self) -> Vec<ContextInfo> {
        read_or_recover(&self.contexts)
            .values()
            .map(|c| ContextInfo {
                workspace: display_path(&c.root),
                created_at_ms: c.created_at_ms,
                ready: c
                    .store_host
                    .lock()
                    .map(|host| host.store.read(|idx| idx.node_count()) > 0)
                    .unwrap_or(false),
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

    /// 双工作区并行：各持各的数据上下文与 StoreHost，互不串写（L1 验收
    /// 判据的存储面）。引擎进程级隔离由 tests/engine_process_e2e.rs 覆盖
    ///（Phase 3 起引擎在子进程，单元测试不 spawn）。
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
        assert!(!Arc::ptr_eq(&ctx_a1.store_host, &ctx_b.store_host), "各持数据宿主");
        assert_eq!(app.context_count(), 2);

        // 各自写入只落各自宿主
        use hologram_graph::{Node, NodeKind};
        let _ = ctx_a1
            .store_host
            .lock()
            .unwrap()
            .store
            .write(|idx| idx.insert_node(Node::new("a_node", "A", NodeKind::Function)));
        let _ = ctx_b
            .store_host
            .lock()
            .unwrap()
            .store
            .write(|idx| idx.insert_node(Node::new("b_node", "B", NodeKind::Function)));
        assert_eq!(
            ctx_a1.store_host.lock().unwrap().store.read(|i| i.node_count()),
            1
        );
        assert_eq!(
            ctx_b.store_host.lock().unwrap().store.read(|i| i.node_count()),
            1
        );
        assert!(
            ctx_a1
                .store_host
                .lock()
                .unwrap()
                .store
                .read(|i| i.get_node("b_node").is_none())
        );

        let _ = std::fs::remove_dir_all(&ws_a);
        let _ = std::fs::remove_dir_all(&ws_b);
    }

    /// 决议链（workspace-session-ownership-rework 后两条臂）：上下文级。
    /// resolve_transport 的进程 spawn 面由 tests/engine_process_e2e.rs 覆盖。
    #[test]
    fn resolve_transport_rejects_empty_roots() {
        let app = AppContexts::new();
        // 显式与回退全空/全无效 → 显式报错（「未打开工作区」）
        let err = app.resolve_transport(Some(""), Some("")).unwrap_err();
        assert!(err.contains("未打开工作区"), "{err}");
        let err = app.resolve_transport(Some("Z:/definitely/not/here"), None).unwrap_err();
        assert!(err.contains("工作区目录不存在"), "{err}");
        // 全 None 同理
        assert!(app.resolve_transport(None, None).is_err());
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

    /// L2 crate 化守卫：storage/vector 类型引用必须直连独立 crate
    /// （`hologram_storage::` / `hologram_vector::`），不得再经
    /// `hologram_engine::storage::` / `hologram_engine::vector::`
    /// 路径引用——engine 的 storage/vector 门面已拆除，
    /// 新代码不得恢复门面消费面（layering-rework-plan §4.3 欠账项 1 验收钉）。
    #[test]
    fn shell_storage_vector_refs_use_dedicated_crates() {
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
            // 本守卫测试自身写着这些字面量（注释/断言消息），跳过防自匹配。
            if rel.replace('\\', "/").starts_with("app/mod.rs") {
                continue;
            }
            let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
            for bad in [
                "hologram_engine::storage::",
                "hologram_engine::vector::",
                "engine::storage::",
                "engine::vector::",
            ] {
                if content.contains(bad) {
                    violations.push(format!("{rel} 含 {bad} —— 应直连 hologram_storage/hologram_vector crate"));
                }
            }
        }
        assert!(
            violations.is_empty(),
            "壳层存在经 engine 门面引用存储/向量类型的代码（应直连独立 crate）: {violations:?}"
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

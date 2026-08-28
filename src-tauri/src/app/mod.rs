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

use hologram_engine::engine::{Engine, engine_bind_global_shared};

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
/// 为独立 crate），宿主（本上下文）创建并注入 Engine；应用层可直接经
/// `store_host` 持久化/检查库，Engine 是计算与访问的执行方。
pub(crate) struct WorkspaceDataContext {
    /// canonical 工作区根（注册表键）。
    pub root: PathBuf,
    /// 该工作区专属引擎实例。
    pub engine: Arc<Engine>,
    /// 进程外传输（Phase 2：惰性构造，`HOLOGRAM_ENGINE_TRANSPORT=mcp` 时
    /// 经 resolve_transport 取用；Phase 3 翻默认后成为主路径）。
    pub(crate) remote: std::sync::Mutex<Option<std::sync::Arc<crate::engine_transport::McpRemoteTransport>>>,
    /// 数据宿主共享句柄（L2 存储外置）——与 Engine 内部持同一 Arc。
    /// L2 crate 化后物理来源为 hologram-storage crate（经 engine 门面再导出）。
    /// ponytail: 生产面暂无直接消费（L3 业务归位时接入），e2e 测试直查
    /// （analyze_persist_query_loop_via_context）——dead_code 豁免。
    #[allow(dead_code)]
    pub(crate) store_host: Arc<Mutex<hologram_storage::StoreHost>>,
    pub created_at_ms: u64,
}

impl WorkspaceDataContext {
    /// 优雅停机：停 watcher（增量线程）后由 Drop 关库连接。
    /// GC 释放上下文前调用；幂等。
    pub(crate) fn shutdown(&self) {
        self.engine.stop_watcher();
        // 进程外形态：随上下文回收关停引擎子进程（惰性 spawn 的对称清理）。
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

    /// 确保工作区上下文存在（幂等——同根复用同一实例）；创建后同步全局槽
    /// 指向同一 Arc（hologram_call 等无解析信息的调用回退到全局时，
    /// 与上下文见到的永远是同一实例，杜绝同根双实例漂移）。
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
        let engine = Engine::new_shared(&canon)
            .map_err(|e| format!("工作区引擎初始化失败 {}: {}", display_path(&canon), e))?;
        let ctx = Arc::new(WorkspaceDataContext {
            root: canon.clone(),
            store_host: engine.store_host().clone(),
            engine: engine.clone(),
            remote: std::sync::Mutex::new(None),
            created_at_ms: Self::now_ms(),
        });
        guard.insert(canon, ctx.clone());
        drop(guard);
        engine_bind_global_shared(engine);
        Ok(ctx)
    }

    /// 传输解析（Phase 2 接缝）：与 resolve_engine 同决议链（显式 → 活动单槽），
    /// 按传输模式产出 InProcess（内嵌直调，缺省）或 McpRemote（每工作区一个
    /// 引擎进程，惰性 spawn）。调用方 spawn_blocking 后 .call(method, args)。
    pub(crate) fn resolve_transport(
        &self,
        explicit_root: Option<&str>,
        fallback_root: Option<&str>,
    ) -> Result<(std::sync::Arc<dyn crate::engine_transport::EngineTransport>, PathBuf), String> {
        match crate::engine_transport::transport_mode() {
            crate::engine_transport::TransportMode::InProcess => {
                let engine = self
                    .resolve_engine(explicit_root, fallback_root)
                    .ok_or_else(|| "未打开工作区，请先打开项目".to_string())?;
                let root = engine.project_root();
                Ok((std::sync::Arc::new(crate::engine_transport::InProcessTransport::new(engine)), root))
            }
            crate::engine_transport::TransportMode::Mcp => {
                let root = explicit_root
                    .or(fallback_root)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "未打开工作区，请先打开项目".to_string())?;
                let ctx = self.ensure_context(root)?;
                let mut guard = crate::utils::lock_or_recover(&ctx.remote);
                if guard.is_none() {
                    *guard = Some(std::sync::Arc::new(
                        crate::engine_transport::McpRemoteTransport::new(&ctx.root.to_string_lossy()),
                    ));
                }
                let t = guard.clone().expect("just set");
                Ok((t, ctx.root.clone()))
            }
        }
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
                ready: c.engine.is_ready(),
            })
            .collect()
    }

    /// 上下文数（测试）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn context_count(&self) -> usize {
        read_or_recover(&self.contexts).len()
    }

    /// 解析链核心：显式 root → 活动工作区（单槽回退）。全部未命中 → None
    /// （调用方回落全局引擎——MCP 时代语义）。
    /// ⚠ ensure 语义（miss 即建）对两条臂都生效：显式 root 是命令指名，
    /// 回退 root 是活动工作区（激活时上下文已存在，ensure 幂等无副作用）。
    pub(crate) fn resolve_engine(
        &self,
        explicit_root: Option<&str>,
        fallback_root: Option<&str>,
    ) -> Option<Arc<Engine>> {
        if let Some(root) = explicit_root.map(str::trim).filter(|s| !s.is_empty()) {
            return self.ensure_context(root).ok().map(|c| c.engine.clone());
        }
        if let Some(root) = fallback_root.map(str::trim).filter(|s| !s.is_empty()) {
            return self.ensure_context(root).ok().map(|c| c.engine.clone());
        }
        None
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

    /// 双工作区并行：各持各的引擎实例，互不串写（L1 验收判据）。
    #[test]
    fn two_workspaces_get_distinct_engines() {
        let ws_a = temp_dir("lantai_ctx_par_a");
        let ws_b = temp_dir("lantai_ctx_par_b");
        let app = AppContexts::new();

        let ctx_a1 = app.ensure_context(&display_path(&ws_a)).unwrap();
        let ctx_a2 = app.ensure_context(&display_path(&ws_a)).unwrap();
        let ctx_b = app.ensure_context(&display_path(&ws_b)).unwrap();

        assert!(Arc::ptr_eq(&ctx_a1, &ctx_a2), "同根幂等复用");
        assert!(!Arc::ptr_eq(&ctx_a1, &ctx_b), "异根各持实例");
        assert_ne!(ctx_a1.engine.project_root(), ctx_b.engine.project_root());
        assert_eq!(app.context_count(), 2);

        // 各自写入只落各自实例
        use hologram_graph::{Node, NodeKind};
        ctx_a1.engine
            .write(|idx| idx.insert_node(Node::new("a_node", "A", NodeKind::Function)))
            .unwrap();
        ctx_b.engine
            .write(|idx| idx.insert_node(Node::new("b_node", "B", NodeKind::Function)))
            .unwrap();
        assert_eq!(ctx_a1.engine.read(|i| i.node_count()).unwrap(), 1);
        assert_eq!(ctx_b.engine.read(|i| i.node_count()).unwrap(), 1);
        assert!(ctx_a1.engine.read(|i| i.get_node("b_node").is_none()).unwrap());
        assert!(ctx_b.engine.read(|i| i.get_node("a_node").is_none()).unwrap());
    }

    /// 决议链（workspace-session-ownership-rework 后两条臂）：
    /// 显式 root 优先 → 活动工作区回退 → 全空 None。
    #[test]
    fn resolve_engine_two_arms_priority() {
        let ws_a = temp_dir("lantai_ctx_chain_a");
        let ws_b = temp_dir("lantai_ctx_chain_b");
        let ws_c = temp_dir("lantai_ctx_chain_c");
        let app = AppContexts::new();

        // 显式 root 最高优先（即便与回退不同）
        let e_c = app.resolve_engine(Some(&display_path(&ws_c)), Some(&display_path(&ws_b))).unwrap();
        assert_eq!(e_c.project_root(), ws_c);

        // 无显式 → 回退（活动工作区）
        let e_fb = app.resolve_engine(None, Some(&display_path(&ws_b))).unwrap();
        assert_eq!(e_fb.project_root(), ws_b);

        // 回退无效（空/不存在）→ None
        assert!(app.resolve_engine(None, Some("")).is_none());
        assert!(app.resolve_engine(None, Some("Z:/definitely/not/here")).is_none());

        // 全空 → None
        assert!(app.resolve_engine(None, None).is_none());

        // 幂等：重复解析不同根不新建（两条臂各 ensure 一次，共 3 个上下文）
        let _ = app.resolve_engine(None, Some(&display_path(&ws_a))).unwrap();
        assert_eq!(app.context_count(), 3, "ensure_context 幂等，不因重复解析新建");
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

    /// L2 e2e：分析→落盘→查询闭环经数据上下文。
    /// ① 经 context.engine 分析；② engine.read（计算面）与 store_host 直查
    /// （应用层数据面）结果一致；③ GC 后重开上下文——新实例从 SQLite
    /// 读回同量节点（落盘真实发生，非内存假象）。
    #[test]
    fn analyze_persist_query_loop_via_context() {
        let ws = temp_dir("lantai_ctx_l2_loop");
        std::fs::create_dir_all(ws.join("src")).unwrap();
        std::fs::write(ws.join("src/main.py"), "def hello(): pass\n").unwrap();
        let app = AppContexts::new();
        let ctx = app.ensure_context(&display_path(&ws)).unwrap();

        let result = ctx.engine.analyze(&ctx.root).expect("analyze via context engine");
        assert!(result.node_count > 0, "fixture must yield nodes");

        let via_engine = ctx.engine.read(|i| i.node_count()).unwrap();
        let via_host = {
            let host = ctx.store_host.lock().unwrap();
            host.store.read(|i| i.node_count())
        };
        assert_eq!(via_engine, via_host, "计算面与应用层数据面必须同源一致");
        assert!(via_engine > 0);

        // 落盘验证：GC（非保留）→ 重开 → 新实例从盘上读回
        app.gc_if_unused(&ctx.root, &[]);
        let ctx2 = app.ensure_context(&display_path(&ws)).unwrap();
        let reloaded = ctx2.engine.read(|i| i.node_count()).unwrap();
        assert_eq!(reloaded, via_engine, "重开上下文必须从 SQLite 读回同量节点");

        let _ = std::fs::remove_dir_all(&ws);
    }

    /// L4 守卫：壳层对 engine 全局函数（隐式单例存储访问）的直连点必须
    /// 全部在白名单内——白名单 = 决议链的 None 兜底臂（MCP 时代语义），
    /// 新增直连即红（应走 app::services 决议链 / 实例方法）。
    /// 白名单条目同时要求真实存在（防腐烂）。
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

        // 白名单：文件（相对 src-tauri/src）→ 允许的全局函数直连
        let whitelist: &[(&str, &[&str])] = &[
            // record_event 的决议链 None 兜底
            (r"app\services\hologram_service.rs", &["engine_record_timeline"]),
            // fs 命令时间线：单槽实例缺席时的全局兜底
            (r"commands\filesystem.rs", &["engine_record_timeline"]),
            // edit 副作用时间线：同上兜底
            (r"commands\editor.rs", &["engine_record_timeline"]),
        ];

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

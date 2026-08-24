// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 应用层（L1 数据上下文抽象）—— 壳内新生的业务与数据归属层。
//!
//! [`WorkspaceDataContext`] 按工作区实例化：每个工作区一个专属引擎实例
//! （图库 / 索引 / 时间线连接 / watcher 全在该实例内部），会话经
//! **事实校验**（卷快照 `workspace` 字段 + 目录存在性）attach 到自己的
//! 上下文；「当前工作区」退化为 UI 投影（由焦点会话推导）。
//!
//! 设计参照 DSH 五条铁律（docs/plans/layering-rework-plan.md §4 L1）：
//! 1. 会话是第一公民，自带 workspace 事实（卷快照字段）；
//! 2. 工作区 = 注册表容器（canonical 路径为键）；
//! 3. attach = 事实校验非声明——卷在则以卷为准，目录在才绑定；
//! 4. 出生与绑定分离——新会话卷未落盘时可用声明绑定，落盘后以卷为事实；
//! 5. 运行时锚点 = 会话，工作区是派生投影。
//!
//! 线程/锁纪律：std::sync 锁 + `unwrap_or_else(|e| e.into_inner())` 中毒
//! 恢复（壳层惯例，见 CONVENTIONS）；所有会阻塞的引擎操作（Engine init
//! 开 SQLite）由命令层包 spawn_blocking，本层保持同步纯逻辑。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use hologram_engine::engine::{Engine, engine_bind_global_shared};

pub(crate) mod commands;

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
/// 不存在 / 非目录 → None（attach 事实校验的「目录在」判据）。
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

/// 按工作区实例化的数据上下文。L2 起显式持**数据宿主共享句柄**——
/// 图库（hologram.db/FTS5/快照）与 timeline 连接的归属单元在
/// [`hologram_engine::storage::StoreHost`]，宿主（本上下文）创建并注入
/// Engine；应用层可直接经 `store_host` 持久化/检查库，Engine 是计算与
/// 访问的执行方。
pub(crate) struct WorkspaceDataContext {
    /// canonical 工作区根（注册表键）。
    pub root: PathBuf,
    /// 该工作区专属引擎实例。
    pub engine: Arc<Engine>,
    /// 数据宿主共享句柄（L2 存储外置）——与 Engine 内部持同一 Arc。
    pub(crate) store_host: Arc<Mutex<hologram_engine::storage::StoreHost>>,
    /// 绑定到本上下文的会话 id 集（GC 判据）。
    pub(crate) sessions: Mutex<HashSet<u64>>,
    pub created_at_ms: u64,
}

impl WorkspaceDataContext {
    /// 优雅停机：停 watcher（增量线程）后由 Drop 关库连接。
    /// GC 释放上下文前调用；幂等。
    pub(crate) fn shutdown(&self) {
        self.engine.stop_watcher();
    }
}

/// 会话绑定记录。`workspace == None` = Ungrouped（零目录/目录缺失卷，
/// 最小上下文——会话照常可用，无图上下文）。
pub(crate) struct SessionBinding {
    pub workspace: Option<PathBuf>,
}

/// attach 结果（命令回包 / 测试判据）。
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct AttachOutcome {
    pub session_id: u64,
    /// 绑定到的工作区（正斜杠 canonical 展示形）；None = Ungrouped。
    pub workspace: Option<String>,
    /// 是否绑定成功（workspace 非 None）。
    pub attached: bool,
}

/// 卷快照读取事实。
#[derive(Debug, PartialEq, Eq)]
enum VolumeFact {
    /// 卷文件不存在（新生会话——可用声明绑定，DSH 规则 4）。
    Missing,
    /// 卷在但读不出事实（坏 JSON / 超 4MB 毒化护栏）——按 Ungrouped 处理，
    /// 不采纳声明（卷已存在，不按新生对待）。
    Corrupt,
    /// 卷在且可读；workspace 字段（可空）。
    Data(Option<String>),
}

/// 读卷快照的 workspace 事实：全局位优先，legacy 目录回退（U1 双读）。
/// 只读不写；>4MB / 坏 JSON / 非 JSON 全容忍为 Corrupt（INVARIANTS #11.2）。
fn read_volume_workspace(session_id: u64, legacy_root: Option<&str>, sessions_root: &Path) -> VolumeFact {
    let read_one = |dir: &Path| -> Option<VolumeFact> {
        let file = dir.join(format!("{session_id}.json"));
        let meta = std::fs::metadata(&file).ok()?;
        if meta.len() > 4 * 1024 * 1024 {
            return Some(VolumeFact::Corrupt);
        }
        let content = std::fs::read_to_string(&file).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&content).ok()?;
        // 墓碑卷（deleted）视同数据卷——workspace 字段仍可作为归属事实，
        // 但 attach 前端不会打开墓碑；按 Data 处理保持读侧无特判。
        let ws = parsed
            .get("workspace")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.replace('\\', "/"));
        Some(VolumeFact::Data(ws))
    };
    // 全局位优先；未命中（文件不存在）→ legacy 目录（若提供）。
    match read_one(sessions_root) {
        Some(fact) => fact,
        None => match legacy_root.map(canonical_root).flatten() {
            Some(root) => read_one(&root.join(".lantai").join("sessions")).unwrap_or(VolumeFact::Missing),
            None => VolumeFact::Missing,
        },
    }
}

// ═══════════════════════════════════════════════════════════════
// 注册表（Tauri managed state：Arc<AppContexts>）
// ═══════════════════════════════════════════════════════════════

pub struct AppContexts {
    /// canonical root → context。
    contexts: RwLock<HashMap<PathBuf, Arc<WorkspaceDataContext>>>,
    /// session_id → binding（None = Ungrouped）。
    sessions: RwLock<HashMap<u64, SessionBinding>>,
    /// 焦点会话（UI 投影锚；决议链回退序之一）。
    focus: RwLock<Option<u64>>,
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
            sessions: RwLock::new(HashMap::new()),
            focus: RwLock::new(None),
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
            sessions: Mutex::new(HashSet::new()),
            created_at_ms: Self::now_ms(),
        });
        guard.insert(canon, ctx.clone());
        drop(guard);
        engine_bind_global_shared(engine);
        Ok(ctx)
    }

    /// 会话 attach（事实校验）：
    /// - 卷在 → 卷快照 workspace 字段为准（声明不参与）；目录在 → 绑定；
    ///   目录缺失 / 字段空 → Ungrouped；
    /// - 卷不在（新生）→ 声明 workspace（目录在）→ 绑定；无声明 → Ungrouped；
    /// - 坏卷 → Ungrouped（不采纳声明）。
    /// 重 attach（会话迁移）覆盖旧绑定并 GC 旧上下文。
    /// ⚠ 命中需建引擎时开 SQLite——命令层须包 spawn_blocking。
    pub(crate) fn attach_session(
        &self,
        session_id: u64,
        legacy_root: Option<&str>,
        claim: Option<&str>,
        sessions_root: &Path,
    ) -> Result<AttachOutcome, String> {
        let fact = read_volume_workspace(session_id, legacy_root, sessions_root);
        let workspace: Option<PathBuf> = match &fact {
            VolumeFact::Data(Some(ws)) => canonical_root(ws), // 目录缺失 → None（Ungrouped）
            VolumeFact::Data(None) => None,
            VolumeFact::Corrupt => None,
            VolumeFact::Missing => claim.and_then(canonical_root),
        };
        let ctx = match &workspace {
            Some(root) => Some(self.ensure_context(&display_path(root))?),
            None => None,
        };
        // 旧绑定迁移：先取旧值再写新值；从旧上下文会话集移除 + GC。
        let old_root = {
            let mut sessions = write_or_recover(&self.sessions);
            let old = sessions
                .get(&session_id)
                .and_then(|b| b.workspace.clone());
            sessions.insert(
                session_id,
                SessionBinding {
                    workspace: workspace.clone(),
                },
            );
            old
        };
        if let Some(ref old) = old_root {
            if Some(old) != workspace.as_ref() {
                if let Some(old_ctx) = read_or_recover(&self.contexts).get(old).cloned() {
                    old_ctx
                        .sessions
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&session_id);
                }
                let keep: Vec<PathBuf> = workspace.clone().into_iter().collect();
                self.gc_if_unused(old, &keep);
            }
        }
        if let Some(ref ctx) = ctx {
            ctx.sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_id);
        }
        Ok(AttachOutcome {
            session_id,
            workspace: workspace.as_deref().map(display_path),
            attached: workspace.is_some(),
        })
    }

    /// 焦点会话（UI 投影锚）。未 attach 的会话也可被聚焦（决议链自然回退）。
    pub(crate) fn focus_session(&self, session_id: u64) -> Option<String> {
        *write_or_recover(&self.focus) = Some(session_id);
        self.session_workspace(session_id)
    }

    /// 会话绑定的工作区（展示形）。
    pub(crate) fn session_workspace(&self, session_id: u64) -> Option<String> {
        read_or_recover(&self.sessions)
            .get(&session_id)
            .and_then(|b| b.workspace.as_ref())
            .map(|p| display_path(p))
    }

    /// 解绑会话并按需 GC 上下文（无会话绑定且非焦点且不在保留集）。
    pub(crate) fn detach_session(&self, session_id: u64, keep_roots: &[PathBuf]) {
        let old = write_or_recover(&self.sessions).remove(&session_id);
        if *read_or_recover(&self.focus) == Some(session_id) {
            *write_or_recover(&self.focus) = None;
        }
        if let Some(SessionBinding { workspace: Some(root), .. }) = old {
            self.gc_if_unused(&root, keep_roots);
        }
    }

    /// 上下文空闲判定回收：无会话绑定、非焦点工作区、不在保留集 →
    /// 停 watcher + 移除（Arc 落 Drop 关库连接）。
    pub(crate) fn gc_if_unused(&self, root: &Path, keep_roots: &[PathBuf]) {
        let in_use = read_or_recover(&self.sessions)
            .values()
            .any(|b| b.workspace.as_deref() == Some(root));
        let focused_root = self
            .focused_context()
            .map(|c| c.root.clone());
        let kept = keep_roots.iter().any(|k| k == root);
        if in_use || focused_root.as_deref() == Some(root) || kept {
            return;
        }
        if let Some(ctx) = write_or_recover(&self.contexts).remove(root) {
            ctx.shutdown();
        }
    }

    /// 会话 → 上下文。
    pub(crate) fn context_for_session(&self, session_id: u64) -> Option<Arc<WorkspaceDataContext>> {
        let root = read_or_recover(&self.sessions)
            .get(&session_id)
            .and_then(|b| b.workspace.clone())?;
        read_or_recover(&self.contexts).get(&root).cloned()
    }

    /// 焦点会话 → 上下文。
    pub(crate) fn focused_context(&self) -> Option<Arc<WorkspaceDataContext>> {
        let focus = *read_or_recover(&self.focus);
        self.context_for_session(focus?)
    }
    /// 上下文清单（诊断 / 守护测试）。
    pub(crate) fn list_contexts(&self) -> Vec<ContextInfo> {
        read_or_recover(&self.contexts)
            .values()
            .map(|c| ContextInfo {
                workspace: display_path(&c.root),
                session_count: c
                    .sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .len(),
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

    /// 解析链核心：显式 root → 会话 → 焦点 → 保留回退（单槽）。
    /// 全部未命中 → None（调用方回落全局引擎——MCP 时代语义）。
    /// ⚠ ensure 语义（miss 即建）只对 explicit_root 生效；会话/焦点链
    /// 只读（未 attach 的会话不应凭空调用就建引擎）。
    pub(crate) fn resolve_engine(
        &self,
        explicit_root: Option<&str>,
        session_id: Option<u64>,
        fallback_root: Option<&str>,
    ) -> Option<Arc<Engine>> {
        if let Some(root) = explicit_root.map(str::trim).filter(|s| !s.is_empty()) {
            return self.ensure_context(root).ok().map(|c| c.engine.clone());
        }
        if let Some(sid) = session_id {
            if let Some(ctx) = self.context_for_session(sid) {
                return Some(ctx.engine.clone());
            }
        }
        if let Some(ctx) = self.focused_context() {
            return Some(ctx.engine.clone());
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
    pub session_count: usize,
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

    /// attach 事实校验：卷在、workspace 字段有效、目录存在 → 绑定对应上下文。
    #[test]
    fn attach_binds_to_volume_workspace_fact() {
        let ws = temp_dir("lantai_ctx_attach_fact");
        let sess_root = temp_dir("lantai_ctx_attach_fact_sess");
        let ws_disp = display_path(&ws);
        std::fs::write(
            sess_root.join("7.json"),
            serde_json::json!({ "label": "x", "workspace": ws_disp }).to_string(),
        )
        .unwrap();

        let app = AppContexts::new();
        let out = app
            .attach_session(7, None, None, &sess_root)
            .expect("attach should succeed");
        assert_eq!(out.workspace.as_deref(), Some(ws_disp.as_str()));
        assert!(out.attached);
        assert_eq!(app.context_count(), 1, "context created for workspace");
    }

    /// 卷在但 workspace 字段空 → Ungrouped（不建上下文，会话仍可用）。
    #[test]
    fn attach_zero_workspace_volume_is_ungrouped() {
        let sess_root = temp_dir("lantai_ctx_attach_zero");
        std::fs::write(
            sess_root.join("8.json"),
            serde_json::json!({ "label": "x", "workspace": null }).to_string(),
        )
        .unwrap();

        let app = AppContexts::new();
        let out = app.attach_session(8, None, None, &sess_root).unwrap();
        assert_eq!(out.workspace, None);
        assert!(!out.attached);
        assert_eq!(app.context_count(), 0);
    }

    /// 卷在但工作区目录已删 → Ungrouped（事实校验拒绝，不采纳声明）。
    #[test]
    fn attach_volume_workspace_dir_missing_is_ungrouped() {
        let sess_root = temp_dir("lantai_ctx_attach_missing_dir");
        std::fs::write(
            sess_root.join("9.json"),
            serde_json::json!({ "label": "x", "workspace": "Z:/definitely/not/here" }).to_string(),
        )
        .unwrap();

        let app = AppContexts::new();
        let out = app.attach_session(9, None, Some("C:/also/not/here"), &sess_root).unwrap();
        assert_eq!(out.workspace, None, "卷存在时声明不得覆盖卷事实（即便目录缺失）");
        assert_eq!(app.context_count(), 0);
    }

    /// 新生会话（卷不在）→ 声明绑定（DSH 出生与绑定分离）。
    #[test]
    fn attach_newborn_uses_claim() {
        let ws = temp_dir("lantai_ctx_attach_newborn");
        let sess_root = temp_dir("lantai_ctx_attach_newborn_sess");
        let ws_disp = display_path(&ws);

        let app = AppContexts::new();
        let out = app
            .attach_session(11, None, Some(&ws_disp), &sess_root)
            .unwrap();
        assert_eq!(out.workspace.as_deref(), Some(ws_disp.as_str()));
        assert!(out.attached);

        // 卷随后落盘（带另一 workspace 事实）→ 重 attach 以卷为准
        let ws2 = temp_dir("lantai_ctx_attach_newborn_2");
        std::fs::write(
            sess_root.join("11.json"),
            serde_json::json!({ "workspace": display_path(&ws2) }).to_string(),
        )
        .unwrap();
        let out2 = app
            .attach_session(11, None, Some(&ws_disp), &sess_root)
            .unwrap();
        assert_eq!(out2.workspace.as_deref(), Some(display_path(&ws2).as_str()));
        // 旧声明工作区上下文无会话引用后应被 GC（非焦点、非保留）
        assert_eq!(app.context_count(), 1, "旧上下文应被回收");
    }

    /// legacy 目录回退读卷（U1 双读：全局位无此卷时）。
    #[test]
    fn attach_reads_legacy_volume_when_global_missing() {
        let ws = temp_dir("lantai_ctx_attach_legacy");
        let legacy_project = temp_dir("lantai_ctx_attach_legacy_proj");
        let empty_global = temp_dir("lantai_ctx_attach_legacy_global");
        std::fs::create_dir_all(legacy_project.join(".lantai/sessions")).unwrap();
        std::fs::write(
            legacy_project.join(".lantai/sessions/12.json"),
            serde_json::json!({ "workspace": display_path(&ws) }).to_string(),
        )
        .unwrap();

        let app = AppContexts::new();
        let out = app
            .attach_session(12, Some(&display_path(&legacy_project)), None, &empty_global)
            .unwrap();
        assert_eq!(out.workspace.as_deref(), Some(display_path(&ws).as_str()));
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
        use hologram_engine::graph::{Node, NodeKind};
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

    /// 决议链：显式 root > 会话 > 焦点 > 回退；全空 → None。
    #[test]
    fn resolve_engine_chain_priority() {
        let ws_a = temp_dir("lantai_ctx_chain_a");
        let ws_b = temp_dir("lantai_ctx_chain_b");
        let ws_c = temp_dir("lantai_ctx_chain_c");
        let sess_root = temp_dir("lantai_ctx_chain_sess");
        let app = AppContexts::new();

        // 会话 21 → ws_a（卷事实）
        std::fs::write(
            sess_root.join("21.json"),
            serde_json::json!({ "workspace": display_path(&ws_a) }).to_string(),
        )
        .unwrap();
        app.attach_session(21, None, None, &sess_root).unwrap();
        // 会话 22 → ws_b，并聚焦
        std::fs::write(
            sess_root.join("22.json"),
            serde_json::json!({ "workspace": display_path(&ws_b) }).to_string(),
        )
        .unwrap();
        app.attach_session(22, None, None, &sess_root).unwrap();
        let focused_ws = app.focus_session(22).unwrap();
        assert_eq!(focused_ws, display_path(&ws_b));

        let b_disp = display_path(&ws_b);
        let c_disp = display_path(&ws_c);

        // 显式 root 最高优先（即便与会话/焦点不同）
        let e_c = app.resolve_engine(Some(&c_disp), Some(21), Some(&b_disp)).unwrap();
        assert_eq!(e_c.project_root(), ws_c);

        // 会话 > 焦点
        let e_21 = app.resolve_engine(None, Some(21), Some(&b_disp)).unwrap();
        assert_eq!(e_21.project_root(), ws_a);

        // 焦点兜底
        let e_focus = app.resolve_engine(None, None, Some(&b_disp)).unwrap();
        assert_eq!(e_focus.project_root(), ws_b);

        // 焦点 detach 后 → 回退根
        app.detach_session(22, &[]);
        let e_fb = app.resolve_engine(None, None, Some(&b_disp)).unwrap();
        assert_eq!(e_fb.project_root(), ws_b);

        // 全空 → None
        assert!(app.resolve_engine(None, Some(999), None).is_none());
    }

    /// detach GC：最后一个会话解绑 → 上下文回收。
    #[test]
    fn detach_garbage_collects_idle_context() {
        let ws = temp_dir("lantai_ctx_gc");
        let sess_root = temp_dir("lantai_ctx_gc_sess");
        let app = AppContexts::new();
        std::fs::write(
            sess_root.join("31.json"),
            serde_json::json!({ "workspace": display_path(&ws) }).to_string(),
        )
        .unwrap();
        app.attach_session(31, None, None, &sess_root).unwrap();
        assert_eq!(app.context_count(), 1);

        // 保留集包含该根 → 不回收
        app.detach_session(31, &[ws.clone()]);
        assert_eq!(app.context_count(), 1, "保留根不回收");

        // 重新绑定后无保留解绑 → 回收
        app.attach_session(31, None, None, &sess_root).unwrap();
        app.detach_session(31, &[]);
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

        // 落盘验证：GC（无会话绑定）→ 重开 → 新实例从盘上读回
        app.gc_if_unused(&ctx.root, &[]);
        let ctx2 = app.ensure_context(&display_path(&ws)).unwrap();
        let reloaded = ctx2.engine.read(|i| i.node_count()).unwrap();
        assert_eq!(reloaded, via_engine, "重开上下文必须从 SQLite 读回同量节点");

        let _ = std::fs::remove_dir_all(&ws);
    }
}

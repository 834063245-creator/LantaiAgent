// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 工作区生命周期命令薄壳（L3）：State 转换 + 调应用层服务
// （app/services/workspace_service）。

use tauri;

#[tauri::command]
pub(crate) async fn workspace_activate(
    path: String,
    graph_engine: Option<bool>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<(), String> {
    let mut handle = crate::workspace::WorkspaceHandle::new(&path);
    // register 需要 path，但 activate 会 move 走——先克隆（登记在激活成功后）。
    let reg_path = path.clone();
    crate::app::services::workspace_service::activate(
        path,
        app_ctx.inner().clone(),
        &mut handle,
    )
    .await?;
    *crate::utils::lock_or_recover(&state) = Some(handle);
    // Stage-5 补尾：绑定真目录 → 登记进「已知工作区」注册表（首页工作区管理
    // 的实体来源；空工作区也可见）。登记是便利面，失败不阻断激活（可见于日志）。
    // per-workspace 图谱引擎旗标（2026-08-31）：Some = 显式选择（新建工作区
    // sheet 的勾选）随登记写入；None = 保持注册表现值（进入既有工作区不覆写）。
    if !reg_path.trim().is_empty() {
        if let Err(e) = registry::register(&reg_path, None, graph_engine) {
            eprintln!("[workspace] 已知工作区登记失败 {reg_path}: {e}");
        }
    }
    Ok(())
}

/// 新建工作区目录（2026-08-31 首页 sheet「创建」路径）：在用户文档根下建
/// `~/Documents/兰台/<名字>` 并返回归一化路径（正斜杠）。名字即目录名——
/// 工作区身份 = 目录路径，此后改名只改注册表显示名。只建目录不登记：
/// 登记随后续 workspace_activate 发生（用户中途取消则留下一个无主空目录，无害）。
pub(crate) fn create_default_workspace_dir(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("工作区名字不能为空".into());
    }
    // 名字 = 目录名：拒绝路径分隔符与 Windows 保留字符、控制字符、相对路径段
    const ILLEGAL: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    if trimmed.chars().any(|c| ILLEGAL.contains(&c) || c.is_control()) {
        return Err("工作区名字不能包含 / \\ : * ? \" < > | 或控制字符".into());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("工作区名字不能是 . 或 ..".into());
    }
    // Windows 文件系统会静默吞掉结尾的空格/点——先归一并复查非空
    let trimmed = trimmed.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return Err("工作区名字不能只有点或空格".into());
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录（USERPROFILE/HOME 均未设置）".to_string())?;
    let dir = std::path::PathBuf::from(home)
        .join("Documents")
        .join("兰台")
        .join(trimmed);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建工作区目录失败: {e}"))?;
    Ok(dir.to_string_lossy().replace('\\', "/"))
}

/// 停用当前工作区。停止文件监视器，清除已变更文件。
#[tauri::command]
pub(crate) async fn workspace_deactivate(
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<(), String> {
    // 在短暂持有锁时取出句柄，然后在停用前释放锁。
    // deactivate() 停止监视器；在 state 互斥锁下执行此操作
    // 会在整个停止期间阻塞所有需要 state 的其他命令。
    let handle = {
        let mut guard = state.lock().map_err(|e| format!("工作区状态错误: {e}"))?;
        guard.take()
    };
    if let Some(mut h) = handle {
        let old_path = h.path.clone();
        h.deactivate();
        crate::app::services::workspace_service::deactivate(old_path, app_ctx.inner().clone()).await?;
    }
    Ok(())
}

/// 启动活跃工作区的文件监视器。
/// 必须在 workspace_activate 之后调用。
#[tauri::command]
pub(crate) async fn workspace_start_watcher(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::WorkspaceState>,
) -> Result<(), String> {
    if let Some(ref mut handle) = *crate::utils::lock_or_recover(&state) {
        handle.start_watcher(app);
        Ok(())
    } else {
        Err("没有活跃的工作区".into())
    }
}

/// 读取最近工作区路径（.last_project——workspace_activate 每次绑定都写，
/// 与图谱引擎无关）。冷启动恢复信号之一；图谱引擎停用时是**唯一**信号。
#[tauri::command]
pub(crate) fn get_last_project() -> Result<Option<String>, String> {
    let last = std::fs::read_to_string(crate::utils::project_root().join(".last_project"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(last)
}

// ═══════════════════════════════════════════════════════════════
// 已知工作区注册表（Stage-5 补尾：首页工作区管理的「已知工作区」实体）
//
// ~ 用途：`~/.lantai/workspaces.json` 记录用户绑定过的目录（路径 + 显示名 +
//   最近打开 + 固定）。与「由会话推导」互补：空工作区（无卷）也可见、可管理，
//   解决「工作区清单 = 会话倒推 → 空目录不可见、无法增删改查」的结构缺口。
//
// 边界纪律：并入既有 commands::workspace 模块——不新增命令模块（守卫测试
// platform_boundary_test::capability_command_modules_are_frozen 钉死清单）。
//
// 读写纪律：原子写（write_atomic）+ 毒化容忍（INVARIANTS #11.2——坏文件不变
// 成每次启动必崩）。登记在 `workspace_activate` 时触发（后端侧，与前端无关）。
// ═══════════════════════════════════════════════════════════════
pub(crate) mod registry {
    use serde::{Deserialize, Serialize};
    use std::path::PathBuf;

    #[derive(Serialize, Deserialize, Clone, Debug)]
    pub(crate) struct WorkspaceEntry {
        pub path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        pub last_opened_at: String,
        #[serde(default)]
        pub pinned: bool,
        /// per-workspace 图谱引擎旗标（2026-08-31）：None = 从未显式选择
        /// （前端回退全局默认值）。生效语义 = 装配期一次（在途工作区不活拆）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub graph_engine: Option<bool>,
    }

    #[derive(Serialize, Deserialize, Clone, Debug, Default)]
    pub(crate) struct WorkspaceRegistry {
        pub version: u32,
        pub workspaces: Vec<WorkspaceEntry>,
    }

    /// 注册表文件路径：`~/.lantai/workspaces.json`。
    fn registry_path() -> PathBuf {
        crate::commands::filesystem::user_lantai_dir().join("workspaces.json")
    }

    /// 读注册表（缺失 = 空；毒化 = 空并丢弃坏内容——不把坏文件变每次启动必崩）。
    pub(crate) fn read_registry() -> WorkspaceRegistry {
        let raw = match std::fs::read_to_string(registry_path()) {
            Ok(r) => r,
            Err(_) => return WorkspaceRegistry { version: 1, workspaces: Vec::new() },
        };
        match serde_json::from_str::<WorkspaceRegistry>(&raw) {
            Ok(mut r) => {
                if r.version != 1 {
                    r.version = 1;
                }
                r
            }
            Err(_) => WorkspaceRegistry { version: 1, workspaces: Vec::new() },
        }
    }

    fn write_registry(reg: &WorkspaceRegistry) -> Result<(), String> {
        let path = registry_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建 ~/.lantai 目录失败: {e}"))?;
        }
        let json =
            serde_json::to_string_pretty(reg).map_err(|e| format!("序列化工作区注册表失败: {e}"))?;
        crate::utils::write_atomic(&path.to_string_lossy(), &json)
    }

    /// 路径归一：反斜杠 → 正斜杠、去尾斜杠（与 TS chat-session normWs 同规——
    /// 匹配时统一，避免 `D:\x` 与 `D:/x` 双写一条）。
    fn norm_path(p: &str) -> String {
        p.replace('\\', "/").trim_end_matches('/').to_string()
    }

    /// 登记（upsert）：path 已存在 → 刷新 last_opened_at（name 提供则更新，
    /// graph_engine 提供则更新）；否则新增。`workspace_activate` 每次绑定真
    /// 目录时调用——graph_engine 为 None 时不动已有值（进入既有工作区路径）。
    pub(crate) fn register(
        path: &str,
        name: Option<String>,
        graph_engine: Option<bool>,
    ) -> Result<(), String> {
        if path.trim().is_empty() {
            return Ok(()); // 占位工作区（path=''）不登记
        }
        let np = norm_path(path);
        let now = crate::audit::now_iso();
        let mut reg = read_registry();
        if let Some(e) = reg.workspaces.iter_mut().find(|e| e.path == np) {
            e.last_opened_at = now;
            if let Some(n) = name {
                let n = n.trim();
                if !n.is_empty() {
                    e.name = Some(n.to_string());
                }
            }
            if graph_engine.is_some() {
                e.graph_engine = graph_engine;
            }
        } else {
            reg.workspaces.push(WorkspaceEntry {
                path: np,
                name,
                last_opened_at: now,
                pinned: false,
                graph_engine,
            });
        }
        write_registry(&reg)
    }

    /// per-workspace 图谱引擎开关（2026-08-31）：首页卡片徽标的切换入口。
    /// 未知路径自动补登记（rename/pin 同款）；生效语义 = 装配期一次
    /// （在途不活拆——下次进入该工作区即见）。
    pub(crate) fn set_graph_engine(path: &str, enabled: bool) -> Result<(), String> {
        let np = norm_path(path);
        if np.is_empty() {
            return Err("工作区路径不能为空".into());
        }
        let mut reg = read_registry();
        if let Some(e) = reg.workspaces.iter_mut().find(|e| e.path == np) {
            e.graph_engine = Some(enabled);
        } else {
            reg.workspaces.push(WorkspaceEntry {
                path: np,
                name: None,
                last_opened_at: crate::audit::now_iso(),
                pinned: false,
                graph_engine: Some(enabled),
            });
        }
        write_registry(&reg)
    }

    /// 重命名（显示名）。未知路径自动补登记（首页可能先于 activate 操作派生卡）。
    pub(crate) fn rename(path: &str, name: String) -> Result<(), String> {
        let np = norm_path(path);
        let name = name.trim();
        if name.is_empty() {
            return Err("工作区显示名不能为空".into());
        }
        let mut reg = read_registry();
        if let Some(e) = reg.workspaces.iter_mut().find(|e| e.path == np) {
            e.name = Some(name.to_string());
        } else {
            reg.workspaces.push(WorkspaceEntry {
                path: np,
                name: Some(name.to_string()),
                last_opened_at: crate::audit::now_iso(),
                pinned: false,
                graph_engine: None,
            });
        }
        write_registry(&reg)
    }

    /// 固定/取消固定（常用工作区置顶）。未知路径自动补登记。
    pub(crate) fn toggle_pin(path: &str, pinned: bool) -> Result<(), String> {
        let np = norm_path(path);
        let mut reg = read_registry();
        if let Some(e) = reg.workspaces.iter_mut().find(|e| e.path == np) {
            e.pinned = pinned;
        } else {
            reg.workspaces.push(WorkspaceEntry {
                path: np,
                name: None,
                last_opened_at: crate::audit::now_iso(),
                pinned,
                graph_engine: None,
            });
        }
        write_registry(&reg)
    }

    /// 移除工作区（彻底）：删除该工作区自己的会话目录（`{ws}/.lantai/sessions/`）
    /// 并从注册表移除。workspace-session-ownership-rework（2026-08-27）：会话
    /// 物理归属工作区——删除 = 删目录；旧模型的「按 workspace 字段扫描全局位
    /// 墓碑」已随全局位归档退役。
    /// 「确认做足、不做退路」拍板（2026-08-31）的必然推论：删除失败必须报错
    /// 且**不解除登记**——此前 `let _ =` 吞错会产生孤儿卷（注册表没了，数据
    /// 还在却无处可见，永不可达）。目录本就不存在 = 无可删，直接解除登记。
    pub(crate) fn remove(path: &str) -> Result<(), String> {
        let np = norm_path(path);
        if !np.is_empty() {
            let dir = crate::commands::filesystem::workspace_sessions_root(&np);
            if dir.exists() {
                std::fs::remove_dir_all(&dir)
                    .map_err(|e| format!("删除案卷目录失败（工作区保留在清单中）: {e}"))?;
            }
        }
        let mut reg = read_registry();
        reg.workspaces.retain(|e| e.path != np);
        write_registry(&reg)
    }

    /// 首页工作区卡（注册表 + 会话推导合流后的完整形状）。
    #[derive(serde::Serialize)]
    pub(crate) struct WorkspaceSummary {
        pub path: String,
        pub name: Option<String>,
        pub last_opened_at: String,
        pub pinned: bool,
        pub session_count: usize,
        pub latest_saved_at: Option<String>,
        /// 工作区根目录在磁盘上是否仍存在（false = 前端「目录已丢失」诚实
        /// 显示并禁进——此前谎称「空工作区」且进入会复活目录树）。
        pub dir_exists: bool,
        /// per-workspace 图谱引擎旗标（None = 未显式选择，前端回退全局默认）。
        pub graph_engine: Option<bool>,
    }

    /// 已知工作区清单：注册表条目全量列出（含空工作区）；每个工作区的
    /// 会话计数/最近时间扫**自己的会话根** `{path}/.lantai/sessions/`。
    /// workspace-session-ownership-rework（2026-08-27）：会话物理归属工作区，
    /// 不再有「全局位按 workspace 字段推导」的回退臂；排序 = 固定优先 →
    /// lastOpenedAt 降序。
    pub(crate) fn list() -> Result<Vec<WorkspaceSummary>, String> {
        let reg = read_registry();
        let mut out: Vec<WorkspaceSummary> = Vec::new();
        for e in &reg.workspaces {
            let sessions = crate::commands::filesystem::scan_sessions_dir(
                &crate::commands::filesystem::workspace_sessions_root(&e.path),
            );
            let latest = sessions
                .iter()
                .map(|s| s.saved_at.clone())
                .filter(|s| !s.is_empty())
                .max();
            out.push(WorkspaceSummary {
                path: e.path.clone(),
                name: e.name.clone(),
                last_opened_at: e.last_opened_at.clone(),
                pinned: e.pinned,
                session_count: sessions.len(),
                latest_saved_at: latest,
                dir_exists: std::path::Path::new(&e.path).exists(),
                graph_engine: e.graph_engine,
            });
        }

        out.sort_by(|a, b| {
            b.pinned.cmp(&a.pinned).then_with(|| b.last_opened_at.cmp(&a.last_opened_at))
        });
        Ok(out)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        // create_default_workspace_dir 定义在文件级（registry 外）——测试直接引
        use super::super::create_default_workspace_dir;

        /// 隔离测试：把用户主目录指到临时目录（USERPROFILE/HOME 重定向——
        /// user_lantai_dir 的解析真源），结束还原并清理。
        /// 进程级 env 是全测试进程共享的：并行测试线程同时翻转会让
        /// registry 路径错乱（os error 3 / 计数互串）——写侧互斥串行化，
        /// 持锁覆盖「翻转 → 执行 → 还原」全程。
        fn with_temp_home(f: impl FnOnce()) {
            static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let _guard = crate::utils::lock_or_recover(&ENV_LOCK);
            let dir = std::env::temp_dir().join(format!(
                "lantai_ws_registry_test_{}",
                crate::audit::now_iso().replace([':', '.'], "-")
            ));
            let old_home = std::env::var("USERPROFILE").ok();
            let old_home2 = std::env::var("HOME").ok();
            std::env::set_var("USERPROFILE", &dir);
            std::env::set_var("HOME", &dir);
            f();
            if let Some(h) = old_home {
                std::env::set_var("USERPROFILE", h);
            } else {
                std::env::remove_var("USERPROFILE");
            }
            if let Some(h) = old_home2 {
                std::env::set_var("HOME", h);
            } else {
                std::env::remove_var("HOME");
            }
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn register_upsert_refreshes_last_opened() {
            with_temp_home(|| {
                register("D:/proj", Some("项目A".into()), None).unwrap();
                register("D:/proj", None, None).unwrap();
                let reg = read_registry();
                assert_eq!(reg.workspaces.len(), 1);
                assert_eq!(reg.workspaces[0].name.as_deref(), Some("项目A"));
            });
        }

        #[test]
        fn empty_path_not_registered() {
            with_temp_home(|| {
                register("", None, None).unwrap();
                assert!(read_registry().workspaces.is_empty());
            });
        }

        #[test]
        fn graph_engine_flag_roundtrip_and_none_keeps() {
            // per-workspace 引擎旗标（2026-08-31）：Some 写入、None 保持现值
            with_temp_home(|| {
                register("D:/proj", None, Some(false)).unwrap();
                assert_eq!(read_registry().workspaces[0].graph_engine, Some(false));
                // 再登记不携旗标（进入既有工作区路径）→ 保持注册表现值
                register("D:/proj", None, None).unwrap();
                assert_eq!(read_registry().workspaces[0].graph_engine, Some(false));
                // 显式翻转 → 覆写
                register("D:/proj", None, Some(true)).unwrap();
                assert_eq!(read_registry().workspaces[0].graph_engine, Some(true));
            });
        }

        #[test]
        fn set_graph_engine_upserts() {
            with_temp_home(|| {
                // 未知路径自动补登记（rename/pin 同款）
                set_graph_engine("D:/new", false).unwrap();
                let reg = read_registry();
                assert_eq!(reg.workspaces.len(), 1);
                assert_eq!(reg.workspaces[0].graph_engine, Some(false));
                assert_eq!(reg.workspaces[0].path, "D:/new");
                // 既有条目翻转
                set_graph_engine("D:/new", true).unwrap();
                assert_eq!(read_registry().workspaces[0].graph_engine, Some(true));
            });
        }

        #[test]
        fn create_dir_rejects_bad_names() {
            // 名字校验纯逻辑，不触盘
            assert!(create_default_workspace_dir("").is_err());
            assert!(create_default_workspace_dir("   ".into()).is_err());
            assert!(create_default_workspace_dir("a/b").is_err());
            assert!(create_default_workspace_dir("a\\b").is_err());
            assert!(create_default_workspace_dir("a:b").is_err());
            assert!(create_default_workspace_dir("a*b").is_err());
            assert!(create_default_workspace_dir("..").is_err());
            assert!(create_default_workspace_dir("...  ").is_err());
        }

        #[test]
        fn create_dir_creates_under_documents() {
            with_temp_home(|| {
                let p = create_default_workspace_dir("  测试区  ").unwrap();
                // 归一化：正斜杠 + 名字已 trim
                assert!(p.ends_with("Documents/兰台/测试区"), "实际路径: {p}");
                assert!(!p.contains('\\'), "路径应归一为正斜杠: {p}");
                assert!(std::path::Path::new(&p).is_dir());
            });
        }

        #[test]
        fn rename_and_pin_upsert() {
            with_temp_home(|| {
                rename("D:/proj", " 新名 ".into()).unwrap();
                let reg = read_registry();
                assert_eq!(reg.workspaces.len(), 1);
                assert_eq!(reg.workspaces[0].name.as_deref(), Some("新名"));
                toggle_pin("D:/proj", true).unwrap();
                assert!(read_registry().workspaces[0].pinned);
            });
        }

        #[test]
        fn rename_rejects_empty() {
            with_temp_home(|| {
                assert!(rename("D:/proj", "  ".into()).is_err());
            });
        }

        #[test]
        fn poison_registry_is_empty_not_panic() {
            with_temp_home(|| {
                let p = registry_path();
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(&p, "{{not json").unwrap();
                let reg = read_registry();
                assert!(reg.workspaces.is_empty());
            });
        }

        #[test]
        fn list_counts_per_workspace_sessions() {
            // workspace-session-ownership-rework：会话计数扫各工作区自己的
            // 会话根（{ws}/.lantai/sessions/）——工作区根用临时目录真实落盘，
            // 注册表读写走 with_temp_home 隔离。
            let ws_empty = std::env::temp_dir().join(format!(
                "lantai_ws_list_empty_{}",
                crate::audit::now_iso().replace([':', '.'], "-")
            ));
            let ws_full = std::env::temp_dir().join(format!(
                "lantai_ws_list_full_{}",
                crate::audit::now_iso().replace([':', '.'], "-")
            ));
            let _ = std::fs::remove_dir_all(&ws_empty);
            let _ = std::fs::remove_dir_all(&ws_full);
            // 空工作区也真实落盘（绑定过的目录必然在盘上——dir_exists 语义的前提）
            std::fs::create_dir_all(&ws_empty).unwrap();
            let empty_str = ws_empty.to_string_lossy().replace('\\', "/");
            let full_str = ws_full.to_string_lossy().replace('\\', "/");
            let sessions_dir = crate::commands::filesystem::workspace_sessions_root(&full_str);
            std::fs::create_dir_all(&sessions_dir).unwrap();
            crate::utils::write_atomic(
                &sessions_dir.join("11.json").to_string_lossy(),
                r#"{"id":11,"label":"a","savedAt":"2026-08-26T00:00:00Z"}"#,
            )
            .unwrap();
            crate::utils::write_atomic(
                &sessions_dir.join("12.json").to_string_lossy(),
                r#"{"id":12,"label":"b","savedAt":"2026-08-26T01:00:00Z"}"#,
            )
            .unwrap();

            with_temp_home(|| {
                register(&empty_str, None, None).unwrap();
                register(&full_str, None, None).unwrap();

                let list = list().unwrap();
                // 空工作区也在列（注册表来源，计数 0）
                let empty = list.iter().find(|w| w.path == empty_str).unwrap();
                assert_eq!(empty.session_count, 0, "空工作区可见且计数 0");
                assert!(empty.dir_exists, "真实落盘的工作区 dir_exists=true");
                // 会话计数扫本工作区会话根 + 最近正确
                let full = list.iter().find(|w| w.path == full_str).unwrap();
                assert_eq!(full.session_count, 2);
                assert_eq!(full.latest_saved_at.as_deref(), Some("2026-08-26T01:00:00Z"));
                assert!(full.dir_exists);
            });
            let _ = std::fs::remove_dir_all(&ws_empty);
            let _ = std::fs::remove_dir_all(&ws_full);
        }

        #[test]
        fn remove_deletes_sessions_and_entry() {
            // 工作区根用临时目录（workspace_sessions_root 直读 ws 路径，
            // 不经 HOME——注册表读写才走 with_temp_home 隔离）
            let ws_root = std::env::temp_dir().join(format!(
                "lantai_ws_remove_test_{}",
                crate::audit::now_iso().replace([':', '.'], "-")
            ));
            let _ = std::fs::remove_dir_all(&ws_root);
            let ws_str = ws_root.to_string_lossy().replace('\\', "/");
            with_temp_home(|| {
                register(&ws_str, None, None).unwrap();
                // 新模型（workspace-session-ownership-rework）：会话在
                // {ws}/.lantai/sessions/ 下——删除 = 删该目录
                let sessions_dir = crate::commands::filesystem::workspace_sessions_root(&ws_str);
                std::fs::create_dir_all(&sessions_dir).unwrap();
                std::fs::write(sessions_dir.join("21.json"), r#"{"id":21,"label":"a"}"#).unwrap();
                std::fs::write(sessions_dir.join("22.json"), r#"{"id":22,"label":"b"}"#).unwrap();

                remove(&ws_str).unwrap();

                // 该工作区会话目录被删除；注册表条目移除
                assert!(!sessions_dir.exists(), "工作区会话目录应被删除");
                assert!(!read_registry().workspaces.iter().any(|e| e.path == ws_str));
            });
            let _ = std::fs::remove_dir_all(&ws_root);
        }

        #[test]
        fn remove_dir_missing_still_unregisters() {
            // 目录已在磁盘上消失（用户自己删了）→ 无可删，直接解除登记
            let ws_root = std::env::temp_dir().join(format!(
                "lantai_ws_remove_gone_{}",
                crate::audit::now_iso().replace([':', '.'], "-")
            ));
            let _ = std::fs::remove_dir_all(&ws_root);
            let ws_str = ws_root.to_string_lossy().replace('\\', "/");
            with_temp_home(|| {
                register(&ws_str, None, None).unwrap();
                assert!(!std::path::Path::new(&ws_str).exists());
                remove(&ws_str).unwrap();
                assert!(!read_registry().workspaces.iter().any(|e| e.path == ws_str));
            });
        }

        #[test]
        fn remove_failure_keeps_registry_entry() {
            // 「确认做足、不做退路」拍板（2026-08-31）的守护：删除失败必须报错
            // 且不解除登记——否则产生孤儿卷（数据在盘上却无处可见）。
            // 失败注入：sessions 根位置放一个同名**文件**（非目录）——
            // remove_dir_all 对非目录必失败，跨平台成立。
            let ws_root = std::env::temp_dir().join(format!(
                "lantai_ws_remove_fail_{}",
                crate::audit::now_iso().replace([':', '.'], "-")
            ));
            let _ = std::fs::remove_dir_all(&ws_root);
            std::fs::create_dir_all(&ws_root).unwrap();
            let ws_str = ws_root.to_string_lossy().replace('\\', "/");
            let sessions_root = crate::commands::filesystem::workspace_sessions_root(&ws_str);
            std::fs::create_dir_all(sessions_root.parent().unwrap()).unwrap();
            std::fs::write(&sessions_root, b"not a directory").unwrap();
            with_temp_home(|| {
                register(&ws_str, None, None).unwrap();
                let r = remove(&ws_str);
                assert!(r.is_err(), "sessions 根被文件占用时删除必须报错");
                assert!(
                    read_registry().workspaces.iter().any(|e| e.path == ws_str),
                    "删除失败时注册表条目必须保留（不产生孤儿卷）"
                );
            });
            let _ = std::fs::remove_dir_all(&ws_root);
        }
    }
}

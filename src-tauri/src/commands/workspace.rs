// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 工作区生命周期命令薄壳（L3）：State 转换 + 调应用层服务
// （app/services/workspace_service）。

use tauri;

#[tauri::command]
pub(crate) async fn workspace_activate(
    path: String,
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
    if !reg_path.trim().is_empty() {
        if let Err(e) = registry::register(&reg_path, None) {
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

/// 停用当前工作区。清理工作区状态。
#[tauri::command]
pub(crate) async fn workspace_deactivate(
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
) -> Result<(), String> {
    // 在短暂持有锁时取出句柄，然后在停用前释放锁。
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

// （workspace_start_watcher（壳侧通知泵启动口）随图谱全量退役删除，
//  2026-09-09——泵的产出（analyze-* 进度事件 / graph-updated）纯为图谱
//  数据面服务，引擎进程不再被兰台拉起。）

/// 读取最近工作区路径（.last_project——workspace_activate 每次绑定都写）。
/// 冷启动恢复信号。
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

    /// 登记（upsert）：path 已存在 → 刷新 last_opened_at（name 提供则更新）；
    /// 否则新增。`workspace_activate` 每次绑定真目录时调用。
    /// （graph_engine 旗标随图谱全量退役移除，2026-09-09——在盘注册表残留
    ///  旧字段由 serde 忽略，自然荒废。）
    pub(crate) fn register(path: &str, name: Option<String>) -> Result<(), String> {
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
        } else {
            reg.workspaces.push(WorkspaceEntry {
                path: np,
                name,
                last_opened_at: now,
                pinned: false,
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
    }

    /// 已知工作区清单：注册表条目全量列出（含空工作区）；每个工作区的
    /// 卷数/最近时间扫**自己的会话根** `{path}/.lantai/sessions/`——认卷口径
    /// 见 `filesystem::scan_sessions_dir`（卷本体 = `.ndjson`，空卷按清单投影
    /// `_index.json` 剔除，与画布侧栏同源）。
    /// workspace-session-ownership-rework（2026-08-27）：会话物理归属工作区，
    /// 不再有「全局位按 workspace 字段推导」的回退臂；排序 = 固定优先 →
    /// lastOpenedAt 降序。
    pub(crate) fn list() -> Result<Vec<WorkspaceSummary>, String> {
        let reg = read_registry();
        let mut out: Vec<WorkspaceSummary> = Vec::new();
        for e in &reg.workspaces {
            let scan = crate::commands::filesystem::scan_sessions_dir(
                &crate::commands::filesystem::workspace_sessions_root(&e.path),
            );
            out.push(WorkspaceSummary {
                path: e.path.clone(),
                name: e.name.clone(),
                last_opened_at: e.last_opened_at.clone(),
                pinned: e.pinned,
                session_count: scan.count,
                latest_saved_at: scan.latest_saved_at,
                dir_exists: std::path::Path::new(&e.path).exists(),
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
                register("D:/proj", Some("项目A".into())).unwrap();
                register("D:/proj", None).unwrap();
                let reg = read_registry();
                assert_eq!(reg.workspaces.len(), 1);
                assert_eq!(reg.workspaces[0].name.as_deref(), Some("项目A"));
            });
        }

        #[test]
        fn empty_path_not_registered() {
            with_temp_home(|| {
                register("", None).unwrap();
                assert!(read_registry().workspaces.is_empty());
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
        fn list_counts_volumes_from_ndjson_and_catalog() {
            // 卷集真源 = 事件日志 `.ndjson`（Phase 3b 权威翻转 2026-09-15）。
            // 旧口径按 `.json` 数卷：删光会话后仍报「2 卷」（真机 2026-10-20 的
            // 6.json / 10.json 两份残留），且漏掉只有 `.ndjson` 的真实卷。
            // 空卷（建卷后没说过话）在清单投影 `_index.json` 无行、画布侧栏也不列
            // → 不计数；清单缺席/版本不认则退回「目录里有就算」。
            let temp_ws = |tag: &str| {
                let dir = std::env::temp_dir().join(format!(
                    "lantai_ws_list_{tag}_{}",
                    crate::audit::now_iso().replace([':', '.'], "-")
                ));
                let _ = std::fs::remove_dir_all(&dir);
                dir
            };
            let put = |path: &std::path::Path, body: &str| {
                crate::utils::write_atomic(&path.to_string_lossy(), body).unwrap();
            };

            let ws_empty = temp_ws("empty");
            std::fs::create_dir_all(&ws_empty).unwrap();
            let empty_str = ws_empty.to_string_lossy().replace('\\', "/");

            // 满工作区：11/12 = 真卷；14 = 空壳（清单无行）；13.json = 旧化石/删除残留
            let ws_full = temp_ws("full");
            std::fs::create_dir_all(&ws_full).unwrap();
            let full_str = ws_full.to_string_lossy().replace('\\', "/");
            let sessions_dir = crate::commands::filesystem::workspace_sessions_root(&full_str);
            std::fs::create_dir_all(&sessions_dir).unwrap();
            put(
                &sessions_dir.join("11.ndjson"),
                r#"{"type":"session","version":1,"id":11}"#,
            );
            put(
                &sessions_dir.join("12.ndjson"),
                r#"{"type":"session","version":1,"id":12}"#,
            );
            put(
                &sessions_dir.join("14.ndjson"),
                r#"{"type":"session","version":1,"id":14}"#,
            );
            put(
                &sessions_dir.join("13.json"),
                r#"{"id":13,"label":"fossil","savedAt":"2026-09-19T17:08:38Z"}"#,
            );
            put(
                &sessions_dir.join("_index.json"),
                r#"{"ver":2,"rows":{"11":{"label":"a","savedAt":"2026-08-26T00:00:00Z","msgCount":3},"12":{"label":"b","savedAt":"2026-08-26T01:00:00Z","msgCount":4}}}"#,
            );

            // 旧工作区：只有 Phase 3b 之前的 `.json` 化石（画布也读不出来）→ 0 卷
            let ws_legacy = temp_ws("legacy");
            std::fs::create_dir_all(&ws_legacy).unwrap();
            let legacy_str = ws_legacy.to_string_lossy().replace('\\', "/");
            let legacy_dir = crate::commands::filesystem::workspace_sessions_root(&legacy_str);
            std::fs::create_dir_all(&legacy_dir).unwrap();
            put(
                &legacy_dir.join("5.json"),
                r#"{"id":5,"label":"old","savedAt":"2026-09-01T00:00:00Z"}"#,
            );

            // 清单缺席的工作区：退回文件口径（ndjson 在盘上就算），最近取 mtime
            let ws_no_index = temp_ws("noindex");
            std::fs::create_dir_all(&ws_no_index).unwrap();
            let no_index_str = ws_no_index.to_string_lossy().replace('\\', "/");
            let no_index_dir = crate::commands::filesystem::workspace_sessions_root(&no_index_str);
            std::fs::create_dir_all(&no_index_dir).unwrap();
            put(
                &no_index_dir.join("31.ndjson"),
                r#"{"type":"session","version":1,"id":31}"#,
            );

            with_temp_home(|| {
                for p in [&empty_str, &full_str, &legacy_str, &no_index_str] {
                    register(p, None).unwrap();
                }

                let list = list().unwrap();
                let find = |path: &str| list.iter().find(|w| w.path == path).unwrap();

                // 空工作区也在列（注册表来源，计数 0）
                let empty = find(&empty_str);
                assert_eq!(empty.session_count, 0, "空工作区可见且计数 0");
                assert!(empty.dir_exists, "真实落盘的工作区 dir_exists=true");

                // 真卷计数 = 2（13.json 化石不算、14.ndjson 空壳不算）；最近取清单行
                let full = find(&full_str);
                assert_eq!(full.session_count, 2, ".ndjson 真卷才算卷");
                assert_eq!(
                    full.latest_saved_at.as_deref(),
                    Some("2026-08-26T01:00:00Z"),
                    "最近落盘时间取清单投影 savedAt"
                );
                assert!(full.dir_exists);

                // 只有旧 `.json` 化石 = 0 卷（画布同样不认）
                assert_eq!(find(&legacy_str).session_count, 0, "旧 .json 化石不算卷");
                assert_eq!(find(&legacy_str).latest_saved_at, None);

                // 清单缺席：退回文件口径（不至于把历史工作区显示成 0 卷）
                let no_index = find(&no_index_str);
                assert_eq!(no_index.session_count, 1, "清单缺席时按 .ndjson 计数");
                assert!(no_index.latest_saved_at.is_some(), "清单缺席时最近取 mtime");
            });
            for d in [&ws_empty, &ws_full, &ws_legacy, &ws_no_index] {
                let _ = std::fs::remove_dir_all(d);
            }
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
                register(&ws_str, None).unwrap();
                // 新模型（workspace-session-ownership-rework）：会话在
                // {ws}/.lantai/sessions/ 下——删除 = 删该目录
                let sessions_dir = crate::commands::filesystem::workspace_sessions_root(&ws_str);
                std::fs::create_dir_all(&sessions_dir).unwrap();
                std::fs::write(sessions_dir.join("21.ndjson"), r#"{"type":"session","version":1,"id":21}"#).unwrap();
                std::fs::write(sessions_dir.join("22.ndjson"), r#"{"type":"session","version":1,"id":22}"#).unwrap();

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
                register(&ws_str, None).unwrap();
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
                register(&ws_str, None).unwrap();
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

use serde_json::{json, Value};
use tracing::info;
use crate::analysis::*;
use crate::engine;
use hologram_graph::Node;
use crate::tools::handlers::{strip_loc_suffix, LspCheck, lsp_has_real_reference};
use crate::tools::{get_usize, project_root, with_store};
use crate::tools::ToolResponse;

pub(crate) fn handler_status(_args: &Value) -> ToolResponse {
    // LSP 舰队治理（2026-09-09 宿主共享化）：
    // 1) 宿主（hologram-lspd）在线 → 舰队归宿主，本地不 warm 不杀，
    //    状态合并宿主面（shared_fleet 标记）；本地池若有残留先收敛掉。
    // 2) 宿主离线 → 本地池自治（未初始化/换根时预热，按已索引扩展名过滤）。
    let (lsp, fleet_shared): (Vec<serde_json::Value>, bool) = {
        let proj = project_root();
        let root = if proj.as_os_str().is_empty() {
            std::env::current_dir().unwrap_or_default()
        } else {
            proj
        };
        let root_str = root.to_string_lossy().to_string();
        if crate::lsp_manager::LspManager::ensure_daemon(&root_str) {
            // 宿主接管：本地池残留（宿主曾离线时的回退舰队）收敛掉，
            // 防双舰队并存；标记初始化让本地 op 走宿主路径。
            if crate::lsp_manager::LspManager::local_pool_nonempty() {
                info!("[lsp_manager] daemon owns fleet, draining local pool");
                crate::lsp_manager::LspManager::shutdown_all();
            }
            crate::lsp_manager::LspManager::mark_initialized(&root_str);
            match crate::lsp_manager::LspManager::daemon_lsp_status(&root_str) {
                Some(status) => (status, true),
                None => (crate::lsp_manager::LspManager::lsp_status(), false),
            }
        } else {
            let root_changed = crate::lsp_manager::LspManager::root_changed(&root_str);
            if !crate::lsp_manager::LspManager::is_initialized() || root_changed {
                if root_changed {
                    // 工作区切换：先杀旧工作区的 LSP 服务器再预热新池
                    //（旧池进程继续活着 = 浪费内存 + 用旧根解析新查询）。
                    crate::lsp_manager::LspManager::shutdown_all();
                }
                let mut lsp_exts: Vec<String> = Vec::new();
                let _ = engine::engine_read(|idx| {
                    for node in idx.nodes_iter() {
                        if let Some(file) = node.file() {
                            if let Some(ext) = std::path::Path::new(file)
                                .extension()
                                .and_then(|e| e.to_str())
                            {
                                let ext = ext.to_ascii_lowercase();
                                if !lsp_exts.contains(&ext) {
                                    lsp_exts.push(ext);
                                }
                            }
                        }
                    }
                });
                std::thread::spawn(move || {
                    if lsp_exts.is_empty() {
                        // 尚无索引（首次打开/分析中）：不再全量 warm——
                        // 无过滤 spawn 全部 9 个服务器是多窗口并行时的内存
                        // 炸弹（2026-09-09 事故：6 引擎 × 全套舰队打爆 16GB
                        // 提交内存）。只标记初始化，查询到来时经
                        // get_or_warm_server 惰性拉起被查询的那一门语言。
                        crate::lsp_manager::LspManager::mark_initialized(&root_str);
                    } else {
                        let ext_filter: Vec<&str> = lsp_exts.iter().map(|s| s.as_str()).collect();
                        crate::lsp_manager::LspManager::warm_filtered(&root_str, &ext_filter);
                    }
                });
            }
            (crate::lsp_manager::LspManager::lsp_status(), false)
        }
    };
    // #5 同源纪律：`missing` 只装**真的用不上**的（没装 / 起不来）。
    // 「装了但从没被用过」是懒加载的正常初态（`never-warmed`）——把它算进 missing
    // 就会让读的人（含模型）去装一个已经装好的服务器（2026-09-25 实测病灶）。
    let lsp_available: Vec<&str> = lsp
        .iter()
        .filter(|s| s["state"].as_str() == Some("ready"))
        .map(|s| s["language_id"].as_str().unwrap_or(""))
        .collect();
    let lsp_missing: Vec<&str> = lsp
        .iter()
        .filter(|s| matches!(s["state"].as_str(), Some("not-installed") | Some("failed")))
        .map(|s| s["language_id"].as_str().unwrap_or(""))
        .collect();
    let lsp_installed_idle: Vec<&str> = lsp
        .iter()
        .filter(|s| matches!(s["state"].as_str(), Some("never-warmed") | Some("warming")))
        .map(|s| s["language_id"].as_str().unwrap_or(""))
        .collect();
    let lsp_data = json!({
        "shared_fleet": fleet_shared,
        "available": lsp_available,
        "missing": lsp_missing,
        // 装了但本进程还没用上（懒加载正常初态）——**不是**缺件，别据此去装东西
        "installed_idle": lsp_installed_idle,
        "servers": lsp,
    });

    let state = engine::engine_state();
    match engine::engine_read(|idx| (idx.node_count(), idx.edge_count(), idx.has_aux_indexes())) {
        Ok((nodes, edges, has_aux)) => {
            let phase = match state {
                engine::EngineState::Ready { .. } => "ready",
                engine::EngineState::Analyzing { .. } => "analyzing",
                engine::EngineState::Loading { .. } => "loading",
                engine::EngineState::Uninitialized => "empty",
                engine::EngineState::Error(_) => "error",
            };
            let is_watching = engine::with_engine(|eng| eng.is_watching()).unwrap_or(false);
            let vi_path = hologram_graph::data_dir(&project_root()).join("vectors.usearch");
            let vi_exists = vi_path.exists();
            // 走进程级缓存（mtime 失效）——不再每次 status 调用都从磁盘全量加载索引
            let vi_count = if vi_exists {
                hologram_vector::get_or_load_index(&project_root())
                    .map(|(_, slots)| slots.read().unwrap_or_else(|e| e.into_inner()).len())
                    .unwrap_or(0)
            } else { 0 };
            // #8：向量索引滞后告警——把 `nodes` 与 `vectors` 两个数**显式比对**。
            // 此前两数并列摆着却不报警：没有任何人知道语义搜索在旧快照上跑
            // （2026-09-25 实测：图 22244 / 索引 21760，差 484 无人发现）。
            let (vi_lag, vi_warnings) = vector_lag_warnings(phase, nodes, vi_exists, vi_count);
            ToolResponse::Success(json!({
                "phase": phase,
                // 改名（原 "store"）：旧名易被读成「图只在内存」——它实际指**当前活跃读索引**；
                // 图持久化在 SQLite（`<data_dir>/hologram.db`），索引只是加速读的内存结构。
                "active_index": "MemoryIndex",
                "nodes": nodes,
                "edges": edges,
                "has_aux_indexes": has_aux,
                "is_watching": is_watching,
                "vector_index": {
                    "exists": vi_exists,
                    "vectors": vi_count,
                    "lag_nodes": vi_lag,
                    "stale": vi_lag != 0,
                    "backend": hologram_vector::backend_id(),
                },
                // 空数组 = 无告警（异常才非空——「错误不静默」）
                "warnings": vi_warnings,
                "lsp": lsp_data,
                // 图工具使用率观测：Agent 是否真的在用图（装饰品检测）
                "tool_call_counts": crate::tools::tool_call_counts(),
                "contract": crate::contract::engine_contract_info(),
                // 免编译扩展面（Phase 4）：已装载 manifest 扩展 + 逐文件装载错误
                "extensions": crate::plugins::extensions_status(),
            }))
        }
        Err(_) => ToolResponse::Success(json!({
            "phase": "empty",
            "active_index": "none",
            "nodes": 0,
            "edges": 0,
            "lsp": lsp_data,
            "warnings": [],
            "tool_call_counts": crate::tools::tool_call_counts(),
            "contract": crate::contract::engine_contract_info(),
            "extensions": crate::plugins::extensions_status(),
        })),
    }
}

/// 向量索引滞后判定（#8）——返回 `(lag_nodes, warnings)`。
///
/// 判据：`图节点数 − 索引向量数`。>0 = 索引落后（语义搜索跑在旧快照上）；
/// <0 = 索引比图新（图被重建/清空过而索引没跟上）；0 = 对齐。
///
/// `phase != ready` 时滞后**是预期**（analyze 的后台重建线程在跑）——照实报数，
/// 但文案说明「分析中，属预期」，避免把正常中间态报成故障。
fn vector_lag_warnings(phase: &str, nodes: usize, vi_exists: bool, vi_count: usize) -> (i64, Vec<String>) {
    if !vi_exists {
        return (
            nodes as i64,
            vec![
                "vector index file missing — semantic search has no index yet; it is built in the \
                 background after analyze_project finishes"
                    .to_string(),
            ],
        );
    }
    let lag = nodes as i64 - vi_count as i64;
    if lag == 0 {
        return (0, Vec::new());
    }
    let warn = if phase != "ready" {
        format!(
            "vector index lags the graph by {lag} nodes while analysis is in progress (phase={phase}) \
             — expected; re-check after the analysis finishes"
        )
    } else {
        format!(
            "semantic search is running on a STALE snapshot: graph has {nodes} nodes but vectors.usearch \
             holds {vi_count} (lag {lag}). The index rebuilds in the background after analyze_project — if \
             this persists, the rebuild did not finish (the engine process may have been recycled mid-build; \
             see engine logs)"
        )
    };
    (lag, vec![warn])
}

pub(crate) fn handler_policy_check(args: &Value) -> ToolResponse {
    let rules: Value = if let Some(r) = args.get("rules").cloned() {
        r
    } else if let (Some(source), Some(target)) = (
        args.get("source").and_then(|v| v.as_str()),
        args.get("target").and_then(|v| v.as_str()),
    ) {
        let mut rule = json!({
            "name": "ad-hoc",
            "source": source,
            "target": target,
            "message": format!("{} -> {} dependency violation", source, target),
        });
        if let Some(kinds) = args.get("edge_kinds") {
            rule["edge_kinds"] = kinds.clone();
        }
        json!([rule])
    } else {
        return ToolResponse::Degraded {
            guidance: "Provide either 'rules' (array of rule objects) or both 'source' and 'target' (string patterns).".into(),
            fallback: "Define boundary rules with source/target file patterns".into(),
            details: json!({}),
        };
    };
    ToolResponse::Success(with_store(|idx| policy_check_from_index(idx, &rules)))
}


fn is_entry_point(node: &Node) -> bool {
    let name = &node.name;
    let raw_loc = node.location.as_deref().unwrap_or("");
    let loc = strip_loc_suffix(raw_loc);

    // 二进制入口点（任何语言的 main）
    if name == "main" {
        return true;
    }
    // 类构造函数（在 JS/TS 中通过 `new` 关键字调用）
    if name == "constructor" || name.ends_with(".constructor") {
        return true;
    }
    // 测试函数（由测试框架动态发现）
    if name.starts_with("test_") || name.ends_with("_test") || name.ends_with("Test") {
        return true;
    }
    // Tauri 命令分发器（通过 #[command] 宏注册）
    if name == "rpc" && loc.contains("rpc.rs") {
        return true;
    }
    // 引擎流水线入口
    if name == "run_pipeline" {
        return true;
    }
    // Tauri 命令处理器模块（在 commands/ 目录中，由宏注册）
    if loc.contains("/commands/") || loc.contains("\\commands\\") {
        return true;
    }
    // React/Vue 组件入口点
    if name == "App" && (loc.ends_with("App.tsx") || loc.ends_with("App.ts")) {
        return true;
    }
    // 框架初始化/引导函数
    if name == "init" && node.out_degree > 3 {
        return true;
    }
    // ponytail：跨语言的常见入口点名称模式。
    // 这些函数由框架/CLI/测试运行器调用，
    // 而非通过直接的 CALLS 边 —— 静态分析无法看到它们。
    const ENTRY_PATTERNS: &[&str] = &[
        "handle", "process", "run", "start", "stop", "serve",
        "migrate", "setup", "teardown", "bootstrap", "execute",
        "configure", "initialize", "load",
    ];
    let name_lower = name.to_lowercase();
    for pat in ENTRY_PATTERNS {
        if name_lower.starts_with(pat) || name_lower.ends_with(pat) {
            return true;
        }
    }
    false
}

/// 检查节点名称是否为 mock/stub 测试夹具。
/// 这些由测试框架连接引用，而非直接的 CALLS 边。
fn is_mock_or_stub(name: &str) -> bool {
    // mockSomething, MockXxx, createMockXxx
    if name.starts_with("mock") || name.starts_with("Mock") || name.starts_with("createMock") {
        return true;
    }
    // somethingMock, dbStub, s3Fake, userSpy（这些是代码标识符，保留英文）
    for suffix in &["Mock", "Stub", "Fake", "Spy"] {
        if name.ends_with(suffix) {
            return true;
        }
    }
    false
}

/// 通过元类/DI/框架魔法实例化的框架基类，
/// 而非通过直接的 CALLS 边。继承自其中之一意味着该类是
/// 框架管理的 —— 不是死代码。
fn is_framework_base(name: &str) -> bool {
    matches!(
        name,
        // Python ORM / Pydantic
        "Base" | "DeclarativeBase" | "Model" | "BaseModel" | "BaseSettings"
        | "db.Model" | "TableBase"
        // AWS CDK / IaC 构造
        | "Stack" | "NestedStack" | "Construct" | "Resource"
        // Django REST / DRF
        | "Serializer" | "ViewSet" | "ModelViewSet"
        // Android / 移动端
        | "Activity" | "Fragment" | "ViewModel" | "Service"
        // Spring / Java EE
        | "Application" | "Configuration"
    )
}

/// React/Vue/Android 生命周期方法 —— 由框架调用，
/// 从不通过直接的 CALLS 边。
fn is_lifecycle_method(name: &str) -> bool {
    matches!(
        name,
        "render" | "componentDidMount" | "componentWillUnmount" | "componentDidUpdate"
        | "shouldComponentUpdate" | "getDerivedStateFromProps" | "getSnapshotBeforeUpdate"
        | "mounted" | "created" | "destroyed" | "beforeMount" | "beforeDestroy"
        | "updated" | "activated" | "deactivated"
        | "onCreate" | "onDestroy" | "onStart" | "onStop" | "onResume" | "onPause"
        | "ngOnInit" | "ngOnDestroy" | "ngOnChanges" | "ngAfterViewInit"
    )
}

pub(crate) fn handler_unused(args: &Value) -> ToolResponse {
    let limit = get_usize(args, "limit", 20).min(200);
    let kind_str = args
        .get("kind_filter")
        .and_then(|v| v.as_str())
        .unwrap_or("function,class");
    let kind_label = kind_str.to_string();
    let kinds: Vec<&str> = kind_str.split(',').map(|s| s.trim()).collect();

    // ponytail：先在读锁内收集候选（轻量快照），锁外做 LSP 验证。
    // LSP references 可能触发 server warm（耗时数百 ms），不能持图锁。
    let mut candidates: Vec<Value> = match engine::engine_read(|idx| {
        idx.nodes_iter()
            .filter(|n| {
                n.non_defines_in_degree == 0
                    && kinds.iter().any(|k| n.kind.as_str() == *k)
                    && !is_entry_point(n)
                    && !is_mock_or_stub(&n.name)
                    && !is_framework_base(&n.name)
                    && !is_lifecycle_method(&n.name)
            })
            .map(|n| json!({
                "id": n.id,
                "name": n.name,
                "kind": n.kind.as_str(),
                "location": n.location,
                "out_degree": n.out_degree,
                "in_degree": n.in_degree,
                "non_defines_in_degree": n.non_defines_in_degree,
                "community_id": n.community_id,
            }))
            .collect()
    }) {
        Ok(v) => v,
        Err(e) => return ToolResponse::Degraded {
            guidance: format!("cannot access graph: {}", e),
            fallback: "Ensure the project has been analyzed first".into(),
            details: json!({}),
        },
    };

    // LSP 验证：对能定位到源码位置的候选查 references，
    // 有非定义引用（如 React JSX/对象属性使用）则不是死代码。
    // 这修复名字匹配失败导致的误报 —— 图上看不到引用，但
    // 类型系统（LSP）能确认它被使用。
    //
    // 防护：只验证 out_degree 最高的前 LSP_VERIFY_LIMIT 个候选
    // （最可疑的优先），避免批量 open_file+references 把 LSP server
    // 打崩；且任一次查询失败即停止（server 不可用时反复重试只会
    // 浪费时间），失败的候选按原判断保留。
    const LSP_VERIFY_LIMIT: usize = 50;
    candidates.sort_by_key(|n| std::cmp::Reverse(n["out_degree"].as_u64().unwrap_or(0)));
    let verify_count = candidates.len().min(LSP_VERIFY_LIMIT);
    let mut lsp_verified_removed = 0usize;
    let mut verified: Vec<Value> = Vec::with_capacity(candidates.len());
    for (i, cand) in candidates.iter().enumerate() {
        if i < verify_count {
            let loc = cand["location"].as_str().unwrap_or("");
            let name = cand["name"].as_str().unwrap_or("");
            match lsp_has_real_reference(loc, name) {
                LspCheck::HasReference => {
                    lsp_verified_removed += 1;
                    continue;
                }
                LspCheck::NoReference => {}
                LspCheck::Unavailable => {
                    // LSP 挂了——停止验证，剩余候选全部保留
                    verified.push(cand.clone());
                    verified.extend(candidates[i + 1..].iter().cloned());
                    break;
                }
            }
        }
        verified.push(cand.clone());
    }

    verified.sort_by_key(|n| std::cmp::Reverse(n["out_degree"].as_u64().unwrap_or(0)));
    let total = verified.len();
    verified.truncate(limit);
    ToolResponse::Success(json!({
        "total_unused": total,
        "limit": limit,
        "kind_filter": kind_label,
        "lsp_verified_removed": lsp_verified_removed,
        "unused": verified,
    }))
}

#[cfg(test)]
mod tests {
    use super::vector_lag_warnings;

    /// #8：`nodes` 与 `vectors` 不一致必须**出告警**。
    ///
    /// 此前 ops(status) 把两个数并列摆着却不报警——没有任何人知道语义搜索
    /// 在旧快照上跑（2026-09-25 实测：图 22244 / 索引 21760，差 484 无人发现）。
    #[test]
    fn vector_lag_warns_when_index_and_graph_disagree() {
        // 对齐 → 无告警（空数组 = 健康，不是「没检查」）
        assert_eq!(vector_lag_warnings("ready", 100, true, 100), (0, Vec::<String>::new()));
        // 索引落后（实测形状）：lag>0 + 告警带上两个数与差值
        let (lag, w) = vector_lag_warnings("ready", 22244, true, 21760);
        assert_eq!(lag, 484);
        assert_eq!(w.len(), 1);
        assert!(w[0].contains("STALE"), "{}", w[0]);
        assert!(w[0].contains("22244") && w[0].contains("21760"), "{}", w[0]);
        // 索引比图新（图被重建/清空过）同样是不一致——负 lag 也要报
        let (lag, w) = vector_lag_warnings("ready", 10, true, 20);
        assert_eq!(lag, -10);
        assert_eq!(w.len(), 1);
        // 分析中：照实报数，但文案说明属预期（别把正常中间态报成故障）
        let (lag, w) = vector_lag_warnings("analyzing", 100, true, 10);
        assert_eq!(lag, 90);
        assert!(w[0].contains("expected") && w[0].contains("analyzing"), "{}", w[0]);
        assert!(!w[0].contains("STALE"), "分析中不该报 STALE：{}", w[0]);
        // 索引文件缺席 → 告警且 lag = 全部节点
        let (lag, w) = vector_lag_warnings("ready", 100, false, 0);
        assert_eq!(lag, 100);
        assert!(w[0].contains("missing"), "{}", w[0]);
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 引擎开放面契约（engine-plugin-extraction Phase 0）。
//!
//! 机制三件（镜像 TS 组合层 `OPEN_SURFACE_CONTRACT_VERSION` 的纪律）：
//!   1. `ENGINE_CONTRACT_VERSION` —— 契约当前版本（整数递增，变更即 +1）；
//!   2. `ENGINE_CONTRACT_FILES` —— 契约面物理载体清单（指纹 guard 消费：
//!      `contract_face_fingerprint_matches` 对拍 `CONTRACT_FACE_FINGERPRINT`，
//!      文件内容变更而指纹未更新 = `cargo test` 红）；
//!   3. `SHELL_METHODS` —— **壳专属方法清单**（host API，永不进模型
//!      `tools/list`；模型工具面真源 = `tools/mod.rs` 的 `DOMAIN_SPECS`
//!      （可见面，契约 v5 域折叠）+ `DEFAULT_MCP_TOOLS`（可寻址面））。
//!
//! 本契约是「引擎 = 独立插件，兰台 / DSH / 任意 MCP 客户端消费同一二进制」
//! 的对外承诺面：任何形状变更（工具名 / schema / 输出形态 / 新增壳方法）
//! 必须显式升版 + 记录，不得静默改约。

/// 引擎开放面契约当前版本（变更即 +1）。
///
/// v2（2026-08-29 复盘修订）：砍图分页——分页只为已退役 3D 星图 + IPC 128MB
/// 护栏服务的双重死代码，整链删除（计划 Phase 1.5）。删 `get_graph_page` /
/// `graph_meta` / `get_full_graph` 三个分页/全量转储方法，新增
/// `graph_snapshot`（聚合快照）+ `file_nodes`（按文件符号索引）——
/// graphData 的三个消费面（快照聚合 / 文件索引 / 就绪开关）全是查询不是传输。
///
/// v3（2026-08-29 Phase 3 摘依赖）：新增 `run_check`（第 11 个壳方法）——
/// 简报编排真源（基线 load/diff/save + 时间线记录）从壳层上收引擎；
/// `analyze_with_progress` 增加 `force` 参数（缓存新鲜度门上收：
/// 新鲜即返回 cached，杜绝壳侧重复判定）。
///
/// v4（2026-08-29 Phase 4 免编译扩展面）：①新增 `plugins` 模块——
/// `HOLOGRAM_PLUGIN_DIR` 指向扩展目录（缺省 `<project_root>/plugins`），
/// manifest yaml 声明 language（扩展名表 + builtin/dll 语法 + 运行时 .scm 查询）/
/// framework（路由候选模式）/ tool（schema + handler id 复用既有 handler）三类扩展，
/// `engine_init` 首行装载；②`engine_status` 新增 `extensions` 字段
/// （已装载清单 + 逐文件装载错误）；③模型 `tools/list` 缺省面 = DEFAULT_MCP_TOOLS
/// ∪ manifest 工具（`HOLOGRAM_MCP_TOOLS` 显式白名单优先）；manifest 工具经
/// `tools::builtin_handler` 注册表按 id 复用既有 handler，壳专属方法不入表。
/// 免编译扩展自身的破坏性兼容由 manifest 文件的 `manifest_version` 管控。
///
/// v5（2026-09-18 工具面收敛）：模型 `tools/list` 缺省面从「36 个扁平工具」
/// 折叠为「**域 + action 枚举**」——
///   ① 只读工具折成 4 个域：`graph`(10 动作) / `analysis`(15) / `lsp`(4) / `ops`(4)；
///      写工具（`analyze_project` / `import_scip` / `rename_symbol`）留在顶层
///      ——MCP 只读注解只能声明到工具粒度，读写混装的域会被宿主 fail-closed
///      判为写（plan 门禁连带拦掉同域的只读动作）；
///   ② 调用面 `tools/call("graph", {"action":"impact", ...})`：域名进 dispatch
///      一层 action→handler 路由，`action` 键不进 handler；action 缺失/未知
///      给 Degraded 引导（含合法动作清单），不静默兜底；
///   ③ **底层工具名一个不删**：schema 全留、`tools/call` 原名直达（壳与外部
///      MCP 客户端零破坏）；后续工具建议改按可见面折算（`graph(impact)` 形态，
///      不再回吐被折叠的裸名）；
///   ④ 只读语义改发 **MCP 标准注解** `annotations.readOnlyHint`——旧的非标准
///      顶层 `readOnly` 删除（宿主只认 annotations，该键零消费方）；
///   ⑤ `HOLOGRAM_MCP_TOOLS` 三档语义：未设 = 折叠面 / `*` = 全量原名（**壳专属
///      方法除外**——旧实现会把 host API 一并列出，本版修正为契约本意）/
///      显式名单 = 严格名单（条目可为原名或域名 = 整域）。
/// 真源：`tools/mod.rs` 的 `DOMAIN_SPECS`（域表）+ `DEFAULT_MCP_TOOLS`
/// （可寻址面）+ `SurfaceMode`（可见面三档）。
///
/// v6（2026-09-18 折叠面收口）：v5 落地后复盘，三处收口——
///   ① **删除 `HOLOGRAM_MCP_TOOLS` 三档**（v5 的 ⑤）：它是给 36 个扁平工具做
///      白名单裁剪的开关，折叠成 7 个之后用途消失；且全仓无宿主能设它
///      （插件 manifest 与用户 mcp.json 的 schema 都没有 env 字段），
///      留着就是一个只有系统环境变量能碰、界面不可见的隐形开关。
///      可见面自此**恒定折叠面**；要不要给模型看某个工具 = 宿主组合层的事。
///      退役开关仍在设时留 warn（不静默忽略）；原名 `tools/call` 直达不变。
///   ② **新增保留动作 `action=help`**（每个域自带）：回该域全部动作的完整
///      说明书（动作名 / 原名 / 完整 description / 参数表 / required，取自
///      ToolSchema 单一真源）。折叠因此**无损**——被挪走的原文可按需取回。
///   ③ **动作 hint 补前置纪律**：把原文里「何时用 / 用之前先做什么 / 下一步去哪」
///      压进 40-240 字的迷你说明书，并由测试钉住下限与上限（不许退化成词，
///      也不许把完整说明书抄回常驻上下文）。
/// v7（2026-09-22 契约面内容纪律）：**形状零变更**——只为让 CI 过而清掉
/// `tools/mod.rs` 顶层那条用不到的 `HashSet` import（它只在 `#[cfg(test)] mod tests`
/// 里用裸名，非测试段一律全限定 `std::collections::HashSet`）。
/// 指纹 guard 是**按内容**算的（任一契约面文件动一个字节即红），所以这一步照样要走
/// 全套纪律；版本号 +1 因此只是「本文件被触碰」的记账，**不构成任何对宿主的形状承诺
/// 变化**——工具名 / schema / 输出形态 / 壳方法清单一律照旧，消费方无需跟改。
/// 连带记一条本地门禁的裂缝：CI 的 `actions-rust-lang/setup-rust-toolchain@v1` 默认塞
/// `RUSTFLAGS=-D warnings`，本机 `.cargo/config.toml` 没有这条——于是同一个文件本地是
/// warning、CI 是 error；**本地 `cargo test` 全绿并不代表 CI 绿**。
/// v8（macOS 动态语法面修复）：**模型工具面形状零变更**——工具名 / schema /
/// 输出形态 / 壳方法清单照旧，消费方无需跟改；本版修的是**非 MCP 面**的
/// 一条 macOS 静默失效路径，因 `grammar_loader.rs` 属契约面（语法加载能力
/// 是「同一二进制跨宿主消费」承诺的一部分）而连带升版。
///   ① `GrammarLoader::scan_dir` 的平台后缀判定原本只有两档——`cfg!(windows)`
///      → `.dll`，其余 → `.so`。而 `grammars/build.sh` 在 Darwin 上产出的后缀是
///      `.dylib`（该脚本自身的 case 分支与注释都如此声明）。两者对不上，后果是
///      **macOS 上动态语法一个都扫不到**：`kotlin` / `markdown` / `toml` 三个
///      动态语法全部静默退化为「无语法」，既不报错也不留痕，只表现为解析质量
///      下降。本版把后缀真源收敛到新增的 `native_shared_lib_exts()`
///      （Windows .dll / macOS .dylib / 其余 .so），扫描与构建脚本约定同源。
///   ② 候选只列**本平台真会产出**的后缀：Windows 上不把 `.so`/`.dylib` 留在
///      候选里，否则 `tree-sitter-x.dylib.bak` 之类的旁支文件会被误登记为语法。
///   ③ `grammars/build.sh` 补上 markdown 语法必需的 `-DTREE_SITTER_MARKDOWN_AVOID_CRASH`
///      ——`build.ps1` 的文件头注释早已声明该 flag 必需，但两个脚本都只在注释里
///      提，实际编译命令都没带；纯 C 的 kotlin / toml 不受影响（解析器自洽，
///      编译期只出 unused-function 警告），markdown 的 C++ scanner 才真正依赖它。
///   备注：本版**不改变** `find_grammar_dir()` 的目录发现顺序，
///   `HOLOGRAM_GRAMMAR_DIR` 仍为最高优先级；独立分发时把 `grammars/` 放在
///   二进制同级的约定也不变，只是该目录内 macOS 产物现在能被真正加载。
/// v9（MCP 握手版本号单一真源）：**模型工具面形状零变更**——工具名 / schema /
/// 输出形态 / 壳方法清单一律照旧。修的是 `initialize` 响应里 `serverInfo.version`
/// 的取值来源：
///   · 原实现硬编码字符串 `"4.0.0"`，而同一个二进制的 CLI `--version` 走
///     `env!("CARGO_PKG_VERSION")`（彼时 1.0.1）——**同一个引擎从两条路报出两个
///     版本号**。宿主侧诊断、问题反馈、兼容性判断都会读到这个字段，取值不一致
///     只会让归因更难，Rust 侧实测定为：`--version` → "HoloGram Engine 1.0.1"，
///     MCP `initialize` → serverInfo.version "4.0.0"。
///   · 现改为 `env!("CARGO_PKG_VERSION")`，单一真源 = `engine/Cargo.toml`
///     的 `package.version`，与 `--version`、以及插件侧下载产物所用的
///     Release tag（`v<version>`）三处自此同源。
///   消费方无需跟改：`serverInfo.version` 本来就是自由字符串，本版只是让它
///   从「错的常量」变成「对的值」。
pub const ENGINE_CONTRACT_VERSION: u32 = 9;

/// 契约面物理载体（相对仓库根）。指纹 guard（本文件的
/// `contract_face_fingerprint_matches`）对拍 `CONTRACT_FACE_FINGERPRINT`：
/// 任一文件内容变更而指纹未更新 = `cargo test` 红，强制显式升版 + 记录。
pub const ENGINE_CONTRACT_FILES: &[&str] = &[
    "engine/src/contract.rs",
    "engine/src/tools/mod.rs",
    "engine/src/tools/response.rs",
    "engine/src/mcp.rs",
    "engine/src/adapter/registry.rs",
    "engine/src/adapter/grammar_loader.rs",
    "engine/src/plugins/mod.rs",
    "engine/src/engine/grammar.rs",
];

/// 契约面指纹：`ENGINE_CONTRACT_FILES` 逐文件内容（FNV-1a 64）+ 契约版本的复合。
///
/// 纪律（与组合层 `OPEN_SURFACE_CONTRACT_FILES` 的 sha256 指纹同款）：
/// **改契约面 → 升 `ENGINE_CONTRACT_VERSION` → 更新本常量**，三件事同一 commit。
/// 忘了更新 = `cargo test` 红（`contract_face_fingerprint_matches` 会打印新指纹）。
///
/// 实现细节：换行归一（CRLF→LF）——工作树 EOL 因 `.gitattributes` 归一而可能
/// 与索引不同，指纹必须跟着**仓库内容**走；contract.rs 自身在哈希前剔除本行
/// （自指），其余内容照常参与。
pub const CONTRACT_FACE_FINGERPRINT: &str = "a7bb41aeb712a0f3";

/// 壳专属方法参数（最小形状；Phase 1 接线时并入 dispatch）。
pub struct ShellParam {
    pub name: &'static str,
    pub ptype: &'static str,
    pub description: &'static str,
}

/// 壳专属方法规格：兰台进程外消费面（host API），永不进模型 `tools/list`。
pub struct ShellMethodSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub params: &'static [ShellParam],
    pub read_only: bool,
    /// 接线阶段：phase1 = 引擎侧实现；phase3 = 壳侧 transport 切换后才消费。
    pub wired_in: &'static str,
}

/// 壳专属方法清单（契约 v3；Phase 1 接线 10 个 + Phase 3 增 run_check）。
pub const SHELL_METHODS: &[ShellMethodSpec] = &[
    ShellMethodSpec {
        name: "graph_snapshot",
        description: "聚合快照：节点/边数、社区分布、边类型、top 扇入、类数。壳专属——进程外形态下前端不搬原始图，graphData = 一次轻量查询。",
        params: &[],
        read_only: true,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "file_nodes",
        description: "按文件返回符号索引（id/name/kind/fanIn/fanOut）。壳专属——取代前端全量建索引。",
        params: &[ShellParam { name: "file", ptype: "string", description: "文件路径（相对项目根或绝对）" }],
        read_only: true,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "analyze_with_progress",
        description: "全量分析并持久化，进度经 MCP notifications/progress 推送。force=true 跳过缓存新鲜度门；默认缓存新鲜（非空且未过期）时直接返回 cached 不重分析。壳专属。",
        params: &[
            ShellParam { name: "path", ptype: "string", description: "项目根路径" },
            ShellParam { name: "force", ptype: "boolean", description: "强制全量重分析（默认 false）" },
        ],
        read_only: false,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "save",
        description: "持久化 store 到磁盘（.hologram/hologram.db）。壳专属。",
        params: &[],
        read_only: false,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "fts_search",
        description: "FTS5 全文搜索（内容级，区别于 search_symbols 的符号名模糊）。壳专属。",
        params: &[
            ShellParam { name: "query", ptype: "string", description: "检索词" },
            ShellParam { name: "limit", ptype: "integer", description: "最大条数（默认 20）" },
        ],
        read_only: true,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "timeline_record",
        description: "记录时间线事件（写动作）。壳专属。",
        params: &[
            ShellParam { name: "event", ptype: "string", description: "事件名" },
            ShellParam { name: "detail", ptype: "string", description: "事件摘要（可选，缺省用事件名）" },
            ShellParam { name: "node_id", ptype: "string", description: "关联节点（可选）" },
        ],
        read_only: false,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "diff",
        description: "基线 diff：baseline.json 与当前图比对。壳专属。",
        params: &[ShellParam { name: "baseline_path", ptype: "string", description: "基线文件路径" }],
        read_only: true,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "ensure_ready",
        description: "确保引擎就绪（同根幂等 / 异根报错）。壳专属。",
        params: &[ShellParam { name: "path", ptype: "string", description: "项目根路径" }],
        read_only: true,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "cache_stale",
        description: "缓存是否过期（源码 mtime 与图缓存比对）。壳专属。",
        params: &[ShellParam { name: "path", ptype: "string", description: "项目根路径" }],
        read_only: true,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "watcher_subscribe",
        description: "订阅 watcher 通知（graph-updated 推送，MCP notification）。壳专属。",
        params: &[],
        read_only: false,
        wired_in: "phase1",
    },
    ShellMethodSpec {
        name: "run_check",
        description: "简报检查：基线 load/diff/save + 违规信号 + 时间线记录（quiet/baseline_seed 门）一次完成。编排真源在引擎侧。壳专属。",
        params: &[
            ShellParam { name: "path", ptype: "string", description: "项目根路径（可选，缺省用绑定根；异根拒绝）" },
            ShellParam { name: "changed_files", ptype: "array", description: "自上次检查以来的变更文件列表" },
        ],
        read_only: false,
        wired_in: "phase3",
    },
];

/// 壳专属方法名清单（供 guard / 文档 / 测试消费）。
pub fn shell_method_names() -> Vec<&'static str> {
    SHELL_METHODS.iter().map(|m| m.name).collect()
}

// ── 契约面指纹（guard）────────────────────────────────────────────────

/// FNV-1a 64 位（变更检测够用；不引入新依赖）。
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 计算当前契约面指纹（与 `CONTRACT_FACE_FINGERPRINT` 对拍）。
///
/// 仓库根 = `CARGO_MANIFEST_DIR`（engine/）的父目录；定位不到或文件缺失即
/// Err——guard 失败关闭，不静默跳过（这正是一条「说了没做」的防线）。
pub fn contract_face_fingerprint() -> Result<String, String> {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .parent()
        .ok_or_else(|| format!("定位仓库根失败：{}", manifest.display()))?;

    let mut composite = format!("version:{}\n", ENGINE_CONTRACT_VERSION);
    for rel in ENGINE_CONTRACT_FILES {
        let path = root.join(rel);
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("契约面文件读不到 {}: {e}", path.display()))?;
        // 换行归一：指纹跟仓库内容走，不跟工作树 EOL 走。
        let normalized = raw.replace("\r\n", "\n");
        // 自指剔除：contract.rs 里的指纹常量行不参与哈希。
        let content = if *rel == "engine/src/contract.rs" {
            normalized
                .lines()
                .filter(|l| !l.trim_start().starts_with("pub const CONTRACT_FACE_FINGERPRINT"))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            normalized
        };
        composite.push_str(&format!("{rel}:{:016x}\n", fnv1a64(content.as_bytes())));
    }
    Ok(format!("{:016x}", fnv1a64(composite.as_bytes())))
}

/// 引擎 status 的契约摘要（engine_status 暴露，宿主可探测契约版本）。
pub fn engine_contract_info() -> serde_json::Value {
    let domains: Vec<serde_json::Value> = crate::tools::DOMAIN_SPECS
        .iter()
        .map(|d| {
            serde_json::json!({
                "name": d.name,
                "read_only": d.read_only,
                "actions": d.actions.iter().map(|a| a.action).collect::<Vec<_>>(),
            })
        })
        .collect();
    serde_json::json!({
        "version": ENGINE_CONTRACT_VERSION,
        "files": ENGINE_CONTRACT_FILES,
        // 可寻址面（tools/call 原名直达；v5 起不再等于模型可见面）
        "model_tools_default": crate::tools::ToolRegistry::DEFAULT_MCP_TOOLS.len(),
        // 模型可见默认面（tools/list 缺省）= 域 + 未折叠的默认工具
        "model_surface_default": crate::tools::default_visible_names(),
        "domains": domains,
        "shell_methods": SHELL_METHODS.iter().map(|m| serde_json::json!({
            "name": m.name,
            "read_only": m.read_only,
            "wired_in": m.wired_in,
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::ToolRegistry;
    use std::collections::HashSet;

    #[test]
    fn contract_version_is_set() {
        assert!(ENGINE_CONTRACT_VERSION > 0, "契约版本必须为正整数");
    }

    /// 契约面指纹对拍：改了契约面文件却没升版/没更新指纹 = 红。
    ///
    /// 这是「契约面变更必须显式登记」的机械防线——契约面文件的注释、
    /// schema、壳方法清单、开关语义全在哈希覆盖面内。
    #[test]
    fn contract_face_fingerprint_matches() {
        let actual = contract_face_fingerprint().expect("契约面指纹可算");
        assert_eq!(
            actual.len(),
            16,
            "指纹形态应为 16 位十六进制（FNV-1a 64）"
        );
        assert_eq!(
            actual, CONTRACT_FACE_FINGERPRINT,
            "契约面文件已变更——按契约纪律同 commit 完成三件事：\
             ① 升 ENGINE_CONTRACT_VERSION；② 在本文件 vN 沿革块记录变更；\
             ③ 把本测试断言的 left（实际指纹）抄进 CONTRACT_FACE_FINGERPRINT，\
             再跑 npm run gen:engine-contract 同步生成物文档"
        );
    }

    #[test]
    fn contract_files_nonempty() {
        assert!(!ENGINE_CONTRACT_FILES.is_empty());
    }

    #[test]
    fn shell_method_names_unique_and_nonempty() {
        let names = shell_method_names();
        assert!(!names.is_empty(), "壳专属方法清单不能为空");
        let mut seen = HashSet::new();
        for n in &names {
            assert!(!n.is_empty());
            assert!(seen.insert(*n), "重复的壳专属方法: {n}");
        }
    }

    #[test]
    fn shell_methods_do_not_collide_with_model_tools() {
        let model: HashSet<&str> = ToolRegistry::DEFAULT_MCP_TOOLS.iter().copied().collect();
        for n in shell_method_names() {
            assert!(!model.contains(n), "壳专属方法 {n} 与模型工具冲突");
        }
    }
}

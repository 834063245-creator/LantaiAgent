// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 引擎开放面契约（engine-plugin-extraction Phase 0）。
//!
//! 机制三件（镜像 TS 组合层 `OPEN_SURFACE_CONTRACT_VERSION` 的纪律）：
//!   1. `ENGINE_CONTRACT_VERSION` —— 契约当前版本（整数递增，变更即 +1）；
//!   2. `ENGINE_CONTRACT_FILES` —— 契约面物理载体清单（指纹 guard 消费，
//!      文件变更未升版/未更新指纹 = 红）；
//!   3. `SHELL_METHODS` —— **壳专属方法清单**（host API，永不进模型
//!      `tools/list`；模型工具面单一真源仍是 `tools/mod.rs` 的
//!      `DEFAULT_MCP_TOOLS`）。
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
pub const ENGINE_CONTRACT_VERSION: u32 = 3;

/// 契约面物理载体（相对仓库根）。指纹 guard 对拍：文件变更未升版 = 红。
pub const ENGINE_CONTRACT_FILES: &[&str] = &[
    "engine/src/contract.rs",
    "engine/src/tools/mod.rs",
    "engine/src/tools/response.rs",
    "engine/src/mcp.rs",
    "engine/src/adapter/registry.rs",
    "engine/src/engine/grammar.rs",
];

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
        description: "持久化 store 到磁盘（.lantai/hologram.db）。壳专属。",
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

/// 引擎 status 的契约摘要（engine_status 暴露，宿主可探测契约版本）。
pub fn engine_contract_info() -> serde_json::Value {
    serde_json::json!({
        "version": ENGINE_CONTRACT_VERSION,
        "files": ENGINE_CONTRACT_FILES,
        "model_tools_default": crate::tools::ToolRegistry::DEFAULT_MCP_TOOLS.len(),
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工具注册表 —— 全部 hologram_* 工具的 schema 定义 + 处理器分发。
// 模型可见面（契约 v5）= DOMAIN_SPECS 域表 + 未折叠的默认工具；
// 可寻址面 = DEFAULT_MCP_TOOLS（tools/call 原名直达）。
// 与 MCP 传输层分离，使 Tauri / TCP / CLI 能共享同一套工具层。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde_json::{json, Value};

use crate::engine;
use crate::engine::GRAMMAR_LOADER;
use hologram_graph::{Edge, Graph, Node};
use crate::pipeline::discovery::discover_files;
use hologram_storage::MemoryIndex;

// ═══════════════════════════════════════════════════════════════
// ToolSchema — 单个工具的元数据
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
pub struct ToolSchema {
    pub name: &'static str,
    pub description: &'static str,
    pub params: &'static [ParamDef],
    pub required: &'static [&'static str],
    pub read_only: bool,
    pub category: &'static str,
}

#[derive(Debug, Clone)]
pub struct ParamDef {
    pub name: &'static str,
    pub ptype: &'static str,
    pub description: &'static str,
    /// 枚举约束（可选）：非空时 inputSchema 附带 enum，把合法值从 description
    /// 文本约定升级为机器可校验约束 —— 降低 LLM 猜错参数值的概率。
    pub enum_values: &'static [&'static str],
}

impl ToolSchema {
    fn mcp_value(&self) -> Value {
        let mut properties = serde_json::Map::new();
        for p in self.params {
            let mut prop = serde_json::Map::new();
            prop.insert("type".to_string(), json!(p.ptype));
            prop.insert("description".to_string(), json!(p.description));
            if !p.enum_values.is_empty() {
                prop.insert("enum".to_string(), json!(p.enum_values));
            }
            properties.insert(p.name.to_string(), Value::Object(prop));
        }
        let required: Vec<Value> = self.required.iter().map(|r| json!(r)).collect();
        json!({
            "name": self.name,
            "description": self.description,
            // MCP 标准只读注解：宿主（兰台 plan 门禁 / 只读并行组）认 annotations.readOnlyHint；
            // 旧的非标准顶层 readOnly 已随契约 v5 删除（无消费方的第二写点）。
            "annotations": { "readOnlyHint": self.read_only },
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": required,
            }
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// 域工具（DomainSpec —— 契约 v5）
// ═══════════════════════════════════════════════════════════════
//
// 模型可见面从「36 个扁平工具」收敛为「域 + action 枚举」（2026-09-18）：
//   ① 只读工具按域折叠（graph / analysis / lsp / ops）；
//   ② 写工具（analyze_project / import_scip / rename_symbol）保持顶层——
//      MCP 只读注解只能声明到工具粒度，读写混装的域会被宿主 fail-closed 判为写，
//      plan 门禁连带拦掉同域的只读动作；
//   ③ 底层工具名一个不删：schema 仍在 all_schemas、tools/call 原名直达
//      （壳 / 外部 MCP 客户端零破坏）。
// 域 schema 的参数说明不另抄一份——properties 由成员工具的 ParamDef 派生
// （单一权威源）；「每个动作干什么、何时用」由 action hint 短句承载。

/// 域内一个动作：模型传 `action=<action>`，引擎路由到 `tool`。
pub struct DomainAction {
    pub action: &'static str,
    pub tool: &'static str,
    pub hint: &'static str,
}

/// 域工具（模型可见面的折叠单元；契约 v5）。
pub struct DomainSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub read_only: bool,
    pub actions: &'static [DomainAction],
}

/// 出厂域表：域 ∪ 未折叠的默认工具 = tools/list 默认返回面。
///
/// guard（测试）钉住：默认面里每个只读工具恰好是一个域动作、写工具必须留在顶层、
/// 域内同名参数类型一致（域 schema 不许对模型说谎）。
pub const DOMAIN_SPECS: &[DomainSpec] = &[
    DomainSpec {
        name: "graph",
        description: "Code knowledge-graph queries (27 languages, AST + symbol-level edges). Pick the action matching your question — symbol lookup, dependency direction, blast radius, architecture shape. **改代码前先问图**: grep sees text, the graph sees structure. All actions read-only. Raw per-tool names (search_symbols / trace_impact / ...) stay callable via tools/call.",
        read_only: true,
        actions: &[
            DomainAction { action: "explore", tool: "explore_deps", hint: "natural-language dependency exploration (flow + blast radius + source); START HERE when unsure which action to use" },
            DomainAction { action: "symbols", tool: "search_symbols", hint: "find symbols by name substring → node IDs (知道名字、不知道 ID 时的第一步)" },
            DomainAction { action: "semantic", tool: "semantic_search", hint: "meaning-based search over the embedding index (按语义找，不知道确切名字)" },
            DomainAction { action: "neighbors", tool: "get_neighbors", hint: "1-hop in/out edges of a node (这个模块被谁依赖？)" },
            DomainAction { action: "impact", tool: "trace_impact", hint: "downstream blast radius layered by distance (改这个会炸多少地方？)" },
            DomainAction { action: "path", tool: "find_dep_path", hint: "dependency chain from A to B with hop count (A 是怎么依赖到 B 的？)" },
            DomainAction { action: "inspect", tool: "inspect_symbol", hint: "everything about one symbol: identity, community, all edges grouped by kind" },
            DomainAction { action: "community", tool: "get_community", hint: "which Leiden cluster a node belongs to (+ siblings)" },
            DomainAction { action: "clusters", tool: "cluster_report", hint: "global community map sorted by size (high-level architecture)" },
            DomainAction { action: "summary", tool: "graph_summary", hint: "graph stats: nodes/edges/resolution rate/SCIP freshness" },
        ],
    },
    DomainSpec {
        name: "analysis",
        description: "Whole-graph architecture and health analysis: cycles, coupling, fragility, blind spots, concurrency conflicts, boundary rules, dead code, execution flows, async/temporal edges, syntax-level dataflow, audit timeline, gRPC contracts, and pre-change preflight. All actions read-only; run action=preflight before editing files.",
        read_only: true,
        actions: &[
            DomainAction { action: "cycles", tool: "detect_cycles", hint: "circular dependencies, filter all/data/llm (有没有循环依赖？)" },
            DomainAction { action: "coupling", tool: "coupling_report", hint: "one module's L1-L4 coupling profile (needs module)" },
            DomainAction { action: "fragile", tool: "fragile_modules", hint: "top-N most coupled modules (structural hub ranking)" },
            DomainAction { action: "blindspots", tool: "arch_blindspots", hint: "aggregated architecture blind spots (cycles + conflicts + L4)" },
            DomainAction { action: "conflicts", tool: "thread_conflicts", hint: "thread × shared-resource conflict matrix (并发问题，可给 nodeId 收窄)" },
            DomainAction { action: "boundaries", tool: "check_boundaries", hint: "boundary/policy rule violations (自定义 rules 或约束文件)" },
            DomainAction { action: "unused", tool: "find_unused", hint: "dead-code candidates (无入边符号，kind_filter 可筛)" },
            DomainAction { action: "timeline", tool: "project_timeline", hint: "audit timeline of past analyses/changes (since/limit 可筛)" },
            DomainAction { action: "grpc", tool: "grpc_services", hint: "gRPC service map from .proto: implementation status + call sites" },
            DomainAction { action: "flows", tool: "list_flows", hint: "list execution flows (entry point → critical path)" },
            DomainAction { action: "flow", tool: "get_flow", hint: "one execution flow by id or name" },
            DomainAction { action: "affected_flows", tool: "get_affected_flows", hint: "flows touched by changed files/nodes" },
            DomainAction { action: "async", tool: "async_edges", hint: "async/temporal edges (triggers/awaits) — computed on demand, not stored" },
            DomainAction { action: "dataflow", tool: "trace_dataflow", hint: "syntax-level read/write/share stats for files (非污点分析)" },
            DomainAction { action: "preflight", tool: "preflight_check", hint: "pre-change preflight: impact + flows + boundaries in one call (改文件前必须)" },
        ],
    },
    DomainSpec {
        name: "lsp",
        description: "Language-server resolution (server started on demand): compiler-accurate answers when the graph's heuristic edges are not enough — resolve a call site, infer a type, list implementations, list references. Slower than graph actions (spawns a language server); try graph(symbols|neighbors|impact) first.",
        read_only: true,
        actions: &[
            DomainAction { action: "resolve", tool: "resolve_call", hint: "resolve a call site to its real definition (function name, or file+line+column)" },
            DomainAction { action: "infer_type", tool: "infer_type", hint: "infer the type of the symbol at a position (file+line+column)" },
            DomainAction { action: "implementations", tool: "find_implementations", hint: "find implementations of an interface/abstract symbol" },
            DomainAction { action: "references", tool: "find_references", hint: "find all references to a symbol (includeDeclaration optional)" },
        ],
    },
    DomainSpec {
        name: "ops",
        description: "Project-level READ-ONLY state: constraint validation, health snapshot, engine status (contract / tool-call counts / vector index / LSP / watcher), and graph diff against a baseline. Write operations stay top-level tools: analyze_project, import_scip, rename_symbol.",
        read_only: true,
        actions: &[
            DomainAction { action: "validate", tool: "validate_project", hint: "run all constraint checks (path optional; defaults to the bound root)" },
            DomainAction { action: "health", tool: "project_health", hint: "project health snapshot over N days" },
            DomainAction { action: "status", tool: "engine_status", hint: "engine status + contract + per-tool call counts + index/LSP state" },
            DomainAction { action: "diff", tool: "graph_diff", hint: "diff current graph against a baseline graph (beforePath)" },
        ],
    },
];

/// 按名取静态 schema（get_schema 与域 schema 派生共用同一处查找）。
fn find_schema(name: &str) -> Option<&'static ToolSchema> {
    all_schemas().iter().find(|s| s.name == name)
}

/// 域名 → 域规格（非域名返回 None）。
pub fn domain_of(name: &str) -> Option<&'static DomainSpec> {
    DOMAIN_SPECS.iter().find(|d| d.name == name)
}

/// 工具名 → 承载它的域（未折叠工具返回 None）。
pub fn domain_of_tool(tool: &str) -> Option<&'static DomainSpec> {
    DOMAIN_SPECS
        .iter()
        .find(|d| d.actions.iter().any(|a| a.tool == tool))
}

/// 域动作清单文本（引导语 / 错误信息共用）。
fn action_list(spec: &DomainSpec) -> String {
    spec.actions.iter().map(|a| a.action).collect::<Vec<_>>().join(", ")
}

/// 域调用路由：域名 + args → (目标工具名, 剥掉 action 的 args)。
///
/// action 缺失 / 未知 → Err(给模型看的引导语)——错误必须可见且可自恢复
/// （沿用 ToolResponse::Degraded 的降级形态，不做静默兜底）。
fn route_domain(spec: &DomainSpec, args: &Value) -> Result<(&'static str, Value), String> {
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
    if action.is_empty() {
        return Err(format!(
            "{} requires an 'action' argument — valid actions: {}",
            spec.name,
            action_list(spec)
        ));
    }
    let Some(hit) = spec.actions.iter().find(|a| a.action == action) else {
        return Err(format!(
            "unknown {} action '{}' — valid actions: {}",
            spec.name,
            action,
            action_list(spec)
        ));
    };
    // action 是域层的路由键，不进底层 handler（handler 只认自己的参数）。
    let mut routed = args.clone();
    if let Some(obj) = routed.as_object_mut() {
        obj.remove("action");
    }
    Ok((hit.tool, routed))
}

/// 折叠后的可调用引用：`domain(action)`；未折叠的默认工具返回原名；
/// 既不在域里也不在默认面（legacy 隐藏名）返回 None——建议里不许出现隐藏名。
pub fn visible_ref(tool: &str) -> Option<String> {
    if let Some(d) = domain_of_tool(tool) {
        let action = d
            .actions
            .iter()
            .find(|a| a.tool == tool)
            .map(|a| a.action)
            .unwrap_or("");
        return Some(format!("{}({})", d.name, action));
    }
    if ToolRegistry::DEFAULT_MCP_TOOLS.contains(&tool) {
        return Some(tool.to_string());
    }
    None
}

/// 模型可见默认面清单（域 + 未折叠的默认工具）——engine_status / 文档 / guard 消费。
pub fn default_visible_names() -> Vec<String> {
    let mut names: Vec<String> = DOMAIN_SPECS.iter().map(|d| d.name.to_string()).collect();
    for s in all_schemas() {
        if s.category == "shell" {
            continue;
        }
        if ToolRegistry::DEFAULT_MCP_TOOLS.contains(&s.name) && domain_of_tool(s.name).is_none() {
            names.push(s.name.to_string());
        }
    }
    names
}

impl DomainSpec {
    /// 域工具 schema：action 枚举 + 成员参数并集（参数文档派生自 ToolSchema）。
    fn mcp_value(&self) -> Value {
        let mut action_doc = format!("{} action — one of:", self.name);
        for a in self.actions {
            action_doc.push_str(&format!("\n- {}: {}", a.action, a.hint));
        }
        let mut action_prop = serde_json::Map::new();
        action_prop.insert("type".to_string(), json!("string"));
        action_prop.insert("description".to_string(), json!(action_doc));
        action_prop.insert(
            "enum".to_string(),
            json!(self.actions.iter().map(|a| a.action).collect::<Vec<_>>()),
        );

        let mut properties = serde_json::Map::new();
        properties.insert("action".to_string(), Value::Object(action_prop));
        for a in self.actions {
            let Some(schema) = find_schema(a.tool) else { continue };
            for p in schema.params {
                // 同名参数保留首个（类型一致性由 test_domain_param_types_consistent 钉住）；
                // 其文档来自 ToolSchema——域层不重复维护第二份参数说明。
                if properties.contains_key(p.name) {
                    continue;
                }
                let mut prop = serde_json::Map::new();
                prop.insert("type".to_string(), json!(p.ptype));
                prop.insert("description".to_string(), json!(p.description));
                if !p.enum_values.is_empty() {
                    prop.insert("enum".to_string(), json!(p.enum_values));
                }
                properties.insert(p.name.to_string(), Value::Object(prop));
            }
        }
        json!({
            "name": self.name,
            "description": self.description,
            // MCP 标准只读注解（annotations.readOnlyHint）——
            // 宿主（兰台 plan 门禁 / 并行只读组）认的是这个键，不是旧的非标准顶层 readOnly。
            "annotations": { "readOnlyHint": self.read_only },
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": ["action"],
            }
        })
    }
}

/// 模型可见面的构成方式（契约 v5；`HOLOGRAM_MCP_TOOLS` 解析产物）。
pub enum SurfaceMode {
    /// 缺省：折叠面（域 + 未折叠的默认工具 + manifest 工具）。
    Folded,
    /// `*`：全量原名（壳专属方法除外）+ manifest 工具。
    AllRaw,
    /// 显式名单：严格按名单（条目可为原名，也可为域名 = 整域）。
    Explicit(Vec<String>),
}

// ═══════════════════════════════════════════════════════════════
// ToolRegistry — 单例分发
// ═══════════════════════════════════════════════════════════════

pub struct ToolRegistry;

static REGISTRY: LazyLock<ToolRegistry> = LazyLock::new(|| ToolRegistry);

impl ToolRegistry {
    pub fn global() -> &'static ToolRegistry {
        &REGISTRY
    }

    /// 模型可见默认工具（单一真源；契约 guard 消费）。
    pub const DEFAULT_MCP_TOOLS: &[&str] = &[
        "explore_deps",
        "search_symbols",
        "semantic_search",
        "get_neighbors",
        "trace_impact",
        "find_dep_path",
        "inspect_symbol",
        "get_community",
        "async_edges",
        "fragile_modules",
        "detect_cycles",
        "thread_conflicts",
        "coupling_report",
        "project_timeline",
        "arch_blindspots",
        "grpc_services",
        "preflight_check",
        "graph_summary",
        "cluster_report",
        "graph_diff",
        "analyze_project",
        "validate_project",
        "project_health",
        "rename_symbol",
        "engine_status",
        "check_boundaries",
        "find_unused",
        "trace_dataflow",
        "list_flows",
        "get_flow",
        "get_affected_flows",
        "resolve_call",
        "infer_type",
        "find_implementations",
        "find_references",
        "import_scip",
    ];

    /// 模型可见面的三档语义（HOLOGRAM_MCP_TOOLS）——契约 v5。
    ///
    /// | 环境变量 | 面 |
    /// |---|---|
    /// | 未设 / 空串 | **折叠面**：域（graph/analysis/lsp/ops）+ 未折叠的默认工具（写工具）+ manifest 工具 |
    /// | `*` | **全量原名**：全部 schema（壳专属方法除外）+ manifest 工具 |
    /// | 显式名单 | **严格名单**：条目可为原名，也可为域名（`graph` = 整域） |
    ///
    /// 解析是纯函数（测试不碰进程环境）：两侧空白容忍——实测 `set VAR=* && …`
    /// 在 cmd 下会带尾随空格，严格等于 `"*"` 会把全量面静默解析成空集。
    fn parse_surface_mode(raw: Option<&str>) -> SurfaceMode {
        let val = raw.unwrap_or("").trim();
        if val.is_empty() {
            return SurfaceMode::Folded;
        }
        if val == "*" {
            return SurfaceMode::AllRaw;
        }
        SurfaceMode::Explicit(
            val.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        )
    }

    fn surface_mode() -> SurfaceMode {
        let raw = std::env::var("HOLOGRAM_MCP_TOOLS").ok();
        Self::parse_surface_mode(raw.as_deref())
    }

    /// 可见面组装（tools_list 的行为本体；测试直接喂 mode，不碰进程环境）。
    fn tools_list_with(mode: &SurfaceMode) -> Vec<Value> {
        let mut list: Vec<Value> = Vec::new();
        match mode {
            SurfaceMode::Folded => {
                for d in DOMAIN_SPECS {
                    list.push(d.mcp_value());
                }
                for s in all_schemas() {
                    // 壳专属方法（host API）永不进模型面
                    if s.category == "shell" {
                        continue;
                    }
                    // 默认面里未折叠的工具（= 写工具）以原名出现；已折叠的由域承载。
                    if ToolRegistry::DEFAULT_MCP_TOOLS.contains(&s.name)
                        && domain_of_tool(s.name).is_none()
                    {
                        list.push(s.mcp_value());
                    }
                }
                // manifest 工具装了即见（免编译扩展面 Phase 4）
                list.extend(crate::plugins::plugin_tool_values());
            }
            SurfaceMode::AllRaw => {
                for s in all_schemas() {
                    if s.category == "shell" {
                        continue;
                    }
                    list.push(s.mcp_value());
                }
                list.extend(crate::plugins::plugin_tool_values());
            }
            SurfaceMode::Explicit(names) => {
                let want: HashSet<&str> = names.iter().map(|s| s.as_str()).collect();
                for d in DOMAIN_SPECS {
                    if want.contains(d.name) {
                        list.push(d.mcp_value());
                    }
                }
                for s in all_schemas() {
                    if s.category == "shell" {
                        continue;
                    }
                    if want.contains(s.name) {
                        list.push(s.mcp_value());
                    }
                }
                list.extend(
                    crate::plugins::plugin_tool_values()
                        .into_iter()
                        .filter(|v| want.contains(v["name"].as_str().unwrap_or(""))),
                );
            }
        }
        list
    }

    pub fn tools_list(&self) -> Vec<Value> {
        let list = Self::tools_list_with(&Self::surface_mode());
        if list.is_empty() {
            // 空面是坏故障（模型看得见零工具），必须留痕而不是静默返回空数组。
            tracing::warn!(
                env = ?std::env::var("HOLOGRAM_MCP_TOOLS").ok(),
                "tools/list 解析为空——HOLOGRAM_MCP_TOOLS 名单没有命中任何工具或域"
            );
        }
        list
    }

    pub fn get_schema(&self, name: &str) -> Option<&'static ToolSchema> {
        find_schema(name)
    }

    /// 工具是否可被 `tools/call` 调用（静态 schema 面 ∪ manifest 工具面 ∪ 域面）。
    ///
    /// 域可调用性是契约 v5 的新面：`tools/call("graph", {action:"impact", ...})`。
    /// 折叠不改可达性——被折叠的原名同样仍可 `tools/call` 直达。
    pub fn knows_tool(&self, name: &str) -> bool {
        self.get_schema(name).is_some()
            || domain_of(name).is_some()
            || crate::plugins::is_plugin_tool(name)
    }

    /// 调用生效的工具名：域调用解析成路由目标（供长任务判定 / 新鲜度横幅用），
    /// 非域调用原样返回。action 缺失/未知时返回域名本身（dispatch 会给出引导语）。
    pub fn effective_tool_name<'a>(name: &'a str, args: &Value) -> &'a str {
        match domain_of(name).map(|spec| route_domain(spec, args)) {
            Some(Ok((tool, _))) => tool,
            _ => name,
        }
    }

    pub fn dispatch(name: &str, args: &Value, id: &Value) -> Value {
        // ── 域路由（契约 v5）：action → 既有工具 + args 透传（action 键剥掉）──
        let mut effective = name;
        let mut call_args: std::borrow::Cow<'_, Value> = std::borrow::Cow::Borrowed(args);
        if let Some(spec) = domain_of(name) {
            match route_domain(spec, args) {
                Ok((tool, stripped)) => {
                    effective = tool;
                    call_args = std::borrow::Cow::Owned(stripped);
                }
                Err(guidance) => {
                    Self::count_call(name);
                    return ToolResponse::Degraded {
                        guidance,
                        fallback: format!("{} actions: {}", name, action_list(spec)),
                        details: json!({
                            "domain": name,
                            "action": args.get("action").cloned().unwrap_or(Value::Null),
                            "valid_actions": spec.actions.iter().map(|a| a.action).collect::<Vec<_>>(),
                        }),
                    }
                    .to_mcp_value(id);
                }
            }
        }
        // 调用计数（进程内）：engine_status 可观测 Agent 对各工具的真实使用率。
        // 域调用记账两次——域名（模型实际调了什么）+ 路由目标（底层能力被用了几次）。
        Self::count_call(name);
        if effective != name {
            Self::count_call(effective);
        }
        let call_args = call_args.as_ref();
        let resp = match effective {
            "get_neighbors" => handlers::handler_neighbors(call_args),
            "trace_impact" => handlers::handler_impact(call_args),
            "find_dep_path" => handlers::handler_path(call_args),
            "inspect_symbol" | "symbol_history" => handlers::handler_node(call_args),
            "get_community" => handlers::handler_community(call_args),
            "async_edges" => handlers::handler_delayed(call_args),
            "fragile_modules" => handlers::handler_fragile(call_args),
            "detect_cycles" => handlers::handler_cycle(call_args),
            "thread_conflicts" => handlers::handler_thread_conflicts(call_args),
            "coupling_report" => handlers::handler_coupling_report(call_args),
            "project_timeline" => handlers::handler_timeline(call_args),
            "arch_blindspots" => handlers::handler_blindspots(call_args),
            "grpc_services" => handlers::handler_grpc_services(call_args),
            "preflight_check" => handlers::handler_preflight(call_args),
            "search_symbols" => handlers::handler_search(call_args),
            "semantic_search" => handlers::handler_semantic_search(call_args),
            "explore_deps" => handlers::handler_explore(call_args),
            "graph_summary" => handlers::handler_graph_summary(call_args),
            "cluster_report" => handlers::handler_clusters(call_args),
            "graph_diff" => handlers::handler_diff(call_args),
            "analyze_project" => handlers::handler_analyze(call_args),
            "validate_project" => handlers::handler_run_check(call_args),
            "project_health" => handlers::handler_run_health(call_args),
            "rename_symbol" => handlers::handler_rename(call_args),
            "engine_status" => handlers::handler_status(call_args),
            "check_boundaries" => handlers::handler_policy_check(call_args),
            "find_unused" => handlers::handler_unused(call_args),
            "list_flows" => handlers::handler_list_flows(call_args),
            "get_flow" => handlers::handler_get_flow(call_args),
            "get_affected_flows" => handlers::handler_affected_flows(call_args),
            "trace_dataflow" => handlers::handler_dataflow(call_args),
            "resolve_call" => handlers::handler_resolve_call(call_args),
            "infer_type" => handlers::handler_resolve_type(call_args),
            "find_implementations" => handlers::handler_find_implementations(call_args),
            "find_references" => handlers::handler_find_references(call_args),
            "import_scip" => handlers::handler_import_scip(call_args),
            // ── 壳专属方法（契约 v2；hidden —— 不在 DEFAULT_MCP_TOOLS）──
            "graph_snapshot" => handlers::shell::handler_graph_snapshot(call_args),
            "file_nodes" => handlers::shell::handler_file_nodes(call_args),
            "analyze_with_progress" => handlers::shell::handler_analyze_with_progress(call_args),
            "save" => handlers::shell::handler_save(call_args),
            "fts_search" => handlers::shell::handler_fts_search(call_args),
            "timeline_record" => handlers::shell::handler_timeline_record(call_args),
            "diff" => handlers::shell::handler_diff(call_args),
            "ensure_ready" => handlers::shell::handler_ensure_ready(call_args),
            "cache_stale" => handlers::shell::handler_cache_stale(call_args),
            "watcher_subscribe" => handlers::shell::handler_watcher_subscribe(call_args),
            "run_check" => handlers::shell::handler_run_check(call_args),
            // ── manifest 工具（免编译扩展面 Phase 4）──
            _ => match crate::plugins::dispatch_plugin_tool(effective, call_args) {
                Some(resp) => resp,
                None => {
                    return ToolResponse::Degraded {
                        guidance: format!("Tool not found: {}", name),
                        fallback: "Check tools/list for available tools".into(),
                        details: json!({}),
                    }
                    .to_mcp_value(id)
                }
            },
        };
        // ponytail：在分发层注入后续工具建议，
        // 使每个处理器免费获得 —— 无需逐处理器编写样板代码。
        // 建议名一律经 visible_ref 折算成**模型实际能调用的引用**（v5）：
        // 折叠后裸名 `preflight_check` 不可见，建议必须是 `analysis(preflight)`。
        let suggestions: Vec<String> = suggestions_for(effective)
            .iter()
            .filter_map(|t| crate::tools::visible_ref(t))
            .collect();
        resp.with_suggestions(&suggestions).to_mcp_value(id)
    }

    /// 调用计数递增（进程内观测面）。
    fn count_call(name: &str) {
        if let Ok(mut counts) = TOOL_CALL_COUNTS.lock() {
            *counts.entry(name.to_string()).or_default() += 1;
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Handler id 注册表 —— manifest 工具的寻址面（免编译扩展面 Phase 4）。
// 静态 dispatch match 的运行时形态：id = 模型工具名，fn = 既有 handler。
// manifest 工具声明 handler id 即复用既有能力，不引入任意代码执行。
// ═══════════════════════════════════════════════════════════════

/// manifest 工具可指向的 handler 形态（与 dispatch 静态臂同签名）。
pub(crate) type HandlerFn = fn(&Value) -> ToolResponse;

/// 按 id 寻址既有 handler。注册面 = 全部模型默认工具（DEFAULT_MCP_TOOLS）；
/// 壳专属方法（handlers::shell::*）刻意不入表 —— host API 不经 manifest 暴露。
pub(crate) fn builtin_handler(id: &str) -> Option<HandlerFn> {
    let f: HandlerFn = match id {
        "explore_deps" => handlers::handler_explore,
        "search_symbols" => handlers::handler_search,
        "semantic_search" => handlers::handler_semantic_search,
        "get_neighbors" => handlers::handler_neighbors,
        "trace_impact" => handlers::handler_impact,
        "find_dep_path" => handlers::handler_path,
        "inspect_symbol" => handlers::handler_node,
        "get_community" => handlers::handler_community,
        "async_edges" => handlers::handler_delayed,
        "fragile_modules" => handlers::handler_fragile,
        "detect_cycles" => handlers::handler_cycle,
        "thread_conflicts" => handlers::handler_thread_conflicts,
        "coupling_report" => handlers::handler_coupling_report,
        "project_timeline" => handlers::handler_timeline,
        "arch_blindspots" => handlers::handler_blindspots,
        "grpc_services" => handlers::handler_grpc_services,
        "preflight_check" => handlers::handler_preflight,
        "graph_summary" => handlers::handler_graph_summary,
        "cluster_report" => handlers::handler_clusters,
        "graph_diff" => handlers::handler_diff,
        "analyze_project" => handlers::handler_analyze,
        "validate_project" => handlers::handler_run_check,
        "project_health" => handlers::handler_run_health,
        "rename_symbol" => handlers::handler_rename,
        "engine_status" => handlers::handler_status,
        "check_boundaries" => handlers::handler_policy_check,
        "find_unused" => handlers::handler_unused,
        "trace_dataflow" => handlers::handler_dataflow,
        "list_flows" => handlers::handler_list_flows,
        "get_flow" => handlers::handler_get_flow,
        "get_affected_flows" => handlers::handler_affected_flows,
        "resolve_call" => handlers::handler_resolve_call,
        "infer_type" => handlers::handler_resolve_type,
        "find_implementations" => handlers::handler_find_implementations,
        "find_references" => handlers::handler_find_references,
        "import_scip" => handlers::handler_import_scip,
        _ => return None,
    };
    Some(f)
}

// ═══════════════════════════════════════════════════════════════
// 后续工具建议 —— 静态查找表，由 dispatch() 注入。
// ═══════════════════════════════════════════════════════════════

fn suggestions_for(name: &str) -> &'static [&'static str] {
    match name {
        // ── 图导航 ──
        "search_symbols" => &["semantic_search", "get_neighbors", "inspect_symbol"],
        "semantic_search" => &["search_symbols", "inspect_symbol", "get_neighbors"],
        "get_neighbors" => &["trace_impact", "find_dep_path", "inspect_symbol"],
        "trace_impact" => &["find_dep_path", "preflight_check", "coupling_report"],
        "find_dep_path" => &["trace_impact", "inspect_symbol", "get_neighbors"],
        "inspect_symbol" | "symbol_history" => {
            &["trace_impact", "coupling_report", "get_community"]
        }
        "explore_deps" => &["trace_impact", "inspect_symbol", "get_neighbors"],
        // ── Community ──
        "get_community" => &["cluster_report", "coupling_report", "trace_impact"],
        "cluster_report" => &["get_community", "coupling_report", "arch_blindspots"],
        // ── Analysis ──
        "fragile_modules" => &["coupling_report", "arch_blindspots", "trace_impact"],
        "detect_cycles" => &["arch_blindspots", "coupling_report", "fragile_modules"],
        "thread_conflicts" => &["trace_dataflow", "arch_blindspots", "preflight_check"],
        "coupling_report" => &["fragile_modules", "detect_cycles", "arch_blindspots"],
        "arch_blindspots" => &["preflight_check", "coupling_report", "thread_conflicts"],
        "grpc_services" => &["search_symbols", "inspect_symbol", "trace_impact"],
        "check_boundaries" => &["preflight_check", "arch_blindspots", "coupling_report"],
        // ── 数据流 ──
        "trace_dataflow" => &["thread_conflicts", "preflight_check", "async_edges"],
        "async_edges" => &["trace_dataflow", "coupling_report", "detect_cycles"],
        // ── 死代码 / 重构 ──
        "find_unused" => &["inspect_symbol", "trace_impact", "rename_symbol"],
        "rename_symbol" => &["search_symbols", "preflight_check", "trace_impact"],
        // ── 预检 ──
        "preflight_check" => &["trace_impact", "trace_dataflow", "check_boundaries"],
        // ── LSP ──
        "resolve_call" => &["find_implementations", "infer_type", "find_references"],
        "infer_type" => &["resolve_call", "find_references", "find_implementations"],
        "find_implementations" => &["resolve_call", "infer_type", "trace_impact"],
        "find_references" => &["trace_impact", "inspect_symbol", "preflight_check"],
        // ── SCIP ──
        "import_scip" => &["graph_summary", "search_symbols", "analyze_project"],
        // ── Operations ──
        "graph_summary" => &["cluster_report", "fragile_modules", "detect_cycles"],
        "graph_diff" => &["trace_impact", "inspect_symbol", "engine_status"],
        "analyze_project" => &["engine_status", "graph_summary", "cluster_report"],
        "validate_project" => &["arch_blindspots", "check_boundaries", "graph_diff"],
        "project_health" => &["fragile_modules", "arch_blindspots", "project_timeline"],
        "project_timeline" => &["inspect_symbol", "graph_diff", "project_health"],
        "engine_status" => &["graph_summary", "analyze_project", "search_symbols"],
        // ── 流程 ──
        "list_flows" => &["get_flow", "get_affected_flows", "trace_impact"],
        "get_flow" => &["trace_impact", "inspect_symbol", "preflight_check"],
        "get_affected_flows" => &["get_flow", "preflight_check", "detect_cycles"],
        _ => &[],
    }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════


pub(crate) mod handlers;
pub(crate) mod response;
pub(crate) use response::ToolResponse;
pub mod staleness;
pub(crate) fn get_str(args: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = args.get(key).and_then(|v| v.as_str()) {
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }
    String::new()
}

pub(crate) fn get_usize(args: &Value, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or_else(|| {
            // 尝试 camelCase 变体（如 "min_size" → "minSize"）
            let camel = snake_to_camel(key);
            args.get(&camel)
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .unwrap_or(default)
        })
}

/// 布尔参数读取（缺省 default；容忍字符串 "true"/"false" 形态）。
pub(crate) fn get_bool(args: &Value, key: &str, default: bool) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => matches!(s.as_str(), "true" | "True" | "1"),
        _ => default,
    }
}

/// 将 snake_case 转换为 camelCase（如 "min_size" → "minSize"，"node_id" → "nodeId"）
pub(crate) fn snake_to_camel(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut upper = false;
    for ch in s.chars() {
        if ch == '_' {
            upper = true;
        } else if upper {
            result.push(ch.to_ascii_uppercase());
            upper = false;
        } else {
            result.push(ch);
        }
    }
    result
}

pub(crate) fn project_root() -> PathBuf {
    engine::with_engine(|eng| eng.project_root()).unwrap_or_default()
}

/// 每工具调用计数（进程内）：Agent 图工具使用率观测。
/// 图形工具是产品核心却可能「挂而不用」——这个计数让
/// engine_status 直接暴露真实使用分布。
static TOOL_CALL_COUNTS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 当前进程内各工具的调用计数快照。
pub fn tool_call_counts() -> HashMap<String, u64> {
    TOOL_CALL_COUNTS
        .lock()
        .map(|m| m.clone())
        .unwrap_or_default()
}

pub(crate) fn with_store<F>(f: F) -> Value
where
    F: FnOnce(&MemoryIndex) -> Value,
{
    match engine::engine_read(|idx| f(idx)) {
        Ok(value) => value,
        Err(e) => json!({"error": e}),
    }
}

pub(crate) fn with_graph<F>(f: F) -> Value
where
    F: FnOnce(&Graph) -> Value,
{
    match engine::engine_read(|idx| f(&engine::graph_from_index(idx))) {
        Ok(value) => value,
        Err(e) => json!({"error": e}),
    }
}

/// 在 MemoryIndex 中解析节点引用。
/// 解析顺序：精确 ID → 精确名称 → 后缀匹配（处理 LLM 传的带路径前缀
/// 直觉 ID，如 `D:.HoloGramHG...Agent.setPlanState`）→ 未找到。
/// 后缀匹配按"最短后缀优先"取，因为最长的精确匹配通常更准。
pub(crate) fn resolve_in_index(idx: &MemoryIndex, node_id_or_name: &str) -> Option<String> {
    if idx.get_node(node_id_or_name).is_some() {
        return Some(node_id_or_name.to_string());
    }
    if let Some(hit) = idx.get_nodes_by_name(node_id_or_name).first() {
        return Some(hit.clone());
    }
    // 后缀匹配：节点 ID 通常形如 `D:.HoloGramHG.src-ui.src.agent.ts.Agent.setPlanState`，
    // LLM 常截取末尾片段（如 `agent.ts.Agent.setPlanState`）。按匹配长度降序取最短命中。
    let needle = node_id_or_name.to_lowercase();
    let mut best: Option<(usize, String)> = None;
    for n in idx.nodes_iter() {
        let id = n.id.to_string().to_lowercase();
        if id.ends_with(&needle) {
            let score = id.len();
            if best.as_ref().map(|(s, _)| score < *s).unwrap_or(true) {
                best = Some((score, n.id.to_string()));
            }
        }
    }
    best.map(|(_, id)| id)
}

/// 在旧版 Graph 中解析节点引用：精确 ID → 搜索 → 未找到。
pub(crate) fn resolve_in_graph(g: &Graph, node_id_or_name: &str) -> Option<String> {
    if g.get_node(node_id_or_name).is_some() {
        return Some(node_id_or_name.to_string());
    }
    g.search_nodes(node_id_or_name).first().map(|n| n.id.as_str().to_owned())
}

pub(crate) fn discover_source_files(root: &Path, limit: usize) -> Vec<PathBuf> {
    let exts: Vec<String> = GRAMMAR_LOADER.supported_extensions();
    let ext_strs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    discover_files(root, &ext_strs).into_iter().take(limit).collect()
}

pub(crate) fn derive_comm_label(members: &[String], idx: &MemoryIndex) -> String {
    use std::collections::HashMap;
    let mut prefix_counts: HashMap<String, usize> = HashMap::new();
    for nid in members.iter().take(30) {
        if let Some(node) = idx.get_node(nid) {
            let loc = node.location.as_deref().unwrap_or("");
            let file = loc.rsplit(&['/', '\\']).next().unwrap_or(loc);
            let stem = file.rsplit(':').next().unwrap_or(file);
            *prefix_counts.entry(stem.to_string()).or_default() += 1;
        }
    }
    prefix_counts
        .into_iter()
        .max_by_key(|(_, c)| *c)
        .map(|(p, _)| p)
        .unwrap_or_else(|| format!("Community({})", members.len()))
}

pub(crate) fn node_to_value(n: &Node) -> Value {
    json!({
        "id": n.id,
        "name": n.name,
        "type": n.kind.as_str(),
        "kind": n.kind.as_str(),
        "location": n.location,
        "in_degree": n.in_degree,
        "out_degree": n.out_degree,
        "properties": n.properties,
        "position": n.position,
        "community_id": n.community_id,
    })
}

pub(crate) fn edge_to_value(e: &Edge) -> Value {
    json!({
        "id": e.id,
        "source": e.source,
        "target": e.target,
        "type": e.kind.as_str(),
        "coupling_depth": e.coupling_depth,
        "cross_file": e.cross_file,
        "temporal_delay_sec": e.temporal_delay_sec,
        "metadata": e.metadata,
        "lsp_resolved": e.lsp_resolved,
    })
}

// ═══════════════════════════════════════════════════════════════
// 图聚合快照 —— 壳方法 graph_snapshot 的单一真源
// ═══════════════════════════════════════════════════════════════

/// 从 Graph 组装聚合快照值（graph_snapshot 壳方法的负载形状：
/// 计数 / kind 分布 / 边类型分布 / 社区规模 / top 扇入扇出 / 类数）。
/// 进程外形态下壳经 MCP 调同一壳方法，本函数是引擎内单一消费源。
pub fn graph_snapshot_value(g: &Graph, source_root: &str) -> Value {
    // BTreeMap：契约面确定性（HashMap 序列化序不稳定，字节契约）。
    let mut kind_counts: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    let mut files: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut community_sizes: std::collections::HashMap<usize, usize> =
        std::collections::HashMap::new();
    let mut fan_in: Vec<(&str, &str, u32)> = Vec::new();
    let mut fan_out: Vec<(&str, &str, u32)> = Vec::new();
    for n in g.nodes_map().values() {
        *kind_counts.entry(n.kind.as_str()).or_default() += 1;
        if let Some(loc) = &n.location {
            files.insert(handlers::graph::strip_loc_suffix(loc).replace('\\', "/"));
        }
        if let Some(cid) = n.community_id {
            *community_sizes.entry(cid).or_default() += 1;
        }
        if n.in_degree > 0 {
            fan_in.push((n.id.as_str(), n.name.as_str(), n.in_degree));
        }
        if n.out_degree > 0 {
            fan_out.push((n.id.as_str(), n.name.as_str(), n.out_degree));
        }
    }
    fan_in.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(b.0)));
    fan_out.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(b.0)));
    let mut edge_kinds: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for e in g.edges_map().values() {
        *edge_kinds.entry(e.kind.as_str()).or_default() += 1;
    }
    let mut communities: Vec<Value> = community_sizes
        .iter()
        .map(|(cid, size)| json!({ "id": cid, "size": size }))
        .collect();
    communities.sort_by_key(|c| c["id"].as_u64().unwrap_or(0));
    json!({
        "source_root": source_root,
        "node_count": g.node_count(),
        "edge_count": g.edge_count(),
        "file_count": files.len(),
        "class_count": kind_counts.get("class").copied().unwrap_or(0),
        "kind_counts": kind_counts,
        "edge_kind_counts": edge_kinds,
        "communities": communities,
        "top_fan_in": fan_in.iter().take(10).map(|(id, name, deg)| json!({"id": id, "name": name, "fan_in": deg})).collect::<Vec<_>>(),
        "top_fan_out": fan_out.iter().take(10).map(|(id, name, deg)| json!({"id": id, "name": name, "fan_out": deg})).collect::<Vec<_>>(),
    })
}

/// 按文件符号索引（file_nodes 壳方法与壳侧内嵌消费的单一真源）：
/// 归一为相对项目根路径再比对，非根内路径按后缀匹配
///（与 resolve_in_index 的 suffix 语义一致）。
pub fn file_nodes_value(g: &Graph, project_root: &str, want_file: &str) -> Value {
    let want = want_file.replace('\\', "/");
    let root_prefix = format!("{}/", project_root.replace('\\', "/"));
    let mut matched: Vec<&hologram_graph::Node> = Vec::new();
    for n in g.nodes_map().values() {
        let Some(loc) = &n.location else { continue };
        let norm = handlers::graph::strip_loc_suffix(loc).replace('\\', "/");
        let rel = norm.strip_prefix(root_prefix.as_str()).unwrap_or(&norm);
        if rel == want || norm.ends_with(&want) {
            matched.push(n);
        }
    }
    // 契约面确定性：HashMap 迭代序不稳定，按 id 排序输出（字节契约）。
    matched.sort_by(|a, b| a.id.as_str().cmp(b.id.as_str()));
    let nodes: Vec<Value> = matched
        .iter()
        .map(|n| {
            json!({
                "id": n.id, "name": n.name, "kind": n.kind.as_str(),
                "fan_in": n.in_degree, "fan_out": n.out_degree,
            })
        })
        .collect();
    json!({ "file": want, "count": nodes.len(), "nodes": nodes })
}

// ═══════════════════════════════════════════════════════════════
// V1 处理器 —— 图查询
// ═══════════════════════════════════════════════════════════════


macro_rules! p {
    ($name:expr, $type:expr, $desc:expr) => {
        ParamDef {
            name: $name,
            ptype: $type,
            description: $desc,
            enum_values: &[],
        }
    };
}

/// 带枚举约束的参数定义：合法值进 inputSchema.enum（如 detect_cycles 的 mode）。
macro_rules! p_enum {
    ($name:expr, $type:expr, $desc:expr, [$($v:expr),+ $(,)?]) => {
        ParamDef {
            name: $name,
            ptype: $type,
            description: $desc,
            enum_values: &[$($v),+],
        }
    };
}

fn all_schemas() -> &'static [ToolSchema] {
    &[
        // ── 入口点 ──
        ToolSchema {
            name: "explore_deps",
            description: "【DEFAULT FIRST CHOICE】NL-powered dependency exploration — one call returns: dependency flow path + blast radius + relationships + source code + architecture alerts. Just type a natural-language question like \"DataRequest validate task\" or \"auth模块的依赖链\". When unsure which tool to use, START HERE — it auto-disambiguates.",
            params: &[p!("query", "string", "Natural language query (e.g. 'DataRequest validate task'). Auto-extracts symbol names."), p!("symbols", "array", "List of symbol names (alternative to query)"), p!("includeSource", "boolean", "Include source code sections (default true)")],
            required: &[],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "search_symbols",
            description: "Find symbols by name. Fuzzy search — type a partial name, get back matching nodes with IDs, types, locations. Your FIRST step when you know the function/class name but not its node ID. \"找一下 auth 相关的模块\" → this. After finding the ID, follow up with get_neighbors or inspect_symbol.",
            params: &[p!("query", "string", "Partial name or ID to search for"), p!("limit", "integer", "Max results (default 20)")],
            required: &["query"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "semantic_search",
            description: "Semantic symbol search over the vector index (embeddings of source snippets). Finds symbols by MEANING when you don't know the exact name — 'where is memory freed' surfaces lifecycle functions even if named releaseTeardown. Returns full node info + similarity score. Complements search_symbols (exact/fuzzy name matching). Index is built during analyze and rebuilt on incremental updates; check engine_status (vector_index) for availability.",
            params: &[
                p!("query", "string", "Natural-language or code phrase describing WHAT you're looking for (not its name), e.g. 'memory lifecycle management'"),
                p!("limit", "integer", "Max results (default 10, max 50)"),
            ],
            required: &["query"],
            read_only: true,
            category: "graph",
        },
        // ── 图导航 ──
        ToolSchema {
            name: "get_neighbors",
            description: "Get the direct neighborhood of a node — who depends on it and who it depends on (1-hop subgraph). Use after search_symbols when you've found a symbol and want to see its immediate coupling. \"这个模块被谁依赖？\" → call this.",
            params: &[p!("nodeId", "string", "The node ID"), p!("excludeSynthesized", "boolean", "Exclude heuristic-synthesized edges (dynamic dispatch / framework routes / DI reflection) from incoming/outgoing lists (default false)")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "trace_impact",
            description: "Map the blast radius of a change. BFS from a node through all downstream dependents — returns the complete impact tree layered by distance. Use BEFORE editing any high-fan-in symbol. \"改这个会炸多少地方？\" → call this first.",
            params: &[p!("nodeId", "string", "The source node ID"), p!("depth", "integer", "BFS max depth (default 3)")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "find_dep_path",
            description: "Find the dependency chain between two nodes — shows every route from A to B with hop count and edge types. Use when you need to understand HOW two modules are connected. \"A 是怎么依赖到 B 的？\"",
            params: &[p!("from", "string", "Source node ID"), p!("to", "string", "Target node ID"), p!("depth", "integer", "BFS search depth limit (default 20)")],
            required: &["from", "to"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "inspect_symbol",
            description: "Everything about one symbol in a single call: identity (name/kind/degree), community membership, ALL incoming/outgoing edges grouped by kind (imports, calls, inherits, etc.). Use after search_symbols when you need the full picture of a specific symbol. Supersedes symbol_history.",
            params: &[p!("nodeId", "string", "The node ID")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "symbol_history",
            description: "Get decision history for a node — which past commits/analyses touched this symbol, dependency/dependent counts, and timeline events. Use when you need context on why a module looks the way it does. For richer data use inspect_symbol instead.",
            params: &[p!("nodeId", "string", "The node ID")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        // ── 社区 ──
        ToolSchema {
            name: "get_community",
            description: "Which group does this module belong to? Returns the node's community (Leiden clustering), parent community, and sibling nodes. Use when asked \"this module is in which group?\" or to find closely-related modules. For global community structure, use cluster_report.",
            params: &[p!("nodeId", "string", "The node ID")],
            required: &["nodeId"],
            read_only: true,
            category: "graph",
        },
        ToolSchema {
            name: "cluster_report",
            description: "Global community/cluster map — which modules naturally group together (Leiden algorithm). Sorted by size with member lists. Use for high-level architecture understanding. For a single node's community, use get_community instead.",
            params: &[p!("min_size", "integer", "Minimum community size to report (default 3)"), p!("max_nodes", "integer", "Max node IDs per community in output (default 20, max 200)")],
            required: &[],
            read_only: true,
            category: "graph",
        },
        // ── 分析 ──
        ToolSchema {
            name: "grpc_services",
            description: "gRPC/protobuf service map — every service and rpc method from .proto files, each method's implementation status (implemented / missing) and client call-site count. Use for microservice architecture understanding and finding unimplemented contracts. For a single method's callers, use inspect_symbol or trace_impact.",
            params: &[],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
                        name: "fragile_modules",
            description: "Top N most coupled modules ranked by structural fan-in/fan-out and coupling depth. High score = core hub with many dependents (well-designed hubs naturally rank high). For data-flow coupling (reads/writes) and temporal coupling (triggers/awaits), use trace_dataflow or async_edges.",
            params: &[p!("limit", "integer", "Number of top fragile modules to return (default 5)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "detect_cycles",
            description: "Find all circular dependencies in the graph. Each cycle has a `category`: pure_code (normal coupling, harmless), data_persistent (involves storage/IO), or llm_involved (AI feedback loops). Use mode: all, data, or llm. Ignore pure_code cycles — they are natural mutual dependencies, not bugs. \"有没有循环依赖？\" → call this. Use before large refactors to understand what can't be untangled easily.",
            params: &[p_enum!("mode", "string", "Filter: all, data, or llm (default all)", ["all", "data", "llm"])],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "thread_conflicts",
            description: "Thread × resource conflict matrix. Detects shared variables with multiple writers (concurrency risk), concurrent data structure access patterns. Omit nodeId for the global conflict map. \"哪些地方有并发问题？\" → this.",
            params: &[p!("nodeId", "string", "Optional node ID — if omitted, returns global conflict matrix")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "coupling_report",
            description: "Deep-dive coupling profile for one module: L1 (imports) through L4 (temporal/async) breakdown, fan-in/out, cycle participation. Use when asked to analyze a specific file's dependency health. \"auth 模块耦合有多深？\" → this.",
            params: &[p!("module", "string", "Module file name or path")],
            required: &["module"],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "arch_blindspots",
            description: "Architecture blind-spot radar. Detects L4 encapsulation violations, unlocked concurrency, LLM feedback loops. Filter by type (all/L4/thread/cycle). Like a linter for architecture boundaries — catches what code review misses. \"项目有什么隐藏的架构问题？\" → this.",
            params: &[p_enum!("filter", "string", "Boundary type filter: all, L4, thread, cycle (default all)", ["all", "L4", "thread", "cycle"])],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "graph_summary",
            description: "High-level project overview: total nodes/edges, language breakdown, density, top-level modules. Use at the start of a session to understand the codebase landscape. \"这个项目有多大？什么结构？\" → start here, then drill in with specific tools.",
            params: &[],
            required: &[],
            read_only: true,
            category: "graph",
        },
        // ── 时序 ──
        ToolSchema {
            name: "async_edges",
            description: "List all async/temporal edges — triggers, awaits/callbacks, scheduled tasks, sequenced calls. Use when investigating async coupling, race conditions, or temporal dependency chains. \"有哪些异步依赖？\" → this.",
            params: &[],
            required: &[],
            read_only: true,
            category: "temporal",
        },
        ToolSchema {
            name: "project_timeline",
            description: "Chronological project audit log — analysis runs, commits, violations, constraint checks in order. Use for project retrospectives or trend analysis. \"最近项目发生了什么变化？\" → this. Limit for recent, since for date range.",
            params: &[p!("limit", "integer", "Max events to return (default 100)"), p!("since", "string", "ISO timestamp filter (optional)")],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // ── 操作 ──
        ToolSchema {
            name: "analyze_project",
            description: "Full pipeline re-analysis of a project directory. Parses, runs LSP, cross-file resolution, coupling depth, community detection — then reloads the graph. Use when the graph is stale or you've made many changes. SLOW — runs in background; check engine_status for progress.",
            params: &[p!("path", "string", "Project root directory path")],
            required: &["path"],
            read_only: false,
            category: "operations",
        },
        ToolSchema {
            name: "graph_diff",
            description: "Compare current dependency graph against a baseline JSON snapshot. Shows added/removed/modified nodes and edge count changes. Use to understand what changed since last analysis. NOT a git diff — use git_diff for file-level code changes.",
            params: &[p!("beforePath", "string", "Path to the baseline graph JSON file")],
            required: &["beforePath"],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "import_scip",
            description: "Import a SCIP index (index.scip from scip-typescript/scip-python/scip-java/rust-analyzer etc.) and merge its compiler-accurate symbol reference edges into the graph. Adds precise usage/import edges (metadata provenance=scip), definition nodes, and external library symbol nodes. Use to upgrade symbol-level reference quality beyond tree-sitter heuristics. Returns import stats including honestly-skipped references.",
            params: &[p!("path", "string", "Path to index.scip (absolute or project-relative)")],
            required: &["path"],
            read_only: false,
            category: "operations",
        },
        ToolSchema {
            name: "preflight_check",
            description: "Change-impact rehearsal. Before you commit, feed it the files you're about to change — returns estimated blast radius, risk level (low/medium/high/critical), shared variable impacts, and temporal edge signals. \"先看看改这里会怎样？这个改动安全吗？\" → ALWAYS call this before editing high-fan-in files.",
            params: &[p!("path", "array", "List of file paths that would be changed")],
            required: &["path"],
            read_only: true,
            category: "preflight",
        },
        ToolSchema {
            name: "validate_project",
            description: "Full constraint validation — re-analyzes, diffs against baseline, runs all structural checks. Returns violations found AND confirmation of passing rules. Use when user asks for a thorough audit: \"全面检查\" \"跑一遍约束\" \"有没有违规？\". For lighter checks, use arch_blindspots first.",
            params: &[p!("path", "string", "Project root directory path")],
            required: &["path"],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "project_health",
            description: "Project health snapshot: coupling density score (0-100), recent trends, top-changed files, most-interconnected modules. \"项目最近怎么样？\" \"最近的趋势怎么样？\" → this. Score reflects coupling density, not code quality — different project stages have different normal ranges.",
            params: &[p!("path", "string", "Project root directory path"), p!("days", "integer", "Days to look back (default 30)")],
            required: &["path"],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "rename_symbol",
            description: "Safe symbol rename across the dependency graph. ALWAYS run with dryRun=true first to preview affected nodes, then dryRun=false to apply. Persists to storage. \"把这个函数名改掉\" → dry run → review → execute.",
            params: &[p!("oldName", "string", "Current symbol name"), p!("newName", "string", "New symbol name"), p!("dryRun", "boolean", "Preview only — no changes applied (default false)"), p!("nodeId", "string", "Optional specific node ID to rename")],
            required: &["oldName", "newName"],
            read_only: false,
            category: "operations",
        },
        ToolSchema {
            name: "engine_status",
            description: "Engine status and memory stats: loading phase, node/edge counts, storage type, uptime. Use when tools return empty results or Agent needs to confirm the graph is ready. \"引擎就绪了吗？\" → this.",
            params: &[],
            required: &[],
            read_only: true,
            category: "operations",
        },
        ToolSchema {
            name: "check_boundaries",
            description: "Architecture boundary enforcer. Define rules with source/target file patterns (glob or regex) + edge kinds, then scan for violations. \"模块A有没有偷import模块B的内部文件？\" \"数据库模块有没有直接调前端代码？\" → define a rule, run this. Check before and after refactors to confirm no new violations.",
            params: &[
                p!("rules", "array", "JSON array of rule objects. Each rule: {name, source, target, edge_kinds?, message?}. source/target are glob or regex patterns. edge_kinds defaults to [\"imports\"]. Valid kinds: imports, calls, inherits, defines, reads, writes, shares, triggers, awaits, sequences."),
                p!("source", "string", "Shortcut: single source file pattern (instead of full rules array)"),
                p!("target", "string", "Shortcut: single target file pattern (instead of full rules array)"),
                p!("edge_kinds", "array", "Shortcut: edge kinds for single-rule mode. Default: [\"imports\"]"),
            ],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // ── 死代码检测 ──
        ToolSchema {
            name: "find_unused",
            description: "Find dead code candidates — symbols with zero non-defines incoming references. Excludes the mandatory \"defines\" edge each symbol gets from its parent file. Results with non_defines_in_degree>0 have real callers (via bus.emit/Tauri invoke/etc) and are false positives — ignore them. Sorted by outgoing references descending. \"有没有没用到的代码？\" → this. Always review results before deleting — some low-fan-in symbols are intentional (entry points, tests).",
            params: &[
                p!("limit", "integer", "Max results (default 20, max 200)"),
                p!("kind_filter", "string", "Node kinds to include, comma-separated. Default: \"function,class\". Options: symbol, function, class, module, interface, medium, temporal."),
            ],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // ── 流程检测 ──
        ToolSchema {
            name: "list_flows",
            description: "List execution flows in the codebase, sorted by criticality. Each flow is a full call chain from an entry point (framework route, main function, CLI command) through all its callees. \"这个项目的核心业务流程是什么？\" \"哪些调用链最关键？\" → this. Follow up with get_flow to drill into a specific flow.",
            params: &[
                p_enum!("sort_by", "string", "Sort: criticality (default), depth, node_count, file_count, name", ["criticality", "depth", "node_count", "file_count", "name"]),
                p!("limit", "integer", "Max flows (default 50, max 200)"),
                p_enum!("kind_filter", "string", "Entry kind filter: framework_route, naming_convention, orphan_entry", ["framework_route", "naming_convention", "orphan_entry"]),
                p_enum!("detail_level", "string", "standard (default) or minimal (name + criticality only)", ["standard", "minimal"]),
            ],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "get_flow",
            description: "Get the full call path of a single execution flow. Returns every step (function name, file, line) from entry point to deepest callee. Use after list_flows to drill into a critical flow. \"这个登录流程具体经过哪些函数？\" → this with the flow id or name.",
            params: &[
                p!("flow_id", "number", "Flow ID from list_flows"),
                p!("flow_name", "string", "Flow name to search (partial match) — ignored if flow_id given"),
                p!("include_source", "boolean", "Include source snippets for each step (default false)"),
            ],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        ToolSchema {
            name: "get_affected_flows",
            description: "Find execution flows that pass through changed files. Maps your code changes to the user-facing or critical paths they impact. \"我改了 auth.js，会影响哪些业务流程？\" → this. Use before merging to understand downstream impact.",
            params: &[
                p!("files", "array", "Changed file paths, e.g. [\"src/auth.py\", \"src/db.py\"]"),
                p!("changed_nodes", "array", "Specific node IDs to check (optional — uses files if omitted)"),
            ],
            required: &[],
            read_only: true,
            category: "analysis",
        },
        // ── 数据流追踪 ──
        ToolSchema {
            name: "trace_dataflow",
            description: "Syntax-level identifier usage census per function scope (heuristic, NOT semantic dataflow): which identifiers each function scope reads/writes, name-collision-based shared-state candidates, await/trigger patterns, and consecutive call sequences. No interprocedural propagation, no aliasing, no taint sources/sinks — do NOT treat results as proven data flow. Use resolve_call (LSP) for precise per-call resolution, trace_impact for structural blast radius. Pass the file paths you're investigating.",
            params: &[p!("files", "array", "File paths, e.g. [\"src/auth.js\", \"src/db.js\"]")],
            required: &["files"],
            read_only: true,
            category: "dataflow",
        },
        // ── LSP ──
        ToolSchema {
            name: "resolve_call",
            description: "Resolve a function/method call to its concrete definition(s). Uses native LSP (rust-analyzer/gopls/pyright) for polymorphic dispatch, struct methods, inheritance. When the graph shows `do_thing()` and you need to know WHICH `do_thing` — this resolves it.",
            params: &[
                p!("file", "string", "File path, e.g. \"src/views.py\""),
                p!("function", "string", "Optional: filter to calls from a specific function, e.g. \"login\""),
                p!("line", "number", "Optional: 0-based line number for native LSP resolution"),
                p!("column", "number", "Optional: 0-based column for native LSP resolution"),
            ],
            required: &["file"],
            read_only: true,
            category: "lsp",
        },
        ToolSchema {
            name: "infer_type",
            description: "What type is this expression? Uses native LSP hover for precise type info — struct fields, return types, variable types. \"这个变量是什么类型？\" → this at the position. Fallback to call-target-based inference when LSP isn't available.",
            params: &[
                p!("file", "string", "File path, e.g. \"src/views.py\""),
                p!("line", "number", "0-based line number"),
                p!("column", "number", "0-based column"),
            ],
            required: &["file", "line", "column"],
            read_only: true,
            category: "lsp",
        },
        ToolSchema {
            name: "find_implementations",
            description: "Find all implementations of an interface/trait/abstract class. Uses native LSP textDocument/implementation. \"这个接口有哪些实现？\" \"谁实现了这个 trait？\" → click on the definition, call this. Returns the full implementation tree.",
            params: &[
                p!("file", "string", "File path, e.g. \"src/interface.go\""),
                p!("line", "number", "0-based line number"),
                p!("column", "number", "0-based column"),
            ],
            required: &["file", "line", "column"],
            read_only: true,
            category: "lsp",
        },
        ToolSchema {
            name: "find_references",
            description: "Find every place that references this symbol — across the entire codebase. Uses native LSP textDocument/references. \"谁在用这个函数？\" \"这个类在哪被引用了？\" → this. Set includeDeclaration=true to include the definition itself. High reference count → call trace_impact before changing.",
            params: &[
                p!("file", "string", "File path"),
                p!("line", "number", "0-based line number"),
                p!("column", "number", "0-based column"),
                p!("includeDeclaration", "boolean", "Include the definition itself (default false)"),
            ],
            required: &["file", "line", "column"],
            read_only: true,
            category: "lsp",
        },
        // ── 壳专属方法（contract.rs SHELL_METHODS 的 schema 载体；hidden ——
        //    不进 DEFAULT_MCP_TOOLS，tools/list 默认不可见，tools/call 可达）──
        ToolSchema {
            name: "graph_snapshot",
            description: "[SHELL] Aggregated graph snapshot: node/edge counts, kind distribution, edge-kind distribution, community sizes, top fan-in/out, class count. Replaces raw-graph transfer for out-of-process hosts.",
            params: &[],
            required: &[],
            read_only: true,
            category: "shell",
        },
        ToolSchema {
            name: "file_nodes",
            description: "[SHELL] Symbol index for one file (id/name/kind/fanIn/fanOut). Replaces host-side full-graph index building; one lightweight query per file.",
            params: &[p!("file", "string", "File path (relative to project root or absolute)")],
            required: &["file"],
            read_only: true,
            category: "shell",
        },
        ToolSchema {
            name: "analyze_with_progress",
            description: "[SHELL] Full analysis in background; progress arrives via notifications/progress. Path defaults to the bound project root.",
            params: &[p!("path", "string", "Project root path (optional; defaults to bound root)")],
            required: &[],
            read_only: false,
            category: "shell",
        },
        ToolSchema {
            name: "save",
            description: "[SHELL] Persist the store to disk (.hologram/hologram.db).",
            params: &[],
            required: &[],
            read_only: false,
            category: "shell",
        },
        ToolSchema {
            name: "fts_search",
            description: "[SHELL] FTS5 full-text search (content-level; distinct from search_symbols name matching).",
            params: &[
                p!("query", "string", "Search query"),
                p!("limit", "integer", "Max results (default 20)"),
            ],
            required: &["query"],
            read_only: true,
            category: "shell",
        },
        ToolSchema {
            name: "timeline_record",
            description: "[SHELL] Record a timeline event (write action).",
            params: &[
                p!("event", "string", "Event name"),
                p!("detail", "string", "Event summary (optional; defaults to event name)"),
                p!("node_id", "string", "Related node (optional)"),
            ],
            required: &["event"],
            read_only: false,
            category: "shell",
        },
        ToolSchema {
            name: "diff",
            description: "[SHELL] Baseline diff: baseline.json (default <root>/.hologram/baseline.json, override with baseline_path) vs current graph.",
            params: &[p!("baseline_path", "string", "Baseline file path (optional)")],
            required: &[],
            read_only: true,
            category: "shell",
        },
        ToolSchema {
            name: "ensure_ready",
            description: "[SHELL] Ensure engine readiness — same-root idempotent, different-root refused (one process per workspace). Returns readiness for the host to decide next step.",
            params: &[p!("path", "string", "Project root path (optional; defaults to bound root)")],
            required: &[],
            read_only: true,
            category: "shell",
        },
        ToolSchema {
            name: "cache_stale",
            description: "[SHELL] Whether the persisted graph is stale (source mtimes vs last persistence). Reason and baseline kind are reported.",
            params: &[p!("path", "string", "Project root path (optional; defaults to bound root)")],
            required: &[],
            read_only: true,
            category: "shell",
        },
        ToolSchema {
            name: "watcher_subscribe",
            description: "[SHELL] Subscribe to watcher notifications — change summaries arrive via notifications/message (data = JSON string).",
            params: &[],
            required: &[],
            read_only: false,
            category: "shell",
        },
        ToolSchema {
            name: "run_check",
            description: "[SHELL] Preflight check: load baseline, diff vs current graph, persist new baseline, record timeline (quiet/baseline_seed gated). Orchestration lives in the engine.",
            params: &[
                p!("path", "string", "Project root path (optional; defaults to bound root, different root refused)"),
                p!("changed_files", "array", "Files changed since the last check"),
            ],
            required: &[],
            read_only: false,
            category: "shell",
        },
    ]
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_count() {
        let schemas = all_schemas();
        assert!(!schemas.is_empty(), "must have at least one tool");
    }

    #[test]
    fn test_builtin_handler_registry_covers_default_tools() {
        // handler id 注册表（免编译扩展面 Phase 4）必须覆盖全部模型默认工具——
        // manifest 工具的可寻址面 = DEFAULT_MCP_TOOLS，漏一 id 即 manifest 无法复用。
        for id in ToolRegistry::DEFAULT_MCP_TOOLS {
            assert!(
                builtin_handler(id).is_some(),
                "handler id '{id}' missing from builtin_handler registry"
            );
        }
        // 壳专属方法刻意不入表（host API 不经 manifest 暴露）
        assert!(builtin_handler("graph_snapshot").is_none());
        assert!(builtin_handler("no_such_handler").is_none());
    }

    #[test]
    fn test_mcp_tools_list_format() {
        let registry = ToolRegistry::global();
        let tools = registry.tools_list();
        assert!(!tools.is_empty());
        for tool in &tools {
            assert!(tool.get("name").and_then(|v| v.as_str()).is_some(), "every tool must have a name");
            assert!(tool.get("description").and_then(|v| v.as_str()).is_some(), "every tool must have a description");
            assert!(tool.get("inputSchema").is_some(), "every tool must have inputSchema");
        }
    }

    #[test]
    fn test_dispatch_unknown_tool() {
        let dummy_id = json!(1);
        let result = ToolRegistry::dispatch("nonexistent_tool", &json!({}), &dummy_id);
        // 降级响应仍是成功（JSON-RPC 中无 error 字段）
        assert!(result.get("result").is_some(), "unknown tool should return degraded result, not error");
    }

    #[test]
    fn test_all_tools_dispatchable() {
        let dummy_id = json!(1);
        let schemas = all_schemas();
        for schema in schemas {
            let args = json!({});
            let result = ToolRegistry::dispatch(schema.name, &args, &dummy_id);
            assert!(result.is_object(), "dispatch({}) must return a JSON object", schema.name);
        }
    }

    /// 契约一致性（engine-plugin-extraction Phase 1）：contract.rs 的
    /// SHELL_METHODS 必须与注册面完全对齐 —— schema 已注册（tools/call
    /// 可达）、不在模型默认清单（tools/list 不可见）、与 dispatch 分支一一对应。
    #[test]
    fn test_shell_methods_contract_alignment() {
        let contract_names = crate::contract::shell_method_names();
        assert_eq!(contract_names.len(), 11, "契约 v3 = 11 个壳专属方法");
        let registry = ToolRegistry::global();
        let default_set: HashSet<&str> = ToolRegistry::DEFAULT_MCP_TOOLS.iter().copied().collect();
        let dummy_id = json!(1);
        for name in &contract_names {
            assert!(
                registry.get_schema(name).is_some(),
                "壳方法 {name} 未注册 schema（tools/call 会被拒）"
            );
            assert!(
                !default_set.contains(name),
                "壳方法 {name} 不得进模型默认工具面"
            );
            let result = ToolRegistry::dispatch(name, &json!({}), &dummy_id);
            let text = result["result"]["content"][0]["text"].as_str().unwrap_or("");
            assert!(
                !text.contains("Tool not found"),
                "壳方法 {name} 的 dispatch 分支缺失: {text}"
            );
        }
        // 反向：schema 里 category = "shell" 的条目必须恰好是契约清单
        let shell_schemas: Vec<&str> = all_schemas()
            .iter()
            .filter(|s| s.category == "shell")
            .map(|s| s.name)
            .collect();
        assert_eq!(shell_schemas.len(), contract_names.len(), "shell 类目 schema 数应与契约一致");
        for name in &contract_names {
            assert!(shell_schemas.contains(name), "契约方法 {name} 缺 shell 类目 schema");
        }
    }

    /// tools/list 默认面绝不返回壳专属方法（hidden 机制的行为面验证）。
    #[test]
    fn test_shell_methods_absent_from_tools_list() {
        let contract_names: HashSet<&str> = crate::contract::shell_method_names().into_iter().collect();
        let tools = ToolRegistry::global().tools_list();
        for tool in &tools {
            let name = tool.get("name").and_then(|v| v.as_str()).unwrap_or("");
            assert!(
                !contract_names.contains(name),
                "tools/list 泄漏了壳专属方法 {name}"
            );
        }
    }

    #[test]
    fn test_tool_names_unique() {
        let schemas = all_schemas();
        let mut names: Vec<&str> = schemas.iter().map(|s| s.name).collect();
        names.sort();
        let mut uniq = names.clone();
        uniq.dedup();
        assert_eq!(names.len(), uniq.len(), "all tool names must be unique");
    }

    #[test]
    fn test_schema_get() {
        let registry = ToolRegistry::global();
        let schema = registry.get_schema("get_neighbors");
        assert!(schema.is_some());
        assert_eq!(schema.unwrap().name, "get_neighbors");
        assert!(registry.get_schema("nonexistent_tool").is_none());
    }

    #[test]
    fn test_missing_required_params_error() {
        let dummy_id = json!(1);
        let result = ToolRegistry::dispatch("get_neighbors", &json!({}), &dummy_id);
        // 降级结果包装在 JSON-RPC 成功格式中，带 _isDegraded 标志
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("node_id") || text.contains("nodeId"),
            "get_neighbors should degrade on missing nodeId, got: {}", text);
        let result = ToolRegistry::dispatch("find_dep_path", &json!({}), &dummy_id);
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("from_id") || text.contains("fromId"),
            "find_dep_path should degrade on missing params");
        let result = ToolRegistry::dispatch("coupling_report", &json!({}), &dummy_id);
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("module_name") || text.contains("module"),
            "coupling_report should degrade on missing module_name");
        let result = ToolRegistry::dispatch("search_symbols", &json!({}), &dummy_id);
        let text = result["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("query"), "search_symbols should degrade on missing query");
    }

    #[test]
    fn test_category_assignments() {
        let schemas = all_schemas();
        for schema in schemas {
            assert!(!schema.category.is_empty(), "tool '{}' must have a category", schema.name);
        }
        let categories: Vec<&str> = schemas.iter().map(|s| s.category).collect();
        assert!(categories.contains(&"graph"));
        assert!(categories.contains(&"analysis"));
        assert!(categories.contains(&"operations"));
        assert!(categories.contains(&"dataflow"));
        assert!(categories.contains(&"temporal"));
        assert!(categories.contains(&"preflight"));
    }

    #[test]
    fn test_read_only_consistency() {
        let schemas = all_schemas();
        let read_only_tools: Vec<&str> = schemas.iter().filter(|s| s.read_only).map(|s| s.name).collect();
        assert!(!read_only_tools.contains(&"analyze_project"), "analyze mutates state");
        assert!(!read_only_tools.contains(&"rename_symbol"), "rename mutates state");
        assert!(read_only_tools.contains(&"get_neighbors"));
        assert!(read_only_tools.contains(&"search_symbols"));
        assert!(read_only_tools.contains(&"engine_status"));
    }

    // ═══════════════════════════════════════════════════════════
    // 契约 v5 域折叠 guard —— 折叠必须「不丢工具、不说谎、不遮壳方法」
    // ═══════════════════════════════════════════════════════════

    /// 域表覆盖：默认面里每个只读工具恰好是一个域动作。
    #[test]
    fn test_domain_actions_cover_readonly_defaults() {
        let mut folded: Vec<&str> = Vec::new();
        for d in DOMAIN_SPECS {
            assert!(d.read_only, "域 {} 现在是只读域（写工具留顶层）", d.name);
            for a in d.actions {
                assert!(
                    !folded.contains(&a.tool),
                    "工具 {} 被多个域承载（折叠必须唯一）",
                    a.tool
                );
                folded.push(a.tool);
            }
        }
        for name in ToolRegistry::DEFAULT_MCP_TOOLS {
            let schema = find_schema(name).unwrap_or_else(|| panic!("默认工具 {name} 缺 schema"));
            if schema.read_only {
                assert!(
                    folded.contains(name),
                    "只读默认工具 {name} 未进任何域（折叠漏项 = 模型面少一个能力）"
                );
            } else {
                assert!(
                    !folded.contains(name),
                    "写工具 {name} 不得进只读域（MCP 只读注解只能到工具粒度）"
                );
            }
        }
        assert_eq!(folded.len(), 33, "只读默认工具折叠数（36 默认 - 3 写）");
    }

    /// 域动作目标必须存在且在默认可寻址面内（域不许挂隐藏工具）。
    #[test]
    fn test_domain_action_targets_resolve() {
        for d in DOMAIN_SPECS {
            let mut actions: Vec<&str> = Vec::new();
            for a in d.actions {
                assert!(
                    find_schema(a.tool).is_some(),
                    "域 {}.{} 指向不存在的工具 {}",
                    d.name,
                    a.action,
                    a.tool
                );
                assert!(
                    ToolRegistry::DEFAULT_MCP_TOOLS.contains(&a.tool),
                    "域 {}.{} 指向非默认工具 {}（域面不许吞隐藏名）",
                    d.name,
                    a.action,
                    a.tool
                );
                assert!(!a.hint.is_empty(), "域 {}.{} 缺路由提示", d.name, a.action);
                assert!(
                    !actions.contains(&a.action),
                    "域 {} 动作名重复：{}",
                    d.name,
                    a.action
                );
                actions.push(a.action);
            }
        }
    }

    /// 域内同名参数类型必须一致——域 schema 的 properties 是并集，冲突即对模型说谎。
    #[test]
    fn test_domain_param_types_consistent() {
        for d in DOMAIN_SPECS {
            let mut seen: Vec<(&str, &str)> = Vec::new();
            for a in d.actions {
                let schema = find_schema(a.tool).expect("guard: target resolves");
                for p in schema.params {
                    if let Some((_, prev)) = seen.iter().find(|(n, _)| *n == p.name) {
                        assert_eq!(
                            *prev, p.ptype,
                            "域 {} 参数 {} 类型冲突（{} vs {}，来自 {}）",
                            d.name, p.name, prev, p.ptype, a.tool
                        );
                    } else {
                        seen.push((p.name, p.ptype));
                    }
                }
            }
        }
    }

    /// 域名与工具名不得撞名（tools/call 路由必须无歧义）。
    #[test]
    fn test_domain_names_do_not_collide() {
        let tools: HashSet<&str> = all_schemas().iter().map(|s| s.name).collect();
        let mut domains: Vec<&str> = Vec::new();
        for d in DOMAIN_SPECS {
            assert!(!tools.contains(d.name), "域名 {} 与工具名撞车", d.name);
            assert!(!domains.contains(&d.name), "域名重复：{}", d.name);
            domains.push(d.name);
        }
    }

    /// 默认可见面 = 域 + 未折叠默认工具（写 3 个）；原名一个不丢（可寻址面 36）。
    #[test]
    fn test_default_visible_face_is_folded() {
        let face = default_visible_names();
        assert_eq!(face.len(), DOMAIN_SPECS.len() + 3, "默认面 = 4 域 + 3 写工具");
        for d in DOMAIN_SPECS {
            assert!(face.contains(&d.name.to_string()));
        }
        for w in ["analyze_project", "import_scip", "rename_symbol"] {
            assert!(face.contains(&w.to_string()), "写工具 {w} 必须留在可见面");
        }
        // 折叠不改可达性：全部默认工具仍可 tools/call 直达
        let registry = ToolRegistry::global();
        for name in ToolRegistry::DEFAULT_MCP_TOOLS {
            assert!(registry.knows_tool(name), "折叠后原名 {name} 必须仍可寻址");
        }
    }

    /// 三档可见面语义（直接喂 mode，不碰进程环境）。
    #[test]
    fn test_surface_modes() {
        let folded = ToolRegistry::tools_list_with(&SurfaceMode::Folded);
        let folded_names: Vec<&str> = folded.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(folded_names.len(), DOMAIN_SPECS.len() + 3);

        let all = ToolRegistry::tools_list_with(&SurfaceMode::AllRaw);
        let all_names: Vec<&str> = all.iter().filter_map(|t| t["name"].as_str()).collect();
        // 全量面 = 全部非壳 schema（36 默认 + legacy symbol_history = 37）
        let non_shell = all_schemas()
            .iter()
            .filter(|s| s.category != "shell")
            .count();
        assert_eq!(all_names.len(), non_shell, "全量面 = 全部非壳 schema");
        assert_eq!(non_shell, 37);
        assert!(all_names.contains(&"search_symbols"));

        let explicit = ToolRegistry::tools_list_with(&SurfaceMode::Explicit(vec![
            "graph".into(),
            "engine_status".into(),
        ]));
        let explicit_names: Vec<&str> =
            explicit.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(explicit_names.len(), 2, "严格名单：域名整域出，原名单出");
        assert!(explicit_names.contains(&"graph"));
        assert!(explicit_names.contains(&"engine_status"));
    }

    /// `HOLOGRAM_MCP_TOOLS` 解析：空白容忍 + 空值回落折叠面（不静默空面）。
    #[test]
    fn test_parse_surface_mode() {
        assert!(matches!(
            ToolRegistry::parse_surface_mode(None),
            SurfaceMode::Folded
        ));
        assert!(
            matches!(ToolRegistry::parse_surface_mode(Some("")), SurfaceMode::Folded),
            "空值 = 未设（回落折叠面，不许解析成空面）"
        );
        assert!(matches!(
            ToolRegistry::parse_surface_mode(Some("   ")),
            SurfaceMode::Folded
        ));
        assert!(
            matches!(ToolRegistry::parse_surface_mode(Some("*")), SurfaceMode::AllRaw),
            "全量面"
        );
        // 实测坑：cmd 的 `set VAR=* && …` 会带尾随空格——必须仍是全量面
        assert!(
            matches!(ToolRegistry::parse_surface_mode(Some("* ")), SurfaceMode::AllRaw),
            "尾随空白不得把全量面解析成空集"
        );
        match ToolRegistry::parse_surface_mode(Some(" graph , engine_status ")) {
            SurfaceMode::Explicit(names) => assert_eq!(names, vec!["graph", "engine_status"]),
            _ => panic!("显式名单应解析为 Explicit"),
        }
    }

    /// 域 schema 形状：action 枚举 + 成员参数并集 + 只读注解。
    #[test]
    fn test_domain_schema_shape() {
        let value = domain_of("graph").expect("graph 域存在").mcp_value();
        assert_eq!(value["name"], "graph");
        assert_eq!(value["annotations"]["readOnlyHint"], true);
        let props = &value["inputSchema"]["properties"];
        assert!(props["action"]["description"]
            .as_str()
            .expect("action 说明")
            .contains("impact"));
        let actions = props["action"]["enum"].as_array().expect("action 枚举");
        assert_eq!(actions.len(), 10);
        // 参数文档派生自成员 schema（抽一个验证透传）
        assert_eq!(props["nodeId"]["type"], "string");
        assert!(props["nodeId"]["description"].as_str().is_some());
        assert_eq!(value["inputSchema"]["required"][0], "action");
        // 未折叠的写工具仍是标准注解形态
        let raw = find_schema("rename_symbol").expect("写工具 schema").mcp_value();
        assert_eq!(raw["annotations"]["readOnlyHint"], false);
        assert!(raw.get("readOnly").is_none(), "非标准顶层 readOnly 已删");
    }

    /// 域调用 ≡ 原名调用（逐字节等价，action 键被剥离）+ 缺/错 action 给引导。
    #[test]
    fn test_domain_call_routes_like_raw_tool() {
        let id = json!(1);
        let routed = ToolRegistry::dispatch("graph", &json!({"action": "neighbors"}), &id);
        let raw = ToolRegistry::dispatch("get_neighbors", &json!({}), &id);
        assert_eq!(
            routed["result"]["content"][0]["text"], raw["result"]["content"][0]["text"],
            "域路由必须与原名调用逐字节等价"
        );

        let missing = ToolRegistry::dispatch("graph", &json!({}), &id);
        let text = missing["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains("requires an 'action'"), "缺 action 要可见: {text}");
        assert!(text.contains("valid actions"), "缺 action 要给合法清单: {text}");

        let unknown = ToolRegistry::dispatch("graph", &json!({"action": "nope"}), &id);
        let text = unknown["result"]["content"][0]["text"].as_str().unwrap_or("");
        assert!(text.contains("unknown graph action"), "未知 action 要具名: {text}");
        assert!(text.contains("_isDegraded"), "未知 action 走降级而非静默: {text}");
    }

    /// 建议必须落在可见面：折叠后回吐裸名 = 建议指向不存在的工具。
    #[test]
    fn test_suggestions_use_visible_refs() {
        let id = json!(1);
        let result = ToolRegistry::dispatch("graph", &json!({"action": "impact"}), &id);
        let text = result["result"]["content"][0]["text"].as_str().unwrap_or("");
        let payload: Value = serde_json::from_str(text).expect("工具响应是 JSON 文本");
        let suggestions = payload["next_tool_suggestions"]
            .as_array()
            .expect("建议数组");
        assert!(!suggestions.is_empty());
        let visible: HashSet<String> = default_visible_names().into_iter().collect();
        for s in suggestions {
            let name = s.as_str().expect("建议是字符串");
            let head = name.split('(').next().unwrap_or("");
            assert!(
                visible.contains(head),
                "建议 {name} 不在可见面（模型照调必撞 Degraded）"
            );
        }
        // 折叠面里必须出现 `域(动作)` 形态，而不是裸工具名
        assert!(
            suggestions.iter().any(|s| s.as_str().unwrap_or("").contains('(')),
            "折叠后建议应写成 domain(action) 形态: {suggestions:?}"
        );
        assert!(visible_ref("trace_impact").as_deref() == Some("graph(impact)"));
        assert!(visible_ref("symbol_history").is_none(), "隐藏名不进建议");
    }

    #[test]
    fn test_resolve_in_index_suffix_match() {
        use hologram_graph::{Node, NodeKind};
        let mut idx = hologram_storage::MemoryIndex::default();
        let mut node = Node::new(
            "D:.HoloGramHG.src-ui.src.agent.ts.Agent.setPlanState",
            "setPlanState",
            NodeKind::Function,
        );
        node.location = Some("src/agent/agent.ts:100".into());
        idx.insert_node(node);
        // 精确 ID
        assert_eq!(
            resolve_in_index(&idx, "D:.HoloGramHG.src-ui.src.agent.ts.Agent.setPlanState").as_deref(),
            Some("D:.HoloGramHG.src-ui.src.agent.ts.Agent.setPlanState")
        );
        // 精确名称
        assert_eq!(resolve_in_index(&idx, "setPlanState").as_deref(), Some("D:.HoloGramHG.src-ui.src.agent.ts.Agent.setPlanState"));
        // 后缀匹配（LLM 直觉 ID）
        assert_eq!(resolve_in_index(&idx, "agent.ts.Agent.setPlanState").as_deref(), Some("D:.HoloGramHG.src-ui.src.agent.ts.Agent.setPlanState"));
        assert_eq!(resolve_in_index(&idx, "Agent.setPlanState").as_deref(), Some("D:.HoloGramHG.src-ui.src.agent.ts.Agent.setPlanState"));
        // 无匹配
        assert_eq!(resolve_in_index(&idx, "nonexistent_symbol"), None);
    }
}
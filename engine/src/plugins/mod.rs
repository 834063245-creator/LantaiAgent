// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 免编译扩展面（engine-plugin-extraction Phase 4）。
//!
//! `HOLOGRAM_PLUGIN_DIR` 指向扩展目录（缺省 `<project_root>/plugins`，不存在即空）；
//! 目录下每个 `*.yml` 是一份 manifest，声明三类扩展之一：
//!
//! - `language`  — 扩展名表 + 语法（`builtin` 复用静态语法 / `dll` 显式加载）
//!                 + 可选 `.scm` 查询（structure / dataflow，运行时读盘）
//! - `framework` — 路由候选模式（glob），命中文件注入 route 节点
//! - `tool`      — 工具 schema + handler id（复用既有 handler，不引入任意代码执行）
//!
//! 装载时机：`engine_init` 首行 —— serve 进程启动即装载，先于 watcher 扩展表
//! 快照与任何分析。失败语义：单份 manifest 失败只记入 errors
//! （`engine_status.extensions` 可见 + warn 日志），绝不阻断引擎启动。
//!
//! 破坏性兼容由 `manifest_version` 管控：引擎只认本文件声明的版本，
//! 未知版本 = 该 manifest 报错拒绝（不静默降级）。

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock, RwLock};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::analysis::dataflow_engine::LangDataflowConfig;
use crate::tools::{ToolResponse, HandlerFn};

/// 本引擎支持的 manifest 格式版本（破坏性兼容管控位）。
pub const MANIFEST_VERSION: u32 = 1;

// ═══════════════════════════════════════════════════════════════
// Manifest 解析模型（serde，deny_unknown_fields —— 拼错字段可见失败）
// ═══════════════════════════════════════════════════════════════

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    manifest_version: u32,
    kind: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    // ── language ──
    #[serde(default)]
    extensions: Vec<String>,
    #[serde(default)]
    grammar: Option<GrammarSpec>,
    #[serde(default)]
    queries: Option<QueriesSpec>,
    #[serde(default)]
    func_kinds: Vec<String>,
    #[serde(default)]
    class_kinds: Vec<String>,
    // ── framework ──
    #[serde(default)]
    routes: Vec<RouteSpec>,
    // ── tool ──
    #[serde(default)]
    read_only: Option<bool>,
    #[serde(default)]
    handler: Option<String>,
    #[serde(default)]
    params: Vec<ParamSpec>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrammarSpec {
    /// 复用已静态注册的语法键（如 `python`）。与 `dll` 二选一。
    #[serde(default)]
    builtin: Option<String>,
    /// 语法 cdylib 路径（相对 manifest 文件解析）。与 `builtin` 二选一。
    #[serde(default)]
    dll: Option<String>,
    /// DLL 导出符号；缺省 `tree_sitter_{name}`。
    #[serde(default)]
    symbol: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueriesSpec {
    /// 结构查询 .scm（相对 manifest 文件解析）。缺省 = 语言只进发现与
    /// 语法面，结构分析落到 TreeSitterAdapter 通用兜底。
    #[serde(default)]
    structure: Option<String>,
    /// 数据流查询 .scm（相对 manifest 文件解析）。
    #[serde(default)]
    dataflow: Option<String>,
    /// 数据流分析的名称黑名单（内置对象/宿主对象）。
    #[serde(default)]
    skip_names: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteSpec {
    /// 候选模式：glob（`**` 跨目录、`*`/`?` 单段），对项目相对路径匹配。
    pattern: String,
    /// 路由 HTTP 方法；缺省 GET。
    #[serde(default)]
    method: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParamSpec {
    name: String,
    /// string | number | integer | boolean | array | object
    ptype: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    r#enum: Vec<String>,
}

// ═══════════════════════════════════════════════════════════════
// 装载产物（三张注册表的运行时行）
// ═══════════════════════════════════════════════════════════════

/// 语法规格的解析产物（路径已锚定 manifest 所在目录）。
enum GrammarResolved {
    Builtin(String),
    Dll { dll: PathBuf, symbol: String },
}

/// 语言 manifest 的应用条目（AdapterRegistry::new() 尾部消费）。
#[derive(Clone)]
pub(crate) struct LanguageEntry {
    pub extensions: Vec<String>,
    /// 结构查询源（manifest 声明时从盘读入；`&'static` 为装载期一次性泄漏，
    /// 与静态 include_str! 表共享同一进程生命周期语义）。
    pub structure_query: Option<&'static str>,
    pub func_kinds: &'static [&'static str],
    pub class_kinds: &'static [&'static str],
}

/// 数据流 manifest 条目（dataflow_engine::config_for_ext 兜底消费）。
pub(crate) struct DataflowEntry {
    pub ext: String,
    pub grammar_key: &'static str,
    pub config: LangDataflowConfig,
}

/// 路由候选模式（glob → regex 编译产物 + URL 推导前缀）。
#[derive(Clone)]
pub(crate) struct RoutePattern {
    pub matcher: regex::Regex,
    pub method: String,
    /// URL 推导：从相对路径剥离的模式字面前缀（首个通配符前的最后一段目录）。
    pub prefix: String,
}

/// 框架 manifest 的应用条目。
#[derive(Clone)]
pub(crate) struct FrameworkEntry {
    pub name: String,
    pub patterns: Vec<RoutePattern>,
}

/// 工具 manifest 的应用条目（schema 面与既有 ToolSchema 同形状，全 owned）。
pub(crate) struct ToolEntry {
    pub name: String,
    pub description: String,
    pub params: Vec<ParamValue>,
    pub required: Vec<String>,
    pub read_only: bool,
    pub handler: HandlerFn,
}

/// 工具参数值（ParamDef 的 owned 镜像）。
pub(crate) struct ParamValue {
    pub name: String,
    pub ptype: String,
    pub description: String,
    pub enum_values: Vec<String>,
}

impl ToolEntry {
    /// 与 `ToolSchema::mcp_value` 逐字段同形状（tools/list 消费方零感知）。
    pub(crate) fn mcp_value(&self) -> Value {
        let mut properties = serde_json::Map::new();
        for p in &self.params {
            let mut prop = serde_json::Map::new();
            prop.insert("type".to_string(), json!(p.ptype));
            prop.insert("description".to_string(), json!(p.description));
            if !p.enum_values.is_empty() {
                prop.insert("enum".to_string(), json!(p.enum_values));
            }
            properties.insert(p.name.clone(), Value::Object(prop));
        }
        json!({
            "name": self.name,
            "description": self.description,
            // 与 ToolSchema::mcp_value 同形状：只读语义走 MCP 标准注解（契约 v5）
            "annotations": { "readOnlyHint": self.read_only },
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": self.required,
            }
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// 全局状态（进程级；引擎单根纪律下每进程装载一次）
// ═══════════════════════════════════════════════════════════════

struct PluginState {
    dir: Option<PathBuf>,
    loaded: Vec<Value>,
    errors: Vec<Value>,
}

static STATE: OnceLock<RwLock<PluginState>> = OnceLock::new();
/// 上次装载目录（None = 从未装载；Some(None) = 已装载过空集；
/// Some(Some(p)) = 已装载目录 p）——同值重入 no-op，异值整体重放。
static LAST_DIR: Mutex<Option<Option<PathBuf>>> = Mutex::new(None);

static LANGUAGE_ENTRIES: LazyLock<RwLock<Vec<LanguageEntry>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));
static DATAFLOW_ENTRIES: LazyLock<RwLock<Vec<DataflowEntry>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));
static FRAMEWORK_ENTRIES: LazyLock<RwLock<Vec<FrameworkEntry>>> =
    LazyLock::new(|| RwLock::new(Vec::new()));
static TOOL_ENTRIES: LazyLock<RwLock<Vec<ToolEntry>>> = LazyLock::new(|| RwLock::new(Vec::new()));

fn state_cell() -> &'static RwLock<PluginState> {
    STATE.get_or_init(|| {
        RwLock::new(PluginState { dir: None, loaded: Vec::new(), errors: Vec::new() })
    })
}

/// 解析扩展目录：`HOLOGRAM_PLUGIN_DIR` env 优先（设了就用，缺失即报错可见）；
/// 否则 `<project_root>/plugins`（存在才用）；都不满足 = None（无扩展）。
fn resolve_plugin_dir(project_root: &Path) -> Option<PathBuf> {
    if let Ok(v) = std::env::var("HOLOGRAM_PLUGIN_DIR") {
        let p = PathBuf::from(v);
        if !p.is_dir() {
            tracing::warn!("[plugins] HOLOGRAM_PLUGIN_DIR 指向的目录不存在: {}", p.display());
        }
        return Some(p);
    }
    let default = project_root.join("plugins");
    if default.is_dir() {
        return Some(default);
    }
    None
}

/// 装载入口：`engine_init` 首行调用。同目录重入 no-op；目录/内容变更整体重放
/// （表按名替换；语法注册为增量——进程内不可注销，重放主要服务测试）。
/// 已装载过显式目录后，无配置（None）的 engine_init 不清表——进程内配置
/// 不回退，且测试进程里其他用例的 engine_init 不会冲掉 env 装载的扩展。
pub(crate) fn ensure_loaded(project_root: &Path) {
    let dir = resolve_plugin_dir(project_root);
    let mut last = LAST_DIR
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if *last == Some(dir.clone()) {
        return;
    }
    if dir.is_none() && matches!(*last, Some(Some(_))) {
        return;
    }
    let outcome = load_from_dir(dir.as_deref());
    apply(outcome);
    *last = Some(dir);
}

struct LoadOutcome {
    state: PluginState,
    languages: Vec<(String, LanguageManifest)>,
    frameworks: Vec<FrameworkEntry>,
    tools: Vec<ToolEntry>,
}

/// 目录扫描 + 全部 manifest 解析与校验（纯函数，不碰全局表）。
/// 语法注册延后到 apply（GRAMMAR_LOADER 是有副作用的全局）。
fn load_from_dir(dir: Option<&Path>) -> LoadOutcome {
    let mut state = PluginState { dir: dir.map(|p| p.to_path_buf()), loaded: Vec::new(), errors: Vec::new() };
    let mut languages: Vec<(String, LanguageManifest)> = Vec::new();
    let mut frameworks: Vec<FrameworkEntry> = Vec::new();
    let mut tools: Vec<ToolEntry> = Vec::new();
    let Some(dir) = dir else {
        return LoadOutcome { state, languages, frameworks, tools };
    };

    let mut yml_paths: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("yml") | Some("yaml")))
            .collect(),
        Err(e) => {
            state.errors.push(json!({ "file": dir.display().to_string(), "error": format!("read_dir failed: {e}") }));
            return LoadOutcome { state, languages, frameworks, tools };
        }
    };
    yml_paths.sort();

    let mut seen_names: Vec<String> = Vec::new();
    for path in yml_paths {
        let file = path.display().to_string();
        match parse_manifest_file(&path, dir, &seen_names) {
            Ok(ManifestOutcome::Language(lang)) => {
                seen_names.push(lang.name.clone());
                state.loaded.push(json!({ "name": lang.name, "kind": "language", "source": file }));
                languages.push((file, lang));
            }
            Ok(ManifestOutcome::Framework(fw)) => {
                seen_names.push(fw.name.clone());
                state.loaded.push(json!({ "name": fw.name, "kind": "framework", "source": file }));
                frameworks.push(fw);
            }
            Ok(ManifestOutcome::Tool(tool)) => {
                seen_names.push(tool.name.clone());
                state.loaded.push(json!({ "name": tool.name, "kind": "tool", "source": file }));
                tools.push(tool);
            }
            Err(e) => {
                tracing::warn!("[plugins] manifest 装载失败（{file}）: {e}");
                state.errors.push(json!({ "file": file, "error": e }));
            }
        }
    }
    LoadOutcome { state, languages, frameworks, tools }
}

enum ManifestOutcome {
    Language(LanguageManifest),
    Framework(FrameworkEntry),
    Tool(ToolEntry),
}

/// 语言 manifest 的完整解析产物（语法注册延后到 apply）。
struct LanguageManifest {
    name: String,
    entry: LanguageEntry,
    grammar: GrammarResolved,
    extensions: Vec<String>,
    dataflow: Vec<DataflowEntry>,
}

/// 解析 + 校验单份 manifest（除语法注册外的全部规则都在这里）。
fn parse_manifest_file(path: &Path, dir: &Path, seen_names: &[String]) -> Result<ManifestOutcome, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read failed: {e}"))?;
    let m: ManifestFile = serde_yaml::from_str(&raw)
        .map_err(|e| format!("yaml parse failed: {e}"))?;

    if m.manifest_version != MANIFEST_VERSION {
        return Err(format!(
            "unsupported manifest_version {} (engine supports {})",
            m.manifest_version, MANIFEST_VERSION
        ));
    }
    if m.name.is_empty() {
        return Err("name must be non-empty".to_string());
    }
    if seen_names.iter().any(|n| n == &m.name) {
        return Err(format!("duplicate manifest name '{}'", m.name));
    }

    match m.kind.as_str() {
        "language" => build_language(m, path, dir),
        "framework" => build_framework(m),
        "tool" => build_tool(m),
        other => Err(format!("unknown kind '{other}' (expected language | framework | tool)")),
    }
}

/// 扩展名归一：去前导点、小写、去重。返回校验错误（非空 + 字符集）。
fn normalize_extensions(raw: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for e in raw {
        let ext = e.trim().trim_start_matches('.').to_ascii_lowercase();
        if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!("invalid extension '{e}' (expected [a-z0-9]+ without dot)"));
        }
        if !out.contains(&ext) {
            out.push(ext);
        }
    }
    if out.is_empty() {
        return Err("extensions must list at least one extension".to_string());
    }
    Ok(out)
}

/// 读文件内容并一次性泄漏为 `'static`（与 include_str! 静态查询共享
/// 进程生命周期语义；装载期一次性、受 manifest 数量约束）。
fn read_query(path: &Path) -> Result<&'static str, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("read query {} failed: {e}", path.display()))?;
    Ok(Box::leak(content.into_boxed_str()))
}

fn leak_strs(v: &[String]) -> &'static [&'static str] {
    let leaked: Vec<&'static str> = v
        .iter()
        .map(|s| {
            let s: &'static str = Box::leak(s.clone().into_boxed_str());
            s
        })
        .collect();
    Box::leak(leaked.into_boxed_slice())
}

fn build_language(m: ManifestFile, path: &Path, dir: &Path) -> Result<ManifestOutcome, String> {
    let exts = normalize_extensions(&m.extensions)?;

    let grammar = match (m.grammar.as_ref().map(|g| g.builtin.clone()).flatten(), m.grammar.as_ref().map(|g| g.dll.clone()).flatten()) {
        (Some(_), Some(_)) => return Err("grammar.builtin and grammar.dll are mutually exclusive".to_string()),
        (None, None) => return Err("language manifest requires grammar.builtin or grammar.dll".to_string()),
        (Some(key), None) => GrammarResolved::Builtin(key),
        (None, Some(rel)) => {
            let dll = dir.join(rel);
            if !dll.is_file() {
                return Err(format!("grammar.dll not found: {}", dll.display()));
            }
            let symbol = m
                .grammar
                .as_ref()
                .and_then(|g| g.symbol.clone())
                .unwrap_or_else(|| format!("tree_sitter_{}", m.name.replace('-', "_")));
            GrammarResolved::Dll { dll, symbol }
        }
    };

    // 扩展名冲突在装载期显式拒绝（AdapterRegistry first-wins 语义下静默跳过不可见）。
    for ext in &exts {
        if crate::engine::GRAMMAR_LOADER.is_extension_registered(ext) {
            return Err(format!("extension '{ext}' already registered"));
        }
    }

    let (structure_query, dataflow) = match m.queries.as_ref() {
        None => (None, Vec::new()),
        Some(q) => {
            let base = path.parent().unwrap_or(dir);
            let structure = match q.structure.as_ref() {
                Some(rel) => Some(read_query(&base.join(rel))?),
                None => None,
            };
            let dataflow = match q.dataflow.as_ref() {
                Some(rel) => {
                    let src = read_query(&base.join(rel))?;
                    let skip_names = leak_strs(&q.skip_names);
                    let func_kinds = leak_strs(&m.func_kinds);
                    let class_kinds = leak_strs(&m.class_kinds);
                    // 每个扩展名一条同配置条目；grammar_key = 扩展名本身
                    //（apply 已把该扩展名注册进 GRAMMAR_LOADER）。
                    exts.iter()
                        .map(|ext| DataflowEntry {
                            ext: ext.clone(),
                            grammar_key: Box::leak(ext.clone().into_boxed_str()),
                            config: LangDataflowConfig {
                                query_src: src,
                                skip_names,
                                func_kinds,
                                class_kinds,
                            },
                        })
                        .collect()
                }
                None => Vec::new(),
            };
            (structure, dataflow)
        }
    };

    let entry = LanguageEntry {
        extensions: exts.clone(),
        structure_query,
        func_kinds: leak_strs(&m.func_kinds),
        class_kinds: leak_strs(&m.class_kinds),
    };
    Ok(ManifestOutcome::Language(LanguageManifest {
        name: m.name,
        entry,
        grammar,
        extensions: exts,
        dataflow,
    }))
}

/// glob → regex（`**` 跨目录、`*`/`?` 单段），全锚定。
fn glob_to_regex(pattern: &str) -> Result<regex::Regex, String> {
    let mut re = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // 吞掉随后的 '/'，使 `a/**/b` 也匹配 `a/b`
                    if chars.peek() == Some(&'/') {
                        chars.next();
                    }
                    re.push_str(".*");
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            // 字面字符：字母数字与 _ - / 直推；其余（含 `.`）经 escape——
            // `.` 若直推会变成 regex 任意符，`*.page.myl` 将误匹配 `pageXmyl`。
            c if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '/' => re.push(c),
            c => {
                re.push_str(&regex::escape(&c.to_string()));
            }
        }
    }
    re.push('$');
    regex::Regex::new(&re).map_err(|e| format!("invalid pattern: {e}"))
}

/// 从模式推导 URL 前缀：首个通配符前的最后一段目录字面前缀
///（`src/pages/**` → `src/pages/`；无通配符 → 空）。
fn pattern_prefix(pattern: &str) -> String {
    let stop = pattern.find(['*', '?']).unwrap_or(pattern.len());
    let head = &pattern[..stop];
    match head.rfind('/') {
        Some(i) => head[..=i].to_string(),
        None => String::new(),
    }
}

/// 相对路径 → 路由 URL：剥前缀、剥扩展名、补前导 `/`。
///（framework_routes 消费；pub(crate) 供 detect_manifest_framework_routes 调用）
pub(crate) fn manifest_route_url(rel: &str, prefix: &str) -> String {
    let s = rel.strip_prefix(prefix).unwrap_or(rel);
    // 只剥最后一个扩展名段（点不能属于目录段）
    let s = match s.rfind('.') {
        Some(i) if !s[i..].contains('/') => &s[..i],
        _ => s,
    };
    format!("/{}", s.trim_start_matches('/'))
}

fn build_framework(m: ManifestFile) -> Result<ManifestOutcome, String> {
    if m.routes.is_empty() {
        return Err("framework manifest requires at least one route pattern".to_string());
    }
    let mut patterns = Vec::new();
    for r in &m.routes {
        let matcher = glob_to_regex(&r.pattern)?;
        let prefix = pattern_prefix(&r.pattern);
        patterns.push(RoutePattern {
            matcher,
            method: r.method.clone().unwrap_or_else(|| "GET".to_string()),
            prefix,
        });
    }
    Ok(ManifestOutcome::Framework(FrameworkEntry { name: m.name, patterns }))
}

const PARAM_TYPES: &[&str] = &["string", "number", "integer", "boolean", "array", "object"];

fn build_tool(m: ManifestFile) -> Result<ManifestOutcome, String> {
    let valid_name = m.name.chars().next().map_or(false, |c| c.is_ascii_lowercase())
        && m.name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if !valid_name {
        return Err(format!(
            "tool name '{}' must match [a-z][a-z0-9_]*",
            m.name
        ));
    }
    // 与静态 schema 面冲突 → 装载期显式拒绝（dispatch 静态臂优先，静默遮蔽不可见）。
    if crate::tools::ToolRegistry::global().get_schema(&m.name).is_some() {
        return Err(format!("tool name '{}' collides with a built-in tool", m.name));
    }
    let description = m
        .description
        .filter(|d| !d.trim().is_empty())
        .ok_or_else(|| "tool manifest requires a non-empty description".to_string())?;
    let handler_id = m
        .handler
        .as_ref()
        .ok_or_else(|| "tool manifest requires handler (a built-in handler id)".to_string())?;
    let handler = crate::tools::builtin_handler(handler_id)
        .ok_or_else(|| format!("unknown handler id '{handler_id}' (see tools::builtin_handler registry)"))?;

    let mut params: Vec<ParamValue> = Vec::new();
    let mut required: Vec<String> = Vec::new();
    for p in &m.params {
        if p.name.is_empty() {
            return Err("param name must be non-empty".to_string());
        }
        if !PARAM_TYPES.contains(&p.ptype.as_str()) {
            return Err(format!(
                "param '{}' has unsupported ptype '{}' (allowed: {})",
                p.name,
                p.ptype,
                PARAM_TYPES.join(", ")
            ));
        }
        if p.required {
            required.push(p.name.clone());
        }
        params.push(ParamValue {
            name: p.name.clone(),
            ptype: p.ptype.clone(),
            description: p.description.clone().unwrap_or_default(),
            enum_values: p.r#enum.clone(),
        });
    }

    Ok(ManifestOutcome::Tool(ToolEntry {
        name: m.name,
        description,
        params,
        required,
        read_only: m.read_only.unwrap_or(false),
        handler,
    }))
}

// ═══════════════════════════════════════════════════════════════
// Apply —— 把装载产物落进各消费面（语法注册 / 三张注册表 / 状态）
// ═══════════════════════════════════════════════════════════════

fn apply(outcome: LoadOutcome) {
    let LoadOutcome { mut state, languages, frameworks, tools } = outcome;

    // ── 语言：语法注册（失败转为状态错误，逐 manifest 隔离）──
    let mut lang_loaded: Vec<Value> = Vec::new();
    let mut lang_entries: Vec<LanguageEntry> = Vec::new();
    let mut dataflow_entries: Vec<DataflowEntry> = Vec::new();
    for (file, lang) in languages {
        let register = match &lang.grammar {
            GrammarResolved::Builtin(key) => {
                crate::engine::GRAMMAR_LOADER.register_builtin_grammar(key, &lang.extensions)
            }
            GrammarResolved::Dll { dll, symbol } => {
                crate::engine::GRAMMAR_LOADER.register_dll(dll.clone(), symbol, lang.extensions.clone())
            }
        };
        match register {
            Ok(()) => {
                lang_entries.push(lang.entry);
                dataflow_entries.extend(lang.dataflow);
                lang_loaded.push(json!({ "name": lang.name, "kind": "language", "source": file }));
            }
            Err(e) => {
                tracing::warn!("[plugins] 语法注册失败（{file}）: {e}");
                state.errors.push(json!({ "file": file, "error": e }));
            }
        }
    }
    *LANGUAGE_ENTRIES.write().unwrap_or_else(|e| e.into_inner()) = lang_entries;
    *DATAFLOW_ENTRIES.write().unwrap_or_else(|e| e.into_inner()) = dataflow_entries;
    *FRAMEWORK_ENTRIES.write().unwrap_or_else(|e| e.into_inner()) = frameworks;
    *TOOL_ENTRIES.write().unwrap_or_else(|e| e.into_inner()) = tools;

    // 扩展名注入 hologram-graph（LazyLock 初始化时的注入只覆盖静态+扫描面，
    // manifest 扩展名是其后的追加——在此重放注入）。
    let _ = hologram_graph::set_code_extensions(&crate::engine::GRAMMAR_LOADER.supported_extensions());

    *state_cell().write().unwrap_or_else(|e| e.into_inner()) = state;
}

// ═══════════════════════════════════════════════════════════════
// 消费面访问器
// ═══════════════════════════════════════════════════════════════

/// `AdapterRegistry::new()` 尾部消费：manifest 语言适配器行
///（builtin 表之后注册——first-wins 语义下 manifest 只补缺口）。
pub(crate) fn language_adapter_entries() -> Vec<LanguageEntry> {
    LANGUAGE_ENTRIES.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// `dataflow_engine::config_for_ext` 兜底消费：按扩展名取 manifest 数据流配置。
pub(crate) fn dataflow_entry(ext: &str) -> Option<(&'static str, LangDataflowConfig)> {
    let entries = DATAFLOW_ENTRIES.read().unwrap_or_else(|e| e.into_inner());
    entries
        .iter()
        .find(|e| e.ext == ext)
        .map(|e| (e.grammar_key, e.config.clone()))
}

/// `framework_routes` 消费：manifest 框架行（glob 已编译）。
pub(crate) fn framework_entries() -> Vec<FrameworkEntry> {
    FRAMEWORK_ENTRIES.read().unwrap_or_else(|e| e.into_inner()).clone()
}

pub(crate) fn plugin_tool_values() -> Vec<Value> {
    TOOL_ENTRIES.read().unwrap_or_else(|e| e.into_inner()).iter().map(|t| t.mcp_value()).collect()
}

pub(crate) fn is_plugin_tool(name: &str) -> bool {
    TOOL_ENTRIES.read().unwrap_or_else(|e| e.into_inner()).iter().any(|t| t.name == name)
}

/// dispatch 兜底：manifest 工具 → 注册期解析好的 handler。
pub(crate) fn dispatch_plugin_tool(name: &str, args: &Value) -> Option<ToolResponse> {
    let entries = TOOL_ENTRIES.read().unwrap_or_else(|e| e.into_inner());
    entries
        .iter()
        .find(|t| t.name == name)
        .map(|t| (t.handler)(args))
}

/// `engine_status.extensions` 载荷：目录 + 已装载清单 + 逐文件错误。
pub fn extensions_status() -> Value {
    let st = state_cell().read().unwrap_or_else(|e| e.into_inner());
    json!({
        "dir": st.dir.as_ref().map(|p| p.display().to_string()),
        "loaded": st.loaded,
        "errors": st.errors,
    })
}

#[cfg(test)]
pub(crate) fn reset_for_tests() {
    *LANGUAGE_ENTRIES.write().unwrap_or_else(|e| e.into_inner()) = Vec::new();
    *DATAFLOW_ENTRIES.write().unwrap_or_else(|e| e.into_inner()) = Vec::new();
    *FRAMEWORK_ENTRIES.write().unwrap_or_else(|e| e.into_inner()) = Vec::new();
    *TOOL_ENTRIES.write().unwrap_or_else(|e| e.into_inner()) = Vec::new();
    *state_cell().write().unwrap_or_else(|e| e.into_inner()) =
        PluginState { dir: None, loaded: Vec::new(), errors: Vec::new() };
    *LAST_DIR.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine;
    use crate::tools::ToolRegistry;
    use serde_json::json;
    use std::collections::HashMap;

    // ── glob → regex ──

    #[test]
    fn test_glob_to_regex() {
        let re = glob_to_regex("pages/**/*.page.myl").unwrap();
        assert!(re.is_match("pages/users/list.page.myl"));
        assert!(re.is_match("pages/list.page.myl"));
        assert!(!re.is_match("src/pages/list.page.myl"));
        // 字面 `.` 不得当任意符：`pageXmyl` 不匹配
        assert!(!re.is_match("pages/list.pageXmyl"));

        let single = glob_to_regex("src/*.myl").unwrap();
        assert!(single.is_match("src/a.myl"));
        assert!(!single.is_match("src/deep/a.myl"));

        let q = glob_to_regex("a?c.myl").unwrap();
        assert!(q.is_match("abc.myl"));
        assert!(!q.is_match("a/c.myl"));
    }

    #[test]
    fn test_pattern_prefix_and_route_url() {
        assert_eq!(pattern_prefix("pages/**/*.page.myl"), "pages/");
        assert_eq!(pattern_prefix("src/*.myl"), "src/");
        assert_eq!(pattern_prefix("**/*.myl"), "");

        assert_eq!(manifest_route_url("pages/users/list.page.myl", "pages/"), "/users/list.page");
        assert_eq!(manifest_route_url("pages/index.page.myl", "pages/"), "/index.page");
        assert_eq!(manifest_route_url("deep/a.myl", ""), "/deep/a");
    }

    // ── 解析与校验（纯函数，不碰全局表）──

    fn write_manifest(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn test_parse_language_manifest_ok() {
        let base = std::env::temp_dir().join("hologram_test_plugins_parse_ok");
        let _ = std::fs::remove_dir_all(&base);
        let qdir = base.join("queries");
        std::fs::create_dir_all(&qdir).unwrap();
        std::fs::write(qdir.join("s.scm"), "(function_definition) @fn\n").unwrap();
        std::fs::write(qdir.join("d.scm"), "(identifier) @usage\n").unwrap();
        let path = write_manifest(
            &base,
            "lang.yml",
            "manifest_version: 1\nkind: language\nname: mylang\nextensions: [\".MyLP\", \"mylpi\"]\ngrammar:\n  builtin: python\nqueries:\n  structure: ./queries/s.scm\n  dataflow: ./queries/d.scm\n  skip_names: [\"builtins\"]\nfunc_kinds: [function_definition]\nclass_kinds: []\n",
        );

        let outcome = parse_manifest_file(&path, &base, &[]).unwrap();
        let ManifestOutcome::Language(lang) = outcome else {
            panic!("expected language outcome");
        };
        assert_eq!(lang.name, "mylang");
        assert_eq!(lang.extensions, vec!["mylp", "mylpi"]);
        assert_eq!(lang.entry.structure_query, Some("(function_definition) @fn\n"));
        assert_eq!(lang.dataflow.len(), 2); // 每扩展名一条
        assert_eq!(lang.dataflow[0].config.skip_names, &["builtins"][..]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_parse_manifest_errors() {
        let base = std::env::temp_dir().join("hologram_test_plugins_parse_err");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // 坏 yaml
        let p = write_manifest(&base, "bad.yml", "manifest_version: 1\nkind: [broken\n");
        assert!(parse_manifest_file(&p, &base, &[]).is_err());

        // 未知版本
        let p = write_manifest(&base, "ver.yml", "manifest_version: 99\nkind: framework\nname: x\nroutes: [{pattern: \"a/b\"}]\n");
        assert!(parse_manifest_file(&p, &base, &[]).err().expect("should fail").contains("manifest_version"));

        // 未知 kind
        let p = write_manifest(&base, "kind.yml", "manifest_version: 1\nkind: widget\nname: x\n");
        assert!(parse_manifest_file(&p, &base, &[]).err().expect("should fail").contains("unknown kind"));

        // 重复名
        let p = write_manifest(&base, "dup.yml", "manifest_version: 1\nkind: framework\nname: taken\nroutes: [{pattern: \"a/b\"}]\n");
        assert!(parse_manifest_file(&p, &base, &["taken".to_string()]).err().expect("should fail").contains("duplicate"));

        // language 缺 grammar
        let p = write_manifest(&base, "nogram.yml", "manifest_version: 1\nkind: language\nname: x\nextensions: [zz]\n");
        assert!(parse_manifest_file(&p, &base, &[]).err().expect("should fail").contains("grammar"));

        // builtin + dll 互斥
        let p = write_manifest(&base, "both.yml", "manifest_version: 1\nkind: language\nname: x\nextensions: [zz]\ngrammar:\n  builtin: python\n  dll: ./nope.dll\n");
        assert!(parse_manifest_file(&p, &base, &[]).err().expect("should fail").contains("mutually exclusive"));

        // 工具：未知 handler
        let p = write_manifest(&base, "badh.yml", "manifest_version: 1\nkind: tool\nname: my_tool\ndescription: d\nhandler: no_such_handler\n");
        assert!(parse_manifest_file(&p, &base, &[]).err().expect("should fail").contains("unknown handler"));

        // 工具：与内置工具撞名
        let p = write_manifest(&base, "clash.yml", "manifest_version: 1\nkind: tool\nname: search_symbols\ndescription: d\nhandler: search_symbols\n");
        assert!(parse_manifest_file(&p, &base, &[]).err().expect("should fail").contains("collides"));

        // 工具：非法 ptype
        let p = write_manifest(&base, "badt.yml", "manifest_version: 1\nkind: tool\nname: my_tool\ndescription: d\nhandler: search_symbols\nparams: [{name: q, ptype: tuple}]\n");
        assert!(parse_manifest_file(&p, &base, &[]).err().expect("should fail").contains("ptype"));

        // framework 缺 routes
        let p = write_manifest(&base, "nor.yml", "manifest_version: 1\nkind: framework\nname: x\n");
        assert!(parse_manifest_file(&p, &base, &[]).err().expect("should fail").contains("route"));

        // 未知字段（deny_unknown_fields）
        let p = write_manifest(&base, "unk.yml", "manifest_version: 1\nkind: framework\nname: x\nroutes: [{pattern: \"a/b\"}]\nextra: 1\n");
        assert!(parse_manifest_file(&p, &base, &[]).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    // ── 端到端（单用例承载全部三类扩展的 DoD：不加一行 Rust 即生效）──

    #[test]
    fn test_manifest_end_to_end() {
        let base = std::env::temp_dir().join("hologram_test_plugins_e2e");
        let _ = std::fs::remove_dir_all(&base);
        let proj = base.join("proj");
        let pdir = base.join("plugins");
        let qdir = pdir.join("queries");
        std::fs::create_dir_all(&qdir).unwrap();
        std::fs::create_dir_all(&proj).unwrap();

        // 语言：复用 python 静态语法 + manifest .scm（structure + dataflow）
        std::fs::write(
            pdir.join("mylang.yml"),
            "manifest_version: 1\nkind: language\nname: mylang\nextensions: [\".myl\"]\ngrammar:\n  builtin: python\nqueries:\n  structure: ./queries/mylang_structure.scm\n  dataflow: ./queries/mylang_dataflow.scm\nfunc_kinds: [function_definition]\nclass_kinds: [class_definition]\n",
        )
        .unwrap();
        std::fs::write(
            qdir.join("mylang_structure.scm"),
            ";; MyLang Structure Queries\n(function_definition) @fn\n(class_definition) @class\n(call_expression) @call\n(import_statement) @import\n(assignment) @var\n(identifier) @usage\n",
        )
        .unwrap();
        std::fs::write(qdir.join("mylang_dataflow.scm"), "(function_definition) @fn\n(identifier) @usage\n").unwrap();

        // 框架：候选模式
        std::fs::write(
            pdir.join("pagesfw.yml"),
            "manifest_version: 1\nkind: framework\nname: pagesfw\nroutes:\n  - pattern: \"pages/**/*.page.myl\"\n    method: POST\n",
        )
        .unwrap();

        // 工具：handler id 复用既有能力
        std::fs::write(
            pdir.join("mytools.yml"),
            "manifest_version: 1\nkind: tool\nname: myfw_list_pages\ndescription: List manifest pages via symbol search\nread_only: true\nhandler: search_symbols\nparams:\n  - name: query\n    ptype: string\n    description: symbol query\n    required: true\n",
        )
        .unwrap();

        std::env::set_var("HOLOGRAM_PLUGIN_DIR", &pdir);
        engine::engine_init(&proj).expect("engine_init");

        // 状态面：三份 manifest 全部装载 + 目录可见
        let status = extensions_status();
        assert_eq!(status["loaded"].as_array().map(|a| a.len()), Some(3), "status: {status}");
        assert_eq!(status["errors"].as_array().map(|a| a.len()), Some(0), "status: {status}");

        // 语法面：扩展名注册 + 语法可解析
        assert!(engine::GRAMMAR_LOADER.get("myl").is_some());
        assert!(engine::GRAMMAR_LOADER.supported_extensions().iter().any(|e| e == "myl"));

        // 适配器面：结构分析走 manifest .scm（符号提取端到端）
        let reg = crate::adapter::registry::AdapterRegistry::new();
        let adapter = reg.get("myl").expect("manifest adapter registered");
        let (nodes, _edges, _) = adapter.analyze("src/a.myl", "def hello():\n    pass\n");
        assert!(
            nodes.iter().any(|n| n.name == "hello"),
            "manifest structure query should extract symbols, got: {:?}",
            nodes.iter().map(|n| n.name.clone()).collect::<Vec<_>>()
        );

        // 数据流面：config_for_ext 兜底命中
        assert!(crate::analysis::dataflow_engine::config_for_ext("myl").is_some());

        // 工具面：可见 + 可调用
        assert!(ToolRegistry::global().knows_tool("myfw_list_pages"));
        let list = ToolRegistry::global().tools_list();
        assert!(
            list.iter().any(|v| v["name"] == "myfw_list_pages"),
            "tools/list should include manifest tool"
        );
        let resp = ToolRegistry::dispatch("myfw_list_pages", &json!({"query": "hello"}), &json!(1));
        assert!(resp.is_object(), "manifest tool dispatch must answer");

        // 框架面：候选模式 → route 节点注入
        let page_dir = proj.join("pages").join("users");
        std::fs::create_dir_all(&page_dir).unwrap();
        std::fs::write(page_dir.join("list.page.myl"), "def x():\n    pass\n").unwrap();
        let mut graph = hologram_graph::Graph::new();
        let files = vec![page_dir.join("list.page.myl")];
        let cache: HashMap<String, (String, Option<tree_sitter::Tree>)> = HashMap::new();
        let added =
            crate::analysis::framework_routes::detect_framework_routes(&mut graph, &proj, &cache, &files);
        assert!(added >= 1, "manifest framework should inject a route node");

        // 重放语义：同 env 下 engine_init 幂等（不重复装载）
        engine::engine_init(&proj).unwrap();
        assert_eq!(extensions_status()["loaded"].as_array().map(|a| a.len()), Some(3));

        // 收尾：清 env + 重置表 + 拆 watcher（进程级干净）
        std::env::remove_var("HOLOGRAM_PLUGIN_DIR");
        reset_for_tests();
        engine::engine_teardown_global();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_examples_dir_manifests_parse() {
        // 交付的示例扩展目录必须与解析器保持同步（防示例格式漂移成摆设）
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("examples").join("engine-plugins"))
            .expect("examples dir");
        assert!(dir.is_dir(), "examples dir missing: {}", dir.display());
        let outcome = load_from_dir(Some(&dir));
        assert!(outcome.state.errors.is_empty(), "errors: {:?}", outcome.state.errors);
        assert_eq!(outcome.state.loaded.len(), 3, "loaded: {:?}", outcome.state.loaded);
    }
}

use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use crate::engine;
use crate::tools::{get_str, get_usize, project_root};
use crate::tools::ToolResponse;

/// LSP 引用检查结果。
pub(crate) enum LspCheck {
    /// 有真实引用（应移出死代码列表）
    HasReference,
    /// 无引用（确认死代码）
    NoReference,
    /// LSP 不可用 / 无法定位（保持原判断）
    Unavailable,
}

/// 用 LSP references 验证符号是否有真实引用（非定义点）。
/// 无法定位位置 / 无 LSP 可用 / LSP 查询失败时返回 Unavailable。
pub(crate) fn lsp_has_real_reference(location: &str, name: &str) -> LspCheck {
    if location.is_empty() || name.is_empty() {
        return LspCheck::Unavailable;
    }
    // location 格式: "D:/path/to/file.ts:153"（路径 + :行号）。
    // rsplit_once(':') 只拆最后一个冒号，drive letter（D:）不受影响。
    let (path, line_str) = match location.rsplit_once(':') {
        Some(pair) => pair,
        None => return LspCheck::Unavailable,
    };
    // Node.location 行号是 1-based；LSP 需要 0-based。
    let line: u32 = match line_str.parse::<u32>() {
        Ok(l) if l > 0 => l - 1,
        _ => return LspCheck::Unavailable,
    };
    let ext = path.rsplit('.').next().unwrap_or("");
    if ext.is_empty() {
        return LspCheck::Unavailable;
    }
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return LspCheck::Unavailable,
    };
    // 定位符号名在该行的列（LSP 需要精确位置）。
    // 用行内首次出现；若该行无符号名则无法定位，跳过验证。
    let line_text = match source.lines().nth(line as usize) {
        Some(l) => l,
        None => return LspCheck::Unavailable,
    };
    let column = match line_text.find(name) {
        Some(c) => c as u32,
        None => return LspCheck::Unavailable,
    };
    // find_references 内部 includeDeclaration=false（不含定义本身），
    // 非空结果 = 有真实使用点。
    //
    // 冷启动窗口内的空结果已由 LSP 层转成 Err（#7：服务器还在索引 ⇒ 空结果不算数）
    // ⇒ 这里归 Unavailable（保持原判断），不会把「还在索引」误判成「确认死代码」。
    match crate::lsp_manager::LspManager::find_references(path, &source, line, column, ext) {
        Ok(locs) if !locs.is_empty() => LspCheck::HasReference,
        Ok(_) => LspCheck::NoReference,
        Err(_) => LspCheck::Unavailable,
    }
}

/// P1-2：将 resolve_call 的 LSP 解析结果回写图。
/// 定位源节点（同文件、同名、行号邻近）与目标节点（定义位置 file:line），
/// 把图中已存在的 calls 边标记 lsp_resolved=true 并落库。
/// 只标记真实存在的边 —— 图里没有的边如实报告，不凭空造边。
fn write_back_lsp_resolution(
    file: &str,
    func_name: &str,
    line0: u32,
    defs: &[Value],
) -> Value {
    use hologram_graph::EdgeKind;

    // 1) 定位源节点：同文件 + 同名 + 行号邻近（节点行号 1-based，LSP 0-based → +1）
    let src_id: Option<String> = crate::tools::with_store(|idx| {
        let mut best: Option<String> = None;
        for nid in idx.get_nodes_by_file(file) {
            if let Some(n) = idx.get_node(nid.as_str()) {
                if n.name != func_name {
                    continue;
                }
                if let Some(ref loc) = n.location {
                    let node_line = loc.rsplit(':').next().and_then(|l| l.parse::<u32>().ok());
                    if let Some(nl) = node_line {
                        let expect = line0.saturating_add(1);
                        if nl == expect || nl + 1 == expect || nl == expect + 1 {
                            best = Some(nid.clone());
                            break;
                        }
                    }
                }
            }
        }
        Value::String(best.unwrap_or_default())
    })
    .as_str()
    .filter(|s| !s.is_empty())
    .map(|s| s.to_string());

    // 2) 对每个定义位置：定位目标节点并标记已存在的 calls 边
    let mut marked = 0usize;
    let mut targets: Vec<Value> = Vec::new();
    for d in defs {
        let def_path = crate::lsp_manager::uri_to_path(d["file"].as_str().unwrap_or(""))
            .replace('\\', "/");
        let def_line1 = d["line"].as_u64().unwrap_or(0) as u32 + 1;
        let tgt_id: Option<String> = crate::tools::with_store(|idx| {
            let mut hit: Option<String> = None;
            for nid in idx.get_nodes_by_file(&def_path) {
                if let Some(n) = idx.get_node(nid.as_str()) {
                    if let Some(ref loc) = n.location {
                        let nl = loc.rsplit(':').next().and_then(|l| l.parse::<u32>().ok());
                        if nl == Some(def_line1) {
                            hit = Some(nid.clone());
                            break;
                        }
                    }
                }
            }
            Value::String(hit.unwrap_or_default())
        })
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

        if let (Some(ref s), Some(ref t)) = (src_id.as_ref(), tgt_id.as_ref()) {
            let edge_marked = crate::engine::with_engine(|eng| eng.mark_edge_lsp_resolved(s, t, EdgeKind::Calls))
                .and_then(|r| r.ok())
                .unwrap_or(false);
            if edge_marked {
                marked += 1;
            }
            targets.push(json!({"target": t, "edge_marked": edge_marked}));
        } else {
            targets.push(json!({
                "target": tgt_id,
                "edge_marked": false,
                "reason": if src_id.is_none() { "call site node not in graph" } else { "definition node not in graph" },
            }));
        }
    }
    json!({
        "edges_marked": marked,
        "source_node": src_id,
        "targets": targets,
        "note": "只标记图中已存在的 calls 边为 lsp_resolved；图里没有的边如实报告，不凭空造边"
    })
}

/// LSP 降级详情：真实错误优先于安装指引。
/// 服务器「忙/冷启动」时 agent 收到的指引应该是稍后重试，
/// 而不是误导性的「去安装 LSP 服务器」（2026-09-09 事故现场：
/// 服务器全在启动/OOM，agent 却被引导去装服务器）。
fn lsp_degraded_details(ext: &str, lsp_error: Option<String>) -> Value {
    let mut details = json!({
        "ext": ext,
        "missing_lsp": crate::lsp_manager::LspManager::warm_errors(),
        "note": "Handwritten adapters removed in v8. Use real LSP servers (pyright, gopls, rust-analyzer, etc.)"
    });
    if let Some(e) = lsp_error {
        if crate::lsp_manager::LspManager::err_is_busy(&e) {
            details["retry_hint"] = json!("LSP server is starting/busy — retry in a minute instead of installing anything");
        }
        details["lsp_error"] = json!(e);
    }
    details
}

/// LSP 无结果时的降级响应——**#6 的分流真源**（三种「没结果」说三句话）。
///
/// 修的是什么（2026-09-25 实测）：此前 `Ok(空列表)` 不记 error，于是
/// 「服务器答了、只是这个位置没有结果」一路落进「路径 2：无原生 LSP 可用」，
/// 吐出 `Install an LSP server for .rs`——同一秒 `missing_lsp` 是空表、日志里躺着
/// `lazy warm succeeded`，三处自相矛盾。讽刺的是本文件 `lsp_degraded_details`
/// 上面的注释**明确想防这个**，但防逻辑写成 `if let Some(e) = lsp_error`，
/// 只覆盖「有 error」那条路，空结果绕过去了。
///
/// 判据（`answered_empty` = LSP 层真的答了）：
///   ① 答了但空 → 位置问题（核对 line/column），**不是**缺服务器；
///   ② 忙/冷启动（`LSP busy`）→ 稍后重试，别装东西；
///   ③ 拉起失败（装了但起不来）→ 看原因，重装没用；
///   ④ 没装 / 无适配器 → 安装指引（这才是「去装 LSP」唯一成立的场合）。
fn lsp_degraded(ext: &str, what: &str, answered_empty: bool, lsp_error: Option<String>) -> ToolResponse {
    use crate::lsp_manager::{LspManager, LspServerState};
    let state = LspManager::server_state_for_ext(ext);
    let busy = lsp_error
        .as_deref()
        .map(crate::lsp_manager::LspManager::err_is_busy)
        .unwrap_or(false);
    let mut details = lsp_degraded_details(ext, lsp_error);
    details["server_state"] = json!(state.as_ref().map(|s| s.as_str()).unwrap_or("no-adapter"));
    if answered_empty {
        details["note"] = json!(
            "LSP server answered but returned no result at this position — this is not a missing-server problem"
        );
        return ToolResponse::Degraded {
            guidance: format!("LSP answered with no result for {} at that position (.{})", what, ext),
            fallback: format!(
                "Not an install problem — the .{} server is running. Re-check line/column (schema says 0-based) against the actual symbol position and retry.",
                ext
            ),
            details,
        };
    }
    if busy {
        return ToolResponse::Degraded {
            guidance: format!("LSP server for .{} is starting/busy — {} not resolved yet", ext, what),
            fallback: format!(
                "Retry in a moment: the .{} server is coming up or still indexing the project. Do not install anything.",
                ext
            ),
            details,
        };
    }
    if let Some(LspServerState::Failed(e)) = state {
        details["lsp_error"] = json!(e);
        return ToolResponse::Degraded {
            guidance: format!("No usable LSP server for .{} — {} skipped", ext, what),
            fallback: format!(
                "The .{} server is installed but did not start (see details.lsp_error) — reinstalling will not help; check engine_status and engine logs.",
                ext
            ),
            details,
        };
    }
    ToolResponse::Degraded {
        guidance: format!("No LSP server available for .{} — {} skipped.", ext, what),
        fallback: format!(
            "Install an LSP server for .{} to enable precise {}. Check engine_status for details.",
            ext, what
        ),
        details,
    }
}

/// 通过原生 LSP 按需进行类型感知的调用解析。
/// LSP 服务器未安装时优雅降级。
pub(crate) fn handler_resolve_call(args: &Value) -> ToolResponse {    let file_path = args.get("file").and_then(|v| v.as_str()).unwrap_or("");
    let func_name = args.get("function").and_then(|v| v.as_str()).unwrap_or("");
    let line = args.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let column = args.get("column").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    if file_path.is_empty() {
        return ToolResponse::Degraded {
            guidance: "file is required".into(),
            fallback: "Provide the file path to resolve calls in".into(),
            details: json!({}),
        };
    }
    let root = project_root();
    let abs_path = if Path::new(file_path).is_absolute() {
        PathBuf::from(file_path)
    } else {
        root.join(file_path)
    };
    let path_str = abs_path.to_string_lossy().replace('\\', "/");
    let ext = path_str.rsplit('.').next().unwrap_or("").to_lowercase();

    // 读取源码
    let source = match std::fs::read_to_string(&abs_path) {
        Ok(s) => s,
        Err(e) => return ToolResponse::Degraded {
            guidance: format!("cannot read file: {}", e),
            fallback: "Check the file path and permissions".into(),
            details: json!({}),
        },
    };

    // 尝试原生 LSP（如果池已预热）——真实错误透传给降级详情，
    // 服务器忙/冷启动时 agent 才能拿到「稍后重试」的正确指引。
    if line == 0 && column == 0 {
        return ToolResponse::Degraded {
            guidance: "line/column required for LSP call resolution".into(),
            fallback: "Provide the 0-based line (and column) of the call site to resolve it via LSP.".into(),
            details: lsp_degraded_details(&ext, None),
        };
    }
    let mut lsp_error: Option<String> = None;
    let mut answered_empty = false;
    match crate::lsp_manager::LspManager::resolve_definition(&path_str, &source, line, column, &ext) {
        // 有定义：P1-2 回写（命中的 calls 边标记 lsp_resolved=true 并落库）
        Ok(locs) if !locs.is_empty() => {
            let mapped = locs
                .iter()
                .map(|loc| {
                    json!({
                        "file": crate::lsp_manager::uri_to_path(&loc.uri),
                        "line": loc.range_start_line,
                        "column": loc.range_start_char,
                        "backend": "native_lsp",
                    })
                })
                .collect::<Vec<_>>();
            let write_back = write_back_lsp_resolution(&path_str, func_name, line, &mapped);
            return ToolResponse::Success(json!({
                "file": path_str,
                "function": func_name,
                "backend": "native_lsp",
                "definitions": mapped,
                "note": "resolved via real LSP server",
                "write_back": write_back,
            }));
        }
        // #6：服务器**答了**（空 = 这个位置没有可解析的定义，如行列填错）——
        // 不是「无原生 LSP 可用」，不许落进安装指引。
        Ok(_) => answered_empty = true,
        Err(e) => lsp_error = Some(e),
    }

    // ── 路径 2：无结果 → 按归因分流（#6：空结果 / 忙 / 起不来 / 没装 各说各的）──
    lsp_degraded(&ext, "call resolution", answered_empty, lsp_error)
}

/// 解析指定位置符号的类型。
pub(crate) fn handler_resolve_type(args: &Value) -> ToolResponse {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.get("error").and_then(|v| v.as_str()).unwrap_or("Invalid arguments");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Provide a valid file path".into(),
                details: json!({}),
            };
        }
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;

    // 尝试原生 LSP
    let mut lsp_error: Option<String> = None;
    let mut answered_empty = false;
    match crate::lsp_manager::LspManager::resolve_type(&path_str, &source, line, column, &ext) {
        Ok(hover) if !hover.is_empty() => {
            return ToolResponse::Success(json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "type_info": hover,
            }));
        }
        // #6：服务器答了（空 hover = 该位置没有可解析类型）——不是「缺 LSP 服务器」
        Ok(_) => answered_empty = true,
        Err(e) => lsp_error = Some(e),
    }

    // ── 路径 2：无结果 → 按归因分流（#6）──
    lsp_degraded(&ext, "type resolution", answered_empty, lsp_error)
}

/// 查找指定位置接口/trait/抽象类的所有实现。
pub(crate) fn handler_find_implementations(args: &Value) -> ToolResponse {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.get("error").and_then(|v| v.as_str()).unwrap_or("Invalid arguments");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Provide a valid file path".into(),
                details: json!({}),
            };
        }
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;

    // 尝试原生 LSP
    let mut lsp_error: Option<String> = None;
    let mut answered_empty = false;
    match crate::lsp_manager::LspManager::find_implementations(&path_str, &source, line, column, &ext) {
        Ok(locs) if !locs.is_empty() => {
            return ToolResponse::Success(json!({
                "file": path_str, "line": line, "column": column,
                "backend": "native_lsp",
                "implementations": locs.iter().map(|l| json!({
                    "file": crate::lsp_manager::uri_to_path(&l.uri),
                    "line": l.range_start_line,
                    "column": l.range_start_char,
                })).collect::<Vec<_>>(),
                "count": locs.len(),
            }));
        }
        // #6：服务器答了（空 = 该位置没有实现）——不是「缺 LSP 服务器」
        Ok(_) => answered_empty = true,
        Err(e) => lsp_error = Some(e),
    }

    // 回退：无结果 → 按归因分流（#6）
    lsp_degraded(&ext, "interface implementation search", answered_empty, lsp_error)
}

/// 查找指定位置符号的所有引用。
pub(crate) fn handler_find_references(args: &Value) -> ToolResponse {
    let (path_str, source, ext) = match resolve_tool_prepare(args) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.get("error").and_then(|v| v.as_str()).unwrap_or("Invalid arguments");
            return ToolResponse::Degraded {
                guidance: msg.into(),
                fallback: "Provide a valid file path".into(),
                details: json!({}),
            };
        }
    };
    let line = get_usize(args, "line", 0) as u32;
    let column = get_usize(args, "column", 0) as u32;
    let _include_decl = args.get("includeDeclaration").and_then(|v| v.as_bool()).unwrap_or(false);

    // 尝试原生 LSP
    let (lsp_err, lsp_answered): (Option<String>, bool) =
        match crate::lsp_manager::LspManager::find_references(&path_str, &source, line, column, &ext) {
            Ok(locs) if !locs.is_empty() => {
                return ToolResponse::Success(json!({
                    "file": path_str, "line": line, "column": column,
                    "backend": "native_lsp",
                    "references": locs.iter().map(|l| json!({
                        "file": crate::lsp_manager::uri_to_path(&l.uri),
                        "line": l.range_start_line,
                        "column": l.range_start_char,
                    })).collect::<Vec<_>>(),
                    "count": locs.len(),
                }));
            }
            // 答了、但没有引用 = 正常（不是「没用上 LSP」——#6 同一归因纪律）
            Ok(_) => (None, true),
            Err(e) => (Some(e), false), // 记录错误供诊断
        };

    // 回退：使用图查找入边引用
    match engine::engine_read(|idx| {
        let g = engine::graph_from_index(idx);
        let _node_ids: Vec<String> = g.node_ids().map(|s| s.to_string()).collect();
        let refs: Vec<Value> = g.edges_iter()
            .take(100)
            .map(|(_, e)| json!({
                "source": e.source,
                "target": e.target,
                "kind": format!("{:?}", e.kind),
            }))
            .collect();
        let mut out = json!({
            "file": path_str, "line": line, "column": column,
            "backend": "graph",
            "native_lsp_available": crate::lsp_manager::LspManager::is_available(&ext),
            "native_lsp_answered": lsp_answered,
            "note": "Graph-based fallback — use native LSP for precise symbol references. Provide line+column for precise resolution.",
            "references": refs,
            "count": refs.len(),
        });
        if lsp_answered {
            out["note"] = json!(
                "Native LSP answered with no references at that position; showing graph edges instead (re-check line/column if unexpected)."
            );
        }
        if let Some(e) = &lsp_err {
            out["lsp_error"] = json!(e);
        }
        out
    }) {
        Ok(v) => ToolResponse::Success(v),
        Err(e) => ToolResponse::Degraded {
            guidance: format!("cannot access graph: {}", e),
            fallback: "Ensure the project has been analyzed first".into(),
            details: json!({}),
        },
    }
}

/// resolve_* 工具的共享准备：读取文件、获取扩展名，返回 (path, source, ext)。
pub(crate) fn resolve_tool_prepare(args: &Value) -> Result<(String, String, String), Value> {
    let file_path = get_str(args, &["file"]);
    if file_path.is_empty() {
        return Err(json!({"error": "file is required"}));
    }
    let root = project_root();
    let abs_path = if Path::new(&file_path).is_absolute() {
        PathBuf::from(&file_path)
    } else {
        root.join(&file_path)
    };
    let path_str = abs_path.to_string_lossy().replace('\\', "/");
    let ext = path_str.rsplit('.').next().unwrap_or("").to_lowercase();
    let source = std::fs::read_to_string(&abs_path)
        .map_err(|e| json!({"error": format!("cannot read file: {}", e)}))?;
    Ok((path_str, source, ext))
}

pub(crate) fn handler_dataflow(args: &Value) -> ToolResponse {
    let files: Vec<String> = args
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if files.is_empty() {
        return ToolResponse::Degraded {
            guidance: "files is required and must be a non-empty array".into(),
            fallback: "Provide an array of file paths to trace dataflow".into(),
            details: json!({}),
        };
    }
    let root = project_root();
    let paths: Vec<PathBuf> = files
        .iter()
        .map(|f| {
            let p = Path::new(f);
            if p.is_absolute() { p.to_path_buf() } else { root.join(p) }
        })
        .collect();
    let results = crate::analysis::dataflow_engine::query_dataflow_files(&paths);
    let json_results: Vec<Value> = results
        .iter()
        .map(|r| match &r.result {
            Ok(df) => json!({
                "file": r.file,
                "scopes": df.scopes.iter().map(|s| json!({
                    "name": s.name,
                    "reads": s.reads,
                    "writes": s.writes,
                    "triggers": s.triggers,
                    "awaits_callbacks": s.awaits_callbacks,
                    "sequence_calls": s.sequence_calls,
                })).collect::<Vec<_>>(),
                "shared": df.shared.iter().map(|sh| json!({
                    "var": sh.var,
                    "readers": sh.readers,
                    "writers": sh.writers,
                })).collect::<Vec<_>>(),
            }),
            Err(e) => json!({"file": r.file, "error": e}),
        })
        .collect();
    ToolResponse::Success(json!({"results": json_results}))
}

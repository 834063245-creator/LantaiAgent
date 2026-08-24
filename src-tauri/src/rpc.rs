// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// RPC — 替代 89 个独立 #[tauri::command] 函数的单一 IPC 入口。
// 所有命令通过 invoke("rpc", {method, params}) 路由，而非
// 独立的 invoke("git_status", ...) 调用。
//
// ponytail: 一个 Tauri 命令，一个 match，一个维护面。
// 添加新命令 = 此处一个 match 分支 + 前端相同的 invoke("rpc",...)。
// 不再需要双端签名对齐。

use serde_json::Value;

use crate::permissions::Tool;

// ── 参数辅助函数 ──

fn req_str(params: &Value, name: &str, method: &str) -> Result<String, String> {
    params.get(name)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("{method}: missing '{name}'"))
}
fn opt_str(params: &Value, name: &str) -> Option<String> {
    params.get(name).and_then(|v| v.as_str()).map(String::from)
}
fn opt_bool(params: &Value, name: &str) -> Option<bool> {
    params.get(name).and_then(|v| v.as_bool())
}
fn opt_i32(params: &Value, name: &str) -> Option<i32> {
    params.get(name).and_then(|v| v.as_i64()).map(|n| n as i32)
}
fn opt_u32(params: &Value, name: &str) -> Option<u32> {
    params.get(name).and_then(|v| v.as_u64()).map(|n| n as u32)
}
fn opt_u64(params: &Value, name: &str) -> Option<u64> {
    params.get(name).and_then(|v| v.as_u64())
}
fn opt_usize(params: &Value, name: &str) -> Option<usize> {
    params.get(name).and_then(|v| v.as_u64()).map(|n| n as usize)
}
fn opt_f64(params: &Value, name: &str) -> Option<f64> {
    params.get(name).and_then(|v| v.as_f64())
}
/// browser 命令的 agent 路由：target="self"（或 self=true）走自家 webview 只读会话，
/// 否则走各 Agent 自己的 CDP 会话（无 _agent_id 共用 default）。
/// 修复：前端领域工具传的是 target="self" 字符串，旧实现只认 self 布尔参数——
/// self 路由自 D4 落地起从未生效（静默失效，所有 self 读操作报"尚未 launch 浏览器"）。
fn self_or_agent(params: &Value) -> Option<String> {
    let is_self = opt_bool(params, "self").unwrap_or(false)
        || params.get("target").and_then(|v| v.as_str()) == Some("self");
    if is_self {
        Some(crate::cdp::SELF_AGENT_ID.to_string())
    } else {
        opt_str(params, "_agent_id")
    }
}

/// 全部 browser_* 分支统一过权限引擎（二轮评审 P2）：
/// - Browser=deny 对包括只读在内的所有动作生效（Deny 最高优先级）；
/// - 只读/L2 动作由 BrowserTool::check_permissions 裁决为 Passthrough；
/// - launch/connect/kill/attach/eval 与敏感目标动作仍走 Ask。
/// 无工作区时没有可加载的规则源：只读动作保持原行为放行，写动作维持原报错。
async fn check_browser_permission(
    action: &str,
    agent_id: Option<&str>,
    state: &tauri::State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let tool = crate::tools::BrowserTool {
        action: action.to_string(),
        agent_id: agent_id.map(String::from),
    };
    let ctx = match crate::utils::get_ctx(state) {
        Ok(ctx) => ctx,
        Err(e) => {
            if tool.is_read_only() {
                return Ok(());
            }
            return Err(e);
        }
    };
    crate::utils::check_permission(&tool, &ctx, app).await
}
fn req_strs(params: &Value, name: &str, method: &str) -> Result<Vec<String>, String> {
    params.get(name)
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .ok_or_else(|| format!("{method}: missing '{name}'"))
}
fn req_u16(params: &Value, name: &str, method: &str) -> Result<u16, String> {
    params.get(name).and_then(|v| v.as_u64()).map(|n| n as u16)
        .ok_or_else(|| format!("{method}: missing '{name}'"))
}

// ── 结果辅助函数（将类型化的 Ok 转换为 JSON 字符串）──

fn ok_json<T: serde::Serialize>(r: Result<T, String>) -> Result<String, String> {
    r.and_then(|v| serde_json::to_string(&v).map_err(|e| format!("rpc: serialize: {e}")))
}
fn ok_unit(r: Result<(), String>) -> Result<String, String> {
    r.map(|_| "null".into())
}

/// rpc 返回值 Value 化（landmine 根治级，2026-08-22）：commands 层保持
/// Result<String, String> 零改动，出口单点包 Value::String。
/// **故意不 parse**：出口无法区分「JSON 命令输出」和「恰好长得像 JSON 的
/// 文本」（read_file_content 读 .json 文件必须字节精确），智能留给前端
/// typedRpc 按契约分派（JSON 命令清单由 gen-rpc-contract-md.cjs 同源生成）。
/// agentInvoke 出口直通 string（工具链 string 世界零改动）。
fn str_to_value(s: String) -> Value {
    Value::String(s)
}

// ── rpc 返回值 Value 化第二步：命令→形态分派表（B 路线，2026-08-22）──
//
// JsonValue 表示「命令 Ok 输出恒为合法 JSON」：出口把字符串 parse 成真结构化
// Value 传递（serde_json 默认 BTreeMap 序，parse 消费方无感）。Text 表示字节
// 精确直通 Value::String。判定依据 = 前端同源答案卷（typedJsonRpc 调用点 +
// RpcContract 注释 + 命令实现逐一核对）；read_file_content 是刻意的文本铁律样板。
//
// 铁律：
// 1) 贴错标签 = 字节级破坏——Text 命令误标 JsonValue 会在出口 parse「长得像
//    JSON 的文本」上炸（read_file_content 读 .json 文件的回归测试钉死）；
//    JsonValue 命令误标 Text 只会让前端 typedJsonRpc 走兜底 parse string（慢
//    路径），不破坏正确性——错误方向只有一侧致命，分类偏保守。
// 2) 本表只认命令不认内容——同一命令返回形态必须恒定；动态形态命令
//    （exec_command 流式 started 响应等）一律 Text 由消费方自行 parse。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RpcResultShape {
    JsonValue,
    Text,
}

fn rpc_result_shape(method: &str) -> RpcResultShape {
    match method {
        // ── 应用层（L1 数据上下文）──
        // session_attach：AttachOutcome serde 序列化恒 JSON。
        // session_focus：Option<String> serde（"path"/null），恒 JSON。
        // context_list：Vec<ContextInfo> serde，恒 JSON。
        // session_detach：ok_unit "null" 家族，Text。
        "session_attach" | "session_focus" | "context_list" => RpcResultShape::JsonValue,

        // ── Engine 调度 ──
        // hologram_call 是元命令（37 个底层工具），输出形态由工具决定，无法在
        // 出口层保证恒定——保持 Text，由前端 holoExec 双形态守卫兜。
        // hologram_tools_list：Ok 恒为 schema 数组 JSON（serde 序列化，空时为 "[]"）。
        "hologram_tools_list" => RpcResultShape::JsonValue,

        // ── Graph ──
        // load_graph_json/analyze_and_load：引擎图 meta JSON；但磁盘兑底路径返回
        // hologram_graph.json 原文（合法 JSON，字段不同）——两种路径都是合法 JSON，
        // 前端 parse 后宽容读 meta。保守起见 load_graph_json 保持 Text（磁盘全文
        // 可能很大，出口 parse 再重新序列化的开销不划算；analyze_and_load 只回 meta
        // 恒定小 JSON）。get_graph_meta：graph_meta_json 产物恒定。get_graph_page/
        // get_full_graph：同 load_graph_json 的磁盘兑底风险 + 体积，保持 Text。
        // engine_impact：with_index 产物恒定。
        "analyze_and_load" | "get_graph_meta" | "engine_impact" => RpcResultShape::JsonValue,

        // ── Git ──
        // status（json! 构造）/log（commits 数组）恒 JSON；
        // diff/stage/commit/push/pull/init/checkout/branch/stash/discard/blame
        // 是 git 子进程 stdout 文本（run_git 直通），保持 Text。
        "git_status" | "git_log" => RpcResultShape::JsonValue,

        // ── 文件系统 ──
        // list_directory/list_directory_flat：ok_json(DirEntry 数组) 恒 JSON。
        // read_file_content/read_file_base64/read_memory_batch：字节精确/内容
        // 不可控，Text 铁律。user_sessions_list：ok_json(Vec) 恒 JSON。
        "list_directory" | "list_directory_flat" | "user_sessions_list" => RpcResultShape::JsonValue,

        // ── 搜索 ──
        // search_content（含 search_code）/glob：output_val/json! 构造恒 JSON。
        "search_content" | "glob" => RpcResultShape::JsonValue,

        // ── Web ──
        // web_search：json! 构造恒 JSON（空结果也是 {query,results,error}）。
        // web_fetch：网页文本，Text 铁律。
        "web_search" => RpcResultShape::JsonValue,

        // ── Shell ──
        // shell_env：serde 序列化恒 JSON（兑底也是合法 JSON 字面量）。
        // exec_command：前台=命令 stdout 文本 / 流式=started JSON，动态形态，Text。
        // bash_output/bash_kill/bash_wait：输出文本，Text。
        // drain_bg_notifications：无通知返回空串（非 JSON），Text。
        // background_activity：json! 构造恒 JSON。
        "shell_env" | "background_activity" => RpcResultShape::JsonValue,

        // ── 身份认证/权限 ──
        // credential_get：Option<String> serde 序列化，恒 "key"/null JSON。
        // get_last_project：同款 Option<String> serde 序列化，恒 "path"/null。
        "credential_get" | "get_last_project" => RpcResultShape::JsonValue,

        // ── Agent 隔离 ──
        // create（json!）/status（json!）/force_purge（format! 文本）。
        // diff：三种分支都是 json! 构造，但 diff 内容含任意文本——json! 的
        // 字符串值保证转义安全，恒合法 JSON，JsonValue。
        // merge：merge_to_main 返回 git stdout 文本，Text。
        // discard：文案文本，Text。
        "agent_isolation_create" | "agent_isolation_status" | "agent_isolation_diff" => RpcResultShape::JsonValue,

        // ── 外部服务 ──
        // sandbox_status：json! 构造恒 JSON。其余 MCP 文案文本，Text。
        "sandbox_status" => RpcResultShape::JsonValue,

        // ── Hologram 遗留 ──
        // hologram_run_check：serde 序列化（to_string(&result)，空时 unwrap_or_default
        // 返回空串——空串非合法 JSON！保守 Text，前端 merge-gate 自行 parse。
        // （run_check 正常路径永不为空，但 unwrap_or_default 的类型要求意味着
        // 可能，不赌。）

        // ── 插件安装 ──
        // plugin_install：ok_json(String) 恒 JSON 字符串。uninstall/set_enabled：
        // ok_unit "null"，ok_unit 家族统一 Text（见下）。
        "plugin_install" => RpcResultShape::JsonValue,

        // ── 数据流 ──
        // dataflow_query 的 trace_id 路径直通磁盘 .json 文件原文——磁盘文件
        // 可能被写坏，出口 parse 会把业务错变成协议错，保持 Text（前端
        // agentInvoke 兜底链自处理）。save/delete 同域同待遇，不单独展开。
        // dataflow_save | dataflow_query | dataflow_delete → Text

        // ── Aura ──
        // aura_init：json! 构造恒 JSON。aura_recall：DLL 返回 json_str，空可能——
        // 前端有 || '[]' 业务兑底，保守 Text。其余 recall_text/store/count 文本，Text。
        "aura_init" => RpcResultShape::JsonValue,

        // ── LSP ──
        // lsp_request：ok_json(serde 序列化)，恒 JSON。
        "lsp_request" => RpcResultShape::JsonValue,

        // ── 桌面 UIA ──
        // desktop_status：json! 构造恒 JSON。desktop_audit：查询产物 JSON。
        // 其余 desktop_uia_*：树/快照/结果文本，Text（probe 是诊断文案）。
        "desktop_status" | "desktop_audit" => RpcResultShape::JsonValue,

        // ── 其余（含 ok_unit "null" 家族、read_file_content、edit_file、
        // exec_command、浏览器命令、PTY、会话持久化、约束、workspace、
        // protocol_bridge、get_user_sessions_dir、llm_proxy_port 等）──
        // 默认 Text：字节精确优先，形态不恒定或体量不可控的一律不展开。
        _ => RpcResultShape::Text,
    }
}

/// 第二步出口分派：JsonValue 命令的 Ok 路径 parse 成真 Value（parse 失败属
/// 命令违反「Ok 恒为合法 JSON」契约——错误不静默，转错误文案可见）；Text
/// 命令字节精确包 Value::String。Err 路径两种形态统一包 Value::String
/// （错误信息是人读文本，前端 catch 语义不变）。
fn dispatch_result_to_value(method: &str, r: Result<String, String>) -> Result<Value, String> {
    match (rpc_result_shape(method), r) {
        (RpcResultShape::JsonValue, Ok(s)) => serde_json::from_str(&s).map_err(|e| {
            tracing::error!(
                "[rpc] JsonValue 命令 {} 返回非合法 JSON（违反契约，转错误回包）: {}",
                method,
                e
            );
            format!("rpc: {}: 输出非合法 JSON: {}", method, e)
        }),
        (_, Ok(s)) => Ok(str_to_value(s)),
        (_, Err(e)) => Err(e),
    }
}

// ── 单一 RPC 命令 ──

#[tauri::command]
pub(crate) async fn rpc(
    method: String,
    params: Value,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    // panic 容器：Tauri 2.x 命令 future panic 时 resolver 随 task 一起被
    // 丢弃，invoke promise 永远不 resolve——前端工具调用永久挂起，且
    // panic 只进 stderr、不进 bridge.log（2026-08 edit 偶发挂死即此症状，
    // 根因见 editor.rs truncate_err_key 回归测试）。这里把 panic 就地转为
    // Err 回包：错误可见、调用失败返回而不是挂死。与 INVARIANTS #11
    // （响应丢失 → 前端 await 永久挂起）同症状家族的根治护栏。
    // 出口分派（Value 化第二步）：method 移入闭包供形态分派。
    let result = guard_panic(dispatch_rpc(method.clone(), params, state, app_ctx, app)).await;
    dispatch_result_to_value(&method, result)
}

/// 把命令体 panic 转为错误回包，防止 invoke promise 泄漏成永久挂起。
async fn guard_panic(
    fut: impl std::future::Future<Output = Result<String, String>>,
) -> Result<String, String> {
    use futures_util::FutureExt;
    std::panic::AssertUnwindSafe(fut)
        .catch_unwind()
        .await
        .unwrap_or_else(|payload| Err(panic_to_rpc_error(payload)))
}

/// panic payload → 人话错误消息（trace 落 bridge.log，不再无迹可寻）。
fn panic_to_rpc_error(payload: Box<dyn std::any::Any + Send>) -> String {
    let msg = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "未知 panic payload".to_string());
    tracing::error!("[rpc] 命令内部 panic（已转为错误回包）: {}", msg);
    format!("命令内部错误（panic）: {}", msg)
}

async fn dispatch_rpc(
    method: String,
    params: Value,
    state: tauri::State<'_, crate::WorkspaceState>,
    app_ctx: tauri::State<'_, std::sync::Arc<crate::app::AppContexts>>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use crate::commands;

    match method.as_str() {
        // ═══════════════════════════════════════════════════════
        // 应用层：数据上下文 / 会话 attach（L1）
        // ═══════════════════════════════════════════════════════
        "session_attach" => {
            let session_id = params
                .get("session_id")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| format!("{method}: missing 'session_id'"))?;
            let legacy_root = opt_str(&params, "legacy_root");
            let workspace = opt_str(&params, "workspace");
            crate::app::commands::session_attach(session_id, legacy_root, workspace, app_ctx).await
        }
        "session_detach" => {
            let session_id = params
                .get("session_id")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| format!("{method}: missing 'session_id'"))?;
            crate::app::commands::session_detach(session_id, app_ctx, state).await.map(|_| "null".into())
        }
        "session_focus" => {
            let session_id = params
                .get("session_id")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| format!("{method}: missing 'session_id'"))?;
            crate::app::commands::session_focus(session_id, app_ctx)
        }
        "context_list" => crate::app::commands::context_list(app_ctx),

        // ═══════════════════════════════════════════════════════
        // Engine 调度（tools.rs 重新导出）
        // ═══════════════════════════════════════════════════════
        "hologram_call" => {
            let tool = req_str(&params, "tool", "hologram_call")?;
            let args = params.get("args").cloned().unwrap_or(Value::Null);
            // L1：会话/工作区身份透传（决议链见 engine_dispatch）。
            let session_id = opt_u64(&params, "_session_id");
            let workspace = opt_str(&params, "workspace");
            commands::engine_dispatch::hologram_call(tool, args, session_id, workspace, state, app_ctx).await
        }
        "hologram_tools_list" => commands::engine_dispatch::hologram_tools_list(),

        // ═══════════════════════════════════════════════════════
        // Graph（9 个命令）
        // ═══════════════════════════════════════════════════════
        "load_graph_json" => {
            let path = opt_str(&params, "path");
            commands::graph::load_graph_json(path, state, app_ctx).await
        }
        "analyze_and_load" => {
            let path = req_str(&params, "path", "analyze_and_load")?;
            let force = opt_bool(&params, "force");
            commands::graph::analyze_and_load(path, force, app, state, app_ctx).await
        }
        "get_graph_meta" => {
            let session_id = opt_u64(&params, "_session_id");
            commands::graph::get_graph_meta(session_id, state, app_ctx).await
        }
        "get_graph_page" => {
            let page = opt_usize(&params, "page").unwrap_or(0);
            let page_size = opt_usize(&params, "page_size");
            let session_id = opt_u64(&params, "_session_id");
            commands::graph::get_graph_page(page, page_size, session_id, state, app_ctx).await
        }
        "engine_impact" => {
            let node_id = req_str(&params, "node_id", "engine_impact")?;
            let max_depth = opt_usize(&params, "max_depth").unwrap_or(3);
            commands::graph::engine_impact(node_id, max_depth, state, app_ctx).await
        }

        // ═══════════════════════════════════════════════════════
        // Git（23 个命令）
        // ═══════════════════════════════════════════════════════
        "git_status" => {
            let path = req_str(&params, "path", "git_status")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_status(path, is_agent, _agent_id, state, app).await
        }
        "git_diff_unstaged" => {
            let path = req_str(&params, "path", "git_diff_unstaged")?;
            let file = req_str(&params, "file", "git_diff_unstaged")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_diff_unstaged(path, file, is_agent, _agent_id, state, app).await
        }
        "git_diff_staged" => {
            let path = req_str(&params, "path", "git_diff_staged")?;
            let file = req_str(&params, "file", "git_diff_staged")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_diff_staged(path, file, is_agent, _agent_id, state, app).await
        }
        "git_stage" => {
            let path = req_str(&params, "path", "git_stage")?;
            let files = req_strs(&params, "files", "git_stage")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_stage(path, files, is_agent, _agent_id, state, app).await
        }
        "git_stage_all" => {
            let path = req_str(&params, "path", "git_stage_all")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_stage_all(path, is_agent, _agent_id, state, app).await
        }
        "git_commit" => {
            let path = req_str(&params, "path", "git_commit")?;
            let message = req_str(&params, "message", "git_commit")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_commit(path, message, is_agent, _agent_id, state, app).await
        }
        "git_push" => {
            let path = req_str(&params, "path", "git_push")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_push(path, is_agent, _agent_id, state, app).await
        }
        "git_pull" => {
            let path = req_str(&params, "path", "git_pull")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_pull(path, is_agent, _agent_id, state, app).await
        }
        "git_log" => {
            let path = req_str(&params, "path", "git_log")?;
            let limit = opt_i32(&params, "limit");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_log(path, limit, is_agent, _agent_id, state, app).await
        }
        "git_init" => {
            let path = req_str(&params, "path", "git_init")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_init(path, is_agent, _agent_id, state, app).await
        }
        "git_checkout" => {
            let path = req_str(&params, "path", "git_checkout")?;
            let branch = req_str(&params, "branch", "git_checkout")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_checkout(path, branch, is_agent, _agent_id, state, app).await
        }
        "git_create_branch" => {
            let path = req_str(&params, "path", "git_create_branch")?;
            let name = req_str(&params, "name", "git_create_branch")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_create_branch(path, name, is_agent, _agent_id, state, app).await
        }
        "git_stash_push" => {
            let path = req_str(&params, "path", "git_stash_push")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_stash_push(path, is_agent, _agent_id, state, app).await
        }
        "git_stash_pop" => {
            let path = req_str(&params, "path", "git_stash_pop")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_stash_pop(path, is_agent, _agent_id, state, app).await
        }
        "git_discard" => {
            let path = req_str(&params, "path", "git_discard")?;
            let file = req_str(&params, "file", "git_discard")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_discard(path, file, is_agent, _agent_id, state, app).await
        }
        "git_blame" => {
            let path = req_str(&params, "path", "git_blame")?;
            let file = req_str(&params, "file", "git_blame")?;
            let _agent_id = opt_str(&params, "_agent_id");
            commands::git_cmds::git_blame(path, file, _agent_id, state, app).await
        }

        // ═══════════════════════════════════════════════════════
        // 文件系统（13 个命令）
        // ═══════════════════════════════════════════════════════
        "list_directory" => {
            let path = req_str(&params, "path", "list_directory")?;
            let is_agent = opt_bool(&params, "is_agent");
            let filter_ignored = opt_bool(&params, "filter_ignored");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_json(commands::filesystem::list_directory(path, is_agent, filter_ignored, _agent_id, state, app).await)
        }
        "list_directory_flat" => {
            let path = req_str(&params, "path", "list_directory_flat")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_json(commands::filesystem::list_directory_flat(path, is_agent, _agent_id, state, app).await)
        }
        "read_file_content" => {
            let file_path = req_str(&params, "file_path", "read_file_content")?;
            let offset = opt_usize(&params, "offset");
            let limit = opt_usize(&params, "limit");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::filesystem::read_file_content(file_path, offset, limit, is_agent, _agent_id, state, app).await
        }
        "user_sessions_list" => {
            // 会话统一 U2：全局会话列表（全局位恒扫 + legacy_root 兼容源加扫）
            let legacy_root = opt_str(&params, "legacy_root");
            ok_json(commands::filesystem::user_sessions_list(legacy_root).await)
        }
        "get_user_sessions_dir" => {
            // workspace-flip 批 1：用户级会话目录路径（TS sessionsDir('') 路由真源）
            Ok(commands::filesystem::get_user_sessions_dir())
        }
        "read_memory_batch" => {
            let paths: Vec<String> = params.get("paths")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            commands::filesystem::read_memory_batch(paths)
        }
        "read_file_base64" => {
            let file_path = req_str(&params, "file_path", "read_file_base64")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::filesystem::read_file_base64(file_path, is_agent, _agent_id, state, app).await
        }
        "write_file_content" => {
            let file_path = req_str(&params, "file_path", "write_file_content")?;
            let content = req_str(&params, "content", "write_file_content")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::filesystem::write_file_content(file_path, content, is_agent, _agent_id, state, app).await
        }
        "log_append" => {
            let path = req_str(&params, "path", "log_append")?;
            let content = req_str(&params, "content", "log_append")?;
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::log_append(path, content, _agent_id, state))
        }
        "create_directory" => {
            let path = req_str(&params, "path", "create_directory")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::create_directory(path, is_agent, _agent_id, state, app).await)
        }
        "get_global_memory_dir" => Ok(commands::filesystem::get_global_memory_dir()),
        "delete_file_or_dir" => {
            let path = req_str(&params, "path", "delete_file_or_dir")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::delete_file_or_dir(path, is_agent, _agent_id, state, app).await)
        }
        "rename_file_or_dir" => {
            let file_path = req_str(&params, "file_path", "rename_file_or_dir")?;
            let new_name = req_str(&params, "new_name", "rename_file_or_dir")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::rename_file_or_dir(file_path, new_name, is_agent, _agent_id, state, app).await)
        }
        "move_file" => {
            let from = req_str(&params, "from", "move_file")?;
            let to = req_str(&params, "to", "move_file")?;
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            ok_unit(commands::filesystem::move_file(from, to, is_agent, _agent_id, state, app).await)
        }

        // ═══════════════════════════════════════════════════════
        // 搜索（3 个命令）
        // ═══════════════════════════════════════════════════════
        "search_content" => {
            let directory = req_str(&params, "directory", "search_content")?;
            let pattern = req_str(&params, "pattern", "search_content")?;
            let file_types = opt_str(&params, "file_types");
            let max_results = opt_usize(&params, "max_results");
            let use_regex = opt_bool(&params, "use_regex");
            let context_lines = opt_usize(&params, "context_lines");
            let output_mode = opt_str(&params, "output_mode");
            let show_line_numbers = opt_bool(&params, "show_line_numbers");
            let head_limit = opt_usize(&params, "head_limit");
            let offset = opt_usize(&params, "offset");
            let glob_filter = opt_str(&params, "glob_filter");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::search::search_content(
                directory, pattern, file_types, max_results, use_regex,
                context_lines, output_mode, show_line_numbers, head_limit,
                offset, glob_filter, is_agent, _agent_id, state, app,
            ).await
        }
        "glob" => {
            let pattern = req_str(&params, "pattern", "glob")?;
            let path = opt_str(&params, "path");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::search::glob(pattern, path, is_agent, _agent_id, state, app).await
        }

        // ═══════════════════════════════════════════════════════
        // Web（2 个命令）
        // ═══════════════════════════════════════════════════════
        "web_search" => {
            let query = req_str(&params, "query", "web_search")?;
            let agent_id = opt_str(&params, "_agent_id");
            commands::web::web_search(query, agent_id, state, app).await
        }
        "web_fetch" => {
            let url = req_str(&params, "url", "web_fetch")?;
            let agent_id = opt_str(&params, "_agent_id");
            commands::web::web_fetch(url, agent_id, state, app).await
        }

        // ═══════════════════════════════════════════════════════
        // CDP 浏览器控制（37 个命令）
        // 权限：所有 browser_* 分支统一经过 check_browser_permission（BrowserTool）。
        //       launch/kill/attach/connect/eval/cookies_set/cookies_delete 走 Ask；
        //       inspect/report/targets/snapshot/content/console/network/network_detail/network_har/
        //       screenshot/audit/status/wait/sessions/cookies_list 只读放行；
        //       navigate/back/forward/reload/click/hover/type/select/upload/dialog/press/
        //       scroll/viewport/new_tab/close_tab/switch_session 依赖 attach/launch 时已获
        //       批准的 target，不再重复弹窗——但敏感目标
        //       （已填值输入框/提交按钮/下载/高危文本）每次单独 Ask（ADR 0003 D6 L3）。
        //       工具级 Browser=deny 对所有动作生效（含只读与 self 通道）。
        // 会话：所有命令按 _agent_id 键控路由到各 Agent 自己的 CDP 会话；
        //       self=true 时路由到自家 webview 只读会话（操作类动作被拒）。
        // ═══════════════════════════════════════════════════════
        "browser_launch" => {
            let agent_id = opt_str(&params, "_agent_id");
            check_browser_permission("launch", agent_id.as_deref(), &state, &app).await?;
            let url = opt_str(&params, "url");
            let port = opt_u64(&params, "port").map(|n| n as u16);
            let headless = opt_bool(&params, "headless");
            let profile = opt_str(&params, "profile");
            let proxy = opt_str(&params, "proxy");
            let proxy_bypass = opt_str(&params, "proxy_bypass");
            let window_size = params
                .get("window_size")
                .and_then(|v| v.as_object())
                .map(|o| {
                    let w = o.get("width").and_then(|v| v.as_u64()).ok_or_else(|| {
                        "browser_launch: windowSize.width 必须是正整数".to_string()
                    })?;
                    let h = o.get("height").and_then(|v| v.as_u64()).ok_or_else(|| {
                        "browser_launch: windowSize.height 必须是正整数".to_string()
                    })?;
                    let w = u32::try_from(w).map_err(|_| {
                        "browser_launch: windowSize.width 必须在 1-16384 之间".to_string()
                    })?;
                    let h = u32::try_from(h).map_err(|_| {
                        "browser_launch: windowSize.height 必须在 1-16384 之间".to_string()
                    })?;
                    Ok::<(u32, u32), String>((w, h))
                })
                .transpose()?;
            crate::cdp::cdp_launch(
                url, port, headless, window_size, profile, proxy, proxy_bypass,
                agent_id.as_deref(),
            )
            .await
        }
        "browser_connect" => {
            let agent_id = opt_str(&params, "_agent_id");
            check_browser_permission("connect", agent_id.as_deref(), &state, &app).await?;
            let port = opt_u64(&params, "port")
                .ok_or_else(|| "browser_connect: missing 'port'".to_string())?;
            if port == 0 || port > 65535 {
                return Err("browser_connect: 端口必须在 1-65535".into());
            }
            let profile = opt_str(&params, "session").or_else(|| opt_str(&params, "profile"));
            crate::cdp::cdp_connect(port as u16, profile, agent_id.as_deref())
        }
        "browser_sessions" => {
            let agent_id = opt_str(&params, "_agent_id");
            check_browser_permission("sessions", agent_id.as_deref(), &state, &app).await?;
            Ok(crate::cdp::cdp_sessions(agent_id.as_deref()))
        }
        "browser_switch_session" => {
            let agent_id = opt_str(&params, "_agent_id");
            check_browser_permission("switch_session", agent_id.as_deref(), &state, &app).await?;
            let profile = opt_str(&params, "session").or_else(|| opt_str(&params, "profile"));
            crate::cdp::cdp_switch_session(profile, agent_id.as_deref())
        }
        "browser_cookies" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_cookies: self 会话只读，不暴露/修改自家 webview cookie".into());
            }
            let action = req_str(&params, "op", "browser_cookies")?;
            let perm = match action.as_str() {
                "list" => "cookies_list",
                "set" => "cookies_set",
                "delete" => "cookies_delete",
                _ => return Err("browser_cookies: action 只支持 list/set/delete".into()),
            };
            check_browser_permission(perm, agent_id.as_deref(), &state, &app).await?;
            let urls = params.get("urls").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect::<Vec<String>>()
            });
            let url = opt_str(&params, "url");
            let name = opt_str(&params, "name");
            let value = opt_str(&params, "value");
            let domain = opt_str(&params, "domain");
            let path = opt_str(&params, "path");
            let http_only = opt_bool(&params, "http_only");
            let secure = opt_bool(&params, "secure");
            let same_site = opt_str(&params, "same_site");
            let expires = opt_f64(&params, "expires");
            crate::cdp::cdp_cookies(
                &action, urls, url, name, value, domain, path, http_only, secure, same_site,
                expires, agent_id.as_deref(),
            )
            .await
        }
        "browser_kill" => {
            let agent_id = opt_str(&params, "_agent_id");
            check_browser_permission("kill", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_kill(agent_id.as_deref())
        }
        "browser_targets" => {
            let agent_id = opt_str(&params, "_agent_id");
            check_browser_permission("targets", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_targets(agent_id.as_deref())
        }
        "browser_discover" => {
            // 只读：只列清单，不连接任何实例；但工具级 Deny 仍生效
            check_browser_permission("discover", None, &state, &app).await?;
            crate::cdp::cdp_discover()
        }
        "desktop_probe" => {
            let agent_id = opt_str(&params, "_agent_id");
            desktop_check(&state, &app, &agent_id, "probe").await?;
            // 只读快照:进程/窗口/控制台可见性,纯查询
            let base = crate::desktop::desktop_probe()?;
            // 通道路由建议：chromium 窗口→cdp；其余按 UIA interactive 探测→uia/vision
            let route = opt_bool(&params, "route").unwrap_or(true);
            if !route {
                return Ok(base);
            }
            let mut v: serde_json::Value = serde_json::from_str(&base)
                .map_err(|e| format!("desktop_probe: 解析快照失败: {e}"))?;
            let proc_chromium: std::collections::HashMap<u64, bool> = v["processes"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|p| {
                            let pid = p["pid"].as_u64()?;
                            let is_c = p["is_chromium"].as_bool()?;
                            Some((pid, is_c))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let Some(wins) = v["windows"].as_array_mut() {
                for w in wins.iter_mut() {
                    let pid = w["pid"].as_u64().unwrap_or(0);
                    let hwnd = w["hwnd"].as_u64().unwrap_or(0);
                    if proc_chromium.get(&pid).copied().unwrap_or(false) {
                        w["route"] = serde_json::json!({
                            "channel": "cdp",
                            "hint": "browser_discover → browser_connect（或 browser_launch 受控实例）",
                        });
                        continue;
                    }
                    // UIA 快速探测（预算 50ms/窗；失败归 vision，不阻塞 probe）
                    let probe = if hwnd != 0 { crate::uia::probe_route(hwnd).await } else { Err("no hwnd".into()) };
                    w["route"] = match probe {
                        Ok(p) if p["interactive"].as_u64().unwrap_or(0) >= 3 => serde_json::json!({
                            "channel": "uia",
                            "hint": "desktop_uia_tree（标准控件可用，按 ref 操作）",
                        }),
                        _ => serde_json::json!({
                            "channel": "vision",
                            "hint": "自绘/无标准控件 → desktop_uia_window_shot + 多模态读图",
                        }),
                    };
                }
            }
            Ok(v.to_string())
        }
        "desktop_screenshot" => {
            let agent_id = opt_str(&params, "_agent_id");
            // 高隐私面:DesktopTool 第 8 层 Ask(已从 read-only 移除)
            desktop_check(&state, &app, &agent_id, "screenshot").await?;
            crate::desktop::desktop_screenshot()
        }
        "desktop_uia_tree" => {
            let agent_id = opt_str(&params, "_agent_id");
            desktop_check(&state, &app, &agent_id, "uia_tree").await?;
            // 只读:窗口 UIA 控件树 + ref 清单(默认 interactive-only,分页)
            crate::uia::uia_tree(
                opt_str(&params, "title").as_deref(),
                opt_u32(&params, "pid"),
                opt_u64(&params, "hwnd"),
                opt_u32(&params, "depth"),
                opt_bool(&params, "all").unwrap_or(false),
                opt_u64(&params, "offset").unwrap_or(0) as usize,
                opt_u64(&params, "max_results").unwrap_or(0) as usize,
            )
            .await
        }
        "desktop_uia_find" => {
            let agent_id = opt_str(&params, "_agent_id");
            desktop_check(&state, &app, &agent_id, "uia_find").await?;
            // 只读:按条件在窗口内查找控件
            crate::uia::uia_find(
                opt_str(&params, "title").as_deref(),
                opt_u32(&params, "pid"),
                opt_u64(&params, "hwnd"),
                opt_str(&params, "name").as_deref(),
                opt_str(&params, "control_type").as_deref(),
                opt_str(&params, "automation_id").as_deref(),
                opt_bool(&params, "enabled"),
            )
            .await
        }
        "desktop_uia_read" => {
            let agent_id = opt_str(&params, "_agent_id");
            desktop_check(&state, &app, &agent_id, "uia_read").await?;
            // 只读:单控件全量详情(value/toggle/expand/rect/patterns)
            crate::uia::uia_read(
                opt_str(&params, "title").as_deref(),
                opt_u32(&params, "pid"),
                opt_u64(&params, "hwnd"),
                opt_u32(&params, "ref"),
                opt_str(&params, "name").as_deref(),
                opt_str(&params, "automation_id").as_deref(),
                opt_str(&params, "control_type").as_deref(),
            )
            .await
        }
        "desktop_uia_wait" => {
            let agent_id = opt_str(&params, "_agent_id");
            desktop_check(&state, &app, &agent_id, "uia_wait").await?;
            // 只读:轮询等待控件出现/启用/值匹配(超时返回 found:false,不报错)
            crate::uia::uia_wait(
                opt_str(&params, "title").as_deref(),
                opt_u32(&params, "pid"),
                opt_u64(&params, "hwnd"),
                opt_u32(&params, "ref"),
                opt_str(&params, "name").as_deref(),
                opt_str(&params, "automation_id").as_deref(),
                opt_str(&params, "control_type").as_deref(),
                &req_str(&params, "until", "desktop_uia_wait")?,
                opt_str(&params, "value").as_deref(),
                opt_u64(&params, "timeout_ms").unwrap_or(10_000),
            )
            .await
        }
        "desktop_uia_click" => desktop_uia_write(&state, &app, &params, "click").await,
        "desktop_uia_right_click" => desktop_uia_write(&state, &app, &params, "right_click").await,
        "desktop_uia_type" => desktop_uia_write(&state, &app, &params, "type").await,
        "desktop_uia_scroll" => desktop_uia_write(&state, &app, &params, "scroll").await,
        "desktop_uia_select" => desktop_uia_write(&state, &app, &params, "select").await,
        "desktop_uia_expand" => desktop_uia_write(&state, &app, &params, "expand").await,
        "desktop_uia_keys" => desktop_uia_keys(&state, &app, &params).await,
        "desktop_uia_activate" => desktop_uia_activate(&state, &app, &params).await,
        "desktop_uia_window_shot" => {
            let agent_id = opt_str(&params, "_agent_id");
            desktop_check(&state, &app, &agent_id, "uia_window_shot").await?;
            // 只读:按窗口矩形截图(非全屏,隐私面更小)
            crate::uia::uia_window_shot(
                opt_str(&params, "title").as_deref(),
                opt_u32(&params, "pid"),
                opt_u64(&params, "hwnd"),
            )
            .await
        }
        "desktop_audit" => {
            let agent_id = opt_str(&params, "_agent_id");
            desktop_check(&state, &app, &agent_id, "audit").await?;
            // 只读:desktop 操作审计查询(对齐 browser_audit)
            Ok(crate::uia::desktop_audit_query(
                agent_id.as_deref(),
                opt_u64(&params, "limit").map(|l| l as usize),
            ))
        }
        "desktop_status" => {
            let agent_id = opt_str(&params, "_agent_id");
            desktop_check(&state, &app, &agent_id, "probe").await?;
            // 只读:窗口授权(grants) + 输入租约持有者 + worker 存活状态
            Ok(serde_json::json!({
                "grants": crate::uia::list_grants().iter()
                    .map(|(a, h, ttl)| serde_json::json!({ "agent": a, "hwnd": h, "ttl_secs": ttl }))
                    .collect::<Vec<_>>(),
                "input_lease_holder": crate::uia::lease_holder(),
            })
            .to_string())
        }
        "browser_attach" => {
            let agent_id = opt_str(&params, "_agent_id");
            check_browser_permission("attach", agent_id.as_deref(), &state, &app).await?;
            // 前端 schema 用 targetId（camelCase → target_id）；兼容旧调用方的 target
            let target = opt_str(&params, "target_id")
                .or_else(|| opt_str(&params, "target"))
                .ok_or_else(|| "browser_attach: missing 'targetId'".to_string())?;
            crate::cdp::cdp_attach(&target, agent_id.as_deref())
        }
        "browser_inspect" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("inspect", agent_id.as_deref(), &state, &app).await?;
            let selector = req_str(&params, "selector", "browser_inspect")?;
            let props = params.get("props")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<String>>());
            let max_results = opt_usize(&params, "max_results");
            crate::cdp::cdp_inspect(&selector, props, max_results, agent_id.as_deref()).await
        }
        "browser_report" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("report", agent_id.as_deref(), &state, &app).await?;
            let scope = opt_str(&params, "scope");
            crate::cdp::cdp_report(scope, agent_id.as_deref()).await
        }
        "browser_snapshot" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("snapshot", agent_id.as_deref(), &state, &app).await?;
            let scope = opt_str(&params, "scope");
            let max_results = opt_usize(&params, "max_results");
            let offset = opt_usize(&params, "offset");
            crate::cdp::cdp_snapshot(scope, max_results, offset, agent_id.as_deref()).await
        }
        "browser_content" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("content", agent_id.as_deref(), &state, &app).await?;
            let scope = opt_str(&params, "scope");
            let format = opt_str(&params, "format");
            let max_chars = opt_usize(&params, "max_chars");
            let offset = opt_usize(&params, "offset");
            crate::cdp::cdp_content(scope, format, max_chars, offset, agent_id.as_deref()).await
        }
        "browser_console" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("console", agent_id.as_deref(), &state, &app).await?;
            let limit = opt_usize(&params, "limit");
            Ok(crate::cdp::cdp_console(agent_id.as_deref(), limit))
        }
        "browser_network" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("network", agent_id.as_deref(), &state, &app).await?;
            let limit = opt_usize(&params, "limit");
            Ok(crate::cdp::cdp_network(agent_id.as_deref(), limit))
        }
        "browser_network_detail" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("network_detail", agent_id.as_deref(), &state, &app).await?;
            let request_id = req_str(&params, "request_id", "browser_network_detail")?;
            crate::cdp::cdp_network_detail(&request_id, agent_id.as_deref())
        }
        "browser_network_har" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("network_har", agent_id.as_deref(), &state, &app).await?;
            let limit = opt_usize(&params, "limit");
            crate::cdp::cdp_network_har(agent_id.as_deref(), limit)
        }
        "browser_screenshot" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("screenshot", agent_id.as_deref(), &state, &app).await?;
            let full_page = opt_bool(&params, "full_page").unwrap_or(false);
            let inline = opt_bool(&params, "inline").unwrap_or(false);
            crate::cdp::cdp_screenshot(full_page, inline, agent_id.as_deref()).await
        }
        "browser_viewport" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_viewport: self 会话只读，不能操作自家 webview".into());
            }
            check_browser_permission("viewport", agent_id.as_deref(), &state, &app).await?;
            let width = opt_u64(&params, "width")
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| "browser_viewport: missing or invalid 'width'".to_string())?;
            let height = opt_u64(&params, "height")
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| "browser_viewport: missing or invalid 'height'".to_string())?;
            let device_scale_factor = params.get("device_scale_factor").and_then(|v| v.as_f64());
            let mobile = opt_bool(&params, "mobile");
            crate::cdp::cdp_set_viewport(width, height, device_scale_factor, mobile, agent_id.as_deref()).await
        }
        "browser_audit" => {
            check_browser_permission("audit", None, &state, &app).await?;
            let agent = opt_str(&params, "agent");
            let limit = opt_usize(&params, "limit");
            Ok(crate::cdp::cdp_audit(agent.as_deref(), limit))
        }
        "browser_click" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_click: self 会话只读，不能操作自家 webview".into());
            }
            let selector = req_str(&params, "selector", "browser_click")?;
            check_browser_permission("click", agent_id.as_deref(), &state, &app).await?;
            // 敏感目标（提交按钮/下载/中英文高危文本）→ 每次单独 Ask（ADR 0003 D6 L3）
            if crate::cdp::check_sensitive(&selector, "click", agent_id.as_deref()).await {
                check_browser_permission("click_sensitive", agent_id.as_deref(), &state, &app).await?;
            }
            crate::cdp::cdp_click(&selector, agent_id.as_deref()).await
        }
        "browser_type" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_type: self 会话只读，不能操作自家 webview".into());
            }
            let selector = req_str(&params, "selector", "browser_type")?;
            let text = req_str(&params, "text", "browser_type")?;
            let replace = opt_bool(&params, "replace").unwrap_or(false);
            check_browser_permission("type", agent_id.as_deref(), &state, &app).await?;
            // 敏感目标（已填值输入框/密码框）→ 每次单独 Ask（ADR 0003 D6 L3）
            if crate::cdp::check_sensitive(&selector, "type", agent_id.as_deref()).await {
                check_browser_permission("type_sensitive", agent_id.as_deref(), &state, &app).await?;
            }
            crate::cdp::cdp_type(&selector, &text, replace, agent_id.as_deref()).await
        }
        "browser_press" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_press: self 会话只读，不能操作自家 webview".into());
            }
            let key = req_str(&params, "key", "browser_press")?;
            let modifiers = params
                .get("modifiers")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<String>>());
            check_browser_permission("press", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_press(&key, modifiers, agent_id.as_deref()).await
        }
        "browser_hover" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_hover: self 会话只读，不能操作自家 webview".into());
            }
            let selector = req_str(&params, "selector", "browser_hover")?;
            check_browser_permission("hover", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_hover(&selector, agent_id.as_deref()).await
        }
        "browser_dialog" => {
            let agent_id = self_or_agent(&params);
            let accept = opt_bool(&params, "accept");
            if accept.is_some() {
                if crate::cdp::is_self(agent_id.as_deref()) {
                    return Err("browser_dialog: self 会话只读，不能操作自家 webview".into());
                }
                check_browser_permission("dialog", agent_id.as_deref(), &state, &app).await?;
                let prompt_text = opt_str(&params, "prompt_text");
                crate::cdp::cdp_handle_dialog(accept.unwrap_or(false), prompt_text, agent_id.as_deref()).await
            } else {
                // 只查询 pending/最近 dialog；self 通道也可用。
                check_browser_permission("dialog_query", agent_id.as_deref(), &state, &app).await?;
                let limit = opt_usize(&params, "limit");
                Ok(crate::cdp::cdp_dialogs(agent_id.as_deref(), limit))
            }
        }
        "browser_upload" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_upload: self 会话只读，不能操作自家 webview".into());
            }
            let selector = opt_str(&params, "selector");
            let files = req_strs(&params, "files", "browser_upload")?;
            check_browser_permission("upload", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_upload(selector, files, agent_id.as_deref()).await
        }
        "browser_new_tab" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_new_tab: self 会话只读，不能操作自家 webview".into());
            }
            check_browser_permission("new_tab", agent_id.as_deref(), &state, &app).await?;
            let url = opt_str(&params, "url");
            crate::cdp::cdp_new_tab(url, agent_id.as_deref()).await
        }
        "browser_close_tab" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_close_tab: self 会话只读，不能操作自家 webview".into());
            }
            let target_id = opt_str(&params, "target_id")
                .ok_or_else(|| "browser_close_tab: missing 'targetId'".to_string())?;
            check_browser_permission("close_tab", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_close_tab(&target_id, agent_id.as_deref())
        }
        "browser_scroll" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_scroll: self 会话只读，不能操作自家 webview".into());
            }
            let selector = opt_str(&params, "selector");
            let direction = opt_str(&params, "direction");
            check_browser_permission("scroll", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_scroll(selector, direction, agent_id.as_deref()).await
        }
        "browser_navigate" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_navigate: self 会话只读，不能操作自家 webview".into());
            }
            let url = req_str(&params, "url", "browser_navigate")?;
            check_browser_permission("navigate", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_navigate(&url, agent_id.as_deref()).await
        }
        "browser_back" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_back: self 会话只读，不能操作自家 webview".into());
            }
            check_browser_permission("back", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_back(agent_id.as_deref()).await
        }
        "browser_forward" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_forward: self 会话只读，不能操作自家 webview".into());
            }
            check_browser_permission("forward", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_forward(agent_id.as_deref()).await
        }
        "browser_reload" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_reload: self 会话只读，不能操作自家 webview".into());
            }
            check_browser_permission("reload", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_reload(agent_id.as_deref()).await
        }
        "browser_select" => {
            let agent_id = self_or_agent(&params);
            if crate::cdp::is_self(agent_id.as_deref()) {
                return Err("browser_select: self 会话只读，不能操作自家 webview".into());
            }
            let selector = req_str(&params, "selector", "browser_select")?;
            let value = req_str(&params, "value", "browser_select")?;
            check_browser_permission("select", agent_id.as_deref(), &state, &app).await?;
            crate::cdp::cdp_select(&selector, &value, agent_id.as_deref()).await
        }
        "browser_wait" => {
            // 只读等待(selector 出现或固定 ms)，不改变状态；Deny 仍生效
            let agent_id = self_or_agent(&params);
            check_browser_permission("wait", agent_id.as_deref(), &state, &app).await?;
            let selector = opt_str(&params, "selector");
            let ms = opt_u64(&params, "ms");
            crate::cdp::cdp_wait(selector, ms, agent_id.as_deref()).await
        }
        "browser_eval" => {
            let agent_id = opt_str(&params, "_agent_id");
            check_browser_permission("eval", agent_id.as_deref(), &state, &app).await?;
            let expr = req_str(&params, "expr", "browser_eval")?;
            crate::cdp::cdp_eval(&expr, agent_id.as_deref()).await
        }
        "browser_status" => {
            let agent_id = self_or_agent(&params);
            check_browser_permission("status", agent_id.as_deref(), &state, &app).await?;
            Ok(crate::cdp::cdp_status(agent_id.as_deref()))
        }

        // ═══════════════════════════════════════════════════════
        // Shell（3 个命令）
        // ═══════════════════════════════════════════════════════
        "exec_command" => {
            let command = req_str(&params, "command", "exec_command")?;
            let cwd = opt_str(&params, "cwd");
            let timeout_ms = opt_u64(&params, "timeout_ms");
            let run_in_background = opt_bool(&params, "run_in_background");
            let is_agent = opt_bool(&params, "is_agent");
            let agent_id = opt_str(&params, "_agent_id").or_else(|| opt_str(&params, "agent_id"));
            // 通知路由身份（bus agent id）— 与 _agent_id（worktree 隔离 id）分离
            let owner_id = opt_str(&params, "_owner_id");
            let stream_tool_id = opt_str(&params, "stream_tool_id");
            let interpreter = opt_str(&params, "interpreter");
            commands::shell::exec_command(command, cwd, timeout_ms, run_in_background, is_agent, stream_tool_id, agent_id, interpreter, owner_id, state, app).await
        }
        "bash_output" => {
            let job_id = params.get("job_id").and_then(|v| v.as_u64()).map(|n| n as u32)
                .ok_or_else(|| "bash_output: missing 'job_id'".to_string())?;
            commands::shell::bash_output(job_id).await
        }
                "bash_kill" => {
            let job_id = params.get("job_id").and_then(|v| v.as_u64()).map(|n| n as u32)
                .ok_or_else(|| "bash_kill: missing 'job_id'".to_string())?;
            // kill 所有权身份优先 _owner_id（与 spawn 时 job owner 对齐），回退 agent_id
            let agent_id = opt_str(&params, "_owner_id").or_else(|| opt_str(&params, "agent_id"));
            commands::shell::bash_kill(job_id, agent_id).await
        }
        "bash_wait" => {
            let job_id = params.get("job_id").and_then(|v| v.as_u64()).map(|n| n as u32)
                .ok_or_else(|| "bash_wait: missing 'job_id'".to_string())?;
            let timeout_ms = opt_u64(&params, "timeout_ms");
            commands::shell::bash_wait(job_id, timeout_ms).await
        }
        "shell_env" => Ok(commands::shell::shell_env()),
        "background_activity" => {
            // 状态栏 HUD 只读聚合：正在运行的 shell 后台任务 + 浏览器会话。
            // 不经过 Agent 权限引擎（本机 UI 查询，不含命令输出/页面内容）。
            let shells = crate::utils::bg_jobs_snapshot();
            let browsers = crate::cdp::cdp_browser_activity();
            Ok(serde_json::json!({ "shells": shells, "browsers": browsers }).to_string())
        }
        "drain_bg_notifications" => {
            let agent_id = opt_str(&params, "agent_id");
            commands::shell::drain_bg_notifications(agent_id).await
        }
        "protocol_bridge_spawn" => {
            let id = req_str(&params, "id", "protocol_bridge_spawn")?;
            let command = req_str(&params, "command", "protocol_bridge_spawn")?;
            let args = req_strs(&params, "args", "protocol_bridge_spawn")?;
            commands::protocol_bridge::protocol_bridge_spawn(id, command, args, app)
        }
        "protocol_bridge_write" => {
            let id = req_str(&params, "id", "protocol_bridge_write")?;
            let line = req_str(&params, "line", "protocol_bridge_write")?;
            commands::protocol_bridge::protocol_bridge_write(id, line)
        }
        "protocol_bridge_kill" => {
            let id = req_str(&params, "id", "protocol_bridge_kill")?;
            commands::protocol_bridge::protocol_bridge_kill(id)
        }

        // ═══════════════════════════════════════════════════════
        // 编辑器（1 个命令）
        // ═══════════════════════════════════════════════════════
        "edit_file" => {
            let file_path = req_str(&params, "file_path", "edit_file")?;
            let old_string = req_str(&params, "old_string", "edit_file")?;
            let new_string = req_str(&params, "new_string", "edit_file")?;
            let replace_all = opt_bool(&params, "replace_all");
            let is_agent = opt_bool(&params, "is_agent");
            let _agent_id = opt_str(&params, "_agent_id");
            commands::editor::edit_file(file_path, old_string, new_string, replace_all, is_agent, _agent_id, state, app).await
        }

        // ═══════════════════════════════════════════════════════
        // 身份认证（5 个命令）
        // ═══════════════════════════════════════════════════════
        "permission_ask_response" => {
            let request_id = req_str(&params, "request_id", "permission_ask_response")?;
            let allow = match params.get("allow") {
                Some(v) => v.as_bool().ok_or_else(|| format!("参数 'allow' 必须是布尔值，收到: {}", v))?,
                None => return Err("参数 'allow' 缺失 — 必须明确指定允许或拒绝".to_string()),
            };
            // 验证可选参数 — 类型错误时报错，不静默吞掉
            let remember = match params.get("remember") {
                None => None,
                Some(Value::Bool(b)) => Some(*b),
                Some(v) => return Err(format!("参数 'remember' 必须是布尔值，收到: {}", v)),
            };
            let rule_to_add = match params.get("rule_to_add") {
                None => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Null) => None,
                Some(v) => return Err(format!("参数 'rule_to_add' 必须是字符串，收到: {}", v)),
            };
            let rule_behavior = match params.get("rule_behavior") {
                None => None,
                Some(Value::String(s)) => {
                    // 验证已知行为值
                    let valid = ["allow", "deny", "ask"];
                    if !valid.contains(&s.as_str()) {
                        return Err(format!("参数 'rule_behavior' 无效: '{}' (允许: {})", s, valid.join(", ")));
                    }
                    Some(s.clone())
                }
                Some(Value::Null) => None,
                Some(v) => return Err(format!("参数 'rule_behavior' 必须是字符串，收到: {}", v)),
            };
            ok_unit(commands::identity::permission_ask_response(request_id, allow, remember, rule_to_add, rule_behavior, state).await)
        }
        "set_permission_mode" => {
            let mode = req_str(&params, "mode", "set_permission_mode")?;
            ok_unit(commands::identity::set_permission_mode(mode))
        }
        "credential_store" => {
            let provider = req_str(&params, "provider", "credential_store")?;
            let key = req_str(&params, "key", "credential_store")?;
            // 同步 DPAPI/Keychain/secret-tool 操作 — 移到阻塞线程池，避免卡住异步 runtime
            let r = tokio::task::spawn_blocking(move || commands::identity::credential_store(provider, key))
                .await
                .map_err(|e| format!("credential_store 任务失败: {e}"))?;
            ok_unit(r)
        }
        "credential_get" => {
            let provider = req_str(&params, "provider", "credential_get")?;
            let r = tokio::task::spawn_blocking(move || commands::identity::credential_get(provider))
                .await
                .map_err(|e| format!("credential_get 任务失败: {e}"))?;
            ok_json(r)
        }
        "credential_delete" => {
            let provider = req_str(&params, "provider", "credential_delete")?;
            let r = tokio::task::spawn_blocking(move || commands::identity::credential_delete(provider))
                .await
                .map_err(|e| format!("credential_delete 任务失败: {e}"))?;
            ok_unit(r)
        }
        "llm_proxy_port" => Ok(crate::llm_proxy::proxy_port().to_string()),

        // ═══════════════════════════════════════════════════════
        // 插件安装通道（3 个命令，S4-3）：npm tarball 源 / 本地目录 → 下载/解包/
        // tar-slip 防护/原子落盘；卸载/禁用走 plugins.json 读改写。
        // 生效时机：重启（装载是 boot 期一次性——UI 提示条如实声明）。
        // ═══════════════════════════════════════════════════════
        "plugin_install" => {
            let source = commands::plugin_install::PluginSource::from_params(&params)?;
            let expect_name = opt_str(&params, "expect_name");
            // 本地目录源走复制路径；registry/tarball 走下载+解包路径
            let name = match source {
                commands::plugin_install::PluginSource::LocalDir(dir) => {
                    commands::plugin_install::plugin_install_local_dir(dir, expect_name).await?
                }
                other => commands::plugin_install::plugin_install(other, expect_name).await?,
            };
            ok_json(Ok(name))
        }
        "plugin_uninstall" => {
            let name = req_str(&params, "name", "plugin_uninstall")?;
            let r = tokio::task::spawn_blocking(move || commands::plugin_install::plugin_uninstall(&name))
                .await
                .map_err(|e| format!("plugin_uninstall 任务失败: {e}"))?;
            ok_unit(r)
        }
        "plugin_dir" => {
            let name = req_str(&params, "name", "plugin_dir")?;
            let r = tokio::task::spawn_blocking(move || commands::plugin_install::plugin_dir(&name))
                .await
                .map_err(|e| format!("plugin_dir 任务失败: {e}"))?;
            ok_json(r)
        }
        "plugin_set_enabled" => {
            let name = req_str(&params, "name", "plugin_set_enabled")?;
            let enabled = match params.get("enabled") {
                Some(v) => v.as_bool().ok_or_else(|| format!("参数 'enabled' 必须是布尔值，收到: {v}"))?,
                None => return Err("参数 'enabled' 缺失 — 必须明确指定启用或禁用".to_string()),
            };
            let r = tokio::task::spawn_blocking(move || commands::plugin_install::plugin_set_enabled(&name, enabled))
                .await
                .map_err(|e| format!("plugin_set_enabled 任务失败: {e}"))?;
            ok_unit(r)
        }

        // ═══════════════════════════════════════════════════════
        // Agent 隔离（7 个命令）
        // P1-18：worktree 生命周期操作是阻塞进程等待（git worktree add/diff/
        // merge/prune 的 .output()），全部经 spawn_blocking 移出 async worker。
        // ═══════════════════════════════════════════════════════
        "agent_isolation_create" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_create")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_create(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_create 任务失败: {e}"))?
        }
        "agent_isolation_diff" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_diff")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_diff(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_diff 任务失败: {e}"))?
        }
        "agent_isolation_merge" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_merge")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_merge(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_merge 任务失败: {e}"))?
        }
        "agent_isolation_discard" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_discard")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_discard(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_discard 任务失败: {e}"))?
        }
        "agent_isolation_status" => {
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_status(&ws))
                .await
                .map_err(|e| format!("agent_isolation_status 任务失败: {e}"))?
        }
        "agent_isolation_force_purge" => {
            let agent_id = req_str(&params, "agent_id", "agent_isolation_force_purge")?;
            let ws = state.inner().clone();
            tokio::task::spawn_blocking(move || commands::isolation::agent_isolation_force_purge(agent_id, &ws))
                .await
                .map_err(|e| format!("agent_isolation_force_purge 任务失败: {e}"))?
        }

        // ═══════════════════════════════════════════════════════
        // 外部服务（6 个命令）
        // ═══════════════════════════════════════════════════════
        "start_mcp_server" => {
            let project_root = req_str(&params, "project_root", "start_mcp_server")?;
            commands::external::start_mcp_server(project_root).await
        }
        "stop_mcp_server" => commands::external::stop_mcp_server().await,
        "sandbox_status" => commands::external::sandbox_status(),

        // ═══════════════════════════════════════════════════════
        // Hologram（尚未迁入 engine ToolRegistry 的遗留命令）
        // ═══════════════════════════════════════════════════════
        "hologram_run_check" => {
            let path = opt_str(&params, "path");
            let session_id = opt_u64(&params, "_session_id");
            commands::hologram::hologram_run_check(path, session_id, state, app_ctx).await
        }
        "hologram_record_event" => {
            let event_type = req_str(&params, "event_type", "hologram_record_event")?;
            let file = opt_str(&params, "file");
            let summary = req_str(&params, "summary", "hologram_record_event")?;
            let session_id = opt_u64(&params, "_session_id");
            // E3: 统一返回包装 — 将 "ok" 映射为 "null" 以保持
            // 与其他返回单元的命令一致（ok_unit 模式）。
            // 前端以 fire-and-forget 方式调用，不检查返回值。
            commands::hologram::hologram_record_event(event_type, file, summary, session_id, state, app_ctx)
                .await
                .map(|_| "null".into())
        }
        "get_full_graph" => {
            let session_id = opt_u64(&params, "_session_id");
            commands::hologram::get_full_graph(session_id, state, app_ctx).await
        }

        // ═══════════════════════════════════════════════════════
        // 工作区（4 个命令）
        // ═══════════════════════════════════════════════════════
        "workspace_activate" => {
            let path = req_str(&params, "path", "workspace_activate")?;
            ok_unit(commands::workspace::workspace_activate(path, state, app_ctx).await)
        }
        "workspace_deactivate" => {
            ok_unit(commands::workspace::workspace_deactivate(state, app_ctx).await)
        }
        "workspace_start_watcher" => {
            ok_unit(commands::workspace::workspace_start_watcher(app, state).await)
        }
        // get_last_project：Option<String> serde 序列化，恒 "path"/null JSON
        //（credential_get 同款）；图谱引擎停用时冷启动的唯一恢复信号。
        "get_last_project" => {
            let r = tokio::task::spawn_blocking(commands::workspace::get_last_project)
                .await
                .map_err(|e| format!("get_last_project 任务失败: {e}"))?;
            ok_json(r)
        }

        // ═══════════════════════════════════════════════════════
        // 会话持久化（2 个命令）
        // ═══════════════════════════════════════════════════════
        "session_append" => {
            let path = req_str(&params, "path", "session_append")?;
            let session_id = req_str(&params, "session_id", "session_append")?;
            crate::utils::sanitize_path_id(&session_id, "session_id")?;
            let message = params.get("message")
                .ok_or("session_append: missing 'message'")?;
            let file = std::path::Path::new(&path)
                .join(".lantai/sessions")
                .join(format!("{session_id}.ndjson"));
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("session_append: cannot create dir: {e}"))?;
            }
            let line = serde_json::to_string(message)
                .map_err(|e| format!("session_append: serialize: {e}"))?;
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)
                .map_err(|e| format!("session_append: open: {e}"))?;
            f.write_all(line.as_bytes())
                .map_err(|e| format!("session_append: write: {e}"))?;
            f.write_all(b"\n")
                .map_err(|e| format!("session_append: write: {e}"))?;
            f.flush()
                .map_err(|e| format!("session_append: flush: {e}"))?;
            ok_unit(Ok(()))
        }

        // P1-15: agent 会话增量追加（NDJSON）— 与 session_append 同构，但写到
        // .lantai/agents/{agent_id}/session.ndjson。rewrite=true 时 truncate 重写
        // （会话被撤回/替换后全量重建），否则 append-only（每轮对话只写增量，
        // 消除旧 saveState 全量重写 session.json 的 O(全量) 写放大）。
        "agent_session_append" => {
            let project_path = req_str(&params, "project_path", "agent_session_append")?;
            let agent_id = req_str(&params, "agent_id", "agent_session_append")?;
            crate::utils::sanitize_path_id(&agent_id, "agent_id")?;
            let messages = params.get("messages")
                .ok_or("agent_session_append: missing 'messages'")?;
            let rewrite = params.get("rewrite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let file = std::path::Path::new(&project_path)
                .join(".lantai/agents")
                .join(&agent_id)
                .join("session.ndjson");
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("agent_session_append: cannot create dir: {e}"))?;
            }
            let arr = messages.as_array()
                .ok_or("agent_session_append: 'messages' must be an array")?;
            use std::io::Write;
            let mut f = if rewrite {
                // truncate 重写（撤回/替换后全量重建）
                std::fs::File::create(&file)
                    .map_err(|e| format!("agent_session_append: create: {e}"))?
            } else {
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&file)
                    .map_err(|e| format!("agent_session_append: open: {e}"))?
            };
            for msg in arr {
                let line = serde_json::to_string(msg)
                    .map_err(|e| format!("agent_session_append: serialize: {e}"))?;
                f.write_all(line.as_bytes())
                    .map_err(|e| format!("agent_session_append: write: {e}"))?;
                f.write_all(b"\n")
                    .map_err(|e| format!("agent_session_append: write: {e}"))?;
            }
            f.flush()
                .map_err(|e| format!("agent_session_append: flush: {e}"))?;
            ok_unit(Ok(()))
        }

        // ═══════════════════════════════════════════════════════
        // 约束（2 个命令）
        // ═══════════════════════════════════════════════════════
        "read_constraints" => {
            let project_path = req_str(&params, "project_path", "read_constraints")?;
            commands::constraints::read_constraints(project_path).await
        }
        "write_constraints" => {
            let project_path = req_str(&params, "project_path", "write_constraints")?;
            let content = req_str(&params, "content", "write_constraints")?;
            ok_unit(commands::constraints::write_constraints(project_path, content).await)
        }

        // ═══════════════════════════════════════════════════════
        // 数据流（3 个命令）
        // ═══════════════════════════════════════════════════════
        "dataflow_save" => {
            let query = req_str(&params, "query", "dataflow_save")?;
            let content = opt_str(&params, "content");
            let explore_result = opt_str(&params, "explore_result");
            let dataflow_result = opt_str(&params, "dataflow_result");
            commands::dataflow::dataflow_save(query, content, explore_result, dataflow_result, state).await
        }
        "dataflow_query" => {
            let trace_id = opt_str(&params, "trace_id");
            let list = opt_bool(&params, "list");
            commands::dataflow::dataflow_query(trace_id, list, state).await
        }
        "dataflow_delete" => {
            let trace_id = req_str(&params, "trace_id", "dataflow_delete")?;
            commands::dataflow::dataflow_delete(trace_id, state).await
        }

        // ═══════════════════════════════════════════════════════
        // Aura 记忆（7 个命令）
        // ═══════════════════════════════════════════════════════
        "aura_init" => {
            let brain_path = req_str(&params, "brain_path", "aura_init")?;
            crate::aura_memory::aura_init(brain_path)
        }
        "aura_recall" => {
            let query = req_str(&params, "query", "aura_recall")?;
            let top_k = opt_i32(&params, "top_k").unwrap_or(0);
            crate::aura_memory::aura_recall(query, top_k)
        }
        "aura_recall_text" => {
            let query = req_str(&params, "query", "aura_recall_text")?;
            let token_budget = opt_i32(&params, "token_budget").unwrap_or(0);
            crate::aura_memory::aura_recall_text(query, token_budget)
        }
        "aura_store" => {
            let content = req_str(&params, "content", "aura_store")?;
            let level = params.get("level").and_then(|v| v.as_u64()).map(|n| n as u8).unwrap_or(0);
            let tags = opt_str(&params, "tags").unwrap_or_default();
            let namespace = opt_str(&params, "namespace").unwrap_or_default();
            crate::aura_memory::aura_store(content, level, tags, namespace)
        }
        "aura_count" => crate::aura_memory::aura_count().map(|n| n.to_string()),
        "aura_maintenance" => ok_unit(crate::aura_memory::aura_maintenance()),
        "aura_shutdown" => ok_unit(crate::aura_memory::aura_shutdown()),

        // ═══════════════════════════════════════════════════════
        // PTY（4 个命令）
        // ═══════════════════════════════════════════════════════
        "pty_spawn" => {
            let cwd = req_str(&params, "cwd", "pty_spawn")?;
            let shell = opt_str(&params, "shell");
            let cols = req_u16(&params, "cols", "pty_spawn")?;
            let rows = req_u16(&params, "rows", "pty_spawn")?;
            let id = crate::pty_manager::pty_spawn(app, cwd, shell, cols, rows).await?;
            Ok(id.to_string())
        }
        "pty_write" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "pty_write: missing 'session_id'".to_string())?;
            let data = req_str(&params, "data", "pty_write")?;
            ok_unit(crate::pty_manager::pty_write(session_id, data).await)
        }
        "pty_resize" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "pty_resize: missing 'session_id'".to_string())?;
            let cols = req_u16(&params, "cols", "pty_resize")?;
            let rows = req_u16(&params, "rows", "pty_resize")?;
            ok_unit(crate::pty_manager::pty_resize(session_id, cols, rows).await)
        }
        "pty_kill" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "pty_kill: missing 'session_id'".to_string())?;
            ok_unit(crate::pty_manager::pty_kill(session_id).await)
        }

        // ═══════════════════════════════════════════════════════
        // LSP（3 个命令）
        // ═══════════════════════════════════════════════════════
        "lsp_start" => {
            let language = req_str(&params, "language", "lsp_start")?;
            let root_uri = req_str(&params, "root_uri", "lsp_start")?;
            let id = crate::lsp_manager::lsp_start(app, language, root_uri).await?;
            Ok(id.to_string())
        }
        "lsp_request" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "lsp_request: missing 'session_id'".to_string())?;
            let method = req_str(&params, "method", "lsp_request")?;
            let lsp_params = params.get("params").cloned().unwrap_or(Value::Null);
            ok_json(crate::lsp_manager::lsp_request(session_id, method, lsp_params).await)
        }
        "lsp_stop" => {
            let session_id = opt_u32(&params, "session_id")
                .ok_or_else(|| "lsp_stop: missing 'session_id'".to_string())?;
            ok_unit(crate::lsp_manager::lsp_stop(session_id).await)
        }

        _ => Err(format!("rpc: unknown method '{}'", method)),
    }
}

// ═══════════════════════════════════════════════════════════
// desktop/UIA 编排 — 六层权限 + 输入租约 + 逐动作审计
// ═══════════════════════════════════════════════════════════
// 只读动作（probe/tree/find/read/wait/window_shot/audit/screenshot-Ask）走
// desktop_check；写动作先只读 resolve 拿分类信息（控件名/patterns/hwnd），
// 按 tools/mod.rs DesktopTool 的分层模型构造 Tool 再 check_permission，
// 批准接管时记录 DesktopGrant，物理路径执行前获取全局输入租约。

/// 只读/直查动作的权限守卫（DesktopTool::is_read_only → Passthrough；
/// screenshot 例外走 Ask）。
async fn desktop_check(
    state: &tauri::State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
    agent_id: &Option<String>,
    action: &str,
) -> Result<(), String> {
    let ctx = crate::utils::get_ctx(state)?;
    let tool = crate::tools::DesktopTool {
        action: action.into(),
        agent_id: agent_id.clone(),
        hwnd: None,
        window_title: None,
    };
    crate::utils::check_permission(&tool, &ctx, app).await
}

/// UIA 写动作统一编排（click/right_click/type/scroll/select/expand）。
async fn desktop_uia_write(
    state: &tauri::State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
    params: &serde_json::Value,
    kind: &str,
) -> Result<String, String> {
    let agent_id = opt_str(params, "_agent_id");
    let title = opt_str(params, "title");
    let pid = opt_u32(params, "pid");
    let hwnd = opt_u64(params, "hwnd");
    let ref_id = opt_u32(params, "ref");
    let name = opt_str(params, "name");
    let aid = opt_str(params, "automation_id");
    let ctype = opt_str(params, "control_type");

    if ref_id.is_none() && name.is_none() && aid.is_none() && ctype.is_none() {
        return Err(format!(
            "desktop_uia_{kind}: 至少要给一个定位条件 (ref / name / automation_id / control_type)"
        ));
    }

    // 只读解析（分类前置步骤，等同 tree 读取的权限面）
    let res = crate::uia::resolve(
        title.as_deref(), pid, hwnd, ref_id, name.as_deref(), aid.as_deref(), ctype.as_deref(),
    )
    .await?;
    let res_name = res["name"].as_str().unwrap_or("").to_string();
    let res_type = res["type"].as_str().unwrap_or("").to_string();
    let res_aid = res["automation_id"].as_str().unwrap_or("").to_string();
    let res_hwnd = res["hwnd"].as_u64();
    let res_title = res["title"].as_str().unwrap_or("").to_string();
    let password = res["password"].as_bool().unwrap_or(false);
    let cur_value = res["value"].as_str().unwrap_or("");
    let g = |k: &str| res[k].as_bool().unwrap_or(false);
    let target_desc = format!(
        "[{res_type}] \"{res_name}\"{} @ {}",
        if res_aid.is_empty() { String::new() } else { format!(" id={res_aid}") },
        res_hwnd.map(|h| format!("hwnd={h}")).unwrap_or_else(|| "window".into())
    );

    let caps = crate::tools::UiaTargetCaps {
        has_invoke: g("has_invoke"),
        has_toggle: g("has_toggle"),
        has_select: g("has_select"),
        has_value: g("has_value"),
        has_scroll: g("has_scroll"),
    };
    let granted = crate::uia::has_grant(agent_id.as_deref(), res_hwnd);
    let tool_action = crate::tools::classify_uia_action(
        kind, &res_name, password, cur_value, &caps, granted,
    );

    // 权限（Ask 由 check_permission 内部走异步确认）
    {
        let ctx = crate::utils::get_ctx(state)?;
        let tool = crate::tools::DesktopTool {
            action: tool_action.into(),
            agent_id: agent_id.clone(),
            hwnd: res_hwnd,
            window_title: Some(res_title.clone()),
        };
        if let Err(e) = crate::utils::check_permission(&tool, &ctx, app).await {
            crate::uia::desktop_audit_log(
                agent_id.as_deref(),
                &format!("desktop_uia_{kind}_denied"),
                &target_desc,
                &e,
            );
            return Err(e);
        }
    }
    // 批准接管 → 记录 grant（该窗口后续 pattern 动作放行）
    if tool_action == "uia_grant" {
        if let Some(h) = res_hwnd {
            crate::uia::grant(agent_id.as_deref(), h);
        }
    }
    let allow_physical = matches!(tool_action, "uia_physical" | "uia_click_sensitive" | "uia_type_sensitive");

    // 执行（物理兜底路径需先拿全局输入租约）
    let text = if kind == "type" { Some(req_str(params, "text", "desktop_uia_type")?) } else { None };
    let direction = if kind == "scroll" { Some(req_str(params, "direction", "desktop_uia_scroll")?) } else { None };
    let amount = opt_f64(params, "amount");
    let exec = async {
        match kind {
            "click" => {
                crate::uia::uia_click(title.as_deref(), pid, hwnd, ref_id, name.as_deref(), aid.as_deref(), ctype.as_deref(), false, allow_physical).await
            }
            "right_click" => {
                crate::uia::uia_click(title.as_deref(), pid, hwnd, ref_id, name.as_deref(), aid.as_deref(), ctype.as_deref(), true, allow_physical).await
            }
            "type" => {
                crate::uia::uia_type(title.as_deref(), pid, hwnd, ref_id, text.as_deref().unwrap_or(""), name.as_deref(), aid.as_deref(), ctype.as_deref(), allow_physical).await
            }
            "scroll" => {
                crate::uia::uia_scroll(title.as_deref(), pid, hwnd, ref_id, direction.as_deref().unwrap_or("down"), amount.unwrap_or(1.0), name.as_deref(), aid.as_deref(), ctype.as_deref(), allow_physical).await
            }
            "select" => {
                crate::uia::uia_select(title.as_deref(), pid, hwnd, ref_id, name.as_deref(), aid.as_deref(), ctype.as_deref()).await
            }
            _ => {
                crate::uia::uia_expand(title.as_deref(), pid, hwnd, ref_id, name.as_deref(), aid.as_deref(), ctype.as_deref()).await
            }
        }
    };
    let outcome = if crate::tools::uia_action_needs_physical(kind, &caps) && allow_physical {
        match crate::uia::acquire_input_lease(agent_id.as_deref(), std::time::Duration::from_secs(3)).await {
            Ok(_lease) => exec.await,
            Err(e) => Err(e),
        }
    } else {
        exec.await
    };

    // 逐动作审计（成败都记）
    match &outcome {
        Ok(s) => crate::uia::desktop_audit_log(agent_id.as_deref(), &format!("desktop_uia_{kind}"), &target_desc, s),
        Err(e) => crate::uia::desktop_audit_log(agent_id.as_deref(), &format!("desktop_uia_{kind}_failed"), &target_desc, e),
    }
    outcome
}

/// desktop_uia_keys — 热键（物理输入：Ask + 输入租约）。
async fn desktop_uia_keys(
    state: &tauri::State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
    params: &serde_json::Value,
) -> Result<String, String> {
    let agent_id = opt_str(params, "_agent_id");
    let title = opt_str(params, "title");
    let key = req_str(params, "key", "desktop_uia_keys")?;
    let modifiers: Vec<String> = params
        .get("modifiers")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    {
        let ctx = crate::utils::get_ctx(state)?;
        let tool = crate::tools::DesktopTool {
            action: "uia_keys".into(),
            agent_id: agent_id.clone(),
            hwnd: opt_u64(params, "hwnd"),
            window_title: title.clone(),
        };
        if let Err(e) = crate::utils::check_permission(&tool, &ctx, app).await {
            crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_keys_denied", &format!("key={key}"), &e);
            return Err(e);
        }
    }
    let lease = crate::uia::acquire_input_lease(agent_id.as_deref(), std::time::Duration::from_secs(3)).await;
    let outcome = match lease {
        Ok(_l) => {
            crate::uia::uia_keys(title.as_deref(), opt_u32(params, "pid"), opt_u64(params, "hwnd"), modifiers.clone(), &key).await
        }
        Err(e) => Err(e),
    };
    match &outcome {
        Ok(s) => crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_keys", &format!("mods={modifiers:?} key={key}"), s),
        Err(e) => crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_keys_failed", &format!("mods={modifiers:?} key={key}"), e),
    }
    outcome
}

/// desktop_uia_activate — 窗口提前台（物理输入：Ask + 输入租约）。
async fn desktop_uia_activate(
    state: &tauri::State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
    params: &serde_json::Value,
) -> Result<String, String> {
    let agent_id = opt_str(params, "_agent_id");
    let title = opt_str(params, "title");
    let hwnd = opt_u64(params, "hwnd");
    {
        let ctx = crate::utils::get_ctx(state)?;
        let tool = crate::tools::DesktopTool {
            action: "uia_activate".into(),
            agent_id: agent_id.clone(),
            hwnd,
            window_title: title.clone(),
        };
        if let Err(e) = crate::utils::check_permission(&tool, &ctx, app).await {
            crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_activate_denied", &format!("hwnd={hwnd:?}"), &e);
            return Err(e);
        }
    }
    let lease = crate::uia::acquire_input_lease(agent_id.as_deref(), std::time::Duration::from_secs(3)).await;
    let outcome = match lease {
        Ok(_l) => crate::uia::uia_activate(title.as_deref(), opt_u32(params, "pid"), hwnd).await,
        Err(e) => Err(e),
    };
    match &outcome {
        Ok(s) => crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_activate", &format!("hwnd={hwnd:?}"), s),
        Err(e) => crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_activate_failed", &format!("hwnd={hwnd:?}"), e),
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::self_or_agent;
    use super::{dispatch_result_to_value, guard_panic, panic_to_rpc_error, rpc_result_shape, str_to_value, RpcResultShape};
    use serde_json::json;

    /// 回归（edit 偶发挂死家族）：命令体 panic 必须变成 Err 回包，
    /// 而不是让 panic 逃逸——逃逸时 Tauri resolver 被丢弃，前端
    /// invoke promise 永久挂起且无日志。
    #[tokio::test]
    async fn guard_panic_converts_panic_to_err_response() {
        let out = guard_panic(async {
            // 模拟命令体里的字节切片 panic（与 editor.rs 旧 bug 同型）：
            // 4 字节 ASCII 前缀 + CJK，字节 60 落在字符中间。
            // 注意纯 "中".repeat(30) 的字节 60 恰好对齐边界，不会 panic。
            let s = format!("// ab{}", "中".repeat(30));
            let _ = &s[..60];
            Ok::<String, String>("unreachable".to_string())
        })
        .await;
        let err = out.expect_err("panic 必须转为 Err 回包");
        assert!(err.contains("panic"), "错误应说明是命令内部 panic: {err}");
    }

    #[tokio::test]
    async fn guard_panic_passes_through_ok_and_err() {
        assert_eq!(guard_panic(async { Ok("ok".to_string()) }).await.unwrap(), "ok");
        assert_eq!(
            guard_panic(async { Err("业务错误".to_string()) }).await.unwrap_err(),
            "业务错误"
        );
    }

    #[test]
    fn panic_to_rpc_error_extracts_string_payload() {
        let msg = panic_to_rpc_error(Box::new("byte index 60 is not a char boundary".to_string()));
        assert!(msg.contains("命令内部错误"));
        assert!(msg.contains("char boundary"));
    }

    /// rpc 返回值 Value 化回归（landmine 根治级，2026-08-22）：
    /// 出口包装契约——纯包 Value::String，零 parse。字节精确是铁律：
    /// read_file_content 读 JSON 文件时前端必须拿到原文，不能被出口
    /// 误展开成结构化值；JSON 展开分派在前端 typedRpc 按契约进行。
    #[test]
    fn str_to_value_wraps_verbatim_never_parses() {
        // JSON 对象形状的文本也必须原样保留（字节精确）
        assert_eq!(
            str_to_value(r#"{"ok":true,"n":3}"#.to_string()),
            serde_json::Value::String(r#"{"ok":true,"n":3}"#.to_string())
        );
        // ok_unit 的 "null" 同样原样（前端 typedRpc 负责解）
        assert_eq!(str_to_value("null".to_string()), serde_json::Value::String("null".to_string()));
        // 空串、多行文本、带 BOM/控制字符的文本一律字节精确
        assert_eq!(str_to_value(String::new()), serde_json::Value::String(String::new()));
        let cjk = "中文内容\n第二行";
        assert_eq!(str_to_value(cjk.to_string()), serde_json::Value::String(cjk.to_string()));
    }

    /// Value 化第二步（B 路线，2026-08-22）：出口分派——JsonValue 命令 Ok
    /// 路径 parse 成真结构化 Value；Text 命令字节精确包 Value::String；
    /// Err 路径拒绝展开、原样传播（前端 catch 语义不变）。
    /// 贴错标签的两个方向都在这里钉死：Text 命令误标 JsonValue 会把字节
    /// 精确的文本当成 JSON 展开（错误）；JsonValue 命令误标 Text 只会
    /// 退化为慢路径（正确性不受影响）——分类偏保守的依据。
    #[test]
    fn dispatch_result_to_value_shapes() {
        use serde_json::json;
        // 形态表钉死：小样命令 = JsonValue，未列命令默认 Text
        assert_eq!(rpc_result_shape("shell_env"), RpcResultShape::JsonValue);
        assert_eq!(rpc_result_shape("get_graph_meta"), RpcResultShape::JsonValue);
        assert_eq!(rpc_result_shape("read_file_content"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("anything_else"), RpcResultShape::Text);
        // JsonValue 命令：真结构化展开（小样 shell_env / get_graph_meta）
        let v = dispatch_result_to_value("shell_env", Ok(r#"{"bundled":true}"#.into())).unwrap();
        assert_eq!(v, json!({"bundled": true}));
        let v = dispatch_result_to_value("get_graph_meta", Ok(r#"{"total_nodes":42}"#.into())).unwrap();
        assert_eq!(v, json!({"total_nodes": 42}));
        // JsonValue 命令返回非合法 JSON：违反契约转 Err（错误可见，不静默）
        let bad = dispatch_result_to_value("shell_env", Ok("not json".into()));
        assert!(bad.is_err(), "JsonValue 命令 Ok 输出非合法 JSON 必须转 Err");
        // Text 命令（含默认路径）：字节精确，JSON 形状的文本也不展开
        let raw = r#"{"looks":"like json"}"#;
        let v = dispatch_result_to_value("read_file_content", Ok(raw.into())).unwrap();
        assert_eq!(v, serde_json::Value::String(raw.to_string()));
        let v = dispatch_result_to_value("unlisted_unknown_cmd", Ok(raw.into())).unwrap();
        assert_eq!(v, serde_json::Value::String(raw.to_string()));
        // Err 路径：原样传播，不包 Ok（前端 catch 语义不变）
        let e = dispatch_result_to_value("shell_env", Err("boom".into()));
        assert_eq!(e, Err("boom".to_string()));
        let e = dispatch_result_to_value("read_file_content", Err("boom".into()));
        assert_eq!(e, Err("boom".to_string()));
    }

    /// self 路由契约锁定：前端领域工具传 target="self" 字符串，
    /// 旧实现只认 self 布尔参数曾导致 self 通道全程静默失效。
    #[test]
    fn self_routing_accepts_target_string() {
        // 前端实际传参形态（browser.ts runBrowserAction 直通 args）
        let p = json!({ "target": "self", "scope": "body" });
        assert_eq!(
            self_or_agent(&p).as_deref(),
            Some(crate::cdp::SELF_AGENT_ID),
            "target=\"self\" 必须路由到 self 会话"
        );
        // 布尔 self 兼容旧调用方
        let p2 = json!({ "self": true });
        assert_eq!(self_or_agent(&p2).as_deref(), Some(crate::cdp::SELF_AGENT_ID));
        // 普通参数不受 target 影响
        let p3 = json!({ "target": "9223" });
        assert_eq!(self_or_agent(&p3), None);
        // _agent_id 直通
        let p4 = json!({ "_agent_id": "agent-7" });
        assert_eq!(self_or_agent(&p4).as_deref(), Some("agent-7"));
    }
}
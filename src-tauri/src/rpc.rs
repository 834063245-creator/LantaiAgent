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

use tauri::Manager;

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
fn req_bool(params: &Value, name: &str, method: &str) -> Result<bool, String> {
    params
        .get(name)
        .and_then(|v| v.as_bool())
        .ok_or_else(|| format!("{method}: missing '{name}'"))
}
fn opt_u32(params: &Value, name: &str) -> Option<u32> {
    params.get(name).and_then(|v| v.as_u64()).map(|n| n as u32)
}
/// browser 命令的 agent 路由：target="self" 走自家 webview 只读会话，

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
        // context_list：Vec<ContextInfo> serde，恒 JSON。
        // （workspace-session-ownership-rework 2026-08-27：session_attach/
        //  detach/focus 三命令退役，shape 表同步清。）
        "context_list" => RpcResultShape::JsonValue,

        // ── Engine 调度 ──
        // hologram_call 是元命令（37 个底层工具），输出形态由工具决定，无法在
        // 出口层保证恒定——保持 Text，由前端 holoExec 双形态守卫兜。
        // hologram_tools_list：Ok 恒为 schema 数组 JSON（serde 序列化，空时为 "[]"）。
        "hologram_tools_list" => RpcResultShape::JsonValue,

        // ── Graph ──
        // Phase 1.5：load_graph_json/get_graph_snapshot 返回聚合快照 JSON
        // （快照按需算，恒定轻量，跨边界不再传全量图体）。
        // analyze_and_load：轻状态。hologram_file_nodes：按文件符号索引。
        // engine_impact：with_index 产物恒定。
        "load_graph_json" | "get_graph_snapshot" | "hologram_file_nodes"
        | "analyze_and_load" => RpcResultShape::JsonValue,

        // ── Git ──
        // status（json! 构造）/log（commits 数组）恒 JSON；
        // diff/stage/commit/push/pull/init/checkout/branch/stash/discard/blame
        // 是 git 子进程 stdout 文本（run_git 直通），保持 Text。

        // ── 文件系统 ──
        // （list_directory/list_directory_flat/read_file_content 等已迁 builtin.fs
        //  插件走 tool_call——kernel-plugin-runtime P2-2，无需本表条目。）
        // workspace_list：ok_json(注册表+各工作区会话计数) 恒 JSON。
        // workspace_create_dir：ok_json(归一化路径字符串) 恒 JSON 字符串。
        // （workspace-session-ownership-rework 2026-08-27：user_sessions_list 退役——
        //  首页工作区清单由 workspace_list 承担，计数扫各工作区会话根。）
        "workspace_list" | "workspace_create_dir" => {
            RpcResultShape::JsonValue
        }

        // ── 搜索 ──
        // （search_content 已迁 builtin.search / glob 已迁 builtin.fs，均走
        //  tool_call——其 JSON 形态由前端 agentInvoke 字符串世界兜底，无需本表条目。）

        // ── Shell ──
        // shell_env：serde 序列化恒 JSON（兑底也是合法 JSON 字面量）。
        // exec_command：前台=命令 stdout 文本 / 流式=started JSON，动态形态，Text。
        // bash_output/bash_kill/bash_wait：输出文本，Text。
        // drain_bg_notifications：无通知返回空串（非 JSON），Text。
        // background_activity：json! 构造恒 JSON。

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

        // ── LSP ──
        // lsp_request：ok_json(serde 序列化)，恒 JSON。
        "lsp_request" => RpcResultShape::JsonValue,

        // ── 其余（含 ok_unit "null" 家族、read_file_content、
        // exec_command、浏览器命令、PTY、会话持久化、workspace、
        // protocol_bridge、llm_proxy_port 等）──
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

/// P1-15: agent 会话增量追加（NDJSON）— 与 session_append 同构，但写到
/// .lantai/agents/{agent_id}/session.ndjson。rewrite=true 时 truncate 重写
/// （会话被撤回/替换后全量重建），否则 append-only（每轮对话只写增量，
/// 消除旧 saveState 全量重写 session.json 的 O(全量) 写放大）。
///
/// 从 dispatch_rpc 的 match 分支原样提取（行为逐字节不变，2026-09-02 平台
/// 补课 Phase 2）——dispatch_rpc 依赖 tauri::State/AppHandle，单元测试无法
/// 构造；本函数零状态、纯 fs，是会话 NDJSON 落盘的唯一实现，持久化行为
/// 序列（round-trip / 空会话 / 损坏容忍 / 并发 / 覆盖）以此为钉测锚点。
fn agent_session_append(
    project_path: &str,
    agent_id: &str,
    messages: &Value,
    rewrite: bool,
) -> Result<(), String> {
    crate::utils::sanitize_path_id(agent_id, "agent_id")?;
    let file = std::path::Path::new(project_path)
        .join(".lantai/agents")
        .join(agent_id)
        .join("session.ndjson");
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("agent_session_append: cannot create dir: {e}"))?;
    }
    let arr = messages
        .as_array()
        .ok_or("agent_session_append: 'messages' must be an array")?;
    use std::io::Write;
    let mut f = if rewrite {
        // truncate 重写（撤回/替换后全量重建）
        std::fs::File::create(&file).map_err(|e| format!("agent_session_append: create: {e}"))?
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
    Ok(())
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
        // 应用层：数据上下文（L1）
        // （workspace-session-ownership-rework 2026-08-27：session_attach/
        //  detach/focus 三命令退役——会话只在所属工作区内打开，引擎决议
        //  只看活动工作区，无需会话绑定/焦点投影。）
        // ═══════════════════════════════════════════════════════
        "context_list" => crate::app::commands::context_list(app_ctx),

        // ═══════════════════════════════════════════════════════
        // Engine 调度（tools.rs 重新导出）
        // ═══════════════════════════════════════════════════════
        "hologram_call" => {
            let tool = req_str(&params, "tool", "hologram_call")?;
            let args = params.get("args").cloned().unwrap_or(Value::Null);
            // 工作区身份透传（显式 workspace；缺省 = 活动工作区单槽决议）。
            let workspace = opt_str(&params, "workspace");
            commands::engine_dispatch::hologram_call(tool, args, workspace, state, app_ctx).await
        }
        "hologram_tools_list" => commands::engine_dispatch::hologram_tools_list(state, app_ctx).await,

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
        "get_graph_snapshot" => commands::graph::get_graph_snapshot(state, app_ctx).await,
        "hologram_file_nodes" => {
            let file = req_str(&params, "file", "hologram_file_nodes")?;
            commands::graph::hologram_file_nodes(file, state, app_ctx).await
        }


        // ═══════════════════════════════════════════════════════
        // 搜索（3 个命令）
        // ═══════════════════════════════════════════════════════
        "tool_call" => {
            // 内核插件运行时统一入口（kernel-plugin-runtime）。
            // args 说 manifest schema 的语言（camelCase）；_agent_id meta 嵌在 args 内。
            let plugin = req_str(&params, "plugin", "tool_call")?;
            let tool = req_str(&params, "tool", "tool_call")?;
            let args = params.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
            let is_agent = opt_bool(&params, "is_agent").unwrap_or(false);
            let registry = app.state::<std::sync::Arc<crate::tool_plugins::PluginRegistry>>();
            crate::tool_plugins::dispatch_tool_call(&registry, &plugin, &tool, args, is_agent, &state, &app).await
        }
        "plugin_tool_manifests" => {
            let registry = app.state::<std::sync::Arc<crate::tool_plugins::PluginRegistry>>();
            Ok(crate::tool_plugins::registry_manifests(&registry).to_string())
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
        // 生效时机（D6，2026-08-27）：Rust 侧只管盘面与进程；前端在 RPC 落盘
        // 成功后即时装卸插件 fiber——装/卸/启/禁运行时生效（工具面下次装配）。
        // ═══════════════════════════════════════════════════════
        "plugin_install" => {
            let source = commands::plugin_install::PluginSource::from_params(&params)?;
            let expect_name = opt_str(&params, "expect_name");
            // force = true 跳过版本守卫（降级/同版本覆盖安装——显式逃生门，P3）
            let force = opt_bool(&params, "force").unwrap_or(false);
            // 本地目录源走复制路径；registry/tarball 走下载+解包路径
            let name = match source {
                commands::plugin_install::PluginSource::LocalDir(dir) => {
                    commands::plugin_install::plugin_install_local_dir(dir, expect_name, force).await?
                }
                other => commands::plugin_install::plugin_install(other, expect_name, force).await?,
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
        // 外部服务（sandbox_status；MCP server 生命周期面已随 legacy
        // McpManager 退役——引擎子进程统一走 engine_transport）
        // ═══════════════════════════════════════════════════════
        "sandbox_status" => commands::external::sandbox_status(),

        // ═══════════════════════════════════════════════════════
        // Hologram（尚未迁入 engine ToolRegistry 的遗留命令）
        // ═══════════════════════════════════════════════════════
        "hologram_run_check" => {
            let path = opt_str(&params, "path");
            commands::hologram::hologram_run_check(path, state, app_ctx).await
        }
        "hologram_record_event" => {
            let event_type = req_str(&params, "event_type", "hologram_record_event")?;
            let file = opt_str(&params, "file");
            let summary = req_str(&params, "summary", "hologram_record_event")?;
            // E3: 统一返回包装 — 将 "ok" 映射为 "null" 以保持
            // 与其他返回单元的命令一致（ok_unit 模式）。
            // 前端以 fire-and-forget 方式调用，不检查返回值。
            commands::hologram::hologram_record_event(event_type, file, summary, state, app_ctx)
                .await
                .map(|_| "null".into())
        }

        // ═══════════════════════════════════════════════════════
        // 工作区（10 个命令）
        // ═══════════════════════════════════════════════════════
        "workspace_activate" => {
            let path = req_str(&params, "path", "workspace_activate")?;
            // per-workspace 图谱引擎旗标（2026-08-31）：缺省 = None（保持注册表现值）
            let graph_engine = params.get("graph_engine").and_then(|v| v.as_bool());
            ok_unit(commands::workspace::workspace_activate(path, graph_engine, state, app_ctx).await)
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
        // ── 已知工作区注册表（Stage-5 补尾：首页工作区管理）──
        "workspace_list" => {
            let r = tokio::task::spawn_blocking(commands::workspace::registry::list)
                .await
                .map_err(|e| format!("workspace_list 任务失败: {e}"))?
                .map_err(|e| format!("workspace_list: {e}"))?;
            ok_json(Ok(r))
        }
        "workspace_rename" => {
            let path = req_str(&params, "path", "workspace_rename")?;
            let name = req_str(&params, "name", "workspace_rename")?;
            let res = tokio::task::spawn_blocking(move || commands::workspace::registry::rename(&path, name))
                .await
                .map_err(|e| format!("workspace_rename 任务失败: {e}"))?;
            ok_unit(res)
        }
        "workspace_toggle_pin" => {
            let path = req_str(&params, "path", "workspace_toggle_pin")?;
            let pinned = req_bool(&params, "pinned", "workspace_toggle_pin")?;
            let res = tokio::task::spawn_blocking(move || commands::workspace::registry::toggle_pin(&path, pinned))
                .await
                .map_err(|e| format!("workspace_toggle_pin 任务失败: {e}"))?;
            ok_unit(res)
        }
        "workspace_remove" => {
            let path = req_str(&params, "path", "workspace_remove")?;
            let res = tokio::task::spawn_blocking(move || commands::workspace::registry::remove(&path))
                .await
                .map_err(|e| format!("workspace_remove 任务失败: {e}"))?;
            ok_unit(res)
        }
        // per-workspace 图谱引擎开关（2026-08-31）：首页卡片徽标切换入口；
        // 未知路径自动补登记。生效语义 = 装配期一次（在途不活拆）。
        "workspace_set_graph_engine" => {
            let path = req_str(&params, "path", "workspace_set_graph_engine")?;
            let enabled = req_bool(&params, "enabled", "workspace_set_graph_engine")?;
            let res =
                tokio::task::spawn_blocking(move || commands::workspace::registry::set_graph_engine(&path, enabled))
                    .await
                    .map_err(|e| format!("workspace_set_graph_engine 任务失败: {e}"))?;
            ok_unit(res)
        }
        // 新建工作区目录（2026-08-31 首页 sheet「创建」路径）：
        // ~/Documents/兰台/<名字>，返回归一化路径字符串。
        "workspace_create_dir" => {
            let name = req_str(&params, "name", "workspace_create_dir")?;
            let res = tokio::task::spawn_blocking(move || commands::workspace::create_default_workspace_dir(&name))
                .await
                .map_err(|e| format!("workspace_create_dir 任务失败: {e}"))?;
            ok_json(res)
        }

        // ═══════════════════════════════════════════════════════
        // 会话持久化（1 个命令）
        // （workspace-session-ownership-rework 2026-08-27：chat 会话 NDJSON
        //  session_append 已拆——只写不读孤儿路径；唯一保留路径 = 工作区会话根
        //  全量快照，由前端 write_file_content 写 {ws}/.lantai/sessions/{id}.json。）
        // ═══════════════════════════════════════════════════════

        // P1-15: agent 会话增量追加（NDJSON）— 与 session_append 同构，但写到
        // .lantai/agents/{agent_id}/session.ndjson。rewrite=true 时 truncate 重写
        // （会话被撤回/替换后全量重建），否则 append-only（每轮对话只写增量，
        // 消除旧 saveState 全量重写 session.json 的 O(全量) 写放大）。
        "agent_session_append" => {
            let project_path = req_str(&params, "project_path", "agent_session_append")?;
            let agent_id = req_str(&params, "agent_id", "agent_session_append")?;
            let messages = params
                .get("messages")
                .ok_or("agent_session_append: missing 'messages'")?;
            let rewrite = params
                .get("rewrite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            ok_unit(agent_session_append(&project_path, &agent_id, messages, rewrite))
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
#[cfg(test)]
mod tests {
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
        // （shell_env / exec_command 已随 builtin.shell 迁 tool_call 退表——
        //  workspace_list 接任 JsonValue 小样，kernel-plugin-runtime P2-4）
        assert_eq!(rpc_result_shape("workspace_list"), RpcResultShape::JsonValue);
        // Phase 1.5：load_graph_json/get_graph_snapshot = 聚合快照（JsonValue 恒定）；
        // 分页双命令（get_graph_meta/get_graph_page）与 get_full_graph 已拆除。
        assert_eq!(rpc_result_shape("load_graph_json"), RpcResultShape::JsonValue);
        assert_eq!(rpc_result_shape("get_graph_snapshot"), RpcResultShape::JsonValue);
        assert_eq!(rpc_result_shape("hologram_file_nodes"), RpcResultShape::JsonValue);
        assert_eq!(rpc_result_shape("get_graph_meta"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("get_graph_page"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("exec_command"), RpcResultShape::Text);
        assert_eq!(rpc_result_shape("anything_else"), RpcResultShape::Text);
        // JsonValue 命令：真结构化展开（小样 workspace_list / get_graph_snapshot）
        let v = dispatch_result_to_value("workspace_list", Ok(r#"{"bundled":true}"#.into())).unwrap();
        assert_eq!(v, json!({"bundled": true}));
        let v = dispatch_result_to_value("get_graph_snapshot", Ok(r#"{"total_nodes":42}"#.into())).unwrap();
        assert_eq!(v, json!({"total_nodes": 42}));
        let bad = dispatch_result_to_value("workspace_list", Ok("not json".into()));
        assert!(bad.is_err(), "JsonValue 命令 Ok 输出非合法 JSON 必须转 Err");
        // Text 命令（含默认路径）：字节精确，JSON 形状的文本也不展开
        // （exec_command 已退表——按未列命令默认 Text 走，仍可当 Text 小样）
        let raw = r#"{"looks":"like json"}"#;
        let v = dispatch_result_to_value("exec_command", Ok(raw.into())).unwrap();
        assert_eq!(v, serde_json::Value::String(raw.to_string()));
        let v = dispatch_result_to_value("unlisted_unknown_cmd", Ok(raw.into())).unwrap();
        assert_eq!(v, serde_json::Value::String(raw.to_string()));
        // Err 路径：原样传播，不包 Ok（前端 catch 语义不变）
        let e = dispatch_result_to_value("workspace_list", Err("boom".into()));
        assert_eq!(e, Err("boom".to_string()));
        let e = dispatch_result_to_value("exec_command", Err("boom".into()));
        assert_eq!(e, Err("boom".to_string()));
        let e = dispatch_result_to_value("read_file_content", Err("boom".into()));
        assert_eq!(e, Err("boom".to_string()));
    }

    // ═══════════════════════════════════════════════════════════════
    // 会话持久化行为序列钉测（2026-09-02 平台补课 Phase 2）——
    // agent_session_append 是 .lantai/agents/{agent_id}/session.ndjson
    // 的唯一落盘实现；以下断言当前真实行为，不美化。
    // ═══════════════════════════════════════════════════════════════

    use super::agent_session_append;

    /// 每测独立的临时项目根（isolation.rs spill 测试同款模式）。
    fn session_test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hologram_rpc_session_test_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn session_file(project: &std::path::Path, agent_id: &str) -> std::path::PathBuf {
        project
            .join(".lantai/agents")
            .join(agent_id)
            .join("session.ndjson")
    }

    /// ① 保存 → 重新加载 → 内容一致（round-trip）。
    /// NDJSON 契约：每条消息一行合法 JSON、行尾换行；重载按行 parse。
    #[test]
    fn agent_session_round_trip_preserves_messages() {
        let project = session_test_dir("roundtrip");
        let messages = json!([
            { "role": "user", "content": "你好，兰台" },
            { "role": "assistant", "content": "收到", "tool_calls": [] }
        ]);
        agent_session_append(project.to_str().unwrap(), "agent-rt", &messages, false).unwrap();

        let content = std::fs::read_to_string(session_file(&project, "agent-rt")).unwrap();
        assert!(content.ends_with('\n'), "NDJSON 每行以换行结尾");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2, "两条消息两行");
        for (i, line) in lines.iter().enumerate() {
            let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(parsed, messages[i], "重载内容与保存内容逐字节等价");
        }
        let _ = std::fs::remove_dir_all(&project);
    }

    /// ② 空会话（空消息数组）与仅元数据会话可正常保存/加载。
    #[test]
    fn agent_session_empty_and_metadata_only_round_trip() {
        let project = session_test_dir("emptymeta");

        // 空消息数组：文件被创建（OpenOptions create）但零行——不报错
        agent_session_append(project.to_str().unwrap(), "agent-empty", &json!([]), false).unwrap();
        let empty_file = session_file(&project, "agent-empty");
        assert!(empty_file.exists(), "空会话也要落盘建文件");
        assert_eq!(
            std::fs::read_to_string(&empty_file).unwrap(),
            "",
            "空会话 = 零字节文件"
        );

        // 仅元数据（单条 system 消息）的会话 round-trip
        let meta = json!([{ "role": "system", "content": "meta only" }]);
        agent_session_append(project.to_str().unwrap(), "agent-meta", &meta, false).unwrap();
        let content = std::fs::read_to_string(session_file(&project, "agent-meta")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(content.trim()).unwrap();
        assert_eq!(parsed, meta[0]);
        let _ = std::fs::remove_dir_all(&project);
    }

    /// ③ 损坏 JSON 文件 → 现状恢复路径（不美化）：
    /// 追加路径不解析、不清洗既有内容——
    ///   场景 A（损坏带尾换行）：垃圾字节原样保留，新合法行续尾；
    ///   场景 B（损坏不带尾换行）：新记录与垃圾尾熔接成非法行（现状不补换行）；
    ///   真恢复 = rewrite=true 截断重写（前端全量重建）。
    #[test]
    fn agent_session_corrupted_file_tolerated_on_append_rebuilt_on_rewrite() {
        let project = session_test_dir("corrupt");

        // 场景 A：损坏带尾换行
        let file = session_file(&project, "agent-c");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "not json at all\n").unwrap();
        agent_session_append(
            project.to_str().unwrap(),
            "agent-c",
            &json!([{ "role": "user", "content": "after corruption" }]),
            false,
        )
        .unwrap();
        let content = std::fs::read_to_string(&file).unwrap();
        assert!(
            content.starts_with("not json at all\n"),
            "损坏字节必须原样保留（现状不清洗）"
        );
        let last_line = content.lines().last().unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(last_line).is_ok(),
            "新增行仍是合法 JSON：{last_line}"
        );

        // 场景 B：损坏不带尾换行 → 熔接
        let fused = session_file(&project, "agent-f");
        std::fs::create_dir_all(fused.parent().unwrap()).unwrap();
        std::fs::write(&fused, "{\"broken\": ").unwrap();
        agent_session_append(
            project.to_str().unwrap(),
            "agent-f",
            &json!([{ "role": "user", "content": "fused" }]),
            false,
        )
        .unwrap();
        let fused_content = std::fs::read_to_string(&fused).unwrap();
        let fused_line = fused_content.lines().last().unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(fused_line).is_err(),
            "现状：无尾换行的损坏文件会把新记录熔接成非法行（不补换行）：{fused_line}"
        );

        // 恢复路径 = rewrite=true 截断重写：损坏历史被清除
        agent_session_append(
            project.to_str().unwrap(),
            "agent-c",
            &json!([{ "role": "user", "content": "rebuilt" }]),
            true,
        )
        .unwrap();
        let rebuilt = std::fs::read_to_string(&file).unwrap();
        assert_eq!(rebuilt.lines().count(), 1, "rewrite 后只剩新内容");
        assert!(rebuilt.contains("rebuilt"));
        assert!(!rebuilt.contains("not json"), "损坏历史被截断清除");
        let _ = std::fs::remove_dir_all(&project);
    }

    /// ④ 并发写入 → 现状完整性（无进程内锁）：
    /// 并发安全完全依赖 OS 追加句柄语义——Windows FILE_APPEND_DATA 下每次
    /// WriteFile 原子续尾（本测试每行为一次 write_all，小缓冲单次系统调用
    /// 即完成），因此字节零丢失、标记零丢失、换行数守恒；行级原子性（一条
    /// 消息的 line 与 \n 两次 write_all 之间可能被他线程插入）不保证——故
    /// 不断言行结构，只断言字节面完整性。
    #[test]
    fn agent_session_concurrent_appends_preserve_all_bytes() {
        let project = session_test_dir("concurrent");
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let project = project.clone();
                std::thread::spawn(move || {
                    for j in 0..10 {
                        let msg = json!({ "thread": t, "seq": j, "marker": format!("M{t:02}x{j:02}") });
                        agent_session_append(
                            project.to_str().unwrap(),
                            "agent-cc",
                            &json!([msg]),
                            false,
                        )
                        .unwrap();
                    }
                })
            })
            .collect();
        for h in threads {
            h.join().unwrap();
        }

        let content = std::fs::read_to_string(session_file(&project, "agent-cc")).unwrap();
        for t in 0..8 {
            for j in 0..10 {
                let marker = format!("\"M{t:02}x{j:02}\"");
                assert!(content.contains(&marker), "标记 {marker} 字节丢失");
            }
        }
        assert_eq!(
            content.matches('\n').count(),
            80,
            "80 次追加 = 80 个换行（零丢字节）"
        );
        let _ = std::fs::remove_dir_all(&project);
    }

    /// ⑤ 同会话重复保存：append 累积、rewrite=true 覆盖（truncate）。
    #[test]
    fn agent_session_repeat_save_append_accumulates_rewrite_overwrites() {
        let project = session_test_dir("overwrite");

        // 追加语义：历史行累积不丢
        agent_session_append(project.to_str().unwrap(), "agent-o", &json!([{ "role": "user", "content": "first" }]), false).unwrap();
        agent_session_append(project.to_str().unwrap(), "agent-o", &json!([{ "role": "assistant", "content": "second" }]), false).unwrap();
        let content = std::fs::read_to_string(session_file(&project, "agent-o")).unwrap();
        assert_eq!(content.lines().count(), 2, "重复保存（append）= 历史累积");
        assert!(content.contains("first") && content.contains("second"));

        // 覆盖语义：rewrite=true → File::create 截断重写
        agent_session_append(project.to_str().unwrap(), "agent-o", &json!([{ "role": "user", "content": "third" }]), true).unwrap();
        let content = std::fs::read_to_string(session_file(&project, "agent-o")).unwrap();
        assert_eq!(content.lines().count(), 1, "rewrite 保存 = 覆盖");
        assert!(content.contains("third"));
        assert!(!content.contains("first"), "旧历史被覆盖清除");
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 附加钉：持久化入口的路径穿越守卫（sanitize_path_id）——
    /// agent_id 含 / \\ .. \0 一律拒绝，不落盘、不建目录。
    #[test]
    fn agent_session_rejects_path_traversal_agent_id() {
        let project = session_test_dir("traversal");
        let err = agent_session_append(
            project.to_str().unwrap(),
            "../evil",
            &json!([{ "role": "user", "content": "x" }]),
            false,
        )
        .unwrap_err();
        assert!(err.contains("非法字符"), "穿越 agent_id 必须拒绝: {err}");
        assert!(
            !project.join(".lantai/agents").exists(),
            "拒绝时不得创建任何目录"
        );
        let _ = std::fs::remove_dir_all(&project);
    }
}

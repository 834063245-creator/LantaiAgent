// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// browser 能力口（R4，kernel-capability-d4-handle-design.md）——句柄域 browser 族。
//
// 能力口语义：模型族 TS 工具（browser.ts）经 RPC 直呼，不经 tool_call 信封 /
// PluginRegistry / PluginToolAdapter（builtin.browser 插件随 R4-2 退役；R4-1
// 过渡期插件 execute 委托本口——业务单一实现在这里，插件只是信封薄壳）。
// 单方法 + action 分派（对标 fs/git/process_cap），action = 退役前
// builtin.browser 37 工具名（一位一动作）。
//
// 口内闸（v3 §1：Rust 能力口是 webview 越不过的物理强制层；D4-4/D4-5 裁定）：
// 直接构造 BrowserTool 过 crate::utils::check_permission——**不构造
// PluginToolAdapter**（manifest 零 permission 声明 = `plugin:builtin.browser.*`
// 精确名寻址面从未存在，adapter 恒 Passthrough 无意义）；**无条件过闸**
// （插件原语义：Agent/用户路径同过闸，BrowserTool 自带 agent_id，Ask 链路
// 两态通用——与 git_cap 的 is_agent 门差异见设计件 §4）。多层语义
// （Browser=deny 最高优先 + 只读放行 + attach 后页内动作放行 + 高危 Ask）
// 全在 BrowserTool::check_permissions——口内不重实现。click_sensitive /
// type_sensitive 运行时二次 Ask（check_sensitive，ADR 0003 D6 L3）与
// target="self" 只读拒绝原样保留。
//
// 键语言（D4-6）：口收顶层 snake_case（能力口统一契约，bridge.rpc() 对已是
// snake 的键幂等）；TS 工具面键 = manifest 语言（camelCase）不变，映射在
// TS execute 层（11 键表）。R4-1 过渡期信封 args 是 camelCase——
// envelope_execute 入口做顶层 camel→snake 翻译（snake_args，仅键名，
// 值不动）。
//
// 句柄层（CDP 会话注册表 / wire transport / 审计环 / 敏感词表）全在
// crate::cdp——本口是调用壳非实现；快照/分页在会话源内完成（D4-3：不迁 TS）。

use serde_json::Value;
use tauri::State;

/// 口内闸句柄：agent 身份 + 权限上下文获取面（ToolContext.check_permission
/// 的等价展开——browser/uia 业务只消费这两样）。
pub(crate) struct BrowserGate<'a> {
    pub agent_id: Option<String>,
    pub state: &'a State<'a, crate::WorkspaceState>,
    pub app: &'a tauri::AppHandle,
}

impl BrowserGate<'_> {
    /// 工具级权限过闸（BrowserTool 承载 Browser=deny / 只读放行 / attach 后
    /// 页内放行 / 高危 Ask 分层）。无条件过闸（D4-5：插件原语义）。
    /// 错误统一带「权限拒绝: 」前缀——与插件 ToolError::Permission.message()
    /// 的最终字符串逐字节一致（能力口错误串即最终形态）。
    pub async fn check(&self, action: &str, agent_id: Option<&str>) -> Result<(), String> {
        let tool = crate::tools::BrowserTool {
            action: action.to_string(),
            agent_id: agent_id.map(String::from),
        };
        let perm_ctx = crate::utils::get_ctx(self.state)?;
        crate::utils::check_permission(&tool, &perm_ctx, self.app)
            .await
            .map_err(|m| format!("权限拒绝: {m}"))
    }
}

// ── 参数提取（顶层 snake 键；局部 helper，不依赖 tool_plugins 信封面）──

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
}

fn arg_strs(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key).and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<String>>()
    })
}

/// browser 命令的 agent 路由：target="self" 走自家 webview 只读会话，
/// 否则走各 Agent 自己的 CDP 会话（无 agent_id 共用 default）。
/// 与插件 self_or_agent/agent_of 同一语义（agent_of 是同义别名，合并）。
fn self_or_agent(gate: &BrowserGate<'_>, args: &Value) -> Option<String> {
    if arg_str(args, "target").as_deref() == Some(crate::cdp::SELF_AGENT_ID) {
        Some(crate::cdp::SELF_AGENT_ID.to_string())
    } else {
        gate.agent_id.clone()
    }
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 tool_plugins/browser/mod.rs 逐行为迁入；参数键 snake；
// text() 直通内联为 Result<String, String>——错误串即最终形态）
// ═══════════════════════════════════════════════════════════════

async fn browser_launch(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = gate.agent_id.clone();
    gate.check("launch", agent_id.as_deref()).await?;
    let url = arg_str(args, "url");
    let port = args.get("port").and_then(|v| v.as_u64()).map(|n| n as u16);
    let headless = args.get("headless").and_then(|v| v.as_bool());
    let profile = arg_str(args, "profile");
    let proxy = arg_str(args, "proxy");
    let proxy_bypass = arg_str(args, "proxy_bypass");
    let window_size = args
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

async fn browser_connect(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = gate.agent_id.clone();
    gate.check("connect", agent_id.as_deref()).await?;
    let port = args
        .get("port")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "browser_connect: missing 'port'".to_string())?;
    if port == 0 || port > 65535 {
        return Err("browser_connect: 端口必须在 1-65535".into());
    }
    let profile = arg_str(args, "session").or_else(|| arg_str(args, "profile"));
    crate::cdp::cdp_connect(port as u16, profile, agent_id.as_deref())
}

async fn browser_sessions(gate: &BrowserGate<'_>, _args: &Value) -> Result<String, String> {
    let agent_id = gate.agent_id.clone();
    gate.check("sessions", agent_id.as_deref()).await?;
    Ok(crate::cdp::cdp_sessions(agent_id.as_deref()))
}

async fn browser_switch_session(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = gate.agent_id.clone();
    gate.check("switch_session", agent_id.as_deref()).await?;
    let profile = arg_str(args, "session").or_else(|| arg_str(args, "profile"));
    crate::cdp::cdp_switch_session(profile, agent_id.as_deref())
}

async fn browser_cookies(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(
            "browser_cookies: self 会话只读，不暴露/修改自家 webview cookie".into(),
        );
    }
    let action = arg_str(args, "op")
        .ok_or_else(|| "browser_cookies: missing 'op'".to_string())?;
    let perm = match action.as_str() {
        "list" => "cookies_list",
        "set" => "cookies_set",
        "delete" => "cookies_delete",
        _ => {
            return Err(
                "browser_cookies: action 只支持 list/set/delete".into(),
            )
        }
    };
    gate.check(perm, agent_id.as_deref()).await?;
    let urls = arg_strs(args, "urls");
    let url = arg_str(args, "url");
    let name = arg_str(args, "name");
    let value = arg_str(args, "value");
    let domain = arg_str(args, "domain");
    let path = arg_str(args, "path");
    let http_only = args.get("http_only").and_then(|v| v.as_bool());
    let secure = args.get("secure").and_then(|v| v.as_bool());
    let same_site = arg_str(args, "same_site");
    let expires = args.get("expires").and_then(|v| v.as_f64());
    crate::cdp::cdp_cookies(
        &action, urls, url, name, value, domain, path, http_only, secure, same_site,
        expires, agent_id.as_deref(),
    )
    .await
}

async fn browser_kill(gate: &BrowserGate<'_>, _args: &Value) -> Result<String, String> {
    let agent_id = gate.agent_id.clone();
    gate.check("kill", agent_id.as_deref()).await?;
    crate::cdp::cdp_kill(agent_id.as_deref())
}

async fn browser_targets(gate: &BrowserGate<'_>, _args: &Value) -> Result<String, String> {
    let agent_id = gate.agent_id.clone();
    gate.check("targets", agent_id.as_deref()).await?;
    crate::cdp::cdp_targets(agent_id.as_deref())
}

async fn browser_discover(gate: &BrowserGate<'_>, _args: &Value) -> Result<String, String> {
    // 只读：只列清单，不连接任何实例；但工具级 Deny 仍生效
    gate.check("discover", None).await?;
    crate::cdp::cdp_discover()
}

async fn browser_attach(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = gate.agent_id.clone();
    gate.check("attach", agent_id.as_deref()).await?;
    let target = arg_str(args, "target_id")
        .ok_or_else(|| "browser_attach: missing 'targetId'".to_string())?;
    crate::cdp::cdp_attach(&target, agent_id.as_deref())
}

async fn browser_inspect(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("inspect", agent_id.as_deref()).await?;
    let selector = arg_str(args, "selector")
        .ok_or_else(|| "browser_inspect: missing 'selector'".to_string())?;
    let props = arg_strs(args, "props");
    let max_results = args.get("max_results").and_then(|v| v.as_u64()).map(|n| n as usize);
    crate::cdp::cdp_inspect(&selector, props, max_results, agent_id.as_deref())
        .await
}

async fn browser_report(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("report", agent_id.as_deref()).await?;
    let scope = arg_str(args, "scope");
    crate::cdp::cdp_report(scope, agent_id.as_deref()).await
}

async fn browser_snapshot(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("snapshot", agent_id.as_deref()).await?;
    let scope = arg_str(args, "scope");
    let max_results = args.get("max_results").and_then(|v| v.as_u64()).map(|n| n as usize);
    let offset = args.get("offset").and_then(|v| v.as_u64()).map(|n| n as usize);
    crate::cdp::cdp_snapshot(scope, max_results, offset, agent_id.as_deref()).await
}

async fn browser_content(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("content", agent_id.as_deref()).await?;
    let scope = arg_str(args, "scope");
    let format = arg_str(args, "format");
    let max_chars = args.get("max_chars").and_then(|v| v.as_u64()).map(|n| n as usize);
    let offset = args.get("offset").and_then(|v| v.as_u64()).map(|n| n as usize);
    crate::cdp::cdp_content(scope, format, max_chars, offset, agent_id.as_deref()).await
}

async fn browser_console(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("console", agent_id.as_deref()).await?;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
    Ok(crate::cdp::cdp_console(agent_id.as_deref(), limit))
}

async fn browser_network(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("network", agent_id.as_deref()).await?;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
    Ok(crate::cdp::cdp_network(agent_id.as_deref(), limit))
}

async fn browser_network_detail(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("network_detail", agent_id.as_deref()).await?;
    let request_id = arg_str(args, "request_id")
        .ok_or_else(|| "browser_network_detail: missing 'requestId'".to_string())?;
    crate::cdp::cdp_network_detail(&request_id, agent_id.as_deref())
}

async fn browser_network_har(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("network_har", agent_id.as_deref()).await?;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
    crate::cdp::cdp_network_har(agent_id.as_deref(), limit)
}

async fn browser_screenshot(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("screenshot", agent_id.as_deref()).await?;
    let full_page = args.get("full_page").and_then(|v| v.as_bool()).unwrap_or(false);
    let out = crate::cdp::cdp_screenshot(full_page, agent_id.as_deref()).await?;
    // 工具附图通道 P0a（docs/plans/tool-image-context-plan.md）：把截图转存成工作区
    // 内容寻址附件，并在输出里附 image 引用 —— 模型侧 parseToolImageOutput 据此把图
    // 挂进上下文（INVARIANTS #14：消息只存引用，字节在 {ws}/.lantai/attachments/）。
    Ok(attach_screenshot_ref(gate, out))
}

/// 截图目录下文件的大小上限（8MiB，与 fs_cap 读字节上限同档）——超过则只回路径，
/// 不把巨图灌进用户项目目录。
const SHOT_ATTACH_MAX_BYTES: usize = 8 * 1024 * 1024;

/// 把 cdp 截图转存为工作区附件并加 `image` 引用（纯增益：任何一步不成 → 原输出原样返回）。
///
/// 为何在 Rust 侧写而不是 TS 侧搬运：截图落在系统临时目录（工作区外），Agent 通道读
/// 会撞权限闸；本口已持 WorkspaceState（gate.state），直接写 attachments 零摩擦。
/// 落盘走 attachments::store_attachment（内容寻址单一权威，与 fs(read) 附图同一份）。
fn attach_screenshot_ref(gate: &BrowserGate<'_>, output: String) -> String {
    let Ok(mut val) = serde_json::from_str::<Value>(&output) else {
        return output;
    };
    let Some(src) = val.get("path").and_then(|v| v.as_str()) else {
        return output;
    };
    // 只认本套件自己产的截图（防任何形态的路径注入）
    let src_path = std::path::Path::new(src);
    if src_path.parent() != Some(crate::cdp::shot_dir().as_path()) {
        return output;
    }
    let Ok(bytes) = std::fs::read(src_path) else {
        return output;
    };
    if bytes.len() > SHOT_ATTACH_MAX_BYTES {
        return output;
    }
    // PNG 尺寸：IHDR（偏移 16/20，大端）——渲染侧展示与预算判据都要
    let (Some(w), Some(h)) = (png_dim(&bytes, 16), png_dim(&bytes, 20)) else {
        return output;
    };
    // 无工作区（未打开项目）→ 不落附件，只回路径（截图本身仍成功）
    let Ok(ws) = crate::utils::workspace_path(gate.state) else {
        return output;
    };
    let Ok((id, dst)) = crate::attachments::store_attachment(&ws, &bytes, "png") else {
        return output;
    };
    let name = src_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("{id}.png"));
    if let Some(obj) = val.as_object_mut() {
        obj.insert(
            "image".to_string(),
            serde_json::json!({
                "id": id,
                "mediaType": "image/png",
                "bytes": bytes.len(),
                "width": w,
                "height": h,
                "name": name,
            }),
        );
        obj.insert(
            "attachment".to_string(),
            serde_json::json!(dst.to_string_lossy()),
        );
        obj.insert(
            "imageNote".to_string(),
            serde_json::json!(
                "本图已作为附图进入上下文：视觉模型可直接观察（纯文本模型只看到本占位说明）。"
            ),
        );
    }
    val.to_string()
}

/// 从 PNG 头部读一个 4 字节大端整数（偏移 16=宽 / 20=高）；非 PNG 或越界 → None。
fn png_dim(bytes: &[u8], at: usize) -> Option<u32> {
    if bytes.len() < at + 4 || bytes.get(12..16) != Some(b"IHDR") {
        return None;
    }
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&bytes[at..at + 4]);
    Some(u32::from_be_bytes(buf))
}


async fn browser_viewport(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_viewport: self 会话只读，不能操作自家 webview".into());
    }
    gate.check("viewport", agent_id.as_deref()).await?;
    let width = args.get("width")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| "browser_viewport: missing or invalid 'width'".to_string())?;
    let height = args.get("height")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| "browser_viewport: missing or invalid 'height'".to_string())?;
    let device_scale_factor = args.get("device_scale_factor").and_then(|v| v.as_f64());
    let mobile = args.get("mobile").and_then(|v| v.as_bool());
    crate::cdp::cdp_set_viewport(width, height, device_scale_factor, mobile, agent_id.as_deref())
        .await
}

async fn browser_audit(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    gate.check("audit", None).await?;
    let agent = arg_str(args, "agent");
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
    Ok(crate::cdp::cdp_audit(agent.as_deref(), limit))
}

async fn browser_click(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_click: self 会话只读，不能操作自家 webview".into());
    }
    let selector = arg_str(args, "selector")
        .ok_or_else(|| "browser_click: missing 'selector'".to_string())?;
    gate.check("click", agent_id.as_deref()).await?;
    // 敏感目标（提交按钮/下载/中英文高危文本）→ 每次单独 Ask（ADR 0003 D6 L3）
    if crate::cdp::check_sensitive(&selector, "click", agent_id.as_deref()).await {
        gate.check("click_sensitive", agent_id.as_deref()).await?;
    }
    crate::cdp::cdp_click(&selector, agent_id.as_deref()).await
}

async fn browser_type(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_type: self 会话只读，不能操作自家 webview".into());
    }
    let selector = arg_str(args, "selector")
        .ok_or_else(|| "browser_type: missing 'selector'".to_string())?;
    let text_v = arg_str(args, "text")
        .ok_or_else(|| "browser_type: missing 'text'".to_string())?;
    let replace = args.get("replace").and_then(|v| v.as_bool()).unwrap_or(false);
    gate.check("type", agent_id.as_deref()).await?;
    // 敏感目标（已填值输入框/密码框）→ 每次单独 Ask（ADR 0003 D6 L3）
    if crate::cdp::check_sensitive(&selector, "type", agent_id.as_deref()).await {
        gate.check("type_sensitive", agent_id.as_deref()).await?;
    }
    crate::cdp::cdp_type(&selector, &text_v, replace, agent_id.as_deref()).await
}

async fn browser_press(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_press: self 会话只读，不能操作自家 webview".into());
    }
    let key = arg_str(args, "key")
        .ok_or_else(|| "browser_press: missing 'key'".to_string())?;
    let modifiers = arg_strs(args, "modifiers");
    gate.check("press", agent_id.as_deref()).await?;
    crate::cdp::cdp_press(&key, modifiers, agent_id.as_deref()).await
}

async fn browser_hover(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_hover: self 会话只读，不能操作自家 webview".into());
    }
    let selector = arg_str(args, "selector")
        .ok_or_else(|| "browser_hover: missing 'selector'".to_string())?;
    gate.check("hover", agent_id.as_deref()).await?;
    crate::cdp::cdp_hover(&selector, agent_id.as_deref()).await
}

async fn browser_dialog(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    let accept = args.get("accept").and_then(|v| v.as_bool());
    if let Some(accept) = accept {
        if crate::cdp::is_self(agent_id.as_deref()) {
            return Err("browser_dialog: self 会话只读，不能操作自家 webview".into());
        }
        gate.check("dialog", agent_id.as_deref()).await?;
        let prompt_text = arg_str(args, "prompt_text");
        crate::cdp::cdp_handle_dialog(accept, prompt_text, agent_id.as_deref()).await
    } else {
        // 只查询 pending/最近 dialog；self 通道也可用。
        gate.check("dialog_query", agent_id.as_deref()).await?;
        let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
        Ok(crate::cdp::cdp_dialogs(agent_id.as_deref(), limit))
    }
}

async fn browser_upload(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_upload: self 会话只读，不能操作自家 webview".into());
    }
    let selector = arg_str(args, "selector");
    let files = arg_strs(args, "files")
        .ok_or_else(|| "browser_upload: missing 'files'".to_string())?;
    gate.check("upload", agent_id.as_deref()).await?;
    crate::cdp::cdp_upload(selector, files, agent_id.as_deref()).await
}

async fn browser_new_tab(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_new_tab: self 会话只读，不能操作自家 webview".into());
    }
    gate.check("new_tab", agent_id.as_deref()).await?;
    let url = arg_str(args, "url");
    crate::cdp::cdp_new_tab(url, agent_id.as_deref()).await
}

async fn browser_close_tab(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_close_tab: self 会话只读，不能操作自家 webview".into());
    }
    let target_id = arg_str(args, "target_id")
        .ok_or_else(|| "browser_close_tab: missing 'targetId'".to_string())?;
    gate.check("close_tab", agent_id.as_deref()).await?;
    crate::cdp::cdp_close_tab(&target_id, agent_id.as_deref())
}

async fn browser_scroll(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_scroll: self 会话只读，不能操作自家 webview".into());
    }
    let selector = arg_str(args, "selector");
    let direction = arg_str(args, "direction");
    gate.check("scroll", agent_id.as_deref()).await?;
    crate::cdp::cdp_scroll(selector, direction, agent_id.as_deref()).await
}

async fn browser_navigate(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_navigate: self 会话只读，不能操作自家 webview".into());
    }
    let url = arg_str(args, "url")
        .ok_or_else(|| "browser_navigate: missing 'url'".to_string())?;
    gate.check("navigate", agent_id.as_deref()).await?;
    crate::cdp::cdp_navigate(&url, agent_id.as_deref()).await
}

async fn browser_back(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_back: self 会话只读，不能操作自家 webview".into());
    }
    gate.check("back", agent_id.as_deref()).await?;
    crate::cdp::cdp_back(agent_id.as_deref()).await
}

async fn browser_forward(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_forward: self 会话只读，不能操作自家 webview".into());
    }
    gate.check("forward", agent_id.as_deref()).await?;
    crate::cdp::cdp_forward(agent_id.as_deref()).await
}

async fn browser_reload(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_reload: self 会话只读，不能操作自家 webview".into());
    }
    gate.check("reload", agent_id.as_deref()).await?;
    crate::cdp::cdp_reload(agent_id.as_deref()).await
}

async fn browser_select(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err("browser_select: self 会话只读，不能操作自家 webview".into());
    }
    let selector = arg_str(args, "selector")
        .ok_or_else(|| "browser_select: missing 'selector'".to_string())?;
    let value = arg_str(args, "value")
        .ok_or_else(|| "browser_select: missing 'value'".to_string())?;
    gate.check("select", agent_id.as_deref()).await?;
    crate::cdp::cdp_select(&selector, &value, agent_id.as_deref()).await
}

async fn browser_wait(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    // 只读等待(selector 出现或固定 ms)，不改变状态；Deny 仍生效
    let agent_id = self_or_agent(gate, args);
    gate.check("wait", agent_id.as_deref()).await?;
    let selector = arg_str(args, "selector");
    let ms = args.get("ms").and_then(|v| v.as_u64());
    crate::cdp::cdp_wait(selector, ms, agent_id.as_deref()).await
}

async fn browser_eval(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = gate.agent_id.clone();
    gate.check("eval", agent_id.as_deref()).await?;
    let expr = arg_str(args, "expr")
        .ok_or_else(|| "browser_eval: missing 'expr'".to_string())?;
    crate::cdp::cdp_eval(&expr, agent_id.as_deref()).await
}

async fn browser_status(gate: &BrowserGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = self_or_agent(gate, args);
    gate.check("status", agent_id.as_deref()).await?;
    Ok(crate::cdp::cdp_status(agent_id.as_deref()))
}

// ═══════════════════════════════════════════════════════════════
// 分派与入口
// ═══════════════════════════════════════════════════════════════

async fn dispatch_action(gate: &BrowserGate<'_>, action: &str, args: &Value) -> Result<String, String> {
    match action {
        "browser_launch" => browser_launch(gate, args).await,
        "browser_connect" => browser_connect(gate, args).await,
        "browser_sessions" => browser_sessions(gate, args).await,
        "browser_switch_session" => browser_switch_session(gate, args).await,
        "browser_cookies" => browser_cookies(gate, args).await,
        "browser_kill" => browser_kill(gate, args).await,
        "browser_targets" => browser_targets(gate, args).await,
        "browser_discover" => browser_discover(gate, args).await,
        "browser_attach" => browser_attach(gate, args).await,
        "browser_inspect" => browser_inspect(gate, args).await,
        "browser_report" => browser_report(gate, args).await,
        "browser_snapshot" => browser_snapshot(gate, args).await,
        "browser_content" => browser_content(gate, args).await,
        "browser_console" => browser_console(gate, args).await,
        "browser_network" => browser_network(gate, args).await,
        "browser_network_detail" => browser_network_detail(gate, args).await,
        "browser_network_har" => browser_network_har(gate, args).await,
        "browser_screenshot" => browser_screenshot(gate, args).await,
        "browser_viewport" => browser_viewport(gate, args).await,
        "browser_audit" => browser_audit(gate, args).await,
        "browser_click" => browser_click(gate, args).await,
        "browser_type" => browser_type(gate, args).await,
        "browser_press" => browser_press(gate, args).await,
        "browser_hover" => browser_hover(gate, args).await,
        "browser_dialog" => browser_dialog(gate, args).await,
        "browser_upload" => browser_upload(gate, args).await,
        "browser_new_tab" => browser_new_tab(gate, args).await,
        "browser_close_tab" => browser_close_tab(gate, args).await,
        "browser_scroll" => browser_scroll(gate, args).await,
        "browser_navigate" => browser_navigate(gate, args).await,
        "browser_back" => browser_back(gate, args).await,
        "browser_forward" => browser_forward(gate, args).await,
        "browser_reload" => browser_reload(gate, args).await,
        "browser_select" => browser_select(gate, args).await,
        "browser_wait" => browser_wait(gate, args).await,
        "browser_eval" => browser_eval(gate, args).await,
        "browser_status" => browser_status(gate, args).await,
        other => Err(format!("browser_cap: 未知 action '{other}'")),
    }
}

/// browser_cap 能力口分派（R4-1 立口；R4-2 起为 browser 族唯一入口）。
/// action = 退役前 builtin.browser 37 工具名；参数顶层 snake（D4-6）；
/// 返回文本（Text shape——字节精确直通）。
pub(crate) async fn browser_cap(
    action: String,
    params: Value,
    is_agent: bool,
    agent_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    // is_agent 为能力口统一契约键（与 fs/git/process 口同形）；browser 闸
    // 两态通用不过门（D4-5），口内业务不消费。
    let _ = is_agent;
    let gate = BrowserGate {
        agent_id,
        state,
        app,
    };
    dispatch_action(&gate, &action, &params).await
}

// ── 信封过渡面（R4-1）随 builtin.browser 退役（R4-2）删除：snake_args /
//    snake_top_key / envelope_execute 不再有消费方——TS 直呼路径的 camel→snake
//    映射在 TS execute 层（BROWSER_CAP_SNAKE_KEYS）。

#[cfg(test)]
mod tests {
    /// 37 动作全集（= 退役前 builtin.browser manifest.tools 名单，D4-1）。
    const ACTIONS: &[&str] = &[
        "browser_launch",
        "browser_connect",
        "browser_sessions",
        "browser_switch_session",
        "browser_cookies",
        "browser_kill",
        "browser_targets",
        "browser_discover",
        "browser_attach",
        "browser_inspect",
        "browser_report",
        "browser_snapshot",
        "browser_content",
        "browser_console",
        "browser_network",
        "browser_network_detail",
        "browser_network_har",
        "browser_screenshot",
        "browser_viewport",
        "browser_audit",
        "browser_click",
        "browser_type",
        "browser_press",
        "browser_hover",
        "browser_dialog",
        "browser_upload",
        "browser_new_tab",
        "browser_close_tab",
        "browser_scroll",
        "browser_navigate",
        "browser_back",
        "browser_forward",
        "browser_reload",
        "browser_select",
        "browser_wait",
        "browser_eval",
        "browser_status",
    ];

    #[test]
    fn action_table_is_exactly_thirty_seven_unique() {
        assert_eq!(ACTIONS.len(), 37);
        let mut sorted = ACTIONS.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 37, "动作表不得有重复项");
    }

    #[test]
    fn unknown_action_errors_loudly() {
        // 未知动作显式报错（不静默 Passthrough）——与 git_cap 同纪律。
        let known: std::collections::HashSet<&str> = ACTIONS.iter().copied().collect();
        for a in ["browser_frobnicate", "launch", "browser_", ""] {
            assert!(!known.contains(a), "{a} 不应在 37 动作表内");
        }
    }

    // ── 工具附图通道 P0a（docs/plans/tool-image-context-plan.md）──

    /// 最小合法 PNG 头（签名 + IHDR 宽高）——只够 png_dim 读尺寸。
    fn png_head(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v
    }

    #[test]
    fn png_dim_reads_ihdr_width_height() {
        let head = png_head(720, 240);
        assert_eq!(super::png_dim(&head, 16), Some(720));
        assert_eq!(super::png_dim(&head, 20), Some(240));
    }

    #[test]
    fn png_dim_rejects_non_png_and_short_input() {
        // 非 PNG（JPEG 头）——不得把任意二进制当图读尺寸
        let jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(super::png_dim(&jpeg, 16), None);
        // 越界读（不足 at+4）
        assert_eq!(super::png_dim(&png_head(1, 1)[..14], 16), None);
        assert_eq!(super::png_dim(&[], 20), None);
    }

    /// 截图目录判据：非本套件产的路径一律不转存（防路径注入）。
    #[test]
    fn shot_source_guard_only_accepts_shot_dir() {
        let dir = crate::cdp::shot_dir();
        assert_eq!(
            std::path::Path::new(&dir.join("shot-1.png")).parent(),
            Some(dir.as_path())
        );
        for bad in ["C:\\Windows\\Temp\\evil.png", "D:\\proj\\.lantai\\attachments\\x.png"] {
            assert_ne!(std::path::Path::new(bad).parent(), Some(dir.as_path()));
        }
    }
}

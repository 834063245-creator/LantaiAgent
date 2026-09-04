// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

//! builtin.browser 插件——内核插件运行时 Phase 5（自 rpc.rs CDP 分区拆出）。
//! 工具面真源 = 同目录 manifest.json（npm run gen:kernel-manifest browser 发射）。
//!
//! 权限形状（§8 裁决）：**不进 manifest permission**——插件内业务自检。
//! dispatch 侧 adapter 恒 Passthrough；各业务函数内构造 BrowserTool 经
//! ctx.check_permission(&BrowserTool{action}) 过闸（与旧 rpc 层
//! check_browser_permission 同一真权路径：Browser=deny 最高优先 + 只读放行 +
//! attach 后页内动作放行 + 高危动作 Ask）。click_sensitive / type_sensitive 的
//! 运行时二次 Ask（ADR 0003 D6 L3）与 self 路由原样迁入。
//!
//! 单键语言（P2-3 裁决延续）：模型面键 = manifest 键 = 插件实收键。
//! 参数键说 manifest schema 的语言（camelCase：windowSize / proxyBypass /
//! maxResults / targetId ——与旧 RPC 分支读 snake_case 不同，信封 args 不经
//! bridge 转换，嵌套键原样到达）；target="self" 判别与 _agent_id 路由语义不变。

use serde_json::Value;

use super::manifest::ToolManifest;
use super::plugin::{arg_str, ToolContext, ToolError, ToolPlugin};

pub struct BrowserPlugin {
    manifest: ToolManifest,
}

impl BrowserPlugin {
    pub fn new() -> Self {
        let manifest: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("builtin.browser manifest 是随 exe 编译的静态资源");
        Self { manifest }
    }
}

impl Default for BrowserPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlugin for BrowserPlugin {
    fn id(&self) -> &str {
        "builtin.browser"
    }

    fn manifest(&self) -> &ToolManifest {
        &self.manifest
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a ToolContext<'a>,
        tool_name: &'a str,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, ToolError>> + Send + 'a>,
    > {
        Box::pin(async move {
            match tool_name {
                "browser_launch" => browser_launch(ctx, &args).await,
                "browser_connect" => browser_connect(ctx, &args).await,
                "browser_sessions" => browser_sessions(ctx, &args).await,
                "browser_switch_session" => browser_switch_session(ctx, &args).await,
                "browser_cookies" => browser_cookies(ctx, &args).await,
                "browser_kill" => browser_kill(ctx, &args).await,
                "browser_targets" => browser_targets(ctx, &args).await,
                "browser_discover" => browser_discover(ctx, &args).await,
                "browser_attach" => browser_attach(ctx, &args).await,
                "browser_inspect" => browser_inspect(ctx, &args).await,
                "browser_report" => browser_report(ctx, &args).await,
                "browser_snapshot" => browser_snapshot(ctx, &args).await,
                "browser_content" => browser_content(ctx, &args).await,
                "browser_console" => browser_console(ctx, &args).await,
                "browser_network" => browser_network(ctx, &args).await,
                "browser_network_detail" => browser_network_detail(ctx, &args).await,
                "browser_network_har" => browser_network_har(ctx, &args).await,
                "browser_screenshot" => browser_screenshot(ctx, &args).await,
                "browser_viewport" => browser_viewport(ctx, &args).await,
                "browser_audit" => browser_audit(ctx, &args).await,
                "browser_click" => browser_click(ctx, &args).await,
                "browser_type" => browser_type(ctx, &args).await,
                "browser_press" => browser_press(ctx, &args).await,
                "browser_hover" => browser_hover(ctx, &args).await,
                "browser_dialog" => browser_dialog(ctx, &args).await,
                "browser_upload" => browser_upload(ctx, &args).await,
                "browser_new_tab" => browser_new_tab(ctx, &args).await,
                "browser_close_tab" => browser_close_tab(ctx, &args).await,
                "browser_scroll" => browser_scroll(ctx, &args).await,
                "browser_navigate" => browser_navigate(ctx, &args).await,
                "browser_back" => browser_back(ctx, &args).await,
                "browser_forward" => browser_forward(ctx, &args).await,
                "browser_reload" => browser_reload(ctx, &args).await,
                "browser_select" => browser_select(ctx, &args).await,
                "browser_wait" => browser_wait(ctx, &args).await,
                "browser_eval" => browser_eval(ctx, &args).await,
                "browser_status" => browser_status(ctx, &args).await,
                other => Err(ToolError::InvalidArgs(format!("builtin.browser: 未知工具 '{other}'"))),
            }
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 rpc.rs CDP 分区原样迁入；参数键 = manifest 语言 camelCase；
// 权限 = ctx.check_permission(&BrowserTool{action})——§8.3 形态）
// ═══════════════════════════════════════════════════════════════

/// text 结果直通（dispatch 的 Value::String 分支——字节精确）。
fn text(s: String) -> Result<Value, ToolError> {
    Ok(Value::String(s))
}

/// browser 命令的 agent 路由：target="self" 走自家 webview 只读会话，
/// 否则走各 Agent 自己的 CDP 会话（无 _agent_id 共用 default）。
/// 与旧 rpc.rs self_or_agent 同一语义（领域工具传 target="self" 字符串）。
fn self_or_agent(ctx: &ToolContext<'_>, args: &Value) -> Option<String> {
    if arg_str(args, "target").as_deref() == Some(crate::cdp::SELF_AGENT_ID) {
        Some(crate::cdp::SELF_AGENT_ID.to_string())
    } else {
        ctx.agent_id.clone()
    }
}

/// 读侧 agent 路由（self 判别 + _agent_id）。
fn agent_of(ctx: &ToolContext<'_>, args: &Value) -> Option<String> {
    self_or_agent(ctx, args)
}

/// 工具级权限过闸（BrowserTool 承载 Browser=deny / 只读放行 / 页内放行 / Ask 分层）。
async fn browser_check(ctx: &ToolContext<'_>, action: &str, agent_id: Option<&str>) -> Result<(), ToolError> {
    let tool = crate::tools::BrowserTool {
        action: action.to_string(),
        agent_id: agent_id.map(String::from),
    };
    ctx.check_permission(&tool).await.map_err(ToolError::Permission)
}


async fn browser_launch(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = ctx.agent_id.clone();
    browser_check(ctx, "launch", agent_id.as_deref()).await?;
    let url = arg_str(args, "url");
    let port = args.get("port").and_then(|v| v.as_u64()).map(|n| n as u16);
    let headless = args.get("headless").and_then(|v| v.as_bool());
    let profile = arg_str(args, "profile");
    let proxy = arg_str(args, "proxy");
    let proxy_bypass = arg_str(args, "proxyBypass");
    let window_size = args
        .get("windowSize")
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
        .transpose()
        .map_err(ToolError::Tool)?;
    text(
        crate::cdp::cdp_launch(
            url, port, headless, window_size, profile, proxy, proxy_bypass,
            agent_id.as_deref(),
        )
        .await
        .map_err(ToolError::Tool)?,
    )
}

async fn browser_connect(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = ctx.agent_id.clone();
    browser_check(ctx, "connect", agent_id.as_deref()).await?;
    let port = args
        .get("port")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| ToolError::InvalidArgs("browser_connect: missing 'port'".into()))?;
    if port == 0 || port > 65535 {
        return Err(ToolError::Tool("browser_connect: 端口必须在 1-65535".into()));
    }
    let profile = arg_str(args, "session").or_else(|| arg_str(args, "profile"));
    text(crate::cdp::cdp_connect(port as u16, profile, agent_id.as_deref()).map_err(ToolError::Tool)?)
}

async fn browser_sessions(ctx: &ToolContext<'_>, _args: &Value) -> Result<Value, ToolError> {
    let agent_id = ctx.agent_id.clone();
    browser_check(ctx, "sessions", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_sessions(agent_id.as_deref()))
}

async fn browser_switch_session(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = ctx.agent_id.clone();
    browser_check(ctx, "switch_session", agent_id.as_deref()).await?;
    let profile = arg_str(args, "session").or_else(|| arg_str(args, "profile"));
    text(crate::cdp::cdp_switch_session(profile, agent_id.as_deref()).map_err(ToolError::Tool)?)
}

async fn browser_cookies(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool(
            "browser_cookies: self 会话只读，不暴露/修改自家 webview cookie".into(),
        ));
    }
    let action = arg_str(args, "op")
        .ok_or_else(|| ToolError::InvalidArgs("browser_cookies: missing 'op'".into()))?;
    let perm = match action.as_str() {
        "list" => "cookies_list",
        "set" => "cookies_set",
        "delete" => "cookies_delete",
        _ => return Err(ToolError::InvalidArgs("browser_cookies: action 只支持 list/set/delete".into())),
    };
    browser_check(ctx, perm, agent_id.as_deref()).await?;
    let urls = args.get("urls").and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<String>>()
    });
    let url = arg_str(args, "url");
    let name = arg_str(args, "name");
    let value = arg_str(args, "value");
    let domain = arg_str(args, "domain");
    let path = arg_str(args, "path");
    let http_only = args.get("httpOnly").and_then(|v| v.as_bool());
    let secure = args.get("secure").and_then(|v| v.as_bool());
    let same_site = arg_str(args, "sameSite");
    let expires = args.get("expires").and_then(|v| v.as_f64());
    text(
        crate::cdp::cdp_cookies(
            &action, urls, url, name, value, domain, path, http_only, secure, same_site,
            expires, agent_id.as_deref(),
        )
        .await
        .map_err(ToolError::Tool)?,
    )
}

async fn browser_kill(ctx: &ToolContext<'_>, _args: &Value) -> Result<Value, ToolError> {
    let agent_id = ctx.agent_id.clone();
    browser_check(ctx, "kill", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_kill(agent_id.as_deref()).map_err(ToolError::Tool)?)
}

async fn browser_targets(ctx: &ToolContext<'_>, _args: &Value) -> Result<Value, ToolError> {
    let agent_id = ctx.agent_id.clone();
    browser_check(ctx, "targets", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_targets(agent_id.as_deref()).map_err(ToolError::Tool)?)
}

async fn browser_discover(ctx: &ToolContext<'_>, _args: &Value) -> Result<Value, ToolError> {
    // 只读：只列清单，不连接任何实例；但工具级 Deny 仍生效
    browser_check(ctx, "discover", None).await?;
    text(crate::cdp::cdp_discover().map_err(ToolError::Tool)?)
}

async fn browser_attach(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = ctx.agent_id.clone();
    browser_check(ctx, "attach", agent_id.as_deref()).await?;
    let target = arg_str(args, "targetId")
        .ok_or_else(|| ToolError::InvalidArgs("browser_attach: missing 'targetId'".into()))?;
    text(crate::cdp::cdp_attach(&target, agent_id.as_deref()).map_err(ToolError::Tool)?)
}

async fn browser_inspect(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "inspect", agent_id.as_deref()).await?;
    let selector = arg_str(args, "selector")
        .ok_or_else(|| ToolError::InvalidArgs("browser_inspect: missing 'selector'".into()))?;
    let props = args.get("props").and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<String>>()
    });
    let max_results = args.get("maxResults").and_then(|v| v.as_u64()).map(|n| n as usize);
    text(
        crate::cdp::cdp_inspect(&selector, props, max_results, agent_id.as_deref())
            .await
            .map_err(ToolError::Tool)?,
    )
}

async fn browser_report(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "report", agent_id.as_deref()).await?;
    let scope = arg_str(args, "scope");
    text(crate::cdp::cdp_report(scope, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_snapshot(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "snapshot", agent_id.as_deref()).await?;
    let scope = arg_str(args, "scope");
    let max_results = args.get("maxResults").and_then(|v| v.as_u64()).map(|n| n as usize);
    let offset = args.get("offset").and_then(|v| v.as_u64()).map(|n| n as usize);
    text(crate::cdp::cdp_snapshot(scope, max_results, offset, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_content(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "content", agent_id.as_deref()).await?;
    let scope = arg_str(args, "scope");
    let format = arg_str(args, "format");
    let max_chars = args.get("maxChars").and_then(|v| v.as_u64()).map(|n| n as usize);
    let offset = args.get("offset").and_then(|v| v.as_u64()).map(|n| n as usize);
    text(crate::cdp::cdp_content(scope, format, max_chars, offset, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_console(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "console", agent_id.as_deref()).await?;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
    text(crate::cdp::cdp_console(agent_id.as_deref(), limit))
}

async fn browser_network(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "network", agent_id.as_deref()).await?;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
    text(crate::cdp::cdp_network(agent_id.as_deref(), limit))
}

async fn browser_network_detail(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "network_detail", agent_id.as_deref()).await?;
    let request_id = arg_str(args, "requestId")
        .ok_or_else(|| ToolError::InvalidArgs("browser_network_detail: missing 'requestId'".into()))?;
    text(crate::cdp::cdp_network_detail(&request_id, agent_id.as_deref()).map_err(ToolError::Tool)?)
}

async fn browser_network_har(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "network_har", agent_id.as_deref()).await?;
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
    text(crate::cdp::cdp_network_har(agent_id.as_deref(), limit).map_err(ToolError::Tool)?)
}

async fn browser_screenshot(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "screenshot", agent_id.as_deref()).await?;
    let full_page = args.get("fullPage").and_then(|v| v.as_bool()).unwrap_or(false);
    let inline = args.get("inline").and_then(|v| v.as_bool()).unwrap_or(false);
    text(crate::cdp::cdp_screenshot(full_page, inline, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_viewport(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_viewport: self 会话只读，不能操作自家 webview".into()));
    }
    browser_check(ctx, "viewport", agent_id.as_deref()).await?;
    let width = args.get("width")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| ToolError::InvalidArgs("browser_viewport: missing or invalid 'width'".into()))?;
    let height = args.get("height")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| ToolError::InvalidArgs("browser_viewport: missing or invalid 'height'".into()))?;
    let device_scale_factor = args.get("deviceScaleFactor").and_then(|v| v.as_f64());
    let mobile = args.get("mobile").and_then(|v| v.as_bool());
    text(
        crate::cdp::cdp_set_viewport(width, height, device_scale_factor, mobile, agent_id.as_deref())
            .await
            .map_err(ToolError::Tool)?,
    )
}

async fn browser_audit(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    browser_check(ctx, "audit", None).await?;
    let agent = arg_str(args, "agent");
    let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
    text(crate::cdp::cdp_audit(agent.as_deref(), limit))
}

async fn browser_click(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_click: self 会话只读，不能操作自家 webview".into()));
    }
    let selector = arg_str(args, "selector")
        .ok_or_else(|| ToolError::InvalidArgs("browser_click: missing 'selector'".into()))?;
    browser_check(ctx, "click", agent_id.as_deref()).await?;
    // 敏感目标（提交按钮/下载/中英文高危文本）→ 每次单独 Ask（ADR 0003 D6 L3）
    if crate::cdp::check_sensitive(&selector, "click", agent_id.as_deref()).await {
        browser_check(ctx, "click_sensitive", agent_id.as_deref()).await?;
    }
    text(crate::cdp::cdp_click(&selector, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_type(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_type: self 会话只读，不能操作自家 webview".into()));
    }
    let selector = arg_str(args, "selector")
        .ok_or_else(|| ToolError::InvalidArgs("browser_type: missing 'selector'".into()))?;
    let text_v = arg_str(args, "text")
        .ok_or_else(|| ToolError::InvalidArgs("browser_type: missing 'text'".into()))?;
    let replace = args.get("replace").and_then(|v| v.as_bool()).unwrap_or(false);
    browser_check(ctx, "type", agent_id.as_deref()).await?;
    // 敏感目标（已填值输入框/密码框）→ 每次单独 Ask（ADR 0003 D6 L3）
    if crate::cdp::check_sensitive(&selector, "type", agent_id.as_deref()).await {
        browser_check(ctx, "type_sensitive", agent_id.as_deref()).await?;
    }
    text(crate::cdp::cdp_type(&selector, &text_v, replace, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_press(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_press: self 会话只读，不能操作自家 webview".into()));
    }
    let key = arg_str(args, "key")
        .ok_or_else(|| ToolError::InvalidArgs("browser_press: missing 'key'".into()))?;
    let modifiers = args.get("modifiers").and_then(|v| v.as_array()).map(|arr| {
        arr.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<String>>()
    });
    browser_check(ctx, "press", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_press(&key, modifiers, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_hover(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_hover: self 会话只读，不能操作自家 webview".into()));
    }
    let selector = arg_str(args, "selector")
        .ok_or_else(|| ToolError::InvalidArgs("browser_hover: missing 'selector'".into()))?;
    browser_check(ctx, "hover", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_hover(&selector, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_dialog(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    let accept = args.get("accept").and_then(|v| v.as_bool());
    if accept.is_some() {
        if crate::cdp::is_self(agent_id.as_deref()) {
            return Err(ToolError::Tool("browser_dialog: self 会话只读，不能操作自家 webview".into()));
        }
        browser_check(ctx, "dialog", agent_id.as_deref()).await?;
        let prompt_text = arg_str(args, "promptText");
        text(crate::cdp::cdp_handle_dialog(accept.unwrap_or(false), prompt_text, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
    } else {
        // 只查询 pending/最近 dialog；self 通道也可用。
        browser_check(ctx, "dialog_query", agent_id.as_deref()).await?;
        let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
        text(crate::cdp::cdp_dialogs(agent_id.as_deref(), limit))
    }
}

async fn browser_upload(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_upload: self 会话只读，不能操作自家 webview".into()));
    }
    let selector = arg_str(args, "selector");
    let files: Vec<String> = args.get("files")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .ok_or_else(|| ToolError::InvalidArgs("browser_upload: missing 'files'".into()))?;
    browser_check(ctx, "upload", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_upload(selector, files, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_new_tab(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_new_tab: self 会话只读，不能操作自家 webview".into()));
    }
    browser_check(ctx, "new_tab", agent_id.as_deref()).await?;
    let url = arg_str(args, "url");
    text(crate::cdp::cdp_new_tab(url, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_close_tab(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_close_tab: self 会话只读，不能操作自家 webview".into()));
    }
    let target_id = arg_str(args, "targetId")
        .ok_or_else(|| ToolError::InvalidArgs("browser_close_tab: missing 'targetId'".into()))?;
    browser_check(ctx, "close_tab", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_close_tab(&target_id, agent_id.as_deref()).map_err(ToolError::Tool)?)
}

async fn browser_scroll(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_scroll: self 会话只读，不能操作自家 webview".into()));
    }
    let selector = arg_str(args, "selector");
    let direction = arg_str(args, "direction");
    browser_check(ctx, "scroll", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_scroll(selector, direction, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_navigate(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_navigate: self 会话只读，不能操作自家 webview".into()));
    }
    let url = arg_str(args, "url")
        .ok_or_else(|| ToolError::InvalidArgs("browser_navigate: missing 'url'".into()))?;
    browser_check(ctx, "navigate", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_navigate(&url, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_back(ctx: &ToolContext<'_>, _args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, _args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_back: self 会话只读，不能操作自家 webview".into()));
    }
    browser_check(ctx, "back", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_back(agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_forward(ctx: &ToolContext<'_>, _args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, _args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_forward: self 会话只读，不能操作自家 webview".into()));
    }
    browser_check(ctx, "forward", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_forward(agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_reload(ctx: &ToolContext<'_>, _args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, _args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_reload: self 会话只读，不能操作自家 webview".into()));
    }
    browser_check(ctx, "reload", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_reload(agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_select(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = self_or_agent(ctx, args);
    if crate::cdp::is_self(agent_id.as_deref()) {
        return Err(ToolError::Tool("browser_select: self 会话只读，不能操作自家 webview".into()));
    }
    let selector = arg_str(args, "selector")
        .ok_or_else(|| ToolError::InvalidArgs("browser_select: missing 'selector'".into()))?;
    let value = arg_str(args, "value")
        .ok_or_else(|| ToolError::InvalidArgs("browser_select: missing 'value'".into()))?;
    browser_check(ctx, "select", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_select(&selector, &value, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_wait(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    // 只读等待(selector 出现或固定 ms)，不改变状态；Deny 仍生效
    let agent_id = self_or_agent(ctx, args);
    browser_check(ctx, "wait", agent_id.as_deref()).await?;
    let selector = arg_str(args, "selector");
    let ms = args.get("ms").and_then(|v| v.as_u64());
    text(crate::cdp::cdp_wait(selector, ms, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_eval(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = ctx.agent_id.clone();
    browser_check(ctx, "eval", agent_id.as_deref()).await?;
    let expr = arg_str(args, "expr")
        .ok_or_else(|| ToolError::InvalidArgs("browser_eval: missing 'expr'".into()))?;
    text(crate::cdp::cdp_eval(&expr, agent_id.as_deref()).await.map_err(ToolError::Tool)?)
}

async fn browser_status(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    browser_check(ctx, "status", agent_id.as_deref()).await?;
    text(crate::cdp::cdp_status(agent_id.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        let m: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.browser");
        assert_eq!(m.trust, super::super::manifest::TrustLevel::System);
        assert_eq!(m.tools.len(), 37);
        // §8.6：browser/uia 不写 manifest permission（权限整体留插件内业务自检）。
        for t in &m.tools {
            assert!(t.permission.is_none(), "builtin.browser {}.permission 必须为 None（§8 裁决）", t.name);
        }
        for name in ["browser_launch", "browser_click", "browser_status"] {
            assert!(m.tools.iter().any(|t| t.name == name), "{name} 在清单内");
        }
    }
}


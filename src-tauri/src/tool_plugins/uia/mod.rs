// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

//! builtin.uia 插件——内核插件运行时 Phase 5（自 rpc.rs desktop 分区拆出）。
//! 工具面真源 = 同目录 manifest.json（npm run gen:kernel-manifest uia 发射）。
//!
//! 权限形状（§8 裁决）：**不进 manifest permission**——插件内业务自检。
//! dispatch 侧 adapter 恒 Passthrough；各业务函数照旧构造 DesktopTool 经
//! ctx.check_permission 过闸。desktop_uia_write 的 resolve → classify →
//! grant → lease 全链原样迁入（六层权限 + 输入租约 + 逐动作审计，
//! tools/mod.rs DesktopTool / classify_uia_action / uia_action_needs_physical
//! 保留不动——插件内真权检查的依赖）。
//!
//! 参数键说 manifest schema 的语言（desktop_uia_* 为 snake_case：max_results /
//! control_type / automation_id / timeout_ms——desktop 面 zod 键即 snake，与
//! 旧 RPC 分支同键；信封 args 不经 bridge 转换，原样到达）。

use serde_json::Value;

use super::manifest::ToolManifest;
use super::plugin::{arg_str, ToolContext, ToolError, ToolPlugin};

pub struct UiaPlugin {
    manifest: ToolManifest,
}

impl UiaPlugin {
    pub fn new() -> Self {
        let manifest: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("builtin.uia manifest 是随 exe 编译的静态资源");
        Self { manifest }
    }
}

impl Default for UiaPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlugin for UiaPlugin {
    fn id(&self) -> &str {
        "builtin.uia"
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
                "desktop_probe" => desktop_probe(ctx, &args).await,
                "desktop_screenshot" => desktop_screenshot(ctx, &args).await,
                "desktop_uia_tree" => desktop_uia_tree(ctx, &args).await,
                "desktop_uia_find" => desktop_uia_find(ctx, &args).await,
                "desktop_uia_read" => desktop_uia_read(ctx, &args).await,
                "desktop_uia_wait" => desktop_uia_wait(ctx, &args).await,
                "desktop_uia_click" => desktop_uia_click(ctx, &args).await,
                "desktop_uia_right_click" => desktop_uia_right_click(ctx, &args).await,
                "desktop_uia_type" => desktop_uia_type(ctx, &args).await,
                "desktop_uia_scroll" => desktop_uia_scroll(ctx, &args).await,
                "desktop_uia_select" => desktop_uia_select(ctx, &args).await,
                "desktop_uia_expand" => desktop_uia_expand(ctx, &args).await,
                "desktop_uia_keys" => desktop_uia_keys(ctx, &args).await,
                "desktop_uia_activate" => desktop_uia_activate(ctx, &args).await,
                "desktop_uia_window_shot" => desktop_uia_window_shot(ctx, &args).await,
                "desktop_audit" => desktop_audit(ctx, &args).await,
                "desktop_status" => desktop_status(ctx, &args).await,
                other => Err(ToolError::InvalidArgs(format!("builtin.uia: 未知工具 '{other}'"))),
            }
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 rpc.rs desktop 分区原样迁入；参数键 = manifest 语言；
// 权限 = ctx.check_permission(&DesktopTool{action})——§8.3 形态）
// ═══════════════════════════════════════════════════════════════

/// text 结果直通。
fn text(s: String) -> Result<Value, ToolError> {
    Ok(Value::String(s))
}

fn agent_of(ctx: &ToolContext<'_>, args: &Value) -> Option<String> {
    ctx.agent_id.clone().or_else(|| arg_str(args, "_agent_id"))
}

fn opt_u32_of(args: &Value, k: &str) -> Option<u32> {
    args.get(k).and_then(|v| v.as_u64()).map(|n| n as u32)
}

fn opt_u64_of(args: &Value, k: &str) -> Option<u64> {
    args.get(k).and_then(|v| v.as_u64())
}

fn opt_usize_of(args: &Value, k: &str) -> Option<usize> {
    args.get(k).and_then(|v| v.as_u64()).map(|n| n as usize)
}

/// 工具级权限过闸（DesktopTool 承载六层语义）。
async fn desktop_check(ctx: &ToolContext<'_>, agent_id: Option<&str>, action: &str) -> Result<(), ToolError> {
    let tool = crate::tools::DesktopTool {
        action: action.into(),
        agent_id: agent_id.map(String::from),
        hwnd: None,
        window_title: None,
    };
    ctx.check_permission(&tool).await.map_err(ToolError::Permission)
}

async fn desktop_probe(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    desktop_check(ctx, agent_id.as_deref(), "probe").await?;
    // 只读快照:进程/窗口/控制台可见性,纯查询
    let base = crate::desktop::desktop_probe().map_err(ToolError::Tool)?;
    // 通道路由建议：chromium 窗口→cdp；其余按 UIA interactive 探测→uia/vision
    let route = args.get("route").and_then(|v| v.as_bool()).unwrap_or(true);
    if !route {
        return text(base);
    }
    let mut v: serde_json::Value = serde_json::from_str(&base)
        .map_err(|e| ToolError::Tool(format!("desktop_probe: 解析快照失败: {e}")))?;
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
    text(v.to_string())
}

async fn desktop_screenshot(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    // 高隐私面:DesktopTool 第 8 层 Ask(已从 read-only 移除)
    desktop_check(ctx, agent_id.as_deref(), "screenshot").await?;
    text(crate::desktop::desktop_screenshot().map_err(ToolError::Tool)?)
}

async fn desktop_uia_tree(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    desktop_check(ctx, agent_id.as_deref(), "uia_tree").await?;
    // 只读:窗口 UIA 控件树 + ref 清单(默认 interactive-only,分页)
    text(
        crate::uia::uia_tree(
            arg_str(args, "title").as_deref(),
            opt_u32_of(args, "pid"),
            opt_u64_of(args, "hwnd"),
            opt_u32_of(args, "depth"),
            args.get("all").and_then(|v| v.as_bool()).unwrap_or(false),
            opt_usize_of(args, "offset").unwrap_or(0),
            opt_usize_of(args, "max_results").unwrap_or(0),
        )
        .await
        .map_err(ToolError::Tool)?,
    )
}

async fn desktop_uia_find(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    desktop_check(ctx, agent_id.as_deref(), "uia_find").await?;
    // 只读:按条件在窗口内查找控件
    text(
        crate::uia::uia_find(
            arg_str(args, "title").as_deref(),
            opt_u32_of(args, "pid"),
            opt_u64_of(args, "hwnd"),
            arg_str(args, "name").as_deref(),
            arg_str(args, "control_type").as_deref(),
            arg_str(args, "automation_id").as_deref(),
            args.get("enabled").and_then(|v| v.as_bool()),
        )
        .await
        .map_err(ToolError::Tool)?,
    )
}


async fn desktop_uia_read(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    desktop_check(ctx, agent_id.as_deref(), "uia_read").await?;
    // 只读:单控件全量详情(value/toggle/expand/rect/patterns)
    text(
        crate::uia::uia_read(
            arg_str(args, "title").as_deref(),
            opt_u32_of(args, "pid"),
            opt_u64_of(args, "hwnd"),
            opt_u32_of(args, "ref"),
            arg_str(args, "name").as_deref(),
            arg_str(args, "automation_id").as_deref(),
            arg_str(args, "control_type").as_deref(),
        )
        .await
        .map_err(ToolError::Tool)?,
    )
}

async fn desktop_uia_wait(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    desktop_check(ctx, agent_id.as_deref(), "uia_wait").await?;
    // 只读:轮询等待控件出现/启用/值匹配(超时返回 found:false,不报错)
    let until = arg_str(args, "until")
        .ok_or_else(|| ToolError::InvalidArgs("desktop_uia_wait: missing 'until'".into()))?;
    text(
        crate::uia::uia_wait(
            arg_str(args, "title").as_deref(),
            opt_u32_of(args, "pid"),
            opt_u64_of(args, "hwnd"),
            opt_u32_of(args, "ref"),
            arg_str(args, "name").as_deref(),
            arg_str(args, "automation_id").as_deref(),
            arg_str(args, "control_type").as_deref(),
            &until,
            arg_str(args, "value").as_deref(),
            args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(10_000),
        )
        .await
        .map_err(ToolError::Tool)?,
    )
}

async fn desktop_uia_click(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    desktop_uia_write(ctx, args, "click").await
}

async fn desktop_uia_right_click(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    desktop_uia_write(ctx, args, "right_click").await
}

async fn desktop_uia_type(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    desktop_uia_write(ctx, args, "type").await
}

async fn desktop_uia_scroll(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    desktop_uia_write(ctx, args, "scroll").await
}

async fn desktop_uia_select(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    desktop_uia_write(ctx, args, "select").await
}

async fn desktop_uia_expand(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    desktop_uia_write(ctx, args, "expand").await
}

/// UIA 写动作统一编排（click/right_click/type/scroll/select/expand）。
/// 自 rpc.rs desktop_uia_write 原样迁入：只读 resolve → classify_uia_action →
/// DesktopTool 过闸 → grant →（物理路径）输入租约 → 执行 → 逐动作审计。
async fn desktop_uia_write(ctx: &ToolContext<'_>, args: &Value, kind: &str) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    let title = arg_str(args, "title");
    let pid = opt_u32_of(args, "pid");
    let hwnd = opt_u64_of(args, "hwnd");
    let ref_id = opt_u32_of(args, "ref");
    let name = arg_str(args, "name");
    let aid = arg_str(args, "automation_id");
    let ctype = arg_str(args, "control_type");

    if ref_id.is_none() && name.is_none() && aid.is_none() && ctype.is_none() {
        return Err(ToolError::InvalidArgs(format!(
            "desktop_uia_{kind}: 至少要给一个定位条件 (ref / name / automation_id / control_type)"
        )));
    }

    // 只读解析（分类前置步骤，等同 tree 读取的权限面）
    let res = crate::uia::resolve(
        title.as_deref(), pid, hwnd, ref_id, name.as_deref(), aid.as_deref(), ctype.as_deref(),
    )
    .await
    .map_err(ToolError::Tool)?;
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
        let tool = crate::tools::DesktopTool {
            action: tool_action.into(),
            agent_id: agent_id.clone(),
            hwnd: res_hwnd,
            window_title: Some(res_title.clone()),
        };
        if let Err(e) = ctx.check_permission(&tool).await {
            crate::uia::desktop_audit_log(
                agent_id.as_deref(),
                &format!("desktop_uia_{kind}_denied"),
                &target_desc,
                &e,
            );
            return Err(ToolError::Permission(e));
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
    let text_v = if kind == "type" {
        Some(arg_str(args, "text").ok_or_else(|| ToolError::InvalidArgs("desktop_uia_type: missing 'text'".into()))?)
    } else { None };
    let direction = if kind == "scroll" {
        Some(arg_str(args, "direction").ok_or_else(|| ToolError::InvalidArgs("desktop_uia_scroll: missing 'direction'".into()))?)
    } else { None };
    let amount = args.get("amount").and_then(|v| v.as_f64());
    let exec = async {
        match kind {
            "click" => {
                crate::uia::uia_click(title.as_deref(), pid, hwnd, ref_id, name.as_deref(), aid.as_deref(), ctype.as_deref(), false, allow_physical).await
            }
            "right_click" => {
                crate::uia::uia_click(title.as_deref(), pid, hwnd, ref_id, name.as_deref(), aid.as_deref(), ctype.as_deref(), true, allow_physical).await
            }
            "type" => {
                crate::uia::uia_type(title.as_deref(), pid, hwnd, ref_id, text_v.as_deref().unwrap_or(""), name.as_deref(), aid.as_deref(), ctype.as_deref(), allow_physical).await
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
    text(outcome.map_err(ToolError::Tool)?)
}

/// desktop_uia_keys — 热键（物理输入：Ask + 输入租约）。
async fn desktop_uia_keys(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    let title = arg_str(args, "title");
    let key = arg_str(args, "key")
        .ok_or_else(|| ToolError::InvalidArgs("desktop_uia_keys: missing 'key'".into()))?;
    let modifiers: Vec<String> = args.get("modifiers")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    {
        let tool = crate::tools::DesktopTool {
            action: "uia_keys".into(),
            agent_id: agent_id.clone(),
            hwnd: opt_u64_of(args, "hwnd"),
            window_title: title.clone(),
        };
        if let Err(e) = ctx.check_permission(&tool).await {
            crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_keys_denied", &format!("key={key}"), &e);
            return Err(ToolError::Permission(e));
        }
    }
    let lease = crate::uia::acquire_input_lease(agent_id.as_deref(), std::time::Duration::from_secs(3)).await;
    let outcome = match lease {
        Ok(_l) => {
            crate::uia::uia_keys(title.as_deref(), opt_u32_of(args, "pid"), opt_u64_of(args, "hwnd"), modifiers.clone(), &key).await
        }
        Err(e) => Err(e),
    };
    match &outcome {
        Ok(s) => crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_keys", &format!("mods={modifiers:?} key={key}"), s),
        Err(e) => crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_keys_failed", &format!("mods={modifiers:?} key={key}"), e),
    }
    text(outcome.map_err(ToolError::Tool)?)
}

/// desktop_uia_activate — 窗口提前台（物理输入：Ask + 输入租约）。
async fn desktop_uia_activate(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    let title = arg_str(args, "title");
    let hwnd = opt_u64_of(args, "hwnd");
    {
        let tool = crate::tools::DesktopTool {
            action: "uia_activate".into(),
            agent_id: agent_id.clone(),
            hwnd,
            window_title: title.clone(),
        };
        if let Err(e) = ctx.check_permission(&tool).await {
            crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_activate_denied", &format!("hwnd={hwnd:?}"), &e);
            return Err(ToolError::Permission(e));
        }
    }
    let lease = crate::uia::acquire_input_lease(agent_id.as_deref(), std::time::Duration::from_secs(3)).await;
    let outcome = match lease {
        Ok(_l) => crate::uia::uia_activate(title.as_deref(), opt_u32_of(args, "pid"), hwnd).await,
        Err(e) => Err(e),
    };
    match &outcome {
        Ok(s) => crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_activate", &format!("hwnd={hwnd:?}"), s),
        Err(e) => crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_activate_failed", &format!("hwnd={hwnd:?}"), e),
    }
    text(outcome.map_err(ToolError::Tool)?)
}

/// desktop_uia_window_shot — 按窗口矩形截图（worker 定位 + PS GDI 捕获）。
async fn desktop_uia_window_shot(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    desktop_check(ctx, agent_id.as_deref(), "uia_window_shot").await?;
    // 只读:按窗口矩形截图(非全屏,隐私面更小)
    text(
        crate::uia::uia_window_shot(
            arg_str(args, "title").as_deref(),
            opt_u32_of(args, "pid"),
            opt_u64_of(args, "hwnd"),
        )
        .await
        .map_err(ToolError::Tool)?,
    )
}

/// desktop_audit — 只读:desktop 操作审计查询(对齐 browser_audit)。
async fn desktop_audit(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    desktop_check(ctx, agent_id.as_deref(), "audit").await?;
    text(crate::uia::desktop_audit_query(
        agent_id.as_deref(),
        args.get("limit").and_then(|v| v.as_u64()).map(|l| l as usize),
    ))
}

/// desktop_status — 只读:窗口授权(grants) + 输入租约持有者。
async fn desktop_status(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let agent_id = agent_of(ctx, args);
    desktop_check(ctx, agent_id.as_deref(), "probe").await?;
    text(
        serde_json::json!({
            "grants": crate::uia::list_grants().iter()
                .map(|(a, h, ttl)| serde_json::json!({ "agent": a, "hwnd": h, "ttl_secs": ttl }))
                .collect::<Vec<_>>(),
            "input_lease_holder": crate::uia::lease_holder(),
        })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        let m: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.uia");
        assert_eq!(m.trust, super::super::manifest::TrustLevel::System);
        assert_eq!(m.tools.len(), 17);
        // §8.6：browser/uia 不写 manifest permission（权限整体留插件内业务自检）。
        for t in &m.tools {
            assert!(t.permission.is_none(), "builtin.uia {}.permission 必须为 None（§8 裁决）", t.name);
        }
        for name in ["desktop_probe", "desktop_uia_click", "desktop_status"] {
            assert!(m.tools.iter().any(|t| t.name == name), "{name} 在清单内");
        }
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// uia 能力口（R4，kernel-capability-d4-handle-design.md）——句柄域 desktop 族。
//
// 能力口语义：模型族 TS 工具（browser.ts desktop 半区）经 RPC 直呼，不经
// tool_call 信封 / PluginRegistry / PluginToolAdapter（builtin.uia 插件随 R4-3
// 退役）。单方法 + action 分派（对标 browser_cap），action = 退役前
// builtin.uia 17 工具名（一位一动作）。
//
// 口内闸（v3 §1 + D4-4/D4-5 裁定）：直接构造 DesktopTool 过
// crate::utils::check_permission——**无条件过闸**（插件原语义）+ **不构造
// adapter**（manifest 零 permission）。六层权限（probe/只读放行 → 窗口接管
// grant 一次 → 敏感目标/物理输入单独 Ask）+ desktop_uia_write 的
// resolve → classify_uia_action → grant →（物理路径）acquire_input_lease →
// 执行 → 逐动作审计全链在口内业务自检（单键 adapter 表达不了——
// shell/browser 同形）。
//
// INVARIANTS #13 零触碰：IUIAutomationElement 只活在 worker.rs 专用线程
// （本口经 crate::uia 公开函数间接走 worker request 通道，COM 不跨线程）；
// 一切物理输入（keys/activate/坐标点击/滚轮）必经 acquire_input_lease；
// pattern 类动作不抢焦点。grants.rs / worker.rs / com.rs 本体零改动。
//
// 键语言：desktop 面 manifest 键本就是 snake_case——口收顶层 snake 无映射
// （D4-6）；meta `_agent_id`/`_owner_id` 原样透传（bridge.rpc() 幂等）。
// 参数物理校验（至少一个定位条件）在口内（插件原语义）。

use serde_json::Value;
use tauri::State;

/// 口内闸句柄（与 browser_cap::BrowserGate 同形——uia 面工具名/形状不同）。
pub(crate) struct UiaGate<'a> {
    pub agent_id: Option<String>,
    pub state: &'a State<'a, crate::WorkspaceState>,
    pub app: &'a tauri::AppHandle,
}

/// 原始过闸（错误不带前缀——调用方按需审计原文再自行加「权限拒绝: 」前缀，
/// desktop_uia_write/keys/activate 的 deny 审计路径需要原文）。
async fn check_desktop_raw(
    tool: &crate::tools::DesktopTool,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let perm_ctx = crate::utils::get_ctx(state)?;
    crate::utils::check_permission(tool, &perm_ctx, app).await
}

impl UiaGate<'_> {
    /// 工具级权限过闸（DesktopTool 承载六层语义）。无条件过闸（D4-5：插件
    /// 原语义）。错误统一「权限拒绝: 」前缀（ToolError::Permission.message()
    /// 的最终字符串等价）。
    pub async fn check(&self, action: &str, agent_id: Option<&str>) -> Result<(), String> {
        let tool = crate::tools::DesktopTool {
            action: action.into(),
            agent_id: agent_id.map(String::from),
            hwnd: None,
            window_title: None,
        };
        check_desktop_raw(&tool, self.state, self.app)
            .await
            .map_err(|m| format!("权限拒绝: {m}"))
    }
}

// ── 参数提取（顶层 snake 键；键名 = manifest 语言，无映射）──

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
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

/// 读侧 agent 路由（_agent_id meta 由 rpc.rs 抽出，args 内兜底读取保留——
/// 插件 agent_of 原语义）。
fn agent_of(gate: &UiaGate<'_>, args: &Value) -> Option<String> {
    gate.agent_id.clone().or_else(|| arg_str(args, "_agent_id"))
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 tool_plugins/uia/mod.rs 逐行为迁入；text() 直通内联为
// Result<String, String>——错误串即最终形态）
// ═══════════════════════════════════════════════════════════════

async fn desktop_probe(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("probe", agent_id.as_deref()).await?;
    // 只读快照:进程/窗口/控制台可见性,纯查询
    let base = crate::desktop::desktop_probe()?;
    // 通道路由建议：chromium 窗口→cdp；其余按 UIA interactive 探测→uia/vision
    let route = args.get("route").and_then(|v| v.as_bool()).unwrap_or(true);
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

async fn desktop_screenshot(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    // 高隐私面:DesktopTool 第 8 层 Ask(已从 read-only 移除)
    gate.check("screenshot", agent_id.as_deref()).await?;
    crate::desktop::desktop_screenshot()
}

async fn desktop_uia_tree(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("uia_tree", agent_id.as_deref()).await?;
    // 只读:窗口 UIA 控件树 + ref 清单(默认 interactive-only,分页)
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
}

async fn desktop_uia_find(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("uia_find", agent_id.as_deref()).await?;
    // 只读:按条件在窗口内查找控件
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
}

async fn desktop_uia_read(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("uia_read", agent_id.as_deref()).await?;
    // 只读:单控件全量详情(value/toggle/expand/rect/patterns)
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
}

async fn desktop_uia_wait(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("uia_wait", agent_id.as_deref()).await?;
    // 只读:轮询等待控件出现/启用/值匹配(超时返回 found:false,不报错)
    let until = arg_str(args, "until")
        .ok_or_else(|| "desktop_uia_wait: missing 'until'".to_string())?;
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
}

/// UIA 写动作统一编排（click/right_click/type/scroll/select/expand）。
/// 自 rpc.rs desktop_uia_write 原样迁入（经 builtin.uia 插件中转）：只读
/// resolve → classify_uia_action → DesktopTool 过闸 → grant →（物理路径）
/// 输入租约 → 执行 → 逐动作审计。
async fn desktop_uia_write(gate: &UiaGate<'_>, args: &Value, kind: &str) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    let title = arg_str(args, "title");
    let pid = opt_u32_of(args, "pid");
    let hwnd = opt_u64_of(args, "hwnd");
    let ref_id = opt_u32_of(args, "ref");
    let name = arg_str(args, "name");
    let aid = arg_str(args, "automation_id");
    let ctype = arg_str(args, "control_type");

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

    // 权限（Ask 由 check_permission 内部走异步确认；deny 原文进审计）
    {
        let tool = crate::tools::DesktopTool {
            action: tool_action.into(),
            agent_id: agent_id.clone(),
            hwnd: res_hwnd,
            window_title: Some(res_title.clone()),
        };
        if let Err(e) = check_desktop_raw(&tool, gate.state, gate.app).await {
            crate::uia::desktop_audit_log(
                agent_id.as_deref(),
                &format!("desktop_uia_{kind}_denied"),
                &target_desc,
                &e,
            );
            return Err(format!("权限拒绝: {e}"));
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
        Some(arg_str(args, "text").ok_or_else(|| "desktop_uia_type: missing 'text'".to_string())?)
    } else { None };
    let direction = if kind == "scroll" {
        Some(arg_str(args, "direction").ok_or_else(|| "desktop_uia_scroll: missing 'direction'".to_string())?)
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
    outcome
}

/// desktop_uia_keys — 热键（物理输入：Ask + 输入租约）。
async fn desktop_uia_keys(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    let title = arg_str(args, "title");
    let key = arg_str(args, "key")
        .ok_or_else(|| "desktop_uia_keys: missing 'key'".to_string())?;
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
        if let Err(e) = check_desktop_raw(&tool, gate.state, gate.app).await {
            crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_keys_denied", &format!("key={key}"), &e);
            return Err(format!("权限拒绝: {e}"));
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
    outcome
}

/// desktop_uia_activate — 窗口提前台（物理输入：Ask + 输入租约）。
async fn desktop_uia_activate(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    let title = arg_str(args, "title");
    let hwnd = opt_u64_of(args, "hwnd");
    {
        let tool = crate::tools::DesktopTool {
            action: "uia_activate".into(),
            agent_id: agent_id.clone(),
            hwnd,
            window_title: title.clone(),
        };
        if let Err(e) = check_desktop_raw(&tool, gate.state, gate.app).await {
            crate::uia::desktop_audit_log(agent_id.as_deref(), "desktop_uia_activate_denied", &format!("hwnd={hwnd:?}"), &e);
            return Err(format!("权限拒绝: {e}"));
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
    outcome
}

/// desktop_uia_window_shot — 按窗口矩形截图（worker 定位 + PS GDI 捕获）。
async fn desktop_uia_window_shot(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("uia_window_shot", agent_id.as_deref()).await?;
    // 只读:按窗口矩形截图(非全屏,隐私面更小)
    crate::uia::uia_window_shot(
        arg_str(args, "title").as_deref(),
        opt_u32_of(args, "pid"),
        opt_u64_of(args, "hwnd"),
    )
    .await
}

/// desktop_audit — 只读:desktop 操作审计查询(对齐 browser_audit)。
async fn desktop_audit(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("audit", agent_id.as_deref()).await?;
    Ok(crate::uia::desktop_audit_query(
        agent_id.as_deref(),
        args.get("limit").and_then(|v| v.as_u64()).map(|l| l as usize),
    ))
}

/// desktop_status — 只读:窗口授权(grants) + 输入租约持有者。
async fn desktop_status(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("probe", agent_id.as_deref()).await?;
    Ok(
        serde_json::json!({
            "grants": crate::uia::list_grants().iter()
                .map(|(a, h, ttl)| serde_json::json!({ "agent": a, "hwnd": h, "ttl_secs": ttl }))
                .collect::<Vec<_>>(),
            "input_lease_holder": crate::uia::lease_holder(),
        })
        .to_string(),
    )
}

// ═══════════════════════════════════════════════════════════════
// 分派与入口
// ═══════════════════════════════════════════════════════════════

async fn dispatch_action(gate: &UiaGate<'_>, action: &str, args: &Value) -> Result<String, String> {
    match action {
        "desktop_probe" => desktop_probe(gate, args).await,
        "desktop_screenshot" => desktop_screenshot(gate, args).await,
        "desktop_uia_tree" => desktop_uia_tree(gate, args).await,
        "desktop_uia_find" => desktop_uia_find(gate, args).await,
        "desktop_uia_read" => desktop_uia_read(gate, args).await,
        "desktop_uia_wait" => desktop_uia_wait(gate, args).await,
        "desktop_uia_click" => desktop_uia_write(gate, args, "click").await,
        "desktop_uia_right_click" => desktop_uia_write(gate, args, "right_click").await,
        "desktop_uia_type" => desktop_uia_write(gate, args, "type").await,
        "desktop_uia_scroll" => desktop_uia_write(gate, args, "scroll").await,
        "desktop_uia_select" => desktop_uia_write(gate, args, "select").await,
        "desktop_uia_expand" => desktop_uia_write(gate, args, "expand").await,
        "desktop_uia_keys" => desktop_uia_keys(gate, args).await,
        "desktop_uia_activate" => desktop_uia_activate(gate, args).await,
        "desktop_uia_window_shot" => desktop_uia_window_shot(gate, args).await,
        "desktop_audit" => desktop_audit(gate, args).await,
        "desktop_status" => desktop_status(gate, args).await,
        other => Err(format!("uia_cap: 未知 action '{other}'")),
    }
}

/// uia_cap 能力口分派（R4-3 立口即唯一入口——builtin.uia 同批退役，无信封
/// 过渡面）。action = 退役前 builtin.uia 17 工具名；参数顶层 snake；
/// 返回文本（Text shape——字节精确直通）。
pub(crate) async fn uia_cap(
    action: String,
    params: Value,
    is_agent: bool,
    agent_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    // is_agent 为能力口统一契约键（与 fs/git/process/browser 口同形）；
    // desktop 闸两态通用不过门（D4-5），口内业务不消费。
    let _ = is_agent;
    let gate = UiaGate {
        agent_id,
        state,
        app,
    };
    dispatch_action(&gate, &action, &params).await
}

#[cfg(test)]
mod tests {
    /// 17 动作全集（= 退役前 builtin.uia manifest.tools 名单，D4-1）。
    const ACTIONS: &[&str] = &[
        "desktop_probe",
        "desktop_screenshot",
        "desktop_uia_tree",
        "desktop_uia_find",
        "desktop_uia_read",
        "desktop_uia_wait",
        "desktop_uia_click",
        "desktop_uia_right_click",
        "desktop_uia_type",
        "desktop_uia_scroll",
        "desktop_uia_select",
        "desktop_uia_expand",
        "desktop_uia_keys",
        "desktop_uia_activate",
        "desktop_uia_window_shot",
        "desktop_audit",
        "desktop_status",
    ];

    #[test]
    fn action_table_is_exactly_seventeen_unique() {
        assert_eq!(ACTIONS.len(), 17);
        let mut sorted = ACTIONS.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 17, "动作表不得有重复项");
    }

    /// 写动作（desktop_uia_write 统一编排族）——六层闸 + lease 全链所在。
    #[test]
    fn write_actions_route_through_desktop_uia_write() {
        for a in [
            "desktop_uia_click",
            "desktop_uia_right_click",
            "desktop_uia_type",
            "desktop_uia_scroll",
            "desktop_uia_select",
            "desktop_uia_expand",
        ] {
            assert!(ACTIONS.contains(&a), "{a} 应在动作表内");
        }
    }

    #[test]
    fn unknown_action_errors_loudly() {
        let known: std::collections::HashSet<&str> = ACTIONS.iter().copied().collect();
        for a in ["desktop_frobnicate", "probe", "desktop_uia_", ""] {
            assert!(!known.contains(a), "{a} 不应在 17 动作表内");
        }
    }
}

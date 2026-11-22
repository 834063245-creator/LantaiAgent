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
/// `pub(super)`：批 3 的 uia_batch 子模块复用同一把闸（一次审批覆盖整批）。
pub(super) async fn check_desktop_raw(
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
// pub(super)：批 3 的 uia_batch 子模块按同一口径读步参数（不另开口径）。

pub(super) fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
}

pub(super) fn opt_u32_of(args: &Value, k: &str) -> Option<u32> {
    args.get(k).and_then(|v| v.as_u64()).map(|n| n as u32)
}

/// i32 坐标参数（批 2 坐标模式；屏幕虚拟坐标可能为负——多显示器副屏在主屏左侧/上方）。
pub(super) fn opt_i32_of(args: &Value, k: &str) -> Option<i32> {
    args.get(k)
        .and_then(|v| v.as_i64())
        .and_then(|n| i32::try_from(n).ok())
}

pub(super) fn opt_u64_of(args: &Value, k: &str) -> Option<u64> {
    args.get(k).and_then(|v| v.as_u64())
}

fn opt_usize_of(args: &Value, k: &str) -> Option<usize> {
    args.get(k).and_then(|v| v.as_u64()).map(|n| n as usize)
}

/// 读侧 agent 路由（_agent_id meta 由 rpc.rs 抽出，args 内兜底读取保留——
/// 插件 agent_of 原语义）。
pub(super) fn agent_of(gate: &UiaGate<'_>, args: &Value) -> Option<String> {
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
    let mut v: serde_json::Value =
        serde_json::from_str(&base).map_err(|e| format!("desktop_probe: 解析快照失败: {e}"))?;
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
            let probe = if hwnd != 0 {
                crate::uia::probe_route(hwnd).await
            } else {
                Err("no hwnd".into())
            };
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
    let out = crate::desktop::desktop_screenshot()?;
    // 附图通道（批 1）：全屏截屏**默认不接**——整屏像素进上下文 = 高隐私 + 高 token，
    // 必须调用方显式 attach_image:true 才转附件（窗口截图则默认接，见 window_shot）。
    Ok(if attach_image_arg(args) {
        attach_shot_ref(gate.state, out)
    } else {
        out
    })
}

/// `attach_image` 参数（缺省 false——保守默认：图不进上下文）。
fn attach_image_arg(args: &Value) -> bool {
    args.get("attach_image")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
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
    let until =
        arg_str(args, "until").ok_or_else(|| "desktop_uia_wait: missing 'until'".to_string())?;
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
        args.get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(10_000),
    )
    .await
}

/// UIA 写动作统一编排（click/right_click/type/scroll/select/expand）。
/// 自 rpc.rs desktop_uia_write 原样迁入（经 builtin.uia 插件中转）：只读
/// resolve → classify_uia_action → DesktopTool 过闸 → grant →（物理路径）
/// 输入租约 → 执行 → 逐动作审计。
async fn desktop_uia_write(gate: &UiaGate<'_>, args: &Value, kind: &str) -> Result<String, String> {
    // 批 2（P0-2）坐标模式：x/y 同时给出 → 坐标分支（自绘界面唯一交互路径）。
    if let (Some(x), Some(y)) = (opt_i32_of(args, "x"), opt_i32_of(args, "y")) {
        return desktop_uia_write_at(gate, args, kind, x, y).await;
    }
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
        title.as_deref(),
        pid,
        hwnd,
        ref_id,
        name.as_deref(),
        aid.as_deref(),
        ctype.as_deref(),
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
        if res_aid.is_empty() {
            String::new()
        } else {
            format!(" id={res_aid}")
        },
        res_hwnd
            .map(|h| format!("hwnd={h}"))
            .unwrap_or_else(|| "window".into())
    );

    let caps = crate::tools::UiaTargetCaps {
        has_invoke: g("has_invoke"),
        has_toggle: g("has_toggle"),
        has_select: g("has_select"),
        has_value: g("has_value"),
        has_scroll: g("has_scroll"),
    };
    let granted = crate::uia::has_grant(agent_id.as_deref(), res_hwnd);
    let tool_action =
        crate::tools::classify_uia_action(kind, &res_name, password, cur_value, &caps, granted);

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
    // 批准接管 → 记录 grant（该窗口后续动作放行）。
    // 批 2：物理输入档（无 pattern 的自绘界面）批准一次同样算接管——否则整窗无 pattern
    // 的界面永远拿不到 grant，「接管后放行」对它等于不存在。敏感目标档**不**记 grant
    // （每次单独 Ask 的语义不许被稀释）。
    if matches!(tool_action, "uia_grant" | "uia_physical") {
        if let Some(h) = res_hwnd {
            crate::uia::grant(agent_id.as_deref(), h);
        }
    }
    // 物理执行许可：未授权窗口的物理兜底（Ask 已过）、敏感目标（Ask 已过）、
    // 以及批 2 的「已接管窗口内物理放行」（Passthrough）——同一条执行路径。
    let allow_physical = matches!(
        tool_action,
        "uia_physical" | "uia_physical_granted" | "uia_click_sensitive" | "uia_type_sensitive"
    );

    // 执行（物理兜底路径需先拿全局输入租约）
    let text_v = if kind == "type" {
        Some(arg_str(args, "text").ok_or_else(|| "desktop_uia_type: missing 'text'".to_string())?)
    } else {
        None
    };
    let direction = if kind == "scroll" {
        Some(
            arg_str(args, "direction")
                .ok_or_else(|| "desktop_uia_scroll: missing 'direction'".to_string())?,
        )
    } else {
        None
    };
    let amount = args.get("amount").and_then(|v| v.as_f64());
    let exec = async {
        match kind {
            "click" => {
                crate::uia::uia_click(
                    title.as_deref(),
                    pid,
                    hwnd,
                    ref_id,
                    name.as_deref(),
                    aid.as_deref(),
                    ctype.as_deref(),
                    false,
                    allow_physical,
                )
                .await
            }
            "right_click" => {
                crate::uia::uia_click(
                    title.as_deref(),
                    pid,
                    hwnd,
                    ref_id,
                    name.as_deref(),
                    aid.as_deref(),
                    ctype.as_deref(),
                    true,
                    allow_physical,
                )
                .await
            }
            "type" => {
                crate::uia::uia_type(
                    title.as_deref(),
                    pid,
                    hwnd,
                    ref_id,
                    text_v.as_deref().unwrap_or(""),
                    name.as_deref(),
                    aid.as_deref(),
                    ctype.as_deref(),
                    allow_physical,
                )
                .await
            }
            "scroll" => {
                crate::uia::uia_scroll(
                    title.as_deref(),
                    pid,
                    hwnd,
                    ref_id,
                    direction.as_deref().unwrap_or("down"),
                    amount.unwrap_or(1.0),
                    name.as_deref(),
                    aid.as_deref(),
                    ctype.as_deref(),
                    allow_physical,
                )
                .await
            }
            "select" => {
                crate::uia::uia_select(
                    title.as_deref(),
                    pid,
                    hwnd,
                    ref_id,
                    name.as_deref(),
                    aid.as_deref(),
                    ctype.as_deref(),
                )
                .await
            }
            _ => {
                crate::uia::uia_expand(
                    title.as_deref(),
                    pid,
                    hwnd,
                    ref_id,
                    name.as_deref(),
                    aid.as_deref(),
                    ctype.as_deref(),
                )
                .await
            }
        }
    };
    let outcome = if crate::tools::uia_action_needs_physical(kind, &caps) && allow_physical {
        match crate::uia::acquire_input_lease(
            agent_id.as_deref(),
            std::time::Duration::from_secs(3),
        )
        .await
        {
            Ok(_lease) => exec.await,
            Err(e) => Err(e),
        }
    } else {
        exec.await
    };

    // 逐动作审计（成败都记）
    match &outcome {
        Ok(s) => crate::uia::desktop_audit_log(
            agent_id.as_deref(),
            &format!("desktop_uia_{kind}"),
            &target_desc,
            s,
        ),
        Err(e) => crate::uia::desktop_audit_log(
            agent_id.as_deref(),
            &format!("desktop_uia_{kind}_failed"),
            &target_desc,
            e,
        ),
    }
    outcome
}

/// 坐标模式写动作（批 2，P0-2）：click / right_click / scroll 带 x/y 时进入。
///
/// 与控件模式的区别：**不 resolve 控件**（自绘界面根本没有可 resolve 的控件），但窗口定位
/// 仍必需——授权按 (agent, hwnd) 键控，且 com 侧用窗口 rect 校验坐标边界（防误点其它应用）。
/// 分类走 `click_at` / `right_click_at` / `scroll_at`（天然物理路径）：已接管窗口 → Passthrough，
/// 未接管 → 一次物理 Ask（批准即接管）。敏感词表在坐标模式不适用（拿不到控件名）——
/// 审批文案已写实「该位置是哪一控件由像素决定」。
async fn desktop_uia_write_at(
    gate: &UiaGate<'_>,
    args: &Value,
    kind: &str,
    x: i32,
    y: i32,
) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    let title = arg_str(args, "title");
    let pid = opt_u32_of(args, "pid");
    let hwnd = opt_u64_of(args, "hwnd");
    let at_kind = match kind {
        "click" => "click_at",
        "right_click" => "right_click_at",
        "scroll" => "scroll_at",
        other => {
            return Err(format!(
                "desktop_uia_{other}: 坐标模式只支持 click / right_click / scroll"
            ))
        }
    };
    // 窗口定位（授权键控 + rect 校验口径）
    let info = crate::uia::window_info(title.as_deref(), pid, hwnd).await?;
    let Some(res_hwnd) = info["hwnd"].as_u64() else {
        return Err(format!(
            "desktop_uia_{kind}: 坐标模式必须能定位到窗口（给 hwnd / pid / title 之一）"
        ));
    };
    let res_title = info["title"].as_str().unwrap_or("").to_string();

    let granted = crate::uia::has_grant(agent_id.as_deref(), Some(res_hwnd));
    let tool_action = crate::tools::classify_uia_action(
        at_kind,
        "",
        false,
        "",
        &crate::tools::UiaTargetCaps::default(),
        granted,
    );

    // 权限（Ask 走异步确认；deny 原文进审计）
    {
        let tool = crate::tools::DesktopTool {
            action: tool_action.into(),
            agent_id: agent_id.clone(),
            hwnd: Some(res_hwnd),
            window_title: Some(res_title.clone()),
        };
        if let Err(e) = check_desktop_raw(&tool, gate.state, gate.app).await {
            crate::uia::desktop_audit_log(
                agent_id.as_deref(),
                &format!("desktop_uia_{kind}_at_denied"),
                &format!("at=({x},{y}) hwnd={res_hwnd}"),
                &e,
            );
            return Err(format!("权限拒绝: {e}"));
        }
    }
    // 批准即接管（与控件模式的物理档同语义：敏感目标不在此列）
    if matches!(tool_action, "uia_grant" | "uia_physical") {
        crate::uia::grant(agent_id.as_deref(), res_hwnd);
    }

    let direction = arg_str(args, "direction").unwrap_or_else(|| "down".into());
    let amount = args.get("amount").and_then(|v| v.as_f64()).unwrap_or(1.0);
    let lease =
        crate::uia::acquire_input_lease(agent_id.as_deref(), std::time::Duration::from_secs(3))
            .await;
    let outcome = match lease {
        Ok(_l) => match kind {
            "click" => {
                crate::uia::uia_click_at(title.as_deref(), pid, Some(res_hwnd), x, y, false).await
            }
            "right_click" => {
                crate::uia::uia_click_at(title.as_deref(), pid, Some(res_hwnd), x, y, true).await
            }
            _ => {
                crate::uia::uia_scroll_at(
                    title.as_deref(),
                    pid,
                    Some(res_hwnd),
                    x,
                    y,
                    &direction,
                    amount,
                )
                .await
            }
        },
        Err(e) => Err(e),
    };

    let target_desc = format!("at=({x},{y}) hwnd={res_hwnd}");
    match &outcome {
        Ok(s) => crate::uia::desktop_audit_log(
            agent_id.as_deref(),
            &format!("desktop_uia_{kind}_at"),
            &target_desc,
            s,
        ),
        Err(e) => crate::uia::desktop_audit_log(
            agent_id.as_deref(),
            &format!("desktop_uia_{kind}_at_failed"),
            &target_desc,
            e,
        ),
    }
    outcome
}

/// desktop_uia_keys — 热键（物理输入：Ask + 输入租约）。
async fn desktop_uia_keys(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    let title = arg_str(args, "title");
    let key = arg_str(args, "key").ok_or_else(|| "desktop_uia_keys: missing 'key'".to_string())?;
    let modifiers: Vec<String> = args
        .get("modifiers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    {
        let tool = crate::tools::DesktopTool {
            action: "uia_keys".into(),
            agent_id: agent_id.clone(),
            hwnd: opt_u64_of(args, "hwnd"),
            window_title: title.clone(),
        };
        if let Err(e) = check_desktop_raw(&tool, gate.state, gate.app).await {
            crate::uia::desktop_audit_log(
                agent_id.as_deref(),
                "desktop_uia_keys_denied",
                &format!("key={key}"),
                &e,
            );
            return Err(format!("权限拒绝: {e}"));
        }
    }
    let lease =
        crate::uia::acquire_input_lease(agent_id.as_deref(), std::time::Duration::from_secs(3))
            .await;
    let outcome = match lease {
        Ok(_l) => {
            crate::uia::uia_keys(
                title.as_deref(),
                opt_u32_of(args, "pid"),
                opt_u64_of(args, "hwnd"),
                modifiers.clone(),
                &key,
            )
            .await
        }
        Err(e) => Err(e),
    };
    match &outcome {
        Ok(s) => crate::uia::desktop_audit_log(
            agent_id.as_deref(),
            "desktop_uia_keys",
            &format!("mods={modifiers:?} key={key}"),
            s,
        ),
        Err(e) => crate::uia::desktop_audit_log(
            agent_id.as_deref(),
            "desktop_uia_keys_failed",
            &format!("mods={modifiers:?} key={key}"),
            e,
        ),
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
            crate::uia::desktop_audit_log(
                agent_id.as_deref(),
                "desktop_uia_activate_denied",
                &format!("hwnd={hwnd:?}"),
                &e,
            );
            return Err(format!("权限拒绝: {e}"));
        }
    }
    let lease =
        crate::uia::acquire_input_lease(agent_id.as_deref(), std::time::Duration::from_secs(3))
            .await;
    let outcome = match lease {
        Ok(_l) => crate::uia::uia_activate(title.as_deref(), opt_u32_of(args, "pid"), hwnd).await,
        Err(e) => Err(e),
    };
    match &outcome {
        Ok(s) => crate::uia::desktop_audit_log(
            agent_id.as_deref(),
            "desktop_uia_activate",
            &format!("hwnd={hwnd:?}"),
            s,
        ),
        Err(e) => crate::uia::desktop_audit_log(
            agent_id.as_deref(),
            "desktop_uia_activate_failed",
            &format!("hwnd={hwnd:?}"),
            e,
        ),
    }
    outcome
}

/// desktop_uia_window_shot — 按窗口矩形截图（worker 定位 + PS GDI 捕获）。
async fn desktop_uia_window_shot(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("uia_window_shot", agent_id.as_deref()).await?;
    // 只读:按窗口矩形截图(非全屏,隐私面更小)
    let out = crate::uia::uia_window_shot(
        arg_str(args, "title").as_deref(),
        opt_u32_of(args, "pid"),
        opt_u64_of(args, "hwnd"),
    )
    .await?;
    // 附图通道（批 1）：窗口截图**默认接**——「模型看得见窗口」是自绘应用
    // （微信/QQ/钉钉这类 UIA 树为空的界面）可用的前提。纯增益：转存任何一步
    // 不成 → 输出原样返回（路径仍在，老行为不破）。
    Ok(attach_shot_ref(gate.state, out))
}

// ═══════════════════════════════════════════════════════════════
// 截图附图转存（批 1，P0-1：窗口截图进模型上下文）
// ═══════════════════════════════════════════════════════════════

/// 截图附件转存上限（8MiB，与 fs_cap 读字节上限 / browser 截图同档）——超过则
/// 只回路径，不把巨图灌进用户项目目录。
const SHOT_ATTACH_MAX_BYTES: usize = 8 * 1024 * 1024;

/// 是否本套件自己产的截图（源文件必须落在 uia/cdp 共用截图目录内）——
/// 任何形态的外部路径一律不转附件（防路径注入）。
fn is_shot_path(p: &std::path::Path) -> bool {
    p.parent() == Some(crate::uia::shot_dir().as_path())
}

/// 读一张**本套件自己产**的截图并认出它的真实格式与尺寸。
///
/// 三道闸顺序即安全序：目录白名单（防路径注入）→ 字节上限（防巨图灌工作区）
/// → 字节嗅探（`image_probe`，与 fs(read) 附图同口径，不信任扩展名）。
/// 任一不成立 → None（调用方落回「只回路径」）。
fn load_shot(src: &str) -> Option<(Vec<u8>, crate::image_probe::ImageProbe)> {
    let p = std::path::Path::new(src);
    if !is_shot_path(p) {
        return None;
    }
    let bytes = std::fs::read(p).ok()?;
    if bytes.len() > SHOT_ATTACH_MAX_BYTES {
        return None;
    }
    let probe = crate::image_probe::probe(&bytes)?;
    Some((bytes, probe))
}

/// 把截图转存为工作区内容寻址附件，并在输出里补 `image` 引用
/// （`image` / `attachment` / `imageNote` 三键，形状与 browser_cap 的
/// `attach_screenshot_ref` 逐字节同构——TS 侧 `parseToolImageOutput` 是唯一解析点）。
///
/// 为何在 Rust 侧写：截图落 `%TEMP%`（工作区外），Agent 通道读会撞权限闸；
/// 本口已持 WorkspaceState，直接写 attachments 零摩擦。落盘走
/// `attachments::store_attachment`（内容寻址单一权威，与 fs(read)/browser 截图同一份）。
///
/// 纯增益纪律：解析失败 / 非本套件路径 / 超限 / 认不出图片字节 / 无工作区
/// —— 任一不成立都原样返回，截图本身仍成功。
fn attach_shot_ref(state: &State<'_, crate::WorkspaceState>, output: String) -> String {
    let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&output) else {
        return output;
    };
    let Some(src) = val.get("path").and_then(|v| v.as_str()) else {
        return output;
    };
    let src_path = std::path::Path::new(src);
    let Some((bytes, probe)) = load_shot(src) else {
        return output;
    };
    // 无工作区（未打开项目）→ 不落附件，只回路径（截图本身仍成功）
    let Ok(ws) = crate::utils::workspace_path(state) else {
        return output;
    };
    let Ok((id, dst)) = crate::attachments::store_attachment(&ws, &bytes, probe.ext) else {
        return output;
    };
    let name = src_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("{id}.{}", probe.ext));
    if let Some(obj) = val.as_object_mut() {
        obj.insert(
            "image".to_string(),
            serde_json::json!({
                "id": id,
                "mediaType": probe.media_type,
                "bytes": bytes.len(),
                "width": probe.width,
                "height": probe.height,
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
                "本图已作为附图进入上下文：视觉模型可直接观察窗口内容（纯文本模型只看到本占位说明）。"
            ),
        );
    }
    val.to_string()
}

/// desktop_audit — 只读:desktop 操作审计查询(对齐 browser_audit)。
async fn desktop_audit(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("audit", agent_id.as_deref()).await?;
    Ok(crate::uia::desktop_audit_query(
        agent_id.as_deref(),
        args.get("limit")
            .and_then(|v| v.as_u64())
            .map(|l| l as usize),
    ))
}

/// desktop_status — 只读:窗口授权(grants) + 输入租约持有者。
async fn desktop_status(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    gate.check("probe", agent_id.as_deref()).await?;
    Ok(serde_json::json!({
        "grants": crate::uia::list_grants().iter()
            .map(|(a, h, ttl)| serde_json::json!({ "agent": a, "hwnd": h, "ttl_secs": ttl }))
            .collect::<Vec<_>>(),
        "input_lease_holder": crate::uia::lease_holder(),
    })
    .to_string())
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
        "desktop_uia_batch" => super::uia_batch::desktop_uia_batch(gate, args).await,
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
    /// 动作全集（退役前 builtin.uia manifest.tools 17 个 + 批 3 新增的
    /// `desktop_uia_batch`；D4-1）。
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
        "desktop_uia_batch",
        "desktop_audit",
        "desktop_status",
    ];

    #[test]
    fn action_table_is_exactly_eighteen_unique() {
        assert_eq!(ACTIONS.len(), 18);
        let mut sorted = ACTIONS.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 18, "动作表不得有重复项");
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

    // ── 批 1（P0-1）截图附图转存：白名单 / 字节嗅探 / 参数缺省 ──

    use super::{attach_image_arg, is_shot_path, load_shot, SHOT_ATTACH_MAX_BYTES};

    /// 最小 PNG（签名 + IHDR 宽高）——只够 image_probe 读尺寸。
    fn png_head(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.extend_from_slice(&13u32.to_be_bytes()); // IHDR 数据长度
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v
    }

    #[test]
    fn shot_path_whitelist_is_own_dir_only() {
        let own = crate::uia::shot_dir();
        assert!(is_shot_path(&own.join("uia-win-1.png")), "本套件截图目录内的图应放行");
        assert!(
            !is_shot_path(std::path::Path::new("C:/Windows/System32/notepad.exe")),
            "外部路径必须拒绝（防路径注入）"
        );
        assert!(
            !is_shot_path(std::path::Path::new("uia-win-1.png")),
            "裸文件名（无 parent）必须拒绝"
        );
    }

    #[test]
    fn load_shot_reads_own_png_and_reports_real_dims() {
        let dir = crate::uia::shot_dir();
        std::fs::create_dir_all(&dir).expect("建截图目录");
        let p = dir.join(format!("test-attach-{}.png", std::process::id()));
        std::fs::write(&p, png_head(600, 300)).expect("写测试 PNG");
        let got = load_shot(&p.to_string_lossy());
        let _ = std::fs::remove_file(&p);
        let (bytes, probe) = got.expect("本套件目录内的 PNG 应可转附件");
        assert_eq!(bytes.len(), png_head(600, 300).len());
        assert_eq!(
            (probe.media_type, probe.ext, probe.width, probe.height),
            ("image/png", "png", 600, 300)
        );
    }

    #[test]
    fn load_shot_rejects_foreign_missing_and_non_image() {
        assert!(load_shot("C:/Windows/System32/notepad.exe").is_none());
        assert!(load_shot("").is_none());
        // 本目录内的非图片字节同样不转（不信任扩展名）
        let dir = crate::uia::shot_dir();
        std::fs::create_dir_all(&dir).expect("建截图目录");
        let p = dir.join(format!("test-notimage-{}.png", std::process::id()));
        std::fs::write(&p, b"plain text, not a png").expect("写测试文件");
        let got = load_shot(&p.to_string_lossy());
        let _ = std::fs::remove_file(&p);
        assert!(got.is_none(), "认不出图片字节必须拒绝");
    }

    #[test]
    fn attach_image_arg_defaults_false() {
        let empty = serde_json::json!({});
        assert!(!attach_image_arg(&empty), "缺省必须 false（全屏图默认不进上下文）");
        assert!(attach_image_arg(&serde_json::json!({ "attach_image": true })));
        assert!(!attach_image_arg(&serde_json::json!({ "attach_image": "true" })));
    }

    #[test]
    fn shot_attach_limit_is_8mib() {
        assert_eq!(SHOT_ATTACH_MAX_BYTES, 8 * 1024 * 1024);
    }
}

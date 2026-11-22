// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 坐标模式写动作（computer use 批 2，P0-2）——自绘界面的唯一交互路径。
//
// 2026-11-22 体量清账自 `uia_cap.rs` 抽出。
//
// 与控件模式的区别：**不 resolve 控件**（自绘界面根本没有可 resolve 的控件），但窗口定位
// 仍必需——授权按 (agent, hwnd) 键控，且 `uia::com` 侧用窗口 rect 校验坐标边界（防误点
// 其它应用）。分类走 `click_at` / `right_click_at` / `scroll_at`（天然物理路径）：
// 已接管窗口 → Passthrough，未接管 → 一次物理 Ask（批准即接管）。敏感词表在坐标模式
// 不适用（拿不到控件名）——审批文案已写实「该位置是哪一控件由像素决定」。

use serde_json::Value;

use super::uia_cap::{
    agent_of, arg_str, check_desktop_raw, opt_u32_of, opt_u64_of, UiaGate,
};

/// 坐标模式写动作（批 2，P0-2）：click / right_click / scroll 带 x/y 时进入。
///
/// 与控件模式的区别：**不 resolve 控件**（自绘界面根本没有可 resolve 的控件），但窗口定位
/// 仍必需——授权按 (agent, hwnd) 键控，且 com 侧用窗口 rect 校验坐标边界（防误点其它应用）。
/// 分类走 `click_at` / `right_click_at` / `scroll_at`（天然物理路径）：已接管窗口 → Passthrough，
/// 未接管 → 一次物理 Ask（批准即接管）。敏感词表在坐标模式不适用（拿不到控件名）——
/// 审批文案已写实「该位置是哪一控件由像素决定」。
pub(super) async fn desktop_uia_write_at(
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

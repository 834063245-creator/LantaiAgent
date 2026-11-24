// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 桌面批处理（批 3，P1-1）——「一次审批、多步串行执行」。
//
// 由来：computer use 四批计划 §4。业界的 batching（一个模型回合发多个动作）能砍掉长任务
// 的往返与审批次数，但 The New Stack 对 Anthropic 那套的批评同样成立——一次批准覆盖多步
// 会让用户失去逐步控制。本实现的收紧面（每条都在代码里强制）：
//   - 步白名单（11 种中低风险动作）；**禁** keys / activate / grant / screenshot / probe /
//     audit / status / 嵌套 batch —— 它们的影响面超窗或本身就是审批动作，必须单独调用；
//   - **敏感目标出现即整批拒绝**（提交/支付/删除/密码/覆盖已填值）——一次批准不可逆操作链
//     违背既有安全分层，请逐次单独确认；
//   - `on_error` 默认 `stop`（失败即停），可显式改 `continue`；
//   - 上限 20 步；**批内只支持同一窗口**（跨窗口批量请拆成多批）；
//   - 物理步共享**一次**全局输入租约（并发安全不变，租约到期随批结束释放）；
//   - 审批一次（文案列前 5 步），每步与批头各落一条审计。
//
// 与控件模式一致的语义：批准即接管（`uia_grant` / `uia_physical` 批级 action 落 grant），
// 之后同一窗口内的批不再逐条询问。

use serde_json::{json, Value};

use super::uia_cap::{
    agent_of, arg_str, check_desktop_raw, opt_i32_of, opt_u32_of, opt_u64_of, UiaGate,
};

/// 批内允许的步动作（短名，与 desktop 域动作同名）。
const ALLOWED: &[&str] = &[
    "click",
    "right_click",
    "type",
    "scroll",
    "select",
    "expand",
    "read",
    "wait",
    "tree",
    "find",
    "window_shot",
];

/// 只读步：不过权限分类、不进租约、不影响批级 action 的收紧度。
const READONLY: &[&str] = &["read", "wait", "tree", "find", "window_shot"];

/// 步数硬上限（参数只能往下调，不能往上抬）。
const MAX_STEPS: usize = 20;
/// 单步结果回显上限（防批结果把上下文撑爆）。
const STEP_RESULT_MAX: usize = 800;

/// 批级窗口（唯一）。
struct Win {
    hwnd: u64,
    title: Option<String>,
    pid: Option<u32>,
}

/// 桌面批处理入口（uia_cap action = `desktop_uia_batch`）。
pub(crate) async fn desktop_uia_batch(gate: &UiaGate<'_>, args: &Value) -> Result<String, String> {
    let agent_id = agent_of(gate, args);
    let steps = args
        .get("steps")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "desktop_uia_batch: missing 'steps'（数组，每项一个动作）".to_string())?;
    if steps.is_empty() {
        return Err("desktop_uia_batch: steps 不能为空".into());
    }
    let limit = args
        .get("max_steps")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(MAX_STEPS)
        .min(MAX_STEPS);
    if steps.len() > limit {
        return Err(format!(
            "desktop_uia_batch: 步数 {} 超过上限 {limit}（max_steps 只能往下调，硬上限 {MAX_STEPS}）",
            steps.len()
        ));
    }
    let on_error = arg_str(args, "on_error").unwrap_or_else(|| "stop".into());
    if !["stop", "continue"].contains(&on_error.as_str()) {
        return Err(format!(
            "desktop_uia_batch: on_error 只能是 stop / continue，收到 {on_error}"
        ));
    }

    // 批级窗口：必须能定位（授权键控 + com 侧 rect 校验都要它，跨窗口批量不支持）
    let info = crate::uia::window_info(
        arg_str(args, "title").as_deref(),
        opt_u32_of(args, "pid"),
        opt_u64_of(args, "hwnd"),
    )
    .await?;
    let Some(hwnd) = info["hwnd"].as_u64() else {
        return Err("desktop_uia_batch: 必须指定目标窗口（hwnd / pid / title 之一）".into());
    };
    let win = Win {
        hwnd,
        title: info["title"].as_str().map(String::from),
        pid: info["pid"].as_u64().map(|n| n as u32),
    };

    // ── 预检：白名单 + 逐步分类 + 敏感拒绝（全在过闸之前，失败零副作用）──
    let granted = crate::uia::has_grant(agent_id.as_deref(), Some(hwnd));
    let mut kinds: Vec<String> = Vec::with_capacity(steps.len());
    let mut actions: Vec<&'static str> = Vec::with_capacity(steps.len());
    let mut needs_lease = false;
    for (i, step) in steps.iter().enumerate() {
        let kind = arg_str(step, "action")
            .ok_or_else(|| format!("desktop_uia_batch: 第 {i} 步缺 'action'"))?;
        if !ALLOWED.contains(&kind.as_str()) {
            return Err(format!(
                "desktop_uia_batch: 第 {i} 步 action '{kind}' 不在白名单（允许: {}）；\
                 keys / activate / grant / screenshot / probe / audit / status / 嵌套 batch 必须单独调用",
                ALLOWED.join(" / ")
            ));
        }
        if READONLY.contains(&kind.as_str()) {
            kinds.push(kind);
            actions.push("uia_pattern"); // 只读步对批级收紧度无贡献
            continue;
        }
        let act = classify_step(step, &kind, &win, granted, i).await?;
        if matches!(act, "uia_click_sensitive" | "uia_type_sensitive") {
            return Err(format!(
                "desktop_uia_batch: 第 {i} 步（{kind}）目标是敏感控件——提交/支付/删除/密码/\
                 覆盖已填值不允许进批（一次批准不可逆操作链违背安全分层），\
                 请单独调用 desktop_uia_{kind} 逐次确认"
            ));
        }
        if matches!(act, "uia_physical" | "uia_physical_granted") {
            needs_lease = true;
        }
        kinds.push(kind);
        actions.push(act);
    }

    // ── 批级 action：取最严（未接管物理 > 未接管 pattern > 已接管）──
    let batch_action = if actions.iter().any(|a| *a == "uia_physical") {
        "uia_physical"
    } else if actions.iter().any(|a| *a == "uia_grant") {
        "uia_grant"
    } else {
        "uia_pattern"
    };

    // ── 一次审批 ──
    {
        let tool = crate::tools::DesktopTool {
            action: batch_action.into(),
            agent_id: agent_id.clone(),
            hwnd: Some(hwnd),
            window_title: win.title.clone(),
        };
        if let Err(e) = check_desktop_raw(&tool, gate.state, gate.app).await {
            crate::uia::desktop_audit_log(
                agent_id.as_deref(),
                "desktop_uia_batch_denied",
                &format!("steps={} hwnd={hwnd}", steps.len()),
                &e,
            );
            return Err(format!("权限拒绝: {e}"));
        }
    }
    // 批准即接管（与单动作同语义）
    if matches!(batch_action, "uia_grant" | "uia_physical") {
        crate::uia::grant(agent_id.as_deref(), hwnd);
    }

    // ── 执行：串行；物理步共享一次租约 ──
    let _lease = if needs_lease {
        match crate::uia::acquire_input_lease(
            agent_id.as_deref(),
            std::time::Duration::from_secs(3),
        )
        .await
        {
            Ok(g) => Some(g),
            Err(e) => return Err(e),
        }
    } else {
        None
    };

    let started = std::time::Instant::now();
    let mut records: Vec<Value> = Vec::with_capacity(steps.len());
    let mut stopped_at: Option<usize> = None;
    let mut failed = 0usize;
    for (i, step) in steps.iter().enumerate() {
        let kind = kinds[i].as_str();
        let target = step_desc(step, kind);
        match exec_step(step, kind, &win).await {
            Ok(s) => {
                crate::uia::desktop_audit_log(
                    agent_id.as_deref(),
                    &format!("desktop_uia_batch_step_{kind}"),
                    &target,
                    &s,
                );
                records.push(json!({
                    "i": i, "action": kind, "ok": true,
                    "result": clip(&s),
                }));
            }
            Err(e) => {
                failed += 1;
                crate::uia::desktop_audit_log(
                    agent_id.as_deref(),
                    &format!("desktop_uia_batch_step_{kind}_failed"),
                    &target,
                    &e,
                );
                records.push(json!({
                    "i": i, "action": kind, "ok": false, "error": e,
                }));
                if on_error == "stop" {
                    stopped_at = Some(i);
                    break;
                }
            }
        }
    }

    let elapsed = started.elapsed().as_millis() as u64;
    let payload = json!({
        "steps": records,
        "total": steps.len(),
        "executed": records.len(),
        "failed": failed,
        "stopped_at": stopped_at,
        "on_error": on_error,
        "elapsed_ms": elapsed,
        "window": { "hwnd": hwnd, "pid": win.pid, "title": win.title },
        "hint": if stopped_at.is_some() {
            "批在失败步停下（on_error=stop）；修好该步后可从下一步继续或整批重发。"
        } else {
            "批内全部执行完毕；每步均落审计（desktop(audit) 可查）。"
        },
    })
    .to_string();
    crate::uia::desktop_audit_log(
        agent_id.as_deref(),
        "desktop_uia_batch",
        &format!(
            "steps={} failed={failed} action={batch_action} hwnd={hwnd}",
            steps.len()
        ),
        &clip(&payload),
    );
    Ok(payload)
}

/// 单步分类（控件模式 → 只读 resolve；坐标模式 → at_kind）。
async fn classify_step(
    step: &Value,
    kind: &str,
    win: &Win,
    granted: bool,
    i: usize,
) -> Result<&'static str, String> {
    if let (Some(_x), Some(_y)) = (opt_i32_of(step, "x"), opt_i32_of(step, "y")) {
        let at_kind = match kind {
            "click" => "click_at",
            "right_click" => "right_click_at",
            "scroll" => "scroll_at",
            other => {
                return Err(format!(
                    "desktop_uia_batch: 第 {i} 步 {other} 不支持坐标模式（只有 click / right_click / scroll）"
                ))
            }
        };
        return Ok(crate::tools::classify_uia_action(
            at_kind,
            "",
            false,
            "",
            &crate::tools::UiaTargetCaps::default(),
            granted,
        ));
    }
    let res = crate::uia::resolve(
        win.title.as_deref(),
        win.pid,
        Some(win.hwnd),
        opt_u32_of(step, "ref"),
        arg_str(step, "name").as_deref(),
        arg_str(step, "automation_id").as_deref(),
        arg_str(step, "control_type").as_deref(),
    )
    .await?;
    let g = |k: &str| res[k].as_bool().unwrap_or(false);
    let caps = crate::tools::UiaTargetCaps {
        has_invoke: g("has_invoke"),
        has_toggle: g("has_toggle"),
        has_select: g("has_select"),
        has_value: g("has_value"),
        has_scroll: g("has_scroll"),
    };
    Ok(crate::tools::classify_uia_action(
        kind,
        res["name"].as_str().unwrap_or(""),
        res["password"].as_bool().unwrap_or(false),
        res["value"].as_str().unwrap_or(""),
        &caps,
        granted,
    ))
}

/// 执行单步（权限已由批级一次审批覆盖；这里只做动作派发）。
async fn exec_step(step: &Value, kind: &str, win: &Win) -> Result<String, String> {
    let title = win.title.as_deref();
    let pid = win.pid;
    let hwnd = Some(win.hwnd);
    let ref_id = opt_u32_of(step, "ref");
    let name = arg_str(step, "name");
    let aid = arg_str(step, "automation_id");
    let ctype = arg_str(step, "control_type");

    // 坐标模式（x/y 同时给出）
    if let (Some(x), Some(y)) = (opt_i32_of(step, "x"), opt_i32_of(step, "y")) {
        return match kind {
            "click" => crate::uia::uia_click_at(title, pid, hwnd, x, y, false).await,
            "right_click" => crate::uia::uia_click_at(title, pid, hwnd, x, y, true).await,
            "scroll" => {
                let dir = arg_str(step, "direction").unwrap_or_else(|| "down".into());
                let amount = step.get("amount").and_then(|v| v.as_f64()).unwrap_or(1.0);
                crate::uia::uia_scroll_at(title, pid, hwnd, x, y, &dir, amount).await
            }
            other => Err(format!(
                "desktop_uia_batch: 坐标模式不支持 {other}（只有 click / right_click / scroll）"
            )),
        };
    }

    match kind {
        "click" => {
            crate::uia::uia_click(
                title,
                pid,
                hwnd,
                ref_id,
                name.as_deref(),
                aid.as_deref(),
                ctype.as_deref(),
                false,
                true,
            )
            .await
        }
        "right_click" => {
            crate::uia::uia_click(
                title,
                pid,
                hwnd,
                ref_id,
                name.as_deref(),
                aid.as_deref(),
                ctype.as_deref(),
                true,
                true,
            )
            .await
        }
        "type" => {
            let text = arg_str(step, "text")
                .ok_or_else(|| "desktop_uia_batch: type 步缺 'text'".to_string())?;
            crate::uia::uia_type(
                title,
                pid,
                hwnd,
                ref_id,
                &text,
                name.as_deref(),
                aid.as_deref(),
                ctype.as_deref(),
                true,
            )
            .await
        }
        "scroll" => {
            let dir = arg_str(step, "direction").unwrap_or_else(|| "down".into());
            let amount = step.get("amount").and_then(|v| v.as_f64()).unwrap_or(1.0);
            crate::uia::uia_scroll(
                title,
                pid,
                hwnd,
                ref_id,
                &dir,
                amount,
                name.as_deref(),
                aid.as_deref(),
                ctype.as_deref(),
                true,
            )
            .await
        }
        "select" => {
            crate::uia::uia_select(
                title,
                pid,
                hwnd,
                ref_id,
                name.as_deref(),
                aid.as_deref(),
                ctype.as_deref(),
            )
            .await
        }
        "expand" => {
            crate::uia::uia_expand(
                title,
                pid,
                hwnd,
                ref_id,
                name.as_deref(),
                aid.as_deref(),
                ctype.as_deref(),
            )
            .await
        }
        "read" => {
            crate::uia::uia_read(
                title,
                pid,
                hwnd,
                ref_id,
                name.as_deref(),
                aid.as_deref(),
                ctype.as_deref(),
            )
            .await
        }
        "wait" => {
            let until = arg_str(step, "until")
                .ok_or_else(|| "desktop_uia_batch: wait 步缺 'until'".to_string())?;
            let timeout_ms = step
                .get("timeout_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(10_000);
            crate::uia::uia_wait(
                title,
                pid,
                hwnd,
                ref_id,
                name.as_deref(),
                aid.as_deref(),
                ctype.as_deref(),
                &until,
                arg_str(step, "value").as_deref(),
                timeout_ms,
            )
            .await
        }
        "tree" => {
            crate::uia::uia_tree(
                title,
                pid,
                hwnd,
                opt_u32_of(step, "depth"),
                step.get("all").and_then(|v| v.as_bool()).unwrap_or(false),
                step.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                step.get("max_results")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize,
            )
            .await
        }
        "find" => {
            crate::uia::uia_find(
                title,
                pid,
                hwnd,
                name.as_deref(),
                ctype.as_deref(),
                aid.as_deref(),
                step.get("enabled").and_then(|v| v.as_bool()),
            )
            .await
        }
        "window_shot" => {
            crate::uia::uia_window_shot(
                title,
                pid,
                hwnd,
                // 批 4：步内也可要 OCR 锚点（默认 false——OCR 有几百毫秒成本）
                step.get("anchors")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            )
            .await
        }
        other => Err(format!("desktop_uia_batch: 未知步动作 {other}")),
    }
}

/// 步的审计描述（目标定位摘要）。
fn step_desc(step: &Value, kind: &str) -> String {
    if let (Some(x), Some(y)) = (opt_i32_of(step, "x"), opt_i32_of(step, "y")) {
        return format!("{kind} at=({x},{y})");
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(r) = opt_u32_of(step, "ref") {
        parts.push(format!("ref={r}"));
    }
    for k in ["name", "automation_id", "control_type"] {
        if let Some(v) = arg_str(step, k) {
            parts.push(format!("{k}={v}"));
        }
    }
    if parts.is_empty() {
        format!("{kind} (批级窗口)")
    } else {
        format!("{kind} {}", parts.join(" "))
    }
}

/// 结果裁剪（模型可见面防膨胀）。
fn clip(s: &str) -> String {
    if s.chars().count() <= STEP_RESULT_MAX {
        return s.to_string();
    }
    let head: String = s.chars().take(STEP_RESULT_MAX).collect();
    format!("{head}…[已截断，共 {} 字符]", s.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_excludes_dangerous_actions() {
        for banned in [
            "keys",
            "activate",
            "grant",
            "screenshot",
            "probe",
            "audit",
            "status",
            "batch",
        ] {
            assert!(
                !ALLOWED.contains(&banned),
                "{banned} 不得进批（必须单独调用）"
            );
        }
        for ok in [
            "click", "type", "scroll", "select", "expand", "read", "wait",
        ] {
            assert!(ALLOWED.contains(&ok), "{ok} 应在白名单");
        }
    }

    #[test]
    fn readonly_set_is_subset_of_allowed() {
        for r in READONLY {
            assert!(ALLOWED.contains(r), "{r} 必须在白名单内");
        }
    }

    #[test]
    fn step_cap_is_twenty() {
        assert_eq!(MAX_STEPS, 20);
    }

    #[test]
    fn step_desc_prefers_coordinates() {
        let at = serde_json::json!({"action": "click", "x": 10, "y": -20});
        assert_eq!(step_desc(&at, "click"), "click at=(10,-20)");
        let ctl = serde_json::json!({"action": "click", "ref": 7});
        assert_eq!(step_desc(&ctl, "click"), "click ref=7");
        let bare = serde_json::json!({"action": "read"});
        assert_eq!(step_desc(&bare, "read"), "read (批级窗口)");
    }

    #[test]
    fn clip_truncates_long_results() {
        let short = "ok";
        assert_eq!(clip(short), "ok");
        let long = "x".repeat(STEP_RESULT_MAX + 10);
        let out = clip(&long);
        assert!(out.contains("已截断"));
        assert!(out.chars().count() < long.chars().count() + 40);
    }
}

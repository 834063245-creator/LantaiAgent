// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// UIA (Windows UI Automation) 客户端 — Agent 观察/操作任意标准 Windows 窗口。
//
// 2026-08 computer-use 改造（进程内化）：
//   - 旧实现每动作 spawn PowerShell + 全树重建（秒级）；现为进程内 COM 专用
//     线程（hologram-uia）+ 线程内树缓存，单步毫秒级
//   - 交互范式不变：desktop_uia_tree 输出「控件树 + ref」；动作按 ref 或
//     name/automation_id/control_type selector 引用
//   - 反馈闭环：写动作返回 world-diff（标题/焦点/value/toggle/滚动百分比前后对比）
//   - 读路径零打扰：tree/find/read/wait 不再抢前台（旧版每个动作都 SetForegroundWindow）
//   - 权限分级见 tools/mod.rs DesktopTool：窗口级授权(pattern 放行) +
//     敏感目标单独 Ask + 物理输入路径单独 Ask + 全局输入租约串行化
//   - 全部写动作落审计（hologram-desktop-audit-*.jsonl，desktop_audit 可查）
//   - 错误带 [UIA_*] 结构化码（errors.rs），TS 侧 parseStructuredError 路由
//   - 边界：只覆盖标准控件；自绘控件（QQ/微信/钉钉等）树为空，
//     文档引导走 desktop_uia_window_shot + 视觉兜底
//
// 模块：worker(线程桥) / com(COM 核心) / cache(纯逻辑) / errors / grants(授权+租约) /
//       audit / shot(截图混合路径) / e2e(env 门控真实窗口测试)

#[cfg(windows)]
mod com;
mod worker;
#[cfg(not(windows))]
use worker as com; // 非 Windows：worker_loop 回结构化错误（worker.rs 内置占位）
mod audit;
mod cache;
#[cfg(test)]
mod e2e;
pub(crate) mod errors;
pub(crate) mod grants;
mod ocr;
mod shot;

use serde_json::Value;

pub(crate) use audit::audit_log as desktop_audit_log;
pub(crate) use audit::audit_query as desktop_audit_query;
pub(crate) use grants::{acquire_input_lease, grant, has_grant, lease_holder, list_grants};
pub(crate) use shot::shot_dir;

use worker::{Locator, Target};

fn locator(title: Option<&str>, pid: Option<u32>, hwnd: Option<u64>) -> Locator {
    Locator {
        title: title.map(|s| s.to_string()),
        pid,
        hwnd,
    }
}

fn target(
    ref_id: Option<u32>,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> Target {
    Target {
        ref_id,
        name: name.map(|s| s.to_string()),
        automation_id: automation_id.map(|s| s.to_string()),
        control_type: control_type.map(|s| s.to_string()),
    }
}

// ═══════════════════════════════════════════════════════════
// 公开动作（rpc 调用入口，返回 JSON 字符串）
// ═══════════════════════════════════════════════════════════

/// desktop_uia_tree — 窗口控件树 + ref 清单（默认 interactive-only，分页）。
pub(crate) async fn uia_tree(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    depth: Option<u32>,
    all: bool,
    offset: usize,
    max_results: usize,
) -> Result<String, String> {
    let v = worker::request(|reply| worker::UiaRequest::Tree {
        loc: locator(title, pid, hwnd),
        all,
        offset,
        max_results,
        reply,
    })
    .await?;
    Ok(post_depth_filter(v, depth)?.to_string())
}

/// depth 参数：Some(n) 只保留前 n 层（在 worker 返回的 JSON 上过滤，纯数据操作）。
fn post_depth_filter(mut v: Value, depth: Option<u32>) -> Result<Value, String> {
    let Some(n) = depth.filter(|&n| n >= 1) else {
        return Ok(v);
    };
    let controls = v["controls"].as_array().cloned().unwrap_or_default();
    let kept: Vec<&Value> = controls
        .iter()
        .filter(|c| c["depth"].as_u64().unwrap_or(1) <= n as u64)
        .collect();
    v["controls"] = Value::Array(kept.iter().map(|c| (*c).clone()).collect());
    v["tree"] = Value::String(cache::tree_text(
        &kept
            .iter()
            .filter_map(|c| json_to_rec(c))
            .collect::<Vec<_>>(),
    ));
    v["count"] = Value::from(kept.len());
    v["total"] = Value::from(kept.len());
    v["truncated"] = Value::Bool(false);
    Ok(v)
}

fn json_to_rec(c: &Value) -> Option<cache::ControlRec> {
    Some(cache::ControlRec {
        ref_id: c["ref"].as_u64()? as usize,
        ctype: cache::control_type_id(c["type"].as_str()?)?,
        name: c["name"].as_str()?.to_string(),
        automation_id: c["automation_id"].as_str().unwrap_or("").to_string(),
        enabled: c["enabled"].as_bool()?,
        password: false,
        rect: (0, 0, 0, 0),
        depth: c["depth"].as_u64().unwrap_or(1) as u32,
    })
}

/// desktop_uia_find — 在窗口内按条件查找控件（interactive 默认开）。
pub(crate) async fn uia_find(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    name: Option<&str>,
    ctype: Option<&str>,
    aid: Option<&str>,
    enabled: Option<bool>,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Find {
        loc: locator(title, pid, hwnd),
        all: false,
        name: name.map(|s| s.to_string()),
        ctype: ctype.map(|s| s.to_string()),
        aid: aid.map(|s| s.to_string()),
        enabled,
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// 只读解析 — rpc 权限分类前置步骤（返回 hwnd/title/name/patterns 等）。
pub(crate) async fn resolve(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: Option<u32>,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> Result<Value, String> {
    worker::request(|reply| worker::UiaRequest::Resolve {
        loc: locator(title, pid, hwnd),
        target: target(ref_id, name, automation_id, control_type),
        reply,
    })
    .await
}

/// desktop_uia_read — 单控件全量详情。
pub(crate) async fn uia_read(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: Option<u32>,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Read {
        loc: locator(title, pid, hwnd),
        target: target(ref_id, name, automation_id, control_type),
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_wait — 等控件出现/启用/值匹配。
pub(crate) async fn uia_wait(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: Option<u32>,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
    until: &str,
    value: Option<&str>,
    timeout_ms: u64,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Wait {
        loc: locator(title, pid, hwnd),
        target: target(ref_id, name, automation_id, control_type),
        until: until.to_string(),
        value: value.map(|s| s.to_string()),
        timeout_ms,
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_click — 按 ref 或 selector 点击（pattern 优先，物理兜底需授权）。
pub(crate) async fn uia_click(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: Option<u32>,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
    right: bool,
    allow_coords: bool,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Click {
        loc: locator(title, pid, hwnd),
        target: target(ref_id, name, automation_id, control_type),
        right,
        allow_coords,
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_type — 输入文字（SetValue 优先，聚焦+粘贴兜底需授权）。
pub(crate) async fn uia_type(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: Option<u32>,
    text: &str,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
    allow_physical: bool,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Type {
        loc: locator(title, pid, hwnd),
        target: target(ref_id, name, automation_id, control_type),
        text: text.to_string(),
        allow_physical,
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_scroll — 滚动（ScrollPattern 优先，滚轮兜底需授权）。
pub(crate) async fn uia_scroll(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: Option<u32>,
    direction: &str,
    amount: f64,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
    allow_wheel: bool,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Scroll {
        loc: locator(title, pid, hwnd),
        target: target(ref_id, name, automation_id, control_type),
        direction: direction.to_string(),
        amount,
        allow_wheel,
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_select — 列表项显式选中（SelectionItemPattern）。
pub(crate) async fn uia_select(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: Option<u32>,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Select {
        loc: locator(title, pid, hwnd),
        target: target(ref_id, name, automation_id, control_type),
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_expand — 组合框/树节点展开-收起（幂等 toggle）。
pub(crate) async fn uia_expand(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    ref_id: Option<u32>,
    name: Option<&str>,
    automation_id: Option<&str>,
    control_type: Option<&str>,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Expand {
        loc: locator(title, pid, hwnd),
        target: target(ref_id, name, automation_id, control_type),
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_keys — SendKeys 热键（物理输入，rpc 层保证 lease）。
pub(crate) async fn uia_keys(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    modifiers: Vec<String>,
    key: &str,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Keys {
        loc: locator(title, pid, hwnd),
        modifiers,
        key: key.to_string(),
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_activate — 把窗口带到前台（物理输入，rpc 层保证 lease）。
pub(crate) async fn uia_activate(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::Activate {
        loc: locator(title, pid, hwnd),
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_window_shot — 按窗口矩形截图（worker 定位 + PS GDI 捕获）。
/// `want_anchors`（批 4）：额外跑一次 WinRT OCR，把「文字 → 屏幕坐标」锚点一并返回——
/// 自绘界面里「按文字找按钮」比让模型估坐标更省更准；OCR 失败只降级为「只给图」。
pub(crate) async fn uia_window_shot(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    want_anchors: bool,
) -> Result<String, String> {
    let v = worker::request(|reply| worker::UiaRequest::WindowRect {
        loc: locator(title, pid, hwnd),
        reply,
    })
    .await?;
    let rect = v["rect"]
        .as_array()
        .and_then(|a| {
            let n: Vec<i32> = a
                .iter()
                .filter_map(|x| x.as_i64().map(|x| x as i32))
                .collect();
            if n.len() == 4 {
                Some((n[0], n[1], n[2], n[3]))
            } else {
                None
            }
        })
        .ok_or_else(|| errors::err(errors::codes::INTERNAL, "窗口矩形解析失败"))?;
    let (path, bytes, rect_s) = shot::capture(rect.0, rect.1, rect.2, rect.3)?;
    let mut out = serde_json::json!({
        "path": path.to_string_lossy(),
        "bytes": bytes,
        "rect": rect_s,
        "window": { "pid": v["pid"], "title": v["title"], "hwnd": v["hwnd"] },
        "note": "窗口矩形截图已落盘(文本模型看不到内容,可交给用户确认; vision 模型可读路径)。",
    });
    // 批 4（P1-2）：文字锚点。失败不致命——图照给，ocrNote 说明原因，模型按图自估坐标。
    if want_anchors {
        match ocr::anchors(&path.to_string_lossy(), rect.0, rect.1) {
            Ok(a) => {
                out["anchors"] = a["anchors"].clone();
                out["ocr"] = serde_json::json!({ "engine": a["engine"] });
                out["ocrNote"] = serde_json::json!(
                    "anchors = OCR 文字锚点（rect / center 均为屏幕虚拟坐标，可直接喂 \
                     desktop_uia_click 的 x/y）；纯图标无文字的区域不会有锚点，仍需看图定位。"
                );
            }
            Err(e) => {
                out["ocrNote"] = serde_json::json!(format!(
                    "OCR 不可用（{e}）——请按图自估坐标，或改用 desktop_uia_tree 拿控件 ref。"
                ));
            }
        }
    }
    Ok(out.to_string())
}

/// 窗口信息（坐标动作的定位前置）：hwnd/title/pid/rect —— 授权键控与 rect 校验口径。
pub(crate) async fn window_info(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
) -> Result<Value, String> {
    worker::request(|reply| worker::UiaRequest::WindowRect {
        loc: locator(title, pid, hwnd),
        reply,
    })
    .await
}

/// desktop_uia_click 坐标模式（批 2，P0-2）：屏幕虚拟坐标物理点击。
/// 自绘控件（UIA 树为空）与画布类界面的唯一交互路径；rect 校验在 worker 内。
pub(crate) async fn uia_click_at(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    x: i32,
    y: i32,
    right: bool,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::ClickAt {
        loc: locator(title, pid, hwnd),
        x,
        y,
        right,
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_uia_scroll 坐标模式（批 2）：屏幕虚拟坐标滚轮。
pub(crate) async fn uia_scroll_at(
    title: Option<&str>,
    pid: Option<u32>,
    hwnd: Option<u64>,
    x: i32,
    y: i32,
    direction: &str,
    amount: f64,
) -> Result<String, String> {
    worker::request(|reply| worker::UiaRequest::ScrollAt {
        loc: locator(title, pid, hwnd),
        x,
        y,
        direction: direction.to_string(),
        amount,
        reply,
    })
    .await
    .map(|v| v.to_string())
}

/// desktop_probe 路由探测 — 每窗口 interactive 数（预算 50ms）。
pub(crate) async fn probe_route(hwnd: u64) -> Result<Value, String> {
    worker::request(|reply| worker::UiaRequest::ProbeRoute {
        hwnd,
        budget_ms: 50,
        reply,
    })
    .await
}

/// 优雅停机（lifecycle::UiaService 调用）。
pub(crate) fn shutdown_worker(deadline: std::time::Instant) -> bool {
    worker::shutdown(deadline)
}

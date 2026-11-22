// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 窗口截图的 OCR 锚点（computer use 批 4，P1-2）——「自绘控件的文字锚点」。
//
// 由来：计划 §5。自绘界面（微信/QQ/钉钉、画布类应用）没有 UIA 树，模型只能看图猜坐标；
// 批 2 打通了坐标点击，本模块补上「文字 → 屏幕坐标」的锚点层，省 token 也更准。
//
// 实现选择：PowerShell 内嵌脚本调 WinRT `Windows.Media.Ocr`（与 `shot.rs` 用 PowerShell
// `System.Drawing` 同一先例）——**零新 Rust 依赖**，不引入 YOLO/ONNX 模型。
// 脚本独立成 `ocr_anchors.ps1`（`include_str!` 嵌入，改脚本 = 改文件，不重编译逻辑）。
// 引擎候选：用户配置语言 + 显式 `zh-Hans-CN`（自绘界面多为中文），取识别行数多者。
//
// 坐标口径：OCR 给的是**图片内**坐标；本模块加窗口原点，产出**屏幕虚拟坐标**——
// 与 `uia_tree`/`uia_read` 的 `rect`、批 2 的 x/y 点击完全同源，模型照抄即可。

use serde_json::Value;

/// 对一张窗口截图跑 OCR，返回 `{engine, anchors:[{text, rect:[x,y,w,h], center:[cx,cy]}]}`
/// （rect/center 已是**屏幕虚拟坐标**）。
///
/// 失败语义：脚本缺失/执行失败/输出不可解析 → `Err`（调用方决定是否降级为「只给图」）。
pub(super) fn anchors(png: &str, ox: i32, oy: i32) -> Result<Value, String> {
    let script = std::env::temp_dir().join("lantai-ocr-anchors.ps1");
    let want = include_str!("ocr_anchors.ps1");
    // 内容固定：长度不同才重写（避免每帧写盘）
    let stale = std::fs::read_to_string(&script)
        .map(|s| s.len() != want.len())
        .unwrap_or(true);
    if stale {
        std::fs::write(&script, want).map_err(|e| format!("[UIA_OCR] 写 OCR 脚本失败: {e}"))?;
    }

    let mut ps = std::process::Command::new("powershell");
    ps.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
    ps.arg(&script);
    ps.args(["-Png", png]);
    ps.args(["-Ox", &ox.to_string(), "-Oy", &oy.to_string()]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        ps.creation_flags(crate::utils::HIDDEN_CONSOLE);
    }
    let out = ps
        .output()
        .map_err(|e| format!("[UIA_OCR] 执行 PowerShell 失败: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("[UIA_OCR] OCR 脚本失败: {}", err.trim()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_anchors(stdout.trim(), ox, oy)
}

/// 解析脚本输出 → `{engine, anchors}`（纯函数，可单测）。
///
/// 行框 = 词框并集；`rect`/`center` 都加窗口原点（屏幕虚拟坐标）。
/// 容忍脏数据：缺字段的词跳过、空行跳过、退化框（宽高 ≤0）跳过——OCR 是增益不是必需。
pub(super) fn parse_anchors(raw: &str, ox: i32, oy: i32) -> Result<Value, String> {
    let v: Value = serde_json::from_str(raw)
        .map_err(|e| format!("[UIA_OCR] 解析 OCR 输出失败: {e}"))?;
    let engine = v["engine"].as_str().unwrap_or("none").to_string();
    let mut anchors: Vec<Value> = Vec::new();
    if let Some(lines) = v["lines"].as_array() {
        for line in lines {
            let text = line["text"].as_str().unwrap_or("").trim().to_string();
            if text.is_empty() {
                continue;
            }
            let (mut lx, mut ly) = (i32::MAX, i32::MAX);
            let (mut hx, mut hy) = (i32::MIN, i32::MIN);
            let Some(words) = line["words"].as_array() else {
                continue;
            };
            for w in words {
                let (Some(x), Some(y)) = (w["x"].as_i64(), w["y"].as_i64()) else {
                    continue;
                };
                let (x, y) = (x as i32, y as i32);
                let ww = w["w"].as_i64().unwrap_or(0) as i32;
                let hh = w["h"].as_i64().unwrap_or(0) as i32;
                lx = lx.min(x);
                ly = ly.min(y);
                hx = hx.max(x + ww);
                hy = hy.max(y + hh);
            }
            if lx == i32::MAX {
                continue;
            }
            let (w, h) = (hx - lx, hy - ly);
            if w <= 0 || h <= 0 {
                continue;
            }
            anchors.push(serde_json::json!({
                "text": text,
                "rect": [lx + ox, ly + oy, w, h],
                "center": [lx + ox + w / 2, ly + oy + h / 2],
            }));
        }
    }
    Ok(serde_json::json!({ "engine": engine, "anchors": anchors }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_merges_words_into_line_box_with_window_offset() {
        let raw = r#"{"engine":"zh-Hans-CN","lines":[
            {"text":"Save Close","words":[
                {"text":"Save","x":10,"y":20,"w":30,"h":10},
                {"text":"Close","x":50,"y":18,"w":40,"h":12}]},
            {"text":"Cancel","words":[{"text":"Cancel","x":10,"y":60,"w":50,"h":14}]}]}"#;
        let v = parse_anchors(raw, 100, 200).expect("应解析成功");
        assert_eq!(v["engine"], "zh-Hans-CN");
        let anchors = v["anchors"].as_array().expect("anchors 数组");
        assert_eq!(anchors.len(), 2);
        // 行框 = 词并集（x 10..90, y 18..30）→ 加窗口原点 (100,200)
        assert_eq!(anchors[0]["text"], "Save Close");
        assert_eq!(anchors[0]["rect"], serde_json::json!([110, 218, 80, 12]));
        assert_eq!(anchors[0]["center"], serde_json::json!([150, 224]));
        assert_eq!(anchors[1]["rect"], serde_json::json!([110, 260, 50, 14]));
    }

    #[test]
    fn parse_skips_bad_lines_and_bad_words() {
        let raw = r#"{"engine":"en-US","lines":[
            {"text":"","words":[{"text":"x","x":1,"y":2,"w":3,"h":4}]},
            {"text":"no-x","words":[{"text":"y","w":3,"h":4}]},
            {"text":"degenerate","words":[{"text":"z","x":5,"y":5,"w":0,"h":0}]},
            {"text":"good","words":[{"text":"good","x":7,"y":8,"w":20,"h":10}]}]}"#;
        let v = parse_anchors(raw, 0, 0).expect("应解析成功");
        let anchors = v["anchors"].as_array().expect("anchors 数组");
        assert_eq!(anchors.len(), 1, "只有 good 行保留: {anchors:?}");
        assert_eq!(anchors[0]["text"], "good");
    }

    #[test]
    fn parse_handles_empty_and_engine_none() {
        let v = parse_anchors(r#"{"engine":"none","lines":[]}"#, 0, 0).expect("应解析成功");
        assert_eq!(v["engine"], "none");
        assert_eq!(v["anchors"].as_array().expect("数组").len(), 0);
        // 完全不合法的输出 → Err（调用方降级「只给图」）
        assert!(parse_anchors("not json", 0, 0).is_err());
    }
}

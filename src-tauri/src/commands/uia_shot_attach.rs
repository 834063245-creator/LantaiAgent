// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 截图 → 工作区内容寻址附件（computer use 批 1，P0-1：窗口截图进模型上下文）。
//
// 2026-11-22 体量清账自 `uia_cap.rs` 抽出（uia_cap 1015+ → 见 DEBT 账）：截图转存与
// 能力口调度是两件事——前者只认字节、白名单与工作区，后者管权限与执行。
//
// 为何在 Rust 侧写而不是 TS 侧搬运：截图落 `%TEMP%`（工作区外），Agent 通道读会撞权限闸；
// 能力口已持 WorkspaceState，直接写 attachments 零摩擦。落盘走
// `attachments::store_attachment`（内容寻址单一权威，与 fs(read)/browser 截图同一份）。
//
// 输出形状与 `browser_cap::attach_screenshot_ref` 逐字节同构（`image` / `attachment` /
// `imageNote` 三键——TS 侧 `parseToolImageOutput` 是唯一解析点）。
//
// 纯增益纪律：解析失败 / 非本套件路径 / 超限 / 认不出图片字节 / 无工作区
// —— 任一不成立都原样返回，截图本身仍成功。

use serde_json::Value;
use tauri::State;

/// `attach_image` 参数（缺省 false——保守默认：图不进上下文）。
pub(super) fn attach_image_arg(args: &Value) -> bool {
    args.get("attach_image")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
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
pub(super) fn attach_shot_ref(state: &State<'_, crate::WorkspaceState>, output: String) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── 批 1（P0-1）截图附图转存：白名单 / 字节嗅探 / 参数缺省 ──

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
        assert!(
            is_shot_path(&own.join("uia-win-1.png")),
            "本套件截图目录内的图应放行"
        );
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
        assert!(
            !attach_image_arg(&empty),
            "缺省必须 false（全屏图默认不进上下文）"
        );
        assert!(attach_image_arg(
            &serde_json::json!({ "attach_image": true })
        ));
        assert!(!attach_image_arg(
            &serde_json::json!({ "attach_image": "true" })
        ));
    }

    #[test]
    fn shot_attach_limit_is_8mib() {
        assert_eq!(SHOT_ATTACH_MAX_BYTES, 8 * 1024 * 1024);
    }
}

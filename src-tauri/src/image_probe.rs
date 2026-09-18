// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 图片字节嗅探与尺寸读取（fs(read) 附图通道的单一真源）——纯函数，零 IO。
//
// 用途：confined_fs::read_cap 读文件后据此判定「这是不是受支持的图片」——
// 只认**字节事实**（magic + 可解析尺寸），不信任扩展名（与 image-intake 的
// 「声明与字节不符即拒」同纪律）。支持 png / jpeg / webp / gif 四格式，与
// 附件白名单（TS 侧 image-intake / tool-images 的 MEDIA_TYPES）同口径。
//
// 尺寸按格式走最小头部解析（不引重依赖）：PNG=IHDR、JPEG=SOF 段扫描、
// WebP=VP8/VP8L/VP8X 三变体、GIF=逻辑屏幕描述符。任一环节不成立 → None
// （调用面落回文本读取路径，行为零变化——探测只「认出」完整可解析的图）。

/// 探测结果。ext 与 TS 侧 extOfMediaType 一致（jpeg 的附件扩展名取 jpg）——
/// 附件文件名会被请求期读取器按 {id}.{ext} 拼接读取，口径必须对齐。
pub(crate) struct ImageProbe {
    pub media_type: &'static str,
    pub ext: &'static str,
    pub width: u32,
    pub height: u32,
}

/// 字节 → 图片探测。命中受支持格式且尺寸可解析、为正 → Some；否则 None。
pub(crate) fn probe(bytes: &[u8]) -> Option<ImageProbe> {
    if let Some((width, height)) = png_dim(bytes) {
        return Some(ImageProbe {
            media_type: "image/png",
            ext: "png",
            width,
            height,
        });
    }
    if let Some((width, height)) = jpeg_dim(bytes) {
        return Some(ImageProbe {
            media_type: "image/jpeg",
            ext: "jpg",
            width,
            height,
        });
    }
    if let Some((width, height)) = webp_dim(bytes) {
        return Some(ImageProbe {
            media_type: "image/webp",
            ext: "webp",
            width,
            height,
        });
    }
    if let Some((width, height)) = gif_dim(bytes) {
        return Some(ImageProbe {
            media_type: "image/gif",
            ext: "gif",
            width,
            height,
        });
    }
    None
}

/// 区间字节比较（越界 = false）。
fn has(bytes: &[u8], at: usize, tag: &[u8]) -> bool {
    bytes.get(at..at + tag.len()) == Some(tag)
}

/// PNG：8 字节签名 + IHDR 尺寸（偏移 16/20，大端）。
fn png_dim(bytes: &[u8]) -> Option<(u32, u32)> {
    if !has(bytes, 0, b"\x89PNG\r\n\x1a\n") || !has(bytes, 12, b"IHDR") {
        return None;
    }
    let w = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let h = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// JPEG：SOI 后扫段，命中 SOF（C0-CF 中除 DHT/JPG/DAC）取高宽（大端 u16）。
fn jpeg_dim(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 1 < bytes.len() {
        if bytes[i] != 0xFF {
            return None; // 段边界失序——放弃（非我们认识的结构）
        }
        let marker = bytes[i + 1];
        if marker == 0xFF {
            i += 1; // 填充字节
            continue;
        }
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2; // 无长度载荷的段（TEM / RSTn）
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            return None; // EOI / SOS：在此之前没见到 SOF
        }
        if i + 4 > bytes.len() {
            return None;
        }
        let seg_len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if seg_len < 2 || i + 2 + seg_len > bytes.len() {
            return None;
        }
        // SOF0-3 / 5-7 / 9-11 / 13-15（排除 DHT=C4 / JPG=C8 / DAC=CC）。
        let is_sof = (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            if seg_len < 7 || i + 9 > bytes.len() {
                return None;
            }
            let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
            let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
            return (w > 0 && h > 0).then_some((w, h));
        }
        i += 2 + seg_len;
    }
    None
}

/// WebP：RIFF/WEBP 容器 + 三变体头（VP8 有损 / VP8L 无损 / VP8X 扩展）。
fn webp_dim(bytes: &[u8]) -> Option<(u32, u32)> {
    if !has(bytes, 0, b"RIFF") || !has(bytes, 8, b"WEBP") {
        return None;
    }
    let fourcc = bytes.get(12..16)?;
    if fourcc == b"VP8X" {
        // 扩展格式：画布宽高（24 位小端，存值 = 实际 - 1），偏移 24/27。
        let w = 1 + u32::from_le_bytes([*bytes.get(24)?, *bytes.get(25)?, *bytes.get(26)?, 0]);
        let h = 1 + u32::from_le_bytes([*bytes.get(27)?, *bytes.get(28)?, *bytes.get(29)?, 0]);
        return (w > 0 && h > 0).then_some((w, h));
    }
    if fourcc == b"VP8L" {
        // 无损：签名 0x2F（偏移 20）+ 14 位宽 / 14 位高（存值 = 实际 - 1）。
        if *bytes.get(20)? != 0x2F {
            return None;
        }
        let bits = u32::from_le_bytes([
            *bytes.get(21)?,
            *bytes.get(22)?,
            *bytes.get(23)?,
            *bytes.get(24)?,
        ]);
        let w = (bits & 0x3FFF) + 1;
        let h = ((bits >> 14) & 0x3FFF) + 1;
        return (w > 0 && h > 0).then_some((w, h));
    }
    if fourcc == b"VP8 " {
        // 有损：帧标签(3) + 起始码 9D 01 2A（偏移 23）+ 14 位宽 / 14 位高（偏移 26/28）。
        if !has(bytes, 23, &[0x9D, 0x01, 0x2A]) {
            return None;
        }
        let w = (u16::from_le_bytes([*bytes.get(26)?, *bytes.get(27)?]) & 0x3FFF) as u32;
        let h = (u16::from_le_bytes([*bytes.get(28)?, *bytes.get(29)?]) & 0x3FFF) as u32;
        return (w > 0 && h > 0).then_some((w, h));
    }
    None
}

/// GIF：GIF87a/GIF89a + 逻辑屏幕宽高（偏移 6/8，小端 u16）。
fn gif_dim(bytes: &[u8]) -> Option<(u32, u32)> {
    if !has(bytes, 0, b"GIF87a") && !has(bytes, 0, b"GIF89a") {
        return None;
    }
    let w = u16::from_le_bytes([*bytes.get(6)?, *bytes.get(7)?]) as u32;
    let h = u16::from_le_bytes([*bytes.get(8)?, *bytes.get(9)?]) as u32;
    (w > 0 && h > 0).then_some((w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小 PNG（签名 + IHDR 宽高）——只够 png_dim 读尺寸。
    fn png_head(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.extend_from_slice(&13u32.to_be_bytes()); // IHDR 数据长度
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v
    }

    /// 最小 JPEG（SOI + APP0 + SOF0 高宽）。
    fn jpeg_head(w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]); // APP0
        v.extend_from_slice(b"JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00");
        v.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]); // SOF0, len=17
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&[0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00]);
        v
    }

    fn webp_head(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&[0, 0, 0, 0]); // 文件长度（本探测器不读）
        v.extend_from_slice(b"WEBP");
        v.extend_from_slice(fourcc);
        v.extend_from_slice(&[0, 0, 0, 0]); // chunk 长度（不读）
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn png_dim_reads_ihdr() {
        let head = png_head(600, 300);
        let p = probe(&head).expect("png 应命中");
        assert_eq!(
            (p.media_type, p.ext, p.width, p.height),
            ("image/png", "png", 600, 300)
        );
    }

    #[test]
    fn jpeg_dim_scans_to_sof() {
        let head = jpeg_head(600, 300);
        let p = probe(&head).expect("jpeg 应命中");
        assert_eq!(
            (p.media_type, p.ext, p.width, p.height),
            ("image/jpeg", "jpg", 600, 300)
        );
        // 截断在 SOF 之前 → 认不出（落回文本路径）
        assert!(probe(&head[..8]).is_none());
    }

    #[test]
    fn webp_dim_reads_three_variants() {
        // VP8X：flags/reserved(4) + 画布宽高（存值 - 1，24 位小端）
        let mut vp8x = vec![0u8; 10];
        let (w, h) = (600u32, 300u32);
        vp8x[4..7].copy_from_slice(&(w - 1).to_le_bytes()[..3]);
        vp8x[7..10].copy_from_slice(&(h - 1).to_le_bytes()[..3]);
        let p = probe(&webp_head(b"VP8X", &vp8x)).expect("VP8X 应命中");
        assert_eq!((p.media_type, p.width, p.height), ("image/webp", w, h));

        // VP8L：签名 0x2F + 14 位宽 / 14 位高
        let bits: u32 = (w - 1) | ((h - 1) << 14);
        let mut vp8l = vec![0x2F];
        vp8l.extend_from_slice(&bits.to_le_bytes());
        let p = probe(&webp_head(b"VP8L", &vp8l)).expect("VP8L 应命中");
        assert_eq!((p.width, p.height), (w, h));

        // VP8：帧标签(3) + 起始码 + 14 位宽 / 14 位高
        let mut vp8 = vec![0u8; 3];
        vp8.extend_from_slice(&[0x9D, 0x01, 0x2A]);
        vp8.extend_from_slice(&(w as u16).to_le_bytes());
        vp8.extend_from_slice(&(h as u16).to_le_bytes());
        let p = probe(&webp_head(b"VP8 ", &vp8)).expect("VP8 应命中");
        assert_eq!((p.width, p.height), (w, h));
    }

    #[test]
    fn gif_dim_reads_logical_screen() {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&600u16.to_le_bytes());
        v.extend_from_slice(&300u16.to_le_bytes());
        let p = probe(&v).expect("gif 应命中");
        assert_eq!(
            (p.media_type, p.ext, p.width, p.height),
            ("image/gif", "gif", 600, 300)
        );
    }

    #[test]
    fn probe_rejects_non_images_and_malformed() {
        assert!(probe(&[]).is_none());
        assert!(probe(b"plain text file").is_none());
        assert!(probe(&[0xFF, 0xD8]).is_none()); // SOI 后截断
        assert!(probe(b"RIFF\0\0\0\0WEBPJUNK").is_none()); // 未知 fourcc
        assert!(probe(b"GIF89a").is_none()); // GIF 头截断
        assert!(probe(&png_head(0, 1)).is_none()); // 零宽拒绝
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 工作区附图附件落盘（{ws}/.lantai/attachments/）——字节 → 内容寻址 id 的
// **单一权威**（sha256；INVARIANTS #14：消息只存引用，字节在盘上）。
//
// 消费方两类（同一命名/路径口径，请求期读取器按 {id}.{ext} 拼接取字节）：
//   - browser_cap：自家截图转存（rs 侧写，绕开工作区外路径的 Agent 读闸）；
//   - confined_fs::read_cap：fs(read) 读到图片字节时转存（2026-09-18 附图读图）。
//
// 与 TS 侧 image-intake 的落盘同目录同命名（{ws}/.lantai/attachments/{sha256}.{ext}）
// ——ext 映射须对齐其 extOfMediaType（jpeg→jpg）。

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 把字节存为工作区附件；返回（内容寻址 id, 落盘路径）。
/// 幂等：同内容（同 id）已存在时不再写盘。目录按需创建。
pub(crate) fn store_attachment(
    ws_root: &str,
    bytes: &[u8],
    ext: &str,
) -> std::io::Result<(String, PathBuf)> {
    let id = format!("{:x}", Sha256::digest(bytes));
    let dir = Path::new(ws_root).join(".lantai").join("attachments");
    std::fs::create_dir_all(&dir)?;
    let dst = dir.join(format!("{id}.{ext}"));
    if !dst.exists() {
        std::fs::write(&dst, bytes)?;
    }
    Ok((id, dst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_attachment_is_content_addressed_and_idempotent() {
        let ws = std::env::temp_dir().join(format!("lantai_attach_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&ws);
        let bytes = b"fake-png-bytes";

        let (id1, path1) = store_attachment(&ws.to_string_lossy(), bytes, "png").expect("首次落盘");
        assert_eq!(id1.len(), 64, "id = sha256 hex");
        assert!(id1.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(path1.exists());
        assert_eq!(std::fs::read(&path1).unwrap(), bytes);

        // 幂等：同内容再存 → 同 id 同路径，不重写
        let (id2, path2) = store_attachment(&ws.to_string_lossy(), bytes, "png").expect("重复落盘");
        assert_eq!(
            (id2.as_str(), path2.as_path()),
            (id1.as_str(), path1.as_path())
        );

        // 不同内容 → 不同 id（扩展名沿用调用方口径）
        let (id3, _) = store_attachment(&ws.to_string_lossy(), b"other", "jpg").expect("异内容");
        assert_ne!(id3, id1);

        let _ = std::fs::remove_dir_all(&ws);
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 组合目录作者面（P-1 authoring 环境，2026-09-14）——单二进制下用户"不动源码
// 配出一个 preset"的第一块地基（设计件
// docs/plans/composition-architecture/designs/S6-per-agent-composition.md §2 序列 F / §4 P-1）。
//
// 解决的问题（施工前实测）：组合根 `~/.lantai/composition/` 由
// `plugin_assets::composition_root` **只算路径不建目录**，且组合域零 RPC——
// 用户拿到 release 单 exe 时既不知道路径、也没有任何动作能把目录建出来，
// 只能自己摸黑 `mkdir`。
//
// 安全面（刻意收窄）：
//   - 路径**只来自服务端计算**（`composition_root_public`，尊重
//     `HOLOGRAM_COMPOSITION_ROOT` 测试/重定位语义），本 RPC **不接受调用方路径**；
//   - 因此这里不存在"任意路径打开/创建"面。对比 `commands::oauth::open_external`
//     只收 http(s)：本函数**不放宽**那个口子，也不复用它（打开文件管理器是另一件事）。
//   - 写入面（模板落盘）不在这里：走既有 `fs_cap write/create_dir`（UI 用户路径
//     只解析），不新开写通道——"能用现成的不造新的"。

use std::path::Path;

/// 准备组合目录（建 `root` 与 `root/presets/`，幂等）——返回根路径字符串。
/// 纯逻辑（给定根），便于测试注入临时根、避开进程级环境变量竞争。
pub(crate) fn ensure_composition_dirs(root: &Path) -> Result<String, String> {
    let presets = root.join("presets");
    std::fs::create_dir_all(&presets)
        .map_err(|e| format!("composition_dir: 创建目录失败 {}: {e}", presets.display()))?;
    Ok(root.to_string_lossy().to_string())
}

/// 组合目录 RPC：返回根绝对路径 + 按需创建；`open` = 用系统文件管理器打开。
/// 现有内容不动（`create_dir_all` 幂等，绝不清理）。
pub fn composition_dir(open: bool) -> Result<String, String> {
    let root = crate::plugin_assets::composition_root_public();
    let path = ensure_composition_dirs(&root)?;
    if open {
        open_in_file_manager(&root, "composition_dir")?;
    }
    Ok(path)
}

/// 用系统文件管理器打开目录（路径由调用方保证来自服务端计算）。
/// `what` = 调用方命令名（错误文案的归属前缀，两条通道共用同一份平台分派）。
/// 共用面：composition_dir 与 commands::providers::providers_dir。
pub(crate) fn open_in_file_manager(path: &Path, what: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        // explorer 直接开目录（不用 cmd start：少一层 shell 解析面）。
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("{what}: 打开目录失败 {}: {e}", path.display()))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("{what}: 打开目录失败 {}: {e}", path.display()))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("{what}: 打开目录失败 {}: {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("lantai_composition_dir_{tag}_{}", std::process::id()))
    }

    /// P-1 核心：目录不存在 → 建出来（含 presets/），返回根路径。
    #[test]
    fn ensure_creates_root_and_presets() {
        let root = tmp_root("create");
        let _ = std::fs::remove_dir_all(&root);
        assert!(!root.exists());
        let path = ensure_composition_dirs(&root).unwrap();
        assert_eq!(path, root.to_string_lossy());
        assert!(root.join("presets").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 幂等 + 不清理已有内容（用户自己写的 preset 绝不能被这个动作抹掉）。
    #[test]
    fn ensure_is_idempotent_and_preserves_content() {
        let root = tmp_root("idempotent");
        let _ = std::fs::remove_dir_all(&root);
        let mine = root.join("presets").join("mine");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::write(mine.join("roster.patch.yml"), b"tools: []\n").unwrap();

        let first = ensure_composition_dirs(&root).unwrap();
        let second = ensure_composition_dirs(&root).unwrap();
        assert_eq!(first, second);
        // 用户内容原样在
        assert_eq!(
            std::fs::read_to_string(mine.join("roster.patch.yml")).unwrap(),
            "tools: []\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 根路径解析尊重 HOLOGRAM_COMPOSITION_ROOT（测试隔离/重定位语义——
    /// 与 plugin_assets::composition_root_public 同源，这里只钉"目录准备对任意根成立"）。
    #[test]
    fn ensure_works_on_arbitrary_root() {
        let root = tmp_root("arbitrary").join("nested").join("composition");
        let _ = std::fs::remove_dir_all(tmp_root("arbitrary"));
        assert!(ensure_composition_dirs(&root).is_ok());
        assert!(root.join("presets").is_dir());
        let _ = std::fs::remove_dir_all(tmp_root("arbitrary"));
    }
}

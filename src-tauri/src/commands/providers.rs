// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// provider 配置文件作者面 —— 单二进制下用户/agent「不动源码写出一份 provider
// 配方」的地基通道（providers.yml 统管：人可手写、agent 可读写、改动热生效；
// 变更事件见 providers_watcher）。
//
// 解决的问题：`plugin_assets::providers_file` **只算路径不建目录**——用户拿到
// release 单 exe 时既不知道配置文件在哪、也没有任何动作能把 `~/.lantai/` 建出来，
// 只能自己摸黑 `mkdir`。
//
// 安全面（刻意收窄，与 commands::composition 同一条纪律）：
//   - 路径**只来自服务端计算**（`providers_file_public`，尊重
//     `HOLOGRAM_PROVIDERS_FILE` 测试/重定位语义），本 RPC **不接受调用方路径**；
//   - 因此这里不存在"任意路径打开/创建"面——只建配置文件所在的那一级目录，
//     且 `create_dir_all` 幂等、**绝不清理/覆盖已有内容**（配方是用户的资产）；
//   - 文件内容的写入面不在这里：走既有 `fs_cap write`（沙箱已放行这一个文件，
//     见 sandbox::is_user_providers_file_path），不新开写通道。

use std::path::Path;

/// 准备 provider 配置目录（建 `dir`，幂等）——返回目录路径字符串。
/// 纯逻辑（给定目录），便于测试注入临时目录、避开进程级环境变量竞争。
pub(crate) fn ensure_providers_dir(dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("providers_dir: 创建目录失败 {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().to_string())
}

/// provider 配置目录 RPC：返回**配置文件所在目录**的绝对路径 + 按需创建；
/// `open` = 用系统文件管理器打开该目录。现有内容不动。
pub fn providers_dir(open: bool) -> Result<String, String> {
    let file = crate::plugin_assets::providers_file_public();
    let dir = match file.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        // 无目录段（如 HOLOGRAM_PROVIDERS_FILE 只给了裸文件名）= 配置无落点，
        // 明确报错而不是往当前工作目录里建（不猜、不静默兜底）。
        _ => return Err(format!("providers_dir: 配置路径无目录段 {}", file.display())),
    };
    let path = ensure_providers_dir(&dir)?;
    if open {
        crate::commands::composition::open_in_file_manager(&dir, "providers_dir")?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("lantai_providers_dir_{tag}_{}", std::process::id()))
    }

    /// 核心：目录不存在 → 建出来，返回该目录路径；再调一次同结果（幂等）。
    #[test]
    fn ensure_creates_dir_idempotently() {
        let dir = tmp_dir("create");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!dir.exists());
        let first = ensure_providers_dir(&dir).unwrap();
        assert_eq!(first, dir.to_string_lossy());
        assert!(dir.is_dir());
        let second = ensure_providers_dir(&dir).unwrap();
        assert_eq!(first, second, "幂等：重复调用同结果");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 已有内容绝不被这个动作动到——providers.yml 是用户/agent 手写的配方，
    /// "建目录"不得顺手清空或覆盖它。
    #[test]
    fn ensure_preserves_existing_providers_yml() {
        let dir = tmp_dir("preserve");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("providers.yml");
        let content = "providers:\n  - id: deepseek\n    model: deepseek-chat\n";
        std::fs::write(&file, content).unwrap();

        assert!(ensure_providers_dir(&dir).is_ok());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), content, "已有配方必须原样在");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 多级不存在路径也成立（HOLOGRAM_PROVIDERS_FILE 可指向任意可重定位落点）。
    #[test]
    fn ensure_works_on_nested_path() {
        let outer = tmp_dir("nested");
        let _ = std::fs::remove_dir_all(&outer);
        let dir = outer.join("sub").join(".lantai");
        assert!(ensure_providers_dir(&dir).is_ok());
        assert!(dir.is_dir());
        let _ = std::fs::remove_dir_all(&outer);
    }
}

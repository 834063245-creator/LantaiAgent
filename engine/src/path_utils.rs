// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # 路径规范化工具
//!
//! 统一路径格式：反斜杠 → 正斜杠 + 驱动器字母大写。
//! 应使用此函数替代临时 `replace('\\', "/")`，确保所有代码路径产生相同的规范形式。

/// 将路径规范化为统一格式。
///
/// - Windows 反斜杠 `\` 转换为正斜杠 `/`
/// - Windows 驱动器字母统一为大写（如 `d:` → `D:`）
///
/// 这样可以避免 `d:/foo` 和 `D:/foo` 在依赖图中创建两个不同的节点。
pub fn normalize_path(path: &str) -> String {
    let s = path.replace('\\', "/");
    // 将 Windows 驱动器字母统一为大写，防止大小写差异导致图节点分裂
    // （例如 "d:/foo" 和 "D:/foo" 之前会创建两个不同的图节点）
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let mut chars: Vec<char> = s.chars().collect();
        chars[0] = chars[0].to_ascii_uppercase();
        chars.into_iter().collect()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_windows_path() {
        assert_eq!(normalize_path(r"C:\project\src\main.rs"), "C:/project/src/main.rs");
    }

    #[test]
    fn test_normalize_unix_path_idempotent() {
        // Unix 路径不含反斜杠，规范化后应保持不变
        assert_eq!(normalize_path("/home/user/src/main.rs"), "/home/user/src/main.rs");
    }

    #[test]
    fn test_normalize_mixed() {
        // 混合分隔符也应正确处理
        assert_eq!(normalize_path(r"C:\project\src/module\file.rs"), "C:/project/src/module/file.rs");
    }

    #[test]
    fn test_normalize_lowercase_drive_letter() {
        // 小写驱动器字母应转换为大写
        assert_eq!(normalize_path(r"d:\HoloGramHG\src\main.rs"), "D:/HoloGramHG/src/main.rs");
    }

    #[test]
    fn test_normalize_uppercase_drive_idempotent() {
        // 大写驱动器字母应保持不变（幂等性）
        assert_eq!(normalize_path(r"D:\HoloGramHG\src\main.rs"), "D:/HoloGramHG/src/main.rs");
    }
}

// ═══════════════════════════════════════════════════════════════
// `.hologram` → `.lantai` 目录改名迁移（2026-08-23）
//
// 与壳 src-tauri/src/utils.rs::migrate_hologram_to_lantai 同款契约。
// 引擎在 MCP/CLI 直跑时也可能被外部客户端拉起——独立提供一份。
// ═══════════════════════════════════════════════════════════════

/// 迁移结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrateStatus {
    /// 老目录不存在——无事可做。
    NoOldData,
    /// 已重命名 .hologram → .lantai。
    Migrated,
    /// 两目录并存——告警不迁移（防误删用户数据），由用户手动决。
    ConflictSkipped,
}

/// 把 `root/.hologram` 重命名为 `root/.lantai`（原子，同文件系统内）。
///
/// 幂等：可反复调。两目录并存时告警不迁移（防误删用户数据）。
pub fn migrate_hologram_to_lantai(root: &std::path::Path) -> Result<MigrateStatus, String> {
    let old = root.join(".hologram");
    let new = root.join(".lantai");
    if !old.exists() {
        return Ok(MigrateStatus::NoOldData);
    }
    if new.exists() {
        eprintln!(
            "[lantai] 警告：{} 同时存在 .hologram 与 .lantai，未迁移。请手动合并后删除 .hologram。",
            root.display()
        );
        return Ok(MigrateStatus::ConflictSkipped);
    }
    std::fs::rename(&old, &new).map_err(|e| {
        format!(
            "迁移 {} → {} 失败: {e}",
            old.display(),
            new.display()
        )
    })?;
    eprintln!("[lantai] 已迁移 {} → {}", old.display(), new.display());
    Ok(MigrateStatus::Migrated)
}

#[cfg(test)]
mod migrate_tests {
    use super::*;

    #[test]
    fn migrate_no_old_dir_is_noop() {
        let tmp = std::env::temp_dir().join("lantai_test_migrate_noop");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let r = migrate_hologram_to_lantai(&tmp).unwrap();
        assert_eq!(r, MigrateStatus::NoOldData);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn migrate_renames_old_to_new() {
        let tmp = std::env::temp_dir().join("lantai_test_migrate_rename");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".hologram/sessions")).unwrap();
        std::fs::write(tmp.join(".hologram/sessions/1.json"), "{}").unwrap();
        let r = migrate_hologram_to_lantai(&tmp).unwrap();
        assert_eq!(r, MigrateStatus::Migrated);
        assert!(!tmp.join(".hologram").exists());
        assert!(tmp.join(".lantai/sessions/1.json").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn migrate_conflict_skipped() {
        let tmp = std::env::temp_dir().join("lantai_test_migrate_conflict");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".hologram")).unwrap();
        std::fs::create_dir_all(tmp.join(".lantai")).unwrap();
        std::fs::write(tmp.join(".hologram/old.txt"), "old").unwrap();
        std::fs::write(tmp.join(".lantai/new.txt"), "new").unwrap();
        let r = migrate_hologram_to_lantai(&tmp).unwrap();
        assert_eq!(r, MigrateStatus::ConflictSkipped);
        // 两目录都未被修改
        assert!(tmp.join(".hologram/old.txt").exists());
        assert!(tmp.join(".lantai/new.txt").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn migrate_idempotent() {
        let tmp = std::env::temp_dir().join("lantai_test_migrate_idem");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".hologram")).unwrap();
        let _ = migrate_hologram_to_lantai(&tmp).unwrap();
        let r = migrate_hologram_to_lantai(&tmp).unwrap();
        assert_eq!(r, MigrateStatus::NoOldData);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

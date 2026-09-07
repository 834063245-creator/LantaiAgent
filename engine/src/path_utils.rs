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
// `.lantai` → `.hologram` 引擎数据分居迁移（engine-host-severance，2026-09-08）
//
// 引擎数据目录自有化：引擎自有文件从宿主目录 `.lantai/` 搬到
// `.hologram/`（真源见 hologram_graph::paths）。只搬引擎文件——宿主数据
// （sessions/memory/agents/宿主日志）归属 `.lantai` 不动。历史上引擎曾
// 兜底整目录迁移（.hologram→.lantai，2026-08-23），那会连宿主数据一起搬、
// 属职责越界，已退役；宿主数据的迁移归宿主（壳 utils.rs）。
// ═══════════════════════════════════════════════════════════════

/// 迁移结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineDataMigrateStatus {
    /// `.lantai` 下没有任何引擎数据——无事可做。
    NoData,
    /// 有搬迁（或遇到冲突告警——见 stderr 清单）。
    Migrated,
}

/// 引擎在宿主数据目录里的自有文件（不含 db trio——它们有组语义）。
const LANTAI_LEGACY_FILES: &[&str] = &[
    "graph.snapshot",
    "graph.snapshot.tmp",
    "hologram_graph.json",
    "vectors.usearch",
    "vectors.usearch.tmp",
    "vectors.slots.json",
    "vectors.slots.json.tmp",
    "baseline.json",
    "baseline_violations.json",
];

/// 把引擎自有文件从 `root/.lantai/` 搬到 `root/.hologram/`（rename，原子）。
///
/// - 幂等：可反复调；源文件不存在 → 跳过；零数据 → 不建目录。
/// - 保数据：目标已存在同名文件 → 冲突告警，**不搬不覆盖**，留在原地由
///   用户手决，引擎继续用 `.hologram` 侧。db trio（hologram.db/-wal/-shm）
///   整组语义：`.hologram` 已有 db 时 wal/shm 不得单独搬走（拼出半套
///   数据库比不搬更糟）。
/// - 失败非致命：个别文件搬不动只 warn，不阻断启动。
pub fn migrate_engine_data(root: &std::path::Path) -> Result<EngineDataMigrateStatus, String> {
    let old = root.join(".lantai");
    let new = hologram_graph::data_dir(root);

    let mut moved = 0usize;
    let mut conflicts = 0usize;

    let move_one = |src: &std::path::Path, dst: &std::path::Path, moved: &mut usize, conflicts: &mut usize| {
        if dst.exists() {
            eprintln!(
                "[engine] 警告：{} 与 .hologram 侧同名文件并存，未搬迁（保数据，请手动合并后删除）。",
                src.display()
            );
            *conflicts += 1;
            return;
        }
        match std::fs::rename(src, dst) {
            Ok(()) => *moved += 1,
            Err(e) => eprintln!("[engine] 迁移 {} 失败（非致命）: {e}", src.display()),
        }
    };

    // db trio：整组判定（组冲突 → 三件全留）
    if old.join("hologram.db").exists() {
        std::fs::create_dir_all(&new)
            .map_err(|e| format!("mkdir {}: {e}", new.display()))?;
        if new.join("hologram.db").exists() {
            eprintln!(
                "[engine] 警告：{} 与 .hologram 侧 hologram.db 并存，db 三件组不动（wal/shm 属于留在原地的 db）。",
                old.join("hologram.db").display()
            );
            conflicts += 1;
        } else {
            for name in ["hologram.db", "hologram.db-wal", "hologram.db-shm"] {
                let src = old.join(name);
                if src.exists() {
                    move_one(&src, &new.join(name), &mut moved, &mut conflicts);
                }
            }
        }
    }

    for name in LANTAI_LEGACY_FILES {
        let src = old.join(name);
        if !src.exists() {
            continue;
        }
        std::fs::create_dir_all(&new)
            .map_err(|e| format!("mkdir {}: {e}", new.display()))?;
        move_one(&src, &new.join(name), &mut moved, &mut conflicts);
    }

    // 引擎日志单独搬（logs/ 里还有宿主的 bridge.log——只取 engine.log）
    let old_log = old.join("logs").join("engine.log");
    if old_log.exists() {
        let new_log_dir = new.join("logs");
        std::fs::create_dir_all(&new_log_dir)
            .map_err(|e| format!("mkdir {}: {e}", new_log_dir.display()))?;
        move_one(&old_log, &new_log_dir.join("engine.log"), &mut moved, &mut conflicts);
    }

    if moved == 0 && conflicts == 0 {
        return Ok(EngineDataMigrateStatus::NoData);
    }
    eprintln!("[engine] 引擎数据已从 .lantai 迁至 .hologram（{} 搬迁 / {} 冲突留驻）", moved, conflicts);
    Ok(EngineDataMigrateStatus::Migrated)
}

#[cfg(test)]
mod migrate_tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir()
            .join(format!("hologram_migrate_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        tmp
    }

    #[test]
    fn migrate_no_lantai_data_is_noop() {
        let t = tmp("noop");
        assert_eq!(migrate_engine_data(&t).unwrap(), EngineDataMigrateStatus::NoData);
        assert!(!t.join(".hologram").exists(), "零数据不建目录");
    }

    #[test]
    fn migrate_moves_engine_files_only() {
        let t = tmp("moves");
        std::fs::create_dir_all(t.join(".lantai/logs")).unwrap();
        std::fs::write(t.join(".lantai/hologram.db"), "db").unwrap();
        std::fs::write(t.join(".lantai/hologram.db-wal"), "wal").unwrap();
        std::fs::write(t.join(".lantai/hologram.db-shm"), "shm").unwrap();
        std::fs::write(t.join(".lantai/vectors.usearch"), "vi").unwrap();
        std::fs::write(t.join(".lantai/baseline.json"), "{}").unwrap();
        std::fs::write(t.join(".lantai/logs/engine.log"), "log").unwrap();
        // 宿主数据必须原地不动
        std::fs::create_dir_all(t.join(".lantai/sessions")).unwrap();
        std::fs::write(t.join(".lantai/sessions/1.json"), "{}").unwrap();
        std::fs::write(t.join(".lantai/logs/bridge.log"), "host log").unwrap();

        assert_eq!(migrate_engine_data(&t).unwrap(), EngineDataMigrateStatus::Migrated);
        // 引擎文件已搬
        assert!(t.join(".hologram/hologram.db").exists());
        assert!(t.join(".hologram/hologram.db-wal").exists());
        assert!(t.join(".hologram/hologram.db-shm").exists());
        assert!(t.join(".hologram/vectors.usearch").exists());
        assert!(t.join(".hologram/baseline.json").exists());
        assert!(t.join(".hologram/logs/engine.log").exists());
        assert!(!t.join(".lantai/hologram.db").exists());
        assert!(!t.join(".lantai/vectors.usearch").exists());
        // 宿主数据留驻
        assert!(t.join(".lantai/sessions/1.json").exists());
        assert!(t.join(".lantai/logs/bridge.log").exists());
    }

    #[test]
    fn migrate_db_conflict_keeps_group_together() {
        let t = tmp("conflict");
        std::fs::create_dir_all(t.join(".lantai")).unwrap();
        std::fs::create_dir_all(t.join(".hologram")).unwrap();
        std::fs::write(t.join(".lantai/hologram.db"), "old db").unwrap();
        std::fs::write(t.join(".lantai/hologram.db-wal"), "old wal").unwrap();
        std::fs::write(t.join(".hologram/hologram.db"), "new db").unwrap();

        assert_eq!(migrate_engine_data(&t).unwrap(), EngineDataMigrateStatus::Migrated);
        // 双侧 db 都不动，wal 也不得单独搬走（组语义——防半套数据库）
        assert_eq!(
            std::fs::read_to_string(t.join(".hologram/hologram.db")).unwrap(),
            "new db"
        );
        assert_eq!(
            std::fs::read_to_string(t.join(".lantai/hologram.db")).unwrap(),
            "old db"
        );
        assert!(t.join(".lantai/hologram.db-wal").exists(), "组冲突时 wal/shm 不单独搬");
    }

    #[test]
    fn migrate_is_idempotent() {
        let t = tmp("idem");
        std::fs::create_dir_all(t.join(".lantai")).unwrap();
        std::fs::write(t.join(".lantai/hologram.db"), "db").unwrap();
        assert_eq!(migrate_engine_data(&t).unwrap(), EngineDataMigrateStatus::Migrated);
        // 二跑：.lantai 已无引擎数据 → NoData，零副作用
        assert_eq!(migrate_engine_data(&t).unwrap(), EngineDataMigrateStatus::NoData);
        assert_eq!(
            std::fs::read_to_string(t.join(".hologram/hologram.db")).unwrap(),
            "db"
        );
    }
}

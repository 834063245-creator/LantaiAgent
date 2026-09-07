// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

//! # 引擎数据目录真源
//!
//! 引擎自有数据（hologram.db / 快照 / 向量索引 / 基线 / 引擎日志）的根目录。
//! 2026-09-08 引擎-宿主逻辑收断（engine-host-severance-plan 拍板 A）：引擎数据
//! 从宿主目录 `.lantai` 分居到自有目录 `.hologram`；宿主数据（sessions/memory/
//! agents/宿主日志）继续归 `.lantai`。旧项目的引擎文件由引擎启动时的
//! `migrate_engine_data`（engine/src/path_utils.rs）自动搬迁，宿主零感知。
//!
//! storage / vector / engine 三层共用的唯一真源——不得再散写目录字面量。
//! 注意与 `ignore` 的双名共存区分：文件发现忽略清单同时收录 `.hologram`
//! 与 `.lantai`（老项目双目录必须继续忽略），那是发现面纪律，与本真源无关。

use std::path::{Path, PathBuf};

/// 引擎数据目录名（项目根下）。
pub const DATA_DIR_NAME: &str = ".hologram";

/// 引擎数据目录：`<project_root>/.hologram`。
pub fn data_dir(project_root: &Path) -> PathBuf {
    project_root.join(DATA_DIR_NAME)
}

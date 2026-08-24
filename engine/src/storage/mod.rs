// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 存储门面：数据家层（GraphStore / MemoryIndex / SqliteDb / 快照 / StoreHost）
//! 自 L2 存储外置（layering-rework-plan §4.3 欠账项 1）起物理拆出为独立 crate
//! `hologram-storage`，此处再导出保持 `crate::storage::*` 消费路径零改动。
//! engine 不再物理拥有存储实现——数据文件的所有权单元（StoreHost）由宿主
//! （壳层数据上下文 / engine 二进制）创建并注入。

pub use hologram_storage::{MemoryIndex, LoadProgress, SqliteDb, GraphStore, Connection, StoreHost};

/// 增量更新器（原 storage/incremental.rs）——依赖 adapter::registry 做
/// 单文件 tree-sitter 重解析，属「分析行为」而非「数据持有」，随 L2 crate 化
/// 迁入 pipeline 域（管线的一部分）。路径兼容：`crate::storage::IncrementalUpdater`
/// 仍可用（engine 内部消费方 watcher.rs / engine/mod.rs 零改动）。
pub use crate::pipeline::incremental::IncrementalUpdater;

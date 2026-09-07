// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # hologram-storage — 数据家层
//!
//! L2 存储外置（layering-rework-plan §4.3 欠账项 1）时从 engine crate 物理拆出：
//! `hologram.db` / FTS5 / 快照 / 向量索引文件的所有权单元（`StoreHost`）与
//! 读写实现（`GraphStore` / `MemoryIndex` / `SqliteDb` / 快照编解码）住在这里。
//!
//! 归属语义（引擎-宿主逻辑全断 2026-09-08 后）：数据文件的唯一宿主 =
//! 引擎进程——`StoreHost` 由引擎自开自持，落引擎自有数据目录
//! `<root>/.hologram/`（真源 hologram_graph::paths）。壳层不持任何数据
//! 句柄（曾经的双进程同库并发形态已随壳侧 StoreHost 退役消亡）。
//!
//! 依赖方向（健康）：storage → graph（类型词汇）+ vector（增量向量重建，
//! 纯计算层）。不再依赖 engine——数据家与分析器物理分家。

pub mod memory;
pub mod sqlite;
pub mod store;
pub mod snapshot;
pub mod string_arena;

pub use memory::{LoadProgress, MemoryIndex};
pub use sqlite::SqliteDb;
pub use rusqlite::Connection;
pub use store::GraphStore;

use std::path::Path;

/// 数据宿主（L2 存储外置）——图库 + 专用时间线连接的**所有权单元**。
///
/// 归属语义（2026-09-08 起）：宿主 = 引擎进程——`StoreHost` 自开自持，
/// 数据文件（hologram.db / FTS5 / 快照）落引擎自有数据目录
/// `<root>/.hologram/`。timeline 用独立连接，永不阻塞图库锁
/// （原 Engine 内两把锁的语义原样保留）。
pub struct StoreHost {
    /// 图存储（MemoryIndex + SQLite + 快照路径）。
    pub store: GraphStore,
    /// timeline 专用 SQLite 连接（与图库互不阻塞）。
    pub timeline_conn: Connection,
}

impl StoreHost {
    /// 为工作区根打开宿主：GraphStore::open（SQLite + 快照/JSON 加载）
    /// + timeline 辅助连接。
    pub fn open(project_root: &Path) -> Result<Self, String> {
        let store = GraphStore::open(project_root)?;
        let timeline_conn = SqliteDb::open_aux_connection(store.db.path())?;
        Ok(Self { store, timeline_conn })
    }
}

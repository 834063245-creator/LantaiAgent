// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

pub mod memory;
pub mod sqlite;
pub mod store;
pub mod incremental;
pub mod snapshot;
pub mod string_arena;

pub use memory::{LoadProgress, MemoryIndex};
pub use sqlite::SqliteDb;
pub use rusqlite::Connection;
pub use store::GraphStore;
pub use incremental::IncrementalUpdater;

use std::path::Path;

/// 数据宿主（L2 存储外置）——图库 + 专用时间线连接的**所有权单元**。
///
/// 归属语义：数据文件（hologram.db / FTS5 / 快照）按工作区打开，由宿主
/// （壳层数据上下文 / engine 二进制的进程级宿主）创建并**注入** Engine——
/// Engine 是使用方不是唯一拥有方，分析与查询经共享句柄（`Arc<Mutex<StoreHost>>`）
/// 落库。timeline 用独立连接，永不阻塞图库锁（原 Engine 内两把锁的语义原样保留）。
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

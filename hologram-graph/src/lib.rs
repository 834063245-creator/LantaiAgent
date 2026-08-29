// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # hologram-graph — 图类型层
//!
//! 依赖星图的最底层纯类型 crate：`Node` / `Edge` / `Graph` 数据结构 +
//! `NodeId`/`EdgeId` 全局字符串驻留器（R10-deep 句柄化）。
//! 零项目内依赖——上游（engine 的解析/分析层、hologram-storage 的数据家层）
//! 都拿这些类型当共享词汇。
//!
//! L2 存储外置（layering-rework-plan §4.3 欠账项 1）时从 engine crate 物理拆出：
//! engine 只保留「纯分析器」身份，类型层与存储层各自成家。

pub mod node;
pub mod edge;
pub mod graph;
pub mod id;
pub mod ignore;

pub use node::{Node, NodeKind, set_code_extensions};
pub use edge::{Edge, EdgeKind};
pub use graph::Graph;
pub use id::{EdgeId, NodeId};
pub use ignore::{is_ignored_dir_name, is_ignored_path, IGNORED_DIRS};

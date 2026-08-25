// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 图域分析模块：纯类型层（Node/Edge/Graph/ID 驻留器）已物理拆出为独立
//! crate `hologram-graph`，engine 内一律直连 `hologram_graph::` 引用；
//! 解析器/合并器/跨文件推导是**分析行为**，仍留在 engine::graph。
//! 图查询（neighbors/shortest_path/search_nodes/impact）已升为
//! `hologram_graph::Graph` 一等方法。

pub mod import_resolver;
pub mod merge;
pub mod resolver;

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 图域门面：纯类型层（Node/Edge/Graph/ID 驻留器）自 L2 存储外置起物理
//! 拆出为独立 crate `hologram-graph`，此处再导出保持 `crate::graph::*`
//! 消费路径零改动；解析器/合并器/查询/跨文件推导是**分析行为**，留在 engine。

pub use hologram_graph::{Node, NodeKind, Edge, EdgeKind, Graph, NodeId, EdgeId};
pub use hologram_graph::id;
pub use hologram_graph::set_code_extensions;

pub mod import_resolver;
pub mod merge;
pub mod resolver;
pub mod query;

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 向量检索门面：纯计算层（CodeVectorIndex / MiniLM 嵌入 / 词元切分）自
//! L2 存储外置（layering-rework-plan §4.3 欠账项 1）起物理拆出为独立 crate
//! `hologram-vector`，此处整体再导出保持 `crate::vector::*` 消费路径零改动。
//!
//! 拆出动机：hologram-storage 的 GraphStore::reindex_vectors 消费向量重建，
//! vector 若留在 engine 则 storage → engine 循环依赖；vector 本就是纯计算
//! （只依赖 graph 类型层），物理分家后方向健康。

pub use hologram_vector::*;

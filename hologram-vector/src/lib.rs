// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # hologram-vector — 向量检索层（纯计算）
//!
//! L2 存储外置（layering-rework-plan §4.3 欠账项 1）时从 engine crate 物理拆出：
//! `CodeVectorIndex`（usearch 索引 + slots 映射）+ MiniLM ONNX 嵌入器 +
//! WordPiece 词元切分。语义拍板不变——向量化计算是纯计算，只是物理成家；
//! `vectors.usearch` 数据文件的归属仍在宿主（StoreHost / 数据上下文）。
//!
//! 拆出动机：`hologram-storage` 的 `GraphStore::reindex_vectors` 消费本层
//! （增量向量重建），若 vector 留在 engine 则 storage→engine 形成循环依赖。
//! vector 只依赖 hologram-graph 类型层，方向健康：vector → graph。

mod index;
pub use index::*;

mod embed;
pub use embed::{backend_id, embed, embed_batch, score_threshold};

mod minilm;
mod wordpiece;

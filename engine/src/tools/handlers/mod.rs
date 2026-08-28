// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 工具处理器实现（第三批任务 11b：按工具域拆分，原 handlers.rs）。
//! 各域文件经 pub use 重导出，`handlers::handler_*` 路由路径保持不变。

pub(crate) mod analysis;
pub(crate) mod audit;
pub(crate) mod flows;
pub(crate) mod graph;
pub(crate) mod overview;
pub(crate) mod preflight;
pub(crate) mod rename;
pub(crate) mod resolve;
pub(crate) mod scip;
pub(crate) mod search;
pub(crate) mod shell;
pub(crate) use analysis::*;
pub(crate) use audit::*;
pub(crate) use flows::*;
pub(crate) use graph::*;
pub(crate) use overview::*;
pub(crate) use preflight::*;
pub(crate) use rename::*;
pub(crate) use resolve::*;
pub(crate) use scip::*;
pub(crate) use search::*;
// shell 不走 glob 重导出 —— 壳方法路由显式写 handlers::shell::*，
// 保持「模型工具面 / 壳专属面」两条路径在代码可读性上也分开。

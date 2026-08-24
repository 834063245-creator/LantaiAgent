// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 应用层服务（L3 壳层瘦身）——从 commands/ 迁入的业务实现。
//!
//! 职责归位：壳层（commands/ + rpc.rs）只管参数提取与通道；
//! 本目录持有业务编排（图命令 / 工作区生命周期 / hologram 查询 /
//! 引擎分发 / 数据流持久化），经 `AppContexts` 决议数据上下文。
//! 横切设施（权限/沙箱/审计/进程）仍在壳层，服务层可调用。

pub(crate) mod dataflow_service;
pub(crate) mod dispatch_service;
pub(crate) mod graph_service;
pub(crate) mod hologram_service;
pub(crate) mod workspace_service;

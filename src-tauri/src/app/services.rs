// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 应用层服务（L3 壳层瘦身）——从 commands/ 迁入的业务实现。
//!
//! 职责归位：壳层（commands/ + rpc.rs）只管参数提取与通道；
//! 本目录持有业务编排（工作区生命周期），经 `AppContexts` 决议数据上下文。
//! 横切设施（权限/沙箱/审计/进程）仍在壳层，服务层可调用。
//!
//! （图谱/引擎面服务——graph_service / hologram_service / dispatch_service /
//!  dataflow_service——随图谱功能全量退役删除，2026-09-09：兰台侧零引擎
//!  接线，引擎以独立进程 + 外部 MCP 通道形态供消费。）

pub(crate) mod workspace_service;

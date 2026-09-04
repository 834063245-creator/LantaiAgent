// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! primitives-server — 内核工具原语后端进程（拆壳第一刀）。
//!
//! 形态：独立二进制（与 hologram-engine 同构），由壳 exe spawn 为受信子进程，
//! stdio JSON-RPC。**本进程没有权限裁决权**：壳裁决通过后把「已授权的物理路径 +
//! 动作」发来，本进程只做字节执行（read/write/delete/mkdir/rename/move/list/glob）。
//!
//! 安全模型（用户 2026-09-04 拍板）：**裁决留 exe，执行外置**。
//! - exe = 权限裁决（worktree 映射 + 规则 + 审计）+ spawn 管理 + 转发；
//! - 本进程 = 无裁决、只信 exe 给的已授权物理路径；
//! - 威胁边界：webview 渲染器被攻破后无法触达本进程（仅 exe spawn 的 stdin 可达），
//!   且每个动作都先经 exe 裁决——本进程不是独立信任边界，是 exe 的受信执行臂。
//!
//! 协议：stdin/stdout 逐行 JSON-RPC（引擎 mcp.rs 同款骨架）。
//!   请求   {"jsonrpc":"2.0","id":1,"method":"fs.read_text","params":{...}}
//!   响应   {"jsonrpc":"2.0","id":1,"result":{...}} / {"error":{"code":..,"message":..}}
//! 启动即发 {"jsonrpc":"2.0","method":"ready"}（壳 client 等待此信号，同引擎）。

pub mod fs_ops;
pub mod protocol;

pub use protocol::handle_line;

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! primitives-server — 内核工具原语后端进程入口（拆壳第一刀）。
//!
//! 形态：由壳 exe spawn 的受信子进程，stdio JSON-RPC（lib.rs 协议见）。
//! **无权限裁决权**——只执行壳裁决后下发的已授权物理路径动作。
//!
//! 用法：primitives-server.exe serve
//! （v1 无参数模式即 serve；保留 serve 参数位以对齐引擎形态、方便未来子命令。）

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let is_serve = args.get(1).map(|a| a.as_str() == "serve").unwrap_or(false);
    let _ = is_serve; // v1 仅 serve 一种形态；无参默认 serve
    primitives_server::protocol::run_stdio();
}

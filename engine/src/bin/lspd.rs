// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # hologram-lspd —— LSP 舰队宿主（每 root 一个，引擎们共享）
//!
//! 2026-09-09 LSP 宿主共享化（lsp-fleet-daemon-plan）：多窗口/CLI 会话
//! 各带的引擎进程不再各自拉 LSP 舰队，全机每个 root 只由本进程持一套。
//!
//! 用法：`hologram-lspd --root <project-root> [--idle-secs 600]`
//! 端口落 `{root}/.hologram/lspd.port`；无连接且无请求 10 分钟自动退出。

use std::path::PathBuf;
use std::time::Duration;

use hologram_engine::lsp_daemon::{LspDaemon, DEFAULT_IDLE_TIMEOUT};
use hologram_engine::lsp_manager::LspManager;
use hologram_engine::logging;

fn main() {
    let mut root: Option<PathBuf> = None;
    let mut idle = DEFAULT_IDLE_TIMEOUT;
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--root" if i + 1 < args.len() => {
                root = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--idle-secs" if i + 1 < args.len() => {
                if let Ok(secs) = args[i + 1].parse::<u64>() {
                    idle = Duration::from_secs(secs);
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    let Some(root) = root else {
        eprintln!("usage: hologram-lspd --root <project-root> [--idle-secs 600]");
        std::process::exit(2);
    };

    // 日志分居 lspd.log（与引擎 engine.log 不互踩）
    let _log_guard = logging::init_logging_named(Some(&root), "lspd");

    // 宿主进程身份：LspManager 全部 op 走本地池（防止宿主作为客户端连自己）
    LspManager::set_daemon_mode(true);
    LspManager::mark_initialized(&root.to_string_lossy());

    match LspDaemon::bind(&root, idle) {
        Ok(Some(daemon)) => daemon.serve(),
        // 已有活宿主在位（双拉败者）或陈旧自愈路径上的正当退场：安静退出
        Ok(None) => tracing::info!("[lspd] another live daemon owns this root, exiting"),
        Err(e) => {
            tracing::error!(err = %e, "[lspd] bind failed");
            std::process::exit(1);
        }
    }
}

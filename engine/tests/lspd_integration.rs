// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! LSP 宿主共享化集成测试：走**真 hologram-lspd 二进制**的完整链
//! ——ensure_daemon 拉起 → status 往返 → shutdown 优雅退场。
//! （lib 内单测走 LspDaemon::bind 直启，不经 spawn 路径；本文件补齐
//! 「引擎进程外拉起真宿主」这一段。lsp-fleet-daemon-plan §6）

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use hologram_engine::lsp_daemon;
use hologram_engine::lsp_manager::LspManager;
use serde_json::json;

fn fresh_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "hologram_lspd_integration_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn test_ensure_daemon_spawns_real_binary_and_serves() {
    let root = fresh_root();
    let root_str = root.to_string_lossy().to_string();
    // 注入真二进制路径（客户端定位序：环境变量 → current_exe 同目录）
    std::env::set_var("HOLOGRAM_LSPD_EXE", env!("CARGO_BIN_EXE_hologram-lspd"));
    // 引擎客户端按 project_root 定位端口文件
    LspManager::mark_initialized(&root_str);

    // 拉起链：端口文件不存在 → spawn 真二进制 → 轮询 connect
    let online = LspManager::ensure_daemon(&root_str);
    assert!(online, "real lspd binary should spawn and become reachable");

    // status 往返：全部服务器配置在列（宿主应答，非本地池——本地池为空）
    let status = LspManager::daemon_lsp_status(&root_str)
        .expect("status should come from the spawned daemon");
    assert!(status.len() >= 9, "all server configs listed, got {}", status.len());

    // 端口文件真源可读回端口号；行协议 ping 验证
    let port: u16 = std::fs::read_to_string(lsp_daemon::port_file(&root))
        .expect("port file")
        .trim()
        .parse()
        .expect("port number");
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect lspd");
    s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
    writeln!(s, "{}", json!({"op": "ping"})).unwrap();
    s.flush().unwrap();
    let mut resp = String::new();
    BufReader::new(s).read_line(&mut resp).expect("pong");
    assert!(resp.contains("\"pong\""), "ping roundtrip, got: {resp}");

    // shutdown → 宿主退出 + 端口文件自清理（陈旧自愈的另一半）
    let mut s = TcpStream::connect(("127.0.0.1", port)).expect("reconnect lspd");
    writeln!(s, "{}", json!({"op": "shutdown"})).unwrap();
    s.flush().unwrap();
    let mut bye = String::new();
    BufReader::new(s).read_line(&mut bye).expect("shutdown ack");
    assert!(bye.contains("\"ok\""), "shutdown acked, got: {bye}");

    // 宿主 serve 循环 250ms 周期内应完成清理
    let pf = lsp_daemon::port_file(&root);
    let mut cleaned = false;
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(250));
        if !pf.exists() {
            cleaned = true;
            break;
        }
    }
    assert!(cleaned, "port file must be removed after shutdown");
    let _ = std::fs::remove_dir_all(&root);
}

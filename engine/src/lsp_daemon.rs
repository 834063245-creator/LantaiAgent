// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # LSP 宿主守护进程（hologram-lspd）——每根目录一套共享舰队
//!
//! 2026-09-09 事故的结构性根治：N 个引擎进程（多窗口/CLI 会话各带一个）
//! 曾经各自拉一套 LSP 舰队，16GB 机器被打爆。本模块把舰队收拢为
//! **每个 root 全机唯一**的宿主进程，引擎们经 127.0.0.1 TCP 共享它。
//!
//! ## 协议（行式 JSON：一行请求 → 一行响应）
//! - 请求：`{"op":"definition|implementation|hover|references|status|shutdown",
//!           "file":...,"source":...,"line":...,"column":...,"ext":...}`
//! - 响应：`{"ok":true,"locations":[...]}` / `{"ok":true,"hover":"..."}`
//!         / `{"ok":true,"status":[...]}` / `{"ok":false,"error":"..."}`
//! - payload 即 [`crate::lsp_manager::LspManager`] 公开 op 的入参——
//!   协议只是它的远程化，busy/门禁错误字符串原样透传回引擎侧。
//!
//! ## 生命周期
//! - 双拉仲裁：绑 127.0.0.1:0 后用 `create_new` 抢写 `{root}/.hologram/lspd.port`；
//!   败者读端口验活后安静退出（返回 [`LspDaemon::bind`] 的 `Ok(None)`）。
//! - 舰队懒生长：启动不预 warm，首次某语言的查询才拉该语言的 server。
//! - 空闲退出：无活跃连接且无请求持续 `idle_timeout` → 杀舰队、删端口文件、退出。

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::lsp_manager::{LspLocation, LspManager};

/// 端口发现文件名（经 [`hologram_graph::data_dir`] 真源定位：
/// `<root>/.hologram/lspd.port`）。
pub const PORT_FILE_NAME: &str = "lspd.port";

/// 默认空闲退出时限：无连接且无请求 10 分钟。
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(600);

// 进程级状态（宿主进程即整个进程的使命，无需每实例独立）：
// serve 循环在主线程 &self 上，连接工作线程够不到 &self——计数/停机/活跃
// 时刻全部升为进程级原子/静态。
static LIVE_CONNECTIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static REQUEST_SHUTDOWN: AtomicBool = AtomicBool::new(false);
static LAST_ACTIVITY: Mutex<Option<Instant>> = Mutex::new(None);

/// 端口发现文件全路径（引擎客户端与测试共用语义）。
pub fn port_file(root: &Path) -> PathBuf {
    hologram_graph::data_dir(root).join(PORT_FILE_NAME)
}

/// 宿主进程实例：持监听器与生命周期配置，`serve()` 进入服务循环。
pub struct LspDaemon {
    root: PathBuf,
    listener: TcpListener,
    port: u16,
    idle_timeout: Duration,
}

impl LspDaemon {
    /// 绑定 + 抢端口文件。
    ///
    /// 返回 `Ok(None)` = 已有活宿主在位（本进程是双拉败者，应安静退出）。
    pub fn bind(root: &Path, idle_timeout: Duration) -> Result<Option<Self>, String> {
        let port_file = port_file(root);
        std::fs::create_dir_all(port_file.parent().ok_or("bad root path")?)
            .map_err(|e| format!("create .hologram: {e}"))?;

        // 先判活：端口文件存在且能连上 → 败者退场
        if let Some(port) = read_live_port(&port_file)? {
            tracing::info!(port, "[lspd] already running, this process exits");
            return Ok(None);
        }
        // 陈旧端口文件（宿主已死）→ 清掉再抢
        if port_file.exists() {
            let _ = std::fs::remove_file(&port_file);
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("bind: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("local_addr: {e}"))?
            .port();

        // create_new 原子抢写：并发双拉只有一个能赢
        let claim = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&port_file)
            .and_then(|mut f| f.write_all(port.to_string().as_bytes()));
        match claim {
            Ok(()) => {}
            Err(_) => {
                // 输给并发对手：验活后退出（对手写完即死的极小窗口 → 清掉重抢一次）
                if let Some(_) = read_live_port(&port_file)? {
                    tracing::info!("[lspd] lost port race, this process exits");
                    return Ok(None);
                }
                let _ = std::fs::remove_file(&port_file);
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&port_file)
                    .and_then(|mut f| f.write_all(port.to_string().as_bytes()))
                    .map_err(|e| format!("re-claim port file: {e}"))?;
            }
        }

        Ok(Some(Self {
            root: root.to_path_buf(),
            listener,
            port,
            idle_timeout,
        }))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 服务循环：accept + 空闲检查；shutdown 标志或空闲超时退出。
    /// 退出前杀舰队（LspManager 静态池不跑析构）并删端口文件。
    pub fn serve(&self) {
        // 入口清停机标志：同一进程里串行跑多个宿主（测试）时，
        // 上一轮的 shutdown 不应立刻杀死这一轮。
        REQUEST_SHUTDOWN.store(false, Ordering::SeqCst);
        let _ = self.listener.set_nonblocking(true);
        touch();
        tracing::info!(port = self.port, root = %self.root.display(), "[lspd] serving");
        loop {
            match self.listener.accept() {
                Ok((stream, _addr)) => {
                    // Windows：accept 出的 socket 继承监听器的非阻塞模式，
                    // 连接循环要阻塞读——显式置回，否则 WOULDBLOCK 掐连接
                    //（2026-09-09 冒烟事故：同连接第二个请求必死）。
                    let _ = stream.set_nonblocking(false);
                    touch();
                    LIVE_CONNECTIONS.fetch_add(1, Ordering::SeqCst);
                    std::thread::spawn(move || {
                        handle_connection(stream);
                        LIVE_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => {
                    tracing::error!(err = %e, "[lspd] accept error");
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            if REQUEST_SHUTDOWN.load(Ordering::SeqCst) {
                tracing::info!("[lspd] shutdown requested");
                break;
            }
            let live = LIVE_CONNECTIONS.load(Ordering::SeqCst);
            let idle_for = LAST_ACTIVITY
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .map(|t| t.elapsed())
                .unwrap_or_default();
            if live == 0 && idle_for > self.idle_timeout {
                tracing::info!(idle_secs = idle_for.as_secs(), "[lspd] idle exit");
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        LspManager::shutdown_all();
        let _ = std::fs::remove_file(port_file(&self.root));
        tracing::info!("[lspd] exited");
    }

    /// 处理单条请求 → 响应 JSON。
    /// 协议层合法但服务报错时返回 `{"ok":false,"error":...}`（不是 Err）——
    /// busy/门禁等 op 级错误原样透传给引擎客户端。
    fn dispatch(req: &Value) -> Value {
        let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
        let get = |k: &str| req.get(k).and_then(|v| v.as_str()).unwrap_or("");
        let get_u32 = |k: &str| req.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        match op {
            "definition" => match LspManager::resolve_definition(
                get("file"), get("source"), get_u32("line"), get_u32("column"), get("ext"),
            ) {
                Ok(locs) => json!({"ok": true, "locations": locs.iter().map(location_json).collect::<Vec<_>>()}),
                Err(e) => json!({"ok": false, "error": e}),
            },
            "implementation" => match LspManager::find_implementations(
                get("file"), get("source"), get_u32("line"), get_u32("column"), get("ext"),
            ) {
                Ok(locs) => json!({"ok": true, "locations": locs.iter().map(location_json).collect::<Vec<_>>()}),
                Err(e) => json!({"ok": false, "error": e}),
            },
            "references" => match LspManager::find_references(
                get("file"), get("source"), get_u32("line"), get_u32("column"), get("ext"),
            ) {
                Ok(locs) => json!({"ok": true, "locations": locs.iter().map(location_json).collect::<Vec<_>>()}),
                Err(e) => json!({"ok": false, "error": e}),
            },
            "hover" => match LspManager::resolve_type(
                get("file"), get("source"), get_u32("line"), get_u32("column"), get("ext"),
            ) {
                Ok(hover) => json!({"ok": true, "hover": hover}),
                Err(e) => json!({"ok": false, "error": e}),
            },
            "status" => json!({"ok": true, "status": LspManager::lsp_status()}),
            "ping" => json!({"ok": true, "pong": true}),
            other => json!({"ok": false, "error": format!("unknown op: {other}")}),
        }
    }
}

/// 单连接处理：循环读行式请求，直至 EOF。
///
/// Windows 陷阱（2026-09-09 冒烟事故）：`accept()` 出来的 socket 会
/// **继承监听器的非阻塞模式**（serve 循环把 listener 置了非阻塞做空闲
/// 轮询），而本循环假设阻塞读——第二个请求到达前读会撞上
/// WSAEWOULDBLOCK，被当致命错误掐断连接（客户端视角 = 响应后连接被
/// RST）。双保险：accept 处显式置回阻塞 + 这里对 WouldBlock 容忍重试。
fn handle_connection(stream: TcpStream) {
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF：对端关闭
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let resp = match serde_json::from_str::<Value>(trimmed) {
                    Ok(req) => {
                        if req.get("op").and_then(|v| v.as_str()) == Some("shutdown") {
                            let _ = writeln!(writer, "{}", json!({"ok": true}));
                            let _ = writer.flush();
                            REQUEST_SHUTDOWN.store(true, Ordering::SeqCst);
                            break;
                        }
                        touch();
                        LspDaemon::dispatch(&req)
                    }
                    Err(e) => json!({"ok": false, "error": format!("parse: {e}")}),
                };
                if writeln!(writer, "{}", resp).is_err() || writer.flush().is_err() {
                    break;
                }
            }
            // 非阻塞残留防御：正常路径 accept 处已置阻塞，这里不该进来；
            // 若某平台仍交出非阻塞 socket，睡一拍重试而非掐断连接。
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
}

/// 刷新活跃时刻（accept 与每条请求时）。
fn touch() {
    *LAST_ACTIVITY.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
}

/// 请求宿主优雅停机（外部触发口；进程被强杀时靠端口文件陈旧自愈兜底）。
pub fn request_shutdown() {
    REQUEST_SHUTDOWN.store(true, Ordering::SeqCst);
}

/// 读端口文件并验活；文件缺失/端口死/格式坏 → None。
fn read_live_port(port_file: &Path) -> Result<Option<u16>, String> {
    let content = match std::fs::read_to_string(port_file) {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let port: u16 = content.trim().parse().map_err(|e| format!("bad port file: {e}"))?;
    match TcpStream::connect(("127.0.0.1", port)) {
        Ok(_) => Ok(Some(port)),
        Err(_) => Ok(None),
    }
}

/// LspLocation → 协议 JSON。
fn location_json(l: &LspLocation) -> Value {
    json!({
        "uri": l.uri,
        "range_start_line": l.range_start_line,
        "range_start_char": l.range_start_char,
        "range_end_line": l.range_end_line,
        "range_end_char": l.range_end_char,
    })
}

/// 协议 JSON → LspLocation（引擎客户端侧解析用）。
pub fn location_from_json(v: &Value) -> Option<LspLocation> {
    Some(LspLocation {
        uri: v.get("uri")?.as_str()?.to_string(),
        range_start_line: v.get("range_start_line")?.as_u64()? as u32,
        range_start_char: v.get("range_start_char")?.as_u64()? as u32,
        range_end_line: v.get("range_end_line").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        range_end_char: v.get("range_end_char").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 全部 daemon 测试触碰进程级静态（LspManager 单例、停机标志、
    /// 活跃计数），与其它引擎级全局测试共用串行锁。
    fn serialize() -> std::sync::MutexGuard<'static, ()> {
        crate::engine::global_engine_test_guard()
    }

    pub fn port_file_of(root: &Path) -> PathBuf {
        port_file(root)
    }

    fn fresh_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("hologram_lspd_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".hologram")).unwrap();
        root
    }

    /// 行协议客户端（测试用）：一行请求 → 一行响应。
    fn call(port: u16, req: Value) -> Value {
        let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect daemon");
        s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
        writeln!(s, "{}", req).unwrap();
        s.flush().unwrap();
        let mut resp = String::new();
        BufReader::new(s).read_line(&mut resp).expect("read response");
        serde_json::from_str(resp.trim()).expect("valid json response")
    }

    #[test]
    fn test_bind_serve_status_shutdown_roundtrip() {
        let _serial = serialize();
        let root = fresh_root("roundtrip");
        // 进程内宿主必须置 daemon_mode：否则 dispatch 里的 resolve_definition
        // 会走客户端路径连回自己（无限递归连接）——与真 bin 主函数同款职责。
        LspManager::set_daemon_mode(true);
        let daemon = LspDaemon::bind(&root, Duration::from_secs(3600))
            .expect("bind")
            .expect("first bind must win");
        let port = daemon.port();
        // 宿主就位后标记初始化（bin 主函数同款职责）
        LspManager::mark_initialized(&root.to_string_lossy());

        let serve_thread = std::thread::spawn(move || daemon.serve());

        // 状态往返：全部配置条目在列
        let status = call(port, json!({"op": "status"}));
        assert!(status["ok"].as_bool().unwrap(), "status resp: {status}");
        assert!(status["status"].as_array().unwrap().len() >= 9, "all configs listed");

        // 未配置 server 的扩展名：op 级错误原样透传（ok:false + error）
        let miss = call(port, json!({
            "op": "definition", "file": "D:/no/such/file.zzz",
            "source": "x", "line": 0, "column": 0, "ext": "zzz",
        }));
        assert!(!miss["ok"].as_bool().unwrap(), "zzz has no server: {miss}");
        assert!(
            miss["error"].as_str().unwrap().contains("no server for .zzz"),
            "error should be verbatim, got: {}", miss["error"]
        );

        // shutdown → serve 循环退出、端口文件清理
        let bye = call(port, json!({"op": "shutdown"}));
        assert!(bye["ok"].as_bool().unwrap());
        serve_thread.join().expect("serve thread exits cleanly");
        assert!(!port_file_of(&root).exists(), "port file must be removed on exit");
        // 还原宿主身份（本进程内后续测试按引擎客户端身份跑）
        LspManager::set_daemon_mode(false);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_multiple_requests_on_single_connection() {
        // 同连接多请求回归：真实冒烟发现连接在第一个响应后被 RST。
        // 进程内复现——宿主线程若 panic 会直接打进测试输出。
        let _serial = serialize();
        let root = fresh_root("multi");
        LspManager::set_daemon_mode(true);
        let daemon = LspDaemon::bind(&root, Duration::from_secs(3600))
            .expect("bind")
            .expect("first bind must win");
        let port = daemon.port();
        let serve_thread = std::thread::spawn(move || daemon.serve());

        let s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
        let mut w = s.try_clone().expect("clone writer");
        let mut r = BufReader::new(s);
        let mut line = String::new();

        for i in 1..=3 {
            writeln!(w, r#"{{"op":"ping"}}"#).expect("write ping");
            w.flush().expect("flush ping");
            line.clear();
            r.read_line(&mut line).unwrap_or_else(|e| {
                panic!("req#{i} read failed (connection killed?): {e}")
            });
            assert!(line.contains("\"pong\""), "req#{i} should pong, got: {line}");
        }

        writeln!(w, r#"{{"op":"shutdown"}}"#).expect("write shutdown");
        w.flush().expect("flush shutdown");
        line.clear();
        r.read_line(&mut line).expect("shutdown ack");
        assert!(line.contains("\"ok\""), "shutdown acked, got: {line}");
        serve_thread.join().expect("serve exits");
        assert!(!port_file_of(&root).exists(), "port file cleaned");
        LspManager::set_daemon_mode(false);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_double_bind_loser_exits() {
        let _serial = serialize();
        let root = fresh_root("arbiter");
        let daemon = LspDaemon::bind(&root, Duration::from_secs(3600))
            .expect("bind")
            .expect("first bind wins");
        let serve_thread = std::thread::spawn(move || daemon.serve());
        // 等 serve 起来：判活靠 connect（listener 绑定即通），
        // 400ms 足够 serve() 完成入口清标志（防 request_shutdown 与入口重置竞态）。
        std::thread::sleep(Duration::from_millis(400));

        // 第二个 bind：活宿主在位 → Ok(None)（安静退场）
        let loser = LspDaemon::bind(&root, Duration::from_secs(3600)).expect("loser bind");
        assert!(loser.is_none(), "second bind must detect live daemon");

        request_shutdown();
        serve_thread.join().expect("serve exits");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_stale_port_file_is_swept() {
        // 纯 bind 面测试（不起 serve，不碰停机标志）
        let _serial = serialize();
        let root = fresh_root("stale");
        // 宿主死掉后残留的端口文件（指向无人监听的端口）
        let pf = port_file_of(&root);
        std::fs::write(&pf, "59999").unwrap();

        // 新宿主 bind：陈旧文件被扫掉、正常抢位
        let daemon = LspDaemon::bind(&root, Duration::from_secs(3600))
            .expect("bind")
            .expect("stale file must not block bind");
        let real_port = daemon.port();
        let content = std::fs::read_to_string(&pf).unwrap();
        assert_eq!(content.trim(), real_port.to_string(), "port file refreshed");
        drop(daemon); // 不 serve：直接丢弃，手工清端口文件
        let _ = std::fs::remove_file(&pf);
        let _ = std::fs::remove_dir_all(&root);
    }
}

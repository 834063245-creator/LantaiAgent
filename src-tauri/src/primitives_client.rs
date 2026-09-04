// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! primitives_client — 壳侧工具原语后端进程 client（拆壳 D1）。
//!
//! 职责：spawn primitives-server（受信执行臂）+ stdio JSON-RPC + 崩溃重启。
//! **本 client 无裁决权**——调用方（fs 域工具）必须先做权限裁决（worktree
//! 映射 + 规则 + 审计），再把**已授权的物理路径**传进来执行字节操作。
//!
//! 与 engine_transport 同构但更薄：单进程（非每工作区一个）——字节执行无
//! 工作区状态；一次 initialize + 崩溃重启一次。进程归属 Job Object（os_sandbox
//! die-with-parent——宿主退出不留孤儿）。
//!
//! 二进制解析：env `HOLOGRAM_PRIMITIVES_EXE` 覆盖 → 壳 exe 同目录 → 其上一级
//! （测试二进制在 target/debug/deps/ 下的两级解析，对齐 engine_transport）。
//!
//! 拆壳中间态：本模块在 D1 已落地但尚未有生产消费者（fs 域接线 = D2）——
//! 挂 allow(dead_code) 过渡（接线后删除）。测试已消费全部路径（真进程 e2e）。

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// 单次调用响应等待上限（字节操作瞬时完成；超时按传输错误走重启重试）。
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// 单例后端进程（进程级——与 cdp PROCS / protocol_bridge 同款模块级静态）。
static PRIMITIVES: std::sync::LazyLock<Mutex<Option<PrimitivesSession>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

struct PrimitivesSession {
    child: Child,
    pending: Arc<Mutex<std::collections::HashMap<u64, mpsc::SyncSender<Value>>>>,
    next_id: AtomicU64,
}

impl Drop for PrimitivesSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 后端二进制路径解析（env 覆盖 → exe 同目录 → 上一级）。
fn primitives_exe_path() -> String {
    if let Ok(p) = std::env::var("HOLOGRAM_PRIMITIVES_EXE") {
        return p;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [
                dir.join("primitives-server.exe"),
                dir.join("..").join("primitives-server.exe"),
            ] {
                if cand.exists() {
                    return cand.to_string_lossy().to_string();
                }
            }
        }
    }
    "primitives-server.exe".into()
}

/// spawn 后端进程 + 握手（ready → initialize）。失败显式报错。
fn spawn_session() -> Result<PrimitivesSession, String> {
    let exe_path = primitives_exe_path();
    let mut child = {
        let mut cmd = Command::new(&exe_path);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(crate::utils::HIDDEN_CONSOLE);
        }
        cmd.spawn()
            .map_err(|e| format!("primitives-server 启动失败: {e}"))?
    };
    crate::os_sandbox::assign_to_job(&child);
    let stdout = child.stdout.take().ok_or("primitives-server stdout 不可用")?;
    let mut session = PrimitivesSession {
        child,
        pending: Arc::new(Mutex::new(std::collections::HashMap::new())),
        next_id: AtomicU64::new(0),
    };
    // stdout 读者线程：按 id 路由；EOF → fail-close 全部在途（传输错误走重启）。
    let pending = session.pending.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
                let tx = pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(v);
                }
            }
            // 通知（ready/message 等）无 id —— client 不消费（ready 在 spawn 期
            // 轮询握手已处理；后续通知无意义，丢弃）。
        }
        let mut guard = pending.lock().unwrap_or_else(|e| e.into_inner());
        for (_, tx) in guard.drain() {
            let _ = tx.send(json!({
                "jsonrpc": "2.0",
                "error": { "code": -32000, "message": "primitives-server terminated" }
            }));
        }
    });

    // 就绪握手：reader 线程接管 stdout 后，ready 通知行在读者线程被丢弃——
    // 这里不依赖 ready 轮询（引擎 serve 是先发 ready 再 initialize；后端
    // run_stdio 也是先发 ready）。直接 initialize，若进程死了会走到重启。
    let result = session.request("initialize", &json!({}));
    match result {
        Ok(resp) => {
            if resp.get("error").is_some() {
                return Err(format!("primitives-server initialize 失败: {resp}"));
            }
            Ok(session)
        }
        Err(e) => Err(e),
    }
}

/// 进程是否存活。
fn alive(session: &mut PrimitivesSession) -> bool {
    session.child.try_wait().map(|s| s.is_none()).unwrap_or(false)
}

/// 单次调用入口（裁决后调用——调用方已授权）。传输错误 → 重启重试一次。
pub(crate) fn call(method: &str, params: &Value) -> Result<Value, String> {
    let mut guard = PRIMITIVES.lock().unwrap_or_else(|e| e.into_inner());
    let need_spawn = match guard.as_mut() {
        Some(s) => !alive(s),
        None => true,
    };
    if need_spawn {
        if let Some(old) = guard.take() {
            drop(old);
        }
        *guard = Some(spawn_session()?);
    }
    let sess = guard.as_mut().expect("spawned above");
    match sess.request(method, params) {
        Ok(v) => Ok(v),
        Err(_e) => {
            // 传输级失败 → 重启重试一次
            if let Some(old) = guard.take() {
                drop(old);
            }
            *guard = Some(spawn_session()?);
            let sess = guard.as_mut().expect("respawned above");
            sess.request(method, params)
        }
    }
}

/// 主动关闭（测试/关停用）。
pub(crate) fn shutdown() {
    let mut guard = PRIMITIVES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = guard.take() {
        drop(old);
    }
}

/// 测试复位。
#[cfg(test)]
pub(crate) fn reset() {
    shutdown();
}

impl PrimitivesSession {
    /// 写一行到 stdin（child 锁只覆盖短写）。
    fn write_line(&mut self, line: &str) -> Result<(), String> {
        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or("primitives-server stdin 不可用")?;
        writeln!(stdin, "{line}").map_err(|e| format!("写入 stdin 失败: {e}"))?;
        stdin.flush().map_err(|e| format!("flush stdin 失败: {e}"))
    }

    /// 通用 JSON-RPC 请求（id 路由 + 超时）。
    fn request(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write_line(&req.to_string()) {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(v) => Ok(v),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                Err(format!("primitives-server 调用 {method} 超时"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_path_resolution_prefers_env() {
        std::env::set_var("HOLOGRAM_PRIMITIVES_EXE", "C:/custom/p.exe");
        assert_eq!(primitives_exe_path(), "C:/custom/p.exe");
        std::env::remove_var("HOLOGRAM_PRIMITIVES_EXE");
    }

    #[test]
    fn no_binary_errors_not_panics() {
        // 无二进制（未建）→ spawn 失败应显式报错（不 panic）
        std::env::set_var("HOLOGRAM_PRIMITIVES_EXE", "Z:/definitely/nope.exe");
        reset();
        let r = call("fs.read_text", &json!({ "path": "x" }));
        assert!(r.is_err(), "spawn 失败应报错: {r:?}");
        reset();
        std::env::remove_var("HOLOGRAM_PRIMITIVES_EXE");
    }

    /// 真进程端到端：spawn 后端 → initialize → fs.read_text 往返。
    /// 依赖 target/debug/primitives-server.exe 已构建（D0 产物）——
    /// 缺席时显式跳过（对齐 engine e2e 的「引擎二进制缺席自动跳过」纪律）。
    #[test]
    fn real_process_read_roundtrip() {
        // 二进制解析：测试二进制在 target/debug/deps/ → 上一级即 target/debug/
        let exe = std::env::current_exe().ok();
        let dir = exe.as_ref().and_then(|e| e.parent()).map(|p| p.to_path_buf());
        let cand = dir.as_ref().map(|d| d.join("primitives-server.exe"));
        let cand2 = dir.as_ref().and_then(|d| d.parent()).map(|d| d.join("primitives-server.exe"));
        let found = cand
            .as_ref()
            .filter(|p| p.exists())
            .or(cand2.as_ref().filter(|p| p.exists()))
            .cloned();
        let Some(bin) = found else {
            eprintln!("[primitives_client] 后端二进制缺席（先 cargo build -p primitives-server），跳过");
            return;
        };
        std::env::set_var("HOLOGRAM_PRIMITIVES_EXE", &bin);
        reset();

        let tmp = std::env::temp_dir().join(format!("primitives_client_e2e_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("hello.txt");
        std::fs::write(&f, "primitive client e2e").unwrap();

        let r = call("fs.read_text", &json!({ "path": f.to_string_lossy() }));
        let v = r.expect("真进程调用应成功");
        assert!(v.get("error").is_none(), "无 error: {v}");
        assert_eq!(v["result"]["content"], "primitive client e2e");

        let _ = std::fs::remove_dir_all(&tmp);
        reset();
        std::env::remove_var("HOLOGRAM_PRIMITIVES_EXE");
    }
}

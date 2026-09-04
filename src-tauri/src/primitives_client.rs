// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! primitives_client — 壳侧工具原语后端进程 client（拆壳 D1）。
//!
//! 职责：spawn primitives-server（受信执行臂）+ stdio JSON-RPC + 崩溃重启。
//! **本 client 无裁决权**——调用方（fs 域工具）必须先做权限裁决（worktree
//! 映射 + 规则 + 审计），再把**已授权的物理路径**传进来执行字节操作。
//!
//! 并发模型（与 engine_transport 同构）：PRIMITIVES 锁只保护 spawn 决策与
//! session 存取——`session()` 返回 Arc<PrimitivesSession> 克隆即放锁；请求
//! 的 stdin 写是短临界区（锁内仅 writeln），等响应在锁外 mpsc recv——多调用
//! 并发复用同一进程，不互相阻塞。单进程（字节执行无工作区状态）。
//!
//! 二进制解析：env `HOLOGRAM_PRIMITIVES_EXE` 覆盖 → 壳 exe 同目录 → 其上一级
//! （测试二进制在 target/debug/deps/ 下的两级解析，对齐 engine_transport）。
//!
//! 拆壳 D2：fs 域字节执行已接本 client（confined_fs 裁决 → call_async 转发）。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// 单次调用响应等待上限（字节操作瞬时完成；超时按传输错误走重启重试）。
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// 后端进程注册表（进程级——与 cdp PROCS / protocol_bridge 同款模块级静态）。
static PRIMITIVES: std::sync::LazyLock<Mutex<Option<Arc<PrimitivesSession>>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

struct PrimitivesSession {
    child: Mutex<Child>,
    pending: Arc<Mutex<std::collections::HashMap<u64, mpsc::SyncSender<Value>>>>,
    next_id: AtomicU64,
}

impl Drop for PrimitivesSession {
    fn drop(&mut self) {
        let _ = self.child.lock().map(|mut c| {
            let _ = c.kill();
            let _ = c.wait();
        });
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

/// spawn 后端进程 + initialize 握手。失败显式报错。
fn spawn_session() -> Result<Arc<PrimitivesSession>, String> {
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
    let session = Arc::new(PrimitivesSession {
        child: Mutex::new(child),
        pending: Arc::new(Mutex::new(std::collections::HashMap::new())),
        next_id: AtomicU64::new(0),
    });
    // stdout 读者线程：按 id 路由；EOF → fail-close 全部在途。
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
            // 通知（ready/message）无 id——丢弃（无消费面）。
        }
        let mut guard = pending.lock().unwrap_or_else(|e| e.into_inner());
        for (_, tx) in guard.drain() {
            let _ = tx.send(json!({
                "jsonrpc": "2.0",
                "error": { "code": -32000, "message": "primitives-server terminated" }
            }));
        }
    });

    // 握手：initialize（后端 run_stdio 先发 ready 行——读者线程丢弃；直接
    // initialize 无竞态，stdin/stdout 两条管道）。
    let resp = session.request("initialize", &json!({}))?;
    if resp.get("error").is_some() {
        return Err(format!("primitives-server initialize 失败: {resp}"));
    }
    Ok(session)
}

/// 进程是否存活。
fn alive(session: &PrimitivesSession) -> bool {
    session
        .child
        .lock()
        .ok()
        .and_then(|mut c| c.try_wait().ok())
        .map(|s| s.is_none())
        .unwrap_or(false)
}

/// 取会话（惰性 spawn + 死进程重建）。返回 Arc 克隆——后续调用不持注册表锁。
fn session() -> Result<Arc<PrimitivesSession>, String> {
    let mut guard = PRIMITIVES.lock().unwrap_or_else(|e| e.into_inner());
    let need_spawn = match guard.as_ref() {
        Some(s) => !alive(s),
        None => true,
    };
    if need_spawn {
        if let Some(old) = guard.take() {
            drop(old);
        }
        *guard = Some(spawn_session()?);
    }
    Ok(guard.as_ref().expect("spawned above").clone())
}

/// 同步调用（阻塞等待；适合非 async 上下文——如 log_append 的同步链）。
pub(crate) fn call(method: &str, params: &Value) -> Result<Value, String> {
    call_session(&session()?, method, params)
}

/// async 调用：spawn_blocking 包 call——fs 域工具（async execute）用，不阻塞
/// tokio worker；多调用并发复用同一进程。
pub(crate) async fn call_async(method: &str, params: &Value) -> Result<Value, String> {
    let m = method.to_string();
    let p = params.clone();
    tokio::task::spawn_blocking(move || call(&m, &p))
        .await
        .map_err(|e| format!("primitives-server 调用任务失败: {e}"))?
}

/// 会话级调用：传输级失败 → 重启重试一次。
fn call_session(sess: &Arc<PrimitivesSession>, method: &str, params: &Value) -> Result<Value, String> {
    match sess.request(method, params) {
        Ok(v) => Ok(v),
        Err(_e) => {
            // 传输级失败 → 换新会话重试一次
            let mut guard = PRIMITIVES.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(old) = guard.take() {
                drop(old);
            }
            *guard = Some(spawn_session()?);
            let fresh = guard.as_ref().expect("respawned above").clone();
            fresh.request(method, params)
        }
    }
}

/// 测试复位（后端进程随测试隔离重建）。
#[cfg(test)]
pub(crate) fn reset() {
    shutdown();
}

/// 主动关闭后端进程（测试用；生产生命周期接线 = D 批后续——宿主退出时
/// Job Object die-with-parent 已兜底杀进程，无需显式关闭）。
#[cfg(test)]
fn shutdown() {
    let mut guard = PRIMITIVES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = guard.take() {
        drop(old);
    }
}

impl PrimitivesSession {
    /// 写一行到 stdin（child 锁只覆盖短写——写完即放，不跨调用持有）。
    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = guard.stdin.as_mut().ok_or("primitives-server stdin 不可用")?;
        writeln!(stdin, "{line}").map_err(|e| format!("写入 stdin 失败: {e}"))?;
        stdin.flush().map_err(|e| format!("flush stdin 失败: {e}"))
    }

    /// 通用 JSON-RPC 请求（id 路由 + 超时；写锁只盖短写，等待在锁外）。
    fn request(&self, method: &str, params: &Value) -> Result<Value, String> {
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

    /// 后端二进制解析（测试在 target/debug/deps/ → 上一级 target/debug/）。
    /// 缺席 → None（测试跳过，对齐引擎 e2e 纪律）。
    fn backend_bin() -> Option<std::path::PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        for cand in [
            dir.join("primitives-server.exe"),
            dir.parent()?.join("primitives-server.exe"),
        ] {
            if cand.exists() {
                return Some(cand);
            }
        }
        None
    }

    fn ok_result(v: &Value) -> Value {
        assert!(v.get("error").is_none(), "应无 error: {v}");
        v.get("result").cloned().unwrap_or_else(|| json!({}))
    }

    /// 真进程端到端全方法：spawn 后端 → fs 读写/删/mkdir/rename/list/glob 往返。
    /// 依赖 target/debug/primitives-server.exe 已构建（D0 产物）。
    #[test]
    fn real_process_fs_methods_roundtrip() {
        let Some(bin) = backend_bin() else {
            eprintln!("[primitives_client] 后端二进制缺席（先 cargo build -p primitives-server），跳过");
            return;
        };
        std::env::set_var("HOLOGRAM_PRIMITIVES_EXE", &bin);
        reset();

        let tmp = std::env::temp_dir().join(format!("primitives_client_e2e_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // write → read
        let f = tmp.join("sub").join("hello.txt");
        let w = call("fs.write_text", &json!({ "path": f.to_string_lossy(), "content": "primitive e2e" }));
        ok_result(&w.expect("write 应成功"));
        assert!(f.is_file(), "write 应落盘");
        let r = call("fs.read_text", &json!({ "path": f.to_string_lossy(), "lineNumbers": true }));
        let rv = ok_result(&r.expect("read 应成功"));
        assert_eq!(rv["content"], "     1\tprimitive e2e");

        // list（含 sub 目录——顶层应含 sub，递归 children 内含 hello.txt）
        let l = call("fs.list_dir", &json!({ "path": tmp.to_string_lossy(), "recursive": true }));
        let lv = ok_result(&l.expect("list 应成功"));
        assert!(lv["entries"].is_array(), "entries 是数组");
        let top: Vec<&str> = lv["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["name"].as_str())
            .collect();
        assert!(top.contains(&"sub"), "顶层应含 sub 目录: {top:?}");

        // create_dir + rename
        let d = tmp.join("newdir");
        let cd = call("fs.create_dir", &json!({ "path": d.to_string_lossy() }));
        ok_result(&cd.expect("mkdir 应成功"));
        assert!(d.is_dir());
        let moved = tmp.join("sub").join("renamed.txt");
        let rn = call("fs.rename", &json!({ "from": f.to_string_lossy(), "to": moved.to_string_lossy() }));
        ok_result(&rn.expect("rename 应成功"));
        assert!(moved.is_file() && !f.exists(), "rename 应移动");

        // glob
        let g = call("fs.glob", &json!({ "path": tmp.to_string_lossy(), "patterns": ["**/*.txt"] }));
        let gv = ok_result(&g.expect("glob 应成功"));
        assert_eq!(gv["results"].as_array().unwrap().len(), 1, "glob 应命中 renamed.txt");

        // delete（目录树）
        let del = call("fs.delete", &json!({ "path": tmp.to_string_lossy() }));
        ok_result(&del.expect("delete 应成功"));
        assert!(!tmp.exists(), "delete 应清空");

        reset();
        std::env::remove_var("HOLOGRAM_PRIMITIVES_EXE");
    }
}

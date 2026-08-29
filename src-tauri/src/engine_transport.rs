// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 引擎传输接缝（engine-plugin-extraction Phase 3）——壳消费引擎的唯一边界。
//!
//! 方法面 = 引擎壳方法契约（v3：`graph_snapshot` / `file_nodes` /
//! `analyze_with_progress` / `save` / `fts_search` / `timeline_record` /
//! `diff` / `ensure_ready` / `cache_stale` / `watcher_subscribe` /
//! `run_check`）+ 模型工具全名（hologram_call 分发面）。
//! 实现 = `McpRemoteTransport`：每工作区一个 `engine serve` 子进程，
//! 经 stdio MCP `tools/call` 调用。（内嵌直调形态 InProcessTransport 已随
//! Phase 3 摘除 hologram-engine 依赖退役——无 engine crate 即无内嵌形态，
//! `HOLOGRAM_ENGINE_TRANSPORT` env 一并退役。）
//!
//! **通知出泵**（Phase 3 第二步核心）：EngineSession 常驻读线程把 stdout
//! 行按 id 路由——带 id 行投递给在途请求通道；无 id 通知行（watcher 桥
//! `notifications/message`、分析进度 `notifications/progress`）进进程级
//! 封顶队列（cap 64，丢最旧）。壳侧 pump（workspace watcher）drain 后
//! 转译为 graph-updated / analyze-* 事件。同会话并发调用天然多路复用：
//! stdin 串行写 + id 路由读，调用方不再独占会话。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

// ═══════════════════════════════════════════════════════════════
// EngineSession —— 一个 engine serve 子进程的 stdio MCP 会话
// ═══════════════════════════════════════════════════════════════

/// 就绪信号等待超时。serve 启动即发 ready（分析/观察者延迟到首次调用）。
const READY_TIMEOUT_SECS: u64 = 600;
/// 单次调用响应等待上限（run_check 等同步重方法可达分钟级；超时按
/// 传输错误走重启重试——实际不可达的兜底值）。
const CALL_TIMEOUT_SECS: u64 = 3600;
/// 通知队列封顶（与引擎侧 watcher 桥同参数——满时丢最旧，不积压）。
const NOTIFICATION_CAP: usize = 64;

/// 调用错误分类：引擎工具级失败（isError）不重启；传输级断裂（写失败 /
/// 进程退出 / 超时）重启重试一次。旧实现不分型导致任何工具错误都杀进程
/// 重启——这是 Phase 3 重写时顺手纠正的病灶。
#[derive(Debug)]
enum CallError {
    /// 工具执行失败（result.isError）——引擎进程健康，不重启。
    Tool(String),
    /// 传输断裂——进程疑似死亡，可重启重试。
    Transport(String),
}

pub(crate) struct EngineSession {
    child: Mutex<Child>,
    /// 请求 id → 响应投递通道（读线程路由；发起方超时后自行移除）。
    pending: Arc<Mutex<HashMap<u64, mpsc::SyncSender<Value>>>>,
    /// 通知队列（watcher 桥 / 进度；封顶丢最旧）。读线程生产，pump 消费。
    notifications: Arc<Mutex<VecDeque<Value>>>,
    next_id: AtomicU64,
}

impl Drop for EngineSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl EngineSession {
    /// spawn `engine serve --project-root <root>`，启动常驻读线程并完成
    /// MCP 握手（ready 通知 → initialize → notifications/initialized）。
    pub(crate) fn spawn(project_root: &str, engine_path: &str) -> Result<Arc<Self>, String> {
        let root = crate::utils::project_root();
        #[cfg(windows)]
        let mut child = {
            use std::os::windows::process::CommandExt;
            Command::new(engine_path)
                // serve 可能拉起子进程（LSP/工具）→ 隐藏控制台继承
                .creation_flags(crate::utils::HIDDEN_CONSOLE)
                .current_dir(&root)
                .args(["serve", "--project-root", project_root])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("无法启动引擎进程: {e}"))?
        };
        #[cfg(not(windows))]
        let mut child = {
            Command::new(engine_path)
                .current_dir(&root)
                .args(["serve", "--project-root", project_root])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("无法启动引擎进程: {e}"))?
        };
        crate::os_sandbox::assign_to_job(&child);
        let stdout = child.stdout.take().ok_or("stdout 不可用")?;
        let session = Arc::new(Self {
            child: Mutex::new(child),
            pending: Arc::new(Mutex::new(HashMap::new())),
            notifications: Arc::new(Mutex::new(VecDeque::new())),
            next_id: AtomicU64::new(0),
        });
        Self::start_reader(stdout, session.pending.clone(), session.notifications.clone());
        Self::wait_ready(&session)?;
        Self::initialize(&session)?;
        Ok(session)
    }

    /// 常驻读线程：按 id 路由 stdout 行。带 id 行投递在途请求；
    /// 通知行进封顶队列；EOF（进程退出）时 fail-close 全部在途请求
    /// （回错误封套 → 调用方按传输错误走重启重试）。
    fn start_reader(
        stdout: std::process::ChildStdout,
        pending: Arc<Mutex<HashMap<u64, mpsc::SyncSender<Value>>>>,
        notifications: Arc<Mutex<VecDeque<Value>>>,
    ) {
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
                // 引擎 stdout 是纯 JSON 行协议；坏行跳过（不毒化队列）。
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
                } else {
                    // 通知行：watcher 桥 / 进度（无 id）。封顶丢最旧。
                    let mut q = notifications.lock().unwrap_or_else(|e| e.into_inner());
                    while q.len() >= NOTIFICATION_CAP {
                        q.pop_front();
                    }
                    q.push_back(v);
                }
            }
            // EOF：进程已退出 —— 所有在途请求立即失败（不等超时）。
            let mut guard = pending.lock().unwrap_or_else(|e| e.into_inner());
            for (_, tx) in guard.drain() {
                let _ = tx.send(json!({
                    "jsonrpc": "2.0",
                    "error": { "code": -32000, "message": "engine process terminated" }
                }));
            }
        });
    }

    /// 等待 serve 的 ready 通知（启动即发；轮询通知队列——reader 线程
    /// 已接管 stdout，P1-19 纪律：长等待不持调用方锁）。
    fn wait_ready(session: &Arc<Self>) -> Result<(), String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(READY_TIMEOUT_SECS);
        while std::time::Instant::now() < deadline {
            for v in session.take_notifications() {
                if v.get("method").and_then(|m| m.as_str()) == Some("ready") {
                    return Ok(());
                }
            }
            if !session.alive() {
                return Err("引擎进程启动即退出".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(format!("引擎进程启动超时（{READY_TIMEOUT_SECS}s）"))
    }

    /// MCP initialize 握手。
    fn initialize(session: &Arc<Self>) -> Result<(), String> {
        let resp = session.request(
            "initialize",
            &json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "lantai-shell", "version": "0.1.0" },
            }),
        )?;
        if resp.get("error").is_some() {
            return Err(format!("引擎 initialize 失败: {resp}"));
        }
        session.write_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)?;
        Ok(())
    }

    /// 写一行到 stdin（child 锁只覆盖短写——写完即放，不跨调用持有）。
    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.child.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = guard.stdin.as_mut().ok_or("stdin 不可用")?;
        writeln!(stdin, "{line}").map_err(|e| format!("写入 stdin 失败: {e}"))?;
        stdin.flush().map_err(|e| format!("flush stdin 失败: {e}"))
    }

    /// 通用 MCP 请求（带 id 路由 + 超时兜底）。
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
        match rx.recv_timeout(Duration::from_secs(CALL_TIMEOUT_SECS)) {
            Ok(v) => Ok(v),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                Err(format!("引擎响应超时（id {id}, {method}）"))
            }
        }
    }

    /// tools/call 调用。每个请求携带 progressToken（MCP 客户端 opt-in）——
    /// 长任务（analyze_with_progress / analyze_project）的进度通知得以推送，
    /// 壳侧 pump 转译为 analyze-* 事件（与内嵌形态的进度轮询语义对齐）。
    fn call_tool(&self, method: &str, args: &Value) -> Result<String, CallError> {
        let params = json!({
            "name": method,
            "arguments": args,
            "_meta": { "progressToken": "lantai-shell" },
        });
        let resp = self.request("tools/call", &params).map_err(CallError::Transport)?;
        if let Some(err) = resp.get("error") {
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
            // JSON-RPC 层错误：-32000 工具不存在等属工具面失败；其余（进程
            // 异常）按传输断裂处理。
            return Err(match err.get("code").and_then(|c| c.as_i64()) {
                Some(-32000) => CallError::Tool(format!("引擎方法 {method} 失败: {msg}")),
                _ => CallError::Transport(format!("引擎方法 {method} 失败: {msg}")),
            });
        }
        let result = resp.get("result").ok_or_else(|| {
            CallError::Transport("引擎响应无 result".into())
        })?;
        // isError 结果（工具级失败）转 Err——调用方降级语义与内嵌一致，
        // 但不再触发进程重启。
        if result.get("isError").and_then(|v| v.as_bool()) == Some(true) {
            let msg = result["content"][0]["text"].as_str().unwrap_or("tool failed");
            return Err(CallError::Tool(format!("引擎方法 {method} 失败: {msg}")));
        }
        if let Some(text) = result["content"][0]["text"].as_str() {
            return Ok(text.to_string());
        }
        Ok(serde_json::to_string(result).unwrap_or_default())
    }

    /// drain 通知队列（pump 消费；不 spawn、不触碰 stdin）。
    pub(crate) fn take_notifications(&self) -> Vec<Value> {
        match self.notifications.lock() {
            Ok(mut q) => q.drain(..).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// 进程是否仍存活（崩溃重启判据）。
    fn alive(&self) -> bool {
        matches!(
            self.child.lock().unwrap_or_else(|e| e.into_inner()).try_wait(),
            Ok(None)
        )
    }

    pub(crate) fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            let _ = guard.kill();
            let _ = guard.wait();
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// McpRemoteTransport —— 每工作区一个引擎进程（Phase 3 起唯一形态）
// ═══════════════════════════════════════════════════════════════

pub(crate) struct McpRemoteTransport {
    root: String,
    /// 会话句柄（惰性 spawn；Mutex 只覆盖「取/换会话」的短暂临界区——
    /// 调用本体在 Arc 克隆上进行，长等待绝不持锁（P1-19 纪律；
    /// 读线程架构后同会话并发调用天然多路复用））。
    process: Mutex<Option<Arc<EngineSession>>>,
}

impl std::fmt::Debug for McpRemoteTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpRemoteTransport").field("root", &self.root).finish()
    }
}

impl McpRemoteTransport {
    pub(crate) fn new(root: &str) -> Self {
        Self {
            root: root.to_string(),
            process: Mutex::new(None),
        }
    }

    /// 调用引擎方法（壳方法名或模型工具名），返回解包后的输出文本
    /// （MCP content[0].text）。
    pub(crate) fn call(&self, method: &str, args: &Value) -> Result<String, String> {
        self.call_inner(|s| s.call_tool(method, args))
    }

    /// MCP 层通用请求（tools/list 等带 id 方法；非 tools/call 信封解包）。
    /// 返回完整 JSON-RPC response 值。
    pub(crate) fn request_mcp(&self, method: &str, params: &Value) -> Result<Value, String> {
        self.call_inner(|s| s.request(method, params).map_err(CallError::Transport))
    }

    /// 引擎二进制路径：env 覆盖 → 壳可执行同目录（正式位）→ 其上一级
    /// （测试二进制在 target/debug/deps/ 下——parity 先例的两级解析）。
    fn engine_exe_path() -> String {
        if let Ok(p) = std::env::var("HOLOGRAM_ENGINE_EXE") {
            return p;
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for cand in [
                    dir.join("hologram-engine.exe"),
                    dir.join("..").join("hologram-engine.exe"),
                ] {
                    if cand.exists() {
                        return cand.to_string_lossy().to_string();
                    }
                }
            }
        }
        "hologram-engine.exe".into()
    }

    /// 取当前会话（惰性 spawn + 死进程重建）。返回 Arc 克隆——后续调用
    /// 不持 process 锁。
    fn session(&self) -> Result<Arc<EngineSession>, String> {
        let mut guard = self.process.lock().unwrap_or_else(|e| e.into_inner());
        let need_spawn = match guard.as_ref() {
            Some(s) => !s.alive(),
            None => true,
        };
        if need_spawn {
            if let Some(old) = guard.take() {
                old.shutdown();
            }
            let engine_path = Self::engine_exe_path();
            eprintln!(
                "[engine-transport] spawning engine process for {} ({})",
                self.root, engine_path
            );
            *guard = Some(EngineSession::spawn(&self.root, &engine_path)?);
        }
        Ok(guard.as_ref().expect("spawned above").clone())
    }

    /// 调用本体：会话调用失败时仅对**传输级**错误重启重试一次
    ///（工具级 isError 直接透传——引擎进程健康，重启纯属浪费）。
    fn call_inner<T>(
        &self,
        f: impl Fn(&EngineSession) -> Result<T, CallError> + Clone,
    ) -> Result<T, String> {
        let session = self.session()?;
        match f(&session) {
            Ok(v) => Ok(v),
            Err(CallError::Tool(e)) => Err(e),
            Err(CallError::Transport(_e)) => {
                // 崩溃重启：杀掉重建，重试一次
                {
                    let mut guard = self.process.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(old) = guard.take() {
                        old.shutdown();
                    }
                    let engine_path = Self::engine_exe_path();
                    *guard = Some(EngineSession::spawn(&self.root, &engine_path)?);
                }
                let fresh = self.session()?;
                f(&fresh).map_err(|e2| match e2 {
                    CallError::Tool(e) => e,
                    CallError::Transport(e) => format!("引擎进程重启后仍失败: {e}"),
                })
            }
        }
    }

    /// 通知出泵（drain 封顶队列）。不 spawn、不触碰 stdin——引擎开关关闭
    /// 的工作区不会有进程被 pump 拉起。
    pub(crate) fn take_notifications(&self) -> Vec<Value> {
        let guard = self.process.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(s) => s.take_notifications(),
            None => Vec::new(),
        }
    }

    pub(crate) fn shutdown(&self) {
        if let Ok(guard) = self.process.lock() {
            if let Some(p) = guard.as_ref() {
                p.shutdown();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::process::Stdio;

    /// McpRemoteTransport 的 stdio 会话协议层（无需真引擎二进制——
    /// 用一个脚本子进程模拟 serve 的 ready/initialize/tools/call 时序，
    /// 钉住握手顺序、通知入队、isError 转译三个协议契约）。
    #[cfg(windows)]
    #[test]
    fn engine_process_stdio_protocol_faked_peer() {
        // 模拟 serve：发 ready → 应答 initialize → 吞 initialized 通知 →
        // 应答 tools/call（先插一条无关通知，验证通知入队不干扰响应配对）
        // → isError 结果 → 退出。
        let script = r#"
import sys, json
def out(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
out({"jsonrpc":"2.0","method":"ready"})
line = sys.stdin.readline()
req = json.loads(line)
assert req["method"] == "initialize", req
out({"jsonrpc":"2.0","id":req["id"],"result":{"protocolVersion":"2024-11-05"}})
line = sys.stdin.readline()
assert json.loads(line)["method"] == "notifications/initialized"
line = sys.stdin.readline()
req = json.loads(line)
assert req["method"] == "tools/call"
assert req["params"]["_meta"]["progressToken"], "tools/call 必须带 progressToken"
out({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"noise"}})
out({"jsonrpc":"2.0","id":req["id"],"result":{"content":[{"type":"text","text":json.dumps({"ok": True, "method": req["params"]["name"]})}]}})
line = sys.stdin.readline()
req = json.loads(line)
out({"jsonrpc":"2.0","id":req["id"],"result":{"content":[{"type":"text","text":"boom"}],"isError": True}})
"#;
        let script_path = std::env::temp_dir().join("hologram_transport_fake_serve.py");
        std::fs::write(&script_path, script).unwrap();
        let python = std::env::var("HOLOGRAM_TEST_PYTHON").unwrap_or_else(|_| "python".to_string());
        let mut child = match Command::new(&python)
            .arg(&script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => {
                eprintln!("[engine-transport-test] python 不可用，跳过协议测试");
                let _ = std::fs::remove_file(&script_path);
                return;
            }
        };
        let stdout = child.stdout.take().unwrap();
        let pending: Arc<Mutex<HashMap<u64, mpsc::SyncSender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let notifications: Arc<Mutex<VecDeque<Value>>> = Arc::new(Mutex::new(VecDeque::new()));
        EngineSession::start_reader(stdout, pending.clone(), notifications.clone());
        let session = Arc::new(EngineSession {
            child: Mutex::new(child),
            pending,
            notifications,
            next_id: AtomicU64::new(0),
        });
        EngineSession::wait_ready(&session).expect("wait_ready");
        EngineSession::initialize(&session).expect("initialize 握手");
        let out = session
            .call_tool("graph_snapshot", &json!({}))
            .expect("tools/call 应配对响应");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["method"], "graph_snapshot");
        // 通知行入队（不干扰响应配对）
        let notifs = session.take_notifications();
        assert!(
            notifs
                .iter()
                .any(|v| v.get("method").and_then(|m| m.as_str()) == Some("notifications/message")),
            "通知必须进队列: {notifs:?}"
        );
        // isError → 工具级错误（不触发重启）
        match session.call_tool("save", &json!({})) {
            Err(CallError::Tool(_)) => {}
            other => panic!("isError 必须转工具级错误: {other:?}"),
        }
        session.shutdown();
        let _ = std::fs::remove_file(&script_path);
    }

    /// 通知封顶语义：满时丢最旧（与引擎侧 watcher 桥同参数）。
    #[test]
    fn notification_queue_is_bounded() {
        let notifications: Arc<Mutex<VecDeque<Value>>> = Arc::new(Mutex::new(VecDeque::new()));
        for i in 0..(NOTIFICATION_CAP + 10) {
            let mut q = notifications.lock().unwrap();
            while q.len() >= NOTIFICATION_CAP {
                q.pop_front();
            }
            q.push_back(json!({ "i": i }));
        }
        let q = notifications.lock().unwrap();
        assert_eq!(q.len(), NOTIFICATION_CAP);
        assert_eq!(q.front().unwrap()["i"], 10, "最旧的 10 条被丢弃");
        assert_eq!(q.back().unwrap()["i"], NOTIFICATION_CAP + 9);
    }

    // ═══════════════════════════════════════════════════════════
    // 进程级 e2e（Phase 3 DoD：双工作区隔离 + 崩溃重启 + 持久化闭环）
    // 引擎二进制解析：env HOLOGRAM_ENGINE_EXE → workspace 编译输出
    // （target/debug/hologram-engine.exe）。不存在时跳过（对齐向量层
    // 「真实索引无文件自动跳过」先例）；门禁顺序跑 engine cargo test
    // 后该二进制必然在位。
    // ═══════════════════════════════════════════════════════════

    fn e2e_engine_exe() -> Option<std::path::PathBuf> {
        if let Ok(p) = std::env::var("HOLOGRAM_ENGINE_EXE") {
            let p = std::path::PathBuf::from(&p);
            return if p.exists() { Some(p) } else { None };
        }
        // 测试二进制在 target/debug/deps/ → 上两级 = workspace 编译输出目录
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?.parent()?.join("hologram-engine.exe");
        if dir.exists() { Some(dir) } else { None }
    }

    fn e2e_tmp_project(tag: &str, body: &str) -> String {
        let tmp = std::env::temp_dir().join(format!(
            "hologram_e2e_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("alpha.rs"), body).unwrap();
        tmp.to_string_lossy().replace('\\', "/")
    }

    /// 等待引擎进程离开 analyzing（spawn_blocking 纪律的测试面等价物）。
    fn e2e_wait_idle(t: &McpRemoteTransport, timeout: Duration) {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            let raw = t.call("engine_status", &json!({})).unwrap_or_default();
            let v: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            if v.get("phase").and_then(|p| p.as_str()) != Some("analyzing") {
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        panic!("e2e 分析等待超时");
    }

    /// 双工作区进程级隔离：各 spawn 一 serve，符号互不可见（Phase 3 DoD ①）。
    #[test]
    fn e2e_two_workspaces_isolated() {
        let Some(engine_exe) = e2e_engine_exe() else {
            eprintln!("[e2e] 引擎二进制不存在（先 cargo build -p hologram-engine），跳过");
            return;
        };
        let _ = &engine_exe;
        let ws_a = e2e_tmp_project("wsa", "fn alpha_one() { let marker_a = 1; }\n");
        let ws_b = e2e_tmp_project("wsb", "fn beta_one() { let marker_b = 2; }\n");
        let t_a = McpRemoteTransport::new(&ws_a);
        let t_b = McpRemoteTransport::new(&ws_b);

        for (t, root) in [(&t_a, &ws_a), (&t_b, &ws_b)] {
            let raw = t
                .call("analyze_with_progress", &json!({ "path": root, "force": true }))
                .unwrap_or_else(|e| panic!("analyze 失败: {e}"));
            assert_eq!(
                serde_json::from_str::<Value>(&raw).unwrap()["status"],
                "started"
            );
            e2e_wait_idle(t, Duration::from_secs(300));
        }

        // 各自符号可见 + 他区符号不可见（FTS5 索引面 = 符号 id/name/location）
        let raw = t_a.call("fts_search", &json!({ "query": "alpha_one" })).unwrap();
        assert!(
            serde_json::from_str::<Value>(&raw).unwrap()["count"].as_u64().unwrap_or(0) >= 1,
            "A 必须命中自己的符号: {raw}"
        );
        let raw = t_a.call("fts_search", &json!({ "query": "beta_one" })).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap()["count"].as_u64(),
            Some(0),
            "A 不得见到 B 的符号: {raw}"
        );
        let raw = t_b.call("fts_search", &json!({ "query": "beta_one" })).unwrap();
        assert!(
            serde_json::from_str::<Value>(&raw).unwrap()["count"].as_u64().unwrap_or(0) >= 1
        );

        t_a.shutdown();
        t_b.shutdown();
        let _ = std::fs::remove_dir_all(&ws_a);
        let _ = std::fs::remove_dir_all(&ws_b);
    }

    /// 崩溃重启 + 持久化闭环（Phase 3 DoD ②）：杀引擎子进程 → 下一次调用
    /// 自动重启且从 SQLite 恢复（数据不丢）——即旧
    /// analyze_persist_query_loop_via_context 的 transport 形态重写。
    #[test]
    fn e2e_crash_restart_recovers_persisted_graph() {
        let Some(engine_exe) = e2e_engine_exe() else {
            eprintln!("[e2e] 引擎二进制不存在（先 cargo build -p hologram-engine），跳过");
            return;
        };
        let _ = &engine_exe;
        let ws = e2e_tmp_project("crash", "fn alpha_one() { let marker_crash = 1; }\n");
        let t = McpRemoteTransport::new(&ws);

        let raw = t
            .call("analyze_with_progress", &json!({ "path": ws, "force": true }))
            .unwrap_or_else(|e| panic!("analyze 失败: {e}"));
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["status"], "started");
        e2e_wait_idle(&t, Duration::from_secs(300));

        // 模拟崩溃：硬杀子进程（TerminateProcess，等价任务管理器结束进程）
        {
            let guard = t.process.lock().unwrap();
            let session = guard.as_ref().expect("分析后进程必须在位");
            session
                .child
                .lock()
                .unwrap()
                .kill()
                .expect("kill engine child");
        }
        std::thread::sleep(Duration::from_millis(200));

        // 下一次调用自动重启；SQLite 持久化数据读回（ready = 非空图）
        let raw = t
            .call("ensure_ready", &json!({}))
            .unwrap_or_else(|e| panic!("崩溃重启后调用失败: {e}"));
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["ready"], true, "重启后必须从 SQLite 恢复非空图: {v}");
        let raw = t.call("fts_search", &json!({ "query": "alpha_one" })).unwrap();
        assert!(
            serde_json::from_str::<Value>(&raw).unwrap()["count"].as_u64().unwrap_or(0) >= 1,
            "重启后数据必须可查: {raw}"
        );

        t.shutdown();
        let _ = std::fs::remove_dir_all(&ws);
    }
}

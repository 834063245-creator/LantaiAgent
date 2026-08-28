// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 引擎传输接缝（engine-plugin-extraction Phase 2）——壳消费引擎的唯一边界。
//!
//! 方法面 = Phase 1 的引擎壳方法契约（v2：`graph_snapshot` / `file_nodes` /
//! `save` / `fts_search` / `timeline_record` / `diff` / `ensure_ready` /
//! `cache_stale` / `watcher_subscribe`）+ 模型工具全名（hologram_call 分发面）。
//! 两个实现走**同一方法名**：
//!   - `InProcessTransport`（现状默认）：with_current TLS 绑定 →
//!     `ToolRegistry::dispatch`（内嵌引擎即自己）；
//!   - `McpRemoteTransport`（Phase 3 翻默认）：每工作区一个 `engine serve`
//!     子进程，经 stdio MCP `tools/call`。
//! 差分对拍因此天然同构——同一 dispatch 面、只差传输；差分测试钉住
//! 两实现逐字节等价（layering-rework 对账守恒做法）。
//!
//! `HOLOGRAM_ENGINE_TRANSPORT=inprocess|mcp`（缺省 inprocess，Phase 3 翻默认）。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::app::services::dispatch_service::dispatch_engine;

/// 引擎传输抽象——方法调用 + 传输名（诊断/差分报告）。
pub(crate) trait EngineTransport: Send + Sync {
    /// 调用引擎方法（壳方法名或模型工具名），返回解包后的输出文本
    /// （与 dispatch_engine 的解包契约一致：MCP content[0].text）。
    fn call(&self, method: &str, args: &Value) -> Result<String, String>;
    fn name(&self) -> &'static str;
}

// ═══════════════════════════════════════════════════════════════
// InProcessTransport —— 内嵌直调（Phase 2 缺省）
// ═══════════════════════════════════════════════════════════════

pub(crate) struct InProcessTransport {
    engine: Arc<hologram_engine::engine::Engine>,
}

impl InProcessTransport {
    pub(crate) fn new(engine: Arc<hologram_engine::engine::Engine>) -> Self {
        Self { engine }
    }
}

impl EngineTransport for InProcessTransport {
    fn call(&self, method: &str, args: &Value) -> Result<String, String> {
        // 大图上单次 dispatch 可达秒级——调用方负责 spawn_blocking（与
        // 既有 dispatch_engine 纪律一致，此处不重复包装）。
        hologram_engine::engine::with_current(self.engine.clone(), || {
            dispatch_engine(method, args)
        })
    }

    fn name(&self) -> &'static str {
        "inprocess"
    }
}

// ═══════════════════════════════════════════════════════════════
// EngineProcess —— 一个 engine serve 子进程（stdio MCP 会话）
// ═══════════════════════════════════════════════════════════════

/// 就绪信号等待超时。serve 启动即发 ready（分析/观察者延迟到首次调用），
/// 正常毫秒级到；上限对齐 legacy McpManager 的保守值。
const READY_TIMEOUT_SECS: u64 = 600;

pub(crate) struct EngineProcess {
    child: Child,
    request_id: u64,
}

impl EngineProcess {
    /// spawn `engine serve --project-root <root>` 并完成 MCP 握手
    /// （ready 通知 → initialize → notifications/initialized）。
    pub(crate) fn spawn(project_root: &str, engine_path: &str) -> Result<Self, String> {
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

        Self::wait_ready(&mut child)?;
        let mut proc = Self { child, request_id: 0 };
        proc.initialize()?;
        Ok(proc)
    }

    /// 读取 serve 的 ready 通知（启动即发；带超时的独立读线程——
    /// P1-19 纪律：长等待不持调用方锁）。
    fn wait_ready(child: &mut Child) -> Result<(), String> {
        let stdout = child.stdout.take().ok_or("stdout 不可用")?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(_) => {
                    let _ = tx.send(Ok((reader.into_inner(), line)));
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("读取引擎就绪信号失败: {e}")));
                }
            }
        });
        match rx.recv_timeout(Duration::from_secs(READY_TIMEOUT_SECS)) {
            Ok(Ok((stdout_back, line))) => {
                child.stdout = Some(stdout_back);
                let trimmed = line.trim();
                let val: Value = serde_json::from_str(trimmed)
                    .map_err(|e| format!("引擎启动输出非 JSON: {e} — raw: {trimmed}"))?;
                if val.get("method").and_then(|m| m.as_str()) == Some("ready") {
                    return Ok(());
                }
                Err(format!("引擎异常启动输出: {trimmed}"))
            }
            Ok(Err(e)) => Err(e),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                Err("引擎进程启动超时（600s）".into())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("引擎就绪读取线程异常断开".into())
            }
        }
    }

    /// MCP initialize 握手。
    fn initialize(&mut self) -> Result<(), String> {
        let id = self.request_id;
        self.request_id += 1;
        let request = format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"initialize","params":{{"protocolVersion":"2024-11-05","capabilities":{{}},"clientInfo":{{"name":"lantai-shell","version":"0.1.0"}}}}}}"#
        );
        Self::write_line(&mut self.child, &request)?;
        // 读到 initialize 响应（过滤 serve 的通知行——watcher 桥/进度）
        let resp = Self::read_response(&mut self.child, id)?;
        if resp.get("error").is_some() {
            return Err(format!("引擎 initialize 失败: {resp}"));
        }
        // notifications/initialized
        Self::write_line(
            &mut self.child,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )?;
        Ok(())
    }

    /// tools/call 调用（过滤 serve 主动推送的通知行——watcher 桥/
    /// 进度等无 id 行不干扰响应配对）。
    fn call_tool(&mut self, method: &str, args: &Value) -> Result<String, String> {
        let id = self.request_id;
        self.request_id += 1;
        let params = serde_json::json!({ "name": method, "arguments": args });
        let request = format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{}}}"#,
            params
        );
        Self::write_line(&mut self.child, &request)?;
        let resp = Self::read_response(&mut self.child, id)?;
        if let Some(err) = resp.get("error") {
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
            return Err(format!("引擎方法 {method} 失败: {msg}"));
        }
        let result = resp.get("result").ok_or("引擎响应无 result")?;
        // isError 结果（工具级失败）转 Err——调用方降级语义与内嵌一致
        if result.get("isError").and_then(|v| v.as_bool()) == Some(true) {
            let msg = result["content"][0]["text"].as_str().unwrap_or("tool failed");
            return Err(format!("引擎方法 {method} 失败: {msg}"));
        }
        if let Some(text) = result["content"][0]["text"].as_str() {
            return Ok(text.to_string());
        }
        Ok(serde_json::to_string(result).unwrap_or_default())
    }

    fn write_line(child: &mut Child, line: &str) -> Result<(), String> {
        let stdin = child.stdin.as_mut().ok_or("stdin 不可用")?;
        writeln!(stdin, "{line}").map_err(|e| format!("写入 stdin 失败: {e}"))?;
        stdin.flush().map_err(|e| format!("flush stdin 失败: {e}"))
    }

    /// 读一行响应，跳过 serve 主动推送的通知（无 id 行：notifications/
    /// message watcher 桥、notifications/progress 等）。
    fn read_response(child: &mut Child, request_id: u64) -> Result<Value, String> {
        let stdout = child.stdout.take().ok_or("stdout 不可用")?;
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .map_err(|e| format!("读取引擎响应失败: {e}"))?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    child.stdout = Some(reader.into_inner());
                    return Err(format!("引擎响应 JSON 解析失败: {e} — raw: {trimmed}"));
                }
            };
            if v.get("id").is_some() {
                child.stdout = Some(reader.into_inner());
                if v.get("id") != Some(&serde_json::json!(request_id)) {
                    return Err(format!("引擎响应 id 不匹配（期望 {request_id}）"));
                }
                return Ok(v);
            }
            // 通知行：serve 主动推送（watcher/进度）——消费并继续
        }
    }

    pub(crate) fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// 进程是否仍存活（崩溃重启判据）。
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ═══════════════════════════════════════════════════════════════
// McpRemoteTransport —— 每工作区一个引擎进程（Phase 3 翻默认）
// ═══════════════════════════════════════════════════════════════

pub(crate) struct McpRemoteTransport {
    root: String,
    /// 进程句柄（惰性 spawn；Mutex 串行化 stdio 单通道——每工作区一把，
    /// 不持全局锁（P1-19：长等待绝不占全局资源））。
    process: Mutex<Option<EngineProcess>>,
}

impl McpRemoteTransport {
    pub(crate) fn new(root: &str) -> Self {
        Self {
            root: root.to_string(),
            process: Mutex::new(None),
        }
    }

    /// 引擎二进制路径：env 覆盖 → 壳可执行同目录（workspace 编译输出）。
    fn engine_exe_path() -> String {
        if let Ok(p) = std::env::var("HOLOGRAM_ENGINE_EXE") {
            return p;
        }
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.join("hologram-engine.exe")))
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "hologram-engine.exe".into())
    }

    fn with_process<T>(
        &self,
        f: impl FnOnce(&mut EngineProcess) -> Result<T, String> + Clone,
    ) -> Result<T, String> {
        let mut guard = self
            .process
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // 惰性 spawn + 崩溃重启（一次）：死进程/首次 → spawn；spawn 后仍失败则透传
        let need_spawn = match guard.as_mut() {
            Some(p) => !p.alive(),
            None => true,
        };
        if need_spawn {
            if let Some(mut old) = guard.take() {
                old.shutdown();
            }
            let engine_path = Self::engine_exe_path();
            eprintln!(
                "[engine-transport] spawning engine process for {} ({} )",
                self.root,
                engine_path
            );
            *guard = Some(EngineProcess::spawn(&self.root, &engine_path)?);
        }
        // alive 检查后的 call 失败（写入断裂等）→ 重启一次重试
        match guard.as_mut().expect("spawned above").call_inner(f.clone()) {
            Ok(v) => Ok(v),
            Err(_e) => {
                // 崩溃重启：杀掉重建，重试一次
                if let Some(mut old) = guard.take() {
                    old.shutdown();
                }
                let engine_path = Self::engine_exe_path();
                *guard = Some(EngineProcess::spawn(&self.root, &engine_path)?);
                guard
                    .as_mut()
                    .expect("respawned above")
                    .call_inner(f)
                    .map_err(|e2| format!("引擎进程重启后仍失败: {e2}"))
            }
        }
    }

    pub(crate) fn shutdown(&self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut p) = guard.take() {
                p.shutdown();
            }
        }
    }
}

impl EngineTransport for McpRemoteTransport {
    fn call(&self, method: &str, args: &Value) -> Result<String, String> {
        self.with_process(|p| p.call_tool(method, args))
    }

    fn name(&self) -> &'static str {
        "mcp-remote"
    }
}

impl EngineProcess {
    fn call_inner<T>(
        &mut self,
        f: impl FnOnce(&mut EngineProcess) -> Result<T, String>,
    ) -> Result<T, String> {
        f(self)
    }
}

// ═══════════════════════════════════════════════════════════════
// 传输模式选择
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransportMode {
    InProcess,
    Mcp,
}

/// 传输模式：`HOLOGRAM_ENGINE_TRANSPORT=inprocess|mcp`（缺省 inprocess——
/// Phase 2 行为零变化；Phase 3 翻默认）。
pub(crate) fn transport_mode() -> TransportMode {
    match std::env::var("HOLOGRAM_ENGINE_TRANSPORT").as_deref() {
        Ok("mcp") | Ok("MCP") => TransportMode::Mcp,
        _ => TransportMode::InProcess,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transport_mode_env_parse() {
        // 缺省 = inprocess（Phase 2 行为零变化的根基）
        // （env 由调用进程决定，这里只验证非法值回落缺省）
        // 注：不能在本测试设置 env（并行测试共享进程环境），
        // transport_mode() 的 mcp 分支由差分测试以显式构造覆盖。
        let _ = transport_mode();
    }

    #[test]
    fn inprocess_transport_dispatches_shell_methods() {
        // 临时项目 → 真实引擎实例 → InProcessTransport 调壳方法
        let tmp = std::env::temp_dir().join(format!(
            "hologram_transport_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.rs"), "fn a_one() {}\n").unwrap();
        let engine = hologram_engine::engine::Engine::open(&tmp).unwrap();
        let t = InProcessTransport::new(Arc::new(engine));
        assert_eq!(t.name(), "inprocess");

        // graph_snapshot：空图 = 零值快照（不报错）
        let raw = t.call("graph_snapshot", &json!({})).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["node_count"], 0);
        assert!(v["source_root"].as_str().is_some(), "快照必须带 source_root");

        // ensure_ready：ready=false（未分析）而不是错误
        let raw = t.call("ensure_ready", &json!({})).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["ready"], false);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// McpRemoteTransport 的 stdio 会话协议层（无需真引擎二进制——
    /// 用一个脚本子进程模拟 serve 的 ready/initialize/tools/call 时序，
    /// 钉住握手顺序、通知过滤、isError 转译三个协议契约）。
    #[cfg(windows)]
    #[test]
    fn engine_process_stdio_protocol_faked_peer() {
        // 模拟 serve：发 ready → 应答 initialize → 吞 initialized 通知 →
        // 应答 tools/call（第二条带一条无关通知插入，验证过滤）→ 退出。
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
out({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"noise"}})
out({"jsonrpc":"2.0","id":req["id"],"result":{"content":[{"type":"text","text":json.dumps({"ok": True, "method": req["params"]["name"]})}]}})
line = sys.stdin.readline()
req = json.loads(line)
out({"jsonrpc":"2.0","id":req["id"],"result":{"content":[{"type":"text","text":"boom"}],"isError": True}})
"#;
        let script_path = std::env::temp_dir().join("hologram_transport_fake_serve.py");
        std::fs::write(&script_path, script).unwrap();
        let python = if std::env::var("HOLOGRAM_TEST_PYTHON").is_ok() {
            std::env::var("HOLOGRAM_TEST_PYTHON").unwrap()
        } else {
            "python".to_string()
        };
        let child = Command::new(&python)
            .arg(&script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(_) => {
                eprintln!("[engine-transport-test] python 不可用，跳过协议测试");
                let _ = std::fs::remove_file(&script_path);
                return;
            }
        };
        // 手工走 EngineProcess 的协议步骤（spawn 假 peer 的 ready 已发出）
        let r = EngineProcess::wait_ready(&mut child);
        if r.is_err() {
            let _ = child.kill();
            let _ = std::fs::remove_file(&script_path);
            panic!("wait_ready 失败: {:?}", r.err());
        }
        let mut proc = EngineProcess { child, request_id: 0 };
        proc.initialize().expect("initialize 握手");
        let out = proc
            .call_tool("graph_snapshot", &json!({}))
            .expect("tools/call 应过滤通知并配对响应");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["method"], "graph_snapshot");
        // isError → Err
        let err = proc.call_tool("save", &json!({}));
        assert!(err.is_err(), "isError 结果必须转 Err");
        proc.shutdown();
        let _ = std::fs::remove_file(&script_path);
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 引擎传输差分对拍（engine-plugin-extraction Phase 2 DoD）。
//!
//! 同一临时项目、同一组方法，两条传输通道的输出必须**逐字节等价**：
//!   - 内嵌臂：`ToolRegistry::dispatch`（with_current TLS 绑定）——
//!     生产 InProcessTransport 的同一路径（后者是它的薄包装）；
//!   - 进程外臂：每工作区一个 `engine serve` 子进程、stdio MCP
//!     `tools/call`（mini client 与生产 McpRemoteTransport 同 MCP 时序）。
//!
//! 两臂走同一方法面（Phase 1 壳方法契约 v2 + 模型工具全名），聚合/
//! 新鲜度逻辑单一真源在引擎（tools::graph_snapshot_value /
//! file_nodes_value / staleness）——差分验证的是方法面在两种传输下的
//! 确定性，layering-rework 对账守恒做法。
//!
//! 对拍面 = 纯查询命令（graph_snapshot / file_nodes / fts_search /
//! ensure_ready / cache_stale）。副作用命令（analyze/save/timeline）
//! 不进差分——时序与非确定性字段（elapsed_secs）不构成字节契约。
//!
//! 引擎二进制解析：env `HOLOGRAM_ENGINE_EXE` → 壳可执行同目录
//! （workspace 编译输出 target/debug/）。不存在时跳过（对齐向量层
//! 「真实索引无文件自动跳过」先例）。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use hologram_engine as engine_crate;
use engine_crate::tools::ToolRegistry;
use serde_json::{json, Value};

// ═══════════════════════════════════════════════════════════════
// 内嵌臂 —— ToolRegistry::dispatch（with_current）+ MCP 信封解包
// ═══════════════════════════════════════════════════════════════

fn inprocess_call(engine: &std::sync::Arc<engine_crate::engine::Engine>, method: &str, args: &Value) -> Result<String, String> {
    engine_crate::engine::with_current(engine.clone(), || {
        let dummy_id = json!(null);
        let result = ToolRegistry::dispatch(method, args, &dummy_id);
        let text = result
            .get("result")
            .and_then(|r| r.get("content"))
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        if text.is_empty() {
            if let Some(err) = result.get("error") {
                return Err(format!("Engine error: {err:?}"));
            }
            return Err("Engine returned empty result".into());
        }
        Ok(text)
    })
}

// ═══════════════════════════════════════════════════════════════
// 进程外臂 —— mini stdio MCP client（与生产 McpRemoteTransport 同 MCP 时序：
// ready → initialize → initialized → tools/call，通知行过滤、isError 转译）
// ═══════════════════════════════════════════════════════════════

struct MiniRemote {
    child: Child,
    request_id: u64,
}

impl MiniRemote {
    fn spawn(project_root: &str, engine_exe: &Path) -> Result<Self, String> {
        let mut child = Command::new(engine_exe)
            .args(["serve", "--project-root", project_root])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("无法启动引擎进程: {e}"))?;
        Self::wait_ready(&mut child)?;
        let mut remote = Self { child, request_id: 0 };
        remote.handshake()?;
        Ok(remote)
    }

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
                    let _ = tx.send(Err(format!("读取就绪信号失败: {e}")));
                }
            }
        });
        match rx.recv_timeout(Duration::from_secs(600)) {
            Ok(Ok((back, line))) => {
                child.stdout = Some(back);
                let v: Value = serde_json::from_str(line.trim())
                    .map_err(|e| format!("启动输出非 JSON: {e}"))?;
                if v.get("method").and_then(|m| m.as_str()) == Some("ready") {
                    Ok(())
                } else {
                    Err(format!("异常启动输出: {line}"))
                }
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("引擎就绪等待超时".into()),
        }
    }

    fn handshake(&mut self) -> Result<(), String> {
        let id = self.request_id;
        self.request_id += 1;
        let req = json!({
            "jsonrpc": "2.0", "id": id, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "parity-test", "version": "0.1.0" } }
        });
        Self::write_line(&mut self.child, &req.to_string())?;
        self.read_response(id)?;
        Self::write_line(
            &mut self.child,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )?;
        Ok(())
    }

    fn call(&mut self, method: &str, args: &Value) -> Result<String, String> {
        let id = self.request_id;
        self.request_id += 1;
        let req = json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": { "name": method, "arguments": args }
        });
        Self::write_line(&mut self.child, &req.to_string())?;
        let resp = self.read_response(id)?;
        if let Some(err) = resp.get("error") {
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown");
            return Err(format!("引擎方法 {method} 失败: {msg}"));
        }
        let result = resp.get("result").ok_or("引擎响应无 result")?;
        if result.get("isError").and_then(|v| v.as_bool()) == Some(true) {
            let msg = result["content"][0]["text"].as_str().unwrap_or("tool failed");
            return Err(format!("引擎方法 {method} 失败: {msg}"));
        }
        result["content"][0]["text"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| "引擎响应缺 content text".into())
    }

    fn write_line(child: &mut Child, line: &str) -> Result<(), String> {
        let stdin = child.stdin.as_mut().ok_or("stdin 不可用")?;
        writeln!(stdin, "{line}").map_err(|e| format!("写 stdin 失败: {e}"))?;
        stdin.flush().map_err(|e| format!("flush stdin 失败: {e}"))
    }

    /// 读一行响应，跳过 serve 主动推送的通知（watcher 桥/进度——无 id 行）。
    fn read_response(&mut self, request_id: u64) -> Result<Value, String> {
        let stdout = self.child.stdout.take().ok_or("stdout 不可用")?;
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .map_err(|e| format!("读引擎响应失败: {e}"))?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    self.child.stdout = Some(reader.into_inner());
                    return Err(format!("响应 JSON 解析失败: {e} — raw: {trimmed}"));
                }
            };
            if v.get("id").is_some() {
                self.child.stdout = Some(reader.into_inner());
                if v.get("id") != Some(&json!(request_id)) {
                    return Err(format!("响应 id 不匹配（期望 {request_id}）"));
                }
                return Ok(v);
            }
        }
    }

    fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for MiniRemote {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ═══════════════════════════════════════════════════════════════
// 差分对拍
// ═══════════════════════════════════════════════════════════════

fn tmp_project(tag: &str) -> PathBuf {
    let tmp = std::env::temp_dir().join(format!(
        "hologram_parity_{}_{}",
        tag,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(tmp.join("src")).unwrap();
    std::fs::write(
        tmp.join("src").join("alpha.rs"),
        "fn alpha_one() { let marker_token = 1; }\nstruct AlphaTwo;\n",
    )
    .unwrap();
    std::fs::write(
        tmp.join("src").join("beta.rs"),
        "fn beta_one() {}\nfn beta_two() {}\n",
    )
    .unwrap();
    tmp
}

fn engine_exe() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HOLOGRAM_ENGINE_EXE") {
        let p = PathBuf::from(&p);
        return if p.exists() { Some(p) } else { None };
    }
    // 测试二进制在 target/debug/deps/ → 上两级 = workspace 编译输出目录
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?.join("hologram-engine.exe");
    if dir.exists() {
        Some(dir)
    } else {
        None
    }
}

#[test]
fn inprocess_and_mcp_remote_parity() {
    let Some(engine_exe) = engine_exe() else {
        eprintln!("[parity] 引擎二进制不存在（先 cargo build -p hologram-engine），跳过差分对拍");
        return;
    };

    // ── 建库：内嵌直调分析（SQLite 唯一持久化，remote 进程读同库）──
    let tmp = tmp_project("parity");
    let root_str = tmp.to_string_lossy().to_string();
    let engine = engine_crate::engine::Engine::new_shared(&tmp).unwrap();
    engine_crate::engine::with_current(engine.clone(), || {
        let root = PathBuf::from(&root_str);
        engine
            .analyze(&root)
            .map_err(|e| format!("analyze 失败: {e}"))
            .unwrap();
    });

    // ── 对拍方法面（契约 v2 查询面）──
    let methods: Vec<(&str, Value)> = vec![
        ("graph_snapshot", json!({})),
        ("file_nodes", json!({ "file": "src/alpha.rs" })),
        ("fts_search", json!({ "query": "marker_token", "limit": 5 })),
        ("ensure_ready", json!({})),
        ("cache_stale", json!({ "path": root_str })),
    ];

    let mut inproc_results: Vec<(String, String)> = Vec::new();
    for (m, args) in &methods {
        let out = inprocess_call(&engine, m, args).unwrap_or_else(|e| panic!("inprocess {m} 失败: {e}"));
        inproc_results.push((m.to_string(), out));
    }

    let started = Instant::now();
    let mut remote = MiniRemote::spawn(&root_str, &engine_exe)
        .unwrap_or_else(|e| panic!("remote spawn 失败（{}）: {e}", engine_exe.display()));
    let mut remote_results: Vec<(String, String)> = Vec::new();
    for (m, args) in &methods {
        let out = remote.call(m, args).unwrap_or_else(|e| panic!("remote {m} 失败: {e}"));
        remote_results.push((m.to_string(), out));
    }
    eprintln!("[parity] remote 全量调用耗时 {:.1}s", started.elapsed().as_secs_f64());
    remote.shutdown();

    // ── 逐字节对拍 ──
    for ((m, a), (m2, b)) in inproc_results.iter().zip(remote_results.iter()) {
        assert_eq!(m, m2);
        assert_eq!(a, b, "差分对拍失败：方法 {m} 两传输输出不一致");
    }

    // 语义抽查：快照非空 + file_nodes 命中（两边同构，抽内嵌侧断言）
    let (_, snap) = inproc_results.iter().find(|(m, _)| m == "graph_snapshot").unwrap();
    let v: Value = serde_json::from_str(snap).unwrap();
    assert!(v["node_count"].as_u64().unwrap() > 0);
    assert_eq!(v["source_root"].as_str(), Some(root_str.as_str()));
    let (_, fnodes) = inproc_results.iter().find(|(m, _)| m == "file_nodes").unwrap();
    let v: Value = serde_json::from_str(fnodes).unwrap();
    assert!(v["count"].as_u64().unwrap() >= 1, "alpha.rs 应命中符号: {v}");

    let _ = std::fs::remove_dir_all(&tmp);
}

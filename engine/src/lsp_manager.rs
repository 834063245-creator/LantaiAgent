// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! # LSP 管理器 —— 长生命周期的 LSP 服务器池
//!
//! 用于按需解析函数调用关系。
//!
//! ## 架构
//! ```text
//! LspManager（惰性单例）→ ServerPool → 每种语言一个 LSP 进程
//! 每个服务器：通过 stdio JSON-RPC 通信，首次使用时启动，永久存活
//! ```
//!
//! ## 生命周期
//! - 索引完成 → `pool.warm_filtered(project_root, exts)` → 后台启动索引中
//!   实际出现的语言服务器；索引未建立的窗口只 `mark_initialized`，
//!   查询到来时惰性拉起被查询的那一门语言
//! - Agent 查询 → `pool.resolve(file, l, c)` → JSON-RPC textDocument/definition
//! - UI 影响范围 → `pool.references(file, l, c)` → JSON-RPC textDocument/references
//!
//! ## 降级策略
//! 如果服务器无法启动（未安装 / spawn 失败 / 内存门禁 / 预热失败），
//! 透明降级到现有的手写适配器。
//!
//! ## 生存性三闸（2026-09-09 事故后）
//! - **内存门禁**：系统可用提交内存不足时拒绝拉新服务器——
//!   多窗口并行时每个引擎各拉全套舰队，16GB 机器提交内存耗尽，
//!   gopls 直接 VirtualAlloc 失败（errno=1455）。
//! - **超时不杀**：冷启动服务器（rust-analyzer 全量索引 1-2 分钟）
//!   首次查询几乎必然超 5s；原实现超时即杀进程重拉，重拉又从零
//!   索引、又被杀——服务器永远活不过索引期（杀-重生循环）。
//!   现在超时把 Receiver 存进回收盒等读线程送回 reader，冷窗口
//!   （150s）内进程保留，窗口耗尽才销毁重建。
//! - **重生退避**：同一命令死亡/失败后至少间隔 30s 才允许再拉，
//!   防止「查询→失败→重拉→再失败」的风暴被并行查询放大。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use serde_json::{json, Value};

// ═══════════════════════════════════════════════════════════════
// LSP 服务器进程句柄
// ═══════════════════════════════════════════════════════════════

/// 默认 LSP 请求超时时间。
/// ponytail: 曾为 30s。typescript-language-server 在这台机器上
/// 初始化后 references 请求 30s 不响应（服务器侧环境问题），
/// 导致工具调用卡死 30s 才 fallback。降到 5s 快速失败 ——
/// LSP 可用时 5s 足够（本地语言服务器响应毫秒级），
/// 不可用时避免长时间阻塞用户。
/// 注意：超时不再销毁进程（见 [`LspProcess::send_request`] 的
/// 迟到响应回收机制），只影响本次调用。
const LSP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 冷启动窗口：服务器 spawn 后这段时间内，查询超时不算死刑——
/// 重型服务器（rust-analyzer 对大型仓库冷索引需 1-2 分钟）首次
/// 请求大概率超 5s；窗口内进程保留等读线程送回 reader，
/// 窗口耗尽仍未恢复才销毁重建。
const LSP_COLD_WINDOW: std::time::Duration = std::time::Duration::from_secs(150);

/// 同一命令的重生退避：spawn 尝试（含失败）后至少间隔这么久
/// 才允许再拉，防止「查询→失败→重拉→再失败」风暴。
const RESPAWN_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(30);

/// LSP spawn 内存门禁阈值（系统可用提交内存，MB）。
/// 2026-09-09 事故：16GB 机器上 6 个引擎进程并行各拉全套舰队，
/// 提交内存耗尽，gopls 直接 VirtualAlloc 失败（errno=1455），
/// 所有 LSP 查询全线报错。低于此值时拒绝拉新服务器，工具
/// 透明降级，原因可在 engine_status 的 lsp.error 里看到。
const MIN_SPAWN_COMMIT_MB: u64 = 3072;

/// 宿主进程身份标志（模块级静态，Rust impl 块不允许关联 static）：
/// hologram-lspd 主函数置位——宿主内的 LspManager 调用永远走本地池，
/// 绝不作为客户端连自己（防递归）。
static DAEMON_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 单个 LSP 服务器进程的句柄。
///
/// 持有子进程的 stdin/stdout/stderr，维护自增的请求 ID，
/// 通过 LSP Content-Length 帧协议读写 JSON-RPC 消息。
struct LspProcess {
    process: Child,
    /// Arc<Mutex> 包装：读响应线程也需要写回复
    /// （服务器发来的 workspace/configuration 等请求必须回 null，
    ///   否则服务器阻塞、后续所有查询排队超时）。
    stdin: Arc<Mutex<ChildStdin>>,
    reader: Option<BufReader<std::process::ChildStdout>>,
    #[allow(dead_code)]
    stderr: Option<std::process::ChildStderr>,
    next_id: u64,
    timeout: std::time::Duration,
    /// spawn 时刻：冷窗口判定的基准。
    spawned_at: std::time::Instant,
    /// 冷启动窗口时长（测试可覆写）。
    cold_window: std::time::Duration,
    /// 迟到响应回收盒：上次超时后读线程仍在等旧响应。
    /// 读线程完成后经 channel 把 reader 送回，下次调用收割。
    /// None = 无悬挂请求；Some(Empty) = 旧响应未到（服务器忙/索引中）。
    late_rx: Option<
        std::sync::mpsc::Receiver<(
            BufReader<std::process::ChildStdout>,
            Result<Value, String>,
        )>,
    >,
}

impl LspProcess {
    /// 以 LSP Content-Length 帧协议写一条完整消息。
    /// 静态版本供读线程（无 &self）回复服务器请求使用。
    fn write_message_static(stdin: &Arc<Mutex<ChildStdin>>, body: &str) -> Result<(), String> {
        let mut stdin = stdin.lock().map_err(|e| format!("stdin lock: {}", e))?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        stdin.write_all(header.as_bytes()).map_err(|e| format!("write: {}", e))?;
        stdin.write_all(body.as_bytes()).map_err(|e| format!("write body: {}", e))?;
        stdin.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    fn write_message(&self, body: &str) -> Result<(), String> {
        Self::write_message_static(&self.stdin, body)
    }

    /// 冷启动提示（#7）：spawn 后的 `cold_window` 内服务器多在索引整个项目，
    /// **空结果不代表「这个位置没有东西」**。返回 Some(原因) = 别把空结果当真。
    ///
    /// 为什么放在这里：首次查询会触发 lazy warm（实测 432ms 拉起 rust-analyzer，
    /// 但它随后要索引几分钟），此时 `textDocument/definition` 如实回空——旧行为
    /// 让这次必然的空结果一路降级成「去装 LSP 服务器」，把「索引中」说成「缺东西」。
    fn cold_start_note(&self) -> Option<String> {
        let elapsed = self.spawned_at.elapsed();
        if elapsed >= self.cold_window {
            return None;
        }
        Some(format!(
            "LSP busy: server still indexing (cold start, {:.0}s elapsed) — empty result is not conclusive, retry later",
            elapsed.as_secs()
        ))
    }

    /// 发送 JSON-RPC 请求并等待响应。
    ///
    /// LSP 服务器会在请求/响应周期之间异步发送诊断和日志通知——
    /// 这些消息会被跳过，只等待与请求 id 匹配的响应。
    ///
    /// 超时语义（2026-09-09 事故后重设计）：
    /// 超时**不**销毁服务器。读线程继续等旧响应，完成后经 channel
    /// 把 reader 送回；`late_rx` 保存 Receiver，下次调用非阻塞收割。
    /// 冷窗口内收割不到 → 返回 "LSP busy"（进程保留，工具降级）；
    /// 窗口耗尽仍收不回 → 返回可销毁错误（重建走重生退避）。
    /// 旧实现超时即丢 reader 杀进程，冷启动的 rust-analyzer
    /// 永远活不过索引期（杀-重生循环）。
    fn send_request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        // ── 迟到响应回收 ──
        if let Some(rx) = self.late_rx.take() {
            match rx.try_recv() {
                Ok((reader_back, old_result)) => {
                    // 旧响应已到，reader 归位——服务器恢复健康。
                    self.reader = Some(reader_back);
                    tracing::debug!("[lsp_manager] late response reclaimed, reader restored");
                    // 但旧请求以读错误收场 = 流已断（多半进程死了）——
                    // 立即判死走重建，别把死进程挂满冷窗口。
                    // （"LSP error: ..." 是 JSON-RPC 应答，服务器健康，继续用。）
                    if let Err(e) = old_result {
                        if e.starts_with("LSP read error") {
                            return Err(format!("{e} — server will be recreated"));
                        }
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {
                    // 读线程仍在等旧响应（冷启动索引中）。
                    self.late_rx = Some(rx);
                    if self.spawned_at.elapsed() < self.cold_window {
                        return Err(format!(
                            "LSP busy: server still answering earlier request (cold start, {:.0}s elapsed) — retry later",
                            self.spawned_at.elapsed().as_secs()
                        ));
                    }
                    return Err(
                        "LSP reader lost after cold window — server will be recreated".to_string()
                    );
                }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    return Err(
                        "LSP reader thread exited without reader — server will be recreated"
                            .to_string(),
                    );
                }
            }
        }

        self.next_id += 1;
        let id = self.next_id;
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let body = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        self.write_message(&body)?;

        // 在独立线程中读取响应以实现超时控制
        // LSP 服务器会异步发送诊断/日志通知——跳过这些，等待匹配 id 的响应
        let mut reader = self.reader.take()
            .ok_or("LSP reader lost (previous call timed out) — server will be recreated")?;
        // 读线程需要写回复（服务器发来的请求），克隆 stdin 句柄
        let stdin_for_thread = self.stdin.clone();

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = loop {
                match Self::read_one_message(&mut reader) {
                    Ok((resp_id, response)) => {
                        if resp_id == Some(id) {
                            if let Some(err) = response.get("error") {
                                break Err(format!("LSP error: {}", err));
                            }
                            break Ok(response);
                        }
                        // 服务器发来的请求（有 id + method 字段，如
                        // workspace/configuration、client/registerCapability）——
                        // 必须回复 null 空结果，否则服务器阻塞等待，
                        // 我们后续的查询全部排队超时。
                        if let Some(req_id) = resp_id {
                            if response.get("method").and_then(|m| m.as_str()).is_some() {
                                let reply = json!({"jsonrpc": "2.0", "id": req_id, "result": null});
                                if let Ok(reply_body) = serde_json::to_string(&reply) {
                                    if let Err(e) = Self::write_message_static(&stdin_for_thread, &reply_body) {
                                        tracing::debug!(err = %e, "[lsp_manager] failed to reply to server request");
                                    }
                                }
                                continue;
                            }
                        }
                        // 通知或过期响应 → 跳过
                    }
                    Err(e) => break Err(format!("LSP read error: {}", e)),
                }
            };
            let _ = tx.send((reader, result));
        });

        match rx.recv_timeout(self.timeout) {
            Ok((reader_back, result)) => {
                self.reader = Some(reader_back);
                result
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // 不丢弃 rx：读线程继续等旧响应，完成后把 reader 送回。
                // 服务器保持存活（冷窗口内），下次调用收割。
                self.late_rx = Some(rx);
                Err(format!(
                    "LSP busy: timeout after {:?} waiting for {}(id {}) — server kept alive, retry later",
                    self.timeout, method, id,
                ))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("LSP reader thread panicked".to_string())
            }
        }
    }

    /// 发送通知消息（无 id，不期望响应）。
    fn send_notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        let notif = json!({"jsonrpc": "2.0", "method": method, "params": params});
        let body = serde_json::to_string(&notif).map_err(|e| e.to_string())?;
        self.write_message(&body)
    }

    /// 读取单条 JSON-RPC 消息并返回 (id, body)。
    ///
    /// 设为 static 方法以便在超时线程中调用而无需借用 self。
    /// 解析 LSP 帧协议：扫描 "Content-Length: N\r\n\r\n" 定界，
    /// 然后精确读取 N 字节 body。
    ///
    /// ponytail: 曾用 read_line 逐行读 header，但服务器可能一次
    /// write 粘连多条消息（帧+帧），且 JSON body 内可能含 \n，
    /// read_line 行边界会错位 → body 读进帧头（曾出现 body 开头是
    /// "Content-Length: 185\r\n\r\n{...}" 的 parse 错误）。
    /// 改按字节流扫描定界符，帧边界精确。
    fn read_one_message(reader: &mut BufReader<std::process::ChildStdout>) -> Result<(Option<u64>, Value), String> {
        use std::io::Read;
        // 扫描 header 直到 "\r\n\r\n"，收集 Content-Length。
        let mut header = Vec::with_capacity(256);
        let mut content_length: Option<usize> = None;
        loop {
            let mut byte = [0u8; 1];
            reader.read_exact(&mut byte).map_err(|e| format!("read header: {}", e))?;
            header.push(byte[0]);
            // 检测 "\r\n\r\n" 结尾（header 结束）
            let hlen = header.len();
            if hlen >= 4 && &header[hlen - 4..] == b"\r\n\r\n" {
                break;
            }
            // 防御：header 过长（>8KB）说明协议错乱，避免无限读
            if hlen > 8192 {
                return Err(format!("header too long ({} bytes)", hlen));
            }
        }
        // 从 header 中解析 Content-Length（大小写不敏感、容忍空格）
        let header_text = String::from_utf8_lossy(&header);
        for line in header_text.split("\r\n") {
            let lower = line.trim().to_lowercase();
            if let Some(val) = lower.strip_prefix("content-length:") {
                content_length = val.trim().parse().ok();
            }
        }
        let len = content_length.ok_or_else(|| format!("missing Content-Length in header: {:?}", header_text))?;
        let mut body_buf = vec![0u8; len];
        reader.read_exact(&mut body_buf).map_err(|e| format!("read body: {}", e))?;
        let msg: Value = serde_json::from_slice(&body_buf).map_err(|e| {
            // 把原始字节带进错误消息 — 定位"服务器发了非 JSON 内容"
            //（typescript-language-server 曾把日志/横幅混进 stdout）。
            let raw = String::from_utf8_lossy(&body_buf[..len.min(200)]);
            format!("parse: {} raw={:?}", e, raw)
        })?;
        let id = msg.get("id").and_then(|v| v.as_u64());
        Ok((id, msg))
    }

    /// LSP initialize 握手：发送 initialize 请求 + initialized 通知。
    ///
    /// 声明客户端能力（definition、references、hover），
    /// 等待服务器返回能力声明后发送 initialized 通知。
    fn initialize(&mut self, root: &str) -> Result<(), String> {
        let params = json!({
            "processId": std::process::id(),
            "rootUri": format!("file:///{}", root.replace('\\', "/")),
            "workspaceFolders": [{
                "uri": format!("file:///{}", root.replace('\\', "/")),
                "name": "project"
            }],
            "capabilities": {
                "textDocument": {
                    "definition": { "linkSupport": true },
                    "references": {},
                    "hover": {},
                },
            },
        });
        let resp = self.send_request("initialize", params)
            .map_err(|e| {
                // 尝试读取 stderr 以获取诊断信息
                let mut extra = String::new();
                if let Some(ref mut stderr) = self.stderr {
                    let mut buf = [0u8; 512];
                    use std::io::Read;
                    if let Ok(n) = stderr.read(&mut buf) {
                        if n > 0 {
                            extra = format!(" stderr: {}", String::from_utf8_lossy(&buf[..n]).trim());
                        }
                    }
                }
                format!("{}{}", e, extra)
            })?;
        let _capabilities = resp.get("result").ok_or("no capabilities")?;

        // initialized 是通知，不是请求
        self.send_notification("initialized", json!({}))?;

        // 排空初始化后的诊断/日志通知
        // 100ms 应该足够等待启动消息
        std::thread::sleep(std::time::Duration::from_millis(100));

        Ok(())
    }

    /// 通知服务器打开文件（textDocument/didOpen）。
    fn open_file(&mut self, uri: &str, text: &str, language: &str) -> Result<(), String> {
        // didOpen 是通知——无 id，不期望响应
        self.send_notification("textDocument/didOpen", json!({
            "textDocument": {
                "uri": uri,
                "languageId": language,
                "version": 1,
                "text": text,
            }
        }))
    }

    /// 查询指定位置的定义（textDocument/definition）。
    fn definition(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
        });
        let resp = self.send_request("textDocument/definition", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        parse_definition_results(&result)
    }

    /// 查询指定位置的实现（textDocument/implementation）。
    ///
    /// 用于查找接口/trait 的所有具体实现。
    fn implementation(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
        });
        let resp = self.send_request("textDocument/implementation", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        parse_definition_results(&result)
    }

    /// 查询指定位置的悬停信息（textDocument/hover）。
    ///
    /// 用于获取类型信息、文档等。
    fn hover(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<String, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
        });
        let resp = self.send_request("textDocument/hover", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        if result.is_null() {
            return Ok(String::new());
        }
        // hover 结果格式: { contents: MarkupContent | MarkedString | MarkedString[] }
        let contents = result.get("contents").cloned().unwrap_or(Value::Null);
        match contents {
            Value::String(s) => Ok(s),
            Value::Object(ref m) => m.get("value").and_then(|v| v.as_str()).map(|s| s.to_string()).ok_or("no hover value".into()),
            Value::Array(ref arr) => {
                // MarkedString[] —— 取第一个带语言标签的
                for item in arr {
                    if let Some(s) = item.as_str() { return Ok(s.to_string()); }
                    if let Some(v) = item.get("value").and_then(|v| v.as_str()) { return Ok(v.to_string()); }
                }
                Ok(String::new())
            }
            _ => Ok(String::new()),
        }
    }

    /// 查询指定位置符号的所有引用（textDocument/references）。
    ///
    /// 用于 UI 的影响范围分析。
    fn references(
        &mut self,
        uri: &str,
        line: u32,
        column: u32,
    ) -> Result<Vec<LspLocation>, String> {
        let params = json!({
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": column},
            "context": {"includeDeclaration": false},
        });
        let resp = self.send_request("textDocument/references", params)?;
        let result = resp.get("result").cloned().unwrap_or(Value::Null);
        parse_definition_results(&result)
    }
}

impl Drop for LspProcess {
    fn drop(&mut self) {
        // 尝试优雅关闭：发送 shutdown 请求后 kill 进程
        let _ = self.write_message(
            json!({"jsonrpc":"2.0","method":"shutdown","params":null}).to_string().as_ref(),
        );
        let _ = self.process.kill();
    }
}

// ═══════════════════════════════════════════════════════════════
// 位置解析
// ═══════════════════════════════════════════════════════════════

/// LSP 位置信息：URI + 范围（起止行列）。
#[derive(Debug, Clone)]
pub struct LspLocation {
    pub uri: String,
    pub range_start_line: u32,
    pub range_start_char: u32,
    pub range_end_line: u32,
    pub range_end_char: u32,
}

/// 将 file:/// URI 转换为绝对路径。
///
/// 在 Windows 上将正斜杠转回反斜杠。
pub fn uri_to_path(uri: &str) -> String {
    uri.strip_prefix("file:///")
        .unwrap_or(uri)
        .replace('/', if cfg!(windows) { "\\" } else { "/" })
}

/// 解析 definition/references 的返回结果。
///
/// LSP 返回格式可能是：
/// - null（无结果）
/// - 单个 Location `{uri, range}`
/// - Location 数组 `[{uri, range}, ...]`
/// - LocationLink 数组 `[{targetUri, targetRange, ...}, ...]`
/// - 单个 LocationLink
fn parse_definition_results(value: &Value) -> Result<Vec<LspLocation>, String> {
    if value.is_null() {
        return Ok(vec![]);
    }
    // LocationLink[] —— 含 targetUri + targetRange
    if let Some(arr) = value.as_array() {
        if let Some(first) = arr.first() {
            if first.get("targetUri").is_some() {
                return arr.iter().map(parse_location_link).collect();
            }
        }
        return arr.iter().map(parse_one_location).collect();
    }
    // 单个 Location
    if value.get("uri").is_some() {
        return Ok(vec![parse_one_location(value)?]);
    }
    // 单个 LocationLink
    if value.get("targetUri").is_some() {
        return Ok(vec![parse_location_link(value)?]);
    }
    Ok(vec![])
}

/// 解析 LocationLink（含 targetUri + targetSelectionRange/targetRange）。
fn parse_location_link(v: &Value) -> Result<LspLocation, String> {
    let uri = v.get("targetUri").and_then(|u| u.as_str()).ok_or("missing targetUri")?.to_string();
    let range = v.get("targetSelectionRange").or(v.get("targetRange")).ok_or("missing range")?;
    parse_range(uri, range)
}

/// 解析单个 Location（含 uri + range）。
fn parse_one_location(v: &Value) -> Result<LspLocation, String> {
    let uri = v.get("uri").and_then(|u| u.as_str()).ok_or("missing uri")?.to_string();
    let range = v.get("range").ok_or("missing range")?;
    parse_range(uri, range)
}

/// 从 range JSON 中提取起止行列，构造 LspLocation。
fn parse_range(uri: String, range: &Value) -> Result<LspLocation, String> {
    let start = range.get("start").ok_or("missing start")?;
    let end = range.get("end").unwrap_or(start);
    Ok(LspLocation {
        uri,
        range_start_line: start.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32,
        range_start_char: start.get("character").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
        range_end_line: end.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32,
        range_end_char: end.get("character").and_then(|c| c.as_u64()).unwrap_or(0) as u32,
    })
}

// ═══════════════════════════════════════════════════════════════
// 每种语言的 LSP 服务器配置
// ═══════════════════════════════════════════════════════════════

/// 单种语言的 LSP 服务器配置。
struct LspServerConfig {
    /// 启动命令（如 "rust-analyzer"）
    command: &'static str,
    /// 命令行参数
    args: &'static [&'static str],
    /// LSP 语言 ID（如 "rust"、"python"）
    language_id: &'static str,
    /// 此服务器处理的文件扩展名
    extensions: &'static [&'static str],
    /// 标记正确工作区根目录的配置文件。
    /// 如果在项目根目录下未找到，则搜索一级子目录，
    /// 使用第一个匹配项的父目录作为 rootUri。
    config_marker: &'static [&'static str],
}

/// 所有支持的 LSP 服务器配置表。
///
/// 覆盖 9 种语言：Rust、Go、Python、TypeScript/JavaScript、C/C++、Java、C#、PHP、Kotlin。
const SERVER_CONFIGS: &[LspServerConfig] = &[
    LspServerConfig {
        command: "rust-analyzer",
        args: &[],
        language_id: "rust",
        extensions: &["rs"],
        config_marker: &["Cargo.toml"],
    },
    LspServerConfig {
        command: "gopls",
        args: &[],
        language_id: "go",
        extensions: &["go"],
        config_marker: &["go.mod"],
    },
    LspServerConfig {
        command: "pyright-langserver",
        args: &["--stdio"],
        language_id: "python",
        extensions: &["py", "pyi"],
        config_marker: &["pyproject.toml", "setup.py", "setup.cfg"],
    },
    LspServerConfig {
        command: "typescript-language-server",
        args: &["--stdio"],
        language_id: "typescript",
        extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
        config_marker: &["tsconfig.json", "jsconfig.json"],
    },
    LspServerConfig {
        command: "clangd",
        args: &[],
        language_id: "cpp",
        extensions: &["c", "h", "cpp", "hpp", "cc", "hh", "cxx", "hxx"],
        config_marker: &["compile_commands.json", "CMakeLists.txt", "Makefile"],
    },
    LspServerConfig {
        command: "jdtls",
        args: &[],
        language_id: "java",
        extensions: &["java"],
        config_marker: &["pom.xml", "build.gradle", "build.gradle.kts"],
    },
    LspServerConfig {
        command: "omnisharp",
        args: &["--languageserver"],
        language_id: "csharp",
        extensions: &["cs"],
        config_marker: &["*.sln", "*.csproj"],
    },
    LspServerConfig {
        command: "intelephense",
        args: &["--stdio"],
        language_id: "php",
        extensions: &["php"],
        config_marker: &["composer.json"],
    },
    LspServerConfig {
        command: "kotlin-language-server",
        args: &[],
        language_id: "kotlin",
        extensions: &["kt", "kts"],
        config_marker: &["build.gradle.kts", "settings.gradle.kts"],
    },
];

// ═══════════════════════════════════════════════════════════════
// 服务器池
// ═══════════════════════════════════════════════════════════════

/// 服务器池类型：命令名 → LSP 进程的 Arc<Mutex<Option<>>>。
///
/// Option<None> 表示进程已失败/被销毁，需要重建。
type PoolMap = HashMap<&'static str, Arc<Mutex<Option<LspProcess>>>>;

/// LSP 管理器：全局单例，管理所有语言的 LSP 服务器进程。
///
/// 使用 RwLock 保护内部状态，支持并发读取。
/// 通过 `LspManager::global()` 获取全局实例。
pub struct LspManager {
    /// 服务器池：命令名 → 进程句柄
    pool: RwLock<PoolMap>,
    /// 项目根目录
    project_root: RwLock<Option<String>>,
    /// 是否已初始化（warm/mark_initialized 已调用）
    initialized: RwLock<bool>,
    /// 每个命令的最后一次预热错误，用于诊断
    last_warm_errors: RwLock<HashMap<String, String>>,
    /// 每个命令最近一次 spawn 尝试（含失败）的时刻，重生退避用。
    /// 多窗口并行时 N 个引擎各自重拉服务器的风暴从这里被限频。
    last_spawn: RwLock<HashMap<String, std::time::Instant>>,
    /// 宿主拉起失败负缓存（root → 上次尝试时刻）：
    /// 未装 hologram-lspd 的环境不逐 op 重试拉起。
    daemon_ensure: RwLock<HashMap<String, std::time::Instant>>,
}

/// 单个语言服务器的状态（#5 分流真源）——engine_status 与工具降级文案**同源**。
///
/// 立此枚举的由来（2026-09-25 实测）：旧的兜底把「装了但从没试过 / 正在拉起 /
/// 拉起失败」三种完全不同的状态糊成一句
/// `warm in progress or silent failure — retry if persists`——把排查者引向
/// 「它坏了」，而最常见的那种（懒加载的正常初态：这门语言还没人用过）根本不是故障。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LspServerState {
    /// 池中有活进程——查询能真正得到应答。
    Ready,
    /// 已尝试拉起、暂无进程、也无失败记录（spawn 在途 / 握手未完成）。
    Warming,
    /// 装了但本进程从未尝试拉起这门语言——**懒加载的正常初态，不是故障**。
    NeverWarmed,
    /// 拉起/握手/存活失败（含内存门禁、spawn 后快速崩溃），带原因。
    Failed(String),
    /// PATH 上找不到该服务器。
    NotInstalled,
}

impl LspServerState {
    /// 机器可读状态名（引擎状态面 / 工具 details 共用一套词）。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Warming => "warming",
            Self::NeverWarmed => "never-warmed",
            Self::Failed(_) => "failed",
            Self::NotInstalled => "not-installed",
        }
    }
}

/// 状态判据（纯函数——事实由 [`LspManager::server_state`] 收集）。
///
/// 顺序即优先级：池中活进程 > 池中死壳 > **没装** > 有失败记录 > 尝试过（在途）
/// > 装了但从未尝试。
///
/// 「没装」排在「失败」前：命令不在 PATH 上时唯一可行动作是安装，报 spawn 错误
/// 只会把人引偏。「从未尝试」不是故障——懒加载的正常初态（#5 的由来）。
fn classify_server_state(
    pool_alive: Option<bool>,
    on_path: bool,
    error: Option<String>,
    attempted: bool,
) -> LspServerState {
    match pool_alive {
        Some(true) => return LspServerState::Ready,
        // 死壳（with_process 判死把进程置 None，Arc 还留在池里）——下次查询重建
        Some(false) => {
            return LspServerState::Failed("server process exited — will be rebuilt on next query".into());
        }
        None => {}
    }
    if !on_path {
        return LspServerState::NotInstalled;
    }
    if let Some(e) = error {
        return LspServerState::Failed(e);
    }
    if attempted {
        LspServerState::Warming
    } else {
        LspServerState::NeverWarmed
    }
}

impl LspManager {
    /// 获取全局单例实例。
    pub fn global() -> &'static Self {
        use std::sync::LazyLock;
        static MANAGER: LazyLock<LspManager> = LazyLock::new(LspManager::new);
        &MANAGER
    }

    /// 检查 LSP 池是否已初始化（warm 已调用）。
    pub fn is_initialized() -> bool {
        *Self::global().initialized.read().unwrap_or_else(|e| e.into_inner())
    }

    /// 检查项目根目录是否与上次 warm 时不同（工作区切换）。
    pub fn root_changed(new_root: &str) -> bool {
        match Self::global().project_root.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
            Some(old) => old != new_root,
            None => true,
        }
    }

    /// 杀掉池中全部 LSP 服务器进程并清空状态。
    ///
    /// 必须显式调用：LspProcess 的 Drop 只在对象被销毁时 kill，
    /// 但池是进程级全局静态 —— 进程退出时静态对象不跑析构，
    /// 子进程会变成孤儿（曾观测 32 jdtls + 24 omnisharp 存活 16 小时）。
    /// 调用点：工作区切换（杀旧池）、引擎进程退出前。
    pub fn shutdown_all() {
        let mgr = Self::global();
        let drained: Vec<(&'static str, Arc<Mutex<Option<LspProcess>>>)> = {
            let mut pool = mgr.pool.write().unwrap_or_else(|e| e.into_inner());
            pool.drain().collect()
        };
        let mut killed = 0usize;
        for (cmd, arc) in &drained {
            let mut guard = match arc.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            if guard.take().is_some() {
                killed += 1;
            }
            tracing::info!(cmd, "[lsp_manager] shutdown_all killed server");
        }
        *mgr.initialized.write().unwrap_or_else(|e| e.into_inner()) = false;
        *mgr.project_root.write().unwrap_or_else(|e| e.into_inner()) = None;
        mgr.last_warm_errors.write().unwrap_or_else(|e| e.into_inner()).clear();
        // 换根/清池后退避一并清零：新根的首次 warm 不应被旧根的
        // 失败退避卡住。
        mgr.last_spawn.write().unwrap_or_else(|e| e.into_inner()).clear();
        mgr.daemon_ensure.write().unwrap_or_else(|e| e.into_inner()).clear();
        tracing::info!(killed, "[lsp_manager] shutdown_all done");
    }

    fn new() -> Self {
        Self {
            pool: RwLock::new(HashMap::new()),
            project_root: RwLock::new(None),
            initialized: RwLock::new(false),
            last_warm_errors: RwLock::new(HashMap::new()),
            last_spawn: RwLock::new(HashMap::new()),
            daemon_ensure: RwLock::new(HashMap::new()),
        }
    }

    /// 标记 LSP 池已初始化（记录项目根），但不 spawn 任何服务器。
    ///
    /// 「索引尚未建立」的窗口用它替代全量 warm：查询到来时走
    /// [`Self::get_or_warm_server`] 的惰性路径，只拉被查询的那一门
    /// 语言——避免分析窗口内 9 个服务器无条件全量 spawn
    /// （多窗口并行时 ×N，2026-09-09 内存事故来源之一）。
    pub fn mark_initialized(project_root: &str) {
        let mgr = Self::global();
        *mgr.project_root.write().unwrap_or_else(|e| e.into_inner()) = Some(project_root.to_string());
        *mgr.initialized.write().unwrap_or_else(|e| e.into_inner()) = true;
    }

    /// 记录一次 spawn 尝试（含失败）——重生退避的时钟。
    fn record_spawn_attempt(cmd: &str) {
        Self::global()
            .last_spawn
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(cmd.to_string(), std::time::Instant::now());
    }

    /// 同一命令距下次允许 spawn 还要等多久；None = 现在就可以。
    fn respawn_cooldown_remaining(cmd: &str) -> Option<std::time::Duration> {
        let mgr = Self::global();
        let map = mgr.last_spawn.read().unwrap_or_else(|e| e.into_inner());
        let last = map.get(cmd)?;
        let since = last.elapsed();
        if since < RESPAWN_COOLDOWN {
            Some(RESPAWN_COOLDOWN - since)
        } else {
            None
        }
    }

    /// 系统可用提交内存（MB）。
    ///
    /// Windows 用 GlobalMemoryStatusEx 的 ullAvailPageFile
    /// （commit limit − 已提交）——正是 errno=1455
    /// (ERROR_COMMITMENT_LIMIT) 触碰的那条线；Linux 读 /proc/meminfo。
    /// 无法探测时返回 None（不门禁）。
    pub fn available_commit_mb() -> Option<u64> {
        #[cfg(windows)]
        {
            #[repr(C)]
            #[derive(Default)]
            struct MemoryStatusEx {
                dw_length: u32,
                dw_memory_load: u32,
                ull_total_phys: u64,
                ull_avail_phys: u64,
                ull_total_page_file: u64,
                ull_avail_page_file: u64,
                ull_total_virtual: u64,
                ull_avail_virtual: u64,
                ull_avail_extended_virtual: u64,
            }
            extern "system" {
                fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
            }
            let mut status = MemoryStatusEx::default();
            status.dw_length = std::mem::size_of::<MemoryStatusEx>() as u32;
            // SAFETY: 按约定把结构体指针传给 kernel32，函数只写入。
            let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
            if ok != 0 {
                Some(status.ull_avail_page_file / (1024 * 1024))
            } else {
                None
            }
        }
        #[cfg(not(windows))]
        {
            let info = std::fs::read_to_string("/proc/meminfo").ok()?;
            for line in info.lines() {
                if let Some(rest) = line.strip_prefix("MemAvailable:") {
                    let kb: u64 = rest.trim().trim_end_matches(" kB").parse().ok()?;
                    return Some(kb / 1024);
                }
            }
            None
        }
    }

    /// 内存门禁的纯决策（可单测）：None = 探测不到，不门禁。
    fn spawn_gate_decision(avail_mb: Option<u64>) -> Result<(), String> {
        match avail_mb {
            Some(mb) if mb < MIN_SPAWN_COMMIT_MB => Err(format!(
                "lsp spawn skipped: low system memory (available commit {} MB < {} MB) — \
                 close other workspaces/windows or enlarge the pagefile",
                mb, MIN_SPAWN_COMMIT_MB,
            )),
            _ => Ok(()),
        }
    }

    /// spawn 前的内存门禁：可用提交内存不足时拒绝拉新服务器。
    fn gate_spawn_memory() -> Result<(), String> {
        Self::spawn_gate_decision(Self::available_commit_mb())
    }

    /// 哪些错误代表「服务器还活着，别杀」：
    /// - `LSP busy`：请求超时/服务器忙——读线程还在等响应，进程保留；
    /// - `LSP error`：服务器正常应答了 JSON-RPC error（协议层答复，
    ///   例如方法不支持），进程完全健康，杀掉纯属误伤。
    /// 其余（流损坏 parse/read header、进程死亡）才值得销毁重建。
    fn err_preserves_server(e: &str) -> bool {
        Self::err_is_busy(e) || e.starts_with("LSP error")
    }

    /// 错误是否为「忙/冷启动」类（值得稍后重试，而非安装/修复）。
    /// 工具层据此给 agent「稍后重试」而非误导性的「去装服务器」指引。
    pub(crate) fn err_is_busy(e: &str) -> bool {
        e.starts_with("LSP busy")
    }

    // ═══════════════════════════════════════════════════════════════
    // LSP 宿主客户端（hologram-lspd 共享舰队）
    //
    // 2026-09-09 宿主共享化（lsp-fleet-daemon-plan）：同一 root 全机
    // 只有一套舰队（宿主进程持有），本进程的四个 op 先走宿主、
    // 宿主不可用才回退本地池。op 级错误（busy/门禁）原样透传，
    // 只有传输层失败（连不上/断流）才回退——保证「一套舰队」性质。
    // ═══════════════════════════════════════════════════════════════

    /// 置位宿主进程身份（hologram-lspd 专用）。
    pub fn set_daemon_mode(on: bool) {
        DAEMON_MODE.store(on, std::sync::atomic::Ordering::SeqCst);
    }

    /// 本进程是否为 LSP 宿主。
    pub fn is_daemon_mode() -> bool {
        DAEMON_MODE.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 连接 root 的活宿主；不在线 → None。
    fn connect_daemon(root: &str) -> Option<TcpStream> {
        let port_file = crate::lsp_daemon::port_file(std::path::Path::new(root));
        let content = std::fs::read_to_string(port_file).ok()?;
        let port: u16 = content.trim().parse().ok()?;
        TcpStream::connect(("127.0.0.1", port)).ok()
    }

    /// 确保宿主在位（惰性拉起链）：connect → spawn → 轮询。
    /// 拉起失败负缓存 60s——未装 hologram-lspd 的环境不逐 op 重试。
    /// pub：engine_status/pipeline 的舰队治理门 + 集成测试都要用。
    pub fn ensure_daemon(root: &str) -> bool {
        if Self::connect_daemon(root).is_some() {
            return true;
        }
        let mgr = Self::global();
        {
            let cache = mgr.daemon_ensure.read().unwrap_or_else(|e| e.into_inner());
            if let Some(t) = cache.get(root) {
                if t.elapsed() < std::time::Duration::from_secs(60) {
                    return false;
                }
            }
        }
        mgr.daemon_ensure
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(root.to_string(), std::time::Instant::now());
        if Self::spawn_daemon(root).is_none() {
            return false;
        }
        // 短轮询等宿主绑定 + 端口文件落盘（3s 预算）
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if Self::connect_daemon(root).is_some() {
                return true;
            }
        }
        tracing::warn!("[lsp_manager] lspd spawn poll exhausted, falling back to local pool");
        false
    }

    /// 拉起宿主二进制；找不到 → None（老环境/未打包，本地池降级）。
    /// 定位顺序：HOLOGRAM_LSPD_EXE 环境变量（测试注入）→ current_exe 同目录。
    fn spawn_daemon(root: &str) -> Option<Child> {
        let exe: Option<PathBuf> = std::env::var("HOLOGRAM_LSPD_EXE")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std::env::current_exe()
                    .ok()?
                    .parent()
                    .map(|d| d.join(Self::lspd_exe_name()))
            });
        let exe = exe?;
        if !exe.exists() {
            tracing::debug!(exe = %exe.display(), "[lsp_manager] hologram-lspd not found, local pool fallback");
            return None;
        }
        let mut c = Command::new(&exe);
        c.args(["--root", root])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：宿主无控制台弹窗（与舰队 spawn 同理）
            c.creation_flags(0x08000000);
        }
        c.spawn().ok()
    }

    fn lspd_exe_name() -> &'static str {
        if cfg!(windows) { "hologram-lspd.exe" } else { "hologram-lspd" }
    }

    /// 一次 op 往返：一行请求 → 一行响应。
    /// 传输层失败返回 Err（`[lspd-transport]` 前缀，调用方据此回退本地池）；
    /// 宿主应答（含 op 级错误）返回 Ok(resp)。
    fn daemon_call(root: &str, req: Value) -> Result<Value, String> {
        let mut stream = Self::connect_daemon(root)
            .ok_or_else(|| "[lspd-transport] connect failed".to_string())?;
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(15)))
            .map_err(|e| format!("[lspd-transport] set timeout: {e}"))?;
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(15)))
            .map_err(|e| format!("[lspd-transport] set timeout: {e}"))?;
        let mut line = req.to_string();
        line.push('\n');
        stream
            .write_all(line.as_bytes())
            .map_err(|e| format!("[lspd-transport] write: {e}"))?;
        let mut reader = BufReader::new(stream);
        let mut resp = String::new();
        reader
            .read_line(&mut resp)
            .map_err(|e| format!("[lspd-transport] read: {e}"))?;
        if resp.trim().is_empty() {
            return Err("[lspd-transport] empty response".to_string());
        }
        serde_json::from_str(resp.trim())
            .map_err(|e| format!("[lspd-transport] parse: {e}"))
    }

    /// 四 op 的宿主优先包装：
    /// - None → 宿主不可用（离线/本进程是宿主/无根），调用方走本地池
    /// - Some(Ok/Err) → 宿主已应答，结果（含 op 级错误）原样返回
    fn try_daemon_locations(
        op: &str,
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Option<Result<Vec<LspLocation>, String>> {
        if Self::is_daemon_mode() {
            return None;
        }
        let root = Self::global()
            .project_root
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        if !Self::ensure_daemon(&root) {
            return None;
        }
        // 相对路径客户端先转绝对（与本地 prepare() 同规则）
        let abs_path = if PathBuf::from(file_path).is_absolute() {
            file_path.to_string()
        } else {
            format!("{}/{}", root, file_path)
        };
        let req = json!({
            "op": op,
            "file": abs_path,
            "source": source,
            "line": line,
            "column": column,
            "ext": ext,
        });
        match Self::daemon_call(&root, req) {
            Ok(resp) => {
                if resp["ok"].as_bool().unwrap_or(false) {
                    let locs: Vec<LspLocation> = resp["locations"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(crate::lsp_daemon::location_from_json)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(Ok(locs))
                } else {
                    Some(Err(
                        resp["error"].as_str().unwrap_or("lspd op failed").to_string()
                    ))
                }
            }
            Err(_) => None, // 传输层失败 → 本地池
        }
    }

    /// hover（resolve_type）的宿主优先包装，语义同 [`Self::try_daemon_locations`]。
    fn try_daemon_hover(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Option<Result<String, String>> {
        if Self::is_daemon_mode() {
            return None;
        }
        let root = Self::global()
            .project_root
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()?;
        if !Self::ensure_daemon(&root) {
            return None;
        }
        let abs_path = if PathBuf::from(file_path).is_absolute() {
            file_path.to_string()
        } else {
            format!("{}/{}", root, file_path)
        };
        let req = json!({
            "op": "hover",
            "file": abs_path,
            "source": source,
            "line": line,
            "column": column,
            "ext": ext,
        });
        match Self::daemon_call(&root, req) {
            Ok(resp) => {
                if resp["ok"].as_bool().unwrap_or(false) {
                    Some(Ok(resp["hover"].as_str().unwrap_or("").to_string()))
                } else {
                    Some(Err(
                        resp["error"].as_str().unwrap_or("lspd op failed").to_string()
                    ))
                }
            }
            Err(_) => None,
        }
    }

    /// 宿主的 LSP 状态（engine_status 合并用）；离线 → None。
    pub fn daemon_lsp_status(root: &str) -> Option<Vec<Value>> {
        let resp = Self::daemon_call(root, json!({"op": "status"})).ok()?;
        if !resp["ok"].as_bool().unwrap_or(false) {
            return None;
        }
        resp["status"].as_array().cloned()
    }

    /// 本地池是否还有活服务器（宿主接管时的收敛检查用）。
    pub fn local_pool_nonempty() -> bool {
        let mgr = Self::global();
        let pool = mgr.pool.read().unwrap_or_else(|e| e.into_inner());
        pool.values().any(|arc| {
            arc.lock().map(|g| g.is_some()).unwrap_or(false)
        })
    }

    /// 预热服务器池——并行启动所有已配置的 LSP 服务器。
    ///
    /// 不做扩展名扫描和过滤：如果服务器在 PATH 上存在就尝试启动。
    /// 启动慢的不阻塞启动快的。失败记录到 `last_warm_errors` 中供诊断。
    /// 应在索引完成后调用。
    pub fn warm(project_root: &str) {
        Self::warm_filtered(project_root, &[]);
    }

    /// 异步预热，仅启动与 `ext_filter` 中扩展名有交集的服务器。
    /// `ext_filter` 为空时行为与 [`warm`] 完全一致。
    ///
    /// 索引完成后应优先使用本方法：避免对不存在的语言
    /// 无条件 spawn 全部 LSP 进程（孤儿进程来源）。
    pub fn warm_filtered(project_root: &str, ext_filter: &[&str]) {
        let mgr = Self::global();
        *mgr.project_root.write().unwrap_or_else(|e| e.into_inner()) = Some(project_root.to_string());
        *mgr.initialized.write().unwrap_or_else(|e| e.into_inner()) = true;

        let root = project_root.to_string();
        for cfg in SERVER_CONFIGS {
            if !ext_filter.is_empty() {
                let has_match = ext_filter
                    .iter()
                    .any(|e| cfg.extensions.contains(e));
                if !has_match {
                    continue;
                }
            }
            let cmd = cfg.command;
            // 跳过池中已在运行的服务器 —— 避免在重复 warm 调用
            //（如 engine_status 轮询）时杀死健康的进程。
            {
                let pool = mgr.pool.read().unwrap_or_else(|e| e.into_inner());
                if let Some(arc) = pool.get(cmd) {
                    if let Ok(guard) = arc.lock() {
                        if guard.is_some() {
                            tracing::debug!(cmd, "[lsp_manager] already running, skip warm");
                            continue;
                        }
                    }
                }
            }
            let ws_root = Self::resolve_workspace_root(&root, cfg.config_marker);
            let cfg: &'static LspServerConfig = cfg; // const slice → 'static
            std::thread::spawn(move || {
                match Self::spawn_server(cfg, &ws_root) {
                    Ok(process) => {
                        tracing::info!(cmd, "[lsp_manager] server started");
                        mgr.pool
                            .write()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(cmd, Arc::new(Mutex::new(Some(process))));
                        mgr.last_warm_errors.write().unwrap_or_else(|e| e.into_inner()).remove(cmd);
                    }
                    Err(e) => {
                        let diagnosed = Self::diagnose_error(cmd, &e);
                        let err_msg = format!("spawn+init {}: {}", cmd, diagnosed);
                        tracing::error!(cmd, err = %diagnosed, "[lsp_manager] server unavailable");
                        mgr.last_warm_errors
                            .write()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(cmd.to_string(), err_msg);
                    }
                }
            });
        }
    }

    /// 同步预热服务器池——阻塞直到所有服务器启动或失败。
    ///
    /// 返回 (已启动数, 失败数)。供压力测试使用。
    pub fn warm_blocking(project_root: &str) -> (usize, usize) {
        Self::warm_blocking_filtered(project_root, &[])
    }

    /// 同步预热服务器池，仅启动扩展名与 `ext_filter` 有交集的服务器。
    ///
    /// 如果 `ext_filter` 为空则启动全部。供压力测试按语言过滤使用。
    pub fn warm_blocking_filtered(project_root: &str, ext_filter: &[&str]) -> (usize, usize) {
        let mgr = Self::global();
        *mgr.project_root.write().unwrap_or_else(|e| e.into_inner()) = Some(project_root.to_string());
        *mgr.initialized.write().unwrap_or_else(|e| e.into_inner()) = true;

        let root = project_root.to_string();
        let mut handles = Vec::new();
        let mut already_running = 0usize;

        for cfg in SERVER_CONFIGS {
            // 应用扩展名过滤
            if !ext_filter.is_empty() {
                let has_match = ext_filter.iter()
                    .any(|e| cfg.extensions.contains(e));
                if !has_match { continue; }
            }

            // 跳过池中已在运行的服务器 —— 与 warm() 行为一致,
            // 避免压测/重复调用时杀死健康进程并重复全量索引
            {
                let pool = mgr.pool.read().unwrap_or_else(|e| e.into_inner());
                if let Some(arc) = pool.get(cfg.command) {
                    if let Ok(guard) = arc.lock() {
                        if guard.is_some() {
                            already_running += 1;
                            continue;
                        }
                    }
                }
            }

            let root = Self::resolve_workspace_root(&root, cfg.config_marker);
            let cmd = cfg.command;
            let cfg: &'static LspServerConfig = cfg;
            let handle = std::thread::spawn(move || {
                match Self::spawn_server(cfg, &root) {
                    Ok(process) => {
                        tracing::info!(cmd, "[lsp_manager] server started (blocking)");
                        mgr.pool
                            .write()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(cmd, Arc::new(Mutex::new(Some(process))));
                        mgr.last_warm_errors.write().unwrap_or_else(|e| e.into_inner()).remove(cmd);
                        Ok(cmd)
                    }
                    Err(e) => {
                        let diagnosed = Self::diagnose_error(cmd, &e);
                        let err_msg = format!("spawn+init {}: {}", cmd, diagnosed);
                        tracing::error!(cmd, err = %diagnosed, "[lsp_manager] server unavailable (blocking)");
                        mgr.last_warm_errors
                            .write()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(cmd.to_string(), err_msg);
                        Err(cmd)
                    }
                }
            });
            handles.push(handle);
        }

        let mut started = 0;
        let mut failed = 0;
        for h in handles {
            match h.join() {
                Ok(Ok(_)) => started += 1,
                Ok(Err(_)) => failed += 1,
                Err(_) => {
                    eprintln!("[lsp] warm-up thread panicked");
                    failed += 1;
                }
            }
        }

        // 已在运行的服务器计入成功数(它们确实可用)
        (started + already_running, failed)
    }

    /// 为 LSP 服务器查找正确的工作区根目录。
    ///
    /// 在项目根目录下搜索 config_marker 文件，如果未找到则搜索一级子目录。
    /// 返回包含第一个匹配项的目录，如果都未找到则返回项目根目录。
    fn resolve_workspace_root(project_root: &str, markers: &[&str]) -> String {
        if markers.is_empty() {
            return project_root.to_string();
        }
        // 先检查项目根目录
        if Self::dir_has_marker(project_root, markers) {
            return project_root.to_string();
        }
        // 搜索一级子目录
        if let Ok(entries) = std::fs::read_dir(project_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(dir_str) = path.to_str() {
                        if Self::dir_has_marker(dir_str, markers) {
                            return dir_str.to_string();
                        }
                    }
                }
            }
        }
        // 回退到项目根目录
        project_root.to_string()
    }

    /// 检查目录中是否包含任意一个给定的标记文件。
    ///
    /// 支持字面文件名和扩展名通配（如 "*.sln"）。
    fn dir_has_marker(dir: &str, markers: &[&str]) -> bool {
        for marker in markers {
            if marker.starts_with("*.") {
                // 扩展名通配：检查是否存在任何带此扩展名的文件
                let ext = &marker[1..]; // ".sln", ".csproj"
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.is_file() {
                            if let Some(file_ext) = p.extension().and_then(|e| e.to_str()) {
                                let dot_ext = format!(".{}", file_ext);
                                if dot_ext.eq_ignore_ascii_case(ext) {
                                    return true;
                                }
                            }
                        }
                    }
                }
            } else {
                // 字面文件名
                let full = std::path::Path::new(dir).join(marker);
                if full.exists() {
                    return true;
                }
            }
        }
        false
    }

    /// 诊断常见的 LSP 启动失败并返回可操作的指导信息。
    fn diagnose_error(cmd: &str, raw: &str) -> String {
        let lower = raw.to_lowercase();
        // npm 全局包损坏——node_modules 缺失
        if lower.contains("cannot find module") && lower.contains("node_modules") {
            return format!(
                "{} — npm package appears corrupted. Reinstall: npm uninstall -g {} && npm install -g {}",
                raw,
                cmd.replace("-langserver", "").replace("-language-server", ""),
                cmd.replace("-langserver", "").replace("-language-server", ""),
            );
        }
        // rustup 代理缺少实际组件
        if cmd == "rust-analyzer" && lower.contains("unknown binary") && lower.contains("toolchain") {
            return format!(
                "{} — rust-analyzer not installed for your Rust toolchain. Run: rustup component add rust-analyzer",
                raw,
            );
        }
        // gopls 未安装
        if cmd == "gopls" && (lower.contains("not found") || lower.contains("no such file")) {
            return format!(
                "{} — gopls not found. Install: go install golang.org/x/tools/gopls@latest",
                raw,
            );
        }
        // 通用的 "not found"
        if lower.contains("program not found") || lower.contains("no such file") {
            return format!(
                "{} — {} is not installed or not on PATH. See 安装指南 for install instructions.",
                raw, cmd,
            );
        }
        // 原样返回
        raw.to_string()
    }

    /// 按扩展名尝试预热单个 LSP 服务器。
    ///
    /// 当 resolve_definition 发现池中无服务器时作为惰性重试使用。
    fn try_warm_one(ext: &str) -> bool {
        let cfg = match SERVER_CONFIGS.iter().find(|c| c.extensions.contains(&ext)) {
            Some(c) => c,
            None => return false,
        };
        let mgr = Self::global();
        let root = match mgr.project_root.read().unwrap_or_else(|e| e.into_inner()).as_ref() {
            Some(r) => r.clone(),
            None => return false,
        };
        let cmd = cfg.command;
        // 重生退避（防御纵深：get_or_warm_server 已查过一次）。
        if let Some(remain) = Self::respawn_cooldown_remaining(cmd) {
            tracing::debug!(cmd, remain_secs = remain.as_secs(), "[lsp_manager] lazy warm blocked by respawn cooldown");
            return false;
        }
        match Self::spawn_server(cfg, &root) {
            Ok(process) => {
                tracing::info!(cmd, ext, "[lsp_manager] lazy warm succeeded");
                mgr.pool
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(cmd, Arc::new(Mutex::new(Some(process))));
                mgr.last_warm_errors.write().unwrap_or_else(|e| e.into_inner()).remove(cmd);
                true
            }
            Err(e) => {
                let err_msg = format!("lazy-spawn+init {}: {}", cmd, e);
                tracing::error!(cmd, ext, err = %e, "[lsp_manager] lazy warm failed — retry exhausted");
                mgr.last_warm_errors
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(cmd.to_string(), err_msg);
                false
            }
        }
    }

    /// 启动单个 LSP 服务器进程并完成 initialize 握手。
    ///
    /// Windows 上 npm 全局工具是 .cmd 包装器，需要通过 cmd.exe /c 运行。
    fn spawn_server(cfg: &LspServerConfig, root: &str) -> Result<LspProcess, String> {
        // 重生退避：spawn 尝试（含此处的门禁失败）先记时钟——
        // 冷却期内惰性重拉在 try_warm_one/get_or_warm_server 就被拦下。
        Self::record_spawn_attempt(cfg.command);
        // 内存门禁：可用提交内存不足时拒绝拉新服务器。
        // 失败原因会进 last_warm_errors，engine_status 可见、工具降级。
        Self::gate_spawn_memory()?;

        // 解析完整路径——Windows 上 npm 全局工具是 .cmd 包装器
        // .cmd/.bat 文件必须通过 cmd.exe /c 运行（它们是脚本，不是 PE 可执行文件）
        let exe = Self::resolve_cmd_path(cfg.command)
            .unwrap_or_else(|| std::path::PathBuf::from(cfg.command));
        let (program, args_vec) = {
            #[cfg(target_os = "windows")]
            {
                let ext = exe.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                if ext == "cmd" || ext == "bat" {
                    let mut v = vec!["/c".to_string(), exe.to_string_lossy().into_owned()];
                    v.extend(cfg.args.iter().map(|a| a.to_string()));
                    (std::path::PathBuf::from("cmd.exe"), v)
                } else {
                    let v: Vec<String> = cfg.args.iter().map(|a| a.to_string()).collect();
                    (exe, v)
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let v: Vec<String> = cfg.args.iter().map(|a| a.to_string()).collect();
                (exe, v)
            }
        };

        let mut c = Command::new(&program);
        c.args(&args_vec)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()); // 捕获 stderr 用于诊断
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW —— 给 LSP 进程分配一个【隐藏】控制台。
            // 不能用 DETACHED_PROCESS（0x08000008）：npm 全局工具是 .cmd 批处理
            // shim，cmd.exe 无控制台时再拉起 node 等孙进程会分配一个【可见】的新
            // 控制台窗口（启动时三个语言服务器窗口就是这里漏的，2026-08-13 回归）。
            // CREATE_NO_WINDOW 的隐藏控制台会被孙进程继承，整棵进程树都不可见。
            c.creation_flags(0x08000000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // die-with-parent：引擎进程死亡（含 SIGKILL）时子进程立即自杀。
            // 没有它，引擎异常退出后 LSP 服务器变孤儿 —— 实测 32 jdtls +
            // 24 omnisharp 存活 16 小时。
            //
            // ⚠ 平台边界（2026-09-24 macOS 腿首次编译时暴露，exit 101）：
            // `prctl` / `PR_SET_PDEATHSIG` 是 **Linux 专有**——libc crate 只在
            // linux/android 目标上导出它们，用 `#[cfg(unix)]` 圈住就等于让
            // 整个 macOS 腿编译不过（`cannot find value PR_SET_PDEATHSIG in
            // crate libc` / `cannot find function prctl`）。macOS 没有等价物
            // （kqueue 的 EVFILT_PROC 得由外部看门狗进程持有，不在 spawn 点
            // 的能力面内），故 macOS 上只保留 ppid 复查这一半。
            unsafe {
                c.pre_exec(|| {
                    #[cfg(target_os = "linux")]
                    {
                        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                    }
                    // 复查 ppid：若父进程在 exec 前已死（子进程已被 init 收养），
                    // 补一发自尽。Linux 上这是 prctl 的补漏；macOS 上这是唯一
                    // 一条自尽路径 —— 引擎被 SIGKILL 时 macOS 可能残留 LSP 子进程，
                    // 正常退出/SIGTERM 仍由 shutdown_all() + Drop 兜底（Linux 无此缺口）。
                    if libc::getppid() == 1 {
                        libc::kill(libc::getpid(), libc::SIGKILL);
                    }
                    Ok(())
                });
            }
        }
        let mut child = c.spawn()
            .map_err(|e| format!("spawn {}: {}", cfg.command, e))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take();

        let mut process = LspProcess {
            process: child,
            stdin: Arc::new(Mutex::new(stdin)),
            reader: Some(BufReader::new(stdout)),
            stderr,
            next_id: 0,
            timeout: LSP_TIMEOUT,
            spawned_at: std::time::Instant::now(),
            cold_window: LSP_COLD_WINDOW,
            late_rx: None,
        };

        // 快速死亡检测：如果进程在几百毫秒内就退出了（典型：版本不兼容），
        // 立即报错而不是等 initialize 超时 30 秒。
        std::thread::sleep(std::time::Duration::from_millis(300));
        if let Ok(Some(status)) = process.process.try_wait() {
            let mut stderr_output = String::new();
            if let Some(ref mut stderr) = process.stderr {
                use std::io::Read;
                let _ = stderr.read_to_string(&mut stderr_output);
            }
            let hint = if stderr_output.is_empty() {
                format!(
                    "exited with code {} immediately after spawn (no stderr) — \
                     likely a version incompatibility between {} and its language runtime",
                    status, cfg.command,
                )
            } else {
                format!(
                    "exited with code {} immediately after spawn: {}",
                    status, stderr_output.trim(),
                )
            };
            // 进程已死，清理
            let _ = process.process.kill();
            return Err(hint);
        }

        process.initialize(root)?;

        Ok(process)
    }

    /// 按文件扩展名查找对应的 LSP 服务器。
    fn get_server(ext: &str) -> Option<Arc<Mutex<Option<LspProcess>>>> {
        let mgr = Self::global();
        let pool = mgr.pool.read().unwrap_or_else(|e| e.into_inner());
        for cfg in SERVER_CONFIGS {
            if cfg.extensions.contains(&ext) {
                return pool.get(cfg.command).cloned();
            }
        }
        None
    }

    /// 获取服务器，如果池中不存在则尝试惰性预热。
    ///
    /// 返回 Ok(server_arc) 或 Err(原因)。
    fn get_or_warm_server(ext: &str) -> Result<Arc<Mutex<Option<LspProcess>>>, String> {
        // 池中已有条目：仅当进程存活（Some）才复用。
        // with_process 失败会把进程置 None 但 Arc 留在池中 ——
        // 若不检查存活，get_server 恒返回 Some，导致永久
        // "server not running" 死壳、LSP 永远无法自愈。
        if let Some(arc) = Self::get_server(ext) {
            let alive = arc.lock().map(|g| g.is_some()).unwrap_or(false);
            if alive {
                return Ok(arc);
            }
            // 死壳：从池中移除，走下方重建路径
            let mgr = Self::global();
            let cmd = SERVER_CONFIGS
                .iter()
                .find(|c| c.extensions.contains(&ext))
                .map(|c| c.command);
            if let Some(cmd) = cmd {
                tracing::warn!(ext, "[lsp_manager] stale dead server removed, rebuilding");
                mgr.pool.write().unwrap_or_else(|e| e.into_inner()).remove(cmd);
                // 重生退避：冷却未过不再拉——防止「查询→失败→重拉→
                // 再失败」风暴（多窗口 ×N 放大，2026-09-09 事故）。
                if let Some(remain) = Self::respawn_cooldown_remaining(cmd) {
                    tracing::debug!(cmd, remain_secs = remain.as_secs(), "[lsp_manager] respawn cooldown active");
                    return Err(format!(
                        "LSP busy: {} respawn cooldown (~{:.0}s left) — retry later",
                        cmd, remain.as_secs_f32()
                    ));
                }
            }
        }
        tracing::info!(ext, "[lsp_manager] server not in pool, attempting lazy warm");
        // 重生退避：池中无条目（从未 spawn / 已被移除）时同样受冷却约束，
        // 且把原因透传成 busy 类错误——工具层才能给出「稍后重试」指引。
        if let Some(cfg) = SERVER_CONFIGS.iter().find(|c| c.extensions.contains(&ext)) {
            if let Some(remain) = Self::respawn_cooldown_remaining(cfg.command) {
                tracing::debug!(cmd = cfg.command, remain_secs = remain.as_secs(), "[lsp_manager] respawn cooldown active");
                return Err(format!(
                    "LSP busy: {} respawn cooldown (~{:.0}s left) — retry later",
                    cfg.command, remain.as_secs_f32()
                ));
            }
        }
        if !Self::try_warm_one(ext) {
            return Err(format!("no server for .{} (lazy warm failed)", ext));
        }
        Self::get_server(ext).ok_or_else(|| format!("no server for .{} after warm", ext))
    }

    /// 在 LSP 进程上执行操作。
    ///
    /// 锁定服务器，执行闭包 f；f 失败时按错误性质决定：
    /// - 瞬态错误（"LSP busy"/"LSP error"）→ 进程保留（服务器健康）；
    /// - 其余错误 → 清空池条目，下次调用重新预热新进程。
    fn with_process<T>(
        server_arc: &Arc<Mutex<Option<LspProcess>>>,
        f: impl FnOnce(&mut LspProcess) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = server_arc.lock().map_err(|e| format!("lock: {}", e))?;
        let process = guard.as_mut().ok_or("server not running")?;
        match f(process) {
            Ok(v) => Ok(v),
            Err(e) => {
                if Self::err_preserves_server(&e) {
                    return Err(e);
                }
                *guard = None; // 销毁损坏的进程，下次调用强制重建
                Err(e)
            }
        }
    }

    /// 解析指定位置的函数定义。
    ///
    /// 参数：
    /// - `file_path`: 文件路径（相对或绝对）
    /// - `source`: 文件源码文本
    /// - `line`/`column`: 0-based 行列号
    /// - `ext`: 文件扩展名（用于选择 LSP 服务器）
    ///
    /// 返回定义位置列表，或 Err（无可用服务器）。
    pub fn resolve_definition(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<Vec<LspLocation>, String> {
        // 宿主优先：共享舰队在线时走宿主；传输层失败才回退本地池
        if let Some(result) = Self::try_daemon_locations("definition", file_path, source, line, column, ext) {
            return result;
        }
        let mgr = Self::global();
        if !*mgr.initialized.read().unwrap_or_else(|e| e.into_inner()) {
            return Err("LSP pool not initialized".into());
        }
        let server_arc = Self::get_or_warm_server(ext)?;
        let abs_path = if PathBuf::from(file_path).is_absolute() {
            file_path.to_string()
        } else {
            let root = mgr.project_root.read().unwrap_or_else(|e| e.into_inner());
            let root = root.as_ref().ok_or("no project root")?;
            format!("{}/{}", root, file_path)
        };
        let uri = format!("file:///{}", abs_path.replace('\\', "/"));
        let lang_id = SERVER_CONFIGS.iter().find(|c| c.extensions.contains(&ext)).map(|c| c.language_id).unwrap_or(ext);
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, lang_id);
            let locs = process.definition(&uri, line, column)?;
            // #7：冷窗口内的空结果不算数（服务器还在索引项目）——如实回 busy，
            // 工具层的指引才会是「稍后重试」而不是「去装 LSP 服务器」。
            if locs.is_empty() {
                if let Some(note) = process.cold_start_note() {
                    return Err(note);
                }
            }
            Ok(locs)
        })
    }

    /// 通过 hover 解析指定位置的类型信息。
    pub fn resolve_type(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<String, String> {
        // 宿主优先
        if let Some(result) = Self::try_daemon_hover(file_path, source, line, column, ext) {
            return result;
        }
        let (uri, lang_id) = Self::prepare(file_path, ext)?;
        let server_arc = Self::get_or_warm_server(ext)?;
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, &lang_id);
            let hover = process.hover(&uri, line, column)?;
            // #7：冷窗口内的空 hover 同样不算数（服务器还在索引）。
            if hover.is_empty() {
                if let Some(note) = process.cold_start_note() {
                    return Err(note);
                }
            }
            Ok(hover)
        })
    }

    /// 查找指定位置接口/trait 的所有实现。
    pub fn find_implementations(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<Vec<LspLocation>, String> {
        // 宿主优先
        if let Some(result) = Self::try_daemon_locations("implementation", file_path, source, line, column, ext) {
            return result;
        }
        let (uri, lang_id) = Self::prepare(file_path, ext)?;
        let server_arc = Self::get_or_warm_server(ext)?;
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, &lang_id);
            let locs = process.implementation(&uri, line, column)?;
            // #7：冷窗口内的空结果不算数（服务器还在索引）。
            if locs.is_empty() {
                if let Some(note) = process.cold_start_note() {
                    return Err(note);
                }
            }
            Ok(locs)
        })
    }

    /// 查找指定位置符号的所有引用。
    pub fn find_references(
        file_path: &str,
        source: &str,
        line: u32,
        column: u32,
        ext: &str,
    ) -> Result<Vec<LspLocation>, String> {
        // 宿主优先
        if let Some(result) = Self::try_daemon_locations("references", file_path, source, line, column, ext) {
            return result;
        }
        let (uri, lang_id) = Self::prepare(file_path, ext)?;
        let server_arc = Self::get_or_warm_server(ext)?;
        let source = source.to_string();
        Self::with_process(&server_arc, |process| {
            let _ = process.open_file(&uri, &source, &lang_id);
            let locs = process.references(&uri, line, column)?;
            // #7：冷窗口内的空结果不算数（服务器还在索引）——免得「正在索引」
            // 被读成「这个符号没有引用」。
            if locs.is_empty() {
                if let Some(note) = process.cold_start_note() {
                    return Err(note);
                }
            }
            Ok(locs)
        })
    }

    /// 辅助函数：从文件路径和扩展名解析 URI 和语言 ID。
    fn prepare(file_path: &str, ext: &str) -> Result<(String, String), String> {
        let abs_path = if PathBuf::from(file_path).is_absolute() {
            file_path.to_string()
        } else {
            let mgr = Self::global();
            let root = mgr.project_root.read().unwrap_or_else(|e| e.into_inner());
            let root = root.as_ref().ok_or("no project root")?;
            format!("{}/{}", root, file_path)
        };
        let uri = format!("file:///{}", abs_path.replace('\\', "/"));
        let lang_id = SERVER_CONFIGS
            .iter()
            .find(|c| c.extensions.contains(&ext))
            .map(|c| c.language_id)
            .unwrap_or(ext)
            .to_string();
        Ok((uri, lang_id))
    }

    /// 检查指定文件扩展名是否有可用的 LSP 服务器。
    ///
    /// 仅当池中有服务器进程实际运行时返回 true。
    pub fn is_available(ext: &str) -> bool {
        Self::get_server(ext)
            .and_then(|arc| {
                arc.lock().ok().map(|guard| guard.is_some())
            })
            .unwrap_or(false)
    }

    /// 返回最近一次预热错误，用于诊断显示。
    ///
    /// 返回命令名 → 错误消息的映射。
    pub fn warm_errors() -> HashMap<String, String> {
        Self::global().last_warm_errors.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 单命令状态（#5 五态；判据顺序即优先级）。
    ///
    /// 事实收集在这里，判据在 [`classify_server_state`]（纯函数——可穷举测试）。
    pub fn server_state(cmd: &str) -> LspServerState {
        let mgr = Self::global();
        let pool_alive = mgr
            .pool
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(cmd)
            .map(|arc| arc.lock().map(|g| g.is_some()).unwrap_or(false));
        let error = mgr.last_warm_errors.read().unwrap_or_else(|e| e.into_inner()).get(cmd).cloned();
        let attempted = mgr.last_spawn.read().unwrap_or_else(|e| e.into_inner()).contains_key(cmd);
        classify_server_state(pool_alive, Self::find_on_path(cmd), error, attempted)
    }

    /// 按扩展名取状态；None = 这门语言**没有适配器**（连配置表都没有）。
    pub fn server_state_for_ext(ext: &str) -> Option<LspServerState> {
        let cfg = SERVER_CONFIGS.iter().find(|c| c.extensions.contains(&ext))?;
        Some(Self::server_state(cfg.command))
    }

    /// 在文件系统上解析命令的完整路径。
    ///
    /// Windows 上优先检查 .exe/.cmd/.bat——npm 全局工具
    /// 有无扩展名的 Unix 脚本和 .cmd 包装器并存；
    /// 无扩展名的文件是 shell 脚本，不能直接 spawn。
    fn resolve_cmd_path(cmd: &str) -> Option<std::path::PathBuf> {
        if let Ok(paths) = std::env::var("PATH") {
            for dir in std::env::split_paths(&paths) {
                #[cfg(target_os = "windows")]
                {
                    for ext in ["exe", "cmd", "bat"] {
                        let with_ext = dir.join(cmd).with_extension(ext);
                        if with_ext.exists() {
                            return Some(with_ext);
                        }
                    }
                }
                // 回退：无扩展名（Unix）或非 Windows
                let full = dir.join(cmd);
                if full.exists() {
                    return Some(full);
                }
            }
        }
        None
    }

    /// 检查命令是否在 PATH 上存在（不启动进程）。
    ///
    /// 始终可用——不需要 warm()。供 lsp_status() 区分"未启动"和"未安装"。
    fn find_on_path(cmd: &str) -> bool {
        Self::resolve_cmd_path(cmd).is_some()
    }

    /// 完整的 LSP 状态，供设置面板 / engine_status 使用。
    ///
    /// 每项：`state`（`LspServerState::as_str()` 五态——**单一归因源**）、
    /// `available`（池中有活进程）、`installed`（PATH 检查）、`error`（仅失败/在途有值）。
    ///
    /// 修（#5，2026-09-25）：旧版在「已安装 + 未就绪 + 无错误 + 已 mark_initialized」
    /// 时填 `warm in progress or silent failure — retry if persists`——把
    /// 「从未 warm（懒加载正常初态）/ 正在 warm / warm 静默失败」三种状态糊成一句，
    /// 且措辞把人引向「它坏了」。现在四态分开、文案各说各的实际含义。
    pub fn lsp_status() -> Vec<Value> {
        SERVER_CONFIGS
            .iter()
            .map(|cfg| {
                let state = Self::server_state(cfg.command);
                let available = state == LspServerState::Ready;
                let installed = available || Self::find_on_path(cfg.command);
                let error = match &state {
                    LspServerState::Failed(e) => Some(e.clone()),
                    // 在途不是错误（懒加载的正常中间态）——如实标注，别叫「silent failure」
                    LspServerState::Warming => {
                        Some("warm in progress — server is being started (retry shortly, not a failure)".to_string())
                    }
                    _ => None,
                };
                json!({
                    "command": cfg.command,
                    "language_id": cfg.language_id,
                    "extensions": cfg.extensions,
                    "state": state.as_str(),
                    "available": available,
                    "installed": installed,
                    "error": error,
                })
            })
            .collect()
    }
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_single_location() {
        // 单个 Location 应正确解析
        let json = json!({
            "uri": "file:///src/main.rs",
            "range": {
                "start": {"line": 10, "character": 5},
                "end": {"line": 10, "character": 9}
            }
        });
        let locs = parse_definition_results(&json).unwrap();
        assert_eq!(locs.len(), 1);
        assert_eq!(locs[0].uri, "file:///src/main.rs");
        assert_eq!(locs[0].range_start_line, 10);
    }

    #[test]
    fn test_parse_null_result() {
        // null 结果应返回空列表
        let locs = parse_definition_results(&Value::Null).unwrap();
        assert!(locs.is_empty());
    }

    #[test]
    fn test_server_configs_complete() {
        // 验证所有主要语言的扩展名都在配置表中
        let covered: Vec<&str> = SERVER_CONFIGS
            .iter()
            .flat_map(|c| c.extensions.iter().copied())
            .collect();
        assert!(covered.contains(&"rs"));
        assert!(covered.contains(&"py"));
        assert!(covered.contains(&"go"));
        assert!(covered.contains(&"java"));
        assert!(covered.contains(&"ts"));
        assert!(covered.contains(&"cs"));
        assert!(covered.contains(&"php"));
        assert!(covered.contains(&"kt"));
    }

    // ── 辅助函数 ──


    /// 启动一个会挂起 60 秒的进程——用于超时测试。
    fn spawn_hanging_process() -> LspProcess {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("cmd");
            c.args(&["/c", "ping -n 60 127.0.0.1 > nul"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("sh");
            c.args(&["-c", "sleep 60"]);
            c
        };
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn hanging process");

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        LspProcess {
            process: child,
            stdin: Arc::new(Mutex::new(stdin)),
            reader: Some(BufReader::new(stdout)),
            stderr: None,
            next_id: 0,
            timeout: std::time::Duration::from_secs(2), // 测试用 2 秒超时
            spawned_at: std::time::Instant::now(),
            cold_window: std::time::Duration::from_secs(60),
            late_rx: None,
        }
    }

    /// 启动一个「收到请求后延迟应答」的 python 假 LSP 服务器——
    /// 用于迟到响应回收测试（读线程最终会把 reader 送回回收盒）。
    fn spawn_slow_responder(delay_secs: f64, timeout: std::time::Duration) -> LspProcess {
        let script = format!(
            r#"
import sys, json, time
def read_msg():
    length = 0
    while True:
        line = sys.stdin.buffer.readline()
        if not line: sys.exit(0)
        if line.startswith(b'Content-Length:'):
            length = int(line.split(b':')[1].strip())
        if line == b'\r\n': break
    return json.loads(sys.stdin.buffer.read(length))
def send(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(b'Content-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
    sys.stdout.buffer.flush()
for _ in range(3):
    req = read_msg()
    time.sleep({delay_secs})
    send({{"jsonrpc":"2.0","id":req["id"],"result":{{}}}})
"#
        );
        let mut child = Command::new("python")
            .args(["-c", &script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn python slow responder");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        LspProcess {
            process: child,
            stdin: Arc::new(Mutex::new(stdin)),
            reader: Some(BufReader::new(stdout)),
            stderr: None,
            next_id: 0,
            timeout,
            spawned_at: std::time::Instant::now(),
            cold_window: std::time::Duration::from_secs(300),
            late_rx: None,
        }
    }

    // ── 超时测试 ──

    #[test]
    fn test_read_one_message_parses_coalesced_frames() {
        // ponytail: 服务器一次 write 粘连多条消息（帧+帧），
        // 曾导致 read_line 行边界错位、body 读进帧头。
        // 验证新解析器能精确拆帧。
        use std::process::{Command, Stdio};
        // 用一个子进程模拟服务器：输出两条粘连的 LSP 帧
        let mut child = Command::new("python")
            .args(["-c", r#"
import sys, json, time
def frame(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(b'Content-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
    sys.stdout.buffer.flush()
# 两条消息粘连在同一个 write 里
frame({"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}})
frame({"jsonrpc":"2.0","id":2,"result":[{"uri":"file:///x.ts","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}]})
time.sleep(0.2)
"#])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn python");
        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);

        // 第一条帧
        let (id1, msg1) = LspProcess::read_one_message(&mut reader).expect("frame 1");
        assert_eq!(id1, Some(1));
        assert!(msg1.get("result").is_some(), "frame1 result missing");

        // 第二条帧 — 粘连场景下第二条必须能精确解析
        let (id2, msg2) = LspProcess::read_one_message(&mut reader).expect("frame 2");
        assert_eq!(id2, Some(2));
        let result = msg2.get("result").unwrap();
        assert!(result.is_array(), "frame2 should be an array, got {:?}", result);
        let _ = child.wait();
    }

    #[test]
    fn test_send_request_timeout() {
        // 挂起进程的请求应在超时后返回错误，而非永久阻塞
        let mut process = spawn_hanging_process();
        let start = std::time::Instant::now();
        let result = process.send_request(
            "textDocument/references",
            json!({"textDocument":{"uri":"file:///x.rs"},"position":{"line":0,"character":0}}),
        );
        let elapsed = start.elapsed();
        // 不应挂起——必须在 5 秒内返回（超时设为 2 秒）
        assert!(elapsed < std::time::Duration::from_secs(5),
            "send_request should not block forever, took {:?}, result: {:?}", elapsed, result);
        assert!(result.is_err(), "expected error from hanging process, got {:?}", result);
    }

    // ── 生存性三闸回归（2026-09-09 事故）──

    #[test]
    fn test_spawn_gate_decision() {
        // 探测不到（None）→ 不门禁
        assert!(LspManager::spawn_gate_decision(None).is_ok());
        // 充足 → 放行
        assert!(LspManager::spawn_gate_decision(Some(MIN_SPAWN_COMMIT_MB)).is_ok());
        assert!(LspManager::spawn_gate_decision(Some(MIN_SPAWN_COMMIT_MB + 1)).is_ok());
        // 不足 → 拒绝且给出可操作的原因
        let err = LspManager::spawn_gate_decision(Some(MIN_SPAWN_COMMIT_MB - 1)).unwrap_err();
        assert!(err.contains("low system memory"), "gate error should explain: {err}");
    }

    #[test]
    fn test_available_commit_mb_positive() {
        // 本机必须能探测到正值，否则门禁形同虚设
        let avail = LspManager::available_commit_mb();
        assert!(avail.is_some(), "available_commit_mb should be probeable");
        assert!(avail.unwrap() > 0);
    }

    #[test]
    fn test_err_preserves_server_classification() {
        // 忙/JSON-RPC error → 保留进程
        assert!(LspManager::err_preserves_server("LSP busy: timeout after 5s waiting for x(id 1)"));
        assert!(LspManager::err_preserves_server("LSP error: {\"code\":-32601,...}"));
        // 流损坏/死亡 → 销毁
        assert!(!LspManager::err_preserves_server("LSP read error: read header: failed to fill whole buffer"));
        assert!(!LspManager::err_preserves_server("LSP reader lost after cold window — server will be recreated"));
        assert!(!LspManager::err_preserves_server("parse: expected value"));
    }

    // ── #5 五态分类（纯判据穷举）──

    #[test]
    fn test_server_state_classification_is_five_way() {
        use LspServerState::*;
        // 池中活进程 ⇒ Ready（与 PATH / 历史错误无关）
        assert_eq!(classify_server_state(Some(true), false, Some("x".into()), true), Ready);
        // 死壳 ⇒ Failed（下次查询重建）
        assert!(matches!(
            classify_server_state(Some(false), true, None, true),
            Failed(_)
        ));
        // **没装优先于失败过**：唯一可行动作是安装，报 spawn 错误只会把人引偏
        assert_eq!(
            classify_server_state(None, false, Some("spawn: program not found".into()), true),
            NotInstalled
        );
        // 装了 + 失败记录 ⇒ Failed（带原因，engine_status 可见）
        assert_eq!(
            classify_server_state(None, true, Some("gate: low system memory".into()), true),
            Failed("gate: low system memory".into())
        );
        // 装了 + 尝试过 + 无错误 ⇒ Warming（在途——旧文案叫它 "silent failure"）
        assert_eq!(classify_server_state(None, true, None, true), Warming);
        // 装了 + 从未尝试 ⇒ NeverWarmed（**懒加载的正常初态，不是故障**——#5 的由来）
        assert_eq!(classify_server_state(None, true, None, false), NeverWarmed);
    }

    #[test]
    fn test_server_state_names_are_stable() {
        // 状态名是引擎状态面的机器可读契约（设置面板 / engine_status / 工具 details 同源）
        assert_eq!(LspServerState::Ready.as_str(), "ready");
        assert_eq!(LspServerState::Warming.as_str(), "warming");
        assert_eq!(LspServerState::NeverWarmed.as_str(), "never-warmed");
        assert_eq!(LspServerState::Failed(String::new()).as_str(), "failed");
        assert_eq!(LspServerState::NotInstalled.as_str(), "not-installed");
    }

    // ── #7 冷启动空结果不算数 ──

    #[test]
    fn test_cold_start_note_flags_unreliable_empty_results() {
        let mut process = spawn_hanging_process();
        // 刚起来（冷窗口内）：空结果不许当真，且必须是 busy 类（工具层才给「稍后重试」、
        // 且 with_process 保留进程不误杀）
        let note = process.cold_start_note().expect("young server must be flagged cold");
        assert!(note.starts_with("LSP busy"), "cold note must be busy-class: {note}");
        assert!(LspManager::err_preserves_server(&note), "cold note must not destroy the server");
        // 冷窗口过期：空结果可信（None = 别拿冷启动当借口）
        process.cold_window = std::time::Duration::ZERO;
        assert!(process.cold_start_note().is_none());
    }

    #[test]
    fn test_timeout_keeps_young_server_alive() {
        // 杀-重生循环回归：冷窗口内超时不得销毁进程。
        // 旧实现超时即杀 → 冷启动 rust-analyzer 永远活不过索引期。
        let arc: Arc<Mutex<Option<LspProcess>>> = Arc::new(Mutex::new(Some(spawn_hanging_process())));

        // 第一次请求：2s 超时 → busy（保留进程）
        let e1 = LspManager::with_process(&arc, |p| {
            p.send_request("textDocument/definition", json!({}))
        }).unwrap_err();
        assert!(e1.starts_with("LSP busy"), "timeout should be busy-class, got: {e1}");
        assert!(arc.lock().unwrap().is_some(), "young server must survive a timeout");

        // 第二次请求：回收盒空（挂起进程永不响应）→ 冷窗口内仍 busy、仍保留
        let e2 = LspManager::with_process(&arc, |p| {
            p.send_request("textDocument/definition", json!({}))
        }).unwrap_err();
        assert!(e2.starts_with("LSP busy"), "cold-window busy expected, got: {e2}");
        assert!(arc.lock().unwrap().is_some(), "young server must stay alive while busy");
    }

    #[test]
    fn test_cold_window_expiry_destroys_stuck_server() {
        // 冷窗口耗尽仍收不回 reader → 销毁重建（挂死的服务器不能永久占位）
        let arc: Arc<Mutex<Option<LspProcess>>> = Arc::new(Mutex::new(Some(spawn_hanging_process())));
        // 冷窗口归零：下一轮回收失败即判死刑
        arc.lock().unwrap().as_mut().unwrap().cold_window = std::time::Duration::ZERO;

        let e1 = LspManager::with_process(&arc, |p| {
            p.send_request("textDocument/definition", json!({}))
        }).unwrap_err();
        assert!(e1.starts_with("LSP busy"));

        let e2 = LspManager::with_process(&arc, |p| {
            p.send_request("textDocument/definition", json!({}))
        }).unwrap_err();
        assert!(e2.contains("reader lost"), "expired cold window should be destroy-class, got: {e2}");
        assert!(arc.lock().unwrap().is_none(), "stuck server must be destroyed after cold window");
    }

    #[test]
    fn test_late_response_reclaim_restores_reader() {
        // 迟到响应回收：服务器最终应答后，reader 必须能被下次调用收割，
        // 服务器恢复健康（而不是被当成死壳销毁）。
        // python 假服务器：每个请求延迟 1.2s 才应答，请求超时 300ms。
        let mut process = spawn_slow_responder(1.2, std::time::Duration::from_millis(300));

        let e1 = process.send_request("textDocument/definition", json!({})).unwrap_err();
        assert!(e1.starts_with("LSP busy"), "first request should time out as busy, got: {e1}");

        // 轮询等回收盒到货：慢机器上 python 启动 + 全量测试并行时
        // 调度延迟都可能远超 1.5s。回收未到时 send_request 只空转
        // 返回 busy（不发新请求），轮询无副作用。
        // 收割成功的标志 = 发出的是【新】请求并再次超时——
        // 而不是 "reader lost"。
        let mut e2 = String::new();
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            match process.send_request("textDocument/definition", json!({})) {
                Err(e) if e.contains("LSP busy: timeout") => { e2 = e; break; }
                Err(e) if e.contains("still answering") => { continue; }
                other => panic!("unexpected result while polling for reclaim: {other:?}"),
            }
        }
        assert!(!e2.is_empty(), "late response never arrived within poll budget");
        assert!(!e2.contains("reader lost"), "reader must have been reclaimed, got: {e2}");

        let _ = process.process.kill();
    }

    #[test]
    fn test_respawn_cooldown_remaining() {
        let mgr = LspManager::global();
        let key = "__test_cooldown_cmd__";
        {
            let mut map = mgr.last_spawn.write().unwrap();
            map.insert(key.to_string(), std::time::Instant::now());
        }
        assert!(LspManager::respawn_cooldown_remaining(key).is_some(),
            "fresh spawn attempt must be inside cooldown");
        // 时间倒推超过冷却 → 放行
        {
            let mut map = mgr.last_spawn.write().unwrap();
            map.insert(key.to_string(), std::time::Instant::now() - RESPAWN_COOLDOWN - std::time::Duration::from_secs(1));
        }
        assert!(LspManager::respawn_cooldown_remaining(key).is_none(),
            "cooldown must expire");
        mgr.last_spawn.write().unwrap().remove(key);
    }

    #[test]
    fn test_mark_initialized() {
        // 全局状态测试：与其它引擎级测试共用串行锁，避免互相污染
        let _guard = crate::engine::global_engine_test_guard();
        LspManager::mark_initialized("D:/__lsp_mark_init_test__");
        assert!(LspManager::is_initialized());
        assert!(!LspManager::root_changed("D:/__lsp_mark_init_test__"));
        assert!(LspManager::root_changed("D:/another/root"));
        // 还原全局状态（直接写私有字段，避免 shutdown_all 误杀并行测试的服务器池）
        let mgr = LspManager::global();
        *mgr.initialized.write().unwrap_or_else(|e| e.into_inner()) = false;
        *mgr.project_root.write().unwrap_or_else(|e| e.into_inner()) = None;
    }

    #[test]
    fn test_daemon_mode_never_connects_to_itself() {
        // 宿主自连防护：hologram-lspd 进程内的 op 必须永远走本地池，
        // 即使端口文件存在（指向自己）也绝不入客户端路径（防递归）。
        let _guard = crate::engine::global_engine_test_guard();
        let root = std::env::temp_dir().join(format!("hologram_lsp_selfconn_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&root);
        let pf = crate::lsp_daemon::port_file(&root);
        let _ = std::fs::write(&pf, "1"); // 伪端口：若误入客户端会触发拉起链（慢且错）
        LspManager::mark_initialized(&root.to_string_lossy());

        LspManager::set_daemon_mode(true);
        let r = LspManager::try_daemon_locations("definition", "x.rs", "src", 0, 0, "rs");
        assert!(r.is_none(), "daemon_mode must bypass the client path");
        LspManager::set_daemon_mode(false);

        // 还原全局状态
        let mgr = LspManager::global();
        *mgr.initialized.write().unwrap_or_else(|e| e.into_inner()) = false;
        *mgr.project_root.write().unwrap_or_else(|e| e.into_inner()) = None;
        let _ = std::fs::remove_file(&pf);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_daemon_offline_falls_back_to_local() {
        // 宿主离线（无端口文件 + 找不到 lspd 二进制）→ op 包装返回 None，
        // 调用方走本地池。负缓存写入独立 root，不污染其它测试。
        let _guard = crate::engine::global_engine_test_guard();
        let root = std::env::temp_dir()
            .join(format!("hologram_lsp_offline_{}", std::process::id()))
            .to_string_lossy()
            .to_string();
        let _ = std::fs::create_dir_all(&root);
        let pf = crate::lsp_daemon::port_file(std::path::Path::new(&root));
        let _ = std::fs::remove_file(&pf); // 确保离线
        LspManager::mark_initialized(&root);

        let r = LspManager::try_daemon_locations("definition", "x.rs", "src", 0, 0, "rs");
        assert!(r.is_none(), "offline daemon must fall through to local pool");

        // 还原全局状态
        let mgr = LspManager::global();
        *mgr.initialized.write().unwrap_or_else(|e| e.into_inner()) = false;
        *mgr.project_root.write().unwrap_or_else(|e| e.into_inner()) = None;
        mgr.daemon_ensure.write().unwrap_or_else(|e| e.into_inner()).clear();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 进程回收回归：shutdown_all 必须杀掉池中全部 LSP 子进程
    ///（静态池退出时不跑析构，曾漏 56 个孤儿 jdtls/omnisharp）。
    #[cfg(unix)]
    #[test]
    fn test_shutdown_all_kills_pooled_processes() {
        let mgr = LspManager::global();
        let pid = {
            let p = spawn_hanging_process();
            let pid = p.process.id();
            mgr.pool
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .insert("__test_shutdown__", Arc::new(Mutex::new(Some(p))));
            pid
        };

        LspManager::shutdown_all();

        // 池已清空
        let pool = mgr.pool.read().unwrap_or_else(|e| e.into_inner());
        assert!(pool.get("__test_shutdown__").is_none(), "pool entry removed");
        drop(pool);

        // 子进程已死（给 kill 一点时间）
        let mut dead = false;
        for _ in 0..50 {
            let alive = process_alive(pid);
            if !alive {
                dead = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(dead, "shutdown_all 后子进程 {} 必须已退出", pid);
    }

    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        // kill(pid, 0) 对僵尸进程也返回成功 —— 用 waitpid(WNOHANG)
        // 同时判定死亡并回收僵尸。
        let mut status: libc::c_int = 0;
        let r = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
        match r {
            0 => true,                      // 仍在运行
            p if p == pid as i32 => false,  // 僵尸，已被回收 → 死了
            _ => false,                     // ECHILD：不存在 → 死了
        }
    }

    // ── E2E: 真实 rust-analyzer ──

    // 注意：曾尝试 rust-analyzer E2E 测试，但在 CI 中不可靠：
    // cargo check 的耗时因机器而异波动很大。超时机制已由 test_send_request_timeout 验证；
    // 真实 LSP 调用在每次引擎运行时被测试（索引 + 通过 MCP 工具的 agent 查询）。

}

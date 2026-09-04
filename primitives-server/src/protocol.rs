// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! protocol — stdio JSON-RPC 服务端（引擎 mcp.rs run_stdio 同款骨架）。
//!
//! 方法面（v1，仅 fs 原语——拆壳第一刀范围）：
//!   fs.read_text    {path}                          → {content}
//!   fs.read_bytes   {path}                          → {base64}
//!   fs.write_text   {path, content}                 → {}
//!   fs.create_dir   {path}                          → {}
//!   fs.delete       {path}                          → {}
//!   fs.rename       {from, to}                      → {}
//!   fs.list_dir     {path, recursive, filterIgnored} → {entries:[...]}
//!   fs.format_lines {content, offset, limit}        → {formatted}
//!   fs.preview      {content, maxWidth, maxLines}   → {preview}
//!   fs.glob         {path, patterns:[...]}          → {results:[{path,name}]}
//!
//! 所有 path 均为**壳裁决后的物理路径**——本进程不做任何权限判断。
//! 未知方法 / 参数非法 → JSON-RPC error（不 panic、不毒化流）。

use std::io::{BufRead, BufReader, Write};

use serde_json::{json, Value};

use crate::fs_ops;

/// 处理一行 JSON-RPC 请求，返回要写回 stdout 的输出行。
/// 请求无 id（通知）→ 不产生响应。纯函数：不碰 stdin/stdout（测试友好）。
pub fn handle_line(line: &str) -> Vec<String> {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return vec![], // 坏行丢弃（不毒化流）
    };
    let id = match request.get("id").cloned() {
        Some(id @ (Value::Number(_) | Value::String(_))) => id,
        _ => return vec![], // 通知（无 id）不响应
    };
    let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    match method {
        "initialize" => vec![success(&id, json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "serverInfo": { "name": "primitives-server", "version": env!("CARGO_PKG_VERSION") },
        }))],
        "ping" => vec![success(&id, json!({}))],
        "fs.read_text" => {
            let path = match req_str(&params, "path") {
                Ok(p) => p,
                Err(e) => return vec![error(&id, -32602, &e)],
            };
            match fs_ops::read_text(&path) {
                Ok(content) => vec![success(&id, json!({ "content": content }))],
                Err(e) => vec![error(&id, -32000, &e)],
            }
        }
        "fs.read_bytes" => {
            let path = match req_str(&params, "path") {
                Ok(p) => p,
                Err(e) => return vec![error(&id, -32602, &e)],
            };
            match fs_ops::read_bytes(&path) {
                Ok(bytes) => {
                    use base64::Engine;
                    vec![success(
                        &id,
                        json!({ "base64": base64::engine::general_purpose::STANDARD.encode(&bytes) }),
                    )]
                }
                Err(e) => vec![error(&id, -32000, &e)],
            }
        }
        "fs.write_text" => {
            let (path, content) = match (req_str(&params, "path"), req_str(&params, "content")) {
                (Ok(p), Ok(c)) => (p, c),
                (Err(e), _) | (_, Err(e)) => return vec![error(&id, -32602, &e)],
            };
            match fs_ops::write_text(&path, &content) {
                Ok(()) => vec![success(&id, json!({}))],
                Err(e) => vec![error(&id, -32000, &e)],
            }
        }
        "fs.create_dir" => {
            let path = match req_str(&params, "path") {
                Ok(p) => p,
                Err(e) => return vec![error(&id, -32602, &e)],
            };
            match fs_ops::create_dir(&path) {
                Ok(()) => vec![success(&id, json!({}))],
                Err(e) => vec![error(&id, -32000, &e)],
            }
        }
        "fs.delete" => {
            let path = match req_str(&params, "path") {
                Ok(p) => p,
                Err(e) => return vec![error(&id, -32602, &e)],
            };
            match fs_ops::delete(&path) {
                Ok(()) => vec![success(&id, json!({}))],
                Err(e) => vec![error(&id, -32000, &e)],
            }
        }
        "fs.rename" => {
            let (from, to) = match (req_str(&params, "from"), req_str(&params, "to")) {
                (Ok(f), Ok(t)) => (f, t),
                (Err(e), _) | (_, Err(e)) => return vec![error(&id, -32602, &e)],
            };
            match fs_ops::rename(&from, &to) {
                Ok(()) => vec![success(&id, json!({}))],
                Err(e) => vec![error(&id, -32000, &e)],
            }
        }
        "fs.list_dir" => {
            let path = match req_str(&params, "path") {
                Ok(p) => p,
                Err(e) => return vec![error(&id, -32602, &e)],
            };
            let recursive = params.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
            let filter_ignored = params.get("filterIgnored").and_then(|v| v.as_bool()).unwrap_or(true);
            let p = std::path::PathBuf::from(&path);
            if !p.is_dir() {
                return vec![error(&id, -32000, &format!("不是有效目录: {}", path))];
            }
            let entries = if recursive {
                fs_ops::list_dir_recursive(&p, filter_ignored)
            } else {
                fs_ops::list_dir_flat(&p)
            };
            let entries_json = serde_json::to_value(entries).unwrap_or_else(|_| json!([]));
            vec![success(&id, json!({ "entries": entries_json }))]
        }
        "fs.format_lines" => {
            let content = match req_str(&params, "content") {
                Ok(c) => c,
                Err(e) => return vec![error(&id, -32602, &e)],
            };
            let offset = params.get("offset").and_then(|v| v.as_u64()).map(|n| n as usize);
            let limit = params.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
            vec![success(&id, json!({ "formatted": fs_ops::format_lines(&content, offset, limit) }))]
        }
        "fs.preview" => {
            let content = match req_str(&params, "content") {
                Ok(c) => c,
                Err(e) => return vec![error(&id, -32602, &e)],
            };
            let max_width = params.get("maxWidth").and_then(|v| v.as_u64()).unwrap_or(80) as usize;
            let max_lines = params.get("maxLines").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
            vec![success(&id, json!({ "preview": fs_ops::preview(&content, max_width, max_lines) }))]
        }
        "fs.glob" => {
            let path = match req_str(&params, "path") {
                Ok(p) => p,
                Err(e) => return vec![error(&id, -32602, &e)],
            };
            let patterns: Vec<String> = params
                .get("patterns")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            match fs_ops::glob(&path, &patterns) {
                Ok(results) => {
                    let results_json = serde_json::to_value(results).unwrap_or_else(|_| json!([]));
                    vec![success(&id, json!({ "results": results_json }))]
                }
                Err(e) => vec![error(&id, -32000, &e)],
            }
        }
        other => vec![error(&id, -32601, &format!("Method not found: {other}"))],
    }
}

fn req_str(params: &Value, name: &str) -> Result<String, String> {
    params
        .get(name)
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("missing '{name}'"))
}

fn success(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// 主循环：从 stdin 逐行读请求 → 处理 → 写回 stdout。
/// 启动先发 ready（壳 client 等此信号，同引擎 serve 协议）。
pub fn run_stdio() {
    println!(r#"{{"jsonrpc":"2.0","method":"ready"}}"#);
    let _ = std::io::stdout().flush();

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let _reader = std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in BufReader::new(stdin.lock()).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if tx.send(trimmed.to_string()).is_err() {
                break;
            }
        }
    });

    let mut stdout = std::io::stdout();
    loop {
        match rx.recv() {
            Ok(line) => {
                for out in handle_line(&line) {
                    let _ = writeln!(stdout, "{out}");
                }
                let _ = stdout.flush();
            }
            Err(_) => break, // reader 线程退出（stdin EOF）
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_handshake_line_is_notification() {
        let out = handle_line(r#"{"jsonrpc":"2.0","method":"ready"}"#);
        assert!(out.is_empty());
    }

    #[test]
    fn unknown_method_returns_error() {
        let out = handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"nope","params":{}}"#);
        assert_eq!(out.len(), 1);
        let v: Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(v["error"]["code"], -32601);
    }

    #[test]
    fn bad_line_is_dropped() {
        let out = handle_line("not json at all");
        assert!(out.is_empty());
    }

    #[test]
    fn read_text_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("primitives_proto_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("a.txt");
        std::fs::write(&f, "hello world").unwrap();

        let req = json!({
            "jsonrpc": "2.0", "id": 7,
            "method": "fs.read_text",
            "params": { "path": f.to_string_lossy() }
        });
        let out = handle_line(&req.to_string());
        assert_eq!(out.len(), 1);
        let v: Value = serde_json::from_str(&out[0]).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["content"], "hello world");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_missing_returns_error() {
        let req = json!({
            "jsonrpc": "2.0", "id": 1,
            "method": "fs.read_text",
            "params": { "path": "Z:/definitely/not/here.txt" }
        });
        let out = handle_line(&req.to_string());
        let v: Value = serde_json::from_str(&out[0]).unwrap();
        assert!(v["error"].is_object(), "missing file → error: {v}");
    }

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("primitives_proto_wr_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("sub/w.txt");

        let w = json!({
            "jsonrpc": "2.0", "id": 2,
            "method": "fs.write_text",
            "params": { "path": f.to_string_lossy(), "content": "abc" }
        });
        let out = handle_line(&w.to_string());
        let v: Value = serde_json::from_str(&out[0]).unwrap();
        assert!(v["result"].is_object(), "write ok: {v}");
        assert!(f.is_file(), "file created");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "abc");

        // 再写覆盖（原子 .bak 路径）
        let w2 = json!({
            "jsonrpc": "2.0", "id": 3,
            "method": "fs.write_text",
            "params": { "path": f.to_string_lossy(), "content": "xyz" }
        });
        let _ = handle_line(&w2.to_string());
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "xyz");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

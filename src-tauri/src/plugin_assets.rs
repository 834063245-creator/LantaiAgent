// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 插件静态资源服务（WO-S0B 插件内核）——装载通道的正式实现。
//
// 背景：WO-S0A spike（2026-08-20）已证实 Tauri webview 能从
// http://127.0.0.1:14570 动态 import ES module；本模块把验证过的路由正式化：
//   GET /plugins/                → 插件目录索引（JSON 数组：含 manifest.json 的子目录）
//   GET /plugins/<id>/<相对路径>  → ~/.hologram/plugins/<id>/<相对路径> 静态文件
//   GET /plugins/plugins.json    → 启用态持久化文件（根目录下的普通文件，同一解析路径）
//
// 安全三件套（composition-architecture 计划风险表 R5）：
//   - 路径遍历拒绝：percent 解码后逐段校验（空/./.. 拒绝，含 %2e%2e 编码形态）
//     + canonicalize 前缀双保险（符号链接/junction 逃逸兜底）；
//   - 仅 GET：非 GET 的 /plugins/* → 405（JSON 错误体）；
//   - 仅 loopback：本服务挂在 llm_proxy 的 hyper 监听上，只绑 127.0.0.1
//     （llm_proxy::loopback_bind_addr 测试钉住）。
//
// 信任模型：完全信任、无沙箱（用户 2026-08-19 拍板，见
// docs/adr/composition-boundaries.md §2 层 5）；本模块只管资产通道，不做执行隔离。

use crate::llm_proxy::{err_response, full_boxed, BoxBody};
use hyper::body::Bytes;
use hyper::{Response, StatusCode};
use std::path::{Path, PathBuf};

/// 单文件读取上限——防无界读入内存（正式实现如需大资产再走流式）。
const MAX_PLUGIN_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// 插件根目录：用户主目录下 `.hologram/plugins/`。
/// 与启用态持久化（plugins.json，同目录普通文件）共用同一解析函数（WO-S0B 要求）。
/// `HOLOGRAM_PLUGINS_ROOT` 环境变量可覆盖（测试隔离与目录重定位）。
pub(crate) fn plugins_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("HOLOGRAM_PLUGINS_ROOT") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    // 仓库惯例的家目录解析（同 commands/filesystem.rs get_global_memory_dir）
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".hologram").join("plugins")
}

/// 最小 percent 解码（解码失败 → None，整条请求拒绝）。
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if bytes.len() < i + 3 {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// resolve_asset 的三态结果。
enum ResolveOutcome {
    /// 非法路径（遍历/编码攻击）→ 403
    Forbidden,
    /// 目标不存在 → 404
    Missing,
    /// 解析成功（canonicalize 后仍在根目录内）
    Found(PathBuf),
}

/// URL 路径 → 根目录下文件的规范化解析（遍历防护核心）。
/// 规则：先 percent 解码再按 `/` 分段，任一段为空 / `.` / `..` 即拒绝
/// （覆盖 `%2e%2e` 编码形态）；拒绝 `\` 与 NUL（Windows 分隔符注入）；
/// canonicalize 解析符号链接/junction 后必须仍以根目录为前缀——双保险。
fn resolve_asset(root: &Path, url_path: &str) -> ResolveOutcome {
    let Some(decoded) = percent_decode(url_path) else {
        return ResolveOutcome::Forbidden;
    };
    if decoded.is_empty() || decoded.contains('\\') || decoded.contains('\0') {
        return ResolveOutcome::Forbidden;
    }
    let mut full = root.to_path_buf();
    for seg in decoded.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return ResolveOutcome::Forbidden;
        }
        full.push(seg);
    }
    let Ok(canonical_root) = std::fs::canonicalize(root) else {
        return ResolveOutcome::Missing;
    };
    let Ok(canonical) = std::fs::canonicalize(&full) else {
        return ResolveOutcome::Missing;
    };
    if !canonical.starts_with(&canonical_root) {
        return ResolveOutcome::Forbidden;
    }
    ResolveOutcome::Found(canonical)
}

/// MIME 映射——ES module import 对 MIME 严格，`.js`/`.mjs` 必须是
/// `application/javascript`，否则 webview 拒绝执行模块。
/// `.wasm` 为前瞻映射（WO-S0B），本阶段无消费者。
fn plugin_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("js") | Some("mjs") => "application/javascript",
        Some("json") => "application/json",
        Some("css") => "text/css",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// 静态文件读取错误（区分 404/413/500 语义）。
enum AssetReadError {
    NotAFile,
    TooLarge,
    Io(std::io::Error),
}

/// 插件资产路由主入口（GET /plugins/&lt;path&gt;）。文件 IO 走 spawn_blocking。
/// 仅 loopback 由服务器绑定天然保证（14570 只绑 127.0.0.1）。
pub(crate) async fn serve_plugin_path(url_path: &str) -> Response<BoxBody> {
    // 空路径 = 目录索引（GET /plugins/）——loader 的插件发现端点。
    if url_path.is_empty() {
        return serve_index().await;
    }
    let root = plugins_root();
    match resolve_asset(&root, url_path) {
        ResolveOutcome::Forbidden => {
            json_error(StatusCode::FORBIDDEN, "forbidden", "路径遍历或非法路径被拒绝")
        }
        ResolveOutcome::Missing => json_error(StatusCode::NOT_FOUND, "not_found", "插件资产不存在"),
        ResolveOutcome::Found(path) => {
            let mime = plugin_mime(&path);
            let read = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, AssetReadError> {
                let meta = std::fs::metadata(&path).map_err(AssetReadError::Io)?;
                if !meta.is_file() {
                    return Err(AssetReadError::NotAFile);
                }
                if meta.len() > MAX_PLUGIN_FILE_BYTES {
                    return Err(AssetReadError::TooLarge);
                }
                std::fs::read(&path).map_err(AssetReadError::Io)
            })
            .await;
            match read {
                Ok(Ok(bytes)) => asset_response(StatusCode::OK, mime, Bytes::from(bytes)),
                Ok(Err(AssetReadError::NotAFile)) => {
                    json_error(StatusCode::NOT_FOUND, "not_found", "不是常规文件")
                }
                Ok(Err(AssetReadError::TooLarge)) => {
                    json_error(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "插件资产超过 32MB 上限")
                }
                Ok(Err(AssetReadError::Io(e))) => {
                    eprintln!("[plugin_assets] 插件资产读取失败: {e}");
                    json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "插件资产读取失败")
                }
                Err(join_err) => {
                    eprintln!("[plugin_assets] 插件资产读取任务失败: {join_err}");
                    json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "插件资产读取任务失败")
                }
            }
        }
    }
}

/// 非 GET 的 /plugins/* → 405（JSON 错误体，CORS 头齐全）。
pub(crate) fn method_not_allowed() -> Response<BoxBody> {
    json_error(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "插件资产通道仅支持 GET")
}

/// 目录索引：含 manifest.json 的子目录相对路径（`/` 分隔，排序稳定）。
/// 名字可含一段斜杠（npm scope 风格，如 hologram/settings 对应嵌套目录），深度 ≤2。
async fn serve_index() -> Response<BoxBody> {
    let root = plugins_root();
    let listed = tokio::task::spawn_blocking(move || list_plugin_dirs(&root)).await;
    match listed {
        Ok(dirs) => {
            let body = serde_json::to_string(&dirs).unwrap_or_else(|e| {
                eprintln!("[plugin_assets] 索引序列化失败: {e}");
                "[]".to_string()
            });
            asset_response(StatusCode::OK, "application/json", Bytes::from(body))
        }
        Err(join_err) => {
            eprintln!("[plugin_assets] 索引扫描任务失败: {join_err}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "插件索引扫描失败")
        }
    }
}

/// 纯函数：列出根目录下含 manifest.json 的子目录（walkdir 深度 ≤2，不跟符号链接）。
fn list_plugin_dirs(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !root.is_dir() {
        return out;
    }
    for entry in walkdir::WalkDir::new(root).max_depth(2).min_depth(1) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_dir() {
            continue;
        }
        if !entry.path().join("manifest.json").is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        out.push(rel.to_string_lossy().replace('\\', "/"));
    }
    out.sort();
    out
}

/// 静态资产响应——CORS/PNA 头与 llm_proxy::cors_response 同一套
/// （含 access-control-allow-private-network: true，WebView2 PNA 预检需要）。
fn asset_response(status: StatusCode, mime: &str, body: Bytes) -> Response<BoxBody> {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "GET, POST, OPTIONS")
        .header("access-control-allow-headers", "*")
        .header("access-control-allow-private-network", "true")
        .body(full_boxed(body))
        .unwrap_or_else(|_| err_response(StatusCode::INTERNAL_SERVER_ERROR, "proxy: 构造插件响应失败"))
}

/// JSON 错误响应（404/403/405/500/413 统一形状：{"error": code, "message": ...}）。
fn json_error(status: StatusCode, code: &str, message: &str) -> Response<BoxBody> {
    let body = serde_json::json!({ "error": code, "message": message }).to_string();
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "GET, POST, OPTIONS")
        .header("access-control-allow-headers", "*")
        .header("access-control-allow-private-network", "true")
        .body(full_boxed(Bytes::from(body)))
        .unwrap_or_else(|_| err_response(StatusCode::INTERNAL_SERVER_ERROR, "proxy: 构造插件错误响应失败"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_root(tag: &str) -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!("hologram_plugin_assets_{tag}_{}", std::process::id()));
        let root = tmp.join("plugins");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(root.join("hello")).unwrap();
        std::fs::create_dir_all(root.join("hologram").join("settings")).unwrap();
        std::fs::write(root.join("hello").join("manifest.json"), b"{\"name\":\"hello\"}").unwrap();
        std::fs::write(
            root.join("hologram").join("settings").join("manifest.json"),
            b"{\"name\":\"hologram/settings\"}",
        )
        .unwrap();
        std::fs::write(root.join("hello").join("entry.js"), b"export const spike = 1").unwrap();
        std::fs::write(root.join("plugins.json"), b"{\"disabled\":[]}").unwrap();
        root
    }

    /// WO-S0B 测试 1：路径遍历拒绝（含 %2e%2e 编码形态、反斜杠、绝对前缀）。
    #[test]
    fn traversal_rejected() {
        let root = make_root("traversal");
        let outside = root.parent().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.js"), b"secret").unwrap();

        assert!(matches!(resolve_asset(&root, "hello/entry.js"), ResolveOutcome::Found(_)));
        assert!(matches!(resolve_asset(&root, "plugins.json"), ResolveOutcome::Found(_)));
        assert!(matches!(resolve_asset(&root, "../outside/secret.js"), ResolveOutcome::Forbidden));
        assert!(matches!(resolve_asset(&root, "hello/../../outside/secret.js"), ResolveOutcome::Forbidden));
        assert!(matches!(resolve_asset(&root, "%2e%2e/outside/secret.js"), ResolveOutcome::Forbidden));
        assert!(matches!(resolve_asset(&root, "hello/%2e%2e/outside/secret.js"), ResolveOutcome::Forbidden));
        assert!(matches!(resolve_asset(&root, "hello\\..\\outside\\secret.js"), ResolveOutcome::Forbidden));
        assert!(matches!(resolve_asset(&root, "hello//entry.js"), ResolveOutcome::Forbidden));
        assert!(matches!(resolve_asset(&root, "c:/windows/win.ini"), ResolveOutcome::Forbidden));
        assert!(matches!(resolve_asset(&root, "hello/nope.js"), ResolveOutcome::Missing));
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// WO-S0B 测试 2：MIME 映射（含 .wasm 前瞻）。
    #[test]
    fn mime_mapping() {
        use std::path::Path;
        assert_eq!(plugin_mime(Path::new("hello/entry.js")), "application/javascript");
        assert_eq!(plugin_mime(Path::new("hello/entry.mjs")), "application/javascript");
        assert_eq!(plugin_mime(Path::new("hello/manifest.json")), "application/json");
        assert_eq!(plugin_mime(Path::new("hello/style.css")), "text/css");
        assert_eq!(plugin_mime(Path::new("hello/mod.wasm")), "application/wasm");
        assert_eq!(plugin_mime(Path::new("hello/icon.png")), "application/octet-stream");
        assert_eq!(plugin_mime(Path::new("hello/noext")), "application/octet-stream");
    }

    /// 目录索引：只列含 manifest.json 的子目录；scope 名（嵌套目录）支持；
    /// 无 manifest 的目录（如临时杂物）不出现。
    #[test]
    fn index_lists_manifest_dirs_only() {
        let root = make_root("index");
        std::fs::create_dir_all(root.join("junk")).unwrap();
        let dirs = list_plugin_dirs(&root);
        assert_eq!(dirs, vec!["hello".to_string(), "hologram/settings".to_string()]);
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// WO-S0B 测试 3（junction 逃逸，Windows）：根目录内的 junction 指向外部，
    /// canonicalize 前缀检查必须把逃逸路径判为 Forbidden。
    #[cfg(windows)]
    #[test]
    fn junction_escape_rejected() {
        use std::os::windows::process::CommandExt;
        let root = make_root("junction");
        let outside = root.parent().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.js"), b"secret").unwrap();
        let link = root.join("escape");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .creation_flags(crate::utils::HIDDEN_CONSOLE)
            .output()
            .expect("mklink /J 应可执行（junction 无需特权）");
        if !status.status.success() {
            // 沙箱环境可能禁止建 junction：跳过而非静默通过——显式打印原因。
            eprintln!("[plugin_assets] junction 创建失败，跳过逃逸测试: {status:?}");
            let _ = std::fs::remove_dir_all(root.parent().unwrap());
            return;
        }
        assert!(
            matches!(resolve_asset(&root, "escape/secret.js"), ResolveOutcome::Forbidden),
            "junction 逃逸必须被前缀检查拒绝"
        );
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// WO-S0B 测试 3（symlink 逃逸，Unix 对称面）。
    #[cfg(unix)]
    #[test]
    fn symlink_escape_rejected() {
        let root = make_root("symlink");
        let outside = root.parent().unwrap().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.js"), b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
        assert!(matches!(resolve_asset(&root, "escape/secret.js"), ResolveOutcome::Forbidden));
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// WO-S0B 测试 4（HTTP 端到端）：经真实 hyper 栈验证 200/MIME/CORS、
    /// 404 JSON、403 JSON（遍历）、405 JSON（非 GET）、目录索引。
    /// （webview 半边的 import 验证见 WO-S0B 验收 1-2/5——cargo tauri dev/build。）
    #[test]
    fn http_status_and_json_errors() {
        use std::io::{Read, Write};
        let root = make_root("http");

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            // 覆盖插件根目录到临时目录（仅本测试消费该 env）
            std::env::set_var("HOLOGRAM_PLUGINS_ROOT", &root);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let client = reqwest::Client::builder().build().unwrap();
            let shutdown = std::sync::atomic::AtomicBool::new(false);
            let server_handle =
                tokio::spawn(async move { crate::llm_proxy::serve_listener(&listener, client, &shutdown).await });

            let get = |path: &str| {
                format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nconnection: close\r\n\r\n")
            };
            let cases: Vec<(&str, u16, &str)> = vec![
                ("/plugins/", 200, "application/json"),
                ("/plugins/hello/entry.js", 200, "application/javascript"),
                ("/plugins/hello/missing.js", 404, "application/json"),
                ("/plugins/%2e%2e/outside/secret.js", 403, "application/json"),
                ("/plugins/hello/manifest.json", 200, "application/json"),
            ];
            for (path, want_status, want_mime) in cases {
                let mut probe = std::net::TcpStream::connect(addr).unwrap();
                probe.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
                probe.write_all(get(path).as_bytes()).unwrap();
                probe.flush().unwrap();
                let mut buf = String::new();
                let res = probe.read_to_string(&mut buf);
                assert!(res.is_ok(), "{path} 读取超时/失败: {res:?} 已收: {buf}");
                let lower = buf.to_ascii_lowercase();
                assert!(
                    buf.starts_with(&format!("HTTP/1.1 {want_status}")),
                    "{path} 期望 {want_status}: {buf}"
                );
                assert!(lower.contains(&format!("content-type: {want_mime}")), "{path} MIME: {buf}");
                assert!(lower.contains("access-control-allow-origin: *"), "{path} CORS: {buf}");
                if want_status >= 400 {
                    assert!(buf.contains("\"error\":"), "{path} 错误体必须是 JSON: {buf}");
                }
            }

            // 非 GET → 405 JSON
            let mut probe = std::net::TcpStream::connect(addr).unwrap();
            probe.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
            probe
                .write_all(format!("POST /plugins/hello/entry.js HTTP/1.1\r\nHost: {addr}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes())
                .unwrap();
            probe.flush().unwrap();
            let mut buf = String::new();
            probe.read_to_string(&mut buf).unwrap();
            assert!(buf.starts_with("HTTP/1.1 405"), "POST 插件路径应 405: {buf}");
            assert!(buf.contains("\"error\":\"method_not_allowed\""), "405 错误体: {buf}");

            // 索引内容：只列 manifest 目录
            let mut probe = std::net::TcpStream::connect(addr).unwrap();
            probe.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
            probe.write_all(get("/plugins/").as_bytes()).unwrap();
            probe.flush().unwrap();
            let mut buf = String::new();
            probe.read_to_string(&mut buf).unwrap();
            assert!(buf.contains("hello"), "索引应含 hello: {buf}");
            assert!(buf.contains("hologram/settings"), "索引应含 scope 目录: {buf}");

            server_handle.abort();
        });
        std::env::remove_var("HOLOGRAM_PLUGINS_ROOT");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}

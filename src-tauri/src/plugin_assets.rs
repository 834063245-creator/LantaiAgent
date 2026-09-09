// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 插件静态资源服务（WO-S0B 插件内核）——装载通道的正式实现。
//
// 背景：WO-S0A spike（2026-08-20）已证实 Tauri webview 能从
// http://127.0.0.1:14570 动态 import ES module；本模块把验证过的路由正式化：
//   GET /plugins/                → 插件目录索引（JSON 数组：含 manifest.json 的子目录）
//   GET /plugins/<id>/<相对路径>  → ~/.lantai/plugins/<id>/<相对路径> 静态文件
//   GET /plugins/plugins.json    → 启用态持久化文件（根目录下的普通文件，同一解析路径）
//   GET /composition/<固定文件名>  → ~/.lantai/composition/<固定文件名>（用户层 patch）
//   GET /composition/presets/    → preset 目录索引（JSON 数组：含 roster.patch.yml 的
//                                  presets/ 子目录，S4-0）
//   GET /composition/presets/<id>/<文件名> → preset 文件（组合本体 + 元数据）
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
use tauri::Manager;

/// 单文件读取上限——防无界读入内存（正式实现如需大资产再走流式）。
const MAX_PLUGIN_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// 插件根目录：用户主目录下 `.lantai/plugins/`。
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
    PathBuf::from(home).join(".lantai").join("plugins")
}

/// 内置插件根目录（P1d，first-party-hot-reload-plan）——第一方插件产物
/// （如渲染器插件的 dist-plugins/builtin/renderers）的磁盘回退源。
///
/// 解析优先级（缓存一次）：
///   1. `HOLOGRAM_BUILTIN_PLUGINS_ROOT` 环境变量（测试隔离 / 目录重定位）；
///   2. 打包态候选（main.rs 的 init_builtin_plugins_dir 注入缓存——探测
///      `resource_dir()/builtin` 与 tauri v2 越界资源实际落点
///      `resource_dir()/_up_/src-ui/dist-plugins/builtin`，命中才锁）；
///   3. 开发/测试兜底：仓库 `src-ui/dist-plugins/`（构建脚本产物，cargo test
///      或 dev 前置构建后可用；未构建时目录不存在 → 无内置插件 → 回退缺席）。
///
/// 返回 None = 未初始化且无解析源（索引不合并内置插件，行为退化为纯用户插件面）。
pub(crate) fn builtin_plugins_root() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("HOLOGRAM_BUILTIN_PLUGINS_ROOT") {
        if !custom.is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    let cached = BUILTIN_PLUGINS_DIR.get();
    if let Some(dir) = cached {
        return dir.clone();
    }
    // 兜底：仓库 dist-plugins（dev / cargo test —— 打包态由 init 注入缓存）
    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_dist = manifest_root.parent().map(|p| p.join("src-ui").join("dist-plugins"));
    if let Some(dir) = repo_dist {
        if dir.is_dir() {
            let _ = BUILTIN_PLUGINS_DIR.set(Some(dir.clone()));
            return Some(dir);
        }
    }
    None
}

/// 内置插件根目录缓存（OnceLock——进程生命期一次解析；main.rs 启动注入）。
static BUILTIN_PLUGINS_DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

/// main.rs 启动注入打包态内置插件根（tauri resource_dir 下的候选探测）。
/// 未打包（cargo test / 无 tauri 应用态）不调用——builtin_plugins_root 兜底
/// 仓库 dist-plugins。
///
/// 候选路径梯（多候选纪律——单一期望位置
/// 不可靠，tauri v2 对 crate 外资源的落点随 conf 形式而变）：
///   1. `resource_dir()/builtin` ——打包态期望落点（若 tauri.conf.json
///      resources 用 map 形式把 `dist-plugins/builtin` 重映射到 `builtin/`）；
///   2. `resource_dir()/_up_/src-ui/dist-plugins/builtin` ——tauri v2 对
///      crate 外资源（当前 conf 的 `"../src-ui/dist-plugins"` 目录 key）的
///      实际落点：`_up_` 是 bundler 对越界 `../` 路径的转义目录
///      （debug 与 release 实测一致落此）。⚠ map 形式的 glob key
///      （`**/*`）会压平目录只留文件名——曾把 31 个插件 manifest.json
///      压进同一目录打爆 MSI ICE30 校验（light 退出码 204），勿回退。
/// 命中即锁缓存；**全未命中不锁 None**——保留 builtin_plugins_root 的仓库
/// 兜底分支可走（早先实现遇 `resource_dir()/builtin` 缺席即 `set(None)`，
/// 把 OnceLock 钉死 None，令兜底分支沦为死代码——dev 下「重新加载全报错」
/// 的真根因：产物 manifest fetch 经 builtin_plugins_root → None → 无回退
/// → 404 → 23 个 feature 插件无一可重载）。
pub(crate) fn init_builtin_plugins_dir(app: &tauri::AppHandle) {
    let resource = app.path().resource_dir().ok();
    let candidates: [Option<PathBuf>; 2] = [
        resource.as_ref().map(|r| r.join("builtin")),
        resource
            .as_ref()
            .map(|r| r.join("_up_").join("src-ui").join("dist-plugins").join("builtin")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_dir() {
            let _ = BUILTIN_PLUGINS_DIR.set(Some(candidate));
            return;
        }
    }
    // 全未命中：不锁——builtin_plugins_root 走仓库兜底（dev/cargo test）
}

/// 组合 patch 根目录（S2-2）：用户主目录下 `.lantai/composition/`。
/// 用户层 roster.patch.yml 的通道根；`HOLOGRAM_COMPOSITION_ROOT` 环境变量
/// 可覆盖（镜像 HOLOGRAM_PLUGINS_ROOT 的测试隔离/重定位语义）。
/// S4-2 起 composition_watcher 复用同一根（单一事实源——经
/// composition_root_public 跨模块访问）。
pub(crate) fn composition_root() -> PathBuf {
    composition_root_public()
}

/// composition_root 的跨模块访问面（S4-2 watcher 消费）。
pub(crate) fn composition_root_public() -> PathBuf {
    if let Some(custom) = std::env::var_os("HOLOGRAM_COMPOSITION_ROOT") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".lantai").join("composition")
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
/// `.html`/`.htm` 是 app shell 件 A（S3）的窗内容入口——iframe 载体渲染
/// 需要 `text/html`（octet-stream 会被 webview 拒渲染）。
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
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("wasm") => "application/wasm",
        // 组合 patch 文件（S2-2）：loader 自行 parse 文本，无严格 MIME 消费方
        Some("yml") | Some("yaml") => "text/plain; charset=utf-8",
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
/// P1d：用户插件根未命中时，对内置插件路径回退内置根（first-party 产物）。
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
        ResolveOutcome::Found(path) => serve_file(&path).await,
        ResolveOutcome::Missing => {
            // P1d 回退：用户根缺失 → 试内置根（第一方产物随包携带）。
            // 用户根权限优先——用户装了同名内置插件（覆盖升级）时已在上面
            // Found 返回；此处只处理「用户根确实没有」的回退。
            // 2026-09-06：白名单（BUILTIN_PLUGIN_NAMES）删除——内置根只装第一方
            // 产物，「用户同名目录优先」由先查用户根保证，无需名字清单预筛；
            // 文件在内置根本不存在时 resolve_asset 自然 Missing → 404。
            if let Some(builtin_root) = builtin_plugins_root() {
                match resolve_asset(&builtin_root, url_path) {
                    ResolveOutcome::Forbidden | ResolveOutcome::Missing => {
                        return json_error(StatusCode::NOT_FOUND, "not_found", "插件资产不存在");
                    }
                    ResolveOutcome::Found(path) => return serve_file(&path).await,
                }
            }
            json_error(StatusCode::NOT_FOUND, "not_found", "插件资产不存在")
        }
    }
}

/// 读取并响应一个已解析的插件资产文件（spawn_blocking + 尺寸护栏 + MIME）。
async fn serve_file(path: &std::path::Path) -> Response<BoxBody> {
    let mime = plugin_mime(path);
    let path_owned = path.to_path_buf();
    let read = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, AssetReadError> {
        let meta = std::fs::metadata(&path_owned).map_err(AssetReadError::Io)?;
        if !meta.is_file() {
            return Err(AssetReadError::NotAFile);
        }
        if meta.len() > MAX_PLUGIN_FILE_BYTES {
            return Err(AssetReadError::TooLarge);
        }
        std::fs::read(&path_owned).map_err(AssetReadError::Io)
    })
    .await;
    match read {
        Ok(Ok(bytes)) => asset_response(StatusCode::OK, mime, Bytes::from(bytes)),
        Ok(Err(AssetReadError::NotAFile)) => json_error(StatusCode::NOT_FOUND, "not_found", "不是常规文件"),
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

/// 非 GET 的 /plugins/* → 405（JSON 错误体，CORS 头齐全）。
pub(crate) fn method_not_allowed() -> Response<BoxBody> {
    json_error(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "插件资产通道仅支持 GET")
}

/// 组合 patch 路由主入口（S2-2，GET /composition/<path>）。
/// 与插件通道同一套安全件（resolve_asset 遍历拒绝 + canonicalize 前缀 +
/// 32MB 上限 + 错误 JSON 形状）。通道语义（S4-0 扩充）：
///   - 根级固定文件：roster.patch.yml 等用户层 patch 文件；
///   - presets/ 路径：preset 文件（presets/<id>/roster.patch.yml 等）与
///     preset 目录索引（GET /composition/presets/ → JSON 数组，S4-0）。
/// 根级空路径 404（根级无索引）；presets/ 空 = 索引入口。
/// 文件 IO 走 spawn_blocking。
pub(crate) async fn serve_composition_path(url_path: &str) -> Response<BoxBody> {
    if url_path.is_empty() {
        return json_error(StatusCode::NOT_FOUND, "not_found", "组合 patch 路径为空");
    }
    // preset 索引入口（GET /composition/presets/ → 目录索引）。
    // 注意：此处收到的 url_path 已剥去前导 "/composition/"——索引请求
    // 的完整路径是 "/composition/presets/"，剥前缀后剩 "presets/"。
    if url_path == "presets/" || url_path == "presets" {
        return serve_preset_index().await;
    }
    let root = composition_root();
    match resolve_asset(&root, url_path) {
        ResolveOutcome::Forbidden => {
            json_error(StatusCode::FORBIDDEN, "forbidden", "路径遍历或非法路径被拒绝")
        }
        ResolveOutcome::Missing => json_error(StatusCode::NOT_FOUND, "not_found", "组合 patch 不存在"),
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
                    json_error(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "组合 patch 超过 32MB 上限")
                }
                Ok(Err(AssetReadError::Io(e))) => {
                    eprintln!("[plugin_assets] 组合 patch 读取失败: {e}");
                    json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "组合 patch 读取失败")
                }
                Err(join_err) => {
                    eprintln!("[plugin_assets] 组合 patch 读取任务失败: {join_err}");
                    json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "组合 patch 读取任务失败")
                }
            }
        }
    }
}

/// 目录索引：含 manifest.json 的子目录相对路径（`/` 分隔，排序稳定）。
/// 名字可含一段斜杠（npm scope 风格，如 hologram/settings 对应嵌套目录），深度 ≤2。
/// P1d：内置根（builtin_plugins_root）合并进索引——loader 发现第一方产物；
/// 用户根同目录时用户优先（去重，内置目录不覆盖用户同名目录）。
async fn serve_index() -> Response<BoxBody> {
    let root = plugins_root();
    let listed = tokio::task::spawn_blocking(move || list_plugin_dirs(&root)).await;
    let mut dirs = match listed {
        Ok(dirs) => dirs,
        Err(join_err) => {
            eprintln!("[plugin_assets] 插件索引扫描任务失败: {join_err}");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "插件索引扫描失败");
        }
    };
    // 内置根合并（去重：用户同名目录优先——用户覆盖升级不被内置目录挤掉）
    if let Some(builtin_root) = builtin_plugins_root() {
        let extra = tokio::task::spawn_blocking(move || list_plugin_dirs(&builtin_root)).await;
        if let Ok(builtin_dirs) = extra {
            for d in builtin_dirs {
                if !dirs.iter().any(|x| x == &d) {
                    dirs.push(d);
                }
            }
            dirs.sort();
        }
    }
    let body = serde_json::to_string(&dirs).unwrap_or_else(|e| {
        eprintln!("[plugin_assets] 索引序列化失败: {e}");
        "[]".to_string()
    });
    asset_response(StatusCode::OK, "application/json", Bytes::from(body))
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

/// preset 目录索引（S4-0）：composition 根下 presets/ 内含 roster.patch.yml
/// 的子目录 id 列表（JSON 数组，排序稳定）。镜像插件索引完整做法
/// （serve_index + 纯函数 + spawn_blocking + 错误 JSON 分支）——preset
/// 合法性过滤（含 roster.patch.yml 才入列）与插件「含 manifest.json 才入列」
/// 同款纪律。preset 子目录只取一层（id 是单段，PRESET_ID 围栏在 TS 侧把关）。
async fn serve_preset_index() -> Response<BoxBody> {
    let root = composition_root().join("presets");
    let listed = tokio::task::spawn_blocking(move || list_preset_dirs(&root)).await;
    match listed {
        Ok(dirs) => {
            let body = serde_json::to_string(&dirs).unwrap_or_else(|e| {
                eprintln!("[plugin_assets] preset 索引序列化失败: {e}");
                "[]".to_string()
            });
            asset_response(StatusCode::OK, "application/json", Bytes::from(body))
        }
        Err(join_err) => {
            eprintln!("[plugin_assets] preset 索引扫描任务失败: {join_err}");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal", "preset 索引扫描失败")
        }
    }
}

/// 纯函数：列出 presets/ 根下含 roster.patch.yml 的一层子目录名。
/// 目录不存在 = 空列表（无用户 preset 是常态，非错误）。
fn list_preset_dirs(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !root.is_dir() {
        return out;
    }
    for entry in walkdir::WalkDir::new(root).max_depth(1).min_depth(1) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_dir() {
            continue;
        }
        if !entry.path().join("roster.patch.yml").is_file() {
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

/// HOLOGRAM_PLUGINS_ROOT 测试锁（S4-3）：env 变量进程级——设置它的测试
/// （本模块 HTTP e2e + commands/plugin_install 的安装测试）必须串行，
/// 否则并行 clobber 会让对方的 plugins_root() 解析到错误根（间歇红）。
#[cfg(test)]
pub(crate) static PLUGINS_ROOT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        // app shell 件 A（S3）：窗内容入口是插件目录深处的 .html——深路径照常
        // 解析（同一 canonicalize 围栏，无深度特判）。
        std::fs::create_dir_all(root.join("hello").join("app")).unwrap();
        std::fs::write(root.join("hello").join("app").join("index.html"), b"<!doctype html>").unwrap();
        assert!(matches!(resolve_asset(&root, "hello/app/index.html"), ResolveOutcome::Found(_)));
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

    /// WO-S0B 测试 2：MIME 映射（含 .wasm 前瞻；.html 是 app shell 件 A 的
    /// 窗内容入口——iframe 载体渲染必需）。
    #[test]
    fn mime_mapping() {
        use std::path::Path;
        assert_eq!(plugin_mime(Path::new("hello/entry.js")), "application/javascript");
        assert_eq!(plugin_mime(Path::new("hello/entry.mjs")), "application/javascript");
        assert_eq!(plugin_mime(Path::new("hello/manifest.json")), "application/json");
        assert_eq!(plugin_mime(Path::new("hello/style.css")), "text/css");
        assert_eq!(plugin_mime(Path::new("hello/app/index.html")), "text/html; charset=utf-8");
        assert_eq!(plugin_mime(Path::new("hello/old.HTM")), "text/html; charset=utf-8");
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
        // S4-3：持 PLUGINS_ROOT 锁（plugin_install 的安装测试同锁串行——
        // env 变量进程级，并行 clobber 会间歇红）
        let _env_lock = super::PLUGINS_ROOT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

    // ── S4-0 preset 索引路由 ──
    // 注意：HTTP 端到端用例并入 composition_http_end_to_end（env 变量
    // HOLOGRAM_COMPOSITION_ROOT 只允许一个测试设置——并行测试会互相
    // clobber；此处只留纯函数测试）。

    /// S4-0 纯函数：preset 索引只列含 roster.patch.yml 的一层子目录；排序稳定；
    /// 无 roster.patch.yml 的目录（杂物）不出现；深层目录不出现。
    #[test]
    fn preset_index_lists_roster_dirs_only() {
        let root = make_composition_root("preset-index");
        // 杂物目录（无 roster.patch.yml）不入列
        std::fs::create_dir_all(root.join("presets").join("junk")).unwrap();
        let dirs = list_preset_dirs(&root.join("presets"));
        assert_eq!(dirs, vec!["focus".to_string(), "paper".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// S4-0 纯函数：presets/ 目录不存在 = 空列表（无用户 preset 是常态）。
    #[test]
    fn preset_index_empty_when_no_dir() {
        let tmp = std::env::temp_dir().join(format!("hologram_preset_empty_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(list_preset_dirs(&tmp).is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── S2-2 组合 patch 通道 ──

    fn make_composition_root(tag: &str) -> std::path::PathBuf {
        let tmp =
            std::env::temp_dir().join(format!("hologram_composition_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("roster.patch.yml"), b"tools:\n  - id: builtin/shell\n    disabled: true\n").unwrap();
        // S4-0：preset 子目录（paper 含本体+元数据；focus 只含本体；
        // junk 无本体不入索引）
        std::fs::create_dir_all(tmp.join("presets").join("paper")).unwrap();
        std::fs::create_dir_all(tmp.join("presets").join("focus")).unwrap();
        std::fs::create_dir_all(tmp.join("presets").join("junk")).unwrap();
        std::fs::write(
            tmp.join("presets").join("paper").join("roster.patch.yml"),
            b"tools:\n  - id: builtin/web\n    disabled: true\n",
        )
        .unwrap();
        std::fs::write(tmp.join("presets").join("paper").join("preset.yml"), b"name: paper\n").unwrap();
        std::fs::write(
            tmp.join("presets").join("focus").join("roster.patch.yml"),
            b"capabilities:\n  - id: auto-tune\n    disabled: true\n",
        )
        .unwrap();
        tmp
    }

    /// S2-2 语义：composition 根解析 + 遍历拒绝（含编码形态）+ yml MIME。
    #[test]
    fn composition_route_semantics() {
        let root = make_composition_root("semantics");
        assert!(matches!(resolve_asset(&root, "roster.patch.yml"), ResolveOutcome::Found(_)));
        assert!(matches!(resolve_asset(&root, "missing.yml"), ResolveOutcome::Missing));
        assert!(matches!(resolve_asset(&root, "../escape.yml"), ResolveOutcome::Forbidden));
        assert!(matches!(resolve_asset(&root, "%2e%2e/escape.yml"), ResolveOutcome::Forbidden));
        assert!(matches!(resolve_asset(&root, "roster.patch.yml/.."), ResolveOutcome::Forbidden));
        assert_eq!(
            plugin_mime(std::path::Path::new("c/roster.patch.yml")),
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            plugin_mime(std::path::Path::new("c/roster.patch.yaml")),
            "text/plain; charset=utf-8"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// S2-2 HTTP 端到端：/composition/* 经真实 hyper 栈（200+MIME / 404 /
    /// 403 遍历 / 空路径 404 / 非 GET 405）。
    #[test]
    fn composition_http_end_to_end() {
        use std::io::{Read, Write};
        let root = make_composition_root("http");

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            std::env::set_var("HOLOGRAM_COMPOSITION_ROOT", &root);
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
                ("/composition/roster.patch.yml", 200, "text/plain; charset=utf-8"),
                ("/composition/missing.yml", 404, "application/json"),
                ("/composition/%2e%2e/escape.yml", 403, "application/json"),
                ("/composition/", 404, "application/json"),
                // S4-0 preset 域：索引（JSON 数组，含 paper/focus 不含 junk）
                ("/composition/presets/", 200, "application/json"),
                // 无尾斜杠同义（剥前缀后剩 "presets"）
                ("/composition/presets", 200, "application/json"),
                // 逐 preset 文件取用
                ("/composition/presets/paper/roster.patch.yml", 200, "text/plain; charset=utf-8"),
                ("/composition/presets/paper/preset.yml", 200, "text/plain; charset=utf-8"),
                // 未知 preset 文件 404
                ("/composition/presets/ghost/roster.patch.yml", 404, "application/json"),
                // 遍历拒绝（preset 路径攻击面——resolve_asset 逐段校验兜住）
                ("/composition/presets/%2e%2e/roster.patch.yml", 403, "application/json"),
            ];
            for (path, want_status, want_mime) in cases {
                let mut probe = std::net::TcpStream::connect(addr).unwrap();
                probe.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
                probe.write_all(get(path).as_bytes()).unwrap();
                probe.flush().unwrap();
                let mut buf = String::new();
                let res = probe.read_to_string(&mut buf);
                assert!(res.is_ok(), "{path} 读取超时/失败: {res:?} 已收: {buf}");
                assert!(
                    buf.starts_with(&format!("HTTP/1.1 {want_status}")),
                    "{path} 期望 {want_status}: {buf}"
                );
                let lower = buf.to_ascii_lowercase();
                assert!(lower.contains(&format!("content-type: {want_mime}")), "{path} MIME: {buf}");
                if want_status >= 400 {
                    assert!(buf.contains("\"error\":"), "{path} 错误体必须是 JSON: {buf}");
                }
            }

            // 非 GET → 405 JSON（与插件通道同款纪律）
            let mut probe = std::net::TcpStream::connect(addr).unwrap();
            probe.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
            probe
                .write_all(
                    format!("POST /composition/roster.patch.yml HTTP/1.1\r\nHost: {addr}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes(),
                )
                .unwrap();
            probe.flush().unwrap();
            let mut buf = String::new();
            probe.read_to_string(&mut buf).unwrap();
            assert!(buf.starts_with("HTTP/1.1 405"), "POST 组合路径应 405: {buf}");

            // S4-0：preset 索引内容断言——只列含 roster.patch.yml 的目录
            let mut probe = std::net::TcpStream::connect(addr).unwrap();
            probe.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
            probe.write_all(get("/composition/presets/").as_bytes()).unwrap();
            probe.flush().unwrap();
            let mut buf = String::new();
            probe.read_to_string(&mut buf).unwrap();
            assert!(buf.contains("focus"), "preset 索引应含 focus: {buf}");
            assert!(buf.contains("paper"), "preset 索引应含 paper: {buf}");
            assert!(!buf.contains("junk"), "preset 索引不应含 junk: {buf}");

            server_handle.abort();
        });
        std::env::remove_var("HOLOGRAM_COMPOSITION_ROOT");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── P1d 内置插件回退（first-party-hot-reload-plan；2026-09-06 白名单消灭
    // ── 用户根缺失无条件回退内置根——名单真源 = src-ui 名册，Rust 不再持有）──

    /// P1d e2e：用户根缺失的内置插件路径 → 回退 HOLOGRAM_BUILTIN_PLUGINS_ROOT
    /// 提供 manifest/entry（200 + 正确 MIME）；内置根也无 → 404。
    /// 同时验证索引合并（内置根目录出现在 /plugins/ 索引）。
    #[test]
    fn builtin_plugin_fallback_end_to_end() {
        use std::io::{Read, Write};
        let _env_lock = super::PLUGINS_ROOT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let user_root = make_root("p1d_user");
        // 内置根：独立临时目录，含渲染器插件（manifest + entry）
        let builtin_tmp =
            std::env::temp_dir().join(format!("hologram_plugin_assets_builtin_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&builtin_tmp);
        let builtin_root = builtin_tmp.join("builtin");
        std::fs::create_dir_all(builtin_root.join("hologram").join("renderers")).unwrap();
        std::fs::write(
            builtin_root.join("hologram").join("renderers").join("manifest.json"),
            br#"{"name":"hologram/renderers","version":"1.0.0","entry":"entry.js"}"#,
        )
        .unwrap();
        std::fs::write(
            builtin_root.join("hologram").join("renderers").join("entry.js"),
            b"export const renderers = 1",
        )
        .unwrap();

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            std::env::set_var("HOLOGRAM_PLUGINS_ROOT", &user_root);
            std::env::set_var("HOLOGRAM_BUILTIN_PLUGINS_ROOT", &builtin_root);
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
                // 用户根没有渲染器 → 回退内置根（manifest JSON）
                ("/plugins/hologram/renderers/manifest.json", 200, "application/json"),
                // 回退 entry（JS MIME）
                ("/plugins/hologram/renderers/entry.js", 200, "application/javascript"),
                // 白名单消灭后（2026-09-06）：任意路径用户根缺失都试内置根，
                // 内置根也无该文件（ghost）→ 404（与白名单时代终态等价）
                ("/plugins/ghost/entry.js", 404, "application/json"),
                // 遍历防护在内置根同样生效
                ("/plugins/hologram/renderers/../../outside.js", 403, "application/json"),
            ];
            for (path, want_status, want_mime) in cases {
                let mut probe = std::net::TcpStream::connect(addr).unwrap();
                probe.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
                probe.write_all(get(path).as_bytes()).unwrap();
                probe.flush().unwrap();
                let mut buf = String::new();
                let res = probe.read_to_string(&mut buf);
                assert!(res.is_ok(), "{path} 读取超时/失败: {res:?} 已收: {buf}");
                assert!(
                    buf.starts_with(&format!("HTTP/1.1 {want_status}")),
                    "{path} 期望 {want_status}: {buf}"
                );
                let lower = buf.to_ascii_lowercase();
                assert!(lower.contains(&format!("content-type: {want_mime}")), "{path} MIME: {buf}");
            }

            // 索引合并：内置渲染器插件出现在 /plugins/ 索引
            let mut probe = std::net::TcpStream::connect(addr).unwrap();
            probe.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
            probe.write_all(get("/plugins/").as_bytes()).unwrap();
            probe.flush().unwrap();
            let mut buf = String::new();
            probe.read_to_string(&mut buf).unwrap();
            assert!(buf.contains("hologram/renderers"), "索引应含内置渲染器: {buf}");

            server_handle.abort();
        });
        std::env::remove_var("HOLOGRAM_PLUGINS_ROOT");
        std::env::remove_var("HOLOGRAM_BUILTIN_PLUGINS_ROOT");
        let _ = std::fs::remove_dir_all(user_root.parent().unwrap());
        let _ = std::fs::remove_dir_all(&builtin_tmp);
    }

    /// 用户同名目录优先：用户根有渲染器目录时，内置回退不覆盖（用户即权威）。
    #[test]
    fn user_plugin_dir_wins_over_builtin() {
        use std::io::{Read, Write};
        let _env_lock = super::PLUGINS_ROOT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let user_root = make_root("p1d_userwin");
        // 用户根放渲染器（覆盖升级场景）
        std::fs::create_dir_all(user_root.join("hologram").join("renderers")).unwrap();
        std::fs::write(
            user_root.join("hologram").join("renderers").join("manifest.json"),
            br#"{"name":"hologram/renderers","version":"9.9.9","entry":"entry.js"}"#,
        )
        .unwrap();
        let builtin_tmp =
            std::env::temp_dir().join(format!("hologram_plugin_assets_builtin_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&builtin_tmp);
        std::fs::create_dir_all(builtin_tmp.join("hologram").join("renderers")).unwrap();
        std::fs::write(
            builtin_tmp.join("hologram").join("renderers").join("manifest.json"),
            br#"{"name":"hologram/renderers","version":"1.0.0","entry":"entry.js"}"#,
        )
        .unwrap();

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            std::env::set_var("HOLOGRAM_PLUGINS_ROOT", &user_root);
            std::env::set_var("HOLOGRAM_BUILTIN_PLUGINS_ROOT", &builtin_tmp);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let client = reqwest::Client::builder().build().unwrap();
            let shutdown = std::sync::atomic::AtomicBool::new(false);
            let server_handle =
                tokio::spawn(async move { crate::llm_proxy::serve_listener(&listener, client, &shutdown).await });

            let get = |path: &str| {
                format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nconnection: close\r\n\r\n")
            };
            let mut probe = std::net::TcpStream::connect(addr).unwrap();
            probe.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
            probe.write_all(get("/plugins/hologram/renderers/manifest.json").as_bytes()).unwrap();
            probe.flush().unwrap();
            let mut buf = String::new();
            probe.read_to_string(&mut buf).unwrap();
            assert!(buf.contains("9.9.9"), "用户目录应优先（版本 9.9.9）: {buf}");

            server_handle.abort();
        });
        std::env::remove_var("HOLOGRAM_PLUGINS_ROOT");
        std::env::remove_var("HOLOGRAM_BUILTIN_PLUGINS_ROOT");
        let _ = std::fs::remove_dir_all(user_root.parent().unwrap());
        let _ = std::fs::remove_dir_all(&builtin_tmp);
    }
}

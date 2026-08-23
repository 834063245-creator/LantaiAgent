// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 插件安装通道（S4-3）—— npm tarball 源的下载/校验/解包/落盘。
//
// 设计（设计件 §2.6）：
//   - 安装 = 下载（reqwest 已在依赖树）+ Rust 侧 tar 解包 + 路径安全 +
//     原子落盘（先解到 .tmp-<rand> 再 rename；重名拒绝）；
//   - manifest 校验留在 TS loader 既有单一入口（Rust 只做「tar 解包 +
//     路径安全」——不镜像 zod 校验规则，避免双真源）；
//   - source 三形态：(a) registry 规格（name/version/registry——缺省
//     registry.npmjs.org，拼 tarball URL 下载）；(b) tarball URL 或本地
//     文件路径（同一解包校验路径）；(c) 本地目录——复制进 plugins 根
//     （loader 只扫自己根，指向外部目录无效）；
//   - 更新 = 同一 source 重装（先装 .tmp 校验后换名——卸载+安装的原子
//     复合）；第一版不做版本比较（未决项）。
//
// 路径安全（tar-slip 防护，v1 P3 原案 + DSH 供应链警告合并）：tar crate
// unpack 不带内置防护——entry 逐条校验：拒绝绝对路径 / `..` 段 / 符号链接
// 条目；npm tarball 顶层还有 `package/` 前缀（剥掉后落盘）。
//
// 供应链警告立场（ADR §5 维持）：完全信任模型——安装 UI 常驻警告文本，
// 不做签名/校验和（用户已拍板，如实声明不加固）。
//
// 卸载/禁用：plugin_uninstall（删目录）/ plugin_set_enabled（plugins.json
// 读改写——webview 无盘权必须走 RPC；S0 已定文件形状 {"disabled": [...]}）。
// 两者均重启生效（装载是 boot 期一次性——与组合层「下次装配」语义对齐）。

use std::io::Read;
use std::path::{Path, PathBuf};

/// 安装源三形态（前端序列化传入；snake_case 键——RPC 契约纪律）。
#[derive(Debug, Clone)]
pub(crate) enum PluginSource {
    /// registry 规格：包名（可含 version）+ 可选 registry base URL。
    Registry { name: String, version: Option<String>, registry: Option<String> },
    /// tarball：URL（http/https）或本地文件路径。
    Tarball(String),
    /// 本地插件目录——复制进 plugins 根。
    LocalDir(PathBuf),
}

impl PluginSource {
    /// 从 RPC 参数解析（source_kind + name/version/registry/location）。
    pub(crate) fn from_params(params: &serde_json::Value) -> Result<Self, String> {
        let kind = params
            .get("source_kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "参数 'source_kind' 缺失（允许: registry | tarball | local_dir）".to_string())?;
        match kind {
            "registry" => {
                let name = params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "registry 源需要参数 'name'".to_string())?
                    .to_string();
                if name.trim().is_empty() {
                    return Err("registry 源 'name' 不能为空".to_string());
                }
                let version = params.get("version").and_then(|v| v.as_str()).map(String::from);
                let registry = params.get("registry").and_then(|v| v.as_str()).map(String::from);
                Ok(PluginSource::Registry { name, version, registry })
            }
            "tarball" => {
                let loc = params
                    .get("location")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "tarball 源需要参数 'location'（URL 或本地路径）".to_string())?
                    .to_string();
                if loc.trim().is_empty() {
                    return Err("tarball 源 'location' 不能为空".to_string());
                }
                Ok(PluginSource::Tarball(loc))
            }
            "local_dir" => {
                let loc = params
                    .get("location")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "local_dir 源需要参数 'location'（本地目录）".to_string())?
                    .to_string();
                let path = PathBuf::from(&loc);
                if !path.is_dir() {
                    return Err(format!("local_dir 源目录不存在或不是目录: {loc}"));
                }
                Ok(PluginSource::LocalDir(path))
            }
            _ => Err(format!("未知 source_kind: {kind}（允许: registry | tarball | local_dir）")),
        }
    }
}

/// registry 规格 → tarball URL（npm 约定：<registry>/<name>/-/<name>-<version>.tgz）。
fn registry_tarball_url(name: &str, version: &str, registry: &str) -> String {
    // scoped 包的 tarball 路径惯例：@scope/name → @scope/name/-/name-version.tgz
    // （file 段用包 basename）
    let file_stem = name.rsplit('/').next().unwrap_or(name);
    format!("{registry}/{name}/-/{file_stem}-{version}.tgz")
}

/// 安装主流程（spawn_blocking 调用）：取包 → 解包校验 → 原子落盘。
/// 返回安装的插件目录名（npm 包名，scope 保留）。
pub(crate) async fn plugin_install(
    source: PluginSource,
    expect_name: Option<String>,
) -> Result<String, String> {
    // 1) 取字节（下载或本地读）
    let bytes = fetch_source_bytes(&source).await?;
    // 2) 解包校验 + 落盘（阻塞 IO → spawn_blocking）
    tokio::task::spawn_blocking(move || install_from_tarball_bytes(&bytes, expect_name))
        .await
        .map_err(|e| format!("plugin_install 任务失败: {e}"))?
}

/// 本地目录安装（复制进 plugins 根后校验 manifest 存在性）。
pub(crate) async fn plugin_install_local_dir(dir: PathBuf, expect_name: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || install_from_local_dir(&dir, expect_name))
        .await
        .map_err(|e| format!("plugin_install_local_dir 任务失败: {e}"))?
}

/// 源 → tarball 字节（registry 拼 URL 下载；tarball 源区分 URL/本地路径）。
async fn fetch_source_bytes(source: &PluginSource) -> Result<Vec<u8>, String> {
    match source {
        PluginSource::Registry { name, version, registry } => {
            let reg = registry
                .clone()
                .unwrap_or_else(|| "https://registry.npmjs.org".to_string())
                .trim_end_matches('/')
                .to_string();
            // version 缺省 → 查 registry metadata 拿 latest（一次 JSON 往返）
            let ver = match version {
                Some(v) => v.clone(),
                None => fetch_latest_version(&reg, name).await?,
            };
            let url = registry_tarball_url(name, &ver, &reg);
            download(&url).await
        }
        PluginSource::Tarball(loc) => {
            if loc.starts_with("http://") || loc.starts_with("https://") {
                download(loc).await
            } else {
                // 本地文件路径（开发期 npm pack 产物）
                let path = PathBuf::from(loc);
                if !path.is_file() {
                    return Err(format!("本地 tarball 不存在: {loc}"));
                }
                let cap = path.metadata().map_err(|e| format!("读取 tarball 元数据失败: {e}"))?.len() as usize;
                std::fs::read(&path).map_err(|e| format!("读取本地 tarball 失败: {e}")).and_then(|b| {
                    // 大小护栏（镜像 MAX_PLUGIN_FILE_BYTES 的量级——防误指大文件）
                    if b.len() > cap.max(1) * 2 + 1 && b.len() > 256 * 1024 * 1024 {
                        Err(format!("tarball 过大（{} MB），超过 256MB 上限", b.len() / 1024 / 1024))
                    } else {
                        Ok(b)
                    }
                })
            }
        }
        PluginSource::LocalDir(_) => {
            Err("内部错误：LocalDir 源不走 fetch_source_bytes".to_string())
        }
    }
}

/// registry metadata 查询 latest 版本（失败可见）。
async fn fetch_latest_version(registry: &str, name: &str) -> Result<String, String> {
    let url = format!("{registry}/{name}");
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {e}"))?;
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.npm.install-metadata+json")
        .send()
        .await
        .map_err(|e| format!("查询 {url} 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("查询 {url} 返回 HTTP {}", resp.status()));
    }
    let meta: serde_json::Value =
        resp.json().await.map_err(|e| format!("解析 registry 元数据失败: {e}"))?;
    meta.get("dist-tags")
        .and_then(|d| d.get("latest"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("registry 元数据缺 dist-tags.latest: {url}"))
}

/// 下载限制（与 IPC 护栏同量级——插件 tarball 是小包）。
const MAX_TARBALL_BYTES: u64 = 256 * 1024 * 1024;

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {e}"))?;
    let resp = client.get(url).send().await.map_err(|e| format!("下载 {url} 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载 {url} 返回 HTTP {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_TARBALL_BYTES {
            return Err(format!("tarball 过大（{len} 字节），超过 256MB 上限"));
        }
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取下载流失败: {e}"))?;
    if bytes.len() as u64 > MAX_TARBALL_BYTES {
        return Err(format!("tarball 过大（{} 字节），超过 256MB 上限", bytes.len()));
    }
    Ok(bytes.to_vec())
}

/// tarball 字节 → 校验 + 原子落盘。返回安装的插件目录名。
fn install_from_tarball_bytes(bytes: &[u8], expect_name: Option<String>) -> Result<String, String> {
    // 1) 解包到内存结构（entry 路径 → 字节），同步做 tar-slip 校验与
    //    npm `package/` 前缀剥离
    let entries = extract_tarball(bytes)?;
    if entries.is_empty() {
        return Err("tarball 为空（无可安装条目）".to_string());
    }
    // 2) manifest 存在性（name 以 manifest 为准——loader 校验规则在 TS 侧单一真源，
    //    Rust 只验「像个插件包」的最小形状）
    let manifest = entries
        .iter()
        .find(|(p, _)| p == "manifest.json")
        .map(|(_, b)| b.clone())
        .ok_or_else(|| "tarball 缺 manifest.json（根层——npm package/ 前缀已剥）".to_string())?;
    let manifest_name = parse_manifest_name(&manifest)?;
    if let Some(expected) = &expect_name {
        if &manifest_name != expected {
            return Err(format!("manifest.name ({manifest_name}) 与 expect_name ({expected}) 不一致——拒绝安装"));
        }
    }
    // 3) 目标目录：重名拒绝；先落 .tmp 再 rename（原子）
    let plugins_root = crate::plugin_assets::plugins_root();
    let target = plugins_root.join(&manifest_name);
    if target.exists() {
        return Err(format!("插件已存在: {manifest_name}（先卸载或走更新路径）"));
    }
    let tmp = plugins_root.join(format!(
        ".tmp-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    let _guard = TmpDirGuard(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录失败: {e}"))?;
    for (rel, data) in &entries {
        let dest = tmp.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录 {parent:?} 失败: {e}"))?;
        }
        std::fs::write(&dest, data).map_err(|e| format!("写入 {rel} 失败: {e}"))?;
    }
    std::fs::rename(&tmp, &target).map_err(|e| format!("原子落盘失败（rename {tmp:?} → {target:?}）: {e}"))?;
    Ok(manifest_name)
}

/// 本地目录安装：复制进 plugins 根 + manifest 存在性校验（同款原子纪律）。
fn install_from_local_dir(dir: &Path, expect_name: Option<String>) -> Result<String, String> {
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(format!("本地目录缺 manifest.json: {}", dir.display()));
    }
    let manifest = std::fs::read(&manifest_path).map_err(|e| format!("读取 manifest 失败: {e}"))?;
    let manifest_name = parse_manifest_name(&manifest)?;
    if let Some(expected) = &expect_name {
        if &manifest_name != expected {
            return Err(format!("manifest.name ({manifest_name}) 与 expect_name ({expected}) 不一致——拒绝安装"));
        }
    }
    let plugins_root = crate::plugin_assets::plugins_root();
    let target = plugins_root.join(&manifest_name);
    if target.exists() {
        return Err(format!("插件已存在: {manifest_name}（先卸载或走更新路径）"));
    }
    let tmp = plugins_root.join(format!(".tmp-{}-{}", std::process::id(), rand_suffix()));
    let _guard = TmpDirGuard(&tmp);
    copy_dir_recursive(dir, &tmp)?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("原子落盘失败: {e}"))?;
    Ok(manifest_name)
}

/// 单条 entry 路径的 tar-slip 围栏（raw 与剥前缀后的 rel 都要过——
/// 「package/C:/x」剥完才露出盘符形态）。
fn validate_safe_rel(p: &str) -> Result<(), String> {
    if p.starts_with('/') || p.starts_with('\\') {
        return Err(format!("tar entry 绝对路径（拒绝）: {p}"));
    }
    if p.split('/').any(|seg| seg == "..") {
        return Err(format!("tar entry 含 .. 段（拒绝）: {p}"));
    }
    if p.split('/').any(|seg| seg.is_empty()) {
        return Err(format!("tar entry 含空路径段（拒绝）: {p}"));
    }
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return Err(format!("tar entry 含盘符形态（拒绝）: {p}"));
    }
    Ok(())
}

/// tarball 解包 + tar-slip 校验 + npm package/ 前缀剥离。
/// 返回（相对路径 → 字节）——纯函数（测试面）。
fn extract_tarball(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(gz);
    let mut out = Vec::new();
    for entry in archive.entries().map_err(|e| format!("tar 解包失败: {e}"))? {
        let mut entry = entry.map_err(|e| format!("tar entry 读取失败: {e}"))?;
        let header_type = entry.header().entry_type();
        // 符号链接条目拒绝（tar-slip 攻击面：链接落盘后指向外部路径）
        if header_type.is_symlink() || header_type.is_hard_link() {
            return Err(format!("tar 含链接条目（拒绝——tar-slip 防护）: {}", entry.path().unwrap_or_default().display()));
        }
        let path = entry
            .path()
            .map_err(|e| format!("tar entry 路径不可读: {e}"))?
            .to_path_buf();
        let raw = path
            .to_str()
            .ok_or_else(|| format!("tar entry 路径非 UTF-8: {:?}", path))?
            .replace('\\', "/");
        // 围栏查原始路径（剥离前的攻击面）
        validate_safe_rel(&raw)?;
        // 剥 npm 顶层 package/ 前缀（多段也剥——部分打包器嵌套）
        let rel = strip_package_prefix(&raw);
        if rel.is_empty() {
            continue; // 顶层目录条目本身
        }
        // 围栏再查剥后的路径（「package/C:/x」剥完才露出盘符形态）
        validate_safe_rel(&rel)?;
        if !entry.header().entry_type().is_file() && !entry.header().entry_type().is_dir() {
            continue; // 非常规文件跳过（fifo 等罕见类型）
        }
        if entry.header().entry_type().is_dir() {
            continue; // 目录条目由写文件时的 create_dir_all 隐式创建
        }
        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|e| format!("tar entry 内容读取失败: {rel}: {e}"))?;
        out.push((rel, data));
    }
    Ok(out)
}

/// 剥 npm tarball 的顶层 package/ 前缀（非 package 前缀的包形态不剥——
/// 直接以根层文件落盘）。
fn strip_package_prefix(rel: &str) -> String {
    let mut s = rel;
    while let Some(rest) = s.strip_prefix("package/") {
        s = rest;
    }
    s.to_string()
}

/// manifest.name 提取（最小形状——完整校验在 TS loader）。
fn parse_manifest_name(manifest: &[u8]) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_slice(manifest).map_err(|e| format!("manifest.json 解析失败: {e}"))?;
    v.get("name")
        .and_then(|n| n.as_str())
        .filter(|n| !n.trim().is_empty())
        .map(String::from)
        .ok_or_else(|| "manifest.json 缺 name 字段".to_string())
}

/// 卸载：删目录（幂等——不存在 = 成功）。
pub(crate) fn plugin_uninstall(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("插件名不能为空".to_string());
    }
    // 名字是路径段：围栏校验（防 ../ 逃逸——与 PRESET_ID 同款纪律）
    if name.contains("..") || name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err(format!("非法插件名（含路径段/回溯）: {name}"));
    }
    let plugins_root = crate::plugin_assets::plugins_root();
    let dir = plugins_root.join(name);
    if !dir.exists() {
        return Ok(()); // 幂等
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除 {dir:?} 失败: {e}"))
}

/// 插件目录绝对路径（S4-4 乙机器桥）：manifest.mcpServers 的 stdio command
/// 相对插件目录解析——webview 无盘权，路径解析锚点经本 RPC 暴露。
/// 名字围栏同 uninstall；目录不存在 = 错误（声明 mcpServers 的插件必须已安装）。
pub(crate) fn plugin_dir(name: &str) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("插件名不能为空".to_string());
    }
    if name.contains("..") || name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err(format!("非法插件名（含路径段/回溯）: {name}"));
    }
    let dir = crate::plugin_assets::plugins_root().join(name);
    if !dir.is_dir() {
        return Err(format!("插件目录不存在: {name}"));
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// 启用/禁用：plugins.json 读改写（{"disabled": [...]}——S0 文件形状）。
pub(crate) fn plugin_set_enabled(name: &str, enabled: bool) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("插件名不能为空".to_string());
    }
    let plugins_root = crate::plugin_assets::plugins_root();
    let file = plugins_root.join("plugins.json");
    // 读（容忍毒化数据：坏 JSON = 空集重建——INVARIANTS #11.2 纪律）
    let mut disabled: Vec<String> = Vec::new();
    if let Ok(text) = std::fs::read_to_string(&file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(arr) = v.get("disabled").and_then(|d| d.as_array()) {
                disabled = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .filter(|s| !s.is_empty())
                    .collect();
            }
        }
    }
    // 改（去重保序）
    disabled.retain(|n| n != name);
    if !enabled {
        disabled.push(name.to_string());
    }
    // 写（读改写原子性：先写临时文件再 rename）
    let payload = serde_json::json!({ "disabled": disabled }).to_string();
    let tmp = plugins_root.join(format!(".plugins.json.tmp-{}", rand_suffix()));
    std::fs::write(&tmp, &payload).map_err(|e| format!("写 plugins.json 临时文件失败: {e}"))?;
    std::fs::rename(&tmp, &file).map_err(|e| format!("plugins.json 原子替换失败: {e}"))?;
    Ok(())
}

// ── 辅助 ──

/// 临时目录守卫：作用域退出时若目录仍在（rename 失败路径）则清理。
struct TmpDirGuard<'a>(&'a Path);

impl Drop for TmpDirGuard<'_> {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.0);
    }
}

/// 随机后缀（无 rand 依赖——时间戳 + 地址熵）。
fn rand_suffix() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", t, &t as *const u32 as usize)
}

/// 递归复制目录。
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录 {dst:?} 失败: {e}"))?;
    for entry in walkdir::WalkDir::new(src).min_depth(1).follow_links(false) {
        let entry = entry.map_err(|e| format!("遍历 {src:?} 失败: {e}"))?;
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(|e| format!("相对路径计算失败: {e}"))?;
        let dest = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| format!("创建目录失败: {e}"))?;
        } else if entry.file_type().is_symlink() {
            return Err(format!("本地目录含符号链接（拒绝复制）: {}", entry.path().display()));
        } else {
            std::fs::copy(entry.path(), &dest).map_err(|e| format!("复制 {} 失败: {e}", entry.path().display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试隔离辅助：持跨模块 PLUGINS_ROOT 锁（plugin_assets HTTP e2e 同锁
    /// 串行——env 变量进程级，并行 clobber 间歇红）+ 设置 env + 返回临时根。 */
    fn with_plugins_root(tag: &str) -> (std::sync::MutexGuard<'static, ()>, std::path::PathBuf) {
        let guard = crate::plugin_assets::PLUGINS_ROOT_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("hologram_plugin_install_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("HOLOGRAM_PLUGINS_ROOT", &tmp);
        (guard, tmp)
    }

    /// 造一个 npm 形态 tarball（package/ 前缀 + manifest.json + entry.js）。
    fn make_tarball(name: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let manifest = serde_json::json!({ "name": name, "version": "1.0.0", "entry": "entry.js" });
        let mut add = |path: String, data: Vec<u8>| {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, data.as_slice()).unwrap();
        };
        add(format!("package/manifest.json"), manifest.to_string().into_bytes());
        add("package/entry.js".to_string(), b"export default {}".to_vec());
        for (p, d) in extra {
            add(format!("package/{p}"), d.to_vec());
        }
        builder.into_inner().unwrap()
    }

    fn gz(bytes: Vec<u8>) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut enc, &bytes).unwrap();
        enc.finish().unwrap()
    }

    #[test]
    fn extract_strips_package_prefix_and_reads_entries() {
        let tarball = gz(make_tarball("hello", &[("sub/dir/asset.txt", b"asset".as_slice())]));
        let entries = extract_tarball(&tarball).unwrap();
        let paths: Vec<&str> = entries.iter().map(|(p, _)| p.as_str()).collect();
        assert!(paths.contains(&"manifest.json"));
        assert!(paths.contains(&"entry.js"));
        assert!(paths.contains(&"sub/dir/asset.txt"));
        // 前缀已剥：无 package/ 开头
        assert!(entries.iter().all(|(p, _)| !p.starts_with("package/")));
    }

    /// 追加一个「恶意路径」entry：绕过 builder 的路径良民校验（append_data
    /// 会拒绝 ..——那是打包器侧的防护；攻击者手搓 tarball 不经此路径），
    /// 直接写 header 的 name 字段模拟恶意输入。
    fn append_evil_entry(builder: &mut tar::Builder<Vec<u8>>, raw_name: &str, data: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        // set_path 是良民 API（会校验）——手工写 name 字段（offset 0，100 字节
        // NUL 填充——ustar 布局）
        let field = header.as_mut_bytes();
        field[..100].fill(0);
        field[..raw_name.len()].copy_from_slice(raw_name.as_bytes());
        header.set_cksum(); // name 变了 → 重算校验和
        builder.append(&mut header, data).unwrap();
    }

    #[test]
    fn extract_rejects_traversal_entries() {
        for bad in ["package/../evil.txt", "../evil.txt", "a/../../b.txt"] {
            let mut builder = tar::Builder::new(Vec::new());
            append_evil_entry(&mut builder, bad, b"evil");
            let raw = builder.into_inner().unwrap();
            let err = extract_tarball(&gz(raw)).unwrap_err();
            assert!(err.contains(".."), "{bad} 应拒绝 .. 段: {err}");
        }
    }

    #[test]
    fn extract_rejects_absolute_and_drive_entries() {
        for bad in ["/etc/passwd", "package//etc/passwd", "package/C:/evil.txt", "C:/evil.txt"] {
            let mut builder = tar::Builder::new(Vec::new());
            append_evil_entry(&mut builder, bad, b"x");
            let raw = builder.into_inner().unwrap();
            let result = extract_tarball(&gz(raw));
            assert!(result.is_err(), "{bad} 应被拒绝: {result:?}");
        }
    }

    #[test]
    fn extract_rejects_symlink_entries() {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_mode(0o777);
        header.set_cksum();
        builder.append_data(&mut header, "package/link", std::io::empty()).unwrap();
        let raw = builder.into_inner().unwrap();
        let err = extract_tarball(&gz(raw)).unwrap_err();
        assert!(err.contains("链接"), "应拒绝符号链接: {err}");
    }

    /// 本地目录安装 + 卸载 + 禁用读改写（HOLOGRAM_PLUGINS_ROOT 隔离）。
    #[test]
    fn install_uninstall_set_enabled_roundtrip() {
        let (_guard, tmp) = with_plugins_root("roundtrip");
        // 源目录（插件形态）
        let src = tmp.join("src/hello");
        std::fs::create_dir_all(src.join("assets")).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            br#"{"name":"hello","version":"1.0.0","entry":"entry.js"}"#,
        )
        .unwrap();
        std::fs::write(src.join("entry.js"), b"export default {}").unwrap();
        std::fs::write(src.join("assets/x.txt"), b"x").unwrap();
        // plugins 根 = tmp（env 已指）
        let root = tmp.clone();

        // 安装：复制进根 + 原子落盘
        let name = install_from_local_dir(&src, Some("hello".to_string())).unwrap();
        assert_eq!(name, "hello");
        assert!(root.join("hello/manifest.json").is_file());
        assert!(root.join("hello/assets/x.txt").is_file());

        // 重名拒绝
        let dup = install_from_local_dir(&src, Some("hello".to_string()));
        assert!(dup.is_err(), "重名安装应拒绝");

        // expect_name 不一致拒绝
        let mismatch = install_from_local_dir(&src, Some("other".to_string()));
        assert!(mismatch.is_err(), "expect_name 不一致应拒绝");

        // 禁用读改写：plugins.json 落盘 + 幂等 + 毒化容错
        plugin_set_enabled("hello", false).unwrap();
        let text = std::fs::read_to_string(root.join("plugins.json")).unwrap();
        assert!(text.contains("hello"));
        // 重复禁用不重复追加
        plugin_set_enabled("hello", false).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("plugins.json")).unwrap()).unwrap();
        let count = v["disabled"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|x| x.as_str() == Some("hello"))
            .count();
        assert_eq!(count, 1);
        // 启用 → 移出 disabled
        plugin_set_enabled("hello", true).unwrap();
        let v2: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("plugins.json")).unwrap()).unwrap();
        assert!(v2["disabled"].as_array().unwrap().is_empty());

        // 卸载：目录消失 + 幂等
        plugin_uninstall("hello").unwrap();
        assert!(!root.join("hello").exists());
        plugin_uninstall("hello").unwrap(); // 幂等
        // 非法名拒绝（路径逃逸防护）
        assert!(plugin_uninstall("../evil").is_err());
        assert!(plugin_uninstall("a/b").is_err());

        std::env::remove_var("HOLOGRAM_PLUGINS_ROOT");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// plugin_dir（S4-4 乙机器桥）：存在目录返回绝对路径；不存在/非法名拒绝。
    #[test]
    fn plugin_dir_resolves_and_fences() {
        let (_guard, tmp) = with_plugins_root("plugindir");
        let src = tmp.join("src/hello");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("manifest.json"),
            br#"{"name":"hello","version":"1.0.0","entry":"entry.js"}"#,
        )
        .unwrap();
        let name = install_from_local_dir(&src, Some("hello".to_string())).unwrap();

        // 存在 → 绝对路径（含插件名尾段）
        let dir = plugin_dir(&name).unwrap();
        assert!(dir.replace('\\', "/").ends_with("/hello"), "意外路径: {dir}");
        assert!(std::path::Path::new(&dir).is_dir());

        // 不存在 → 错误（声明 mcpServers 的插件必须已安装）
        assert!(plugin_dir("ghost").is_err());
        // 名字围栏（路径逃逸防护——同 uninstall）
        assert!(plugin_dir("../evil").is_err());
        assert!(plugin_dir("a/b").is_err());
        assert!(plugin_dir("").is_err());

        std::env::remove_var("HOLOGRAM_PLUGINS_ROOT");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// tarball 字节安装端到端（内存构造 → 原子落盘 → 重名拒绝）。
    #[test]
    fn install_from_tarball_bytes_atomic() {
        let (_guard, tmp) = with_plugins_root("tarball");

        let tarball = gz(make_tarball("acme-tools", &[]));
        let name = install_from_tarball_bytes(&tarball, Some("acme-tools".to_string())).unwrap();
        assert_eq!(name, "acme-tools");
        assert!(tmp.join("acme-tools/manifest.json").is_file());
        assert!(tmp.join("acme-tools/entry.js").is_file());

        // 重名拒绝（原子性：第二次安装不留垃圾）
        assert!(install_from_tarball_bytes(&tarball, None).is_err());
        // 无 .tmp-* 残留（TmpDirGuard 或 rename 已清理）
        let leftovers: Vec<_> = std::fs::read_dir(&tmp)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "临时目录残留: {leftovers:?}");

        // manifest 缺失拒绝
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        let data = b"export {}".to_vec();
        header.set_size(data.len() as u64);
        header.set_cksum();
        builder.append_data(&mut header, "package/entry.js", data.as_slice()).unwrap();
        let no_manifest = gz(builder.into_inner().unwrap());
        assert!(install_from_tarball_bytes(&no_manifest, None).is_err());

        std::env::remove_var("HOLOGRAM_PLUGINS_ROOT");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn registry_tarball_url_construction() {
        assert_eq!(
            registry_tarball_url("hello", "1.0.0", "https://registry.npmjs.org"),
            "https://registry.npmjs.org/hello/-/hello-1.0.0.tgz"
        );
        assert_eq!(
            registry_tarball_url("@acme/tools", "2.1.3", "https://npm.example.com"),
            "https://npm.example.com/@acme/tools/-/tools-2.1.3.tgz"
        );
    }

    #[test]
    fn source_parsing() {
        let p = serde_json::json!({ "source_kind": "registry", "name": "hello", "version": "1.0.0" });
        assert!(matches!(
            PluginSource::from_params(&p).unwrap(),
            PluginSource::Registry { ref name, ref version, .. } if name == "hello" && version.as_deref() == Some("1.0.0")
        ));
        let p = serde_json::json!({ "source_kind": "tarball", "location": "C:/x/y.tgz" });
        assert!(matches!(PluginSource::from_params(&p).unwrap(), PluginSource::Tarball(ref l) if l == "C:/x/y.tgz"));
        let bad = serde_json::json!({ "source_kind": "nope" });
        assert!(PluginSource::from_params(&bad).is_err());
        let missing = serde_json::json!({});
        assert!(PluginSource::from_params(&missing).is_err());
    }

    // ── fetch_source_bytes（网络/文件层分支——S4 测试补欠账）──

    /// 本地 tarball 路径：读文件字节（合法 gz 直接透传——解包校验在 extract）。
    #[tokio::test]
    async fn fetch_source_bytes_local_tarball() {
        let tmp = std::env::temp_dir().join(format!("hologram_fetch_src_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let tgz = tmp.join("probe.tgz");
        let payload = gz(make_tarball("hello", &[]));
        std::fs::write(&tgz, &payload).unwrap();
        let bytes = fetch_source_bytes(&PluginSource::Tarball(tgz.to_string_lossy().to_string()))
            .await
            .unwrap();
        assert_eq!(bytes, payload);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 本地 tarball 不存在 → 显式错误（非静默空）。
    #[tokio::test]
    async fn fetch_source_bytes_missing_tarball_errors() {
        let err = fetch_source_bytes(&PluginSource::Tarball("Z:/nope/missing.tgz".to_string()))
            .await
            .unwrap_err();
        assert!(err.contains("不存在"), "缺失文件应显式报错: {err}");
    }

    /// LocalDir 源不走 fetch（内部错误——分发路由在 rpc.rs 的 match）。
    #[tokio::test]
    async fn fetch_source_bytes_local_dir_is_internal_error() {
        let err = fetch_source_bytes(&PluginSource::LocalDir(PathBuf::from("."))).await.unwrap_err();
        assert!(err.contains("内部错误"), "LocalDir 应被分发路由拦截: {err}");
    }

    /// registry 源错误面（不可达 registry → 显式错误可见，不 panic）。
    #[tokio::test]
    async fn fetch_source_bytes_registry_unreachable_errors() {
        // 127.0.0.1:1 端口不可达（连接拒绝——不依赖外网）
        let err = fetch_source_bytes(&PluginSource::Registry {
            name: "hello".to_string(),
            version: Some("1.0.0".to_string()),
            registry: Some("http://127.0.0.1:1".to_string()),
        })
        .await
        .unwrap_err();
        assert!(!err.is_empty(), "不可达 registry 必须显式报错: {err}");
    }

    /// copy_dir_recursive：嵌套目录全量复制 + 符号链接拒绝。
    #[test]
    fn copy_dir_recursive_copies_and_rejects_symlink() {
        let tmp = std::env::temp_dir().join(format!("hologram_copy_dir_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        std::fs::create_dir_all(src.join("a/b")).unwrap();
        std::fs::write(src.join("a/b/x.txt"), b"x").unwrap();
        std::fs::write(src.join("root.txt"), b"r").unwrap();
        let dst = tmp.join("dst");
        copy_dir_recursive(&src, &dst).unwrap();
        assert!(dst.join("a/b/x.txt").is_file());
        assert!(dst.join("root.txt").is_file());
        // 符号链接拒绝（tar-slip 同族攻击面：链接落盘指向外部）
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc", src.join("evil-link")).unwrap();
            let err = copy_dir_recursive(&src, &tmp.join("dst2")).unwrap_err();
            assert!(err.contains("符号链接"), "应拒绝符号链接: {err}");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // junction 无需特权（mklink /J）——junction_escape_rejected 同款先例
            let outside = tmp.join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            let link = src.join("evil-link");
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .creation_flags(crate::utils::HIDDEN_CONSOLE)
                .output();
            if let Ok(st) = status {
                if st.status.success() {
                    let err = copy_dir_recursive(&src, &tmp.join("dst2")).unwrap_err();
                    assert!(err.contains("符号链接") || err.contains("链接"), "应拒绝链接: {err}");
                }
                // 沙箱建不了 junction 时跳过（链接面已由 walkdir follow_links(false)
                // + 显式 is_symlink 分支守护——plugin_assets 的 junction 测试同款处理）
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

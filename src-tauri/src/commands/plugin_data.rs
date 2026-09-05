// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 插件数据目录（app shell 四件套 · 件 B，app-shell-software-plugin-plan §5-S1）
// —— manifest.dataDir 插件的专属数据地盘。
//
// 契约：
//   - 装载即分配：loader 对 manifest.dataDir === true 的插件调 plugin_data_ensure
//     （幂等 create_dir_all），返回 {path}——S2 受治进程 spawn 注入数据目录
//     路径的同一入口；
//   - 根锁死：全部操作锁在 <dataRoot>/<插件名>/ 内——名字围栏（npm scope
//     ≤2 段，空/./..、\、NUL、盘符全拒）+ rel 路径逐段围栏 + canonicalize
//     前缀双保险（junction 逃逸兜底，plugin_assets::resolve_asset 同款纪律；
//     前缀锚定插件目录而非数据根——指向他插件/根外的 junction 同拒）；
//   - 卸载整体回收（决策 2）：plugin_uninstall 钩子把数据目录整体挪进
//     <dataRoot>/.trash/（默认 .trash 安全网——「备份一个目录全家走」）。
//
// 信任模型（与安装通道一致）：已装插件是全信任区；围栏防的是路径拼装越界
// 与 junction 逃逸，不做插件间调用方绑定（桥面插件名是参数——同信任级；
// S3 的 iframe 窗口面才由宿主容器侧绑定插件身份）。
//
// 强制层定位：webview 无盘权 → 数据目录 I/O 必须 Rust（v3 决策「应用壳」
// 保留面）；路径闸属沙箱族安全件。非能力口——不进 Agent 工具面。

use std::path::PathBuf;

/// 单文件读写上限（防无界内存读入——镜像 MAX_PLUGIN_FILE_BYTES 量级）。
const MAX_PLUGIN_DATA_BYTES: u64 = 32 * 1024 * 1024;

/// 数据根：用户主目录 `.lantai/plugins-data/`（与代码安装根 `.lantai/plugins`
/// 分立——卸载删代码、数据走 .trash，互不牵连）。`HOLOGRAM_PLUGIN_DATA_ROOT`
/// 可覆盖（测试隔离/目录重定位，镜像 HOLOGRAM_PLUGINS_ROOT 语义）。
fn plugin_data_root() -> PathBuf {
    if let Some(custom) = std::env::var_os("HOLOGRAM_PLUGIN_DATA_ROOT") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".lantai").join("plugins-data")
}

/// 插件名围栏：npm scope 风格 ≤2 段，段非空且不为 . / ..；整名禁 \、NUL、
/// 盘符（安装通道同款——scope 名落嵌套目录）。
fn fence_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("插件名不能为空".to_string());
    }
    if name.contains('\\') || name.contains('\0') || name.contains(':') {
        return Err(format!("非法插件名（反斜杠/NUL/盘符）: {name}"));
    }
    let segs: Vec<&str> = name.split('/').collect();
    if segs.len() > 2 {
        return Err(format!("非法插件名（npm scope 风格上限两段）: {name}"));
    }
    for seg in segs {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(format!("非法插件名（空段/回溯段）: {name}"));
        }
    }
    Ok(())
}

/// rel 路径围栏：逐段非空且不为 . / ..（空 rel = 插件根本身，list 用）；
/// 整串禁 \、NUL、盘符形态、绝对前缀。
fn fence_rel(rel: &str) -> Result<(), String> {
    if rel.contains('\\') || rel.contains('\0') {
        return Err(format!("非法数据路径（反斜杠/NUL）: {rel}"));
    }
    if rel.starts_with('/') {
        return Err(format!("非法数据路径（绝对路径）: {rel}"));
    }
    if rel.len() >= 2 && rel.as_bytes()[1] == b':' {
        return Err(format!("非法数据路径（盘符形态）: {rel}"));
    }
    if !rel.is_empty() {
        for seg in rel.split('/') {
            if seg.is_empty() || seg == "." || seg == ".." {
                return Err(format!("非法数据路径（空段/回溯段）: {rel}"));
            }
        }
    }
    Ok(())
}

/// 解析 <dataRoot>/<名>/<rel> 并围栏。插件目录必须已存在（ensure 先行——
/// 未声明 dataDir 的插件调读写 = 显式错误，不静默给地盘）；最深已存在祖先
/// canonicalize 后必须仍在插件目录内（目标可为尚不存在的写入路径——祖先
/// 即安全边界，剩余段是纯字符拼接无逃逸面；跨插件/根外 junction 在此兜住）。
fn resolve_under_plugin(name: &str, rel: &str) -> Result<PathBuf, String> {
    fence_name(name)?;
    fence_rel(rel)?;
    let plugin_dir = plugin_data_root().join(name);
    if !plugin_dir.is_dir() {
        return Err(format!("数据目录未分配（manifest 未声明 dataDir 或 ensure 未跑）: {name}"));
    }
    let canon_plugin_dir = std::fs::canonicalize(&plugin_dir)
        .map_err(|e| format!("数据目录解析失败（{}）: {e}", plugin_dir.display()))?;
    let mut target = plugin_dir.clone();
    if !rel.is_empty() {
        for seg in rel.split('/') {
            target.push(seg);
        }
    }
    let mut ancestor = target.clone();
    while !ancestor.exists() {
        let Some(parent) = ancestor.parent().map(std::path::Path::to_path_buf) else {
            return Err(format!("路径无已存在祖先: {name}/{rel}"));
        };
        ancestor = parent;
    }
    let canon_ancestor = std::fs::canonicalize(&ancestor)
        .map_err(|e| format!("路径解析失败（{name}/{rel}）: {e}"))?;
    if !canon_ancestor.starts_with(&canon_plugin_dir) {
        return Err(format!("数据路径越界（拒绝——回溯/junction 逃逸）: {name}/{rel}"));
    }
    Ok(target)
}

/// 装载即分配（幂等）：create_dir_all <dataRoot>/<名>，返回 {path: 绝对路径}。
pub(crate) fn plugin_data_ensure(name: &str) -> Result<serde_json::Value, String> {
    fence_name(name)?;
    let dir = plugin_data_root().join(name);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("分配数据目录失败（{}）: {e}", dir.display()))?;
    Ok(serde_json::json!({ "path": dir.to_string_lossy() }))
}

/// 枚举（单层，目录在前名字序）：rel 缺省/空 = 插件根。
/// 返回 {entries: [{name, is_dir, size}]}。
pub(crate) fn plugin_data_list(name: &str, rel: &str) -> Result<serde_json::Value, String> {
    let dir = resolve_under_plugin(name, rel)?;
    if !dir.is_dir() {
        return Err(format!("数据路径不是目录: {name}/{rel}"));
    }
    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("枚举失败（{name}/{rel}）: {e}"))? {
        let entry = entry.map_err(|e| format!("枚举失败（{name}/{rel}）: {e}"))?;
        let ft = entry.file_type().map_err(|e| format!("枚举失败（{name}/{rel}）: {e}"))?;
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        entries.push((ft.is_dir(), entry.file_name().to_string_lossy().into_owned(), size));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let entries: Vec<serde_json::Value> = entries
        .into_iter()
        .map(|(is_dir, file_name, size)| {
            serde_json::json!({ "name": file_name, "is_dir": is_dir, "size": size })
        })
        .collect();
    Ok(serde_json::json!({ "entries": entries }))
}

/// 读文本（UTF-8 契约——二进制面未来走 base64 变体，fs_cap 同先例）。
pub(crate) fn plugin_data_read(name: &str, rel: &str) -> Result<String, String> {
    if rel.trim().is_empty() {
        return Err(format!("read 需要具体文件路径: {name}"));
    }
    let path = resolve_under_plugin(name, rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取失败（{name}/{rel}）: {e}"))?;
    if !meta.is_file() {
        return Err(format!("数据路径不是常规文件: {name}/{rel}"));
    }
    if meta.len() > MAX_PLUGIN_DATA_BYTES {
        return Err(format!("数据文件超过 32MB 上限（{} 字节）", meta.len()));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败（{name}/{rel}）: {e}"))
}

/// 原子写（父目录自动创建；utils::write_atomic 复用——tmp+rename 纪律）。
pub(crate) fn plugin_data_write(name: &str, rel: &str, content: &str) -> Result<(), String> {
    if rel.trim().is_empty() {
        return Err(format!("write 需要具体文件路径: {name}"));
    }
    if content.len() as u64 > MAX_PLUGIN_DATA_BYTES {
        return Err(format!("写入内容超过 32MB 上限（{} 字节）", content.len()));
    }
    let path = resolve_under_plugin(name, rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败（{name}/{rel}）: {e}"))?;
    }
    crate::utils::write_atomic(&path.to_string_lossy(), content)
        .map_err(|e| format!("写入失败（{name}/{rel}）: {e}"))
}

/// 删除（文件或目录树；幂等——不存在 = 成功）。插件根不可删（卸载回收走
/// .trash，不裸删）。
pub(crate) fn plugin_data_delete(name: &str, rel: &str) -> Result<(), String> {
    if rel.trim().is_empty() {
        return Err(format!("delete 需要具体路径（插件根的回收走卸载 .trash）: {name}"));
    }
    let path = resolve_under_plugin(name, rel)?;
    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("删除失败（{name}/{rel}）: {e}"))
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除失败（{name}/{rel}）: {e}"))
    } else {
        Ok(()) // 幂等
    }
}

/// 卸载整体回收（决策 2）：数据目录整体挪进 <dataRoot>/.trash/<名>。
/// trash 重名 → 秒级时间戳后缀（再撞 → 加纳秒段）；目录不存在 = no-op；
/// 失败由调用方降级为 warn（数据留在原位是安全方向——plugin_uninstall 不
/// 因回收失败阻断）。
pub(crate) fn recycle_on_uninstall(name: &str) -> Result<(), String> {
    fence_name(name)?;
    let root = plugin_data_root();
    let dir = root.join(name);
    if !dir.exists() {
        return Ok(());
    }
    let trash_root = root.join(".trash");
    std::fs::create_dir_all(&trash_root)
        .map_err(|e| format!("创建 .trash 失败（{}）: {e}", trash_root.display()))?;
    let mut dest = trash_root.join(name);
    if dest.exists() {
        let (secs, nanos) = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| (d.as_secs(), d.subsec_nanos()))
            .unwrap_or((0, 0));
        dest = trash_root.join(format!("{name}-{secs}"));
        if dest.exists() {
            dest = trash_root.join(format!("{name}-{secs}-{nanos}"));
        }
    }
    std::fs::rename(&dir, &dest)
        .map_err(|e| format!("数据目录回收失败（{} → {}）: {e}", dir.display(), dest.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HOLOGRAM_PLUGIN_DATA_ROOT 测试锁（env 变量进程级——本模块并行用例
    /// 串行防互相 clobber；plugin_install 的 with_plugins_root 同款纪律）。
    static PLUGIN_DATA_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_data_root(tag: &str) -> (std::sync::MutexGuard<'static, ()>, std::path::PathBuf) {
        let guard = PLUGIN_DATA_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("hologram_plugin_data_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("HOLOGRAM_PLUGIN_DATA_ROOT", &tmp);
        (guard, tmp)
    }

    fn cleanup(tmp: &std::path::Path) {
        std::env::remove_var("HOLOGRAM_PLUGIN_DATA_ROOT");
        let _ = std::fs::remove_dir_all(tmp);
    }

    /// 装载即分配：幂等 + scope 名嵌套 + 名字围栏（越界/多段/盘符/空/反斜杠）。
    #[test]
    fn ensure_allocates_idempotent_and_fences_names() {
        let (_guard, tmp) = with_data_root("ensure");
        let path = plugin_data_ensure("hello").unwrap();
        let dir = path["path"].as_str().unwrap();
        assert!(std::path::Path::new(dir).is_dir());
        // 幂等：再 ensure 同路径不炸
        let again = plugin_data_ensure("hello").unwrap();
        assert_eq!(again["path"], path["path"]);
        // scope 名嵌套（安装通道同款布局）
        let scoped = plugin_data_ensure("acme/tools").unwrap();
        assert!(
            scoped["path"].as_str().unwrap().replace('\\', "/").ends_with("acme/tools"),
            "意外路径: {scoped}"
        );
        // 名字围栏
        assert!(plugin_data_ensure("../evil").is_err());
        assert!(plugin_data_ensure("a/b/c").is_err());
        assert!(plugin_data_ensure("C:evil").is_err());
        assert!(plugin_data_ensure("").is_err());
        assert!(plugin_data_ensure("a\\b").is_err());
        cleanup(&tmp);
    }

    /// 读写列删闭环：嵌套写自动建目录、读原文、枚举形状（目录在前名字序）、
    /// 删文件/目录树、幂等删。
    #[test]
    fn write_read_list_delete_roundtrip() {
        let (_guard, tmp) = with_data_root("roundtrip");
        plugin_data_ensure("hello").unwrap();
        plugin_data_write("hello", "notes/sub/a.json", "{\"x\":1}").unwrap();
        assert_eq!(plugin_data_read("hello", "notes/sub/a.json").unwrap(), "{\"x\":1}");
        plugin_data_write("hello", "notes.json", "n").unwrap();
        // list 根：目录在前、名字序
        let listed = plugin_data_list("hello", "").unwrap();
        let names: Vec<&str> = listed["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["notes", "notes.json"]);
        assert!(listed["entries"][0]["is_dir"].as_bool().unwrap());
        // list 子目录（嵌套层：notes → 只含 sub 目录；notes/sub → a.json）
        let sub = plugin_data_list("hello", "notes").unwrap();
        assert_eq!(sub["entries"][0]["name"], "sub");
        assert!(sub["entries"][0]["is_dir"].as_bool().unwrap());
        let deep = plugin_data_list("hello", "notes/sub").unwrap();
        assert_eq!(deep["entries"][0]["name"], "a.json");
        assert!(!deep["entries"][0]["is_dir"].as_bool().unwrap());
        // delete 文件 + 目录树；删后读取报错
        plugin_data_delete("hello", "notes.json").unwrap();
        plugin_data_delete("hello", "notes").unwrap();
        assert!(plugin_data_read("hello", "notes/sub/a.json").is_err());
        // 幂等删
        plugin_data_delete("hello", "notes.json").unwrap();
        cleanup(&tmp);
    }

    /// rel 路径围栏：回溯/盘符/反斜杠/绝对前缀/空段全拒；空 rel 只放行给
    /// list（read/write/delete 要具体路径）。
    #[test]
    fn rel_path_fences_reject_traversal_and_drives() {
        let (_guard, tmp) = with_data_root("fences");
        plugin_data_ensure("hello").unwrap();
        plugin_data_write("hello", "a.txt", "x").unwrap();
        for bad in ["../escape", "a/../../escape", "\\escape", "C:/evil", "/abs", "a//b", "./a", "a/."] {
            assert!(plugin_data_read("hello", bad).is_err(), "{bad} read 应拒绝");
            assert!(plugin_data_write("hello", bad, "x").is_err(), "{bad} write 应拒绝");
        }
        assert!(plugin_data_read("hello", "").is_err());
        assert!(plugin_data_write("hello", "", "x").is_err());
        assert!(plugin_data_delete("hello", "").is_err());
        assert!(plugin_data_list("hello", "").is_ok());
        cleanup(&tmp);
    }

    /// 未声明 dataDir 的插件（目录未分配）→ 读写显式报错（不静默给地盘）。
    #[test]
    fn undeclared_plugin_ops_error_explicitly() {
        let (_guard, tmp) = with_data_root("undeclared");
        let err = plugin_data_list("ghost", "").unwrap_err();
        assert!(err.contains("未分配"), "应显式点名未分配: {err}");
        assert!(plugin_data_write("ghost", "a.txt", "x").is_err());
        cleanup(&tmp);
    }

    /// junction 逃逸（Windows）：数据目录内 junction 指向根外 / 指向他插件
    /// （仍在数据根内）都必须被前缀检查拒绝——锚定插件目录而非数据根。
    #[cfg(windows)]
    #[test]
    fn junction_escape_rejected() {
        use std::os::windows::process::CommandExt;
        let (_guard, tmp) = with_data_root("junction");
        plugin_data_ensure("hello").unwrap();
        plugin_data_ensure("other").unwrap();
        plugin_data_write("other", "secret.txt", "s").unwrap();
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"s").unwrap();
        let mk = |link: std::path::PathBuf, target: &std::path::Path| {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(target)
                .creation_flags(crate::utils::HIDDEN_CONSOLE)
                .output()
        };
        // 根外逃逸
        let link = tmp.join("hello").join("escape");
        let status = mk(link, &outside).expect("mklink /J 应可执行（junction 无需特权）");
        if !status.status.success() {
            eprintln!("[plugin_data] junction 创建失败，跳过逃逸测试: {status:?}");
            cleanup(&tmp);
            return;
        }
        assert!(plugin_data_read("hello", "escape/secret.txt").is_err(), "junction 逃逸必须拒绝");
        assert!(plugin_data_list("hello", "escape").is_err());
        assert!(plugin_data_write("hello", "escape/new.txt", "x").is_err());
        // 跨插件 junction（指向 other——仍在数据根内，前缀锚插件目录判拒）
        let cross = tmp.join("hello").join("cross");
        if let Ok(st) = mk(cross, &tmp.join("other")) {
            if st.status.success() {
                assert!(
                    plugin_data_read("hello", "cross/secret.txt").is_err(),
                    "跨插件 junction 必须拒绝"
                );
            }
        }
        cleanup(&tmp);
    }

    /// 卸载整体回收：数据目录挪 .trash（备份一个目录全家走）；重装再回收
    /// trash 重名加时间戳后缀（旧备份不覆盖）；无数据目录 = no-op。
    #[test]
    fn recycle_moves_to_trash_with_unique_suffix() {
        let (_guard, tmp) = with_data_root("recycle");
        plugin_data_ensure("hello").unwrap();
        plugin_data_write("hello", "data.json", "v1").unwrap();
        recycle_on_uninstall("hello").unwrap();
        assert!(!tmp.join("hello").exists(), "原位目录已挪走");
        let trashed = tmp.join(".trash").join("hello");
        assert!(trashed.join("data.json").is_file());
        // 重装再回收：第二份进带后缀目录，第一份不覆盖
        plugin_data_ensure("hello").unwrap();
        plugin_data_write("hello", "data.json", "v2").unwrap();
        recycle_on_uninstall("hello").unwrap();
        assert!(trashed.join("data.json").is_file(), "第一份备份不被覆盖");
        let trash_names: Vec<String> = std::fs::read_dir(tmp.join(".trash"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("hello"))
            .collect();
        assert!(trash_names.len() >= 2, "trash 应有两份: {trash_names:?}");
        // 无数据目录（未声明 dataDir 的插件）→ no-op
        recycle_on_uninstall("ghost").unwrap();
        cleanup(&tmp);
    }

    /// 卸载钩子端到端：plugin_uninstall 删代码目录 + 数据目录挪 .trash。
    /// 同时持 plugin_assets::PLUGINS_ROOT_TEST_LOCK（本测试也设
    /// HOLOGRAM_PLUGINS_ROOT——两个 env 都是进程级）。
    #[test]
    fn uninstall_recycles_data_dir() {
        let _data_guard = PLUGIN_DATA_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _plugins_guard = crate::plugin_assets::PLUGINS_ROOT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let data_tmp = std::env::temp_dir().join(format!("hologram_plugin_data_uninstall_{}", std::process::id()));
        let plugins_tmp = std::env::temp_dir().join(format!("hologram_plugins_uninstall_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_tmp);
        let _ = std::fs::remove_dir_all(&plugins_tmp);
        std::fs::create_dir_all(plugins_tmp.join("hello")).unwrap();
        std::fs::write(plugins_tmp.join("hello/manifest.json"), b"{\"name\":\"hello\"}").unwrap();
        std::env::set_var("HOLOGRAM_PLUGIN_DATA_ROOT", &data_tmp);
        std::env::set_var("HOLOGRAM_PLUGINS_ROOT", &plugins_tmp);
        plugin_data_ensure("hello").unwrap();
        plugin_data_write("hello", "keep.json", "v").unwrap();
        crate::commands::plugin_install::plugin_uninstall("hello").unwrap();
        assert!(!plugins_tmp.join("hello").exists(), "代码目录已删");
        assert!(data_tmp.join(".trash/hello/keep.json").is_file(), "数据随卸载进 .trash");
        assert!(!data_tmp.join("hello").exists(), "原位数据目录已挪走");
        std::env::remove_var("HOLOGRAM_PLUGIN_DATA_ROOT");
        std::env::remove_var("HOLOGRAM_PLUGINS_ROOT");
        let _ = std::fs::remove_dir_all(&data_tmp);
        let _ = std::fs::remove_dir_all(&plugins_tmp);
    }
}

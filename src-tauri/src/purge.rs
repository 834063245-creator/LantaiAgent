// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 卸载期用户数据清理（uninstall purge）。
//!
//! **背景（2026-09-26 用户报）**：卸载后用户主目录残留 `.lantai/`（会话/设置/插件/
//! 技能/全局记忆）与 `.hologram/`（2026-08-23 改名之前的老位，含引擎二进制与语法仓库），
//! 而 NSIS 卸载页的「删除应用程序数据」勾选框只覆盖 `%APPDATA%`/`%LOCALAPPDATA%\<identifier>`
//! （上游模板内建，见 target/release/nsis/x64/installer.nsi 的 `$DeleteAppDataCheckboxState` 段），
//! 主目录那两处没有任何人管 —— 用户看到的就是「没卸干净」。
//!
//! **设计：目录清单只有这一份**，安装器只负责「何时问、何时调」，不复述任何路径：
//!
//! | 挂接点 | 触发 | 调用 |
//! |---|---|---|
//! | NSIS（Windows 唯一在发的安装包） | 卸载确认页勾选框为真，或卸载器带 `/PURGE-DATA` | `lantai.exe --purge-user-data --yes`（钩子文件 `nsis/installer-hooks.nsh`） |
//!
//! 勾选框 / `/PURGE-DATA` 即用户同意 ⇒ 安装器带 `--yes` 不再二次询问；不带 `--yes` 手工执行时
//! （老 MSI 安装的用户、排障现场）本模块先弹一次「是/否」——卸载清理是删数据，缺省必须先问。
//!
//! MSI（`.msi`）渠道 2026-09-26 已停发（用户拍板「只发 NSIS」）：WiX fragment 装不进自定义动作，
//! 旧 MSI 从来没有过清理通路，理由与证据见 `docs/plans/uninstall-purge-plan.md`。
//!
//! **边界**：只清**用户级**数据（主目录 + AppData）。工作区里的 `{项目}/.lantai`
//! 与 `{项目}/.hologram` 是用户自己目录里的数据，卸载软件不该动它们。
//!
//! **默认安全**：勾选框缺省不勾 = 保数据；静默/被动卸载（`/S`、`/P`）页面不出现 ⇒
//! 勾选态恒为 0 ⇒ 自动更新路径永不删数据（钩子里另有 `$UpdateMode` 闸）。

use std::path::{Path, PathBuf};

/// 命令行开关：清理本机用户数据后立即退出（不起 GUI）。
pub const FLAG_PURGE: &str = "--purge-user-data";
/// 与 [`FLAG_PURGE`] 同用：跳过交互确认（调用方已经问过用户了）。
pub const FLAG_YES: &str = "--yes";

/// 用户主目录下的数据目录：`.lantai` = 现位（宿主数据），`.hologram` = 2026-08-23
/// 更名前的老位（引擎二进制/语法仓库/全局记忆；代码已不读它，但盘上还在）。
const HOME_SUBDIRS: [&str; 2] = [".lantai", ".hologram"];

/// 除当前 identifier 外，历史上用过的 bundle id（AppData 下按 identifier 分家）。
const LEGACY_BUNDLE_IDS: [&str; 2] = ["com.hologram.app", "com.hologram.hg"];

/// 三个系统数据根。生产入口 [`Roots::from_env`]；测试直接构造（字段公开）。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Roots {
    pub home: Option<PathBuf>,
    pub roaming: Option<PathBuf>,
    pub local: Option<PathBuf>,
}

impl Roots {
    /// Windows 卸载路径的三个根。非 Windows 上 `APPDATA`/`LOCALAPPDATA` 不存在 ⇒
    /// 只剩主目录两处（本模块只由 Windows 安装器调用，此处如实降级，不编造路径）。
    pub fn from_env() -> Self {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from);
        #[cfg(windows)]
        let (roaming, local) = (
            std::env::var_os("APPDATA").map(PathBuf::from),
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        );
        #[cfg(not(windows))]
        let (roaming, local) = (None, None);
        Self { home, roaming, local }
    }
}

/// 一个待清理目录。
///
/// **名字闸**（[`Target::new`]）：必须是绝对路径、有文件名，且名字属于
/// `.lantai` / `.hologram` / `com.*`。即便调用方算错了根，也删不到
/// `C:\Windows`、`C:\Users` 这类目录 —— 卸载路径上删错目录是灾难级事故。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    path: PathBuf,
    why: &'static str,
}

impl Target {
    pub fn new(path: PathBuf, why: &'static str) -> Option<Self> {
        if !path.is_absolute() {
            return None;
        }
        let name = path.file_name()?.to_str()?;
        if !(HOME_SUBDIRS.contains(&name) || name.starts_with("com.")) {
            return None;
        }
        Some(Self { path, why })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 该目录属于哪个根（人读日志用）。
    pub fn why(&self) -> &'static str {
        self.why
    }
}

/// 本次卸载要清的目录清单（真源）。
pub fn targets(roots: &Roots, bundle_id: &str) -> Vec<Target> {
    let mut out = Vec::new();
    if let Some(home) = &roots.home {
        for sub in HOME_SUBDIRS {
            push(&mut out, home.join(sub), "用户主目录");
        }
    }
    let mut ids: Vec<&str> = LEGACY_BUNDLE_IDS.to_vec();
    if !bundle_id.is_empty() {
        ids.push(bundle_id);
    }
    for (root, label) in [(&roots.roaming, "%APPDATA%"), (&roots.local, "%LOCALAPPDATA%")] {
        if let Some(r) = root {
            for id in &ids {
                push(&mut out, r.join(id), label);
            }
        }
    }
    out
}

fn push(out: &mut Vec<Target>, path: PathBuf, why: &'static str) {
    if let Some(t) = Target::new(path, why) {
        out.push(t);
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub removed: Vec<PathBuf>,
    pub missing: Vec<PathBuf>,
    pub failed: Vec<(PathBuf, String)>,
}

impl Report {
    /// 全部清干净（不存在 = 干净）。
    pub fn is_clean(&self) -> bool {
        self.failed.is_empty()
    }

    /// 一行摘要（日志与安装器 DetailPrint 共用）。
    pub fn summary(&self) -> String {
        format!(
            "removed={} missing={} failed={}",
            self.removed.len(),
            self.missing.len(),
            self.failed.len()
        )
    }
}

pub fn purge(targets: &[Target]) -> Report {
    let mut report = Report::default();
    for t in targets {
        let path = t.path();
        if !path.exists() {
            report.missing.push(path.to_path_buf());
            continue;
        }
        match remove(path) {
            Ok(()) => report.removed.push(path.to_path_buf()),
            Err(e) => report.failed.push((path.to_path_buf(), e)),
        }
    }
    report
}

/// 删掉一个目录（或文件）：先直接删，失败就清掉只读位再删一次。
///
/// 为什么必须清只读位：老 `.hologram/grammars/repos/*/.git/objects/**` 里的 git 对象带
/// 只读位，WebView2 的 `EBWebView` 亦然；`remove_dir_all` 撞上它们直接报 Access denied，
/// 会把整棵子树留在盘上（用户看到的仍是「没删干净」）。
fn remove(path: &Path) -> Result<(), String> {
    let attempt = |p: &Path| {
        if p.is_dir() {
            std::fs::remove_dir_all(p)
        } else {
            std::fs::remove_file(p)
        }
    };
    if attempt(path).is_ok() {
        return Ok(());
    }
    clear_readonly(path);
    attempt(path).map_err(|e| e.to_string())
}

fn clear_readonly(root: &Path) {
    for entry in walkdir::WalkDir::new(root).into_iter().filter_map(Result::ok) {
        let Ok(md) = entry.metadata() else { continue };
        let mut perms = md.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(entry.path(), perms);
        }
    }
}

/// 命令行解析结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliMode {
    /// 正常起 GUI。
    None,
    Purge { assume_yes: bool },
}

pub fn parse_args(args: &[String]) -> CliMode {
    if !args.iter().any(|a| a == FLAG_PURGE) {
        return CliMode::None;
    }
    CliMode::Purge {
        assume_yes: args.iter().any(|a| a == FLAG_YES),
    }
}

/// 生产入口：命中卸载清理开关就执行并返回**进程退出码**（0 = 干净，2 = 有残留）；
/// 未命中返回 `None` —— 调用方照常起 GUI。
pub fn cli_entry(bundle_id: &str) -> Option<i32> {
    match parse_args(&std::env::args().collect::<Vec<_>>()) {
        CliMode::None => None,
        CliMode::Purge { assume_yes } => Some(run(bundle_id, assume_yes)),
    }
}

fn run(bundle_id: &str, assume_yes: bool) -> i32 {
    let list = targets(&Roots::from_env(), bundle_id);
    if list.is_empty() {
        // 三个根一个都没解析出来（环境异常）——没删任何东西，如实返回失败。
        return 2;
    }
    if !assume_yes && !confirm(&list) {
        return 0;
    }
    let report = purge(&list);
    write_log(&report);
    if !report.is_clean() {
        notify_failure(&report);
        2
    } else {
        0
    }
}

const MB_YESNO: u32 = 0x0000_0004;
const MB_ICONWARNING: u32 = 0x0000_0030;
const MB_DEFBUTTON2: u32 = 0x0000_0100;
const MB_SETFOREGROUND: u32 = 0x0001_0000;
const MB_TOPMOST: u32 = 0x0004_0000;
const IDYES: i32 = 6;

#[cfg(windows)]
fn message_box(text: &str, caption: &str, flags: u32) -> i32 {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MESSAGEBOX_STYLE};
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let (t, c) = (wide(text), wide(caption));
    let r = unsafe { MessageBoxW(None, PCWSTR(t.as_ptr()), PCWSTR(c.as_ptr()), MESSAGEBOX_STYLE(flags)) };
    r.0
}

/// 安装器之外的手工调用（老 MSI 安装的用户、排障现场）在删之前问一次 ——
/// 这是删数据的命令，缺省必须先问，`--yes` 才是「调用方已经问过了」。
#[cfg(windows)]
fn confirm(list: &[Target]) -> bool {
    let mut text = String::from("是否同时删除兰台的用户数据？\n\n将删除：\n");
    for t in list {
        text.push_str(&format!("  · {}（{}）\n", t.path().display(), t.why()));
    }
    text.push_str("\n含会话记录、设置、API 密钥、插件与技能。\n选「否」= 保留数据（重新安装后仍可用）；选「是」= 立即删除，不可恢复。");
    message_box(
        &text,
        "卸载兰台",
        MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND,
    ) == IDYES
}

#[cfg(not(windows))]
fn confirm(_list: &[Target]) -> bool {
    // 非 Windows 上本模块不由安装器调用；交互无法保证 ⇒ 不动数据（安全方向）。
    eprintln!("[lantai] --purge-user-data 需要确认，但本平台无交互确认通道：未删除任何数据。");
    false
}

/// 删不掉必须可见（正是「没卸干净」这条投诉的形态）：问过用户的路径弹框列残留，
/// 自动路径（NSIS 卸载页）弹框同样列出，另有 `%TEMP%` 日志兜底。
fn notify_failure(report: &Report) {
    let mut text = String::from("以下兰台数据未能删除（可能被占用，删除失败）：\n\n");
    for (p, e) in &report.failed {
        text.push_str(&format!("  · {}\n    {}\n", p.display(), e));
    }
    text.push_str("\n已删除其余数据。请关闭兰台及相关进程后手动删除上述目录。");
    #[cfg(windows)]
    message_box(&text, "卸载兰台 · 有残留", MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND);
    #[cfg(not(windows))]
    eprintln!("[lantai] 卸载清理残留：{text}");
}

/// 逐条落 NDJSON 到 `%TEMP%\lantai-uninstall-purge.log`（安装器窗口一闪而过，
/// 事后排障只有这份账）。
fn write_log(report: &Report) {
    let path = std::env::temp_dir().join("lantai-uninstall-purge.log");
    let ts = chrono::Local::now().to_rfc3339();
    let mut lines = vec![
        serde_json::json!({"ts": ts, "event": "uninstall_purge", "result": "summary", "detail": report.summary()})
            .to_string(),
    ];
    let mut row = |p: &Path, result: &str, err: Option<&str>| {
        lines.push(
            serde_json::json!({
                "ts": ts,
                "event": "uninstall_purge",
                "target": p.to_string_lossy(),
                "result": result,
                "error": err,
            })
            .to_string(),
        );
    };
    for p in &report.removed {
        row(p, "removed", None);
    }
    for p in &report.missing {
        row(p, "missing", None);
    }
    for (p, e) in &report.failed {
        row(p, "failed", Some(e));
    }
    let mut body = lines.join("\n");
    body.push('\n');
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(body.as_bytes());
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lantai-purge-test-{}-{}-{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed(root: &Path, sub: &str) {
        let dir = root.join(sub);
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("nested/file.txt"), "x").unwrap();
    }

    /// 清单真源：主目录两处 + 两个 AppData 根 × （当前 id + 两个历史 id）。
    #[test]
    fn targets_cover_home_and_appdata() {
        let (home, roaming, local) = (
            PathBuf::from(r"C:\Users\t"),
            PathBuf::from(r"C:\Users\t\AppData\Roaming"),
            PathBuf::from(r"C:\Users\t\AppData\Local"),
        );
        let roots = Roots {
            home: Some(home.clone()),
            roaming: Some(roaming.clone()),
            local: Some(local.clone()),
        };
        let got: Vec<PathBuf> = targets(&roots, "com.lantai.app").into_iter().map(|t| t.path().to_path_buf()).collect();
        assert_eq!(
            got,
            vec![
                home.join(".lantai"),
                home.join(".hologram"),
                roaming.join("com.hologram.app"),
                roaming.join("com.hologram.hg"),
                roaming.join("com.lantai.app"),
                local.join("com.hologram.app"),
                local.join("com.hologram.hg"),
                local.join("com.lantai.app"),
            ]
        );
    }

    /// 根解析不出来时不留半截清单（宁少删，不删错）。
    #[test]
    fn targets_degrade_when_roots_missing() {
        let roots = Roots::default();
        assert!(targets(&roots, "com.lantai.app").is_empty());
    }

    /// 名字闸：盘根 / 系统目录 / 相对路径一律拒绝。
    #[test]
    fn target_rejects_dangerous_paths() {
        for bad in [
            r"C:\",
            r"C:\Windows",
            r"C:\Users",
            r"C:\Users\t\Documents",
            r".lantai",
            r"C:\Users\t\.lantai\sessions",
        ] {
            assert!(
                Target::new(PathBuf::from(bad), "test").is_none(),
                "必须拒绝：{bad}"
            );
        }
        assert!(Target::new(PathBuf::from(r"C:\Users\t\.lantai"), "test").is_some());
        assert!(Target::new(PathBuf::from(r"C:\Users\t\.hologram"), "test").is_some());
        assert!(Target::new(PathBuf::from(r"C:\Users\t\AppData\Local\com.lantai.app"), "test").is_some());
    }

    /// 真删：清单内的删干净（含只读文件），清单外的邻居一动不动。
    #[test]
    fn purge_removes_declared_and_spares_siblings() {
        let home = tmp("home");
        let local = tmp("local");
        seed(&home, ".lantai");
        seed(&home, ".hologram");
        seed(&local, "com.lantai.app");
        seed(&local, "com.hologram.app");
        // 邻居：同名前缀目录 + 无关目录（不得被删）
        seed(&home, ".lantai-old");
        seed(&home, "Documents");
        seed(&local, "some-other-app");

        // 只读文件（git 对象/WebView2 的形态）也必须能删掉
        let ro = home.join(".hologram/nested/ro.bin");
        std::fs::write(&ro, "x").unwrap();
        let mut perms = std::fs::metadata(&ro).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&ro, perms).unwrap();

        let roots = Roots {
            home: Some(home.clone()),
            roaming: None,
            local: Some(local.clone()),
        };
        let list = targets(&roots, "com.lantai.app");
        let report = purge(&list);

        assert!(report.is_clean(), "不该有失败：{:?}", report.failed);
        assert!(!home.join(".lantai").exists());
        assert!(!home.join(".hologram").exists());
        assert!(!local.join("com.lantai.app").exists());
        assert!(!local.join("com.hologram.app").exists());
        assert!(home.join(".lantai-old").exists(), "同前缀邻居不得被删");
        assert!(home.join("Documents").exists());
        assert!(local.join("some-other-app").exists());
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&local);

        // 没建过的目标 = missing（不是失败）
        assert!(report.missing.iter().any(|p| p.ends_with("com.hologram.hg")));
    }

    /// 幂等：删完再删一次 = 全 missing、零失败，不 panic。
    #[test]
    fn purge_is_idempotent() {
        let home = tmp("idem");
        seed(&home, ".lantai");
        let roots = Roots {
            home: Some(home.clone()),
            roaming: None,
            local: None,
        };
        let list = targets(&roots, "com.lantai.app");
        let first = purge(&list);
        assert_eq!(first.removed, vec![home.join(".lantai")]);
        let second = purge(&list);
        assert!(second.is_clean());
        assert!(second.removed.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 命令行解析：只有带开关才进清理路径，`--yes` 决定是否二次询问。
    #[test]
    fn parse_args_only_triggers_on_flag() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_args(&a(&["lantai.exe"])), CliMode::None);
        assert_eq!(parse_args(&a(&["lantai.exe", "--yes"])), CliMode::None);
        assert_eq!(
            parse_args(&a(&["lantai.exe", "--purge-user-data"])),
            CliMode::Purge { assume_yes: false }
        );
        assert_eq!(
            parse_args(&a(&["lantai.exe", "--purge-user-data", "--yes"])),
            CliMode::Purge { assume_yes: true }
        );
    }

    /// 契约守卫：安装器的清理必须走同一个开关（防「改了 Rust、忘了安装器」这类漂移）。
    #[test]
    fn installer_wiring_calls_the_purge_flag() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let conf = std::fs::read_to_string(root.join("tauri.conf.json")).unwrap();
        assert!(
            conf.contains("\"installerHooks\""),
            "NSIS 卸载钩子必须在 tauri.conf.json 上挂"
        );

        let hooks = std::fs::read_to_string(root.join("nsis/installer-hooks.nsh")).unwrap();
        assert!(hooks.contains(FLAG_PURGE) && hooks.contains(FLAG_YES));
        assert!(
            hooks.contains("$DeleteAppDataCheckboxState"),
            "清理必须以卸载页勾选框为条件（缺省不勾 = 保数据）"
        );
        assert!(
            hooks.contains("/PURGE-DATA"),
            "必须保留无人值守的显式同意开关（/S 时勾选框页不出现；E2E 也走它）"
        );
        assert!(hooks.contains("$UpdateMode"), "更新（/UPDATE）路径不得清数据");
    }

    /// 反向守卫：**MSI 渠道不得复活**（2026-09-26 用户拍板「Windows 只发 NSIS」），
    /// 也不得再挂「fragment 里塞自定义动作」这类假通路。
    ///
    /// 依据（本机 2026-09-26 实测）：`wix/cleanup.wxs` 那个 fragment 从 1.0.0 起就没进过任何一版
    /// 发布的 MSI —— 反编译 1.0.0 / 1.0.3 / 1.0.4 三版，CustomAction 表里都没有它，
    /// `InstallExecuteSequence` 里也没有对应行；那段 base64 PowerShell 弹窗一次也没弹过。
    /// 手工把 `main.wixobj + cleanup.wixobj` 一起交给 `light.exe` 重链、再做最小复现
    /// （Product + Fragment 两文件，CA 与序列都写在 Fragment 里）结果一样：只有 File 行、
    /// 没有 CustomAction 行 —— **WiX v3 的 sequence / CustomAction 是 Product 级元素，
    /// 写在 Fragment 里会被 light 丢掉**（上游 issue tauri#5970 同源）。
    /// MSI 侧唯一真路 = 整份替换 `wix.template`（配方留在计划件里），要复活渠道先过用户。
    #[test]
    fn windows_ships_nsis_only() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert!(
            !root.join("wix/cleanup.wxs").exists(),
            "MSI fragment 装不进自定义动作（见本测试头注）：别再把它加回来"
        );
        let conf = std::fs::read_to_string(root.join("tauri.conf.json")).unwrap();
        assert!(
            !conf.contains("fragmentPaths") && !conf.contains("\"wix\""),
            "MSI 已停发：base 配置不得再有 wix 段 / fragmentPaths"
        );
        let win = std::fs::read_to_string(root.join("tauri.windows.conf.json")).unwrap();
        assert!(
            win.contains("\"nsis\"") && !win.contains("\"msi\""),
            "Windows 只发 NSIS（用户 2026-09-26 拍板）"
        );
    }
}

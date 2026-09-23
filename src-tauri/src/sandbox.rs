// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// v4 Phase 2 — 降级为纯路径解析层：canonicalize + symlink/junction 检测
// 裁决逻辑已移至 permissions/ 模块。Sandbox 现被 permissions/filesystem.rs 调用，
// 不再独立裁决。
use std::path::{Path, PathBuf};

/// 沙箱路径解析检查的结果。
#[derive(Debug)]
pub enum SandboxResult {
    Allowed(PathBuf), // 已规范化、已验证的路径
    Denied(String),   // 拒绝原因
}

/// 路径验证 — 规范化、检查符号链接、验证前缀。
pub struct Sandbox {
    /// 逻辑版项目根（无 Windows verbatim `\\?\` 前缀）— 仅用于前缀比较。
    /// canonicalize 的结果带 `\\?\`，直接与无前缀路径比较会误判 outside。
    project_root: PathBuf,
}

/// 去掉 Windows verbatim 路径前缀（`\\?\` 与 `//?/` 两种拼写），统一比较基准。
/// canonicalize 返回 `\\?\D:\...`，用户提供的路径是 `D:\...`（前端透传/序列化后
/// 还可能变成 `//?/D:/...`）——字符串比较前必须统一，否则 starts_with 恒失败。
/// 注意：本函数只统一**拼写**，不做跨盘/回溯归约——归属判定后仍会 canonicalize，
/// 越界路径该拒还是拒。
#[cfg(windows)]
fn logical_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    for pre in [r"\\?\", "//?/"] {
        if let Some(rest) = s.strip_prefix(pre) {
            return PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}
#[cfg(not(windows))]
fn logical_path(p: &Path) -> PathBuf {
    p.to_path_buf()
}

impl Sandbox {
    pub fn new(project_root: &Path) -> Self {
        let root =
            std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
        Self {
            project_root: logical_path(&root),
        }
    }

    /// 前缀检查（逻辑路径比较 — canonicalize 会解析 junction/symlink 到物理路径，
    /// 但前缀归属判定应基于逻辑位置）。
    fn contains(&self, path: &Path) -> bool {
        logical_path(path).starts_with(&self.project_root)
    }

    /// 验证对 `path` 的读取操作。
    /// 用户级数据（~/.lantai/ 下白名单子目录 + 根级配置文件，见
    /// is_user_data_path_with_home）绕过项目沙箱（与写入相同）。
    pub fn resolve_read(&self, path: &Path) -> SandboxResult {
        // 用户级数据目录绕过
        if Self::is_user_data_path(path) {
            let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            if is_symlink_or_junction(path) {
                return SandboxResult::Denied("user data path symlinks are not allowed".into());
            }
            return SandboxResult::Allowed(real);
        }

        let real = match std::fs::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                if let Some(parent) = path.parent() {
                    match std::fs::canonicalize(parent) {
                        Ok(p) => p.join(path.file_name().unwrap_or_default()),
                        Err(_) => return SandboxResult::Denied("parent directory not found".into()),
                    }
                } else {
                    return SandboxResult::Denied("invalid path".into());
                }
            }
        };

        // 拒绝符号链接 / junction
        if is_symlink_or_junction(path) {
            return SandboxResult::Denied("symlinks and junctions are not allowed".into());
        }

        // 检查项目根目录前缀（逻辑路径比较，避免 \\?\ 前缀/junction 解析误判）
        if self.contains(&real) {
            return SandboxResult::Allowed(real);
        }

        SandboxResult::Denied(format!(
            "path {:?} is outside project directory {:?}",
            real, self.project_root
        ))
    }

    /// 检查此路径是否在用户级数据目录下（~/.lantai/<sub>）。
    /// 用户管理的数据设计上位于项目沙箱之外（全局记忆 + 技能目录——
    /// skills-mcp-production-plan Commit 3：让前端读 ~/.lantai/skills 放行）。
    fn is_user_data_path(path: &Path) -> bool {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        if home.is_empty() {
            return false;
        }
        Self::is_user_data_path_with_home(path, &home)
    }

    /// 用户级数据目录判定纯函数（home 注入——测试免 env 污染直测）。
    /// ~/.lantai 下允许项目沙箱外访问的：
    ///   - 数据子目录：global_memory（读+写豁免）、skills（读豁免，写锁项目内）
    ///   - 根级数据文件：mcp.json（用户级 MCP 配置——读+写豁免，Commit 5b/6c）、
    ///     providers.yml（provider 配方统管文件——读+写豁免，人可手写/agent 可读写）
    fn is_user_data_path_with_home(path: &Path, home: &str) -> bool {
        // ~/.lantai 下允许项目沙箱外访问的用户数据子目录（只读为主；
        // global_memory 历史含写绕过——skills 设计只读，写仍走项目内）。
        const USER_DATA_SUBDIRS: &[&str] = &["global_memory", "skills"];
        // 根级数据文件（~/.lantai/<file>——首段即文件名，非子目录）。
        const USER_DATA_FILES: &[&str] = &["mcp.json", "providers.yml"];
        let lantai = logical_path(&PathBuf::from(home).join(".lantai"));
        let rel_ok = |p: &Path| {
            let rel = match p.strip_prefix(&lantai).ok() {
                Some(r) => r,
                None => return false,
            };
            let mut comps = rel.components();
            let first = comps.next().and_then(|c| c.as_os_str().to_str());
            match first {
                Some(f) => {
                    // 子目录命中（白名单目录内任意层级）或根级文件命中
                    USER_DATA_SUBDIRS.iter().any(|s| *s == f)
                        || (comps.next().is_none() && USER_DATA_FILES.iter().any(|s| *s == f))
                }
                None => false,
            }
        };
        // 入参可能已是 verbatim 形态（`\\?\C:\...` / `//?/C:/...`——canonicalize 或前端透传）
        // ⇒ 先统一拼写再判归属；否则豁免恒不命中，用户级技能/记忆被误判 outside project。
        let logical = logical_path(path);
        if logical.starts_with(&lantai) && rel_ok(&logical) {
            return true;
        }
        // canonicalize 兜底（junction/symlink 解析后前缀判定——拒绝自身在
        // is_symlink_or_junction 检查）：结果**同样带 verbatim 前缀**，必须再过 logical_path。
        std::fs::canonicalize(path)
            .map(|p| {
                let lp = logical_path(&p);
                lp.starts_with(&lantai) && rel_ok(&lp)
            })
            .unwrap_or(false)
    }

    /// 检查此路径是否在全局记忆目录下（~/.lantai/global_memory）。
    /// 写豁免专用窄版——用户数据目录里只有 global_memory 开放写
    /// （agent 管理记忆）；skills 等其余子目录只读（resolve_read 放行，
    /// resolve_write 仍锁项目内）。
    fn is_global_memory_path(path: &Path) -> bool {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        if home.is_empty() {
            return false;
        }
        let gm = logical_path(&PathBuf::from(&home).join(".lantai").join("global_memory"));
        // 与读豁免同款：入参与 canonicalize 结果都可能是 verbatim 拼写，统一后再比
        let logical = logical_path(path);
        logical.starts_with(&gm)
            || std::fs::canonicalize(path)
                .map(|p| logical_path(&p).starts_with(&gm))
                .unwrap_or(false)
    }

    /// 用户级数据**写**豁免判定：global_memory 子目录（agent 管理记忆）
    /// + ~/.lantai/mcp.json（用户 UI 管理用户级 MCP 配置，Commit 6c）
    /// + ~/.lantai/providers.yml（provider 配方——agent 可读写）。
    /// 其余用户数据（skills 目录等）写仍锁项目内——防任意写跨项目资产。
    fn is_user_data_writable_path(path: &Path) -> bool {
        Self::is_global_memory_path(path)
            || Self::is_user_mcp_json_path(path)
            || Self::is_user_providers_file_path(path)
    }

    /// ~/.lantai/mcp.json 判定（用户级 MCP 配置文件——读+写豁免）。
    fn is_user_mcp_json_path(path: &Path) -> bool {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        if home.is_empty() {
            return false;
        }
        Self::is_user_mcp_json_path_with_home(path, &home)
    }

    /// mcp.json 判定纯函数（home 注入——测试免 env 污染直测）。
    fn is_user_mcp_json_path_with_home(path: &Path, home: &str) -> bool {
        let f = logical_path(&PathBuf::from(home).join(".lantai").join("mcp.json"));
        // 同款：verbatim 拼写（`\\?\`/`//?/`）统一后再比——用户级 mcp.json 的读+写都靠它
        logical_path(path) == f
            || std::fs::canonicalize(path)
                .map(|p| logical_path(&p) == f)
                .unwrap_or(false)
    }

    /// ~/.lantai/providers.yml 判定（provider 配方统管文件——读+写豁免）。
    fn is_user_providers_file_path(path: &Path) -> bool {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        if home.is_empty() {
            return false;
        }
        Self::is_user_providers_file_path_with_home(path, &home)
    }

    /// providers.yml 判定纯函数（home 注入——测试免 env 污染直测）。
    /// 只放行这一个文件：`providers.yml.bak` / `providers/` 子目录都不豁免。
    fn is_user_providers_file_path_with_home(path: &Path, home: &str) -> bool {
        let f = logical_path(&PathBuf::from(home).join(".lantai").join("providers.yml"));
        // 同款：verbatim 拼写（`\\?\`/`//?/`）统一后再比——用户级 providers.yml 的读+写都靠它
        logical_path(path) == f
            || std::fs::canonicalize(path)
                .map(|p| logical_path(&p) == f)
                .unwrap_or(false)
    }

    /// 验证写入操作。锁定到项目目录，
    /// 用户级数据目录除外（global_memory 为 agent 管理；skills 本期只读——
    /// 写入仍锁项目内，防技能目录被任意写）。
    pub fn resolve_write(&self, path: &Path) -> SandboxResult {
        // 用户级数据写豁免（global_memory + mcp.json + providers.yml；
        // skills 目录不在豁免——技能安装走项目级 UI 动作，不开放任意写）
        if Self::is_user_data_writable_path(path) {
            let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            // 安全检查仍然适用 — 用户数据路径不允许符号链接
            if is_symlink_or_junction(path) {
                return SandboxResult::Denied("user data path symlinks are not allowed".into());
            }
            return SandboxResult::Allowed(real);
        }

        let real = match std::fs::canonicalize(path) {
            Ok(p) => p,
            Err(_) => {
                if let Some(parent) = path.parent() {
                    match std::fs::canonicalize(parent) {
                        Ok(p) => p.join(path.file_name().unwrap_or_default()),
                        Err(_) => {
                            match find_existing_ancestor(path) {
                                Some((canon_ancestor, orig_ancestor)) => {
                                    if !self.contains(&canon_ancestor) {
                                        return SandboxResult::Denied(format!(
                                            "write outside project root {:?}",
                                            self.project_root
                                        ));
                                    }
                                    let relative =
                                        path.strip_prefix(&orig_ancestor).unwrap_or(path);
                                    canon_ancestor.join(relative)
                                }
                                None => {
                                    return SandboxResult::Denied(
                                        "parent directory not found".into(),
                                    )
                                }
                            }
                        }
                    }
                } else {
                    return SandboxResult::Denied("invalid path".into());
                }
            }
        };

        // 验证在 project_root 内（逻辑路径比较）
        if !self.contains(&real) {
            return SandboxResult::Denied(format!(
                "write to {:?} denied: outside project root {:?}",
                real, self.project_root
            ));
        }

        // 拒绝符号链接 / junction
        if is_symlink_or_junction(path) {
            return SandboxResult::Denied("symlinks and junctions are not allowed".into());
        }

        SandboxResult::Allowed(real)
    }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数：路径穿越
// ═══════════════════════════════════════════════════════════════

/// 向上遍历目录树，查找最近的已存在祖先。
fn find_existing_ancestor(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut current = path.to_path_buf();
    while let Some(parent) = current.parent() {
        if parent.as_os_str().is_empty() {
            break;
        }
        current = parent.to_path_buf();
        if current.exists() {
            if let Ok(canon) = std::fs::canonicalize(&current) {
                return Some((canon, current));
            }
        }
    }
    None
}

/// 检测 Windows 上的 NTFS 符号链接和 junction。
#[cfg(windows)]
fn is_symlink_or_junction(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    if let Ok(meta) = path.symlink_metadata() {
        // FILE_ATTRIBUTE_REPARSE_POINT = 0x400
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

#[cfg(not(windows))]
fn is_symlink_or_junction(path: &Path) -> bool {
    path.is_symlink()
}

/// 将 `~` 展开为用户 home 目录。
/// 被 permissions/bash.rs 从 shell 命令提取路径用；**也被 fs 路径解析入口用**
/// （2026-09-13 修：设置页 `~/.lantai/mcp.json` 的读/写此前全链路静默失败——
///  `~` 在 fs 层压根没展开，`Path::new("~/.lantai/mcp.json")` 被当相对路径，
///  落到 "parent directory not found"，再被 UI 的 catch 吞成"没有该文件"）。
/// 支持 `~` / `~/` / `~\` 三种写法；其余原样返回（不猜、不静默改）。
pub fn expand_home(raw: &str) -> PathBuf {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return PathBuf::from(raw);
    }
    if raw == "~" {
        return PathBuf::from(&home);
    }
    for pre in ["~/", r"~\"] {
        if let Some(rest) = raw.strip_prefix(pre) {
            return PathBuf::from(&home).join(rest);
        }
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// verbatim 前缀（\\?\）必须不影响前缀归属判定 —
    /// canonicalize 返回 \\?\D:\...，与无前缀路径比较必须通过。
    #[test]
    fn test_logical_path_strips_verbatim_prefix() {
        #[cfg(windows)]
        {
            let verbatim = Path::new(r"\\?\D:\FirstBeat Ultimate\.lantai\worktrees\agent-abc");
            let logical = logical_path(verbatim);
            assert_eq!(logical, PathBuf::from(r"D:\FirstBeat Ultimate\.lantai\worktrees\agent-abc"));
            // 无前缀路径原样返回
            assert_eq!(logical_path(Path::new(r"D:\proj")), PathBuf::from(r"D:\proj"));
        }
        #[cfg(not(windows))]
        {
            assert_eq!(logical_path(Path::new("/tmp/x")), PathBuf::from("/tmp/x"));
        }
    }

    /// `~` 展开（fs 路径层从此支持波浪号）——`~` / `~/` / `~\` 三种写法都要落到 home，
    /// 非波浪号一律原样（不猜、不静默改路径）。
    #[test]
    fn test_expand_home_forms() {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        if home.is_empty() {
            return; // 无 home 环境：本机不适用
        }
        let h = PathBuf::from(&home);
        #[cfg(windows)]
        {
            assert_eq!(expand_home("~"), h);
            assert_eq!(expand_home("~/.lantai/mcp.json"), h.join(".lantai/mcp.json"));
            assert_eq!(expand_home(r"~\.lantai\mcp.json"), h.join(r".lantai\mcp.json"));
            assert_eq!(expand_home("C:/other/x.json"), PathBuf::from("C:/other/x.json"));
            assert_eq!(expand_home("~/"), h.join(""));
        }
        #[cfg(not(windows))]
        {
            assert_eq!(expand_home("~"), h);
            assert_eq!(expand_home("~/.lantai/mcp.json"), h.join(".lantai/mcp.json"));
            assert_eq!(expand_home("/tmp/x"), PathBuf::from("/tmp/x"));
        }
    }

    /// contains() 对 verbatim 前缀的路径必须按逻辑路径判定 —
    /// \\?\D:\root\a 在根 D:\root 内。
    #[test]
    fn test_contains_with_verbatim_path() {
        #[cfg(windows)]
        {
            let sandbox = Sandbox {
                project_root: PathBuf::from(r"D:\root"),
            };
            let verbatim_child = Path::new(r"\\?\D:\root\sub\file.rs");
            assert!(sandbox.contains(verbatim_child), "verbatim child must be inside root");
            let outside = Path::new(r"\\?\D:\other\file.rs");
            assert!(!sandbox.contains(outside), "verbatim outside path must be denied");
        }
        #[cfg(not(windows))]
        {
            let sandbox = Sandbox {
                project_root: PathBuf::from("/root"),
            };
            assert!(sandbox.contains(Path::new("/root/sub/file.rs")));
            assert!(!sandbox.contains(Path::new("/other/file.rs")));
        }
    }

    // ── resolve_read ──

    #[test]
    fn test_read_inside_project() {
        let tmp = std::env::temp_dir().join("holo_sandbox_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("test.txt"), "hello").unwrap();

        let sandbox = Sandbox::new(&tmp);
        let result = sandbox.resolve_read(&tmp.join("test.txt"));
        assert!(matches!(result, SandboxResult::Allowed(_)));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_read_outside_project_denied() {
        let tmp = std::env::temp_dir().join("holo_sandbox_test2");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let sandbox = Sandbox::new(&tmp);
        let result = sandbox.resolve_read(Path::new("C:\\Windows\\System32\\notepad.exe"));
        assert!(matches!(result, SandboxResult::Denied(_)));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── resolve_write ──

    #[test]
    fn test_write_locked_to_project() {
        let tmp = std::env::temp_dir().join("holo_sandbox_test3");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let sandbox = Sandbox::new(&tmp);
        let result = sandbox.resolve_write(&tmp.join("new_file.txt"));
        assert!(matches!(result, SandboxResult::Allowed(_)));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── 用户级数据目录（skills-mcp-production-plan Commit 3）──
    // 纯函数直测（home 注入——免 env 污染）。Windows/macOS/Linux 共用路径
    // 语义：home = /home/u 或 C:\Users\u，拼 .lantai/<sub>。

    fn fake_home() -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(r"C:\Users\test")
        }
        #[cfg(not(windows))]
        {
            PathBuf::from("/home/test")
        }
    }

    #[test]
    fn user_data_path_skills_allowed() {
        let home = fake_home();
        let home_s = home.to_string_lossy().into_owned();
        // ~/.lantai/skills/<name>/SKILL.md 应放行（前端读用户级技能）
        let p = home.join(".lantai").join("skills").join("code-review").join("SKILL.md");
        assert!(Sandbox::is_user_data_path_with_home(&p, &home_s), "~/.lantai/skills 应放行");
        // global_memory 保持放行（历史语义）
        let gm = home.join(".lantai").join("global_memory").join("MEMORY.md");
        assert!(Sandbox::is_user_data_path_with_home(&gm, &home_s), "~/.lantai/global_memory 应放行");
    }

    #[test]
    fn user_data_path_mcp_json_allowed_rw() {
        let home = fake_home();
        let home_s = home.to_string_lossy().into_owned();
        // ~/.lantai/mcp.json（用户级 MCP 配置）读+写豁免（Commit 5b/6c）
        let f = home.join(".lantai").join("mcp.json");
        assert!(Sandbox::is_user_data_path_with_home(&f, &home_s), "~/.lantai/mcp.json 读应放行");
        assert!(
            Sandbox::is_user_mcp_json_path_with_home(&f, &home_s),
            "~/.lantai/mcp.json 写豁免判定应真"
        );
        // 同名前缀的其他文件不受影响
        let other = home.join(".lantai").join("mcp.json.bak");
        assert!(
            !Sandbox::is_user_mcp_json_path_with_home(&other, &home_s),
            "mcp.json.bak 不豁免"
        );
    }

    /// ~/.lantai/providers.yml（provider 配方统管文件）：读+写豁免；
    /// 相邻路径一律不放行——白名单只放行**这一个文件**（providers.yml.bak /
    /// providers/ 子目录 / providers 目录本身都拒绝）。
    #[test]
    fn user_data_path_providers_yml_allowed_rw() {
        let home = fake_home();
        let home_s = home.to_string_lossy().into_owned();
        let lantai = home.join(".lantai");
        // 读豁免（is_user_data_path_with_home）+ 写豁免（is_user_providers_file_path_with_home）
        let f = lantai.join("providers.yml");
        assert!(
            Sandbox::is_user_data_path_with_home(&f, &home_s),
            "~/.lantai/providers.yml 读应放行"
        );
        assert!(
            Sandbox::is_user_providers_file_path_with_home(&f, &home_s),
            "~/.lantai/providers.yml 写豁免判定应真"
        );
        // 相邻路径写侧一律不豁免
        for adjacent in [
            lantai.join("providers.yml.bak"),
            lantai.join("providers").join("x.yml"),
            lantai.join("providers"),
            lantai.join("mcp.json"),
            lantai.join("providers.yaml"),
        ] {
            assert!(
                !Sandbox::is_user_providers_file_path_with_home(&adjacent, &home_s),
                "写豁免不得放行 {:?}",
                adjacent
            );
        }
        // 相邻路径读侧同样拒绝（豁免是"单文件"，不是"providers* 前缀"）
        for adjacent in [
            lantai.join("providers.yml.bak"),
            lantai.join("providers").join("x.yml"),
            lantai.join("providers"),
            lantai.join("providers.yaml"),
        ] {
            assert!(
                !Sandbox::is_user_data_path_with_home(&adjacent, &home_s),
                "读豁免不得放行 {:?}",
                adjacent
            );
        }
    }

    /// 端到端拼接：`resolve_read` / `resolve_write` 真的走到 providers.yml 豁免
    /// （纯函数真 ≠ 接线真——漏把判别函数接进 is_user_data_writable_path 时本用例红）。
    /// 只 stat/canonicalize，不写用户真实主目录。
    #[test]
    fn providers_file_bypasses_project_sandbox_rw() {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        if home.is_empty() {
            return; // 无 home 环境：本机不适用（同 test_expand_home_forms 的处置）
        }
        let sandbox = Sandbox::new(&std::env::temp_dir());
        let lantai = PathBuf::from(&home).join(".lantai");
        assert!(
            matches!(sandbox.resolve_read(&lantai.join("providers.yml")), SandboxResult::Allowed(_)),
            "~/.lantai/providers.yml 读应绕过项目沙箱"
        );
        assert!(
            matches!(sandbox.resolve_write(&lantai.join("providers.yml")), SandboxResult::Allowed(_)),
            "~/.lantai/providers.yml 写应绕过项目沙箱"
        );
        // 相邻路径两项都仍锁项目内
        let bak = lantai.join("providers.yml.bak");
        assert!(matches!(sandbox.resolve_read(&bak), SandboxResult::Denied(_)), "providers.yml.bak 读仍拒绝");
        assert!(matches!(sandbox.resolve_write(&bak), SandboxResult::Denied(_)), "providers.yml.bak 写仍拒绝");
    }

    #[test]
    fn user_data_path_other_subdirs_denied() {
        let home = fake_home();
        let home_s = home.to_string_lossy().into_owned();
        // ~/.lantai 下但非白名单子目录（如 sessions/logs/canvas.json）→ 拒绝
        let session = home.join(".lantai").join("sessions").join("1.json");
        assert!(
            !Sandbox::is_user_data_path_with_home(&session, &home_s),
            "~/.lantai/sessions 不在白名单——拒绝"
        );
        let log = home.join(".lantai").join("logs").join("ui.log");
        assert!(!Sandbox::is_user_data_path_with_home(&log, &home_s), "~/.lantai/logs 拒绝");
        // ~/.lantai 根本身（无子目录段）→ 拒绝
        assert!(!Sandbox::is_user_data_path_with_home(&home.join(".lantai"), &home_s), ".lantai 根拒绝");
    }

    /// 回归：Windows `canonicalize` 产出的 **verbatim 形态**（`\\?\C:\...`）必须同样命中用户数据豁免。
    /// 实测 bug（2026-09-13）：前端读到的一批路径带 `\\?\`/`//?/` 前缀，而
    /// `is_user_data_path_with_home` 只拿**逻辑形态**（`C:\...`）做 `starts_with` ⇒ 恒不命中，
    /// 用户级技能 `~/.lantai/skills/<name>/SKILL.md` 被误判「outside project directory」拒读，
    /// 且 canonicalize 兜底同样在拿 verbatim 路径比对逻辑前缀（双重失效）。
    #[test]
    fn user_data_path_verbatim_prefix_allowed() {
        let home = fake_home();
        let home_s = home.to_string_lossy().into_owned();
        #[cfg(windows)]
        {
            let verbatim = PathBuf::from(format!(r"\\?\{}\.lantai\skills\officecli\SKILL.md", home_s));
            assert!(
                Sandbox::is_user_data_path_with_home(&verbatim, &home_s),
                r"verbatim（\\?\）形态应命中用户数据豁免"
            );
            let verbatim_fwd = PathBuf::from(format!("//?/{}/.lantai/skills/officecli/SKILL.md", home_s.replace('\\', "/")));
            assert!(
                Sandbox::is_user_data_path_with_home(&verbatim_fwd, &home_s),
                "verbatim 正斜杠形态（//?/C:/...）应命中用户数据豁免"
            );
            // 非白名单子目录在 verbatim 形态下仍必须拒（豁免只放宽形态，不放宽范围）
            let verbatim_denied = PathBuf::from(format!(r"\\?\{}\.lantai\sessions\1.json", home_s));
            assert!(
                !Sandbox::is_user_data_path_with_home(&verbatim_denied, &home_s),
                "verbatim 形态不得把非白名单子目录放进来"
            );
        }
        #[cfg(not(windows))]
        {
            let p = home.join(".lantai").join("skills").join("officecli").join("SKILL.md");
            assert!(Sandbox::is_user_data_path_with_home(&p, &home_s));
        }
    }

    #[test]
    fn user_data_path_outside_home_denied() {
        let home = fake_home();
        let home_s = home.to_string_lossy().into_owned();
        // 非 home 前缀一律拒绝（含项目内路径——项目内本就走正常沙箱路径）
        #[cfg(windows)]
        let outside = PathBuf::from(r"D:\proj\.lantai\skills\x\SKILL.md");
        #[cfg(not(windows))]
        let outside = PathBuf::from("/proj/.lantai/skills/x/SKILL.md");
        assert!(!Sandbox::is_user_data_path_with_home(&outside, &home_s), "项目内 skills 走正常沙箱，非用户数据豁免");
    }
}

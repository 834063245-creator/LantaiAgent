// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

//! 通用排除规则（工具链、VCS、构建产物、运行时目录）。
//!
//! 原 `engine::pipeline::discovery` 的纯函数面（engine-plugin-extraction
//! Phase 3 上收：壳层在摘除 hologram-engine 依赖后仍需同一套忽略语义，
//! 纯函数迁图类型层 crate——后缀表 `set_code_extensions` 本就在此）。
//! 由文件发现、watcher、简报（preflight）与壳层 fs/search 共享，
//! 确保所有子系统中的过滤行为一致。
//!
//! 注意：不收录 `vendor`（Go/PHP 依赖树）与 `bin`（.NET 输出）——kernel
//! 实证存在同名的真实源码目录（arch/riscv/include/uapi/asm/vendor、
//! tools/perf/scripts/*/bin），全局 basename 排除会误伤；这些场景应
//! 由项目自己的 .gitignore（已按 git 语义生效）处理。

/// 硬编码的通用排除规则。
pub const IGNORED_DIRS: &[&str] = &[
    ".git", "__pycache__", "node_modules", "venv", ".venv", "env",
    ".tox", ".mypy_cache", ".pytest_cache", ".hg", ".svn",
    "dist", "build", "target", ".eggs", "*.egg-info",
    // .hologram 与 .lantai 双名共存（2026-08-23 改名）：用户硬盘上的老项目
    // 可能永远存在未迁移的 .hologram，必须继续忽略防止被吃进图。
    ".hologram", ".lantai", "htmlcov", ".reasonix", ".codegraph", ".ruff_cache",
    ".next", ".nuxt", "out", ".angular", ".cache", "coverage",
    "vendored", "generated", "tests",
    ".vscode", ".idea", ".fleet", ".cursor",  // 编辑器
    "Pods", ".gradle",  // CocoaPods 依赖 / Gradle 缓存 — 语义铁定的依赖目录
];

/// 目录名是否应被排除（精确名单 + 虚拟环境前缀规则）。
/// `.venv*` / `venv-` / `venv_` 前缀覆盖带后缀命名的 Python 虚拟环境
/// （`.venv-lme`、`.venv2`、`venv-lme`…）——精确名单匹配不上时，整棵
/// site-packages 依赖树会漏进图（d:\newexperience 实证：1,891 个第三方
/// py → 9 万节点 / 280MB graph JSON / 447MB sqlite）。虚拟环境目录
/// 无源码语义，前缀匹配不会误伤真实源码（区别于 vendor/bin 的教训）。
pub fn is_ignored_dir_name(name: &str) -> bool {
    if IGNORED_DIRS.contains(&name) {
        return true;
    }
    name.starts_with(".venv") || name.starts_with("venv-") || name.starts_with("venv_")
}

/// 检查文件路径是否位于任何被忽略的目录中。
/// 供简报系统（preflight）、watcher 与壳层 fs/search 使用，用于过滤
/// `.lantai/`、`.git/`、`node_modules/` 等目录中的文件 — 这些是工具/
/// 运行时产物，而非用户源代码。
///
/// 同时处理 `/` 和 `\` 路径分隔符，以实现跨平台兼容。
pub fn is_ignored_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let mut components = normalized.split('/').peekable();
    while let Some(component) = components.next() {
        if components.peek().is_some() {
            // 目录分量：精确名单 + 虚拟环境前缀规则（`.venv-lme` 等）
            if is_ignored_dir_name(component) {
                return true;
            }
        } else if IGNORED_DIRS.contains(&component) {
            // 末位分量（文件名）：仅精确名单——前缀规则是目录语义，
            // 套到文件名会误伤 `venv_helper.py` 这类真实文件。
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_ignored_path_hologram() {
        assert!(is_ignored_path("D:/projects/myapp/.hologram/baseline.json"));
        assert!(is_ignored_path("D:/projects/myapp/.hologram/memory/ctx.json"));
        assert!(is_ignored_path(".hologram/cache/graph.json"));
        assert!(is_ignored_path("D:/projects/myapp/.lantai/sessions/1.json"));
        assert!(is_ignored_path(".lantai/hologram.db"));
    }

    #[test]
    fn test_is_ignored_path_git() {
        assert!(is_ignored_path("D:/projects/myapp/.git/HEAD"));
        assert!(is_ignored_path("D:/projects/myapp/.git/config"));
        assert!(is_ignored_path(".gitignore") == false);
    }

    #[test]
    fn test_is_ignored_path_node_modules() {
        assert!(is_ignored_path("D:/projects/myapp/node_modules/express/index.js"));
        assert!(is_ignored_path("node_modules/react/index.js"));
    }

    #[test]
    fn test_is_ignored_path_source_files() {
        assert!(!is_ignored_path("D:/projects/myapp/src/main.rs"));
        assert!(!is_ignored_path("src/handler.py"));
        assert!(!is_ignored_path("app/config/settings.yaml"));
    }

    #[test]
    fn test_venv_prefix_rules() {
        for name in [".venv-lme", ".venv2", "venv-lme", "venv_2"] {
            assert!(is_ignored_dir_name(name), "{name} should be ignored");
            assert!(
                is_ignored_path(&format!("D:/proj/{name}/Lib/site-packages/pip/_internal/x.py")),
                "{name} 整棵依赖树应被排除"
            );
        }
        assert!(is_ignored_dir_name(".venv"));
        assert!(is_ignored_dir_name("venv"));
        assert!(!is_ignored_dir_name("src"));
        assert!(!is_ignored_dir_name("vendor"));
        // 前缀规则是目录语义——末位文件名不套用（venv_helper.py 是真实源文件）
        assert!(!is_ignored_path("D:/proj/src/venv_helper.py"));
    }
}

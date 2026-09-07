// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

//! 通用排除规则（工具链、VCS、构建产物、运行时目录）——壳层自有一份。
//!
//! 引擎-宿主逻辑全断（engine-host-severance，2026-09-08）：壳摘除
//! hologram-* crate 依赖后，文件忽略语义（fs / search / editor 能力口与
//! confined_fs 的目录过滤）归壳自管——与引擎侧的发现忽略（类型 crate 里的
//! 同型函数）从此各自演化：宿主的文件可见面与引擎的图发现面本就是两个
//! 关注点，共享一份清单只是当年省事，不是语义。
//!
//! 教训注释与用例随函数原样搬入（vendor/bin 与 venv 前缀两课都是真血）：
//!
//! 注意：不收录 `vendor`（Go/PHP 依赖树）与 `bin`（.NET 输出）——kernel
//! 实证存在同名的真实源码目录（arch/riscv/include/uapi/asm/vendor、
//! tools/perf/scripts/*/bin），全局 basename 排除会误伤；这些场景应
//! 由项目自己的 .gitignore（已按 git 语义生效）处理。

/// 硬编码的通用排除规则。
///
/// `.hologram` 与 `.lantai` 双名共存（2026-08-23 宿主目录改名；2026-09-08
/// 引擎数据分居后 `.hologram` 归引擎、`.lantai` 归宿主）：用户硬盘上的老项目
/// 可能任一形态存在，两个都必须继续忽略。
pub const IGNORED_DIRS: &[&str] = &[
    ".git", "__pycache__", "node_modules", "venv", ".venv", "env",
    ".tox", ".mypy_cache", ".pytest_cache", ".hg", ".svn",
    "dist", "build", "target", ".eggs", "*.egg-info",
    ".hologram", ".lantai", "htmlcov", ".reasonix", ".codegraph", ".ruff_cache",
    ".next", ".nuxt", "out", ".angular", ".cache", "coverage",
    "vendored", "generated", "tests",
    ".vscode", ".idea", ".fleet", ".cursor",  // 编辑器
    "Pods", ".gradle",  // CocoaPods 依赖 / Gradle 缓存 — 语义铁定的依赖目录
];

/// 目录名是否应被排除（精确名单 + 虚拟环境前缀规则）。
/// `.venv*` / `venv-` / `venv_` 前缀覆盖带后缀命名的 Python 虚拟环境
/// （`.venv-lme`、`.venv2`、`venv-lme`…）——精确名单匹配不上时，整棵
/// site-packages 依赖树会漏过过滤（d:\newexperience 实证：1,891 个第三方
/// py 全量入图）。虚拟环境目录无源码语义，前缀匹配不会误伤真实源码
/// （区别于 vendor/bin 的教训）。
pub(crate) fn is_ignored_dir_name(name: &str) -> bool {
    if IGNORED_DIRS.contains(&name) {
        return true;
    }
    name.starts_with(".venv") || name.starts_with("venv-") || name.starts_with("venv_")
}

/// 检查文件路径是否位于任何被忽略的目录中。
/// 同时处理 `/` 和 `\` 路径分隔符，以实现跨平台兼容。
pub(crate) fn is_ignored_path(path: &str) -> bool {
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
    fn test_is_ignored_path_data_dirs() {
        assert!(is_ignored_path("D:/projects/myapp/.hologram/hologram.db"));
        assert!(is_ignored_path("D:/projects/myapp/.hologram/baseline.json"));
        assert!(is_ignored_path("D:/projects/myapp/.lantai/sessions/1.json"));
        assert!(is_ignored_path(".lantai/memory/context.json"));
        assert!(is_ignored_path(".hologram/vectors.usearch"));
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

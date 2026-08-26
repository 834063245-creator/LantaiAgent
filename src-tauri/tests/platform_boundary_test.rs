// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 平台边界守卫（agent-platformization-plan.md Phase 0 / D1）：
// 强制层外不得新增 Rust 命令模块。新增能力命令 = 违反平台边界，必须走开放面
// （前端 seam / 外部 MCP / 动态插件）。若确属强制层改动，更新本测试基线并附宪法审查记录。

use std::fs;

fn commands_mod_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("commands")
        .join("mod.rs")
}

fn parse_command_modules(src: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in src.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("pub mod ") {
            if let Some(name) = rest.strip_suffix(';') {
                let name = name.trim();
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    names
}

#[test]
fn capability_command_modules_are_frozen() {
    let src = fs::read_to_string(commands_mod_path()).expect("src/commands/mod.rs must exist");
    let actual = parse_command_modules(&src);
    let expected = vec![
        "constraints",
        "dataflow",
        "editor",
        "engine_dispatch",
        "external",
        "filesystem",
        "git_cmds",
        "graph",
        "hologram",
        "identity",
        "isolation",
        "plugin_install",
        "protocol_bridge",
        "search",
        "shell",
        "web",
        "workspace",
    ];
    assert_eq!(
        actual, expected,
        "强制层外能力命令模块清单被改动。\n\
         平台边界（docs/adr/project-constitution.md 第五条 / agent-platformization-plan D1）：\n\
         新能力必须走开放面（前端 seam / 外部 MCP / 动态插件），禁止新增 Rust 命令。\n\
         若确属强制层（权限/沙箱/审计/IPC/组合引擎）改动，必须：\n\
         1) 在本测试基线中加入该模块；\n\
         2) 在 commit message 显式标注「强制层改动 + 宪法审查」。"
    );
}
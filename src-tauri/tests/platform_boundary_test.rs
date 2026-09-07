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
        "browser_cap",
        "constraints_cap",
        "dataflow",
        "editor_cap",
        "engine_dispatch",
        "external",
        "filesystem",
        "fs_cap",
        "git_cap",
        "graph",
        "hologram",
        "identity",
        "isolation",
        "lsp_cap",
        "oauth",
        "plugin_data",
        "plugin_install",
        "process_cap",
        "protocol_bridge",
        "pty_cap",
        "search_cap",
        "uia_cap",
        "web_cap",
        "workspace",
    ];
    assert_eq!(
        actual, expected,
        "强制层外能力命令模块清单被改动。\n\
         平台边界（docs/adr/project-constitution.md 第五条 / agent-platformization-plan D1）：\n\
         新能力必须走开放面（前端 seam / 外部 MCP / 动态插件），禁止新增 Rust 命令。\n\
         若确属强制层（权限/沙箱/审计/IPC/组合引擎）改动，必须：\n\
         1) 在本测试基线中加入该模块；\n\
         2) 在 commit message 显式标注「强制层改动 + 宪法审查」。\n\
         oauth = 强制层身份认证（OAuth 订阅登录，commit 6575c04c——凭证流与\n\
         identity 同族；基线补录 2026-09-08：该 commit 漏更本基线致 HEAD 红，\n\
         按本测试自有程序补录，非新授权）。\n\
         search_cap = v3 能力口（kernel-plugin-architecture-decision.md §3：fs 能力族\n\
         变体 + resolve_read 强制闸 + 物理扫描/向量召回）——合法强制层模块，见\n\
         docs/plans/kernel-capability-r2-search-pilot.md §7。\n\
         fs_cap = v3 能力口（kernel-capability-c3-design.md R3-a：fs 能力族 + \n\
         resolve_*_dispatch 强制闸 + confined_fs 字节执行）——合法强制层模块，\n\
         编排归 TS（R3-b 起），禁止向 commands/ 塞业务命令。\n\
         git_cap = v3 能力口（kernel-capability-c3-design.md R3-c：git 能力族 +\n\
         PluginToolAdapter 两段闸（Read 家族/Git 家族 subcommand 位）+ git_exec_path\n\
         worktree forward-map + run_git 执行体）——合法强制层模块，porcelain 解析\n\
         归 TS（git 域收口起），禁止向 commands/ 塞业务命令。\n\
         process_cap = v3 能力口（kernel-capability-c3-design.md R3-d：process\n\
         能力族 + fg/bg 双检查不对称闸（require_command 可 Ask / sync 免 Ask，\n\
         Bash 家族命令串规则面直用 BashTool）+ BG_JOBS ledger 执行体）——合法\n\
         强制层模块，粘性 cwd 状态归 TS 编排层（c3 §9，口只收 cwd/sticky_cwd\n\
         显式参数），禁止向 commands/ 塞业务命令。\n\
         browser_cap = v3 能力口（kernel-capability-d4-handle-design.md R4-1：\n\
         browser 句柄域 + BrowserTool 口内闸（无条件过闸 + 多层语义 +\n\
         click/type_sensitive 二次 Ask——D4-4/D4-5）+ CDP 会话执行体）——合法\n\
         强制层模块，CDP 会话注册表/审计环/敏感词表是句柄层本体，禁止向\n\
         commands/ 塞业务命令。\n\
         uia_cap = v3 能力口（kernel-capability-d4-handle-design.md R4-3：\n\
         desktop 句柄域 + DesktopTool 口内闸（无条件过闸 + 六层语义）+\n\
         resolve→classify→grant→lease 全链执行体（INVARIANTS #13：COM 只活\n\
         worker 线程、物理输入必经租约））——合法强制层模块，grants/审计/\n\
         敏感词表是句柄层本体，禁止向 commands/ 塞业务命令。\n\
         web_cap/constraints_cap/pty_cap/lsp_cap = v3 能力口（同设计件 R4-4\n\
         小面清偿：web 族（WebFetchTool 口内闸 + SSRF 逐跳复查）/ constraints\n\
         读写（原语义无闸 + 路径校验）/ pty、lsp 会话族（Passthrough 原语义，\n\
         pty_manager/lsp_manager 本体留 Rust——v3 §4 原生引用不迁））——合法\n\
         强制层模块，禁止向 commands/ 塞业务命令。\n\
         plugin_data = 应用壳基础设施（app-shell 四件套 · 件 B，docs/plans/\n\
         app-shell-software-plugin-plan.md §5-S1）：webview 无盘权 → 插件数据\n\
         目录 I/O 必须 Rust（v3 决策「应用壳」保留面）；名字 + rel 双围栏 +\n\
         canonicalize 前缀锁死 <dataRoot>/<插件名>/ 属沙箱族安全件；非能力口\n\
         ——不进 Agent 工具面（装载期 ensure + 宿主桥 fs 面 + 卸载 .trash 钩）。"
    );
}
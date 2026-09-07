// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// git 能力口（R3-c，kernel-capability-c3-design.md §8）——内核能力层的 git 族。
//
// 能力口语义：模型族 TS 工具（coding.ts gitCapTool）与内部消费（state-inject
// 的 git_status 状态栏 / git_blame 行级归属）经 RPC 直呼，不经 tool_call 信封 /
// PluginRegistry / PluginToolAdapter（builtin.git 插件随 git 域收口退役）。
// 单方法 + action 分派（对标 fs_cap.rs），action = 退役前 builtin.git 工具名
// （16 工具一一位，与历史精确规则寻址名同构）。
//
// 口内闸（v3 §1：Rust 能力口是 webview 越不过的物理强制层；权限不迁 TS——
// c3 §9 裁定）：Agent 路径构造 PluginToolAdapter 过闸——
//   - 只读五动作（git_status/git_diff_unstaged/git_diff_staged/git_log/git_blame）
//     走 Read 家族（repo 路径读检查，c3 §8「read_only 5 工具走 Read 家族闸分流」）；
//   - 写动作走 Git 家族两段闸 = filesystem::check_read_permission(repo) +
//     git::check(subcommand)——精确子命令 deny/allow/ask 规则依赖 subcommand 位。
//   精确名寻址保留历史名 plugin:builtin.git.<action>（用户既有规则不失义）；
//   家族回退 Read/Git 继续生效（PluginToolAdapter 双级寻址同款）。
// 用户路径（is_agent=false）零规则零弹窗（dispatch P2-0 §3.5 同款）。
//
// 编排归 TS（c3 §8）：porcelain 解析（status 头 / parse_status / log \x00
// split）迁 src-ui/src/agent/git-porcelain.ts——本口只做 run_git 直通；
// diff/blame 保留 32K 截断（IPC 尺寸护栏属物理层，INVARIANTS #11）。
// 执行侧唯一物理换算点 = git_exec_path（worktree forward-map——r7 守卫语义）。

use tauri::State;

/// 只读动作集合（退役前 manifest.json 声明 family "Read" 的同一五工具）。
fn is_read_only(action: &str) -> bool {
    matches!(
        action,
        "git_status" | "git_diff_unstaged" | "git_diff_staged" | "git_log" | "git_blame"
    )
}

/// 写动作 → Git 家族 subcommand（两段闸的子命令位）。映射 = 退役前 manifest
/// permission.subcommand 声明（stage_all 同 stage）。未知动作返回 None。
fn subcommand_of(action: &str) -> Option<&'static str> {
    match action {
        "git_stage" | "git_stage_all" => Some("stage"),
        "git_commit" => Some("commit"),
        "git_push" => Some("push"),
        "git_pull" => Some("pull"),
        "git_init" => Some("init"),
        "git_checkout" => Some("checkout"),
        "git_create_branch" => Some("create_branch"),
        "git_stash_push" => Some("stash_push"),
        "git_stash_pop" => Some("stash_pop"),
        "git_discard" => Some("discard"),
        _ => None,
    }
}

/// git_cap 能力口分派。action ∈ 退役前 builtin.git 16 工具名；返回 run_git
/// stdout 文本（porcelain 解析归 TS——git_status 头解析 / parse_status /
/// git_log \x00 split 在 src-ui/src/agent/git-porcelain.ts）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn git_cap(
    action: String,
    repo_path: String,
    file: Option<String>,
    files: Option<Vec<String>>,
    message: Option<String>,
    branch: Option<String>,
    count: Option<usize>,
    is_agent: bool,
    agent_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    // ── action → 权限形状（未知 action 先显式报错——错误不静默）──
    let read_only = is_read_only(&action);
    let subcommand = subcommand_of(&action);
    if !read_only && subcommand.is_none() {
        return Err(format!("git_cap: 未知 action '{action}'"));
    }

    // ── 口内闸（仅 Agent 路径）。path = forward-map 物理路径（与 dispatch 侧
    // PluginToolAdapter::build 同款——worktree 隔离下规则匹配经 reverse-map
    // 回逻辑路径，adapter 内部处理）。──
    if is_agent {
        let perm_ctx = crate::utils::get_ctx(state)?;
        let physical =
            perm_ctx.forward_map_path(std::path::Path::new(&repo_path), agent_id.as_deref());
        let adapter = crate::permissions::adapter::PluginToolAdapter {
            full_name: format!("plugin:builtin.git.{action}"),
            read_only,
            path: Some(physical.to_string_lossy().to_string()),
            agent_id: agent_id.clone(),
            family: Some(if read_only { "Read" } else { "Git" }),
            command: None,
            subcommand: subcommand.map(String::from),
        };
        crate::utils::check_permission(&adapter, &perm_ctx, app).await?;
    }

    // ── 执行侧唯一物理换算点：agent 有活跃 worktree 隔离时换算进 worktree，
    // 否则原样（无隔离 / 非 agent 幂等）。──
    let exec_path = crate::utils::git_exec_path(&repo_path, is_agent, agent_id.as_deref(), state)?;

    let git_args = git_args(
        &action,
        file.as_deref(),
        files,
        message.as_deref(),
        branch.as_deref(),
        count,
    )?;

    // git_status 失败回空串（退役前插件原语义——状态栏/turn-start 注入对
    // 非仓库路径不报错）；其余 action 错误传播。
    if action == "git_status" {
        return Ok(crate::utils::run_git(exec_path, git_args)
            .await
            .unwrap_or_default());
    }
    let out = crate::utils::run_git(exec_path, git_args).await?;
    // diff/blame 截断保留（blame --line-porcelain 每行源码约 10 行输出，
    // 中等文件即可达 MB 级——退役前插件同款）。
    Ok(match action.as_str() {
        "git_diff_unstaged" | "git_diff_staged" | "git_blame" => crate::utils::truncate_output(&out),
        _ => out,
    })
}

/// action → git 参数向量（纯函数，单测钉行为）。diff 双动作的 file 缺省 "."
/// （2026-09 工具缺陷报告 Bug 3：模型面 schema 一直声明 `default "."`——
/// "If omitted, shows all unstaged changes"——但缺省从未在运行时生效，
/// 缺 file 直报 missing 'file'）。discard 保持必填（丢弃是破坏性动作，
/// 不给缺省全仓兜底）。
fn git_args(
    action: &str,
    file: Option<&str>,
    files: Option<Vec<String>>,
    message: Option<&str>,
    branch: Option<&str>,
    count: Option<usize>,
) -> Result<Vec<String>, String> {
    match action {
        "git_status" => Ok(vec![
            "status".to_string(),
            "--branch".to_string(),
            "--porcelain".to_string(),
        ]),
        "git_diff_unstaged" => Ok(vec![
            "diff".to_string(),
            "--".to_string(),
            file.unwrap_or(".").to_string(),
        ]),
        "git_diff_staged" => Ok(vec![
            "diff".to_string(),
            "--cached".to_string(),
            "--".to_string(),
            file.unwrap_or(".").to_string(),
        ]),
        "git_log" => Ok(vec![
            "log".to_string(),
            format!("-{}", count.unwrap_or(10)),
            "--pretty=format:%H%x00%h%x00%s%x00%an%x00%ai".to_string(),
        ]),
        "git_stage" => {
            let mut a = vec!["add".to_string()];
            a.extend(files.ok_or_else(|| "git_cap git_stage: missing 'files'".to_string())?);
            Ok(a)
        }
        "git_stage_all" => Ok(vec!["add".to_string(), "-A".to_string()]),
        "git_commit" => Ok(vec![
            "commit".to_string(),
            "-m".to_string(),
            message
                .ok_or_else(|| "git_cap git_commit: missing 'message'".to_string())?
                .to_string(),
        ]),
        "git_push" => Ok(vec!["push".to_string()]),
        "git_pull" => Ok(vec!["pull".to_string()]),
        "git_init" => Ok(vec!["init".to_string()]),
        "git_checkout" => Ok(vec![
            "checkout".to_string(),
            branch
                .ok_or_else(|| "git_cap git_checkout: missing 'branch'".to_string())?
                .to_string(),
        ]),
        "git_create_branch" => Ok(vec![
            "checkout".to_string(),
            "-b".to_string(),
            branch
                .ok_or_else(|| "git_cap git_create_branch: missing 'branch'".to_string())?
                .to_string(),
        ]),
        "git_stash_push" => Ok(vec!["stash".to_string(), "push".to_string()]),
        "git_stash_pop" => Ok(vec!["stash".to_string(), "pop".to_string()]),
        "git_discard" => Ok(vec![
            "checkout".to_string(),
            "--".to_string(),
            file.ok_or_else(|| "git_cap git_discard: missing 'file'".to_string())?.to_string(),
        ]),
        "git_blame" => Ok(vec![
            "blame".to_string(),
            "--line-porcelain".to_string(),
            file.ok_or_else(|| "git_cap git_blame: missing 'file'".to_string())?.to_string(),
        ]),
        other => Err(format!("git_cap: 未知 action '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 权限形状锚（退役前 tool_plugins/git/mod.rs tests 同表）：只读五动作 =
    /// Read 家族、无 subcommand（c3 §8「read_only 5 工具走 Read 家族闸分流」）。
    #[test]
    fn read_only_action_table_matches_retired_manifest() {
        for a in ["git_status", "git_diff_unstaged", "git_diff_staged", "git_log", "git_blame"] {
            assert!(is_read_only(a), "{a} 应只读");
            assert_eq!(subcommand_of(a), None, "{a} 不应有 subcommand");
        }
    }

    /// 权限形状锚：写动作 = Git 家族 + subcommand（两段闸的子命令位）。
    #[test]
    fn write_action_subcommand_table_matches_retired_manifest() {
        let expected: &[(&str, &str)] = &[
            ("git_stage", "stage"),
            ("git_stage_all", "stage"),
            ("git_commit", "commit"),
            ("git_push", "push"),
            ("git_pull", "pull"),
            ("git_init", "init"),
            ("git_checkout", "checkout"),
            ("git_create_branch", "create_branch"),
            ("git_stash_push", "stash_push"),
            ("git_stash_pop", "stash_pop"),
            ("git_discard", "discard"),
        ];
        for (a, sub) in expected {
            assert!(!is_read_only(a), "{a} 应非只读");
            assert_eq!(subcommand_of(a), Some(*sub), "{a} subcommand = {sub}");
        }
    }

    /// 未知动作两表皆空——git_cap 入口据此显式报错（不静默 Passthrough）。
    #[test]
    fn unknown_action_has_no_permission_shape() {
        for a in ["git_branch", "git_merge", "rebase", "git_statusx", ""] {
            assert!(!is_read_only(a), "{a} 不应判为只读");
            assert_eq!(subcommand_of(a), None, "{a} 未知动作无权限形状");
        }
    }

    /// 16 工具全集无遗漏（与退役前 manifest.tools 数一致）。
    #[test]
    fn action_table_covers_all_sixteen_tools() {
        let all = [
            "git_status",
            "git_diff_unstaged",
            "git_diff_staged",
            "git_log",
            "git_stage",
            "git_stage_all",
            "git_commit",
            "git_push",
            "git_pull",
            "git_init",
            "git_checkout",
            "git_create_branch",
            "git_stash_push",
            "git_stash_pop",
            "git_discard",
            "git_blame",
        ];
        assert_eq!(all.len(), 16);
        for a in all {
            assert!(
                is_read_only(a) || subcommand_of(a).is_some(),
                "{a} 必须落在只读表或写表之一"
            );
            assert!(
                !(is_read_only(a) && subcommand_of(a).is_some()),
                "{a} 不得同时落在两表"
            );
        }
    }

    // ── git_args 行为锚（2026-09 工具缺陷报告 Bug 3 修复）──

    /// diff 双动作 file 缺省 "."——与模型面 schema 的 default "." 文档
    /// （"If omitted, shows all unstaged changes"）对齐；缺省不再报
    /// missing 'file'。
    #[test]
    fn git_args_diff_defaults_to_dot() {
        let dot = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        assert_eq!(
            git_args("git_diff_unstaged", None, None, None, None, None).unwrap(),
            dot(&["diff", "--", "."])
        );
        assert_eq!(
            git_args("git_diff_staged", None, None, None, None, None).unwrap(),
            dot(&["diff", "--cached", "--", "."])
        );
        // 显式 file 原样透传
        assert_eq!(
            git_args("git_diff_unstaged", Some("src/a.rs"), None, None, None, None).unwrap(),
            dot(&["diff", "--", "src/a.rs"])
        );
    }

    /// 破坏性/行级动作保持必填：discard/blame 无缺省兜底。
    #[test]
    fn git_args_discard_and_blame_still_require_file() {
        assert!(git_args("git_discard", None, None, None, None, None)
            .unwrap_err()
            .contains("missing 'file'"));
        assert!(git_args("git_blame", None, None, None, None, None)
            .unwrap_err()
            .contains("missing 'file'"));
    }

    /// commit 缺 message、stage 缺 files 显式报错（错误不静默）。
    #[test]
    fn git_args_required_params_error_loudly() {
        assert!(git_args("git_commit", None, None, None, None, None)
            .unwrap_err()
            .contains("missing 'message'"));
        assert!(git_args("git_stage", None, None, None, None, None)
            .unwrap_err()
            .contains("missing 'files'"));
        assert!(git_args("git_checkout", None, None, None, None, None)
            .unwrap_err()
            .contains("missing 'branch'"));
    }
}

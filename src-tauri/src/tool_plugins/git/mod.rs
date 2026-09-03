// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

//! builtin.git 插件——内核插件运行时 Phase 3（自 commands/git_cmds.rs 拆出）。
//! 工具面真源 = 同目录 manifest.json（`npm run gen:kernel-manifest git` 发射，
//! schema 字节 = zod 发射序由构造保证）。
//!
//! 权限形状（P2-0 模式）：manifest 声明 permission——status/diff/log/blame 走
//! `Read` 家族（工具级门在 dispatch 侧 adapter）；stage/commit/push/pull/init/
//! checkout/create_branch/stash_push/stash_pop/discard 走 `Git` 家族 + subcommand
//! （原 require_git_dispatch 第二参，GitTool 同款两段：仓库路径读检查 + 子命令
//! 规则）。插件内业务免检化：resolve_read_dispatch / require_git_dispatch 调用
//! 随迁出退役，保留 git_exec_path（agent worktree 隔离的执行路径换算）+ run_git。
//!
//! 单键语言（P2-3 裁决）：模型面键 = manifest 键 = 插件实收键，不新增折写特例。
//! 随迁修复两处存量静默丢参：git_log 的 count（旧 RPC 读 limit，模型传 count
//! 恒被丢、恒用缺省）与 git_create_branch 的 branch（旧 RPC 读 name，模型路径
//! 必报 missing 'name'）——插件按 manifest 键收参，两路皆通。

use serde_json::Value;

use super::manifest::ToolManifest;
use super::plugin::{ToolContext, ToolError, ToolPlugin};

pub struct GitPlugin {
    manifest: ToolManifest,
}

impl GitPlugin {
    pub fn new() -> Self {
        let manifest: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("builtin.git manifest 是随 exe 编译的静态资源");
        Self { manifest }
    }
}

impl Default for GitPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolPlugin for GitPlugin {
    fn id(&self) -> &str {
        "builtin.git"
    }

    fn manifest(&self) -> &ToolManifest {
        &self.manifest
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a ToolContext<'a>,
        tool_name: &'a str,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, ToolError>> + Send + 'a>,
    > {
        Box::pin(async move {
            match tool_name {
                "git_status" => git_status(ctx, &args).await,
                "git_diff_unstaged" => git_diff(ctx, &args, false).await,
                "git_diff_staged" => git_diff(ctx, &args, true).await,
                "git_log" => git_log(ctx, &args).await,
                "git_stage" => git_stage(ctx, &args).await,
                "git_stage_all" => git_stage_all(ctx, &args).await,
                "git_commit" => git_commit(ctx, &args).await,
                "git_push" => git_push(ctx, &args).await,
                "git_pull" => git_pull(ctx, &args).await,
                "git_init" => git_init(ctx, &args).await,
                "git_checkout" => git_checkout(ctx, &args).await,
                "git_create_branch" => git_create_branch(ctx, &args).await,
                "git_stash_push" => git_stash_push(ctx, &args).await,
                "git_stash_pop" => git_stash_pop(ctx, &args).await,
                "git_discard" => git_discard(ctx, &args).await,
                "git_blame" => git_blame(ctx, &args).await,
                other => Err(ToolError::InvalidArgs(format!(
                    "builtin.git: 未知工具 '{other}'"
                ))),
            }
        })
    }
}

// ═══════════════════════════════════════════════════════════════
// 业务（自 commands/git_cmds.rs 原样迁入；参数键 = manifest 语言；
// 权限门在 dispatch 侧 adapter，业务只做 git_exec_path + run_git）
// ═══════════════════════════════════════════════════════════════

/// 仓库执行路径 + 缺参报错的公共腰。
fn repo_of(ctx: &ToolContext<'_>, args: &Value, tool: &str) -> Result<String, ToolError> {
    let path = super::plugin::arg_str(args, "path")
        .ok_or_else(|| ToolError::InvalidArgs(format!("{tool}: missing 'path'")))?;
    crate::utils::git_exec_path(&path, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
        .map_err(ToolError::Tool)
}

/// text 结果直通（dispatch 的 Value::String 分支——Text 铁律）。
fn text(s: String) -> Result<Value, ToolError> {
    Ok(Value::String(s))
}

async fn git_status(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let path = super::plugin::arg_str(args, "path")
        .ok_or_else(|| ToolError::InvalidArgs("git_status: missing 'path'".into()))?;
    let exec_path = crate::utils::git_exec_path(&path, ctx.is_agent, ctx.agent_id.as_deref(), ctx.state)
        .map_err(ToolError::Tool)?;
    let branch_porcelain = crate::utils::run_git(
        exec_path,
        vec!["status".to_string(), "--branch".to_string(), "--porcelain".to_string()],
    )
    .await
    .unwrap_or_default();

    let mut branch = String::new();
    let mut ahead = 0i32;
    let mut behind = 0i32;
    let first_line = branch_porcelain.lines().next().unwrap_or("");
    if let Some(header) = first_line.strip_prefix("## ") {
        if let Some(dot_pos) = header.find("...") {
            branch = header[..dot_pos].to_string();
            let rest = &header[dot_pos..];
            for part in rest.split(['[', ']', ',']) {
                let trimmed = part.trim();
                if let Some(num) = trimmed.strip_prefix("ahead ") {
                    ahead = num.parse().unwrap_or(0);
                } else if let Some(num) = trimmed.strip_prefix("behind ") {
                    behind = num.parse().unwrap_or(0);
                }
            }
        } else {
            branch = header.trim().to_string();
        }
    }

    let porcelain = branch_porcelain
        .lines()
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n");
    let files = crate::utils::parse_status(&porcelain);

    let result = serde_json::json!({
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "files": files,
    });
    Ok(result)
}

async fn git_diff(ctx: &ToolContext<'_>, args: &Value, staged: bool) -> Result<Value, ToolError> {
    let tool = if staged { "git_diff_staged" } else { "git_diff_unstaged" };
    let exec_path = repo_of(ctx, args, tool)?;
    let file = super::plugin::arg_str(args, "file")
        .ok_or_else(|| ToolError::InvalidArgs(format!("{tool}: missing 'file'")))?;
    let mut git_args = vec!["diff".to_string()];
    if staged {
        git_args.push("--cached".to_string());
    }
    git_args.push("--".to_string());
    git_args.push(file);
    let out = crate::utils::run_git(exec_path, git_args)
        .await
        .map(|s| crate::utils::truncate_output(&s))
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_log(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_log")?;
    // 单键语言：manifest 键 count（旧 RPC 读 limit——模型传 count 恒被丢的
    // 存量缺陷随迁移修复；缺省对齐 manifest schema 声明的 10）。
    let n = super::plugin::arg_usize(args, "count").unwrap_or(10);
    let raw = crate::utils::run_git(
        exec_path,
        vec![
            "log".to_string(),
            format!("-{}", n),
            "--pretty=format:%H%x00%h%x00%s%x00%an%x00%ai".to_string(),
        ],
    )
    .await
    .map_err(ToolError::Tool)?;
    let commits: Vec<serde_json::Value> = raw
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\x00').collect();
            if parts.len() >= 5 {
                Some(serde_json::json!({
                    "hash": parts[0],
                    "short": parts[1],
                    "message": parts[2],
                    "author": parts[3],
                    "date": parts[4],
                }))
            } else {
                None
            }
        })
        .collect();
    Ok(serde_json::json!(commits))
}

async fn git_stage(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_stage")?;
    let files: Vec<String> = args
        .get("files")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .ok_or_else(|| ToolError::InvalidArgs("git_stage: missing 'files'".into()))?;
    let mut git_args: Vec<String> = vec!["add".to_string()];
    git_args.extend(files);
    let out = crate::utils::run_git(exec_path, git_args).await.map_err(ToolError::Tool)?;
    text(out)
}

async fn git_stage_all(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_stage_all")?;
    let out = crate::utils::run_git(exec_path, vec!["add".to_string(), "-A".to_string()])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_commit(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_commit")?;
    let message = super::plugin::arg_str(args, "message")
        .ok_or_else(|| ToolError::InvalidArgs("git_commit: missing 'message'".into()))?;
    let out = crate::utils::run_git(exec_path, vec!["commit".to_string(), "-m".to_string(), message])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_push(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_push")?;
    let out = crate::utils::run_git(exec_path, vec!["push".to_string()])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_pull(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_pull")?;
    let out = crate::utils::run_git(exec_path, vec!["pull".to_string()])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_init(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_init")?;
    let out = crate::utils::run_git(exec_path, vec!["init".to_string()])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_checkout(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_checkout")?;
    let branch = super::plugin::arg_str(args, "branch")
        .ok_or_else(|| ToolError::InvalidArgs("git_checkout: missing 'branch'".into()))?;
    let out = crate::utils::run_git(exec_path, vec!["checkout".to_string(), branch])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_create_branch(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_create_branch")?;
    // 单键语言：manifest 键 branch（旧 RPC 读 name——模型路径必报
    // missing 'name' 的存量缺陷随迁移修复）。
    let branch = super::plugin::arg_str(args, "branch")
        .ok_or_else(|| ToolError::InvalidArgs("git_create_branch: missing 'branch'".into()))?;
    let out = crate::utils::run_git(exec_path, vec!["checkout".to_string(), "-b".to_string(), branch])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_stash_push(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_stash_push")?;
    // message 是 schema 声明的可选识别参数——旧业务即不传给 git（保持原样，
    // 迁移不改行为；补 -m 属功能增项，另行立项）。
    let out = crate::utils::run_git(exec_path, vec!["stash".to_string(), "push".to_string()])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_stash_pop(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_stash_pop")?;
    let out = crate::utils::run_git(exec_path, vec!["stash".to_string(), "pop".to_string()])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_discard(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_discard")?;
    let file = super::plugin::arg_str(args, "file")
        .ok_or_else(|| ToolError::InvalidArgs("git_discard: missing 'file'".into()))?;
    let out = crate::utils::run_git(exec_path, vec!["checkout".to_string(), "--".to_string(), file])
        .await
        .map_err(ToolError::Tool)?;
    text(out)
}

async fn git_blame(ctx: &ToolContext<'_>, args: &Value) -> Result<Value, ToolError> {
    let exec_path = repo_of(ctx, args, "git_blame")?;
    let file = super::plugin::arg_str(args, "file")
        .ok_or_else(|| ToolError::InvalidArgs("git_blame: missing 'file'".into()))?;
    // blame --line-porcelain 每行源码约 10 行输出，中等文件即可达 MB 级，必须截断
    let out = crate::utils::run_git(
        exec_path,
        vec!["blame".to_string(), "--line-porcelain".to_string(), file],
    )
    .await
    .map(|s| crate::utils::truncate_output(&s))
    .map_err(ToolError::Tool)?;
    text(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_json_parses_and_matches_id() {
        let m: ToolManifest = serde_json::from_str(include_str!("manifest.json"))
            .expect("出厂 manifest 是编译期静态资源");
        assert_eq!(m.id, "builtin.git");
        assert_eq!(m.trust, super::super::manifest::TrustLevel::System);
        assert_eq!(m.tools.len(), 16);
        // 权限声明形状（P2-3 裁决）：读族 status/diff/log/blame = Read 家族；
        // 写族 = Git 家族 + subcommand（原 require_git_dispatch 第二参）。
        for name in ["git_status", "git_diff_unstaged", "git_diff_staged", "git_log", "git_blame"] {
            let t = m.tools.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("{name} 在清单内"));
            assert!(t.read_only, "{name} 应只读");
            let perm = t.permission.as_ref().unwrap_or_else(|| panic!("{name} 声明 permission"));
            assert_eq!(perm.family, "Read", "{name} = Read 家族");
            assert_eq!(perm.path_key.as_deref(), Some("path"), "{name} path_key = path");
        }
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
        for (name, sub) in expected {
            let t = m.tools.iter().find(|t| t.name == *name).unwrap_or_else(|| panic!("{name} 在清单内"));
            assert!(!t.read_only, "{name} 应非只读");
            let perm = t.permission.as_ref().unwrap_or_else(|| panic!("{name} 声明 permission"));
            assert_eq!(perm.family, "Git", "{name} = Git 家族");
            assert_eq!(perm.subcommand.as_deref(), Some(*sub), "{name} subcommand = {sub}");
            assert_eq!(perm.path_key.as_deref(), Some("path"), "{name} path_key = path");
        }
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// editor 能力口（R4 小面清偿收官，kernel-capability-d4-handle-design.md §6
// R4-4b）——edit_file 直呼入口，不经 tool_call 信封（信封与 PluginRegistry
// 脚手架已随 R5 拆除；builtin.editor 插件随 R4-4b 退役）。
//
// 口内闸（git_cap 同形——editor 的权限门本在 dispatch 侧 adapter）：Agent
// 路径构造 PluginToolAdapter（Edit 家族 + 精确名寻址保留
// plugin:builtin.editor.edit_file——用户既有规则不失义；path =
// forward_map_path 物理路径，worktree 隔离规则经 adapter 内部 reverse-map）；
// 用户路径零规则零弹窗（dispatch P2-0 §3.5 同款）。口内业务用免检解析
// （resolve_write_unchecked / read_text_unchecked——闸已在口内过，插件原
// 语义）；checked_write_atomic 进程级锁 + 命令内重试环原样保留
// （INVARIANTS：并发安全在 Rust 临界区）。
//
// 键语言：模型面 schema 键 = camelCase（filePath/oldString/newString/
// replaceAll）；口收与业务解析统一顶层 snake（file_path/old_string/
// new_string/replace_all）——映射在 TS execute 层完成（R4-4b 后信封的 bridge
// camelCase 化已不存在，camelCase 是死语言，业务解析不读）。_forceGate 为
// 模型面 schema 声明键（架构门禁），executor 消费，原样透传不映射。
// 返回 Text（diff 快照文本直通）。

use serde_json::Value;
use tauri::State;

/// 编辑业务错误信封（自 tool_plugins/plugin.rs 本地化，R5 脚手架拆除——
/// editor_cap 是唯一消费者）。边界上经 `message()` 折成 RPC 错误字符串。
#[derive(Debug)]
enum ToolError {
    /// 参数缺失/非法（schema 之外的契约违规）。
    InvalidArgs(String),
    /// 工具业务失败。
    /// （Permission 变体已随 R4-4b builtin.* 插件全退役删除——能力口错误串
    ///  自带「权限拒绝: 」前缀，不再经 ToolError 折叠。）
    Tool(String),
}

impl ToolError {
    fn message(&self) -> String {
        match self {
            ToolError::InvalidArgs(m) => m.clone(),
            ToolError::Tool(m) => m.clone(),
        }
    }
}

/// 口内业务上下文（ToolContext 的 editor 面投影——业务只消费身份与 state）。
pub(crate) struct EditorCtx<'a> {
    pub is_agent: bool,
    pub agent_id: Option<String>,
    pub state: &'a State<'a, crate::WorkspaceState>,
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
}

fn arg_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

/// 进程级编辑写锁 — 序列化「重读校验 → 原子写入」临界区。
/// 否则两个并发 edit_file 可双双通过乐观检查后互相覆盖（TOCTOU），
/// 双双报成功，后写者静默吞掉先写者的改动。
static EDIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 乐观并发检查 + 原子写入，在同一临界区内完成（fail-closed）。
/// - 重读文件与 expected_base 不一致 → 拒绝写入（并发修改）；
/// - 重读失败 → Err：无法校验并发安全时不得静默写入；
/// - 锁仅覆盖检查+写入，timeline 记录等后续动作由调用方在锁外完成。
pub(crate) fn checked_write_atomic(
    file_path: &str,
    expected_base: &str,
    new_content: &str,
) -> Result<(), String> {
    let _guard = EDIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let current = std::fs::read_to_string(file_path).map_err(|e| {
        format!("无法重读文件以校验并发安全，已取消写入: {file_path}: {e}")
    })?;
    if current != expected_base {
        return Err(format!(
            "文件在编辑过程中被并发修改，请重试（old_string 基于旧内容）: {}",
            file_path
        ));
    }
    crate::utils::write_atomic(file_path, new_content)
}

/// 写盘成功后的副作用：timeline 记录 + changed_files 登记。
///
/// 引擎调用（`engine_record_timeline` → 全局 `ENGINE.read()`）可能阻塞
/// ——引擎初始化/工作区切换期间写锁被持有。因此先把 `changed_files`
/// 的 Arc 克隆出来并**释放 WorkspaceState 锁**，再调引擎：否则一旦
/// 引擎侧阻塞，WorkspaceState 会被一并长期持有，所有需要 state 的
/// 命令（读写/git/shell/权限回包）全部排队，单工具挂起放大为全会话死亡。
fn record_edit_side_effects(state: &crate::WorkspaceState, file_path: &str) {
    let changed_files = {
        let guard = crate::utils::lock_or_recover(state);
        guard.as_ref().map(|h| h.changed_files.clone())
    };
    let Some(changed_files) = changed_files else {
        return;
    };
    if crate::ignored_paths::is_ignored_path(file_path) {
        return;
    }
    let short = file_path.rsplit(['/', '\\']).next().unwrap_or(file_path);
    // Phase 3：timeline 落工作区引擎进程（transport timeline_record；占位
    // 工作区无传输，不记录）。
    let transport = {
        let guard = crate::utils::lock_or_recover(state);
        guard.as_ref().and_then(|h| h.transport.clone())
    };
    // fire-and-forget：引擎往返（3600s 超时）不得内联在 edit 命令线程上——
    // 锁纪律只保证不拖死其它命令，detach 才保证 edit 本身不被引擎拖住。
    crate::utils::record_timeline_transport_detached(
        transport,
        "agent_edit",
        Some(file_path),
        &format!("Agent 编辑: {}", short),
    );
    if let Ok(mut changed) = changed_files.lock() {
        let owned = file_path.to_string();
        if !changed.contains(&owned) {
            changed.push(owned);
        }
    };
}

/// old_string 未命中时错误消息里的键截断（≈60 字节预算）。
/// 必须按字符边界回退：`&s[..60]` 在 CJK 混合行的第 60 字节落在
/// 多字节字符中间时 panic（回归测试 truncate_err_key_cjk_mixed_line_no_panic）。
fn truncate_err_key(first_line: &str) -> &str {
    if first_line.len() <= 60 {
        return first_line;
    }
    let mut end = 60;
    while end > 0 && !first_line.is_char_boundary(end) {
        end -= 1;
    }
    &first_line[..end]
}

/// edit_file 参数（口收顶层 snake 键——契约见 editor_cap 分派头注；键名与本
/// 文件头注「口收顶层 snake（file_path/old_string/new_string/replace_all）」
/// 同源。R4-4b 从 builtin.editor 插件迁入时业务逐行照搬、把插件 manifest 的
/// camelCase 键（filePath/oldString/…）原样留在了解析点——信封时代 args 经
/// bridge camelCase 化，能力口时代 TS execute 直映 snake，键语言已切换，业务
/// 解析必须说 snake。2026-09 bug 报告：fs(edit) 三种写法全报
/// "edit_file: missing 'filePath'"（file_path 明明已传）——分派侧读 snake 过
/// 闸、业务侧读 camelCase 全空。
#[derive(Debug)]
struct EditArgs {
    file_path: String,
    old_string: String,
    new_string: String,
    replace_all: bool,
}

/// 免检解析 edit_file 参数（键 = snake，能力口契约语言）。业务与回归测试共用
/// ——参数契约的单一解析点，防「schema 键 / 口收键 / 业务键」三处再漂移。
fn parse_edit_args(args: &Value) -> Result<EditArgs, ToolError> {
    let missing = |k: &str| ToolError::InvalidArgs(format!("edit_file: missing '{k}'"));
    let file_path = arg_str(args, "file_path").ok_or_else(|| missing("file_path"))?;
    let old_string = arg_str(args, "old_string").ok_or_else(|| missing("old_string"))?;
    let new_string = arg_str(args, "new_string").ok_or_else(|| missing("new_string"))?;
    let replace_all = arg_bool(args, "replace_all").unwrap_or(false);
    Ok(EditArgs {
        file_path,
        old_string,
        new_string,
        replace_all,
    })
}

/// edit_file — 精确字符串替换 + 真实行级 diff（业务自 commands/editor.rs 原样
/// 迁入；参数键说能力口顶层 snake 的语言——见 parse_edit_args；解析走免检变体
/// ——Edit 家族工具级门已在 dispatch 侧过闸）。
async fn edit_file(ctx: &EditorCtx<'_>, args: &Value) -> Result<Value, ToolError> {
    let EditArgs {
        file_path,
        old_string,
        new_string,
        replace_all,
    } = parse_edit_args(args)?;
    let is_agent = ctx.is_agent;
    let agent_id = ctx.agent_id.as_deref();
    let state = ctx.state;

    let resolved = crate::utils::resolve_write_unchecked(&file_path, is_agent, agent_id, state)
        .map_err(ToolError::Tool)?;
    let file_path = resolved.to_string_lossy().to_string();

    // 并发门禁摘除（2026-08-30 用户拍板：拒绝+模型重试 = 往返/token 浪费）：
    // EDIT_LOCK 内重读校验发现内容漂移时，本命令内重读重算（≤3 次），
    // 模型零感知零往返。old_string 锚即冲突检测器——锚还在（非冲突的
    // 并行编辑）→ 直接落盘；锚没了 → 走常规 not-found/不唯一语义。
    // 2026-08-13 事故的保留项只有「绝不基于过期内容落盘」，重试环在
    // Rust 内闭合，不再外溢为模型侧重试风暴。
    const EDIT_RACE_ATTEMPTS: usize = 3;
    'retry: for attempt in 0..EDIT_RACE_ATTEMPTS {
    // 循环体保持原缩进（机械包裹，避免整段重排的 diff 噪声）
    let (_, content) = crate::confined_fs::read_text_unchecked(&file_path, is_agent, agent_id, state, false, None, None)
        .await
        .map_err(ToolError::Tool)?;

    if old_string.is_empty() {
        return Err(ToolError::InvalidArgs("old_string 不能为空".to_string()));
    }

    // 容错模式的替换执行（写回 out 后返回 diff 快照）
    let fallback = |start: usize, old_lines: &[&str], new_ls: &[&str], file_lines: &[&str]| -> String {
        let mut out = String::new();
        for l in &file_lines[..start] { out.push_str(l); out.push('\n'); }
        for nl in new_ls { out.push_str(nl); out.push('\n'); }
        for l in &file_lines[start + old_lines.len()..] {
            out.push_str(l); out.push('\n');
        }
        out
    };

    let count = if replace_all {
        content.matches(&old_string).count()
    } else {
        let c = content.matches(&old_string).count();
        if c == 0 {
            // Whitespace-tolerant: match line-by-line after trimming each line.
            let old_lines: Vec<&str> = old_string.lines().collect();
            if !old_lines.is_empty() {
                let file_lines: Vec<&str> = content.lines().collect();
                let first_trimmed = old_lines[0].trim();
                for start in 0..file_lines.len() {
                    if file_lines[start].trim() != first_trimmed { continue; }
                    let mut matched = true;
                    for k in 1..old_lines.len() {
                        if start + k >= file_lines.len()
                            || file_lines[start + k].trim() != old_lines[k].trim()
                        { matched = false; break; }
                    }
                    if matched && start + old_lines.len() <= file_lines.len() {
                        // 写回时 new_string 按调用者原样（每行保留自身缩进），
                        // 不再做「首行补 prefix、后续行 trim」的不可预测改写。
                        let new_ls: Vec<&str> = new_string.lines().collect();
                        let mut out = fallback(start, &old_lines, &new_ls, &file_lines);
                        // 保持原文件的末尾换行状态：原文件无末尾换行则不补。
                        // （此前 trim_end_matches('\n') 会删掉所有末尾换行，
                        //   导致每次容错编辑后文件变成 no-newline-at-EOF。）
                        if !content.ends_with('\n') && out.ends_with('\n') {
                            out.pop();
                        }
                        // 乐观并发检查 + 原子写入在同一临界区（锁内重读校验，
                        // fail-closed）；timeline 记录等后续动作在锁外。
                        // 内容漂移 → 命令内重读重算，不惊动模型。
                        match checked_write_atomic(&file_path, &content, &out) {
                            Ok(()) => {}
                            Err(e)
                                if (e.contains("并发修改") || e.contains("无法重读"))
                                    && attempt + 1 < EDIT_RACE_ATTEMPTS =>
                            {
                                continue 'retry;
                            }
                            Err(e) => return Err(ToolError::Tool(e)),
                        }
                        record_edit_side_effects(state, &file_path);
                        let match_line = start + 1;
                        let ds = build_line_diff(&content, &out);
                        return Ok(Value::String(format!(
                            "已替换 1 处匹配（容错模式：逐行对齐）— {} (第 {} 行附近)\n```diff\n{}\n```",
                            file_path, match_line, ds
                        )));
                    }
                    break;
                }
            }
            let first_line = old_string.lines().next().unwrap_or("(empty)");
            let best = crate::utils::fuzzy_find(&content, first_line);
            let hint = match best {
                Some((ln, ctxx)) => format!("line {}: {}", ln, ctxx),
                None => format!("file starts: {}",
                    content.lines().take(3).collect::<Vec<_>>().join(" | ")),
            };
            let key = truncate_err_key(first_line);
            return Err(ToolError::Tool(format!("not found: \"{}\" | {}", key, hint)));
        }
        if c > 1 {
            return Err(ToolError::Tool(format!(
                "old_string 在文件中出现了 {} 次，不是唯一的。请添加更多上下文使其唯一，或设置 replace_all: true。",
                c
            )));
        }
        c
    };

    let new_content = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };

    // 乐观并发检查 + 原子写入在同一临界区（锁内重读校验，fail-closed）。
    // 内容漂移 → 命令内重读重算，不惊动模型。
    match checked_write_atomic(&file_path, &content, &new_content) {
        Ok(()) => {}
        Err(e)
            if (e.contains("并发修改") || e.contains("无法重读")) && attempt + 1 < EDIT_RACE_ATTEMPTS =>
        {
            continue 'retry;
        }
        Err(e) => return Err(ToolError::Tool(e)),
    }

    record_edit_side_effects(state, &file_path);

    let first_match_line = content.lines()
        .enumerate()
        .find(|(_, l)| l.contains(old_string.lines().next().unwrap_or("")))
        .map(|(i, _)| i + 1)
        .unwrap_or(0);
    let line_info = if first_match_line > 0 {
        format!(" (第 {} 行附近)", first_match_line)
    } else {
        String::new()
    };

    // 真实 before/after 行级 diff — 模型看到的就是文件里实际发生的变化
    // （此前按 old_string 伪造的 snippet 在行内替换/replace_all 时会误导）。
    let diff_snippet = build_line_diff(&content, &new_content);

    return Ok(Value::String(if replace_all {
        format!(
            "已替换 {} 处匹配 — {}{}\n```diff\n{}\n```",
            count, file_path, line_info, diff_snippet
        )
    } else {
        format!(
            "已替换 1 处匹配 — {}{}\n```diff\n{}\n```",
            file_path, line_info, diff_snippet
        )
    }));
    }
    // 防御性不可达：每轮必以 return/continue 收束；末轮并发拒绝也直返 Err。
    Err(ToolError::Tool("文件被高频并发修改，编辑未落地，请重读后重试".to_string()))
}

// ═══════════════════════════════════════════════════════════
// 真实行级 diff（2026-08：替代伪造 snippet，防止模型误解改动范围）
// ═══════════════════════════════════════════════════════════
// 对替换前/后内容做行级 LCS diff，输出标准 unified diff 格式：
// @@ 头在上下文之前、每个 hunk 独立头、间隔 ≤ 2*CTX 的变化合并
// （git 行为）。行内子串替换只显示那一行的 - / +（真实差异）；
// replace_all 显示全部 hunk；容错模式显示实际写入前后的差异。
// 模型看到的永远是文件里真实发生的变化。

#[derive(Clone, Copy, PartialEq, Eq)]
enum DiffOp {
    Keep,
    Del,
    Ins,
}

/// 行级 diff — O(n*m) DP + 回溯。编辑场景文件通常在几百行内，足够快。
fn line_diff(a: &[&str], b: &[&str]) -> Vec<DiffOp> {
    let n = a.len();
    let m = b.len();
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut ops = Vec::with_capacity(n + m);
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push(DiffOp::Keep);
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            ops.push(DiffOp::Del);
            i += 1;
        } else {
            ops.push(DiffOp::Ins);
            j += 1;
        }
    }
    while i < n {
        ops.push(DiffOp::Del);
        i += 1;
    }
    while j < m {
        ops.push(DiffOp::Ins);
        j += 1;
    }
    ops
}

/// 渲染标准 unified diff：每个 hunk 以 @@ 头开始，前后各 3 行上下文；
/// 间隔 ≤ 2*CTX 的变化区间合并为一个 hunk（git 行为）；超长截断保护。
fn build_line_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let n = a.len();
    let m = b.len();
    if a == b {
        return String::new();
    }

    // 公共前缀/后缀夹逼 — 缩小 DP 区间：大文件的一次编辑只对比中间变化段。
    let mut pre = 0;
    while pre < n && pre < m && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < n - pre && suf < m - pre && a[n - 1 - suf] == b[m - 1 - suf] {
        suf += 1;
    }
    let mid_a = &a[pre..n - suf];
    let mid_b = &b[pre..m - suf];
    let mid_ops = if mid_a.len() * mid_b.len() > 4_000_000 {
        // 超大中间段：整体视为变化（避免 O(n*m) 内存爆炸）
        let mut v = Vec::with_capacity(mid_a.len() + mid_b.len());
        v.resize(mid_a.len(), DiffOp::Del);
        v.resize(mid_a.len() + mid_b.len(), DiffOp::Ins);
        v
    } else {
        line_diff(mid_a, mid_b)
    };
    let mut ops = Vec::with_capacity(n + m);
    ops.resize(pre, DiffOp::Keep);
    let mid_len = mid_ops.len();
    ops.extend(mid_ops);
    ops.resize(pre + mid_len + suf, DiffOp::Keep);

    // 每个 op 位置两侧的 0-based 行游标（= 该 op 之前已消费的行数）。
    // Keep/Del 的行文本 = a[a_pos[idx]]；Keep/Ins 的行文本 = b[b_pos[idx]]。
    let mut a_pos = vec![0usize; ops.len()];
    let mut b_pos = vec![0usize; ops.len()];
    {
        let (mut ai, mut bi) = (0usize, 0usize);
        for (idx, op) in ops.iter().enumerate() {
            a_pos[idx] = ai;
            b_pos[idx] = bi;
            match op {
                DiffOp::Keep => {
                    ai += 1;
                    bi += 1;
                }
                DiffOp::Del => ai += 1,
                DiffOp::Ins => bi += 1,
            }
        }
    }

    const CTX: usize = 3;
    const MAX_LINES: usize = 400;

    // 变化区间（ops 下标，半开）；间隔 ≤ 2*CTX 的相邻区间合并为一个 hunk。
    let mut regions: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < ops.len() {
        if ops[i] == DiffOp::Keep {
            i += 1;
            continue;
        }
        let s = i;
        while i < ops.len() && ops[i] != DiffOp::Keep {
            i += 1;
        }
        match regions.last_mut() {
            Some(last) if s - last.1 <= 2 * CTX => last.1 = i,
            _ => regions.push((s, i)),
        }
    }
    if regions.is_empty() {
        return String::new();
    }

    let mut out = String::new();
    let mut emitted = 0usize;
    let mut truncated = false;
    let mut prev_end = 0usize;
    'hunks: for (hidx, &(rs, re)) in regions.iter().enumerate() {
        // 上下文：首 hunk 之前/末 hunk 之后按文件边界收敛；hunk 间距 > 2*CTX
        // 保证相邻 hunk 的上下文不重叠。
        let lead = CTX.min(rs - prev_end);
        let trail = if hidx + 1 < regions.len() {
            CTX
        } else {
            CTX.min(ops.len() - re)
        };
        let s0 = rs - lead;
        let e0 = (re + trail).min(ops.len());
        prev_end = re;

        let a_count = ops[s0..e0].iter().filter(|o| **o != DiffOp::Ins).count();
        let b_count = ops[s0..e0].iter().filter(|o| **o != DiffOp::Del).count();
        // 起点行号（1-based，含上下文行）：锚定区间内首条本侧行；纯插入/纯删除
        // （count = 0）时锚点为插入点前的行数（git 约定的 -k,0 / +k,0）。
        let a_start = ops[s0..e0]
            .iter()
            .position(|o| *o != DiffOp::Ins)
            .map(|p| a_pos[s0 + p] + 1)
            .unwrap_or(a_pos[s0]);
        let b_start = ops[s0..e0]
            .iter()
            .position(|o| *o != DiffOp::Del)
            .map(|p| b_pos[s0 + p] + 1)
            .unwrap_or(b_pos[s0]);
        out.push_str(&format!("@@ -{},{} +{},{} @@\n", a_start, a_count, b_start, b_count));
        emitted += 1;

        for (idx, op) in ops.iter().enumerate().take(e0).skip(s0) {
            if emitted >= MAX_LINES {
                truncated = true;
                break 'hunks;
            }
            let (prefix, text) = match op {
                DiffOp::Keep => ("  ", a[a_pos[idx]]),
                DiffOp::Del => ("- ", a[a_pos[idx]]),
                DiffOp::Ins => ("+ ", b[b_pos[idx]]),
            };
            out.push_str(prefix);
            out.push_str(text);
            out.push('\n');
            emitted += 1;
        }
    }
    if truncated {
        out.push_str(&format!("...(diff 过长已截断，仅显示前 {} 行)", MAX_LINES));
    }
    out.trim_end().to_string()
}

// ═══════════════════════════════════════════════════════════════
// 分派与入口
// ═══════════════════════════════════════════════════════════════

/// editor_cap 能力口分派（R4-4b 立口即唯一入口——builtin.editor 同批退役，
/// 无信封过渡面）。action = 退役前 builtin.editor 唯一工具名 edit_file；
/// 参数顶层 snake；返回文本（diff 快照）。
pub(crate) async fn editor_cap(
    action: String,
    params: Value,
    is_agent: bool,
    agent_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    if action != "edit_file" {
        return Err(format!("editor_cap: 未知 action '{action}'"));
    }
    // 口内闸（仅 Agent 路径——dispatch adapter 原语义）：Edit 家族 + 精确名
    // plugin:builtin.editor.edit_file（用户既有规则不失义）。
    if is_agent {
        let file_path = arg_str(&params, "file_path")
            .ok_or_else(|| "edit_file: missing 'file_path'".to_string())?;
        let perm_ctx = crate::utils::get_ctx(state)?;
        let physical =
            perm_ctx.forward_map_path(std::path::Path::new(&file_path), agent_id.as_deref());
        let adapter = crate::permissions::adapter::PluginToolAdapter {
            full_name: "plugin:builtin.editor.edit_file".to_string(),
            read_only: false,
            path: Some(physical.to_string_lossy().to_string()),
            agent_id: agent_id.clone(),
            family: Some("Edit"),
            command: None,
            subcommand: None,
        };
        crate::utils::check_permission(&adapter, &perm_ctx, app).await?;
    }
    let ctx = EditorCtx {
        is_agent,
        agent_id,
        state,
    };
    let out = edit_file(&ctx, &params).await.map_err(|e| e.message())?;
    // 值形态分流（dispatch 原语义）：文本字节直通，结构化 JSON 序列化。
    Ok(match out {
        Value::String(s) => s,
        other => other.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff_of(before: &str, after: &str) -> String {
        build_line_diff(before, after)
    }

    /// 回归（edit 偶发挂死根因）：old_string 未命中时的错误键截断必须
    /// 容忍多字节字符。旧实现 `&first_line[..60]` 按字节切片，CJK 混合
    /// 行第 60 字节落在字符中间会 panic——而 Tauri 异步命令 panic 不回包
    /// （resolver 随 task 一起被丢弃），前端 edit_file invoke 永久挂起且
    /// 无任何日志痕迹（panic 只进 stderr）。
    #[test]
    fn truncate_err_key_cjk_mixed_line_no_panic() {
        // 4 字节 ASCII 前缀 + CJK（每字 3 字节）：字节 60 恰好落在
        // 第 19 个 CJK 字符内部 → 旧实现在此 panic。
        let line = format!("// ab{}", "中".repeat(30));
        assert!(line.len() > 60, "测试前提：首行超过 60 字节");
        let key = truncate_err_key(&line);
        assert!(key.len() <= 60, "截断键不应超过 60 字节");
        assert!(key.starts_with("// ab"));
    }

    #[test]
    fn truncate_err_key_ascii_unchanged() {
        let line = "fn short_call() {".repeat(10);
        assert_eq!(truncate_err_key(&line), &line[..60]);
        assert_eq!(truncate_err_key("short"), "short");
    }

    /// 回归（2026-09 fs(edit) bug 报告）：能力口契约 = 顶层 snake 键，业务解析
    /// 必须说 snake。R4-4b 从 builtin.editor 插件迁入时把插件 manifest 的
    /// camelCase 键（filePath/oldString/…）原样留在了解析点——TS execute 直映
    /// snake（file_path/old_string/…），业务侧读 camelCase 全空 →
    /// "edit_file: missing 'filePath'"（file_path 明明已传）。契约语言锚死：
    /// snake 键必须解析出全量参数；camelCase 键是死语言（信封已拆，不得复活）。
    #[test]
    fn parse_edit_args_reads_snake_keys() {
        let args = serde_json::json!({
            "action": "edit_file",
            "file_path": "D:/proj/a.ts",
            "old_string": "foo",
            "new_string": "bar",
            "replace_all": true,
            "_agent_id": "agent-123", // meta 原样透传，不参与业务解析
        });
        let parsed = parse_edit_args(&args).expect("snake 键必须解析成功");
        assert_eq!(parsed.file_path, "D:/proj/a.ts");
        assert_eq!(parsed.old_string, "foo");
        assert_eq!(parsed.new_string, "bar");
        assert!(parsed.replace_all);
    }

    #[test]
    fn parse_edit_args_rejects_camel_case_and_missing() {
        // camelCase 是信封时代死语言——能力口直呼后不得复活
        let camel = serde_json::json!({
            "filePath": "D:/proj/a.ts",
            "oldString": "foo",
            "newString": "bar",
        });
        let err = parse_edit_args(&camel).unwrap_err();
        assert!(
            err.message().contains("missing 'file_path'"),
            "got: {}",
            err.message()
        );
        // 缺键响亮报错（schema 之外的契约违规），不静默兜底
        let none = serde_json::json!({});
        let err2 = parse_edit_args(&none).unwrap_err();
        assert!(
            err2.message().contains("missing 'file_path'"),
            "got: {}",
            err2.message()
        );
        // replace_all 缺省 false
        let minimal = serde_json::json!({
            "file_path": "a.ts", "old_string": "x", "new_string": "y",
        });
        let parsed = parse_edit_args(&minimal).expect("snake 最小集必须解析成功");
        assert!(!parsed.replace_all);
    }

    #[test]
    fn diff_no_change_is_empty() {
        assert_eq!(diff_of("a\nb\nc\n", "a\nb\nc\n"), "");
    }

    #[test]
    fn diff_inline_substring_replacement_shows_only_that_line() {
        // 行内替换 — 旧实现会把整行标 - / + 之外还伪造上下文；现在只显示真实变化。
        let d = diff_of("line one\nfoo bar baz\nline three\n", "line one\nfoo QUX baz\nline three\n");
        assert!(d.contains("- foo bar baz"), "unexpected diff: {d}");
        assert!(d.contains("+ foo QUX baz"), "unexpected diff: {d}");
        assert!(!d.contains("- line one"), "unchanged line must not be removed: {d}");
        assert!(!d.contains("- line three"), "unchanged line must not be removed: {d}");
        // 尾部上下文行按标准 unified diff 正常显示（hunk 紧邻行）
        assert!(d.contains("  line three"), "tail context missing: {d}");
    }

    #[test]
    fn diff_multiline_replacement() {
        let d = diff_of("a\nold1\nold2\nz\n", "a\nnew1\nnew2\nnew3\nz\n");
        assert!(d.contains("- old1"), "unexpected diff: {d}");
        assert!(d.contains("- old2"), "unexpected diff: {d}");
        assert!(d.contains("+ new1"), "unexpected diff: {d}");
        assert!(d.contains("+ new2"), "unexpected diff: {d}");
        assert!(d.contains("+ new3"), "unexpected diff: {d}");
    }

    #[test]
    fn diff_multiple_hunks_all_shown() {
        // replace_all 场景：两处相距 > 2*CTX 行的修改必须是两个独立 hunk，
        // 各自带 @@ 头（回归：旧渲染器 off-by-one 导致第二个 hunk 起丢头，
        // 无头变化直接拼接在上一 hunk 尾部，严重误导模型）。
        let mids = (0..10).map(|i| format!("mid{i}")).collect::<Vec<_>>().join("\n");
        let before = format!("x1\n{mids}\nx2\n");
        let after = before.replacen("x1", "y1", 1).replacen("x2", "y2", 1);
        let d = diff_of(&before, &after);
        assert!(d.contains("- x1"), "hunk 1 missing: {d}");
        assert!(d.contains("+ y1"), "hunk 1 missing: {d}");
        assert!(d.contains("- x2"), "hunk 2 missing: {d}");
        assert!(d.contains("+ y2"), "hunk 2 missing: {d}");
        assert_eq!(d.matches("@@ -").count(), 2, "expected 2 hunk headers: {d}");
        assert!(d.contains("@@ -1,4 +1,4 @@"), "hunk 1 header: {d}");
        assert!(d.contains("@@ -9,4 +9,4 @@"), "hunk 2 header: {d}");
    }

    #[test]
    fn diff_close_changes_merge_into_one_hunk() {
        // 间隔 ≤ 2*CTX 的变化合并为一个 hunk（git 行为），不得出现无头变化段。
        let d = diff_of("a\nx1\nb\nx2\nc\n", "a\ny1\nb\ny2\nc\n");
        assert_eq!(d.matches("@@ -").count(), 1, "expected 1 merged hunk: {d}");
        assert!(d.contains("- x1"), "unexpected diff: {d}");
        assert!(d.contains("+ y2"), "unexpected diff: {d}");
    }

    #[test]
    fn diff_header_line_numbers() {
        // 标准 unified diff：@@ 头在最前，行号含上下文行。
        // 文件头插入（全文仅 2 行，全部成为上下文）→ @@ -1,2 +1,3 @@
        let d = diff_of("a\nb\n", "new\na\nb\n");
        assert!(d.starts_with("@@ -1,2 +1,3 @@\n+ new\n  a\n  b"), "unexpected diff: {d}");
        // 第 2 行替换（3 行文件全上下文）→ @@ -1,3 +1,3 @@
        let d2 = diff_of("a\nold\nc\n", "a\nnew\nc\n");
        assert!(d2.starts_with("@@ -1,3 +1,3 @@\n  a\n- old\n+ new\n  c"), "unexpected diff: {d2}");
        // 纯插入且前方无上下文 → git 约定锚点 -k,0
        let d3 = diff_of("", "x\n");
        assert!(d3.starts_with("@@ -0,0 +1,1 @@"), "unexpected diff: {d3}");
    }

    #[test]
    fn diff_whitespace_preserved() {
        // 容错模式：缩进差异必须原样显示（trim 会误导模型）。
        let d = diff_of("fn a() {\n    let x = 1;\n}\n", "fn a() {\n  let x = 1;\n}\n");
        assert!(d.contains("-     let x = 1;"), "indentation lost: {d}");
        assert!(d.contains("+   let x = 1;"), "indentation lost: {d}");
    }

    #[test]
    fn diff_truncation_guard() {
        // 全量变化（500 Del + 500 Ins）远超 400 行上限 → 必须截断并注明。
        let before = (0..500).map(|i| format!("old line {i}")).collect::<Vec<_>>().join("\n");
        let after = (0..500).map(|i| format!("new line {i}")).collect::<Vec<_>>().join("\n");
        let d = diff_of(&before, &after);
        assert!(d.contains("已截断"), "expected truncation note: {d:?}");
    }

    // ── checked_write_atomic：乐观并发检查 + 原子写入（TOCTOU/fail-open 修复）──

    /// 独立临时子目录（测试后由用例自行清理）。
    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hologram_test_checked_write_{}_{}_{}",
            std::process::id(),
            tag,
            SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// (a) base 正确 → Ok 且内容落盘。
    #[test]
    fn checked_write_ok_when_base_matches() {
        let dir = tmp_dir("ok");
        let f = dir.join("a.txt");
        let fs = f.to_string_lossy().to_string();
        std::fs::write(&f, "v1\n").unwrap();
        checked_write_atomic(&fs, "v1\n", "v2\n").expect("base 一致必须写入成功");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "v2\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (b) base 过期（先有人来改过）→ Err 含「并发修改」且文件不被覆盖。
    #[test]
    fn checked_write_rejects_stale_base() {
        let dir = tmp_dir("stale");
        let f = dir.join("a.txt");
        let fs = f.to_string_lossy().to_string();
        std::fs::write(&f, "concurrent-edit\n").unwrap();
        let err = checked_write_atomic(&fs, "old-base\n", "mine\n").unwrap_err();
        assert!(err.contains("并发修改"), "报错必须指明并发修改: {err}");
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "concurrent-edit\n",
            "过期 base 不得覆盖文件"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (c) 8 线程 × 50 轮「读当前 → 追加唯一标记 → checked_write_atomic，Err 重试」，
    /// 最终文件必须恰好包含全部成功写入的标记（无静默丢失 = TOCTOU 回归）。
    #[test]
    fn checked_write_concurrent_no_lost_updates() {
        let dir = tmp_dir("race");
        let f = dir.join("shared.txt");
        let fs = f.to_string_lossy().to_string();
        std::fs::write(&f, "").unwrap();

        const THREADS: usize = 8;
        const ROUNDS: usize = 50;
        let mut handles = Vec::new();
        for t in 0..THREADS {
            let fs = fs.clone();
            handles.push(std::thread::spawn(move || {
                for r in 0..ROUNDS {
                    let marker = format!("marker-{t}-{r}");
                    loop {
                        // 锁外读取可能撞上另一线程 write_atomic 的 rename 窗口
                        // （目标文件瞬态不存在/占用）— 瞬态错误，重试即可；
                        // 本测试验证的不变量是「无静默丢失」，不是「锁外读永不失败」。
                        let cur = match std::fs::read_to_string(&fs) {
                            Ok(c) => c,
                            Err(_) => continue,
                        };
                        let next = format!("{cur}{marker}\n");
                        match checked_write_atomic(&fs, &cur, &next) {
                            Ok(()) => break,
                            Err(e) => assert!(
                                e.contains("并发修改") || e.contains("无法重读"),
                                "只允许并发冲突类失败: {e}"
                            ),
                        }
                    }
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let final_content = std::fs::read_to_string(&f).unwrap();
        for t in 0..THREADS {
            for r in 0..ROUNDS {
                // 带换行统计，避免 marker-1-1 误中 marker-1-11
                let line = format!("marker-{t}-{r}\n");
                assert_eq!(
                    final_content.matches(&line).count(),
                    1,
                    "标记 {line:?} 必须恰好出现一次"
                );
            }
        }
        assert_eq!(final_content.lines().count(), THREADS * ROUNDS);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (d) 重读必失败的路径（文件不存在）→ Err，不得静默写入。
    #[test]
    fn checked_write_fails_closed_when_unreadable() {
        let dir = tmp_dir("missing");
        let fs = dir.join("nope.txt").to_string_lossy().to_string();
        let err = checked_write_atomic(&fs, "", "x\n").unwrap_err();
        assert!(err.contains("无法重读"), "重读失败必须 fail-closed: {err}");
        assert!(
            !std::path::Path::new(&fs).exists(),
            "校验失败的文件不得被创建"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

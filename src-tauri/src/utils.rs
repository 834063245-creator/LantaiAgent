// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 共享工具函数。

use std::process::Command;
use tracing_appender::non_blocking::WorkerGuard;
#[cfg(windows)] use std::os::windows::process::CommandExt;
// ═══════════════════════════════════════════════════════════════
// Windows 子进程窗口控制 — 语义化常量（2026-08-17 根治复发问题）。
//
// 历史教训（修过 8 次仍在弹窗）：窗口标志的选择不能用"一个全局常量
// 盖所有调用点"。同一个数字对直接子进程和对「孙进程」的窗口行为相反：
//
//   CREATE_NO_WINDOW (0x08000000)：「隐藏控制台」—— 子进程有隐藏控制台，
//   且该隐藏控制台会被孙进程继承 → 整棵进程树都不可见。
//   DETACHED_PROCESS (0x00000008)：「无控制台」—— 子进程完全没有控制台，
//   它再 spawn 的孙进程（cmd shim → node/git/cargo 等 CUI 程序）无控制台
//   可继承 → Windows 给孙进程分配【可见新控制台窗口】→ 弹 cmd 黑窗。
//   同时给两者时 CREATE_NO_WINDOW 被忽略（MSDN），实际等效 DETACHED。
//
// 判别标准：这个子进程**会不会再拉起 CUI 孙进程**？
//   - 会（shell 解释器 bash/pwsh/cmd、.cmd shim、git、PowerShell 脚本）
//     → 必须 HIDDEN_CONSOLE，隐藏控制台被子孙继承，全程静默。
//   - 不会（一次性探测 reg/where/版本探针等 stdio 重定向短命令）
//     → 可以 DETACHED_PROCESS，无控制台、无 conhost，零残留。
//
// 验证依据（D:/tmp/winprobe 实验探针实测）：
//   cmd /c shim.cmd（cmd→cmd→ping 链，npm.cmd 同构）：
//     0x08000000  → new_visible_console=0（静默 ✅）
//     0x00000008  → new_visible_console=1（弹窗 ❌）
//     0x08000008  → new_visible_console=1（组合等效 DETACHED，弹窗 ❌）
//   PS: pty_manager 的 conhost 孤儿（8-13 动机）是 ConPTY 场景，由
//   conhost_guard 看门狗兜底，与本常量无关，不要把 DETACHED 强行扩散。
#[cfg(windows)]
pub(crate) const HIDDEN_CONSOLE: u32 = 0x08000000; // CREATE_NO_WINDOW：隐藏控制台被子孙继承
#[cfg(windows)]
pub(crate) const DETACHED_PROCESS_FLAG: u32 = 0x00000008; // 仅一次性探测（不 spawn 孙进程）

// ══════════════════════════════════════════════════════════════════════
// 模块拆分（第三批任务 11a）— 按关注点拆出的子模块，
// 经 pub use 重导出，`crate::utils::*` 调用路径保持不变。
// ══════════════════════════════════════════════════════════════════════

pub(crate) mod bg_jobs;
pub(crate) mod build_lock;
pub(crate) mod encoding;
pub(crate) mod graph_io;
pub(crate) mod ipc_guard;
pub(crate) mod path_resolve;
// （sticky_cwd 已随 shell 域收口退役——2026-09-05，kernel-capability-c3-design.md
//  R3-d §9 裁定：粘性 cwd 归 TS 编排层（session-context per-owner 注册表 +
//  agent/sticky-cwd.ts 截流），Rust 口只收 cwd/sticky_cwd 显式参数——
//  commands/process_cap.rs resolve_effective_cwd。）
pub(crate) use bg_jobs::*;
pub(crate) use build_lock::*;
pub(crate) use encoding::*;
pub(crate) use graph_io::*;
pub(crate) use ipc_guard::*;
pub(crate) use path_resolve::*;

/// 日志守护 — 在首次打开项目时初始化一次，在整个进程生命周期内持有。
pub(crate) static LOG_GUARD: std::sync::OnceLock<WorkerGuard> = std::sync::OnceLock::new();

/// 时间线记录（Phase 3 transport 形态）：事件落工作区引擎进程的
/// hologram.db（timeline_record 壳方法）。best-effort——timeline 是旁路
/// 观测面，失败仅日志可见，不阻断主操作。
pub(crate) fn record_timeline_transport(
    transport: Option<&std::sync::Arc<crate::engine_transport::McpRemoteTransport>>,
    event: &str,
    node_id: Option<&str>,
    summary: &str,
) {
    let Some(t) = transport else {
        return; // 占位工作区（无传输）不记录
    };
    if let Err(e) = t.call(
        "timeline_record",
        &serde_json::json!({
            "event": event,
            "node_id": node_id.unwrap_or(""),
            "detail": summary,
        }),
    ) {
        eprintln!("[timeline] 记录失败 ({event}): {e}");
    }
}

/// timeline 记录的 fire-and-forget 形态：detached 线程发送，引擎卡死/缺席
/// 只丢观测事件，绝不拖住工具命令线程。同步形态（`record_timeline_transport`）
/// 会把引擎往返（`CALL_TIMEOUT_SECS` = 3600s）内联进调用方命令——Phase 3 后
/// write/edit 挂起的根治形态：能力工具与引擎的耦合必须不占命令线程。
pub(crate) fn record_timeline_transport_detached(
    transport: Option<std::sync::Arc<crate::engine_transport::McpRemoteTransport>>,
    event: &str,
    node_id: Option<&str>,
    summary: &str,
) {
    let Some(t) = transport else {
        return; // 占位工作区（无传输）不记录
    };
    let event = event.to_string();
    let node_id = node_id.unwrap_or("").to_string();
    let summary = summary.to_string();
    std::thread::spawn(move || {
        record_timeline_transport(Some(&t), &event, Some(&node_id), &summary);
    });
}

pub(crate) fn is_private_ip(host: &str) -> bool {    // 主机名检查（解析到本地/私有的 DNS 名称）
    let host_lower = host.to_lowercase();
    if host_lower == "localhost" || host_lower.ends_with(".local") || host_lower.ends_with(".internal") {
        return true;
    }
    use std::net::IpAddr;
    let ip: IpAddr = match host.parse() {
        Ok(ip) => ip,
        Err(_) => return false,
    };
    if ip.is_loopback() || ip.is_unspecified() { return true; }
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_link_local()
        }
        IpAddr::V6(v6) => {
            // 检查 IPv6 映射的 IPv4 地址 (::ffff:a.b.c.d)
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_private_ip(&mapped.to_string());
            }
            let segs = v6.segments();
            // 链路本地 (fe80::/10) 或 ULA (fc00::/7 — 包含 fd00::/8)
            (segs[0] & 0xffc0 == 0xfe80) || (segs[0] & 0xfe00 == 0xfc00)
        }
    }
}

pub(crate) fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => { out.push('%'); out.push_str(&format!("{:02X}", b)); }
        }
    }
    out
}

/// git 失败消息三级回退：stderr → stdout → exit code。
/// git 有把失败状态打到 stdout 的分支（实测 `git commit -m` 在「无暂存」时
/// 状态文本全走 stdout、stderr 为空）——只回 stderr 会得到空错误（2026-09
/// 工具缺陷报告 Bug 2：模型收到 `error: ` 无从排查）。
pub(crate) fn git_failure_text(stderr: &str, stdout: &str, code: Option<i32>) -> String {
    let err = stderr.trim();
    if !err.is_empty() {
        return err.to_string();
    }
    let out = stdout.trim();
    if !out.is_empty() {
        return out.to_string();
    }
    format!(
        "git 命令失败 (exit {})",
        code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".to_string())
    )
}

pub(crate) fn run_git_sync(dir: &str, args: &[String]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        // git 会经 shim/editor/hook 拉起孙进程 → 需隐藏控制台继承，不能 DETACHED
        cmd.creation_flags(HIDDEN_CONSOLE);
    }
    let output = cmd
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git 命令失败: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(git_failure_text(
            &String::from_utf8_lossy(&output.stderr),
            &String::from_utf8_lossy(&output.stdout),
            output.status.code(),
        ))
    }
}

/// 在阻塞线程池中运行 git 命令。
/// ponytail: .output() 会阻塞线程等待 git 进程；
/// 在 async worker 上运行会饿死并发的 Tauri 命令。
pub(crate) async fn run_git(dir: String, args: Vec<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_git_sync(&dir, &args))
        .await
        .map_err(|e| format!("git 任务失败: {e}"))?
}

// （parse_status 已随 git 域收口退役——2026-09-05，kernel-capability-c3-design.md
//  R3-c：porcelain 解析归 TS 编排层（src-ui/src/agent/git-porcelain.ts，逐行
//  转录同语义），唯一消费方 builtin.git 插件整目录退役。）

/// 原子写入：临时文件再重命名。
/// 原子地写入文件（tmp → rename），当原文件已存在时创建 .bak 备份。
/// 使用 io_retry 处理瞬时错误。
/// 调用方必须已通过权限检查 — 此函数仅做纯 I/O。
pub(crate) fn write_atomic(file_path: &str, content: &str) -> Result<(), String> {
    // tmp 路径带进程内唯一后缀 — 固定 ".tmp" 会让并发写同一文件的调用
    // 互相覆盖临时文件，rename 时触发 "系统找不到指定的文件"（os error 2）
    // 或写入内容错乱（后写覆盖先写的 tmp 再 rename）。
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = format!("{}.tmp.{}", file_path, seq);
    let bak_path = format!("{}.bak", file_path);

    // 重试临时文件写入（NFS 等的瞬时 I/O 错误）
    io_retry(|| std::fs::write(&tmp_path, content), "write_atomic(tmp)")?;

    // 在覆盖原文件前创建 .bak 快照（尽力而为）
    let had_original = std::path::Path::new(file_path).exists();
    if had_original {
        // 上次崩溃可能残留旧 .bak；rename 对既有目标的行为依赖平台/std 语义，
        // 先删旧 .bak 保证重命名一定可用——否则残留 .bak 会让该文件的
        // 所有后续写入永久失败（雷区地图 P0-3）
        let _ = std::fs::remove_file(&bak_path);
        // 将原文件重命名为 .bak；忽略失败（磁盘满、权限等）
        let _ = std::fs::rename(file_path, &bak_path);
    }

    // 用 tmp 原子替换原文件
    match std::fs::rename(&tmp_path, file_path) {
        Ok(()) => {
            // 成功后删除旧的 .bak（尽力而为）
            if had_original {
                let _ = std::fs::remove_file(&bak_path);
            }
            Ok(())
        }
        Err(e) => {
            // 如果重命名失败，尝试从 .bak 恢复
            if had_original && std::path::Path::new(&bak_path).exists() {
                let _ = std::fs::rename(&bak_path, file_path);
            }
            Err(format!("write_atomic(rename): {}", e))
        }
    }
}

/// 对可能失败的 I/O 闭包最多重试 3 次（针对瞬时错误）。
/// 瞬时错误 = Interrupted、TimedOut、WouldBlock。其他错误立即失败。
fn io_retry<T, F>(mut op: F, label: &str) -> Result<T, String>
where
    F: FnMut() -> std::io::Result<T>,
{
    let retry_count = 3u32;
    for attempt in 0..=retry_count {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => {
                let retryable = matches!(
                    e.kind(),
                    std::io::ErrorKind::Interrupted
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::WouldBlock
                );
                if !retryable || attempt == retry_count {
                    return Err(format!("{} (尝试 {} 次后失败): {}", label, attempt + 1, e));
                }
                let delay = std::time::Duration::from_millis(100) * 2u32.pow(attempt);
                eprintln!(
                    "[write_atomic] {}: 可重试错误，第 {}/{} 次尝试 — {:?}（{:?} 后重试）",
                    label,
                    attempt + 1,
                    retry_count,
                    e,
                    delay
                );
                std::thread::sleep(delay);
            }
        }
    }
    Err(format!("{}: unreachable", label))
}

/// 在内容中查找包含查询字符串的行（模糊子串匹配）。
pub(crate) fn fuzzy_find(content: &str, query: &str) -> Option<(usize, String)> {
    let q = query.trim();
    if q.is_empty() { return None; }
    for (i, line) in content.lines().enumerate() {
        if line.contains(q) {
            return Some((i + 1, line.trim().chars().take(80).collect()));
        }
    }
    None
}

/// PATH 合并（shell-stability P3，平台无关纯函数）：
/// existing 在前（保留顺序），逐个追加 extras 中不重复的条目；
/// 去重大小写不敏感（Windows PATH 语义），空串/引号清理。
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn merge_path_entries(existing: &[String], extras: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |p: &str, out: &mut Vec<String>| {
        let p = p.trim().trim_matches('"');
        if p.is_empty() {
            return;
        }
        if !out.iter().any(|x| x.eq_ignore_ascii_case(p)) {
            out.push(p.to_string());
        }
    };
    for p in existing {
        push(p, &mut out);
    }
    for p in extras {
        push(p, &mut out);
    }
    out
}

// ═══════════════════════════════════════════════════════════════
// `.hologram` → `.lantai` 目录改名迁移（2026-08-23）
//
// 背景：产品更名兰台后，用户数据目录从 `.hologram` 切换到 `.lantai`。
// 迁移策略 = 启动时自动重命名；两目录并存时告警不迁移（防误删用户数据）。
// 幂等：可反复调。
//
// 调用点：
//   - main.rs setup（开发/安装目录的 `.hologram`）
//   - workspace_activate（每次打开项目时对该工作区根）
// 引擎侧职责已收窄（2026-09-08 逻辑收断）：引擎只做文件级搬运
// （engine/src/path_utils.rs::migrate_engine_data——`.lantai` 里的引擎
// 数据搬往 `.hologram`）；整目录迁移（含宿主数据）只由本函数承担。
// ═══════════════════════════════════════════════════════════════

/// 迁移结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrateStatus {
    /// 老目录不存在——无事可做。
    NoOldData,
    /// 已重命名 .hologram → .lantai。
    Migrated,
    /// 两目录并存——告警不迁移（防误删用户数据），由用户手动决。
    ConflictSkipped,
}

/// 把 `root/.hologram` 重命名为 `root/.lantai`（原子，同文件系统内）。
///
/// 要求调用方保证没有进程占用 `.hologram` 内的文件（SQLite WAL 打开、
/// 日志 appender 写入等）——本函数自身不检测，失败由 `fs::rename` 上报。
///
/// 调用前应清理孤儿 worktree（`.hologram/worktrees/agent-*` 在 git 内部
/// 元数据 `.git/worktrees/<name>/gitdir` 中记的是绝对路径，重命名后断链；
/// 先 `git worktree prune` 清孤儿，仍活跃的由调用方后续 `git worktree repair`）。
pub(crate) fn migrate_hologram_to_lantai(root: &std::path::Path) -> Result<MigrateStatus, String> {
    let old = root.join(".hologram");
    let new = root.join(".lantai");
    if !old.exists() {
        return Ok(MigrateStatus::NoOldData);
    }
    if new.exists() {
        eprintln!(
            "[lantai] 警告：{} 同时存在 .hologram 与 .lantai，未迁移。请手动合并后删除 .hologram。",
            root.display()
        );
        return Ok(MigrateStatus::ConflictSkipped);
    }
    std::fs::rename(&old, &new).map_err(|e| {
        format!(
            "迁移 {} → {} 失败: {e}（可能有进程占用 .hologram 内的文件——SQLite/日志/watcher 需先关闭）",
            old.display(),
            new.display()
        )
    })?;
    eprintln!("[lantai] 已迁移 {} → {}", old.display(), new.display());
    Ok(MigrateStatus::Migrated)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── git 失败消息三级回退（Bug 2 根因：git commit 无暂存时 stderr 为空、
    //    状态文本全在 stdout——只回 stderr 得到空错误）──
    #[test]
    fn git_failure_text_prefers_stderr() {
        assert_eq!(git_failure_text(" fatal: boom ", "out", Some(128)), "fatal: boom");
    }

    #[test]
    fn git_failure_text_falls_back_to_stdout_when_stderr_empty() {
        // 实测 `git commit -m msg`（无暂存）：exit 1，stderr 空，状态文本在 stdout
        let stdout = "On branch main\n\nno changes added to commit";
        assert_eq!(git_failure_text("", stdout, Some(1)), stdout);
    }

    #[test]
    fn git_failure_text_reports_exit_code_when_both_empty() {
        assert_eq!(git_failure_text("", "  \n", Some(1)), "git 命令失败 (exit 1)");
        assert_eq!(
            git_failure_text("", "", None),
            "git 命令失败 (exit unknown)",
            "信号终止无 code 时也必须有可读消息"
        );
    }

    #[test]
    fn merge_path_entries_dedupes_case_insensitive_and_keeps_order() {
        let out = merge_path_entries(
            &["C:\\Windows".into(), "\"C:\\Foo\"".into()],
            &["c:\\foo".into(), "".into(), "D:\\Bar".into()],
        );
        assert_eq!(out, vec!["C:\\Windows", "C:\\Foo", "D:\\Bar"]);
    }

    #[test]
    fn truncate_output_spill_writes_full_log_and_guides() {
        let big: String = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 10_000);
        let out = crate::utils::truncate_output_spill(&big, "test-job");
        assert!(out.contains("output truncated"), "必须带截断标记: {out}");
        assert!(out.contains("完整输出已落盘"), "必须给落盘指引: {out}");
        // 从指引里抠出路径，验证全量内容在盘上
        let path_part = out
            .split("完整输出已落盘: ")
            .nth(1)
            .and_then(|s| s.split("（用 fs(read)").next())
            .map(|s| s.trim().to_string())
            .expect("应含路径");
        let on_disk = std::fs::read_to_string(&path_part).expect("溢出文件应存在");
        assert_eq!(on_disk, big, "落盘内容必须与全量输出一致");
        // 短输出不落盘、原文返回
        let short = "hello";
        assert_eq!(crate::utils::truncate_output_spill(short, "test-job"), short);
        let _ = std::fs::remove_file(&path_part);
    }

    // ── B1: SSRF 防护必须捕获 ipv6 映射的 ipv4 (::ffff:a.b.c.d) ──
    #[test]
    fn test_b1_is_private_ip_ipv6_mapped() {
        assert!(is_private_ip("::ffff:127.0.0.1"), "ipv6 映射的回环地址必须被拦截");
        assert!(is_private_ip("::ffff:10.0.0.5"), "ipv6 映射的私有地址段必须被拦截");
        assert!(is_private_ip("::ffff:192.168.1.1"), "ipv6 映射的私有地址段必须被拦截");
    }

    #[test]
    fn test_b1_is_private_ip_baseline() {
        assert!(is_private_ip("127.0.0.1"));
        assert!(is_private_ip("10.1.2.3"));
        assert!(is_private_ip("192.168.0.1"));
        assert!(is_private_ip("172.16.5.5"));
        assert!(is_private_ip("169.254.1.1"), "链路本地地址必须被拦截");
        assert!(is_private_ip("0.0.0.0"), "未指定地址必须被拦截");
        assert!(is_private_ip("::1"), "ipv6 回环地址必须被拦截");
        assert!(is_private_ip("fe80::1"), "ipv6 链路本地地址必须被拦截");
        assert!(is_private_ip("fd00::1"), "ipv6 ULA 地址必须被拦截");
        assert!(is_private_ip("localhost"));
        // 公网地址不应被标记
        assert!(!is_private_ip("8.8.8.8"));
        assert!(!is_private_ip("1.1.1.1"));
        assert!(!is_private_ip("2606:4700:4700::1111"), "公网 ipv6 必须放行");
        assert!(!is_private_ip("example.com"), "普通主机名不是 IP 字面量");
    }

    // ── P0-2：大响应护栏（2026-08-08 事故的物理通道） ──
    #[test]
    fn truncate_output_short_passthrough() {
        let s = "hello world";
        assert_eq!(truncate_output(s), s);
    }

    #[test]
    fn truncate_output_long_keeps_head_and_tail() {
        let s: String = (0..MAX_TOOL_OUTPUT_CHARS * 2).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
        let out = truncate_output(&s);
        assert!(out.contains("[output truncated:"), "必须带截断标记");
        assert!(out.starts_with(&s[..100]), "必须保留头部");
        assert!(out.ends_with(&s[s.len() - 100..]), "必须保留尾部");
        assert!(out.chars().count() < s.chars().count(), "必须真的变短");
    }

    #[test]
    fn truncate_output_multibyte_no_panic() {
        // 中文 3 字节/字，按 char 边界切绝不能 panic 或切出乱码
        let s: String = "汉".repeat(MAX_TOOL_OUTPUT_CHARS * 2);
        let out = truncate_output(&s);
        assert!(out.contains("[output truncated:"));
    }

    #[test]
    fn guard_ipc_size_allows_small() {
        let s = "x".repeat(1024);
        assert_eq!(guard_ipc_size(s.clone(), "测试").unwrap(), s);
    }

    #[test]
    fn guard_ipc_size_rejects_oversize() {
        let s = "x".repeat(MAX_IPC_RESPONSE_BYTES + 1);
        let err = guard_ipc_size(s, "Graph JSON").unwrap_err();
        assert!(err.contains("超过 IPC 上限"), "报错必须说明原因：{err}");
    }

    /// 回归 P0-3：上次崩溃残留的 .bak 不得让后续写入永久失败。
    #[test]
    fn write_atomic_clears_stale_bak() {
        let dir = std::env::temp_dir().join("hologram_test_write_atomic_bak");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("settings.json");
        let fs = f.to_string_lossy().to_string();
        std::fs::write(&f, "old").unwrap();
        std::fs::write(format!("{fs}.bak"), "stale-corpse").unwrap();
        write_atomic(&fs, "new").expect("残留 .bak 不得导致写失败");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "new");
        assert!(
            !std::path::Path::new(&format!("{fs}.bak")).exists(),
            "成功后 .bak 必须清理"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回归 P0-12：锁中毒后 lock_or_recover 恢复数据而非 panic 连锁。
    #[test]
    fn lock_or_recover_survives_poisoning() {
        use std::sync::{Arc, Mutex};
        let m = Arc::new(Mutex::new(42));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            // 故意持锁 panic 制造中毒（用 expect 避开 lock_or_recover 的 codemod 模式）
            let mut g = m2.lock().expect("test lock");
            *g = 43;
            panic!("boom");
        })
        .join();
        assert!(m.lock().is_err(), "前提：锁必须已中毒");
        assert_eq!(*lock_or_recover(&m), 43, "中毒后必须恢复数据而非 panic");
    }

    // ── BuildLock：多 Agent 构建锁互斥 ──
    // 测试共享全局 BUILD_LOCKS 且并行执行——各测试末尾的 clear() 会互踩，
    // 用共享 Mutex 串行化（Rust 测试默认并行线程）。
    // 锁定义在 build_lock.rs（bg_jobs.rs 的 build_lock_released_on_remove_job
    // 也要用它串行化——子模块测试无法访问父模块私有项），经 pub use 转发可见。

    /// 锁键按 (cwd, lock_name) 判定：同目录两个 cargo build 冲突。
    #[test]
    fn build_lock_conflict_same_resource() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let k1 = acquire_build_lock("cargo build", "C:/ws-t1", 1, Some("agent-a".into())).unwrap();
        assert!(k1.is_some(), "cargo build 应注册 target 锁");
        let err = acquire_build_lock("cargo test", "C:/ws-t1", 2, Some("agent-b".into())).unwrap_err();
        assert!(err.contains("构建锁冲突"), "冲突应打回: {err}");
        assert!(err.contains("job #1"), "打回应指明持有者 job: {err}");
        assert!(err.contains("agent-a"), "打回应指明持有者: {err}");
        assert!(err.contains("bash_wait(1)"), "打回应带等待路径: {err}");
        crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
    }

    /// 不同锁资源 / 不同 cwd 互不冲突（worktree 隔离白赚）。
    #[test]
    fn build_lock_no_conflict_different_resource() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let k1 = acquire_build_lock("cargo build", "C:/ws-t2", 1, None).unwrap();
        let k2 = acquire_build_lock("npm install", "C:/ws-t2", 2, None).unwrap();
        let k3 = acquire_build_lock("cargo build", "C:/ws-t2/worktree2", 3, None).unwrap();
        assert!(k1.is_some() && k2.is_some() && k3.is_some(), "异资源/异目录不应冲突");
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
    }

    /// 无锁命令不注册；git 只读子命令不锁。
    #[test]
    fn build_lock_ignores_nonlocking_commands() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        assert!(acquire_build_lock("echo hi", "C:/ws-t3", 1, None).unwrap().is_none());
        assert!(acquire_build_lock("git status", "C:/ws-t3", 2, None).unwrap().is_none());
        assert!(acquire_build_lock("git commit -m x", "C:/ws-t3", 3, None).unwrap().is_some());
        crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
    }

    /// remove_job 释放锁：job 完成后同资源命令恢复可执行。
    /// bash_kill 所有权边界：Agent 不能 kill 用户任务 / 其他 Agent 任务。
    #[test]
    fn kill_bg_ownership_boundary() {
        let _g = BUILD_LOCK_TESTS.lock().expect("test lock");
        let id = next_job_id();
        let child = crate::os_sandbox::spawn_shell("sleep 30", ".").expect("spawn_shell failed");
        register_fg_child(id, child, "sleep 30", BgSharedOutput { stdout: Default::default(), stderr: Default::default(), drain_done: Default::default() }, Some("agent-a".into()), None);
        // 其他 Agent 无权 kill
        let err = kill_bg(id, Some("agent-b")).unwrap_err();
        assert!(err.contains("无权终止"), "跨 Agent kill 应拒绝: {err}");
        // 本人可 kill
        assert!(kill_bg(id, Some("agent-a")).is_ok(), "本人 kill 应放行");
        // 用户任务（owner=None）：Agent 无权 kill
        let id2 = next_job_id();
        let child2 = crate::os_sandbox::spawn_shell("sleep 30", ".").expect("spawn_shell failed");
        register_fg_child(id2, child2, "sleep 30", BgSharedOutput { stdout: Default::default(), stderr: Default::default(), drain_done: Default::default() }, None, None);
        let err2 = kill_bg(id2, Some("agent-a")).unwrap_err();
        assert!(err2.contains("无权终止"), "用户任务 Agent 不可 kill: {err2}");
        // 用户（无 agent_id）可 kill 任何任务
        assert!(kill_bg(id2, None).is_ok(), "用户 kill 应放行");
    }

    // ── P1-17：bg 任务读方只碰 shared Arc，永不阻塞读管道 ──
    #[test]
    fn bg_job_roundtrip_via_shared_arc() {
        let id = spawn_bg("echo bg-p117", ".", None, None, None).expect("spawn_bg failed");
        let out = wait_bg(id, 10_000).expect("wait_bg failed");
        assert!(out.contains("bg-p117"), "unexpected output: {out}");
        assert!(out.contains("exit code: 0"), "unexpected output: {out}");
    }

    /// 无输出的长任务：read_bg_output 必须立即返回快照（修复前 shared=None 分支
    /// 会持 BG_JOBS 锁阻塞读管道，任务安静时永久卡死）。shared 现为必填字段，
    /// 该分支已从类型上移除，此测试锁定行为。
    #[test]
    fn bg_output_snapshot_quiet_task_returns_fast() {
        let id = spawn_bg("sleep 5", ".", None, None, None).expect("spawn_bg failed");
        let start = std::time::Instant::now();
        let out = read_bg_output(id).expect("read_bg_output failed");
        assert!(
            start.elapsed() < std::time::Duration::from_secs(2),
            "快照读取耗时 {:?}——疑似退化为阻塞管道读",
            start.elapsed()
        );
        assert!(out.contains("任务运行中"), "unexpected output: {out}");
        kill_bg(id, None).expect("kill_bg failed");
    }
}
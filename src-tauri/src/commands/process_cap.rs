// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// process 能力口（R3-d，kernel-capability-c3-design.md §8/§9）——内核能力层的
// 进程/spawn 族。自 tool_plugins/shell/mod.rs（builtin.shell 插件）整体迁入；
// 单方法 + action 分派（对标 fs_cap.rs / git_cap.rs），action = 退役前
// builtin.shell 7 工具名（与历史精确规则寻址名同构）。
//
// 口内闸（v3 §1：Rust 能力口是 webview 越不过的物理强制层；权限不迁 TS——
// c3 §9 裁定）：shell 的规则面全在 Bash 家族命令串上（manifest 无 permission
// 声明 = 无工具级规则寻址），口内直用 BashTool（与 git_cap 构造
// PluginToolAdapter 的区别）。fg/bg 双检查不对称（shell 域自检形态，v1
// 原样保留）：
//   - fg = require_command（BashTool 构造 + check_permission 可 Ask）
//         + resolve_read_dispatch（Agent 过 Read 闸 / 用户只解析）
//   - bg = require_command_sync + require_read_sync（sync 变体刻意免 Ask——
//         后台任务不能挂等弹窗）
// bash_output/bash_kill/bash_wait/shell_env/background_activity/
// drain_bg_notifications 本就无命令级检查。
//
// 粘性 cwd 归 TS（c3 §9 裁定）：编排记忆在 TS 编排层（session-context 的
// per-owner 注册表——切工作区即随 agent 拆卸重置），Rust 口无状态。口只收
// 两个显式参数：
//   - cwd：显式目录（模型参数）
//   - sticky_cwd：TS 注册表当前值（候选——盘上不存在时跳过，自愈回退）
// 解析序 cwd → sticky_cwd（存在）→ workspace root，与退役前 sticky_cwd::resolve
// 等价（存在性检查属物理层，留在口内）。
//
// 落点捕获（capture_cwd=true 时）：口内按方言包装命令（尾部 printf marker
// 携带真实 PWD），marker 字节**原样流经** shell:output 事件/结果——截流、
// 提交、[cwd: X] 回显全在 TS 编排层（queued-shell + agent/sticky-cwd.ts）。
// 事件形状零改（§4.3 裁决）：shell:output / shell:done 双事件 + started 回
// {streamId, job_id, resolvedCwd} 保留；tool_call:progress 不掺和。
// bg 三工具（bash_output 增量游标 / bash_wait / bash_kill）依赖 Rust
// BG_JOBS ledger——留口内 action。

use std::thread;
use std::time::Duration;

use tauri::Emitter;
use tauri::State;

/// 粘性 cwd 标记 — OSC 序列（终端消费型，即使泄漏到 UI 也不可见）。
/// 与 TS 侧 agent/sticky-cwd.ts 的常量字节一致（截流/提交在 TS）。
const CWD_MARKER_START: &str = "\u{1b}]lantaicwd;";
const CWD_MARKER_END: char = '\u{07}';

/// process_cap 全量 action 表（= 退役前 builtin.shell 7 工具名）。
const PROCESS_CAP_ACTIONS: [&str; 7] = [
    "exec_command",
    "bash_output",
    "bash_kill",
    "bash_wait",
    "shell_env",
    "background_activity",
    "drain_bg_notifications",
];

/// process_cap 能力口分派。action ∈ 退役前 builtin.shell 7 工具名。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn process_cap(
    action: String,
    // exec_command
    command: Option<String>,
    cwd: Option<String>,
    sticky_cwd: Option<String>,
    timeout_ms: Option<u64>,
    run_in_background: bool,
    stream_tool_id: Option<String>,
    interpreter: Option<String>,
    capture_cwd: bool,
    // bash_output / bash_kill / bash_wait
    job_id: Option<u32>,
    wait_timeout_ms: Option<u64>,
    // 身份（agent_id 兼容 _agent_id；owner_id 兼容 _owner_id——通知路由身份）
    is_agent: bool,
    agent_id: Option<String>,
    owner_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    match action.as_str() {
        "exec_command" => {
            let command = command
                .ok_or_else(|| "process_cap exec_command: missing 'command'".to_string())?;
            exec_command(
                command,
                cwd,
                sticky_cwd,
                timeout_ms,
                run_in_background,
                stream_tool_id,
                interpreter,
                capture_cwd,
                is_agent,
                agent_id,
                owner_id,
                state,
                app,
            )
            .await
        }
        "bash_output" => {
            let job_id = job_id
                .ok_or_else(|| "process_cap bash_output: missing 'job_id'".to_string())?;
            crate::utils::read_bg_output(job_id)
                .map(|s| crate::utils::truncate_output_spill(&s, &format!("bg-job-{job_id}")))
        }
        "bash_kill" => {
            let job_id = job_id
                .ok_or_else(|| "process_cap bash_kill: missing 'job_id'".to_string())?;
            // kill 所有权身份：owner_id（bus id——与 spawn 时 job owner 对齐）
            // 回退 agent_id（隔离子 Agent / 旧前端直连形态；两形都收——
            // 退役前插件同款）。
            let caller = owner_id.or(agent_id);
            crate::utils::kill_bg(job_id, caller.as_deref())
        }
        "bash_wait" => {
            let job_id = job_id
                .ok_or_else(|| "process_cap bash_wait: missing 'job_id'".to_string())?;
            let timeout = wait_timeout_ms.unwrap_or(60_000);
            crate::utils::wait_bg(job_id, timeout)
                .map(|s| crate::utils::truncate_output_spill(&s, &format!("bg-job-{job_id}")))
        }
        // shell_env：serde 序列化恒 JSON（兑底也是合法 JSON 字面量）——
        // runtime 注入 system prompt 经 TS parseJson 消费。
        "shell_env" => Ok(serde_json::to_string(&crate::os_sandbox::shell_env())
            .unwrap_or_else(|_| r#"{"os":"unknown","shell":"unknown","shell_path":"","notes":""}"#.to_string())),
        "background_activity" => {
            let shells = crate::utils::bg_jobs_snapshot();
            let browsers = crate::cdp::cdp_browser_activity();
            Ok(serde_json::json!({ "shells": shells, "browsers": browsers }).to_string())
        }
        "drain_bg_notifications" => Ok(crate::utils::drain_bg_notifications(agent_id.as_deref())),
        other => Err(format!(
            "process_cap: 未知 action '{other}'（合法：{PROCESS_CAP_ACTIONS:?}）"
        )),
    }
}

/// 有效目录解析：显式 cwd → sticky 候选（盘上存在才用——自愈失效）→ 工作区根。
/// 与退役前 sticky_cwd::resolve 的差别只在状态来源：候选值由 TS 编排层
/// 显式传入（Rust 口无粘性状态）。
fn resolve_effective_cwd(
    explicit: Option<&str>,
    sticky: Option<&str>,
    workspace_root: String,
) -> String {
    if let Some(c) = explicit {
        return c.to_string();
    }
    if let Some(s) = sticky {
        if std::path::Path::new(s).exists() {
            return s.to_string();
        }
    }
    workspace_root
}

#[allow(clippy::too_many_arguments)]
async fn exec_command(
    command: String,
    cwd: Option<String>,
    sticky_cwd: Option<String>,
    timeout_ms: Option<u64>,
    run_in_background: bool,
    stream_tool_id: Option<String>,
    interpreter: Option<String>,
    capture_cwd: bool,
    is_agent: bool,
    agent_id: Option<String>,
    owner_id: Option<String>,
    state: &State<'_, crate::WorkspaceState>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    // P5：解释器选择（"pwsh" → PowerShell；其余/缺省 → 捆绑 bash 阶梯）
    let shell_kind = match interpreter.as_deref() {
        Some("pwsh") => crate::os_sandbox::ShellInterpreter::Pwsh,
        _ => crate::os_sandbox::ShellInterpreter::Auto,
    };
    // 粘性 cwd 解析序：显式参数 → TS 候选（存在才用）→ workspace root。
    let dir = resolve_effective_cwd(
        cwd.as_deref(),
        sticky_cwd.as_deref(),
        crate::utils::workspace_path(state)?,
    );
    let is_bg = run_in_background;
    // fg/bg 双检查不对称（见模块头）。后台任务不参与粘性 cwd 捕获（长驻命令
    // 的落点意义小，且完成时机被动）——但 spawn 目录仍解析自粘性值（退役前
    // 插件同款：resolve 先于 is_bg 分支）。
    let physical_dir = if is_bg {
        crate::utils::require_command_sync(&command, state)?;
        crate::utils::require_read_sync(&dir, agent_id.as_deref(), state)?
    } else {
        crate::utils::require_command(&command, state, app).await?;
        crate::utils::resolve_read_dispatch(&dir, is_agent, agent_id.as_deref(), state, app).await?
    };
    let physical_dir_str = physical_dir.to_string_lossy().to_string();

    // ── BuildLock：原子检查+注册（Tauri 单进程 + Mutex，无 TOCTOU）──
    // 冲突 → 打回（带路径错误，LLM 决策）；无冲突 → 持锁执行，随 job 释放。
    let job_id = crate::utils::next_job_id();
    let lock_key = crate::utils::acquire_build_lock(&command, &physical_dir_str, job_id, agent_id.clone())?;

    // P4 护栏：cmd 语法 `cd /d X:` 混入捆绑 bash（日志实证 19 次必失败重试）。
    // 不拦截 — 输出顶部注入纠偏提示，模型看得到失败原因与正确写法。
    let cmd_syntax_hint = if shell_kind != crate::os_sandbox::ShellInterpreter::Pwsh
        && is_cmd_cd_slash_d(&command)
    {
        Some("[提示] `cd /d X:\\...` 是 cmd 语法，捆绑 bash 里 `/d` 会被当成目录名导致 cd 失败。bash 直接写 `cd /x/path`（MSYS 风格）或 `cd 'X:/path'`；也可改用 run_shell 的 cwd 参数。\n".to_string())
    } else {
        None
    };

    if is_bg {
        // app 随 job 下传 — 监视线程完成/停滞时发射 bg:note 事件（owner 路由 + idle 唤醒）。
        // owner 优先 _owner_id（bus id — 前端 executor 注入，通知路由 + kill
        // 所有权）；回退 _agent_id（worktree 隔离 id）兼容旧前端 / 直连 RPC。
        let id = crate::utils::spawn_bg_with(
            job_id,
            &command,
            &physical_dir_str,
            shell_kind,
            owner_id.or(agent_id),
            lock_key,
            Some(app.clone()),
        )?;
        let hint = cmd_syntax_hint.unwrap_or_default();
        return Ok(format!("{hint}[后台任务已启动, ID: {}]\n使用 bash_output({}) 查看输出, bash_wait({}) 等待完成, bash_kill({}) 终止任务", id, id, id, id));
    }

    // ── 落点捕获包装（capture_cwd=true 且 fg；权限检查与构建锁之后，spawn 之前）──
    // 命令按方言包装，输出尾部的 OSC marker 携带真实 PWD。marker 不在口内截流
    // ——原样流经 shell:output 事件/结果，TS 编排层（queued-shell +
    // agent/sticky-cwd.ts）截流、提交粘性值、回显。无 marker（cd 失败、超时、
    // 被杀、cmd 回退、capture_cwd=false）→ TS 侧粘性不动，自愈。
    let effective_command = if !capture_cwd {
        command.clone()
    } else if shell_kind == crate::os_sandbox::ShellInterpreter::Pwsh {
        wrap_pwsh_command(&command)
    } else if crate::os_sandbox::bash_interpreter_available() {
        wrap_bash_command(&command)
    } else {
        // cmd 回退 — printf 不存在，不包装（粘性不更新，仅沿用旧值）
        command.clone()
    };

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(300_000));

    let mut child = match crate::os_sandbox::spawn_shell_with(&effective_command, &physical_dir_str, shell_kind) {
        Ok(c) => c,
        Err(e) => {
            crate::utils::release_build_lock(&lock_key);
            return Err(format!("无法执行命令: {e}"));
        }
    };

    // ── 流式路径：通过 Tauri 事件发送数据块 ──
    if let Some(stream_id) = stream_tool_id.clone() {
        // 流式路径的 cd /d 护栏：hint 作为首个输出块 emit（前端监听器在
        // invoke 前注册，无竞态），按到达顺序拼在结果顶部。
        if let Some(hint) = &cmd_syntax_hint {
            let _ = app.emit("shell:output", serde_json::json!({
                "streamId": stream_id,
                "kind": "stdout",
                "chunk": hint,
            }));
        }
        let stdout_reader = child.take_stdout();
        let stderr_reader = child.take_stderr();

        // 共享输出缓冲区 — 管道被 take 后，转后台时 bg job 从这里读。
        use std::sync::{Arc, Mutex};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let shared_out: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let shared_err: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

        // 输出线程完成计数(0=none, 1=stdout, 2=stderr, 3=both)。
        // join 不能无超时阻塞:bash 退出后孙进程(cargo→rustc/test 子进程)
        // 可能短暂持有管道写端句柄,read_vectored 阻塞等待 → 线程不退出 →
        // join 无限拖住 shell:done → 前端"任务已结束但卡片卡在执行中"。
        // 用计数 + 有界等待替代 join,超时直接发 done。
        let drain_done: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));

        let app_stdout = app.clone();
        let sid_stdout = stream_id.clone();
        let app_stderr = app.clone();
        let so_clone = Arc::clone(&shared_out);

        // 在后台线程中排空 stdout，逐块 emit 到事件 + 累积到共享 Arc。
        // 必须用 read_vectored:裸 read() 在此手工管道上第二次调用会永久阻塞
        // (复现测试证实,卡 Windows 管道 4KB 边界 → bash/cargo 写端阻塞 →
        // 子进程永不退出 → shell:done 永不发出 → Agent loop 无限等待)。
        // read_to_end 能读完但憋到 EOF,长命令期间一个字节都不 emit → 前端假卡。
        // read_vectored 逐块可靠(191ms/23KB 实测),每块实时 emit,两者兼得。
        stdout_reader.map(|mut reader| {
            let dd = Arc::clone(&drain_done);
            std::thread::spawn(move || {
                use std::io::{IoSliceMut, Read};
                // 增量编码解码（2026-08-17）：跨 4KB 块边界的多字节 UTF-8
                // 不再被 from_utf8_lossy 切成 U+FFFD；GBK 输出自动转码。
                let mut dec = crate::utils::StreamDecoder::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = {
                        let mut iov = [IoSliceMut::new(&mut buf)];
                        match reader.read_vectored(&mut iov) {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(_) => break,
                        }
                    };
                    let chunk = dec.push(&buf[..n]);
                    if !chunk.is_empty() {
                        let _ = app_stdout.emit("shell:output", serde_json::json!({
                            "streamId": sid_stdout,
                            "kind": "stdout",
                            "chunk": chunk,
                        }));
                    }
                    crate::utils::append_shared_bounded(&mut *crate::utils::lock_or_recover(&so_clone), &buf[..n]);
                }
                // EOF：清空解码器残余（不完整序列 / GBK 尾）。
                let tail = dec.finish();
                if !tail.is_empty() {
                    let _ = app_stdout.emit("shell:output", serde_json::json!({
                        "streamId": sid_stdout,
                        "kind": "stdout",
                        "chunk": tail,
                    }));
                }
                dd.fetch_add(1, Ordering::SeqCst);
            })
        });

        // 在后台线程中排空 stderr（同上，read_vectored 逐块实时 emit）
        let stream_id_stderr = stream_id.clone();
        let se_clone = Arc::clone(&shared_err);
        stderr_reader.map(|mut reader| {
            let dd = Arc::clone(&drain_done);
            std::thread::spawn(move || {
                use std::io::{IoSliceMut, Read};
                // 与 stdout 同款增量编码解码（2026-08-17）
                let mut dec = crate::utils::StreamDecoder::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = {
                        let mut iov = [IoSliceMut::new(&mut buf)];
                        match reader.read_vectored(&mut iov) {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(_) => break,
                        }
                    };
                    let chunk = dec.push(&buf[..n]);
                    if !chunk.is_empty() {
                        let _ = app_stderr.emit("shell:output", serde_json::json!({
                            "streamId": stream_id_stderr,
                            "kind": "stderr",
                            "chunk": chunk,
                        }));
                    }
                    crate::utils::append_shared_bounded(&mut *crate::utils::lock_or_recover(&se_clone), &buf[..n]);
                }
                let tail = dec.finish();
                if !tail.is_empty() {
                    let _ = app_stderr.emit("shell:output", serde_json::json!({
                        "streamId": stream_id_stderr,
                        "kind": "stderr",
                        "chunk": tail,
                    }));
                }
                dd.fetch_add(1, Ordering::SeqCst);
            })
        });

        // P1-21: 注册进 ledger — 工作区切换 kill_all_bg 能终止运行中的流式命令；
        // 前端 abort 也能按 job_id 调 bash_kill（job_id 经 started 响应暴露给 JS）。
        let label: String = command.chars().take(80).collect();
        let shared = crate::utils::BgSharedOutput {
            stdout: Arc::clone(&shared_out),
            stderr: Arc::clone(&shared_err),
            drain_done: Arc::clone(&drain_done),
        };
        crate::utils::register_fg_child(job_id, child, &label, shared, owner_id.or(agent_id), lock_key);

        // 在后台等待子进程，发送完成事件 / 超时杀进程树
        let app_done = app.clone();
        let sid_done = stream_id.clone();
        let timeout_ms_val = timeout_ms.unwrap_or(300_000);
        let drain_flag = Arc::clone(&drain_done);
        std::thread::spawn(move || {
            enum Poll {
                Running,
                Done(i32),
                Gone,
            }
            let start = std::time::Instant::now();
            loop {
                let poll = {
                    let mut jobs = crate::utils::lock_or_recover(&crate::utils::BG_JOBS);
                    match jobs.get_mut(&job_id) {
                        Some(job) => match job.child.try_wait() {
                            Ok(Some(st)) => Poll::Done(st.code().unwrap_or(-1)),
                            Ok(None) => Poll::Running,
                            Err(_) => Poll::Gone,
                        },
                        // job 被 bash_kill / kill_all_bg 移除 → 视为已终止
                        None => Poll::Gone,
                    }
                };
                match poll {
                    Poll::Done(code) => {
                        // 有界等待输出线程收尾(最多 3s):孙进程短暂持管时
                        // read_vectored 阻塞,但 shell:done 不能因此延迟。
                        // 超时则放弃 — 输出线程在后台自行退出(写端最终关闭)。
                        let deadline = std::time::Instant::now() + Duration::from_secs(3);
                        while drain_flag.load(Ordering::SeqCst) < 2
                            && std::time::Instant::now() < deadline
                        {
                            thread::sleep(Duration::from_millis(20));
                        }
                        crate::utils::remove_job(job_id);
                        let _ = app_done.emit("shell:done", serde_json::json!({
                            "streamId": sid_done,
                            "exitCode": code,
                        }));
                        return;
                    }
                    Poll::Running => {
                        if start.elapsed() >= Duration::from_millis(timeout_ms_val) {
                            // 超时杀进程树（不再转后台）——
                            // 转后台会让进程残留并继续持有构建锁（target/ 等），
                            // 队列放行的后续命令实际卡在 OS 文件锁上连锁超时。
                            // 长任务应走 runInBackground: true（工具描述已引导）。
                            {
                                let mut jobs = crate::utils::lock_or_recover(&crate::utils::BG_JOBS);
                                if let Some(job) = jobs.get_mut(&job_id) {
                                    let _ = job.child.kill_tree();
                                }
                            }
                            // 有界等待输出线程收尾（与 Done 路径一致）：kill 后
                            // 管道写端随进程树关闭，read_vectored 很快收到 EOF。
                            let deadline = std::time::Instant::now() + Duration::from_secs(3);
                            while drain_flag.load(Ordering::SeqCst) < 2
                                && std::time::Instant::now() < deadline
                            {
                                thread::sleep(Duration::from_millis(20));
                            }
                            crate::utils::remove_job(job_id);
                            let msg = format!(
                                "命令超时 ({}ms)，已终止（进程树已杀）。长任务请用 runInBackground: true 启动后用 bash_wait 等待。",
                                timeout_ms_val
                            );
                            let _ = app_done.emit("shell:done", serde_json::json!({
                                "streamId": sid_done,
                                "exitCode": -1,
                                "error": msg,
                            }));
                            return;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                    Poll::Gone => {
                        crate::utils::remove_job(job_id);
                        let _ = app_done.emit("shell:done", serde_json::json!({
                            "streamId": sid_done,
                            "exitCode": -1,
                            "error": "命令执行异常或已被终止",
                        }));
                        return;
                    }
                }
            }
        });

        return Ok(serde_json::json!({
            "streamId": stream_id,
            "status": "started",
            // 暴露 ledger job_id — 前端 abort 时据此调 bash_kill 终止进程树
            // （此前流式命令无法按 streamId 终止，abort 后进程变幽灵继续占队列）
            "job_id": job_id,
            // 本次命令的生效起始目录 — 前端拼进结果尾部回显（粘性 cwd 可见性）
            "resolvedCwd": physical_dir_str,
        })
        .to_string());
    }

    // ── 非流式路径（原始阻塞行为）──
    let stdout_drainer = pipe_drainer(child.take_stdout());
    let stderr_drainer = pipe_drainer(child.take_stderr());

    // P1-21: 前台命令也注册进 ledger（不 spawn monitor — 本路径自己等待并移除）。
    // 工作区切换 kill_all_bg 能终止仍在运行的前台命令，避免跨工作区残留进程。
    use std::sync::{Arc, Mutex};
    let shared = crate::utils::BgSharedOutput {
        stdout: Arc::new(Mutex::new(Vec::new())),
        stderr: Arc::new(Mutex::new(Vec::new())),
        drain_done: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    };
    let label: String = command.chars().take(80).collect();
    crate::utils::register_fg_child(job_id, child, &label, shared, owner_id.or(agent_id), lock_key);

    // P1-16：try_wait+sleep 忙等是阻塞循环，移入 spawn_blocking——
    // 否则一条长命令（默认上限 300s）占住一个 tokio worker，并发命令叠加可耗尽线程池。
    let timeout_ms_val = timeout_ms.unwrap_or(300_000);
    let result = tokio::task::spawn_blocking(move || {
        let r = wait_child_blocking(job_id, stdout_drainer, stderr_drainer, timeout, timeout_ms_val);
        // 命令结束（含超时/错误）→ 从 ledger 移除（锁随 job 释放）
        crate::utils::remove_job(job_id);
        r
    })
    .await
    .map_err(|e| format!("命令等待任务异常: {e}"))?;
    let out = result?;
    Ok(match cmd_syntax_hint {
        Some(hint) => format!("{hint}{out}"),
        None => out,
    })
}

/// 为子进程管道起 drainer 线程：read_to_end 后经 channel 送回，避免管道写满阻塞子进程。
fn pipe_drainer(
    reader: Option<Box<dyn std::io::Read + Send + Unpin>>,
) -> Option<std::sync::mpsc::Receiver<Vec<u8>>> {
    reader.map(|mut r| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = std::io::Read::read_to_end(&mut r, &mut v);
            let _ = tx.send(v);
        });
        rx
    })
}

/// 检测 cmd 专有的 `cd /d` 语法（bash 里 `/d` 被当目录名 → cd 必失败）。
/// 会话日志实证：19 次此类调用每次白付一轮失败重试。
/// `cd` 必须是命令位置（行首或 ; && || | ( 之后），避免 `echo cd /d` 误报。
fn is_cmd_cd_slash_d(command: &str) -> bool {
    let mut rest = command;
    loop {
        let Some(pos) = find_command_position(rest, "cd") else {
            return false;
        };
        let after = &rest[pos + 2..];
        if after.starts_with(char::is_whitespace) {
            let trimmed = after.trim_start();
            if trimmed.starts_with("/d") {
                let next = &trimmed[2..];
                if next.is_empty() || next.starts_with(char::is_whitespace) {
                    return true;
                }
            }
        }
        rest = &rest[pos + 2..];
    }
}

/// 找 `word` 处于命令位置的第一个下标（行首，或 ; && || | ( ）之后）。
fn find_command_position(haystack: &str, word: &str) -> Option<usize> {
    let mut search_from = 0;
    while let Some(rel) = haystack[search_from..].find(word) {
        let pos = search_from + rel;
        let before = haystack[..pos].trim_end();
        let at_command_position = before.is_empty()
            || before.ends_with(';')
            || before.ends_with('&')
            || before.ends_with('|')
            || before.ends_with('(')
            || before.ends_with('$');
        if at_command_position {
            return Some(pos);
        }
        search_from = pos + word.len();
    }
    None
}

/// 包装前台命令（bash 方言，多行形式）：
/// ```sh
/// <command>
/// __lantai_rc=$?
/// printf '<START>%s<END>' "$PWD"
/// exit $__lantai_rc
/// ```
/// - 换行而非 `{ ... ; }` 组：命令尾的 `&`（`cmd &` 后跟 `;` 是 bash 语法错误）
///   与尾随 `# 注释`（会吞掉同行后续 token）都不破坏包装
/// - `$?` 在 printf 前捕获、`exit` 还原 —— 否则 shell 退出码被 printf 的 0
///   覆盖，失败命令显示成功（失败检测循环的根基）
/// - cd 失败时 PWD 未变，粘性值被同值覆盖，等价不动（自愈）
/// - 命令内 `exit`/`set -e`/`exec` 会跳过 printf → 无 marker → 粘性不动（自愈）
fn wrap_bash_command(command: &str) -> String {
    format!(
        "{command}\n__lantai_rc=$?\nprintf '{CWD_MARKER_START}%s{CWD_MARKER_END}' \"$PWD\"\nexit $__lantai_rc"
    )
}

/// 包装前台命令（pwsh 方言，换行分隔）：`[Console]::Out.Write` 直写 stdout 流，
/// 绕过 PowerShell 的流编号与 Write-Host 的信息流语义（marker 必须落在
/// 被捕获的 stdout）；`exit $LASTEXITCODE` 还原原生命令退出码。换行分隔
/// 避免命令尾 `#` 注释吞掉后续 `;` 语句。
fn wrap_pwsh_command(command: &str) -> String {
    format!(
        "{command}\n[Console]::Out.Write('{CWD_MARKER_START}' + $PWD.Path + [char]7)\nexit $LASTEXITCODE"
    )
}

/// 非流式路径的阻塞等待：轮询子进程退出，收集 drainer 输出，超时杀进程树。
/// 必须运行在阻塞线程上（spawn_blocking），不得内联在 async worker。
/// P1-21: child 已注册进 BG_JOBS ledger（register_fg_child），本函数按 job_id
/// 从 ledger 取 child 轮询 — kill_all_bg（工作区切换）可随时终止它。
fn wait_child_blocking(
    job_id: u32,
    stdout_drainer: Option<std::sync::mpsc::Receiver<Vec<u8>>>,
    stderr_drainer: Option<std::sync::mpsc::Receiver<Vec<u8>>>,
    timeout: Duration,
    timeout_ms_val: u64,
) -> Result<String, String> {
    let start = std::time::Instant::now();
    loop {
        let status = {
            let mut jobs = crate::utils::lock_or_recover(&crate::utils::BG_JOBS);
            match jobs.get_mut(&job_id) {
                Some(job) => job.child.try_wait(),
                // job 被 kill_bg / kill_all_bg 移除 → 视为已终止
                None => return Err("后台任务不存在或已被终止".into()),
            }
        };
        match status {
            Ok(Some(status)) => {
                let stdout = stdout_drainer
                    .as_ref()
                    .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                    .map(|v| crate::utils::decode_shell_bytes(&v))
                    .unwrap_or_default();
                let stderr = stderr_drainer
                    .as_ref()
                    .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                    .map(|v| crate::utils::decode_shell_bytes(&v))
                    .unwrap_or_default();

                let full_output = if stdout.is_empty() && stderr.is_empty() {
                    "(无输出)".to_string()
                } else {
                    crate::utils::truncate_output_spill(
                        &format!("{}{}", stdout, stderr),
                        &format!("job-{job_id}"),
                    )
                };

                if !status.success() {
                    return Ok(format!(
                        "[exit code: {}]\n{}",
                        status.code().unwrap_or(-1),
                        full_output
                    ));
                }

                return Ok(full_output);
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    // 终止进程树而非转后台 — 非流式路径的 stdout 已被 take 走,
                    // 转后台后同样收不回输出,agent 只会反复重跑。终止并带回已收集的输出。
                    crate::utils::lock_or_recover(&crate::utils::BG_JOBS)
                        .get_mut(&job_id)
                        .and_then(|j| j.child.kill_tree().ok());
                    let stdout = stdout_drainer
                        .as_ref()
                        .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                        .map(|v| crate::utils::decode_shell_bytes(&v))
                        .unwrap_or_default();
                    let stderr = stderr_drainer
                        .as_ref()
                        .and_then(|rx| rx.recv_timeout(Duration::from_secs(5)).ok())
                        .map(|v| crate::utils::decode_shell_bytes(&v))
                        .unwrap_or_default();
                    return Ok(crate::utils::truncate_output_spill(
                        &format!(
                            "[exit code: -1] 命令超时 ({}ms)，已终止。可拆小命令或增大 timeoutMs 后重试。\n{}{}",
                            timeout_ms_val,
                            stdout,
                            stderr
                        ),
                        &format!("job-{job_id}"),
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                crate::utils::lock_or_recover(&crate::utils::BG_JOBS)
                    .get_mut(&job_id)
                    .and_then(|j| j.child.kill_tree().ok());
                return Err(format!("命令执行异常: {e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_shared() -> crate::utils::BgSharedOutput {
        use std::sync::{Arc, Mutex};
        crate::utils::BgSharedOutput {
            stdout: Arc::new(Mutex::new(Vec::new())),
            stderr: Arc::new(Mutex::new(Vec::new())),
            drain_done: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    /// 前台等待辅助：注册进 ledger（与 exec_command 非流式路径一致），完成后移除。
    fn run_wait(cmd: &str, timeout_ms: u64) -> Result<String, String> {
        let mut child = crate::os_sandbox::spawn_shell(cmd, ".").expect("spawn_shell failed");
        let stdout = pipe_drainer(child.take_stdout());
        let stderr = pipe_drainer(child.take_stderr());
        let job_id = crate::utils::next_job_id();
        crate::utils::register_fg_child(job_id, child, cmd, empty_shared(), None, None);
        let r = wait_child_blocking(
            job_id,
            stdout,
            stderr,
            Duration::from_millis(timeout_ms),
            timeout_ms,
        );
        crate::utils::remove_job(job_id);
        r
    }

    /// action 表锚（退役前 tool_plugins/shell/mod.rs manifest 测试同表）：
    /// 7 工具全量、无遗漏；bash_kill 非 read_only、五内部/查询动作只读。
    #[test]
    fn action_table_matches_retired_manifest() {
        let read_only: [&str; 5] = [
            "bash_output",
            "bash_wait",
            "shell_env",
            "background_activity",
            "drain_bg_notifications",
        ];
        for a in PROCESS_CAP_ACTIONS {
            let known = a == "exec_command" || a == "bash_kill" || read_only.contains(&a);
            assert!(known, "{a} 必须落在已知权限形状之一");
        }
        assert_eq!(PROCESS_CAP_ACTIONS.len(), 7);
        // exec_command 非 read_only（写动作）；bash_kill 非 read_only（终止动作）
        assert!(!read_only.contains(&"exec_command"));
        assert!(!read_only.contains(&"bash_kill"));
    }

    /// 粘性 cwd 解析序（状态归 TS 后口内只收候选值）：显式 → 候选（存在才用）
    /// → workspace root；候选盘上不存在（被删）→ 跳过自愈。
    #[test]
    fn resolve_effective_cwd_order_explicit_sticky_root() {
        let tmp = std::env::temp_dir()
            .join(format!("lantai_pcap_sticky_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let root = "d:/root".to_string();
        let sticky = tmp.to_string_lossy().to_string();
        // 显式最优先
        assert_eq!(
            resolve_effective_cwd(Some("d:/explicit"), Some(&sticky), root.clone()),
            "d:/explicit"
        );
        // 候选存在 → 采用
        assert_eq!(
            resolve_effective_cwd(None, Some(&sticky), root.clone()),
            sticky
        );
        // 候选不存在（被删）→ 自愈回退 root
        assert_eq!(
            resolve_effective_cwd(None, Some("d:/definitely-not-exist-xyz"), root.clone()),
            root
        );
        // 无候选 → root
        assert_eq!(resolve_effective_cwd(None, None, root.clone()), root);
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// 落点捕获包装（bash 方言）：尾随 & / 尾随注释不破坏包装；退出码还原。
    #[test]
    fn wrap_bash_survives_trailing_bg_and_comment() {
        let w = wrap_bash_command("npm run dev &");
        assert!(w.starts_with("npm run dev &\n"), "尾随 & 必须直接换行续接: {w}");
        let w2 = wrap_bash_command("cargo check # heavy");
        assert!(w2.starts_with("cargo check # heavy\n"), "注释行必须被换行终结: {w2}");
        for w in [&w, &w2] {
            assert!(w.contains("printf '"));
            assert!(w.contains("\"$PWD\""));
            assert!(w.contains("exit $__lantai_rc"), "退出码必须被还原");
        }
        assert!(w.contains(CWD_MARKER_START), "包装必须携带 OSC marker");
    }

    /// 落点捕获包装（pwsh 方言）：[Console]::Out.Write 直写 stdout + 退出码还原。
    #[test]
    fn wrap_pwsh_writes_marker_to_stdout() {
        let w = wrap_pwsh_command("Get-Location");
        assert!(w.contains("[Console]::Out.Write('"));
        assert!(w.contains("+ [char]7"));
        assert!(w.contains("exit $LASTEXITCODE"), "退出码必须被还原");
        assert!(w.contains(CWD_MARKER_START));
    }

    /// 物理层锚（截流/提交归 TS 后）：capture 包装的真实输出必须含 marker——
    /// TS 侧截流的契约前提。退出码经包装还原（失败仍非零）。
    #[test]
    fn wrapped_output_carries_marker_and_preserves_exit_code() {
        if !crate::os_sandbox::bash_interpreter_available() {
            return; // cmd 回退环境不包装（CI 非 Windows 分支）
        }
        let out = run_wait(&wrap_bash_command("echo pcap-marker-e2e"), 30_000).unwrap();
        assert!(out.contains("pcap-marker-e2e"), "unexpected: {out}");
        assert!(out.contains(CWD_MARKER_START), "marker 必须随输出流出（TS 截流契约）: {out}");
        // 失败命令的退出码经包装还原（printf 的 0 不覆盖）
        let fail = run_wait(&wrap_bash_command("exit 3"), 30_000).unwrap();
        assert!(fail.contains("[exit code: 3]"), "unexpected: {fail}");
    }

    #[test]
    fn test_cmd_cd_slash_d_detection() {
        assert!(is_cmd_cd_slash_d("cd /d D:\\HoloGramHG\\src-ui && npm run build"));
        assert!(is_cmd_cd_slash_d("  cd  /d  C:\\x"));
        assert!(!is_cmd_cd_slash_d("cd /d/HoloGramHG/engine && cargo build"), "MSYS 绝对路径 `/d/...` 不是 cmd 语法");
        assert!(!is_cmd_cd_slash_d("echo cd /d"));
        assert!(!is_cmd_cd_slash_d("cd src && npm test"));
    }

    // P1-16 回归：阻塞等待移入 spawn_blocking 后行为不变
    #[test]
    fn test_wait_child_blocking_success_output() {
        let out = run_wait("echo hello-p116", 30_000).unwrap();
        assert!(out.contains("hello-p116"), "unexpected output: {out}");
    }

    #[test]
    fn test_wait_child_blocking_exit_code() {
        let out = run_wait("exit 3", 30_000).unwrap();
        assert!(out.contains("[exit code: 3]"), "unexpected output: {out}");
    }

    #[test]
    fn test_wait_child_blocking_timeout_kills() {
        let start = std::time::Instant::now();
        let out = run_wait("sleep 30", 500).unwrap();
        assert!(out.contains("命令超时"), "unexpected output: {out}");
        // 超时即终止进程树，不得等满 sleep 30
        assert!(start.elapsed() < Duration::from_secs(20), "took {:?}", start.elapsed());
    }

    // P1-21 回归：前台命令注册进 ledger（kill_all_bg 可遍历终止）；
    // job 被移除（kill_bg/kill_all_bg）后 wait 立即报告「已被终止」。
    // 注意：不调真实 kill_all_bg —— 它清空全局 BG_JOBS，会干扰并行测试的其他 job。
    #[test]
    fn test_fg_command_killed_by_ledger_removal() {
        let mut child = crate::os_sandbox::spawn_shell("sleep 30", ".").expect("spawn_shell failed");
        let stdout = pipe_drainer(child.take_stdout());
        let stderr = pipe_drainer(child.take_stderr());
        let job_id = crate::utils::next_job_id();
        crate::utils::register_fg_child(job_id, child, "sleep 30", empty_shared(), None, None);
        // 注册生效：ledger 中可见（kill_all_bg 遍历能杀到它）
        assert!(
            crate::utils::lock_or_recover(&crate::utils::BG_JOBS).contains_key(&job_id),
            "前台命令应注册进 ledger"
        );
        // 模拟 kill_all_bg / kill_bg 移除 job → wait 立即报「已被终止」
        crate::utils::remove_job(job_id);
        let r = wait_child_blocking(job_id, stdout, stderr, Duration::from_secs(10), 10_000);
        assert!(r.is_err(), "wait 应因 job 被移除而报错, got {r:?}");
        assert!(r.unwrap_err().contains("已被终止"), "unexpected err");
    }

    // P1-21 回归：前台命令正常完成后，ledger 中不再残留该 job
    #[test]
    fn test_fg_command_removed_after_completion() {
        let mut child = crate::os_sandbox::spawn_shell("echo p121-done", ".").expect("spawn_shell failed");
        let stdout = pipe_drainer(child.take_stdout());
        let stderr = pipe_drainer(child.take_stderr());
        let job_id = crate::utils::next_job_id();
        crate::utils::register_fg_child(job_id, child, "echo p121-done", empty_shared(), None, None);
        let r = wait_child_blocking(job_id, stdout, stderr, Duration::from_secs(10), 10_000);
        crate::utils::remove_job(job_id);
        assert!(r.as_ref().unwrap().contains("p121-done"), "unexpected output: {r:?}");
        assert!(
            crate::utils::lock_or_recover(&crate::utils::BG_JOBS).get(&job_id).is_none(),
            "job {job_id} 应已从 ledger 移除"
        );
    }
}

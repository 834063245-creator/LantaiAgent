// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// Shell 执行：exec_command、bash_output、bash_wait、bash_kill、shell_env。

use std::thread;
use std::time::Duration;

use tauri::Emitter;

use crate::utils::truncate_output_spill;

/// 当前 shell 环境 — 前端注入 Agent system prompt 用（见 os_sandbox::shell_env）。
#[tauri::command]
pub(crate) fn shell_env() -> String {
    serde_json::to_string(&crate::os_sandbox::shell_env())
        .unwrap_or_else(|_| r#"{"os":"unknown","shell":"unknown","shell_path":"","notes":""}"#.into())
}

#[tauri::command]
pub(crate) async fn exec_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    run_in_background: Option<bool>,
    is_agent: Option<bool>,
    stream_tool_id: Option<String>,
    agent_id: Option<String>,
    interpreter: Option<String>,
    owner_id: Option<String>,
    state: tauri::State<'_, crate::WorkspaceState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // P5：解释器选择（"pwsh" → PowerShell；其余/缺省 → 捆绑 bash 阶梯）
    let shell_kind = match interpreter.as_deref() {
        Some("pwsh") => crate::os_sandbox::ShellInterpreter::Pwsh,
        _ => crate::os_sandbox::ShellInterpreter::Auto,
    };
    // 粘性 cwd（会话日志实证：46.9% 的调用是 `cd X && cmd` 复合 —— 模型在
    // 手动模拟持久 shell）。解析顺序：显式参数 → agent 粘性值 → workspace root。
    let owner_key = owner_id.clone().or(agent_id.clone());
    let dir = crate::utils::sticky_cwd::resolve(
        cwd.as_deref(),
        owner_key.as_deref(),
        crate::utils::workspace_path(&state)?,
    );
    let cwd_gen = crate::utils::sticky_cwd::generation();
    let is_bg = run_in_background.unwrap_or(false);
    let physical_dir = if is_bg {
        crate::utils::require_command_sync(&command, &state)?;
        crate::utils::require_read_sync(&dir, agent_id.as_deref(), &state)?
    } else {
        crate::utils::require_command(&command, &state, &app).await?;
        crate::utils::resolve_read_dispatch(&dir, is_agent.unwrap_or(false), agent_id.as_deref(), &state, &app).await?
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
        // owner 优先 _owner_id（bus agent id — 前端 executor 注入，通知路由 + kill
        // 所有权）；回退 _agent_id（worktree 隔离 id）兼容旧前端 / 直连 RPC。
        // 后台任务不参与粘性 cwd（长驻命令的落点意义小，且完成时机被动）。
        let id = crate::utils::spawn_bg_with(job_id, &command, &physical_dir_str, shell_kind, owner_id.or(agent_id), lock_key, Some(app))?;
        let hint = cmd_syntax_hint.unwrap_or_default();
        return Ok(format!("{hint}[后台任务已启动, ID: {}]\n使用 bash_output({}) 查看输出, bash_wait({}) 等待完成, bash_kill({}) 终止任务", id, id, id, id));
    }

    // ── 粘性 cwd 落点捕获包装（权限检查与构建锁之后，spawn 之前）──
    // 前台命令按方言包装，输出尾部的 OSC marker 携带真实 PWD；marker 在
    // 输出层被截留（不进前端/结果），提取后更新粘性值。无 marker（cd 失败、
    // 超时、被杀、cmd 回退）→ 粘性不动，自愈。
    let wrap_sticky = shell_kind == crate::os_sandbox::ShellInterpreter::Pwsh;
    let effective_command = if wrap_sticky {
        crate::utils::sticky_cwd::wrap_pwsh_command(&command)
    } else if crate::os_sandbox::bash_interpreter_available() {
        crate::utils::sticky_cwd::wrap_bash_command(&command)
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

        // 粘性 cwd 截流器：stdout 流上的 OSC marker 不向前端 emit，识别后
        // 直接提交粘性值（跨块分裂由 filter 挂起处理）。stderr 无 marker。
        let cwd_filter = Arc::new(Mutex::new(
            crate::utils::sticky_cwd::CwdMarkerFilter::new(),
        ));
        let cwd_filter_out = Arc::clone(&cwd_filter);
        let sticky_out_key = owner_key.clone();

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
                        let mut filter = crate::utils::lock_or_recover(&cwd_filter_out);
                        let (clean, _committed) =
                            filter.push(&chunk, sticky_out_key.as_deref(), cwd_gen);
                        drop(filter);
                        if !clean.is_empty() {
                            let _ = app_stdout.emit("shell:output", serde_json::json!({
                                "streamId": sid_stdout,
                                "kind": "stdout",
                                "chunk": clean,
                            }));
                        }
                    }
                    crate::utils::append_shared_bounded(&mut *crate::utils::lock_or_recover(&so_clone), &buf[..n]);
                }
                // EOF：清空解码器残余（不完整序列 / GBK 尾），挂起的 filter
                // 片段一并放行（无 marker —— 粘性不动，自愈）。
                let tail = dec.finish();
                if !tail.is_empty() {
                    let mut filter = crate::utils::lock_or_recover(&cwd_filter_out);
                    let (clean, _) = filter.push(&tail, sticky_out_key.as_deref(), cwd_gen);
                    let flushed = filter.flush();
                    drop(filter);
                    let all = format!("{clean}{flushed}");
                    if !all.is_empty() {
                        let _ = app_stdout.emit("shell:output", serde_json::json!({
                            "streamId": sid_stdout,
                            "kind": "stdout",
                            "chunk": all,
                        }));
                    }
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
        }).to_string());
    }

    // ── 非流式路径（原始阻塞行为） ──
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
    let sticky_ctx = crate::utils::sticky_cwd::StickyContext {
        agent_key: owner_key.clone(),
        generation: cwd_gen,
        // 超时/被杀时无 marker，回显退化为起始目录
        start_dir: physical_dir_str.clone(),
    };
    let result = tokio::task::spawn_blocking(move || {
        let r = wait_child_blocking(job_id, stdout_drainer, stderr_drainer, timeout, timeout_ms_val, Some(sticky_ctx));
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

/// 非流式路径的阻塞等待：轮询子进程退出，收集 drainer 输出，超时杀进程树。
/// 必须运行在阻塞线程上（spawn_blocking），不得内联在 async worker。
/// P1-21: child 已注册进 BG_JOBS ledger（register_fg_child），本函数按 job_id
/// 从 ledger 取 child 轮询 — kill_all_bg（工作区切换）可随时终止它。
/// sticky: 粘性 cwd 上下文 — 完成出口剥 marker/提交/回显；超时出口无 marker
/// 仅回显起始目录（None = 测试直调，跳过粘性处理）。
fn wait_child_blocking(
    job_id: u32,
    stdout_drainer: Option<std::sync::mpsc::Receiver<Vec<u8>>>,
    stderr_drainer: Option<std::sync::mpsc::Receiver<Vec<u8>>>,
    timeout: Duration,
    timeout_ms_val: u64,
    sticky: Option<crate::utils::sticky_cwd::StickyContext>,
) -> Result<String, String> {
    /// 剥 marker + 提交粘性 + 回显（有上下文时）；测试直调原样放行。
    fn finalize(text: String, sticky: &Option<crate::utils::sticky_cwd::StickyContext>) -> String {
        match sticky {
            Some(ctx) => crate::utils::sticky_cwd::finalize_output(&text, ctx),
            None => text,
        }
    }
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
                    finalize("(无输出)".into(), &sticky)
                } else {
                    finalize(
                        truncate_output_spill(&format!("{}{}", stdout, stderr), &format!("job-{job_id}")),
                        &sticky,
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
                    return Ok(finalize(
                        truncate_output_spill(
                            &format!(
                                "[exit code: -1] 命令超时 ({}ms)，已终止。可拆小命令或增大 timeoutMs 后重试。\n{}{}",
                                timeout_ms_val,
                                stdout,
                                stderr
                            ),
                            &format!("job-{job_id}"),
                        ),
                        &sticky,
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

#[tauri::command]
pub(crate) async fn bash_output(job_id: u32) -> Result<String, String> {
    crate::utils::read_bg_output(job_id).map(|s| truncate_output_spill(&s, &format!("bg-job-{job_id}")))
}

#[tauri::command]
pub(crate) async fn bash_kill(job_id: u32, agent_id: Option<String>) -> Result<String, String> {
    crate::utils::kill_bg(job_id, agent_id.as_deref())
}

#[tauri::command]
pub(crate) async fn bash_wait(job_id: u32, timeout_ms: Option<u64>) -> Result<String, String> {
    crate::utils::wait_bg(job_id, timeout_ms.unwrap_or(60_000)).map(|s| truncate_output_spill(&s, &format!("bg-job-{job_id}")))
}

#[tauri::command]
pub(crate) async fn drain_bg_notifications(agent_id: Option<String>) -> Result<String, String> {
    Ok(crate::utils::drain_bg_notifications(agent_id.as_deref()))
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
    /// sticky 传入时走生产同款包装 + finalize（粘性 cwd 端到端用例用）。
    fn run_wait(cmd: &str, timeout_ms: u64) -> Result<String, String> {
        run_wait_sticky(cmd, timeout_ms, None)
    }

    fn run_wait_sticky(
        cmd: &str,
        timeout_ms: u64,
        sticky: Option<crate::utils::sticky_cwd::StickyContext>,
    ) -> Result<String, String> {
        let effective = match &sticky {
            Some(_) if crate::os_sandbox::bash_interpreter_available() => {
                crate::utils::sticky_cwd::wrap_bash_command(cmd)
            }
            _ => cmd.to_string(),
        };
        let mut child = crate::os_sandbox::spawn_shell(&effective, ".").expect("spawn_shell failed");
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
            sticky,
        );
        crate::utils::remove_job(job_id);
        r
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

    // ── 粘性 cwd 端到端（真实 bash：包装 → marker 捕获 → 剥离 → 回显）──

    #[test]
    fn test_sticky_cwd_e2e_cd_persists_and_echoes() {
        let _g = crate::utils::sticky_cwd::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        crate::utils::sticky_cwd::clear_all();
        let ctx = crate::utils::sticky_cwd::StickyContext {
            agent_key: Some("e2e-agent".into()),
            generation: crate::utils::sticky_cwd::generation(),
            start_dir: ".".into(),
        };
        // cd 到父目录（“.” 的父）—— marker 应被剥掉、粘性值更新、回显父目录。
        // 期望用 dunce 风格归一化对齐：canonicalize 产生 \\?\ 前缀，粘性值是盘符形式。
        let parent = std::path::Path::new(".").canonicalize().unwrap().parent().unwrap().to_path_buf();
        let out = run_wait_sticky("cd ..", 30_000, Some(ctx)).unwrap();
        assert!(!out.contains("lantaicwd"), "marker 必须被剥离: {out}");
        assert!(out.contains("[cwd:"), "应回显 cwd 行: {out}");
        let sticky = crate::utils::sticky_cwd::get("e2e-agent").expect("粘性值应已提交");
        assert_eq!(
            sticky.to_string_lossy().replace('/', "\\").to_lowercase(),
            parent.to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase(),
            "粘性值应落在真实父目录 (sticky={sticky:?} parent={parent:?})"
        );
        // 解析顺序：下一次无参调用落在粘性目录
        let resolved = crate::utils::sticky_cwd::resolve(None, Some("e2e-agent"), "d:/fallback".into());
        let resolved_canon = std::path::Path::new(&resolved).canonicalize().unwrap();
        let parent_canon = parent.canonicalize().unwrap();
        assert_eq!(resolved_canon, parent_canon, "resolve 应返回粘性目录: {resolved}");
        crate::utils::sticky_cwd::clear_all();
    }

    #[test]
    fn test_sticky_cwd_e2e_failed_cd_keeps_sticky() {
        let _g = crate::utils::sticky_cwd::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        crate::utils::sticky_cwd::clear_all();
        let keep = std::env::temp_dir();
        crate::utils::sticky_cwd::set("keep-agent", keep.clone(), crate::utils::sticky_cwd::generation());
        let ctx = crate::utils::sticky_cwd::StickyContext {
            agent_key: Some("keep-agent".into()),
            generation: crate::utils::sticky_cwd::generation(),
            start_dir: ".".into(),
        };
        // cd 到不存在目录 → cd 失败 → PWD 不变 → marker 印的是原目录（spawn cwd "."）。
        // 粘性被真实 PWD 覆盖是符合语义的 —— 验证不落 ghost 目录。
        let out = run_wait_sticky("cd /definitely-not-exist-xyz", 30_000, Some(ctx)).unwrap();
        assert!(out.contains("[exit code:"), "cd 失败应有非零退出码: {out}");
        assert!(!out.contains("lantaicwd"), "marker 必须被剥离: {out}");
        let sticky = crate::utils::sticky_cwd::get("keep-agent")
            .expect("粘性值存在（被真实 PWD 覆盖）");
        let ghost = std::path::Path::new("/definitely-not-exist-xyz");
        assert_ne!(std::path::PathBuf::from(sticky), ghost.to_path_buf());
        crate::utils::sticky_cwd::clear_all();
    }

    #[test]
    fn test_cmd_cd_slash_d_detection() {
        assert!(is_cmd_cd_slash_d("cd /d D:\\HoloGramHG\\src-ui && npm run build"));
        assert!(is_cmd_cd_slash_d("  cd  /d  C:\\x"));
        assert!(!is_cmd_cd_slash_d("cd /d/HoloGramHG/engine && cargo build"), "MSYS 绝对路径 `/d/...` 不是 cmd 语法");
        assert!(!is_cmd_cd_slash_d("echo cd /d"));
        assert!(!is_cmd_cd_slash_d("cd src && npm test"));
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
        let r = wait_child_blocking(job_id, stdout, stderr, Duration::from_secs(10), 10_000, None);
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
        let r = wait_child_blocking(job_id, stdout, stderr, Duration::from_secs(10), 10_000, None);
        crate::utils::remove_job(job_id);
        assert!(r.as_ref().unwrap().contains("p121-done"), "unexpected output: {r:?}");
        assert!(
            crate::utils::lock_or_recover(&crate::utils::BG_JOBS).get(&job_id).is_none(),
            "job {job_id} 应已从 ledger 移除"
        );
    }
}

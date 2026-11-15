// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 后台任务注册表 — 超时 + 后台 + 输出 + 终止 + 观测（2026-11-12 一次到位）
//
// ── 本文件的双读者模型（改前必读）──────────────────────────────────────
// 同一份输出有两个读者，各有各的游标：
//   ① 模型：`read_bg_output` / `wait_bg` 的**消费式**游标（读走即前进）；
//   ② 人（役册/观测）：`job_read_at` 的**非消费**按绝对字节偏移读。
// 观测读绝不移动模型游标，也绝不销毁 job —— 这是「点开看实时输出」能成立的全部前提。
// 绝对偏移与「环形淘汰」并存：`total` = 累计写入字节，`dropped` = 头部丢弃字节，
// 读者 from < dropped 时如实报 lossy（配合 spill 全量日志文件，环外字节仍可查）。
//
// 结算不消失：进程退出后 job 就地转终态（保留环 + 退出码），模型终读后才移入
// `SETTLED_HISTORY`（只留投影 + 输出尾巴 + 日志路径），役册行因此不会凭空消失。

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::os_sandbox;
use crate::utils::build_lock::{LockKey, BUILD_LOCKS};
use crate::utils::ipc_guard::lock_or_recover;
use crate::utils::stream_ring::{BgSharedOutput, StreamRing};

// ═══════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════

/// 「已结算但模型还没读」的 job 保留上限；超出把最旧迁入历史。
const MAX_SETTLED_UNREAD: usize = 50;
/// 已结算历史保留条数。
const MAX_HISTORY: usize = 200;
/// 历史记录保留的输出尾巴（每流）。
const SETTLED_TAIL_BYTES: usize = 64 * 1024;
/// 通知队列上限：owner 已消亡的通知永远不会被 drain，防无界增长。
const MAX_COMPLETED_NOTES: usize = 200;
/// 停滞检测阈值 — 超过此时长无输出则触发警告。
pub(crate) const STALL_THRESHOLD: std::time::Duration = std::time::Duration::from_secs(300);

// ═══════════════════════════════════════════════════════
// job 状态
// ═══════════════════════════════════════════════════════

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum JobStatus {
    Running,
    Stopping,
    Completed,
    Killed,
}

impl JobStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            JobStatus::Running => "running",
            JobStatus::Stopping => "stopping",
            JobStatus::Completed => "completed",
            JobStatus::Killed => "killed",
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
        !matches!(self, JobStatus::Running | JobStatus::Stopping)
    }
}

// ═══════════════════════════════════════════════════════
// job 记录
// ═══════════════════════════════════════════════════════

pub(crate) struct BgJob {
    pub(crate) child: os_sandbox::SandboxedChild,
    /// 模型侧"已交付给 bash_output 的绝对字节偏移"（消费式游标）。
    pub(crate) stdout_cursor: u64,
    pub(crate) stderr_cursor: u64,
    /// 常驻增量解码器 — 跨 read 边界保持 UTF-8/GBK 解码状态。
    pub(crate) stdout_decoder: crate::utils::StreamDecoder,
    pub(crate) stderr_decoder: crate::utils::StreamDecoder,
    pub(crate) start_time: std::time::Instant,
    /// epoch ms — 投影给 UI 的绝对时刻（Instant 序列化不出来）。
    pub(crate) started_ms: u64,
    pub(crate) label: String,
    pub(crate) kind: String,
    pub(crate) last_output_time: std::time::Instant,
    /// 共享输出缓冲区（必有）：读方只碰内存环，永不阻塞。
    pub(crate) shared: BgSharedOutput,
    /// 任务发起者：Some(agent_id)=Agent 发起；None=用户/UI 直接发起。
    pub(crate) owner: Option<String>,
    /// 本 job 持有的构建锁（若有）— 随 job 移除时自动释放。
    pub(crate) lock_key: Option<LockKey>,
    pub(crate) status: JobStatus,
    pub(crate) exit_code: Option<i32>,
    pub(crate) finished_ms: Option<u64>,
    pub(crate) detail: Option<String>,
}

pub(crate) static BG_JOBS: std::sync::LazyLock<Arc<Mutex<HashMap<u32, BgJob>>>> =
    std::sync::LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 已结算、已离开 ledger 的 job 历史（投影 + 输出尾巴 + 日志路径）。
pub(crate) struct SettledRecord {
    pub(crate) id: u32,
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) owner: Option<String>,
    pub(crate) status: JobStatus,
    pub(crate) exit_code: Option<i32>,
    pub(crate) detail: Option<String>,
    pub(crate) started_ms: u64,
    pub(crate) finished_ms: u64,
    pub(crate) stdout_total: u64,
    pub(crate) stderr_total: u64,
    pub(crate) stdout_tail: String,
    pub(crate) stdout_tail_start: u64,
    pub(crate) stderr_tail: String,
    pub(crate) stderr_tail_start: u64,
    pub(crate) stdout_spill: Option<PathBuf>,
    pub(crate) stderr_spill: Option<PathBuf>,
}

pub(crate) static SETTLED_HISTORY: std::sync::LazyLock<Mutex<VecDeque<SettledRecord>>> =
    std::sync::LazyLock::new(|| Mutex::new(VecDeque::new()));

static NEXT_JOB_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// 单条后台通知 — 携带发起者（job owner）实现按 agent 路由投递。
pub(crate) struct BgNote {
    owner: Option<String>,
    pub(crate) text: String,
}

/// 通知队列 — 由 agent 在每次 stream() 调用前按自己的 agent_id 排干。
pub(crate) static COMPLETED_NOTES: std::sync::LazyLock<Mutex<Vec<BgNote>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

fn push_note(owner: Option<String>, msg: String) {
    let mut notes = lock_or_recover(&COMPLETED_NOTES);
    notes.push(BgNote { owner, text: msg });
    let overflow = notes.len().saturating_sub(MAX_COMPLETED_NOTES);
    if overflow > 0 {
        notes.drain(..overflow);
    }
}

/// 通知前端「该 owner 有新通知」— 前端监听后排干该 owner 的通知。
fn emit_bg_note(app: &Option<tauri::AppHandle>, job_id: u32, owner: Option<String>) {
    if let Some(app) = app {
        let _ = app.emit(
            "bg:note",
            serde_json::json!({ "jobId": job_id, "owner": owner }),
        );
    }
}

/// 通知前端「job 名册变了」（注册 / 结算 / 移除）——役册据此立即刷新，不必等下一个轮询周期。
fn emit_job_changed(app: &Option<tauri::AppHandle>, job_id: u32) {
    if let Some(app) = app {
        let _ = app.emit("job:changed", serde_json::json!({ "jobId": job_id }));
    }
}

// ═══════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 全量日志目录：优先 `<workspace>/.lantai/jobs`，不可写则退回临时目录。
fn jobs_dir() -> PathBuf {
    let dir = crate::utils::project_root().join(".lantai").join("jobs");
    if std::fs::create_dir_all(&dir).is_ok() {
        dir
    } else {
        let fallback = std::env::temp_dir().join("lantai-jobs");
        let _ = std::fs::create_dir_all(&fallback);
        fallback
    }
}

/// 启动后首次建 job 时清理 7 天前的日志残留（不阻塞、失败静默）。
fn sweep_job_spills_once() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = jobs_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        let cutoff =
            std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(7 * 24 * 3600));
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(modified) = meta.modified() else {
                continue;
            };
            if let Some(cutoff) = cutoff {
                if modified < cutoff {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    });
}

fn job_spill_path(id: u32, stream: &str) -> PathBuf {
    jobs_dir().join(format!("{}-{id}-{stream}.log", std::process::id()))
}

// ═══════════════════════════════════════════════════════
// 生命周期
// ═══════════════════════════════════════════════════════

/// 从 ledger 移除 job 并释放其构建锁（所有 job 移除路径的统一出口）。
/// 若进程已退出，顺带把投影归档进历史（役册行不会凭空消失）。
pub(crate) fn remove_job(id: u32) -> Option<BgJob> {
    let removed = {
        let mut jobs = lock_or_recover(&BG_JOBS);
        let mut job = jobs.remove(&id)?;
        if let Some(k) = &job.lock_key {
            lock_or_recover(&BUILD_LOCKS).remove(k);
            job.lock_key = None;
        }
        job
    };
    if removed.status.is_terminal() {
        archive_job_with_id(removed, id);
        return None;
    }
    Some(removed)
}

/// 预留下一个 job id（acquire_build_lock 与 spawn 共用同一 id，保证锁原子注册）。
pub(crate) fn next_job_id() -> u32 {
    NEXT_JOB_ID.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
}

fn settle(job: &mut BgJob, status: JobStatus, exit_code: Option<i32>, detail: Option<String>) {
    if job.status.is_terminal() {
        return;
    }
    job.status = status;
    job.exit_code = exit_code;
    job.finished_ms = Some(now_ms());
    if detail.is_some() {
        job.detail = detail;
    }
}

/// 把已结算 job 的投影 + 输出尾巴 + 日志路径存进历史（有界）。
fn archive_job_with_id(job: BgJob, id: u32) {
    let (stdout_tail, stdout_tail_start) = job.shared.stdout.tail_text(SETTLED_TAIL_BYTES);
    let (stderr_tail, stderr_tail_start) = job.shared.stderr.tail_text(SETTLED_TAIL_BYTES);
    let (stdout_total, _) = job.shared.stdout.coords();
    let (stderr_total, _) = job.shared.stderr.coords();
    push_history(SettledRecord {
        id,
        kind: job.kind,
        label: job.label,
        owner: job.owner,
        status: job.status,
        exit_code: job.exit_code,
        detail: job.detail,
        started_ms: job.started_ms,
        finished_ms: job.finished_ms.unwrap_or_else(now_ms),
        stdout_total,
        stderr_total,
        stdout_tail,
        stdout_tail_start,
        stderr_tail,
        stderr_tail_start,
        stdout_spill: job.shared.stdout.spill_path().cloned(),
        stderr_spill: job.shared.stderr.spill_path().cloned(),
    });
}

fn push_history(record: SettledRecord) {
    let mut history = lock_or_recover(&SETTLED_HISTORY);
    history.push_front(record);
    while history.len() > MAX_HISTORY {
        history.pop_back();
    }
}

/// 已结算未读 job 超限时，把最旧的迁进历史（先到先出）。
fn enforce_settled_cap() {
    let victim = {
        let jobs = lock_or_recover(&BG_JOBS);
        let terminal: Vec<(u32, u64)> = jobs
            .iter()
            .filter(|(_, j)| j.status.is_terminal())
            .map(|(id, j)| (*id, j.finished_ms.unwrap_or(0)))
            .collect();
        if terminal.len() <= MAX_SETTLED_UNREAD {
            return;
        }
        let mut sorted = terminal;
        sorted.sort_by_key(|(_, t)| *t);
        sorted.first().map(|(id, _)| *id)
    };
    if let Some(id) = victim {
        let job = lock_or_recover(&BG_JOBS).remove(&id);
        if let Some(mut job) = job {
            if let Some(k) = job.lock_key.take() {
                lock_or_recover(&BUILD_LOCKS).remove(&k);
            }
            archive_job_with_id(job, id);
        }
    }
}

// ═══════════════════════════════════════════════════════
// 投递 / 拉起
// ═══════════════════════════════════════════════════════

/// 启动监控线程，每秒轮询子进程状态。
fn spawn_monitor(id: u32, label: String, app: Option<tauri::AppHandle>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));

        let mut terminal: Option<(Option<String>, i32, u64, Arc<AtomicUsize>)> = None;
        {
            let mut jobs = lock_or_recover(&BG_JOBS);
            let Some(job) = jobs.get_mut(&id) else { return };
            if job.status.is_terminal() {
                return;
            }
            match job.child.try_wait() {
                Ok(Some(status)) => {
                    settle(
                        job,
                        JobStatus::Completed,
                        Some(status.code().unwrap_or(-1)),
                        None,
                    );
                    // 在锁内取齐收尾所需事实：读方随后移除 job 也不会丢通知。
                    if let Some(k) = job.lock_key.take() {
                        lock_or_recover(&BUILD_LOCKS).remove(&k);
                    }
                    terminal = Some((
                        job.owner.clone(),
                        job.exit_code.unwrap_or(-1),
                        job.start_time.elapsed().as_secs(),
                        Arc::clone(&job.shared.drain_done),
                    ));
                }
                Ok(None) => {
                    let stall_elapsed = job.last_output_time.elapsed();
                    if stall_elapsed > STALL_THRESHOLD {
                        let owner = job.owner.clone();
                        let msg = format!(
                            "⚠️ 后台任务可能已停滞: {} 已 {}s 无输出 (job_id: {})。考虑用 bash_output({}) 检查或 bash_kill({}) 终止。",
                            label, stall_elapsed.as_secs(), id, id, id
                        );
                        job.last_output_time = std::time::Instant::now();
                        drop(jobs);
                        push_note(owner.clone(), msg);
                        emit_bg_note(&app, id, owner);
                        continue;
                    }
                }
                Err(_) => return,
            }
        }

        if let Some((owner, ec, elapsed, drain)) = terminal {
            wait_for_drain(&drain, 2, std::time::Duration::from_secs(3));
            push_note(
                owner.clone(),
                format!(
                    "后台任务已完成: {} (exit code: {}, 耗时: {}s)。使用 bash_output({}) 查看输出。",
                    label, ec, elapsed, id
                ),
            );
            emit_bg_note(&app, id, owner);
            emit_job_changed(&app, id);
            enforce_settled_cap();
            return;
        }
    });
}

/// 前台超时转后台时给「监视线程已挂上」用的入口（2026-11-12 DSH `promoted` 对齐批）。
pub(crate) fn spawn_monitor_for_existing(id: u32, label: String, app: Option<tauri::AppHandle>) {
    spawn_monitor(id, label, app);
}

/// 有界等待 drain 线程收尾。最终读取前调用，避免"进程已退出但管道尾部还没进环"。
fn wait_for_drain(done: &AtomicUsize, expected: usize, timeout: std::time::Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while done.load(Ordering::SeqCst) < expected && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// 把已启动的 SandboxedChild 注册为后台任务。
pub(crate) fn spawn_bg_from_child(
    id: u32,
    child: os_sandbox::SandboxedChild,
    label: &str,
    owner: Option<String>,
    lock_key: Option<LockKey>,
    app: Option<tauri::AppHandle>,
) -> Result<u32, String> {
    sweep_job_spills_once();
    let now = std::time::Instant::now();
    let mut child = child;

    let stdout_ring = Arc::new(StreamRing::with_spill(job_spill_path(id, "stdout")));
    let stderr_ring = Arc::new(StreamRing::with_spill(job_spill_path(id, "stderr")));
    let drain_done: Arc<AtomicUsize> = Default::default();

    if let Some(mut reader) = child.take_stdout() {
        let ring = Arc::clone(&stdout_ring);
        let done = Arc::clone(&drain_done);
        std::thread::spawn(move || {
            use std::io::{IoSliceMut, Read};
            let mut chunk = [0u8; 4096];
            loop {
                let n = {
                    let mut iov = [IoSliceMut::new(&mut chunk)];
                    match reader.read_vectored(&mut iov) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(_) => break,
                    }
                };
                ring.push(&chunk[..n]);
            }
            done.fetch_add(1, Ordering::SeqCst);
        });
    } else {
        drain_done.fetch_add(1, Ordering::SeqCst);
    }
    if let Some(mut reader) = child.take_stderr() {
        let ring = Arc::clone(&stderr_ring);
        let done = Arc::clone(&drain_done);
        std::thread::spawn(move || {
            use std::io::{IoSliceMut, Read};
            let mut chunk = [0u8; 4096];
            loop {
                let n = {
                    let mut iov = [IoSliceMut::new(&mut chunk)];
                    match reader.read_vectored(&mut iov) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(_) => break,
                    }
                };
                ring.push(&chunk[..n]);
            }
            done.fetch_add(1, Ordering::SeqCst);
        });
    } else {
        drain_done.fetch_add(1, Ordering::SeqCst);
    }

    let job = BgJob {
        child,
        stdout_cursor: 0,
        stderr_cursor: 0,
        stdout_decoder: crate::utils::StreamDecoder::new(),
        stderr_decoder: crate::utils::StreamDecoder::new(),
        start_time: now,
        started_ms: now_ms(),
        label: label.to_string(),
        kind: "bash".to_string(),
        last_output_time: now,
        shared: BgSharedOutput {
            stdout: stdout_ring,
            stderr: stderr_ring,
            drain_done,
        },
        owner,
        lock_key,
        status: JobStatus::Running,
        exit_code: None,
        finished_ms: None,
        detail: None,
    };
    crate::utils::lock_or_recover(&BG_JOBS).insert(id, job);
    spawn_monitor(id, label.to_string(), app.clone());
    emit_job_changed(&app, id);
    Ok(id)
}

/// 带调用方预留 job_id + 显式解释器的后台启动。
pub(crate) fn spawn_bg_with(
    id: u32,
    cmd: &str,
    cwd: &str,
    interpreter: crate::os_sandbox::ShellInterpreter,
    owner: Option<String>,
    lock_key: Option<LockKey>,
    app: Option<tauri::AppHandle>,
) -> Result<u32, String> {
    let child = match os_sandbox::spawn_shell_with(cmd, cwd, interpreter) {
        Ok(c) => c,
        Err(e) => {
            crate::utils::build_lock::release_build_lock(&lock_key);
            return Err(format!("无法启动后台命令: {e}"));
        }
    };
    let label: String = cmd.chars().take(80).collect();
    spawn_bg_from_child(id, child, &label, owner, lock_key, app)
}

/// P1-21: 前台子进程注册进 ledger（不 spawn monitor — 前台路径自己等待并负责移除）。
pub(crate) fn register_fg_child(
    id: u32,
    child: os_sandbox::SandboxedChild,
    label: &str,
    shared: BgSharedOutput,
    owner: Option<String>,
    lock_key: Option<LockKey>,
) {
    let now = std::time::Instant::now();
    let job = BgJob {
        child,
        stdout_cursor: 0,
        stderr_cursor: 0,
        stdout_decoder: crate::utils::StreamDecoder::new(),
        stderr_decoder: crate::utils::StreamDecoder::new(),
        start_time: now,
        started_ms: now_ms(),
        label: label.to_string(),
        kind: "bash".to_string(),
        last_output_time: now,
        shared,
        owner,
        lock_key,
        status: JobStatus::Running,
        exit_code: None,
        finished_ms: None,
        detail: None,
    };
    crate::utils::lock_or_recover(&BG_JOBS).insert(id, job);
}

// ═══════════════════════════════════════════════════════
// 模型侧读取（消费式，文本逐字保持 2026-08 起的语义）
// ═══════════════════════════════════════════════════════

/// 读「自模型游标以来」的新增字节并推进游标；环淘汰过游标时报 lost 并对齐。
fn read_increment(job: &mut BgJob) -> (String, String, Vec<String>) {
    let mut notes = Vec::new();

    let (out_bytes, out_next, out_lossy) = job.shared.stdout.raw_from(job.stdout_cursor);
    if out_lossy {
        notes.push("[stdout 输出有丢失：超出滚动缓冲被丢弃]".to_string());
        job.stdout_decoder = crate::utils::StreamDecoder::new();
    }
    let out_text = job.stdout_decoder.push(&out_bytes);
    job.stdout_cursor = out_next;

    let (err_bytes, err_next, err_lossy) = job.shared.stderr.raw_from(job.stderr_cursor);
    if err_lossy {
        notes.push("[stderr 输出有丢失：超出滚动缓冲被丢弃]".to_string());
        job.stderr_decoder = crate::utils::StreamDecoder::new();
    }
    let err_text = job.stderr_decoder.push(&err_bytes);
    job.stderr_cursor = err_next;

    (out_text, err_text, notes)
}

pub(crate) fn read_bg_output(id: u32) -> Result<String, String> {
    // 先看是否已完成；若已完成，先等 drain 收尾再读最终输出（不持锁等待）。
    let drain_to_wait = {
        let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
        let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
        let terminal = match job.status.is_terminal() {
            true => true,
            false => match job.child.try_wait() {
                Ok(Some(status)) => {
                    settle(
                        job,
                        JobStatus::Completed,
                        Some(status.code().unwrap_or(-1)),
                        None,
                    );
                    true
                }
                Ok(None) => false,
                Err(e) => return Err(format!("检查进程状态失败: {e}")),
            },
        };
        terminal.then(|| Arc::clone(&job.shared.drain_done))
    };
    if let Some(drain_done) = drain_to_wait {
        wait_for_drain(&drain_done, 2, std::time::Duration::from_secs(3));
    }

    let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
    let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
    let terminal = job.status.is_terminal();

    let (mut stdout_inc, mut stderr_inc, lost_notes) = read_increment(job);
    let has_new = !stdout_inc.is_empty() || !stderr_inc.is_empty();
    if has_new {
        job.last_output_time = std::time::Instant::now();
    }

    let elapsed = if terminal {
        job.finished_ms
            .map(|f| f.saturating_sub(job.started_ms) / 1000)
            .unwrap_or(0)
    } else {
        job.start_time.elapsed().as_secs()
    };

    if terminal {
        let tail_o =
            std::mem::replace(&mut job.stdout_decoder, crate::utils::StreamDecoder::new()).finish();
        let tail_e =
            std::mem::replace(&mut job.stderr_decoder, crate::utils::StreamDecoder::new()).finish();
        stdout_inc.push_str(&tail_o);
        stderr_inc.push_str(&tail_e);
    }

    let mut result = String::new();
    for n in &lost_notes {
        result.push_str(n);
        result.push('\n');
    }
    if terminal {
        result.push_str(&format!(
            "[任务已完成, exit code: {}, 耗时: {}s]\n",
            job.exit_code.unwrap_or(-1),
            elapsed
        ));
        if let Some(reason) = &job.detail {
            result.push_str(&format!("[stopped: {reason}]\n"));
        }
    } else {
        result.push_str(&format!("[任务运行中, 已运行: {}s]\n", elapsed));
    }
    result.push_str(&stdout_inc);
    result.push_str(&stderr_inc);

    if terminal {
        if let Some(mut finished) = jobs.remove(&id) {
            if let Some(k) = finished.lock_key.take() {
                lock_or_recover(&BUILD_LOCKS).remove(&k);
            }
            drop(jobs);
            archive_job_with_id(finished, id);
        }
    }
    Ok(result)
}

/// 阻塞等待后台任务完成（或超时）。返回完整输出和退出码。
pub(crate) fn wait_bg(id: u32, timeout_ms: u64) -> Result<String, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let (status, drain_done, started) = {
            let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
            let Some(job) = jobs.get_mut(&id) else {
                // 已结算且被归档 —— 与"已完成"同义（模型读到的是同一条文案）。
                return Err("后台任务不存在或已完成".to_string());
            };
            if job.status.is_terminal() {
                (Some(job.exit_code.unwrap_or(-1)), None, job.start_time)
            } else {
                let status = job
                    .child
                    .try_wait()
                    .map_err(|e| format!("检查进程状态失败: {e}"))?;
                match status {
                    Some(st) => {
                        settle(
                            job,
                            JobStatus::Completed,
                            Some(st.code().unwrap_or(-1)),
                            None,
                        );
                        (
                            Some(st.code().unwrap_or(-1)),
                            Some(Arc::clone(&job.shared.drain_done)),
                            job.start_time,
                        )
                    }
                    None => (None, None, job.start_time),
                }
            }
        };
        match status {
            Some(_) => {
                if let Some(d) = drain_done {
                    wait_for_drain(&d, 2, std::time::Duration::from_secs(3));
                }
                let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
                let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
                let stdout_str = job.shared.stdout.decode_all();
                let stderr_str = job.shared.stderr.decode_all();
                let ec = job.exit_code.unwrap_or(-1);
                let detail = job.detail.clone();
                let elapsed = job
                    .finished_ms
                    .map(|f| f.saturating_sub(job.started_ms) / 1000)
                    .unwrap_or_else(|| started.elapsed().as_secs());
                if let Some(mut finished) = jobs.remove(&id) {
                    if let Some(k) = finished.lock_key.take() {
                        lock_or_recover(&BUILD_LOCKS).remove(&k);
                    }
                    drop(jobs);
                    archive_job_with_id(finished, id);
                }
                let mut out = format!("[任务已完成, exit code: {}, 耗时: {}s]\n", ec, elapsed);
                if let Some(reason) = detail {
                    out.push_str(&format!("[stopped: {reason}]\n"));
                }
                out.push_str(&stdout_str);
                out.push_str(&stderr_str);
                return Ok(out);
            }
            None => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!("等待超时 ({}ms)", timeout_ms));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }
}

/// 终止后台任务（模型侧）。caller=Some(agent_id) 时校验所有权。
pub(crate) fn kill_bg(id: u32, caller: Option<&str>) -> Result<String, String> {
    let (lock_key, output) = {
        let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
        let job = jobs.get_mut(&id).ok_or("后台任务不存在或已完成")?;
        if let Some(caller) = caller {
            match job.owner.as_deref() {
                None => {
                    return Err(
                        "该任务由用户发起，Agent 无权终止。请等待其完成或由用户手动清理。".into(),
                    )
                }
                Some(owner) if owner != caller => {
                    return Err(format!("该任务由 {owner} 持有，当前 Agent 无权终止"))
                }
                _ => {}
            }
        }
        job.child
            .kill_tree()
            .map_err(|e| format!("无法终止任务: {e}"))?;
        settle(job, JobStatus::Killed, None, None);
        let stdout = job.shared.stdout.decode_all();
        let stderr = job.shared.stderr.decode_all();
        let lk = job.lock_key.take();
        jobs.remove(&id);
        (lk, format!("[任务已终止]\n{stdout}{stderr}"))
    };
    if let Some(k) = lock_key {
        crate::utils::lock_or_recover(&BUILD_LOCKS).remove(&k);
    }
    Ok(output)
}

/// 人类（役册）停止一个 job：允许停任何本机 job；原因进 detail，模型收到带原因的完成通知。
pub(crate) fn job_kill_human(
    id: u32,
    reason: &str,
    app: Option<tauri::AppHandle>,
) -> Result<&'static str, String> {
    let (requested, owner, label) = {
        let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
        match jobs.get_mut(&id) {
            None => (false, None, String::new()),
            Some(job) => {
                if job.status.is_terminal() {
                    (false, None, String::new())
                } else {
                    job.status = JobStatus::Stopping;
                    job.child
                        .kill_tree()
                        .map_err(|e| format!("无法终止任务: {e}"))?;
                    let exit_code = job.exit_code;
                    settle(job, JobStatus::Killed, exit_code, Some(reason.to_string()));
                    (true, job.owner.clone(), job.label.clone())
                }
            }
        }
    };
    if requested {
        push_note(
            owner.clone(),
            format!(
                "后台任务已被用户停止: {}（{}）。使用 bash_output({}) 查看输出。",
                label, reason, id
            ),
        );
        emit_bg_note(&app, id, owner);
        emit_job_changed(&app, id);
        return Ok("requested");
    }
    if lock_or_recover(&SETTLED_HISTORY).iter().any(|r| r.id == id) {
        Ok("already-finished")
    } else {
        Err(format!("后台任务不存在: {id}"))
    }
}

/// 终止全部后台任务（workspace 切换时调用）。
pub(crate) fn kill_all_bg() {
    let mut jobs = crate::utils::lock_or_recover(&BG_JOBS);
    for (_, job) in jobs.iter_mut() {
        let _ = job.child.kill_tree();
    }
    jobs.clear();
    crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
}

/// 排空并返回指定 agent 的待处理后台通知（只取 owner 匹配的，其余保留）。
pub(crate) fn drain_bg_notifications(agent_id: Option<&str>) -> String {
    let mut notes = lock_or_recover(&COMPLETED_NOTES);
    if notes.is_empty() {
        return String::new();
    }
    let mut mine = String::new();
    notes.retain(|note| {
        let owned = note.owner.as_deref() == agent_id;
        if owned {
            if !mine.is_empty() {
                mine.push('\n');
            }
            mine.push_str(&note.text);
        }
        !owned
    });
    mine
}

#[cfg(test)]
#[path = "bg_jobs_tests.rs"]
mod tests;

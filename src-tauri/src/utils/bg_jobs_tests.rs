// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// bg_jobs 的单元测试（从 bg_jobs.rs 拆出，2026-11-15 上帝文件治理）。
//
// 经 #[path] 挂回 bg_jobs 的 mod tests——等价于原先的 inline 模块，
// 保留对私有项的访问权；拆开只为让生产码回到 LIMIT 以下可读。

use super::*;
use crate::utils::job_observe::{job_list, job_read_at};
use crate::utils::stream_ring::MAX_SHARED_OUTPUT_BYTES;

static BUILD_LOCK_TESTS: Mutex<()> = Mutex::new(());

/// 测试互斥锁容忍中毒：某个用例断言失败时，其余用例继续跑（否则级联 PoisonError 掩盖真因）。
fn serial() -> std::sync::MutexGuard<'static, ()> {
    BUILD_LOCK_TESTS.lock().unwrap_or_else(|e| e.into_inner())
}

/// 手工构造 job（无真实进程）：直接操作共享环模拟 drain 线程写入。
fn make_idle_job(tag: &str) -> u32 {
    let id = next_job_id();
    let child = crate::os_sandbox::spawn_shell(&format!("sleep 30 # {tag}"), ".")
        .expect("spawn_shell failed");
    register_fg_child(id, child, tag, BgSharedOutput::default(), None, None);
    id
}

fn push_shared(id: u32, stream: &str, bytes: &[u8]) {
    let jobs = lock_or_recover(&BG_JOBS);
    let job = jobs.get(&id).expect("job exists");
    if stream == "out" {
        job.shared.stdout.push(bytes);
    } else {
        job.shared.stderr.push(bytes);
    }
}

fn clear_history() {
    lock_or_recover(&SETTLED_HISTORY).clear();
}

#[test]
fn read_bg_output_returns_only_increment() {
    let _g = serial();
    clear_history();
    let id = make_idle_job("inc");
    push_shared(id, "out", b"first chunk\n");
    let r1 = read_bg_output(id).expect("read 1");
    assert!(r1.contains("first chunk"), "r1: {r1}");
    assert!(r1.contains("任务运行中"), "r1: {r1}");

    let r2 = read_bg_output(id).expect("read 2");
    assert!(!r2.contains("first chunk"), "旧输出不得重复下发: {r2}");

    push_shared(id, "out", b"second chunk\n");
    let r3 = read_bg_output(id).expect("read 3");
    assert!(r3.contains("second chunk"), "r3: {r3}");
    assert!(!r3.contains("first chunk"), "r3 不得重发旧输出: {r3}");

    kill_bg(id, None).ok();
}

#[test]
fn read_bg_output_incremental_multibyte_across_reads() {
    let _g = serial();
    clear_history();
    let id = make_idle_job("mb");
    push_shared(id, "out", &b"\xe4\xb8"[..]);
    let r1 = read_bg_output(id).expect("read 1");
    assert!(!r1.contains('\u{fffd}'), "跨块不得出 U+FFFD: {r1}");
    push_shared(id, "out", b"\xad ok\n");
    let r2 = read_bg_output(id).expect("read 2");
    assert!(r2.contains("中 ok"), "补齐后应产出完整字: {r2}");
    kill_bg(id, None).ok();
}

#[test]
fn read_bg_output_reports_lost_on_ring_overwrite() {
    let _g = serial();
    clear_history();
    let id = make_idle_job("lost");
    let big = vec![b'x'; MAX_SHARED_OUTPUT_BYTES + 4096];
    push_shared(id, "out", &big);
    // 游标落在已淘汰区（< dropped）→ 必须报 lost 并对齐
    {
        let mut jobs = lock_or_recover(&BG_JOBS);
        let job = jobs.get_mut(&id).expect("job");
        job.stdout_cursor = 10;
    }
    let r = read_bg_output(id).expect("read");
    assert!(r.contains("输出有丢失"), "环形丢弃必须报 lost: {r}");
    kill_bg(id, None).ok();
}

// ── 观测面：非消费读 / 绝对偏移 / 结算保留 ──

#[test]
fn read_at_is_non_consuming() {
    let _g = serial();
    clear_history();
    let id = make_idle_job("obs");
    push_shared(id, "out", b"hello-observable\n");
    let a = job_read_at(id, 0, 0).expect("read at 1");
    let b = job_read_at(id, 0, 0).expect("read at 2");
    assert_eq!(a, b, "同一偏移两次观测必须一致（非消费）");
    // 模型读仍能拿到全部内容
    let model = read_bg_output(id).expect("model read");
    assert!(
        model.contains("hello-observable"),
        "模型读被观测读吃掉: {model}"
    );
    kill_bg(id, None).ok();
}

#[test]
fn read_at_reports_absolute_offsets_and_loss() {
    let _g = serial();
    clear_history();
    let id = make_idle_job("abs");
    push_shared(id, "out", b"0123456789");
    let r: serde_json::Value =
        serde_json::from_str(&job_read_at(id, 4, 0).expect("read")).expect("json");
    assert_eq!(r["stdout"]["text"], "456789");
    assert_eq!(r["stdout"]["next"], 10);
    assert_eq!(r["total"]["stdout"], 10);

    // 超限写入 → 头部淘汰；从 0 读必须 lossy
    let big = vec![b'z'; MAX_SHARED_OUTPUT_BYTES + 1024];
    push_shared(id, "out", &big);
    let r2: serde_json::Value =
        serde_json::from_str(&job_read_at(id, 0, 0).expect("read2")).expect("json");
    assert_eq!(r2["stdout"]["lossy"], true, "淘汰后从头读必须标 lossy");
    kill_bg(id, None).ok();
}

#[test]
fn settled_job_keeps_projection_after_model_read() {
    let _g = serial();
    clear_history();
    let id = make_idle_job("settle");
    push_shared(id, "out", b"done-output\n");
    {
        let mut jobs = lock_or_recover(&BG_JOBS);
        let job = jobs.get_mut(&id).expect("job");
        settle(job, JobStatus::Completed, Some(0), None);
    }
    let list_before = job_list();
    assert!(
        list_before
            .iter()
            .any(|v| v["id"] == id && v["status"] == "completed"),
        "结算后名册必须仍含该 job"
    );
    let _ = read_bg_output(id).expect("final read");
    let list_after = job_list();
    assert!(
        list_after
            .iter()
            .any(|v| v["id"] == id && v["status"] == "completed"),
        "模型终读后投影必须仍在（历史）"
    );
}

#[test]
fn human_kill_records_reason_and_notifies_owner() {
    let _g = serial();
    clear_history();
    lock_or_recover(&COMPLETED_NOTES).clear();
    let id = next_job_id();
    let child = crate::os_sandbox::spawn_shell("sleep 30 # killh", ".").expect("spawn");
    register_fg_child(
        id,
        child,
        "killh",
        BgSharedOutput::default(),
        Some("agent-x".into()),
        None,
    );
    assert_eq!(
        job_kill_human(id, "cancelled by the user", None).unwrap(),
        "requested"
    );
    {
        let jobs = lock_or_recover(&BG_JOBS);
        let job = jobs.get(&id).expect("job");
        assert_eq!(job.status, JobStatus::Killed);
        assert_eq!(job.detail.as_deref(), Some("cancelled by the user"));
    }
    let notes = drain_bg_notifications(Some("agent-x"));
    assert!(
        notes.contains("已被用户停止"),
        "owner 必须收到带原因的完成通知: {notes}"
    );
    // 第二次停同一条 = 已完成
    assert_eq!(
        job_kill_human(id, "again", None).unwrap_or("already-finished"),
        "already-finished"
    );
    lock_or_recover(&BG_JOBS).remove(&id);
}

#[test]
fn projection_carries_spill_paths_and_coords() {
    let _g = serial();
    clear_history();
    let id = make_idle_job("proj");
    push_shared(id, "out", b"abc");
    let list = job_list();
    let row = list.iter().find(|v| v["id"] == id).expect("row");
    assert_eq!(row["status"], "running");
    assert_eq!(row["output"]["stdout"]["total"], 3);
    assert_eq!(row["output"]["stdout"]["earliest"], 0);
    kill_bg(id, None).ok();
}

#[test]
fn spill_file_holds_full_stream() {
    let _g = serial();
    clear_history();
    let id = next_job_id();
    let path = job_spill_path(id, "stdout");
    let _ = std::fs::remove_file(&path);
    let ring = StreamRing::with_spill(path.clone());
    let big = vec![b's'; MAX_SHARED_OUTPUT_BYTES + 4096];
    ring.push(&big);
    let on_disk = std::fs::read(&path).expect("spill exists");
    assert_eq!(on_disk.len(), big.len(), "全量日志必须包含环外的字节");
    let _ = std::fs::remove_file(&path);
}

// ── 通知按 owner 路由 ──

static NOTE_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn bg_notifications_route_by_owner() {
    let _g = NOTE_TESTS.lock().expect("note tests lock");
    let mut notes = lock_or_recover(&COMPLETED_NOTES);
    notes.clear();
    notes.push(BgNote {
        owner: Some("agent-a".into()),
        text: "A1".into(),
    });
    notes.push(BgNote {
        owner: Some("agent-b".into()),
        text: "B1".into(),
    });
    notes.push(BgNote {
        owner: None,
        text: "UI1".into(),
    });
    drop(notes);

    let a = drain_bg_notifications(Some("agent-a"));
    assert!(
        a.contains("A1") && !a.contains("B1") && !a.contains("UI1"),
        "a: {a}"
    );
    let b = drain_bg_notifications(Some("agent-b"));
    assert!(b.contains("B1") && !b.contains("UI1"), "b: {b}");
    let a2 = drain_bg_notifications(Some("agent-a"));
    assert!(a2.is_empty(), "a2: {a2}");
}

#[test]
fn bg_notification_queue_bounded() {
    let _g = NOTE_TESTS.lock().expect("note tests lock");
    lock_or_recover(&COMPLETED_NOTES).clear();
    for i in 0..(MAX_COMPLETED_NOTES + 50) {
        push_note(Some("dead-agent".into()), format!("n{i}"));
    }
    let drained = drain_bg_notifications(Some("dead-agent"));
    let lines: Vec<&str> = drained.split('\n').collect();
    assert!(
        lines.contains(&"n249"),
        "最新通知丢失（共 {} 行）",
        lines.len()
    );
    assert!(!lines.contains(&"n0"), "最旧通知应已被丢弃");
    assert_eq!(lines.len(), MAX_COMPLETED_NOTES, "保留数应恰为上限");
}

#[test]
fn remove_job_releases_build_lock() {
    let _g = serial();
    let id = next_job_id();
    let k =
        crate::utils::build_lock::acquire_build_lock("cargo build", "C:/ws-bg-remove", id, None)
            .unwrap()
            .unwrap();
    let child = crate::os_sandbox::spawn_shell("echo x", ".").expect("spawn");
    register_fg_child(
        id,
        child,
        "test",
        BgSharedOutput::default(),
        None,
        Some(k.clone()),
    );
    remove_job(id);
    assert!(
        !crate::utils::lock_or_recover(&BUILD_LOCKS).contains_key(&k),
        "remove_job 应释放构建锁"
    );
}

#[test]
fn spawn_bg_with_failure_releases_build_lock() {
    let _g = serial();
    let id = next_job_id();
    let k = crate::utils::build_lock::acquire_build_lock("cargo build", "C:/ws-bg-fail", id, None)
        .unwrap()
        .unwrap();
    let r = spawn_bg_with(
        id,
        "cargo build",
        r"C:\definitely-not-exist-hologram-test",
        crate::os_sandbox::ShellInterpreter::Auto,
        None,
        Some(k.clone()),
        None,
    );
    assert!(r.is_err(), "不存在的 cwd 应导致 spawn 失败: {r:?}");
    assert!(
        !crate::utils::lock_or_recover(&BUILD_LOCKS).contains_key(&k),
        "spawn 失败后 BuildLock 应已释放"
    );
    crate::utils::lock_or_recover(&BUILD_LOCKS).clear();
}

/// 无输出的长任务：read_bg_output 必须立即返回快照（修复前 shared=None 分支
/// 会持 BG_JOBS 锁阻塞读管道，任务安静时永久卡死）。shared 现为必填字段，
/// 该分支已从类型上移除，此测试锁定行为。
#[test]
fn bg_output_snapshot_quiet_task_returns_fast() {
    let _g = serial();
    let id = spawn_bg_with(
        next_job_id(),
        "sleep 30 # quiet-snapshot",
        ".",
        crate::os_sandbox::ShellInterpreter::Auto,
        None,
        None,
        None,
    )
    .expect("spawn_bg_with failed");
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

#[test]
fn spawn_bg_with_uses_given_job_id() {
    let _g = serial();
    let id = next_job_id();
    let kid = spawn_bg_with(
        id,
        "echo bg-id-ok",
        ".",
        crate::os_sandbox::ShellInterpreter::Auto,
        None,
        None,
        None,
    )
    .expect("spawn_bg_with failed");
    assert_eq!(kid, id, "后台 job_id 应与调用方预留 id 一致");
    let out = wait_bg(id, 10_000).expect("wait_bg failed");
    assert!(out.contains("bg-id-ok"), "unexpected output: {out}");
}

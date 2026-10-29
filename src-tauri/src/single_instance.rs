// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 单实例守卫（2026-10-29 会话存盘换轨收口）——把「单写者」从**假设**变成**强制**。
//
// 背景：会话事件日志的写面假定单进程单写者（每卷一份 append-only `.ndjson` +
// 每卷一条写后队列 + 每卷一个 seq 游标）。同一工作区被两个实例同时打开时：
//   ① 两份独立 seq 游标写同一文件 ⇒ 重复/缺号 ⇒ 重放面判「序号断裂」⇒ 打开时截断；
//   ② 卷号账 `_issue.json` 会撞号（两实例都读到 next=20、都发 20）；
//   ③ 清单投影 `_index.json` 互相覆盖。
// DSH 用「revision 双 stat + 每会话链」缓解跨进程并发；兰台的选择是**裁决**——
// 单实例是产品事实（一个桌面应用一个窗口），守卫比裁决更省。
//
// 机制：用户级 `~/.lantai/instance.lock` 上的 OS 文件锁（Rust 1.89 起 std 自带
// `File::try_lock`，Windows 实现 = `LockFileEx`）——**不引依赖**、不做 PID 探测
// （PID 会因复用/崩溃残留误判；OS 锁随进程消亡自动释放）。
// 拿不到锁 ⇒ 原生提示 + 退出。锁句柄由调用方 `mem::forget` 活到进程结束。

use std::fs::{File, TryLockError};
use std::path::PathBuf;

/// 尝试取得单实例锁。
///
/// 返回：
/// * `Ok(Some(file))` —— 拿到锁。**调用方必须让这个句柄活到进程结束**
///   （drop = 释放锁；惯例是 `std::mem::forget`）。
/// * `Ok(None)` —— 已有实例在跑（锁被占）。调用方提示 + 退出。
/// * `Err(msg)` —— 锁面本身不可用（目录建不出来 / 文件系统不支持锁）。
///   调用方**降级放行**并留痕：守卫不该因为环境怪癖把用户挡在门外。
pub(crate) fn try_acquire() -> Result<Option<File>, String> {
    let path = lock_path()?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("无法打开单实例锁 {}: {e}", path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(format!("单实例锁加锁失败 {}: {e}", path.display())),
    }
}

/// 锁文件路径（`~/.lantai/instance.lock`——与用户级数据同目录）。
fn lock_path() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录（USERPROFILE/HOME 均未设置）".to_string())?;
    let dir = PathBuf::from(home).join(".lantai");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建用户数据目录 {}: {e}", dir.display()))?;
    Ok(dir.join("instance.lock"))
}

/// 第二个实例的提示（无控制台也要看得见——Windows 下 `windows_subsystem` 已经
/// 关掉了 stderr；与 `purge.rs` 的 MessageBoxW 写法同款）。
pub(crate) fn notify_already_running() {
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};
        let text = "兰台已在运行。\n\n为避免同一工作区的会话记录被两个实例同时写入（会损坏卷日志），本次启动已退出。";
        let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
        let (t, c) = (wide(text), wide("兰台"));
        unsafe {
            MessageBoxW(
                None,
                PCWSTR(t.as_ptr()),
                PCWSTR(c.as_ptr()),
                MB_OK | MB_ICONINFORMATION,
            );
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("[lantai] 兰台已在运行（单实例守卫）——本次启动退出。");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 同文件的第二把锁必须失败（WouldBlock），释放后可再取——
    /// 「单写者」的 OS 级证据（Windows = LockFileEx，unix = flock）。
    #[test]
    fn second_handle_cannot_lock_the_same_file() {
        let dir = std::env::temp_dir().join(format!("lantai_instance_lock_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("instance.lock");

        let open = || {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
                .unwrap()
        };

        let first = open();
        first.try_lock().expect("第一把锁必须成功");

        let second = open();
        let err = second.try_lock().expect_err("同文件第二把锁必须失败");
        assert!(
            matches!(err, TryLockError::WouldBlock),
            "锁冲突必须是 WouldBlock：{err:?}"
        );

        drop(first);
        second.try_lock().expect("前一把释放后应能取得");
        drop(second);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 输出环 — 单条流的有界内存环 + 绝对字节偏移 + 全量日志落盘。
//
// 从 bg_jobs.rs 拆出（2026-11-15 上帝文件治理）：这是后台任务子系统里最独立的一层——
// 只管「字节怎么进、怎么读、怎么落盘」，对 BG_JOBS 注册表、子进程句柄、通知面零依赖。
// 双读者模型（模型消费游标 vs 人非消费读）见 bg_jobs.rs 头注。

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::utils::ipc_guard::lock_or_recover;

/// 单流内存环上限（UTF-8 字节）。
pub(crate) const MAX_SHARED_OUTPUT_BYTES: usize = 1024 * 1024;
/// 单 job 单流全量日志上限；超过后停止落盘（内存环照常滚动）。
const MAX_SPILL_BYTES: u64 = 256 * 1024 * 1024;
// ═══════════════════════════════════════════════════════
// 环本体
// ═══════════════════════════════════════════════════════

struct RingInner {
    buf: Vec<u8>,
    /// 累计写入字节（= 下一个块的绝对偏移）。
    total: u64,
    /// 头部已丢弃字节（= 最老保留字节的绝对偏移）。
    dropped: u64,
}

/// 单条流的输出环。`push` 由 drain 线程调用；`read_from` 给观察者（非消费）；
/// 模型侧仍用 StreamDecoder + 自己的游标（见 BgJob）。
pub(crate) struct StreamRing {
    inner: Mutex<RingInner>,
    spill: Mutex<Option<std::fs::File>>,
    spill_path: Option<PathBuf>,
    spill_written: AtomicU64,
    spill_stopped: AtomicBool,
}

/// 一次观察者读取的结果（绝对偏移语义）。
pub(crate) struct StreamRead {
    pub text: String,
    /// 下一次读取的绝对偏移（落在完整字符边界上；尾部半截序列留待下次）。
    pub next: u64,
    /// `from` 早于最老保留字节 ⇒ 中间有字节已丢失。
    pub lossy: bool,
    pub earliest: u64,
    pub total: u64,
}

impl Default for StreamRing {
    fn default() -> Self {
        Self::plain()
    }
}

impl StreamRing {
    fn plain() -> Self {
        Self {
            inner: Mutex::new(RingInner { buf: Vec::new(), total: 0, dropped: 0 }),
            spill: Mutex::new(None),
            spill_path: None,
            spill_written: AtomicU64::new(0),
            spill_stopped: AtomicBool::new(false),
        }
    }

    /// 带全量日志落盘的环。
    pub(crate) fn with_spill(path: PathBuf) -> Self {
        Self { spill_path: Some(path), ..Self::plain() }
    }

    pub(crate) fn spill_path(&self) -> Option<&PathBuf> {
        self.spill_path.as_ref()
    }

    /// 追加一块原始字节：先落盘（best-effort），再进有界环。
    pub(crate) fn push(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.write_spill(bytes);
        let mut inner = lock_or_recover(&self.inner);
        inner.total += bytes.len() as u64;
        inner.buf.extend_from_slice(bytes);
        if inner.buf.len() > MAX_SHARED_OUTPUT_BYTES {
            let drop = inner.buf.len() - MAX_SHARED_OUTPUT_BYTES;
            inner.buf.drain(..drop);
            inner.dropped += drop as u64;
        }
    }

    /// (总写入字节, 最老保留偏移)。
    pub(crate) fn coords(&self) -> (u64, u64) {
        let inner = lock_or_recover(&self.inner);
        (inner.total, inner.dropped)
    }

    /// 观察者读取：从绝对偏移 `from` 读到当前末尾，**不消费任何东西**。
    pub(crate) fn read_from(&self, from: u64) -> StreamRead {
        let inner = lock_or_recover(&self.inner);
        let total = inner.total;
        let earliest = inner.dropped;
        if from >= total {
            return StreamRead { text: String::new(), next: total, lossy: false, earliest, total };
        }
        let (start, lossy) = if from < earliest {
            (0usize, true)
        } else {
            ((from - earliest) as usize, false)
        };
        let buf = &inner.buf;
        let mut start = start.min(buf.len());
        // 起点落在某个多字节字符中间时，跳到下一个字符起点（不产出半个字）。
        while start < buf.len() && (buf[start] & 0xC0) == 0x80 {
            start += 1;
        }
        let (text, consumed) = decode_prefix(&buf[start..]);
        StreamRead {
            text,
            next: earliest + start as u64 + consumed as u64,
            lossy,
            earliest,
            total,
        }
    }

    /// 模型终读用：整段缓冲区（与 2026-08 起的行为一致）。
    pub(crate) fn decode_all(&self) -> String {
        let inner = lock_or_recover(&self.inner);
        crate::utils::decode_shell_bytes(&inner.buf)
    }

    /// 模型游标用的原始字节读取：[from, total) 的字节 + 下一偏移 + 是否 lossy。
    ///
    /// 与 `read_from` 的区别是**不对齐字符边界**：模型游标是精确字节偏移，可能停在
    /// 多字节字符中间，残余由 `StreamDecoder` 持有。对齐会丢掉补齐用的续字节
    /// （实测会把「中」解成 GBK 乱码）。
    pub(crate) fn raw_from(&self, from: u64) -> (Vec<u8>, u64, bool) {
        let inner = lock_or_recover(&self.inner);
        let total = inner.total;
        let earliest = inner.dropped;
        if from >= total {
            return (Vec::new(), total, false);
        }
        let (start, lossy) = if from < earliest {
            (0usize, true)
        } else {
            ((from - earliest) as usize, false)
        };
        let start = start.min(inner.buf.len());
        (inner.buf[start..].to_vec(), total, lossy)
    }

    /// 历史记录用：保留最后 `cap` 字节的文本 + 其绝对起点。
    pub(crate) fn tail_text(&self, cap: usize) -> (String, u64) {
        let inner = lock_or_recover(&self.inner);
        let buf = &inner.buf;
        if buf.len() <= cap {
            return (crate::utils::decode_shell_bytes(buf), inner.total - buf.len() as u64);
        }
        let mut start = buf.len() - cap;
        while start < buf.len() && (buf[start] & 0xC0) == 0x80 {
            start += 1;
        }
        (crate::utils::decode_shell_bytes(&buf[start..]), inner.total - (buf.len() - start) as u64)
    }

    fn write_spill(&self, bytes: &[u8]) {
        let Some(path) = &self.spill_path else { return };
        if self.spill_stopped.load(Ordering::Relaxed) {
            return;
        }
        let written = self.spill_written.load(Ordering::Relaxed);
        if written + bytes.len() as u64 > MAX_SPILL_BYTES {
            self.spill_stopped.store(true, Ordering::Relaxed);
            return;
        }
        let mut guard = lock_or_recover(&self.spill);
        if guard.is_none() {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match std::fs::OpenOptions::new().create(true).append(true).open(path) {
                Ok(f) => *guard = Some(f),
                Err(_) => {
                    self.spill_stopped.store(true, Ordering::Relaxed);
                    return;
                }
            }
        }
        if let Some(f) = guard.as_mut() {
            if f.write_all(bytes).is_ok() {
                self.spill_written.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            } else {
                self.spill_stopped.store(true, Ordering::Relaxed);
            }
        }
    }
}

/// 解码一段以字符边界开头的字节：尾部不完整的多字节序列留待下次；
/// 确定是 GBK 之类的非 UTF-8 流则整段转码。
fn decode_prefix(bytes: &[u8]) -> (String, usize) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), bytes.len()),
        Err(e) => {
            if e.error_len().is_none() {
                let valid = e.valid_up_to();
                (String::from_utf8_lossy(&bytes[..valid]).into_owned(), valid)
            } else {
                (crate::utils::decode_shell_bytes(bytes), bytes.len())
            }
        }
    }
}

/// 共享输出缓冲区。drain 线程写入；读方只碰内存环，永不阻塞读管道（P1-17）。
#[derive(Clone, Default)]
pub(crate) struct BgSharedOutput {
    pub stdout: Arc<StreamRing>,
    pub stderr: Arc<StreamRing>,
    /// drain 线程完成计数：0=none, 1=stdout, 2=stderr, 3=both。
    pub drain_done: Arc<AtomicUsize>,
}

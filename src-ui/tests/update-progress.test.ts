// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 更新可见性纯函数面测试：
//   1. createProgressTracker：进度累积 / 缺 Content-Length 的降级 / 速度窗口 / 剩余时间 /
//      坏输入（NaN、负数）/ 二次 Started 复位；
//   2. 更新卡片文本格式化（settings-domain/update-format.ts）：字节 / 速度 / 剩余时间 /
//      发布时间，全部带「缺失就是缺失」的边界。
//
// 纯函数 ⇒ 默认 node 环境（不碰 DOM）。

import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatEta,
  formatReleaseDate,
  formatSpeed,
} from '../src/plugins/builtin/settings-domain/update-format';
import { createProgressTracker } from '../src/state/update-progress';

describe('createProgressTracker', () => {
  it('有 Content-Length：百分比 + 速度 + 剩余时间逐步成形', () => {
    const tracker = createProgressTracker();
    const start = tracker.push({ event: 'Started', data: { contentLength: 1000 } }, 0);
    expect(start).toMatchObject({ downloadedBytes: 0, totalBytes: 1000, percent: 0, etaSeconds: null });

    tracker.push({ event: 'Progress', data: { chunkLength: 400 } }, 1000);
    const mid = tracker.push({ event: 'Progress', data: { chunkLength: 100 } }, 2000);
    expect(mid.downloadedBytes).toBe(500);
    expect(mid.percent).toBe(50);
    expect(mid.bytesPerSecond).toBe(100); // (500-400) 字节 / 1 秒
    expect(mid.etaSeconds).toBe(5); // 剩 500 字节 / 100 B/s

    tracker.push({ event: 'Progress', data: { chunkLength: 500 } }, 8000);
    const end = tracker.push({ event: 'Finished' }, 9000);
    expect(end.percent).toBe(100);
    expect(end.downloadedBytes).toBe(1000); // Finished 不造字节——100% 是收满收出来的
  });

  it('缺 Content-Length：percent / eta 保持 null（不知道总量就不假装知道）', () => {
    const tracker = createProgressTracker();
    tracker.push({ event: 'Started', data: {} }, 0);
    const snap = tracker.push({ event: 'Progress', data: { chunkLength: 300 } }, 1000);
    expect(snap.totalBytes).toBeNull();
    expect(snap.percent).toBeNull();
    expect(snap.etaSeconds).toBeNull();
    expect(snap.downloadedBytes).toBe(300);
  });

  it('相对总量超收也夹到 100%（远端声明的总量不是硬约束）', () => {
    const tracker = createProgressTracker();
    tracker.push({ event: 'Started', data: { contentLength: 100 } }, 0);
    const snap = tracker.push({ event: 'Progress', data: { chunkLength: 250 } }, 1000);
    expect(snap.downloadedBytes).toBe(250);
    expect(snap.percent).toBe(100);
  });

  it('坏输入（NaN / 负数 / 0 总量）不污染读数', () => {
    const tracker = createProgressTracker();
    tracker.push({ event: 'Started', data: { contentLength: 0 } }, 0);
    tracker.push({ event: 'Progress', data: { chunkLength: 100 } }, 1000);
    const snap = tracker.push({ event: 'Progress', data: { chunkLength: Number.NaN } }, 2000);
    expect(snap.downloadedBytes).toBe(100);
    expect(snap.totalBytes).toBeNull(); // 0 = 未声明（除零护栏）
    expect(Number.isFinite(snap.downloadedBytes)).toBe(true);

    const neg = tracker.push({ event: 'Progress', data: { chunkLength: -50 } }, 3000);
    expect(neg.downloadedBytes).toBe(100);
  });

  it('速度样本不足（首秒内）不出速度——避免荒谬值', () => {
    const tracker = createProgressTracker();
    tracker.push({ event: 'Started', data: { contentLength: 100000 } }, 0);
    tracker.push({ event: 'Progress', data: { chunkLength: 10 } }, 100);
    const snap = tracker.push({ event: 'Progress', data: { chunkLength: 10 } }, 200);
    expect(snap.bytesPerSecond).toBeNull();
    expect(snap.etaSeconds).toBeNull();
  });

  it('二次 Started 复位（重试 / 重下从 0 起算，不是接着累加）', () => {
    const tracker = createProgressTracker();
    tracker.push({ event: 'Started', data: { contentLength: 1000 } }, 0);
    tracker.push({ event: 'Progress', data: { chunkLength: 800 } }, 2000);
    const reset = tracker.push({ event: 'Started', data: { contentLength: 1000 } }, 3000);
    expect(reset.downloadedBytes).toBe(0);
    expect(reset.bytesPerSecond).toBeNull();
  });
});

describe('更新卡片文本格式化', () => {
  it('formatBytes：缺失/非法 → 「—」，其余按 1024 进制带单位', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(145099092)).toBe('138.4 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('formatSpeed：非正/缺失 → 「—」', () => {
    expect(formatSpeed(null)).toBe('—');
    expect(formatSpeed(0)).toBe('—');
    expect(formatSpeed(3.5 * 1024 * 1024)).toBe('3.5 MB/s');
  });

  it('formatEta：秒 / 分秒 / 小时分；缺失 → 空串（调用点据此不渲染）', () => {
    expect(formatEta(null)).toBe('');
    expect(formatEta(0)).toBe('约 0 秒');
    expect(formatEta(26)).toBe('约 26 秒');
    expect(formatEta(125)).toBe('约 2 分 05 秒');
    expect(formatEta(3700)).toBe('约 1 小时 01 分');
  });

  it('formatReleaseDate：RFC3339 → 本地时间；缺失「—」；解析不了原样返回（不假造成未知时间）', () => {
    expect(formatReleaseDate(null)).toBe('—');
    expect(formatReleaseDate('')).toBe('—');
    expect(formatReleaseDate('2026-09-25T14:12:07Z')).toMatch(/^2026-09-25 \d{2}:\d{2}$/);
    expect(formatReleaseDate('不是时间')).toBe('不是时间');
  });
});

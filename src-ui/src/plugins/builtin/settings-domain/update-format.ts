// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 更新卡片的文本格式化（产物包内实现）。
// 为什么在包内：内核 update-store 只产数字（字节 / 百分比 / 秒），文案与单位是
// 本卡片的事——格式化归消费侧，内核不必为一个 UI 文案面长出跨面依赖。
// 全部输入可缺失：缺就是「—」，不猜、不写 0 假装有读数。

/** 字节 → '145.1 MB'（1024 进制、业界惯例标签）；缺失/非法 → '—'。 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** 速度 → '3.2 MB/s'；缺失/非正 → '—'。 */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** 剩余时间 → '约 26 秒'；缺失 → ''（调用点据此不渲染这一段）。 */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  if (total < 60) return `约 ${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `约 ${minutes} 分 ${String(total % 60).padStart(2, '0')} 秒`;
  return `约 ${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
}

/** 发布时间（RFC3339）→ 本地 '2026-09-25 22:12'；缺失 → '—'。解析不了就原样显示
 *  （远端给的是不可信文本，不吞掉、不假造成「未知时间」）。 */
export function formatReleaseDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

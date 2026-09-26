// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// update-progress — 更新包下载进度的纯计算面（累积 / 百分比 / 速度 / 剩余时间）。
//
// 为什么单列成件：输入是更新器的事件流（Started → Progress* → Finished），
// Progress 每 chunk 一次（可达百 Hz），而**缺少 Content-Length 是常态**——服务端不给
// 就是 undefined。纯函数面让这些边界（缺总量 / 样本不足 / 除零 / 负数）能被 vitest
// 直接钉住，不必把 React 或 zustand 拖进场；文本格式化另居消费侧（见
// `plugins/builtin/settings-domain/update-format.ts`：内核只产数字，不替 UI 定文案）。
//
// 输入一律视为不可信（chunkLength / contentLength 由远端与运行时决定）：全部夹零，
// 缺总量时 percent 保持 null——不知道就是不知道，不假装 0% 也不假装 100%。

export interface UpdateProgress {
  /** 已接收字节（Progress 累加；不回退） */
  downloadedBytes: number;
  /** 服务端声明的总字节（Content-Length）；缺席 = null */
  totalBytes: number | null;
  /** 0-100 百分比；totalBytes 缺席 = null */
  percent: number | null;
  /** 近期平均速度（字节/秒）；样本窗口不足 = null */
  bytesPerSecond: number | null;
  /** 预计剩余秒数；速度或总量缺席 = null */
  etaSeconds: number | null;
}

/** 更新器事件——与 `@tauri-apps/plugin-updater` 的 DownloadEvent 结构兼容
 *  （结构化类型，免把 npm 包类型拖进内核计算面）。 */
export type DownloadTick =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/** 速度窗口：最近 6 秒样本求平均（再短抖动大，再长跟不上速率变化）。 */
const SPEED_WINDOW_MS = 6000;
/** 有效样本最短跨度：首秒内除小数会得到荒谬速度，宁可先不出。 */
const SPEED_MIN_SPAN_MS = 800;

export interface ProgressTracker {
  /** 吃一个事件，返回当前快照。时间由调用方注入（纯同步 = 可测）。 */
  push(tick: DownloadTick, now: number): UpdateProgress;
  /** 只读当前快照（不推进时间）——发布节流下失败时补一次最新读数用。 */
  snapshot(): UpdateProgress;
}

export function createProgressTracker(): ProgressTracker {
  let total: number | null = null;
  let received = 0;
  let speed: number | null = null;
  let samples: Array<{ t: number; bytes: number }> = [];

  function noteSpeed(now: number): void {
    samples.push({ t: now, bytes: received });
    while (samples.length > 2 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift();
    const first = samples[0];
    const span = now - first.t;
    if (samples.length >= 2 && span >= SPEED_MIN_SPAN_MS) {
      const delta = received - first.bytes;
      if (delta >= 0) speed = (delta * 1000) / span;
    }
  }

  function read(): UpdateProgress {
    const percent = total != null ? Math.min(100, (received / total) * 100) : null;
    const etaSeconds = total != null && speed != null && speed > 0 ? Math.max(0, (total - received) / speed) : null;
    return {
      downloadedBytes: received,
      totalBytes: total,
      percent,
      bytesPerSecond: speed,
      etaSeconds,
    };
  }

  return {
    push(tick, now) {
      switch (tick.event) {
        case 'Started':
          total =
            typeof tick.data.contentLength === 'number' && tick.data.contentLength > 0 ? tick.data.contentLength : null;
          received = 0;
          samples = [];
          speed = null;
          break;
        case 'Progress': {
          const chunk = tick.data.chunkLength;
          // 非有限数/负数一律当 0（远端给的是不可信数字，NaN 会顺着加法污染整条读数）
          if (Number.isFinite(chunk) && chunk > 0) received += chunk;
          noteSpeed(now);
          break;
        }
        case 'Finished':
          break;
      }
      return read();
    },
    snapshot: read,
  };
}

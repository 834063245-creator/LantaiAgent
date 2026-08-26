// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/active-region — 活跃会话自动选中判定（Stage-4 §4.1）。
//
// 拍板（canvas-space-model-notes.md §5 输入区拍板）：活跃会话是**有记忆的
// 状态**，非每帧重算，只在明确条件满足时转移。转移三情形：
//   ① 显式动作（点击流区/输入条、书脊定位、拖动展开）立即切——不经过本模块；
//   ② 浏览态自动跟随，三道闸全过才切——视口停住（平移中不判）+ 中心点落在
//      流区内 + 连续停留约 400ms（快扫不触发）；
//   ③ 缩放永不触发切换；中心点在空白处保持当前。
// 本模块 = ③/② 的纯逻辑（零 DOM）：视口中心 → 流区命中 + 停留计时控制器。
// 渲染层把「平移中 / 缩放中 / 输入锁存」折叠成 moving 标志喂进来。

import { screenToWorld, type Viewport } from './canvas-math';

/** 命中判定用的流区矩形（世界坐标）。 */
export interface RegionHitRect {
  sessionId: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** 视口中心的世界坐标（纯换算——屏幕 [w/2, h/2] → 世界）。 */
export function viewportCenterWorld(v: Viewport, w: number, h: number): { x: number; y: number } {
  return screenToWorld(v, w / 2, h / 2);
}

/** 世界点命中哪个流区（命中判定为 ③/② 的判据：中心点落在流区内）。
 *  空白（未命中任何流区）= null——调用方保持当前活跃会话。 */
export function hitRegionAtWorld(x: number, y: number, regions: RegionHitRect[]): string | null {
  for (const r of regions) {
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.sessionId;
  }
  return null;
}

/** 停留计时控制器的可注入时钟面（测试用 fake timers；缺省走全局 setTimeout）。 */
export interface SettleSelectorOptions {
  /** 连续停留时长（ms）——拍板约 400ms。 */
  delayMs: number;
  /** 停留期满且中心点命中非空流区时的回调（切换活跃会话）。 */
  onChange: (sessionId: string) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * 三道闸停留控制器：
 *   push(centerId, moving) 每帧喂入当前中心命中的流区 + 是否运动中。
 *   - moving（平移/缩放/动画中）→ 取消在途计时，不判；
 *   - centerId 为空（空白）→ 取消在途计时，保持当前；
 *   - centerId 已是最近一次落定值 → 无变化，不重计；
 *   - 新 centerId → 启动 400ms 计时；同一 centerId 在途不重计（连续停留）。
 *   adopt(id) 供显式动作（书脊定位/侧边栏/点流区）同步「最近落定值」，
 *   防止自动选中在用户显式切换后立刻把它拉回去。
 */
export function createSettleSelector(opts: SettleSelectorOptions): {
  push: (centerId: string | null, moving: boolean) => void;
  adopt: (sessionId: string | null) => void;
  dispose: () => void;
  readonly lastSettledId: string | null;
} {
  const setTimer = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeoutFn ?? ((id: ReturnType<typeof setTimeout>) => clearTimeout(id));

  let pendingId: string | null = null;
  let lastSettledId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const fire = (): void => {
    timer = null;
    if (pendingId != null) {
      lastSettledId = pendingId;
      opts.onChange(pendingId);
    }
  };

  return {
    push(centerId, moving): void {
      if (moving) {
        cancel();
        pendingId = null;
        return;
      }
      if (centerId == null) {
        cancel();
        pendingId = null;
        return;
      }
      if (centerId === lastSettledId) {
        cancel();
        pendingId = null;
        return;
      }
      if (centerId !== pendingId) {
        pendingId = centerId;
        cancel();
        timer = setTimer(fire, opts.delayMs);
      }
      // 同一 pendingId 在途：计时器继续（连续停留才触发）
    },
    adopt(sessionId): void {
      cancel();
      pendingId = null;
      lastSettledId = sessionId;
    },
    dispose(): void {
      cancel();
      pendingId = null;
    },
    get lastSettledId() {
      return lastSettledId;
    },
  };
}

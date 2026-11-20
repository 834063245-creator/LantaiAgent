// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DockTetherLayer — 匣脚引线的坞侧缓动（2026-11-19 用户报「坞高变化时引线变化生硬」）。
//
// 两条判据：
//   ① 坞高变化（输入换行 / 附件行 / 墨量册）→ 线的起笔点在**中间帧**是过渡值，
//      不是当帧跳到底（旧实现两端同帧换坐标 = 闪一下）；
//   ② 拖动中（dragging）→ 当帧到位：坞在手上走，线滞后就是「线掉了」。
//
// 时钟面用受控 rAF（本测试自带步进器）——不依赖 jsdom 的帧实现细节。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockTetherLayer } from '../src/plugins/builtin/paper-shell/DockTetherLayer';

interface Geom {
  from: { x: number; y: number };
  to: { x: number; y: number };
  seed: number;
  dragging: boolean;
  dockHeight: number;
}

const geom = (fromY: number, dragging = false, dockHeight = 110): Geom => ({
  from: { x: 100, y: fromY },
  to: { x: 300, y: 600 },
  seed: 7,
  dragging,
  dockHeight,
});

/** 受控帧时钟：rAF 回调入队，step() 手动推进 16ms 并触发。 */
function installClock() {
  let now = 0;
  let nextId = 1;
  const queue = new Map<number, (t: number) => void>();
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb as (t: number) => void);
    return id;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    queue.delete(id);
  });
  const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    step(ms = 16): void {
      now += ms;
      const batch = [...queue.entries()];
      queue.clear();
      act(() => {
        for (const [, cb] of batch) cb(now);
      });
    },
    restore(): void {
      raf.mockRestore();
      cancel.mockRestore();
      nowSpy.mockRestore();
    },
  };
}

describe('匣脚引线 · 坞侧锚点缓动', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = undefined;
  });

  const originY = (): number =>
    Number.parseFloat(container.querySelector('.pp-tether-origin')?.getAttribute('cy') ?? 'NaN');

  const render = async (g: Geom): Promise<void> => {
    await act(async () => {
      if (!root) root = createRoot(container);
      root.render(<DockTetherLayer geom={g} />);
    });
  };

  it('坞高变化：中间帧是过渡值（线不跳），180ms 后到位', async () => {
    const clock = installClock();
    try {
      await render(geom(0));
      expect(originY()).toBe(0);

      await render(geom(100, false, 210)); // 坞长高 100px（匣顶抬起 = 内容态）
      expect(originY(), '当帧就跳到底 = 生硬的病灶').toBe(0);

      clock.step(60); // 走 1/3 时长
      const mid = originY();
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(100);

      for (let i = 0; i < 20; i++) clock.step(16); // 推完 180ms
      expect(originY()).toBeCloseTo(100, 0);
    } finally {
      clock.restore();
    }
  });

  it('拖动中：当帧到位（跟手，不许拖尾）', async () => {
    const clock = installClock();
    try {
      await render(geom(0, true));
      await render(geom(250, true));
      expect(originY()).toBe(250);
    } finally {
      clock.restore();
    }
  });

  it('卷侧（纸脚）即时：纸在动时线立刻指到新落点', async () => {
    const clock = installClock();
    try {
      await render(geom(50));
      clock.step(16);
      await render({ ...geom(50), to: { x: 320, y: 700 } });
      const bead = container.querySelector('.pp-tether-bead');
      expect(Number.parseFloat(bead?.getAttribute('cy') ?? 'NaN')).toBe(700);
    } finally {
      clock.restore();
    }
  });
});

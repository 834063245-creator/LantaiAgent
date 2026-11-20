// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 引用那一拍的**因果**（docs/plans/card-quote-plan.md §6.1/§6.4）：
//   · 起点在卡、终点在夹签轨——量不到任何一端就不画（没有凭空生灭）；
//   · prefers-reduced-motion ⇒ 不飞（槽里的归位动画自己承担可见回执）；
//   · 落地即摘除：浮层元素不留孤儿。
//
// 这里只钉**判据**，不钉缓动曲线（曲线是造型，改它不该红测试）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flyQuoteGhost } from '../src/plugins/builtin/paper-shell/quote-flight';

/** 假 Animation：记下 keyframes/options，手动 finish。 */
function stubAnimate() {
  const calls: Array<{ keyframes: unknown; options: unknown; el: HTMLElement }> = [];
  const animes: Array<{ onfinish: (() => void) | null }> = [];
  HTMLElement.prototype.animate = function (this: HTMLElement, keyframes: unknown, options: unknown) {
    calls.push({ keyframes, options, el: this });
    const a = { onfinish: null as (() => void) | null, oncancel: null as (() => void) | null };
    animes.push(a);
    return a as unknown as Animation;
  } as typeof HTMLElement.prototype.animate;
  return { calls, animes };
}

/** 造一张卡：块的 DOM 上带 data-block-id（纸壳每块恒有，不为一次飞行新增属性）。 */
function seedCard(blockId: string): HTMLElement {
  const card = document.createElement('div');
  card.setAttribute('data-block-id', blockId);
  card.getBoundingClientRect = () =>
    ({ left: 100, top: 200, width: 400, height: 120, right: 500, bottom: 320 }) as DOMRect;
  document.body.appendChild(card);
  return card;
}

function seedRail(rect = { left: 700, top: 860, width: 120, height: 28 }): HTMLElement {
  const rail = document.createElement('div');
  rail.className = 'pp-card-rail';
  const wrap = document.createElement('span');
  wrap.className = 'pp-quote-wrap';
  wrap.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) as DOMRect;
  rail.appendChild(wrap);
  document.body.appendChild(rail);
  return rail;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom 没有 matchMedia；默认「不动效降级」
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('引用飞行（§6.1 因果可视化）', () => {
  it('起点在卡、终点在轨：飞一枚，落地即摘除', async () => {
    const { calls, animes } = stubAnimate();
    seedCard('as_a');
    seedRail();
    flyQuoteGhost('as_a');
    await flush();

    expect(calls, '没有飞（量到起点与终点就该飞）').toHaveLength(1);
    // 起点 = 卡左/上、尺寸 = 卡尺寸（飞的是「卡的一枚分身」，不是随便一块）
    expect(calls[0].el.style.left).toBe('100px');
    expect(calls[0].el.style.top).toBe('200px');
    expect(calls[0].el.style.width).toBe('400px');
    expect(calls[0].el.style.height).toBe('120px');
    // 终点在轨那一侧（世界坐标右下方）——位移方向可核
    const frames = calls[0].keyframes as Array<{ transform: string }>;
    expect(frames[0].transform).toContain('translate(0px, 0px)');
    const last = frames[frames.length - 1].transform;
    const m = last.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
    expect(m, '末帧没有位移').not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThan(0);
    expect(Number(m?.[2])).toBeGreaterThan(0);

    // 落地即摘除（元素与动画都不留）
    expect(document.querySelectorAll('.pp-quote-fly')).toHaveLength(1);
    animes[0].onfinish?.();
    expect(document.querySelectorAll('.pp-quote-fly'), '浮层没被摘除 = 孤儿元素').toHaveLength(0);
  });

  it('起点量不到（卡不在屏上）⇒ 不飞', async () => {
    const { calls } = stubAnimate();
    seedRail();
    flyQuoteGhost('as_missing');
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('终点量不到（坞没渲染 / 夹签轨不在）⇒ 不飞：没有终点的位移不许发生', async () => {
    const { calls } = stubAnimate();
    seedCard('as_a');
    flyQuoteGhost('as_a');
    await flush();
    expect(calls).toHaveLength(0);
    expect(document.querySelectorAll('.pp-quote-fly')).toHaveLength(0);
  });

  it('prefers-reduced-motion ⇒ 不飞（§6.4 降级）', async () => {
    const { calls } = stubAnimate();
    seedCard('as_a');
    seedRail();
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    flyQuoteGhost('as_a');
    await flush();
    expect(calls).toHaveLength(0);
  });
});

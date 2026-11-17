// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 冻帧（hitstop）行为面 —— 2026-11-17 打击感批。
//
// 这一批的核心机制是「命中那一拍把整屏动效冻住 34ms 再放开」。它的风险不在观感，
// 而在**生命周期**：冻住之后没放开 = 整屏动画永久停在半路；反复冻 = 帧率塌。
// 故这里钉的不是「好不好看」，是四条能被证伪的性质：
//   ① 开窗 → 窗满自动放开（不靠调用方记得 release）；
//   ② 窗内重入 = 顺延，不重复冻结（否则 frozen 集合里同一动画记两次）；
//   ③ release 幂等，且卸载路径必须调它；
//   ④ 动效敏感用户 = 窗长 0（一次都不冻）。
//
// 实测依据（Chromium，见 hitstop.ts 头注）：pause/play 对 CSSAnimation 与
// CSSTransition 一视同仁，停顿与恢复各延迟 1 帧；300 条动画时全量 pause+play
// 一次 2.13ms（单帧预算 12.8%）。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHitstop, HITSTOP_MS } from '../src/plugins/builtin/paper-shell/hitstop';

/** 造一个可被 document.getAnimations() 收上来的假动画（jsdom 不实现 Web Animations）。 */
function fakeAnimation(state: 'running' | 'finished' = 'running') {
  const calls: string[] = [];
  return {
    calls,
    playState: state,
    pause() {
      calls.push('pause');
      this.playState = 'paused';
    },
    play() {
      calls.push('play');
      this.playState = 'running';
    },
  };
}

describe('冻帧（hitstop）', () => {
  let animations: ReturnType<typeof fakeAnimation>[];

  beforeEach(() => {
    vi.useFakeTimers();
    animations = [];
    // jsdom 没有 getAnimations：装一个够用的替身（本测要验的是**调用时序**，不是渲染）
    (document as unknown as { getAnimations: () => unknown[] }).getAnimations = () => animations;
    // 默认非 reduced-motion
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as { getAnimations?: () => unknown[] }).getAnimations;
  });

  it('开窗即冻：窗内每条 running 动画各被 pause 一次，窗满自动 play 放开', () => {
    const a = fakeAnimation();
    const b = fakeAnimation();
    animations.push(a, b);

    const hs = createHitstop();
    expect(hs.hit(HITSTOP_MS)).toBe(HITSTOP_MS);

    // 当帧就冻住（不是下一帧）——实测 pause 延迟 1 帧，那 1 帧是浏览器渲染节拍
    expect(a.calls).toEqual(['pause']);
    expect(b.calls).toEqual(['pause']);
    expect(hs.active()).toBe(true);

    // 窗没满：不许放
    vi.advanceTimersByTime(HITSTOP_MS - 1);
    expect(a.calls).toEqual(['pause']);
    expect(hs.active()).toBe(true);

    // 窗满：自动放开
    vi.advanceTimersByTime(1);
    expect(a.calls).toEqual(['pause', 'play']);
    expect(b.calls).toEqual(['pause', 'play']);
    expect(hs.active()).toBe(false);
  });

  it('窗内重入 = 顺延，不重复冻结（同一动画不许被记两次）', () => {
    const a = fakeAnimation();
    animations.push(a);

    const hs = createHitstop();
    hs.hit(34);
    expect(a.calls).toEqual(['pause']);

    // 窗内再来一拍：窗顺延，但**不许再 pause 一次**
    vi.advanceTimersByTime(20);
    hs.hit(34);
    expect(a.calls).toEqual(['pause']); // 仍只有一次
    expect(hs.count()).toBe(1); // 只开过一次窗

    // 第一窗到期时刻（34ms）已经过了，但第二窗把它推到 54ms ⇒ 此刻仍在窗内
    vi.advanceTimersByTime(20); // 累计 40ms
    expect(hs.active()).toBe(true);
    expect(a.calls).toEqual(['pause']);

    // 第二窗满（累计 54ms）才放
    vi.advanceTimersByTime(15);
    expect(a.calls).toEqual(['pause', 'play']);
  });

  it('release 幂等：开着的时候放一次，再调一次什么都不做（不许把已播的再 play 一遍）', () => {
    const a = fakeAnimation();
    animations.push(a);

    const hs = createHitstop();
    hs.hit(34);
    hs.release();
    expect(a.calls).toEqual(['pause', 'play']);

    hs.release();
    hs.release();
    expect(a.calls).toEqual(['pause', 'play']); // 幂等
    expect(hs.active()).toBe(false);
  });

  it('release 之后原定时器不再触发（卸载路径不许留下一个迟到的 play）', () => {
    const a = fakeAnimation();
    animations.push(a);

    const hs = createHitstop();
    hs.hit(34);
    hs.release();
    // 定时器若没清，这里会让 play 变成两次
    vi.advanceTimersByTime(200);
    expect(a.calls).toEqual(['pause', 'play']);
  });

  it('动效敏感用户：窗长 0，一条动画都不冻', () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    const a = fakeAnimation();
    animations.push(a);
    const hs = createHitstop();
    expect(hs.hit()).toBe(0);
    expect(a.calls).toEqual([]);
    expect(hs.active()).toBe(false);
  });

  it('只冻 running 的：已经结束的动画不进 frozen 集合（否则出窗时白 play 一次）', () => {
    const running = fakeAnimation('running');
    const finished = fakeAnimation('finished');
    animations.push(running, finished);

    const hs = createHitstop();
    hs.hit(34);
    expect(running.calls).toEqual(['pause']);
    expect(finished.calls).toEqual([]); // 没被 pause
    hs.release();
    expect(finished.calls).toEqual([]); // 也不被 play —— 账干净
    expect(running.calls).toEqual(['pause', 'play']);
  });

  it('HITSTOP_MS 在 30~40ms 档内（用户 2026-11-16 定的量级）', () => {
    // 一帧 16.7ms：34ms ≈ 2 帧（一帧读作「没卡」，三帧读作「卡了」）
    expect(HITSTOP_MS).toBeGreaterThanOrEqual(30);
    expect(HITSTOP_MS).toBeLessThanOrEqual(40);
  });
});

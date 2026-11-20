// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// motion-end 原语守护（2026-11-17 交互原语收口批 B）。
//
// 病灶：全库 0 处 transitionend / animationend，所有「窗」靠 setTimeout 估
// `--m-sheet` 的当前值。本原语是那条通则的唯一实现：「元素还在盘上就听事件，
// 兜底只作保险」。三条纪律逐条钉：
//   ① 第一次结束即收（transitionend 会为每条过渡各发一次）；
//   ② 子元素的事件不算（`e.target !== el`）；
//   ③ 事件永不到达时兜底窗必须关（漏窗 = 离场卷永不卸载）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOTION_END_FALLBACK_MS, waitMotionEnd } from '../src/plugins/builtin/paper-shell/motion-end';

describe('waitMotionEnd', () => {
  let el: HTMLDivElement;

  beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
  });
  afterEach(() => {
    el.remove();
    vi.useRealTimers();
  });

  it('元素自己的 transitionend 即收，且只收一次（多条过渡逐条收尾不漏账）', () => {
    const done = vi.fn();
    waitMotionEnd(el, done);
    el.dispatchEvent(new Event('transitionend', { bubbles: true }));
    el.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('animationend 同样认（入场是 animation、退场是 transition，两族都要覆盖）', () => {
    const done = vi.fn();
    waitMotionEnd(el, done);
    el.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('子元素的事件不算（纪律②：墨比纸先落完，那是另一件事）', () => {
    const done = vi.fn();
    waitMotionEnd(el, done);
    const child = document.createElement('span');
    el.appendChild(child);
    child.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(done).not.toHaveBeenCalled();
    el.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('cancel() 之后事件到了也不触发（重开卷 / 窗已撤销）', () => {
    const done = vi.fn();
    const cancel = waitMotionEnd(el, done);
    cancel();
    el.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(done).not.toHaveBeenCalled();
  });

  it('事件永不到达 → 兜底窗必须关（漏窗 = 离场卷永不卸载）', () => {
    vi.useFakeTimers();
    const done = vi.fn();
    waitMotionEnd(el, done);
    vi.advanceTimersByTime(MOTION_END_FALLBACK_MS - 1);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('兜底窗长于最长一档 token（--m-scene 0.38s + 编排错峰）——它是保险，不是主路径', () => {
    expect(MOTION_END_FALLBACK_MS).toBeGreaterThan(380 + 100);
  });

  it('收尾后监听器已摘（不留下挂着的监听）', () => {
    const done = vi.fn();
    const spyEl = el;
    waitMotionEnd(spyEl, done);
    spyEl.dispatchEvent(new Event('transitionend', { bubbles: true }));
    // 之后同元素再起一次等待，两把互不干扰
    const done2 = vi.fn();
    waitMotionEnd(spyEl, done2);
    spyEl.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(done).toHaveBeenCalledTimes(1);
    expect(done2).toHaveBeenCalledTimes(1);
  });
});

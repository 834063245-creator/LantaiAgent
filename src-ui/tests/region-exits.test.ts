// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// regionExits —— 退场窗的**事件化**那一半（2026-11-17 交互原语收口批 B）。
//
// 与 region-motion.test.ts 分工：那份考**窗的账**（纯函数：谁进窗、何时撤销、何时到期），
// 本文件考**真卸载的凭据**——从「窗满 = 卸载」改成「`.pp-region[data-leaving]` 的
// opacity 过渡播完 = 卸载」。三件事：
//   ① 事件到达立即回调（不等估算的 260ms）；
//   ② 事件永不到达时兜底窗关（不许把一张该消失的卷永久留在场上）；
//   ③ 取消后不再触发（卷在窗内重开 = 撤销退场，不是卸载）。

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOTION_END_FALLBACK_MS } from '../src/plugins/builtin/paper-shell/motion-end';
import { regionExits } from '../src/plugins/builtin/paper-shell/region-motion';

describe('regionExits（退场窗事件化）', () => {
  let el: HTMLDivElement;

  beforeEach(() => {
    el = document.createElement('div');
    el.className = 'pp-region';
    el.setAttribute('data-leaving', '');
    document.body.appendChild(el);
  });
  afterEach(() => {
    el.remove();
    vi.useRealTimers();
  });

  it('元素自己的 transitionend 到达即卸载（不等估算的 260ms）', () => {
    const onExit = vi.fn();
    regionExits(onExit, el);
    expect(onExit).not.toHaveBeenCalled();
    el.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('事件永不到达 → 兜底窗关（否则离场卷永不卸载）', () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    regionExits(onExit, el);
    vi.advanceTimersByTime(MOTION_END_FALLBACK_MS);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('取消（卷在窗内重开）后不再触发', () => {
    const onExit = vi.fn();
    const cancel = regionExits(onExit, el);
    cancel();
    el.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(onExit).not.toHaveBeenCalled();
  });

  it('元素没挂上时立即卸载（没有可听的面 = 没有窗可等）', () => {
    const onExit = vi.fn();
    regionExits(onExit, null);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

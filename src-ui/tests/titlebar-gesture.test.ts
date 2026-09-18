// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 标题栏手势（拖窗口 / 双击最大化）行为考 —— 2026-09-18 双击回归立法。
//
// 病灶（详见 `src/app/window-drag.ts` 头注）：双击原本建在 DOM `dblclick` 上，而
// `pointerdown` 一响就把窗口交给 **OS 模态移动循环**（tao `drag_window`：
// `ReleaseCapture()` + `PostMessage(WM_NCLBUTTONDOWN, HTCAPTION)`），这一击的
// mouseup 再也不进页面（旁证：tao 自己在 `WM_EXITSIZEMOVE` 里补发合成
// `WM_LBUTTONUP`）⇒ Blink 永远凑不齐一次完整 click ⇒ `dblclick` 一次都不产生。
//
// 判据因此改为 **pointerdown 自己数**：同一位置、双击窗口（450ms）内的第二下 =
// 双击 → 最大化/还原，且第二下**不进 OS 拖动循环**（否则拖动与最大化互相打架）；
// `onTopbarDoubleClick` 只作「页面收得到 dblclick 的平台」的同一对点击去重兜底。
//
// 本文件考这个数法的全部分支。真机「第二下 pointerdown 会不会真的送进页面」是
// OS 消息层的事，jsdom 够不着——由实机验收兜（真双击 + 真拖动）。
//
// 模块态是进程级单例（上一次按下 / 上一次判双击的时刻），用例之间靠**时钟大步
// 前进**作废：每次 beforeEach 把系统时间推 5s，语义上等于「用户隔了一会儿才动手」。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onTopbarDoubleClick, onTopbarPointerDown } from '../src/app/window-drag';

let clock = new Date('2026-09-18T10:00:00Z').getTime();
const invoke = vi.fn(async () => null);

/** 手势事件最小形状：默认落在标题栏热区的一个普通 div（非交互件）上。 */
function ev(over: Partial<{ target: EventTarget | null; clientX: number; clientY: number }> = {}) {
  return {
    target: over.target === undefined ? document.createElement('div') : over.target,
    clientX: over.clientX ?? 600,
    clientY: over.clientY ?? 40,
  };
}

/** 发出去的命令序列（判据挑命令名，不看参数形状）。 */
const cmds = (): string[] => invoke.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.useFakeTimers();
  clock += 5000; // 作废上一用例留下的手势态（见文件头注）
  vi.setSystemTime(clock);
  invoke.mockClear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' } },
    invoke,
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('标题栏手势：双击由 pointerdown 自己数', () => {
  it('单击 = 拖窗口（原生命令，命中面就是元素本身）', () => {
    onTopbarPointerDown(ev());
    expect(invoke).toHaveBeenCalledWith('plugin:window|start_dragging', { label: 'main' });
  });

  it('双击 = 最大化/还原恰好一次，且第二下不再起 OS 拖动', () => {
    onTopbarPointerDown(ev());
    vi.advanceTimersByTime(120);
    onTopbarPointerDown(ev());
    expect(cmds()).toEqual(['plugin:window|start_dragging', 'plugin:window|toggle_maximize']);
    expect(invoke).toHaveBeenCalledWith('plugin:window|toggle_maximize', { label: 'main' });
  });

  it('慢于双击窗口 = 两次独立单击（各拖各的，不最大化）', () => {
    onTopbarPointerDown(ev());
    vi.advanceTimersByTime(600);
    onTopbarPointerDown(ev());
    expect(cmds()).toEqual(['plugin:window|start_dragging', 'plugin:window|start_dragging']);
  });

  it('两次按下位移超过容差 = 不是双击（点一下、再点别处）', () => {
    onTopbarPointerDown(ev({ clientX: 600 }));
    vi.advanceTimersByTime(120);
    onTopbarPointerDown(ev({ clientX: 640 }));
    expect(cmds()).toEqual(['plugin:window|start_dragging', 'plugin:window|start_dragging']);
  });

  it('三击不连判：判过一对就消费掉，第三下重新从「第一下」起算', () => {
    onTopbarPointerDown(ev());
    vi.advanceTimersByTime(100);
    onTopbarPointerDown(ev());
    vi.advanceTimersByTime(100);
    onTopbarPointerDown(ev());
    expect(cmds()).toEqual([
      'plugin:window|start_dragging',
      'plugin:window|toggle_maximize',
      'plugin:window|start_dragging',
    ]);
  });

  it('交互件（窗口钮/输入面）整对豁免：不吃拖窗口，也不吃最大化', () => {
    const btn = document.createElement('button');
    onTopbarPointerDown(ev({ target: btn }));
    vi.advanceTimersByTime(100);
    onTopbarPointerDown(ev({ target: btn }));
    onTopbarDoubleClick(ev({ target: btn }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('页面收得到 dblclick 的平台：同一对点击只算一次（pointerdown 已判则让路）', () => {
    onTopbarPointerDown(ev());
    vi.advanceTimersByTime(100);
    onTopbarPointerDown(ev()); // → 判为双击 → 最大化
    onTopbarDoubleClick(ev()); // → 让路，不得再翻一次
    expect(cmds()).toEqual(['plugin:window|start_dragging', 'plugin:window|toggle_maximize']);
  });

  it('dblclick 单独到达（没有配对的 pointerdown）仍成立——兜底不因新判据失效', () => {
    onTopbarDoubleClick(ev());
    expect(cmds()).toEqual(['plugin:window|toggle_maximize']);
  });

  it('无 Tauri 运行时（纯浏览器预览）不炸、也不发命令', () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    onTopbarPointerDown(ev());
    onTopbarDoubleClick(ev());
    expect(invoke).not.toHaveBeenCalled();
  });
});

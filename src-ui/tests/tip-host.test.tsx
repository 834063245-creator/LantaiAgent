// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 悬停提示宿主（tooltip）—— 2026-10-30 系统化重做的行为钉。
//
// 病灶：全库 159 处浏览器原生 `title`（延迟约 1s、样式不可改、触屏无效），
// 本批换成宿主绘制。本文件按**用户操作序列**钉四件事（不钉样式字面量，
// 视觉决策见 `paper-visual-decisions` 同族口径）：
//   ① 出场延迟：悬停 320ms 才出、键盘聚焦 150ms 就出——原生那个「扫过一排按钮
//      过一秒才冒出来」的手感是本批要治的主症状；
//   ② 退场即时（移开就收，不赖着）；
//   ③ 双层文案（主行 + 次行）与「相邻切换不重播」；
//   ④ 定位翻转：顶部工具条的提示必须翻到下方，不能顶出视口。
//
// 刻意**不钉**的：具体像素坐标、动画曲线（那些属 §15 动效法，改 tokens 即变）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TipHost } from '../src/app/tip';

let root: Root | null = null;

/** 宿主 portal 到 body 的提示节点。 */
function tipEl(): HTMLElement | null {
  return document.querySelector('.lt-tip');
}

/** 造一个带 data-tip 的触发件（挂 body：不随宿主 root 卸载而消失）。 */
function trigger(attrs: Record<string, string>): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

/** 打一个「从外部指向目标」的鼠标事件（宿主在 document 捕获阶段收）。 */
function fire(target: Element, type: string, init: MouseEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(TipHost));
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('悬停提示宿主', () => {
  it('悬停 320ms 才出现（299ms 时仍不显示）', () => {
    const el = trigger({ 'data-tip': '发送本轮输入' });

    fire(el, 'mouseover');
    advance(299);
    expect(tipEl()?.classList.contains('is-on')).toBe(false);

    advance(21); // 累计 320ms
    expect(tipEl()?.classList.contains('is-on')).toBe(true);
    expect(tipEl()?.textContent).toContain('发送本轮输入');
  });

  it('拖拽中（按住鼠标）不出提示', () => {
    const el = trigger({ 'data-tip': '不该出现' });
    fire(el, 'mouseover', { buttons: 1 });
    advance(400);
    expect(tipEl()?.classList.contains('is-on')).toBe(false);
  });

  it('移开后 80ms 宽限即收起（留窗撤销，但不赖着）', () => {
    const el = trigger({ 'data-tip': '拟文' });
    fire(el, 'mouseover');
    advance(320);
    expect(tipEl()?.classList.contains('is-on')).toBe(true);

    fire(el, 'mouseout');
    // 宽限窗内仍可被「移到相邻件」撤销——正是它挡住了扫过一排按钮时的闪烁
    expect(tipEl()?.classList.contains('is-on')).toBe(true);
    advance(80);
    expect(tipEl()?.classList.contains('is-on')).toBe(false);
  });

  it('双层文案：主行 + data-tip-hint 次行', () => {
    const el = trigger({ 'data-tip': '插入回合', 'data-tip-hint': 'Agent 运行中，下轮生效' });
    fire(el, 'mouseover');
    advance(320);

    const label = document.querySelector('.lt-tip-label');
    const hint = document.querySelector('.lt-tip-hint');
    expect(label?.textContent).toBe('插入回合');
    expect(hint?.textContent).toBe('Agent 运行中，下轮生效');
  });

  it('没有次行时不渲染次行节点（不留空行）', () => {
    const el = trigger({ 'data-tip': '快捷键总览' });
    fire(el, 'mouseover');
    advance(320);
    expect(document.querySelector('.lt-tip-hint')).toBeNull();
  });

  it('相邻切换：已是显示态时立即换内容，不重走 320ms 延迟', () => {
    const a = trigger({ 'data-tip': '第一个' });
    const b = trigger({ 'data-tip': '第二个' });

    fire(a, 'mouseover');
    advance(320);
    expect(document.querySelector('.lt-tip-label')?.textContent).toBe('第一个');

    // 移到相邻件：不等延迟就该换
    fire(a, 'mouseout');
    fire(b, 'mouseover');
    advance(1);
    expect(document.querySelector('.lt-tip-label')?.textContent).toBe('第二个');
    expect(tipEl()?.classList.contains('is-on')).toBe(true);
  });

  it('键盘聚焦也出提示（150ms，且比悬停快）', () => {
    const el = trigger({ 'data-tip': '打开命令面板' });
    act(() => {
      el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    advance(149);
    expect(tipEl()?.classList.contains('is-on')).toBe(false);
    advance(1);
    expect(tipEl()?.classList.contains('is-on')).toBe(true);
  });

  it('显示期给触发件挂 aria-describedby，收起后摘除', () => {
    const el = trigger({ 'data-tip': '停止当前回合' });
    fire(el, 'mouseover');
    advance(320);
    expect(el.getAttribute('aria-describedby')).toBe('lt-tip-body');

    fire(el, 'mouseout');
    advance(80);
    expect(el.hasAttribute('aria-describedby')).toBe(false);
  });

  it('定位：中部目标在下方显示、顶部目标翻到下方侧（不出屏）', () => {
    const mid = trigger({ 'data-tip': '中部' });
    vi.spyOn(mid, 'getBoundingClientRect').mockReturnValue({
      top: 300,
      bottom: 320,
      left: 200,
      right: 260,
      width: 60,
      height: 20,
      x: 200,
      y: 300,
      toJSON: () => ({}),
    } as DOMRect);
    fire(mid, 'mouseover');
    advance(320);
    expect(tipEl()?.dataset.side).toBe('top');

    const top = trigger({ 'data-tip': '贴顶' });
    vi.spyOn(top, 'getBoundingClientRect').mockReturnValue({
      top: 2,
      bottom: 22,
      left: 200,
      right: 260,
      width: 60,
      height: 20,
      x: 200,
      y: 2,
      toJSON: () => ({}),
    } as DOMRect);
    fire(top, 'mouseover');
    advance(320);
    expect(tipEl()?.dataset.side).toBe('bottom');
  });

  it('没有 data-tip 的普通悬停不出提示', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    fire(el, 'mouseover');
    advance(400);
    expect(tipEl()?.classList.contains('is-on')).toBe(false);
  });
});

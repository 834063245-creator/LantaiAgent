// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 展卷页行为（2026-11-05 入口 UX 批）——按用户操作序列钉：
//   ① 进入工作区后立刻能看见「正在展卷 + 工作区名 + 三段」，当前段亮；
//   ② 失败落定后同一页转「开卷未成 + 具名原因 + 重试/回案头」，不再是一行状态字；
//   ③ 阶段推进只换当前段（落位 → 装订 → 展卷），已完成段落墨。
// 页面数据真源 = workspace-entry-store（流程写、页面读）——用例直接走 store，
// 不 mock 流程（流程侧由 workspace-lifecycle 的 T0 断言守护）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnteringSheet } from '../src/plugins/builtin/paper-shell/EnteringSheet';
import {
  beginWorkspaceEntry,
  clearWorkspaceEntry,
  failWorkspaceEntry,
  setWorkspaceEntryPhase,
} from '../src/state/workspace-entry-store';

describe('展卷页（进入工作区的加载态）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    clearWorkspaceEntry();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    clearWorkspaceEntry();
    container.remove();
  });

  function mount(): HTMLDivElement {
    act(() => {
      root = createRoot(container);
      root.render(createElement(EnteringSheet));
    });
    return container;
  }

  it('进入即见：工作区名 + 三段，当前段 = 落位', () => {
    beginWorkspaceEntry('D:/work/兰台手稿');
    const c = mount();
    expect(c.textContent).toContain('兰台手稿');
    expect(c.textContent).toContain('落位');
    expect(c.textContent).toContain('装订');
    expect(c.textContent).toContain('展卷');
    const now = c.querySelector('.pp-entry-step.is-now');
    expect(now?.textContent).toContain('落位');
    expect(c.querySelector('[aria-current="step"]')).toBe(now);
  });

  it('标题用首页给的登记名（不是目录名）', () => {
    beginWorkspaceEntry('D:/work/nebula-novel', '星云小说');
    const c = mount();
    expect(c.textContent).toContain('星云小说');
    expect(c.textContent).not.toContain('nebula-novel');
  });

  it('阶段推进：已完成段落 is-done，当前段跟着走（不闪回）', () => {
    beginWorkspaceEntry('D:/work/alpha');
    const c = mount();
    act(() => setWorkspaceEntryPhase('assembling'));
    const steps = c.querySelectorAll('.pp-entry-step');
    expect(steps[0]?.className).toContain('is-done');
    expect(steps[1]?.className).toContain('is-now');
    act(() => setWorkspaceEntryPhase('restoring'));
    expect(steps[2]?.className).toContain('is-now');
  });

  it('失败落定：具名原因 + 重试 / 回案头（不再是「请稍候」一行字）', () => {
    beginWorkspaceEntry('D:/work/broken');
    const c = mount();
    act(() => failWorkspaceEntry('目录不存在：D:/work/broken'));
    expect(c.textContent).toContain('开卷未成');
    expect(c.textContent).toContain('目录不存在：D:/work/broken');
    const labels = [...c.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).toContain('重试');
    expect(labels).toContain('回案头');
    // 失败态不再显示走秒/阶段（同一页换态，不是另开一页）
    expect(c.querySelector('.pp-entry-steps')).toBeNull();
  });
});

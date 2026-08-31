// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// C12 状态反馈面守护：pushStatus → shell-store → StatusLine 渲染链。
// V5 拆状态栏后 statusText/statusLog 无 UI 消费（图谱预热/分析进度对用户
// 不可见）——本测试钉死书眉承接面不断。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useShellStore } from '../src/app/shell-store';
import { StatusLine } from '../src/plugins/builtin/paper-shell/StatusLine';

describe('C12 StatusLine — 承接面渲染链', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // 每用例重置 store（zustand setState 直写——测试域特权）
    useShellStore.setState({ statusText: '就绪', statusLog: [], analyzing: null });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('pushStatus 写入 → chip 显示最新状态', () => {
    act(() => {
      root?.render(createElement(StatusLine));
    });
    act(() => {
      useShellStore.getState().pushStatus('✨ 10812 节点已就绪');
    });
    const chip = container!.querySelector('.sl-chip .sl-text');
    expect(chip?.textContent).toBe('✨ 10812 节点已就绪');
  });

  it('analyzing 态优先：显示「分析中」+ 呼吸点，不显 statusText', () => {
    act(() => {
      useShellStore.getState().setAnalyzing('open');
    });
    act(() => {
      root?.render(createElement(StatusLine));
    });
    expect(container!.querySelector('.sl-chip .sl-text')?.textContent).toBe('分析中');
    expect(container!.querySelector('.sl-dot')).not.toBeNull();
    expect(container!.querySelector('.sl-chip--busy')).not.toBeNull();
  });

  it('点击 chip 展开 statusLog 环（最近优先）', () => {
    act(() => {
      root?.render(createElement(StatusLine));
    });
    act(() => {
      useShellStore.getState().pushStatus('第一条');
      useShellStore.getState().pushStatus('第二条');
    });
    const chip = container!.querySelector('.sl-chip') as HTMLButtonElement;
    act(() => {
      chip.click();
    });
    // 2026-08 UI 大清扫：日志行带 HH:mm 时间前缀（.sl-log-time）——断言剥前缀后比对正文
    const stripTime = (s: string | null): string => (s ?? '').replace(/^\d{2}:\d{2}/, '');
    const lines = [...container!.querySelectorAll('.sl-log-line')].map((e) => stripTime(e.textContent));
    expect(lines[0]).toBe('第二条'); // 最新在上
    expect(lines).toContain('第一条');
    // 时间戳确在渲染（非空 HH:mm 前缀）
    const raw = container!.querySelector('.sl-log-line')?.textContent ?? '';
    expect(raw).toMatch(/^\d{2}:\d{2}第二条$/);
  });

  it('日志环上限 15（pushStatus 截断）', () => {
    act(() => {
      for (let i = 0; i < 20; i++) useShellStore.getState().pushStatus(`msg-${i}`);
    });
    expect(useShellStore.getState().statusLog).toHaveLength(15);
    expect(useShellStore.getState().statusLog[0].msg).toBe('msg-5'); // 尾部保留最新 15
  });
});

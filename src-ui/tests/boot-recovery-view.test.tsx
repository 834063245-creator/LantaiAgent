// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 启动失败面（app/BootRecovery.tsx）——**用户真的能看懂并动手**。
//
// 判据取自事故：白屏时用户手里什么都没有（无文案、无原因、无出口）。这个组件
// 必须做到三件事，缺一件就退回「僵住」：
//   ① 说清是什么（结论一句话 + 构建锚/宿主面/工作区/日志四个定位字段）；
//   ② 说清凭什么（逐条证据，不是一句「出错了」）；
//   ③ 给出出口（重新加载 / 复制诊断 / 进出安全模式）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BootRecovery, diagnosticText } from '../src/app/BootRecovery';
import type { BootFailure } from '../src/app/boot-recovery';

const FAILURE: BootFailure = {
  kind: 'skew',
  summary: '产物与 exe 不同源（宿主面指纹对不上）——40 个出厂产物被拒载',
  evidence: ['hologram/paper-shell —— 宿主面版本偏斜: 产物需宿主面 d57775e9，当前 exe 是 3840339f'],
  hints: ['重建 exe：双击 build.cmd', '只重建 dist-plugins 一定被拒'],
};

const BASE = {
  failure: FAILURE,
  build: { v: '1.0.9', commit: '5dfe12e6' },
  hostSurface: '3840339f',
  workspace: 'D:/HoloGramHG',
  logPath: 'D:/HoloGramHG/.lantai/logs/ui.log',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('BootRecovery：白屏换成可读、可动的诊断面', () => {
  it('① 结论 / 定位四字段 / 证据 / 建议 全部可见', () => {
    act(() => root.render(createElement(BootRecovery, BASE)));
    const text = container.textContent ?? '';
    expect(text).toContain('兰台没能完成启动');
    expect(text).toContain(FAILURE.summary);
    expect(text).toContain('v1.0.9 · 5dfe12e6');
    expect(text).toContain('宿主面 3840339f');
    expect(text).toContain('D:/HoloGramHG/.lantai/logs/ui.log');
    expect(text).toContain('hologram/paper-shell');
    expect(text).toContain('重建 exe：双击 build.cmd');
  });

  it('② 「重新加载界面」真的调用重载（不是摆设按钮）', () => {
    const onReload = vi.fn();
    act(() => root.render(createElement(BootRecovery, { ...BASE, onReload })));
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '重新加载界面');
    expect(btn).toBeTruthy();
    act(() => btn?.click());
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('③ 安全模式态：标题换成「已进入安全模式」，出口按钮换成「退出安全模式」', () => {
    const onToggleSafeMode = vi.fn();
    act(() =>
      root.render(
        createElement(BootRecovery, {
          ...BASE,
          failure: {
            kind: 'safe-mode',
            summary: '安全模式：本次启动跳过了全部出厂产物装载',
            evidence: ['产物装载被跳过'],
            hints: ['修好后退出安全模式'],
          },
          safeMode: true,
          onToggleSafeMode,
        }),
      ),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('已进入安全模式');
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '退出安全模式并重新加载');
    expect(btn).toBeTruthy();
    act(() => btn?.click());
    expect(onToggleSafeMode).toHaveBeenCalledTimes(1);
  });

  it('④ 复制载荷 = 完整诊断（把现场交给别人时不用口述）', () => {
    const text = diagnosticText(BASE);
    expect(text).toContain('兰台启动失败 · skew');
    expect(text).toContain('构建: v1.0.9 (5dfe12e6)');
    expect(text).toContain('宿主面: 3840339f');
    expect(text).toContain('结论: ' + FAILURE.summary);
    expect(text).toContain('重建 exe：双击 build.cmd');
  });
});

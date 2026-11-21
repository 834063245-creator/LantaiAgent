// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// per-model 手改档位编辑器的「预设 + 按声明重新同步」（2026-11-21 §7.2 欠账 ③）。
// 逐行表格只能从零敲：常见组合（关/低中高、关/中高、关/高、全部档位）应有一步到位；
// 网关改了 /models 声明后，也应有一键把覆盖重置回「按声明」而不是逐行删。
//
// 两条不变量（本文件钉死）：
//   ① 套预设不丢 wire 映射——网关要 high→"deep" 时，预设后的参数值仍是 "deep"；
//   ② 「按声明重新同步」= 丢弃手改、从当前声明重新播种（off 恒保留）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelReasoningLevels } from '../../src/plugins/builtin/settings-domain/ModelReasoningLevels';
import type { ThinkingLevelMap } from '../../src/provider/thinking';

describe('ModelReasoningLevels — 预设与重新同步（2026-11-21）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  const render = (props: {
    efforts?: readonly ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[];
    sourceLevelMap?: ThinkingLevelMap;
    value?: false | ThinkingLevelMap;
  }) => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onChange = vi.fn();
    act(() => {
      root?.render(
        createElement(ModelReasoningLevels, {
          efforts: props.efforts,
          sourceLevelMap: props.sourceLevelMap,
          sourceLabel: '手动覆盖',
          value: props.value,
          onChange,
        }),
      );
    });
    return onChange;
  };

  const click = (el: Element | null | undefined) => {
    act(() => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const preset = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.pp-model-presets button')].find((b) => b.textContent === label);

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  it('预设只服务「手动覆盖」面：未开启覆盖时不渲染预设组', () => {
    render({ efforts: ['low', 'high'] });
    expect(document.querySelector('.pp-model-presets')).toBeNull();
  });

  it('「关 / 高」= off + high 两行；「全部档位」= off + 全部 canonical 档', () => {
    const onChange = render({ value: { off: null, low: 'low' } });

    click(preset('关 / 高'));
    expect(onChange).toHaveBeenLastCalledWith({ off: null, high: 'high' });

    click(preset('全部档位'));
    const all = onChange.mock.lastCall?.[0] as ThinkingLevelMap;
    expect(Object.keys(all)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('套预设保留声明里的 wire 映射（high → "deep" 不被冲回档位名）', () => {
    const onChange = render({
      efforts: ['low', 'medium', 'high'],
      sourceLevelMap: { off: 'none', low: 'lo', medium: 'mid', high: 'deep' },
      value: { off: null, low: 'low' },
    });
    click(preset('关 / 中高'));
    expect(onChange).toHaveBeenLastCalledWith({ off: 'none', medium: 'mid', high: 'deep' });
  });

  it('「按声明重新同步」丢弃手改，从当前声明重新播种', () => {
    const onChange = render({
      efforts: ['low', 'medium'],
      sourceLevelMap: { low: 'l', medium: 'm' },
      value: { off: null, low: 'my-custom' },
    });
    click(document.querySelector('.pp-model-presets .pp-preset-resync'));
    expect(onChange).toHaveBeenLastCalledWith({ off: null, low: 'l', medium: 'm' });
  });

  it('预设组是语义化的 fieldset（图例「预设」= 读屏可报的名字），按钮都是 type=button', () => {
    render({ value: { off: null, high: 'high' } });
    const group = document.querySelector('.pp-model-presets');
    expect(group?.tagName).toBe('FIELDSET');
    expect(group?.querySelector('legend')?.textContent).toBe('预设');
    for (const btn of document.querySelectorAll('.pp-model-presets button')) {
      expect(btn.getAttribute('type')).toBe('button');
    }
  });
});

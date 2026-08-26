// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ModelSelector compact（rework P2-1）：收起态 = 触发器（供应商/模型名+箭头），
// 空查询列出全部已配置 provider 的目录模型并按 vendor 分组。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from '../src/app/panels/ModelSelector';

describe('ModelSelector compact（创作坞触发器形态）', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
  });

  it('收起态 = 触发器：供应商 / 人类可读模型名 + 箭头（不再裸露 model id）', () => {
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    const trigger = container!.querySelector('.ms-trigger');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('deepseek'); // 供应商层级
    expect(trigger?.textContent).toContain('DeepSeek V4 Pro'); // 人类可读名
    expect(container!.querySelector('.ms-trigger-caret')).not.toBeNull(); // 箭头暗示可展开
  });

  it('展开：按 vendor 分组；选择模型触发 onChange', async () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          compact: true,
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange,
        }),
      );
    });
    act(() => {
      container!.querySelector<HTMLButtonElement>('.ms-trigger')?.click();
    });
    await act(async () => {});
    const heads = [...container!.querySelectorAll('.ms-group-head')].map((e) => e.textContent);
    expect(heads.length).toBeGreaterThan(0);
    expect(heads).toContain('deepseek');
    const items = container!.querySelectorAll<HTMLButtonElement>('.ms-item');
    expect(items.length).toBeGreaterThan(0);
    act(() => {
      items[0]?.click();
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('非 compact（设置面板字段形态）保持平铺：无触发器、无分组头', () => {
    act(() => {
      root?.render(
        createElement(ModelSelector, {
          value: 'deepseek-v4-pro',
          providerName: 'deepseek',
          kind: 'openai',
          onChange: () => {},
        }),
      );
    });
    expect(container!.querySelector('.ms-trigger')).toBeNull();
    // 聚焦打开后仍是平铺列表（无 .ms-group-head）
    act(() => {
      container!.querySelector<HTMLInputElement>('.ms-input')?.focus();
    });
    expect(container!.querySelectorAll('.ms-group-head').length).toBe(0);
  });
});

// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 高级连接配置组件：请求头编辑的提交纪律（非法行不提交、合法行提交）。
//
// ⚡ 2026-09-24 配方改文件批：本文件原先还覆盖「配方导出/导入」两个按钮的用户动作链
// ——那两个动作整批退役（provider 连接配置的权威改成 `~/.lantai/providers.yml`
// 那份磁盘文件：复制文件即导入、文件本身即导出，agent 直接改）。
// 配方文档本身的逐条语义在 `tests/providers-doc.test.ts` + `tests/providers-store.test.ts`；
// 配置文件的界面面在 `ProviderDocCard`（此处钉住「导入/导出按钮确实不再出现」）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAdvanced } from '../src/app/panels/settings/ProviderAdvanced';
import { type ProviderSettings, providerId } from '../src/settings';

function row(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    kind: 'openai',
    name: providerId('opencodego'),
    apiKey: 'sk-local',
    baseUrl: 'https://x.example/v1',
    model: 'm1',
    ...overrides,
  };
}

/** React 受控组件输入：走原型 setter + input 事件（本仓 tsx 测试惯例）。 */
function setTextarea(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`未找到按钮「${text}」`);
  return found as HTMLButtonElement;
}

describe('ProviderAdvanced（请求头）', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container.remove();
  });

  function mount(provider: ProviderSettings): ReturnType<typeof vi.fn> {
    const onChange = vi.fn();
    act(() => {
      root = createRoot(container);
      root.render(createElement(ProviderAdvanced, { provider, onChange }));
    });
    return onChange;
  }

  it('非法请求头行不提交并显示原因；合法行点「保存」提交', () => {
    const onChange = mount(row());
    const ta = container.querySelector<HTMLTextAreaElement>('#pd-headers');
    if (!ta) throw new Error('缺少请求头输入框');
    act(() => setTextarea(ta, 'bad name: v'));
    expect(container.textContent).toContain('不是 Fetch 能发送的请求头');
    act(() => buttonByText('保存').click());
    expect(onChange).not.toHaveBeenCalled();
    act(() => setTextarea(ta, '# 注释\nx-opencode-session: sess-1'));
    act(() => buttonByText('保存').click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ headers: { 'x-opencode-session': 'sess-1' } }));
  });

  it('清空请求头 = 提交 undefined（字段清除语义，不是空对象）', () => {
    const onChange = mount(row({ headers: { 'x-opencode-session': 'sess-1' } }));
    const ta = container.querySelector<HTMLTextAreaElement>('#pd-headers');
    if (!ta) throw new Error('缺少请求头输入框');
    act(() => setTextarea(ta, ''));
    act(() => buttonByText('保存').click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ headers: undefined }));
  });

  // 2026-09-24 配方改文件批的退役断言：导入/导出两个动作不在这个面板了
  it('导入/导出两个动作已退役（配方 = 磁盘文件，见 ProviderDocCard）', () => {
    mount(row());
    expect([...document.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('导出');
    expect([...document.querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('导入');
    expect(container.querySelector('.pp-recipe-text')).toBeNull();
  });
});

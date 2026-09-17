// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 高级连接配置组件（2026-09-17）：请求头编辑的提交纪律（非法行不提交、合法行提交）
// 与配方导入/导出的用户动作链（导出生文言、导入套用保名字与密钥）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAdvanced } from '../src/app/panels/settings/ProviderAdvanced';
import { exportProviderRecipe } from '../src/provider/provider-recipe';
import { providerId, type ProviderSettings } from '../src/settings';

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

describe('ProviderAdvanced（请求头 + 配方）', () => {
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
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'x-opencode-session': 'sess-1' } }),
    );
  });

  it('导出：生成配方文本（不含密钥）并提示落文本框', async () => {
    mount(row({ headers: { 'x-opencode-session': 'sess-1' } }));
    await act(async () => {
      buttonByText('导出').click();
    });
    const text = container.querySelector<HTMLTextAreaElement>('.pp-recipe-text')?.value ?? '';
    expect(text).toContain('"format": "lantai-provider-recipe"');
    expect(text).toContain('x-opencode-session');
    expect(text).not.toContain('sk-local');
  });

  it('导入：粘贴配方套用本行——连接配置来自配方，名字与密钥保持本行', () => {
    const source = row({
      name: providerId('shared-row'),
      kind: 'openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      model: 'deepseek-v4.1-flash',
      headers: { 'x-opencode-session': 'sess-9' },
    });
    const onChange = mount(row());
    act(() => {
      buttonByText('导入').click();
    });
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-recipe-text');
    if (!ta) throw new Error('缺少配方输入框');
    act(() => setTextarea(ta, exportProviderRecipe(source)));
    act(() => buttonByText('套用到本行').click());
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'opencodego',
        apiKey: 'sk-local',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        headers: { 'x-opencode-session': 'sess-9' },
      }),
    );
  });

  it('导入：坏配方整单拒绝并显示原因', () => {
    const onChange = mount(row());
    act(() => {
      buttonByText('导入').click();
    });
    const ta = container.querySelector<HTMLTextAreaElement>('.pp-recipe-text');
    if (!ta) throw new Error('缺少配方输入框');
    act(() => setTextarea(ta, '{ not json'));
    act(() => buttonByText('套用到本行').click());
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).toContain('不是合法 JSON');
  });
});

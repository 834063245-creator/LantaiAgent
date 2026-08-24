// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// ModeIndicator 模型菜单复合选择守护测试：
// 1. 跨 provider 选模型 = 联动切 activeProvider + model 写进归属 provider
//    （根治「分组只是视觉、选择不切 provider」——模型名写进别家配置的错配）。
// 2. 激活态高亮按 provider+model 双键匹配（同 ID 跨厂商不双亮）。
// 3. 空分组（自定义 provider 无目录模型）渲染引导文案而非整组消失。
// 4. 同 provider 内切模型不动 activeProvider。
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModeIndicator } from '../../src/app/panels/ModeIndicator';
import { type AppSettings, providerId } from '../../src/settings';
import { notifyAgentConfigChanged } from '../../src/state/agent-config-store';

// catalog 静态 import 真目录（findModels 走真实 vendor 数据：deepseek / anthropic 有条目）
vi.mock('../../src/state/agent-config-store', () => ({
  notifyAgentConfigChanged: vi.fn(),
  useAgentConfigStore: { subscribe: () => () => {}, getState: () => ({ seq: 0 }) },
}));

import * as settingsModule from '../../src/settings';

function makeSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    activeProvider: providerId('deepseek'),
    providers: [
      {
        kind: 'openai',
        name: providerId('deepseek'),
        apiKey: 'sk-deep',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
      },
      {
        kind: 'anthropic',
        name: providerId('anthropic'),
        apiKey: 'sk-anth',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        thinking: '',
      },
      {
        // 自定义 provider：目录无此 vendor → 空分组
        kind: 'openai',
        name: providerId('my-gateway'),
        apiKey: '',
        baseUrl: 'https://gw.example.com/v1',
        model: '',
      },
    ],
    projectPath: '.',
    agent: { temperature: 0.7, contextWindow: 0 },
    display: { language: 'zh', fontScale: 1 },
    ...overrides,
  };
}

describe('ModeIndicator — 模型菜单复合选择', () => {
  let container: HTMLElement;
  let root: Root;
  let saved: AppSettings | null;

  const render = async (initial: AppSettings) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(ModeIndicator));
    });
  };

  const click = async (el: Element | null) => {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  beforeEach(() => {
    saved = null;
    vi.mocked(notifyAgentConfigChanged).mockClear();
    // 拦截 saveSettings 落盘面：记录最终提交的 settings
    vi.spyOn(settingsModule, 'saveSettings').mockImplementation((s) => {
      saved = s;
    });
    document.body.innerHTML = '';
  });

  afterEach(() => {
    root?.unmount();
  });

  it('跨 provider 选模型 → activeProvider 联动切换，model 写进归属 provider', async () => {
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({ ...makeSettings(), providers: makeSettings().providers.map((p) => ({ ...p, apiKey: '' })) }),
    );
    await render(makeSettings());

    await click(document.querySelector('.mi-model'));
    expect(document.querySelector('.mi-model-menu')).not.toBeNull();

    // 点 anthropic 分组的 Sonnet 模型（跨协议切换）——按显示名精确定位
    const sonnetItem = [...document.querySelectorAll<HTMLButtonElement>('.mi-model-item')].find(
      (b) => b.querySelector('.mi-model-name')?.textContent?.trim() === 'Claude Sonnet 4.6',
    )!;
    expect(sonnetItem).toBeTruthy();
    await click(sonnetItem);

    expect(saved).not.toBeNull();
    const s = saved as unknown as AppSettings;
    expect(s.activeProvider).toBe('anthropic');
    const anth = s.providers.find((p) => p.name === 'anthropic')!;
    expect(anth.model).toBe('claude-sonnet-4-6');
    // 原 provider 配置不被污染
    const ds = s.providers.find((p) => p.name === 'deepseek')!;
    expect(ds.model).toBe('deepseek-v4-pro');
    expect(notifyAgentConfigChanged).toHaveBeenCalledWith('model-switched');
  });

  it('同 provider 内切模型 → activeProvider 不动', async () => {
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({ ...makeSettings(), providers: makeSettings().providers.map((p) => ({ ...p, apiKey: '' })) }),
    );
    await render(makeSettings());

    await click(document.querySelector('.mi-model'));
    const flashItem = [...document.querySelectorAll<HTMLButtonElement>('.mi-model-item')].find(
      (b) => b.querySelector('.mi-model-name')?.textContent?.trim() === 'DeepSeek V4 Flash',
    )!;
    await click(flashItem);

    const s = saved as unknown as AppSettings;
    expect(s.activeProvider).toBe('deepseek');
    expect(s.providers.find((p) => p.name === 'deepseek')!.model).toBe('deepseek-v4-flash');
  });

  it('激活态高亮按 provider+model 双键——非当前 provider 的同名/异名模型不亮', async () => {
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({ ...makeSettings(), providers: makeSettings().providers.map((p) => ({ ...p, apiKey: '' })) }),
    );
    await render(makeSettings());
    await click(document.querySelector('.mi-model'));

    const onItems = document.querySelectorAll('.mi-model-item--on');
    expect(onItems.length).toBe(1);
    expect(onItems[0]?.querySelector('.mi-model-name')?.textContent).toContain('DeepSeek V4 Pro');
  });

  it('空分组（目录外 provider）渲染引导文案，不消失', async () => {
    localStorage.setItem(
      'hologram_settings',
      JSON.stringify({ ...makeSettings(), providers: makeSettings().providers.map((p) => ({ ...p, apiKey: '' })) }),
    );
    await render(makeSettings());
    await click(document.querySelector('.mi-model'));

    const gwGroup = [...document.querySelectorAll('.mi-model-group')].find((g) =>
      g.querySelector('.mi-model-vendor')?.textContent?.includes('my-gateway'),
    );
    expect(gwGroup).toBeTruthy();
    expect(gwGroup!.querySelector('.mi-model-empty')?.textContent).toContain('设置 → 提供方');
  });
});

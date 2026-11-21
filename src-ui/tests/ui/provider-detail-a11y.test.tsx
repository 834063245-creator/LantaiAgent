// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 详情页的无障碍面（2026-11-21 §7.2 欠账 ⑥）：
// 三态视觉 select、OAuth 账号 select、档位开关、目录折叠头——这些控件此前只有
// aria-label 一半，键盘 / 读屏路径没有守护。本文件钉住：
//   ① 每个控件都有**可读的名字**（aria-label 或关联 label），不是裸 select；
//   ② select 的选项就是用户看到的语义（跟随声明 / 强制支持图片 / 强制仅文本；
//      自动（最近登录）+ 每个账号）；
//   ③ 折叠与展开面都有 aria-expanded / aria-controls，且指向真实存在的节点；
//   ④ 交互按钮 type=button（不触发宿主表单提交）。

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDetailActions, ProviderDocView } from '../../src/plugins/builtin/settings-domain/ProviderDetail';
import { ProviderDetail } from '../../src/plugins/builtin/settings-domain/ProviderDetail';
import type { ProviderSettings } from '../../src/settings';
import { providerId } from '../../src/settings';

const EMPTY_DOC: ProviderDocView = {
  path: '',
  status: { path: '', errors: [], empty: true, loaded: false, available: false, lastError: '' },
  staleHint: false,
};

function makeProvider(over: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    kind: 'openai',
    name: providerId('gw'),
    apiKey: 'sk-gw',
    baseUrl: 'https://gw.test/v1',
    model: 'gw-a',
    models: ['gw-a'],
    catalog: ['gw-a', 'gw-b'],
    ...over,
  };
}

function makeActions(): { actions: ProviderDetailActions; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const spies = {
    onModelVisionToggle: vi.fn(),
    onModelReasoning: vi.fn(),
    onSelectAccount: vi.fn(),
    onLogout: vi.fn(),
    onTest: vi.fn(),
    onDelete: vi.fn(),
  };
  const actions: ProviderDetailActions = {
    onFieldChange: vi.fn(),
    onFetchModels: vi.fn(async () => 0),
    onAddModel: vi.fn(),
    onRemoveModel: vi.fn(),
    onSetEnabledModels: vi.fn(),
    onModelOverride: vi.fn(),
    onModelReasoning: spies.onModelReasoning,
    onModelVisionToggle: spies.onModelVisionToggle,
    onAdvancedChange: vi.fn(),
    doc: EMPTY_DOC,
    onOpenDocDir: vi.fn(),
    onReloadDoc: vi.fn(),
    docMsg: '',
    onTest: spies.onTest,
    onClearKey: vi.fn(),
    onResetBaseUrl: vi.fn(),
    onToggleKeyVisible: vi.fn(),
    onDelete: spies.onDelete,
  };
  return { actions, spies };
}

describe('ProviderDetail — 键盘 / 读屏路径（2026-11-21）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  const mount = (el: ReturnType<typeof createElement>) => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(el);
    });
  };

  const click = (el: Element | null | undefined) => {
    act(() => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const openParams = () => click(document.querySelector('.pp-model-chip-param'));

  const setSelect = (el: HTMLSelectElement, value: string) => {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  it('视觉输入声明：三态 select 有名字、三个选项语义完整，选完写回覆盖', () => {
    const { actions, spies } = makeActions();
    mount(
      createElement(ProviderDetail, {
        provider: makeProvider(),
        canDelete: false,
        test: { phase: 'idle', msg: '' },
        keyState: { saved: true, pendingClear: false, visible: false, inputRef: createRef() },
        actions,
      }),
    );
    openParams();
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="视觉输入声明"]');
    expect(select).not.toBeNull();
    expect([...(select?.options ?? [])].map((o) => o.value)).toEqual(['inherit', 'image', 'text']);
    expect([...(select?.options ?? [])].map((o) => o.textContent?.slice(0, 4))).toEqual([
      '跟随声明',
      '强制支持',
      '强制仅文',
    ]);
    setSelect(select!, 'image');
    expect(spies.onModelVisionToggle).toHaveBeenCalledWith('gw-a', 'image');
  });

  it('推理档位开关是 role=switch 且有 aria-checked；开启后写入按声明的播种值', () => {
    const { actions, spies } = makeActions();
    mount(
      createElement(ProviderDetail, {
        provider: makeProvider({ modelMeta: { 'gw-a': { thinkingEfforts: ['low', 'high'], fetchedAt: 1 } } }),
        canDelete: false,
        test: { phase: 'idle', msg: '' },
        keyState: { saved: true, pendingClear: false, visible: false, inputRef: createRef() },
        actions,
      }),
    );
    openParams();
    const sw = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="手动覆盖推理档位声明"]');
    expect(sw).not.toBeNull();
    expect(sw?.getAttribute('aria-checked')).toBe('false');
    click(sw);
    expect(spies.onModelReasoning).toHaveBeenCalledWith('gw-a', { off: null, low: 'low', high: 'high' });
  });

  it('OAuth 账号选择器：可读名字、选项含「自动（最近登录）」+ 每个账号、登出按钮各有名字', () => {
    const { actions, spies } = makeActions();
    mount(
      createElement(ProviderDetail, {
        provider: makeProvider({ authMode: 'oauth', oauthProvider: 'codex', apiKey: '' }),
        canDelete: false,
        test: { phase: 'idle', msg: '' },
        keyState: { saved: false, pendingClear: false, visible: false, inputRef: createRef() },
        actions,
        oauthData: {
          accounts: [{ accountId: 'user-1' }, { accountId: 'user-2' }],
          busy: false,
          status: null,
          activeAccountId: undefined,
          onSelectAccount: spies.onSelectAccount,
          onLogin: vi.fn(),
          onLogout: spies.onLogout,
          onCancel: vi.fn(),
        },
      }),
    );
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="OAuth 请求使用账号"]');
    expect(select).not.toBeNull();
    expect([...(select?.options ?? [])].map((o) => o.textContent)).toEqual(['自动（最近登录）', 'user-1', 'user-2']);
    setSelect(select!, 'user-2');
    expect(spies.onSelectAccount).toHaveBeenCalledWith('user-2');

    const logout = document.querySelector<HTMLButtonElement>('button[aria-label="登出 user-2"]');
    expect(logout).not.toBeNull();
    click(logout);
    expect(spies.onLogout).toHaveBeenCalledWith('user-2');
  });

  it('模型目录折叠头：aria-expanded 随开合变化，aria-controls 指向真实存在的目录体', () => {
    const { actions } = makeActions();
    mount(
      createElement(ProviderDetail, {
        provider: makeProvider({ catalog: [] }),
        canDelete: false,
        test: { phase: 'idle', msg: '' },
        keyState: { saved: true, pendingClear: false, visible: false, inputRef: createRef() },
        actions,
      }),
    );
    const head = document.querySelector<HTMLButtonElement>('.pp-catalog-head');
    expect(head?.getAttribute('aria-expanded')).toBe('false');
    click(head);
    expect(head?.getAttribute('aria-expanded')).toBe('true');
    const bodyId = head?.getAttribute('aria-controls');
    expect(bodyId).toBeTruthy();
    expect(document.getElementById(bodyId!)).not.toBeNull();
  });

  it('分区导航与参数按钮都是 type=button（不触发宿主表单提交）', () => {
    const { actions } = makeActions();
    mount(
      createElement(ProviderDetail, {
        provider: makeProvider(),
        canDelete: true,
        test: { phase: 'idle', msg: '' },
        keyState: { saved: true, pendingClear: false, visible: false, inputRef: createRef() },
        actions,
      }),
    );
    for (const btn of document.querySelectorAll('.pp-sec-nav button, .pp-model-chip button')) {
      expect(btn.getAttribute('type')).toBe('button');
    }
  });
});

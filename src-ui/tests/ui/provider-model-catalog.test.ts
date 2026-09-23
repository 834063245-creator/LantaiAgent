// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 页「目录 / 启用」分层（2026-09-23 三层重构）——用户实测报告：
//   ①「从 API 拉了 81 个可用模型，为什么创作坞选择器里根本没有那么多」；
//   ②「我配置模型的时候，API 拉到的模型从来没让我选择模型来配置，拉过来之后就全部
//      在列表里了」。
// 本文件从用户操作序列钉死三层语义（目录 = 拉取快照 / 启用 = 勾选 = 创作坞可选面 /
// 选中 = 新会话默认）：
//   刷新目录 → 目录快照落暂存，**可用模型一行不变**；
//   目录里勾选 → 写可用模型；取消 → 移出可用模型；
//   全部取消 → 目录里的全取消，手工添加的不受牵连。

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// typedRpc → rpc → bridge.rpc —— mock bridge 层（照 provider-page-staging.test 模式）。
const mockInvoke = vi.fn(async (_kind: string, args: { method: string }) => {
  const m = args.method;
  if (m === 'oauth_accounts') return '[]';
  if (m === 'credential_get') return 'null';
  return 'null'; // llm_proxy_port → null ⇒ 传输层回退直连（测试里的 stub fetch）
});
vi.mock('../../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { ProviderPage } from '../../src/app/panels/settings/ProviderPage';
import { resetProxyPort } from '../../src/provider/transport';
import { type AppSettings, type ProviderId, type ProviderSettings, providerId } from '../../src/settings';
import { ensureProductionChannelsBooted } from '../helpers/composition-boot';

// createProvider 走方言贡献道（PROVIDER_DIALECT 未注册即响亮报错）——组件测试
// 需要生产组合通道在场（与 provider-model-meta.test 同款）。
await ensureProductionChannelsBooted();

/** 网关 /models 响应：三条模型（一条带名字与窗口，两条只有 id）。 */
const fetchMock = vi.fn(async (url: string) => {
  if (url.includes('/models')) {
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'gw-a', object: 'model', name: 'GW Model A', context_length: 262144 },
          { id: 'gw-b', object: 'model' },
          { id: 'gw-c', object: 'model' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('{}', { status: 404 });
});

/** 每次 onCommitProvider 的产物（暂存 settings 快照）——读「写进去了什么」。 */
const committed: AppSettings[] = [];

function makeSettings(over?: Partial<ProviderSettings>): AppSettings {
  return {
    activeProvider: providerId('gw'),
    providers: [
      {
        kind: 'openai',
        name: providerId('gw'),
        apiKey: 'sk-gw',
        baseUrl: 'https://gw.test/v1',
        model: 'hand-added',
        models: ['hand-added'],
        ...over,
      },
    ],
    projectPath: '.',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
  };
}

function Harness({ initial }: { initial: AppSettings }) {
  const [settings, setSettings] = useState(initial);
  const [providerDirty, setProviderDirty] = useState(false);
  return createElement(ProviderPage, {
    settings,
    onCommitProvider: (next: AppSettings) => {
      committed.push(next);
      setSettings(next);
      setProviderDirty(true);
    },
    onPersistProbe: () => {},
    onStageDelete: () => {},
    onStageClear: () => {},
    onUnstageClear: () => {},
    pendingClears: [],
    saveVersion: 0,
    providerDirty,
    onSaveProviders: () => setProviderDirty(false),
    onAddAndPersist: async (_next: AppSettings, _name: ProviderId) => {},
  });
}

describe('Provider 页 — 模型目录 / 可用模型分层（2026-09-23）', () => {
  let container: HTMLElement;
  let root: Root;

  const render = async (initial: AppSettings) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness, { initial }));
    });
  };

  const click = async (el: Element | null | undefined) => {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const byText = (sel: string, text: string) =>
    [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));

  /** 可用模型 chip 的 id（chip 文本是人类名，id 在 title）。 */
  const chipIds = () => [...document.querySelectorAll<HTMLElement>('.pp-model-chip')].map((c) => c.title);
  const catalogRows = () => [...document.querySelectorAll<HTMLElement>('.pp-catalog-row')];
  const rowIds = () => catalogRows().map((r) => r.title);
  const committedProvider = () => committed.at(-1)?.providers[0];

  beforeEach(() => {
    committed.length = 0;
    localStorage.clear();
    mockInvoke.mockClear();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    resetProxyPort();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
  });

  it('刷新目录：目录快照落暂存并列出全部模型，可用模型一行不变（「拉取 = 配置」不再发生）', async () => {
    await render(makeSettings());
    // 旧存档：没有目录快照
    expect(document.querySelector('.pp-catalog')?.textContent).toContain('尚未拉取');
    expect(chipIds()).toEqual(['hand-added']);

    await click(byText('.pp-f-label-row button', '刷新目录'));
    await act(async () => {});

    // 目录：三条全部列出（拉取的商品面），并自动展开
    expect(rowIds()).toEqual(['gw-a', 'gw-b', 'gw-c']);
    // 可用模型（创作坞可选面）不变 —— 用户没勾，就不进配置
    expect(chipIds()).toEqual(['hand-added']);
    const staged = committedProvider();
    expect(staged?.catalog).toEqual(['gw-a', 'gw-b', 'gw-c']);
    expect(staged?.models).toEqual(['hand-added']);
    expect(staged?.model).toBe('hand-added');
    // 元数据（窗口/名字）同批落暂存
    expect(staged?.modelMeta?.['gw-a']?.contextWindow).toBe(262144);
  });

  it('目录里勾选 → 写可用模型；取消 → 移出（勾选才是配置动作）', async () => {
    await render(makeSettings({ catalog: ['gw-a', 'gw-b', 'gw-c'] }));
    expect(rowIds()).toEqual(['gw-a', 'gw-b', 'gw-c']);

    const boxOf = (id: string) =>
      catalogRows()
        .find((r) => r.title === id)
        ?.querySelector('input');
    await click(boxOf('gw-b'));
    expect(chipIds()).toContain('gw-b');
    expect(committedProvider()?.models).toEqual(['hand-added', 'gw-b']);

    await click(
      catalogRows()
        .find((r) => r.title === 'gw-b')
        ?.querySelector('input'),
    );
    expect(chipIds()).not.toContain('gw-b');
    expect(committedProvider()?.models).toEqual(['hand-added']);
  });

  it('全选 / 全部取消：目录进出可用模型，手工添加的不受牵连', async () => {
    await render(makeSettings({ catalog: ['gw-a', 'gw-b'], models: ['hand-added', 'gw-a'] }));

    await click(byText('.pp-catalog-tools button', '全选'));
    expect(committedProvider()?.models).toEqual(['hand-added', 'gw-a', 'gw-b']);

    await click(byText('.pp-catalog-tools button', '全部取消'));
    // 「全部取消」只清目录里的勾选——手工条目的启用状态是用户自己的选择
    expect(committedProvider()?.models).toEqual(['hand-added']);
    expect(chipIds()).toEqual(['hand-added']);
  });

  it('拉取失败：真实原因可见，目录与可用模型都不动（错误不静默）', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }));
    await render(makeSettings({ catalog: ['gw-a'] }));

    await click(byText('.pp-f-label-row button', '刷新目录'));
    await act(async () => {});

    expect(document.body.textContent).toContain('模型目录获取失败');
    expect(rowIds()).toEqual(['gw-a']); // last-good 目录保留
    expect(chipIds()).toEqual(['hand-added']); // 可用模型不动
  });

  it('目录搜索：按 id 过滤可勾选行（大目录里挑得动）', async () => {
    await render(makeSettings({ catalog: ['gw-a', 'gw-b', 'gw-c'] }));
    const search = document.querySelector<HTMLInputElement>('input[aria-label="搜索模型目录"]');
    expect(search).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search!, 'gw-c');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rowIds()).toEqual(['gw-c']);
  });
});

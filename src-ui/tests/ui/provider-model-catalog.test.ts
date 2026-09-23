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

/** 网关 /models 响应：三条模型（一条带名字与窗口，两条只有 id）。
 *  显式命名 + 每个 describe 的 beforeEach 复位（mockClear 不清实现——「拉取失败」
 *  用例改过实现，不复位会污染后面的用例）。 */
const defaultFetchImpl = async (url: string): Promise<Response> => {
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
};
const fetchMock = vi.fn(defaultFetchImpl);

/** 复位 fetch 桩到默认实现（每个用例前调用）。 */
function resetFetchMock(): void {
  fetchMock.mockReset();
  fetchMock.mockImplementation(defaultFetchImpl);
}

/** 每次 onCommitProvider 的产物（暂存 settings 快照）——读「写进去了什么」。 */
const committed: AppSettings[] = [];
/** 添加弹层「确认添加」的产物（即时持久化的 next settings）。 */
const addedSettings: AppSettings[] = [];

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
    onAddAndPersist: async (next: AppSettings, _name: ProviderId) => {
      addedSettings.push(next);
    },
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
    addedSettings.length = 0;
    localStorage.clear();
    mockInvoke.mockClear();
    resetFetchMock();
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

  it('目录里点行 → 添加进可用模型；再点 → 移除（行上写着动作名）', async () => {
    await render(makeSettings({ catalog: ['gw-a', 'gw-b', 'gw-c'] }));
    expect(rowIds()).toEqual(['gw-a', 'gw-b', 'gw-c']);

    const rowOf = (id: string) => catalogRows().find((r) => r.title === id);
    expect(rowOf('gw-b')?.querySelector('.pp-catalog-verb')?.textContent).toBe('添加');
    await click(rowOf('gw-b')?.querySelector('input'));
    expect(chipIds()).toContain('gw-b');
    expect(committedProvider()?.models).toEqual(['hand-added', 'gw-b']);
    expect(rowOf('gw-b')?.querySelector('.pp-catalog-verb')?.textContent).toBe('移除');

    await click(rowOf('gw-b')?.querySelector('input'));
    expect(chipIds()).not.toContain('gw-b');
    expect(committedProvider()?.models).toEqual(['hand-added']);
  });

  it('全部添加 / 全部移除：目录进出可用模型，手工添加的不受牵连', async () => {
    await render(makeSettings({ catalog: ['gw-a', 'gw-b'], models: ['hand-added', 'gw-a'] }));

    await click(byText('.pp-catalog-tools button', '全部添加'));
    expect(committedProvider()?.models).toEqual(['hand-added', 'gw-a', 'gw-b']);

    await click(byText('.pp-catalog-tools button', '全部移除'));
    // 「全部移除」只清目录里的条目——手工条目的启用状态是用户自己的选择
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

  it('目录搜索：按 id 过滤可挑的行（大目录里挑得动）', async () => {
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

// 「拉取」与「添加」是两个动作（2026-09-23 用户 UX 复盘：别人的流程是
// 从 API 拉到模型 → **再有一个添加模型的步骤**，我们缺的正是这一步）。
// 本组从添加弹层的用户操作序列钉死这两步：拉取只填目录（一个都不添加），
// 行首「＋」/「全部添加」才是添加，「确认添加」只带已添加的。
describe('添加提供方 — 拉取 → 添加 两步（2026-09-23）', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    committed.length = 0;
    addedSettings.length = 0;
    localStorage.clear();
    mockInvoke.mockClear();
    resetFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    resetProxyPort();
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    container.remove();
  });

  const click = async (el: Element | null | undefined) => {
    await act(async () => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  const byText = (sel: string, text: string) =>
    [...document.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));
  const pickRows = () => [...document.querySelectorAll<HTMLElement>('.pp-pick-model')];
  const pickIds = () => pickRows().map((r) => r.querySelector('.pp-pick-model-id')?.textContent);
  const addedCount = () =>
    [...document.querySelectorAll<HTMLElement>('.pp-pick-head .pp-chip')][0]?.textContent?.trim();

  /** 打开添加弹层、填名字、从 API 拉取（fetch 桩返回 3 条目录模型）。 */
  async function openAndPull(): Promise<void> {
    await act(async () => {
      root.render(createElement(Harness, { initial: makeSettings() }));
    });
    await click(document.querySelector('.pp-rail-add'));
    const nameInput = [...document.querySelectorAll<HTMLInputElement>('.pp-form-grid input')].find((i) =>
      i.placeholder.includes('my-gateway'),
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(nameInput, 'gw-new');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText('.pp-add-pull-row button', '从 API 拉取模型'));
    await act(async () => {});
  }

  it('拉取后目录列出全部模型但**一个都没添加**（那一步不再被吃掉）', async () => {
    await openAndPull();
    expect(pickIds()).toEqual(['gw-a', 'gw-b', 'gw-c']);
    expect(addedCount()).toBe('已添加 0 / 目录 3');
    expect(pickRows().every((r) => r.querySelector('.pp-pick-act')?.textContent === '＋')).toBe(true);
    expect(document.body.textContent).toContain('点行首「＋」添加要用的');
    expect(document.body.textContent).toContain('目录里的模型还没添加');
  });

  it('未添加就确认 → 被拦并指名那一步；添加后再确认 → 只带已添加的 + 目录快照', async () => {
    await openAndPull();
    await click(byText('.cd-actions button', '确认添加'));
    expect(addedSettings).toHaveLength(0);
    expect(document.querySelector('.pp-form-error')?.textContent).toContain('点「＋」添加');

    // 行首「＋」= 添加一个
    await click(pickRows()[1]?.querySelector('.pp-pick-act'));
    expect(addedCount()).toBe('已添加 1 / 目录 3');
    await click(byText('.cd-actions button', '确认添加'));

    expect(addedSettings).toHaveLength(1);
    const added = addedSettings[0]?.providers.find((p) => p.name === 'gw-new');
    expect(added?.models).toEqual(['gw-b']); // 只带添加的
    expect(added?.catalog).toEqual(['gw-a', 'gw-b', 'gw-c']); // 目录快照随行落盘
    expect(added?.model).toBe('gw-b'); // 第一个添加的成为新会话默认
  });

  it('全部添加 / 全部移除 与逐个添加等价（同一份语义）', async () => {
    await openAndPull();
    await click(byText('.pp-pick-head button', '全部添加'));
    expect(addedCount()).toBe('已添加 3 / 目录 3');
    await click(byText('.pp-pick-head button', '全部移除'));
    expect(addedCount()).toBe('已添加 0 / 目录 3');
    expect(pickRows().every((r) => r.querySelector('.pp-pick-act')?.textContent === '＋')).toBe(true);
  });
});

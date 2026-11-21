// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 详情页信息架构（2026-11-21 IA 批，handoff §7.2 欠账 ①②④⑤）：
//   ① 单列纵向堆叠 → 按任务分区 + 锚点导航（分区顺序 = 页面顺序，nav 与 DOM 同源）；
//   ② 「模型目录」与「参数」职责分离：可用模型 / 参数面板双列，目录独立成块；
//   ④ 窄窗版式靠容器查询（`.pp-body` 是 container-type 落点）——本文件钉住结构契约，
//      断点行为由 CSS 契约断言（见 tests/ui/provider-console-css.test.ts）；
//   ⑤ 本文件同时是**信息结构基线**：分区 id / 导航文案 / 每节 aria-label 一旦漂移即红。
//
// 关卡口径：这些是「用户能不能定位到东西」的契约，不是实现细节——
// 分区增删、改名、换序都要在这一处显式改基线。

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn(async (_kind: string, args: { method: string }) => {
  if (args.method === 'oauth_accounts') return '[]';
  if (args.method === 'credential_get') return 'null';
  return 'null';
});
vi.mock('../../src/bridge', () => ({
  invoke: vi.fn(),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(),
  isMockMode: () => false,
  watchFileDragDrop: vi.fn(),
}));

import { ProviderPage } from '../../src/plugins/builtin/settings-domain/ProviderPage';
import { type AppSettings, providerId } from '../../src/settings';
import { ensureProductionChannelsBooted } from '../helpers/composition-boot';

await ensureProductionChannelsBooted();

function makeSettings(providerCount = 1): AppSettings {
  const providers: AppSettings['providers'] = [
    {
      kind: 'openai',
      name: providerId('gw'),
      apiKey: 'sk-gw',
      baseUrl: 'https://gw.test/v1',
      model: 'gw-a',
      models: ['gw-a', 'gw-b'],
      catalog: ['gw-a', 'gw-b'],
    },
  ];
  if (providerCount > 1) {
    providers.push({
      kind: 'anthropic',
      name: providerId('anth'),
      apiKey: 'sk-anth',
      baseUrl: 'https://api.anthropic.test',
      model: 'claude-sonnet-4-6',
      models: ['claude-sonnet-4-6'],
    });
  }
  return {
    activeProvider: providerId('gw'),
    providers,
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
    onAddAndPersist: async () => {},
  });
}

const click = async (el: Element | null | undefined) => {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

/** happy-dom 的 scrollIntoView 是 no-op：换成可断言的手势面（记录被滚到哪个元素）。 */
const elementScrollSpy = vi.fn(function (this: Element) {});

describe('Provider 详情页 — 分区与锚点导航（2026-11-21）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  const render = async (settings: AppSettings) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness, { initial: settings }));
    });
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    elementScrollSpy.mockClear();
    // happy-dom 的 scrollIntoView 是 no-op：换成可断言的手势面
    Element.prototype.scrollIntoView = elementScrollSpy as unknown as typeof Element.prototype.scrollIntoView;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  const navButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.pp-sec-nav .pp-sec-jump')];
  const sectionIds = () => [...document.querySelectorAll<HTMLElement>('.pp-console .pp-sec')].map((s) => s.id);

  it('分区 = 连接 / 模型 / 诊断 / 高级 / 文件（+ 危险区），导航与页面同序同源', async () => {
    await render(makeSettings(2));
    // ⑤ 结构基线：改顺序 / 改名 / 增删分区 = 显式改这里
    expect(navButtons().map((b) => b.textContent)).toEqual(['连接', '模型', '诊断', '高级', '文件', '危险区']);
    expect(sectionIds()).toEqual([
      'pp-sec-conn',
      'pp-sec-models',
      'pp-sec-diag',
      'pp-sec-adv',
      'pp-sec-file',
      'pp-sec-danger',
    ]);
    // 每个分区都有一个 nav 按钮（悬空锚点 = 用户点了个空的）
    expect(navButtons()).toHaveLength(sectionIds().length);
  });

  it('单提供方时没有危险区（删不了就没有这一节，也不留空锚点）', async () => {
    await render(makeSettings(1));
    expect(navButtons().map((b) => b.textContent)).not.toContain('危险区');
    expect(sectionIds()).not.toContain('pp-sec-danger');
  });

  it('点导航 → 滚到对应分区，按钮置为当前位置（aria-current 只标一个）', async () => {
    await render(makeSettings(1));
    const modelsBtn = navButtons().find((b) => b.textContent === '模型')!;
    await click(modelsBtn);
    expect(elementScrollSpy).toHaveBeenCalledTimes(1);
    expect((elementScrollSpy.mock.contexts.at(-1) as Element | undefined)?.id).toBe('pp-sec-models');
    expect(modelsBtn.getAttribute('aria-current')).toBe('location');
    expect(navButtons().filter((b) => b.getAttribute('aria-current') === 'location')).toHaveLength(1);

    await click(navButtons().find((b) => b.textContent === '诊断')!);
    expect((elementScrollSpy.mock.contexts.at(-1) as Element | undefined)?.id).toBe('pp-sec-diag');
  });

  it('每节都是有名字的 landmark（读屏能报「连接与凭据 / 模型 / 诊断 …」）', async () => {
    await render(makeSettings(1));
    const labels = [...document.querySelectorAll<HTMLElement>('.pp-console .pp-sec')].map((s) =>
      s.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['连接与凭据', '模型', '诊断', '高级连接配置', '配置文件']);
    expect(document.querySelector('nav.pp-sec-nav')?.getAttribute('aria-label')).toBe('提供方分区导航');
  });
});

describe('Provider 详情页 — 模型区：可用模型 / 参数双列（2026-11-21）', () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  const render = async (settings: AppSettings) => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness, { initial: settings }));
    });
  };

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  const columns = () => [...document.querySelectorAll<HTMLElement>('.pp-model-work > .pp-model-col')];
  const paramBtn = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.pp-model-chip-param')].find((b) =>
      b.closest('.pp-model-chip')?.textContent?.includes(name),
    );

  it('左列可用模型、右列参数面板；没选模型时右列只给引导语（不展开任何编辑器）', async () => {
    await render(makeSettings(1));
    expect(columns()).toHaveLength(2);
    expect(columns()[0]?.querySelectorAll('.pp-model-chip')).toHaveLength(2);
    expect(columns()[1]?.querySelector('.pp-params-empty')).not.toBeNull();
    expect(document.querySelector('.pp-model-params')).toBeNull();
  });

  it('点「参数」→ 右列出现该模型的编辑器；按钮 aria-expanded / aria-controls 指向它', async () => {
    await render(makeSettings(1));
    const btn = paramBtn('gw-a')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await click(btn);

    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const panel = columns()[1]?.querySelector<HTMLElement>('.pp-model-params');
    expect(panel).not.toBeNull();
    const controlled = btn.getAttribute('aria-controls');
    expect(controlled).toBeTruthy();
    expect(document.getElementById(controlled!)).toBe(panel);
    expect(panel?.getAttribute('aria-label')).toBe('gw-a 的模型参数');
    // 一次只开一个模型的面板
    expect(document.querySelectorAll('.pp-model-params')).toHaveLength(1);
  });

  it('再点「收起」→ 编辑器从右列消失（行内不再挂参数，列表保持短）', async () => {
    await render(makeSettings(1));
    await click(paramBtn('gw-a'));
    const btn = columns()[0]!.querySelector('.pp-model-chip-param.is-on');
    expect(btn?.textContent).toBe('收起');
    await click(btn);
    expect(document.querySelector('.pp-model-params')).toBeNull();
    expect(columns()[1]?.querySelector('.pp-params-empty')).not.toBeNull();
  });

  it('「参数」与「模型目录」职责分开：目录在双列之外，参数面板里没有目录', async () => {
    await render(makeSettings(1));
    const work = document.querySelector('.pp-model-work')!;
    const catalog = document.querySelector('.pp-catalog')!;
    expect(work.contains(catalog)).toBe(false);
    expect(catalog.closest('.pp-sec')?.id).toBe('pp-sec-models');

    await click(paramBtn('gw-a'));
    expect(document.querySelector('.pp-model-params .pp-catalog')).toBeNull();
    // 目录收纳在模型区尾部（同一任务面，但不再是「第二个参数编辑器」）
    expect(document.querySelector('.pp-sec#pp-sec-models')?.contains(catalog)).toBe(true);
  });

  it('切到另一个模型重开面板：内容换人，不残留上一个模型的输入', async () => {
    await render(makeSettings(1));
    await click(paramBtn('gw-a'));
    const first = document.querySelector('.pp-model-params')?.getAttribute('id');
    await click(paramBtn('gw-b'));
    const second = document.querySelector('.pp-model-params')?.getAttribute('id');
    expect(first).not.toBe(second);
    expect(second).toBe(paramBtn('gw-b')!.getAttribute('aria-controls'));
  });
});

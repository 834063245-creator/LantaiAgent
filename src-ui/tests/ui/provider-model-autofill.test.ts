// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 「选完模型就自动填好」——用户实测问题（2026-11-21）：
//   「提供商随 /models 同时给了上下文容量、思考强度档位，用户选了模型之后会自动填好吗？」
// 数据层早就按四层链解析（覆盖 ?? API 拉取 ?? 目录 ?? 缺省），但参数面板把生效值
// 放在**占位符**里（灰字、空 value）+ 档位表折叠在「未开启」后面 ⇒ 看起来像「没填」。
// 本文件从用户操作序列钉死渲染面：
//   刷新目录 → 添加模型 → 打开「参数」→ 窗口/输出已是填好的值（灰字 = 自动值）、
//   思考档位下拉列出端点声明的档位、档位表区直接写明「生效档位表」；
//   本家默认档位不在该模型档位表内时，就地告警且实际按「自动」发送。

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
import { resetProxyPort } from '../../src/provider/transport';
import { type AppSettings, type ProviderSettings, providerId } from '../../src/settings';
import { ensureProductionChannelsBooted } from '../helpers/composition-boot';

await ensureProductionChannelsBooted();

/** 网关 /models：一条带名字 + 窗口 + 输出上限 + 思考档位声明；一条只有 id。 */
const fetchMock = vi.fn(async (url: string) => {
  if (url.includes('/models')) {
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'gw-a',
            object: 'model',
            name: 'GW Model A',
            context_length: 262144,
            max_output_tokens: 65536,
            thinking_efforts: ['low', 'medium', 'high'],
          },
          { id: 'gw-b', object: 'model' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('{}', { status: 404 });
});

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

const tick = () => new Promise((r) => setTimeout(r, 60));

/** 刷新目录 → 勾选 gw-a → 打开 gw-a 的「参数」面板。返回容器。 */
async function openParams(initial: AppSettings): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness, { initial }));
  });
  await tick();

  const refresh = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes('刷新目录'),
  );
  await act(async () => {
    refresh?.click();
  });
  await tick();
  await tick();

  const catalogRow = container.querySelector<HTMLInputElement>('.pp-catalog-row input');
  expect(catalogRow).toBeTruthy();
  await act(async () => {
    catalogRow?.click();
  });
  await tick();

  const chip = [...container.querySelectorAll<HTMLElement>('.pp-model-chip')].find((c) =>
    c.textContent?.includes('GW Model A'),
  );
  const paramBtn = [...(chip?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => b.textContent === '参数',
  );
  expect(paramBtn).toBeTruthy();
  await act(async () => {
    paramBtn?.click();
  });
  await tick();
  return container;
}

let root: Root | null = null;

describe('参数面板：选中模型后生效值自动显示（2026-11-21）', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    resetProxyPort();
  });
  afterEach(() => {
    root?.unmount();
    root = null;
    vi.unstubAllGlobals();
  });

  it('窗口 / 输出显示为「已填好」的生效值（灰字），来源标注 API 拉取', async () => {
    const container = await openParams(makeSettings());
    const inputs = [...container.querySelectorAll<HTMLInputElement>('.pp-model-params input[type=number]')];
    const win = inputs[0];
    const out = inputs[1];
    expect(win?.value).toBe('262144');
    expect(out?.value).toBe('65536');
    // 自动值可分辨（灰字斜体）——不是用户写的覆盖值
    expect(win?.classList.contains('is-derived')).toBe(true);
    expect(out?.classList.contains('is-derived')).toBe(true);
    const srcs = [...container.querySelectorAll('.pp-model-param-src')].map((n) => n.textContent ?? '');
    expect(srcs.some((t) => t.includes('API 拉取'))).toBe(true);
  });

  it('档位表区直接写明端点声明的生效表；设置页不再有档位选择器（2026-11-21 收口）', async () => {
    const container = await openParams(makeSettings());
    const current = container.querySelector('.pp-model-levels-current')?.textContent ?? '';
    expect(current).toContain('低 (low)');
    expect(current).toContain('中 (medium)');
    expect(current).toContain('高 (high)');
    // 「用哪一档」只在创作坞按会话选——设置页单模型面板不再有选择器
    expect(container.querySelector('.pp-model-reasoning select')).toBeNull();
  });
});

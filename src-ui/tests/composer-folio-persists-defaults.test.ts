// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 题签「记住选择」**真落盘**。
//
// 现行语义（2026-11-30 R5 收口后，本文件钉它）：
//   · 模型 = **最近使用**运行态读数，落本地存档 provider 行的 `model`，不进 providers.yml；
//     新卷/未改卷跟从它，目录移除时自动回落第一个可用模型。
//   · 思考档位 = 该模型「上次用过」的本机记忆（lastThinking），也不进 providers.yml。
//   · `providers.yml` 只留连接意图与可用模型列表（models）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>();

vi.mock('../src/bridge', () => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => true,
  rpc: (method: string, params: Record<string, unknown>) => mockRpc(method, params),
  watchFileDragDrop: vi.fn(async () => () => {}),
}));
vi.mock('../src/i18n', () => ({ setLang: vi.fn() }));

import { __resetProvidersDocForTests, bootstrapProvidersDoc } from '../src/provider/providers-store';
import { installProvidersProjection, loadSettings } from '../src/settings';
import { getComposeStore, resetComposeStoresForTests, resolveNewSessionDefault } from '../src/state/compose-store';

const STORAGE_KEY = 'hologram_settings';
const DOC_PATH = 'C:/Users/u/.lantai/providers.yml';
const PANEL = 'folio-persist';

/** 一份「文件权威已就位」的 provider 配置（模型 / 档位都还没被拨过）。 */
const DOC = `deepseek:
  kind: openai
  baseUrl: https://api.deepseek.com/v1
  model: deepseek-flash
`;

const disk = new Map<string, string>();

function wireRpc(): void {
  mockRpc.mockImplementation(async (method, params) => {
    if (method === 'providers_dir') return 'C:/Users/u/.lantai';
    if (method === 'fs_cap') {
      const action = params.action as string;
      const path = (params.file_path ?? params.path) as string;
      if (action === 'read') {
        const text = disk.get(path);
        if (text === undefined) throw new Error(`no such file: ${path}`);
        return { path, content: text };
      }
      if (action === 'write') {
        disk.set(path, params.content as string);
        return { path };
      }
      if (action === 'create_dir') return { path };
    }
    return 'null';
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));

describe('题签「记住选择」· 文件权威下落盘（2026-11-29）', () => {
  beforeEach(async () => {
    localStorage.clear();
    disk.clear();
    disk.set(DOC_PATH, DOC);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeProvider: 'deepseek',
        providers: [{ name: 'deepseek', apiKey: '', model: 'deepseek-flash' }],
      }),
    );
    mockRpc.mockReset();
    wireRpc();
    installProvidersProjection(null);
    __resetProvidersDocForTests();
    await bootstrapProvidersDoc();
  });

  // ⚡ 2026-11-21 思考档位收口：设置页的「默认档位」手动项已拆——无主态拨的档位
  // 记成「该模型上次用的档位」（本机读数，跟 catalog/modelMeta 同层），
  // **不写 providers.yml**；重开应用仍在（不像草稿那样丢）。
  it('思考档位：记本机读数（lastThinking）、不写 providers.yml，重开后沿用', async () => {
    getComposeStore(PANEL).getState().setGlobalThinking('high');

    /* ① 当拍可读：下一张纸的出厂值不能等 IPC 回来 */
    expect(resolveNewSessionDefault().model).toBe('deepseek-flash');
    expect(resolveNewSessionDefault().thinking).toBe('high');

    /* ② 配置文件里没有档位（不是配置）；本机存档里有记忆 */
    await settle();
    expect(disk.get(DOC_PATH)).not.toContain('thinking');
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      providers?: Array<{ name?: string; lastThinking?: Record<string, string> }>;
    };
    expect(stored.providers?.[0]?.lastThinking?.['deepseek-flash']).toBe('high');

    /* ③ 「重启」= 重新装载（本机读数恢复）→ 仍在 */
    resetComposeStoresForTests();
    __resetProvidersDocForTests();
    installProvidersProjection(null);
    wireRpc();
    await bootstrapProvidersDoc();
    expect(resolveNewSessionDefault().thinking).toBe('high');
  });

  it('模型：最近使用落本地存档；providers.yml 不再写 model；重启跟从最近使用', async () => {
    getComposeStore(PANEL).getState().setGlobalModel('deepseek', 'deepseek-v4-pro');

    expect(resolveNewSessionDefault().model).toBe('deepseek-v4-pro');
    await settle();
    // R5：最近使用是运行态，不属于 provider 文件意图——切换模型不会改写文件。
    // 文件里那条旧版 model 是迁移源，等下一次 Provider 保存时才会被清掉。
    expect(disk.get(DOC_PATH)).toContain('model: deepseek-flash');
    expect(disk.get(DOC_PATH)).not.toContain('model: deepseek-v4-pro');

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      activeProvider?: string;
      providers?: Array<{ name: string; model?: string }>;
    };
    expect(stored.activeProvider, '最近使用的 provider 是运行态读数，落本地存档').toBe('deepseek');
    expect(stored.providers?.[0]?.model, '最近使用模型也是运行态读数').toBe('deepseek-v4-pro');
    expect(loadSettings().providers[0]?.model, '行表投影合上最近使用').toBe('deepseek-v4-pro');

    // 文件里仍留着旧版 model（迁移源）也不得盖掉本地更新的最近使用。
    __resetProvidersDocForTests();
    await bootstrapProvidersDoc();
    expect(resolveNewSessionDefault().model).toBe('deepseek-v4-pro');
  });

  it('降级域（文件通道不可用）：模型仍落本地存档；档位只记内存（不炸）', async () => {
    // 通道坏掉 → 文件权威不成立
    installProvidersProjection(null);
    __resetProvidersDocForTests();
    mockRpc.mockImplementation(async () => {
      throw new Error('unknown command: providers_dir');
    });
    await bootstrapProvidersDoc();

    getComposeStore(PANEL).getState().setGlobalModel('deepseek', 'deepseek-v4-pro');
    getComposeStore(PANEL).getState().setGlobalThinking('low');

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      providers?: Array<{ name: string; model?: string; modelOverrides?: Record<string, { thinking?: string }> }>;
    };
    expect(stored.providers?.[0]?.model).toBe('deepseek-v4-pro');
    // 档位没有「默认值」可落盘——内存里带上，重启即回自动
    expect(stored.providers?.[0]?.modelOverrides?.['deepseek-v4-pro']?.thinking).toBeUndefined();
    expect(resolveNewSessionDefault().thinking).toBe('low');
  });
});

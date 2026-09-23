// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// provider 配置文件通道（2026-09-24 配方改文件批）——**写盘那一半**的端到端：
// 装载（首启迁移 / 空文件 / 坏手稿）、保存（读-改-写保住手写注释）、拒写纪律、
// 热重载（providers:changed → 重读 + 广播）。
//
// 纯解析/渲染的逐条语义在 tests/providers-doc.test.ts；本文件钉「接线」：
// 前端经 RPC 通道真的把意图写到了那份文件上，且该拒的时候拒。

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn<(method: string, params: Record<string, unknown>) => Promise<string>>();
const mockConfigChanged = vi.fn();

vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('9.0.0') }));
vi.mock('../src/bridge', () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  isMockMode: () => true,
  rpc: (method: string, params: Record<string, unknown>) => mockRpc(method, params),
  watchFileDragDrop: vi.fn(),
}));
vi.mock('../src/i18n', () => ({ setLang: vi.fn() }));
vi.mock('../src/state/agent-config-store', () => ({
  notifyAgentConfigChanged: (...args: unknown[]) => mockConfigChanged(...args),
}));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '' }));

import { SettingsPanel } from '../src/plugins/builtin/settings-domain/SettingsPanel';
import { bootstrapProvidersDoc, loadProvidersDoc, providersDocStatus } from '../src/provider/providers-store';
import { installProvidersProjection, loadSettings, loadSettingsWithSecrets } from '../src/settings';

const STORAGE_KEY = 'hologram_settings';
const tick = () => new Promise((r) => setTimeout(r, 50));

/** 内存文件系统：fs_cap read/write 打到同一份文本上。 */
const disk = new Map<string, string>();
const DOC_PATH = 'C:/Users/u/.lantai/providers.yml';

function wireRpc(): void {
  mockRpc.mockImplementation(async (method, params) => {
    if (method === 'providers_dir') return 'C:/Users/u/.lantai';
    if (method === 'fs_cap') {
      const action = params.action as string;
      const path = (params.file_path ?? params.path) as string;
      if (action === 'read') {
        const text = disk.get(path);
        if (text === undefined) throw new Error(`no such file: ${path}`);
        return JSON.stringify({ path, content: text });
      }
      if (action === 'write') {
        disk.set(path, params.content as string);
        return JSON.stringify({ path });
      }
      if (action === 'create_dir') return JSON.stringify({ path });
    }
    return 'null';
  });
}

interface StoredRow {
  kind?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  models?: string[];
  headers?: Record<string, string>;
  lastTest?: unknown;
  catalog?: string[];
}

function seedStored(rows: StoredRow[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeProvider: 'deepseek', providers: rows }));
}

describe('provider 配置文件通道（写盘一半）', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockConfigChanged.mockReset();
    disk.clear();
    localStorage.clear();
    installProvidersProjection(null);
    wireRpc();
  });

  it('首启迁移：文件为空 ⇒ 把旧存档的 provider 行写成配置文件，此后文件即权威', async () => {
    seedStored([
      {
        kind: 'openai',
        name: 'deepseek',
        apiKey: '',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        models: ['deepseek-flash'],
      },
    ]);
    await bootstrapProvidersDoc();

    const text = disk.get(DOC_PATH) ?? '';
    expect(text).toContain('deepseek:');
    expect(text).toContain('baseUrl: https://api.deepseek.com/v1');
    // 密钥绝不落文件（写进去就是明文落盘）；文件头里提到 apiKey 是那句规矩本身
    expect(text).not.toContain('apiKey:');
    // 投影已生效：loadSettings 看到的是文件里的行
    expect(loadSettings().providers.map((p) => p.name)).toEqual(['deepseek']);
    expect(providersDocStatus().fatal).toBeUndefined();
    expect(providersDocStatus().available).toBe(true);
  });

  it('文件已有内容 ⇒ 不回填（文件是权威）：行表 = 文件里的键，存档里的陈旧行不复活', async () => {
    disk.set(
      DOC_PATH,
      'hand-written:\n  kind: anthropic\n  baseUrl: https://api.anthropic.com\n  model: claude-opus-4-6\n',
    );
    seedStored([{ kind: 'openai', name: 'stale-row', baseUrl: 'https://stale/v1', model: 'x' }]);
    await bootstrapProvidersDoc();

    expect(loadSettings().providers.map((p) => p.name)).toEqual(['hand-written']);
    // 存档没被覆写（stale-row 仍在 localStorage 里当运行态壳——它不在文件里就不显示）
    expect(disk.get(DOC_PATH)).toContain('hand-written:');
    expect(disk.get(DOC_PATH)).not.toContain('stale-row');
  });

  it('手改文件（含注释）后保存：读-改-写保住注释，只落变更字段', async () => {
    disk.set(
      DOC_PATH,
      [
        '# 我的手写注释：这一行别删',
        'deepseek:',
        '  kind: openai          # 协议',
        '  baseUrl: https://old.example/v1',
        '  model: deepseek-flash',
        '',
      ].join('\n'),
    );
    await bootstrapProvidersDoc();
    const s = loadSettings();
    // 模拟设置页提交：改 baseUrl + 加请求头（其余照旧）
    const { saveProvidersDoc } = await import('../src/provider/providers-store');
    const { intentOf } = await import('../src/provider/providers-doc');
    const next = s.providers.map((p) => ({
      ...p,
      baseUrl: 'https://new.example/v1',
      headers: { 'x-opencode-session': 'sess-1' },
    }));
    const patch = Object.fromEntries(next.map((p) => [p.name, intentOf(p)]));
    const res = await saveProvidersDoc(patch);
    expect(res.ok).toBe(true);

    const text = disk.get(DOC_PATH) ?? '';
    expect(text).toContain('# 我的手写注释：这一行别删');
    expect(text).toContain('kind: openai # 协议');
    expect(text).toContain('baseUrl: https://new.example/v1');
    expect(text).toContain('x-opencode-session: sess-1');
    // 重新装载后投影跟着变（保存 → 重读 → 一致）
    await loadProvidersDoc();
    expect(loadSettings().providers[0].baseUrl).toBe('https://new.example/v1');
  });

  it('拒写纪律：手稿 YAML 坏了 ⇒ 保存报错且文件一字不动（绝不覆盖用户手稿）', async () => {
    const broken = 'deepseek: [unclosed\n# 我的半成品手稿\n';
    disk.set(DOC_PATH, broken);
    // 存档里有一行（手稿坏了 ⇒ 解析不出节 ⇒ 迁移不发生，投影为空——
    // 但设置页仍可能对着这一行按保存，必须被拒）
    seedStored([{ kind: 'openai', name: 'deepseek', baseUrl: 'https://x/v1', model: 'deepseek-flash' }]);
    await bootstrapProvidersDoc();
    const { saveProvidersDoc } = await import('../src/provider/providers-store');
    const res = await saveProvidersDoc({
      deepseek: { kind: 'openai', baseUrl: 'https://typed.example/v1', model: 'deepseek-flash' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('拒绝写入');
    expect(disk.get(DOC_PATH)).toBe(broken);
  });

  it('保存页端到端：设置页改 baseUrl → 保存 → 意图进文件、localStorage 只留运行态', async () => {
    disk.set(DOC_PATH, 'deepseek:\n  kind: openai\n  baseUrl: https://old.example/v1\n  model: deepseek-flash\n');
    await bootstrapProvidersDoc();

    const container = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(container);
    let root: Root | null = createRoot(container);
    root.render(createElement(SettingsPanel));
    await tick();
    // 密钥回填是异步的——等它落定再操作
    await loadSettingsWithSecrets().catch(() => {});
    await tick();

    const urlInput = [...container.querySelectorAll<HTMLInputElement>('.pp-field input')].find((i) =>
      i.placeholder.includes('https://'),
    );
    expect(urlInput).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(urlInput, 'https://typed.example/v1');
    urlInput?.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    container.querySelector<HTMLButtonElement>('.pp-save-btn')?.click();
    await tick();
    await tick();

    // 意图进了文件（唯一权威）
    const text = disk.get(DOC_PATH) ?? '';
    expect(text).toContain('baseUrl: https://typed.example/v1');
    // localStorage 只留运行态（baseUrl 不是它的）
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { providers?: StoredRow[] };
    expect(stored.providers?.[0]).not.toHaveProperty('baseUrl');
    expect(mockConfigChanged).toHaveBeenCalledWith('settings-saved');

    root?.unmount();
    root = null;
  });
});

// @vitest-environment happy-dom

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
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));

import { SettingsPanel } from '../src/plugins/builtin/settings-domain/SettingsPanel';
import {
  __resetProvidersDocForTests,
  bootstrapProvidersDoc,
  loadProvidersDoc,
  PROVIDERS_INTENT_BACKUP_KEY,
  providersDocStatus,
  retryProvidersPath,
  saveProvidersDoc,
} from '../src/provider/providers-store';
import { installProvidersProjection, loadSettings, loadSettingsWithSecrets, providerId } from '../src/settings';

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

/** 断掉通道（模拟：壳里还没有 providers_dir / 前端热更跑在旧壳上 / mock 宿主）。 */
function breakChannel(): void {
  mockRpc.mockImplementation(async () => {
    throw new Error('unknown command: providers_dir');
  });
}

describe('provider 配置文件通道（写盘一半）', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockConfigChanged.mockReset();
    disk.clear();
    localStorage.clear();
    installProvidersProjection(null);
    // 每组用例各跑一遍真实时序（「通道先坏后好」那组必须从干净模块态开始）
    __resetProvidersDocForTests();
    wireRpc();
  });

  // ⚡ 2026-09-23 真机事故回归（用户报「之前配好的供应商也没了」）：
  // 病灶有两个，缺一不可成灾——
  //   ① 取路径失败被**缓存**：任何一次早期调用（壳没挂上 RPC / 前端热更跑在旧壳上）
  //      就把文件权威永久钉死成不可用，此后既不建文件也不迁移；
  //   ② 那个状态下 saveSettings 仍把 provider 的**意图**从 localStorage 剥掉
  //      ⇒ 盘上没有文件、内存里也没有行 = 配置凭空消失。
  it('通道短暂不可用后恢复：不缓存失败，引导仍会建文件并迁移（不丢配置）', async () => {
    seedStored([
      {
        kind: 'openai',
        name: 'commandcodegoat',
        apiKey: 'sk-secret',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        model: 'deepseek/deepseek-v4.1-flash',
        models: ['deepseek/deepseek-v4.1-flash'],
      },
    ]);
    // ① 壳还没挂上 providers_dir 的那一瞬间：读设置（真实引导序里 bootShell 第 0 步
    //    之前就有别的调用点读它）
    breakChannel();
    const early = await loadProvidersDoc();
    expect(early).toBe(false);
    expect(providersDocStatus().available).toBe(false);

    // ② 壳热重启完 / 通道就绪 → 引导跑完
    wireRpc();
    await bootstrapProvidersDoc();

    expect(providersDocStatus().available).toBe(true);
    expect(disk.get(DOC_PATH)).toContain('commandcodegoat:');
    expect(disk.get(DOC_PATH)).toContain('https://api.commandcode.ai/provider/v1');
    // 行表与密钥都还在（通道恢复后 apiKey 挂回投影）
    const rows = loadSettings().providers;
    expect(rows.map((p) => p.name)).toEqual(['commandcodegoat']);
    expect(rows[0].apiKey).toBe('sk-secret');
  });

  it('「重试路径」：通道就绪后点一下就接上（不必重启应用）——且状态里留原因可读', async () => {
    seedStored([
      {
        kind: 'openai',
        name: 'opencode',
        apiKey: '',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        model: 'deepseek-flash',
      },
    ]);
    breakChannel();
    await loadProvidersDoc();
    // 失败必须留**可读原因**（设置页把它显示出来——此前只有一句「路径不可用」）
    expect(providersDocStatus().available).toBe(false);
    expect(providersDocStatus().lastError).toContain('providers_dir');

    wireRpc();
    await retryProvidersPath();
    expect(providersDocStatus().available).toBe(true);
    expect(providersDocStatus().path).toContain('providers.yml');
    expect(providersDocStatus().lastError).toBe('');
  });

  // ⚡ 2026-09-26 同族拆弹：**空文档不算文件权威**。
  // 设计件原文 = 「磁盘上已有内容 ⇒ 文件就是权威」，而旧判据只看通道可用性
  // ⇒ 文件**还空着**时也报「权威」，投影当场返回**空行表**；此时任何一次
  // saveSettings 都会把 localStorage 里的意图剥掉 = 配置凭空消失——正是
  // 2026-09-23 用户报「之前配好的供应商也没了」的形态。
  // 此前唯一挡住它的是「迁移失败 ⇒ fatal 置位」这条巧合；而重读会把 fatal
  // 清成 undefined（`state.fatal = doc.fatal`）⇒ 巧合一破就丢配置。
  // 本用例走的就是这条链：迁移写盘失败 ⇒ fatal 置位 ⇒ 重试路径清掉 fatal，
  // 而磁盘上**依然没有内容**。
  it('迁移失败 + 重读清掉 fatal：空文件仍不得算权威（意图必须留在本机）', async () => {
    seedStored([
      {
        kind: 'openai',
        name: 'opencode',
        apiKey: '',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        model: 'deepseek-flash',
      },
    ]);
    // 通道在，但**写盘失败**（例：工作区未就绪 / 磁盘只读）⇒ 迁移失败
    mockRpc.mockImplementation(async (method, params) => {
      if (method === 'providers_dir') return 'C:/Users/u/.lantai';
      if (method === 'fs_cap') {
        const action = params.action as string;
        const path = (params.file_path ?? params.path) as string;
        if (action === 'read') throw new Error(`no such file: ${path}`);
        if (action === 'write') throw new Error('写盘失败：磁盘只读');
      }
      return 'null';
    });
    await bootstrapProvidersDoc();
    expect(providersDocStatus().available).toBe(true);
    expect(providersDocStatus().fatal).toBeTruthy(); // 迁移失败必须可见
    expect(providersDocStatus().empty).toBe(true);

    // 用户点「重试路径」（或 watcher 重读）⇒ fatal 被清成 undefined
    wireRpc();
    await retryProvidersPath();
    expect(providersDocStatus().fatal).toBeUndefined();
    expect(providersDocStatus().empty).toBe(true); // 磁盘上依然没有内容

    // 判据必须仍不成立：意图留在本机，行表走本机回落（不是空行表）
    const { saveSettings } = await import('../src/settings');
    saveSettings(loadSettings());
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { providers?: StoredRow[] };
    expect(raw.providers?.[0]?.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(raw.providers?.[0]?.model).toBe('deepseek-flash');
    expect(loadSettings().providers.map((p) => p.name)).toEqual(['opencode']);
  });

  it('通道不可用时保存设置：绝不剥掉 localStorage 里的意图副本（那是唯一来源）', async () => {
    seedStored([
      {
        kind: 'openai',
        name: 'opencode',
        apiKey: '',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        model: 'deepseek-flash',
      },
    ]);
    breakChannel();
    await bootstrapProvidersDoc();
    expect(providersDocStatus().available).toBe(false);

    // 面板此时仍可保存（不阻断用户）——但那份意图必须原样留在本机
    const { saveSettings } = await import('../src/settings');
    saveSettings(loadSettings());
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { providers?: StoredRow[] };
    expect(raw.providers?.[0]?.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(raw.providers?.[0]?.model).toBe('deepseek-flash');
  });

  it('文件权威确认可用之后：意图才离开 localStorage（只留运行态读数）', async () => {
    seedStored([
      {
        kind: 'openai',
        name: 'opencode',
        apiKey: '',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        model: 'deepseek-flash',
      },
    ]);
    await bootstrapProvidersDoc();
    expect(providersDocStatus().available).toBe(true);
    const { saveSettings } = await import('../src/settings');
    saveSettings(loadSettings());
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as { providers?: StoredRow[] };
    expect(raw.providers?.[0]).not.toHaveProperty('baseUrl');
    expect(raw.providers?.[0]?.name).toBe('opencode');
    // 文件里那份才是权威
    expect(disk.get(DOC_PATH)).toContain('baseUrl: https://opencode.ai/zen/go/v1');
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

  // ⚡ 2026-11-16 真机事故回归（agent 手改出 `input: [audio, video]`）：
  //   旧行为 = 整节从行表消失 + 之后任何一次保存把 359 行手写配置静默抹掉。
  it('坏节回落上一次可用 + 有整节读不出来时拒绝写盘（手写内容不被抹）', async () => {
    const good = [
      'commandcodegoat:',
      '  kind: openai',
      '  baseUrl: https://api.commandcode.ai/provider/v1',
      '  model: deepseek/deepseek-v4.1-flash',
      '  models: [deepseek/deepseek-v4.1-flash]',
      'opencode:',
      '  kind: openai',
      '  baseUrl: https://opencode.ai/zen/go/v1',
      '  model: deepseek-flash',
      '',
    ].join('\n');
    disk.set(DOC_PATH, good);
    await bootstrapProvidersDoc();
    expect(loadSettings().providers.map((p) => p.name)).toEqual(['commandcodegoat', 'opencode']);

    // agent 手改：给一家加了应用不认的模态（旧版本会因此整节消失）
    const brokenSection = good.replace(
      '  models: [deepseek/deepseek-v4.1-flash]',
      '  models: [deepseek/deepseek-v4.1-flash]\n  modelOverrides:\n    m:\n      input: [text, audio]',
    );
    disk.set(DOC_PATH, brokenSection);
    await loadProvidersDoc();

    // ① 字段级：节照常可用，坏字段降级并点名
    expect(providersDocStatus().errors).toEqual([]);
    expect(providersDocStatus().warnings[0].message).toContain('input');
    expect(loadSettings().providers.map((p) => p.name)).toEqual(['commandcodegoat', 'opencode']);

    // ② 真正整节读不出来（baseUrl 坏了）⇒ 行表按上一次可用顶上，不消失
    const unscannable = brokenSection.replace(
      '  baseUrl: https://api.commandcode.ai/provider/v1',
      '  baseUrl: not-a-url',
    );
    disk.set(DOC_PATH, unscannable);
    await loadProvidersDoc();
    expect(providersDocStatus().errors.map((e) => e.name)).toEqual(['commandcodegoat']);
    expect(loadSettings().providers.map((p) => p.name)).toEqual(['commandcodegoat', 'opencode']);
    // 回落的是「上一次可用」的意图（agent 最后那次好配置），不是文件里那行坏的
    expect(loadSettings().providers[0].baseUrl).toBe('https://api.commandcode.ai/provider/v1');

    // ②b 文件里**真的删掉**这一节 ⇒ 才从行表消失（删除是明确意图，不当「没读出来」）
    disk.set(
      DOC_PATH,
      'opencode:\n  kind: openai\n  baseUrl: https://opencode.ai/zen/go/v1\n  model: deepseek-flash\n',
    );
    await loadProvidersDoc();
    expect(loadSettings().providers.map((p) => p.name)).toEqual(['opencode']);
    // 复原成坏节形态，继续验证写盘纪律
    disk.set(DOC_PATH, unscannable);
    await loadProvidersDoc();

    // ③ 此时保存必须被拒（否则会把这一节当成「用户删了」写掉）
    const { saveProvidersDoc } = await import('../src/provider/providers-store');
    const res = await saveProvidersDoc({
      opencode: { kind: 'openai', baseUrl: 'https://typed.example/v1', model: 'deepseek-flash' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('commandcodegoat');
    expect(disk.get(DOC_PATH)).toBe(unscannable); // 文件一字未动
  });

  it('旧文件里的 modelMeta 是运行态读数：装载时收进本机存储，写盘即从文件消失', async () => {
    disk.set(
      DOC_PATH,
      [
        'legacy:',
        '  kind: openai',
        '  baseUrl: https://x.example/v1',
        '  model: m',
        '  modelMeta:',
        '    m:',
        '      fetchedAt: 1790132392579',
        '      contextWindow: 1000000',
        '',
      ].join('\n'),
    );
    await bootstrapProvidersDoc();
    // 行表拿得到元数据（读面不变）
    expect(loadSettings().providers[0].modelMeta?.m.contextWindow).toBe(1000000);
    // 但意图里没有它 → 一次保存就把它从文件里清出去
    const { saveProvidersDoc } = await import('../src/provider/providers-store');
    const res = await saveProvidersDoc({
      legacy: { kind: 'openai', baseUrl: 'https://x.example/v1', model: 'm' },
    });
    expect(res.ok).toBe(true);
    expect(disk.get(DOC_PATH)).not.toContain('modelMeta');
    // 清出去之后元数据仍在本机（运行态读数不随文件走）
    expect(loadSettings().providers[0].modelMeta?.m.contextWindow).toBe(1000000);
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

  // ⚡ 2026-09-26 真机报障：「设置页有时候莫名其妙丢 key」——关掉重开面板又恢复。
  // 病灶：外部手改文件 → watcher 广播 / 保存后广播 / 「重试路径」三条重读路径
  // 都用 `loadSettings()`（**永远不含 apiKey**，权威在系统凭据库）把面板的
  // providers 域**整体替换** ⇒ 内存里刚回填的 Key 被清空。Key 没真丢，是面板
  // 内存态被冲掉（所以重开就恢复）。守护：重读要换 baseUrl，但 Key 必须留。
  it('外部改文件触发面板重读：已回填的 Key 不得被清空', async () => {
    disk.set(DOC_PATH, 'commandcodegoat:\n  kind: openai\n  baseUrl: https://old.example/v1\n  model: m1\n');
    // 凭据库里有一把 Key——只有 credential_get 拿得到，loadSettings 永不带它
    mockRpc.mockImplementation(async (method, params) => {
      if (method === 'providers_dir') return 'C:/Users/u/.lantai';
      if (method === 'credential_get') return 'sk-real-key';
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
    await bootstrapProvidersDoc();

    const container = document.createElement('div');
    document.body.innerHTML = '';
    document.body.appendChild(container);
    let root: Root | null = createRoot(container);
    root.render(createElement(SettingsPanel));
    await tick();
    await tick(); // 密钥回填是异步的——等它落定

    const fieldInputs = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('.pp-field input')];
    const keyInput = (): HTMLInputElement | undefined => fieldInputs().find((i) => i.placeholder.startsWith('sk-'));
    expect(keyInput()?.value).toBe('sk-real-key');

    // 外部手改文件 → 面板重读（等价于 providers:changed 到达）
    disk.set(DOC_PATH, 'commandcodegoat:\n  kind: openai\n  baseUrl: https://outside.example/v1\n  model: m1\n');
    await loadProvidersDoc();
    await tick();

    // 重读真的发生了（baseUrl 换新）……
    expect(fieldInputs().find((i) => i.placeholder.includes('https://'))?.value).toBe('https://outside.example/v1');
    // ……而 Key 必须还在（修前恒为 ''）
    expect(keyInput()?.value).toBe('sk-real-key');

    root?.unmount();
    root = null;
  });

  // ⚡ 2026-11-21 真机排查（用户问「供应商拉的模型目录是不是只落盘了第一次」）：
  //   文件权威下运行态读数（catalog / modelMeta / lastTest）走 saveSettings 写
  //   localStorage，而 provider 行由 runtimeMap 投影——旧实现从不同步 ⇒ 保存后的值在
  //   providers:changed 广播里被换回**装载时**的旧值。真机存档就是这个形态：opencode
  //   的 catalog 停在 2026-09-23 那次拉取的 33 条，后加的行干脆没有 catalog 字段。
  //   本用例钉住「刷新目录 → 保存 → watcher 广播 → 重启」全程。
  it('刷新目录 → 保存 → providers:changed 广播：目录快照与元数据不被换回旧值', async () => {
    disk.set(DOC_PATH, 'gw:\n  kind: openai\n  baseUrl: https://gw.test/v1\n  model: a\n');
    seedStored([{ kind: 'openai', name: 'gw', baseUrl: 'https://gw.test/v1', model: 'a', catalog: ['old-1'] }]);
    await bootstrapProvidersDoc();
    expect(loadSettings().providers[0].catalog).toEqual(['old-1']);

    const { saveSettings } = await import('../src/settings');
    // 设置页「刷新目录」→ 点保存：runSavePipeline 最后一步 = saveSettings(面板 state)
    saveSettings({
      ...loadSettings(),
      providers: loadSettings().providers.map((p) => ({
        ...p,
        catalog: ['new-1', 'new-2'],
        modelMeta: { 'new-1': { fetchedAt: 2, contextWindow: 1000000 } },
      })),
    });
    // ① 同进程读数当场跟上（修前这里仍是装载时的 ['old-1']）
    expect(loadSettings().providers[0].catalog).toEqual(['new-1', 'new-2']);

    // ② watcher 广播（armProvidersWatcher 的两步）——保存写盘后 1s 内必然来一次
    await loadProvidersDoc({ reloadRuntime: true });
    saveSettings(loadSettings());

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      providers?: Array<{
        name?: string;
        catalog?: string[];
        modelMeta?: Record<string, { contextWindow?: number }>;
      }>;
    };
    expect(stored.providers?.[0]?.catalog).toEqual(['new-1', 'new-2']);
    expect(stored.providers?.[0]?.modelMeta?.['new-1']?.contextWindow).toBe(1000000);

    // ③ 「重启」：模块态清空后重新装载，看到的仍是这一次拉取的目录
    __resetProvidersDocForTests();
    installProvidersProjection(null);
    wireRpc();
    await bootstrapProvidersDoc();
    expect(loadSettings().providers[0].catalog).toEqual(['new-1', 'new-2']);
  });

  it('本次会话新增的 provider：目录快照与元数据同样过 watcher 广播而不丢', async () => {
    disk.set(DOC_PATH, 'gw:\n  kind: openai\n  baseUrl: https://gw.test/v1\n  model: a\n');
    seedStored([{ kind: 'openai', name: 'gw', baseUrl: 'https://gw.test/v1', model: 'a' }]);
    await bootstrapProvidersDoc();

    // 「添加提供方」两步式的落盘序：先写文件（intent），再 saveSettings（含运行态）
    const { saveProvidersDoc } = await import('../src/provider/providers-store');
    const { intentOf } = await import('../src/provider/providers-doc');
    const fresh = {
      kind: 'openai' as const,
      name: providerId('fresh'),
      apiKey: '',
      baseUrl: 'https://fresh.test/v1',
      model: 'f1',
      catalog: ['f1', 'f2'],
      modelMeta: { f1: { fetchedAt: 3, contextWindow: 500000 } },
    };
    const base = loadSettings();
    const patch = Object.fromEntries([...base.providers, fresh].map((p) => [p.name, intentOf(p)]));
    expect((await saveProvidersDoc(patch)).ok).toBe(true);

    const { saveSettings } = await import('../src/settings');
    saveSettings({ ...loadSettings(), providers: [...loadSettings().providers, fresh] });
    // watcher 广播：旧实现的投影里这行没有 runtimeMap 条目 ⇒ 目录/元数据被清掉
    await loadProvidersDoc({ reloadRuntime: true });
    saveSettings(loadSettings());

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      providers?: Array<{ name?: string; catalog?: string[]; modelMeta?: Record<string, unknown> }>;
    };
    const row = stored.providers?.find((p) => p.name === 'fresh');
    expect(row?.catalog).toEqual(['f1', 'f2']);
    expect(row?.modelMeta?.f1).toBeTruthy();
    expect(loadSettings().providers.find((p) => p.name === 'fresh')?.catalog).toEqual(['f1', 'f2']);
  });

  it('重读（reloadRuntime）不清内存里已回填的 Key（2026-09-26 同族守护）', async () => {
    disk.set(DOC_PATH, 'gw:\n  kind: openai\n  baseUrl: https://gw.test/v1\n  model: m1\n');
    mockRpc.mockImplementation(async (method, params) => {
      if (method === 'providers_dir') return 'C:/Users/u/.lantai';
      if (method === 'credential_get') return 'sk-real-key';
      if (method === 'fs_cap') {
        const action = params.action as string;
        const path = (params.file_path ?? params.path) as string;
        if (action === 'read') {
          const text = disk.get(path);
          if (text === undefined) throw new Error('no such file: ' + path);
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
    await bootstrapProvidersDoc();
    await loadSettingsWithSecrets(); // 装配面回填（Key 只活在本进程内存）

    await loadProvidersDoc({ reloadRuntime: true });
    expect(loadSettings().providers[0].apiKey).toBe('sk-real-key');
  });
});

describe('provider config safety regressions', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockConfigChanged.mockReset();
    disk.clear();
    localStorage.clear();
    installProvidersProjection(null);
    __resetProvidersDocForTests();
    wireRpc();
  });

  it('app write rejects an invalid ProviderIntent before touching the file', async () => {
    const good = 'a:\n  kind: openai\n  baseUrl: https://good.example/v1\n  model: m1\n';
    disk.set(DOC_PATH, good);
    seedStored([{ kind: 'openai', name: 'a', baseUrl: 'https://good.example/v1', model: 'm1' }]);
    await bootstrapProvidersDoc();
    const { saveProvidersDoc } = await import('../src/provider/providers-store');
    const res = await saveProvidersDoc({ a: { kind: 'openai', baseUrl: 'not-a-url', model: 'm1' } });
    expect(res.ok).toBe(false);
    expect(disk.get(DOC_PATH)).toBe(good);
  });

  it('fatal external YAML keeps the last-good provider projection', async () => {
    const good = 'a:\n  kind: openai\n  baseUrl: https://good.example/v1\n  model: m1\n';
    disk.set(DOC_PATH, good);
    seedStored([{ kind: 'openai', name: 'a', baseUrl: 'https://good.example/v1', model: 'm1' }]);
    await bootstrapProvidersDoc();
    const { saveSettings } = await import('../src/settings');
    saveSettings(loadSettings());
    disk.set(DOC_PATH, 'a: [unclosed\n');
    await loadProvidersDoc();
    const rows = loadSettings().providers;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('a');
    expect(rows[0]?.kind).toBe('openai');
    expect(rows[0]?.baseUrl).toBe('https://good.example/v1');
    expect(rows[0]?.model).toBe('m1');
  });

  it('fatal 跨重启：localStorage 只剩运行态壳时，从独立 intent 备份恢复完整配置', async () => {
    const good =
      'a:\n  kind: openai\n  baseUrl: https://good.example/v1\n  model: m1\n  headers:\n    x-gw: keep-me\n';
    disk.set(DOC_PATH, good);
    seedStored([{ kind: 'openai', name: 'a', baseUrl: 'https://good.example/v1', model: 'm1' }]);
    await bootstrapProvidersDoc();
    expect(localStorage.getItem(PROVIDERS_INTENT_BACKUP_KEY)).toBeTruthy();

    // 文件权威下 saveSettings 只留运行态壳：意图（baseUrl/model/headers）全部被剥掉。
    const { saveSettings } = await import('../src/settings');
    saveSettings(loadSettings());
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      providers?: Array<{ name?: string; baseUrl?: string; model?: string }>;
    };
    expect(stored.providers?.[0]?.name).toBe('a');
    expect(stored.providers?.[0]?.baseUrl).toBeUndefined();
    expect(stored.providers?.[0]?.model).toBeUndefined();

    // 模拟进程重启：内存 last-good 清空，磁盘在启动时已经是坏 YAML。
    __resetProvidersDocForTests();
    installProvidersProjection(null);
    disk.set(DOC_PATH, 'a: [unclosed\n');
    await bootstrapProvidersDoc();

    expect(providersDocStatus().fatal).toBeTruthy();
    expect(providersDocStatus().recoveredFromBackup).toBe(true);
    const row = loadSettings().providers.find((p) => p.name === 'a');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('openai');
    expect(row?.baseUrl).toBe('https://good.example/v1');
    expect(row?.model).toBe('m1');
    expect(row?.headers).toEqual({ 'x-gw': 'keep-me' });
  });

  it('fatal 跨重启之外：整节读不出来的坏节也从 intent 备份回到上一次可用', async () => {
    const good =
      'a:\n  kind: openai\n  baseUrl: https://a.example/v1\n  model: m1\n' +
      'b:\n  kind: openai\n  baseUrl: https://b.example/v1\n  model: b1\n';
    disk.set(DOC_PATH, good);
    await bootstrapProvidersDoc();
    const { saveSettings } = await import('../src/settings');
    saveSettings(loadSettings()); // 文件权威下只留运行态壳

    __resetProvidersDocForTests();
    installProvidersProjection(null);
    disk.set(DOC_PATH, good.replace('https://b.example/v1', 'not-a-url'));
    await bootstrapProvidersDoc();

    expect(providersDocStatus().errors.map((e) => e.name)).toEqual(['b']);
    expect(loadSettings().providers.map((p) => p.name)).toEqual(['a', 'b']);
    expect(loadSettings().providers.find((p) => p.name === 'b')?.baseUrl).toBe('https://b.example/v1');
  });

  it('保存时磁盘已被外部改写：直接冲突态，手稿一字不动', async () => {
    const good = 'a:\n  kind: openai\n  baseUrl: https://good.example/v1\n  model: m1\n';
    disk.set(DOC_PATH, good);
    await bootstrapProvidersDoc();
    const { intentOf } = await import('../src/provider/providers-doc');
    const row = loadSettings().providers[0];
    const external = good.replace('https://good.example/v1', 'https://external.example/v1');
    disk.set(DOC_PATH, external);

    const res = await saveProvidersDoc({
      a: { ...intentOf({ ...row, baseUrl: 'https://typed.example/v1' }) },
    });
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
    expect(res.error).toContain('外部修改');
    expect(disk.get(DOC_PATH)).toBe(external);
  });

  it('watcher 已重读但草稿起点 revision 过期：保存拒绝覆盖外部修改', async () => {
    const good = 'a:\n  kind: openai\n  baseUrl: https://good.example/v1\n  model: m1\n';
    disk.set(DOC_PATH, good);
    await bootstrapProvidersDoc();
    const baseRevision = providersDocStatus().revision;

    const external = good
      .replace('https://good.example/v1', 'https://external.example/v1')
      .replace('  model: m1', '  model: external-model');
    disk.set(DOC_PATH, external);
    await loadProvidersDoc();
    expect(providersDocStatus().revision).toBeGreaterThan(baseRevision);

    const res = await saveProvidersDoc(
      { a: { kind: 'openai', baseUrl: 'https://typed.example/v1', model: 'm1' } },
      { expectedRevision: baseRevision },
    );
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
    expect(res.error).toContain('revision');
    expect(disk.get(DOC_PATH)).toBe(external);
  });

  it('补丁没覆盖且未点名的外部有效节原样保留；pendingDeletes 才允许删除', async () => {
    disk.set(DOC_PATH, 'a:\n  kind: openai\n  baseUrl: https://a.example/v1\n  model: m1\n');
    await bootstrapProvidersDoc();

    // 外部新增 b，watcher 已重读（不是「未送达」的冲突；考的是合并时不得静默删节）。
    const withB =
      'a:\n  kind: openai\n  baseUrl: https://a.example/v1\n  model: m1\n' +
      'b:\n  kind: openai\n  baseUrl: https://b.example/v1\n  model: b1\n  headers:\n    x-hand: keep\n';
    disk.set(DOC_PATH, withB);
    await loadProvidersDoc();
    const revisionWithB = providersDocStatus().revision;

    const saved = await saveProvidersDoc(
      { a: { kind: 'openai', baseUrl: 'https://a2.example/v1', model: 'm1' } },
      { expectedRevision: revisionWithB },
    );
    expect(saved.ok).toBe(true);
    let text = disk.get(DOC_PATH) ?? '';
    expect(text).toContain('https://a2.example/v1');
    expect(text).toContain('b:');
    expect(text).toContain('x-hand: keep');

    const revisionAfterSave = providersDocStatus().revision;
    const deleted = await saveProvidersDoc(
      { a: { kind: 'openai', baseUrl: 'https://a2.example/v1', model: 'm1' } },
      { expectedRevision: revisionAfterSave, pendingDeletes: ['b'] },
    );
    expect(deleted.ok).toBe(true);
    text = disk.get(DOC_PATH) ?? '';
    expect(text).not.toContain('b:');
    expect(text).not.toContain('x-hand: keep');
  });

  it('deleting and re-adding the same name does not resurrect old runtime lastTest', async () => {
    const good = 'a:\n  kind: openai\n  baseUrl: https://good.example/v1\n  model: m1\n';
    disk.set(DOC_PATH, good);
    seedStored([{ kind: 'openai', name: 'a', baseUrl: 'https://good.example/v1', model: 'm1' }]);
    await bootstrapProvidersDoc();
    const { saveProvidersDoc } = await import('../src/provider/providers-store');
    const { intentOf } = await import('../src/provider/providers-doc');
    const { saveSettings } = await import('../src/settings');
    const probe = { status: 'ok' as const, latencyMs: 1, at: 123, message: 'ok' };
    const before = loadSettings();
    saveSettings({ ...before, providers: before.providers.map((row) => ({ ...row, lastTest: probe })) });
    await saveProvidersDoc({}, { pendingDeletes: ['a'] });
    saveSettings({ ...loadSettings(), providers: [] });
    const readded = {
      kind: 'openai' as const,
      name: providerId('a'),
      apiKey: '',
      baseUrl: 'https://good.example/v1',
      model: 'm1',
    };
    await saveProvidersDoc({ a: intentOf(readded) });
    saveSettings({ ...loadSettings(), providers: [readded] });
    expect(loadSettings().providers[0]?.lastTest).toBeUndefined();
  });
});

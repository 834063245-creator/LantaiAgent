// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 方案甲（2026-08-27，composer-provider-audit.md 第二部分）：
// 会话级创作坞覆盖——覆盖制语义（只存显式改动过的卷；未改卷实时回落全局；
// 改过卷不跟随全局；会话改动不写全局 settings）。
// 原「setModel/setThinking 落全局活跃 provider」断言是 A1/A2 错误行为的固化，
// 已随方案甲退役。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyAgentConfigChanged } from '../src/state/agent-config-store';
import { getComposeStore, resetComposeStoresForTests, resolveNewSessionDefault } from '../src/state/compose-store';

vi.mock('../src/state/agent-config-store', () => ({
  notifyAgentConfigChanged: vi.fn(),
  useAgentConfigStore: { subscribe: () => () => {}, getState: () => ({ seq: 0 }) },
}));

import * as settingsModule from '../src/settings';

const STORE = 'test-compose';

function seedSettings(overrides?: Partial<settingsModule.AppSettings>): void {
  const s: settingsModule.AppSettings = {
    activeProvider: 'deepseek' as settingsModule.ProviderId,
    providers: [
      {
        kind: 'openai',
        name: 'deepseek' as settingsModule.ProviderId,
        apiKey: '',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
      },
      {
        kind: 'anthropic',
        name: 'anthropic' as settingsModule.ProviderId,
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
      },
    ],
    projectPath: '.',
    agent: {},
    display: { language: 'zh', fontScale: 1 },
    ...overrides,
  };
  localStorage.setItem(
    'hologram_settings',
    JSON.stringify({ ...s, providers: s.providers.map((p) => ({ ...p, apiKey: '' })) }),
  );
}

describe('state/compose-store（方案甲：会话级覆盖制）', () => {
  beforeEach(() => {
    resetComposeStoresForTests();
    localStorage.clear();
    seedSettings();
    vi.mocked(notifyAgentConfigChanged).mockClear();
    vi.spyOn(settingsModule, 'saveSettings').mockImplementation(() => {});
  });

  it('未改卷：resolveEffective 实时回落全局默认，不落覆盖条目', () => {
    const st = getComposeStore(STORE).getState();
    // 未触碰的卷：无覆盖条目
    expect(st.getPrefs('1')).toBeUndefined();
    // 生效配置 = 全局活跃 provider（实时解析）
    // 思考档位不再有「默认」层（2026-11-21）：没有会话覆盖 = undefined（自动）
    expect(st.resolveEffective('1')).toEqual({
      providerName: 'deepseek',
      model: 'deepseek-v4-pro',
      thinking: undefined,
    });
    expect(st.sessions).toEqual({});
  });

  it('未改卷跟随全局：全局默认变了，生效配置实时跟着变（不冻结快照）', () => {
    seedSettings({
      activeProvider: 'anthropic' as settingsModule.ProviderId,
    });
    const st = getComposeStore(STORE).getState();
    expect(st.resolveEffective('2')).toMatchObject({ providerName: 'anthropic', model: 'claude-sonnet-4-6' });
    // 仍然无覆盖条目——跟随不是快照
    expect(st.getPrefs('2')).toBeUndefined();
  });

  it('setModel：写会话覆盖 + 信号 + 定向写「最近使用」(provider+model) 为新会话默认', () => {
    const st = getComposeStore(STORE).getState();
    // 切到与 anthropic 行当前 model 不同的模型——触发「最近使用」定向写
    st.setModel('1', 'anthropic', 'claude-opus-4-6');
    // 覆盖条目：provider/model；thinking 留 undefined = 「按目标模型解析」
    // （2026-09-23 思考下沉：不再把行值快照进会话覆盖——旧行为会把同一个档位
    //  带给之后切到的每个模型，并盖掉目标模型自己的 per-model 档位）
    expect(st.getPrefs('1')).toEqual({
      providerName: 'anthropic',
      model: 'claude-opus-4-6',
      thinking: undefined,
    });
    // 信号带 sessionId（applyAgentConfig 只热切换该会话）
    expect(notifyAgentConfigChanged).toHaveBeenCalledWith('model-switched', 1);
    // 新语义（2026-08-26「新会话默认 = 最近使用」）：定向写 activeProvider = 最近使用的
    // provider（运行态读数 → 本地存档）。
    // ⚡ 2026-11-29（题签持久化批）：目标 provider 行的 **model** 不再写本地存档——它是
    // 用户意图，权威在 `~/.lantai/providers.yml`（`saveSettings` 在文件权威就位时会把
    // 意图整段剥掉，旧写法等于白写）。无文件通道时（本测的域）走 `patchProviderIntent`
    // 的降级分支，仍落本地存档——故这里按「入参里有没有那一笔」断言，不依赖调用次数/顺序。
    const saveSpy = vi.mocked(settingsModule.saveSettings);
    expect(saveSpy).toHaveBeenCalled();
    const writes = saveSpy.mock.calls.map((c) => c[0] as settingsModule.AppSettings);
    expect(
      writes.some((w) => w.activeProvider === 'anthropic'),
      '最近使用跟随（「设为当前」退役）',
    ).toBe(true);
    const providerWrite = writes.filter(
      (w) => w.providers.find((p) => p.name === 'anthropic')?.model === 'claude-opus-4-6',
    );
    expect(providerWrite.length, '目标 provider 行的 model 写到了新会话默认').toBeGreaterThan(0);
    // A1 不复发：别家 provider 未被拖累（不是全量轰炸）；已存在会话走覆盖
    expect(providerWrite.at(-1)?.providers.find((p) => p.name === 'deepseek')?.model).toBe('deepseek-v4-pro');
  });

  it('setThinking：写会话覆盖 + 记「该模型上次用的档位」（不写 provider 行意图）', () => {
    const st = getComposeStore(STORE).getState();
    st.setThinking('1', 'high');
    expect(st.getPrefs('1')?.thinking).toBe('high');
    // 无覆盖卷改思考：以当前生效配置为底落覆盖条目（模型维度继承全局默认）
    expect(st.getPrefs('1')).toMatchObject({ providerName: 'deepseek', model: 'deepseek-v4-pro' });
    expect(notifyAgentConfigChanged).toHaveBeenCalledWith('thinking-changed', 1);
    // 记忆 = 本机读数（lastThinking），不是 provider 行上的配置字段
    const stored = JSON.parse(localStorage.getItem('hologram_settings') ?? '{}') as {
      providers?: Array<{ name?: string; thinking?: unknown; lastThinking?: Record<string, string> }>;
    };
    const row = stored.providers?.find((p) => p.name === 'deepseek');
    expect(row?.thinking).toBeUndefined();
    expect(row?.lastThinking?.['deepseek-v4-pro']).toBe('high');
    // 重开应用（重新读存档）后记忆还在
    expect(
      settingsModule.loadSettings().providers.find((p) => p.name === 'deepseek')?.lastThinking?.['deepseek-v4-pro'],
    ).toBe('high');
  });

  it('会话覆盖隔离：卷 1 改模型不影响卷 2 的生效配置（A1 核心）', () => {
    const st = getComposeStore(STORE).getState();
    st.setModel('1', 'anthropic', 'claude-sonnet-4-6');
    expect(st.resolveEffective('1')).toMatchObject({ providerName: 'anthropic' });
    expect(st.resolveEffective('2')).toMatchObject({ providerName: 'deepseek' });
    expect(st.getPrefs('2')).toBeUndefined(); // 卷 2 仍是未改卷
  });

  it('改过卷不跟随全局：全局默认变了，覆盖过的卷保持自己的值', () => {
    const st = getComposeStore(STORE).getState();
    st.setModel('1', 'anthropic', 'claude-sonnet-4-6');
    // 全局默认换向（设置页操作，不经 compose-store）
    seedSettings({
      activeProvider: 'deepseek' as settingsModule.ProviderId,
      providers: [
        {
          kind: 'openai',
          name: 'deepseek' as settingsModule.ProviderId,
          apiKey: '',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat', // 全局默认模型也换了
        },
      ],
    });
    // 改过的卷 1 保持覆盖值；未改过的卷 3 跟随新全局默认
    expect(st.resolveEffective('1')).toMatchObject({ providerName: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(st.resolveEffective('3')).toMatchObject({ providerName: 'deepseek', model: 'deepseek-chat' });
  });

  it('hydratePrefs：恢复期整条覆盖写入，不发信号', () => {
    const st = getComposeStore(STORE).getState();
    st.hydratePrefs('5', { providerName: 'glm', model: 'glm-5.2', thinking: 'high' });
    expect(st.resolveEffective('5')).toMatchObject({ providerName: 'glm', model: 'glm-5.2' });
    expect(notifyAgentConfigChanged).not.toHaveBeenCalled();
  });

  it('removePrefs / clearAll：合卷清理与工作区全量重置', () => {
    const st = getComposeStore(STORE).getState();
    st.setModel('1', 'anthropic', 'claude-sonnet-4-6');
    st.setModel('2', 'anthropic', 'claude-sonnet-4-6');
    st.removePrefs('1');
    expect(st.getPrefs('1')).toBeUndefined();
    expect(st.getPrefs('2')).toBeDefined();
    st.clearAll();
    expect(st.sessions).toEqual({});
  });

  it('settings 读失败 → resolveEffective 返回空偏好（不炸）', () => {
    localStorage.clear();
    vi.spyOn(settingsModule, 'loadSettings').mockImplementation(() => {
      throw new Error('bad settings');
    });
    const st = getComposeStore(STORE).getState();
    expect(st.resolveEffective('9')).toEqual({ providerName: '', model: '', thinking: undefined });
    vi.mocked(settingsModule.loadSettings).mockRestore();
  });

  // ⚡ 2026-11-21 思考档位收口：没有「默认档位」可落盘了——无主态拨的档位只活在
  // 本进程内存里（开下一卷时随出生默认带进去），不写 providers.yml、不写本机存档。
  it('setGlobalThinking：只记内存（不落盘），下一卷出生默认读得到', () => {
    const saveSpy = vi.mocked(settingsModule.saveSettings);
    saveSpy.mockClear();
    const st = getComposeStore(STORE).getState();
    st.setGlobalThinking('max');
    expect(saveSpy).not.toHaveBeenCalled();
    expect(resolveNewSessionDefault().thinking).toBe('max');
    // 已有卷不受影响（无覆盖的卷在“未改卷”态跟随出生默认——同一份内存值）
    expect(st.resolveEffective('1').thinking).toBe('max');
  });
});

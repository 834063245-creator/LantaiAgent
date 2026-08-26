// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 方案甲（2026-08-27，composer-provider-audit.md 第二部分）：
// 会话级创作坞覆盖——覆盖制语义（只存显式改动过的卷；未改卷实时回落全局；
// 改过卷不跟随全局；会话改动不写全局 settings）。
// 原「setModel/setThinking 落全局活跃 provider」断言是 A1/A2 错误行为的固化，
// 已随方案甲退役。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyAgentConfigChanged } from '../src/state/agent-config-store';
import { getComposeStore, resetComposeStoresForTests } from '../src/state/compose-store';

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
        thinking: 'medium',
      },
      {
        kind: 'anthropic',
        name: 'anthropic' as settingsModule.ProviderId,
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        thinking: '',
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
    expect(st.resolveEffective('1')).toEqual({
      providerName: 'deepseek',
      model: 'deepseek-v4-pro',
      thinking: 'medium',
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

  it('setModel：写会话覆盖 + 带 sessionId 的 model-switched 信号，一行不碰全局', () => {
    const before = localStorage.getItem('hologram_settings');
    const st = getComposeStore(STORE).getState();
    st.setModel('1', 'anthropic', 'claude-sonnet-4-6');
    // 覆盖条目：provider/model + thinking 跟随目标 provider 行
    expect(st.getPrefs('1')).toEqual({
      providerName: 'anthropic',
      model: 'claude-sonnet-4-6',
      thinking: '', // anthropic 行的 thinking
    });
    // 信号带 sessionId（applyAgentConfig 只热切换该会话）
    expect(notifyAgentConfigChanged).toHaveBeenCalledWith('model-switched', 1);
    // A1 根治断言：全局 settings 一字未动（localStorage 原样）
    expect(localStorage.getItem('hologram_settings')).toBe(before);
  });

  it('setThinking：写会话覆盖（A2 根治——不再写全局活跃 provider 行）', () => {
    const before = localStorage.getItem('hologram_settings');
    const st = getComposeStore(STORE).getState();
    st.setThinking('1', 'high');
    expect(st.getPrefs('1')?.thinking).toBe('high');
    // 无覆盖卷改思考：以当前生效配置为底落覆盖条目（模型维度继承全局默认）
    expect(st.getPrefs('1')).toMatchObject({ providerName: 'deepseek', model: 'deepseek-v4-pro' });
    expect(notifyAgentConfigChanged).toHaveBeenCalledWith('thinking-changed', 1);
    expect(localStorage.getItem('hologram_settings')).toBe(before);
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
          thinking: 'medium',
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
});

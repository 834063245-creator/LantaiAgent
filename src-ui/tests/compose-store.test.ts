// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Stage-4 §4.3 状态归属落地：每会话创作坞偏好（模型/思考）隔离 + 热切换写全局。

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

describe('state/compose-store（每会话创作坞状态）', () => {
  let saved: settingsModule.AppSettings | null = null;

  beforeEach(() => {
    resetComposeStoresForTests();
    localStorage.clear();
    seedSettings();
    saved = null;
    vi.mocked(notifyAgentConfigChanged).mockClear();
    vi.spyOn(settingsModule, 'saveSettings').mockImplementation((s) => {
      saved = s;
    });
  });

  it('ensurePrefs：缺失时从全局活跃 provider 惰性快照，不写盘', () => {
    const st = getComposeStore(STORE).getState();
    const prefs = st.ensurePrefs('1');
    expect(prefs).toEqual({
      providerName: 'deepseek',
      model: 'deepseek-v4-pro',
      thinking: 'medium',
    });
    // 快照已入 store，二次读同引用
    expect(getComposeStore(STORE).getState().getPrefs('1')).toBe(prefs);
    expect(saved).toBeNull(); // 不写盘
  });

  it('会话偏好隔离：两会话各持一份，切回不丢', () => {
    const st = getComposeStore(STORE).getState();
    st.ensurePrefs('1');
    st.ensurePrefs('2');
    st.setModel('1', 'anthropic', 'claude-sonnet-4-6');
    const p1 = st.getPrefs('1');
    const p2 = st.getPrefs('2');
    expect(p1?.providerName).toBe('anthropic');
    expect(p2?.providerName).toBe('deepseek'); // 会话 2 不受影响
  });

  it('setModel：写 store + 落全局（跨 provider 联动 activeProvider）+ model-switched 信号', () => {
    const st = getComposeStore(STORE).getState();
    st.setModel('1', 'anthropic', 'claude-sonnet-4-6');
    expect(st.getPrefs('1')).toMatchObject({
      providerName: 'anthropic',
      model: 'claude-sonnet-4-6',
      thinking: '', // 跟随 anthropic 的 thinking
    });
    expect(saved).not.toBeNull();
    expect(saved!.activeProvider).toBe('anthropic');
    expect(saved!.providers.find((p) => p.name === 'anthropic')!.model).toBe('claude-sonnet-4-6');
    expect(notifyAgentConfigChanged).toHaveBeenCalledWith('model-switched');
  });

  it('setThinking：写 store + 落全局活跃 provider 的 thinking + thinking-changed 信号', () => {
    const st = getComposeStore(STORE).getState();
    st.ensurePrefs('1');
    st.setThinking('1', 'high');
    expect(st.getPrefs('1')?.thinking).toBe('high');
    expect(saved!.providers.find((p) => p.name === 'deepseek')!.thinking).toBe('high');
    expect(notifyAgentConfigChanged).toHaveBeenCalledWith('thinking-changed');
  });

  it('removePrefs / clearAll：合卷清理与工作区全量重置', () => {
    const st = getComposeStore(STORE).getState();
    st.ensurePrefs('1');
    st.ensurePrefs('2');
    st.removePrefs('1');
    expect(st.getPrefs('1')).toBeUndefined();
    expect(st.getPrefs('2')).toBeDefined();
    st.clearAll();
    expect(st.sessions).toEqual({});
  });

  it('settings 读失败 → 惰性快照返回空偏好（不炸）', () => {
    localStorage.clear();
    vi.spyOn(settingsModule, 'loadSettings').mockImplementation(() => {
      throw new Error('bad settings');
    });
    const st = getComposeStore(STORE).getState();
    expect(st.ensurePrefs('9')).toEqual({ providerName: '', model: '', thinking: undefined });
    // 恢复真实实现（后续用例不受影响）
    vi.mocked(settingsModule.loadSettings).mockRestore();
  });
});

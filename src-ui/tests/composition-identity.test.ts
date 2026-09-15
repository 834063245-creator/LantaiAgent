// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S6 P1d：**组合身份**比较（替换对象引用比较）——消掉「每卷白建一份会话注册表」。
//
// 病灶（审计 F4 实测）：会话工厂用对象引用比较 `sessionComposition !== this._assemblyComposition`。
// store 里那份是 setupAgent 时点的快照，而会话解析产物来自 preset-assembly 的 cache
// ——**factory 态恒不是同一对象** ⇒ 覆盖分支恒活跃，每卷都重建一份工具注册表。
//
// 判据换轨为「解析**输入**派生」的组合身份（层内容 + 贡献代数）：
//   同身份 ⇒ 同输入 ⇒ 同一份行面 ⇒ 复用共享注册表（真零重建）；
//   身份含贡献代数 ⇒ 插件重注册/卸载后必不相等 ⇒ **不会复用陈旧注册表**（这条是
//   「先证明不会复用陈旧注册表」的判据本身）。
//
// 本文件两道：① 身份语义单测（同/异、用户层、贡献代数、空层归一）；
//            ② 真 Workspace 装配腰上的**行为**断言（数 buildToolRegistry 调用次数）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── settings / rpc / logger mock 面（workspace 装配腰最小面，同 P1a 用例）──
vi.mock('../src/settings', () => ({
  loadSettings: () => ({ display: { language: 'zh', fontScale: 1 }, agent: {}, providers: [] }),
  loadSettingsWithSecrets: async () => ({
    display: { language: 'zh', fontScale: 1 },
    agent: {},
    providers: [{ name: 'none', kind: 'openai', apiKey: '' }],
  }),
  getActiveProvider: (s: { providers?: Array<{ name: string; kind: string; apiKey?: string }> }) =>
    s?.providers?.[0] ?? { name: 'none', kind: 'openai', apiKey: '' },
  modelContextWindow: () => 8192,
  saveSettings: () => {},
  providerId: (name: string) => name,
}));
vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(async () => '{}'),
  typedJsonRpc: vi.fn(async () => ({})),
  typedListen: vi.fn(async () => () => {}),
  parseJson: (raw: unknown) => JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw ?? 'null')),
  kernelGlobalMemoryDir: async () => 'D:/mock/global-memory',
  kernelCreateDirectory: async () => '',
}));
vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bridge', () => ({ isMockMode: () => false }));

// ── 计数器：包住真 buildToolRegistry（vi.hoisted 供 mock 工厂引用）──
const counter = vi.hoisted(() => ({ builds: 0 }));
vi.mock('../src/agent/runtime/agent-builder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/runtime/agent-builder')>();
  return {
    ...actual,
    buildToolRegistry: async (opts: Parameters<typeof actual.buildToolRegistry>[0]) => {
      counter.builds++;
      return actual.buildToolRegistry(opts);
    },
  };
});

import { agentSessionState } from '../src/agent/agent-session-state';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import {
  applyDefaultPreset,
  clearUserPatch,
  compositionIdentity,
  registerUserPatch,
  userLayerIdentity,
} from '../src/composition/preset-assembly';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import { useCompositionStore } from '../src/state/composition-store';
import { usePresetStore } from '../src/state/preset-store';
import { setAgentFactory } from '../src/ui/chat-session';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'p1d-panel';

describe('S6 P1d 组合身份：语义', () => {
  beforeEach(() => {
    clearUserPatch();
    usePresetStore.setState({ selected: 'standard', error: null });
  });

  it('同输入同身份；standard 空 patch 与「无 preset 层」归一为同一份（可共用产物）', () => {
    usePresetStore.getState().select('standard');
    expect(compositionIdentity('standard')).toBe(compositionIdentity());
    // 关键：空 patch 的 preset ≠「叠了一层」——产物逐字相同，身份也相同
    expect(compositionIdentity('standard')).toBe(userLayerIdentity());
  });

  it('非空 preset 层身份不同（minimal ≠ standard）', () => {
    expect(compositionIdentity('minimal')).not.toBe(compositionIdentity('standard'));
  });

  it('用户层内容进身份（改用户层 = 不同组合）', () => {
    const before = compositionIdentity('standard');
    registerUserPatch({ tools: [{ id: 'plugin/x/y', disabled: true }] });
    expect(compositionIdentity('standard')).not.toBe(before);
    clearUserPatch();
    expect(compositionIdentity('standard')).toBe(before);
  });

  it('贡献代数进身份：插件注册/卸载后必不相等（不复用陈旧注册表的判据）', async () => {
    const root = new Context();
    const fiber = await root.plugin(compositionServicesPlugin);
    try {
      const before = compositionIdentity('standard');
      const dispose = root.tools.register({ id: 'acme/late', factory: () => [] });
      const afterRegister = compositionIdentity('standard');
      expect(afterRegister).not.toBe(before); // 新装载代——行面可能不同，必须重建
      dispose();
      expect(compositionIdentity('standard')).not.toBe(afterRegister); // 卸载也是新代
    } finally {
      await fiber.dispose();
    }
  });
});

describe('S6 P1d 组合身份：会话工厂不再白建注册表（真装配腰 + 调用计数）', () => {
  beforeEach(() => {
    agentSessionState.clearPanelState(PANEL);
    getChatStore(PANEL).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
    usePresetStore.setState({ selected: 'standard', error: null });
    clearUserPatch();
    counter.builds = 0;
  });

  it('全局默认（standard）下开新卷：身份与共享注册表相同 ⇒ 不再重建；换组合才重建', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        // boot 面：出厂态 + 补记身份（applyDefaultPreset 的空 patch 分支）
        useCompositionStore.getState().resetToFactory();
        applyDefaultPreset();
        expect(useCompositionStore.getState().resolvedKey).toBe(userLayerIdentity());

        const { Workspace } = await import('../src/workspace');
        const panel = {
          panelId: PANEL,
          setProjectPath: vi.fn(),
          setAgentFactory: (fn: unknown) => setAgentFactory(PANEL, fn as never),
          setToolSchemas: vi.fn(),
          eventSink: { emit: vi.fn() },
          execState: { subscribe: vi.fn(() => () => {}) },
          eventSinkFor: () => ({ emit: vi.fn() }),
          getSessionExecState: () => ({ subscribe: vi.fn(() => () => {}), bumpVersion: vi.fn() }),
          saveActiveSession: async () => {},
          saveCanvasState: async () => {},
        };
        const ws = await Workspace.open('D:/wsP1d', null, panel as never, {
          onStatusChange: () => {},
          onLoadingChange: () => {},
        });
        try {
          await ws.setupAgent(panel as never);
          const sharedBuilds = counter.builds; // setupAgent 建的共享注册表
          expect(sharedBuilds).toBeGreaterThan(0);

          const factory = agentSessionState.getAgentFactory(PANEL);
          expect(factory).toBeTruthy();

          // 新卷（无记录）→ 解析到的就是全局默认那一份 ⇒ 复用共享注册表，零重建
          await factory?.(1);
          expect(counter.builds).toBe(sharedBuilds); // 旧行为：每卷 +1（F4 的浪费）

          // 本卷记录 minimal（不同层）⇒ 身份不同 ⇒ 必建自己的注册表
          agentSessionState.setRecordedPresetId(PANEL, 2, 'minimal');
          await factory?.(2);
          expect(counter.builds).toBe(sharedBuilds + 1);
        } finally {
          await ws.deactivate(panel as never);
        }
      }),
    );
  }, 30_000);
});

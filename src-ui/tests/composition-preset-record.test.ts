// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// P1a（S6 per-agent 组合）：**卷内组合记录不被落盘改写**（记录闭环的落盘半边）。
//
// 用户序列：卷 A 记录 minimal → 全局默认改成 standard → 重开 A（装配面按记录重建，
// P0 已完成）→ A 再落一次盘 → 卷文件 presetId 必须仍是 minimal。
//
// 病灶（2026-09-14 探针实证 'standard' ≠ 'minimal'）：Agent 构造期 `_presetId`
// 读的是**全局默认**（agent.ts 的 currentPresetId()），而卷落盘写的是
// `agent.presetId`（chat-session.ts 两处 save）——装配面按记录走、落盘面按全局默认
// 走，两半各说各话，记录在本卷第二次落盘时静默蒸发（「重开按其重建」只在第一次
// 重开成立）。修法 = 工厂取到 raw Agent 后把记录回述给它（workspace.ts 的 P1a 块）。
//
// 装配腰：settings/rpc 走 workspace-switch-isolation 同款最小 mock 面；第一方工具
// **与 capability** 通道都要装（minimal 的 patch 同时禁用工具行与 state-hooks
// capability 行——少装一条即解析「未知行 id」回退，覆盖路径根本不发生，断言退化）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── settings mock 面 ──
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
  // live provider 构造链读它（provider/live.ts 的 providerId(name)）
  providerId: (name: string) => name,
}));

// ── RPC mock 面 ──
vi.mock('../src/rpc-contract', () => ({
  typedRpc: vi.fn(async () => '{}'),
  typedJsonRpc: vi.fn(async () => ({})),
  typedListen: vi.fn(async () => () => {}),
  parseJson: (raw: unknown) => JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw ?? 'null')),
  kernelGlobalMemoryDir: async () => 'D:/mock/global-memory',
  kernelCreateDirectory: async () => '',
  workspaceListCached: vi.fn(async () => []),
  clearWorkspaceListCache: vi.fn(),
}));

vi.mock('../src/agent/logger', () => ({
  initLogger: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bridge', () => ({ isMockMode: () => false }));

import { agentSessionState } from '../src/agent/agent-session-state';
import type { ChatCore } from '../src/app/chat/chat-core';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { effectiveComposition } from '../src/composition/preset-assembly';
import { useCompositionStore } from '../src/state/composition-store';
import { usePresetStore } from '../src/state/preset-store';
import { setAgentFactory } from '../src/ui/chat-session';
import { getChatStore } from '../src/ui/chat-store';

const PANEL = 'p1a-panel';
const ids = (rows: ReadonlyArray<{ id: string }>): string[] => rows.map((r) => r.id);

/** 测试用面板（workspace-switch-isolation 最小面 + setupAgent/工厂实际触达的方法）。
 *  `setAgentFactory` 必须真接 Session 注册表——生产里它是 ChatCore 的方法
 *  （chat-core → Session.setAgentFactory），桩成 no-op 则本用例根本拿不到工厂。 */
function makePanel(): ChatCore {
  return {
    panelId: PANEL,
    setProjectPath: vi.fn(),
    setAgentFactory: (fn: Parameters<typeof setAgentFactory>[1]) => setAgentFactory(PANEL, fn),
    eventSink: { emit: vi.fn() },
    execState: { subscribe: vi.fn(() => () => {}) },
    eventSinkFor: () => ({ emit: vi.fn() }),
    getSessionExecState: () => ({ subscribe: vi.fn(() => () => {}), bumpVersion: vi.fn() }),
    saveActiveSession: async () => {},
    saveCanvasState: async () => {},
  } as unknown as ChatCore;
}

/** 通道腰内装配一个工作区并把会话工厂交给 run（组合快照必须在腰内取——腰外
 *  factoryComposition 是空行表，装配会在 read_file 别名处炸）。 */
async function withAssembledWorkspace(
  path: string,
  run: (factory: (sid: number) => Promise<unknown>, panel: ChatCore) => Promise<void>,
): Promise<void> {
  await withFirstPartyToolChannel(() =>
    withFirstPartyCapabilityChannel(async () => {
      useCompositionStore.getState().resetToFactory(); // 腰内快照（含第一方贡献行）
      const { Workspace } = await import('../src/workspace');
      const panel = makePanel();
      const ws = await Workspace.open(path, null, panel, {
        onStatusChange: () => {},
        onLoadingChange: () => {},
      });
      try {
        await ws.setupAgent(panel);
        const factory = agentSessionState.getAgentFactory(PANEL);
        expect(factory).toBeTruthy();
        await run(factory as (sid: number) => Promise<unknown>, panel);
      } finally {
        await ws.deactivate(panel);
      }
    }),
  );
}

describe('P1a 卷内组合记录不被落盘改写（重开旧卷 → 再落盘）', () => {
  beforeEach(() => {
    agentSessionState.clearPanelState(PANEL);
    getChatStore(PANEL).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
    usePresetStore.setState({ selected: 'standard', error: null });
  });

  it('装配面按记录重建（minimal）时，Agent 镜像必须回述记录——否则再落盘改写记录', async () => {
    await withAssembledWorkspace('D:/wsP1a', async (factory) => {
      // 前置：minimal 可解析，且与工作区装配组合（全局 standard）确实不同面——
      // 保证下面的覆盖路径真的发生（否则断言退化）
      expect(usePresetStore.getState().selected).toBe('standard');
      expect(usePresetStore.getState().error).toBeNull();
      expect(ids(effectiveComposition('minimal').tools)).not.toEqual(
        ids(useCompositionStore.getState().resolved.tools),
      );

      // 卷 1 = 落盘记录 minimal 的旧卷（读盘登记，等价 chat-session 的
      // setRecordedPresetId 调用点）
      agentSessionState.setRecordedPresetId(PANEL, 1, 'minimal');

      const handle = (await factory(1)) as { _getAgent(): { presetId: string } } | null;
      expect(handle).toBeTruthy();
      const agent = handle?._getAgent();

      // 卷落盘写 presetId: agent.presetId（chat-session.ts:700/738）——
      // 它必须等于本卷记录，否则本卷再存一次就把记录改成全局默认
      expect(agent?.presetId).toBe('minimal');
    });
  }, 30_000);

  it('记录不可解析（preset 被删/改名）时仍回述记录——记录是「本卷意图」，不被失败抹掉', async () => {
    await withAssembledWorkspace('D:/wsP1a-ghost', async (factory) => {
      agentSessionState.setRecordedPresetId(PANEL, 2, 'ghost'); // 不在册

      const handle = (await factory(2)) as { _getAgent(): { presetId: string } } | null;
      expect(handle).toBeTruthy();

      // 回退面（装配）已给提示且卷照常打开；记录本身留待用户修好 preset 后重开
      expect(handle?._getAgent().presetId).toBe('ghost');
    });
  }, 30_000);
});

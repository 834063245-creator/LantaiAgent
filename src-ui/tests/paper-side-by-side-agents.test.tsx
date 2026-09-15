// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// S6 P5b：**同屏并排两 Agent**（设计件 §2 序列 B）——两个卷、各持一份组合、互不牵连。
//
// 序列 B 的断言逐条落地：
//   ① 两个 Agent 的组合面不同（两卷各按**自己的卷级记录**解析 ⇒ 工具面不同）；
//   ② 在 A 卷拨组合 ⇒ **只有 A 的（重新）装配发生**：B 的句柄对象引用不变、
//      B 的卷级记录不被触碰（写路径只处理目标卷）；
//   ③ UI 层：两枚**卷首芯片**并排，各自显示自己的组合名与来源（"两个面板各自卷头
//      显示自己的组合名"）——读面走**真 ChatCore**（非桩），即真实读面链路。
//
// 形态 = **同纸多卷**（WO-S6P5 §7 裁定 1）：本文件刻意**不碰 ChatCore 单例链**
// （多实例/多面板是另一条线，见 WO-S6P5 §1.2 的四道拦路石）——并排 = 同一画布上
// 两个流区（region），各自句柄、各自组合面。

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { layoutMock, richStatsMock } = vi.hoisted(() => ({
  layoutMock: vi.fn(() => ({ height: 36, lineCount: 2 })),
  richStatsMock: vi.fn(() => ({ lineCount: 2, maxLineWidth: 100 })),
}));
vi.mock('@chenglou/pretext', () => ({
  prepare: vi.fn((text: string) => ({ _text: text, _mock: true })),
  layout: layoutMock,
  clearCache: vi.fn(),
  prepareWithSegments: vi.fn((text: string) => ({ _text: text, _mock: true })),
  walkLineRanges: vi.fn((_prepared: unknown, _width: number, cb: (l: unknown) => void) => {
    cb({ start: 0, end: 1, width: 100 });
  }),
  materializeLineRange: vi.fn(() => ({ width: 100, text: 'mock' })),
}));
vi.mock('@chenglou/pretext/rich-inline', () => ({
  prepareRichInline: vi.fn((items: unknown[]) => ({ _items: items })),
  measureRichInlineStats: richStatsMock,
}));
const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));
vi.mock('../src/settings', () => ({
  loadSettings: () => ({ display: { language: 'zh', fontScale: 1 }, agent: {}, providers: [] }),
  getActiveProvider: () => ({ name: 'none', kind: 'openai', apiKey: '' }),
  modelContextWindow: () => 8192,
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

import { agentSessionState } from '../src/agent/agent-session-state';
import { ChatCore } from '../src/app/chat/chat-core';
import { useCoreStore } from '../src/app/chat/core-instance';
import { selectSessionPreset } from '../src/app/chat/session-composition';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { effectiveComposition } from '../src/composition/preset-assembly';
import { builtinPresets } from '../src/composition/presets';
import { FolioCompositionChip } from '../src/plugins/builtin/paper-shell/FolioCompositionChip';
import { usePresetStore } from '../src/state/preset-store';
import type { SessionContext } from '../src/ui/chat-session';
import { setAgentFactory } from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

const STORE = 'p5-side-by-side';
const SID_A = 1;
const SID_B = 2;
/** minimal 禁用面（与内置 preset 一致）——断言"两面确实不同"的具体判据。 */
const MINIMAL_DISABLED = 'plugin/hologram/browser-desktop-domain/tools';

/** 贡献通道腰（出厂两轨的解析前提：plugin 行 / capability 在册才可寻址）。 */
function withChannels<T>(fn: () => Promise<T>): Promise<T> {
  return withFirstPartyToolChannel(() => withFirstPartyCapabilityChannel(fn));
}

function makeCtx(): SessionContext {
  return {
    storeId: STORE,
    getProjectPath: () => 'D:/wsP5',
    flushReasoning: () => {},
    flushText: () => {},
    clearPendingToolCards: () => {},
    clearInputHistory: () => {},
    getTotalTokensUsed: () => 0,
    setTotalTokensUsed: () => {},
    setLastUsageText: () => {},
    updateFooter: () => {},
  } as unknown as SessionContext;
}

/** 假句柄：dispose / getSession / setSession 是重建路径（ensureSessionAgent）会碰的成员。
 *  无 `sessionLog` 能力位 ⇒ seedVolumeLog 降级（本测只盯组合面与重建归属）。 */
function makeHandle(id: string): {
  id: string;
  dispose: () => void;
  getSession: () => unknown[];
  setSession: () => void;
} {
  return { id, dispose: vi.fn(), getSession: () => [{ role: 'system', content: 'sys' }], setSession: vi.fn() };
}

/** 两卷现场：都在案头、都空白（可拨）；工厂记录每次装配的卷号。
 *  `handleA/handleB` 控制各卷是否已有句柄——**测试 ② 刻意让活跃卷 A 无句柄**
 *  （惰性水合态）：否则 `ensureSessionAgent` 会因「活跃卷已有句柄」提前返回，
 *  漏判「拨非活跃卷却顺手装配了活跃卷」这类缺陷（破测⑤a 实测：带句柄时注入
 *  摘掉活跃卷判据也照绿 ⇒ 断言没牙，故改为无句柄现场）。 */
function setupTwoVolumes(opts: { handleA?: boolean; handleB?: boolean } = {}): { builds: number[] } {
  getChatStore(STORE).sess.setState({
    sessions: [
      { id: SID_A, label: '施工卷' },
      { id: SID_B, label: '审查卷' },
    ],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: 9,
  });
  msgStoreFor(STORE, SID_A).getState().setMessages([]);
  msgStoreFor(STORE, SID_B).getState().setMessages([]);
  if (opts.handleA ?? true) agentSessionState.setAgent(STORE, SID_A, makeHandle('h-A') as never);
  if (opts.handleB ?? true) agentSessionState.setAgent(STORE, SID_B, makeHandle('h-B') as never);
  const builds: number[] = [];
  setAgentFactory(STORE, async (sessionId: number) => {
    builds.push(sessionId);
    return makeHandle(`h-${sessionId}-new`) as never;
  });
  return { builds };
}

describe('S6 P5b 同屏并排两 Agent（序列 B）', () => {
  beforeEach(() => {
    agentSessionState.clearPanelState(STORE);
    getChatStore(STORE).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
    usePresetStore.setState({ roster: builtinPresets(), selected: 'standard', error: null });
  });

  it('① 两卷各持一份组合：拨 A 只重建 A，B 的句柄引用与记录一动不动', async () => {
    await withChannels(async () => {
      const f = setupTwoVolumes();
      const ctx = makeCtx();
      const bHandleBefore = agentSessionState.getAgent(STORE, SID_B);

      // 在活跃卷 A 上拨 minimal（空白卷可拨）
      await expect(selectSessionPreset(ctx, SID_A, 'minimal')).resolves.toEqual({ ok: true });

      // 只有 A 的（重新）装配发生
      expect(f.builds).toEqual([SID_A]);
      // B 未被牵连：句柄对象引用不变、卷级记录未被触碰、消息面仍空
      expect(agentSessionState.getAgent(STORE, SID_B)).toBe(bHandleBefore);
      expect(agentSessionState.getRecordedPresetId(STORE, SID_B)).toBeNull();
      expect(msgStoreFor(STORE, SID_B).getState().messages).toHaveLength(0);

      // 两卷组合面确实不同（A = minimal 面；B = 全局默认 standard 面）
      const faceA = effectiveComposition(agentSessionState.getRecordedPresetId(STORE, SID_A) ?? undefined);
      const faceB = effectiveComposition(agentSessionState.getRecordedPresetId(STORE, SID_B) ?? undefined);
      const idsA = faceA.tools.map((t) => t.id);
      const idsB = faceB.tools.map((t) => t.id);
      expect(idsA).not.toContain(MINIMAL_DISABLED);
      expect(idsB).toContain(MINIMAL_DISABLED);
      expect(idsA).not.toEqual(idsB);
    });
  });

  it('② 拨非活跃的 B：登记生效但**不为它、也不为活跃卷**当场装配', async () => {
    await withChannels(async () => {
      // 活跃卷 A **无句柄**（惰性水合态）——这是让本断言有牙的关键现场：
      // 若写路径丢掉「只有活跃卷才当场重建」的判据，拨 B 会顺手把 A 装配起来。
      const f = setupTwoVolumes({ handleA: false, handleB: true });
      const ctx = makeCtx();

      await expect(selectSessionPreset(ctx, SID_B, 'minimal')).resolves.toEqual({ ok: true });

      expect(f.builds).toEqual([]); // 既没为 B、也没为 A 发生装配
      expect(agentSessionState.getRecordedPresetId(STORE, SID_B)).toBe('minimal'); // 登记已落
      // 纪律：先拆句柄后登记 ⇒ B 的旧句柄按纪律拆除，下次 ensureSessionAgent 按新登记装配
      expect(agentSessionState.getAgent(STORE, SID_B)).toBeNull();
      // A 完全没被碰：仍无句柄（没被顺手建起来）、无记录
      expect(agentSessionState.getAgent(STORE, SID_A)).toBeNull();
      expect(agentSessionState.getRecordedPresetId(STORE, SID_A)).toBeNull();
    });
  });

  it('③ 两枚卷首芯片并排：各自显示自己的组合名与来源（读面 = 真 ChatCore）', async () => {
    await withChannels(async () => {
      const core = new ChatCore();
      useCoreStore.setState({ core });
      const pid = core.panelId;
      getChatStore(pid).sess.setState({
        sessions: [
          { id: SID_A, label: '施工卷' },
          { id: SID_B, label: '审查卷' },
        ],
        activeIdx: 0,
        sessionTokens: {},
        nextSessionId: 9,
      });
      msgStoreFor(pid, SID_A).getState().setMessages([]);
      msgStoreFor(pid, SID_B).getState().setMessages([]);
      // 左卷有本卷记录（minimal），右卷无记录（随全局默认 standard）
      agentSessionState.setRecordedPresetId(pid, SID_A, 'minimal');

      const container = document.createElement('div');
      document.body.appendChild(container);
      let root!: Root;
      await act(async () => {
        root = createRoot(container);
        root.render(
          <>
            <div data-region="A">
              <FolioCompositionChip core={core} sessionId={String(SID_A)} />
            </div>
            <div data-region="B">
              <FolioCompositionChip core={core} sessionId={String(SID_B)} />
            </div>
          </>,
        );
      });

      const chipA = container.querySelector('[data-region="A"] .pp-folio-comp-pill');
      const chipB = container.querySelector('[data-region="B"] .pp-folio-comp-pill');
      expect(chipA?.textContent).toContain('minimal');
      expect(chipB?.textContent).toContain('standard');
      expect(chipA?.getAttribute('title')).toContain('本卷记录');
      expect(chipB?.getAttribute('title')).toContain('全局默认');
      // 两枚芯片的作用对象各自是自己的卷（并排 ≠ 共用"当前卷"）
      expect(container.querySelector('[data-region="A"] [data-folio-comp-chip]')?.getAttribute('data-session-id')).toBe(
        String(SID_A),
      );
      expect(container.querySelector('[data-region="B"] [data-folio-comp-chip]')?.getAttribute('data-session-id')).toBe(
        String(SID_B),
      );

      act(() => root.unmount());
      container.remove();
    });
  });
});

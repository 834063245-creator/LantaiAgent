// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S6 P1c：卷级组合选择（`selectSessionPreset`）——「每卷一份组合」的选择入口。
//
// 用户序列：
//   1. 新卷（无句柄）选组合 → 立刻登记，等下次装配自然生效（不白造句柄）；
//   2. 已在案头的**空白**卷选组合 → 当场重建句柄（组合面立即换、什么都不丢）；
//   3. 跑过一轮的卷 → 拒绝并说明原因（组合决定模型看到的工具/提示面 = 字节契约，
//      不能中途换；控件面按同一把尺子禁用，这里是二道闸）；
//   4. 不可解析的组合 → 拒绝 + 原因可见（沿 F1b：拒绝并说明 > 选了却静默回退）；
//   5. **卷级选择不写全局**（真源不混）：settings/preset-store.selected 一动不动。

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../src/bridge', () => ({ isMockMode: () => false }));

import { agentSessionState } from '../src/agent/agent-session-state';
import { isSessionBlank, selectSessionPreset, sessionCompositionInfo } from '../src/app/chat/session-composition';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { builtinPresets } from '../src/composition/presets';
import { usePresetStore } from '../src/state/preset-store';
import type { SessionContext } from '../src/ui/chat-session';
import { setAgentFactory } from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

const STORE = 'p1c-panel';
const SID = 1;

/** 最小 SessionContext：写路径只用 storeId/getProjectPath（ensureSessionAgent 面）。 */
function makeCtx(): SessionContext {
  return {
    storeId: STORE,
    getProjectPath: () => 'D:/wsP1c',
    flushReasoning: () => {},
    flushText: () => {},
    clearPendingToolCards: () => {},
  } as unknown as SessionContext;
}

/** 假句柄：removeAgent 只调 dispose；ensureSessionAgent 读 getSession/setSession。 */
function makeHandle(id: string): {
  id: string;
  dispose: () => void;
  getSession: () => unknown[];
  setSession: () => void;
} {
  return { id, dispose: vi.fn(), getSession: () => [{ role: 'system', content: 'sys' }], setSession: vi.fn() };
}

/** 装一个「有活跃卷」的面板态 + 工厂（返回假句柄并计数）。 */
function setupSession(opts: { withHandle?: boolean; active?: boolean } = {}): { calls: () => number } {
  getChatStore(STORE).sess.setState({
    sessions:
      opts.active === false
        ? [
            { id: 9, label: '别的卷' },
            { id: SID, label: '本卷' },
          ]
        : [{ id: SID, label: '本卷' }],
    activeIdx: 0,
    sessionTokens: {},
    nextSessionId: SID + 1,
  });
  // messages store 初始为空 = 空白卷
  msgStoreFor(STORE, SID).getState().setMessages([]);
  if (opts.withHandle) agentSessionState.setAgent(STORE, SID, makeHandle(`h-${SID}`) as never);

  let calls = 0;
  setAgentFactory(STORE, async () => {
    calls++;
    return makeHandle(`h-${SID}-new`) as never;
  });
  return { calls: () => calls };
}

const blank = (): boolean => isSessionBlank(STORE, SID);

describe('S6 P1c 卷级组合选择', () => {
  beforeEach(() => {
    agentSessionState.clearPanelState(STORE);
    msgStoreFor(STORE, SID).getState().setMessages([]);
    getChatStore(STORE).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
    usePresetStore.setState({ roster: builtinPresets(), selected: 'standard', error: null });
  });

  it('新卷（无句柄）选组合：立即登记，不白造句柄，等下次装配生效', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const f = setupSession();
        const ctx = makeCtx();

        const r = await selectSessionPreset(ctx, SID, 'minimal');

        expect(r).toEqual({ ok: true });
        expect(agentSessionState.getRecordedPresetId(STORE, SID)).toBe('minimal');
        expect(f.calls()).toBe(0); // 新卷常态：拟文/切卷时 ensureSessionAgent 才装配
        await expect(sessionCompositionInfo(STORE, SID)).resolves.toEqual({
          presetId: 'minimal',
          source: 'session',
          error: null,
        });
      }),
    );
  });

  it('空白卷已有句柄：当场拆旧重建（组合立即换、空白卷无内容可丢）', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const f = setupSession({ withHandle: true });
        const old = agentSessionState.getAgent(STORE, SID) as unknown as { dispose: () => void };
        const ctx = makeCtx();
        expect(blank()).toBe(true);

        const r = await selectSessionPreset(ctx, SID, 'minimal');

        expect(r).toEqual({ ok: true });
        expect(old.dispose).toHaveBeenCalledTimes(1); // 旧句柄拆掉
        expect(f.calls()).toBe(1); // 新句柄按新登记装配
        expect(agentSessionState.getRecordedPresetId(STORE, SID)).toBe('minimal'); // 登记在拆之后仍有效
      }),
    );
  });

  it('跑过一轮的卷被拒（二道闸）：登记不动、句柄不动、原因可读', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        setupSession({ withHandle: true });
        const ctx = makeCtx();
        // 本卷已有一轮对话内容
        msgStoreFor(STORE, SID)
          .getState()
          .setMessages([{ _id: 1, role: 'user', text: '改个 bug' } as never]);
        expect(blank()).toBe(false);

        const r = await selectSessionPreset(ctx, SID, 'minimal');

        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toContain('跑过一轮');
        expect(agentSessionState.getRecordedPresetId(STORE, SID)).toBeNull(); // 没登记
        expect(agentSessionState.getAgent(STORE, SID)).not.toBeNull(); // 句柄没被拆
      }),
    );
  });

  it('不在册的组合被拒（比 selectionError 严一档）：原因可见，登记与句柄都不动', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        setupSession({ withHandle: true });
        const ctx = makeCtx();

        const r = await selectSessionPreset(ctx, SID, 'ghost');

        expect(r.ok).toBe(false);
        // 记一条不存在的记录 = 该卷从此永远解析不出组合（每次开卷弹「不在册」）
        expect(r.ok === false && r.reason).toContain('不在册');
        expect(usePresetStore.getState().error).toContain('不在册'); // 面板可见面
        expect(agentSessionState.getRecordedPresetId(STORE, SID)).toBeNull();
        expect(agentSessionState.getAgent(STORE, SID)).not.toBeNull();
      }),
    );
  });

  it('非活跃卷：句柄拆掉但不当场重建（切回该卷时自然装配）', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const f = setupSession({ withHandle: true, active: false }); // 活跃卷 = 9
        const ctx = makeCtx();

        const r = await selectSessionPreset(ctx, SID, 'minimal');

        expect(r).toEqual({ ok: true });
        expect(f.calls()).toBe(0); // 不越界重造非活跃卷的句柄
        expect(agentSessionState.getAgent(STORE, SID)).toBeNull(); // 已拆（下次装配吃新登记）
        expect(agentSessionState.getRecordedPresetId(STORE, SID)).toBe('minimal');
      }),
    );
  });

  it('在册但行 id 不可寻址（坏 preset）也被拒：原因 = 未知行 id（与 F1b 同一把尺子）', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        setupSession();
        // 用户目录里一个「在册但不可解析」的 preset（行 id 写错——F1 捕获网的场景）
        usePresetStore.setState({
          roster: [
            ...builtinPresets(),
            { id: 'broken', builtin: false, patch: { tools: [{ id: 'plugin/nope/nothing', disabled: true }] } },
          ],
        });

        const r = await selectSessionPreset(makeCtx(), SID, 'broken');

        expect(r.ok).toBe(false);
        expect(r.ok === false && r.reason).toContain('未知行 id');
        expect(agentSessionState.getRecordedPresetId(STORE, SID)).toBeNull();
      }),
    );
  });

  it('卷级选择不写全局真源：settings 与 preset-store.selected 一动不动', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        setupSession();
        const ctx = makeCtx();

        await selectSessionPreset(ctx, SID, 'minimal');

        // 全局默认仍是 standard（本卷选了 minimal 不等于全局改了）
        expect(usePresetStore.getState().selected).toBe('standard');
        // 本卷读到的是自己的选择
        expect((await sessionCompositionInfo(STORE, SID)).presetId).toBe('minimal');
      }),
    );
  });
});

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S6 P4：程序入口（按组合起卷）——`createSessionWithPreset`。
//
// 程序/用户序列（施工单 WO-S6P4 §5，十道判断题裁定见其 §7）：
//   1. 程序指定组合起卷 → 该卷**出生即**按该组合装配（**单次装配**：工厂第一次
//      调用就读到卷级登记 ⇒ 不白装配）；
//   2. 与 UI 选同一 id → 解析面**逐字节一致**（两条路径对拍；且与全局默认不同 ⇒
//      断言有牙）；
//   3. 显式参数**落卷**：出生即卷级记录，读面（UI 芯片 / P5 卷头）零新增代码可见；
//      全局真源一动不动；
//   4. 不可解析（不在册 / requires 缺插件）→ **拒绝创建** + 具名原因，**一个卷都
//      不建**（零副作用——这是"拒绝创建"的字面语义）；
//   5. 缺省不传参 = 今天语义（全局默认，零漂移）；
//   6. 无工作区 = 失败可判（此前只能事后读 store，会把**旧活跃卷 id** 当新卷）；
//   7. 优先级链 = 显式参数 > 卷级记录 > 全局默认；
//   8. 组合面不引入未注册能力（minimal 面 ⊆ standard 面）。
//
// 工厂替身镜像 workspace 工厂的组合判据两行（`getRecordedPresetId` → line 824、
// `effectiveComposition` → line 833）——本文件断言的就是「这两行在**出生那一刻**
// 读到的是程序指定的组合」。

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
import {
  createSessionWithPreset,
  selectSessionPreset,
  sessionCompositionInfo,
} from '../src/app/chat/session-composition';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { effectiveComposition } from '../src/composition/preset-assembly';
import { builtinPresets, type PresetEntry } from '../src/composition/presets';
import type { CompositionPatch } from '../src/composition/roster';
import { usePresetStore } from '../src/state/preset-store';
import type { SessionContext } from '../src/ui/chat-session';
import { createNewSession, setAgentFactory } from '../src/ui/chat-session';
import { getChatStore, msgStoreFor } from '../src/ui/chat-store';

/** minimal preset 禁用面（`composition/presets.ts` 的内置 patch）——断言「出生即
 *  minimal 面」用的具体判据（有牙：standard 面必须有它们）。 */
const MINIMAL_DISABLED_TOOLS = [
  'plugin/hologram/browser-desktop-domain/tools',
  'plugin/hologram/web-domain/web_search',
  'plugin/hologram/web-domain/web_fetch',
];
const MINIMAL_DISABLED_CAPABILITY = 'state-hooks';

/** 一条装配记录：工厂**当时**读到的卷登记 + 它解析出的组合面。 */
interface Assembly {
  sessionId: number;
  presetId: string | null;
  toolIds: string[];
  capIds: string[];
  promptIds: string[];
}

/** 最小 SessionContext：`createNewSession` 只用 storeId/getProjectPath + 这几个
 *  UI 回调（RPC / 句柄能力位在测试里天然缺席 ⇒ 走降级分支）。 */
function makeCtx(storeId: string, projectPath = 'D:/wsP4'): SessionContext {
  return {
    storeId,
    getProjectPath: () => projectPath,
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

/** 假句柄：dispose / getSession / setSession 是 createNewSession 与
 *  ensureSessionAgent 唯二会碰的成员；无 `sessionLog` 能力位 ⇒ seedVolumeLog 降级。 */
function makeHandle(id: string): {
  id: string;
  dispose: () => void;
  getSession: () => unknown[];
  setSession: () => void;
} {
  return { id, dispose: vi.fn(), getSession: () => [{ role: 'system', content: 'sys' }], setSession: vi.fn() };
}

/** 装工厂（镜像 workspace 工厂的组合判据两行）+ 返回其调用记录。 */
function installFactory(storeId: string): { calls: Assembly[] } {
  const calls: Assembly[] = [];
  setAgentFactory(storeId, async (sessionId: number) => {
    const presetId = agentSessionState.getRecordedPresetId(storeId, sessionId); // workspace.ts:824
    const comp = effectiveComposition(presetId ?? undefined); // workspace.ts:833
    calls.push({
      sessionId,
      presetId,
      toolIds: comp.tools.map((t) => t.id),
      capIds: comp.capabilities.map((c) => c.id),
      promptIds: comp.prompt.map((s) => s.id),
    });
    return makeHandle(`h-${storeId}-${sessionId}`) as never;
  });
  return { calls };
}

function resetPanel(storeId: string): void {
  agentSessionState.clearPanelState(storeId);
  getChatStore(storeId).sess.setState({ sessions: [], activeIdx: -1, sessionTokens: {}, nextSessionId: 1 });
}

/** 组合面的**可比字节**（函数体除外：四域身份序 + seam 裁剪面 + 激活声明）
 *  ——「与 UI 同 id 逐字节一致」的对拍口径。 */
function faceBytes(presetId: string | undefined): string {
  const c = effectiveComposition(presetId);
  return JSON.stringify({
    tools: c.tools.map((t) => t.id),
    prompt: c.prompt.map((s) => s.id),
    capabilities: c.capabilities.map((x) => x.id),
    shell: c.shell.map((s) => s.id),
    seamDisabled: c.seamDisabled,
    activationDecl: c.activationDecl,
  });
}

/** 贡献通道腰（出厂两轨的解析前提：plugin 行 / capability 在册才可寻址）。 */
const withChannels = <T>(fn: () => Promise<T>): Promise<T> =>
  withFirstPartyToolChannel(() => withFirstPartyCapabilityChannel(fn));

describe('S6 P4 程序入口：按组合起卷', () => {
  beforeEach(() => {
    usePresetStore.setState({ roster: builtinPresets(), selected: 'standard', error: null });
  });

  it('① 程序指定组合起卷：该卷出生即按该组合装配（单次装配，工厂第一次调用就读到）', async () => {
    await withChannels(async () => {
      const store = 'p4-single';
      resetPanel(store);
      const f = installFactory(store);

      const r = await createSessionWithPreset(makeCtx(store), 'minimal');

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(f.calls).toHaveLength(1); // 单次装配：没有「先按全局默认装一次再拆掉」
      const seen = f.calls[0];
      expect(seen.sessionId).toBe(r.sessionId);
      expect(seen.presetId).toBe('minimal');
      for (const id of MINIMAL_DISABLED_TOOLS) expect(seen.toolIds).not.toContain(id);
      expect(seen.capIds).not.toContain(MINIMAL_DISABLED_CAPABILITY);
    });
  });

  it('② 与 UI 选同一 id：解析面逐字节一致（且与全局默认不同 = 断言有牙）', async () => {
    await withChannels(async () => {
      // 程序路径
      const storeP = 'p4-prog';
      resetPanel(storeP);
      installFactory(storeP);
      const rp = await createSessionWithPreset(makeCtx(storeP), 'minimal');
      expect(rp.ok).toBe(true);
      if (!rp.ok) return;

      // UI 路径：起卷（无参）→ 空白卷拨组合
      const storeU = 'p4-ui';
      resetPanel(storeU);
      installFactory(storeU);
      const ctxU = makeCtx(storeU);
      const sidU = await createNewSession(ctxU);
      expect(sidU).not.toBeNull();
      if (sidU === null) return;
      await expect(selectSessionPreset(ctxU, sidU, 'minimal')).resolves.toEqual({ ok: true });

      const recP = agentSessionState.getRecordedPresetId(storeP, rp.sessionId);
      const recU = agentSessionState.getRecordedPresetId(storeU, sidU);
      expect(recP).toBe('minimal');
      expect(recU).toBe('minimal');
      expect(faceBytes(recP ?? undefined)).toBe(faceBytes(recU ?? undefined));
      expect(faceBytes('minimal')).not.toBe(faceBytes('standard')); // 有牙：两面确实不同
    });
  });

  it('③ 显式参数落卷：出生即卷级记录、读面立刻可见；全局真源不动', async () => {
    await withChannels(async () => {
      const store = 'p4-record';
      resetPanel(store);
      installFactory(store);

      const r = await createSessionWithPreset(makeCtx(store), 'minimal');

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(agentSessionState.getRecordedPresetId(store, r.sessionId)).toBe('minimal');
      // 读面（UI 芯片 / P5 卷头同源）：来源是「本卷自己的选择」
      await expect(sessionCompositionInfo(store, r.sessionId)).resolves.toEqual({
        presetId: 'minimal',
        source: 'session',
        error: null,
      });
      // 真源不混：卷级选择不写全局默认
      expect(usePresetStore.getState().selected).toBe('standard');
    });
  });

  it('④ 不在册的组合 → 拒绝创建 + 具名原因，一个卷都不建（零副作用）', async () => {
    await withChannels(async () => {
      const store = 'p4-reject';
      resetPanel(store);
      const f = installFactory(store);

      const r = await createSessionWithPreset(makeCtx(store), 'ghost');

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain('不在册');
      expect(getChatStore(store).sess.getState().sessions).toHaveLength(0);
      expect(f.calls).toHaveLength(0); // 连工厂都没被调过
      expect(usePresetStore.getState().error).toContain('不在册');
    });
  });

  it('④b requires 缺插件 → 拒绝创建 + 具名「需要插件」原因', async () => {
    await withChannels(async () => {
      const broken: PresetEntry = {
        id: 'needs-plugin',
        builtin: false,
        patch: { requires: ['nope/plugin'] } as CompositionPatch,
      };
      usePresetStore.setState({ roster: [...builtinPresets(), broken], selected: 'standard', error: null });
      const store = 'p4-requires';
      resetPanel(store);
      const f = installFactory(store);

      const r = await createSessionWithPreset(makeCtx(store), 'needs-plugin');

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain('需要插件');
      expect(getChatStore(store).sess.getState().sessions).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
    });
  });

  it('⑤ 不传参 = 今天语义：全局默认（零漂移）', async () => {
    await withChannels(async () => {
      const store = 'p4-default';
      resetPanel(store);
      const f = installFactory(store);

      const r = await createSessionWithPreset(makeCtx(store));

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].presetId).toBeNull(); // 不登记 = 工厂读全局默认
      expect(agentSessionState.getRecordedPresetId(store, r.sessionId)).toBeNull();
      expect(faceBytes(undefined)).toBe(faceBytes('standard'));
    });
  });

  it('⑥ 无工作区：按失败返回（不得把旧活跃卷 id 当新卷）', async () => {
    await withChannels(async () => {
      const store = 'p4-nows';
      resetPanel(store);
      // 先摆一个「旧活跃卷」——旧实现（入口事后读 store）会把它当新卷返回
      getChatStore(store).sess.setState({
        sessions: [{ id: 7, label: '旧卷' }],
        activeIdx: 0,
        sessionTokens: {},
        nextSessionId: 8,
      });
      msgStoreFor(store, 7).getState().setMessages([]);

      const r = await createSessionWithPreset(makeCtx(store, ''), 'minimal');

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain('工作区');
      expect(getChatStore(store).sess.getState().sessions).toHaveLength(1); // 未建卷
    });
  });

  it('⑦ 优先级链：显式参数 > 全局默认（且落卷后不被全局改写）', async () => {
    await withChannels(async () => {
      usePresetStore.setState({ selected: 'minimal' }); // 全局默认 = minimal
      const store = 'p4-priority';
      resetPanel(store);
      const f = installFactory(store);

      const r = await createSessionWithPreset(makeCtx(store), 'standard'); // 显式 = standard

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(f.calls[0].presetId).toBe('standard');
      expect(f.calls[0].toolIds).toContain(MINIMAL_DISABLED_TOOLS[0]); // standard 面
      expect(agentSessionState.getRecordedPresetId(store, r.sessionId)).toBe('standard');
      expect(usePresetStore.getState().selected).toBe('minimal'); // 全局未被写
    });
  });

  it('⑧ 组合面不引入未注册能力：minimal 面 ⊆ standard 面（只裁不增）', async () => {
    await withChannels(async () => {
      const std = effectiveComposition('standard');
      const min = effectiveComposition('minimal');
      const stdTools = new Set(std.tools.map((t) => t.id));
      const stdCaps = new Set(std.capabilities.map((c) => c.id));

      expect(min.tools.every((t) => stdTools.has(t.id))).toBe(true);
      expect(min.capabilities.every((c) => stdCaps.has(c.id))).toBe(true);
      expect(min.tools.length).toBeLessThan(std.tools.length); // 确实裁掉了（非空断言）
    });
  });
});

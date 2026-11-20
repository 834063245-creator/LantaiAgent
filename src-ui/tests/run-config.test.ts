// @vitest-environment happy-dom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 「这一卷打算怎么跑」的单一解析 / 单一写入层（2026-11-29 收口批）。
//
// 本文件钉三件事：
//   ① **读的规则只有一份**：纸 = 题签 → 出生默认 → 出厂；卷 = 卷级覆盖 → 全局；
//      无主 = 出生默认。并且每笔都报**来源**（界面标「（默认）」与「全默认 = 零覆盖」都用它）；
//   ② **写的分流只有一份**：纸 → 这一卷的题签 + 下一张纸的出厂值；卷 → 会话覆盖；
//      无主 → 全局默认。三态各自落到该落的地方；
//   ③ **卷级组合不代写**（异步 + 二道闸归 core）——具名拒绝，不静默降级。
//
// 这是「题签从根上没做好」那批的结构性修复：19 次提交里 9 次修的是「这一笔到底该读谁 /
// 该写哪儿」——那些判断从现在起只存在于本层。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('../src/bridge', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  rpc: (method: string, params?: Record<string, unknown>) => mockInvoke('rpc', { method, params }),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
  watchFileDragDrop: vi.fn(async () => () => {}),
}));

import { loadSettings } from '../src/settings';
import { getComposeStore, resetComposeStoresForTests } from '../src/state/compose-store';
import { useDraftSheetStore } from '../src/state/draft-sheet-store';
import { useModeStore } from '../src/state/mode-store';
import { usePresetStore } from '../src/state/preset-store';
import { bareTarget, paperTarget, patchRunConfig, resolveRunConfig, volumeTarget } from '../src/state/run-config';

const STORAGE_KEY = 'hologram_settings';
const PANEL = 'run-config-test';

function seedSettings(): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      activeProvider: 'deepseek',
      providers: [
        {
          kind: 'openai',
          name: 'deepseek',
          apiKey: '',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
          thinking: 'low',
        },
        {
          kind: 'anthropic',
          name: 'anthropic',
          apiKey: '',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-6',
        },
      ],
    }),
  );
}

const picksOf = (id: string) => useDraftSheetStore.getState().papers.find((p) => p.id === id)?.picks ?? null;

describe('run-config · 四笔的单一解析层', () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    seedSettings();
    resetComposeStoresForTests();
    useDraftSheetStore.getState().dismissAll();
    usePresetStore.setState({ selected: 'standard', error: null });
    useModeStore.setState({
      permissionMode: 'ask',
      sheetPermission: null,
      sessionModes: {},
      pendingYolo: false,
      pendingYoloPaper: null,
    });
  });

  it('无主：四笔全是出生默认/出厂值，来源标 default', () => {
    const c = resolveRunConfig(bareTarget(PANEL));
    expect(c).toMatchObject({
      presetId: 'standard',
      providerName: 'deepseek',
      model: 'deepseek-flash',
      thinking: 'low',
      permission: 'ask',
    });
    expect(c.sources).toEqual({ preset: 'default', model: 'default', thinking: 'model', permission: 'default' });
  });

  it('纸：读的是**这张纸**的题签（不是焦点那张），来源按「与出生默认逐值不等」判', () => {
    const a = useDraftSheetStore.getState().openSheet();
    const b = useDraftSheetStore.getState().openSheet(); // 焦点在 b
    const st = useDraftSheetStore.getState();
    st.setPicks(
      { presetId: 'minimal', providerName: 'deepseek', model: 'deepseek-flash', thinking: undefined, permission: null },
      a,
    );
    st.setPicks(
      { presetId: null, providerName: 'anthropic', model: 'claude-sonnet-4-6', thinking: 'high', permission: 'yolo' },
      b,
    );

    const ca = resolveRunConfig(paperTarget(a, PANEL));
    expect(ca.presetId, 'A 自己的组合').toBe('minimal');
    expect(ca.sources.preset, '与全局默认不同 = 本卷自己定的').toBe('explicit');
    expect(ca.model, 'A 仍是出生默认的模型').toBe('deepseek-flash');
    expect(ca.sources.model, '与出生默认相等 = default').toBe('default');
    expect(ca.sources.permission).toBe('default');

    const cb = resolveRunConfig(paperTarget(b, PANEL));
    expect(cb).toMatchObject({
      providerName: 'anthropic',
      model: 'claude-sonnet-4-6',
      thinking: 'high',
      permission: 'yolo',
    });
    expect(cb.sources.model).toBe('explicit');
    expect(cb.sources.thinking).toBe('explicit');
    expect(cb.sources.permission).toBe('explicit');
  });

  it('新纸预填：模型档位来自 providers.yml 的 per-model 覆盖（用户上次拨过的档位）', () => {
    /* 用户真机形态：provider 行本身没有 thinking，只有 `modelOverrides[模型].thinking`。
     * 新纸的题签不写 thinking（= 没题），读数落到该模型的档位 ⇒ 显示上次拨过的「极限」。
     * 这条是「每次新建都要重设一遍」的去证：拨过一次之后，新纸自动预填。 */
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeProvider: 'deepseek',
        providers: [
          {
            kind: 'openai',
            name: 'deepseek',
            apiKey: '',
            baseUrl: 'https://api.deepseek.com/v1',
            model: 'deepseek-flash',
            modelOverrides: { 'deepseek-flash': { thinking: 'max' } },
          },
        ],
      }),
    );
    const id = useDraftSheetStore.getState().openSheet();
    useDraftSheetStore
      .getState()
      .setPicks(
        { presetId: null, providerName: 'deepseek', model: 'deepseek-flash', thinking: undefined, permission: null },
        id,
      );
    const c = resolveRunConfig(paperTarget(id, PANEL));
    expect(c.thinking, '档位来自模型覆盖，不是「自动」').toBe('max');
    expect(c.sources.thinking, '来源 = 该模型的档位（不是本卷显式）').toBe('model');
  });

  it('纸不在了：按无主读出（**绝不**回落焦点那张）', () => {
    const keep = useDraftSheetStore.getState().openSheet();
    useDraftSheetStore.getState().setPicks(
      {
        presetId: 'minimal',
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        thinking: undefined,
        permission: null,
      },
      keep,
    );
    const ghost = resolveRunConfig(paperTarget('dp-ghost', PANEL));
    expect(ghost.presetId).toBe('standard');
    expect(ghost.providerName).toBe('deepseek');
  });

  it('卷：卷级覆盖 ?? 全局默认（模型/思考/权限三笔各自分流）', () => {
    const compose = getComposeStore(PANEL).getState();
    compose.setModel('7', 'anthropic', 'claude-sonnet-4-6');
    compose.setThinking('7', 'high');
    useModeStore.getState().setSessionMode('7', 'auto');

    const c = resolveRunConfig(volumeTarget(7, PANEL));
    expect(c).toMatchObject({
      providerName: 'anthropic',
      model: 'claude-sonnet-4-6',
      thinking: 'high',
      permission: 'auto',
    });
    expect(c.sources).toMatchObject({ model: 'explicit', thinking: 'explicit', permission: 'explicit' });

    const other = resolveRunConfig(volumeTarget(8, PANEL));
    /* 上面 setModel 顺手把「最近使用」写成 anthropic —— 未覆盖的卷随全局默认走，
     * 这正是「跟随不是快照」的判据（旧实现把它冻结成快照就看不到这一步）。 */
    expect(other).toMatchObject({ providerName: 'anthropic', model: 'claude-sonnet-4-6', permission: 'ask' });
    expect(other.sources.model).toBe('default');
  });
});

describe('run-config · 四笔的单一写入层', () => {
  beforeEach(() => {
    localStorage.clear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(() => Promise.resolve(null));
    seedSettings();
    resetComposeStoresForTests();
    useDraftSheetStore.getState().dismissAll();
    usePresetStore.setState({ selected: 'standard', error: null });
    useModeStore.setState({
      permissionMode: 'ask',
      sheetPermission: null,
      sessionModes: {},
      pendingYolo: false,
      pendingYoloPaper: null,
    });
  });

  it('纸 · 拨模型：写这一张纸的题签 + 下一卷出生默认（思考档重解析）', () => {
    const id = useDraftSheetStore.getState().openSheet();
    useDraftSheetStore
      .getState()
      .setPicks(
        { presetId: null, providerName: 'deepseek', model: 'deepseek-flash', thinking: 'high', permission: null },
        id,
      );

    const r = patchRunConfig(paperTarget(id, PANEL), {
      model: { providerName: 'anthropic', model: 'claude-sonnet-4-6' },
    });
    expect(r.ok).toBe(true);
    expect(picksOf(id)).toMatchObject({
      providerName: 'anthropic',
      model: 'claude-sonnet-4-6',
      thinking: undefined, // 换模型 = 思考档重解析
      permission: null, // 权限那一格不因换模型而丢
    });
    const row = loadSettings().providers.find((p) => p.name === 'anthropic');
    expect(row?.model, '下一卷出生默认 = 同一笔').toBe('claude-sonnet-4-6');
  });

  it("纸 · 拨「自动」：题签里是 undefined（没题），出厂默认是显式 ''", () => {
    const id = useDraftSheetStore.getState().openSheet();
    useDraftSheetStore
      .getState()
      .setPicks(
        { presetId: null, providerName: 'deepseek', model: 'deepseek-flash', thinking: 'high', permission: null },
        id,
      );

    patchRunConfig(paperTarget(id, PANEL), { thinking: '' });
    expect(picksOf(id)?.thinking, '这一卷：自动 = 零覆盖').toBeUndefined();
    const overrides = loadSettings().providers.find((p) => p.name === 'deepseek')?.modelOverrides;
    expect(overrides?.['deepseek-flash']?.thinking, '出厂侧记显式自动').toBe('');
  });

  it('纸 · 拨权限：写题签 + 待题纸出厂值；工作区默认不许被顺手改', () => {
    const id = useDraftSheetStore.getState().openSheet();
    useDraftSheetStore
      .getState()
      .setPicks(
        { presetId: null, providerName: 'deepseek', model: 'deepseek-flash', thinking: undefined, permission: null },
        id,
      );

    patchRunConfig(paperTarget(id, PANEL), { permission: 'yolo' });
    expect(picksOf(id)?.permission).toBe('yolo');
    expect(useModeStore.getState().sheetPermission, '下一张纸的出厂值').toBe('yolo');
    expect(useModeStore.getState().permissionMode, '工作区默认没被改').toBe('ask');
    expect(loadSettings().agent.sheetPermissionMode, '出厂值要落盘').toBe('yolo');

    patchRunConfig(paperTarget(id, PANEL), { permission: null });
    expect(picksOf(id)?.permission, '跟随工作区 = 清回 null').toBeNull();
    expect(useModeStore.getState().sheetPermission).toBeNull();
  });

  it('纸 · 拨组合：题签照旧记着（纸期不做二次拒绝），不可解析时把原因带回给宿主', () => {
    const id = useDraftSheetStore.getState().openSheet();
    useDraftSheetStore
      .getState()
      .setPicks(
        { presetId: null, providerName: 'deepseek', model: 'deepseek-flash', thinking: undefined, permission: null },
        id,
      );

    /* 单元域没有装配插件通道 ⇒ `minimal` 的行 id 不可寻址（= 真机上「插件被禁用」那种
     * 情形）。语义要的正是这一条：**题签那一笔照旧记着**（预设可能先坏后修），
     * 不可解析的原因由宿主播报（不可用时 `ok:false` + reason）。 */
    const r = patchRunConfig(paperTarget(id, PANEL), { presetId: 'minimal' });
    expect(picksOf(id)?.presetId).toBe('minimal');
    if (!r.ok) expect(r.reason).toContain('不可用');
    /* 可解析的那条（真装配域）由 `paper-draft-remembers-picks.test.tsx` 钉住。 */
  });

  it('卷 · 拨模型/思考/权限：写会话覆盖（不碰工作区默认）', () => {
    patchRunConfig(volumeTarget(9, PANEL), { model: { providerName: 'anthropic', model: 'claude-sonnet-4-6' } });
    patchRunConfig(volumeTarget(9, PANEL), { thinking: 'high' });
    patchRunConfig(volumeTarget(9, PANEL), { permission: 'auto' });

    expect(getComposeStore(PANEL).getState().getPrefs('9')).toMatchObject({
      providerName: 'anthropic',
      model: 'claude-sonnet-4-6',
      thinking: 'high',
    });
    expect(useModeStore.getState().sessionModes['9']).toBe('auto');
    expect(useModeStore.getState().permissionMode).toBe('ask');
  });

  it('卷 · 拨组合：具名拒绝（卷级登记要经 core 的二道闸）', () => {
    const r = patchRunConfig(volumeTarget(9, PANEL), { presetId: 'minimal' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('selectSessionPreset');
    expect(usePresetStore.getState().selected, '被拒就不许动全局选择').toBe('standard');
  });

  it('无主 · 拨模型/思考/权限：落全局默认（新卷出生默认 + 工作区默认）', () => {
    patchRunConfig(bareTarget(PANEL), { model: { providerName: 'anthropic', model: 'claude-sonnet-4-6' } });
    patchRunConfig(bareTarget(PANEL), { thinking: 'high' });
    patchRunConfig(bareTarget(PANEL), { permission: 'auto' });

    const row = loadSettings().providers.find((p) => p.name === 'anthropic');
    expect(row?.model).toBe('claude-sonnet-4-6');
    expect(row?.modelOverrides?.['claude-sonnet-4-6']?.thinking).toBe('high');
    expect(useModeStore.getState().permissionMode).toBe('auto');
  });
});

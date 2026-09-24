// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-tools — Agent 资产块工具三件套 + executor 资产通道（WO-2 判据）。
// 协议：docs/archive/agent-asset-blocks.md §2.5/§2.6/§2.7（show_asset/update_asset/
// list_block_kinds + 报错带窗 + Asset/AssetDelta 路由）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/agent-types';

type ShowAssetModule = Awaited<ReturnType<typeof import('../src/agent/tools/show-asset')>>;
type StoreModule = Awaited<ReturnType<typeof import('../src/agent/asset-store')>>;
type KindsModule = Awaited<ReturnType<typeof import('../src/agent/asset-kinds')>>;
type ExecutorModule = Awaited<ReturnType<typeof import('../src/agent/streaming-executor')>>;
type ToolModule = Awaited<ReturnType<typeof import('../src/agent/tool')>>;
type AgentTypesModule = Awaited<ReturnType<typeof import('../src/agent/agent-types')>>;

describe('资产工具三件套 — show_asset / update_asset / list_block_kinds', () => {
  let createAssetTools: ShowAssetModule['createAssetTools'];
  let getAsset: StoreModule['getAsset'];
  let clearAssetTablesForTests: StoreModule['clearAssetTablesForTests'];
  let assetKinds: KindsModule['assetKinds'];
  let tools: ReturnType<ShowAssetModule['createAssetTools']>;
  const SCOPE = 'owner-test';

  beforeEach(async () => {
    const sa = await import('../src/agent/tools/show-asset');
    createAssetTools = sa.createAssetTools;
    const st = await import('../src/agent/asset-store');
    getAsset = st.getAsset;
    clearAssetTablesForTests = st.clearAssetTablesForTests;
    const ak = await import('../src/agent/asset-kinds');
    assetKinds = ak.assetKinds;
    tools = createAssetTools();
    clearAssetTablesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function toolByName(name: string) {
    const t = tools.find((x) => x.name() === name);
    if (!t) throw new Error('tool not found: ' + name);
    return t;
  }

  /** 带 meta 的执行包装（executor 会注入 _owner_id/_asset_id） */
  async function run(toolName: string, args: Record<string, unknown>, onProgress?: (c: string) => void) {
    return toolByName(toolName).execute({ _owner_id: SCOPE, ...args }, onProgress);
  }

  it('show_asset 正常路径：返回 AssetEventData JSON，资产表落账', async () => {
    const out = await run('show_asset', {
      kind: 'chart',
      presentation: 'chart',
      title: 'q4_revenue',
      payload: { type: 'bar', data: [1, 2, 3] },
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.assetId).toBeTypeOf('string');
    expect(parsed.kind).toBe('chart');
    expect(parsed.presentation).toBe('chart');
    expect(parsed.title).toBe('q4_revenue');
    expect(parsed.payload).toEqual({ type: 'bar', data: [1, 2, 3] });
    const rec = getAsset(SCOPE, parsed.assetId as string);
    expect(rec?.kind).toBe('chart');
    expect(rec?.payload).toEqual({ type: 'bar', data: [1, 2, 3] });
  });

  it('show_asset 未知 kind：硬报错且带可用清单（报错即导航）', async () => {
    await expect(run('show_asset', { kind: 'nope_xyz', payload: {} })).rejects.toThrow(/kind 'nope_xyz' 未注册/);
    await expect(run('show_asset', { kind: 'nope_xyz', payload: {} })).rejects.toThrow(/当前可用 kind：table/);
  });

  it('show_asset presentation 越界：报错带该 kind 白名单', async () => {
    await expect(run('show_asset', { kind: 'deps_impact', presentation: 'nope', payload: {} })).rejects.toThrow(
      /不支持表现 'nope'/,
    );
    await expect(run('show_asset', { kind: 'deps_impact', presentation: 'nope', payload: {} })).rejects.toThrow(
      /graph\s*\/\s*tree/,
    );
    await expect(run('show_asset', { kind: 'deps_impact', presentation: 'nope', payload: {} })).rejects.toThrow(
      /默认 graph/,
    );
  });

  it('show_asset 不带 presentation：回落 kind 默认表现', async () => {
    const out = await run('show_asset', { kind: 'deps_impact', payload: { nodeId: 'a' } });
    const parsed = JSON.parse(out) as { presentation: string };
    expect(parsed.presentation).toBe('graph');
  });

  it('show_asset 注入的 _asset_id 优先（executor 预生成语义）', async () => {
    const out = await run('show_asset', { kind: 'metric', payload: { items: [] }, _asset_id: 'as_injected' });
    const parsed = JSON.parse(out) as { assetId: string };
    expect(parsed.assetId).toBe('as_injected');
  });

  it('show_asset append 型 + stream + 字符串 payload：分段 onProgress（executor 路由 AssetDelta 的输入面）', async () => {
    const chunks: string[] = [];
    const payload = 'a'.repeat(200);
    const out = await run('show_asset', { kind: 'table', payload, stream: true }, (c) => chunks.push(c));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(payload);
    expect(JSON.parse(out).kind).toBe('table');
  });

  it('update_asset 缺资产：硬报错（带窗：说明当前会话资产与新建途径）', async () => {
    await expect(run('update_asset', { assetId: 'as_missing', payload: {} })).rejects.toThrow(/不存在于当前会话/);
    await expect(run('update_asset', { assetId: 'as_missing', payload: {} })).rejects.toThrow(/show_asset/);
  });

  it('update_asset 换 kind：拒绝并讲明规矩（kind 绑定语义身份）', async () => {
    // 夹具随 D1 契约收紧同步：payload 须是合法 chart 形状（原 {v:1} 是任意占位）
    const created = JSON.parse(await run('show_asset', { kind: 'chart', payload: { type: 'bar', data: [1] } })) as {
      assetId: string;
    };
    await expect(run('update_asset', { assetId: created.assetId, kind: 'table', payload: {} })).rejects.toThrow(
      /不能更换 kind/,
    );
    await expect(run('update_asset', { assetId: created.assetId, kind: 'table', payload: {} })).rejects.toThrow(
      /show_asset 新建/,
    );
    // 原记录未受损
    expect(getAsset(SCOPE, created.assetId)?.kind).toBe('chart');
  });

  it('update_asset 正常路径：payload 替换、presentation 可换（换皮肤）、kind 保留、title 保留', async () => {
    const created = JSON.parse(
      await run('show_asset', { kind: 'deps_impact', title: 'impact', payload: { nodeId: 'a' } }),
    ) as { assetId: string };
    const out = await run('update_asset', {
      assetId: created.assetId,
      presentation: 'tree',
      payload: { nodes: [{ id: 'x' }], edges: [] },
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.assetId).toBe(created.assetId);
    expect(parsed.kind).toBe('deps_impact');
    expect(parsed.presentation).toBe('tree');
    expect(parsed.payload).toEqual({ nodes: [{ id: 'x' }], edges: [] });
    // 资产表同步
    const rec = getAsset(SCOPE, created.assetId);
    expect(rec?.presentation).toBe('tree');
    expect(rec?.payload).toEqual({ nodes: [{ id: 'x' }], edges: [] });
  });

  it('update_asset presentation 越界也报带窗错误', async () => {
    // 夹具同步 D1：合法 chart 形状（原 {v:1} 是任意占位）
    const created = JSON.parse(await run('show_asset', { kind: 'chart', payload: { type: 'bar', data: [1] } })) as {
      assetId: string;
    };
    await expect(run('update_asset', { assetId: created.assetId, presentation: 'html', payload: {} })).rejects.toThrow(
      /不支持表现 'html'/,
    );
  });

  it('list_block_kinds：输出含全量 kind、presentations、default、streamable、schema', async () => {
    const out = await run('list_block_kinds', {});
    expect(out).toContain('可用资产 kind');
    expect(out).toContain('table [append]');
    expect(out).toContain('chart [atomic]');
    expect(out).toContain('deps_impact');
    expect(out).toContain('graph / tree'); // 2026-09-18：'table' 无实现已从白名单收口（曾致静默 JSON 卡）
    expect(out).toContain('默认 graph');
    expect(out).toContain('schema:');
    expect(out).toContain('update 不可换 kind');
  });

  it('注册表实时性：动态注册的新 kind 立即进校验面与发现面', async () => {
    const dispose = assetKinds.register({
      id: 'test_board',
      description: '测试看板',
      schema: { type: 'object' },
      presentations: ['board'],
      defaultPresentation: 'board',
      streamable: 'atomic',
    });
    const out = await run('show_asset', { kind: 'test_board', payload: { columns: [] } });
    expect(JSON.parse(out).kind).toBe('test_board');
    expect(await run('list_block_kinds', {})).toContain('test_board');
    dispose();
    await expect(run('show_asset', { kind: 'test_board', payload: {} })).rejects.toThrow(/未注册/);
  });
});

describe('资产回执与幂等 — 2026-09-16 真机事故回归（"怀疑就重发"链）', () => {
  let createAssetTools: ShowAssetModule['createAssetTools'];
  let getAsset: StoreModule['getAsset'];
  let listAssets: StoreModule['listAssets'];
  let clearAssetTablesForTests: StoreModule['clearAssetTablesForTests'];
  let tools: ReturnType<ShowAssetModule['createAssetTools']>;
  const SCOPE = 'owner-receipt';

  beforeEach(async () => {
    const sa = await import('../src/agent/tools/show-asset');
    createAssetTools = sa.createAssetTools;
    const st = await import('../src/agent/asset-store');
    getAsset = st.getAsset;
    listAssets = st.listAssets;
    clearAssetTablesForTests = st.clearAssetTablesForTests;
    const cr = await import('../src/agent/confirm-registry');
    cr.clearConfirmRegistryForTests();
    tools = createAssetTools();
    clearAssetTablesForTests();
  });

  function toolByName(name: string) {
    const t = tools.find((x) => x.name() === name);
    if (!t) throw new Error('tool not found: ' + name);
    return t;
  }

  async function run(toolName: string, args: Record<string, unknown>, onProgress?: (c: string) => void) {
    return toolByName(toolName).execute({ _owner_id: SCOPE, ...args }, onProgress);
  }

  const TABLE = {
    caption: '能白拿的东西',
    columns: ['项', '有吗', '在哪'],
    rows: [
      ['引擎', '有', 'Godot'],
      ['美术', '有', 'Kenney'],
      ['手感', '没有', '自己出'],
    ],
  };

  it('回执带派生读数：列/行/顶层键/字符数 + 新建标记 + 回读指路', async () => {
    const parsed = JSON.parse(await run('show_asset', { kind: 'table', title: 'inv', payload: TABLE })) as {
      receipt: { summary: string; reused: boolean; note: string };
    };
    expect(parsed.receipt.reused).toBe(false);
    expect(parsed.receipt.summary).toContain('3 列 × 3 行');
    expect(parsed.receipt.summary).toContain('顶层键 caption/columns/rows');
    expect(parsed.receipt.summary).toMatch(/\d+ 字符/);
    expect(parsed.receipt.note).toContain('list_block_kinds');
  });

  it('行宽不一：摘要点破（同一张表列数不齐是渲染事故的常见形态）', async () => {
    const parsed = JSON.parse(
      await run('show_asset', {
        kind: 'table',
        payload: { columns: ['a', 'b'], rows: [['1', '2'], ['3']] },
      }),
    ) as { receipt: { summary: string } };
    expect(parsed.receipt.summary).toContain('2 列 × 2 行（行宽不一：2/1）');
  });

  it('同 kind + title 重发（内容已改）：复用既有 assetId —— 原位替换、不新增卡片', async () => {
    const first = JSON.parse(await run('show_asset', { kind: 'table', title: 'inv', payload: TABLE })) as {
      assetId: string;
    };
    // 事故形态：模型"修"好 payload 再发一次（内容确实变了——旧实现在聊天里多一张卡）
    const second = JSON.parse(
      await run('show_asset', { kind: 'table', title: 'inv', payload: { ...TABLE, caption: '改好了' } }),
    ) as { assetId: string; receipt: { reused: boolean } };
    expect(second.assetId).toBe(first.assetId);
    expect(second.receipt.reused).toBe(true);
    expect(listAssets(SCOPE)).toHaveLength(1);
    const rec = getAsset(SCOPE, first.assetId)?.payload as { caption: string };
    expect(rec.caption).toBe('改好了');
  });

  it('无 title：按内容判等（键序无关）——同内容复用、异内容新建', async () => {
    const a = JSON.parse(
      await run('show_asset', { kind: 'metric', payload: { items: [{ label: 'x', value: 1 }] } }),
    ) as { assetId: string };
    const reordered = JSON.parse(
      await run('show_asset', { kind: 'metric', payload: { items: [{ value: 1, label: 'x' }] } }),
    ) as { assetId: string };
    expect(reordered.assetId).toBe(a.assetId);
    const b = JSON.parse(
      await run('show_asset', { kind: 'metric', payload: { items: [{ label: 'x', value: 2 }] } }),
    ) as { assetId: string };
    expect(b.assetId).not.toBe(a.assetId);
    expect(listAssets(SCOPE)).toHaveLength(2);
  });

  it('kind 不同但 title 相同：不误判为同一资产', async () => {
    const t = JSON.parse(await run('show_asset', { kind: 'table', title: 'same', payload: TABLE })) as {
      assetId: string;
    };
    const m = JSON.parse(await run('show_asset', { kind: 'metric', title: 'same', payload: { items: [] } })) as {
      assetId: string;
    };
    expect(m.assetId).not.toBe(t.assetId);
    expect(listAssets(SCOPE)).toHaveLength(2);
  });

  it('confirm 永不幂等（活回调绑在既有卡上：复用 = 第二次表决空等到超时）', async () => {
    const a = JSON.parse(await run('show_asset', { kind: 'confirm', title: 'ok', payload: { title: '继续？' } })) as {
      assetId: string;
    };
    const b = JSON.parse(await run('show_asset', { kind: 'confirm', title: 'ok', payload: { title: '继续？' } })) as {
      assetId: string;
    };
    expect(b.assetId).not.toBe(a.assetId);
  });

  it('流式暂态（append + stream + 字符串 payload）不参与幂等：delta 占位块按预生成 id 建', async () => {
    const chunks: string[] = [];
    const a = JSON.parse(
      await run('show_asset', { kind: 'table', title: 'stream', payload: 'x'.repeat(200), stream: true }, (c) =>
        chunks.push(c),
      ),
    ) as { assetId: string };
    const b = JSON.parse(
      await run('show_asset', { kind: 'table', title: 'stream', payload: 'x'.repeat(200), stream: true }, (c) =>
        chunks.push(c),
      ),
    ) as { assetId: string };
    expect(b.assetId).not.toBe(a.assetId);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('回读面：list_block_kinds 列出本会话已有资产 + 派生读数 + 回执语义', async () => {
    const t = JSON.parse(await run('show_asset', { kind: 'table', title: 'inv', payload: TABLE })) as {
      assetId: string;
    };
    const out = await run('list_block_kinds', {});
    expect(out).toContain('本会话已有资产（1 个');
    expect(out).toContain(t.assetId);
    expect(out).toContain('「inv」');
    expect(out).toContain('3 列 × 3 行');
    expect(out).toContain('回执语义');
    // 既有规则面不许丢（重发/换 skin 的规矩仍在同一段里）
    expect(out).toContain('update 不可换 kind');
  });

  it('空会话：回读面显式说"暂无"，不留空白', async () => {
    expect(await run('list_block_kinds', {})).toContain('本会话暂无资产');
  });
});

describe('工具参数 JSON 坏 — 报错带窗（§2.7 成功面对偶；事故种子回归）', () => {
  it('缺括号：报错给解析位置/尾部窗口 + 常见成因（不让模型对着裸回显误诊）', async () => {
    const ex = await import('../src/agent/streaming-executor');
    const tl = await import('../src/agent/tool');
    const sa = await import('../src/agent/tools/show-asset');
    const registry = new tl.ToolRegistry();
    for (const t of sa.createAssetTools()) registry.register(t);
    const events: AgentEvent[] = [];
    const executor = new ex.StreamingToolExecutor(registry, (ev) => events.push(ev), null, null, null, 'owner-badjson');
    // 事故原文形态：title 塞进 payload、外层少一个 }
    executor.addTool({
      id: 'badjson',
      name: 'show_asset',
      arguments: '{"kind": "table", "payload": {"rows": [[1]], "title": "x"}',
    });
    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(results[0].err).toBe('invalid JSON arguments');
    expect(results[0].output).toContain('invalid JSON arguments');
    expect(results[0].output).toContain('常见成因');
    expect(results[0].output).toContain('少/多一个');
    // 原文尾部可辨（不是只有一句"坏了"）
    expect(results[0].output).toContain('"title": "x"}');
  });

  it('invalidArgsErrorText：给窗口与修法（有解析位置时指出偏移）', async () => {
    const { invalidArgsErrorText } = await import('../src/agent/streaming-executor');
    const raw = '{"a": 1, }';
    let err: unknown = null;
    try {
      JSON.parse(raw);
    } catch (e) {
      err = e;
    }
    const text = invalidArgsErrorText(raw, err);
    expect(text).toContain('invalid JSON arguments');
    expect(text).toMatch(/偏移|尾部/);
    expect(text).toContain('常见成因');
    expect(text).toContain('…');
  });
});

describe('executor 资产通道 — assetChannel 工具的事件路由', () => {
  let StreamingToolExecutor: ExecutorModule['StreamingToolExecutor'];
  let ToolRegistry: ToolModule['ToolRegistry'];
  let createAssetTools: ShowAssetModule['createAssetTools'];
  let clearAssetTablesForTests: StoreModule['clearAssetTablesForTests'];
  let EventKind: AgentTypesModule['EventKind'];

  beforeEach(async () => {
    const ex = await import('../src/agent/streaming-executor');
    StreamingToolExecutor = ex.StreamingToolExecutor;
    const tl = await import('../src/agent/tool');
    ToolRegistry = tl.ToolRegistry;
    const sa = await import('../src/agent/tools/show-asset');
    createAssetTools = sa.createAssetTools;
    const st = await import('../src/agent/asset-store');
    clearAssetTablesForTests = st.clearAssetTablesForTests;
    const at = await import('../src/agent/agent-types');
    EventKind = at.EventKind;
    clearAssetTablesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeExecutor(events: AgentEvent[], registry: InstanceType<typeof ToolRegistry>) {
    return new StreamingToolExecutor(registry, (ev) => events.push(ev), null, null, null, 'owner-exec');
  }

  it('show_asset 全链路：ToolDispatch → AssetDelta（流）→ Asset（终值）→ ToolResult', async () => {
    const registry = new ToolRegistry();
    for (const t of createAssetTools()) registry.register(t);
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events, registry);
    // stream 型 table（append）：字符串 payload 200 字符 → 分段 delta
    const payload = 'x'.repeat(200);
    executor.addTool({
      id: 'c1',
      name: 'show_asset',
      arguments: JSON.stringify({ kind: 'table', payload, stream: true }),
    });
    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe(EventKind.ToolDispatch);
    expect(kinds).toContain(EventKind.AssetDelta);
    expect(kinds).toContain(EventKind.Asset);
    expect(kinds).toContain(EventKind.ToolResult);
    // 顺序：Asset 在 ToolResult 之前（终值先于工具卡收尾）
    const assetIdx = kinds.indexOf(EventKind.Asset);
    const resultIdx = kinds.indexOf(EventKind.ToolResult);
    expect(assetIdx).toBeGreaterThan(-1);
    expect(resultIdx).toBeGreaterThan(assetIdx);
    // Asset 终值载荷完整
    const assetEv = events.find((e) => e.kind === EventKind.Asset);
    expect(assetEv?.asset?.kind).toBe('table');
    expect(assetEv?.asset?.payload).toBe(payload);
    expect(assetEv?.asset?.assetId).toBeTypeOf('string');
    // delta 全部归一到同一个 assetId（= 终值 assetId，executor 预生成注入）
    const deltas = events.filter((e) => e.kind === EventKind.AssetDelta);
    for (const d of deltas) expect(d.assetDelta?.assetId).toBe(assetEv?.asset?.assetId);
    expect(deltas.map((d) => d.assetDelta?.chunk ?? '').join('')).toBe(payload);
  });

  it('原子型（chart）：无 delta，一次 Asset 终值', async () => {
    const registry = new ToolRegistry();
    for (const t of createAssetTools()) registry.register(t);
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events, registry);
    executor.addTool({
      id: 'c2',
      name: 'show_asset',
      arguments: JSON.stringify({ kind: 'chart', payload: { type: 'bar', data: [1] } }),
    });
    await executor.awaitRemaining();
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === EventKind.AssetDelta)).toHaveLength(0);
    const assetEv = events.find((e) => e.kind === EventKind.Asset);
    expect(assetEv?.asset?.kind).toBe('chart');
    expect(assetEv?.asset?.payload).toEqual({ type: 'bar', data: [1] });
    expect(assetEv?.asset?.presentation).toBe('chart');
  });

  it('update_asset 经 executor：原位替换 Asset 事件（kind 不变）', async () => {
    clearAssetTablesForTests();
    const registry = new ToolRegistry();
    for (const t of createAssetTools()) registry.register(t);
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events, registry);
    // 先建后更（同一 session 的两次调用）——夹具同步 D1：合法 chart 形状
    executor.addTool({
      id: 'c3',
      name: 'show_asset',
      arguments: JSON.stringify({ kind: 'chart', payload: { type: 'bar', data: [1] } }),
    });
    await executor.awaitRemaining();
    const created = events.find((e) => e.kind === EventKind.Asset)?.asset;
    expect(created?.assetId).toBeTypeOf('string');
    executor.addTool({
      id: 'c4',
      name: 'update_asset',
      arguments: JSON.stringify({ assetId: created?.assetId, payload: { type: 'bar', data: [2] } }),
    });
    await executor.awaitRemaining();
    const updated = [...events].reverse().find((e) => e.kind === EventKind.Asset);
    expect(updated?.kind).toBe(EventKind.Asset);
    expect(updated.asset?.assetId).toBe(created?.assetId);
    expect(updated.asset?.kind).toBe('chart');
    expect(updated.asset?.payload).toEqual({ type: 'bar', data: [2] });
  });

  it('非资产通道工具回归：ToolProgress 照常（Asset 事件缺席）', async () => {
    const registry = new ToolRegistry();
    const { createWaitTool } = await import('../src/plugins/builtin/wait-domain/wait');
    registry.register(createWaitTool());
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events, registry);
    executor.addTool({
      id: 'c5',
      name: 'wait',
      arguments: JSON.stringify({ durationMs: 1 }),
    });
    await executor.awaitRemaining();
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === EventKind.Asset || k === EventKind.AssetDelta)).toHaveLength(0);
    expect(kinds).toContain(EventKind.ToolResult);
  });
});

describe('资产表会话重建 — 重启/恢复后 update_asset 的 U 面续命', () => {
  let getAsset: StoreModule['getAsset'];
  let upsertAsset: StoreModule['upsertAsset'];
  let rebuildAssetsFromSession: StoreModule['rebuildAssetsFromSession'];
  let clearAssetTablesForTests: StoreModule['clearAssetTablesForTests'];
  let listAssets: StoreModule['listAssets'];

  beforeEach(async () => {
    const st = await import('../src/agent/asset-store');
    getAsset = st.getAsset;
    upsertAsset = st.upsertAsset;
    rebuildAssetsFromSession = st.rebuildAssetsFromSession;
    clearAssetTablesForTests = st.clearAssetTablesForTests;
    listAssets = st.listAssets;
    clearAssetTablesForTests();
  });

  it('从工具结果 JSONL 重建：同一 assetId 更新后者胜（会话序 = 时间序）', () => {
    rebuildAssetsFromSession('owner-r', [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '画个图' },
      {
        role: 'tool',
        content: JSON.stringify({
          assetId: 'as_a',
          kind: 'chart',
          presentation: 'chart',
          title: 'q4',
          payload: { v: 1 },
        }),
      },
      {
        role: 'tool',
        content: JSON.stringify({ assetId: 'as_a', kind: 'chart', presentation: 'chart', payload: { v: 2 } }),
      },
      { role: 'tool', content: '普通工具的文本输出（非 JSON）' },
      { role: 'tool', content: '{"assetId": "as_trunc", "kind": "chart", "payload": {"v": 1' },
    ]);
    const a = getAsset('owner-r', 'as_a');
    expect(a?.kind).toBe('chart');
    expect(a?.presentation).toBe('chart');
    expect(a?.payload).toEqual({ v: 2 }); // 更新后者胜
    // 非 JSON 输出与截断 JSON 跳过——不炸、不误入
    expect(getAsset('owner-r', 'as_trunc')).toBeUndefined();
    expect(listAssets('owner-r')).toHaveLength(1);
  });

  it('confirm 决议输出也入表（confirmResponse 字段被解析器丢弃，payload 纯数据）', () => {
    rebuildAssetsFromSession('owner-c', [
      {
        role: 'tool',
        content: JSON.stringify({
          assetId: 'as_c',
          kind: 'confirm',
          presentation: 'form',
          payload: { title: 't' },
          confirmResponse: { decision: 'approved' },
        }),
      },
    ]);
    const c = getAsset('owner-c', 'as_c') as Record<string, unknown>;
    expect(c.kind).toBe('confirm');
    expect(c.payload).toEqual({ title: 't' });
    expect('confirmResponse' in c).toBe(false);
  });

  it('整体替换语义：会话说了算——不在会话里的旧记录随 rebuild 清场', () => {
    upsertAsset('owner-r2', { assetId: 'as_stale', kind: 'chart', presentation: 'chart', payload: {}, ts: 1 });
    rebuildAssetsFromSession('owner-r2', [
      {
        role: 'tool',
        content: JSON.stringify({ assetId: 'as_live', kind: 'table', presentation: 'grid', payload: { rows: [] } }),
      },
    ]);
    expect(getAsset('owner-r2', 'as_stale')).toBeUndefined();
    expect(getAsset('owner-r2', 'as_live')).toBeDefined();
    // 空会话（newSession/清场）→ 表随会话归空
    rebuildAssetsFromSession('owner-r2', [{ role: 'system', content: 'sys' }]);
    expect(listAssets('owner-r2')).toHaveLength(0);
  });

  it('Agent._replaceSession 接线：setSession 恢复后 agent 能按旧 assetId 寻址（重启场景）', async () => {
    const { Agent } = await import('../src/agent/agent');
    const { AgentContext } = await import('../src/agent/context');
    const { ToolRegistry: TR } = await import('../src/agent/tool');
    type Provider = import('../src/provider/types').Provider;

    const provider = {
      name: () => 'mock',
      model: () => 'mock',
      stream: async function* () {
        /* 不跑流——只测会话边界 */
      },
    } as unknown as Provider;
    const ctx = new AgentContext({ agentId: 'owner-agent-r' }, {
      provider,
      tools: new TR(),
    } as Parameters<typeof AgentContext>[1]);
    const agent = new Agent(ctx, 'sys');

    // 模拟重启前的会话卷：工具结果里躺着旧资产的完整 JSON
    agent.setSession([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '画影响面' },
      {
        role: 'tool',
        content: JSON.stringify({
          assetId: 'as_reboot',
          kind: 'deps_impact',
          presentation: 'graph',
          title: 'impact',
          payload: { nodes: [{ id: 'a' }], edges: [] },
        }),
      } as never,
    ]);

    // U 面续命判据：恢复后 update_asset 能寻址（表索引已从会话重建）
    const rec = getAsset('owner-agent-r', 'as_reboot');
    expect(rec?.kind).toBe('deps_impact');
    expect(rec?.title).toBe('impact');
    // 会话清场 → 表归空（同 scope 随会话）
    agent.setSession([{ role: 'system', content: 'sys' }] as never);
    expect(getAsset('owner-agent-r', 'as_reboot')).toBeUndefined();
  });
});

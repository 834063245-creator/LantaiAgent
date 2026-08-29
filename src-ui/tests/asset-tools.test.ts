// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-tools — Agent 资产块工具三件套 + executor 资产通道（WO-2 判据）。
// 协议：docs/plans/agent-asset-blocks.md §2.5/§2.6/§2.7（show_asset/update_asset/
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
      /graph\s*\/\s*tree\s*\/\s*table/,
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
    const created = JSON.parse(await run('show_asset', { kind: 'chart', payload: { v: 1 } })) as { assetId: string };
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
    const created = JSON.parse(await run('show_asset', { kind: 'chart', payload: { v: 1 } })) as { assetId: string };
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
    expect(out).toContain('graph / tree / table');
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
    // 先建后更（同一 session 的两次调用）
    executor.addTool({
      id: 'c3',
      name: 'show_asset',
      arguments: JSON.stringify({ kind: 'chart', payload: { v: 1 } }),
    });
    await executor.awaitRemaining();
    const created = events.find((e) => e.kind === EventKind.Asset)?.asset;
    expect(created?.assetId).toBeTypeOf('string');
    executor.addTool({
      id: 'c4',
      name: 'update_asset',
      arguments: JSON.stringify({ assetId: created?.assetId, payload: { v: 2 } }),
    });
    await executor.awaitRemaining();
    const updated = [...events].reverse().find((e) => e.kind === EventKind.Asset);
    expect(updated?.kind).toBe(EventKind.Asset);
    expect(updated.asset?.assetId).toBe(created?.assetId);
    expect(updated.asset?.kind).toBe('chart');
    expect(updated.asset?.payload).toEqual({ v: 2 });
  });

  it('非资产通道工具回归：ToolProgress 照常（Asset 事件缺席）', async () => {
    const registry = new ToolRegistry();
    const { createWaitTool } = await import('../src/agent/tools/wait');
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

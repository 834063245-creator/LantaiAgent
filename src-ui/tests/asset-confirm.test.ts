// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-confirm — confirm kind 真实回调面（2026-09-06 渲染跟上批 · 项 a）判据：
//   show_asset(kind=confirm) 阻塞等用户在卡上表决——executor 执行前预发卡
//   （onResponse 活回调随事件进 BlockPart）、决议回传工具结果、无 UI 通道
//   立即 no_ui 放行、决议幂等、update 不顶掉活回调、回调不持久化。
// 协议：docs/archive/agent-asset-blocks.md §2.10 confirm kind（plan 审批模式泛化）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ConfirmCardResponse } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';

type RegistryModule = Awaited<ReturnType<typeof import('../src/agent/confirm-registry')>>;
type ShowAssetModule = Awaited<ReturnType<typeof import('../src/plugins/builtin/asset-domain/asset-tools')>>;
type StoreModule = Awaited<ReturnType<typeof import('../src/agent/asset-store')>>;
type ExecutorModule = Awaited<ReturnType<typeof import('../src/agent/streaming-executor')>>;
type ToolModule = Awaited<ReturnType<typeof import('../src/agent/tool')>>;
type MutatorModule = Awaited<ReturnType<typeof import('../src/ui/part-mutator')>>;

describe('confirm-registry — 待决议表', () => {
  let markConfirmEmitted: RegistryModule['markConfirmEmitted'];
  let resolveConfirm: RegistryModule['resolveConfirm'];
  let waitForConfirm: RegistryModule['waitForConfirm'];
  let clearConfirmRegistryForTests: RegistryModule['clearConfirmRegistryForTests'];

  beforeEach(async () => {
    const r = await import('../src/agent/confirm-registry');
    markConfirmEmitted = r.markConfirmEmitted;
    resolveConfirm = r.resolveConfirm;
    waitForConfirm = r.waitForConfirm;
    clearConfirmRegistryForTests = r.clearConfirmRegistryForTests;
    clearConfirmRegistryForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无 UI 通道（未预发卡）：立即 no_ui 放行，不空等', async () => {
    const t0 = Date.now();
    const r = await waitForConfirm('as_headless');
    expect(r).toEqual({ decision: 'no_ui' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('预发卡后决议：resolveConfirm 送达等待方', async () => {
    markConfirmEmitted('as_1');
    const waiting = waitForConfirm('as_1');
    resolveConfirm('as_1', { decision: 'approved', selectedLabel: '方案甲' });
    await expect(waiting).resolves.toEqual({ decision: 'approved', selectedLabel: '方案甲' });
  });

  it('决议幂等：二次 resolve 无操作（返回 false 不抛）', async () => {
    markConfirmEmitted('as_2');
    const waiting = waitForConfirm('as_2');
    expect(resolveConfirm('as_2', { decision: 'rejected' })).toBe(true);
    await expect(waiting).resolves.toEqual({ decision: 'rejected' });
    // 决议后补点（迟到点击）：无待决议 → false，不重复 resolve
    expect(resolveConfirm('as_2', { decision: 'approved' })).toBe(false);
    // 无此 assetId：false
    expect(resolveConfirm('as_missing', { decision: 'rejected' })).toBe(false);
  });
});

describe('show_asset(kind=confirm) — executor 全链路', () => {
  let StreamingToolExecutor: ExecutorModule['StreamingToolExecutor'];
  let ToolRegistry: ToolModule['ToolRegistry'];
  let createAssetTools: ShowAssetModule['createAssetTools'];
  let clearAssetTablesForTests: StoreModule['clearAssetTablesForTests'];
  let clearConfirmRegistryForTests: RegistryModule['clearConfirmRegistryForTests'];

  beforeEach(async () => {
    const ex = await import('../src/agent/streaming-executor');
    StreamingToolExecutor = ex.StreamingToolExecutor;
    const tl = await import('../src/agent/tool');
    ToolRegistry = tl.ToolRegistry;
    const sa = await import('../src/plugins/builtin/asset-domain/asset-tools');
    createAssetTools = sa.createAssetTools;
    const st = await import('../src/agent/asset-store');
    clearAssetTablesForTests = st.clearAssetTablesForTests;
    const r = await import('../src/agent/confirm-registry');
    clearConfirmRegistryForTests = r.clearConfirmRegistryForTests;
    clearAssetTablesForTests();
    clearConfirmRegistryForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeExecutor(events: AgentEvent[], registry: InstanceType<typeof ToolRegistry>) {
    return new StreamingToolExecutor(registry, (ev) => events.push(ev), null, null, null, 'owner-confirm');
  }

  function confirmRegistry() {
    const registry = new ToolRegistry();
    for (const t of createAssetTools()) registry.register(t);
    return registry;
  }

  it('执行前预发卡（onResponse 活回调随事件），决议作为工具结果回传', async () => {
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events, confirmRegistry());
    executor.addTool({
      id: 'c1',
      name: 'show_asset',
      arguments: JSON.stringify({
        kind: 'confirm',
        title: 'deploy_prod',
        payload: { title: '上线确认', body: '发布 v2 到生产？', confirmLabel: '发布' },
      }),
    });
    // 决议（用户点击卡面）：预发卡事件里取 onResponse 回调触发
    const pre = await vi.waitFor(() => {
      const ev = events.find((e) => e.kind === EventKind.Asset);
      expect(ev).toBeDefined();
      return ev!;
    });
    expect(pre.asset?.kind).toBe('confirm');
    expect(pre.asset?.presentation).toBe('form');
    expect(pre.asset?.title).toBe('deploy_prod');
    expect(pre.asset?.onResponse).toBeTypeOf('function');

    pre.asset!.onResponse!({ decision: 'approved' });
    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    // 决议进工具结果（模型可读）
    const out = JSON.parse(results[0].output) as { confirmResponse: ConfirmCardResponse };
    expect(out.confirmResponse).toEqual({ decision: 'approved' });
    // 事件序：ToolDispatch → Asset（预发）→ ToolResult；且 Asset 只有一次
    // （终值解析对 confirm 跳过——不顶掉活卡）
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf(EventKind.Asset)).toBeGreaterThan(kinds.indexOf(EventKind.ToolDispatch));
    expect(kinds.indexOf(EventKind.ToolResult)).toBeGreaterThan(kinds.indexOf(EventKind.Asset));
    expect(kinds.filter((k) => k === EventKind.Asset)).toHaveLength(1);
  });

  it('拒带选项决议：selectedLabel 随 approved 回传', async () => {
    const events: AgentEvent[] = [];
    const executor = makeExecutor(events, confirmRegistry());
    executor.addTool({
      id: 'c2',
      name: 'show_asset',
      arguments: JSON.stringify({
        kind: 'confirm',
        payload: {
          title: '选型',
          options: [
            { label: '方案甲', description: '快' },
            { label: '方案乙', description: '稳' },
          ],
        },
      }),
    });
    const pre = await vi.waitFor(() => events.find((e) => e.kind === EventKind.Asset)!);
    pre.asset!.onResponse!({ decision: 'approved', selectedLabel: '方案乙' });
    const results = await executor.awaitRemaining();
    const out = JSON.parse(results[0].output) as { confirmResponse: ConfirmCardResponse };
    expect(out.confirmResponse).toEqual({ decision: 'approved', selectedLabel: '方案乙' });
  });

  it('无 UI 通道（直调工具——嵌套/headless 等价）：立即 no_ui 放行', async () => {
    const tool = createAssetTools().find((t) => t.name() === 'show_asset')!;
    const out = await tool.execute({ _owner_id: 'o', kind: 'confirm', payload: { title: 't' } });
    const parsed = JSON.parse(out) as { confirmResponse: ConfirmCardResponse };
    expect(parsed.confirmResponse).toEqual({ decision: 'no_ui' });
  });
});

describe('part-mutator — confirm 回调挂接与存续', () => {
  let applyEventToParts: MutatorModule['applyEventToParts'];
  let applyAssetUpdateToExistingParts: MutatorModule['applyAssetUpdateToExistingParts'];
  let clearConfirmRegistryForTests: RegistryModule['clearConfirmRegistryForTests'];

  beforeEach(async () => {
    const m = await import('../src/ui/part-mutator');
    applyEventToParts = m.applyEventToParts;
    applyAssetUpdateToExistingParts = m.applyAssetUpdateToExistingParts;
    const r = await import('../src/agent/confirm-registry');
    clearConfirmRegistryForTests = r.clearConfirmRegistryForTests;
    clearConfirmRegistryForTests();
  });

  it('带 onResponse 的 Asset 事件 → BlockPart 挂活回调', () => {
    const parts: import('../src/ui/message-model').AssistantPart[] = [];
    const cb = (r: ConfirmCardResponse): void => void r;
    const applied = applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: {
        assetId: 'as_c1',
        kind: 'confirm',
        presentation: 'form',
        payload: { title: 't' },
        onResponse: cb,
      },
    });
    expect(applied).toBe(true);
    const bp = parts[0] as import('../src/ui/message-model').BlockPart;
    expect(bp.type).toBe('block');
    expect(bp._confirmCallback).toBe(cb);
  });

  it('update 广播不顶掉活回调（待决议卡按钮不猝死）', () => {
    const cb = (r: ConfirmCardResponse): void => void r;
    const parts: import('../src/ui/message-model').AssistantPart[] = [
      {
        type: 'block',
        assetId: 'as_c2',
        kind: 'confirm',
        presentation: 'form',
        payload: { title: '旧' },
        finalised: true,
        _confirmCallback: cb,
      },
    ];
    const changed = applyAssetUpdateToExistingParts(parts, {
      assetId: 'as_c2',
      kind: 'confirm',
      presentation: 'form',
      payload: { title: '新' },
    });
    expect(changed).toBe(true);
    const bp = parts[0] as import('../src/ui/message-model').BlockPart;
    expect(bp.payload).toEqual({ title: '新' });
    expect(bp._confirmCallback).toBe(cb);
  });

  it('决议终态持久化契约：_confirmCallback 序列化丢弃、confirmResolution 保留', () => {
    const bp: import('../src/ui/message-model').BlockPart = {
      type: 'block',
      assetId: 'as_c3',
      kind: 'confirm',
      presentation: 'form',
      payload: { title: 't' },
      finalised: true,
      _confirmCallback: () => {},
      confirmResolution: { decision: 'approved', selectedLabel: '甲' },
    };
    const round = JSON.parse(JSON.stringify(bp)) as typeof bp;
    expect(round._confirmCallback).toBeUndefined();
    expect(round.confirmResolution).toEqual({ decision: 'approved', selectedLabel: '甲' });
  });
});

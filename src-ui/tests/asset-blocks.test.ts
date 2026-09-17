// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-blocks — Agent 资产块协议 WO-1 判据：
//   asset 事件建 part / delta 追加 / 终值替换 / finalised 翻转 / 防御性忽略。
// 协议：docs/archive/agent-asset-blocks.md §2.2/§2.3（BlockPart + Asset/AssetDelta）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PartMutatorModule = Awaited<ReturnType<typeof import('../src/ui/part-mutator')>>;
type MessageModelModule = Awaited<ReturnType<typeof import('../src/ui/message-model')>>;
type AgentTypesModule = Awaited<ReturnType<typeof import('../src/agent/agent-types')>>;

describe('part-mutator — 资产块 Asset/AssetDelta 事件', () => {
  let applyEventToParts: PartMutatorModule['applyEventToParts'];
  let findBlockPart: MessageModelModule['findBlockPart'];
  let AssistantPart: MessageModelModule['AssistantPart'];
  let EventKind: AgentTypesModule['EventKind'];

  beforeEach(async () => {
    const pm = await import('../src/ui/part-mutator');
    applyEventToParts = pm.applyEventToParts;
    const mm = await import('../src/ui/message-model');
    findBlockPart = mm.findBlockPart;
    AssistantPart = mm.AssistantPart;
    const at = await import('../src/agent/agent-types');
    EventKind = at.EventKind;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Asset 终值建 part：finalised、payload、presentation、title 落位', () => {
    const parts: (typeof AssistantPart)[] = [];
    const mutated = applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: {
        assetId: 'as_abc123',
        kind: 'deps_impact',
        presentation: 'graph',
        title: '改 A 影响面',
        payload: { nodes: [{ id: 'a' }], edges: [] },
      },
    });
    expect(mutated).toBe(true);
    expect(parts).toHaveLength(1);
    const bp = parts[0];
    expect(bp.type).toBe('block');
    if (bp.type !== 'block') return;
    expect(bp.assetId).toBe('as_abc123');
    expect(bp.kind).toBe('deps_impact');
    expect(bp.presentation).toBe('graph');
    expect(bp.title).toBe('改 A 影响面');
    expect(bp.payload).toEqual({ nodes: [{ id: 'a' }], edges: [] });
    expect(bp.finalised).toBe(true);
  });

  it('Asset 终值缺省 presentation → 空串（渲染层回落 default 的输入形态）', () => {
    const parts: (typeof AssistantPart)[] = [];
    applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_x', kind: 'table', payload: { rows: [] } },
    });
    const bp = parts[0];
    expect(bp.type).toBe('block');
    if (bp.type === 'block') expect(bp.presentation).toBe('');
  });

  it('AssetDelta 先于终值：建未 finalised 占位并连续追加', () => {
    const parts: (typeof AssistantPart)[] = [];
    applyEventToParts(parts, {
      kind: EventKind.AssetDelta,
      assetDelta: { assetId: 'as_t', kind: 'table', chunk: 'row1' },
    });
    applyEventToParts(parts, {
      kind: EventKind.AssetDelta,
      assetDelta: { assetId: 'as_t', kind: 'table', chunk: '\nrow2' },
    });
    expect(parts).toHaveLength(1);
    const bp = parts[0];
    expect(bp.type).toBe('block');
    if (bp.type !== 'block') return;
    expect(bp.assetId).toBe('as_t');
    expect(bp.kind).toBe('table');
    expect(bp.presentation).toBe('');
    expect(bp.payload).toBe('row1\nrow2');
    expect(bp.finalised).toBe(false);
  });

  it('终值替换占位：payload 整体替换、finalised 翻转、不重复 push、同 assetId 更新', () => {
    const parts: (typeof AssistantPart)[] = [];
    applyEventToParts(parts, {
      kind: EventKind.AssetDelta,
      assetDelta: { assetId: 'as_t', kind: 'table', chunk: 'partial' },
    });
    applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: {
        assetId: 'as_t',
        kind: 'table',
        presentation: 'grid',
        payload: { columns: ['a'], rows: [['1']] },
      },
    });
    expect(parts).toHaveLength(1);
    const bp = parts[0];
    expect(bp.type).toBe('block');
    if (bp.type !== 'block') return;
    expect(bp.payload).toEqual({ columns: ['a'], rows: [['1']] });
    expect(bp.presentation).toBe('grid');
    expect(bp.finalised).toBe(true);
  });

  it('update_asset 语义：同 assetId 终值再到达 → 原位替换（part 索引不变）', () => {
    const parts: (typeof AssistantPart)[] = [];
    // 建立两个资产，更新第一个——顺序与索引保持
    applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_1', kind: 'chart', payload: { v: 1 } },
    });
    applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_2', kind: 'chart', payload: { v: 2 } },
    });
    applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_1', kind: 'chart', presentation: 'chart', payload: { v: 10 } },
    });
    expect(parts).toHaveLength(2);
    const p0 = parts[0];
    expect(p0.type).toBe('block');
    if (p0.type === 'block') {
      expect(p0.assetId).toBe('as_1');
      expect(p0.payload).toEqual({ v: 10 });
    }
    expect(parts[1]).toBeTypeOf('object');
  });

  it('finalised 后到达的 delta 防御性忽略（不追加、报无变更）', () => {
    const parts: (typeof AssistantPart)[] = [];
    applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_f', kind: 'table', payload: { rows: [] } },
    });
    const mutated = applyEventToParts(parts, {
      kind: EventKind.AssetDelta,
      assetDelta: { assetId: 'as_f', kind: 'table', chunk: 'late' },
    });
    expect(mutated).toBe(false);
    const bp = parts[0];
    expect(bp.type).toBe('block');
    if (bp.type === 'block') expect(bp.payload).toEqual({ rows: [] });
  });

  it('findBlockPart 按 assetId 命中（从后往前）', () => {
    const parts: (typeof AssistantPart)[] = [];
    applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_1', kind: 'chart', payload: { v: 1 } },
    });
    applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: { assetId: 'as_2', kind: 'chart', payload: { v: 2 } },
    });
    const bp = findBlockPart(parts, 'as_1');
    expect(bp?.assetId).toBe('as_1');
    expect(bp?.payload).toEqual({ v: 1 });
    expect(findBlockPart(parts, 'nope')).toBeUndefined();
  });

  it('事件缺载荷时为无变更（AgentEvent 携带空 asset 字段不炸）', () => {
    const parts: (typeof AssistantPart)[] = [];
    const mutated = applyEventToParts(parts, {
      kind: EventKind.Asset,
      asset: undefined,
    } as never);
    expect(mutated).toBe(false);
    expect(parts).toHaveLength(0);
  });
});

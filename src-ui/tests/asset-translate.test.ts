// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-translate — Agent 资产块 WO-3 判据：
//   BlockPart → 1 块映射（活引用 source.part）、id 稳定 pb:{msg}:{i}、
//   update 后重转译 id 不变、钉住续命、块无需拆围栏。
// 协议：docs/plans/agent-asset-blocks.md §2.2/§2.5/§3（WO-3）。

import { describe, expect, it } from 'vitest';
import { translateMessages, translateMessagesCached } from '../src/paper/translate';
import type { AssistantMessage, BlockPart } from '../src/ui/message-model';

function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}

function blockPart(overrides: Partial<BlockPart> = {}): BlockPart {
  return {
    type: 'block',
    assetId: 'as_1',
    kind: 'chart',
    presentation: 'chart',
    title: 'q4',
    payload: { type: 'bar', data: [1, 2, 3] },
    finalised: true,
    ...overrides,
  };
}

describe('paper/translate — BlockPart → 资产块映射（WO-3）', () => {
  it('BlockPart → 1 块：kind/payload/asset 元数据落位，source 活引用', () => {
    const bp = blockPart({ assetId: 'as_chart', kind: 'chart', presentation: 'chart', title: 'q4' });
    const msg = asstMsg('a1', [bp]);
    const blocks = translateMessages([msg]);
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.kind).toBe('chart');
    expect(b.payload).toEqual({ type: 'bar', data: [1, 2, 3] });
    expect(b.id).toBe('pb:a1:0');
    expect(b.asset).toMatchObject({
      assetId: 'as_chart',
      presentation: 'chart',
      title: 'q4',
      finalised: true,
    });
    expect(b.source.part).toBe(bp);
  });

  it('文本与多个资产块混排：每 part 1:1，id 按 part 索引稳定', () => {
    const bp1 = blockPart({ assetId: 'as_1', kind: 'chart', presentation: 'chart' });
    const bp2 = blockPart({ assetId: 'as_2', kind: 'metric', presentation: 'metric', payload: { items: [] } });
    const msg = asstMsg('a1', [{ type: 'text', text: '先看数据', finalised: true }, bp1, bp2]);
    const blocks = translateMessages([msg]);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'chart', 'metric']);
    expect(blocks[0].id).toBe('pb:a1:0');
    expect(blocks[1].id).toBe('pb:a1:1');
    expect(blocks[2].id).toBe('pb:a1:2');
  });

  it('update 后重转译 id 不变、payload/presentation/finalised 取新（活引用）', () => {
    const bp = blockPart({ payload: { v: 1 }, presentation: '', finalised: false });
    const msg = asstMsg('a1', [bp]);
    const first = translateMessages([msg]);
    expect(first[0].asset?.presentation).toBe('');

    bp.payload = { v: 2, rows: [] };
    bp.presentation = 'grid';
    bp.finalised = true;

    const second = translateMessages([msg]);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].payload).toEqual({ v: 2, rows: [] });
    expect(second[0].asset?.presentation).toBe('grid');
    expect(second[0].asset?.finalised).toBe(true);
    expect(second[0].source.part).toBe(bp);
    expect(second[0].asset?.assetId).toBe(bp.assetId);
  });

  it('update 后重转译钉住续命：id 不变、状态/坐标保持', () => {
    const bp = blockPart({ payload: { v: 1 }, finalised: false });
    const msg = asstMsg('a1', [bp]);
    const first = translateMessages([msg]);
    const pinned = new Map([[first[0].id, { x: 500, y: -300 }]]);

    bp.payload = { v: 2 };
    bp.finalised = true;

    const second = translateMessages([msg], { pinnedPositions: pinned });
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].state).toBe('pinned');
    expect(second[0].x).toBe(500);
    expect(second[0].y).toBe(-300);
    expect(second[0].payload).toEqual({ v: 2 });
  });

  it('块无需拆围栏：payload 含 _code fence 字符串仍映射为 1 个资产块', () => {
    const bp = blockPart({
      kind: 'table',
      presentation: 'grid',
      payload: '```diff\n+ a\n```',
      finalised: false,
    });
    const blocks = translateMessages([asstMsg('a1', [bp])]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('table');
    expect(blocks[0].payload).toBe('```diff\n+ a\n```');
    expect(blocks[0].id).toBe('pb:a1:0');
  });

  it('未知 kind 走开放 union：不注册也可映射（渲染层 WO-4 负责兜底）', () => {
    const bp = blockPart({ kind: 'future_custom', presentation: '', payload: { x: 1 }, finalised: true });
    const blocks = translateMessages([asstMsg('a1', [bp])]);
    expect(blocks[0].kind).toBe('future_custom');
    expect(blocks[0].payload).toEqual({ x: 1 });
  });

  it('子 Agent 内的 BlockPart 挂组内（F4 2026-09-01）：组头 + 资产子块，id 带子前缀', () => {
    const bp = blockPart({ assetId: 'as_sub', kind: 'metric', presentation: 'metric', payload: { items: [] } });
    const msg = asstMsg('a1', [
      { type: 'subagent', agentId: 'sub-1', description: '子代理', status: 'done', parts: [bp], version: 1 },
    ]);
    const blocks = translateMessages([msg]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].kind).toBe('subagent');
    expect(blocks[0].id).toBe('pb:a1:0g');
    expect(blocks[1].kind).toBe('metric');
    expect(blocks[1].id).toBe('pb:a1:0s0');
    expect(blocks[1].source.part).toBe(bp);
    expect(blocks[1].asset?.assetId).toBe('as_sub');
  });

  it('增量转译缓存：资产块消息触碰后重建但 id 稳定、内容取新', () => {
    const part = blockPart({ payload: { v: 1 } });
    const msg = asstMsg('a1', [part]);
    const pinned: Record<string, { x: number; y: number }> = {};
    const first = translateMessagesCached([msg], pinned, null);
    expect(first.blocks[0].payload).toEqual({ v: 1 });

    part.payload = { v: 2 };
    const touched = { ...msg };
    const second = translateMessagesCached([touched], pinned, first.cache);
    expect(second.blocks[0]).not.toBe(first.blocks[0]);
    expect(second.blocks[0].id).toBe(first.blocks[0].id);
    expect(second.blocks[0].payload).toEqual({ v: 2 });
    expect(second.blocks[0].source.part).toBe(part);
  });

  it('增量转译缓存 + 钉住：资产块钉住续命跨消息触碰保持', () => {
    const part = blockPart({ payload: { v: 1 }, finalised: false });
    const msg = asstMsg('a1', [part]);
    const first = translateMessagesCached([msg], {}, null);
    const pinned: Record<string, { x: number; y: number }> = { [first.blocks[0].id]: { x: 10, y: 20 } };

    part.payload = { v: 2 };
    part.finalised = true;
    const touched = { ...msg };
    const second = translateMessagesCached([touched], pinned, first.cache);
    expect(second.blocks[0].state).toBe('pinned');
    expect(second.blocks[0].x).toBe(10);
    expect(second.blocks[0].y).toBe(20);
    expect(second.blocks[0].payload).toEqual({ v: 2 });
  });
});

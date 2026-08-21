// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 图分页加载（P0-2）回归测试
//
// 回归背景（2026-08-16 分页渲染管线拆除）：
//   loadGraphPages 曾在首页就 render、后续页 applyGraphDiff 嫁接、末页
//   relayoutInPlace 补丁重算 —— 残图布局 ≠ 全量布局、流式期间折叠视图
//   读到半成品社区态、末页累积边撞 IPC 护栏后整个收敛机制不执行。
//   现为：逐页只合并数据，全部到齐后原子换入 ws.graphData。
//
// V5 拆除（2026-08-22）：渲染面退役——loadGraphPages 的 starGraph 参数
// 恒 null（签名保留作调用点锚），不变式退化为纯数据面：
//   1. 节点/边按 id 去重，ws.graphData 原子换入（含权威社区）；拉页失败
//      时旧图保留；
//   2. 工作区切走时停止拉页、不换入。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(async () => () => {}),
  isMockMode: () => false,
}));

import { loadGraphPages } from '../src/workspace';

// ── helpers ──────────────────────────────────────────────

function makeWs(path = 'D:/proj') {
  return {
    _active: true,
    get active() {
      return this._active;
    },
    path,
    graphData: {
      meta: {},
      nodes: [] as any[],
      edges: [] as any[],
      communities: [] as any[],
      hierarchical_communities: [] as any[],
    },
    onStatusChange: undefined as any,
  } as any;
}

function node(id: string, cid: number) {
  return { id, name: id, type: 'function', location: id.split(':')[0], community_id: cid };
}

function pagePayload(page: number, totalPages: number, nodes: any[], extra: any = {}) {
  return JSON.stringify({
    meta: { source_root: 'D:/proj', node_count: 3, edge_count: 1 },
    page,
    page_size: 2,
    total_pages: totalPages,
    has_more: page + 1 < totalPages,
    nodes,
    edges: [],
    ...extra,
  });
}

// ── tests ────────────────────────────────────────────────

describe('loadGraphPages（P0-2 分页加载 · V5 拆除后纯数据面）', () => {
  beforeEach(() => mockRpc.mockReset());

  it('单页：原子换入 graphData，权威社区已在图上', async () => {
    const ws = makeWs();
    mockRpc.mockResolvedValue(
      pagePayload(0, 1, [node('a.ts:f1', 1), node('a.ts:f2', 1), node('b.ts:g1', 2)], {
        communities: [
          { id: '1', size: 2, node_ids: ['a.ts:f1', 'a.ts:f2'], label: 'a.ts' },
          { id: '2', size: 1, node_ids: ['b.ts:g1'], label: 'b.ts' },
        ],
        hierarchical_communities: [{ id: 'h1', label: 'a', node_ids: ['a.ts:f1', 'a.ts:f2'], level: 0 }],
      }),
    );

    const ok = await loadGraphPages(ws, null, { meta: {}, page_size: 2, total_pages: 1 });

    expect(ok).toBe(true);
    expect(ws.graphData.nodes).toHaveLength(3);
    expect(ws.graphData.communities).toHaveLength(2);
    expect(ws.graphData.hierarchical_communities[0].id).toBe('h1');
  });

  it('多页：全部到齐后一次原子换入（重复节点去重 + 权威社区覆盖）', async () => {
    const ws = makeWs();
    // 页 0：不含社区（仅首页）；页 1：含权威社区，且携带与页 0 重复的节点（漂移吸收）
    mockRpc.mockResolvedValueOnce(pagePayload(0, 2, [node('a.ts:f1', 1), node('a.ts:f2', 1)])).mockResolvedValueOnce(
      pagePayload(1, 2, [node('a.ts:f2', 1), node('b.ts:g1', 2)], {
        communities: [{ id: '1', size: 3, node_ids: ['a.ts:f1', 'a.ts:f2', 'b.ts:g1'], label: 'a.ts' }],
        hierarchical_communities: [{ id: 'h1', label: 'a', node_ids: ['a.ts:f1'], level: 0 }],
      }),
    );

    const ok = await loadGraphPages(ws, null, { meta: {}, page_size: 2, total_pages: 2 });

    expect(ok).toBe(true);
    // 合并结果：重复节点 a.ts:f2 去重，最终社区为权威版
    expect(ws.graphData.nodes.map((n: any) => n.id).sort()).toEqual(['a.ts:f1', 'a.ts:f2', 'b.ts:g1']);
    expect(ws.graphData.communities[0].size).toBe(3);
    expect(ws.graphData.hierarchical_communities[0].id).toBe('h1');
  });

  it('工作区切走：停止拉页、不换入 graphData', async () => {
    const ws = makeWs();
    const shell = ws.graphData;
    mockRpc.mockImplementation(async () => {
      ws._active = false;
      return pagePayload(0, 3, [node('a.ts:f1', 1)]);
    });

    const ok = await loadGraphPages(ws, null, { meta: {}, page_size: 1, total_pages: 3 });

    expect(ok).toBe(false);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(ws.graphData).toBe(shell);
  });

  it('拉页失败：抛错且旧 graphData 原样保留（原子换入）', async () => {
    const ws = makeWs();
    const oldGraph = {
      meta: {},
      nodes: [{ id: 'old.ts:keep' }],
      edges: [] as any[],
      communities: [] as any[],
      hierarchical_communities: [] as any[],
    };
    ws.graphData = oldGraph as any;
    mockRpc
      .mockResolvedValueOnce(pagePayload(0, 2, [node('a.ts:f1', 1)]))
      .mockRejectedValueOnce(new Error('图谱分页响应超过 IPC 尺寸上限'));

    await expect(loadGraphPages(ws, null, { meta: {}, page_size: 1, total_pages: 2 })).rejects.toThrow('IPC 尺寸上限');
    expect(ws.graphData).toBe(oldGraph);
    expect(ws.graphData.nodes.map((n: any) => n.id)).toEqual(['old.ts:keep']);
  });
});

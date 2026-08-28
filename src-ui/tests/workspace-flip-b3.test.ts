// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-flip 批 3 测试 — 打开流两段化（D-W1-3：分析出关键路径）。
// T0 静态断言钉住结构（对齐 chat-epoch-guard 模式）。
// Phase 1.5（engine-plugin-extraction）更新：分页拉页退役，装载 =
// 聚合快照（毫秒级）+ analyze_and_load fire-and-forget（缓存过期→
// 后台重建，graph-updated 事件驱动重拉）——「对话秒进」契约不变。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(process.cwd(), 'src/workspace.ts'), 'utf8');

describe('workspace-flip 批 3：打开流两段化（T0 结构钉 · Phase 1.5 快照形态）', () => {
  it('分析路径：analyze_and_load 为 fire-and-forget（不 await——分析出关键路径）', () => {
    const anchor = SRC.indexOf('图快照装载（Phase 1.5）');
    expect(anchor).toBeGreaterThan(0);
    const segment = SRC.slice(anchor, anchor + 2400);
    // 结构断言：分支内不得出现 await analyze_and_load（fire-and-forget 契约）
    expect(segment).not.toMatch(/await typedRpc\('analyze_and_load'/);
    // 结构断言：analyze_and_load fire-and-forget 调用存在
    expect(segment).toMatch(/typedRpc\('analyze_and_load', \{ path, force: false \}\)/);
  });

  it('快照装载先行：load_graph_json 在 analyze_and_load 之前（快照毫秒级即时可用）', () => {
    const anchor = SRC.indexOf('图快照装载（Phase 1.5）');
    const segment = SRC.slice(anchor, anchor + 2400);
    const snapAt = segment.indexOf("typedJsonRpc<string>('load_graph_json'");
    const analyzeAt = segment.indexOf("typedRpc('analyze_and_load'");
    expect(snapAt).toBeGreaterThan(0);
    expect(analyzeAt).toBeGreaterThan(snapAt);
  });

  it('诚实降级：预热中状态提示存在（不静默——宪法第 4 条）', () => {
    const anchor = SRC.indexOf('图快照装载（Phase 1.5）');
    const segment = SRC.slice(anchor, anchor + 2400);
    expect(segment).toMatch(/图谱后台预热中/);
  });

  it('分页栈已拆除（loadGraphPages / get_graph_page / mergeGraphDiff 不得回潮）', () => {
    expect(SRC).not.toMatch(/loadGraphPages/);
    expect(SRC).not.toMatch(/get_graph_page/);
    expect(SRC).not.toMatch(/mergeGraphDiff/);
    expect(SRC).not.toMatch(/rebuildLevel0Communities/);
  });

  it('graph-updated → 快照重拉（不再走 diff 合并/分页重载）', () => {
    const anchor = SRC.indexOf("typedListen('graph-updated'");
    expect(anchor).toBeGreaterThan(0);
    const segment = SRC.slice(anchor, anchor + 2400);
    expect(segment).toMatch(/load_graph_json/);
    expect(segment).toMatch(/invalidate/);
  });
});

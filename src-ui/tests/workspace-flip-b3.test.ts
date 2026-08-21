// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-flip 批 3 测试 — 打开流两段化（D-W1-3：分析出关键路径）。
// T0 静态断言钉住结构（对齐 chat-epoch-guard 模式）：完整分析路径的
// loadGraphPages 必须是 fire-and-forget（不 await）——这是「对话秒进」的
// 构造性保证。行为面由 graph-paging.test.ts 既有用例回归。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(join(process.cwd(), 'src/workspace.ts'), 'utf8');

describe('workspace-flip 批 3：打开流两段化（T0 结构钉）', () => {
  it('完整分析路径：loadGraphPages 为 fire-and-forget（不 await——分析出关键路径）', () => {
    // 定位完整分析分支（批 3 两段化注释是锚点）
    const anchor = SRC.indexOf('workspace-flip 批 3 两段化');
    expect(anchor).toBeGreaterThan(0);
    const segment = SRC.slice(anchor, anchor + 2400);
    // 结构断言：分支内不得出现 await loadGraphPages（fire-and-forget 契约）
    expect(segment).not.toMatch(/await loadGraphPages/);
    // 结构断言：loadGraphPages(...).then 链存在（缓段登记）
    expect(segment).toMatch(/loadGraphPages\(ws, starGraph, meta\)/);
    expect(segment).toMatch(/\.then\(/);
  });

  it('缓段守卫：预热完成/失败路径都带 _active 检查 + _graphWarming 复位', () => {
    const anchor = SRC.indexOf('workspace-flip 批 3 两段化');
    const segment = SRC.slice(anchor, anchor + 2400);
    expect(segment).toMatch(/if \(!ws\._active\) return;/);
    expect(segment.match(/ws\._graphWarming = false/g)?.length).toBe(2); // ready + degraded 两条路径
  });

  it('诚实降级：预热中状态提示存在（不静默——宪法第 4 条）', () => {
    const anchor = SRC.indexOf('workspace-flip 批 3 两段化');
    const segment = SRC.slice(anchor, anchor + 2400);
    expect(segment).toMatch(/图谱后台预热中/);
    expect(segment).toMatch(/图谱预热完成/);
  });

  it('冷启动缓存路径不受波及（skipAnalysis 分支保持既有 fire-and-forget 语义）', () => {
    const anchor = SRC.indexOf('opts?.skipAnalysis');
    expect(anchor).toBeGreaterThan(0);
    const segment = SRC.slice(anchor, anchor + 1200);
    expect(segment).toMatch(/loadGraphPages\(ws, starGraph, opts\.cachedGraph\)/);
    expect(segment).not.toMatch(/await loadGraphPages/);
  });
});

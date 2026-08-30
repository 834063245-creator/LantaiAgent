// StreamingToolExecutor.awaitRemaining 正常路径兜底回归。
//
// 背景（2026-08-31 运行态挂起诊断）：abort 竞速只保护用户停止路径；
// 正常路径逐个 await pending 工具无超时——工具 promise 永不 settle
// （Tauri invoke 回包丢失、Rust 命令死锁）时 run() 永不 settle，
// UI 永卡运行态。修复 = 排水与 30min 兜底定时器竞速（时长对齐子
// Agent 池超时 coordinator.ts DEFAULT_TIMEOUT_MS），超界未 settle 的
// 工具以合成错误结果落地并补发 ToolResult 终结 UI 卡片。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';

function makeRegistry(tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

function hungTool(name: string): Tool {
  return {
    name: () => name,
    description: () => 'never settles',
    parameters: () => ({ type: 'object', properties: {}, required: [] }),
    readOnly: () => true,
    execute: () => new Promise<string>(() => {}), // 永不 settle——模拟回包丢失
  };
}

function fastTool(name: string, output: string): Tool {
  return {
    name: () => name,
    description: () => `mock ${name}`,
    parameters: () => ({ type: 'object', properties: {}, required: [] }),
    readOnly: () => true,
    execute: async () => output,
  };
}

describe('StreamingToolExecutor.awaitRemaining — 正常路径兜底', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('永不 settle 的工具在兜底时长后以合成结果落地并补发 ToolResult', async () => {
    const events: AgentEvent[] = [];
    const executor = new StreamingToolExecutor(
      makeRegistry([hungTool('hung_tool')]),
      (ev) => events.push(ev),
      null,
      new AbortController().signal,
      null,
    );
    executor.addTool({ id: 'c1', name: 'hung_tool', arguments: '{}' });

    const pending = executor.awaitRemaining();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    const results = await pending;

    expect(results).toHaveLength(1);
    expect(results[0].err).toBe('await backstop timeout');
    expect(results[0].output).toContain('超时兜底');
    expect(results[0].output).toContain('hung_tool');
    // UI 卡片必须被终结：ToolDispatch（分发）+ ToolResult（合成终态）
    const toolResults = events.filter((e) => e.kind === EventKind.ToolResult);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].tool?.id).toBe('c1');
    expect(events.some((e) => e.kind === EventKind.ToolDispatch)).toBe(true);
  });

  it('正常工具先于兜底 settle → 不走超时路径', async () => {
    const events: AgentEvent[] = [];
    const executor = new StreamingToolExecutor(
      makeRegistry([fastTool('fast_tool', 'ok')]),
      (ev) => events.push(ev),
      null,
      new AbortController().signal,
      null,
    );
    executor.addTool({ id: 'c2', name: 'fast_tool', arguments: '{}' });

    const results = await executor.awaitRemaining();
    expect(results).toHaveLength(1);
    expect(results[0].output).toBe('ok');
    expect(results[0].err).toBeUndefined();
  });
});

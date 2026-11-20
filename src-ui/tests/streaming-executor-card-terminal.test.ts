// 工具卡片永不卡在运行态（2026-11-20 用户报「工具卡片会卡在运行态」）——
//
// 两条根因都在执行器的**终结面**，不在渲染面：
//   ① `aborts` 判据读错误文本（`msg.includes('aborted')`）：普通失败被当成用户中止
//      抛出去，该调用的 ToolResult 永不发出，卡片停在「行 Ns」直到本轮收尾。
//   ② `discard()`（流式重试 / 去图重发 / 作废轮）只清账不落终态：已分发的卡片要等
//      本轮 finally 的 `_finaliseStreamingAssistant` 才被统一标 error——那一轮重试
//      可能长达数分钟，用户看到的就是「一直转」。
//
// 守护面：本文件三条（普通失败落终态 / 真中止走取消路径 / discard 立刻终结）。

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';
import { StreamingToolExecutor } from '../src/agent/streaming-executor';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';

function reg(tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

function tool(name: string, execute: Tool['execute']): Tool {
  return {
    name: () => name,
    description: () => name,
    parameters: () => ({ type: 'object', properties: {}, required: [] }),
    readOnly: () => true,
    execute,
  };
}

function terminalIds(events: AgentEvent[]): string[] {
  return events.filter((e) => e.kind === EventKind.ToolResult).map((e) => String(e.tool?.id));
}

describe('工具卡片永不卡在运行态（2026-11-20）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('文案里带 aborted 的普通失败必须落终态（不得被当成用户中止吞掉）', async () => {
    const events: AgentEvent[] = [];
    const executor = new StreamingToolExecutor(
      reg([
        tool('fs', async () => {
          // 真实形态：链路被对端切断 / 子进程被杀 / 适配器把 abort 字样带进 message
          throw new Error('read failed: stream aborted by peer');
        }),
      ]),
      (ev) => events.push(ev),
      null,
      new AbortController().signal,
      null,
    );
    executor.addTool({ id: 'fs-1', name: 'fs', arguments: '{"action":"read","path":"x"}' });

    const results = await executor.awaitRemaining();

    expect(results).toHaveLength(1);
    expect(results[0].err).toBe('read failed: stream aborted by peer');
    expect(terminalIds(events)).toEqual(['fs-1']);
  });

  it('真中止（signal 已 abort）仍交给调用方处理，由取消路径补终态', async () => {
    vi.useRealTimers(); // 取消路径用真实 100ms 竞速窗口
    const events: AgentEvent[] = [];
    const ctrl = new AbortController();
    const executor = new StreamingToolExecutor(
      reg([
        tool(
          'fs',
          () =>
            new Promise<string>((_res, rej) => {
              setTimeout(() => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), 5);
            }),
        ),
      ]),
      (ev) => events.push(ev),
      null,
      ctrl.signal,
      null,
    );
    executor.addTool({ id: 'fs-2', name: 'fs', arguments: '{}' });
    ctrl.abort();

    const results = await executor.awaitRemaining();

    expect(results).toHaveLength(1);
    expect(terminalIds(events)).toEqual(['fs-2']);
  });

  it('discard() 必须立刻终结已分发的卡片（不得等到本轮收尾才变 error）', () => {
    const events: AgentEvent[] = [];
    const executor = new StreamingToolExecutor(
      reg([
        tool('fs', () => new Promise<string>(() => {})), // 永不 settle：模拟回包丢失
      ]),
      (ev) => events.push(ev),
      null,
      new AbortController().signal,
      null,
    );
    executor.addTool({ id: 'fs-3', name: 'fs', arguments: '{"action":"read","path":"a"}' });
    expect(terminalIds(events)).toEqual([]);

    executor.discard(); // agent.stream 的重试路径 / 去图重发路径

    const terminal = events.filter((e) => e.kind === EventKind.ToolResult);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].tool?.id).toBe('fs-3');
    expect(terminal[0].tool?.err).toBe('discarded');
  });
});

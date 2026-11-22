// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 作废尝试的半成卡：重试不得把它留在卷面（2026-11-22 卷 165「code_execution 无由来的重复调用」）。
//
// 事故形态：断流重试时，每次尝试在 ToolCallStart（参数还没到）就先建了一张 UI 卡。
// 尝试失败后，这个调用**不在** executor 的账上（参数没到齐 → 从未 addTool），
// executor.discard() 清不到它；重试再从零生成一张同名卡，回合收尾把所有 pending 卡
// 统一标 error 并随 uiMessages 落盘（165 卷：三次断流 + 一次手停 = 四张空 code_execution 卡）。
//
// 修法：失败尝试把「只发过 ToolCallStart、没收到完整 ToolCall」的调用以 ToolCallDropped
// 事件撤掉——它从未成为一次真调用，不是「失败的调用」。
// 已到齐参数、进过执行器的调用不走这条路（那块由 executor.discard 落「作废」终态）。

import './helpers/kernel-registry';
import { describe, expect, it, vi } from 'vitest';
// 压缩实现（compaction 产物）在生产由装载器常驻登记；自行装配 Agent 的测试须先复现该登记态。
import { installCompactionForTest } from './helpers/compaction-impl';

installCompactionForTest();

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import type { AgentEvent } from '../src/agent/agent-types';
import { EventKind } from '../src/agent/agent-types';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

const STALL_MSG = '[响应超时] 30 秒内未收到服务商任何数据（连接未建立或流式输出中途停止），已中止本次请求';

/** 第一次尝试：只发 ToolCallStart 就断流；之后正常回答（模拟链路恢复 / 重试成功）。 */
function makePartialCallProvider(): { prov: Provider; calls: () => number } {
  let calls = 0;
  const prov: Provider = {
    name: () => 'mock',
    model: () => 'mock',
    stream: () => {
      calls++;
      const n = calls;
      return (async function* (): AsyncGenerator<Chunk> {
        if (n === 1) {
          yield {
            type: ChunkType.ToolCallStart,
            tool_call: { id: 'call_ghost', name: 'code_execution', arguments: '' },
          };
          throw new Error(STALL_MSG);
        }
        yield { type: ChunkType.Text, text: 'recovered' };
        yield { type: ChunkType.Done } as Chunk;
      })();
    },
  };
  return { prov, calls: () => calls };
}

/** 第一次尝试：完整 ToolCall（参数到齐 → 派发）后断流；之后正常回答。 */
function makeCompleteCallProvider(): { prov: Provider; calls: () => number } {
  let calls = 0;
  const prov: Provider = {
    name: () => 'mock',
    model: () => 'mock',
    stream: () => {
      calls++;
      const n = calls;
      return (async function* (): AsyncGenerator<Chunk> {
        if (n === 1) {
          yield { type: ChunkType.ToolCallStart, tool_call: { id: 'call_real', name: 'no_such_tool', arguments: '' } };
          yield { type: ChunkType.ToolCall, tool_call: { id: 'call_real', name: 'no_such_tool', arguments: '{}' } };
          throw new Error(STALL_MSG);
        }
        yield { type: ChunkType.Text, text: 'recovered' };
        yield { type: ChunkType.Done } as Chunk;
      })();
    },
  };
  return { prov, calls: () => calls };
}

/** 把假时钟推完所有退避。 */
async function drainBackoff(steps = 20, stepMs = 5_000): Promise<void> {
  for (let i = 0; i < steps; i++) await vi.advanceTimersByTimeAsync(stepMs);
}

describe('作废尝试的半成卡 — agent 事件面', () => {
  it('只发过 ToolCallStart 的调用：失败尝试后补发 ToolCallDropped，且从未派发完整调用', async () => {
    vi.useFakeTimers();
    try {
      const { prov, calls } = makePartialCallProvider();
      const events: AgentEvent[] = [];
      const agent = createTestAgent(prov, new ToolRegistry(), 'sys', {
        eventSink: (e) => events.push(e),
        contextWindow: 0,
      });

      const runPromise = agent.run(new AbortController().signal, 'hi');
      await drainBackoff();
      await runPromise;

      expect(calls()).toBe(2);
      const dropped = events.filter((e) => e.kind === EventKind.ToolCallDropped);
      expect(dropped.map((e) => e.tool?.id)).toEqual(['call_ghost']);
      expect(dropped.map((e) => e.tool?.name)).toEqual(['code_execution']);
      // 完整调用从未到达 ⇒ 只有那一次 partial 分发，没有结果
      expect(events.filter((e) => e.kind === EventKind.ToolDispatch)).toHaveLength(1);
      expect(events.find((e) => e.kind === EventKind.ToolDispatch)?.tool?.partial).toBe(true);
      expect(events.filter((e) => e.kind === EventKind.ToolResult)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('已到齐的调用不受影响：不误撤（终态仍由 executor.discard 负责）', async () => {
    vi.useFakeTimers();
    try {
      const { prov, calls } = makeCompleteCallProvider();
      const events: AgentEvent[] = [];
      const agent = createTestAgent(prov, new ToolRegistry(), 'sys', {
        eventSink: (e) => events.push(e),
        contextWindow: 0,
      });

      const runPromise = agent.run(new AbortController().signal, 'hi');
      await drainBackoff();
      await runPromise;

      expect(calls()).toBe(2);
      expect(events.filter((e) => e.kind === EventKind.ToolCallDropped)).toHaveLength(0);
      // 未知工具的失败结果照样落终态（卡片不会停在运行态）
      expect(events.some((e) => e.kind === EventKind.ToolResult && e.tool?.id === 'call_real')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

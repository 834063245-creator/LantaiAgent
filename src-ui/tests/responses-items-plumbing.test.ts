// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Responses 方言「output items 留档 → 下一轮请求」的接线守护（2026-09-23 合规批次）。
//
// 为什么单独立一份：`responses.ts` 的协议级用例只证明**给定的留档**能拼回 wire；
// 这里证明**留档真的会被存下来、并出现在下一次请求里**——三段接线缺任何一段，
// 用户看到的就是「工具一调就 400」（服务端拒绝缺 reasoning 项的带 tools 请求）。
//
// 用户操作序列（用例来源）：开一轮 → 模型调工具 → 工具回结果 → 模型收尾。
// 链路：Provider chunk（ChunkType.ResponsesItems）→ Agent.streamOnce 累积 →
//       LoopStreamResult.responses_items → default-loop 写进 assistant 轮
//       （Message.responses_items）→ 会话投影 → 下一次请求载荷。

import { describe, expect, it } from 'vitest';
// 批 6d-2：压缩实现（compaction 产物）在生产由装载器常驻登记；
// service 类 ⇒ 缺实现在调用点 fail-loud——本文件自行装配/驱动 Agent，须先复现该登记态。
import { installCompactionForTest } from './helpers/compaction-impl';

installCompactionForTest();

import type { Agent } from '../src/agent/agent';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Message, Provider, ResponsesOutputItem } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

/** 本轮模型输出项（reasoning 在前、function_call 紧随——服务端要求的相邻关系）。 */
const REASONING: ResponsesOutputItem = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [{ type: 'summary_text', text: '该调工具' }],
  encrypted_content: 'enc-blob',
  status: 'completed',
};
const CALL_ITEM: ResponsesOutputItem = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'echo_tool',
  arguments: '{"v":"x"}',
  status: 'completed',
};

function makeHarness(scripts: Chunk[][]) {
  const requests: Message[][] = [];
  let callIdx = 0;
  const prov: Provider = {
    name: () => 'mock-responses',
    model: () => 'mock-responses',
    async *stream(_signal: AbortSignal, req: { messages: Message[] }) {
      requests.push(JSON.parse(JSON.stringify(req.messages)) as Message[]);
      const script = scripts[Math.min(callIdx++, scripts.length - 1)];
      for (const c of script) yield c;
    },
  };
  const tools = new ToolRegistry();
  const echo: Tool = {
    name: () => 'echo_tool',
    description: () => 'echo fixture',
    parameters: () => ({ type: 'object', properties: { v: { type: 'string' } }, required: ['v'] }),
    readOnly: () => true,
    execute: async (args) => `ok:${String((args as { v?: unknown }).v ?? '')}`,
  };
  tools.register(echo);
  const agent: Agent = createTestAgent(prov, tools, 'sys-fixture', {
    agentId: 'responses-plumbing',
    contextWindow: 10_000_000, // 不触发自动压缩
  });
  return { agent, requests };
}

describe('Responses 留档接线（chunk → 会话 → 下一轮请求）', () => {
  it('本轮 output items 落进 assistant 轮，并出现在下一次请求载荷里', async () => {
    const { agent, requests } = makeHarness([
      // 第 1 步：模型思考 + 调工具 + 收尾（items 随完成事件下发）
      [
        { type: ChunkType.Reasoning, text: '该调工具' },
        { type: ChunkType.ToolCall, tool_call: { id: 'call_1', name: 'echo_tool', arguments: '{"v":"x"}' } },
        { type: ChunkType.ResponsesItems, responses_items: [REASONING, CALL_ITEM] },
        { type: ChunkType.Done },
      ],
      // 第 2 步：拿到工具结果 → 收尾
      [{ type: ChunkType.Text, text: '做完了' }, { type: ChunkType.Done }],
    ]);

    await agent.run(new AbortController().signal, '跑一下');

    // ① 会话里那条 assistant 轮带着留档（落盘/投影面）
    const stored = agent.getSession().filter((m) => m.role === 'assistant' && m.tool_calls?.length);
    expect(stored).toHaveLength(1);
    expect(stored[0].responses_items).toEqual([REASONING, CALL_ITEM]);

    // ② 下一轮请求载荷里有它（回放的输入面——漏了就是服务端 400）
    expect(requests).toHaveLength(2);
    const replayed = requests[1].find((m) => m.role === 'assistant' && m.tool_calls?.length);
    expect(replayed?.responses_items).toEqual([REASONING, CALL_ITEM]);
  });

  it('非 Responses 方言（不产 items chunk）不写该字段（老路径载荷零变化）', async () => {
    const { agent, requests } = makeHarness([
      [
        { type: ChunkType.ToolCall, tool_call: { id: 'call_1', name: 'echo_tool', arguments: '{"v":"x"}' } },
        { type: ChunkType.Done },
      ],
      [{ type: ChunkType.Text, text: '好' }, { type: ChunkType.Done }],
    ]);

    await agent.run(new AbortController().signal, '跑一下');

    const stored = agent.getSession().filter((m) => m.role === 'assistant' && m.tool_calls?.length);
    expect(stored).toHaveLength(1);
    expect('responses_items' in stored[0]).toBe(false);
    // 请求载荷逐字节形状不变（JSON 序列化后无该键）
    expect(JSON.stringify(requests[1]).includes('responses_items')).toBe(false);
  });
});

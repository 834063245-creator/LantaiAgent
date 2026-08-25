// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 测试专用 Agent 构造助手：统一走 ctx 入口，legacy 构造路径已删除。
import { Agent, type AgentOptions } from '../../src/agent/agent';
import { AgentContext } from '../../src/agent/context';
import type { ToolRegistry } from '../../src/agent/tool';
import type { Provider } from '../../src/provider/types';

export function createTestAgent(
  provider: Provider,
  tools: ToolRegistry,
  systemPrompt: string,
  opts: AgentOptions = {},
): Agent {
  const ctx = new AgentContext(
    {
      agentId: opts.agentId,
      parentId: opts.parentId,
      subagentDepth: opts.subagentDepth,
    },
    {
      provider,
      tools,
      eventSink: opts.eventSink,
      execState: opts.execState,
      messageBus: opts.messageBus,
      taskBoard: opts.taskBoard,
      discoveryBoard: opts.discoveryBoard,
    },
  );
  return new Agent(ctx, systemPrompt, opts);
}

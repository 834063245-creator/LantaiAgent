// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentRuntime 句柄转发契约 — 附图引用必须原样透传（multimodal-image-plan B3）
//
// Why: B3 真机事故（2026-09-11 实测定位）——chat-core 传图、Agent 收图两端都
// 正确，中间的 AgentHandleImpl.run 没接第三参（TS 对「实现少写可选参数」不报错，
// 参数少的函数可赋给参数多的签名），图在这一跳被静默吞掉：agent 会话里连
// 「图已省略」占位都没有，模型只收到文字，用户看到「贴了图但模型说没收到」。
// 既有测试只盖两端（composer 门禁 / provider wire），中间这跳无人测。
//
// 本测试钉转发契约：AgentRuntime.createAgent 产出的句柄（真链路——与
// workspace 工厂、chat-core 消费的是同一个实现）必须把 images 原样交给 Agent。

import { describe, expect, it, vi } from 'vitest';

// ── bridge mock（同 agent-lifecycle-dispose.test.ts 的模式）──

const mockRpc = vi.fn();
vi.mock('../src/bridge', () => ({
  rpc: (...args: any[]) => mockRpc(...args),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { Agent } from '../src/agent/agent';
import { AgentRuntime } from '../src/agent/runtime/runtime';
import type { AgentHandle } from '../src/agent/runtime/types';
import { ToolRegistry } from '../src/agent/tool';
import type { ChatImageRef } from '../src/provider/types';

const IMG: ChatImageRef = {
  id: 'a32c49275f3da29d3138f7402d5bc53561635c06d3368d88216bc29deadb6cae',
  mediaType: 'image/jpeg',
  bytes: 332714,
  width: 2048,
  height: 2048,
  name: '截图.jpeg',
};

function mockProvider(): any {
  return { name: () => 'mock-provider' };
}

/** 最小配置造会话主 Agent（同 agent-lifecycle-dispose.test.ts 的 harness）。 */
function createSessionAgent(runtime: AgentRuntime, agentId: string): Promise<AgentHandle> {
  return runtime.createAgent({
    agentId,
    parentId: null,
    projectPath: '/fake/project',
    provider: mockProvider(),
    tools: new ToolRegistry(),
    systemPrompt: 'test system prompt',
  });
}

describe('AgentRuntime 句柄 — 附图引用转发（B3）', () => {
  it('handle.run 把 images 原样转发给 Agent.run（少接一参 = 静默吞图）', async () => {
    const spy = vi.spyOn(Agent.prototype, 'run').mockResolvedValue(undefined);
    try {
      const runtime = new AgentRuntime();
      const handle = await createSessionAgent(runtime, 'main-img');
      const signal = new AbortController().signal;

      await handle.run(signal, '看这张图', [IMG]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(signal, '看这张图', [IMG]);
    } finally {
      spy.mockRestore();
    }
  });

  it('无图轮次照常转发（文本路径零回归）', async () => {
    const spy = vi.spyOn(Agent.prototype, 'run').mockResolvedValue(undefined);
    try {
      const runtime = new AgentRuntime();
      const handle = await createSessionAgent(runtime, 'main-text');
      const signal = new AbortController().signal;

      await handle.run(signal, '纯文字');

      expect(spy).toHaveBeenCalledTimes(1);
      // 第三参允许 undefined —— Agent 侧判据是 `images !== undefined && length > 0`，
      // 显式 undefined 与缺参行为等价；此处只钉前两参不被改动。
      expect(spy.mock.calls[0][0]).toBe(signal);
      expect(spy.mock.calls[0][1]).toBe('纯文字');
    } finally {
      spy.mockRestore();
    }
  });

  it('端到端效应：经句柄发的图真进 Agent 会话（message.images 带引用，非仅调用形状）', async () => {
    const runtime = new AgentRuntime();
    const handle = await createSessionAgent(runtime, 'main-effect');
    // 已中止的 signal —— run 在 runLoop 前先落用户消息（agent.ts D-1），
    // 循环随即中止；本测试只验「图入会话」这一刻的效应。
    const ac = new AbortController();
    ac.abort();

    await handle.run(ac.signal, '看这张图', [IMG]).catch(() => {});

    const userMsg = handle.getSession().find((m) => m.role === 'user' && m.content === '看这张图');
    expect(userMsg).toBeDefined();
    expect(userMsg?.images).toEqual([IMG]);
  });
});

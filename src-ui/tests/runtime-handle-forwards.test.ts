// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// AgentRuntime 句柄转发契约 — **可选能力位**（`ChatAgentHandle` 的 `?` 成员）
//
// Why（2026-11-11 真机排查）：`callSideLLM` 自 B 批（2026-10-31 卷名自动概括）落地起
// 就没被 `AgentHandleImpl` 转发过。能力位是 Optional（语义「不实现 = 该能力不发生」），
// 于是会话层读到的 `agent.callSideLLM` 恒 undefined ⇒ `refineVolumeTitleIfDerived`
// 在 `if (!sideCall) return;` 静默返回：**B 批从未执行过一次**，所有卷名停在首条来文
// 前缀（28 字 + 「…」），ui.log 全量 0 条 `volume title llm response`（连失败 warn
// 都没有）。同文件 `presetId` 同理漏接 ⇒ 落盘的组合身份退化成「全局默认」。
//
// 形态与 runtime-image-forward.test.ts（B3 丢图）完全相同：两端都对，中间这一跳
// 少写一行；TS 因为接口成员可选，不报错。既有用例全绿（桩句柄自带 callSideLLM，
// 恰好绕开这一层）。本测试钉两件事：
//   ① **结构面**：接口上的每个可选成员，包装类必须转发（新增能力位漏接即红）；
//   ② **行为面**：真链路句柄（rt.createAgent 产物，与 workspace 工厂同一个实现）
//      真带这两个成员，且转发到 raw Agent。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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

const SRC = path.resolve(__dirname, '../src/agent');

/** 读一个源文件（结构面守卫走源码，不走反射——包装类是内部实现，不导出）。 */
function read(rel: string): string {
  return readFileSync(path.join(SRC, rel), 'utf8');
}

/** `ChatAgentHandle` 里的**可选**成员名（方法 `foo?(` 与属性 `readonly foo?:`）。 */
function optionalMembers(): string[] {
  const src = read('chat-agent-handle.ts');
  const names = new Set<string>();
  for (const m of src.matchAll(/^\s{2}([A-Za-z_]\w*)\?[(<]/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^\s{2}readonly ([A-Za-z_]\w*)\?/gm)) names.add(m[1]);
  return [...names].sort();
}

/** 包装类（AgentHandleImpl）里是否有该成员的声明（`foo(` / `get foo(`）。 */
function forwardedInWrapper(wrapper: string, name: string): boolean {
  return new RegExp(`^\\s{2}(?:get\\s+)?${name}\\b`, 'm').test(wrapper);
}

function mockProvider(): any {
  return { name: () => 'mock-provider' };
}

/** 最小配置造会话主 Agent（同 runtime-image-forward.test.ts 的 harness）。 */
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

describe('AgentRuntime 句柄 — 可选能力位转发（结构面）', () => {
  it('ChatAgentHandle 的每个可选成员都在 AgentHandleImpl 里有转发声明', () => {
    const wrapper = read('runtime/runtime.ts');
    const missing = optionalMembers().filter((name) => !forwardedInWrapper(wrapper, name));
    // 漏接 = 会话层读到 undefined =「该能力不发生」（静默）。新增能力位必须同步补一跳。
    expect(missing).toEqual([]);
  });

  it('守卫自身有效：能看见已知能力位（防止正则退化成恒真）', () => {
    const names = optionalMembers();
    expect(names).toContain('callSideLLM');
    expect(names).toContain('presetId');
    expect(names).toContain('setExecState');
  });
});

describe('AgentRuntime 句柄 — 可选能力位转发（行为面）', () => {
  it('真链路句柄带 callSideLLM，且转发到 raw Agent', async () => {
    const spy = vi
      .spyOn(Agent.prototype, 'callSideLLM')
      .mockResolvedValue({ text: '磁盘占用核查', maxTokens: 32 } as never);
    try {
      const runtime = new AgentRuntime();
      const handle = await createSessionAgent(runtime, 'main-side');
      expect(typeof handle.callSideLLM).toBe('function');

      const signal = new AbortController().signal;
      const messages = [{ role: 'user' as const, content: '给这卷起个名' }];
      await handle.callSideLLM?.(signal, messages);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(signal);
      expect(spy.mock.calls[0][1]).toEqual(messages);
    } finally {
      spy.mockRestore();
    }
  });

  it('真链路句柄带 presetId（卷的组合身份落盘读的就是这一栏）', async () => {
    const runtime = new AgentRuntime();
    const handle = await createSessionAgent(runtime, 'main-preset');
    expect(typeof handle.presetId).toBe('string');
    expect(handle.presetId).toBe((handle as unknown as { _getAgent(): Agent })._getAgent().presetId);
  });
});

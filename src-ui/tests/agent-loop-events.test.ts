// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// D4 loop 事件面守护（平台化 Phase 1 · 2026-08-27）：
//   ① 完整性 guard：mode 合法（Phase 2 T0 延续）+ LOOP_EVENT_NAMES ↔ AGENT_EVENT_MAP
//      emit 域双向对拍（除 legacy tool/result|error 外，emit 域必须在 loop 表登记）
//   ② emitLoopEvent 运行时拒绝非 emit 域事件（JS 调用方守卫——错误不静默）
//   ③ 发射序与载荷：turn/start → step/start → request/start → request/end →
//      step/end → turn/end（单轮无工具路径），载荷字段逐项断言
//   ④ 监听 disposer 生效（dispose 后不再收到事件）

import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_MAP,
  AgentEventBus,
  EVENT_MODES,
  LOOP_EVENT_NAMES,
  type LoopEventName,
  type LoopEventPayload,
} from '../src/agent/events';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';

const LEGACY_EMIT_EVENTS = ['tool/result', 'tool/error'];

describe('D4 事件表完整性 guard', () => {
  it('所有事件 mode ∈ EVENT_MODES（Phase 2 T0 延续）', () => {
    for (const [name, decl] of Object.entries(AGENT_EVENT_MAP)) {
      expect(EVENT_MODES.includes(decl.mode), `事件 ${name} mode 非法`).toBe(true);
    }
  });

  it('loop 表 ↔ map emit 域双向对拍（tool/result|error 为 legacy 豁免）', () => {
    const emitNames = Object.entries(AGENT_EVENT_MAP)
      .filter(([, decl]) => decl.mode === 'emit')
      .map(([name]) => name);
    for (const name of LOOP_EVENT_NAMES) {
      expect(AGENT_EVENT_MAP[name as LoopEventName].mode, `loop 事件 ${name} 未在 AGENT_EVENT_MAP 声明 emit`).toBe(
        'emit',
      );
    }
    const unregistered = emitNames.filter(
      (n) => !LEGACY_EMIT_EVENTS.includes(n) && !LOOP_EVENT_NAMES.includes(n as never),
    );
    expect(unregistered, `emit 域事件未登记 LOOP_EVENT_NAMES: ${unregistered.join(', ')}`).toEqual([]);
  });

  it('emitLoopEvent 运行时拒绝非 emit 域事件名（JS 调用方守卫）', () => {
    const bus = new AgentEventBus();
    expect(() => bus.emitLoopEvent('tool/guard' as never, {} as never)).toThrow(/非 emit 域事件/);
  });
});

function fakeProvider(): Provider {
  return {
    name: () => 'mock-model',
    stream: async function* (): AsyncGenerator<Chunk> {
      yield { type: ChunkType.Text, text: 'ok' } as Chunk;
      yield { type: ChunkType.Done } as Chunk;
    },
  };
}

describe('D4 发射序与载荷（单轮无工具路径）', () => {
  it('事件序 = turn/start → step/start → request/start → request/end → step/end → turn/end', async () => {
    const agent = createTestAgent(fakeProvider(), new ToolRegistry(), 'sys', {});
    const order: string[] = [];
    const payloads: Record<string, unknown> = {};
    const record = <E extends LoopEventName>(name: E) =>
      agent.onLoopEvent(name, (p: LoopEventPayload[E]) => {
        order.push(name);
        payloads[name] = p;
      });
    const disposers = (LOOP_EVENT_NAMES as readonly LoopEventName[]).map((n) => record(n));

    await agent.run(new AbortController().signal, 'hi');

    expect(order).toEqual(['turn/start', 'step/start', 'request/start', 'request/end', 'step/end', 'turn/end']);
    expect(payloads['turn/start']).toMatchObject({ agentId: agent.id, model: 'mock-model' });
    expect(payloads['step/start']).toMatchObject({ agentId: agent.id, step: 0 });
    expect(payloads['request/start']).toMatchObject({ agentId: agent.id, step: 1, model: 'mock-model' });
    expect(payloads['request/end']).toMatchObject({ agentId: agent.id, step: 1, err: null });
    expect(payloads['step/end']).toMatchObject({ agentId: agent.id, step: 0, toolCalls: 0 });
    expect(payloads['turn/end']).toMatchObject({ agentId: agent.id, ok: true, aborted: false });
    for (const d of disposers) d();
  });

  it('disposer 生效：dispose 后不再收到该事件', async () => {
    const agent = createTestAgent(fakeProvider(), new ToolRegistry(), 'sys', {});
    let seen = 0;
    const d = agent.onLoopEvent('turn/start', () => {
      seen++;
    });
    d();
    await agent.run(new AbortController().signal, 'hi');
    expect(seen).toBe(0);
  });
});

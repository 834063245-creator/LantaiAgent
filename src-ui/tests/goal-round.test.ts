// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Agent.runGoalRound（DSH goal 驱动器的执行原语）：一轮 = goal/round 准入事件 +
// `<goal_round>` 用户消息 + 工具循环。轮数只由准入事件推进，由 foldGoal 严格回放。

import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/agent/agent';
import { foldGoal } from '../src/agent/goal/fold';
import { createGoal, type GoalHost, pauseGoal, readGoal } from '../src/agent/goal/service';
import type { Tool } from '../src/agent/tool';
import { ToolRegistry } from '../src/agent/tool';
import type { Chunk, Provider } from '../src/provider/types';
import { ChunkType } from '../src/provider/types';
import { createTestAgent } from './helpers/agent';
import { ensureProductionChannelsBooted } from './helpers/composition-boot';

await ensureProductionChannelsBooted();

const USAGE = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  cache_hit_tokens: 0,
  cache_miss_tokens: 10,
  reasoning_tokens: 0,
  cache_creation_tokens: 0,
  finish_reason: 'stop',
} as const;

function textTurn(text: string): Chunk[] {
  return [{ type: ChunkType.Usage, usage: USAGE }, { type: ChunkType.Text, text }, { type: ChunkType.Done }];
}

function steppedProvider(turns: Chunk[][]): Provider {
  let i = 0;
  return {
    name: () => 'mock',
    model: () => 'mock',
    stream: async function* (signal: AbortSignal) {
      for (const c of turns[i++] ?? [{ type: ChunkType.Done }]) {
        if (signal.aborted) break;
        yield c;
      }
    },
  };
}

function makeAgent(provider: Provider): Agent {
  const reg = new ToolRegistry();
  reg.register({
    name: () => 'read_file_content',
    description: () => 'read',
    parameters: () => ({ type: 'object', properties: {}, required: [] }),
    readOnly: () => true,
    execute: async () => 'ok',
  } satisfies Tool);
  return createTestAgent(provider, reg, 'system');
}

function hostOf(agent: Agent): GoalHost {
  return agent as unknown as GoalHost;
}

describe('Agent.runGoalRound', () => {
  it('一轮：准入事件 + <goal_round> 消息 + 轮数推进', async () => {
    const agent = makeAgent(steppedProvider([textTurn('第一步完成')]));
    createGoal(hostOf(agent), { objective: '修完门禁' });

    await agent.runGoalRound(new AbortController().signal);

    const log = agent.getSessionLog();
    const roundEvents = log.events().filter((e) => e.kind === 'goal/round');
    expect(roundEvents).toHaveLength(1);
    expect(roundEvents[0]?.data).toMatchObject({ round: 1 });
    expect(foldGoal(log.events()).current?.roundsStarted).toBe(1);

    const sessionText = agent
      .getSession()
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(sessionText).toContain('<goal_round>');
    expect(sessionText).toContain('Round: 1/256');
    expect(sessionText).toContain('修完门禁');
  });

  it('第二轮轮号 +1；paused 后拒绝开轮', async () => {
    const agent = makeAgent(steppedProvider([textTurn('a'), textTurn('b')]));
    const host = hostOf(agent);
    createGoal(host, { objective: 'x' });
    await agent.runGoalRound(new AbortController().signal);
    await agent.runGoalRound(new AbortController().signal);
    expect(foldGoal(agent.getSessionLog().events()).current?.roundsStarted).toBe(2);

    const view = readGoal(host);
    if (!view) throw new Error('no goal');
    pauseGoal(host, { id: view.id, revision: view.revision });
    await expect(agent.runGoalRound(new AbortController().signal)).rejects.toThrow(/not armed/);
  });

  it('未创建目标时拒绝（不凭空开轮）', async () => {
    const agent = makeAgent(steppedProvider([[{ type: ChunkType.Done }]]));
    await expect(agent.runGoalRound(new AbortController().signal)).rejects.toThrow(/no current goal/);
  });
});

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal 域工具（DSH tool-goal 移植）：执行期授权 + CAS + blocked 阈值。
// 考官对象 = 插件真源 goal-tools.ts（经 dev host 面直连内核服务）。

import { beforeEach, describe, expect, it } from 'vitest';
import type { RunKind } from '../src/agent/execution-state';
import { type GoalHost, readGoal, recordGoalRound } from '../src/agent/goal/service';
import { clearGoalHostsForTest, registerGoalHost } from '../src/agent/goal/session-registry';
import { SessionLog } from '../src/agent/session-log';
import { goalTools } from '../src/plugins/builtin/goal-mode/goal-tools';

class FakeHost implements GoalHost {
  readonly id = 'agent-goal-tools';
  readonly sessionId = '7';
  readonly parentId = null;
  readonly log = new SessionLog();
  kind: RunKind | null = null;
  getSessionLog(): SessionLog {
    return this.log;
  }
  currentRunKind(): RunKind | null {
    return this.kind;
  }
}

function tool(name: 'goal_get' | 'goal_create' | 'goal_update') {
  const found = goalTools().find((t) => t.name() === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function args(host: FakeHost, extra: Record<string, unknown> = {}) {
  return { _owner_id: host.id, ...extra };
}

function refOf(host: FakeHost) {
  const view = readGoal(host);
  if (!view) throw new Error('no goal');
  return { goal_id: view.id, revision: view.revision };
}

let host: FakeHost;
let disposer: () => void;

beforeEach(() => {
  clearGoalHostsForTest();
  host = new FakeHost();
  disposer = registerGoalHost(host);
});

describe('goal_get', () => {
  it('无目标返回 {goal:null}；有目标返回紧凑读形', async () => {
    host.kind = 'turn';
    expect(await tool('goal_get').execute(args(host))).toBe('{"goal":null}');
    await tool('goal_create').execute(args(host, { objective: '体检' }));
    const raw = JSON.parse(await tool('goal_get').execute(args(host))) as {
      goal: { objective: string; phase: string; roundsStarted: number };
      activation: string;
    };
    expect(raw.goal).toMatchObject({ objective: '体检', phase: 'active', roundsStarted: 0 });
    expect(raw.activation).toBe('armed');
  });

  it('未登记的 owner = 具名失败', async () => {
    await expect(tool('goal_get').execute({ _owner_id: 'ghost' })).rejects.toThrow(/host is not ready/);
  });
});

describe('goal_create 授权', () => {
  it('直人轮可创建；重复创建被 CAS 阶段拒绝', async () => {
    host.kind = 'turn';
    await tool('goal_create').execute(args(host, { objective: 'a' }));
    await expect(tool('goal_create').execute(args(host, { objective: 'b' }))).rejects.toThrow(/already exists/);
  });

  it('目标轮里不可创建（直人授权）', async () => {
    host.kind = 'goal';
    await expect(tool('goal_create').execute(args(host, { objective: 'a' }))).rejects.toThrow(/direct human/);
  });

  it('父 Agent（子 Agent）不可操作目标', async () => {
    const child = new FakeHost();
    (child as { parentId: string | null }).parentId = 'parent';
    disposer();
    disposer = registerGoalHost(child);
    child.kind = 'turn';
    await expect(tool('goal_create').execute(args(child, { objective: 'a' }))).rejects.toThrow(/direct human/);
  });
});

describe('goal_update', () => {
  it('pause 直人轮生效；paused 的 resume 模型不可做（人用 /goal resume）', async () => {
    host.kind = 'turn';
    await tool('goal_create').execute(args(host, { objective: 'a' }));
    const ref = refOf(host);
    const paused = JSON.parse(await tool('goal_update').execute(args(host, { ...ref, update_action: 'pause' }))) as {
      goal: { phase: string };
    };
    expect(paused.goal.phase).toBe('paused');

    const pausedRef = refOf(host);
    await expect(tool('goal_update').execute(args(host, { ...pausedRef, update_action: 'resume' }))).rejects.toThrow(
      /cannot resume a paused goal/,
    );
  });

  it('complete 可在目标轮里做，并附收尾指令', async () => {
    host.kind = 'turn';
    await tool('goal_create').execute(args(host, { objective: 'a' }));
    host.kind = 'goal';
    const out = await tool('goal_update').execute(args(host, { ...refOf(host), update_action: 'complete' }));
    expect(out).toContain('"phase":"complete"');
    expect(out).toContain('收尾消息');
  });

  it('blocked：目标轮里必须已满 3 轮，且必须给原因', async () => {
    host.kind = 'turn';
    await tool('goal_create').execute(args(host, { objective: 'a' }));
    host.kind = 'goal';
    await expect(tool('goal_update').execute(args(host, { ...refOf(host), update_action: 'blocked' }))).rejects.toThrow(
      /blocked_reason is required/,
    );
    await expect(
      tool('goal_update').execute(args(host, { ...refOf(host), update_action: 'blocked', blocked_reason: '缺凭据' })),
    ).rejects.toThrow(/at least 3 consecutive goal rounds/);

    recordGoalRound(host, 1);
    recordGoalRound(host, 2);
    recordGoalRound(host, 3);
    const out = await tool('goal_update').execute(
      args(host, { ...refOf(host), update_action: 'blocked', blocked_reason: '缺凭据' }),
    );
    expect(out).toContain('"phase":"blocked"');
    expect(out).toContain('model-reported');
  });

  it('直人轮可以立即 blocked（阈值只约束自动轮）', async () => {
    host.kind = 'turn';
    await tool('goal_create').execute(args(host, { objective: 'a' }));
    const out = await tool('goal_update').execute(
      args(host, { ...refOf(host), update_action: 'blocked', blocked_reason: '缺凭据' }),
    );
    expect(out).toContain('"phase":"blocked"');
  });

  it('陈旧 revision 被拒（CAS）', async () => {
    host.kind = 'turn';
    await tool('goal_create').execute(args(host, { objective: 'a' }));
    const stale = refOf(host);
    await tool('goal_update').execute(args(host, { ...stale, update_action: 'pause' }));
    await expect(tool('goal_update').execute(args(host, { ...stale, update_action: 'complete' }))).rejects.toThrow(
      /stale goal ref/,
    );
  });

  it('edit 需要目标文本；不允许夹带 blocked_reason', async () => {
    host.kind = 'turn';
    await tool('goal_create').execute(args(host, { objective: 'a' }));
    await expect(tool('goal_update').execute(args(host, { ...refOf(host), update_action: 'edit' }))).rejects.toThrow(
      /edit requires objective/,
    );
    await expect(
      tool('goal_update').execute(
        args(host, { ...refOf(host), update_action: 'edit', objective: 'b', blocked_reason: 'x' }),
      ),
    ).rejects.toThrow(/only with blocked/);
  });
});

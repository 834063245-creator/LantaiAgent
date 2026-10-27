// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal 服务（DSH goal 栈移植 P2）：CAS 修订、阶段机、进程本地 activation、
// 轮记账。考官对象 = agent/goal/service.ts；宿主用最小桩（不依赖 Agent）。

import { describe, expect, it } from 'vitest';
import type { RunKind } from '../src/agent/execution-state';
import {
  blockGoal,
  clearGoal,
  completeGoal,
  createGoal,
  DEFAULT_MAX_GOAL_ROUNDS,
  disarmGoal,
  editGoal,
  type GoalHost,
  goalActivationOf,
  pauseGoal,
  readGoal,
  recordGoalRound,
  resumeGoal,
} from '../src/agent/goal/service';
import { SessionLog } from '../src/agent/session-log';

class FakeHost implements GoalHost {
  readonly id: string;
  readonly sessionId = '1';
  readonly parentId: string | null = null;
  readonly log = new SessionLog();
  kind: RunKind | null = null;
  constructor(id = 'agent-1') {
    this.id = id;
  }
  getSessionLog(): SessionLog {
    return this.log;
  }
  currentRunKind(): RunKind | null {
    return this.kind;
  }
}

function refOf(host: FakeHost) {
  const view = readGoal(host);
  if (!view) throw new Error('no goal');
  return { id: view.id, revision: view.revision };
}

describe('goal 服务 · 创建与 CAS', () => {
  it('create → active/revision 1/0 轮，并 arm', () => {
    const host = new FakeHost();
    const view = createGoal(host, { objective: '  修完门禁  ' });
    expect(view).toMatchObject({
      revision: 1,
      phase: 'active',
      roundsStarted: 0,
      objective: '修完门禁',
      maxGoalRounds: DEFAULT_MAX_GOAL_ROUNDS,
      activation: 'armed',
    });
    expect(goalActivationOf(host)).toBe('armed');
  });

  it('未完成的目标不可再次 create；complete 后可替换', () => {
    const host = new FakeHost();
    createGoal(host, { objective: 'a' });
    expect(() => createGoal(host, { objective: 'b' })).toThrowError(/already exists/);
    completeGoal(host, refOf(host));
    const next = createGoal(host, { objective: 'b' });
    expect(next.objective).toBe('b');
  });

  it('edit 走 CAS：陈旧 revision 拒绝，新 revision 生效', () => {
    const host = new FakeHost();
    const created = createGoal(host, { objective: 'a' });
    const edited = editGoal(host, { id: created.id, revision: created.revision }, { objective: 'b' });
    expect(edited).toMatchObject({ revision: 2, objective: 'b', phase: 'active' });
    expect(() => editGoal(host, { id: created.id, revision: created.revision }, { objective: 'c' })).toThrowError(
      /stale goal ref/,
    );
  });

  it('edit 不得把上限压到已用轮数以下', () => {
    const host = new FakeHost();
    const created = createGoal(host, { objective: 'a', maxGoalRounds: 3 });
    recordGoalRound(host, 1);
    recordGoalRound(host, 2);
    recordGoalRound(host, 3);
    expect(() => editGoal(host, { id: created.id, revision: created.revision }, { maxGoalRounds: 2 })).toThrowError(
      /lower than rounds/,
    );
  });
});

describe('goal 服务 · 阶段机与 activation', () => {
  it('pause 停用续行；resume 重新 arm 并 bump revision', () => {
    const host = new FakeHost();
    const created = createGoal(host, { objective: 'a' });
    const paused = pauseGoal(host, { id: created.id, revision: created.revision });
    expect(paused).toMatchObject({ phase: 'paused', revision: 2, activation: 'disarmed' });
    const resumed = resumeGoal(host, { id: paused.id, revision: paused.revision });
    expect(resumed).toMatchObject({ phase: 'active', revision: 3, activation: 'armed' });
  });

  it('轮预算耗尽后 resume 拒绝（GOAL_ROUND_EXHAUSTED）', () => {
    const host = new FakeHost();
    const created = createGoal(host, { objective: 'a', maxGoalRounds: 1 });
    recordGoalRound(host, 1);
    const paused = pauseGoal(host, { id: created.id, revision: created.revision });
    expect(() => resumeGoal(host, { id: paused.id, revision: paused.revision })).toThrowError(/exhausted 1 rounds/);
  });

  it('blocked 必须带 lower-kebab-case 原因；resume 清掉原因', () => {
    const host = new FakeHost();
    const created = createGoal(host, { objective: 'a' });
    expect(() =>
      blockGoal(host, { id: created.id, revision: created.revision }, { code: 'Bad_Code', message: 'x' }),
    ).toThrowError(/lower-kebab-case/);
    const blocked = blockGoal(
      host,
      { id: created.id, revision: created.revision },
      {
        code: 'missing-credential',
        message: '缺 API key',
      },
    );
    expect(blocked).toMatchObject({ phase: 'blocked', blockedReason: { code: 'missing-credential' } });
    const resumed = resumeGoal(host, { id: blocked.id, revision: blocked.revision });
    expect(resumed.phase).toBe('active');
    expect(resumed.blockedReason).toBeUndefined();
  });

  it('complete 停用续行；clear 写墓碑并清空读形', () => {
    const host = new FakeHost();
    const created = createGoal(host, { objective: 'a' });
    completeGoal(host, { id: created.id, revision: created.revision });
    expect(goalActivationOf(host)).toBe('disarmed');
    expect(readGoal(host)?.phase).toBe('complete');

    const ref = refOf(host);
    clearGoal(host, ref);
    expect(readGoal(host)).toBeUndefined();
  });

  it('activation 是进程本地：同一日志换一个宿主 = disarmed', () => {
    const a = new FakeHost('agent-a');
    createGoal(a, { objective: 'a' });
    expect(goalActivationOf(a)).toBe('armed');

    const b = new FakeHost('agent-b');
    // 模拟恢复：把同一份事件搬进新宿主（新进程/新句柄）
    for (const ev of a.log.events()) b.log.appendEvent(ev);
    expect(readGoal(b)?.phase).toBe('active');
    expect(readGoal(b)?.activation).toBe('disarmed');
  });

  it('disarmGoal 只停续行、不改持久阶段', () => {
    const host = new FakeHost();
    createGoal(host, { objective: 'a' });
    disarmGoal(host);
    expect(readGoal(host)).toMatchObject({ phase: 'active', activation: 'disarmed' });
  });
});

describe('goal 服务 · 轮记账与损坏', () => {
  it('recordGoalRound 推进轮数，读形带轮号', () => {
    const host = new FakeHost();
    createGoal(host, { objective: 'a' });
    recordGoalRound(host, 1);
    recordGoalRound(host, 2);
    expect(readGoal(host)?.roundsStarted).toBe(2);
  });

  it('轮号越过上限时折叠拒绝（服务读形 fail-closed）', () => {
    const host = new FakeHost();
    createGoal(host, { objective: 'a', maxGoalRounds: 1 });
    recordGoalRound(host, 1);
    host.log.append('goal/round', { goalId: readGoal(host)!.id, revision: 1, round: 2 });
    expect(() => readGoal(host)).toThrowError(/corrupt/);
  });

  it('坏 revision 的变更事件 = GOAL_LOG_CORRUPT', () => {
    const host = new FakeHost();
    createGoal(host, { objective: 'a' });
    const created = readGoal(host)!;
    host.log.append('goal/change', {
      operation: 'edit',
      goal: {
        id: created.id,
        revision: 9,
        objective: created.objective,
        phase: 'active',
        maxGoalRounds: created.maxGoalRounds,
      },
      roundsStarted: 0,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt + 1,
    });
    expect(() => readGoal(host)).toThrowError(/corrupt/);
  });

  it('轮事件形状非法 = 损坏（不静默清洗）', () => {
    const host = new FakeHost();
    createGoal(host, { objective: 'a' });
    host.log.append('goal/round', { goalId: readGoal(host)!.id, revision: 1, round: 0 });
    expect(() => readGoal(host)).toThrowError(/corrupt/);
  });
});

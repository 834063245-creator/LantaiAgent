// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal 折叠（DSH goal 栈移植 P1）：会话日志里的 goal/change + goal/round
// 严格回放规则。考官对象 = agent/goal/fold.ts 的 foldGoal（单一 fold）；
// 用例按 DSH fold 的规则逐条对位，坏事件一律 failure 而不是静默清洗。

import { describe, expect, it } from 'vitest';
import { foldGoal } from '../src/agent/goal/fold';
import type { GoalChangeData, GoalPhase, GoalRoundData } from '../src/agent/goal/types';
import { SessionLog } from '../src/agent/session-log';

const T0 = 1_700_000_000_000;

type GoalStep = { kind: 'goal/change'; data: GoalChangeData } | { kind: 'goal/round'; data: GoalRoundData };

const gc = (data: GoalChangeData): GoalStep => ({ kind: 'goal/change', data });
const gr = (data: GoalRoundData): GoalStep => ({ kind: 'goal/round', data });

function change(
  operation: Exclude<GoalChangeData['operation'], 'clear'>,
  revision: number,
  phase: GoalPhase,
  opts: {
    roundsStarted?: number;
    maxGoalRounds?: number;
    blockedReason?: { code: string; message: string };
    updatedAt?: number;
    id?: string;
  } = {},
): GoalChangeData {
  return {
    operation,
    goal: {
      id: opts.id ?? 'goal-1',
      revision,
      objective: 'ship it',
      phase,
      maxGoalRounds: opts.maxGoalRounds ?? 8,
      ...(opts.blockedReason === undefined ? {} : { blockedReason: opts.blockedReason }),
    },
    roundsStarted: opts.roundsStarted ?? 0,
    createdAt: T0,
    updatedAt: opts.updatedAt ?? T0 + revision,
  };
}

function created(): GoalChangeData {
  return change('create', 1, 'active');
}

function round(n: number, revision = 1): GoalRoundData {
  return { goalId: 'goal-1', revision, round: n };
}

/** 建一条含 init reset 的日志，再按序追加目标事件。 */
function logWith(...steps: GoalStep[]): SessionLog {
  const log = new SessionLog();
  log.append('session/reset', { messages: [{ role: 'system', content: 'sys' }], reason: 'init' });
  for (const step of steps) {
    if (step.kind === 'goal/change') log.append('goal/change', step.data);
    else log.append('goal/round', step.data);
  }
  return log;
}

describe('goal 折叠 · 创建与修订', () => {
  it('create 建立 active 目标，轮数从 0 起', () => {
    const log = new SessionLog();
    log.append('goal/change', created());
    const p = foldGoal(log.events());
    expect(p.failure).toBeNull();
    expect(p.current).toMatchObject({ roundsStarted: 0, goal: { id: 'goal-1', revision: 1, phase: 'active' } });
  });

  it('edit 只改字段、不改阶段与轮数（revision 连续 +1）', () => {
    const log = logWith(gc(created()), gc(change('edit', 2, 'active', { maxGoalRounds: 12 })));
    const p = foldGoal(log.events());
    expect(p.failure).toBeNull();
    expect(p.current?.goal.revision).toBe(2);
    expect(p.current?.goal.maxGoalRounds).toBe(12);
    expect(p.current?.goal.phase).toBe('active');
  });

  it('revision 跳号 = failure（保留最后一个合法快照）', () => {
    const log = logWith(gc(created()), gc(change('edit', 3, 'active')));
    const p = foldGoal(log.events());
    expect(p.failure).toContain('revision');
    expect(p.current?.goal.revision).toBe(1);
  });

  it('未完成的当前目标不可被 create 替换', () => {
    const log = logWith(gc(created()), gc(change('create', 1, 'active', { id: 'goal-2' })));
    expect(foldGoal(log.events()).failure).toContain('create');
  });

  it('complete 之后可以被新目标替换（新 revision 从 1 起）', () => {
    const log = logWith(
      gc(created()),
      gc(change('complete', 2, 'complete')),
      gc(change('create', 1, 'active', { id: 'goal-2' })),
    );
    const p = foldGoal(log.events());
    expect(p.failure).toBeNull();
    expect(p.current?.goal.id).toBe('goal-2');
  });
});

describe('goal 折叠 · 阶段转移', () => {
  it('active → paused → resume → complete 合法', () => {
    const log = logWith(
      gc(created()),
      gc(change('pause', 2, 'paused')),
      gc(change('resume', 3, 'active')),
      gc(change('complete', 4, 'complete')),
    );
    const p = foldGoal(log.events());
    expect(p.failure).toBeNull();
    expect(p.current?.goal.phase).toBe('complete');
  });

  it('从 complete 再 resume = failure', () => {
    const log = logWith(gc(created()), gc(change('complete', 2, 'complete')), gc(change('resume', 3, 'active')));
    expect(foldGoal(log.events()).failure).toContain('resume');
  });

  it('edit 不得夹带阶段变化', () => {
    const log = logWith(gc(created()), gc(change('edit', 2, 'paused')));
    expect(foldGoal(log.events()).failure).toContain('phase');
  });

  it('blocked 必须带原因，非 blocked 不得带原因', () => {
    const missing = logWith(gc(created()), gc(change('block', 2, 'blocked')));
    expect(foldGoal(missing.events()).failure).toContain('blockedReason');

    const extra = logWith(
      gc(created()),
      gc(change('block', 2, 'blocked', { blockedReason: { code: 'round-limit', message: 'x' } })),
      gc(change('resume', 3, 'active', { blockedReason: { code: 'round-limit', message: 'x' } })),
    );
    expect(foldGoal(extra.events()).failure).toContain('blockedReason');
  });

  it('blocked 原因 code 必须 lower-kebab-case', () => {
    const log = logWith(
      gc(created()),
      gc(change('block', 2, 'blocked', { blockedReason: { code: 'Round_Limit', message: 'x' } })),
    );
    expect(foldGoal(log.events()).failure).toContain('kebab');
  });
});

describe('goal 折叠 · 轮记账', () => {
  it('轮必须连续 +1，且只能落在当前 revision 上', () => {
    const ok = logWith(gc(created()), gr(round(1)), gr(round(2)));
    expect(foldGoal(ok.events()).current?.roundsStarted).toBe(2);

    const gap = logWith(gc(created()), gr(round(2)));
    expect(foldGoal(gap.events()).failure).toContain('consecutive');

    const stale = logWith(gc(created()), gr(round(1, 2)));
    expect(foldGoal(stale.events()).failure).toContain('revision');
  });

  it('轮数不得超过 maxGoalRounds', () => {
    const log = logWith(
      gc(change('create', 1, 'active', { maxGoalRounds: 2 })),
      gr(round(1)),
      gr(round(2)),
      gr(round(3)),
    );
    const p = foldGoal(log.events());
    expect(p.failure).toContain('limit');
    expect(p.current?.roundsStarted).toBe(2);
  });

  it('轮预算耗尽的目标不可 resume', () => {
    const log = logWith(
      gc(change('create', 1, 'active', { maxGoalRounds: 1 })),
      gr(round(1)),
      gc(change('pause', 2, 'paused', { maxGoalRounds: 1, roundsStarted: 1 })),
      gc(change('resume', 3, 'active', { maxGoalRounds: 1, roundsStarted: 1 })),
    );
    expect(foldGoal(log.events()).failure).toContain('budget');
  });

  it('edit 把上限降到已用轮数以下 = failure', () => {
    const log = logWith(gc(created()), gr(round(1)), gc(change('edit', 2, 'active', { maxGoalRounds: 0 })));
    expect(foldGoal(log.events()).failure).not.toBeNull();
  });
});

describe('goal 折叠 · 清除与无关事件', () => {
  it('clear 墓碑清空当前目标，之后可再 create', () => {
    const log = logWith(
      gc(created()),
      gc({ operation: 'clear', cleared: { id: 'goal-1', revision: 2 }, clearedAt: T0 + 10 }),
    );
    expect(foldGoal(log.events()).current).toBeNull();

    log.append('goal/change', change('create', 1, 'active', { id: 'goal-2' }));
    expect(foldGoal(log.events()).current?.goal.id).toBe('goal-2');
  });

  it('clear 必须 bump 当前 revision', () => {
    const log = logWith(
      gc(created()),
      gc({ operation: 'clear', cleared: { id: 'goal-1', revision: 1 }, clearedAt: T0 + 10 }),
    );
    expect(foldGoal(log.events()).failure).toContain('clear');
  });

  it('session/reset 与 session/retract 不影响目标状态', () => {
    const log = logWith(gc(created()), gr(round(1)));
    log.append('session/reset', { messages: [{ role: 'system', content: 'next' }], reason: 'restore' });
    log.append('session/retract', { fromIndex: 0, toIndex: 1 });
    const p = foldGoal(log.events());
    expect(p.failure).toBeNull();
    expect(p.current?.roundsStarted).toBe(1);
  });

  it('坏形状事件 = failure（不静默清洗）', () => {
    const log = logWith(gc(created()));
    log.append('goal/round', { goalId: 'goal-1', revision: 1, round: 'x' } as unknown as GoalRoundData);
    expect(foldGoal(log.events()).failure).toContain('round');
  });
});

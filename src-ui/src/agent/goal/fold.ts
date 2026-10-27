// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal 折叠 — 会话日志里的目标状态严格回放（2026-10-23，DSH goal 栈移植 P1）。
//
// 单一 fold：`goal/change`（完整快照/墓碑）是持久状态唯一来源，`goal/round`
// （轮准入）只推进正数轮号。规则逐条对位 DSH `packages/goal/goal/src/fold.ts`：
//   - revision 必须连续 +1；阶段转移必须合法；resume 受轮预算约束；
//   - blockedReason 恰好且只在 blocked 阶段存在，code 必须 lower-kebab-case；
//   - roundsStarted 只由轮事件推进，且严格 +1、不得超过 maxGoalRounds；
//   - 时间戳单调（updatedAt 不倒退；edit 不改 createdAt）；
//   - 首次非法 ⇒ failure 记在首个失败事件 seq 上，保留最后一个合法快照
//     （读面 fail-closed，普通会话不受影响）。
//
// 事件形状来自 JSON 盘面，一律运行时校验（不 `as` 强转）——坏事件 = failure，
// 不是静默清洗（错误不静默）。

import type { SessionEvent } from '../session-log';
import type { GoalBlockReason, GoalChangeData, GoalPhase, GoalProjection, GoalRoundData, GoalSnapshot } from './types';

const PHASES: readonly GoalPhase[] = ['active', 'paused', 'blocked', 'complete'];
const TRANSITIONS: Record<'pause' | 'resume' | 'complete' | 'block', { from: readonly GoalPhase[]; to: GoalPhase }> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['active', 'paused', 'blocked'], to: 'active' },
  complete: { from: ['active', 'paused', 'blocked'], to: 'complete' },
  block: { from: ['active'], to: 'blocked' },
};

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function nonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** lower-kebab-case（DSH 同款正则）：策略代码可路由、可比较。 */
const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function readBlockReason(v: unknown): GoalBlockReason | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) fail('blockedReason must be an object');
  if (!nonEmptyString(v.code) || !KEBAB.test(v.code)) fail('blockedReason.code must be lower-kebab-case');
  if (!nonEmptyString(v.message) || v.message.trim().length === 0) fail('blockedReason.message must be non-empty');
  return { code: v.code, message: v.message.trim() };
}

/** 完整快照形状校验（含 blockedReason 与阶段的一致性）。 */
function readSnapshot(v: unknown): GoalSnapshot {
  if (!isRecord(v)) fail('goal snapshot must be an object');
  if (!nonEmptyString(v.id)) fail('goal.id must be a non-empty string');
  if (!positiveInt(v.revision)) fail('goal.revision must be a positive safe integer');
  if (!nonEmptyString(v.objective) || v.objective.trim().length === 0) fail('goal.objective must be non-empty');
  if (typeof v.phase !== 'string' || !PHASES.includes(v.phase as GoalPhase)) fail('goal.phase is invalid');
  const phase = v.phase as GoalPhase;
  if (!positiveInt(v.maxGoalRounds)) fail('goal.maxGoalRounds must be a positive safe integer');
  const blockedReason = readBlockReason(v.blockedReason);
  if (phase === 'blocked' && blockedReason === undefined) fail('blocked goal must carry blockedReason');
  if (phase !== 'blocked' && blockedReason !== undefined) fail('only a blocked goal may carry blockedReason');
  return {
    id: v.id,
    revision: v.revision,
    objective: v.objective,
    phase,
    maxGoalRounds: v.maxGoalRounds,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  };
}

/** goal/change 的形状校验（clear 墓碑与快照两态）。 */
function readChange(data: unknown): GoalChangeData {
  if (!isRecord(data)) fail('goal/change data must be an object');
  const operation = data.operation;
  if (operation === 'clear') {
    const cleared = data.cleared;
    if (!isRecord(cleared) || !nonEmptyString(cleared.id) || !positiveInt(cleared.revision)) {
      fail('goal/change clear must carry a cleared ref');
    }
    if (typeof data.clearedAt !== 'number' || !Number.isFinite(data.clearedAt)) fail('clear.clearedAt must be a time');
    return { operation: 'clear', cleared: { id: cleared.id, revision: cleared.revision }, clearedAt: data.clearedAt };
  }
  if (
    operation !== 'create' &&
    operation !== 'edit' &&
    operation !== 'pause' &&
    operation !== 'resume' &&
    operation !== 'complete' &&
    operation !== 'block'
  ) {
    fail('goal/change operation is invalid');
  }
  const goal = readSnapshot(data.goal);
  if (!nonNegativeInt(data.roundsStarted)) fail('goal.change.roundsStarted must be a non-negative integer');
  if (typeof data.createdAt !== 'number' || !Number.isFinite(data.createdAt)) fail('goal.createdAt must be a time');
  if (typeof data.updatedAt !== 'number' || !Number.isFinite(data.updatedAt)) fail('goal.updatedAt must be a time');
  if (data.roundsStarted > goal.maxGoalRounds) fail('goal rounds exceed its configured limit');
  return {
    operation,
    goal,
    roundsStarted: data.roundsStarted,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

/** goal/round 的形状校验。 */
function readRound(data: unknown): GoalRoundData {
  if (!isRecord(data)) fail('goal/round data must be an object');
  if (!nonEmptyString(data.goalId)) fail('goal/round goalId must be non-empty');
  if (!positiveInt(data.revision)) fail('goal/round revision must be positive');
  if (!positiveInt(data.round)) fail('goal/round round must be positive');
  return { goalId: data.goalId, revision: data.revision, round: data.round };
}

function requireCurrent(state: GoalProjection): NonNullable<GoalProjection['current']> {
  if (state.current === null) fail('goal mutation without a current goal');
  return state.current;
}

function applyChange(state: GoalProjection, data: GoalChangeData): void {
  if (data.operation === 'clear') {
    const current = requireCurrent(state);
    if (data.cleared.id !== current.goal.id || data.cleared.revision !== current.goal.revision + 1) {
      fail('goal clear must bump the exact current revision');
    }
    if (data.clearedAt < current.updatedAt) fail('goal clear timestamp moved backwards');
    state.current = null;
    return;
  }

  const goal = data.goal;
  if (data.operation === 'create') {
    if (state.current !== null && state.current.goal.phase !== 'complete') {
      fail('goal create requires no current goal (or a completed one)');
    }
    if (goal.revision !== 1) fail('created goal revision must be 1');
    if (goal.phase !== 'active') fail('created goal must be active');
    if (data.roundsStarted !== 0) fail('created goal starts with zero rounds');
    if (data.updatedAt < data.createdAt) fail('created goal update precedes creation');
    state.current = { goal, roundsStarted: 0, createdAt: data.createdAt, updatedAt: data.updatedAt };
    return;
  }

  const current = requireCurrent(state);
  if (goal.id !== current.goal.id) fail('goal mutation changed the goal id');
  if (goal.revision !== current.goal.revision + 1) fail('goal revision must increment by exactly one');
  if (data.createdAt !== current.createdAt) fail('goal mutation changed createdAt');
  if (data.updatedAt < current.updatedAt) fail('goal timestamp moved backwards');
  if (data.roundsStarted !== current.roundsStarted) fail('only goal rounds may advance roundsStarted');

  if (data.operation === 'edit') {
    if (goal.phase !== current.goal.phase) fail('goal edit may not change the phase');
  } else {
    const spec = TRANSITIONS[data.operation];
    if (!spec.from.includes(current.goal.phase) || goal.phase !== spec.to) {
      fail(`cannot ${data.operation} a goal from phase "${current.goal.phase}"`);
    }
  }
  if (data.operation === 'resume' && current.roundsStarted >= goal.maxGoalRounds) {
    fail('resuming a goal requires remaining round budget');
  }
  state.current = {
    goal,
    roundsStarted: current.roundsStarted,
    createdAt: current.createdAt,
    updatedAt: data.updatedAt,
  };
}

function applyRound(state: GoalProjection, data: GoalRoundData): void {
  const current = requireCurrent(state);
  if (data.goalId !== current.goal.id || data.revision !== current.goal.revision) {
    fail('goal round must belong to the exact current goal revision');
  }
  if (data.round !== current.roundsStarted + 1) fail('goal rounds must be admitted consecutively');
  if (data.round > current.goal.maxGoalRounds) fail('goal round exceeds its configured limit');
  state.current = { ...current, roundsStarted: data.round };
}

/**
 * 严格回放整个会话日志，得到当前目标 + 首次失败。
 *
 * 纯函数；O(事件数)（与 `deriveMessages` 同族，未做增量缓存）。
 * failure 非 null 时调用方必须拒绝目标访问（fail-closed），但不得影响普通会话。
 */
export function foldGoal(events: readonly SessionEvent[]): GoalProjection {
  const state: GoalProjection = { current: null, failure: null };
  for (const ev of events) {
    if (state.failure !== null) break;
    try {
      if (ev.kind === 'goal/change') applyChange(state, readChange(ev.data));
      else if (ev.kind === 'goal/round') applyRound(state, readRound(ev.data));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      state.failure = `goal replay failed at session event ${ev.seq}: ${message}`;
    }
  }
  return state;
}

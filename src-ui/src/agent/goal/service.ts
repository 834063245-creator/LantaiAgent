// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal 服务 — 每卷一个持久目标的状态机（2026-10-23，DSH goal 栈移植 P2）。
//
// 对位 DSH `packages/goal/goal/src/index.ts` 的 GoalService：
//   - 持久状态唯一来源 = 会话日志（goal/change 事件，foldGoal 读）；
//   - 变更一律 CAS（`{id, revision}`），陈旧引用报 GOAL_STALE_REVISION；
//   - 阶段：active / paused / blocked / complete；complete 可被新目标替换；
//   - activation（armed/disarmed）是**进程本地**的，永不持久化——重启/恢复/fork
//     后一律 disarmed，只有人 `/goal resume` 才重新授权自动续行。
//
// 归属：服务是纯函数 + 两张进程级键控表（宿主登记在 session-registry、activation
// 在本文件），不持有 Agent 之外的运行时；宿主（Agent）自己登记，工具经
// `_owner_id` 取用。插件不持内核实现：goal 工具产物经 `./host` 桥调用本模块。

import type { RunKind } from '../execution-state';
import type { SessionEventDataMap, SessionLog } from '../session-log';
import { foldGoal } from './fold';
import {
  type GoalActivation,
  type GoalBlockReason,
  GoalError,
  type GoalProjection,
  type GoalRef,
  type GoalSnapshot,
  type GoalView,
} from './types';

/** 部署默认轮上限（DSH 默认 256）。 */
export const DEFAULT_MAX_GOAL_ROUNDS = 256;
/** 模型自报 blocked 前必须经过的连续轮数（DSH 默认 3）。 */
export const DEFAULT_BLOCKED_MIN_ROUNDS = 3;

/** 目标宿主的最小面（Agent 实现；测试可给桩）。 */
export interface GoalHost {
  /** bus id = executor 注入的 `_owner_id`。 */
  readonly id: string;
  /** 会话卷号（string 形态，与 ownerSessionId 同源）。 */
  readonly sessionId: string;
  /** 顶层 Agent（无父）才持有可被模型驱动的目标。 */
  readonly parentId: string | null;
  /** 本卷事件日志（目标状态的持久真源）。 */
  getSessionLog(): SessionLog;
  /** 当前运行种类；空闲 = null。 */
  currentRunKind(): RunKind | null;
}

/** 宿主是否顶层（子 Agent 不得操作目标）。 */
export function isTopLevelHost(host: GoalHost): boolean {
  return host.parentId === null;
}

/** 进程本地 activation 表：owner id → armed/disarmed。 */
const activation = new Map<string, GoalActivation>();

/** 读 activation（未登记 = disarmed）。 */
export function goalActivationOf(host: GoalHost): GoalActivation {
  return activation.get(host.id) ?? 'disarmed';
}

/** 置 activation（进程本地；不写日志、不发事件）。 */
export function setGoalActivation(host: GoalHost, next: GoalActivation): void {
  if (next === 'armed') activation.set(host.id, next);
  else activation.delete(host.id);
}

/** 宿主销毁时清 activation（session-registry 的 disposer 调用）。 */
export function forgetGoalActivation(ownerId: string): void {
  activation.delete(ownerId);
}

/** 读折叠态；损坏即 fail-closed（普通会话不受影响）。 */
function stateOf(host: GoalHost): GoalProjection {
  const projection = foldGoal(host.getSessionLog().events());
  if (projection.failure !== null) {
    throw new GoalError(`goal log is corrupt: ${projection.failure}`, 'GOAL_LOG_CORRUPT');
  }
  return projection;
}

function requireCurrent(state: GoalProjection): NonNullable<GoalProjection['current']> {
  if (state.current === null) throw new GoalError('no current goal', 'GOAL_NOT_FOUND');
  return state.current;
}

function expectRef(current: { goal: GoalSnapshot }, ref: GoalRef): void {
  if (ref.id !== current.goal.id || ref.revision !== current.goal.revision) {
    throw new GoalError(
      `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.goal.id}" revision ${current.goal.revision}`,
      'GOAL_STALE_REVISION',
    );
  }
}

function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE');
  }
  return value.trim();
}

function resolveMaxGoalRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer', 'GOAL_INVALID_MAX_ROUNDS');
  }
  return value;
}

/** 受阻原因：lower-kebab-case 代码 + 非空说明（与折叠校验同一把尺子）。 */
function resolveBlockReason(reason: GoalBlockReason): GoalBlockReason {
  const code = typeof reason?.code === 'string' ? reason.code : '';
  const message = typeof reason?.message === 'string' ? reason.message.trim() : '';
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code) || message.length === 0) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON',
    );
  }
  return { code, message };
}

/** 读形（快照 + 轮数/时间戳 + 进程本地 activation）。 */
function viewOf(host: GoalHost, state: GoalProjection): GoalView | undefined {
  if (state.current === null) return undefined;
  const { goal, roundsStarted, createdAt, updatedAt } = state.current;
  return { ...goal, roundsStarted, createdAt, updatedAt, activation: goalActivationOf(host) };
}

/** 读当前目标；无 = undefined。日志损坏抛 GOAL_LOG_CORRUPT。 */
export function readGoal(host: GoalHost): GoalView | undefined {
  return viewOf(host, stateOf(host));
}

/** 追加变更事件并回读（形状必须能被 foldGoal 严格接受）。 */
function commitChange(host: GoalHost, data: SessionEventDataMap['goal/change']): GoalProjection {
  host.getSessionLog().append('goal/change', data);
  return stateOf(host);
}

function nextTimestamp(state: NonNullable<GoalProjection['current']>): number {
  return Math.max(Date.now(), state.updatedAt);
}

/** 去掉受阻原因（离开 blocked 时必做：折叠要求原因恰好且只在 blocked 存在）。 */
function withoutBlocker(goal: GoalSnapshot): Omit<GoalSnapshot, 'blockedReason'> {
  const { blockedReason: _drop, ...rest } = goal;
  return rest;
}

/** 创建并 arm 一个目标（complete 的当前目标可被替换）。 */
export function createGoal(host: GoalHost, request: { objective: string; maxGoalRounds?: number }): GoalView {
  const state = stateOf(host);
  const current = state.current?.goal;
  if (current !== undefined && current.phase !== 'complete') {
    throw new GoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS');
  }
  const objective = resolveObjective(request.objective);
  const maxGoalRounds = resolveMaxGoalRounds(request.maxGoalRounds ?? DEFAULT_MAX_GOAL_ROUNDS);
  const now = Date.now();
  commitChange(host, {
    operation: 'create',
    goal: {
      id: `goal-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      revision: 1,
      objective,
      phase: 'active',
      maxGoalRounds,
    },
    roundsStarted: 0,
    createdAt: now,
    updatedAt: now,
  });
  setGoalActivation(host, 'armed');
  return requireView(host);
}

/** 改目标字段/上限（不改阶段与轮数；blocked 的原有原因保留）。 */
export function editGoal(
  host: GoalHost,
  ref: GoalRef,
  patch: { objective?: string; maxGoalRounds?: number },
): GoalView {
  const state = stateOf(host);
  const current = requireCurrent(state);
  expectRef(current, ref);
  if (patch.objective === undefined && patch.maxGoalRounds === undefined) {
    throw new GoalError('goal edit requires objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT');
  }
  const goal: GoalSnapshot = {
    ...current.goal,
    revision: current.goal.revision + 1,
    ...(patch.objective === undefined ? {} : { objective: resolveObjective(patch.objective) }),
    ...(patch.maxGoalRounds === undefined ? {} : { maxGoalRounds: resolveMaxGoalRounds(patch.maxGoalRounds) }),
  };
  if (goal.maxGoalRounds < current.roundsStarted) {
    throw new GoalError('maxGoalRounds cannot be lower than rounds already started', 'GOAL_INVALID_MAX_ROUNDS');
  }
  commitChange(host, {
    operation: 'edit',
    goal,
    roundsStarted: current.roundsStarted,
    createdAt: current.createdAt,
    updatedAt: nextTimestamp(current),
  });
  return requireView(host);
}

/** 暂停（停续行、保状态）。 */
export function pauseGoal(host: GoalHost, ref: GoalRef): GoalView {
  const state = stateOf(host);
  const current = requireCurrent(state);
  expectRef(current, ref);
  if (current.goal.phase !== 'active') {
    throw new GoalError(`cannot pause a goal from phase "${current.goal.phase}"`, 'GOAL_INVALID_TRANSITION');
  }
  commitChange(host, {
    operation: 'pause',
    goal: { ...withoutBlocker(current.goal), revision: current.goal.revision + 1, phase: 'paused' },
    roundsStarted: current.roundsStarted,
    createdAt: current.createdAt,
    updatedAt: nextTimestamp(current),
  });
  setGoalActivation(host, 'disarmed');
  return requireView(host);
}

/** 恢复并 arm（受剩余轮预算约束）。 */
export function resumeGoal(host: GoalHost, ref: GoalRef): GoalView {
  const state = stateOf(host);
  const current = requireCurrent(state);
  expectRef(current, ref);
  if (current.goal.phase !== 'active' && current.goal.phase !== 'paused' && current.goal.phase !== 'blocked') {
    throw new GoalError(`cannot resume a goal from phase "${current.goal.phase}"`, 'GOAL_INVALID_TRANSITION');
  }
  if (current.goal.phase === 'active' && goalActivationOf(host) === 'armed') {
    throw new GoalError(`goal "${current.goal.id}" is already active and armed`, 'GOAL_INVALID_TRANSITION');
  }
  if (current.roundsStarted >= current.goal.maxGoalRounds) {
    throw new GoalError(
      `goal "${current.goal.id}" exhausted ${current.goal.maxGoalRounds} rounds; raise maxGoalRounds first`,
      'GOAL_ROUND_EXHAUSTED',
    );
  }
  commitChange(host, {
    operation: 'resume',
    goal: { ...withoutBlocker(current.goal), revision: current.goal.revision + 1, phase: 'active' },
    roundsStarted: current.roundsStarted,
    createdAt: current.createdAt,
    updatedAt: nextTimestamp(current),
  });
  setGoalActivation(host, 'armed');
  return requireView(host);
}

/** 标记完成（停续行、终态）。 */
export function completeGoal(host: GoalHost, ref: GoalRef): GoalView {
  const state = stateOf(host);
  const current = requireCurrent(state);
  expectRef(current, ref);
  if (current.goal.phase !== 'active' && current.goal.phase !== 'paused' && current.goal.phase !== 'blocked') {
    throw new GoalError(`cannot complete a goal from phase "${current.goal.phase}"`, 'GOAL_INVALID_TRANSITION');
  }
  commitChange(host, {
    operation: 'complete',
    goal: { ...withoutBlocker(current.goal), revision: current.goal.revision + 1, phase: 'complete' },
    roundsStarted: current.roundsStarted,
    createdAt: current.createdAt,
    updatedAt: nextTimestamp(current),
  });
  setGoalActivation(host, 'disarmed');
  return requireView(host);
}

/** 标记受阻（必须带策略原因）。 */
export function blockGoal(host: GoalHost, ref: GoalRef, reason: GoalBlockReason): GoalView {
  const state = stateOf(host);
  const current = requireCurrent(state);
  expectRef(current, ref);
  if (current.goal.phase !== 'active') {
    throw new GoalError(`cannot block a goal from phase "${current.goal.phase}"`, 'GOAL_INVALID_TRANSITION');
  }
  commitChange(host, {
    operation: 'block',
    goal: {
      ...withoutBlocker(current.goal),
      revision: current.goal.revision + 1,
      phase: 'blocked',
      blockedReason: resolveBlockReason(reason),
    },
    roundsStarted: current.roundsStarted,
    createdAt: current.createdAt,
    updatedAt: nextTimestamp(current),
  });
  setGoalActivation(host, 'disarmed');
  return requireView(host);
}

/** 清除当前目标（墓碑进日志；历史保留）。 */
export function clearGoal(host: GoalHost, ref: GoalRef): void {
  const state = stateOf(host);
  const current = requireCurrent(state);
  expectRef(current, ref);
  host.getSessionLog().append('goal/change', {
    operation: 'clear',
    cleared: { id: current.goal.id, revision: current.goal.revision + 1 },
    clearedAt: nextTimestamp(current),
  });
  setGoalActivation(host, 'disarmed');
}

/** 只 disarm（停用自动续行，不写日志）——宿主暂停/失败收尾用。 */
export function disarmGoal(host: GoalHost): void {
  setGoalActivation(host, 'disarmed');
}

/** 追加一轮准入事件（Agent.runGoalRound 在追加 `<goal_round>` 消息后调用）。 */
export function recordGoalRound(host: GoalHost, round: number): void {
  const state = stateOf(host);
  const current = requireCurrent(state);
  host.getSessionLog().append('goal/round', {
    goalId: current.goal.id,
    revision: current.goal.revision,
    round,
  });
}

function requireView(host: GoalHost): GoalView {
  const view = readGoal(host);
  if (view === undefined) throw new Error('goal mutation committed without a current goal');
  return view;
}

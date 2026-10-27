// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal 域 · 纯类型（2026-10-23，DSH goal 栈移植 P1）。
//
// 本文件零运行时依赖：会话日志（session-log.ts）与 goal 折叠（goal/fold.ts）
// 共用同一套词汇；任何 import 都必须是 type-only。
//
// 词汇对位（DSH packages/goal/goal/src/types.ts）：
//   - GoalPhase        持久阶段（active/paused/blocked/complete）
//   - GoalActivation   进程本地续行授权（armed/disarmed）——**永不持久化**
//   - GoalRef          CAS 身份（id + revision）
//   - GoalSnapshot     变更事件携带的完整快照
//   - GoalView         快照 + 轮数/时间戳/activation（消费面读形）

/** 持久阶段。blocked 是唯一携带策略原因的阶段。 */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

/** 进程本地续行授权——重启/恢复/fork 后一律 disarmed。 */
export type GoalActivation = 'armed' | 'disarmed';

/** 比较并设置的变更身份。 */
export interface GoalRef {
  id: string;
  /** 正整数；每次持久变更 +1。 */
  revision: number;
}

/** 受阻原因：稳定 lower-kebab-case 代码 + 面向人/模型的说明。 */
export interface GoalBlockReason {
  code: string;
  message: string;
}

/** 变更事件携带的完整快照（clear 走墓碑，不带快照）。 */
export interface GoalSnapshot extends GoalRef {
  objective: string;
  phase: GoalPhase;
  /** 恰好且只在 phase === 'blocked' 时存在。 */
  blockedReason?: GoalBlockReason;
  /** 自动续行的总轮数上限。 */
  maxGoalRounds: number;
}

/** 一次非 clear 变更的完整载荷。 */
export interface GoalChange {
  /** 变更后的快照（含 id/revision）。 */
  goal: GoalSnapshot;
  /** 已准入轮数（轮事件推进；变更原样携带）。 */
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
}

/** clear 墓碑载荷（revision 比被清快照 +1）。 */
export interface GoalClearChange {
  operation: 'clear';
  /** 被清除目标的墓碑身份。 */
  cleared: GoalRef;
  clearedAt: number;
}

/** 变更种类。 */
export type GoalOperation = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear';

/** 非 clear 变更事件的数据形状（goal/change）。 */
export type GoalChangeData =
  | (GoalChange & { operation: Exclude<GoalOperation, 'clear'> })
  | (GoalClearChange & { operation: 'clear' });

/** 轮准入事件（goal/round）：`<goal_round>` 消息进入会话时追加，轮数只由它推进。 */
export interface GoalRoundData {
  goalId: string;
  revision: number;
  /** 正轮号 = 当前 roundsStarted + 1。 */
  round: number;
}

/** 折叠结果：最后一个合法快照 + 严格回放失败（fail-closed 读面）。 */
export interface GoalProjection {
  current: {
    goal: GoalSnapshot;
    roundsStarted: number;
    createdAt: number;
    updatedAt: number;
  } | null;
  /** 首次严格回放失败（非 null 时目标访问必须拒绝）。 */
  failure: string | null;
}

/** 消费面读形（快照 + 轮数 + 时间戳 + 进程本地授权）。 */
export interface GoalView extends GoalSnapshot {
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  activation: GoalActivation;
}

/** 稳定错误码（命令/工具错误面用，禁止暴露内部堆栈）。 */
export type GoalErrorCode =
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_TRANSITION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_UPDATE'
  | 'GOAL_ROUND_EXHAUSTED'
  | 'GOAL_LOG_CORRUPT'
  | 'GOAL_HOST_UNAVAILABLE'
  | 'GOAL_AUTHORITY_REQUIRED';

/** 领域拒绝（命令/工具把它翻成稳定错误文案，不外泄 id/revision 之外的内部态）。 */
export class GoalError extends Error {
  readonly code: GoalErrorCode;
  constructor(message: string, code: GoalErrorCode) {
    super(message);
    this.name = 'GoalError';
    this.code = code;
  }
}

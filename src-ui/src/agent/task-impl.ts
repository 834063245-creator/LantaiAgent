// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent/task-impl — 任务域实现登记表 + 门面（批 9h-5，2026-09-26）。
//
// 形状照抄批 6/7/9h 的接缝（`agent/skill-impl.ts` / `agent/memory-impl.ts`）：契约面住
// `agent/task-contract.ts`，实现由产物 `plugins/builtin/task-domain/` 在装载期登记；
// 内核与其它产物调用点改走下方门面，缺实现 = 具名 fail-loud。
//
// ⚠ 登记口纪律（2026-09-25 实机事故立法，§0.6）：产物侧登记**必须**经包内宿主桥
// （`./host` → faceDeps）取本文件的函数——直连内核模块路径会被 esbuild 内联成副本，
// 登记落进副本、内核读原件 ⇒ 单测全绿而实机炸（`MEMORY_DOMAIN_UNAVAILABLE` 先例）。
//
// 实例所有权：板 / 管理器的生命周期归**内核装配层**（`runtime.ts` 的 per-session 表与
// `workspace.ts` 的每卷管理器，随 `ctx.effect` 对称释放）——本表只出工厂，不缓存实例。

import type {
  TaskBoardFace,
  TaskBoardProxyFace,
  TaskBoardReadFace,
  TaskImplementation,
  TaskManagerFace,
} from './task-contract';
import type { Tool } from './tool';

// 登记表是**栈**（后注册胜 + 对称弹出，对齐 `composition/contribution-channel.ts` 的行语义）：
// 批 9h-5 实测——测试域的装配腰（`withFirstParty*Channel`）会加载并 dispose 贡献者 fiber，
// 单值登记会被那次 dispose 抹掉（同一测试里「腰跑完之后」的 Agent 装配随即撞
// TASK_DOMAIN_UNAVAILABLE）；栈式登记下，常驻登记（tests/setup.ts）不受后来者弹出波及。
const _impls: TaskImplementation[] = [];

/** 产物登记实现（`task-domain` 包装载期调用；测试域由 `tests/setup.ts` 复现）。 */
export function registerTaskImplementation(impl: TaskImplementation): void {
  _impls.push(impl);
}

/** 当前实现 = 栈顶（未登记 = null——诊断/测试面读用）。 */
export function activeTaskImplementation(): TaskImplementation | null {
  return _impls.at(-1) ?? null;
}

/** 对称撤销（产物 fiber dispose）：弹出**本 fiber 注册的那一层**，不波及更早的登记。 */
export function clearTaskImplementation(): void {
  _impls.pop();
}

/** 测试复位（清空整栈；生产不调用）。 */
export function resetTaskImplementationForTests(): void {
  _impls.length = 0;
}

/** 缺实现时的具名错误（fail-loud：不静默造空板让子代理账目消失）。 */
const TASK_DOMAIN_UNAVAILABLE =
  'TASK_DOMAIN_UNAVAILABLE: 任务域实现缺席——请确认内置产物 hologram/task-domain 已装载' +
  '（它由 loader 从产物通道装载）。';

function requireImpl(): TaskImplementation {
  const impl = activeTaskImplementation();
  if (!impl) throw new Error(TASK_DOMAIN_UNAVAILABLE);
  return impl;
}

/** 门面：造每卷任务管理器（`workspace.ts` 装配期调用）。 */
export function createTaskManager(): TaskManagerFace {
  return requireImpl().createTaskManager();
}

/** 门面：造会话级任务板（`runtime.ts` 按 sessionId 缓存）。 */
export function createTaskBoard(projectPath?: string, sessionId?: string): TaskBoardFace {
  return requireImpl().createTaskBoard(projectPath, sessionId);
}

/** 门面：造板代理（`runtime.ts` 每 Agent 一份，绑自身 id）。 */
export function createTaskBoardProxy(target: TaskBoardFace): TaskBoardProxyFace {
  return requireImpl().createTaskBoardProxy(target);
}

/** 门面：task 域五件工具（`capability-segments` 的 task-tools capability 调用）。 */
export function createTaskTools(mgr: TaskManagerFace): Tool[] {
  return requireImpl().createTaskTools(mgr);
}

/** 门面：板状态工具（`capability-segments` 的 board capability 调用）。 */
export function createBoardStatusTool(board: TaskBoardReadFace, agentId: () => string): Tool {
  return requireImpl().createBoardStatusTool(board, agentId);
}

export type {
  BoardEntry,
  BoardStatus,
  Task,
  TaskBoardFace,
  TaskBoardProxyFace,
  TaskImplementation,
  TaskManagerFace,
  TaskStatus,
} from './task-contract';

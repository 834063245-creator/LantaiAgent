// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// task 域契约面（批 9h-5，2026-09-26）——任务管理器 / 任务板 / 代理板 的形状真源。
//
// 背景（账② `task-domain` 696 行）：`agent/task.ts`（178）· `agent/task-board.ts`（319）·
// `agent/tools/board-status.ts`（78）三件实现随 `plugins/builtin/task-domain/` 包，
// 而这三件被**内核**与**另外三个产物包**读取 ⇒ 形状必须在搬运前上收内核：
//   - 内核读点：`runtime.ts`（造会话级板 + 代理板）· `workspace.ts`（造每卷 TaskManager）·
//     `context.ts` / `runtime/types.ts` / `agent-builder.ts` / `blueprint.ts` / `tool-rows.ts`
//     （`rowCtx.taskManager` 类型）· `ui/agent-panel-store.ts`（板条目读面）；
//   - 契约文件读点：`state-hooks-contract.ts`（hook 拿板）· `subagent-runtime-contract.ts`
//     （子代理运行时拿板）；
//   - 产物读点：`capability-segments`（十四项定义里造管理器与两工具族）·
//     `state-hooks` / `subagent-in-process`（类型）· `task-domain` 自身（工具族）。
//
// 分工纪律（对齐 skill/memory 两域先例，9h-3 / 9h-4）：
//   - **形状**（本文件）：类型 + 结构面接口，内核与产物双向可见；
//   - **工厂**（`agent/task-impl.ts`）：登记表 + 门面（缺实现具名 fail-loud）；
//   - **实现**（`plugins/builtin/task-domain/`）：类本体 + 工具工厂，装载期经宿主桥登记。
//
// 板实例的生命周期仍归内核装配层（`runtime.ts` 的 per-session 表 + `ctx.effect` 对称释放）——
// 实现只提供工厂，不持有实例（否则「每会话一块板」会退化成进程一块）。

import type { Tool } from './tool';

/** 任务状态（工具面词表，模型可见）。 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** 一条任务（`task_*` 工具族的存储形状）。 */
export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  detail: string;
  /** 创建时间戳。 */
  ts: number;
}

/** 任务管理器（每卷一个；`rowCtx.taskManager` 交给 task 工具族）。 */
export interface TaskManagerFace {
  /** 订阅变更（React `useSyncExternalStore` 语义）。 */
  subscribe(cb: () => void): () => void;
  /** 当前快照（稳定引用，变更时才换）。 */
  getSnapshot(): Task[];
  create(title: string, detail: string): Task;
  update(id: number, updates: { title?: string; status?: TaskStatus; detail?: string }): Task | null;
  list(filter?: TaskStatus): Task[];
  get(id: number): Task | undefined;
  stop(id: number): Task | null;
}

/** 板条目终态词表。 */
export type BoardStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'merged';

/** 一块板上的一条子代理记录。 */
export interface BoardEntry {
  agentId: string;
  parentAgentId: string;
  description: string;
  status: BoardStatus;
  isolationId: string | null;
  filesTouched: string[];
  summary?: string;
  diff?: string;
  startedAt: number;
  finishedAt?: number;
}

/** 会话级任务板（每会话一块；`ctx.taskBoard` 与两个契约文件的读面）。 */
export interface TaskBoardFace {
  readonly projectPath: string;
  flush(): Promise<void>;
  restore(): Promise<void>;
  /** 清除防抖落盘定时器（会话切换/销毁时调）。 */
  clearFlushTimer(): void;
  destroy(): Promise<void>;
  getAllEntries(): BoardEntry[];
  register(entry: Omit<BoardEntry, 'status' | 'filesTouched' | 'startedAt'>): void;
  recordFileTouch(agentId: string, filepath: string): void;
  complete(agentId: string, summary: string, diff: string): void;
  fail(agentId: string, error: string): void;
  stop(agentId: string): void;
  markMerged(agentId: string): void;
  touch(agentId: string): void;
  reparent(agentId: string, newParentAgentId: string): void;
  attachDiff(agentId: string, diff: string): void;
  getChildren(parentAgentId: string): BoardEntry[];
  getEntry(agentId: string): BoardEntry | undefined;
  unregister(agentId: string): void;
}

/** 板上「本代理视角」的代理面（每 Agent 一份，转发到会话板 + 绑定自身 id）。 */
export interface TaskBoardProxyFace {
  setTarget(board: TaskBoardFace): void;
  readonly target: TaskBoardFace;
  readonly projectPath: string;
  getAllEntries(): BoardEntry[];
  getChildren(parentAgentId: string): BoardEntry[];
  getEntry(agentId: string): BoardEntry | undefined;
  register(entry: Omit<BoardEntry, 'status' | 'filesTouched' | 'startedAt'>): void;
  recordFileTouch(agentId: string, filepath: string): void;
  complete(agentId: string, summary: string, diff: string): void;
  fail(agentId: string, error: string): void;
  stop(agentId: string): void;
  markMerged(agentId: string): void;
  touch(agentId: string): void;
  reparent(agentId: string, newParentAgentId: string): void;
  attachDiff(agentId: string, diff: string): void;
  unregister(agentId: string): void;
  flush(): Promise<void>;
  restore(): Promise<void>;
  destroy(): Promise<void>;
  clearFlushTimer(): void;
}

/** 板只读面（工具读点用：`agent_board` 只需要子树条目 + 项目路径；
 *  会话板与板代理都满足此面——写点仍走完整 `TaskBoardFace` / `TaskBoardProxyFace`）。 */
export interface TaskBoardReadFace {
  readonly projectPath: string;
  getChildren(parentAgentId: string): BoardEntry[];
}

/** task 域实现面（`plugins/builtin/task-domain/` 的 `taskImplementation` 结构上界）。
 *
 *  登记面 = `agent/task-impl.ts` 的 `registerTaskImplementation`；内核与其它产物
 *  一律经该文件的门面取用（缺实现 = 具名 `TASK_DOMAIN_UNAVAILABLE`）。 */
export interface TaskImplementation {
  /** 造一个每卷任务管理器（调用方持有）。 */
  createTaskManager(): TaskManagerFace;
  /** 造一块会话级板（`projectPath` 缺省 = 纯内存板，不落盘）。 */
  createTaskBoard(projectPath?: string, sessionId?: string): TaskBoardFace;
  /** 造「本代理视角」的板代理。 */
  createTaskBoardProxy(target: TaskBoardFace): TaskBoardProxyFace;
  /** task 域五件工具（`task_create` / `task_update` / `task_list` / `task_get` / `task_stop`）。 */
  createTaskTools(mgr: TaskManagerFace): Tool[];
  /** 板状态工具（`agent_board`——读本代理子树条目）。 */
  createBoardStatusTool(board: TaskBoardReadFace, agentId: () => string): Tool;
}

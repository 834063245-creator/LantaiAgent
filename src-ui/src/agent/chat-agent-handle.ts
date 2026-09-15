// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ChatAgentHandle — 解耦 chat.ts 和 agent.ts 的接口层
// chat.ts 只依赖此接口，不直接 import Agent 类。
// Agent 类已结构性实现此接口，无需额外 adapter。

import type { StoredThinking } from '../provider/thinking';
import type { ChatImageRef, Message, Provider } from '../provider/types';
import type { TokenLedgerSnapshot, TokenMeasurement } from './token-meter/types';

/** 目标运行结果 — runGoal / resumeGoal 的统一返回 */
export type GoalRunResult = { status: 'completed' | 'failed' | 'blocked' | 'aborted' | 'paused'; summary: string };

export interface ChatAgentHandle {
  /** 该 Agent 实例的唯一标识 — 会话层按会话登记，UI 据此定位其专属待办等。 */
  readonly id: string;

  /** 发起一轮对话：附加用户消息，驱动工具循环。images = 附图引用
   *  （multimodal-image-plan B3——随用户消息入 session，字节永不进卷）。 */
  run(signal: AbortSignal, input: string, images?: ChatImageRef[]): Promise<void>;

  /** 自主多轮目标执行。status 新增 'paused' — 用户中断时保存检查点，可通过 resumeGoal 继续。 */
  runGoal(signal: AbortSignal, goal: string): Promise<GoalRunResult>;

  /** 恢复暂停(或崩溃遗留)的目标;不传 id 时恢复唯一活体目标 */
  resumeGoal(signal: AbortSignal, id?: string): Promise<GoalRunResult>;

  /** 手动触发上下文压缩，返回摘要文本 */
  compactNow(signal: AbortSignal): Promise<string>;

  /** 撤回指定位置的对话轮次 */
  retractTurnAt(sessionIndex: number): void;

  /** 读取当前会话消息列表（只读） */
  getSession(): Message[];

  /** 替换整个会话消息列表 */
  setSession(msgs: Message[]): void;

  /** 开启全新会话（保留 system prompt） */
  newSession(): void;

  /** 运行时更新思考策略（思考档位/深思考开关切换），不重建 Agent。 */
  setThinking(cfg: StoredThinking | undefined): void;

  /** 运行时切换 provider（模型/提供方/协议），不重建 Agent。 */
  setProvider(prov: Provider): void;

  /** 运行时更新上下文窗口（压缩阈值），不重建 Agent。 */
  setContextWindow(n: number): void;

  /** 预测下一条 insert 的 session 索引 */
  readonly nextInsertIndex: number;

  /** 在 Agent 运行中插入消息。silent=true 抑制用户反馈 notice。 */
  insertMessage(text: string, opts?: { silent?: boolean }): void;

  /** 级联取消：父Agent中断时停止所有运行中的子Agent */
  cascadeAbort(): void;

  /** 批量停止所有子Agent */
  stopAllSubAgents(): string[];

  /** 当前正在运行的子Agent数量 */
  runningSubAgentCount(): number;

  /** Set the UI session ID — used for precise per-session bump in sub-agent notifications */
  setUiSessionId(sid: number): void;

  // ── token 计量（2026-09-13）——每卷一本账，UI 只读、卷文件持久化 ──
  // 能力位（可选）：句柄不实现 = 无账本可读（旧实现/测试桩），调用方降级
  // 为「无读数」而不是炸链路——计量是观测面，不是执行面。

  /** 本卷计量读数（分桶用量 / 压力 / 投影占用 / 构成 / 逐轮）。纯读。 */
  getTokenStats?(): TokenMeasurement;

  /** 账本快照（随卷落盘；空账本 null）。 */
  snapshotTokenLedger?(): TokenLedgerSnapshot | null;

  /** 从卷文件恢复账本（旧卷无此字段 = 空账本；毒化数据降级不抛）。 */
  restoreTokenLedger?(snapshot: TokenLedgerSnapshot | null | undefined): void;

  // ── 组合身份（P0 记录闭环，2026-09-14）——本卷生效的组合 id ──
  // 能力位（可选）：句柄不实现 = 无组合身份可读（旧实现/测试桩），调用方降级为
  // 「无记录」而不是炸链路。真源 = Agent 构造时点读的 preset id（空白会话期
  // 改选会同步更新）；「模型可见 ⟺ 已记录」——组合决定模型看到什么，必须可查。

  /** 本卷生效的组合 id（纯读）。 */
  readonly presetId?: string;

  // ── loop 事件监听（P0 会话存盘止血，2026-09-15）──
  // 能力位（可选）：句柄不实现 = 无监听面（旧实现/测试桩），调用方降级为
  // 「无检查点」而不是炸链路——检查点是保证，不是门禁。

  /** 监听 loop 生命周期事件（`request/start` 等；返回 disposer）。
   *  消费面 = 会话检查点：「模型请求前」落一次卷快照（design:
   *  docs/session-checkpoint-design.md §3.1 触发点 A）。 */
  onLoopEvent?<E extends import('./events').LoopEventName>(
    event: E,
    fn: (payload: import('./events').LoopEventPayload[E]) => void,
    opts?: import('./events').ListenerOptions,
  ): import('./lifecycle').Disposer;

  // ── 事件日志（Phase 1 换轨，2026-09-15）──
  // 能力位（可选）：句柄不实现 = 无日志面（旧实现/测试桩），调用方降级为
  // 「无事件日志可落」而不是炸链路。

  /** 本卷的事件溯源日志（模型可见事实的真源——落盘面见 app/chat/session-log-store）。 */
  readonly sessionLog?: import('./session-log').SessionLog;
}

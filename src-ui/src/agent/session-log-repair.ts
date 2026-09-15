// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 崩溃恢复：把「断在半路的一轮」补成 provider 可接受的转写。
//
// 来源：`deepseek-harness/packages/core/session/src/repair.ts`
// （`interruptedTurnClosers`，HEAD 4e84901e64）。兰台形做了两处**刻意简化**，
// 理由写在下面，不是遗漏：
//
//   ① **不合成 `turn/end` / `step/end`**。DSH 的事件词表有 step/turn 边界事件，
//      所以它的修复要补齐「开着的 step → 开着的 turn」。兰台的 `SessionLog`
//      没有这两种 kind，而且**不需要**：兰台的投影（`deriveMessages`）只认消息
//      事件，一轮的开合不参与转写合法性；provider 真正在意的是「每个 tool_call
//      必须有配对的 tool 消息」。所以兰台只需补**悬空工具调用**的结果。
//      副产品：不动 phase-5 事件词表（`SESSION_EVENT_KINDS`），不触发
//      convergence 基线变更审批。
//   ② **不依赖「轮到第几步」**。DSH 的闭合器要读 `turn`/`step` 数字；兰台的
//      `turn/start` 只带 provider/model，没有轮号——闭合器因此只按 callId 配平，
//      与事件顺序无关（更耐脏：日志被截断在任意位置都能算对）。
//
// 两种语义区分沿用 DSH 的判据（这条判据是整件事的重点）：
//   · 日志里有 `tool/call`（= 模型宣布了、执行器已分发）却没结果
//     → **副作用可能已发生**：提示模型「只读或幂等才重试，否则先核对外部状态
//       或问用户，禁止盲重试」；
//   · 只有 assistant 消息里的 tool_calls（= 宣布了但没分发）
//     → 没跑：提示「需要就重试」。
//
// 诚实边界：`assistant/text` 事件在兰台的流式执行器里是**流收尾才落**的，
// 而 `tool/call` 审计事件紧跟其后；因此「宣布了但没分发」这一态在兰台实测里
// 出现窗口很窄（流中途崩溃时两者都会缺）。保留它是因为 DSH 的判据在语义上正确，
// 且 2026-09-15 修过的「流中途失败补落已执行工具结果」路径会产生这一态。

import type { Message, ToolCall } from '../provider/types';
import type { SessionEvent } from './session-log';

/** 恢复码：调用已被记录为开始（`tool/call` 在日志里），但没有持久化的结果。 */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN';

/** 恢复码：调用只在 assistant 消息里被宣布，Harness 未记录其开始。 */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED';

/** 已分发但结果未知时的可见文案（借 DSH 原文的语气：明确禁止盲重试）。 */
export const OUTCOME_UNKNOWN_TEXT =
  '该工具调用已被记录为开始，但没有持久化的结果——**其副作用是否发生未知**。' +
  '只有只读或幂等的操作才可直接重试；可能产生副作用的操作请先核对外部状态（文件/仓库/远端），' +
  '或向用户确认后再继续。不要盲目重试。';

/** 未分发时的可见文案。 */
export const NOT_STARTED_TEXT = '该工具调用在 Harness 记录其开始之前就中断了——没有执行过。如仍需要，请重试。';

/** 一条悬空调用（assistant 宣布 / 有分发起始记录 / 无结果）。 */
export interface DanglingToolCall {
  callId: string;
  name: string;
  /** 是否在日志里有 `tool/call`（= 已分发，副作用未知）。 */
  dispatched: boolean;
}

/**
 * 扫出日志里「宣布了但没有结果」的工具调用（按出现顺序）。
 * 纯函数、与事件顺序无关之外还容忍重复宣布（同 callId 以首次为准）。
 */
export function danglingToolCalls(events: readonly SessionEvent[]): DanglingToolCall[] {
  const pending = new Map<string, DanglingToolCall>();
  const order: string[] = [];
  for (const ev of events) {
    switch (ev.kind) {
      case 'assistant/text': {
        const message = (ev.data as { message: Message }).message;
        for (const call of message.tool_calls ?? []) {
          const id = String((call as ToolCall).id ?? '');
          if (!id || pending.has(id)) continue;
          pending.set(id, { callId: id, name: String((call as ToolCall).name ?? ''), dispatched: false });
          order.push(id);
        }
        break;
      }
      case 'tool/call': {
        const call = (ev.data as { call: ToolCall }).call;
        const id = String(call?.id ?? '');
        if (!id) break;
        const entry = pending.get(id);
        if (entry) {
          entry.dispatched = true;
        } else {
          // 审计事件先于 assistant 消息出现（流中途失败补落路径）——照样配平
          pending.set(id, { callId: id, name: String(call?.name ?? ''), dispatched: true });
          order.push(id);
        }
        break;
      }
      case 'tool/result': {
        const message = (ev.data as { message: Message }).message;
        const id = String(message?.tool_call_id ?? '');
        if (id) pending.delete(id);
        break;
      }
      case 'session/reset':
      case 'session/retract':
        // 重置/撤回后，之前的悬空调用已被新事实取代——清空重来
        pending.clear();
        order.length = 0;
        break;
      default:
        break;
    }
  }
  return order.map((id) => pending.get(id)).filter((x): x is DanglingToolCall => x !== undefined);
}

/**
 * 合成收尾事件：为每条悬空调用补一条 `tool/result`（两种语义文案不同）。
 * seq 从日志末尾续号、ts 复用末条真实事件的时间（确定性，不发明未来时间）。
 * 已平衡的日志返回空数组。
 */
export function interruptedToolCallClosers(events: readonly SessionEvent[]): SessionEvent[] {
  const dangling = danglingToolCalls(events);
  if (dangling.length === 0) return [];
  const last = events.at(-1);
  let seq = (last?.seq ?? 0) + 1;
  const ts = last?.ts ?? Date.now();
  return dangling.map((call) => {
    const message: Message = {
      role: 'tool',
      tool_call_id: call.callId,
      name: call.name,
      content: call.dispatched ? OUTCOME_UNKNOWN_TEXT : NOT_STARTED_TEXT,
    };
    return {
      seq: seq++,
      ts,
      kind: 'tool/result' as const,
      data: { message },
    } as SessionEvent;
  });
}

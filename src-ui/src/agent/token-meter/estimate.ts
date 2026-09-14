// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 上下文构成测量 — 请求信封（系统提示 / 工具 schema / 对话）的 token 分解。
//
// 与 DSH 的 estimate.ts 同职责（DSH：固定密度启发式 4 字符 ≈ 1 token），
// 但兰台**不抄那份启发式**：本仓已有更准的计数通道（agent/token-counter.ts，
// gpt-tokenizer cl100k_base + 不可控文本兜底），构成测量必须与压缩预检
// （tokenCountWithEstimation）用同一把尺子 —— 两个数字打架比数字粗糙更坏
// （DSH README 的自陈局限正好是「CJK 与 JSON schema 被严重低估」）。
//
// 构成三项之和 = 该次请求的载荷估算量（surfaceTokens），是 projected 占用的
// 基准量；它是**近似构成**，不是提供方计费规模（后者见 usage.ts 的分桶）。

import type { Message, ToolSchema } from '../../provider/types';
import { countMessage, countMessages, countTexts, countToolSchemas } from '../token-counter';
import type { ContextBreakdown } from './types';

/** 请求信封测量的完整产物（构成 + 细分，细分供诊断日志消费）。 */
export interface EnvelopeMeasure {
  /** 三段构成：系统提示 / 工具 schema / 对话。 */
  breakdown: ContextBreakdown;
  /** 载荷估算总量（= 三项之和）。 */
  surfaceTokens: number;
  /** 载荷消息条数（= 分段条数之和）。 */
  messageCount: number;
  /** 系统提示消息条数。 */
  systemMessages: number;
  /** 真实用户消息条数与 tokens（不含注入的 system-reminder）。 */
  userMessages: number;
  userTokens: number;
  /** 注入提醒条数/tokens/其中带 📬 的条数（<system-reminder> 包裹的 user 消息）。 */
  reminderMessages: number;
  reminderTokens: number;
  inboxReminders: number;
  /** assistant 消息条数与 tokens。 */
  assistantMessages: number;
  assistantTokens: number;
  /** 工具结果条数与 tokens。 */
  toolResultMessages: number;
  toolResultTokens: number;
  /** 临时提醒 tokens（发出但不在会话里的那些）。 */
  transientTokens: number;
  /** 工具 schema 条数。 */
  schemaCount: number;
}

/**
 * 测量一次请求的信封构成。
 * @param payload - 实际发出的消息序列（含 system，可含临时提醒）。
 * @param toolSchemas - 本次请求携带的工具 schema。
 * @param transientReminders - 未进会话、仅本轮可见的提醒文本。
 */
export function measureEnvelope(
  payload: readonly Message[],
  toolSchemas: readonly ToolSchema[],
  transientReminders: readonly string[] = [],
): EnvelopeMeasure {
  let systemTokens = 0;
  let systemMessages = 0;
  let userMessages = 0;
  let userTokens = 0;
  let reminderMessages = 0;
  let reminderTokens = 0;
  let inboxReminders = 0;
  let assistantMessages = 0;
  let assistantTokens = 0;
  let toolResultMessages = 0;
  let toolResultTokens = 0;

  for (const m of payload) {
    const tokens = countMessage(m);
    switch (m.role) {
      case 'system':
        systemTokens += tokens;
        systemMessages += 1;
        break;
      case 'user':
        if (typeof m.content === 'string' && m.content.includes('<system-reminder>')) {
          reminderTokens += tokens;
          reminderMessages += 1;
          if (m.content.includes('📬')) inboxReminders += 1;
        } else {
          userTokens += tokens;
          userMessages += 1;
        }
        break;
      case 'assistant':
        assistantTokens += tokens;
        assistantMessages += 1;
        break;
      case 'tool':
        toolResultTokens += tokens;
        toolResultMessages += 1;
        break;
    }
  }

  const transientTokens = countTexts(transientReminders);
  const toolsTokens = countToolSchemas(toolSchemas);
  const messageTokens = userTokens + reminderTokens + assistantTokens + toolResultTokens + transientTokens;

  return {
    breakdown: { systemTokens, toolsTokens, messageTokens },
    surfaceTokens: systemTokens + toolsTokens + messageTokens,
    messageCount: payload.length,
    systemMessages,
    userMessages,
    userTokens,
    reminderMessages,
    reminderTokens,
    inboxReminders,
    assistantMessages,
    assistantTokens,
    toolResultMessages,
    toolResultTokens,
    transientTokens,
    schemaCount: toolSchemas.length,
  };
}

/** 载荷估算总量（不含工具 schema 的对话侧口径；坞底墨量线等轻量消费面用）。 */
export function estimatePayloadTokens(payload: readonly Message[]): number {
  return countMessages(payload);
}

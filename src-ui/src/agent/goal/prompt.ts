// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal 轮提示词（2026-10-23，DSH `goal-round-driver/src/prompt.ts` 移植）。
//
// 每个自动轮以一段保留的 `<goal_round>` 用户消息进入会话历史；它点明目标原文
// （JSON 引用，避免换行破坏结构）与正数轮号。提示词要求模型以当前工作区、工具
// 结果与会话事实为准，而不是相信上一轮的叙述——这是 DSH 同款纪律。
//
// `<goal_round>` 前缀同时是 UI 内部来文判据（ui/chat-session INTERNAL_PREFIXES），
// 因而不会渲染成用户气泡。

import type { GoalView } from './types';

/** 渲染一轮的完整提示（新建与恢复共用；恢复不需要额外说明——轮号自会表达）。 */
export function renderGoalRoundPrompt(goal: GoalView, round: number): string {
  return (
    '<goal_round>\n' +
    `Objective: ${JSON.stringify(goal.objective)}\n` +
    `Round: ${round}/${goal.maxGoalRounds}\n\n` +
    '在同一个会话里继续推进这个目标。以当前工作区、工具结果与会话中的持久事实为准——' +
    '不要假设上一轮的叙述仍然成立，需要时重新检查。做出具体进展并验证结果。' +
    '在声称完成之前，先收集证据证明整个目标已经达成，用 goal(get) 读取当前目标，再执行 complete。' +
    '如果仍有工作，保持目标 active 留给下一轮；报告 blocked 之前遵守目标工具策略。\n' +
    '</goal_round>'
  );
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask 工具族（ask_user）（**归家后真源**，2026-09-24 批 4c-2）。
//
// 来历：原 agent/tools/coding.ts（一文件载五族）的该段整段移出——定义逐字保留，
// 只把内核依赖改走包内宿主面（./host）。
// UI 依赖面**类型**三件在 `agent/tool.ts`（2026-09-24 批 4c 前置上收内核契约）——
// 本族只取类型，不构成宿主→插件反向依赖。

import { z } from 'zod';
import { type CodingToolsUI, defineTool, type Tool } from './host';

export function createAskUserTools(ui?: CodingToolsUI): Tool[] {
  return [
    // ── 用户交互 ──
    defineTool({
      name: 'ask_user',
      description:
        "Ask the user one or more questions when you need clarification or confirmation before proceeding. Use when the request is ambiguous, you need to choose between approaches, or you need approval for a destructive action. Supports: single question (question/header/options/multiSelect), multiple questions in one call (questions array — recommended for 2+, asked one at a time), and open-ended questions (omit options — the user types a free-text answer). Returns the user's answer(s).",
      schema: z.object({
        question: z
          .string()
          .optional()
          .describe(
            'The question to ask the user (single-question form). For 2+ questions use the questions array instead.',
          ),
        header: z
          .string()
          .optional()
          .describe('Short label (max 12 chars) shown as a tag, e.g. "Confirm", "Approach", "File"'),
        options: z
          .array(
            z.object({
              label: z.string().describe('Display text (1-5 words)'),
              description: z.string().describe('Explanation of what this option means'),
            }),
          )
          .optional()
          .describe(
            '2-4 predefined choices the user can pick from. Omit for an open-ended question — the user types a free-text answer.',
          ),
        multiSelect: z
          .boolean()
          .optional()
          .default(false)
          .describe('Set to true to allow selecting multiple options (default: false)'),
        questions: z
          .array(
            z.object({
              question: z.string().describe('The question to ask the user. Be specific about what you need to know.'),
              header: z
                .string()
                .optional()
                .describe('Short label (max 12 chars) shown as a tag, e.g. "Confirm", "Approach", "File"'),
              options: z
                .array(
                  z.object({
                    label: z.string().describe('Display text (1-5 words)'),
                    description: z.string().describe('Explanation of what this option means'),
                  }),
                )
                .optional()
                .describe(
                  '2-4 predefined choices the user can pick from. Omit for an open-ended question — the user types a free-text answer.',
                ),
              multiSelect: z
                .boolean()
                .optional()
                .default(false)
                .describe('Set to true to allow selecting multiple options (default: false)'),
            }),
          )
          .optional()
          .describe(
            'Multiple questions in one call (recommended for 2+). Asked one at a time in order; the returned answers array aligns with this array. Each answer is a string (single choice / free text) or an array of strings (multi-select), or null if the user cancelled.',
          ),
      }),
      readOnly: true,
      execute: async (args) => {
        if (!ui?.askUser) {
          return JSON.stringify({ answer: null, error: 'ask_user 不可用：UI 未接线' });
        }
        const batch = Array.isArray(args.questions) && args.questions.length > 0 ? args.questions : null;
        if (!batch && !args.question) {
          return JSON.stringify({ error: 'ask_user: 需要提供 question（单问）或 questions（多问）' });
        }
        // 发起 Agent 身份（executor 注入的 _owner_id meta key——不在 zod 类型内，
        // 见 define-tool 注释的 meta key 约定）——UI 路由提问卡到所属卷
        const agentId =
          typeof (args as { _owner_id?: unknown })._owner_id === 'string'
            ? ((args as { _owner_id?: unknown })._owner_id as string)
            : undefined;
        // 批量：一次推全部 questions，UI 渲成分页表单一次性收集；取消 → 整批 null
        if (batch) {
          const answers = await new Promise<(string[] | null)[] | null>((resolve) => {
            ui.askUser?.({
              id: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              agentId,
              questions: batch,
              callback: (res) => resolve(Array.isArray(res) ? (res as (string[] | null)[]) : null),
            });
          });
          if (answers === null) return JSON.stringify({ answer: null });
          // 返回与 questions 对齐：多选 → label 数组；单选/开放式 → 字符串；未答 → null
          return JSON.stringify({
            answers: answers.map((a, i) => {
              if (a === null) return null;
              const multi = (batch[i].options?.length ?? 0) > 0 && !!batch[i].multiSelect;
              return multi ? a : (a[0] ?? null);
            }),
          });
        }
        // 单问（含开放式：options 省略）
        const multi = (args.options?.length ?? 0) > 0 && !!args.multiSelect;
        const ans = await new Promise<string[] | null>((resolve) => {
          ui.askUser?.({
            id: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            agentId,
            question: args.question,
            header: args.header,
            options: args.options ?? [],
            multiSelect: multi,
            callback: (res) => resolve(Array.isArray(res) ? (res as string[]) : null),
          });
        });
        if (ans === null) return JSON.stringify({ answer: null });
        return JSON.stringify(multi ? { answers: ans } : { answer: ans[0] ?? null });
      },
    }),
  ];
}

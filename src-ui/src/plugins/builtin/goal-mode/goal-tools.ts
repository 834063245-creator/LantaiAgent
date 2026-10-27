// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// goal 域工具（2026-10-23，DSH goal 栈移植 P3）——`goal(action: get|create|update)`。
//
// 对位 DSH `packages/goal/tool-goal`：三个常驻控制面（get/create/update），不是每轮
// 动态注册的 goal_report。兰台的模型可见面是**域工具**（DOMAIN_SPECS 折叠），所以
// 实现名是 `goal_get` / `goal_create` / `goal_update`，模型看到的是 action 枚举。
//
// 执行期授权（DSH authority.ts 的兰台形）：
//   - 直人授权 = 顶层 Agent 且当前运行种类为 `turn`（人发的轮）；
//   - complete/blocked 额外接受**本目标当前自动轮**（`goal`）；
//   - blocked 在自动轮里必须已连续 ≥3 轮，且必须给具体原因；
//   - 模型不得 resume 一个 paused 目标（人用 /goal resume）。
// 授权判据用的是 Agent.currentRunKind()（进程事实），不信任调用方自报。

import { z } from 'zod';
import {
  blockGoal,
  completeGoal,
  createGoal,
  DEFAULT_BLOCKED_MIN_ROUNDS,
  defineTool,
  editGoal,
  GoalError,
  type GoalHost,
  type GoalView,
  goalHostOf,
  isTopLevelHost,
  pauseGoal,
  readGoal,
  resumeGoal,
  type Tool,
} from './host';

/** executor 注入的 meta（schema 外，defineTool passthrough 透传）。 */
interface ToolMeta {
  _owner_id?: unknown;
  _agent_id?: unknown;
}

/** 从 meta 解析宿主；未就绪 = 具名失败（不静默）。 */
function hostOf(args: ToolMeta): GoalHost {
  const ownerId =
    typeof args._owner_id === 'string'
      ? args._owner_id
      : typeof args._agent_id === 'string'
        ? args._agent_id
        : undefined;
  const host = goalHostOf(ownerId);
  if (!host) throw new GoalError('goal host is not ready for this agent', 'GOAL_HOST_UNAVAILABLE');
  return host;
}

/** 直人授权：顶层 Agent 的直人轮。 */
function requireDirectHuman(host: GoalHost): void {
  if (!isTopLevelHost(host) || host.currentRunKind() !== 'turn') {
    throw new GoalError(
      'this goal operation requires a direct human turn on a top-level agent',
      'GOAL_AUTHORITY_REQUIRED',
    );
  }
}

/** 终结授权：直人轮，或本目标的自动续行轮。 */
function requireCompletionAuthority(host: GoalHost): 'direct-human' | 'goal-round' {
  if (!isTopLevelHost(host)) {
    throw new GoalError('goal tools are available to the top-level agent only', 'GOAL_AUTHORITY_REQUIRED');
  }
  const kind = host.currentRunKind();
  if (kind === 'turn') return 'direct-human';
  if (kind === 'goal') return 'goal-round';
  throw new GoalError(
    'complete and blocked require a direct human turn or the current goal round',
    'GOAL_AUTHORITY_REQUIRED',
  );
}

/** 紧凑读形（照 DSH：`{goal: null}` 或 `{goal, activation}`）。 */
function goalValue(view: GoalView | undefined): string {
  if (view === undefined) return JSON.stringify({ goal: null });
  return JSON.stringify({
    goal: {
      id: view.id,
      revision: view.revision,
      objective: view.objective,
      phase: view.phase,
      roundsStarted: view.roundsStarted,
      maxGoalRounds: view.maxGoalRounds,
      ...(view.blockedReason === undefined ? {} : { blockedReason: view.blockedReason }),
    },
    activation: view.activation,
  });
}

/** 终结后的收尾指令（DSH deferContext 的兰台形：工具结果里给一句话，同轮收尾）。 */
function terminalNote(action: 'complete' | 'blocked'): string {
  return action === 'complete'
    ? '目标已标记完成。现在给用户写收尾消息：结果、做了什么、如何验证的、产物在哪；不要再调用工具。'
    : '目标已标记受阻。现在给用户写收尾消息：已完成部分、具体阻塞条件、需要用户做什么；不要再调用工具。';
}

const getTool: Tool = defineTool({
  name: 'goal_get',
  description: '读取当前会话目标，含 update 所需的 goal_id 与 revision（无目标时 goal=null）。',
  schema: z.object({}),
  readOnly: true,
  execute: async (args) => {
    const host = hostOf(args as ToolMeta);
    return goalValue(readGoal(host));
  },
});

const createTool: Tool = defineTool({
  name: 'goal_create',
  description:
    '创建一个持久目标，本会话会自动续行推进直到完成或受阻。仅当直人请求是长期完成目标时使用' +
    '（用户没说"目标"也可以）；单轮工作不要创建。',
  schema: z.object({
    objective: z.string().min(1).describe('从直人请求推断出的具体完成目标。'),
    max_goal_rounds: z.number().int().positive().optional().describe('可选的自动续行轮上限。'),
  }),
  execute: async (args) => {
    const meta = args as ToolMeta;
    const host = hostOf(meta);
    requireDirectHuman(host);
    const view = createGoal(host, {
      objective: args.objective,
      ...(args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds }),
    });
    return goalValue(view);
  },
});

const updateTool: Tool = defineTool({
  name: 'goal_update',
  description:
    '更新当前目标。update_action=edit/pause/resume/complete/blocked；goal_id 与 revision 必须原样取自 goal_get。' +
    'edit/pause/resume 需要直人轮；complete/blocked 也允许在本目标的自动轮里调用；' +
    'blocked 需在自动轮里已连续 ≥3 轮且必须给具体阻塞条件；paused 目标只能由人 /goal resume。',
  schema: z.object({
    goal_id: z.string().min(1).describe('goal_get 返回的精确 id。'),
    revision: z.number().int().min(1).describe('goal_get 返回的精确 revision。'),
    update_action: z.enum(['edit', 'pause', 'resume', 'complete', 'blocked']).describe('要执行的变更。'),
    objective: z.string().min(1).optional().describe('仅 edit：替换目标原文。'),
    max_goal_rounds: z.number().int().positive().optional().describe('仅 edit：替换轮上限。'),
    blocked_reason: z
      .string()
      .min(1)
      .optional()
      .describe('仅 blocked：连续多轮存在、会话内无法自行解除的具体阻塞条件。'),
  }),
  execute: async (args) => {
    const host = hostOf(args as ToolMeta);
    const ref = { id: args.goal_id, revision: args.revision };
    const action = args.update_action;

    if (action === 'edit') {
      requireDirectHuman(host);
      if (args.blocked_reason !== undefined) {
        throw new GoalError('blocked_reason is valid only with blocked', 'GOAL_INVALID_UPDATE');
      }
      const view = editGoal(host, ref, {
        ...(args.objective === undefined ? {} : { objective: args.objective }),
        ...(args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds }),
      });
      return goalValue(view);
    }

    if (action === 'pause' || action === 'resume') {
      requireDirectHuman(host);
      if (args.objective !== undefined || args.max_goal_rounds !== undefined || args.blocked_reason !== undefined) {
        throw new GoalError(
          'objective/max_goal_rounds are valid only with edit; blocked_reason only with blocked',
          'GOAL_INVALID_UPDATE',
        );
      }
      const current = readGoal(host);
      if (current === undefined) throw new GoalError('no current goal', 'GOAL_NOT_FOUND');
      if (action === 'resume' && current.phase === 'paused') {
        throw new GoalError(
          'the model cannot resume a paused goal; the user must resume it',
          'GOAL_AUTHORITY_REQUIRED',
        );
      }
      return goalValue(action === 'pause' ? pauseGoal(host, ref) : resumeGoal(host, ref));
    }

    const authority = requireCompletionAuthority(host);
    if (args.objective !== undefined || args.max_goal_rounds !== undefined) {
      throw new GoalError('objective/max_goal_rounds are valid only with edit', 'GOAL_INVALID_UPDATE');
    }
    if (action === 'complete') {
      if (args.blocked_reason !== undefined) {
        throw new GoalError('blocked_reason is valid only with blocked', 'GOAL_INVALID_UPDATE');
      }
      const view = completeGoal(host, ref);
      return `${goalValue(view)}\n\n${terminalNote('complete')}`;
    }

    // blocked
    const reason = args.blocked_reason;
    if (reason === undefined) throw new GoalError('blocked_reason is required with blocked', 'GOAL_INVALID_UPDATE');
    const current = readGoal(host);
    if (authority === 'goal-round' && (current?.roundsStarted ?? 0) < DEFAULT_BLOCKED_MIN_ROUNDS) {
      throw new GoalError(
        `blocked requires at least ${DEFAULT_BLOCKED_MIN_ROUNDS} consecutive goal rounds; current round is ${
          current?.roundsStarted ?? 0
        }`,
        'GOAL_AUTHORITY_REQUIRED',
      );
    }
    const view = blockGoal(host, ref, { code: 'model-reported', message: reason });
    return `${goalValue(view)}\n\n${terminalNote('blocked')}`;
  },
});

/** 本包贡献的工具行（顺序 = 模型可见的 action 序：get/create/update）。 */
export function goalTools(): Tool[] {
  return [getTool, createTool, updateTool];
}

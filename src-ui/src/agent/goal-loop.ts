// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Goal 循环 — 自主多轮执行。从 agent.ts 机械搬移（11c），零逻辑改动。
// 宿主模式：Agent 类经受控转换（as unknown as GoalLoopHost）传入本模块；
// session 变异只经宿主的三个双写入口（phase-5 门禁语义不因拆分而变）。

import { z } from 'zod';
import type { Message } from '../provider/types';
import { type AgentEvent, type AgentUINotifier, EventKind } from './agent-types';
import type { ExecStateInstance } from './execution-state';
import type { GoalManager, GoalRecord } from './goal-manager';
import type { SessionResetReason } from './session-log';
import type { Tool, ToolRegistry } from './tool';
import { defineTool } from './tools/define-tool';

/** Goal 循环对宿主 Agent 的最小状态面（成员与 Agent 类声明逐字对齐）。 */
export interface GoalLoopHost {
  readonly goalManager: GoalManager | null;
  readonly tools: ToolRegistry;
  /** UI 通知端口（workspace 注入；headless 时为空操作）。 */
  readonly _ui: AgentUINotifier;
  readonly _execState: ExecStateInstance;
  _sink: (ev: AgentEvent) => void;
  getSession(): Message[];
  _appendMessage(kind: 'user/message' | 'assistant/text' | 'tool/result', message: Message): void;
  _replaceSession(messages: Message[], reason: SessionResetReason): void;
  _retractSessionRange(fromIndex: number, toIndex: number): void;
  runLoop(signal: AbortSignal): Promise<void>;
}

export type GoalRunResult = {
  status: 'completed' | 'failed' | 'blocked' | 'aborted' | 'paused';
  summary: string;
};

// Goal 循环安全: 强制终止前的硬上限（正常不应触发）
const MAX_GOAL_ITERATIONS = 100;
// 停滞检测: 连续无工具调用的轮次 → Agent 陷入分析瘫痪
const MAX_STALL_ROUNDS = 3;

/** 自主运行目标: 规划 → 执行 → 验证 → 循环直到 goal_report。
 *  始终开启新目标 — 单槽语义会取消任何活跃目标
 *  （恢复是独立路径: resumeGoal）。状态存储在 GoalManager
 *  （.hologram/goals/{id}/），与聊天会话槽完全隔离 —
 *  日常聊天不再能覆盖目标检查点。 */
export async function runGoalImpl(ag: GoalLoopHost, signal: AbortSignal, goal: string): Promise<GoalRunResult> {
  if (!ag.goalManager) {
    return { status: 'failed', summary: '目标管理器未初始化' };
  }
  const record = await ag.goalManager.create(goal);
  ag._sink({ kind: EventKind.Notice, level: 'info', text: `[目标模式] ${record.text.slice(0, 60)}…` });
  const report = registerGoalReportTool(ag);
  try {
    return await goalLoop(ag, signal, record, false, report);
  } finally {
    ag.tools.unregister('goal_report');
  }
}

/** 恢复活跃目标（暂停/受阻的，或崩溃遗留的活跃记录）。返回类型与 runGoal 相同。 */
export async function resumeGoalImpl(ag: GoalLoopHost, signal: AbortSignal, id?: string): Promise<GoalRunResult> {
  if (!ag.goalManager) {
    return { status: 'failed', summary: '目标管理器未初始化' };
  }
  const record = id ? await ag.goalManager.get(id) : await ag.goalManager.getActive();
  if (!record || (record.status !== 'paused' && record.status !== 'active' && record.status !== 'blocked')) {
    return { status: 'failed', summary: '没有可恢复的目标。使用 /goal 创建新目标。' };
  }
  // ponytail: 到达这里的 'active' 记录是崩溃残留（活跃循环被
  // UI 的 isRunning 守卫阻塞）— 像暂停的一样接管它。
  const snapshot = await ag.goalManager.loadSession(record.id);
  if (snapshot && snapshot.length > 0) {
    ag._replaceSession(snapshot, 'goal-resume');
    ag._execState.bumpVersion();
  }
  ag._sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 恢复: ${record.text.slice(0, 60)}…` });
  const report = registerGoalReportTool(ag);
  try {
    return await goalLoop(ag, signal, record, true, report);
  } finally {
    ag.tools.unregister('goal_report');
  }
}

/** 为一个 goal 循环注册 goal_report。调用方在 finally 中注销。
 *  完成判定的主通道：模型显式上报，不再只靠正文正则。普通对话拿不到这个工具。
 *  权威语义：只有目标循环期间注册本工具 — 模型无权在普通聊天里改目标状态；
 *  edit/pause/resume/cancel 等生命周期动作只由人类 /goal 命令进入。 */
function registerGoalReportTool(ag: GoalLoopHost): {
  called: boolean;
  status: 'completed' | 'failed' | 'blocked';
  summary: string;
} {
  const report = { called: false, status: 'completed' as 'completed' | 'failed' | 'blocked', summary: '' };
  const goalReportTool: Tool = defineTool({
    name: 'goal_report',
    description:
      '目标模式专用：确认目标已达成、确认无法达成、或遇到需要外部（人类/环境）才能解除的障碍时调用，调用后目标循环结束。' +
      'status=completed 时 summary 写完成摘要；status=failed 时 summary 写失败原因；' +
      'status=blocked 时 summary 必须写明具体阻塞条件（机器可读的事实：缺什么、谁缺、哪个环境不满足），且该条件在会话内无法由你自行解除。',
    schema: z.object({
      status: z.enum(['completed', 'failed', 'blocked']),
      summary: z.string().min(1, 'blocked/failed 必须说明原因'),
    }),
    readOnly: true,
    execute: async (args) => {
      report.called = true;
      report.status = args.status;
      report.summary = args.summary;
      return `目标状态已记录: ${report.status}`;
    },
  });
  ag.tools.register(goalReportTool);
  return report;
}

/** 共享的 goal 循环 — 新建和恢复都汇聚到这里。
 *  ponytail: 串行设计。并行是优化而非正确性要求 —
 *  串行子 Agent 派生保证无文件冲突。 */
async function goalLoop(
  ag: GoalLoopHost,
  signal: AbortSignal,
  record: GoalRecord,
  isResume: boolean,
  report: { called: boolean; status: 'completed' | 'failed' | 'blocked'; summary: string },
): Promise<GoalRunResult> {
  const mgr = ag.goalManager;
  if (!mgr) return { status: 'aborted', summary: 'goal manager not initialized' };
  let stallRounds = record.stallRounds;

  // 重注完整目标提示词 — 新建与恢复都走这里。恢复时不能指望快照里
  // 还留着原文（可能已被压缩），重复出现的 <goal> 块是可接受的代价。
  ag._appendMessage('user/message', { role: 'user', content: goalPrompt(record, isResume) });
  if (isResume) {
    ag._sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 从第 ${record.iteration + 1} 轮恢复…` });
  }

  for (let iter = record.iteration; !signal.aborted && iter < MAX_GOAL_ITERATIONS; iter++) {
    ag._ui.progress?.(iter + 1, 'goal-loop');

    // ── 检查点:记录 + 对话现场快照进 goal 专属槽 ──
    // ponytail: sessionBefore 使我们能在中止时裁剪未完成的轮次消息。
    const sessionBefore = ag.getSession().length;
    await mgr.update(record.id, { iteration: iter, stallRounds, status: 'active' });
    await mgr.saveSession(record.id, ag.getSession());

    try {
      await ag.runLoop(signal);
    } catch (e) {
      // ponytail: 中断有多种冒泡形式 — runLoop 步骤边界抛 'aborted'，
      // 流式 fetch 被掐断时抛 'BodyStreamBuffer was aborted' 之类的原始错误。
      // 用户意图是暂停,以 signal 为准,不认错误消息文本。
      const errMsg = errText(e);
      if (signal.aborted || errMsg === 'aborted') {
        // ── 暂停:裁剪未完成轮次,快照进 goal 槽,记录转 paused ──
        ag._retractSessionRange(sessionBefore, ag.getSession().length);
        ag._execState.bumpVersion();
        await mgr.update(record.id, { status: 'paused', iteration: iter, stallRounds });
        await mgr.saveSession(record.id, ag.getSession());
        // 从内存会话中清除目标上下文，使普通聊天不自动继续。
        // 完整上下文存在 goal 槽中；/goal resume 从那里恢复。
        const session = ag.getSession();
        ag._replaceSession(session.length > 0 && session[0].role === 'system' ? [session[0]] : [], 'goal-parked');
        ag._execState.bumpVersion();
        ag._sink({
          kind: EventKind.Notice,
          level: 'info',
          text: `[目标] 已暂停于第 ${iter + 1} 轮。使用 /goal resume 继续。`,
        });
        return {
          status: 'paused',
          summary: `已暂停于第 ${iter + 1}/${MAX_GOAL_ITERATIONS} 轮。使用 /goal resume 继续。`,
        };
      }
      await mgr.update(record.id, { status: 'failed', summary: `执行异常: ${errMsg}` });
      return { status: 'failed', summary: `执行异常: ${errMsg}` };
    }

    // ── 完成判定:goal_report 优先,正文标记为旧会话 fallback ──
    if (report.called) {
      const summary = report.summary || lastAssistantContent(ag);
      await mgr.update(record.id, { status: report.status, summary });
      if (report.status === 'blocked') {
        ag._sink({ kind: EventKind.Notice, level: 'warn', text: `🚧 目标受阻: ${summary.slice(0, 120)}` });
        return { status: 'blocked', summary };
      }
      ag._sink({
        kind: EventKind.Notice,
        level: report.status === 'completed' ? 'info' : 'warn',
        text: report.status === 'completed' ? '✅ 目标达成' : '❌ 目标失败',
      });
      return { status: report.status, summary };
    }

    const last = lastAssistantContent(ag);
    if (!last) {
      await mgr.update(record.id, { status: 'failed', summary: '模型未产出响应' });
      ag._sink({ kind: EventKind.Notice, level: 'error', text: '目标执行异常: 模型未产出响应' });
      return { status: 'failed', summary: '模型未产出响应' };
    }

    if (/\[GOAL_COMPLETE\]/i.test(last)) {
      await mgr.update(record.id, { status: 'completed', summary: last });
      ag._sink({ kind: EventKind.Notice, level: 'info', text: '✅ 目标达成' });
      return { status: 'completed', summary: last };
    }
    if (/\[GOAL_FAILED\]/i.test(last)) {
      await mgr.update(record.id, { status: 'failed', summary: last });
      ag._sink({ kind: EventKind.Notice, level: 'warn', text: '❌ 目标失败' });
      return { status: 'failed', summary: last };
    }

    // ── 停滞检测: 连续无工具调用的轮次 → 卡住 ──
    const hasToolCalls = lastAssistantHasToolCalls(ag);
    if (!hasToolCalls) {
      stallRounds++;
      if (stallRounds >= MAX_STALL_ROUNDS) {
        const summary = `连续 ${stallRounds} 轮未执行任何工具调用或委派子Agent。目标可能过于模糊或超出能力范围。请拆分目标为更具体的步骤。`;
        await mgr.update(record.id, { status: 'failed', summary, stallRounds });
        ag._sink({
          kind: EventKind.Notice,
          level: 'warn',
          text: `[目标] 连续 ${stallRounds} 轮无实际行动，Agent 可能陷入分析瘫痪，终止`,
        });
        return { status: 'failed', summary };
      }
    } else {
      stallRounds = 0;
    }

    // 目标进行中 — 自动继续
    const stallHint =
      stallRounds > 0
        ? `\n⚠️ 已连续 ${stallRounds}/${MAX_STALL_ROUNDS} 轮无实际行动。必须调用工具或委派子Agent，禁止只输出文字分析。`
        : '';
    ag._appendMessage('user/message', {
      role: 'user',
      content: `<system-reminder>
目标未完成。已完成 ${iter + 1} 轮。${stallHint}

如果目标尚未达成: 规划下一步（不重复已完成步骤）→ 执行或 agent_spawn 委派 → 验证结果。
如果目标已全部达成: 调用 goal_report(status="completed", summary=…) 上报。
如果遇到无法克服的障碍: 调用 goal_report(status="failed", summary=…) 说明原因。
如果障碍是外部条件（需要人类决策/外部环境改变才能解除，你在会话内无法自行解决）: 调用 goal_report(status="blocked", summary="具体阻塞条件")，人类可用 /goal resume 在条件解除后继续。

禁止反问用户。禁止只分析不行动。
</system-reminder>`,
    });
    ag._sink({ kind: EventKind.Notice, level: 'info', text: `[目标] 第 ${iter + 1} 轮完成，继续…` });
  }
  // 达到最大迭代数 — 强制终止（硬上限，正常使用不应触发）
  if (!signal.aborted) {
    const summary = `达到硬上限 ${MAX_GOAL_ITERATIONS} 轮。请拆分目标为更小单元。`;
    await mgr.update(record.id, { status: 'failed', summary });
    ag._sink({
      kind: EventKind.Notice,
      level: 'warn',
      text: `[目标] 达到硬上限 (${MAX_GOAL_ITERATIONS} 轮)，强制终止`,
    });
    return { status: 'failed', summary };
  }

  return { status: 'aborted', summary: '目标被中断' };
}

/** 完整 goal prompt — 新建和恢复时都注入，使模型
 *  不依赖原始 prompt 在快照中存活。 */
function goalPrompt(record: GoalRecord, isResume: boolean): string {
  const resumeNote = isResume
    ? `\n## 恢复执行\n这是恢复后的第 ${record.iteration + 1} 轮（此前已推进 ${record.iteration} 轮，对话现场已从快照恢复）。直接继续下一步，不要复盘已完成的工作。\n`
    : '';
  return `<goal>
## 总体目标
${record.text}
${resumeNote}
## 执行模式
你是目标驱动的执行Agent，会持续工作直到目标达成。你不会在中间停下来等用户。

## 执行规则
1. **规划** — 把目标分解为连续的、可验证的具体步骤
2. **执行** — 小步骤（几次工具调用内能完成）直接自己做；大步骤（多文件改动、独立子任务）用 \`agent_spawn\` fork 模式委派子Agent。子Agent有干净上下文，只做一件事，返回结果
3. **验证** — 每步完成后检查结果。正确→继续下一步，错误→分析原因→修正指令→重做
4. **循环** — 持续 规划→执行→验证→下一步，直到目标全部达成
5. **不要反问** — 不要在中间停下来问用户"要继续吗"。直接继续
6. **完成信号** — 判定目标已达成时调用 \`goal_report(status="completed", summary="完成摘要")\`；确认无法达成时调用 \`goal_report(status="failed", summary="失败原因")\`；障碍需外部条件解除时调用 \`goal_report(status="blocked", summary="具体阻塞条件")\`（人类可用 /goal resume 继续）

## 禁止
- 输出纯文本分析后停止（分析完必须进入下一步行动）
- 反复分析同一问题而不行动
- 未验证结果就直接上报完成

现在开始。
</goal>`;
}

function lastAssistantContent(ag: GoalLoopHost): string {
  const session = ag.getSession();
  for (let i = session.length - 1; i >= 0; i--) {
    if (session[i].role === 'assistant' && typeof session[i].content === 'string') {
      return session[i].content as string;
    }
  }
  return '';
}

/** catch(e) 的 unknown 取消息 — 覆盖 Error/DOMException/裸字符串三种冒泡形态。 */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** 检查最后一条 assistant 消息是否包含 tool_calls（而非纯文本）。 */
function lastAssistantHasToolCalls(ag: GoalLoopHost): boolean {
  const session = ag.getSession();
  for (let i = session.length - 1; i >= 0; i--) {
    if (session[i].role === 'assistant') {
      return (session[i].tool_calls?.length ?? 0) > 0;
    }
  }
  return false;
}

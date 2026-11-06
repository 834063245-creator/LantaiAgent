// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 从 provider 会话重建 UI 消息与轮次对
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { agentSessionState, type TurnPair } from '../../../agent/agent-session-state';
import { parseAssetEventOutput } from '../../../agent/asset-kinds';
import type { Message } from '../../../provider/types';
import { rebuildAssetTableFromMessages } from '../../../state/asset-store';
import { bumpSession, getChatStore, msgStoreFor } from '../../../ui/chat-store';
import {
  type AssistantMessage,
  type BlockPart,
  type ChatMessage,
  createAssistantMessage,
  createNoticeMessage,
  createUserMessage,
  type MessageId,
  nextMsgId,
  type PlanPart,
  resetMsgIdCounter,
  type SubAgentPart,
} from '../../../ui/message-model';
import { applyAssetFinal } from '../../../ui/part-mutator';
import { isSubagentSpawnTool } from '../../../ui/tool-semantics';
import { getTurnPairs, setTurnPairs } from './session-registry';
import { isInternalMessage, type SessionContext } from './session-types';

// ── 会话恢复（内部辅助函数）──

/** 遍历活跃 agent 的会话数组，构建 ChatMessage[] + turnPairs。 */
export function renderRestoredSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sid);
  if (!agent) return;
  _rebuildMessagesFromSession(ctx);
  bumpSession(ctx.storeId, sid);
}

/** 从 agent 的 getSession() 原始消息填充活跃会话的会话级消息 store + turnPairs。
 *  纯数据重建 — 无 DOM 操作，无通知。 */
export function rebuildMessagesFromMessages(msgs: Message[], storeId: string, sessionId: number): void {
  const rebuilt: ChatMessage[] = [];

  // 保留按助手消息序号索引的活跃 SubAgentPart 对象。
  // 子 Agent 汇持持有这些对象的引用并持续流式写入 —
  // 仅从 provider 消息重建会丢弃卡片并使汇持孤立
  // （冻结的卡片、丢失的输出）。同样的对象会在
  // 下方重新附加到重建的消息中。
  const preservedSubAgents = new Map<number, SubAgentPart[]>();
  const preservedBlockParts = new Map<number, BlockPart[]>();
  {
    const existing = msgStoreFor(storeId, sessionId).getState().messages;
    let aIdx = 0;
    for (const m of existing) {
      if (m.role !== 'assistant') continue;
      const subs = (m as AssistantMessage).parts.filter((p): p is SubAgentPart => p.type === 'subagent');
      if (subs.length > 0) preservedSubAgents.set(aIdx, subs);
      const blocks = (m as AssistantMessage).parts.filter((p): p is BlockPart => p.type === 'block');
      if (blocks.length > 0) preservedBlockParts.set(aIdx, blocks);
      aIdx++;
    }
  }

  resetMsgIdCounter();
  setTurnPairs(storeId, sessionId, []);

  const toolResults = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === 'tool' && m.tool_call_id) {
      toolResults.set(m.tool_call_id, m.content || '');
    }
  }

  let pendingUserText: string | null = null;
  let pendingUserId: MessageId | null = null;
  // 本轮的来文（**内部插入不打断它**）：`pendingUserId` 是轮次簿册的暂存（每条助手消息
  // 结账后清空），而 `respondingTo` 问的是「这条回复答的是哪条来文」——轮内被 append 的
  // 内部来文（inbox / goal 提醒，`isInternalMessage`）不是轮边界，答块不得因此丢掉关联
  // （丢了 ⇒ 「立枝」等按节点定位的读面直接落空，见 `app/chat/session-branch`）。
  let turnUserId: MessageId | null = null;
  let sessionIdx = 0;
  // 拟策恢复的跨消息游标（2026-10-08 卷重建丢卡根治）：enter_plan_mode 的结果
  // 里带计划文件路径——exit_plan_mode 恢复正文时取用（两事件常分属不同消息）。
  let lastPlanFilePath: string | null = null;

  for (const m of msgs) {
    const idx = sessionIdx++;

    if (m.role === 'system') continue;

    if (m.role === 'user') {
      if (isInternalMessage(m.content)) {
        if (m.content?.startsWith('<compacted-context>')) {
          rebuilt.push(createNoticeMessage('📋 上下文已压缩', 'info'));
        }
        continue;
      }
      if (pendingUserText && pendingUserId) {
        getTurnPairs(storeId, sessionId).push({
          userText: pendingUserText,
          uiMsgId: pendingUserId,
          userBubble: null,
          assistantBubble: null,
        });
      }
      pendingUserText = m.content || '';
      pendingUserId = nextMsgId();
      const um = createUserMessage(m.content || '', undefined, idx);
      rebuilt.push(um);
      pendingUserId = um._id;
      turnUserId = um._id;
      continue;
    }

    if (m.role === 'tool') continue;

    if (m.role === 'assistant') {
      const am = createAssistantMessage(turnUserId || '');
      am.status = 'done';

      if (m.reasoning_content) {
        am.parts.push({ type: 'reasoning', text: m.reasoning_content });
      }

      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          // 子 Agent spawn 调用由 SubAgentBlock 呈现（实时会话的 SubAgentPart 在上方
          // preservedSubAgents 中保留并重新挂载）— 不重建 ToolCard，
          // 否则恢复/撤回重建后同一 spawn 会同时出现两种卡片。
          if (isSubagentSpawnTool(tc.name, tc.arguments || undefined)) continue;
          const output = toolResults.get(tc.id);
          am.parts.push({
            type: 'tool',
            toolId: tc.id,
            name: tc.name,
            args: tc.arguments || '',
            label: tc.name,
            readOnly: false,
            status: 'done',
            output,
          });

          // 资产块恢复（2026-10-08 卷重建丢卡根治）：资产工具的回执里带完整
          // 资产 JSON——parseAssetEventOutput 与 executor 终值事件同一解析真源；
          // 解析成功由 applyAssetFinal 补回 BlockPart（此刻 push 到 parts 末尾 =
          // 紧跟该工具卡之后；update 的原位置换语义天然成立）。
          if ((tc.name === 'show_asset' || tc.name === 'update_asset') && output) {
            const asset = parseAssetEventOutput(output);
            if (asset) applyAssetFinal(am.parts, asset);
          }

          // 拟策块恢复（同根治）：exit_plan_mode 的结果文本带计划全文（批准/
          // 自动批准路径），解析后补回 PlanPart；宁缺勿造（无全文不产卡）。
          if (tc.name === 'exit_plan_mode' && output) {
            const plan = planPartFromExitResult(output, lastPlanFilePath, tc.arguments || '');
            if (plan) am.parts.push(plan);
          }
          if (tc.name === 'enter_plan_mode' && output) {
            lastPlanFilePath = planFilePathFromEnterResult(output) ?? lastPlanFilePath;
          }
        }
      }

      if (m.content) {
        am.parts.push({ type: 'text', text: m.content, finalised: true });
      }

      rebuilt.push(am);

      if (pendingUserText) {
        getTurnPairs(storeId, sessionId).push({
          userText: pendingUserText,
          uiMsgId: pendingUserId ?? undefined,
          userBubble: null,
          assistantBubble: null,
        });
        pendingUserText = null;
        pendingUserId = null;
      }
    }
  }

  if (pendingUserText) {
    getTurnPairs(storeId, sessionId).push({
      userText: pendingUserText,
      uiMsgId: pendingUserId ?? undefined,
      userBubble: null,
      assistantBubble: null,
    });
  }

  // 按助手消息序号重新附加保留的子 Agent 部件。
  // 超出重建范围的序号（如仍在流式输出但尚未出现在
  // provider 消息中的轮次）回退到最后一条重建的助手消息。
  if (preservedSubAgents.size > 0 || preservedBlockParts.size > 0) {
    const rebuiltAssistants = rebuilt.filter((m): m is AssistantMessage => m.role === 'assistant');
    for (const [ordinal, subs] of preservedSubAgents) {
      const target = rebuiltAssistants[ordinal] ?? rebuiltAssistants[rebuiltAssistants.length - 1];
      if (target) target.parts.push(...subs);
    }
    for (const [ordinal, blocks] of preservedBlockParts) {
      const target = rebuiltAssistants[ordinal] ?? rebuiltAssistants[rebuiltAssistants.length - 1];
      if (target) target.parts.push(...blocks);
    }
  }

  // ponytail: 写入会话级 store — 唯一数据源
  msgStoreFor(storeId, sessionId).getState().setMessages(rebuilt);
  rebuildAssetTableFromMessages(storeId, sessionId, rebuilt);
  bumpSession(storeId, sessionId);
}

// ── 卷重建的块恢复辅助（2026-10-08 session-rebuild-recovery-plan）──
//
// 重建只重造 reasoning/text/tool——资产块与拟策块由此从工具回执/结果恢复，
// 否则「快照判陈旧」一次就整体丢失（案卷 51 事故）。以下解析依赖 plan-tools.ts
// 生成的结果文案，由 tests/session-rebuild-recovery.test.ts 钉住；文案变更 = 测试红。

/** 从 enter_plan_mode 结果解析计划文件路径（`计划文件路径：${path}`）。失败 → null。 */
function planFilePathFromEnterResult(result: string): string | null {
  const m = /计划文件路径：([^\n]+)/.exec(result);
  return m ? m[1].trim() : null;
}

/** 从 exit_plan_mode 结果恢复拟策卡。仅「含计划全文」的结果可恢复（批准执行 /
 *  无 UI 自动批准——marker 即 plan-tools.ts 的两个模板前缀）；修改/拒绝/超时/
 *  留档的结果不含正文 = null（宁缺勿造，不铺半截卡）。
 *  status = 'approved'：两个 marker 都只在「计划已被采纳」时出现（实时决议同批
 *  写回 part.status，见 PlanBody）——重建/重载后卡面保持终态，不长回「待批准」。 */
function planPartFromExitResult(result: string, planFilePath: string | null, args: string): PlanPart | null {
  const markers = ['## 已批准计划：\n', '## 计划：\n'];
  for (const marker of markers) {
    const idx = result.indexOf(marker);
    if (idx < 0) continue;
    const content = result.slice(idx + marker.length);
    if (!content.trim()) continue;
    const options = planOptionsFromArgs(args);
    return {
      type: 'plan',
      planId: `plan-card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      planFilePath: planFilePath ?? '',
      content,
      ...(options ? { options } : {}),
      status: 'approved',
    };
  }
  return null;
}

/** 从 exit_plan_mode 调用参数恢复备选方案（形状不完整 = 省略，不铺半截）。 */
function planOptionsFromArgs(args: string): PlanPart['options'] | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const raw = (parsed as { options?: unknown }).options;
    if (!Array.isArray(raw)) return undefined;
    const options: NonNullable<PlanPart['options']> = [];
    for (const o of raw) {
      if (!o || typeof o !== 'object') continue;
      const { label, description, outcome } = o as { label?: unknown; description?: unknown; outcome?: unknown };
      if (typeof label !== 'string' || typeof description !== 'string') continue;
      options.push({
        label,
        description,
        ...(outcome === 'execute' || outcome === 'archive' ? { outcome } : {}),
      });
    }
    return options.length > 0 ? options : undefined;
  } catch {
    return undefined;
  }
}

/** 包装器：解析活跃 agent 的会话并委托给 rebuildMessagesFromMessages。 */
export function _rebuildMessagesFromSession(ctx: SessionContext): void {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return;
  const agent = agentSessionState.getAgent(ctx.storeId, sid);
  if (!agent) return;

  rebuildMessagesFromMessages(agent.getSession(), ctx.storeId, sid);
}

/** 从 provider 会话推导轮次表（恢复路径直接采用 UI 快照时的派生重建）。
 *  pair 只是轮次簿册（userText + uiMsgId 身份）；撤回/重发的定位权威在
 *  沙盒映射（resolveUserTurnIndex 尾对齐派生），不在这里。
 *  internal 消息（目标/压缩上下文）不建轮次对；重发叠出的重复 user 消息
 *  各自成对，撤回按 uiMsgId 直达互不误删。 */
export function rebuildTurnPairsFromProvider(providerSession: Message[]): TurnPair[] {
  const pairs: TurnPair[] = [];
  providerSession.forEach((m) => {
    if (m.role !== 'user' || isInternalMessage(m.content)) return;
    pairs.push({ userText: m.content || '', userBubble: null, assistantBubble: null });
  });
  return pairs;
}

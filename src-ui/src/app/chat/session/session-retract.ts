// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 轮次撤回（TurnIdBridge 对位）
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { agentSessionState } from '../../../agent/agent-session-state';
import type { Message } from '../../../provider/types';
import { bumpSession, getChatStore, msgStoreFor } from '../../../ui/chat-store';
import type { MessageId, UserMessage } from '../../../ui/message-model';
import { getTurnPairs } from './session-registry';
import { isInternalMessage, type SessionContext } from './session-types';

// ── 轮次撤回（2026-09-01 重发锚点工程：ID 直达，无内容猜测）──
// 旧实现的三条猜测路（记录索引直用 / 内容兜底搜索 / 同文本清 pair）全部
// 退役——provider 会话与 UI 消息本就是两份不同形状的数据，定位唯一权威 =
// UI 消息 _id 经「沙盒映射」（TurnIdBridge）反查 provider 下标。映射由
// 尾对齐派生（按顺序配对 + 内容确认），戳失效即整表重算：压缩、外部裁剪、
// 恢复后统统自愈；对不上的轮次降级置灰，绝不按内容搜索下刀。

/** provider 内容与 UI 文本的对位确认（精确或附件前缀尾匹配——带附件轮次
 *  底层 content = 附加文件清单 + 正文）。仅用于确认顺序对位，绝不做内容搜索。 */
function providerContentMatches(providerContent: string, uiText: string): boolean {
  if (!uiText) return false;
  return providerContent === uiText || providerContent.endsWith(uiText);
}

/** 尾对齐：UI 用户消息 ↔ provider 用户消息从最新端按顺序配对，内容确认，
 *  失配即止（更早的轮次不入映射 → 降级）。同文本多轮按位置各归各位——
 *  旧「按文本找索引」的同文本撤错轮病根在此拔除。
 *  尾悬挂容忍一次：UI 末条在 provider 无对应（在途/夭折轮）时不拖累全场。 */
function alignUserTurns(uiUsers: UserMessage[], provUsers: { index: number; content: string }[]): Map<string, number> {
  const byUiId = new Map<string, number>();
  let ui = uiUsers;
  if (
    ui.length > provUsers.length &&
    !providerContentMatches(provUsers[provUsers.length - 1]?.content ?? '', ui[ui.length - 1]?.text ?? '')
  ) {
    ui = ui.slice(0, -1);
  }
  const n = Math.min(ui.length, provUsers.length);
  for (let k = 1; k <= n; k++) {
    const u = ui[ui.length - k];
    const p = provUsers[provUsers.length - k];
    if (!u || !p || !providerContentMatches(p.content, u.text)) break;
    byUiId.set(u._id, p.index);
  }
  return byUiId;
}

/** 重派生本会话的撤回定位映射（沙盒）。戳（会话长度/界面用户数）失效即
 *  整表重算——不做增量维护，外部改动点（压缩/裁剪/恢复）零接线自愈。 */
function realignTurnIdBridge(storeId: string, sid: number, session: Message[], uiUsers: UserMessage[]): void {
  const provUsers: { index: number; content: string }[] = [];
  session.forEach((m, i) => {
    if (m.role === 'user' && !isInternalMessage(m.content)) {
      provUsers.push({ index: i, content: m.content || '' });
    }
  });
  agentSessionState.setTurnIdBridge(storeId, sid, {
    sessionLength: session.length,
    uiUserCount: uiUsers.length,
    byUiId: alignUserTurns(uiUsers, provUsers),
  });
}

/** uiMsgId → provider 会话中该 user 轮的下标（ID 直达）。映射缺失/过期先
 *  尾对齐重派生；仍对不上返回 null——调用方降级，绝不回退内容搜索。 */
function resolveUserTurnIndex(storeId: string, sid: number, uiMsgId: MessageId): number | null {
  const agent = agentSessionState.getAgent(storeId, sid);
  if (!agent) return null;
  const session = agent.getSession();
  const uiUsers = msgStoreFor(storeId, sid)
    .getState()
    .messages.filter((m): m is UserMessage => m.role === 'user');
  const bridge = agentSessionState.getTurnIdBridge(storeId, sid);
  if (!bridge || bridge.sessionLength !== session.length || bridge.uiUserCount !== uiUsers.length) {
    realignTurnIdBridge(storeId, sid, session, uiUsers);
  }
  const idx = agentSessionState.getTurnIdBridge(storeId, sid)?.byUiId.get(uiMsgId);
  if (idx == null || idx < 0 || idx >= session.length || session[idx]?.role !== 'user') return null;
  return idx;
}

/** 改/重发按钮的准入判定：该轮当前能否被唯一定位撤回（不可 = 置灰降级）。 */
export function canRetraceUserTurn(storeId: string, sid: number, uiMsgId: MessageId): boolean {
  return resolveUserTurnIndex(storeId, sid, uiMsgId) != null;
}

/** 以 UI 消息 _id 撤回一轮（ID 直达）。全有或全无：UI 消息或 provider 轮
 *  任一定位失败 = 两边都原样不动（返回 false）——绝不半撤制造叠尸，
 *  也绝不按内容猜错轮。撤回区间 = 该 user 消息 + 紧随其后的助手回复
 *  （respondingTo 关联），子代理/资产随区间连坐（retractTurnAt 语义）。 */
export function retractUserMessage(ctx: SessionContext, msg: UserMessage): boolean {
  const { sessions, activeIdx } = getChatStore(ctx.storeId).sess.getState();
  const sid = sessions[activeIdx]?.id;
  if (sid == null) return false;

  // 定位先行（UI + provider 两侧都要命中，缺一整体不动）
  const store = msgStoreFor(ctx.storeId, sid);
  const msgs = store.getState().messages;
  const uiIdx = msgs.findIndex((m) => m.role === 'user' && m._id === msg._id);
  const sessIdx = resolveUserTurnIndex(ctx.storeId, sid, msg._id);
  if (uiIdx < 0 || sessIdx == null) return false;

  agentSessionState.getAgent(ctx.storeId, sid)?.retractTurnAt(sessIdx);

  // UI 层清理（_id 直达）：该用户消息 + 紧随其助手回复
  const toRemove: number[] = [uiIdx];
  for (let i = uiIdx + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && m.respondingTo === msg._id) {
      toRemove.push(i);
      break;
    } else if (m.role === 'user') {
      break;
    }
  }
  for (const i of toRemove.reverse()) {
    msgs.splice(i, 1);
  }
  store.getState().setMessages([...msgs]);
  bumpSession(ctx.storeId, sid);

  // pair 簿册按 uiMsgId 直达清理（同文本轮次互不误删）
  const tp = getTurnPairs(ctx.storeId, sid);
  const pi = tp.findIndex((p) => p.uiMsgId === msg._id);
  if (pi >= 0) tp.splice(pi, 1);
  return true;
}

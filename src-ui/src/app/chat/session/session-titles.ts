// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷名维护（首条来文派生 + 一次模型概括）
// 从 ui/chat-session.ts 按既有分区拆出（2026-11-06 上帝文件治理·第 1 刀）——
// 行为零变更，公开面由 ui/chat-session.ts 原样再导出。

import { agentSessionState } from '../../../agent/agent-session-state';
import type { ChatAgentHandle } from '../../../agent/chat-agent-handle';
import { log } from '../../../agent/logger';
import type { ChatSessionMeta } from '../../../state/session-store';
import { deriveVolumeLabel, isUnnamedVolumeLabel, normalizeVolumeLabel } from '../../../state/volume-name';
import { buildVolumeTitlePrompt, parseVolumeTitleReply } from '../../../state/volume-title';
import { getChatStore } from '../../../ui/chat-store';
import { getWorkspaceEpoch, isCurrentEpoch } from '../../../workspace-scope';
import { inheritedMessageCount } from '../session-log-store';

/** 若会话**尚未命名**（空名，或旧存档遗留的默认名「案卷 N」/"会话 N"），则从第一
 *  条用户消息自动命名。在每轮对话完成后调用。sid 指定轮次所属卷（并发会话：后台卷
 *  跑完只命名自己）；缺省 = 活跃卷（遗留调用语义）。
 *  判据与派生都是 state/volume-name 的**同一把尺子**（与读盘路径同判——收口前
 *  这里严「\d+$」、读盘路径松「案卷␣前缀」，同一个名两条路答得不一样）。
 *  **枝卷只认自己的首条来文**（`inheritedMessageCount`）：继承来的前缀是父卷的复制，
 *  拿它起名 = 子卷顶着父卷的名（真机验收报的「卷名乱套」）。 */
/** 本卷**自己的**首条来文：跳过继承前缀（枝卷）与压缩摘要注入。
 *  命名与概括共用同一判据——枝卷拿继承来的父卷首句起名是这个函数收口前的病灶。 */
function ownFirstUserText(agent: ChatAgentHandle): string | null {
  const own = agent.getSession().slice(inheritedMessageCount(agent.sessionLog));
  const first = own.find((m) => m.role === 'user' && m.content && !m.content.startsWith('<compacted-context>'));
  return first?.content ?? null;
}

export function autoTitleSessionIfDefault(storeId: string, sid?: number): void {
  const st = getChatStore(storeId).sess.getState();
  const { sessions, activeIdx } = st;
  const targetSid = sid ?? sessions[activeIdx]?.id;
  if (targetSid == null) return;
  const idx = sessions.findIndex((x) => x.id === targetSid);
  if (idx < 0) return;
  const s = sessions[idx];
  if (!s) return;

  // 已有名：只剩「派生名补一次模型概括」这一件事（B 批）——来源判据在
  // `refineVolumeTitleIfDerived` 内部（user 永不覆盖 / refined 不重试）。
  if (!isUnnamedVolumeLabel(s.label)) {
    refineVolumeTitleIfDerived(storeId, s.id);
    return;
  }

  const agent = agentSessionState.getAgent(storeId, s.id);
  if (!agent) return;

  const firstText = ownFirstUserText(agent);
  if (!firstText) return;

  const derived = deriveVolumeLabel(firstText);
  if (!derived) return;
  // 来源 = derived（2026-10-31 C 批）：只有本进程内派生出来的名字才允许被后续
  // 自动概括覆盖；人手改名走 `renameSession` 的同源字段写 `user`。
  const updated = sessions.map(
    (x, i): ChatSessionMeta => (i === idx ? { ...x, label: derived, labelSource: 'derived' } : x),
  );
  getChatStore(storeId).sess.setState({ sessions: updated });
  refineVolumeTitleIfDerived(storeId, s.id);
}

/** 卷名维护之二（B 批，2026-10-31）：给刚派生的卷补一次模型概括。
 *
 *  只对 `labelSource === 'derived'` 的卷发生**一次**：发起即把来源记成 `refined`
 *  （= 已尝试；失败也不重试，否则每轮末都会重烧一次调用）。用户改名（`user`）永不覆盖。
 *
 *  纪律：
 *   - 不阻塞回合（`void` 发起；失败只 warn、保留派生名、不弹 toast）；
 *   - 落地前 CAS：来源仍是 `refined` 且名字没被换过——用户中途改名则结果丢弃；
 *   - 跨工作区在途按 epoch 丢弃（INVARIANTS #12，与 autoSave 同族）；
 *   - **usage 不入卷账**（旁路调用不是上下文构成），只落一行日志。 */
export function refineVolumeTitleIfDerived(storeId: string, sessionId: number): void {
  const sess = getChatStore(storeId).sess;
  const target = sess.getState().sessions.find((x) => x.id === sessionId);
  if (target?.labelSource !== 'derived') return;

  const agent = agentSessionState.getAgent(storeId, sessionId);
  if (!agent) return;
  const sideCall = agent.callSideLLM?.bind(agent);
  if (!sideCall) return;
  const firstText = ownFirstUserText(agent);
  if (!firstText) return;

  // 发起即记账：同卷不再重复概括（失败也不重试）。
  const attempted = target.label;
  sess.getState().renameSession(sessionId, attempted, 'refined');

  const epoch = getWorkspaceEpoch();
  const controller = new AbortController();
  const { system, user } = buildVolumeTitlePrompt(firstText);
  const startedAt = Date.now();
  void (async () => {
    try {
      const call = await sideCall(controller.signal, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);
      log.info('chat', 'volume title llm response', {
        session_id: sessionId,
        max_tokens: call.maxTokens,
        text_chars: call.text.length,
        prompt_tokens: call.usage?.prompt_tokens,
        completion_tokens: call.usage?.completion_tokens,
        cache_hit_tokens: call.usage?.cache_hit_tokens,
        elapsed_ms: Math.round(Date.now() - startedAt),
      });
      const title = normalizeVolumeLabel(parseVolumeTitleReply(call.text));
      if (!title || title === attempted) return; // 空 / 与现值相同：不写，免版式抖动
      if (!isCurrentEpoch(epoch)) return;
      const now = sess.getState().sessions.find((x) => x.id === sessionId);
      if (now?.labelSource !== 'refined' || now.label !== attempted) return;
      sess.getState().renameSession(sessionId, title, 'refined');
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      log.warn('chat', `卷 ${sessionId} 自动概括失败（保留派生名）`, { error: String(error) });
    } finally {
      controller.abort();
    }
  })();
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 待答缩略行（2026-11-11 画布多卷审批 UX · B 面）。
//
// 病灶：卡架一次只贴一张卡，**队列不透明**——用户看不到「还有几张、来自哪些卷」；
// 答完一张后下一张可能瞬间换成另一卷的问题（徽标跟着换），没有预期。本行贴在
// 当前卡**下方**，把待答清单摊开：每项 = 卷名 + 类型 + 摘要，点它跳到该卷。
//
// 落位：卡架宿主（`.psh-host`，fixed 屏幕底部居中）内部、PromptShelf 之后；
// 宿主本体 pointer-events:none，本行单独放开 auto（与卡架同一纪律）。
// 零待答 = 不渲染（卡架保持原样）。
//
// 数据真源 = state/ask-pending-store（chat-core 交付入账 / 答复结账）——与卷首
// 待答角标**同一本账**，两处读数天然一致。**不改变队列顺序**：卡架内部 FIFO 仍是
// 唯一调度真源，本行只做「让你看见」。

import { useAskPendingStore, useCoreStore } from './host';
import './ask-pending-strip.css';

/** 单条摘要最多显示多少字（超长由 store 的 clipLabel 在入账时已截过一刀）。 */
const ITEM_LABEL_MAX = 18;

export function AskPendingStrip() {
  const core = useCoreStore((s) => s.core);
  const entries = useAskPendingStore((s) => s.entries);
  if (entries.length === 0) return null;
  const perm = entries.filter((e) => e.kind === 'perm').length;
  const ask = entries.length - perm;

  return (
    <div className="aps" role="status" aria-live="polite">
      <span className="aps-title">
        待答 {entries.length}
        {perm > 0 && <span className="aps-title-perm"> · 批 {perm}</span>}
        {ask > 0 && <span className="aps-title-ask"> · 答 {ask}</span>}
      </span>
      <div className="aps-list">
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            className="aps-item"
            data-kind={e.kind}
            data-tip={e.label}
            onClick={() => {
              if (e.ownerSid != null) core?.switchToSession?.(e.ownerSid);
            }}
          >
            <span className="aps-badge">{e.badge ?? '无卷'}</span>
            <span className="aps-kind">{e.kind === 'perm' ? '批' : '答'}</span>
            <span className="aps-label">
              {e.label.length > ITEM_LABEL_MAX ? `${e.label.slice(0, ITEM_LABEL_MAX)}…` : e.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

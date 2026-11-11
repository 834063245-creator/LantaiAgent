// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷首待答角标（2026-11-11 画布多卷审批 UX · A 面）。
//
// 病灶（用户提出）：卡架是**全局单架**（.psh-host 固定屏幕底部居中），多卷并行时
// 只贴一张卡、其余在 FIFO 里排队；而**画布上没有一处能看出「哪卷在等我」**——
// 卷首、卷签、小地图全无痕迹。用户答完一张，下一张可能瞬间换成另一卷的问题
// （徽标跟着换），容易答串上下文。
//
// 本角标把「本卷待答数」写到卷首——与组合芯片同一条落位纪律（见
// `docs/archive/composition-architecture/designs/S6-per-agent-composition.md` §8）：
//   · 绝对定位覆盖、**不进高度流水**（不动 FOLIO_TOKENS / 测高，既有画布零位移）；
//   · 卷首本体 `pointer-events: none`，本控件子树单独放开；
//   · 锚点以**版心**为参照系（左上方——右上方是组合芯片的位）。
//
// 语义分色沿用卡架铁律：**朱砂 = 人的批改动作**（写操作批准卡）、**石青 = 机在问人**
// （ask_user 提问卡）。零待答 = 不渲染（卷首保持原样，不加常驻噪声）。
//
// 点击 = 跳到该卷（`core.switchToSession(sid)`）——把注意力导过去；**不改变队列顺序**
// （队列真源在卡架内部，本批不碰它）。
//
// 数据真源 = `state/ask-pending-store`（chat-core 交付入账 / 答复结账），本控件只读。

import type { FolioAskBadgeCore } from './host';
import { useAskPendingStore } from './host';

export interface FolioAskBadgeProps {
  core: FolioAskBadgeCore | null;
  /** 本卷号（`RegionView.sessionId`，string 形——入口集中转换，与组合芯片同款）。 */
  sessionId: string;
}

export function FolioAskBadge({ core, sessionId }: FolioAskBadgeProps) {
  const entries = useAskPendingStore((s) => s.entries);
  const sidNum = sessionId === '' ? Number.NaN : Number(sessionId);
  const sid = Number.isFinite(sidNum) ? sidNum : null;
  if (sid === null) return null;

  const mine = entries.filter((e) => (e.ownerSid ?? null) === sid);
  if (mine.length === 0) return null;

  const perm = mine.filter((e) => e.kind === 'perm').length;
  const ask = mine.length - perm;
  const tip = [
    perm > 0 ? `待批 ${perm}（写操作批准卡）` : '',
    ask > 0 ? `待答 ${ask}（提问卡）` : '',
    ...mine.map((e) => `· ${e.kind === 'perm' ? '批' : '答'} ${e.label}`),
    '点此跳到本卷',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <button
      type="button"
      className="pp-folio-ask"
      data-folio-ask-badge
      data-session-id={sessionId}
      data-tip={tip}
      onClick={() => {
        // 先顶队头（本卷的卡成为当前卡），再跳过去——顺序反了会先切卷再换卡，
        // 中间那一帧用户看到的是别的卷的卡。
        core?.promoteAskBySession?.(sid);
        core?.switchToSession?.(sid);
      }}
    >
      {perm > 0 && (
        <span className="pp-folio-ask-part pp-folio-ask-part--perm" data-kind="perm">
          <span className="pp-folio-ask-dot" aria-hidden="true" />
          待批 {perm}
        </span>
      )}
      {ask > 0 && (
        <span className="pp-folio-ask-part pp-folio-ask-part--ask" data-kind="ask">
          <span className="pp-folio-ask-dot" aria-hidden="true" />
          待答 {ask}
        </span>
      )}
    </button>
  );
}

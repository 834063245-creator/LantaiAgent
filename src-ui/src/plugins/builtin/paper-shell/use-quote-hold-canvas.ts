// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-quote-hold-canvas — **画布上那张卡的长按引用**（2026-11-20 用户要）。
//
// 与坞里那枚夹签的长按是**同一份手势核心**（`quote-drop` 的 `useQuoteHold`），差别只在：
//   · `allowOwn: true` —— 画布上的卡不属于任何槽，落在**哪一卷**就引用进哪一卷，
//     包括它自己来源的那一卷（坞里那枚落在本卷才是无操作）；
//   · 起点 = 块（不是夹签轨上的一枚），故块身份与卷号在这里暂存。
//
// ── 两条实机病灶（2026-11-20 用户报「画面跳变」「收回失效」）──
//
// ① **不许在块内的交互件上起手**：`useDragGesture.begin` 会立刻对 `currentTarget`
//    `setPointerCapture`。块根一拍就捕获 ⇒ 块内按钮（收回 / 抄录 / 立枝…）的 click
//    被重定向到块根、**永远不触发**。判据 = 事件源不在 `button, a, input, [role=button]`
//    也不在拖拽把手（`.pp-kind` / `.pp-drag-handle`）里——那些位置各有自己的手势。
//    （同 `use-composer-float.ts`「拖动期捕获会掐断 click/dblclick」那条实测同族。）
//
// ② **只在被按住的那一块上给回执**：`holding` 是单个布尔，早先挂在**每一块**上 ⇒
//    按下那一刻整屏块一起变样。这里改成给出「哪一块」，纸面只标那一块。

import { useCallback, useRef, useState } from 'react';
import { quoteCardOf } from './card-quote-of';
import type { SourcedBlock } from './host';
import { useToastStore } from './host';
import { useQuoteHold } from './quote-drop';

/** 块内这些位置**不归长按管**：它们有各自的点击/拖拽语义，捕获会掐断它们。 */
const INTERACTIVE = 'button, a, input, textarea, select, [role="button"], .pp-kind, .pp-drag-handle';

export function useQuoteHoldCanvas(params: {
  /** 本面板的 chat store id（写槽与取 core 都经它）。 */
  panelId: string | null;
  /** 写夹签槽的入口（装配根持有 input-store 的用法，本件不重复一遍）。 */
  moveCardToSlot: (slot: string, card: NonNullable<ReturnType<typeof quoteCardOf>>) => 'moved' | 'duplicate';
}) {
  const { panelId, moveCardToSlot } = params;
  /** 这次长按是从哪一块起的（手势 hook 只经手指针事件，块身份在这里暂存）。 */
  const held = useRef<{ block: SourcedBlock; sessionNum: number } | null>(null);
  /** **正在被按住的那一块**（回执只标它——见头注 ②）。 */
  const [holdingBlockId, setHoldingBlockId] = useState<string | null>(null);

  const hold = useQuoteHold({
    ownSession: '',
    allowOwn: true,
    onDrop: (target) => {
      const start = held.current;
      held.current = null;
      setHoldingBlockId(null);
      if (!start || panelId === null) return;
      const card = quoteCardOf(start.block, start.sessionNum);
      if (!card) return;
      const result = moveCardToSlot(`s:${target}`, card);
      if (result === 'duplicate') {
        useToastStore.getState().showToast(`第 ${target} 卷的夹签槽里已经有这枚了`, 'warn', 2600, 'composer');
      }
    },
    onAbandon: () => {
      held.current = null;
      setHoldingBlockId(null);
    },
  });

  /** 挂在块外层的 onPointerDown 上。非资产块 / 交互件上**不起手**。 */
  const begin = useCallback(
    (e: React.PointerEvent, block: SourcedBlock, sessionNum: number) => {
      if (!block.asset) return;
      const target = e.target as Element | null;
      // ① 交互件归它们自己（否则收回/抄录这些按钮的 click 会被捕获掐断）
      if (typeof target?.closest === 'function' && target.closest(INTERACTIVE)) return;
      held.current = { block, sessionNum };
      setHoldingBlockId(block.id);
      hold.begin(e);
    },
    [hold],
  );

  return { state: hold.state, holdingBlockId, begin };
}

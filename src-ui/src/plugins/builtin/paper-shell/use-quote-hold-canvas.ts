// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-quote-hold-canvas — **画布上那张卡的长按引用**（2026-11-20 用户要）。
//
// 与坞里那枚夹签的长按是**同一份手势核心**（`quote-drop` 的 `useQuoteHold`），差别只在：
//   · `allowOwn: true` —— 画布上的卡不属于任何槽，落在**哪一卷**就引用进哪一卷，
//     包括它自己来源的那一卷（坞里那枚落在本卷才是无操作）；
//   · 起点 = 块（不是夹签轨上的一枚），故块身份与卷号在这里暂存。
//
// ⚠ 与块拖拽（拖出钉住）共存：两者都在块的 pointerdown 上起手，但判据不同——
//   过 8px 未满 320ms = 拖块/滚动（长按作废）；满 320ms = 引用（此时再移动才是「拖给某卷」）。

import { useCallback, useRef } from 'react';
import { quoteCardOf } from './card-quote-of';
import type { SourcedBlock } from './host';
import { useToastStore } from './host';
import { useQuoteHold } from './quote-drop';

export function useQuoteHoldCanvas(params: {
  /** 本面板的 chat store id（写槽与取 core 都经它）。 */
  panelId: string | null;
  /** 写夹签槽的入口（装配根持有 input-store 的用法，本件不重复一遍）。 */
  moveCardToSlot: (slot: string, card: NonNullable<ReturnType<typeof quoteCardOf>>) => 'moved' | 'duplicate';
}) {
  const { panelId, moveCardToSlot } = params;
  /** 这次长按是从哪一块起的（手势 hook 只经手指针事件，块身份在这里暂存）。 */
  const held = useRef<{ block: SourcedBlock; sessionNum: number } | null>(null);

  const hold = useQuoteHold({
    ownSession: '',
    allowOwn: true,
    onDrop: (target) => {
      const start = held.current;
      held.current = null;
      if (!start || panelId === null) return;
      const card = quoteCardOf(start.block, start.sessionNum);
      if (!card) return;
      const result = moveCardToSlot(`s:${target}`, card);
      if (result === 'duplicate') {
        useToastStore.getState().showToast(`第 ${target} 卷的夹签槽里已经有这枚了`, 'warn', 2600, 'composer');
      }
    },
  });

  /** 挂在块外层的 onPointerDown 上。非资产块**不起手**（正文段/工具卡没有卡的「本体」）。 */
  const begin = useCallback(
    (e: React.PointerEvent, block: SourcedBlock, sessionNum: number) => {
      if (!block.asset) return;
      held.current = { block, sessionNum };
      hold.begin(e);
    },
    [hold],
  );

  return { state: hold.state, begin };
}

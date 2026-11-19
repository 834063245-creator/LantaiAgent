// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// quote-target — **夹签落给谁**（docs/plans/card-quote-plan.md §2.3「归属模型」）。
//
// 槽是**每卷一份**（真源 = input-store 的 live 槽 + `sessionDrafts`）。引用动作发生在
// 画布/架阁这两个「不属于某一卷」的面上，所以落槽前必须先回答「此刻这一卷是谁」：
//
//   ① `liveOwner` 已认领（切过卷/落过纸）→ 就是它；
//   ② 未认领（冷启动恢复了工作区、用户还没碰过输入框）→ 按**当前活跃卷**认领——
//      不认领直接往 live 里塞，下一次 `claimLive` 会把这份 live 当作旧主的草稿写回去，
//      夹签就飘到了不相干的卷（正是「换手丢夹签」那条雷）；
//   ③ 既无卷又无纸（空画布）→ 返回空串，调用方据此**禁用**入口（方案 §2.2 态一）。
//
// 本件住在纸壳包内：`quoteSlotOf` 是纯读函数（不持状态），`useQuoteReady` 只订阅
// sess / 纸两个既有读面（不新增数据源、不新增宿主面键）。

import { useCallback, useEffect, useState } from 'react';
import { draftInputKey, focusedPaper, getChatStore, useDraftSheetStore } from './host';

/** 此刻这枚夹签该落进哪个槽（`s:<id>` / `draft:<paperId>`）；空串 = 无处可落。 */
export function quoteSlotOf(panelId: string): string {
  const input = getChatStore(panelId).input.getState();
  if (input.liveOwner) return input.liveOwner;
  const sess = getChatStore(panelId).sess.getState();
  const active = sess.sessions[sess.activeIdx];
  if (active) return `s:${active.id}`;
  const paper = focusedPaper();
  if (paper) return draftInputKey(paper.id);
  return '';
}

/** 「此刻有没有地方可落」的响应式读数（块操作条据此置灰「引用」）。
 *
 *  订阅两个面：sess（开卷/删卷）与待题纸（落纸/弃纸）——**认领态（liveOwner）不进
 *  订阅**：它只会在「有卷或有纸」时才非空，两个订阅源任一变化都会重算，多订一层
 *  只会在打字热路径上多跑一次。 */
export function useQuoteReady(panelId: string | null): boolean {
  const [ready, setReady] = useState(false);
  const paperFocused = useDraftSheetStore((s) => s.focusedId !== null);
  const recompute = useCallback(() => {
    setReady(panelId ? quoteSlotOf(panelId) !== '' : false);
  }, [panelId]);
  useEffect(() => {
    // 纸一变就重算（体里显式读 paperFocused——它是**触发器**，判据仍只认 quoteSlotOf）
    void paperFocused;
    recompute();
    if (!panelId) return;
    return getChatStore(panelId).sess.subscribe(recompute);
  }, [panelId, recompute, paperFocused]);
  return ready;
}

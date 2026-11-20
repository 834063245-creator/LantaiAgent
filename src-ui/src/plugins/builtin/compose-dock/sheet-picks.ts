// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// sheet-picks — **题签第四格（权限）的唯一写入口**（2026-11-29 权限记忆批）。
//
// 病灶（用户报「权限那一格设置没持久化」）：题签这一格有**两条落账路径**，而只有一条
// 记得「下一张纸的出厂值」：
//   · 卷首档行直接选（常询 / 半放 / 跟随工作区）→ `DraftFolioSurface` 写题签 + 记出厂值；
//   · 选「全放」→ 只弹确认，落账归渲染那个模态的宿主（纸期输入面的 `applyMode`）——
//     那一位只写了**这一张纸**的题签，**没写** `sheetPermissionDefault`。
//   ⇒ 全放用户（本机工作区默认正是 yolo）在纸上拨完，下一张纸照样回到「跟随工作区」，
//     重启后也没有任何记号（settings.agent.sheetPermissionMode 从未落过盘）。
//
// 纪律：**同一个动作一个实现**——两条路径都调本函数，别在调用点各写一份。
//   `mode === null` = 「跟随工作区」（清掉纸上的显式值，出厂记号也一并清）。

import { type PermissionMode, useDraftSheetStore, useModeStore } from './host';

/** 写**这张纸**的权限那一格，并记成**下一张纸**的出厂值。
 *
 *  @param paperId - 目标纸（`null` = 焦点那张——裸挂单件/坞期的旧语义）。
 *  @param mode    - 三档之一，或 `null`（跟随工作区）。
 *
 *  ⚠ 纸不在（迟到回调 / 已被弃）：**只记出厂值，不写题签**——空写会落到焦点那张身上，
 *  等于替别人改题签（同 `use-composer-models` 的 paper 判据）。
 *  ⚠ 出厂值写的是 `mode-store.sheetPermission`（待题纸出厂权限），**不是**工作区默认
 *  `permissionMode`：在纸上拨一下是给下一张纸留记号，不该顺手改掉所有未覆盖的卷。 */
export function writeSheetPermission(paperId: string | null, mode: PermissionMode | null): void {
  const st = useDraftSheetStore.getState();
  const id = paperId ?? st.focusedId;
  const paper = id === null ? null : (st.papers.find((p) => p.id === id) ?? null);
  if (paper?.picks) st.setPicks({ ...paper.picks, permission: mode }, paper.id);
  useModeStore.getState().setSheetPermissionDefault(mode);
}

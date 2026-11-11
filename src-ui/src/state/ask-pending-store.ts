// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ask-pending-store — 「已递到卡架、还没作答」的待答账（2026-11-11 画布多卷审批 UX）。
//
// 病灶（用户 2026-11-11 提出）：卡架是**全局单架**（.psh-host 固定在屏幕底部居中、
// z 500 浮于一切之上），多卷并行时只贴一张卡、其余在 FIFO 里排队；而画布上
// **没有一处能看出「哪卷在等我」**——卷首、卷签、小地图都没有痕迹。用户答完一张，
// 下一张可能瞬间换成另一卷的问题（徽标跟着换），容易答串上下文。
//
// 本账把「谁在等」从卡架内部队列里提出来，变成**可订阅的事实**，供两处消费：
//   ① 卷首待答角标（paper-shell 的 `FolioAskBadge`：按 ownerSid 过滤本卷，点它跳卷）；
//   ② 卡架下方的待答缩略行（ask-cards 的 `AskPendingStrip`：全卷一张单子）。
//
// 记账方唯一 = `app/chat/chat-core`（全库唯一经手「把请求交给卡架」与「收到答复」的地方）：
//   - ask：`_consumePendingAsk` 递卡前 upsert；包一层 callback，在答复/取消时 settle。
//   - 权限：`showPermissionCard` 递卡前 upsert；Promise 的 finally settle。
//
// 与 `state/ask-store.ts` 的分工（两本账不互相猜测）：
//   - ask-store = **还没递到卡架**的请求队列（调度用；跨 chat-core 重建存活）；
//   - 本账 = **已递到卡架**的待答事实（展示用；随答复消失）。
//
// 不变量：entries 里 id 唯一；settle 幂等（未知 id / 重复调用 = no-op）；
// 入账序 = 交付序（FIFO 展示口径与卡架队列一致）。

import { create } from 'zustand';

export type PendingAskKind = 'ask' | 'perm';

export interface PendingAskEntry {
  /** 唯一键（`ask-<ts>-<rand>` / `perm-<tool>-<ts>`，与卡片 id 同源）。 */
  id: string;
  /** 归属卷号；null = 无归属（活跃卷兜底 / 面板级）。 */
  ownerSid: number | null;
  kind: PendingAskKind;
  /** 一句话摘要（问题句首行 / 工具名 + 对象）——缩略行正文与角标 tooltip 共用。 */
  label: string;
  /** 卷名徽标（多卷并发时「替哪卷」；无归属 = null）。 */
  badge: string | null;
  /** 入账时刻（FIFO 展示顺序真源）。 */
  at: number;
}

interface AskPendingState {
  entries: PendingAskEntry[];
  /** 入账 / 覆盖同 id（幂等——重复交付不会产生第二条）。 */
  upsert: (e: PendingAskEntry) => void;
  /** 结账（答复 / 取消 / 超时都走它；未知 id = no-op）。 */
  settle: (id: string) => void;
  /** 按卷结账（停卷 / 切工作区时兜底清场——卡架 dismiss 的另一半）。 */
  settleByOwner: (ownerSid: number | null) => void;
  /** 全清（卡架卸载 / 工作区切换）。 */
  reset: () => void;
}

export const useAskPendingStore = create<AskPendingState>((set, get) => ({
  entries: [],
  upsert: (e) =>
    set({
      entries: [...get().entries.filter((x) => x.id !== e.id), e],
    }),
  settle: (id) => {
    const cur = get().entries;
    if (!cur.some((x) => x.id === id)) return; // 幂等，不制造无谓重渲染
    set({ entries: cur.filter((x) => x.id !== id) });
  },
  settleByOwner: (ownerSid) => {
    const key = ownerSid ?? null;
    const cur = get().entries;
    const next = cur.filter((x) => (x.ownerSid ?? null) !== key);
    if (next.length !== cur.length) set({ entries: next });
  },
  reset: () => {
    if (get().entries.length > 0) set({ entries: [] });
  },
}));

/** 按卷聚合（卷首角标读面）。返回 Map：sid → { ask, perm, total }。 */
export function pendingCountsBySid(
  entries: readonly PendingAskEntry[],
): Map<number | null, { ask: number; perm: number; total: number }> {
  const out = new Map<number | null, { ask: number; perm: number; total: number }>();
  for (const e of entries) {
    const key = e.ownerSid ?? null;
    const acc = out.get(key) ?? { ask: 0, perm: 0, total: 0 };
    if (e.kind === 'ask') acc.ask++;
    else acc.perm++;
    acc.total++;
    out.set(key, acc);
  }
  return out;
}

/** 摘要截断（角标 tooltip / 缩略行共用；超长按字符截断，补省略号）。 */
export function clipLabel(text: string, max = 42): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

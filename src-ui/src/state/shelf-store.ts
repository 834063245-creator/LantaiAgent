// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// shelf-store — 架阁浮层的开合账（docs/plans/entity-shelf-plan.md B3）。
//
// 只有一件事：浮层开/关 + 停在哪个页签。**数据不在这里**——软件页读
// `state/plugin-window-store` 的 defs，卡片页读 `agent/card-library` 的 RPC。
// 本 store 是纯 UI 状态：不落盘、不跨会话、不缓存任何卡片内容。
//
// 为什么单开一个 store 而不是塞进 dock/shell：架阁是**随时可开的查询面**
// （不属于某个面板的开关态），与「设置面板开着没」同层不同义。

import { create } from 'zustand';

/** 两页（用户 2026-12-08 拍板：软件型 / 卡片型）。 */
export type ShelfPage = 'app' | 'card';

export const SHELF_PAGE_LABEL: Record<ShelfPage, string> = {
  app: '软件型',
  card: '卡片型',
};

interface ShelfState {
  open: boolean;
  /** 上次停留的页（会话内记忆—— reopened 回到它，不跨重启）。 */
  page: ShelfPage;
  openShelf: (page?: ShelfPage) => void;
  closeShelf: () => void;
  setPage: (page: ShelfPage) => void;
}

export const useShelfStore = create<ShelfState>((set) => ({
  open: false,
  page: 'app',
  openShelf: (page) => set((s) => ({ open: true, page: page ?? s.page })),
  closeShelf: () => set({ open: false }),
  setPage: (page) => set({ page }),
}));

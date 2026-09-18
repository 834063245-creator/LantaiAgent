// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// session-volumes-store — 卷清单变更信号（2026-09-18 侧栏载入批）。
// 发射点：卷文件写面（`ui/chat-session.ts` 的 writeSessionSnapshot / deleteSessionFile）
// ——**写落定之后**才 bump（此前调用方拿到的都是写前状态）。
// 消费者：卷清单消费面（案卷侧栏 / 书脊）——订阅 tick 即重读清单投影
// （`listSavedSessions` 有写代投影缓存，重读零 I/O：写面已就地更行）。
//
// 为什么不靠摊开集（sess store）事件：① 落盘**晚于**摊开集变化（saveActiveSession
// 先 setSessionTokens 再写；closeSession 先发起写再改摊开集）——按摊开集重读会读到
// 写前状态；② 新卷首存之后不再有任何摊开集事件，侧栏会一直显示「未存」——那是假
// 信号（「未存」的语义是「自动存可能失败了」，见 session-sidebar-model.sessionMeta）。
// 形态沿用 state/turn-done-store.ts（版本号信号，不带业务数据）。

import { create } from 'zustand';

interface SessionVolumesState {
  /** 卷清单版本（卷文件每落定一次写入 +1）。 */
  volumesTick: number;
}

export const useSessionVolumesStore = create<SessionVolumesState>(() => ({
  volumesTick: 0,
}));

/** 通知卷清单已变更（保存/改名/合卷落定、删除成功——写前勿调）。 */
export function bumpSessionVolumes(): void {
  useSessionVolumesStore.setState((s) => ({ volumesTick: s.volumesTick + 1 }));
}

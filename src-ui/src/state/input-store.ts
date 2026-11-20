// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 输入存储 — 文本输入、文件附件、输入历史。
// 从 chat-store.ts 拆分（god store → 领域存储）。

import { create } from 'zustand';
import type { ChatImageRef } from '../provider/types';
import { type QuoteCard, quoteKeyOf } from './card-quote';
import { createScopedStore } from './scoped-store';

/** 单个会话的输入草稿快照 —— 会话切换时保存/恢复。 */
export interface SessionDraft {
  inputText: string;
  attachedFiles: Array<{ path: string; name: string; size: number }>;
  /** 附图引用（multimodal-image-plan B1——与文件附件并列的图片草稿槽）。 */
  attachedImages: ChatImageRef[];
  /** **夹签槽**（卡片引用，card-quote-plan §2.3）：引用过的卡片（只存元数据）。
   *  每卷一份、随草稿换手——给 B 卷的夹签在 A 卷看不到，这正是「归属」的意思。 */
  attachedCards: QuoteCard[];
  inputHistory: string[];
  inputHistoryIdx: number;
  draftText: string;
}

/** 从 live 输入 store 当前状态提取草稿快照（不含 sessionId）。 */
export function snapshotDraft(s: InputStore): SessionDraft {
  return {
    inputText: s.inputText,
    attachedFiles: s.attachedFiles,
    attachedImages: s.attachedImages,
    attachedCards: s.attachedCards,
    inputHistory: s.inputHistory,
    inputHistoryIdx: s.inputHistoryIdx,
    draftText: s.draftText,
  };
}

/** 空草稿（用于新建会话 / 清空缓冲槽）。 */
function emptyDraft(): SessionDraft {
  return {
    inputText: '',
    attachedFiles: [],
    attachedImages: [],
    attachedCards: [],
    inputHistory: [],
    inputHistoryIdx: -1,
    draftText: '',
  };
}

interface InputStore {
  inputText: string;
  attachedFiles: Array<{ path: string; name: string; size: number }>;
  /** 附图引用草稿（multimodal-image-plan——采集准入后入槽，发送时随消息带走）。 */
  attachedImages: ChatImageRef[];
  /** **夹签槽**（卡片引用，docs/plans/card-quote-plan.md §2.3）：本卷引用过的卡片。
   *  与附图道并列、同一条「发送即消费」纪律；每卷一份（随 SessionDraft 换手）。 */
  attachedCards: QuoteCard[];
  inputHistory: string[];
  inputHistoryIdx: number;
  draftText: string;

  /** 非活跃目标（会话 / 待题纸）的草稿槽：槽键 → 该目标未发送的输入。
   *
   *  live 状态只属于**当前输入焦点**那一个目标。焦点 = 活跃卷（常态）或某张待题纸
   *  （2026-11-17 多纸改判：纸有自己的输入，不再窃取面板这份 live 槽）。
   *  槽键：会话 = `String(sessionId)`；待题纸 = `draft:<paperId>`（见 draft-sheet-store
   *  的 `draftInputKey`，那是唯一发号处）。 */
  sessionDrafts: Record<string, SessionDraft>;

  setInputText: (text: string) => void;
  setAttachedFiles: (files: Array<{ path: string; name: string; size: number }>) => void;
  addAttachedFile: (file: { path: string; name: string; size: number }) => void;
  removeAttachedFile: (idx: number) => void;
  clearAttachedFiles: () => void;
  setAttachedImages: (images: ChatImageRef[]) => void;
  addAttachedImage: (image: ChatImageRef) => void;
  removeAttachedImage: (idx: number) => void;
  clearAttachedImages: () => void;
  setAttachedCards: (cards: QuoteCard[]) => void;
  /** 追加一枚夹签（同卡去重，方案 §2.5）。**返回 false = 槽里已有**（调用方据此
   *  闪一下那枚 + toast「已在夹签槽里」，不新增）。 */
  addAttachedCard: (card: QuoteCard) => boolean;
  removeAttachedCard: (idx: number) => void;
  clearAttachedCards: () => void;
  /** 把夹签直接递进**指定卷的草稿槽**（长按拖到 B 卷，方案 §2.2 态二）：不切活跃卷、
   *  不动 live——B 卷 `claimLive` 时才把它带出来。返回 false = 该槽里已有这张卡。
   *
   *  ⚠ 长按拖拽走的是 `moveAttachedCardToSlot`（拖动 = **挪**，不是复制）；
   *  本方法留给「同一枚夹签要在两卷各留一份」的场合。 */
  addAttachedCardToSlot: (slot: string | number, card: QuoteCard) => boolean;
  /** **挪**一枚夹签：从 live 槽摘掉，同时写进目标卷的草稿槽（一步，不闪断）。
   *
   *  语义（2026-11-20 用户报「拖给别的会话后原位那枚还在」）：长按拖拽是**换归属**，
   *  不是拓印——卡本体早就拓印过一次了（它还在画布上），夹签本身只有一枚。
   *  返回 `'moved'` = 挪成；`'duplicate'` = 目标槽已有同一张卡（**原位那枚仍摘掉**：
   *  用户的意思就是「给它」，两处都留着只会让人以为没挪动）。 */
  moveAttachedCardToSlot: (slot: string | number, card: QuoteCard) => 'moved' | 'duplicate';
  pushInputHistory: (text: string) => void;
  setInputHistory: (history: string[]) => void;
  setInputHistoryIdx: (idx: number) => void;
  setDraftText: (text: string) => void;

  /** **当前 live 输入归谁**：`s:<sessionId>`（活跃卷）或 `draft:<paperId>`（待题纸）；
   *  '' = 未认领（还没有任何目标占用过输入框）。
   *
   *  为什么需要显式记「归谁」：2026-11-17 多纸改判后，live 槽在**卷与纸之间换手**
   *  ——点某张题签 → 纸拿走输入；点某卷 → 卷拿回来。换手必须「先存旧主、再取新主」，
   *  而旧主是谁不能靠猜（活跃卷恒在，但纸拿走输入时活跃卷并不是旧主）。
   *  与「切卷」是同一条动作：切卷只是 owner 从 `s:A` 换到 `s:B`。 */
  liveOwner: string;
  /** 把 live 输入交给 `owner`（存旧主的草稿 → 取新主的草稿）。
   *  同一 owner 重复调用是幂等的（不覆盖正在打字的正文）。 */
  claimLive: (owner: string) => void;
  /** **丢掉 live 输入**（不写任何槽）：弃纸 / 弃卷这类「这些字不要了」的动作。
   *  与 `claimLive` 的区别只在**旧主的草稿要不要留**：留 = 换手，丢 = 弃。 */
  releaseLive: () => void;

  /** 把当前 live 草稿存入槽（焦点切离该目标前调用）。 */
  saveSessionDraft: (slot: string | number) => void;
  /** 把槽恢复为 live 草稿并删除槽；无槽则清空 live（新目标/未写过草稿）。 */
  restoreSessionDraft: (slot: string | number) => void;
  /** 删除槽（关闭会话 / 发送后清理，避免切回时复活已发送文本）。 */
  clearSessionDraft: (slot: string | number) => void;
  /** 清空全部草稿槽并重置 live 输入（整棵会话树重建，如项目重载）。 */
  clearSessionDrafts: () => void;
}

export type InputStoreApi = ReturnType<typeof createInputStoreImpl>;

function createInputStoreImpl() {
  return create<InputStore>((set) => ({
    inputText: '',
    attachedFiles: [],
    attachedImages: [],
    attachedCards: [],
    inputHistory: [],
    inputHistoryIdx: -1,
    draftText: '',
    sessionDrafts: {},
    liveOwner: '',

    setInputText: (inputText) => set({ inputText }),
    setAttachedFiles: (attachedFiles) => set({ attachedFiles }),
    addAttachedFile: (file) => set((s) => ({ attachedFiles: [...s.attachedFiles, file] })),
    removeAttachedFile: (idx) => set((s) => ({ attachedFiles: s.attachedFiles.filter((_, i) => i !== idx) })),
    clearAttachedFiles: () => set({ attachedFiles: [] }),
    setAttachedImages: (attachedImages) => set({ attachedImages }),
    addAttachedImage: (image) => set((s) => ({ attachedImages: [...s.attachedImages, image] })),
    removeAttachedImage: (idx) => set((s) => ({ attachedImages: s.attachedImages.filter((_, i) => i !== idx) })),
    clearAttachedImages: () => set({ attachedImages: [] }),
    setAttachedCards: (attachedCards) => set({ attachedCards }),
    addAttachedCard: (card) => {
      // 去重键 = 卡身份（assetId / cardId），不是 refId——同一张卡引用两次只留一枚
      let added = false;
      set((s) => {
        const key = quoteKeyOf(card);
        if (s.attachedCards.some((c) => quoteKeyOf(c) === key)) return s;
        added = true;
        return { attachedCards: [...s.attachedCards, card] };
      });
      return added;
    },
    removeAttachedCard: (idx) => set((s) => ({ attachedCards: s.attachedCards.filter((_, i) => i !== idx) })),
    clearAttachedCards: () => set({ attachedCards: [] }),
    addAttachedCardToSlot: (slot, card) => {
      const key = String(slot);
      let added = false;
      set((s) => {
        // 目标槽 = 该卷的草稿（没有就按空草稿起一份）——live 那份**不碰**
        const draft = s.sessionDrafts[key] ?? emptyDraft();
        const dedupe = quoteKeyOf(card);
        if (draft.attachedCards.some((c) => quoteKeyOf(c) === dedupe)) return s;
        added = true;
        return {
          sessionDrafts: { ...s.sessionDrafts, [key]: { ...draft, attachedCards: [...draft.attachedCards, card] } },
        };
      });
      return added;
    },
    moveAttachedCardToSlot: (slot, card) => {
      const key = String(slot);
      let result: 'moved' | 'duplicate' = 'moved';
      set((s) => {
        // ① 先从 live 摘掉这一枚（按 refId 找——同卡去重是槽内的事，挪的是**这一枚**）
        const remaining = s.attachedCards.filter((c) => c.refId !== card.refId);
        // ② 再写进目标槽（目标已有同一张卡 ⇒ 不再加，但原位那枚照样摘掉）
        const draft = s.sessionDrafts[key] ?? emptyDraft();
        const dedupe = quoteKeyOf(card);
        if (draft.attachedCards.some((c) => quoteKeyOf(c) === dedupe)) {
          result = 'duplicate';
          return { attachedCards: remaining };
        }
        return {
          attachedCards: remaining,
          sessionDrafts: { ...s.sessionDrafts, [key]: { ...draft, attachedCards: [...draft.attachedCards, card] } },
        };
      });
      return result;
    },
    pushInputHistory: (text) =>
      set((s) => {
        // 空正文不入历史（2026-11-19 纯图批）：纯图轮没有可回取的字，
        // 塞空条只会让 ↑ 历史里出现「看不见的一条」。
        if (text.trim() === '') return s;
        const filtered = s.inputHistory.filter((t) => t !== text);
        if (filtered.length >= 50) filtered.shift();
        return { inputHistory: [...filtered, text] };
      }),
    setInputHistory: (inputHistory) => set({ inputHistory }),
    setInputHistoryIdx: (inputHistoryIdx) => set({ inputHistoryIdx }),
    setDraftText: (draftText) => set({ draftText }),

    claimLive: (owner) =>
      set((s) => {
        if (s.liveOwner === owner) return s; // 幂等：同一个主人不重取（否则打字的正文被回滚）
        const drafts = { ...s.sessionDrafts };
        if (s.liveOwner) drafts[s.liveOwner] = snapshotDraft(s);
        const next = drafts[owner];
        delete drafts[owner];
        return { ...(next ?? emptyDraft()), liveOwner: owner, sessionDrafts: drafts };
      }),
    releaseLive: () => set(() => ({ ...emptyDraft(), liveOwner: '' })),
    saveSessionDraft: (slot) =>
      set((s) => ({ sessionDrafts: { ...s.sessionDrafts, [String(slot)]: snapshotDraft(s) } })),
    restoreSessionDraft: (slot) =>
      set((s) => {
        const key = String(slot);
        const saved = s.sessionDrafts[key];
        const { [key]: _dropped, ...rest } = s.sessionDrafts;
        return saved ? { ...saved, sessionDrafts: rest } : { ...emptyDraft(), sessionDrafts: rest };
      }),
    clearSessionDraft: (slot) =>
      set((s) => {
        const key = String(slot);
        if (!(key in s.sessionDrafts)) return s;
        const { [key]: _dropped, ...rest } = s.sessionDrafts;
        return { sessionDrafts: rest };
      }),
    clearSessionDrafts: () =>
      set(() => ({
        ...emptyDraft(),
        sessionDrafts: {},
        liveOwner: '',
      })),
  }));
}

// ── 每面板注册表 ──

const scoped = createScopedStore('__lantai_input_stores__', createInputStoreImpl);

export const getInputStore = scoped.getStore;

/** 从注册表中移除面板的输入存储。
 *  （2026-08-04：生产暂未接线，但有单元测试保护 — disposePanelStores 的组成部分） */
export function disposeInputStore(storeId: string): void {
  scoped.disposeStore(storeId);
}

// ── 非响应式访问器 ──
// （2026-08-04 清理：getInputText/getAttachedFiles/getInputHistory/getInputHistoryIdx/
//   getDraftText 全工程零调用，已删）

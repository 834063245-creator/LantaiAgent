// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 输入存储 — 文本输入、文件附件、输入历史。
// 从 chat-store.ts 拆分（god store → 领域存储）。

import { create } from 'zustand';
import type { ChatImageRef } from '../provider/types';
import { createScopedStore } from './scoped-store';

/** 单个会话的输入草稿快照 —— 会话切换时保存/恢复。 */
export interface SessionDraft {
  inputText: string;
  attachedFiles: Array<{ path: string; name: string; size: number }>;
  /** 附图引用（multimodal-image-plan B1——与文件附件并列的图片草稿槽）。 */
  attachedImages: ChatImageRef[];
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state/draft-sheet-store — **待题纸**（新卷出生面）的瞬态态（2026-11-14 立卷 UX）。
//
// 设计件：docs/plans/canvas-space/new-session-ux.md。
//
// **2026-11-15 定稿改判（V2）**：纸不再是「卷首 + 题签 + 开卷按钮」，而是
// **一张会打字的纸**——输入面就长在纸上（与创作坞同一个组件、同一个 input store），
// **发送即开卷**：按发送那一刻才发号建卷，纸长成正常的卷、正常的创作坞才冒出来。
//
// 语义（与「空白卷」严格区分——施工时最容易混的一处）：
//   - 待题纸 = 还没开卷的一张纸：**不占卷号、不落盘、不进侧栏**，Esc 即弃；
//   - 空白卷 = 已建卷、0 消息（`isSessionBlank` 判据）——本 store 不碰它。
//   ⇒ 本 store 是**瞬态**（跨组件共享的业务状态 → store，见 CONVENTIONS §1.2），
//     不持久化、不进卷快照、不参与 canvas.json。
//
// 为什么是 app 级单例而不是 per-panel：画布即主界面，一次只有一个纸视图
// （对齐 canvas-view-store / dock-store 的单例形态）。待题纸同一时刻最多一张
// ——再点「＋」是重定位，不是叠加（设计件 §3.5）。
//
// 为什么创作坞需要它：纸在场时**坞整只不渲染**（槽位让给纸），纸里那枚输入面是
// 同一个 ComposerDock（variant='sheet'，经宿主桥读本 store）。创作坞是独立产物，
// 直引内核路径会被 esbuild 内联成第二份 ⇒ 它永远读不到开合（同 toast-store 先例，
// 见 docs/landmine-map.md）。
//
// 题签为什么也住这里（V2）：题签不是纸的私事——**发送那一刻**由 ChatCore 读它去
// 起卷（组合落卷级登记、模型/思考落会话覆盖）。题签留在纸的组件态里，发送面就
// 读不到（两处真源）；住 store 才让「发送 = 开卷」这一条只有一个读点。

import { create } from 'zustand';
import type { StoredThinking } from '../provider/thinking';

/** 化卷那一拍（V2-P3）的窗长（ms）——**镜像 `--m-sheet`**（0.26s）。
 *
 *  为什么需要有这个窗：发送之后纸**不能立刻消失**——它要与新卷的落纸（`.pp-spread`）
 *  同一拍交接，否则用户读到的是「纸啪一下没了、卷啪一下出现」两件事。窗长必须与
 *  CSS 播的时长同值（留短了交接被掐断，留长了白占一个空窗），
 *  镜像由 `tests/motion-contract.test.ts` 的「TS ↔ --m-sheet」对拍钉死。 */
export const DRAFT_MORPH_MS = 260;

/** 动效敏感（`prefers-reduced-motion`）：化卷那一拍直接跳过——纸当帧撤、卷当帧落，
 *  与 `foundation.css` 把时长压到 0.01ms 的语义一致（先例：use-paper-focus 的 rAF 飞行）。 */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 落纸锚点（世界坐标；与 StreamRegionState 同形，避免第二套坐标语言）。 */
export interface DraftSheetAnchor {
  anchorX: number;
  anchorY: number;
  width: number;
}

/** 题签三笔（**开卷那一刻**由 ChatCore 落到既有写路径上，纸期零持久状态）。
 *  `presetId: null` = 跟随全局默认；模型/思考全默认 ⇒ 零覆盖（照常跟随全局）。 */
export interface DraftPicks {
  presetId: string | null;
  providerName: string;
  model: string;
  thinking: StoredThinking | undefined;
}

/** 化卷那一拍（V2-P3）：纸已化成卷，但**还在屏上**——与新卷的落纸同一窗交接。
 *  `sessionId` = 刚化成的那一卷（纸要「交给」它）；窗满才真撤纸。 */
export interface DraftMorph {
  sessionId: number;
}

export interface DraftSheetState {
  /** 出生面是否摊开。 */
  open: boolean;
  /** 化卷交接（null = 没在交接）。**开工的 'open' 与它互斥**：交接期 open 已 false，
   *  纸张力上仍渲染（看 `morph`），坞也仍不渲染——这样「坞冒出来」与「纸消失」是
   *  同一拍的两端，不会出现中间态（坞与纸同时在屏上）。 */
  morph: DraftMorph | null;
  /** 落纸锚点（null = 尚未落位——由落纸方按「视口中心最近空位」算）。 */
  anchor: DraftSheetAnchor | null;
  /** 预选组合（「✎ 造模式」= 'creator'；null = 跟随全局默认）——摊开时的种子。 */
  presetId: string | null;
  /** 题签三笔（null = 纸刚摊开、纸面尚未填出厂默认）。 */
  picks: DraftPicks | null;
  /** 开卷被拒的原因（写在纸脚，错误不静默；成功即清）。 */
  notice: string | null;
  /** 摊开出生面（已开 = 只更新锚点/预选，不叠加第二张）。 */
  openSheet: (init?: { anchor?: DraftSheetAnchor | null; presetId?: string | null }) => void;
  /** 落位/移动（落纸方算完锚点后回填）。 */
  setAnchor: (anchor: DraftSheetAnchor | null) => void;
  /** 题签：整份写（纸面摊开时填出厂默认）。 */
  setPicks: (picks: DraftPicks) => void;
  /** 题签：拨组合（V2 起组合也在纸面上拨，与模型同处一行）。 */
  setPresetId: (presetId: string | null) => void;
  setNotice: (notice: string | null) => void;
  /** **化卷**（V2-P3）：发送成功那一刻调用——纸退成「已交卷」态，与卷的落纸同一窗。
   *  窗满由本 store 自己撤纸（`DRAFT_MORPH_MS`）；动效敏感 = 当帧撤。 */
  beginMorph: (sessionId: number) => void;
  /** 弃纸（Esc / 切工作区 / 关画布）：不烧号、不落盘。 */
  dismiss: () => void;
}

/** 化卷交接的撤纸定时器（模块级单例：**同一时刻最多一张纸**，故一只表够）。
 *  打开新纸 / 弃纸 / 组件卸载都清它——迟到的定时器不许把新纸的 morph 抹掉。 */
let _morphTimer: ReturnType<typeof setTimeout> | null = null;

/** 清交接定时器（幂等）。 */
function clearMorphTimer(): void {
  if (_morphTimer !== null) {
    clearTimeout(_morphTimer);
    _morphTimer = null;
  }
}

export const useDraftSheetStore = create<DraftSheetState>((set, get) => ({
  open: false,
  morph: null,
  anchor: null,
  presetId: null,
  picks: null,
  notice: null,
  openSheet: (init) => {
    // 新纸 = 上一张无论处于哪一态都作废（含交接期：开新纸即撤旧纸）
    clearMorphTimer();
    set((s) => ({
      open: true,
      morph: null,
      anchor: init?.anchor === undefined ? s.anchor : init.anchor,
      presetId: init?.presetId === undefined ? s.presetId : init.presetId,
    }));
  },
  setAnchor: (anchor) => set((s) => (s.anchor === anchor ? s : { anchor })),
  setPicks: (picks) => set((s) => (s.picks === picks ? s : { picks })),
  setPresetId: (presetId) =>
    set((s) => (s.picks === null || s.picks.presetId === presetId ? s : { picks: { ...s.picks, presetId } })),
  setNotice: (notice) => set((s) => (s.notice === notice ? s : { notice })),
  beginMorph: (sessionId) => {
    clearMorphTimer();
    // 动效敏感：纸当帧撤（不留一座「停在那儿的纸」给用户）
    if (prefersReducedMotion()) {
      get().dismiss();
      return;
    }
    /* 交接期 = open 已 false（**坞立刻可以出现**：它属于新卷）、morph 在场（纸张力上还在）。
     * 纸的题签与锚点**保留到窗满**——纸还在屏上，突然清空会闪一下空白。 */
    set({ open: false, morph: { sessionId } });
    _morphTimer = setTimeout(() => {
      _morphTimer = null;
      get().dismiss();
    }, DRAFT_MORPH_MS);
  },
  dismiss: () => {
    clearMorphTimer();
    set((s) =>
      s.open || s.morph !== null || s.anchor !== null || s.presetId !== null || s.picks !== null || s.notice !== null
        ? { open: false, morph: null, anchor: null, presetId: null, picks: null, notice: null }
        : s,
    );
  },
}));

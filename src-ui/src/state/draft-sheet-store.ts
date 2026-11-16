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

/** 交接期纸盒（世界坐标，**由卷侧回填**，且**只回填左缘与宽**）。
 *
 *  历史（2026-11-15 → 11-16 推翻）：原议是「纸与卷全程锁在同一个盒里」，理由是两者高度
 *  不等（卷落进首块 552 / 纸实测 490）。但两条盒的**盒底相同**（都是锚点 + 底距），
 *  于是借卷的盒 = 把纸的上缘往上挪 62px ⇒ 天头四行在交接第一帧瞬跳（真机定帧实测）。
 *  本轮的改判是「纸不动，字换页」：盒归纸自己（RO 在交接期冻结），卷多出来的那 63px
 *  是「它多了一行正文」的几何后果，不该由纸去承担。
 *  真源 = PaperPanel 渲染期的 rise 卷几何，只取 `anchorX - width/2` 与 `width`。 */
export interface DraftMorphBox {
  left: number;
  /** 恒为 null（2026-11-16 改判）：上缘归纸自己——借卷的上缘 = 天头瞬跳 62px。 */
  top: number | null;
  width: number;
  /** **卷的高**（不是纸该有的高）：两件盒底相同 ⇒ `height − 纸高` = 天头要抬起的高度。
   *  纸拿它把天头平移到卷首将落的位置，纸的盒本身不动。 */
  height: number | null;
}

/** 化卷那一拍（V2-P3）：纸已化成卷，但**还在屏上**——与新卷的落纸同一窗交接。
 *  `sessionId` = 刚化成的那一卷（纸要「交给」它）；窗满才真撤纸。
 *  `sheetId` = 交接期里**纸的纸性种子**（= 新卷 id）——见 PaperPanel 里「交接期的纸走本字段」。 */
export interface DraftMorph {
  sessionId: number;
  sheetId: string;
  /** 交接期纸盒（null = 卷几何还没量到，纸按自己的实测盒走）。 */
  box: DraftMorphBox | null;
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
  /** 落纸代数：**每摊开一次纸 +1**。落位方（DraftSheet）据此判定「这一拍要把镜头带过去」。
   *
   *  为什么不是「anchor 变了才飞」：再点「＋」= 把当前这张纸重新定位（设计件 §3.5），
   *  而落位算法是幂等的——anchor 与上一张纸同值（画布没动过）时，只看 anchor 就不飞，
   *  而用户这一下要的恰恰是「回到那张纸去」。代数由摊开动作推进，与几何无关。 */
  landNonce: number;
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

/** **出生即交接**那一卷的账（2026-11-15 化卷批）。
 *
 *  判据只有一个问题：**这一卷的入场要不要再淡一次纸？**
 *    · 普通摊开（侧栏点开 / 恢复 / 立枝 / 程序起卷）：纸是新出现的 —— 淡入 + 落墨；
 *    · 待题纸化成的那一卷：纸已经在屏上整整一窗、正在同一个盒里淡出。再淡一次 = 两片半透明
 *      的纸叠着（定帧实测 0/65/130ms 三帧双重影）⇒ 这一卷只**落墨**。
 *
 *  ⚠ **必须在这里、必须在 `beginMorph` 里同步登记**：卷开合两窗的判据在**渲染期**跑（
 *  region-motion 的纪律：卷出现的那一帧就要有快照），而 effect 晚一帧——账在 effect 里写，
 *  那一卷早被当成普通摊开记进了 `played`，之后再也不会进落墨窗。
 *
 *  为什么不放 paper-shell 包内：账只有一个读点（region-motion）与一个写点（beginMorph），
 *  而写点在这里，跨包只会多一条桥。过期语义 = 一次性：弃纸即清。 */
let _riseVolume: string | null = null;
/** 「下一张出现的卷是纸化成的」——发号**之前**挂上（那时还没有卷号可用）。
 *  第一帧卷出现时（region-motion 的渲染期判据）由 `isRiseVolume` 认领并落账。 */
let _risePending = false;

/** 发号前挂账（`openDraftVolume` 在起卷前调用）：下一张出现的卷是纸化成的。 */
export function armRiseVolume(): void {
  _risePending = true;
  _riseVolume = null;
}

/** 这一卷是不是待题纸化成的（region-motion 的落纸/落墨分流判据）。
 *  ⚠ 会被**渲染期**调用（卷出现的那一帧就要分流），故认领就发生在这儿：挂着账时，
 *  第一个被问到的卷即认领为那一卷——发号与首帧之间没有第三张卷会经过这里。 */
export function isRiseVolume(sessionId: string): boolean {
  if (_riseVolume === sessionId) return true;
  if (_risePending) {
    _risePending = false;
    _riseVolume = sessionId;
    return true;
  }
  return false;
}

/** 清账（弃纸 / 切工作区）：下一卷按普通摊开处理。 */
export function clearRiseVolume(): void {
  _riseVolume = null;
  _risePending = false;
}

/** **现在该按哪一张纸取纸性**（单一判据，两个消费面：纸面本体与坞交接位）。
 *   交接期（morph 在场）⇒ 新卷 id（纸正在化成它，纹必须已经是它的）；
 *   否则 ⇒ 纸自己的种子（出生面期用固定串，见 DraftSheet 的 SHEET_SEED）。 */
export function draftSheetSeed(fallback: string): string {
  const m = useDraftSheetStore.getState().morph;
  return m ? m.sheetId : fallback;
}

/** 交接期纸盒回填（卷侧在渲染期量到就写；同值不重设，免得逐帧抖 store）。 */
export function setMorphBox(box: DraftMorphBox | null): void {
  const m = useDraftSheetStore.getState().morph;
  if (!m) return;
  if (m.box === box) return;
  if (
    m.box &&
    box &&
    m.box.left === box.left &&
    m.box.top === box.top &&
    m.box.width === box.width &&
    m.box.height === box.height
  )
    return;
  useDraftSheetStore.setState({ morph: { ...m, box } });
}

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
  landNonce: 0,
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
      // 摊开 = 一次新的落纸：落位方据此把镜头带过去（见 landNonce 注）
      landNonce: s.landNonce + 1,
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
     * 纸的题签与锚点**保留到窗满**——纸还在屏上，突然清空会闪一下空白。
     * `sheetId` 与卷同种子：交接那一窗里纸与卷必须**同一张纸**（纹不变、深浅不变），
     * 否则交叉淡入的两帧各有各的水洗，读作「换了一件东西」而不是「同一张纸成了卷」。 */
    /* 账在**这里**登记（不是组件的 effect）：卷开合两窗的判据在渲染期跑，晚一帧就已被当成
     * 普通摊开记进 played（见 isRiseVolume 头注）。beginMorph = 发号那一刻，早于任何渲染。 */
    _riseVolume = String(sessionId);
    _risePending = false;
    set({ open: false, morph: { sessionId, sheetId: String(sessionId), box: null } });
    _morphTimer = setTimeout(() => {
      _morphTimer = null;
      get().dismiss();
    }, DRAFT_MORPH_MS);
  },
  dismiss: () => {
    clearMorphTimer();
    /* `landNonce` 刻意**不**随弃纸清零：它是单调的落纸代数（见字段注）。清回 0 会让
     * 迟到的落位方读到「与上次相同」，把「再摊一张纸」的聚焦吞掉。 */
    set((s) =>
      s.open || s.morph !== null || s.anchor !== null || s.presetId !== null || s.picks !== null || s.notice !== null
        ? { open: false, morph: null, anchor: null, presetId: null, picks: null, notice: null }
        : s,
    );
  },
}));

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state/draft-sheet-store — **待题纸**（新卷出生面）的瞬态态（2026-11-14 立卷 UX）。
//
// 设计件：docs/plans/canvas-space/new-session-ux.md（V2 定稿 + §6.9 落纸聚焦）。
// 多纸改判：docs/plans/canvas-space/multi-draft-sheets.md（2026-11-17）。
//
// **2026-11-17 多纸改判**：纸不再「同一时刻最多一张」。用户报「有一张题签之后，既不能
// 回头和已有会话交互，也不能同时创建多个题签」——三个根因住在三处：
//   ①（本文件）纸是单例：anchor/picks/notice/morph 各一份 ⇒ 第二张纸只能「重定位上一张」；
//   ②（本文件 + input-store）纸窃取了**面板级 live 输入槽** ⇒ 纸在场时坞读到的也是纸上的字；
//   ③（PaperPanel/ComposerDock）「纸在场 ⇒ 坞整只不渲染」⇒ 不能跟任何已有会话说话。
// 现行形状：`papers[]`（每张纸一条：锚点 / 题签 / 失败原因）+ `focusedId`（焦点在哪张纸）
// + `morphs`（化成卷后还在屏上退场的那几张）。**焦点即归属**：焦点在纸上 ⇒ 坞让位、
// 纸上的输入面可打字；焦点回到卷/画布 ⇒ 坞立刻回来，纸留在画布上（只显示天头 + 题签）。
//
// 语义（与「空白卷」严格区分——施工时最容易混的一处）：
//   - 待题纸 = 还没开卷的一张纸：**不占卷号、不落盘、不进侧栏**，Esc 弃当前这张；
//   - 空白卷 = 已建卷、0 消息（`isSessionBlank` 判据）——本 store 不碰它。
//   ⇒ 本 store 是**瞬态**（跨组件共享的业务状态 → store，见 CONVENTIONS §1.2），
//     不持久化、不进卷快照、不参与 canvas.json。
//
// 为什么是 app 级单例而不是 per-panel：画布即主界面，一次只有一个纸视图（对齐
// canvas-view-store / dock-store 的单例形态）。多纸 = **同一张画布上的多张**。
//
// 每张纸的输入住哪：**面板 input store 的草稿槽**（`sessionDrafts`，槽键 = `draft:<id>`，
// 唯一发号处 = 本文件的 `draftInputKey`）。切焦点时与切卷同一套动作（save/restore），
// 所以纸与卷共用**同一份输入实现与同一条草稿机制**——不是第二套输入面。
//
// 题签为什么也住这里：题签不是纸的私事——**发送那一刻**由 ChatCore 读它去起卷
//（组合落卷级登记、模型/思考落会话覆盖）。题签留在纸的组件态里，发送面就读不到
//（两处真源）；住 store 才让「发送 = 开卷」这一条只有一个读点（每张纸一条）。

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

/** 一张**在办**的待题纸（还没开卷）。
 *
 *  自带锚点 / 题签 / 失败原因——全是**这张纸的私事**。输入正文不在这里：它住在
 *  面板 input store 的草稿槽 `draft:<id>`（切焦点时 save/restore，与切卷同一套机制）。 */
export interface DraftPaper {
  /** 纸的稳定标识（瞬态、进程内唯一；也是它草稿槽的键尾）。 */
  id: string;
  /** 落纸锚点（null = 尚未落位——由落纸方按「视口中心最近空位」算）。 */
  anchor: DraftSheetAnchor | null;
  /** 预选组合（「✎ 造模式」= 'creator'；null = 跟随全局默认）——摊开时的种子。 */
  presetId: string | null;
  /** 题签三笔（null = 纸刚摊开、纸面尚未填出厂默认）。 */
  picks: DraftPicks | null;
  /** 开卷被拒的原因（写在纸脚，错误不静默；成功即清）。 */
  notice: string | null;
  /** 纸的**实际盒高**（世界单位；0 = 尚未量到）。纸面组件每量到一次就回写——
   *  化卷那一刻 `beginMorph` 用它做交接期的盒快照（「纸盒一帧都不动」靠它）。 */
  boxH: number;
}

/** 化卷那一拍（V2-P3）：这张纸已化成卷，但**还在屏上**——与新卷的落纸同一窗交接。
 *  `sessionId` = 刚化成的那一卷（纸要「交给」它）；窗满才真撤纸。
 *  `sheetId` = 交接期里**纸的纸性种子**（= 新卷 id）——见 PaperPanel 里「交接期的纸走本字段」。 */
export interface DraftMorph {
  sessionId: number;
  sheetId: string;
  /** 交接期纸盒（null = 卷几何还没量到，纸按自己的实测盒走）。 */
  box: DraftMorphBox | null;
  /** **这张纸化成卷之前站在哪**（世界坐标）：交接期纸要留在原地退场，
   *  不能因为记录离开 `papers` 就跳到世界原点。 */
  anchor: DraftSheetAnchor;
  /** 纸**发送那一刻的盒高**（快照，见 `DraftPaper.boxH`）：交接期纸盒一帧都不动。
   *  0 = 快照缺席（旧记录）⇒ 纸面回落到「卷的最小盒高」。 */
  paperH: number;
}

/** 纸的草稿槽键（`state/input-store` 的 `sessionDrafts`，**唯一发号处**）。
 *  与面板 live 槽不同源：面板那份归「焦点目标」（活跃卷或这张纸），纸这份归「这张纸」。
 *  ⚠ 前缀 `draft:` 同时是「这不是卷号」的机读标记（槽表两族共处一表）。 */
export function draftInputKey(paperId: string): string {
  return `draft:${paperId}`;
}

/** 纸 id 发号（瞬态、进程内唯一；纸不烧卷号）。 */
let _paperSeq = 0;

function nextPaperId(): string {
  _paperSeq += 1;
  return `dp-${_paperSeq.toString(36)}`;
}

/** 化卷交接的撤纸定时器（纸 id → 定时器）。多纸之后**每张纸一只表**：一张纸化成卷
 *  不许把另一张正在退场的纸一起抹掉。 */
const _morphTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
 *   交接期（这张纸在 `morphs` 里）⇒ 新卷 id（纸正在化成它，纹必须已经是它的）；
 *   否则 ⇒ 纸自己的种子（出生面期用固定串，见 DraftSheet 的 SHEET_SEED）。 */
export function draftSheetSeed(paperId: string | null, fallback: string): string {
  if (paperId === null) return fallback;
  const entry = useDraftSheetStore.getState().morphs[paperId];
  return entry ? entry.sheetId : fallback;
}

/** 交接期纸盒回填（卷侧在渲染期量到就写；同值不重设，免得逐帧抖 store）。
 *  缺省纸 = 交接表里**唯一**那一张（多纸同时交接才会走到反查，那时卷侧应显式给 id）。 */
export function setMorphBox(box: DraftMorphBox | null, paperId?: string): void {
  const st = useDraftSheetStore.getState();
  const id = paperId ?? (Object.keys(st.morphs).length === 1 ? Object.keys(st.morphs)[0] : undefined);
  if (id === undefined) return;
  const entry = st.morphs[id];
  if (!entry) return;
  if (entry.box === box) return;
  if (
    entry.box &&
    box &&
    entry.box.left === box.left &&
    entry.box.top === box.top &&
    entry.box.width === box.width &&
    entry.box.height === box.height
  )
    return;
  useDraftSheetStore.setState({ morphs: { ...st.morphs, [id]: { ...entry, box } } });
}

/** 清一张纸的交接定时器（幂等）。 */
function clearMorphTimer(paperId: string): void {
  const t = _morphTimers.get(paperId);
  if (t !== undefined) {
    clearTimeout(t);
    _morphTimers.delete(paperId);
  }
}

/** 清全部交接定时器（弃全部 / 切工作区）。 */
function clearAllMorphTimers(): void {
  for (const t of _morphTimers.values()) clearTimeout(t);
  _morphTimers.clear();
}

export interface DraftSheetState {
  /** 在办的待题纸（按摊开顺序）。同一时刻可以有多张。 */
  papers: DraftPaper[];
  /** 焦点在哪张纸（null = 焦点不在纸上 ⇒ **坞照常渲染**，纸只显示天头 + 题签）。
   *
   *  这就是「回头和已有会话交互」的判据：点卷 / 点画布空白 / Esc 弃纸 ⇒ null；
   *  点某张纸（或刚摊开它）⇒ 该纸 id。**焦点是独占的**——同一时刻只有一张纸吃键盘，
   *  否则两处 textarea 抢输入。 */
  focusedId: string | null;
  /** 化卷交接（纸 id → 交接项）：化成卷的那张纸**不在 papers 里**，只在这里退场。 */
  morphs: Record<string, DraftMorph>;
  /** 落纸代数：**每次摊开纸 / 把焦点交给某张纸 +1**。落位方（DraftSheet）据此判定
   *  「这一拍要把镜头带过去」。
   *
   *  为什么不是「anchor 变了才飞」：点某张纸 = 把镜头带回它，而落位算法是幂等的
   *  ——anchor 与上次同值（画布没动过）时，只看 anchor 就不飞，而用户这一下要的恰恰是
   *  「回到那张纸去」。代数由摊开/聚焦动作推进，与几何无关。 */
  landNonce: number;

  /** 摊开一张新纸（**总是新增一条**，不再复用上一张）。返回它的 id 并给它焦点。 */
  openSheet: (init?: { anchor?: DraftSheetAnchor | null; presetId?: string | null }) => string;
  /** 把焦点交给某张纸；null = 交回卷/画布（坞随之回来）。未知 id 视为 null。 */
  focusSheet: (paperId: string | null) => void;
  /** 落位/移动（落纸方算完锚点后回填）。缺省纸 = 当前焦点那张。 */
  setAnchor: (anchor: DraftSheetAnchor | null, paperId?: string) => void;
  /** 题签：整份写（纸面摊开时填出厂默认）。缺省纸 = 当前焦点那张。 */
  setPicks: (picks: DraftPicks, paperId?: string) => void;
  /** 题签：拨组合（V2 起组合也在纸面上拨，与模型同处一行）。 */
  setPresetId: (presetId: string | null, paperId?: string) => void;
  setNotice: (notice: string | null, paperId?: string) => void;
  /** 纸的实测盒高回写（纸面组件量到就写；化卷时被 `beginMorph` 取作快照）。 */
  setBoxH: (boxH: number, paperId?: string) => void;
  /** **化卷**（V2-P3）：发送成功那一刻调用——这张纸退成「已交卷」态，与卷的落纸同一窗。
   *  窗满由本 store 自己撤纸（`DRAFT_MORPH_MS`）；动效敏感 = 当帧撤。 */
  beginMorph: (sessionId: number, paperId?: string) => void;
  /** 弃纸。`dismissOne(id)` = 弃一张（Esc / 纸上的「弃纸」钮）；
   *  `dismissAll()` = 全弃（切工作区 / 关画布 / 测试复位）——**两条语义不共用一个函数**：
   *  多纸之后「弃纸」与「清场」是两件事，混在一起就会在切工作区时留下一摞幽灵纸。 */
  dismissOne: (paperId: string) => void;
  dismissAll: () => void;
}

/** 当前焦点那张纸（无焦点 = null）。组件与发送面共用这一把尺子。 */
export function focusedPaper(state: DraftSheetState = useDraftSheetStore.getState()): DraftPaper | null {
  const id = state.focusedId;
  if (id === null) return null;
  return state.papers.find((p) => p.id === id) ?? null;
}

export const useDraftSheetStore = create<DraftSheetState>((set, get) => ({
  papers: [],
  focusedId: null,
  morphs: {},
  landNonce: 0,

  openSheet: (init) => {
    const id = nextPaperId();
    set((s) => ({
      papers: [
        ...s.papers,
        {
          id,
          anchor: init?.anchor ?? null,
          presetId: init?.presetId ?? null,
          picks: null,
          notice: null,
          boxH: 0,
        },
      ],
      // 新摊开的纸立刻拿焦点：用户点「＋」就是要打字，不是要一张静物
      focusedId: id,
      // 摊开 = 一次新的落纸：落位方据此把镜头带过去（见 landNonce 注）
      landNonce: s.landNonce + 1,
    }));
    return id;
  },

  focusSheet: (paperId) =>
    set((s) => {
      const next = paperId !== null && s.papers.some((p) => p.id === paperId) ? paperId : null;
      if (s.focusedId === next) return s;
      // 换焦点到某张纸 = 把镜头带回那张纸（与摊开同一条代数；交回卷不飞）
      return { focusedId: next, landNonce: next === null ? s.landNonce : s.landNonce + 1 };
    }),

  setAnchor: (anchor, paperId) =>
    set((s) => {
      const id = paperId ?? s.focusedId;
      if (id === null) return s;
      const paper = s.papers.find((p) => p.id === id);
      if (!paper || paper.anchor === anchor) return s;
      return { papers: s.papers.map((p) => (p.id === id ? { ...p, anchor } : p)) };
    }),

  setPicks: (picks, paperId) =>
    set((s) => {
      const id = paperId ?? s.focusedId;
      if (id === null) return s;
      const paper = s.papers.find((p) => p.id === id);
      if (!paper || paper.picks === picks) return s;
      return { papers: s.papers.map((p) => (p.id === id ? { ...p, picks } : p)) };
    }),

  setPresetId: (presetId, paperId) =>
    set((s) => {
      const id = paperId ?? s.focusedId;
      if (id === null) return s;
      const paper = s.papers.find((p) => p.id === id);
      if (!paper) return s;
      const picks = paper.picks === null ? null : { ...paper.picks, presetId };
      return { papers: s.papers.map((p) => (p.id === id ? { ...p, presetId, picks } : p)) };
    }),

  setNotice: (notice, paperId) =>
    set((s) => {
      const id = paperId ?? s.focusedId;
      if (id === null) return s;
      const paper = s.papers.find((p) => p.id === id);
      if (!paper || paper.notice === notice) return s;
      return { papers: s.papers.map((p) => (p.id === id ? { ...p, notice } : p)) };
    }),

  setBoxH: (boxH, paperId) =>
    set((s) => {
      const id = paperId ?? s.focusedId;
      if (id === null) return s;
      const paper = s.papers.find((p) => p.id === id);
      // 同值不重设：RO 每次量到都回来，写一次就停（免得逐帧抖 store）
      if (!paper || paper.boxH === boxH) return s;
      return { papers: s.papers.map((p) => (p.id === id ? { ...p, boxH } : p)) };
    }),

  beginMorph: (sessionId, paperId) => {
    const state = get();
    const id = paperId ?? state.focusedId;
    if (id === null) return;
    const paper = state.papers.find((p) => p.id === id);
    if (!paper) return;
    clearMorphTimer(id);
    // 动效敏感：纸当帧撤（不留一座「停在那儿的纸」给用户）
    if (prefersReducedMotion()) {
      get().dismissOne(id);
      return;
    }
    /* 账在**这里**登记（不是组件的 effect）：卷开合两窗的判据在渲染期跑，晚一帧就已被当成
     * 普通摊开记进 played（见 isRiseVolume 头注）。beginMorph = 发号那一刻，早于任何渲染。 */
    _riseVolume = String(sessionId);
    _risePending = false;
    /* 交接期 = 这张纸**离开 papers**（焦点同步交回卷/画布 ⇒ 坞立刻可以出现）、进 morphs。
     * 锚点随记录带过去：纸要在原地退场，不能因为记录换了表就跳回世界原点。
     * `sheetId` 与卷同种子：交接那一窗里纸与卷必须**同一张纸**（纹不变、深浅不变）。 */
    set((s) => ({
      papers: s.papers.filter((p) => p.id !== id),
      focusedId: s.focusedId === id ? null : s.focusedId,
      morphs: {
        ...s.morphs,
        [id]: {
          sessionId,
          sheetId: String(sessionId),
          box: null,
          anchor: paper.anchor ?? { anchorX: 0, anchorY: 0, width: 1440 },
          // 交接期纸盒一帧都不动 ⇒ 快照发送那一刻的盒高（纸自己量不到了：记录已离开 papers）
          paperH: paper.boxH,
        },
      },
    }));
    _morphTimers.set(
      id,
      setTimeout(() => {
        _morphTimers.delete(id);
        get().dismissOne(id);
      }, DRAFT_MORPH_MS),
    );
  },

  dismissOne: (paperId) => {
    clearMorphTimer(paperId);
    set((s) => {
      const inPapers = s.papers.some((p) => p.id === paperId);
      const inMorphs = paperId in s.morphs;
      if (!inPapers && !inMorphs) return s;
      const { [paperId]: _dropped, ...morphs } = s.morphs;
      return {
        papers: s.papers.filter((p) => p.id !== paperId),
        focusedId: s.focusedId === paperId ? null : s.focusedId,
        morphs,
      };
    });
  },

  dismissAll: () => {
    clearAllMorphTimers();
    /* `landNonce` 刻意**不**随弃纸清零：它是单调的落纸代数（见字段注）。清回 0 会让
     * 迟到的落位方读到「与上次相同」，把「再摊一张纸」的聚焦吞掉。 */
    set((s) =>
      s.papers.length > 0 || Object.keys(s.morphs).length > 0 || s.focusedId !== null
        ? { papers: [], focusedId: null, morphs: {} }
        : s,
    );
  },
}));

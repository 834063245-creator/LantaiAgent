// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SpineRack — 书脊列 = 画布空间导航器（Stage-3，docs/plans/canvas-space/stage-3.md）。
//
// 隐喻：案头一摞函套——左缘一列脊，一卷一脊（只列**摊开**的卷；
// 未摊开的卷在侧边栏 SessionSidebar 管），当前卷「抽出一半」。
//
// 职责（2026-08-25 用户反馈收敛——书脊只管空间定位，功能别太多）：
//   - 左键 = 定位器：ctx.space.focus 切活跃会话 + canvas-view-store
//     requestFocus 让 PaperPanel 把摄像机轻动画飞到该流区最新块。
//   - 拖动 = 落位（抽书放桌）：按住书脊拖进画布，幽灵预览，松手在
//     「竖向不打架」的空列展开（pickDropAnchor：x 吸附网格 + 跳过占用列，
//     y 取用户落点），经 ctx.space.place 落位。
//   - hover 小卡 = 合卷（收起，数据保留；自动存）——改名/删除留在侧边栏
//     （会话管理那一摊）。右键菜单已按用户反馈移除。
//
// 几何与材料（2026-09-21 四批「设计感复原」，用户拍板戊·墨缘题签脊）：
//   脊 = **纸片件**——左脊 3px 厚边 + 受光/背光缘 + 硬接触落影（墨缘）；
//   题签另贴一枚亮纸（自带同一套缘）；书缝 6px（块块独立，函套底从缝里露出来）；
//   「案卷」= 虚线扣。脊高 = 8px 内距 + **整数行** × 栏距：行数由
//   spineWantRows（内容需要几行）与 planSpines（自然档 → 降档档 → 书口档）共同定，
//   溢出截字 + 省略号（fitLabel）。定值与病灶见 spine-rack.css 头注。
//
// 病史（两批，勿回退）：
//   ① 2026-09-21 二批：列无容器、脊高由题名字数决定 ⇒ 13 卷占 2725px 而 1080 窗
//      只给 1010px（冲出屏外 8 条）。治法 = 函套底 + 共高压缩 + 列内滚。
//   ② 2026-09-21 四批：二批把脊块错归档成「面板架档 = 零投影」，按禁框禁影办，
//      把虚线扣/脊块/活跃影三件语汇全删了 ⇒「又平又简陋，设计不存在了」（用户判词）。
//      治法 = 归位成纸片件 + 墨缘（大尺寸用纸、小尺寸用线，见 css 头注）。
//
// 挂载：画布导航插件贡献行（plugins/builtin/canvas-nav/index.ts →
// ctx.panels 注册 'canvas-spine' 面板，side:'left' + unmountOnClose），
// 随纸面板开合。
// 消费 ctx.space（activeSpace() 读面 + 四命令），不新增核心 API。
// 视口动画经 canvas-view-store 与 PaperPanel 共享（app 级单例）。
//
// 双走查形态（增补四）：本文件是产物域源码（esbuild 编译进插件产物，
// 视觉迭代秒级热更）——项目内依赖一律经 './host' 取宿主共享真实例
// （store/service 单例不可内联副本），react 由构建期别名桥共享。
// 例外 = **纯函数**（无实例身份）：卷名显示兜底 volumeDisplayName 直连
// state/volume-name、合流/机读注记直连 session-sidebar-model（同 InkLedger
// 直连 token-meter 先例）。

import { type CSSProperties, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { volumeDisplayName } from '../../../state/volume-name';
import {
  activeSpace,
  agentSessionState,
  getChatStore,
  msgStoreFor,
  pickDropAnchor,
  screenToWorld,
  useCanvasViewStore,
  useCoreStore,
  useDockStore,
  useSessionVolumesStore,
  useShellStore,
} from './host';
import { mergeSessionRows, sessionMeta } from './session-sidebar-model';
import './spine-rack.css';

/** 拖动阈值（px）：超过即视为拖脊（区分点击定位）。 */
const DRAG_THRESHOLD = 6;

/** 题名权重：CJK 1 字，拉丁/半角 0.55 字（竖排里拉丁占位约为汉字一半强）。 */
export function labelWeight(label: string): number {
  let w = 0;
  for (const ch of label) w += ch.charCodeAt(0) < 0x100 ? 0.55 : 1;
  return w;
}

/** 脊高四档 = **行数**（不是像素）：按题名权重分档，容量 = 2 栏 × 行数。
 *  像素高最后由分配器与 CSS 定：`8px 内距 + 行数 × 栏距`。
 *  挂内容量本更贴书理，但本仓卷名大量同前缀（实测三条「测试，…」），脊一压就
 *  三根长得一样、点哪根靠猜——可辨优先（走查记录 §2 第 3 条）。 */
const ROW_TIERS = [
  { maxWeight: 9, rows: 3 },
  { maxWeight: 15, rows: 4 },
  { maxWeight: 22, rows: 5 },
  { maxWeight: Number.POSITIVE_INFINITY, rows: 6 },
];

/** 内容需要几行（纯函数——测试钉边界，改档必跑 tests/paper-c8-spine.test.tsx）。 */
export function spineWantRows(name: string): number {
  const w = labelWeight(name);
  for (const t of ROW_TIERS) if (w <= t.maxWeight) return t.rows;
  return ROW_TIERS[ROW_TIERS.length - 1].rows;
}

/** 脊内距（上+下）与书缝——CSS 真源见 spine-rack.css 的 `--spine-pad` / `--seam`。 */
export const SPINE_PAD_V = 8;
export const SPINE_SEAM = 6;
/** 书口高（px @ font-scale 1）——CSS 真源见 `--thin-h`（横排题名两行 + 上下内距）。 */
export const SPINE_THIN_H = 32;
/** 压缩下限（行）：两栏 × 3 行 = 6 字，仍够认出「统计一下本地…」这一类。 */
export const SPINE_MIN_ROWS = 3;

/** 一条脊的排布：占几行（`rows`，书口档下无用）+ 是不是书口。 */
export interface SpineSlot {
  rows: number;
  /** 书口档：只留档号 / 枝 / 运行点，题名给 hover 卡（活跃卷永不书口化）。 */
  thin: boolean;
}

const slotH = (rows: number, pitch: number) => SPINE_PAD_V + rows * pitch;
const stackH = (hs: number[], seam: number) => hs.reduce((s, h) => s + h, 0) + seam * Math.max(0, hs.length - 1);

/** 全部压到下限后仍放不下 ⇒ 从最高的往下削（并列取靠后者 = 轮转）。返回削到底的结果。 */
function shrinkToFloor(wants: number[], avail: number, pitch: number): number[] {
  const rows = wants.map((n) => Math.max(SPINE_MIN_ROWS, n));
  let guard = rows.length * 64;
  while (
    stackH(
      rows.map((n) => slotH(n, pitch)),
      SPINE_SEAM,
    ) > avail &&
    guard-- > 0
  ) {
    let best = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] > SPINE_MIN_ROWS && (best < 0 || rows[i] >= rows[best])) best = i;
    }
    if (best < 0) break;
    rows[best] -= 1;
  }
  return rows;
}

/** 三步分配（2026-09-21 乙 · 密度档，用户拍板）：
 *  ① **自然档**：各按需（3–6 行）全放得下 ⇒ 就这样（宽敞时不去动它）；
 *  ② **降档档**：都压到 3 行下限还放得下 ⇒ 就这样（13 卷 / 1010px 窗落这里，与四批一致）；
 *  ③ **书口档**：连下限都放不下 ⇒ **活跃卷保持自然高**（正在读的那本整着），其余压成
 *     24px 一条的书口；仍放不下才交给列内滚。
 *  病史：三批之前只有①②，第 14 卷起就整列进滚动（1010px 窗 14 卷滚 63px、20 卷滚 498px、
 *  24 卷 / 620px 窗滚 1178px）——用户问「卷多是不是还是会被挤出屏幕」后立本档。 */
export function planSpines(wants: number[], avail: number, pitch: number, activeIdx: number): SpineSlot[] {
  if (wants.length === 0) return [];
  const natural = wants.map((n) => Math.max(SPINE_MIN_ROWS, n));
  // ① 自然档
  if (
    stackH(
      natural.map((n) => slotH(n, pitch)),
      SPINE_SEAM,
    ) <= avail
  ) {
    return natural.map((rows) => ({ rows, thin: false }));
  }
  // ② 降档档（全在下限也放得下 ⇒ 用削到底的结果）
  const stepped = shrinkToFloor(natural, avail, pitch);
  if (
    stackH(
      stepped.map((n) => slotH(n, pitch)),
      SPINE_SEAM,
    ) <= avail
  ) {
    return stepped.map((rows) => ({ rows, thin: false }));
  }
  // ③ 书口档：活跃卷整脊，其余书口
  const act = activeIdx >= 0 && activeIdx < natural.length ? activeIdx : 0;
  return natural.map((rows, i) => (i === act ? { rows, thin: false } : { rows: 0, thin: true }));
}

/** 题名截字：容量 = 2 栏 × 行数（CJK 1 格、拉丁 0.55 格），放不下就留一格给省略号。
 *  竖排的溢出发生在**块轴（宽度）**上，`text-overflow: ellipsis` 只治行内溢出 ⇒
 *  旧案实测题签内容 4–14 栏而只显 2 栏，用户读到的是「工具全部拿」这种半截词且
 *  没有任何「还有下文」的信号。省略号由文字自己带。 */
export function fitLabel(name: string, rows: number): string {
  const cap = 2 * rows - 1;
  let w = 0;
  let out = '';
  for (const ch of name) {
    const cw = ch.charCodeAt(0) < 0x100 ? 0.55 : 1;
    if (w + cw > cap) return `${out}…`;
    w += cw;
    out += ch;
  }
  return name;
}

/** 书脊行（只列摊开的卷；卷序 = 侧边栏合流序，见 spineRows）。 */
export interface SpineRow {
  id: number;
  /** **显示名**（已过 volumeDisplayName——空卷名按档号兜底，禁在此散写）。 */
  name: string;
  /** 有父卷（会话树「枝」）——脊上一枚朱砂小签，与侧栏行/卷首眉行同语汇。 */
  branch: boolean;
  /** 块数（盘上投影；未落盘新卷 = 0）。小卡机读注记用。 */
  msgCount: number;
  /** 落盘时刻（未落盘新卷 = 空 → 小卡出「未存」）。 */
  savedAt: string;
}

/** 卷运行态快照（书脊小点）：运行态唯一读面（v43）。 */
function readRunning(storeId: string, sid: number): boolean {
  return agentSessionState.runStateOf(storeId, sid).running;
}

/** 书脊卷序 = 侧边栏合流序（摊开组：savedAt 倒序，未落盘按卷号新者上）——
 *  书脊与侧边栏并陈两份名单，顺序打架是可见 bug（2026-08-31 前
 *  书脊用内存数组序，与侧边栏「新者上」相反）。
 *  `msgCount`/`savedAt` 由盘上行供给：内存摊开集只有 `{id, label}`，
 *  故**不传** msgCount（传 0 会把盘上真值盖掉，见 mergeSessionRows 注）。 */
export function spineRows(
  open: Array<{ id: number; label: string }>,
  saved: Parameters<typeof mergeSessionRows>[1],
): SpineRow[] {
  return mergeSessionRows(open, saved)
    .filter((r) => r.open)
    .map((r) => ({
      id: r.id,
      name: volumeDisplayName(r.label, r.id),
      branch: r.parentId != null,
      msgCount: r.msgCount,
      savedAt: r.savedAt,
    }));
}

export const SpineRack = memo(function SpineRack() {
  const core = useCoreStore((s) => s.core);
  /* ── 两源分离（2026-09-14「被合卷那根闪回来」根治）──
   * 摊开集（内存 sess store）与磁盘已存卷清单（listSavedSessions）各入各的
   * state，卷序在渲染期 useMemo 合流。
   * 病史：此前把合流结果直接 setSessions，而**异步磁盘应答的续体用的是发起
   * 那一刻捕获的摊开集**——合卷一瞬会连发数次 listSavedSessions（exec/agent/
   * space/sess 四条订阅各触发一次 resync，且 listSavedSessions 内部是
   * 「list_volumes + 每卷并行读文件」的多跳异步），先发的应答后到时就把
   * 「还没发合卷」的旧清单写回书脊 → 已合卷的卷闪回来。
   * 现在：摊开集只由内存写（旧值永不回灌），磁盘应答按请求序号收敛（旧的丢弃）。 */
  const [openRows, setOpenRows] = useState<Array<{ id: number; label: string }>>([]);
  const [savedRows, setSavedRows] = useState<Parameters<typeof mergeSessionRows>[1]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set());
  const sessions = useMemo(() => spineRows(openRows, savedRows), [openRows, savedRows]);

  /* ── 整数行分配（2026-09-21 四批）──
   * 脊高必须落成「内距 + 整数行 × 栏距」，否则末行半空或半切（二批实测四档减内距后
   * 是 2.67 / 3.28 / 4.10 / 5.13 行）。栏距随 --font-scale 走，故**从真题签的
   * line-height 读**（CSS 是唯一真源，不在 TS 里复写 19.5）；列高从 .sr-list 的
   * clientHeight 读；两样都量不到（jsdom / 未挂载 / 无高）就退回自然行数。
   * 观测量变化 = 列尺寸（窗口改高、字体档改栏宽）与首帧——RO 一处跟上。 */
  const [alloc, setAlloc] = useState<{ pitch: number; avail: number } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const avail = list.clientHeight;
      if (!avail) return; // 未挂载/无高：保持自然行数
      const label = list.querySelector<HTMLElement>('.sr-label');
      const pitch = label ? Number.parseFloat(getComputedStyle(label).lineHeight) : Number.NaN;
      setAlloc({ pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : 19.5, avail });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return; // jsdom 无 RO（测试自铺桩）
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, []);
  const rowPlan = useMemo(() => {
    const wants = sessions.map((s) => spineWantRows(s.name));
    const activeIdx = sessions.findIndex((s) => s.id === activeId);
    return alloc
      ? planSpines(wants, alloc.avail, alloc.pitch, activeIdx)
      : wants.map((rows) => ({ rows, thin: false }));
  }, [sessions, alloc, activeId]);

  /* ── hover 小卡 = **架级单卡**（全列共用一枚）──
   * 每脊一枚的写法有两处结构病（走查记录 §2 尾注实测回归②）：
   *  ① 卡住在滚动容器里，即使 opacity:0 也照样撑大 scrollHeight（幻影滚动 0→901px）；
   *  ② 脊一旦 overflow:hidden 裁题名，定位在脊外的卡被一并裁掉（截图实证卡整个消失）。
   * 故：卡住在 .sr-list 之外，按悬停/聚焦脊的 rect 定位，再按列高上下夹紧
   * （原案 top:0 定位——列的**低位卷**小卡直接射出屏底，与「冲出屏幕」同族）。 */
  const [card, setCard] = useState<{ row: SpineRow; mid: number } | null>(null);
  const rackRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  /* 小卡机读注记的块数：**读时**取内存真值（与侧栏同一把尺子——两个并陈面
   * 报同一卷的块数不许打架），不缓存进 state。缓存就得给每卷消息 store 挂订阅，
   * 而那条路是**流式逐块触发**的：整列每块消息重渲一次，还会连带读 scrollHeight
   * 触发布局（2026-09-18 载入成本批拆过的同族雷）。卡只在悬停那一刻要这个数。 */
  const liveBlocks = useCallback(
    (id: number, fallback: number): number => {
      if (!core) return fallback;
      const n = msgStoreFor(core.panelId, id)?.getState?.().messages.length;
      return typeof n === 'number' ? n : fallback;
    },
    [core],
  );

  const openCard = useCallback(
    (row: SpineRow, el: HTMLElement) => {
      const rack = rackRef.current;
      if (!rack) return;
      const rr = rack.getBoundingClientRect();
      const sr = el.getBoundingClientRect();
      setCard({ row: { ...row, msgCount: liveBlocks(row.id, row.msgCount) }, mid: sr.top - rr.top + sr.height / 2 });
    },
    [liveBlocks],
  );
  const closeCard = useCallback(() => setCard(null), []);

  /* 卡高只有渲染后才量得到 → 布局期定位（不引第二次 state 更新）。 */
  useLayoutEffect(() => {
    const el = cardRef.current;
    const rack = rackRef.current;
    if (!card || !el || !rack) return;
    const h = el.offsetHeight;
    const lo = 8;
    const hi = rack.clientHeight - h - 8;
    el.style.top = `${hi > lo ? Math.min(Math.max(card.mid - h / 2, lo), hi) : lo}px`;
  }, [card]);

  /* ── 右缘位置条：直接写 DOM（纯呈现细节，不值得每次滚动重渲 React 树）── */
  const syncBar = useCallback(() => {
    const list = listRef.current;
    const bar = barRef.current;
    if (!list || !bar) return;
    const total = list.scrollHeight;
    if (total <= list.clientHeight + 1) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'block';
    bar.style.height = `${Math.max(12, (list.clientHeight / total) * 100)}%`;
    bar.style.top = `${(list.scrollTop / total) * 100}%`;
  }, []);

  /* ── 磁盘卷清单：请求序号防竞态（只认最新一次请求的应答）──
   * 缓存留在 state（resync 不清空）——resync 高频触发（运行态跳变即触发），
   * 每次先回内存数组序再等磁盘应答会让卷序肉眼可见地抖动。
   * 2026-09-18 载入成本批（与 SessionSidebar 同批）：单飞 + 只在**磁盘清单可能变了**
   * 的事件上拉（listSavedSessions 读全部卷体——实测 32 MB 目录 → 21 MB / 240 ms），
   * 运行态/空间事件走内存源。 */
  const savedSeqRef = useRef(0);
  const sweepingRef = useRef(false);
  const sweepPendingRef = useRef(false);
  const refreshSaved = useCallback(() => {
    if (!core) return;
    if (sweepingRef.current) {
      sweepPendingRef.current = true;
      return;
    }
    sweepingRef.current = true;
    const run = () => {
      const seq = ++savedSeqRef.current;
      // 同 SessionSidebar 的 P4-1 教训：工作区路径变化必须重拉 listSavedSessions
      const pp = useShellStore.getState().projectPath;
      void core
        .listSavedSessions(pp)
        .then((saved) => {
          if (seq !== savedSeqRef.current) return; // 在途旧应答：丢弃（不得回灌已合卷的卷）
          setSavedRows(saved);
        })
        .catch((e) => {
          // 读面失败：保留上次清单（不得把已知卷序抹空）——可见化在控制台
          console.error('[spine] 案卷清单读取失败（保留上次结果）:', e);
        })
        .finally(() => {
          sweepingRef.current = false;
          if (sweepPendingRef.current) {
            sweepPendingRef.current = false;
            run();
          }
        });
    };
    run();
  }, [core]);

  /* 内存侧重读（**廉价**——运行态/空间事件走这条）：摊开集 + 活跃卷 + 运行态。 */
  const resyncMemory = useCallback(() => {
    if (!core) return;
    const st = getChatStore(core.panelId).sess.getState();
    setOpenRows(st.sessions.map((s) => ({ id: s.id, label: s.label })));
    const active = st.sessions[st.activeIdx];
    setActiveId(active ? active.id : null);
    const running = new Set<number>();
    for (const s of st.sessions) {
      if (readRunning(core.panelId, s.id)) running.add(s.id);
    }
    setRunningIds(running);
  }, [core]);

  /* 全量重读（摊开集变化 = 卷开合/改名/新建/删除 → 磁盘清单可能变了）。 */
  const resync = useCallback(() => {
    resyncMemory();
    refreshSaved();
  }, [resyncMemory, refreshSaved]);

  useEffect(() => {
    if (!core) return;
    resync();
    // 摊开集：磁盘清单可能变了 → 全量
    const unSess = getChatStore(core.panelId).sess.subscribe(resync);
    // 运行态 / 空间：只影响脊面点位与呼吸点 → 内存源
    const unAgents = agentSessionState.subscribe(resyncMemory);
    const unSpace = activeSpace()?.subscribe(resyncMemory);
    // 卷文件落定写入（保存/改名/合卷/删除）→ 全量（写代缓存重读零 I/O）——
    // 卷序按 savedAt，落盘晚于摊开集变化，只挂摊开集会读到写前状态
    const unVolumes = useSessionVolumesStore.subscribe(resync);
    const unShell = useShellStore.subscribe((s, prev) => {
      if (s.projectPath !== prev.projectPath) resync();
    });
    return () => {
      unSess();
      unAgents();
      unSpace?.();
      unVolumes();
      unShell();
    };
  }, [core, resync, resyncMemory]);

  /* 运行态变化：订阅面 = subscribeExecAll（v43 收口）：账本**实例表**变更（迟到/被换/
   *  注销重建都重挂）+ 既有账本的运行记录起落。旧实现在挂载时对「当时已存在」的账本
   *  逐个 onChange——后来才铸的账本永远没订阅（会话在跑而书脊光点不亮那个病灶族）。 */
  useEffect(() => {
    if (!core) return;
    return agentSessionState.subscribeExecAll(core.panelId, resyncMemory);
  }, [core, resyncMemory]);

  /* 卷集/滚动面变化 → 位置条重算；活跃卷换人 → 保证它在可见窗口里
   * （侧栏点开某卷时书脊可能正滚在别处）。手算滚动量而不走 scrollIntoView：
   * 后者会连带滚动祖链（书脊是画布上的覆盖层，不能碰视口）。 */
  const activeRow = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);
  useEffect(() => {
    const list = listRef.current;
    if (list && activeRow) {
      const el = list.querySelector<HTMLElement>(`.sr-spine[data-id="${activeRow.id}"]`);
      if (el) {
        if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
        else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
        }
      }
    }
    syncBar();
  }, [activeRow, syncBar]);

  /* ── 手势 1：左键定位器 ── */
  const onLocate = useCallback(
    (id: number) => {
      if (!core) return;
      activeSpace()?.focus(String(id));
      useCanvasViewStore.getState().requestFocus(String(id));
    },
    [core],
  );

  /* ── 手势 2：拖动落位（抽书放桌）── */
  const dragRef = useRef<{ id: number; sx: number; sy: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const onSpineMouseDown = useCallback((e: React.MouseEvent, id: number) => {
    if (e.button !== 0) return;
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, moved: false };
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      d.moved = true;
      setGhost({ x: e.clientX, y: e.clientY });
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setGhost(null);
      if (!d?.moved || !core) return;
      // 画布坐标换算：读 .pp-canvas 的视口 rect（只读坐标，不建游离 DOM——
      // 书脊是 DockPanel 上层覆盖，跨组件取坐标是 ponytail 例外）。
      const rect = document.querySelector('.pp-canvas')?.getBoundingClientRect();
      if (!rect) return;
      const v = useCanvasViewStore.getState().view;
      const w = screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top);
      const space = activeSpace();
      const regions = space?.getState().regions ?? [];
      const anchor = pickDropAnchor(regions, String(d.id), w.x, w.y);
      space?.place(String(d.id), anchor.anchorX, anchor.anchorY);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core]);

  /* ── 手势 3：hover 小卡合卷（收起，数据保留 + 自动存）── */
  const onClose = useCallback(
    (id: number) => {
      if (!core || readRunning(core.panelId, id)) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => s.id === id);
      if (idx >= 0) core.closeSession(idx);
      setCard(null);
    },
    [core],
  );

  if (!core) return null;

  return (
    <div className="sr-rack" role="tablist" aria-label="画布书脊（空间导航器）" ref={rackRef} onMouseLeave={closeCard}>
      <button
        type="button"
        className="sr-sidebar-toggle"
        title="案卷侧边栏（可折叠）"
        onClick={() => useDockStore.getState().togglePanel('canvas-sidebar')}
      >
        <span className="sr-sidebar-toggle-label">案卷</span>
      </button>

      <div className="sr-list" ref={listRef} onScroll={syncBar}>
        {sessions.map((s, i) => {
          const isActive = s.id === activeId;
          const isRunning = runningIds.has(s.id);
          const slot = rowPlan[i] ?? { rows: spineWantRows(s.name), thin: false };
          return (
            <div
              key={s.id}
              className={[
                'sr-spine',
                isActive ? 'sr-active' : '',
                isRunning ? 'sr-running' : '',
                slot.thin ? 'sr-thin' : '', // 书口档：只留档号/枝/运行点（活跃卷永不书口化）
              ].join(' ')}
              data-id={s.id}
              style={{ '--rows': slot.rows } as CSSProperties}
            >
              <div
                className="sr-spine-main"
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                title={`${s.name}${s.branch ? '（枝）' : ''}${isRunning ? '（运行中）' : ''} — 左键定位 · 拖动落位 · hover 合卷`}
                onClick={() => onLocate(s.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onLocate(s.id);
                  }
                }}
                onMouseDown={(e) => onSpineMouseDown(e, s.id)}
                onMouseEnter={(e) => openCard(s, e.currentTarget)}
                onFocus={(e) => openCard(s, e.currentTarget)}
              >
                <span className="sr-label" dir="ltr">
                  {fitLabel(s.name, Math.max(SPINE_MIN_ROWS, slot.rows))}
                </span>
                {s.branch && (
                  <span className="sr-branch-tag" title="枝：从父卷的某个节点分出">
                    枝
                  </span>
                )}
                {isRunning && <span className="sr-run-dot" role="presentation" />}
                <span className="sr-num">{s.id}</span>
              </div>
            </div>
          );
        })}
        {sessions.length === 0 && <div className="sr-empty">画布暂无摊开的卷</div>}
      </div>

      {/* hover 小卡（架级单卡）：全名 + 机读注记 + 合卷——改名/删除在侧边栏 */}
      {card && (
        <div className="sr-card" ref={cardRef}>
          <div className="sr-hover-title">{card.row.name}</div>
          <div className="sr-hover-meta">
            {sessionMeta({
              msgCount: card.row.msgCount,
              savedAt: card.row.savedAt,
              orphan: false,
            })}
            {card.row.branch ? ' · 枝' : ''}
          </div>
          <button
            type="button"
            className="sr-close-btn"
            disabled={runningIds.has(card.row.id)}
            onClick={() => onClose(card.row.id)}
          >
            合卷（自动存）
          </button>
        </div>
      )}

      {/* 右缘位置条：列装不下时才有（可见窗口在整列中的位置/长度） */}
      <div className="sr-scrollbar" ref={barRef}>
        <i />
      </div>

      {/* 拖动落位幽灵预览（屏幕坐标浮层——抽书放桌的即时应答） */}
      {ghost && (
        <div className="sr-drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <span className="sr-drag-ghost-tag">放桌</span>
        </div>
      )}
    </div>
  );
});

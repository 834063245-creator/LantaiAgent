// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import type { MotionEndCancel } from './motion-end';
import { waitMotionEnd } from './motion-end';

// region-motion — 卷**开合两窗**（2026-10-18 卷开合动效批；用户拍板「甲 · 入场 + 退场对称」）。
//
// 病灶（用户：「卷的展开收起……现在纯粹是闪现」）：开卷 = 纸与字同一帧出现
// （`.pp-region` 基座只有 box-shadow 过渡、零入场），合卷 = 区域**当帧卸载**
// （`space.collapse → core.closeSession` → 卷从 sess 表消失 → `regions` 随即不含它）
// ——零退场，没有落点可言。§15 动效法的换景收口账收的是「侧栏↔书脊 / 设置页签 /
// 首页↔画布 / 会话换主」四项，**卷开合从来没立过项**。
//
// 两个窗（都住槽主人的一个 ref 里，逐帧就地推进）：
//   - **退场窗**（起纸）：卷消失的当帧进窗，窗满才真卸载——入场逆写的落点。
//   - **落纸窗**（落纸）：**首次真在视口里**且没落过纸的卷挂 `.pp-spread`（纸淡入）
//     **满一窗**才摘类。两条判据都是实机反馈逼出来的（2026-10-18 用户：「实机看了一下，
//     动效好像不太明显」）：
//       ① **可见**而不是「活跃」：开卷 = 摊开 + 视角飞过去（260ms 飞行）⇒ 按「首次活跃」
//          发类会在**屏外**播完，镜头到了纸已稳稳摊着 = 用户读作「还是闪现」；
//       ② **窗**而不是一帧（`pp-enter` 那种写法）：同一批 commit 里后续重渲染会把类连同
//          动画一起摘掉（落位/焦点/测高回写），浏览器根本没见到那个类。
//
// 三条机制纪律（全从既有判例抄来，不是新发明）：
//   ① **渲染期收敛**：卷消失的那一帧就要有快照。挪进 `useEffect` ⇒ 先拆（一帧空白）
//      后挂（退场窗里重播入场）——同 DockPanel 相位机 2026-10-16 那条实测判据
//      （真机报「侧栏收藏时跳变」的根因就是相位晚一趟推进）。
//   ② **窗长 = `--m-sheet`**（`REGION_MOTION_MS`，与 `PANEL_LEAVE_MS` 同一把尺子）：
//      CSS 侧播 260ms，壳层就留 260ms——留短了动画被卸载掐断，留长了白占一个空窗。
//   ③ **离场卷只进渲染面，不进测量面**：本窗的快照只给 PaperPanel 的**渲染两图**
//      （流区叶 + 块层）用；`usePaperRegions` 的 `regions` 保持「活跃卷」语义不动，
//      于是小地图包围盒 / 目次带 / 匣脚引线 / 让位带一律看不见离场卷——一个正在消失
//      的卷不会把读数件撑一下（同 §15 拒绝给块折叠做高度过渡的那条理由）。
//
// 窗内重开 = **撤销退场**（不重挂）：元素同一个 key，`data-leaving` 一摘即回场，
// 过渡按**当下值**掉头（CSS Transitions 的抢占语义——批 3b「半路掉头」实测的用法）；
// 而落纸窗仍在 ⇒ 纸平平地淡回来（不重播一次完整落纸）。
//
// **出生即交接**（2026-11-15）：待题纸化成的那一卷不走「落纸」而走「落墨」——纸的淡出
// 与它是同一个盒里同一张纸的交接（见 draft-sheet.css 化卷段）。`rise` 集合由壳层在装配期
// 喂一个判据（`isRiseVolume`），它取代 `spread`、只留墨（卷首不落、块自 18px 落）。
//
// **退场窗的事件化**（2026-11-17 批 B）：`until` 仍是排程用的到期时刻，但**真卸载**
// 改由 `regionExits`（`.pp-region[data-leaving]` 的 transitionend）触发——动画播完就
// 摘，不再等一把估算的钟；`REGION_MOTION_MS` 退成那条事件的保险兜底。

/** 卷开合窗长（ms）——**镜像 `--m-sheet`**（0.26s）；退场窗与落纸窗同长。改一处必改
 *  两处，由 `tests/motion-contract.test.ts` 的「跨窗口镜像同值」与 `--m-sheet` 对拍钉住。
 *
 *  2026-11-17 交互原语收口批 B：**退场窗改事件驱动后，本常量只给落纸/落墨两窗与
 *  `nextExpiry` 排程用**——真卸载由 `.pp-region[data-leaving]` 的 `transitionend` 触发
 *  （见 `regionExits`），本常量退化成那条事件的保险兜底。 */
export const REGION_MOTION_MS = 260;

/** 沉降窗长（ms）——**余波**：纸落定之后影子继续坐实的那一段（2026-11-17 判据板批）。
 *
 *  **镜像 `--m-ambient`（1.6s），不是 `--m-sheet`**：落纸是「一段动作」（260ms），
 *  余波是「动作之后的一段时间」——语义属环境档，不属三档动作。改一处必改两处，
 *  由 `tests/motion-contract.test.ts` 的本常量 ↔ token 对拍钉住。
 *
 *  为什么不并进 `REGION_MOTION_MS`：落纸窗要摘 `.pp-spread`（纸的淡入是一次性的），
 *  而余波只驱动一个伪元素的 opacity（不改变任何几何/业务态）——两者同开不同长，
 *  并成一条会让「纸的入场」拖到 1.6s。 */
export const REGION_SETTLE_MS = 1600;

/** 一个正在退场的卷（`view` = 消失当帧的**全量快照**——冻结最后一帧，不再重算）。 */
export interface RegionLeaveEntry<T> {
  view: T;
  /** 窗满时刻（ms，`Date.now()` 同源）。 */
  until: number;
}

/** 卷开合窗状态（长期住在槽主人的 ref 里；`stepRegionMotion` 逐帧就地推进）。 */
export interface RegionMotionWindow<T> {
  /** 退场窗：卷 id → 快照与到期时刻。 */
  leaving: Map<string, RegionLeaveEntry<T>>;
  /** 上一帧的活跃卷（退场快照源）。 */
  lastLive: Map<string, T>;
  /** 落纸窗：卷 id → 摘 `.pp-spread` 的时刻。 */
  spread: Map<string, number>;
  /** 沉降窗：卷 id → 摘 `.pp-settling` 的时刻（余波，长于落纸窗——见 REGION_SETTLE_MS）。 */
  settle: Map<string, number>;
  /** **已落过纸**的卷（冷启动整批 + 真播过的）——落纸窗只给「没落过且这帧真在视口里」的卷。 */
  played: Set<string>;
  /** **出生即交接**的卷（2026-11-15 化卷批）：待题纸化成的那一卷。它的「纸从哪来」已由纸
   *  自己那一窗讲完（纸在同一个盒里淡出）——再让它播一次纸淡入，交接窗里就是两片半透明的
   *  纸叠着。这类卷**只落墨**（卷首与首块自 18px 落下），故不进 `spread` 窗、进 `rise`。 */
  rise: Map<string, number>;
  /** 首帧整批算「已落纸」——冷启动/恢复工作区时满屏纸一起淡入会被读成一次闪
   *  （同 §15 批 1「块自己挪位」那条实机验收顾虑）；此后只有**用户驱动**的摊开落纸。 */
  primed: boolean;
}

export function createRegionMotionWindow<T>(): RegionMotionWindow<T> {
  return {
    leaving: new Map(),
    lastLive: new Map(),
    spread: new Map(),
    settle: new Map(),
    played: new Set(),
    rise: new Map(),
    primed: false,
  };
}

/**
 * 卷是否真在视口里（纵向）——`visibleRegionIds`（use-paper-regions）只管**横向**
 * （那是渲染虚拟化的口径：横向离场才卸载 DOM），而「落纸」要给**用户看得见**的那一刻
 * 发。横向 + 纵向都过才算可见。
 */
export function regionOnScreen(topY: number, bottomY: number, viewY0: number, viewY1: number): boolean {
  return topY <= viewY1 && bottomY >= viewY0;
}

/**
 * 推进两个窗（**渲染期**调用；就地改 `win`）：
 *   ① 退场窗内重开 → 撤销（live 里又有它了）；
 *   ② 本帧消失的卷 → 按 `lastLive` 快照**当帧**进退场窗（`entered` 回报给调用方去清
 *      「首见」印记——不清则重开卷没有墨）；同时把它从「已落纸」里摘掉 ⇒ 重开重播；
 *   ③ **这帧真在视口里且没落过纸**的卷 → 开落纸窗（首帧整批除外——见 `primed` 注）。
 *      ⚠ 判据是**「首次可见」而不是「首次活跃」**（2026-10-18 实机反馈「不太明显」
 *      的第一因）：开卷 = 摊开 **+ 视角飞过去**（`space.expand` → `requestFocus`，
 *      260ms 飞行）——远卷落地时压根不在视口里，按「首次活跃」发的落纸类会**在屏外
 *      播完**，等镜头到了纸已经稳稳摊着 = 用户读作「还是闪现」。故改按可见判定：
 *      镜头一带到它，落纸才起手。
 *   ④ 两个窗满 → 摘除。
 * 返回 `nextExpiry` = 最早到期时刻（调用方据此排一次重渲染把满窗的摘掉）；无窗 = null。
 */
/** 一张卷是否「出生即交接」（待题纸化成的那一卷）——由壳层按交卷账判，见 use-paper-panel。 */
export type RiseJudge = (sessionId: string) => boolean;

/**
 * 一张离场卷的**真卸载**凭据（2026-11-17 批 B 事件化）：
 * 不再是「窗满时刻到了」，而是「`.pp-region[data-leaving]` 的 opacity 过渡真播完了」。
 * 调用方挂一次 `waitMotionEnd`，事件到达（或兜底窗满）后调它；卷若在这之前重开，
 * 调用方的 cleanup 会摘掉监听——重开不卸载，退场窗随撤销一起消失。
 */
export function regionExits(onExit: () => void, el: Element | null): MotionEndCancel {
  if (!el) {
    onExit();
    return () => {};
  }
  return waitMotionEnd(el, onExit);
}

/** `stepRegionMotion` 的本帧回报。 */
export interface RegionMotionStep<T> {
  /** 本帧消失、刚进**退场窗**的卷（调用方据此清「首见」印记）。 */
  entered: T[];
  /** 本帧最早到期时刻（调用方据此排一次重渲染把满窗的摘掉）；无窗 = null。 */
  nextExpiry: number | null;
  /** **本帧刚开窗的命中数**（落纸 + 落墨 + 起纸，三窗合计）——冻帧的打点依据。
   *
   *  为什么不让调用方自己看窗：窗是「until 时间戳」，判断「刚开」只能比较
   *  `until - REGION_MOTION_MS ≈ now`，那是拿浮点时间猜状态（本仓 2026-09-18
   *  rAF 两把钟不等源的实测事故同款），一帧偏差就漏打或重打。窗在这里刚被
   *  `set` 的那一刻只有本函数知道，就在此处计数最诚实。 */
  hits: number;
}

export function stepRegionMotion<T extends { sessionId: string }>(
  win: RegionMotionWindow<T>,
  live: T[],
  visible: ReadonlySet<string>,
  now: number,
  isRise: RiseJudge = () => false,
): RegionMotionStep<T> {
  const liveIds = new Set(live.map((r) => r.sessionId));

  // ① 退场窗内重开 = 撤销（同一 key 的元素从未卸载，属性摘掉即回场）
  for (const sid of [...win.leaving.keys()]) {
    if (liveIds.has(sid)) win.leaving.delete(sid);
  }

  // ② 本帧消失的卷当帧进退场窗（晚一趟 = 先拆后挂）+ 清「已落纸」⇒ 重开重播
  const entered: T[] = [];
  /** 本帧刚开窗的命中数（见 RegionMotionStep#hits）。 */
  let hits = 0;
  for (const [sid, view] of win.lastLive) {
    if (liveIds.has(sid) || win.leaving.has(sid)) continue;
    win.leaving.set(sid, { view, until: now + REGION_MOTION_MS });
    hits += 1;
    win.played.delete(sid);
    win.rise.delete(sid);
    win.settle.delete(sid);
    entered.push(view);
  }

  // ③ 首次**可见**的卷开落纸窗（首帧整批算已落纸——见 primed 注）
  //    **出生即交接**的卷不进落纸窗，改记 `rise`：它的纸已在纸自己那一窗里讲过（见头注）。
  if (win.primed) {
    for (const r of live) {
      if (!visible.has(r.sessionId) || win.played.has(r.sessionId)) continue;
      win.played.add(r.sessionId);
      if (isRise(r.sessionId)) {
        win.rise.set(r.sessionId, now + REGION_MOTION_MS);
        hits += 1;
        continue;
      }
      win.spread.set(r.sessionId, now + REGION_MOTION_MS);
      /* 余波与落纸**同开**、不同长：纸到位那一刻影子才开始「坐实」（见 REGION_SETTLE_MS）。 */
      win.settle.set(r.sessionId, now + REGION_SETTLE_MS);
      hits += 1;
    }
  } else if (live.length > 0) {
    /* 冷启动/恢复：第一批量（非空）整批算「已落纸」。
     * 空首帧不 prime——恢复是异步的，别把「第一批真数据」当成用户摊开。
     * **例外 = 出生即交接**（2026-11-15 化卷批）：空工作区里落纸、化卷，那一卷就是**第一批**
     * 的唯一成员——按「整批已落」吞掉的话它一个入场都没有（纸没了、卷早在那里）。故它照样
     * 开落墨窗：这是冷启动，但它不是「恢复」，是**用户正在看着它出生**。 */
    win.primed = true;
    for (const r of live) {
      win.played.add(r.sessionId);
      if (visible.has(r.sessionId) && isRise(r.sessionId)) {
        win.rise.set(r.sessionId, now + REGION_MOTION_MS);
        hits += 1;
      }
    }
  }

  // ④ 两窗统一摘除 + 记最早到期
  let nextExpiry: number | null = null;
  const track = (until: number) => {
    nextExpiry = nextExpiry == null ? until : Math.min(nextExpiry, until);
  };
  for (const [sid, entry] of win.leaving) {
    if (entry.until <= now) {
      win.leaving.delete(sid);
      continue;
    }
    track(entry.until);
  }
  for (const [sid, until] of win.spread) {
    if (until <= now) {
      win.spread.delete(sid);
      continue;
    }
    track(until);
  }
  /* 沉降窗比落纸窗长寿（1.6s vs 260ms）——它只摘类，不动任何业务态；
   * 排程仍走同一条 nextExpiry（到期那次重渲染顺手摘掉）。 */
  for (const [sid, until] of win.settle) {
    if (until <= now) {
      win.settle.delete(sid);
      continue;
    }
    track(until);
  }
  /* 落墨窗与落纸窗同长同摘：它只是「不淡纸、只落墨」那一档，摘的时机完全一样。
   * **重开卷要重播**（同 spread 的 played 语义）：起纸时 rise 已摘，回场按当时判据重判。 */
  for (const [sid, until] of win.rise) {
    if (until <= now) {
      win.rise.delete(sid);
      continue;
    }
    track(until);
  }

  win.lastLive = new Map(live.map((r) => [r.sessionId, r]));
  return { entered, nextExpiry, hits };
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

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

/** 卷开合窗长（ms）——**镜像 `--m-sheet`**（0.26s）；退场窗与落纸窗同长。改一处必改
 *  两处，由 `tests/motion-contract.test.ts` 的「跨窗口镜像同值」与 `--m-sheet` 对拍钉住。 */
export const REGION_MOTION_MS = 260;

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
  /** **已落过纸**的卷（冷启动整批 + 真播过的）——落纸窗只给「没落过且这帧真在视口里」的卷。 */
  played: Set<string>;
  /** 首帧整批算「已落纸」——冷启动/恢复工作区时满屏纸一起淡入会被读成一次闪
   *  （同 §15 批 1「块自己挪位」那条实机验收顾虑）；此后只有**用户驱动**的摊开落纸。 */
  primed: boolean;
}

export function createRegionMotionWindow<T>(): RegionMotionWindow<T> {
  return { leaving: new Map(), lastLive: new Map(), spread: new Map(), played: new Set(), primed: false };
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
export function stepRegionMotion<T extends { sessionId: string }>(
  win: RegionMotionWindow<T>,
  live: T[],
  visible: ReadonlySet<string>,
  now: number,
): { entered: T[]; nextExpiry: number | null } {
  const liveIds = new Set(live.map((r) => r.sessionId));

  // ① 退场窗内重开 = 撤销（同一 key 的元素从未卸载，属性摘掉即回场）
  for (const sid of [...win.leaving.keys()]) {
    if (liveIds.has(sid)) win.leaving.delete(sid);
  }

  // ② 本帧消失的卷当帧进退场窗（晚一趟 = 先拆后挂）+ 清「已落纸」⇒ 重开重播
  const entered: T[] = [];
  for (const [sid, view] of win.lastLive) {
    if (liveIds.has(sid) || win.leaving.has(sid)) continue;
    win.leaving.set(sid, { view, until: now + REGION_MOTION_MS });
    win.played.delete(sid);
    entered.push(view);
  }

  // ③ 首次**可见**的卷开落纸窗（首帧整批算已落纸——见 primed 注）
  if (win.primed) {
    for (const r of live) {
      if (!visible.has(r.sessionId) || win.played.has(r.sessionId)) continue;
      win.played.add(r.sessionId);
      win.spread.set(r.sessionId, now + REGION_MOTION_MS);
    }
  } else if (live.length > 0) {
    /* 冷启动/恢复：第一批量（非空）整批算「已落纸」。
     * 空首帧不 prime——恢复是异步的，别把「第一批真数据」当成用户摊开。 */
    win.primed = true;
    for (const r of live) win.played.add(r.sessionId);
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

  win.lastLive = new Map(live.map((r) => [r.sessionId, r]));
  return { entered, nextExpiry };
}

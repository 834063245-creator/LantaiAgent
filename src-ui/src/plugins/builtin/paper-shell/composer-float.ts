// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// composer-float — 创作坞浮动化（2026-09-17，用户拍板「全画布自由浮动 + 吸附
// 边缘 + 双击复位，锚线跟随重算」；同日二批用户三条修订：目次带不让位 / 拖动与
// 划词打架 / 加桌面歌词式**拖动锁**）的几何与记忆纯函数面。
//
// 归属：坞位是**视图偏好**，不是会话状态（「创作坞是视图不是容器」铁律的另一半）
// ——槽主人 PaperPanel 持有 state 并落 localStorage，坞本体一字不知（compose-dock
// 不动，零跨插件耦合）。同族先例：paper-minimap R3.5 浮动化（MinimapView 的
// pref + localStorage）/ SessionSidebar 宽度拖拽。
//
// 坐标系（单一真源口径）：
//   - left   = 坞槽左边到**视口左缘**的 px 偏移；
//   - bottom = 坞槽下边到**视口底缘**的 px 偏移；
//   - pos === null = 「无覆盖」= 坞落 CSS 默认位（.pp-composer-slot 的
//     left:50% + translateX(-50%) + bottom:var(--composer-rise)，版心居中坐底）
//     ——双击复位即回到这一态（清覆盖，不写死坐标：窗口再变仍居中）。
// 坞几何对消费面下发为 `{ bottom, height }` 一对（同小地图 pref 的「原样下发」
// 纪律）：让位带 = bottom + height（坞的实际位置），出厂底带 = RISE + height。
//
// **拖动锁（2026-09-17 用户方案，桌面歌词式）**：默认**锁定**——坞对鼠标零响应
// （不接管手势、不改光标、划词照旧）；纸壳通过 `PaperDockContext.composerLock`
// 把锁态与写面交给坞，**坞在书眉工具行渲染那枚单字工具**（`移` ↔ `锁`，与 翰/律
// 同排同语言——常显可点，不做悬停浮现：悬停浮现的控件一旦脱出宿主盒子，悬停链
// 会被缝隙掐断，用户「还没挪过去就消失了」）。解锁后**整坞**（除交互件）才是抓手。
// 锁定态即「普通 DOM」，拖动与划词不可能打架；解锁态只在拖动期内全页禁选
// （见 use-composer-float）。

/** 坞位记忆键（视图偏好，全局非工作区数据——与 lantai.minimap.pref 同族）。 */
export const COMPOSER_POS_KEY = 'lantai.composer.pos';
/** 拖动锁记忆键（同一族；默认锁定 = 键缺席）。 */
export const COMPOSER_UNLOCK_KEY = 'lantai.composer.unlocked';

/** 坞坐底抬高（tokens.css --composer-rise 的 TS 镜像——吸附目标之一：经典底带）。 */
export const COMPOSER_RISE = 96;
/** 书眉高（tokens.css --bar-h 的 TS 镜像——坞顶不得进书眉：那一段是窗口拖动热区）。 */
export const COMPOSER_BAR_H = 56;
/** 屏缘留白（坞不得贴死窗口边）。 */
export const COMPOSER_EDGE = 8;
/** 吸附阈（px）——拖到目标位 24px 内即吸附（左右缘/版心中轴/底带/最底缘）。 */
export const COMPOSER_SNAP = 24;

/** 坞位（视口坐标，见文件头注）。 */
export interface ComposerPos {
  left: number;
  bottom: number;
}

/** 坞槽实测尺寸（拖动/夹紧要用真尺寸，不手抄 CSS 的 min(880px, 100vw-48px)）。 */
export interface ComposerBox {
  w: number;
  h: number;
}

/** 视口尺寸。 */
export interface ComposerViewport {
  w: number;
  h: number;
}

/** 坞几何（下发覆盖层消费面：让位带 = bottom + height；出厂底带 = RISE + height）。 */
export interface ComposerDockGeom {
  bottom: number;
  height: number;
}

/**
 * 夹紧：坞整体留在视口内（左/右/下留 COMPOSER_EDGE，上不越书眉）。
 * 窗口缩小后对已存坞位也生效（读侧夹紧——存量值不因窗口变化被改写，
 * 窗口涨回去坞回到用户摆的那一处）。
 */
export function clampComposerPos(pos: ComposerPos, vp: ComposerViewport, box: ComposerBox): ComposerPos {
  const maxLeft = Math.max(COMPOSER_EDGE, vp.w - box.w - COMPOSER_EDGE);
  const maxBottom = Math.max(COMPOSER_EDGE, vp.h - COMPOSER_BAR_H - box.h - COMPOSER_EDGE);
  return {
    left: Math.min(Math.max(pos.left, COMPOSER_EDGE), maxLeft),
    bottom: Math.min(Math.max(pos.bottom, COMPOSER_EDGE), maxBottom),
  };
}

/**
 * 吸附（「吸附边缘」）：四枚目标位取最近一枚，阈内即吸。
 *   - 横向：左缘 / **版心中轴**（= 默认位的横坐标，坞回中轴的手感锚）/ 右缘；
 *   - 纵向：经典底带（--composer-rise，坞的出厂位）/ 最底缘。
 * 拖动全程施加（磁吸）；离阈即自由——由调用方在每次位移后调用，幂等。
 */
export function snapComposerPos(pos: ComposerPos, vp: ComposerViewport, box: ComposerBox): ComposerPos {
  const lefts = [COMPOSER_EDGE, (vp.w - box.w) / 2, vp.w - box.w - COMPOSER_EDGE];
  const bottoms = [COMPOSER_EDGE, COMPOSER_RISE];
  return {
    left: nearest(lefts, pos.left, COMPOSER_SNAP) ?? pos.left,
    bottom: nearest(bottoms, pos.bottom, COMPOSER_SNAP) ?? pos.bottom,
  };
}

/** 阈值内最近的目标位；无则 null（不吸附）。 */
function nearest(targets: number[], value: number, threshold: number): number | null {
  let best: number | null = null;
  let bestD = threshold;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/**
 * 坞几何下发（视口底 → 坞下边 / 坞实测高）。
 * 消费面各自派生（**不代算**，免得两种口径混在一个数里）：
 *   - 让位带 = `bottom + height`（坞的**实际位置**）——小地图默认位 / 递牒卡宿主 /
 *     插件 dock 这类「会被坞当场压住的贴底件」；
 *   - 出厂底带 = `COMPOSER_RISE + height`——目次带专用（用户 2026-09-17 裁定：
 *     目次带**不随坞浮动而压缩**，只按出厂位让位，护住「内容尾不藏进坞后」那条
 *     2026-09-01 实机整改）。
 */
export function composerGeomOf(pos: ComposerPos | null, dockH: number): ComposerDockGeom {
  return { bottom: pos?.bottom ?? COMPOSER_RISE, height: dockH };
}

/**
 * 坞的拖动面命中判据（**锁定态一律 false**）：解锁后**整坞**（`.pp-composer` 内）
 * 的非交互件才是抓手——用户 2026-09-17 原话「解锁之后拓展坞要对鼠标有响应」，
 * 故不只是书眉行。交互件自己接手势（翰/律/停止钮/输入件/锁钮）。
 * 与窗口拖动热区判据同族（app/window-drag.ts 的 isTopbarInteractiveTarget）。
 */
const COMPOSER_DRAG_SURFACE_SELECTOR = '.pp-composer';
const COMPOSER_DRAG_BLOCKERS =
  'button, a, input, textarea, select, [role="button"], [role="listbox"], [role="slider"], [contenteditable="true"]';

export function isComposerDragSurface(target: EventTarget | null, unlocked: boolean): boolean {
  if (!unlocked) return false; // 锁定态：坞是普通 DOM（不接管手势、不改光标、划词照旧）
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (!el.closest(COMPOSER_DRAG_SURFACE_SELECTOR)) return false;
  return el.closest(COMPOSER_DRAG_BLOCKERS) === null;
}

/** 读坞位记忆。毒化/不可用一律当「无覆盖」（容忍坏数据是读侧纪律，见 INVARIANTS #11 同族）。 */
export function loadComposerPos(): ComposerPos | null {
  try {
    const raw = localStorage.getItem(COMPOSER_POS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { left, bottom } = parsed as { left?: unknown; bottom?: unknown };
    if (!Number.isFinite(left) || !Number.isFinite(bottom)) return null;
    return { left: left as number, bottom: bottom as number };
  } catch {
    return null;
  }
}

/** 写坞位记忆；pos = null = 清覆盖（双击复位）。写失败只影响持久化，不影响本次会话。 */
export function saveComposerPos(pos: ComposerPos | null): void {
  try {
    if (!pos) {
      localStorage.removeItem(COMPOSER_POS_KEY);
      return;
    }
    localStorage.setItem(
      COMPOSER_POS_KEY,
      JSON.stringify({ left: Math.round(pos.left), bottom: Math.round(pos.bottom) }),
    );
  } catch {
    /* localStorage 不可用（隐私模式等）——不持久化 */
  }
}

/** 读拖动锁。**默认锁定**（键缺席 = false）；毒化值一律当锁定（读侧容忍）。 */
export function loadComposerUnlocked(): boolean {
  try {
    return localStorage.getItem(COMPOSER_UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写拖动锁（解锁后持久——用户显式开的模式不该每次重开；锁钮常在，随时关得掉）。 */
export function saveComposerUnlocked(unlocked: boolean): void {
  try {
    if (unlocked) localStorage.setItem(COMPOSER_UNLOCK_KEY, '1');
    else localStorage.removeItem(COMPOSER_UNLOCK_KEY);
  } catch {
    /* localStorage 不可用——不持久化，本次会话内仍生效 */
  }
}

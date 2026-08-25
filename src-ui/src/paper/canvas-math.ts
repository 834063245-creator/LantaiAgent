// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/canvas-math — 无限画布数学（走查弹）。
//
// 拍板决定 D-R1-1：无限画布（废除「有界」）+ 方位感。
// 拍板决定 D-R1-3：流锚甲——流向上生长，锚点在视口下缘，输入条固定视口底部。
//
// 坐标系：世界坐标（x 右 y 下，原点 = 流锚锚点，即视口下缘中点附近）。
// 本文件纯函数零依赖——渲染层把 view 变换应用到 DOM transform，
// 交互层用这里的换算做指针事件 → 世界坐标。

/** 视口状态（唯一真相；React 壳把它放 state/ref，每次变更重渲染/重变换） */
export interface Viewport {
  /** 世界原点在屏幕坐标的偏移（world→screen: screen = world*zoom + pan） */
  panX: number;
  panY: number;
  zoom: number;
}

/** 视口约束（走查弹取宽松档：0.35–2.4，同原型手感） */
export const ZOOM_MIN = 0.35;
export const ZOOM_MAX = 2.4;
/** 滚轮缩放灵敏度（同原型 0.0012/px） */
export const WHEEL_FACTOR = 0.0012;

export function identityView(): Viewport {
  return { panX: 0, panY: 0, zoom: 1 };
}

/** 世界 → 屏幕。 */
export function worldToScreen(v: Viewport, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * v.zoom + v.panX, y: wy * v.zoom + v.panY };
}

/** 屏幕 → 世界（拖拽/钉住落点换算）。 */
export function screenToWorld(v: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom };
}

/** 围绕屏幕锚点缩放（光标为锚——原型同款手感）。 */
export function zoomAt(v: Viewport, sx: number, sy: number, factor: number): Viewport {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor));
  if (zoom === v.zoom) return v;
  const wx = (sx - v.panX) / v.zoom;
  const wy = (sy - v.panY) / v.zoom;
  return { zoom, panX: sx - wx * zoom, panY: sy - wy * zoom };
}

/** 滚轮事件的缩放因子（deltaY 正 = 缩小）。 */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * WHEEL_FACTOR);
}

/** 平移（拖空白）。 */
export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { ...v, panX: v.panX + dx, panY: v.panY + dy };
}

/* ── 流锚甲（D-R1-3）──
 * 流从锚点向上生长：块序列沿 -y 方向排布。
 * 视口内「最新块贴下缘」= 布局器保证最底块底边距锚点 line 处，
 * 壳层把锚点行对到屏幕 (视口宽/2, 视口高 - 输入条高 - 底距)。 */

/** 流锚几何常量（世界单位 / 屏幕像素按需混用，走查弹不纠结）。
 *  B1 垂直节奏（2026-08-22 用户拍板）：基础块距 48（原型 .block margin-bottom），
 *  来文前 72（用户轮次切分——头顶放宽才能把「用户发言」和前一轮 LLM 输出
 *  分开）、来文后 8（asterism 自带 30px 尾距，机械间距只补零头）。 */
export const ANCHOR = {
  /** 流锚窄带半宽（D-R2-4 消极决定 2：流锚独占窄带，对话流纵向轨道不横向蔓延） */
  bandHalfWidth: 400,
  /** 块间垂直间距（B1：原型节奏 48） */
  blockGap: 48,
  /** 来文块上方额外间距（B1 用户拍板：用户轮次从头顶切分） */
  userLeadGap: 24,
  /** 来文块下方间距（B1：asterism 尾距 30 为主，机械间距零头） */
  userTailGap: 8,
  /** 锚点行距屏幕底部的留白（输入条上方） */
  screenBottomMargin: 96,
} as const;

/** 流布局输出：给每个 flow 块算出世界坐标（x 居中窄带，y 自锚点向上累积）。
 *  B1 垂直节奏：间距看「上面那块是否来文」——
 *    user 头顶（即下方是 user）：blockGap + userLeadGap（用户轮次切分，头顶宽）
 *    user 尾部（即上方是 user）：userTailGap（asterism 已带 30px 视觉尾距，零头）
 *    其余：blockGap（原型 48）。
 *  自底向上遍历：游标减去的间距属于「上方那块」的头部空间。 */
export function layoutFlow(
  flowBlocks: Array<{ id: string; h: number; w?: number; kind?: string }>,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  // 从锚点 (0, 0) 向上：第一个（最旧）块在最上，最新的贴锚点。
  // 自底向上累积：游标从 0 出发向 -y 走，最后一块（最新）底边贴 y=0。
  let cursor = 0;
  for (let i = flowBlocks.length - 1; i >= 0; i--) {
    const b = flowBlocks[i];
    const upper = flowBlocks[i - 1]; // 上方（更旧）相邻块
    const w = b.w ?? 720;
    const x = -w / 2; // 窄带居中（原点在窄带中轴）
    const y = cursor - b.h; // 块顶 = 游标 - 高度
    out.set(b.id, { x, y });
    // b 头顶的间距：上方块是 user → 它的尾距规则；否则看 b 自己是不是 user（头部加宽）
    const gap =
      upper?.kind === 'user' ? ANCHOR.userTailGap : ANCHOR.blockGap + (b.kind === 'user' ? ANCHOR.userLeadGap : 0);
    cursor = y - gap;
  }
  return out;
}

/** 相邻块间距查询（B1：虚拟化窗口/测高复用同一套节奏规则）。
 *  返回块 b 与其上方（更旧）相邻块之间的总间距。 */
export function gapAbove(b: { kind?: string }, upper: { kind?: string } | undefined): number {
  return upper?.kind === 'user' ? ANCHOR.userTailGap : ANCHOR.blockGap + (b.kind === 'user' ? ANCHOR.userLeadGap : 0);
}

/** 流区锚点（Stage-2 一纸多卷：多会话共享同一视口，各自流）。
 *  anchor.x = 流区中轴（块窄带中心），anchor.y = 最新块底边（流向上长，
 *  对齐 D-R1-3 流锚甲语义）。坐标 = 世界坐标，块在世界层绝对定位。 */
export interface RegionAnchor {
  x: number;
  y: number;
}

/** 多锚流布局（stage-2 4.2：单锚 → 多锚）。
 *  复用 layoutFlow 的相对栈序，整体平移到流区锚点——每流区独立栈：
 *  一个会话吐字只重算它自己的栈（“单流区更新=常数”铁律的布局根基）。 */
export function layoutRegion(
  flowBlocks: Array<{ id: string; h: number; w?: number; kind?: string }>,
  anchor: RegionAnchor,
): Map<string, { x: number; y: number }> {
  const rel = layoutFlow(flowBlocks);
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, pos] of rel) out.set(id, { x: anchor.x + pos.x, y: anchor.y + pos.y });
  return out;
}

/** 原点十字方位感（D-R1-1：无限画布 + 方位感——原点标记）。 */
export const ORIGIN_CROSS = { halfLen: 24, gap: 6 } as const;

/** 把流锚点对到屏幕位置：返回应设的 pan（pan = anchorScreen - world(0,0)*zoom）。
 *  输入条固定视口底部（D-R1-3），锚点在输入条上方 margin 处、水平居中。 */
export function viewForAnchor(viewportWidth: number, viewportHeight: number): { panX: number; panY: number } {
  const ax = viewportWidth / 2;
  const ay = viewportHeight - ANCHOR.screenBottomMargin;
  return { panX: ax, panY: ay };
}

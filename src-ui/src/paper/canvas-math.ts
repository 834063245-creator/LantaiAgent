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

/** 视口中心的世界坐标（键盘跳卷寻带 / 新卷落位找最近空列用）。 */
export function viewportCenterWorld(v: Viewport, w: number, h: number): { x: number; y: number } {
  return screenToWorld(v, w / 2, h / 2);
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

/* ── 缩放阶梯（2026-09-08 缩放舒适度拍板）──
 * 书眉 −/+ 控件与键盘 +/− 步进共用：不连续乘子（×1.2 手感不匀），走常用
 * 档位梯；档间值（自由缩放的落点）迈步 = 取该方向的下一档（上调恒升、
 * 下调恒降），端点外夹持。 */
export const ZOOM_STEPS = [ZOOM_MIN, 0.5, 0.75, 1, 1.5, 2, ZOOM_MAX];

/** 阶梯步进：dir +1 上调 / -1 下调——返回该方向的下一档位；越出两端夹持。 */
export function nextZoomStep(zoom: number, dir: 1 | -1): number {
  const EPS = 1e-9;
  if (dir > 0) {
    for (const s of ZOOM_STEPS) {
      if (s > zoom + EPS) return s;
    }
    return ZOOM_MAX;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < zoom - EPS) return ZOOM_STEPS[i];
  }
  return ZOOM_MIN;
}

/* ── 拖选自动滚屏（2026-09-07 UX 批）──
 * 鼠标拖选文字贴到画布边缘时，视口按指针入带深度自动平移（拖拽中介手势的
 * 通用原语——内容向指针反方向追出画外）。纯几何：指针位 → 单帧平移量。 */

/** 边缘感应带宽（px）：指针距画布边缘进带即起滚，越深越快。 */
export const AUTO_PAN_BAND = 36;
/** 单帧平移上限（px/帧；60fps ≈ 1560px/s），越出画布封顶 1.5×。 */
export const AUTO_PAN_MAX_SPEED = 26;

function axisAutoPan(pos: number, size: number, band: number, maxSpeed: number): number {
  const lo = band - pos; // 贴上/左缘深度（带内为正）
  const hi = pos - (size - band); // 贴下/右缘深度
  if (lo <= 0 && hi <= 0) return 0;
  // 双带重叠（画布窄于 2×带宽）取深侧；贴上/左 = 视口向负方向追（pan 增）。
  const towardLo = lo >= hi;
  const depth = towardLo ? lo : hi;
  return (towardLo ? 1 : -1) * maxSpeed * Math.min(1.5, Math.max(0, depth) / band);
}

/** 指针画布内坐标 → 单帧自动平移量（屏幕 px）。方向语义：指针贴下缘 →
 *  视口向下追内容（panY 减小，内容上移），贴上缘 → 向上追（panY 增大），
 *  左右同理——喂 panBy 即得「内容向指针反方向让出」。 */
export function autoPanVector(
  ix: number,
  iy: number,
  w: number,
  h: number,
  band = AUTO_PAN_BAND,
  maxSpeed = AUTO_PAN_MAX_SPEED,
): { dx: number; dy: number } {
  return { dx: axisAutoPan(ix, w, band, maxSpeed), dy: axisAutoPan(iy, h, band, maxSpeed) };
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
  /** 块间垂直间距（B1：原型节奏 48；无节奏信息的兜底档） */
  blockGap: 48,
  /** 来文块上方额外间距（B1 用户拍板：用户轮次从头顶切分——无节奏信息时的兜底） */
  userLeadGap: 24,
  /** 来文块下方间距（B1：asterism 尾距 30 为主，机械间距零头） */
  userTailGap: 8,
  /** 锚点行距屏幕底部的留白（输入条上方） */
  screenBottomMargin: 96,
  /* stream-rhythm 刀2（2026-09-03，计划 §3）：工作单元节奏档——D1 试值，
   * taste-ledger 待用户终审。层级：intra 32 < 块距 48 < unit 64 < stage 96。 */
  /** 单元内间距（同一工作单元的相邻块：行为链紧密纵向连接） */
  intraUnitGap: 32,
  /** 单元间间距（同回合内工作单元切换） */
  unitGap: 64,
  /** 转折放空（Error 起的恢复单元 / 墓碑前的空间——打破正常节奏） */
  recoveryLeadGap: 96,
  /** 阶段间间距（来文开新阶段：留白 + 细线） */
  stageGap: 96,
} as const;

/** 节奏档（group.leadOf / unitMembership 的产出映射到间距）。 */
export type RhythmClass = 'intra' | 'unit' | 'recovery' | 'stage';

/** 节奏档 → 间距值（表驱动：taste-ledger 钉值面）。 */
export function rhythmGap(r: RhythmClass): number {
  switch (r) {
    case 'intra':
      return ANCHOR.intraUnitGap;
    case 'unit':
      return ANCHOR.unitGap;
    case 'recovery':
      return ANCHOR.recoveryLeadGap;
    case 'stage':
      return ANCHOR.stageGap;
  }
}

/** 流布局输出：给每个 flow 块算出世界坐标（x 居中窄带，y 自锚点向上累积）。
 *  B1 垂直节奏：间距看「上面那块是否来文」——
 *    user 头顶（即下方是 user）：blockGap + userLeadGap（用户轮次切分，头顶宽）
 *    user 尾部（即上方是 user）：userTailGap（asterism 已带 30px 视觉尾距，零头）
 *    其余：blockGap（原型 48）。
 *  stream-rhythm 刀2：块带 rhythm 档时节奏档优先（intra 32 / unit 64 /
 *    recovery 96 / stage 96）；上方是 user 恒 userTailGap（B1 反转：来文后
 *    第一块紧贴，asterism 让位）。无 rhythm 的调用面（外部插件 / 旧测试）走
 *  B1 基线不变。
 *  自底向上遍历：游标减去的间距属于「上方那块」的头部空间。 */
export function layoutFlow(
  flowBlocks: Array<{ id: string; h: number; w?: number; kind?: string; rhythm?: RhythmClass }>,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  // 从锚点 (0, 0) 向上：第一个（最旧）块在最上，最新的贴锚点。
  // 自底向上累积：游标从 0 出发向 -y 走，最后一块（最新）底边贴 y=0。
  // ⚠ 防御（2026-09-03 级联排查）：h/w 非有限数（NaN/Infinity/负）会从该块起
  //  向上游整体污染游标（cursor = y - h - gap），让「从坏点起全乱」——
  //  非有限 h 按 0 兜底（宁可压扁单块，不级联全卷）；w 非有限用默认宽。
  let cursor = 0;
  for (let i = flowBlocks.length - 1; i >= 0; i--) {
    const b = flowBlocks[i];
    const upper = flowBlocks[i - 1]; // 上方（更旧）相邻块
    const rawH = b.h;
    const h = Number.isFinite(rawH) && rawH >= 0 ? rawH : 0;
    const rawW = b.w ?? 720;
    const w = Number.isFinite(rawW) && rawW > 0 ? rawW : 720;
    const x = -w / 2; // 窄带居中（原点在窄带中轴）
    const y = cursor - h; // 块顶 = 游标 - 高度
    out.set(b.id, { x, y });
    cursor = y - gapAbove(b, upper);
  }
  return out;
}

/** 相邻块间距查询（B1 + stream-rhythm 刀2：虚拟化窗口/测高复用同一套节奏规则）。
 *  返回块 b 与其上方（更旧）相邻块之间的总间距。 */
export function gapAbove(
  b: { kind?: string; rhythm?: RhythmClass },
  upper: { kind?: string; rhythm?: RhythmClass } | undefined,
): number {
  // B1 反转优先：上方是来文 → 尾距 8（asterism 已带视觉尾距，来文后第一块紧贴）
  if (upper?.kind === 'user') return ANCHOR.userTailGap;
  if (b.rhythm !== undefined) return rhythmGap(b.rhythm);
  return ANCHOR.blockGap + (b.kind === 'user' ? ANCHOR.userLeadGap : 0);
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

/** 定位器视口（Stage-3 书脊 / Stage-4 目次带共用）。
 *  rework P1-2（2026-08-26 实机）：把目标锚点对到**视口中心**（原实现沿用
 *  「底部上方 margin」的落位公式——锚点一跳落在屏高 35% 处，不符合「跳到目标轮次」
 *  的直觉）。水平居中 + 垂直中心，保持 zoom 不变。纯函数便于测试。
 *
 *  ⚠ 落位/回锚（D-R1-3 流锚甲，锚点对视口下缘上方 margin）**不在这里**——
 *  2026-09-17 起归产地域 `plugins/builtin/paper-shell/landing.ts::panForAnchor`。
 *  旧的 `viewForAnchor(w,h)`（只收视口宽高、把**世界原点**当锚）已随该批**删除**：
 *  卷锚 = 最新块底边、随内容向上漂，按原点落锚会把视口停在卷外（用户实机报了
 *  「按回锚就空白」）。 */
export function viewFocusRegion(
  v: Viewport,
  viewportWidth: number,
  viewportHeight: number,
  anchor: { x: number; y: number },
): Viewport {
  return {
    zoom: v.zoom,
    panX: viewportWidth / 2 - anchor.x * v.zoom,
    panY: viewportHeight / 2 - anchor.y * v.zoom,
  };
}

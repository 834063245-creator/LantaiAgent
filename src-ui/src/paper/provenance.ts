// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/provenance — 钉住块的「出处」派生面（2026-09-18 出处引导批）。
//
// 病灶（用户报）：块从会话流拖出钉到画布之后，**看不出它从哪来**——钉块与源块
// 之间只剩流内占位（.pp-ghost）一个记号，而占位是**视口内**的线索：流自锚点向
// 上生长（canvas-math layoutFlow 自底向上累积，最新块贴锚点），洞随新墨越漂越远
// （`regionTop = min(flowGeom.y)` 单向增负），视口一旦离开，公共物与来路的唯一
// 可见联系归零。
//
// 治法两条腿（本文件 = 二者的纯派生面，零 DOM / 零 store，同 selection.ts 纪律）：
//   ① **出处行**（`provenanceText`）——页边注第三行「摘自 卷名 · 状态字」，
//      **常显**：不依赖任何视口内目标即回答「从哪来」（出处是页边注的本职：
//      这条注疏对着哪段正文）；
//   ② **引线**（`tetherAnchors` + `tetherPath`）——hover 期把「来路」画出来：
//      钉缘 → 洞缘的一丝朱笔。洞离屏时引线照样出屏，**这正是「占位不在视口里
//      也仍有引导」的答案**（线走的方向就是源的方向）。
//
// 引线的笔墨语法 = **判例内转录**（2026-09-18 用户判「一根直线直连有点劣质」后
// 重做）：直接抄 `sel-ink`（划词朱线）那一支笔——逐点正弦微伏、定种子相位
// （同钉恒同线，重渲染不闪）、`smoothPath` 手绘平滑、**恒定墨宽**（该判例的
// 明文字律：**手感来自微伏不来自粗细变化**——等宽细线之所以劣质不在粗细，
// 在「贴死两个盒子 + 一笔到底的直线」）。四点按引线几何改写，每处都记了理由：
//   ① 层 = **屏幕坐标**固定层（同 `.pp-sel-ink`）：墨宽不随缩放变——世界 1px 在
//      zoom .3 下 = .3px，等于没画（引线是导航信号，缩远了更要看得见）；
//   ② 微伏走**弦的法向**（划词横线用竖向即可，引线可朝任意方向）；
//   ③ 叠一层**垂**（重力，只吃横向跨度：纯纵向的丝不垂）；
//   ④ 起笔**留白** TETHER_GAP（飘出来，不贴死钉缘）+ 收笔**朱点**（句读点朱的
//      遗意：线是引，点是落；划词的收笔挑钩是「离纸」，引线到站，故以点收）。
//
// 渲染决定（字号/墨阶/层序）不在这里——与 block-model「本层不做任何视觉决定」
// 同纪律；字面量由 tests/paper-provenance.test.ts 钉死。

import { smoothPath } from './sel-ink';
import type { FlowGeom } from './virtualize';

/** 出处状态：源卷摊开且源块在流内 / 源块不在卷内（撤回、压缩）/ 源卷未摊开 /
 *  源卷已删。状态字进出处行后缀，「活钉」无后缀（常态不加字）。 */
export type ProvenanceState = 'live' | 'absent' | 'unspread' | 'deleted';

/** 状态字（机读后缀；live = 空串——活钉是常态，不缀字）。 */
export const PROVENANCE_NOTE: Record<ProvenanceState, string> = {
  live: '',
  absent: '不在卷内',
  unspread: '未摊开',
  deleted: '已删',
};

/** 出处行卷名截断（字）：页边注栏 104px 宽、9px mono——超长卷名向左出栏，
 *  截断只为「一行读得完」，不占版心。状态字不受截断影响（后缀恒在）。 */
export const PROVENANCE_NAME_MAX = 10;

/** 引线起点纵向偏移（世界 px）：与文类签 hairline 连线（.pp-kind::after top 10px）
 *  同高地——视觉上「页边注的线」一直延长到洞里。 */
export const TETHER_PIN_DY = 12;

/** 起笔留白（屏幕 px）：线**不贴死钉缘**——飘出来的一丝，不是插在盒子上的插头。
 *  （收笔端不留守白：朱点要压在洞缘上，「落点」是实体。） */
export const TETHER_GAP = 6;

/** 微伏振幅上限（屏幕 px）——与划词朱线同量级（sel-ink amp ≤1.4）：一丝手抖，
 *  不是波浪。 */
export const TETHER_WOBBLE = 1.2;

/** 垂度上限（屏幕 px）：线**只横向跨度上垂**（纯纵向的丝不垂——两端同轴没有可垂
 *  的余量），垂度 = min(L×0.06, 18) × clamp(|dx| / (0.35L))。同理：真丝挂在两点间
 *  的样子。 */
export const TETHER_SAG_MAX = 18;

/** 出处行文本：`摘自 卷名` / `摘自 卷名 · 未摊开`。
 *  **卷名由调用方经 state/volume-name 的 volumeDisplayName 派生**（无名卷 → 案卷 N
 *  档号兜底；禁在调用点散写 `label || ...`）——本层只做拼装与截断。 */
export function provenanceText(name: string, state: ProvenanceState): string {
  const note = PROVENANCE_NOTE[state];
  const clipped = clipName(name);
  return note === '' ? `摘自 ${clipped}` : `摘自 ${clipped} · ${note}`;
}

function clipName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > PROVENANCE_NAME_MAX ? `${trimmed.slice(0, PROVENANCE_NAME_MAX)}…` : trimmed;
}

/** 可否点行回溯：已删卷**无回溯目标**——不发起必然落空的定位/摊开请求
 *  （2026-09-10 收口纪律：失败路径不发请求，只让按钮如实不可用）。 */
export function provenanceTraceable(state: ProvenanceState): boolean {
  return state !== 'deleted';
}

/** 出处行的 hover 说明（一句话后果，禁内部名词）。 */
export function provenanceTitle(state: ProvenanceState): string {
  switch (state) {
    case 'live':
      return '回到出处——本卷流内的原块位（点击）';
    case 'absent':
      return '源块已不在卷内（撤回/压缩）——定位到该卷（点击）';
    case 'unspread':
      return '源卷未摊开——摊开并定位（点击）';
    case 'deleted':
      return '源卷已删除——无法回溯';
  }
}

/** 出处行的源块 id：眉批快照钉的 id 是 `${父块 id}:sc`，其源块 = 父块
 *  （引线与定位都落在父块的流位——眉批原位就在那个块里）。 */
export function sourceBlockIdOf(sourceBlockId: string): string {
  return sourceBlockId.endsWith(':sc') ? sourceBlockId.slice(0, -':sc'.length) : sourceBlockId;
}

/** 引线端点（世界坐标）：钉缘 → 洞缘。选边规则 = **净空优先**：
 *  - 洞全在钉左（有净空）→ 钉左缘 → 洞右缘（最近对最近）；
 *  - 洞全在钉右 → 钉右缘 → 洞左缘；
 *  - 横向相叠（钉压着洞的一截）→ 两侧都取**左缘**：线往左出去，不横穿钉身
 *    （相叠时洞的右半被钉盖住，指向它等于没指）。
 *  起笔端再沿弦内缩 TETHER_GAP（线飘出来，不贴死钉缘）；收笔端**不缩**——
 *  朱点压在洞缘上。 */
export function tetherAnchors(
  pin: { x: number; y: number; w: number },
  hole: Pick<FlowGeom, 'x' | 'y' | 'w' | 'h'>,
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const y0 = pin.y + TETHER_PIN_DY;
  const y2 = hole.y + hole.h / 2;
  let x0: number;
  let x2: number;
  if (pin.x - (hole.x + hole.w) > 0) {
    x0 = pin.x;
    x2 = hole.x + hole.w; // 洞全在左
  } else if (hole.x - (pin.x + pin.w) > 0) {
    x0 = pin.x + pin.w;
    x2 = hole.x; // 洞全在右
  } else {
    x0 = pin.x;
    x2 = hole.x; // 横向相叠：两侧都取左缘
  }
  const dx = x2 - x0;
  const dy = y2 - y0;
  const len = Math.hypot(dx, dy);
  const k = len > TETHER_GAP ? TETHER_GAP / len : 0;
  return { from: { x: x0 + dx * k, y: y0 + dy * k }, to: { x: x2, y: y2 } };
}

/** 引线笔道采样点（**屏幕坐标**）+ 落点。与划词朱线同一手绘语法（sel-ink）：
 *  逐点正弦微伏 + 定种子相位（**同钉恒同线**，重渲染/平移不闪），但两处按引线的
 *  几何改写（各记理由）：
 *   ① 微伏取**弦的法向**——划词是横线（竖向微伏即可），引线可朝任意方向，
 *      纯竖向微伏在纵线上等于没有；
 *   ② 叠一层**垂**（重力）：只吃横向跨度，纯纵向的丝不垂。 */
export function tetherPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  seed: number,
): Array<[number, number]> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const n = Math.max(6, Math.min(28, Math.round(len / 46)));
  const nx = len > 0 ? -dy / len : 0;
  const ny = len > 0 ? dx / len : 0;
  const sag = Math.min(len * 0.06, TETHER_SAG_MAX) * Math.min(1, Math.abs(dx) / Math.max(1, len * 0.35));
  const phase = ((seed >>> 0) % 628) / 100;
  const freq = 4.2 + (seed % 3);
  const pts: Array<[number, number]> = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    // 包络取 sin(πt)：**两端微伏收零**——起笔留白、收笔落点都要干净（划词是着重线，
    // 两端照抖；引线的两端是「飘出」与「到站」）。
    const wob = Math.sin(phase + t * freq) * TETHER_WOBBLE * Math.sin(t * Math.PI);
    pts.push([from.x + dx * t + nx * wob, from.y + dy * t + ny * wob + 4 * t * (1 - t) * sag]);
  }
  return pts;
}

/** 引线绘制产物（屏幕坐标）：笔道 d 串（同一手绘平滑）+ 落点朱点。
 *  朱点是「句读点朱」的遗意——**线是引，点是落**（划词朱线的收笔挑钩是「离纸」，
 *  引线到站，故以点收）。 */
export interface TetherArt {
  d: string;
  bead: { x: number; y: number };
}

export function tetherPath(from: { x: number; y: number }, to: { x: number; y: number }, seed: number): TetherArt {
  return { d: smoothPath(tetherPoints(from, to, seed)), bead: { x: to.x, y: to.y } };
}

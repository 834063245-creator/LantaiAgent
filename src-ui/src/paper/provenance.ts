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
//   ② **引线**（`tetherLine`）——hover 期把「来路」在世界坐标里画出来：
//      钉缘 → 洞缘的一条直线。洞离屏时引线照样出屏，**这正是「占位不在视口里
//      也仍有引导」的答案**（线走的方向就是源的方向）。
//
// 渲染决定（字号/颜色/墨阶/挂点）不在这里——与 block-model「本层不做任何视觉
// 决定」同纪律；字面量由 tests/paper-provenance.test.ts 钉死。

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
 *    （相叠时洞的右半被钉盖住，指向它等于没指）。 */
export function tetherLine(
  pin: { x: number; y: number; w: number },
  hole: Pick<FlowGeom, 'x' | 'y' | 'w' | 'h'>,
): { x1: number; y1: number; x2: number; y2: number } {
  const y1 = pin.y + TETHER_PIN_DY;
  const y2 = hole.y + hole.h / 2;
  if (pin.x - (hole.x + hole.w) > 0) return { x1: pin.x, y1, x2: hole.x + hole.w, y2 };
  if (hole.x - (pin.x + pin.w) > 0) return { x1: pin.x + pin.w, y1, x2: hole.x, y2 };
  return { x1: pin.x, y1, x2: hole.x, y2 };
}

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
// ── 2026-09-22 三刀：笔道从「直弦 + 微伏」换成**切向贝塞尔**（用户拿 ComfyUI 的
//    连线为参照判「观感质感好多了」）──
//
// 诊断先行（`prototype/tether-pen-ab.NOTES.md`，实测不是印象）：微伏振幅是**绝对量**
// 1.2px、频率 ≈1 个周期——这套参数是给划词朱线（一行字，几十到几百 px）定的；搬到
// 600–1400px 的引线上，最大法向偏离只剩 2.68% → 0.47%，实看就是**一根尺子画的直线**
// （2026-09-18 判死的那版在视觉上原样回来了，只是多了留白与朱点）。同一台架实测墨本身
// 没问题（墨宽 1.42px、峰值覆盖 1.00，与字面量逐位吻合）——**劣质感出在几何，不在描边**。
//
// 治法 = 转录 ComfyUI 的曲线定律（`renderer/core/canvas/litegraph/litegraphLinkAdapter.ts:241-294`
// 的 SPLINE 分支：控制点 = 端点 + 锚面法向 × **弦长 × 0.25**，两端切线因此垂直于锚面）。
// 但**不能无上限照抄**——那条公式与弦长成正比且只有下限没上限，ComfyUI 里两端永远同屏
// （弦长几百 px）所以不炸，引线的洞可以在一屏之外：台架实测 1397px 弦 → 349px 臂长 →
// **240px 法向鼓包**。上限必须由我们给，两条各记理由：
//   · `TETHER_SPLINE_MAX`（160px）：臂长的**绝对**上限——鼓包随弦长线性增长，离屏越远越炸；
//   · `× TETHER_SPLINE_ROOM`：臂长还不得超过**横向净空**的比例——纯纵向的丝没有可鼓的余量
//     （与「垂只吃横向跨度」同一条判据），否则近纵向的线会朝一个任意方向鼓出去。
// 微伏与垂都留着（纸面语义，且「同钉恒同线」有防闪的功能价值），但各改一处：
//   · 垂的包络从 `4t(1-t)` 换成 `16t²(1-t)²`——**两端斜率归零**，不再破贝塞尔的水平切线
//     （旧包络在起笔处斜率为 4·sag，等于一边说着「水平出场」一边把线掰斜）；
//   · 微伏频率提高（≈1 个周期 → ≈1.4–2 个周期）：低频大振幅读作「这根直线没画准」，
//     高频小振幅才读作手抖。长线上它本来就看不太见，留着是**同钉恒同线**与近看的纸感。
//
// 渲染决定（字号/墨阶/层序）不在这里——与 block-model「本层不做任何视觉决定」
// 同纪律；字面量由 tests/paper-provenance.test.ts 钉死。
//
// ── 2026-09-22 版口引线批：**锚面法向**与臂长下限参数化（`TetherPen`）──
// 第三条腿（创作坞的版口钮 → 活卷的**纸脚**）两端锚面一个在**匣顶线**、一个在**卷底
// 边**，法向竖直——判例原文本来就是「锚面法向」，前两条腿因为锚面都是竖面才写死
// 水平。两处补全，缺省值恒等于旧行为（既有两条腿的 d 串逐字节不变 = 测试 diff 为零）：
//   · `normals`：两端**锚面外法向**（按锚面定，不按相对方位现算——方位一变就改法向，
//     会把「卷首落在匣身背后」那一档的线藏进匣里）；
//   · `minArm`：判例那条公式「只有下限没上限」，我们此前只搬了上限——法向近乎垂直于
//     两端连线时净空上限趋零、笔道退化成直线（摆在匣顶规线上就是一条贴出来的双线）。

import type { FlowGeom } from './host';
import { smoothPath } from './sel-ink';

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

/** **锚点纵向偏移**（世界 px）：块的左右缘各有一枚**固定锚点**（圆点），高度 = 块顶下这么多。
 *  取值 12 = 文类签 hairline 那一档（`.pp-kind` 的 `top: 2` + `::after` 的 `top: 10`）——流块上
 *  它正落在页边注连线的末端，钉块上它落在报头行里。
 *  **同一个相对位置是这套锚点的全部意义**（2026-09-22 锚点批）：引线两端都接在它上面，
 *  线因此永远插在东西上。 */
export const TETHER_ANCHOR_DY = 12;

/** 微伏振幅上限（屏幕 px）——与划词朱线同量级（sel-ink amp ≤1.4）：一丝手抖，
 *  不是波浪。 */
export const TETHER_WOBBLE = 1.2;

/** 垂度上限（屏幕 px）：线**只横向跨度上垂**（纯纵向的丝不垂——两端同轴没有可垂
 *  的余量），垂度 = min(L×0.06, 18) × clamp(|dx| / (0.35L))。同理：真丝挂在两点间
 *  的样子。 */
export const TETHER_SAG_MAX = 18;

/** 控制点臂长 = 弦长 × 0.25（ComfyUI SPLINE 判例，出处见文件头注「三刀」）。 */
export const TETHER_SPLINE_K = 0.25;

/** 控制点臂长上限（屏幕 px）——ComfyUI 那条公式与弦长成正比且**没有上限**：它的两端
 *  永远同屏（弦长几百 px）所以不炸，引线的洞可以在一屏之外（台架实测 1397px 弦 →
 *  无上限时 349px 臂长 → 240px 法向鼓包）。160 的由来：中距档（弦 ≈600px）臂长 149
 *  落在上限内 ⇒ 那一档的弧线与判例逐位一致，只有远洞档被夹住。 */
export const TETHER_SPLINE_MAX = 160;

/** 臂长还不得超过**沿法向的净空 × 这个比例**——纯横向的丝没有可鼓的余量（同「垂只吃
 *  横向跨度」那条判据）；沿法向分量 → 0 时臂长 → 0，笔道退化成一条直线（正是纯垂向
 *  该有的样子，不去朝一个任意方向鼓）。 */
export const TETHER_SPLINE_ROOM = 0.6;

/** 臂长**下限**（屏幕 px）——判例那条公式本就「只有下限没上限」（见文件头注「三刀」），
 *  我们此前只搬了上限。下限只在**沿法向净空趋零**时才起作用：那一刻上面那条净空上限
 *  趋零、笔道退化成直线——放在版口引线上就是「沿匣顶规线贴出一条双线」（正是用户判过
 *  的劣质感来源）。
 *  取值 48 的由来（实测，不是手感）：抬起的幅度 ≈ 0.75 × 臂长，而**重力垂**（上限
 *  `TETHER_SAG_MAX` = 18）在水平弦上正好把它吃回去——下限 24 时净抬起只剩 2.6px
 *  （tests/paper-provenance 的台架读数），等于没抬。48 ⇒ 净抬起 ≈ 18px，与垂同量级，
 *  一眼看得出「线离开了那条规线」。
 *  下限自身又不得超过弦长比例臂长（`min(minArm, len × K)`）：短线不许鼓出与长度不
 *  相称的肚子，退化点（len → 0）仍归零。 */
export const TETHER_SPLINE_MIN = 48;

/** 笔的两端**锚面外法向**（判例原文是「控制点 = 端点 + **锚面法向** × 弦长 × 0.25」（见
 *  文件头注「三刀」）——既有两条腿的两个锚面都是竖面（块的左右缘 / 卷首纸缘），故法向
 *  写死水平。版口引线那条腿两端一个在**匣顶线**、一个在**卷首底线**，法向竖直。
 *  **按锚面定，不按相对方位现算**：锚点挂在哪条缘上，线就朝那条缘的外侧出/进（相对
 *  方位一变就改法向，会让「卷首落在匣身背后」那一档把线藏进匣里——实测形态见
 *  tests/paper-provenance 的翻转档）。 */
export interface TetherNormals {
  /** 起笔端外法向（单位向量）。 */
  from: { x: number; y: number };
  /** 收笔端外法向（单位向量）。 */
  to: { x: number; y: number };
}

/** 笔的可调项（**缺省 = 既有两条腿的逐字节行为**：水平「面对面」法向 + 无臂长下限）。 */
export interface TetherPen {
  /** 两端锚面外法向（缺省 = 现行规则：由弦的 x 符号定，两端反向）。 */
  normals?: TetherNormals;
  /** 臂长下限（缺省 0 = 无下限；版口引线传 `TETHER_SPLINE_MIN`）。 */
  minArm?: number;
}

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

/** 引线端点（世界坐标）：钉缘 → 洞缘。选边规则 = **面对面**（按两者的横向中线）：
 *  - 洞中线在钉中线左 → 取**钉左缘**接**洞右缘**；
 *  - 否则 → 取**钉右缘**接**洞左缘**。
 *  一条判据覆盖全部三种相对位置（全在左 / 全在右 / 横向相叠），且两端都是**朝向对方
 *  的那条缘**——线因此不必绕过任何一方。
 *
 *  （2026-09-22 三刀改：旧规则是「净空优先 + 相叠时两侧都取左缘」。相叠那条**把落点
 *  送到背离钉的远缘**，线为了够到它**整条横穿该块全部正文**——台架实测中距档 4 段正文
 *  83 个采样点压在字上（`prototype/tether-pen-ab.NOTES.md` 病灶 4）。旧注给的理由是
 *  「相叠时洞的右半被钉盖住，指向它等于没指」，但判据只看横向（纵向叠不叠不知道），
 *  纵向分开时那个落点根本没被盖住——理由与判据不等强，故弃。现在线贴洞的**近缘**落点，
 *  不再横穿。
 *  **两端都落在锚点上**（2026-09-22 锚点批，用户判「没有一个固定的锚点来连接引线，
 *  感觉奇怪」）：高度一律 `TETHER_ANCHOR_DY`（块顶下 12px——每块左右缘各一枚固定圆点，
 *  见该常量注）；**起笔留白退役**（旧 `TETHER_GAP = 6` 把起点推到块缘外的虚空里，正是
 *  「没有锚点」的直接成因）。 */
export function tetherAnchors(
  pin: { x: number; y: number; w: number },
  hole: Pick<FlowGeom, 'x' | 'y' | 'w' | 'h'>,
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  return tetherAnchorsAt({ x: pin.x, y: pin.y + TETHER_ANCHOR_DY, w: pin.w }, hole);
}

/** 同一条引线，**锚高由调用方给**——钉那一路的锚高 = 块的锚点（`pin.y + TETHER_ANCHOR_DY`，
 *  见上）；枝边那一路从**卷首**起笔，锚在卷首中线。
 *  选边/锚点规则只有这一份（会话树「枝」的画布承接复用同一支笔，不新造线）。 */
export function tetherAnchorsAt(
  from: { x: number; y: number; w: number },
  hole: Pick<FlowGeom, 'x' | 'y' | 'w' | 'h'>,
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const y0 = from.y;
  const y2 = hole.y + TETHER_ANCHOR_DY;
  // 面对面：按两者横向中线判「洞偏哪边」，两端各取朝向对方的那条缘（判据见上注）。
  const x0 = hole.x + hole.w / 2 <= from.x + from.w / 2 ? from.x : from.x + from.w;
  const x2 = hole.x + hole.w / 2 <= from.x + from.w / 2 ? hole.x + hole.w : hole.x;
  return { from: { x: x0, y: y0 }, to: { x: x2, y: y2 } };
}

/** 引线笔道采样点（**屏幕坐标**）。
 *
 *  骨架 = **切向三次贝塞尔**（ComfyUI SPLINE 判例）：出笔与到站都沿**锚面外法向**
 *  （`pen.normals` 给，缺省水平 = 既有两条腿），控制点臂长 = 弦长 × 0.25，
 *  再夹两道上限与一道下限（`TETHER_SPLINE_MAX` / `_ROOM` / `_MIN` 各注）。
 *  墨仍是划词朱线那一支笔：逐点正弦微伏（走**弦的法向**，两端收零）+ 一层垂（重力，
 *  只吃横向跨度）+ 定种子相位（**同钉恒同线**，重渲染/平移不闪）。 */
export function tetherPoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  seed: number,
  pen?: TetherPen,
): Array<[number, number]> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const n = Math.max(10, Math.min(48, Math.round(len / 18)));
  // 两端控制点的推进方向 = 各端**锚面外法向**；缺省 = 现行水平「面对面」规则（由弦的
  // x 符号定，两端反向）——既有两条腿的锚面都是竖面，逐字节不变。
  const sx = dx < 0 ? -1 : 1;
  const nx0 = pen?.normals?.from.x ?? sx;
  const ny0 = pen?.normals?.from.y ?? 0;
  const nx1 = pen?.normals?.to.x ?? -sx;
  const ny1 = pen?.normals?.to.y ?? 0;
  // 沿起笔法向的净空（缺省 = |dx|）：臂长 = min(弦长 × K, 上限, 净空 × ROOM)，
  // 再托一次下限（下限只在净空趋零时起作用，且自身不得越过弦长比例臂长）。
  const along = dx * nx0 + dy * ny0;
  const off = Math.max(
    Math.min(len * TETHER_SPLINE_K, TETHER_SPLINE_MAX, Math.abs(along) * TETHER_SPLINE_ROOM),
    Math.min(pen?.minArm ?? 0, len * TETHER_SPLINE_K),
  );
  const c0x = from.x + nx0 * off;
  const c0y = from.y + ny0 * off;
  const c1x = to.x + nx1 * off;
  const c1y = to.y + ny1 * off;
  const nx = len > 0 ? -dy / len : 0;
  const ny = len > 0 ? dx / len : 0;
  const sag = Math.min(len * 0.06, TETHER_SAG_MAX) * Math.min(1, Math.abs(dx) / Math.max(1, len * 0.35));
  const phase = ((seed >>> 0) % 628) / 100;
  const freq = 8.5 + (seed % 4);
  const pts: Array<[number, number]> = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const u = 1 - t;
    // 两端**逐位**取锚点：微伏/垂的包络在两端是「数学上的 0」，浮点上是 1e-16 量级的
    // 残差——起笔留白与收笔朱点都按这两个点对齐，钉死它免得残差渗进下游对位。
    if (k === 0) {
      pts.push([from.x, from.y]);
      continue;
    }
    if (k === n) {
      pts.push([to.x, to.y]);
      continue;
    }
    const bx = u * u * u * from.x + 3 * u * u * t * c0x + 3 * u * t * t * c1x + t * t * t * to.x;
    const by = u * u * u * from.y + 3 * u * u * t * c0y + 3 * u * t * t * c1y + t * t * t * to.y;
    // 微伏包络取 sin(πt)：**两端微伏收零**——起笔留白、收笔落点都要干净（划词是着重线，
    // 两端照抖；引线的两端是「飘出」与「到站」）。
    const wob = Math.sin(phase + t * freq) * TETHER_WOBBLE * Math.sin(t * Math.PI);
    // 垂的包络取 16t²(1-t)²：**两端斜率为零**——不破上面那对水平切线（旧包络 4t(1-t)
    // 在起笔处斜率为 4·sag，等于一边说着「水平出场」一边把线掰斜）。
    const bump = 16 * t * t * u * u;
    pts.push([bx + nx * wob, by + ny * wob + bump * sag]);
  }
  return pts;
}

/** 引线绘制产物（屏幕坐标）：笔道 d 串（同一手绘平滑）+ **两端锚点**。
 *  2026-09-22 锚点批：`origin` 与 `bead` 是同一套锚点的两端——线从锚点出发、到锚点到站，
 *  两端各落一枚朱点（**线是引，点是落**，现在是「两头都是落」）。 */
export interface TetherArt {
  d: string;
  /** 起笔锚点（屏幕坐标）——块上那枚常显锚点圆点的圆心 */
  origin: { x: number; y: number };
  /** 收笔锚点（屏幕坐标）——同上 */
  bead: { x: number; y: number };
}

export function tetherPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  seed: number,
  pen?: TetherPen,
): TetherArt {
  return {
    d: smoothPath(tetherPoints(from, to, seed, pen)),
    origin: { x: from.x, y: from.y },
    bead: { x: to.x, y: to.y },
  };
}

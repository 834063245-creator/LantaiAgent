// SPDX-License-Identifier: MIT

// 出处引导钉值（2026-09-18 出处引导批）——钉住块的「从哪来」。
//
// 病灶（用户报）：「块从会话里拖出钉在画布上之后，完全不知道这东西从哪来；会话流
// 中的占位不在视口里，根本起不到任何引导作用」。机理：钉块与源块之间只剩流内占位
// （.pp-ghost）一个**视口内**的记号，而流自锚点向上生长（canvas-math layoutFlow
// 自底向上累积，最新块贴锚点）——洞随新墨越漂越远，视口一离开，公共物与来路的
// 唯一可见联系归零。
//
// 两条腿，本文件各钉一半：
//   ① 出处行（常显，不依赖任何视口内目标）= 页边注第三行「摘自 卷名 · 状态字」；
//   ② 引线（hover 期的空间面）= 世界坐标直线，**洞离屏时线照样出屏**（方向即来路）。
// 行为面（hover 挂线 / 点行溯源 / 洞点名）在 tests/paper-viewport-ux.test.tsx ⑪ 段。
//
// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_NAME_MAX,
  PROVENANCE_NOTE,
  provenanceText,
  provenanceTitle,
  provenanceTraceable,
  sourceBlockIdOf,
  TETHER_ANCHOR_DY,
  TETHER_SAG_MAX,
  TETHER_SPLINE_K,
  TETHER_SPLINE_MIN,
  TETHER_WOBBLE,
  tetherAnchors,
  tetherAnchorsAt,
  tetherPath,
  tetherPoints,
} from '../src/paper/provenance';

const SRC = join(__dirname, '..', 'src');
const PANEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');
const PANEL_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx'), 'utf8');
const DRAG_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'use-paper-drag.ts'), 'utf8');
const CANVAS_STORE_TS = readFileSync(join(SRC, 'state', 'canvas-store.ts'), 'utf8');
const PROVENANCE_TS = readFileSync(join(SRC, 'paper', 'provenance.ts'), 'utf8');
const SEL_INK_TS = readFileSync(join(SRC, 'paper', 'sel-ink.ts'), 'utf8');
const DOCK_TETHER_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'dock-tether.ts'), 'utf8');
const COMPOSER_FLOAT_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'composer-float.ts'), 'utf8');

/** 从选择器名截取规则体（到下一个 `}` 为止——纸壳 CSS 规则无嵌套，同
 *  paper-visual-decisions 的既有范式）。 */
function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
}

describe('出处行（常显那条腿）', () => {
  it('活钉：摘自 卷名，无状态字（常态不加字）', () => {
    expect(PROVENANCE_NOTE.live).toBe('');
    expect(provenanceText('卷二·案卷标题', 'live')).toBe('摘自 卷二·案卷标题');
  });

  it('三种非活态各有状态字：不在卷内 / 未摊开 / 已删', () => {
    expect(provenanceText('卷一', 'absent')).toBe('摘自 卷一 · 不在卷内');
    expect(provenanceText('卷一', 'unspread')).toBe('摘自 卷一 · 未摊开');
    expect(provenanceText('卷一', 'deleted')).toBe('摘自 卷一 · 已删');
  });

  it('超长卷名截断在纯层（一行读得完），状态字不受截断影响', () => {
    const long = '一'.repeat(PROVENANCE_NAME_MAX + 6);
    expect(provenanceText(long, 'unspread')).toBe(`摘自 ${'一'.repeat(PROVENANCE_NAME_MAX)}… · 未摊开`);
    // 恰好等于上限不截（不无中生有多一个省略号）
    expect(provenanceText('二'.repeat(PROVENANCE_NAME_MAX), 'live')).toBe(`摘自 ${'二'.repeat(PROVENANCE_NAME_MAX)}`);
  });

  it('已删卷不可点（不发起必然落空的定位/摊开——2026-09-10 收口纪律）', () => {
    expect(provenanceTraceable('deleted')).toBe(false);
    expect(provenanceTraceable('live')).toBe(true);
    expect(provenanceTraceable('unspread')).toBe(true);
    expect(provenanceTraceable('absent')).toBe(true);
    // 说明文案：已删如实说不能回溯，其余说清了后果（禁内部名词）
    expect(provenanceTitle('deleted')).toContain('无法回溯');
    expect(provenanceTitle('live')).toContain('回到出处');
    expect(provenanceTitle('unspread')).toContain('摊开');
    expect(provenanceTitle('absent')).toContain('不在卷内');
  });
});

describe('引线（划词朱线同族的手绘墨迹，2026-09-18 重做）', () => {
  const pin = { x: 260, y: 100, w: 480 };
  const hole = { x: -240, y: -600, w: 480, h: 32 };

  it('锚点选边（世界坐标）：面对面——两端各取朝向对方的那条缘', () => {
    // 洞全在钉左：钉左缘 → 洞右缘；落点 = 洞的**锚点**（块顶下 TETHER_ANCHOR_DY）
    expect(tetherAnchors(pin, hole).to).toEqual({ x: 240, y: -600 + TETHER_ANCHOR_DY });
    // 洞全在钉右：钉右缘 → 洞左缘
    expect(tetherAnchors(pin, { x: 900, y: -600, w: 480, h: 32 }).to).toEqual({
      x: 900,
      y: -600 + TETHER_ANCHOR_DY,
    });
    // 横向相叠（2026-09-22 三刀改）：仍取**朝向钉的那条缘**（洞右缘 240），
    // 不再送到背离钉的远缘（旧规则给 -240）——线因此不横穿该块
    expect(tetherAnchors({ x: 200, y: 100, w: 480 }, hole).to).toEqual({ x: 240, y: -600 + TETHER_ANCHOR_DY });
  });

  it('两端都落在锚点上（2026-09-22 锚点批）：起笔**不再留白**——就是块缘那枚圆点的圆心', () => {
    const a = tetherAnchors(pin, hole);
    // 起笔 = 钉左缘 × 块顶下 TETHER_ANCHOR_DY，**逐位相等**（旧写法沿弦内缩 6px，
    // 把起点推到块缘外的虚空里——用户判「没有固定的锚点」，该写法退役）
    expect(a.from).toEqual({ x: pin.x, y: pin.y + TETHER_ANCHOR_DY });
  });

  it('锚高由调用方给的同一支笔（会话树「枝」的画布承接复用）：tetherAnchors 只是它 + 块锚高', () => {
    // 钉那一路 = tetherAnchorsAt(锚高 pin.y + TETHER_ANCHOR_DY)（判例内转录，不新造线）
    expect(tetherAnchors(pin, hole)).toEqual(
      tetherAnchorsAt({ x: pin.x, y: pin.y + TETHER_ANCHOR_DY, w: pin.w }, hole),
    );
    // 枝边那一路：锚在**卷首中线**（世界坐标由调用方给），选边/锚点规则同一份
    const folio = { x: 1640, y: -1400, w: 720 };
    const node = { x: -360, y: -300, w: 720, h: 40 };
    const a = tetherAnchorsAt(folio, node);
    expect(a.to).toEqual({ x: 360, y: -300 + TETHER_ANCHOR_DY }); // 节点全在卷首左 ⇒ 收笔落节点右缘锚点
    expect(a.from).toEqual({ x: folio.x, y: folio.y }); // 起笔 = 卷首左缘锚点，无留白
  });

  it('笔道：两端收零（起笔/收笔干净），点数随长度；**无横向净空 ⇒ 直弦不鼓**', () => {
    const from = { x: 100, y: 500 };
    const to = { x: 100, y: -300 };
    const pts = tetherPoints(from, to, 7);
    expect(pts[0]).toEqual([from.x, from.y]); // 起笔 = 锚点（微伏包络为零）
    expect(pts[pts.length - 1]).toEqual([to.x, to.y]); // 收笔 = 落点（微伏包络为零）
    expect(pts.length).toBe(Math.max(10, Math.min(48, Math.round(800 / 18))) + 1);
    // 纯纵向（dx = 0 ⇒ 臂长 = 0）：**不垂也不鼓**——逐点仍在弦上，偏离只发生在横轴
    // （微伏走弦的法向，包络两端收零）。y 的**参数化**是不均匀的（贝塞尔两端慢中间快），
    // 但**轨迹**就是那条竖弦——这里钉的是轨迹不是步长。
    for (const [x, y] of pts) {
      expect(Math.abs(x - from.x)).toBeLessThanOrEqual(TETHER_WOBBLE);
      expect(y).toBeLessThanOrEqual(from.y + 1e-6);
      expect(y).toBeGreaterThanOrEqual(to.y - 1e-6);
    }
    // 中段确实在抖（不是一条零振幅的机器线），两端归零
    expect(Math.max(...pts.map(([x]) => Math.abs(x - from.x)))).toBeGreaterThan(0.3);
    expect(pts[0][0]).toBe(from.x);
    expect(pts[pts.length - 1][0]).toBe(to.x);
  });

  it('切向贝塞尔（三刀）：**有横向净空 ⇒ 成弧**（不再是直弦），出笔切线水平', () => {
    // 典型场景：钉落在卷右外侧（真净空），洞在卷内左上方。臂长 = 弦长 × 0.25 且在上限内
    const from = { x: 700, y: 400 };
    const to = { x: 300, y: 0 };
    const pts = tetherPoints(from, to, 42);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    const maxDev = Math.max(...pts.map(([x, y]) => Math.abs((x - from.x) * nx + (y - from.y) * ny)));
    // 直弦的法向偏离 ≈ 0（只有微伏 1.2px）；成弧后应到几十 px 量级
    expect(maxDev).toBeGreaterThan(20);
    expect(maxDev).toBeLessThan(len * 0.25); // 弧不是失控的鼓包
    // 出笔切线水平：首段斜率远平于弦（弦是 45°=1.0）——贝塞尔的参数化两端慢中间快，
    // 所以钉的是**切线方向**，不是某一步的绝对位移（那会把「参数化」误判成「几何」）
    const exitSlope = (pts[1][1] - pts[0][1]) / (pts[1][0] - pts[0][0]);
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const entrySlope = (last[1] - prev[1]) / (last[0] - prev[0]);
    expect(Math.abs(exitSlope)).toBeLessThan(0.2);
    expect(Math.abs(entrySlope)).toBeLessThan(0.2);
    expect(pts[0]).toEqual([from.x, from.y]);
    expect(pts[pts.length - 1]).toEqual([to.x, to.y]);
  });

  it('臂长两道夹：远洞不失控（上限），横向窄不鼓（净空比例）', () => {
    // 远洞（洞离屏 1288px）：无上限照抄 ComfyUI 会给 349px 臂长 → 240px 鼓包（台架实测）；
    // 夹到 TETHER_SPLINE_MAX 后，法向偏离必须显著小于那个值
    const far = tetherPoints({ x: 596, y: 368 }, { x: 40, y: -920 }, 42);
    const fx = -556;
    const fy = -1288;
    const flen = Math.hypot(fx, fy);
    const fnx = -fy / flen;
    const fny = fx / flen;
    const farDev = Math.max(...far.map(([x, y]) => Math.abs((x - 596) * fnx + (y - 368) * fny)));
    expect(farDev).toBeLessThan(180); // 未夹时是 240
    // 窄横向（钉缘贴着洞缘，只有 4px 净空）：臂长退到 ≈2.4px ⇒ 仍是一条直线
    const tight = tetherPoints({ x: 596, y: 312 }, { x: 600, y: 80 }, 42);
    const tdx = 4;
    const tdy = -232;
    const tlen = Math.hypot(tdx, tdy);
    const tDev = Math.max(...tight.map(([x, y]) => Math.abs((x - 596) * (-tdy / tlen) + (y - 312) * (tdx / tlen))));
    expect(tDev).toBeLessThan(6);
  });

  it('垂（重力）：只吃横向跨度——横丝中段下垂 ≈ 上限，纵丝不垂', () => {
    const flat = tetherPoints({ x: 0, y: 0 }, { x: 400, y: 0 }, 11);
    const midFlat = flat[Math.floor(flat.length / 2)];
    expect(midFlat[1]).toBeGreaterThan(10); // 垂下来（+y = 屏下）
    expect(midFlat[1]).toBeLessThanOrEqual(TETHER_SAG_MAX + TETHER_WOBBLE);
    // 陡丝（横向跨度小）垂度按比例收
    const steep = tetherPoints({ x: 0, y: 0 }, { x: 60, y: -800 }, 11);
    const midSteep = steep[Math.floor(steep.length / 2)];
    const straightY = -400;
    expect(midSteep[1] - straightY).toBeLessThan(midFlat[1] / 2);
  });

  it('定种子相位：同钉恒同线（重渲染/平移不闪），异钉异线', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 300, y: -500 };
    expect(tetherPoints(from, to, 42)).toEqual(tetherPoints(from, to, 42));
    expect(tetherPoints(from, to, 42)).not.toEqual(tetherPoints(from, to, 43));
    // 种子取钉 id（selSeedOf）——同钉同线是壳层接线，见「接线与样式钉值」
    const art = tetherPath(from, to, 42);
    expect(art.d.startsWith('M ')).toBe(true);
    expect(art.d).toBe(tetherPath(from, to, 42).d);
  });

  it('收笔朱点（句读点朱）：点 = 落点，不抖（线是引，点是落）', () => {
    const art = tetherPath({ x: 0, y: 0 }, { x: 300, y: -500 }, 42);
    expect(art.bead).toEqual({ x: 300, y: -500 });
  });
});

describe('眉批钉源块剥离', () => {
  it('`:sc` 快照钉的源块 = 父块（引线/定位落父块位）', () => {
    expect(sourceBlockIdOf('pb7:sc')).toBe('pb7');
    expect(sourceBlockIdOf('pb7')).toBe('pb7');
  });
});

/* 版口引线（2026-09-22）：第三条腿的笔——两端锚面一个在**匣顶线**、一个在**卷首底线**，
 * 故把判例原文的「锚面法向」与「只有下限没上限」两处**补全**（前两条腿因锚面皆竖面，
 * 把法向写死水平、只搬了上限）。缺省值必须恒等于旧行为——那是既有两条腿零漂移的证据。 */
describe('版口引线笔（2026-09-22：锚面法向 + 臂长下限，缺省 = 旧行为）', () => {
  const from = { x: 700, y: 400 };
  const to = { x: 300, y: 0 };
  /** 一条笔道对弦的**最大法向偏离**（px）。 */
  function maxDev(pts: Array<[number, number]>, a = from, b = to): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    return Math.max(...pts.map(([x, y]) => Math.abs((x - a.x) * nx + (y - a.y) * ny)));
  }

  it('缺省恒等于旧行为：不传笔 / 空笔 / `{normals: undefined, minArm: 0}` **逐点相等**', () => {
    const base = tetherPoints(from, to, 42);
    expect(tetherPoints(from, to, 42, {})).toEqual(base);
    expect(tetherPoints(from, to, 42, { minArm: 0 })).toEqual(base);
    expect(tetherPoints(from, to, 42, { normals: undefined, minArm: 0 })).toEqual(base);
    // d 串同逐字节（笔道是下游唯一读面）
    expect(tetherPath(from, to, 42, { minArm: 0 }).d).toBe(tetherPath(from, to, 42).d);
    expect(tetherPath(from, to, 42, {}).d).toBe(tetherPath(from, to, 42).d);
  });

  it('竖法向（匣顶朝上 / 卷首底线朝下）：出笔与到站都竖直，两端仍逐位落在锚点上', () => {
    const dock = { x: 400, y: 620 }; // 坞的版口钮（匣顶线上）
    const folio = { x: 520, y: 120 }; // 活卷的版口钮（卷首底线上，在匣上方）
    const pts = tetherPoints(dock, folio, 7, {
      normals: { from: { x: 0, y: -1 }, to: { x: 0, y: 1 } },
    });
    expect(pts[0]).toEqual([dock.x, dock.y]);
    expect(pts[pts.length - 1]).toEqual([folio.x, folio.y]);
    // 出笔朝上（匣顶外法向），切线竖直（水平位移远小于竖直位移）
    const exit = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
    expect(exit[1]).toBeLessThan(0);
    expect(Math.abs(exit[0])).toBeLessThan(Math.abs(exit[1]) * 0.2);
    // 到站自下方（卷首底线外法向），切线同样竖直——线是「胀上去」不是「贴过去」
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const entry = [last[0] - prev[0], last[1] - prev[1]];
    expect(entry[1]).toBeLessThan(0);
    expect(Math.abs(entry[0])).toBeLessThan(Math.abs(entry[1]) * 0.2);
  });

  it('法向**按锚面定，不按相对方位现算**：卷首落在匣身之下时，出笔仍朝上（不藏进匣里）', () => {
    // 翻转档（卷首底线在匣顶线之下）：出笔方向必须与「卷在上方」那一档**同一个**，
    // 否则线一出门就钻进匣身（z 4 < 匣 6 ⇒ 整段被匣盖住 = 绑定当场隐形）
    const dock = { x: 400, y: 200 };
    const folio = { x: 520, y: 700 };
    const pts = tetherPoints(dock, folio, 7, {
      normals: { from: { x: 0, y: -1 }, to: { x: 0, y: 1 } },
    });
    const exit = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]];
    expect(exit[1]).toBeLessThan(0); // 仍朝上出笔（匣顶外法向）
    // 到站仍自下方（卷首底线外法向）——两端各按自己的锚面走，中间那一段自然成 S
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    expect(last[1] - prev[1]).toBeLessThan(0);
  });

  it('臂长下限：沿法向净空趋零时托住笔道，不再贴着弦退化成一条直线', () => {
    // 卷首底线与匣顶线**同高**（纯水平弦）：净空 = |Δ·n| = 0 ⇒ 上限 0，没下限时
    // 笔道就是一条贴着弦的直线（摆在匣顶规线上＝那条规线的影子/双线）
    const dock = { x: 400, y: 300 };
    const folio = { x: 1100, y: 300 };
    const pen = { normals: { from: { x: 0, y: -1 }, to: { x: 0, y: 1 } } } as const;
    const flat = tetherPoints(dock, folio, 11, pen);
    const lifted = tetherPoints(dock, folio, 11, { ...pen, minArm: TETHER_SPLINE_MIN });
    /** 笔道越过起笔锚点**朝上**（-y）的最大幅度——下限托起的那一下。 */
    const up = (pts: Array<[number, number]>) => dock.y - Math.min(...pts.map(([, y]) => y));
    // 没下限：只会被重力垂往下拉，向上的偏离只有微伏振幅（≤ TETHER_WOBBLE）
    expect(up(flat)).toBeLessThanOrEqual(TETHER_WOBBLE + 1e-9);
    // 有下限：真的离开那条规线（出笔沿匣顶外法向抬起）
    expect(up(lifted)).toBeGreaterThan(5);
  });

  it('下限不得越过弦长比例臂长：短线不鼓出不相称的肚子，两端重合（退化）不绕圈', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 40, y: 2 };
    const pen = { normals: { from: { x: 0, y: -1 }, to: { x: 0, y: 1 } }, minArm: TETHER_SPLINE_MIN } as const;
    const pts = tetherPoints(a, b, 3, pen);
    const len = Math.hypot(40, 2);
    // 上限 = min(下限, 弦长 × K)：短线上抬起的量必须与长度相称（此处 ≤ 10px 臂长）
    const arm = Math.min(TETHER_SPLINE_MIN, len * TETHER_SPLINE_K);
    const sagMax = Math.min(len * 0.06, TETHER_SAG_MAX);
    expect(maxDev(pts, a, b)).toBeLessThan(arm + sagMax + TETHER_WOBBLE + 1e-6);
    // 两端重合：不动（下限不得在零长上造出一个圈）
    const same = tetherPoints(a, a, 3, pen);
    for (const [x, y] of same) {
      expect(x).toBe(0);
      expect(y).toBe(0);
    }
  });
});

describe('接线与样式钉值（防回漂）', () => {
  it('出处行：页边注第三行（文类签内），mono 9px 墨三档——不新立浮件、不占版心', () => {
    const prov = ruleBody(PANEL_CSS, '.pp-prov {');
    expect(prov).toContain('var(--f-mono)');
    expect(prov).toContain('font-size: 9px');
    expect(prov).toContain('var(--ink-3)');
    expect(prov).toContain('white-space: nowrap');
    // 超长卷名向左出栏、不压正文——不设 max-width（截断在纯层）
    expect(prov).not.toContain('max-width');
    // 可点态才给指针与 hover 朱砂（瞬时信号，不占常驻名额）
    expect(ruleBody(PANEL_CSS, '.pp-prov--trace {')).toContain('cursor: pointer');
    expect(ruleBody(PANEL_CSS, '.pp-prov--trace:hover')).toContain('var(--seal-deep)');
    // JSX 挂点：BlockView 文类签内
    expect(PANEL_TSX).toContain('className={`pp-prov${provTraceable');
    expect(PANEL_TSX).toContain('onProvClick?.(block.id)');
    // 已删卷：在场但不装作可点（aria-disabled；title 仍可读——disabled 会吃掉 tooltip）
    expect(PANEL_TSX).toContain('aria-disabled={!provTraceable}');
  });

  it('引线层：划词朱线同族的墨迹（恒定墨宽 + 圆头 + 手绘平滑），屏幕坐标层', () => {
    const layer = ruleBody(PANEL_CSS, '.pp-tether-layer {');
    expect(layer).toContain('position: absolute');
    expect(layer).toContain('pointer-events: none');
    // 屏幕坐标层（墨宽不随缩放变）+ z4：纸与块之上、坞（5）与浮件之下
    expect(layer).toContain('inset: 0');
    expect(layer).toContain('z-index: 4');
    const line = ruleBody(PANEL_CSS, '.pp-tether {');
    expect(line).toContain('fill: none'); // 描边不是填充——手感来自微伏不来自粗细变化
    expect(line).toContain('stroke: var(--seal)');
    expect(line).toContain('stroke-width: 1.4'); // 比划词朱线（1.7）细半档：丝不是着重
    expect(line).toContain('stroke-linecap: round');
    expect(line).not.toContain('non-scaling-stroke'); // 屏幕坐标层不需要它（曾是世界层）
    // 收笔朱点 + 出现一笔落下（只动不透明度）
    expect(ruleBody(PANEL_CSS, '.pp-tether-bead {')).toContain('var(--seal)');
    expect(ruleBody(PANEL_CSS, '@keyframes pp-tether-in {')).toContain('opacity: 0');
    // JSX：笔道 + 朱点；种子取钉 id（同钉恒同线）
    expect(PANEL_TSX).toContain('<path className="pp-tether" d={tether.d} />');
    expect(PANEL_TSX).toContain('className="pp-tether-bead"');
    expect(PANEL_TSX).toContain('selSeedOf(id)');
    // 手绘平滑与他人共用（同一支笔）——不各写一份
    expect(SEL_INK_TS).toContain('export function smoothPath');
    expect(PROVENANCE_TS).toContain("import { smoothPath } from './sel-ink'");
  });

  it('锚点（2026-09-22 锚点批）：每块左右缘各一枚固定圆点，引线两端各落一枚朱点', () => {
    // 常量与 CSS 字面量**同值**（两处各写一遍就必须钉住）
    expect(TETHER_ANCHOR_DY).toBe(12);
    const dot = ruleBody(PANEL_CSS, '.pp-anchor {');
    expect(dot).toContain('position: absolute');
    expect(dot).toContain(`top: ${TETHER_ANCHOR_DY}px`);
    expect(dot).toContain('border-radius: 50%');
    expect(dot).toContain('var(--ink-4)'); // 淡墨（与文类签 hairline 同阶）
    expect(dot).toContain('pointer-events: none');
    // **不常显**（2026-09-22 用户判「专门加的锚点圆点没必要常显」）：静态零信息噪声——
    // 引线本来就会在两端各落一枚朱点；改为进入块才显形（同 .pp-kind:hover 那族）
    expect(dot).toContain('opacity: 0');
    expect(dot).toContain('transition: opacity var(--snap)');
    expect(PANEL_CSS).toContain('.pp-block:hover .pp-anchor {');
    // 左右两缘各一枚（同一个相对位置 = 这套锚点的全部意义）
    expect(ruleBody(PANEL_CSS, '.pp-anchor--l {')).toContain('left: 0');
    expect(ruleBody(PANEL_CSS, '.pp-anchor--r {')).toContain('right: 0');
    // 页边注 hairline 加长接到左缘那枚锚点（地标与锚点连成一条链）
    expect(ruleBody(PANEL_CSS, '.pp-kind::after {')).toContain('width: 18px');
    // 起笔那枚独立成类：`.pp-tether-bead` 是「落点」的既有读面，不能被顶掉
    expect(ruleBody(PANEL_CSS, '.pp-tether-origin {')).toContain('var(--seal)');
    // JSX 挂点：两枚锚点在 BlockView（三条渲染路径共用那一处）；引线两端各一枚
    expect(PANEL_TSX).toContain('className="pp-anchor pp-anchor--l"');
    expect(PANEL_TSX).toContain('className="pp-anchor pp-anchor--r"');
    expect(PANEL_TSX).toContain('className="pp-tether-origin"');
  });

  it('一屏一线（防面条）：引线只在 hover/溯源期存在，不是常显装饰', () => {
    // 常显那条腿 = 出处行；引线由 tetherPinId/tracedPinId 门控
    expect(PANEL_TSX).toContain('const [tetherPinId, setTetherPinId] = useState<string | null>(null)');
    expect(PANEL_TSX).toContain('const [tracedPinId, setTracedPinId] = useState<string | null>(null)');
    expect(PANEL_TSX).toContain('const id = tetherPinId ?? tracedPinId');
    // hover 入口两处（活钉分支 + 孤儿钉分支）都挂
    expect(PANEL_TSX.match(/onMouseEnter=\{\(\) => setTetherPinId\(/g)?.length).toBe(2);
  });

  it('溯源：飞到源洞（flyToPoint 落洞中线）+ 未摊开走 expand（不发起必然落空的请求）', () => {
    expect(PANEL_TSX).toContain('flyToPoint(sid, hole.y + hole.h / 2, region.anchor.anchorX)');
    expect(PANEL_TSX).toContain('activeSpace()?.expand(sid)');
    // 点名一拍（洞位闪一次，1.6s 由壳层摘类）
    expect(ruleBody(PANEL_CSS, '.pp-ghost--traced {')).toContain('var(--seal)');
    expect(PANEL_TSX).toContain("tracedPinId === b.id ? ' pp-ghost--traced' : ''");
  });

  it('卷名在建钉时刻冻结进钉源（源卷退场后出处行仍写得出卷名）', () => {
    expect(CANVAS_STORE_TS).toContain('source?: { sessionId: number; blockId: string; label?: string }');
    expect(DRAG_TS).toContain('const srcLabel = sessionId');
    expect(DRAG_TS).toContain('...(srcLabel != null ? { label: srcLabel } : {})');
  });

  it('孤儿钉三态（已删 / 不在卷内 / 未摊开）：活卷名优先、冻结卷名兜底', () => {
    expect(PANEL_TSX).toContain('deadOrphanPinIds.has(pinId)');
    expect(PANEL_TSX).toContain('liveSession?.label ?? source.label');
  });

  /* 匣脚引线（2026-09-22）：坞的版口钮 → 活卷的纸脚。
   * 卷端落点**二版改档**（用户打回一版「你挂在第一条用户输入那不是乱了套了」）：天头那枚
   * 钮是「哪一卷活跃」的标记，位置又压在标题与第一条来文的接缝上；二版改接纸脚（纸的
   * 材料缘、没有任何字，且它才是「这一卷写到哪儿」的那一端）。 */
  it('匣脚引线：常显半档 + 可点（受墨带）、坞端＝坞顶左端版口钮、卷端＝活卷纸脚', () => {
    // 墨阶：常显半档 .55（同枝边——一屏一线不抢正文），hover 受墨带抬回 .9
    expect(ruleBody(PANEL_CSS, '.pp-dock-tether {')).toContain('opacity: 0.55');
    expect(PANEL_CSS).toContain('.pp-tether-hit:hover ~ .pp-dock-tether');
    // 层位不变（z 4 在坞 z 6 之下——引线不盖家具），可点靠受墨带（墨本身仍是那一丝）
    expect(PANEL_TSX).toContain('className="pp-tether pp-dock-tether"');
    expect(PANEL_TSX).toContain('className="pp-tether-layer pp-dock-layer"');
    // 坞端锚点：版口钮的**起端中点**——坞位/实测尺寸在槽主人手里
    expect(COMPOSER_FLOAT_TS).toContain('export function composerAnchorOf(');
    expect(COMPOSER_FLOAT_TS).toContain('COMPOSER_TICK_TOP + COMPOSER_TICK_H / 2');
    // 卷端锚点：版心左缘 × **卷底边（纸脚）**（版心宽走 measure.folioHeadWidthFor）
    expect(DOCK_TETHER_TS).toContain('export function regionFootAnchorOf(');
    expect(DOCK_TETHER_TS).toContain('folioHeadWidthFor(region.width)');
    expect(DOCK_TETHER_TS).toContain('region.regionTop + region.regionHeight');
    expect(PANEL_TSX).toContain('regionFootAnchorOf({');
    // 无活卷 / 流区尚未落位 ⇒ 不画线（宁可没有线，也不指错）
    expect(PANEL_TSX).toContain('if (activeSessionKey === null) return null;');
    expect(PANEL_TSX).toContain('if (!region) return null;');
    // 点线 = 溯源：飞到线的那一头（纸脚）——同枝边/出处引导那条判例
    expect(PANEL_TSX).toContain('flyToPoint(dockTether.sid, dockTether.foot.y, dockTether.foot.x)');
  });
});

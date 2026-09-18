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
  TETHER_GAP,
  TETHER_PIN_DY,
  TETHER_SAG_MAX,
  TETHER_WOBBLE,
  tetherAnchors,
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

  it('锚点选边（世界坐标）：净空优先（左/右）；横向相叠取左缘（不横穿钉身）', () => {
    // 洞全在钉左：钉左缘 → 洞右缘；落点 = 洞中线
    expect(tetherAnchors(pin, hole).to).toEqual({ x: 240, y: -584 });
    // 洞全在钉右：钉右缘 → 洞左缘
    expect(tetherAnchors(pin, { x: 900, y: -600, w: 480, h: 32 }).to).toEqual({ x: 900, y: -584 });
    // 横向相叠（钉压着洞的一截）：两侧都取左缘
    expect(tetherAnchors({ x: 200, y: 100, w: 480 }, hole).to).toEqual({ x: -240, y: -584 });
  });

  it('起笔留白：线不贴死钉缘——沿弦内缩 TETHER_GAP（收笔端不缩，朱点压在洞缘上）', () => {
    const a = tetherAnchors(pin, hole);
    const y0 = pin.y + TETHER_PIN_DY;
    expect(Math.hypot(a.from.x - pin.x, a.from.y - y0)).toBeCloseTo(TETHER_GAP, 6);
    expect(a.from.y).toBeLessThan(y0); // 缩向洞（向上）
  });

  it('笔道：两端微伏收零（起笔/收笔干净），点数随长度、上下有界', () => {
    const from = { x: 100, y: 500 };
    const to = { x: 100, y: -300 };
    const pts = tetherPoints(from, to, 7);
    expect(pts[0]).toEqual([from.x, from.y]); // 起笔 = 锚点（微伏包络为零）
    expect(pts[pts.length - 1]).toEqual([to.x, to.y]); // 收笔 = 落点（微伏包络为零）
    expect(pts.length).toBe(Math.max(6, Math.min(28, Math.round(800 / 46))) + 1);
    // 纯纵向：**不垂**（两端同轴没有可垂的余量）——纵坐标逐点仍在弦上，
    // 偏离只发生在横轴（微伏走弦的法向）
    const step = (to.y - from.y) / (pts.length - 1);
    for (let k = 0; k < pts.length; k++) {
      expect(pts[k][1]).toBeCloseTo(from.y + step * k, 6);
      expect(Math.abs(pts[k][0] - from.x)).toBeLessThanOrEqual(TETHER_WOBBLE);
    }
    // 中段抖得最开、两端归零
    const midK = Math.floor(pts.length / 2);
    expect(Math.abs(pts[midK][0] - from.x)).toBeGreaterThan(0.3);
    expect(pts[0][0]).toBe(from.x);
    expect(pts[pts.length - 1][0]).toBe(to.x);
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
});

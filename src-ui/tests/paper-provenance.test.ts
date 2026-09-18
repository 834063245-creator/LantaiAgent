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
  TETHER_PIN_DY,
  tetherLine,
} from '../src/paper/provenance';

const SRC = join(__dirname, '..', 'src');
const PANEL_CSS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.css'), 'utf8');
const PANEL_TSX = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'PaperPanel.tsx'), 'utf8');
const DRAG_TS = readFileSync(join(SRC, 'plugins', 'builtin', 'paper-shell', 'use-paper-drag.ts'), 'utf8');
const CANVAS_STORE_TS = readFileSync(join(SRC, 'state', 'canvas-store.ts'), 'utf8');

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

describe('引线端点（hover 那条腿）', () => {
  const pin = { x: 260, y: 100, w: 480 };

  it('洞全在钉左（有净空）：钉左缘 → 洞右缘——最近对最近，不横穿钉身', () => {
    const line = tetherLine(pin, { x: -240, y: -600, w: 480, h: 32 });
    expect(line).toEqual({ x1: 260, y1: 100 + TETHER_PIN_DY, x2: 240, y2: -600 + 16 });
  });

  it('洞全在钉右：钉右缘 → 洞左缘', () => {
    const line = tetherLine(pin, { x: 900, y: -600, w: 480, h: 32 });
    expect(line).toEqual({ x1: 740, y1: 100 + TETHER_PIN_DY, x2: 900, y2: -584 });
  });

  it('横向相叠（钉压着洞的一截）：两侧都取左缘——线往左出去，不横穿钉身', () => {
    // 钉左缘 260 落在洞内（洞 -240..240）右侧的相邻区：相叠
    const line = tetherLine({ x: 200, y: 100, w: 480 }, { x: -240, y: -600, w: 480, h: 32 });
    expect(line).toEqual({ x1: 200, y1: 100 + TETHER_PIN_DY, x2: -240, y2: -584 });
  });

  it('纵取钉挂点高（与文类签 hairline 同高地）/ 洞中线；洞在下方照样连（方向随几何）', () => {
    const line = tetherLine(pin, { x: -240, y: 900, w: 480, h: 32 });
    expect(line.y1).toBe(100 + TETHER_PIN_DY);
    expect(line.y2).toBe(916);
    expect(line.y2).toBeGreaterThan(line.y1);
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

  it('引线层：svg 出盒（世界坐标线可横跨十万 px）+ 不挡指针 + z 序在流区之上、块之下', () => {
    const layer = ruleBody(PANEL_CSS, '.pp-tether-layer {');
    expect(layer).toContain('position: absolute');
    expect(layer).toContain('overflow: visible');
    expect(layer).toContain('pointer-events: none');
    expect(layer).toContain('z-index: 1');
    const line = ruleBody(PANEL_CSS, '.pp-tether {');
    expect(line).toContain('var(--seal)');
    expect(line).toContain('non-scaling-stroke');
    // 块 z2 之上无引线（线不穿字）——z 序两处对拍
    expect(ruleBody(PANEL_CSS, '.pp-block {')).toContain('z-index: 2');
    expect(PANEL_TSX).toContain('<svg className="pp-tether-layer"');
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

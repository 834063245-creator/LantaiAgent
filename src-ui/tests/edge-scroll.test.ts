// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 边缘滚动子系统·策略读面（2026-09-17 立为原生功能）——纯函数考官：
// 设置字段 → 调参（缺省容错 / 毒化夹取 / 灵敏度映射）。
// 行为面（开关生效、灵敏度改带宽、三族手势接入）在
// tests/paper-viewport-ux.test.tsx；设置面板写面在
// tests/ui/settings-panel-save-split.test.ts。

import { describe, expect, it } from 'vitest';
import {
  clampSensitivity,
  EDGE_SCROLL,
  edgeScrollTuning,
  hoverEdgeEligible,
} from '../src/plugins/builtin/paper-shell/edge-scroll';
import type { AppSettings } from '../src/settings';

/** 只给本域关心的字段（其余用最小骨架——被测函数只读 canvas.edgeScroll）。 */
function settingsWith(canvas: AppSettings['canvas']): AppSettings {
  return { canvas } as AppSettings;
}

describe('边缘滚动·策略读面', () => {
  it('缺省：旧存储无 canvas / 无 edgeScroll 字段 = 开 + 基准灵敏度', () => {
    const base = edgeScrollTuning(settingsWith(undefined));
    expect(base.enabled).toBe(true);
    expect(base.band).toBe(EDGE_SCROLL.band);
    expect(base.maxSpeed).toBe(EDGE_SCROLL.maxSpeed);
    expect(edgeScrollTuning(settingsWith({ wheelMode: 'pan' }))).toEqual(base);
    // 只缺 sensitivity（半旧存储）
    expect(
      edgeScrollTuning(settingsWith({ wheelMode: 'pan', edgeScroll: { enabled: true, sensitivity: NaN } })),
    ).toEqual(base);
  });

  it('开关：enabled=false 即关（关掉后曲线参数不再被消费）', () => {
    expect(
      edgeScrollTuning(settingsWith({ wheelMode: 'pan', edgeScroll: { enabled: false, sensitivity: 1 } })).enabled,
    ).toBe(false);
    // 非布尔毒化值一律按「开」处理（宁可开，不可静默失效）
    expect(
      edgeScrollTuning(
        settingsWith({ wheelMode: 'pan', edgeScroll: { enabled: 'no' as unknown as boolean, sensitivity: 1 } }),
      ).enabled,
    ).toBe(true);
  });

  it('悬停即滚档：缺省**开**（2026-09-17 翻案——首版缺省关，实测「根本发现不了这功能」），显式 false 才关', () => {
    const hoverOf = (canvas: AppSettings['canvas']): boolean => edgeScrollTuning(settingsWith(canvas)).hover;
    expect(hoverOf({ wheelMode: 'pan' })).toBe(true);
    expect(hoverOf({ wheelMode: 'pan', edgeScroll: { enabled: true, sensitivity: 1 } })).toBe(true);
    expect(hoverOf({ wheelMode: 'pan', edgeScroll: { enabled: true, sensitivity: 1, hover: false } })).toBe(false);
    // 毒化值按「开」处理（宁可开，不可静默失效——同 enabled 口径）
    expect(
      hoverOf({ wheelMode: 'pan', edgeScroll: { enabled: true, sensitivity: 1, hover: 'no' as unknown as boolean } }),
    ).toBe(true);
  });

  it('灵敏度映射：滚速线性、带宽温和同向（√），两端夹取', () => {
    const t = (sensitivity: number): { band: number; maxSpeed: number } => {
      const r = edgeScrollTuning(settingsWith({ wheelMode: 'pan', edgeScroll: { enabled: true, sensitivity } }));
      return { band: r.band, maxSpeed: r.maxSpeed };
    };
    expect(t(1)).toEqual({ band: EDGE_SCROLL.band, maxSpeed: EDGE_SCROLL.maxSpeed });
    expect(t(2)).toEqual({ band: Math.round(EDGE_SCROLL.band * Math.SQRT2), maxSpeed: EDGE_SCROLL.maxSpeed * 2 });
    expect(t(0.5).maxSpeed).toBe(EDGE_SCROLL.maxSpeed * 0.5);
    expect(t(0.5).band).toBeLessThan(EDGE_SCROLL.band); // 越弱 = 越晚起滚
    // 越界与毒化值夹取到区间（不静默给 0——0 = 功能静默消失）
    expect(t(99).maxSpeed).toBe(EDGE_SCROLL.maxSpeed * EDGE_SCROLL.sensMax);
    expect(t(-5).maxSpeed).toBe(EDGE_SCROLL.maxSpeed * EDGE_SCROLL.sensMin);
    expect(clampSensitivity('x')).toBe(EDGE_SCROLL.sensDefault);
    expect(clampSensitivity(undefined)).toBe(EDGE_SCROLL.sensDefault);
  });

  /* 悬停可滚判据（纯函数）：三处刻意约束 + 交互面豁免 + **贴边浮件（目次带）视为画布**
   * ——2026-09-17 两轮实机取证：① canvas 宽 2560 / 右带 2524–2560 / 目次带 2496–2560 整条
   * 压住 ⇒ 右缘本无可用带；② 目次带是 `.pp-canvas` 的**兄弟**（覆盖件，不属画布 DOM），
   * 故「指针须落在画布内」这条硬判据才是真病灶（贴屏最右命中的是 nav.pp-toc 本身）。 */
  describe('hoverEdgeEligible 判据', () => {
    const RECT = { left: 0, top: 56, width: 2560, height: 1344 };
    const tuningOn = { enabled: true, hover: true, band: 36, maxSpeed: 26 };
    const build = (): {
      canvas: HTMLElement;
      block: HTMLElement;
      toc: HTMLElement;
      tocCard: HTMLElement;
      veil: HTMLElement;
    } => {
      document.body.innerHTML = '';
      const root = document.createElement('div');
      root.className = 'pp-root';
      const canvas = document.createElement('div');
      canvas.className = 'pp-canvas';
      const region = document.createElement('div');
      region.className = 'pp-region';
      const block = document.createElement('div'); // 正文：不豁免（纸面即地图）
      block.className = 'pp-block';
      const toc = document.createElement('div'); // 目次带：**覆盖件，画布之外**（真机结构）
      toc.className = 'pp-toc';
      const tocCard = document.createElement('button'); // 卡片：按钮 → 豁免
      const strip = document.createElement('div'); // 纸条：物理件 → 豁免
      strip.className = 'pp-strip';
      const veil = document.createElement('div'); // 弹层宿主（设置面板类）：非贴边浮件
      veil.id = 'settings-panel-overlay';
      toc.appendChild(tocCard);
      region.appendChild(block);
      region.appendChild(strip);
      canvas.appendChild(region);
      // ⚠ 目次带与弹层是 `.pp-canvas` 的**兄弟**（真机即此结构）——旧测试把它们塞进画布里，
      //   于是漏掉「画布外覆盖件」这条真病灶（右缘贴屏不滚）。
      root.appendChild(canvas);
      root.appendChild(toc);
      root.appendChild(veil);
      document.body.appendChild(root);
      return { canvas, block, toc, tocCard, veil };
    };
    const at = (target: Element | null, x: number, y: number, tuning = tuningOn, buttons = 0): boolean =>
      hoverEdgeEligible({
        target,
        canvas: document.querySelector('.pp-canvas'),
        clientX: x,
        clientY: y,
        buttons,
        tuning,
        rect: RECT,
      });

    it('正文/画布可滚；画布外不滚；**贴边浮件（目次带）可滚而其卡片豁免**；弹层宿主不滚', () => {
      const s = build();
      expect(at(s.block, 1266, 1390)).toBe(true); // 底带内（画布底 1400，带 36）
      expect(at(s.canvas, 1266, 1390)).toBe(true);
      expect(at(s.block, 1266, 1450)).toBe(false); // 画布下缘外：越出画布不追
      expect(at(s.toc, 2555, 700)).toBe(true); // 贴屏最右（目次带本体）→ 滚（真机 x=2555 命中 nav）
      expect(at(s.tocCard, 2520, 700)).toBe(false); // 卡片按钮豁免（瞄准卡片时不滚）
      expect(at(s.veil, 1266, 700)).toBe(false); // 弹层宿主（画布外、非贴边浮件）不滚
      expect(at(document.querySelector('.pp-strip'), 600, 700)).toBe(false); // 纸条豁免
    });

    it('开关 / 悬停档 / 按键三处约束：任一不满足即不可滚', () => {
      const s = build();
      expect(at(s.block, 1266, 1390, { ...tuningOn, enabled: false })).toBe(false);
      expect(at(s.block, 1266, 1390, { ...tuningOn, hover: false })).toBe(false);
      expect(at(s.block, 1266, 1390, tuningOn, 1)).toBe(false); // 拖拽在途 → 让位
      expect(at(null, 1266, 1390)).toBe(false); // 无 target（指针离开文档）
    });
  });
});

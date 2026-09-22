// @vitest-environment jsdom

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

  /* 悬停可滚判据（纯函数）：三处刻意约束 + 交互面豁免 + **贴边浮件（目次带 / 书脊列）
   * 视为画布**——2026-09-17 右缘两轮实机取证：① canvas 宽 2560 / 右带 2524–2560 / 目次带
   * 2496–2560 整条压住 ⇒ 右缘本无可用带；② 目次带是 `.pp-canvas` 的**兄弟**（覆盖件，
   * 不属画布 DOM），故「指针须落在画布内」这条硬判据才是真病灶（贴屏最右命中的是
   * nav.pp-toc 本身）。2026-09-21 左缘批同族（书脊列 [0,72] 压住左带 [0,36]）。 */
  describe('hoverEdgeEligible 判据', () => {
    /* 画布 rect：**top 0**——2026-09-17 标题栏拆除批后画布铺满整窗（顶缘 = 屏缘）。
     * 正是这一条让「指针甩到屏顶」落进上缘感应带（旧书眉 56px 布局行时，屏顶
     * 那 56px 是书眉 DOM，判据一律否掉 ⇒ 上缘在用户视角里等于没有边缘滚动）。 */
    const RECT = { left: 0, top: 0, width: 2560, height: 1400 };
    const tuningOn = { enabled: true, hover: true, band: 36, maxSpeed: 26 };
    const build = (): {
      canvas: HTMLElement;
      block: HTMLElement;
      toc: HTMLElement;
      tocCard: HTMLElement;
      chrome: HTMLElement;
      chromeBtn: HTMLElement;
      veil: HTMLElement;
      rack: HTMLElement;
      list: HTMLElement;
      spineMain: HTMLElement;
      label: HTMLElement;
      rackToggle: HTMLElement;
      card: HTMLElement;
      cardBtn: HTMLElement;
      sidebar: HTMLElement;
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
      const chrome = document.createElement('div'); // 顶部浮件（原书眉）：覆盖件 + 窗口拖动热区
      chrome.className = 'pp-chrome';
      const chromeBtn = document.createElement('button'); // 浮件里的设置/窗口钮 → 豁免
      const veil = document.createElement('div'); // 弹层宿主（设置面板类）：非贴边浮件
      veil.id = 'settings-panel-overlay';
      toc.appendChild(tocCard);
      chrome.appendChild(chromeBtn);
      region.appendChild(block);
      region.appendChild(strip);
      canvas.appendChild(region);
      // ⚠ 目次带/浮件/弹层都是 `.pp-canvas` 的**兄弟**（真机即此结构）——旧测试把
      //   它们塞进画布里，于是漏掉「画布外覆盖件」这条真病灶（右缘贴屏不滚）。
      root.appendChild(canvas);
      root.appendChild(toc);
      root.appendChild(chrome);
      root.appendChild(veil);
      document.body.appendChild(root);

      /* 书脊列（左缘 dock，2026-09-21 左缘批）：真机结构 = 面板坞里的一枚 fixed 覆盖件，
       * **在 `.pp-root` 之外**（探针实测 parentElement = 无名 div，非 .pp-canvas）。
       * 内部层级照 SpineRack：列 > 案卷扣 button + 脊列 .sr-list > 脊槽 .sr-spine >
       * 脊块 .sr-spine-main（div[role=tab]，点/拖/hover 三手势的瞄准面）> 题签 .sr-label。 */
      const dock = document.createElement('div'); // 面板坞宿主（DockPanel 的容器）
      const rack = document.createElement('div');
      rack.className = 'sr-rack';
      const rackToggle = document.createElement('button');
      rackToggle.className = 'sr-sidebar-toggle';
      const list = document.createElement('div');
      list.className = 'sr-list';
      const spine = document.createElement('div');
      spine.className = 'sr-spine sr-active';
      const spineMain = document.createElement('div');
      spineMain.className = 'sr-spine-main';
      spineMain.setAttribute('role', 'tab');
      const label = document.createElement('span');
      label.className = 'sr-label';
      spineMain.appendChild(label);
      spine.appendChild(spineMain);
      list.appendChild(spine);
      const card = document.createElement('div'); // hover 小卡：列外、压画布的瞄准面
      card.className = 'sr-card';
      const cardBtn = document.createElement('button');
      cardBtn.className = 'sr-close-btn';
      card.appendChild(cardBtn);
      rack.appendChild(rackToggle);
      rack.appendChild(list);
      rack.appendChild(card);
      dock.appendChild(rack);
      // 案卷侧栏 = 同一坞位的**展开态**（互斥两态）：宽面板，非贴边浮件
      const sidebar = document.createElement('div');
      sidebar.className = 'ss-sidebar';
      dock.appendChild(sidebar);
      document.body.appendChild(dock);

      return {
        canvas,
        block,
        toc,
        tocCard,
        chrome,
        chromeBtn,
        veil,
        rack,
        list,
        spineMain,
        label,
        rackToggle,
        card,
        cardBtn,
        sidebar,
      };
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

    /* 顶部浮件（2026-09-17 标题栏拆除批）：画布顶缘 = 屏缘 ⇒ **上缘感应带在
     * 屏顶那 36px 里**，指针甩到屏顶即滚——这是本批要买的行为。浮件本体是
     * 覆盖件（右上角一枚），其上的悬停不滚（同弹层口径：浮件是「别的面」，
     * 不是画布本体；同族的目次带另有 HOVER_ALLOW_DOCKS 兜着）。 */
    it('上缘感应带：屏顶那 36px 落在画布上可滚；浮件本体不滚（其为覆盖件）', () => {
      const s = build();
      expect(at(s.block, 1266, 30)).toBe(true); // 屏顶 30px：画布上缘带内（旧书眉时此点必 false）
      expect(at(s.canvas, 1266, 2)).toBe(true); // 贴死屏顶
      expect(at(s.chrome, 2300, 30)).toBe(false); // 浮件本体（覆盖件）不滚
      expect(at(s.chromeBtn, 2300, 30)).toBe(false); // 浮件里的窗口钮/设置钮（按钮）不滚
    });

    it('开关 / 悬停档 / 按键三处约束：任一不满足即不可滚', () => {
      const s = build();
      expect(at(s.block, 1266, 1390, { ...tuningOn, enabled: false })).toBe(false);
      expect(at(s.block, 1266, 1390, { ...tuningOn, hover: false })).toBe(false);
      expect(at(s.block, 1266, 1390, tuningOn, 1)).toBe(false); // 拖拽在途 → 让位
      expect(at(null, 1266, 1390)).toBe(false); // 无 target（指针离开文档）
    });

    /* 书脊列压住**左缘**感应带（2026-09-21 左缘批；用户「边缘滚动的左侧边缘失灵了，
     * 估计是和新的书脊栏逻辑冲突了」）。真机几何（探针 prototype/_probe-edge-left.mjs
     * --stim，2560×1400）：列 [0,72] 全高、脊块占 [6,68]、左带 = [0,36] ⇒ **整条带
     * 压在列内**；列自滚轮批起 pointer-events: auto ⇒ 贴屏最左命中的是列板面而不是
     * 画布 ⇒ 左缘等于没有缘滚（实测 x=2/5/20/40 停 500ms pan Δ=0，同刻右缘跑道
     * Δ=−958、上缘 Δ=+1032）。判据：列的**板面与书缝**算画布（最左内距带正是「指针
     * 甩到屏左」的落点），**脊块 / 小卡 / 按钮**是瞄准面（同目次带卡片口径）。 */
    it('左缘：书脊列的板面/内距带可滚（贴死屏左即滚），脊块与 hover 小卡豁免', () => {
      const s = build();
      expect(at(s.rack, 2, 700)).toBe(true); // 最左内距带：指针被屏缘钉住处
      expect(at(s.rack, 5, 700)).toBe(true);
      expect(at(s.list, 20, 1380)).toBe(true); // 列板面/书缝（末脊之下的空白）= 画布
      expect(at(s.spineMain, 20, 121)).toBe(false); // 脊块：点=定位 / 拖=落位 / hover=小卡
      expect(at(s.label, 40, 121)).toBe(false); // 题签在脊块内
      expect(at(s.rackToggle, 36, 20)).toBe(false); // 「案卷」虚线扣 = button
      expect(at(s.card, 120, 121)).toBe(false); // hover 小卡（列外、压画布的瞄准面）
      expect(at(s.cardBtn, 130, 160)).toBe(false);
      // 展开态案卷侧栏是同一坞位的宽面板，**不是**贴边浮件（悬停其上照滚 = 跟随相机）
      expect(at(s.sidebar, 150, 700)).toBe(false);
    });
  });
});

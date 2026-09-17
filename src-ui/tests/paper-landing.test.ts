// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 落位 / 回锚算式（插件域纯函数）——2026-09-17 用户报「点开工作区 / 按回锚就空白，
// 啥也不渲染」的考官。
//
// 病灶：落位一律按**世界原点**算，而卷锚（= 该卷最新块底边，流向上长）随内容往上
// 漂——用户三卷实测锚点都在 -28,700 上下，于是 Home/首屏把视口停在卷外 28,700px 的
// 空白桌面上（CDP 实测：Home 之后视口世界区间 [-2045, 151]、可见块 0）。
// 修法：落位认**卷锚**。算式刻意落在插件域（`landing.ts`，壳域 canvas-math 改动
// 必须重建 exe），故此处做**跨域对拍**：锚在原点这一档必须与
// `canvas-math.viewForAnchor` 逐值一致——两处漂了就红。

import { describe, expect, it } from 'vitest';
import { ANCHOR, viewForAnchor, worldToScreen } from '../src/paper/canvas-math';
import { panForAnchor } from '../src/plugins/builtin/paper-shell/landing';

const MARGIN = ANCHOR.screenBottomMargin;

describe('落位 / 回锚：panForAnchor（认卷锚）', () => {
  it('锚在原点时与壳域 viewForAnchor 逐值一致（跨域对拍，漂了就红）', () => {
    for (const [w, h] of [
      [1000, 800],
      [2560, 1400],
      [720, 480],
    ] as const) {
      expect(panForAnchor({ w, h }, 1, { x: 0, y: 0 }, MARGIN)).toEqual(viewForAnchor(w, h));
    }
  });

  it('卷锚对到屏幕锚位：水平居中 + 下缘上方 margin（zoom 参与换算）', () => {
    const anchor = { x: -1218, y: -28700 };
    const p = panForAnchor({ w: 1000, h: 800 }, 0.5, anchor, MARGIN);
    const s = worldToScreen({ ...p, zoom: 0.5 }, anchor.x, anchor.y);
    expect(s.x).toBe(500);
    expect(s.y).toBe(800 - MARGIN);
  });

  it('用户现场：卷锚 -28,700 时，旧口径（锚=原点）把卷推出屏外 8 屏以上', () => {
    const anchor = { x: 0, y: -28700 };
    const zoom = 0.6377;
    const fixed = panForAnchor({ w: 2560, h: 1400 }, zoom, anchor, MARGIN);
    const oldWay = panForAnchor({ w: 2560, h: 1400 }, zoom, { x: 0, y: 0 }, MARGIN);
    // 卷锚在新口径下贴视口下缘上方 margin（看得见）
    expect(worldToScreen({ ...fixed, zoom }, 0, anchor.y).y).toBe(1400 - MARGIN);
    // 旧口径下卷锚远在视口**上方**屏外（= 屏幕上一块都没有；实测 -16,998px，逾 12 屏）
    expect(worldToScreen({ ...oldWay, zoom }, 0, anchor.y).y).toBeLessThan(-8 * 1400);
  });
});

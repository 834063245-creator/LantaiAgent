// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作坞浮动化（2026-09-17 用户拍板：全画布自由浮动 + 吸附边缘 + 双击复位，
// 锚线跟随重算）——几何/命中/记忆纯函数考官（composer-float.ts）。
//
// 口径（与文件头注同源）：
//   - pos = { left, bottom }（视口坐标：左缘距 + 底缘距）；null = 无覆盖 =
//     CSS 默认位（版心居中 + 坐底抬高 96）；
//   - 让位带 band = bottom + 坞高（默认位恒 = 96 + 坞高 ⇒ 与浮动化前零漂移）；
//   - 命中判据 isComposerHandle：坞书眉行内的**非交互件**才是抓手。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  COMPOSER_BAR_H,
  COMPOSER_EDGE,
  COMPOSER_POS_KEY,
  COMPOSER_RISE,
  COMPOSER_SNAP,
  clampComposerPos,
  composerBandOf,
  isComposerHandle,
  loadComposerPos,
  saveComposerPos,
  snapComposerPos,
} from '../src/plugins/builtin/paper-shell/composer-float';

const VP = { w: 1200, h: 800 };
const BOX = { w: 880, h: 110 };

describe('创作坞浮动化 · 几何（夹紧）', () => {
  it('坞整体留在视口内：左/右/下留屏缘，上不越书眉（坞顶 ≥ 书眉高 + 屏缘）', () => {
    const far = clampComposerPos({ left: -500, bottom: -500 }, VP, BOX);
    expect(far).toEqual({ left: COMPOSER_EDGE, bottom: COMPOSER_EDGE });

    const beyond = clampComposerPos({ left: 9999, bottom: 9999 }, VP, BOX);
    expect(beyond.left).toBe(VP.w - BOX.w - COMPOSER_EDGE);
    // 上界 = 视口高 − 书眉高 − 坞高 − 屏缘（坞顶恰好落在书眉下缘 + 屏缘）
    expect(beyond.bottom).toBe(VP.h - COMPOSER_BAR_H - BOX.h - COMPOSER_EDGE);
    expect(VP.h - beyond.bottom - BOX.h).toBe(COMPOSER_BAR_H + COMPOSER_EDGE);
  });

  it('坞比视口还宽（窄窗口）：不产生负上界（退回屏缘，不炸布局）', () => {
    const narrow = clampComposerPos({ left: 400, bottom: 20 }, { w: 400, h: 300 }, { w: 880, h: 110 });
    expect(narrow.left).toBe(COMPOSER_EDGE);
    expect(narrow.bottom).toBe(20);
  });
});

describe('创作坞浮动化 · 吸附边缘', () => {
  const snap = (left: number, bottom: number) => snapComposerPos({ left, bottom }, VP, BOX);

  it('横向三枚锚：左缘 / 版心中轴 / 右缘（阈内即吸）', () => {
    expect(snap(COMPOSER_EDGE + 10, 300).left).toBe(COMPOSER_EDGE);
    const center = (VP.w - BOX.w) / 2;
    expect(snap(center + COMPOSER_SNAP - 1, 300).left).toBe(center);
    expect(snap(VP.w - BOX.w - COMPOSER_EDGE - 10, 300).left).toBe(VP.w - BOX.w - COMPOSER_EDGE);
  });

  it('纵向两枚锚：经典底带（抬高 96）/ 最底缘（屏缘）', () => {
    expect(snap(300, COMPOSER_RISE + COMPOSER_SNAP - 1).bottom).toBe(COMPOSER_RISE);
    expect(snap(300, COMPOSER_EDGE + COMPOSER_SNAP - 1).bottom).toBe(COMPOSER_EDGE);
  });

  it('阈外不吸（自由浮动），且吸附幂等（吸过的位再吸不动）', () => {
    const free = { left: 500, bottom: 400 };
    expect(snap(free.left, free.bottom)).toEqual(free);
    const snapped = snap(COMPOSER_EDGE + 3, COMPOSER_RISE + 3);
    expect(snap(snapped.left, snapped.bottom)).toEqual(snapped);
  });
});

describe('创作坞浮动化 · 让位带', () => {
  it('无覆盖（默认位）= 抬高 + 坞高——与浮动化前的 --composer-h-live 配对式同值', () => {
    expect(composerBandOf(null, 110)).toBe(COMPOSER_RISE + 110);
  });

  it('浮动态 = 坞的实际位置（bottom + 坞高）：坞越往上，让位带越大', () => {
    expect(composerBandOf({ left: 40, bottom: 300 }, 110)).toBe(410);
    expect(composerBandOf({ left: 40, bottom: 96 }, 110)).toBe(206);
  });

  it('坞高变了带跟着变（思考展开/附件/墨量册——同一条式子）', () => {
    expect(composerBandOf(null, 300)).toBe(396);
  });
});

describe('创作坞浮动化 · 坞头命中判据', () => {
  function markup(html: string): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'pp-composer-slot';
    slot.innerHTML = `<div class="pp-composer">${html}</div>`;
    return slot;
  }

  it('坞书眉行的空白处/卷名 = 抓手', () => {
    const slot = markup(
      '<div class="pp-composer-header"><span class="pp-composer-target">卷一</span>' +
        '<div class="pp-composer-settings-spacer"></div></div>',
    );
    expect(isComposerHandle(slot.querySelector('.pp-composer-target'))).toBe(true);
    expect(isComposerHandle(slot.querySelector('.pp-composer-settings-spacer'))).toBe(true);
    expect(isComposerHandle(slot.querySelector('.pp-composer-header'))).toBe(true);
  });

  it('书眉行内的交互件不承载拖坞手势（自己接手势）', () => {
    const slot = markup(
      '<div class="pp-composer-header"><button type="button" class="pp-tool-btn">翰</button>' +
        '<span class="pp-bg-running">⟳ 后台 1 卷运行中<button type="button" class="pp-bg-stop">停止</button></span></div>',
    );
    expect(isComposerHandle(slot.querySelector('.pp-tool-btn'))).toBe(false);
    expect(isComposerHandle(slot.querySelector('.pp-bg-stop'))).toBe(false);
  });

  it('书眉行之外不承载拖坞手势（输入行/设置行：打字与控件都不该挪坞）', () => {
    const slot = markup(
      '<div class="pp-composer-row"><textarea></textarea></div>' +
        '<div class="pp-composer-settings"><div class="pp-comp-sel">组合</div></div>',
    );
    expect(isComposerHandle(slot.querySelector('textarea'))).toBe(false);
    expect(isComposerHandle(slot.querySelector('.pp-comp-sel'))).toBe(false);
    expect(isComposerHandle(null)).toBe(false);
  });
});

describe('创作坞浮动化 · 坞位记忆（localStorage）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('往返：存整数 px，读回同值', () => {
    saveComposerPos({ left: 123.4, bottom: 96.6 });
    expect(loadComposerPos()).toEqual({ left: 123, bottom: 97 });
  });

  it('无键 = 无覆盖（null）', () => {
    expect(loadComposerPos()).toBeNull();
  });

  it('双击复位 = 清覆盖（键移除，坞回 CSS 默认位）', () => {
    saveComposerPos({ left: 10, bottom: 10 });
    saveComposerPos(null);
    expect(localStorage.getItem(COMPOSER_POS_KEY)).toBeNull();
    expect(loadComposerPos()).toBeNull();
  });

  it('毒化数据当无覆盖（坏 JSON / 缺字段 / 非有限数）——读侧容忍，不炸不静默兜成坐标', () => {
    localStorage.setItem(COMPOSER_POS_KEY, '{oops');
    expect(loadComposerPos()).toBeNull();
    localStorage.setItem(COMPOSER_POS_KEY, '{"left":12}');
    expect(loadComposerPos()).toBeNull();
    localStorage.setItem(COMPOSER_POS_KEY, '{"left":null,"bottom":"96"}');
    expect(loadComposerPos()).toBeNull();
  });
});

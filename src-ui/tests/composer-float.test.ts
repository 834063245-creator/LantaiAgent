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
  COMPOSER_PILL_H,
  COMPOSER_POS_KEY,
  COMPOSER_RISE,
  COMPOSER_SNAP,
  COMPOSER_UNLOCK_KEY,
  clampComposerPos,
  composerGeomOf,
  isComposerDragSurface,
  loadComposerPos,
  loadComposerUnlocked,
  saveComposerPos,
  saveComposerUnlocked,
  snapComposerPos,
} from '../src/plugins/builtin/paper-shell/composer-float';

const VP = { w: 1200, h: 800 };
const BOX = { w: 880, h: 110 };

describe('创作坞浮动化 · 几何（夹紧）', () => {
  it('坞整体留在视口内：左/右/下留屏缘，上不越书眉（并给拖动锁小钮留位）', () => {
    const far = clampComposerPos({ left: -500, bottom: -500 }, VP, BOX);
    expect(far).toEqual({ left: COMPOSER_EDGE, bottom: COMPOSER_EDGE });

    const beyond = clampComposerPos({ left: 9999, bottom: 9999 }, VP, BOX);
    expect(beyond.left).toBe(VP.w - BOX.w - COMPOSER_EDGE);
    // 上界 = 视口高 − 书眉高 − 锁钮占位 − 坞高 − 屏缘（坞顶落在「书眉下缘 + 锁钮 + 屏缘」）
    expect(beyond.bottom).toBe(VP.h - COMPOSER_BAR_H - COMPOSER_PILL_H - BOX.h - COMPOSER_EDGE);
    expect(VP.h - beyond.bottom - BOX.h).toBe(COMPOSER_BAR_H + COMPOSER_PILL_H + COMPOSER_EDGE);
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

describe('创作坞浮动化 · 坞几何下发（两种口径由消费面各自派生）', () => {
  it('无覆盖（默认位）：bottom = 出厂抬高——让位带 = 抬高 + 坞高（与浮动化前同值）', () => {
    expect(composerGeomOf(null, 110)).toEqual({ bottom: COMPOSER_RISE, height: 110 });
  });

  it('浮动态：bottom = 坞的实际位置（让位带 = bottom + 坞高，坞越往上越大）', () => {
    expect(composerGeomOf({ left: 40, bottom: 300 }, 110)).toEqual({ bottom: 300, height: 110 });
    expect(composerGeomOf({ left: 40, bottom: 96 }, 110).bottom).toBe(96);
  });

  it('坞高变了 height 跟着变（思考展开/附件/墨量册——同一条式子）', () => {
    expect(composerGeomOf(null, 300).height).toBe(300);
  });
});

describe('创作坞浮动化 · 拖动面命中判据（默认锁定）', () => {
  function markup(html: string): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'pp-composer-slot';
    slot.innerHTML = `<div class="pp-composer">${html}</div>`;
    return slot;
  }
  const body = markup(
    '<div class="pp-composer-header"><span class="pp-composer-target">卷一</span>' +
      '<button type="button" class="pp-tool-btn">翰</button></div>' +
      '<div class="pp-composer-row"><textarea></textarea></div>' +
      '<div class="pp-composer-settings"><div class="pp-comp-sel">组合</div></div>',
  );

  it('**锁定态（默认）：一律不是拖动面**——坞是普通 DOM，划词/点选照旧（用户报的冲突即由此根治）', () => {
    for (const sel of ['.pp-composer-target', '.pp-composer-header', '.pp-composer', '.pp-composer-settings']) {
      expect(isComposerDragSurface(body.querySelector(sel), false)).toBe(false);
    }
  });

  it('解锁态：整坞皆是拖动面（书眉行 / 输入行空白 / 设置行空白都算）', () => {
    expect(isComposerDragSurface(body.querySelector('.pp-composer-target'), true)).toBe(true);
    expect(isComposerDragSurface(body.querySelector('.pp-composer-header'), true)).toBe(true);
    expect(isComposerDragSurface(body.querySelector('.pp-composer'), true)).toBe(true);
    expect(isComposerDragSurface(body.querySelector('.pp-composer-settings'), true)).toBe(true);
  });

  it('解锁态：交互件仍不承载拖坞手势（翰钮/输入框/组合控件自己接手势）', () => {
    expect(isComposerDragSurface(body.querySelector('.pp-tool-btn'), true)).toBe(false);
    expect(isComposerDragSurface(body.querySelector('textarea'), true)).toBe(false);
    /* 坞内**纯包裹层**（组合芯片外框这类无 role 的 div）仍算坞体 ⇒ 拖动面：
     * 真坞里可点的是它里面的 button（已被 blockers 拦下），外框留白拖坞无妨。 */
    expect(isComposerDragSurface(body.querySelector('.pp-comp-sel'), true)).toBe(true);
    expect(isComposerDragSurface(null, true)).toBe(false);
  });

  it('解锁态：坞之外（槽里的签条架/锁钮等）不是拖动面', () => {
    const outside = document.createElement('button');
    outside.className = 'pp-composer-lock';
    body.appendChild(outside);
    expect(isComposerDragSurface(outside, true)).toBe(false);
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

describe('创作坞浮动化 · 拖动锁记忆（默认锁定）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('默认锁定（键缺席 = false）——用户方案：「点击解锁之后坞才对鼠标有响应」', () => {
    expect(loadComposerUnlocked()).toBe(false);
  });

  it('解锁 → 落盘 → 读回 true；再锁 → 键移除', () => {
    saveComposerUnlocked(true);
    expect(localStorage.getItem(COMPOSER_UNLOCK_KEY)).toBe('1');
    expect(loadComposerUnlocked()).toBe(true);
    saveComposerUnlocked(false);
    expect(localStorage.getItem(COMPOSER_UNLOCK_KEY)).toBeNull();
    expect(loadComposerUnlocked()).toBe(false);
  });

  it('毒化值一律当锁定（读侧容忍，不炸）', () => {
    localStorage.setItem(COMPOSER_UNLOCK_KEY, 'yes');
    expect(loadComposerUnlocked()).toBe(false);
  });
});

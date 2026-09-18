// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷名派生面（`src/state/volume-name.ts`）纯函数钉值——判据/兜底/派生各只有一处实现，
// 三处收口前的漂移形态（序数 vs 档号、严判据 vs 松判据）在这里钉死。

import { describe, expect, it } from 'vitest';
import {
  deriveVolumeLabel,
  isUnnamedVolumeLabel,
  VOLUME_LABEL_MAX_CHARS,
  volumeDisplayName,
} from '../src/state/volume-name';

describe('volumeDisplayName：有名直采，无名按档号兜底', () => {
  it('有名卷直采（含以「案卷 」开头的手起名）', () => {
    expect(volumeDisplayName('重构命名', 12)).toBe('重构命名');
    expect(volumeDisplayName('案卷 归档 2026', 12)).toBe('案卷 归档 2026');
    expect(volumeDisplayName('案卷 3 收口', 12)).toBe('案卷 3 收口');
  });

  it('未命名（空/空白/undefined）→ 「案卷 N」档号', () => {
    expect(volumeDisplayName('', 12)).toBe('案卷 12');
    expect(volumeDisplayName(undefined, 4)).toBe('案卷 4');
    expect(volumeDisplayName(null, 4)).toBe('案卷 4');
    expect(volumeDisplayName('   ', 4)).toBe('案卷 4');
  });

  it('旧存档的遗留默认名（案卷 N / 会话 N）不冒充名字——显示按**档号**，不按那个序数', () => {
    expect(volumeDisplayName('案卷 3', 12)).toBe('案卷 12');
    expect(volumeDisplayName('会话 3', 12)).toBe('案卷 12');
    expect(volumeDisplayName('已恢复的案卷', 12)).toBe('案卷 12');
  });
});

describe('isUnnamedVolumeLabel：一把尺子判「未命名」', () => {
  it('空/纯空白 = 未命名（新形态：起卷写空）', () => {
    expect(isUnnamedVolumeLabel('')).toBe(true);
    expect(isUnnamedVolumeLabel('   ')).toBe(true);
    expect(isUnnamedVolumeLabel(undefined)).toBe(true);
  });

  it('旧存档的默认名（会话 N / 案卷 N）算未命名——旧数据收敛到同一模型', () => {
    expect(isUnnamedVolumeLabel('案卷 1')).toBe(true);
    expect(isUnnamedVolumeLabel('案卷 12')).toBe(true);
    expect(isUnnamedVolumeLabel('会话 3')).toBe(true);
    expect(isUnnamedVolumeLabel('案卷')).toBe(true);
  });

  it('恢复路径写过的占位名算未命名', () => {
    expect(isUnnamedVolumeLabel('已恢复的会话')).toBe(true);
    expect(isUnnamedVolumeLabel('已恢复的案卷')).toBe(true);
  });

  it('用户起的名（哪怕以「案卷 」开头）不算未命名——旧读盘判据在此打回过', () => {
    expect(isUnnamedVolumeLabel('案卷 归档 2026')).toBe(false);
    expect(isUnnamedVolumeLabel('案卷A')).toBe(false);
    expect(isUnnamedVolumeLabel('重构命名')).toBe(false);
    expect(isUnnamedVolumeLabel('案卷 3 收口')).toBe(false);
  });
});

describe('deriveVolumeLabel：首条来文 → 卷名（28 字 + 省略号）', () => {
  it('短来文直采；首尾空白被规整', () => {
    expect(deriveVolumeLabel('把卷名收口')).toBe('把卷名收口');
    expect(deriveVolumeLabel('  把卷名收口  ')).toBe('把卷名收口');
  });

  it('恰 28 字不加省略号；超一字即截断加「…」', () => {
    const exact = '甲'.repeat(VOLUME_LABEL_MAX_CHARS);
    expect(deriveVolumeLabel(exact)).toBe(exact);
    expect(deriveVolumeLabel(`${exact}乙`)).toBe(`${exact}…`);
  });

  it('全空白来文 = 空名（不编造名字，交由显示兜底）', () => {
    expect(deriveVolumeLabel('   ')).toBe('');
  });
});

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

// 2026-10-31 卷名自动命名 A 批：派生先清洗再截断（docs/plans/volume-naming-plan.md）。
// 收口前 = `trim().slice(0, 28)`：换行原样进卷名（卷首题字按 pre-wrap 实测行数），
// `slice` 按 UTF-16 单元（第 28 位碰上 emoji 劈开代理对）。
describe('deriveVolumeLabel：清洗（A 批）', () => {
  it('多行来文折叠成一行', () => {
    expect(deriveVolumeLabel('第一行\n第二行\t第三行')).toBe('第一行 第二行 第三行');
  });

  it('剥行首排版壳：代码围栏 / 标题 / 引用 / 列表（叠用一并剥）', () => {
    expect(deriveVolumeLabel('```ts\nconst a = 1')).toBe('const a = 1');
    expect(deriveVolumeLabel('### 标题')).toBe('标题');
    expect(deriveVolumeLabel('> 引用一句')).toBe('引用一句');
    expect(deriveVolumeLabel('- 列表项')).toBe('列表项');
    expect(deriveVolumeLabel('1. 有序项')).toBe('有序项');
    expect(deriveVolumeLabel('# - 叠用壳')).toBe('叠用壳');
  });

  it('控制符换成空格、不可见方向符直接去掉', () => {
    expect(deriveVolumeLabel('a\u0000b')).toBe('a b');
    expect(deriveVolumeLabel('\u202Egnp.exe')).toBe('gnp.exe');
  });

  it('截断按 code point：第 28 位是 emoji 时不劈开代理对', () => {
    const label = deriveVolumeLabel(`${'甲'.repeat(27)}😀😀`);
    expect(label).toBe(`${'甲'.repeat(27)}😀…`);
    // 落单的高代理项 = 半个字符（旧实现必现）；
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label)).toBe(false);
  });
});

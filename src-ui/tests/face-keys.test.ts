// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// face-keys 提取器专项（保险丝 a，2026-09-03 生产事故立法）：
// 产物 entry.js → 实际引用的宿主面键集（构建期写 face.json 的真源函数）。
// 提取锚定 `.mods.faceDeps` 声明反查变量名（esbuild 可能重命名 impl），
// 引用形态与 paper-shell 产物实况逐字对拍。

import { describe, expect, it } from 'vitest';
import { extractFaceKeys } from '../../scripts/lib/face-keys.mjs';

describe('extractFaceKeys：产物宿主面键集提取', () => {
  it('标准形态：锚定 mods.faceDeps 声明，收集全部属性访问（去重排序）', () => {
    const src = `
      var host = requireHost();
      var impl = host.mods.faceDeps;
      var groupWorkUnits = impl.groupWorkUnits;
      var leadOf = impl.leadOf;
      var layoutRegion = impl.layoutRegion;
      var again = impl.groupWorkUnits;
      function use() { return impl.ANCHOR; }
    `;
    expect(extractFaceKeys(src)).toEqual(['ANCHOR', 'groupWorkUnits', 'layoutRegion', 'leadOf']);
  });

  it('esbuild 重命名变量（impl → _impl2）→ 仍锚定提取', () => {
    const src = `
      var h = requireHost();
      var _impl2 = h.mods.faceDeps;
      var a = _impl2.foldLabel;
      var b = _impl2.isFoldable;
    `;
    expect(extractFaceKeys(src)).toEqual(['foldLabel', 'isFoldable']);
  });

  it('无 faceDeps 面（renderers 走 renderer-host）→ 空数组（零需求，不写 face.json）', () => {
    const src = `
      var react = host.react;
      var hooks = host.hooks;
      var createElement = host.createElement;
    `;
    expect(extractFaceKeys(src)).toEqual([]);
  });

  it('同名字符串出现但不属于该变量 → 不误收', () => {
    const src = `
      var impl = host.mods.faceDeps;
      var a = impl.layoutRegion;
      var unrelated = other.layoutRegion;
      var also = 'impl.layoutRegion';
    `;
    expect(extractFaceKeys(src)).toEqual(['layoutRegion']);
  });
});

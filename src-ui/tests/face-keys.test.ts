// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// face-keys 提取器专项（保险丝 a，2026-09-03 生产事故立法）：
// 产物 entry.js → 实际引用的宿主面键集（构建期写 face.json 的真源函数）。
// 提取锚定 `.mods.faceDeps` 声明反查变量名（esbuild 可能重命名 impl），
// 引用形态与 paper-shell 产物实况逐字对拍。
//
// 第二段（磁盘产物覆盖面，2026-09-24 批 4c-3 补）：**提取器提不到 = 保险丝静默失效**。
// 实测病灶：22/30 个产物的 host.aliased.ts 写成单行 `const impl = requireHost().mods.faceDeps;`
// ——esbuild 内联后仍是 `requireHost().mods.faceDeps`，与本文件的锚点形态（`<标识符>.mods.faceDeps`）
// 不符 ⇒ 提取结果空 ⇒ 不写 face.json ⇒ 装载器按「零需求」放行，宿主面偏斜（exe↔产物版本不一致）
// 重新变回静默。修法 = 该行拆两步（`const host = requireHost(); const impl = host.mods.faceDeps;`）。
// 本段把「引用 faceDeps 的产物必须有 face.json，且 hostApi 指纹 = 当前宿主面基线」钉死。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFaceKeys } from '../../scripts/lib/face-keys.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_PLUGINS = join(HERE, '..', 'dist-plugins', 'builtin', 'hologram');
const HOST_BASELINE = join(HERE, '..', 'src', 'plugins', 'host-surface.baseline.json');

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

// ── 磁盘产物覆盖面（dist-plugins 在场才跑，仿 face-deps-seal 第二段范式）──
const distDirs = existsSync(DIST_PLUGINS)
  ? readdirSync(DIST_PLUGINS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];
const d = distDirs.length > 0 ? describe : describe.skip;

d('磁盘产物：引用 faceDeps ⇒ 必有 face.json（保险丝 a 不许静默失效）', () => {
  it('每个引用宿主面的产物都写了自己的 face.json，且 hostApi 指纹 = 当前宿主面基线', () => {
    const baseline = JSON.parse(readFileSync(HOST_BASELINE, 'utf8')) as { fingerprint: string; keys: string[] };
    const missing: string[] = [];
    const stale: string[] = [];
    const empty: string[] = [];
    let covered = 0;
    for (const dir of distDirs) {
      const entryPath = join(DIST_PLUGINS, dir, 'entry.js');
      if (!existsSync(entryPath)) continue;
      const src = readFileSync(entryPath, 'utf8');
      if (!src.includes('mods.faceDeps')) continue; // 无宿主面（renderers 走 renderer-host）= 零需求
      const facePath = join(DIST_PLUGINS, dir, 'face.json');
      if (!existsSync(facePath)) {
        missing.push(`${dir}（提取器提不到宿主面键——host.aliased.ts 是否被写成单行 requireHost()… 形态？）`);
        continue;
      }
      covered++;
      const face = JSON.parse(readFileSync(facePath, 'utf8')) as { faceDeps?: string[]; hostApi?: string };
      if (!face.faceDeps?.length) empty.push(dir);
      if (face.hostApi !== baseline.fingerprint) {
        stale.push(`${dir}: 产物 ${face.hostApi ?? '(缺)'} ≠ 宿主面基线 ${baseline.fingerprint}`);
      }
    }
    expect(
      missing,
      `这些产物引用了宿主面却没写 face.json（保险丝 a 失效 = 偏斜产物能装进旧 exe）：\n${missing.join('\n')}`,
    ).toEqual([]);
    expect(empty, `face.json 的 faceDeps 为空（等于零需求，保险丝形同虚设）：\n${empty.join('\n')}`).toEqual([]);
    expect(
      stale,
      `face.json 的 hostApi 指纹与当前宿主面基线不一致（跑 npm run gen:host-surface + 重建产物）：\n${stale.join('\n')}`,
    ).toEqual([]);
    // 自检：覆盖面不许空转（当前 27 个产物有 face.json；低于 20 = 提取器整体失灵）
    expect(covered, '覆盖面自检：有 face.json 的产物数').toBeGreaterThanOrEqual(20);
    expect(baseline.keys.length).toBeGreaterThan(200);
  });
});

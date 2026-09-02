// SPDX-License-Identifier: MIT

// 插件宿主桥完整性门禁（2026-09-02 划词朱线 exe 白屏事故立案）。
//
// 事故：faceDeps（host-modules.ts，bundle 域供给面）漏注册 host.aliased.ts
// 已引用的 impl.mergeSelectionLines/selInkPaths/selSeedOf——插件产物在 exe 里
// 一调即 TypeError，React 整树卸载（全 UI 消失）；dev 域与全部测试走 host.ts
// 真身直连，桥完整性零覆盖，全绿照样崩。
//
// 本测试：四面 host.aliased 引用的每个 impl.X 必须已注册进 faceDeps。
// aliased 文件被 tsc 排除 + faceDeps 是 Record<string, unknown>——本文件是
// 两域之间唯一的完整性门禁，加 host.ts 出口必须同步 faceDeps。
//
// 实现取文本对拍而非 import：host-modules 依赖链在 node 环境摸 window
// （ReferenceError: window is not defined），jsdom 环境又读不了 node:fs——
// 源码字面量是唯一两域通吃的位（biome 强制格式，键位形态稳定）。
//
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const FACES = ['canvas-nav', 'paper-shell', 'settings-domain', 'compose-dock'];

/** host-modules.ts → faceDeps 对象字面量的 key 集合（`const faceDeps = {` 起至闭）。 */
function faceDepsKeys(): Set<string> {
  const src = readFileSync(join(SRC, 'plugins', 'builtin', 'host-modules.ts'), 'utf8');
  const start = src.indexOf('const faceDeps = {');
  if (start === -1) throw new Error('host-modules.ts 找不到 faceDeps 字面量（结构变了？）');
  // S3 后 faceDeps 尾行是 `} satisfies FaceBridgeSeal;`（S2 前的 toolDomains
  // `\n};` 闭合已拆除）——两种闭合形态都兼容。
  let end = src.indexOf('\n} satisfies', start);
  if (end === -1) end = src.indexOf('\n};', start);
  if (end === -1) throw new Error('faceDeps 字面量未闭合');
  const body = src.slice(start, end);
  return new Set([...body.matchAll(/^\s{2}(\w+),$/gm)].map((m) => m[1]));
}

/** face.aliased.ts → impl.X 引用集合（`const impl =` 声明行不匹配——无点访问）。 */
function implRefs(face: string): Set<string> {
  const src = readFileSync(join(SRC, 'plugins', 'builtin', face, 'host.aliased.ts'), 'utf8');
  return new Set([...src.matchAll(/\bimpl\.(\w+)/g)].map((m) => m[1]));
}

describe('插件宿主桥完整性：faceDeps ⊇ 四面 host.aliased 全部 impl 引用', () => {
  it('每个 impl.X 引用都已注册进 faceDeps（缺一个 = exe 运行时 TypeError）', () => {
    const registry = faceDepsKeys();
    const missing: string[] = [];
    for (const face of FACES) {
      for (const ref of implRefs(face)) {
        if (!registry.has(ref)) missing.push(`${face}: impl.${ref}`);
      }
    }
    expect(missing, 'faceDeps 缺注册——插件产物域运行时将 TypeError（划词朱线事故同型）').toEqual([]);
  });

  it('抽查：划词朱线三函数在册（8786c05e 事故回归钉）', () => {
    const registry = faceDepsKeys();
    for (const key of ['mergeSelectionLines', 'selInkPaths', 'selSeedOf']) {
      expect(registry.has(key), `faceDeps.${key} 未注册`).toBe(true);
    }
  });
});

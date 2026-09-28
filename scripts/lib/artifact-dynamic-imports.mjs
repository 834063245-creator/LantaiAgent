// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// artifact-dynamic-imports — 产物源码里的**相对动态 import** 提取
// （2026-09-28 真机事故立法：Key 保存了却「不生效」）。
//
// 病灶（真机形态）：`settings-domain/provider-data.ts` 用
// `await import('../../../provider/credentials')` 取凭据缓存失效口（当时为破环），
// 而产物构建的宿主桥重定向**只认静态 `./host`**（build-builtin-plugins.mjs 的
// onResolve filter）——相对动态 import 落回普通解析 ⇒ esbuild 把内核模块**整份
// 内联成产物私有副本**（自带模块级状态 `_keyCache`）⇒ 写穿失效打在副本上，内核
// 那份（`provider/live.ts` 每请求现读的）纹丝不动：保存 Key 后该提供方仍恒报
// 「未配置 API Key」，**直到重启进程**。同族的还有
// `await import('../../../rpc-contract')`（副本没有内核的 rpc 插桩——收到的
// ui.log 因此答不出「Key 到底写没写」，见 docs/plans/log-observability-plan.md）。
//
// 判据：**值位置的相对动态 import** 一律不许出现在产物源码里——正确姿势永远是静态
// `import … from './host'`（宿主桥出口；缺出口时按纪律补 host.ts + host.aliased.ts +
// host-modules.ts faceDeps 三处）。
//
// 刻意收窄（宁漏勿误，本模块是构建门禁不是安全边界）——只认 `await/return/void import('相对路径')`
// 这一族**真值位置**形态（本仓库两次病灶都是 `await import(...)`）：
//   ① 类型位置全部豁免：`typeof import('./host')` 与类型查询 `export type X = import('./host').X`
//      （host.aliased 的既定对拍形态，编译期擦除）；
//   ② 注释豁免（本仓库注释里大量引用 `import('./host')` 作说明）；
//   ③ 裸动态 import（`import('pkg')`）由构建脚本的产物级检查兜（dynamicBare）；
//   ④ 未 await 的 `const p = import('./x')` 这一形态本模块抓不到——由构建脚本的
//      **模块图级**检查兜（产物 inputs 不得出现插件目录外的项目内源码）。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 去注释（块注释按字符换成空白，**保留换行**——行号必须与原文件对齐；
 *  行注释整段抹掉）。字符串里的 `//`（URL）可能被误切：那只会让本判据漏报，
 *  不会误报——漏报由「构建脚本产物级检查 + 人」兜底。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const DYNAMIC_RELATIVE = /(?:await|return|void)\s+import\s*\(\s*(['"])(\.\.?\/[^'"]*)\1\s*\)/g;

/**
 * 从一段源码里找出值位置的相对动态 import（`await/return/void import('相对路径')`）。
 * @param {string} srcText 源码全文
 * @returns {Array<{ line: number, spec: string }>} 命中（行号 1 起）
 */
export function findRelativeDynamicImports(srcText) {
  const code = stripComments(srcText);
  const out = [];
  for (const m of code.matchAll(DYNAMIC_RELATIVE)) {
    const idx = m.index ?? 0;
    out.push({ line: code.slice(0, idx).split('\n').length, spec: m[2] });
  }
  return out;
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** 递归扫描一个产物源码目录（插件包自包含面）。
 * @param {string} srcDir 插件源码目录绝对路径
 * @returns {Array<{ file: string, line: number, spec: string }>} 命中（含文件路径）
 */
export function scanArtifactSources(srcDir) {
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!SOURCE_EXT.test(e.name)) continue;
      for (const hit of findRelativeDynamicImports(readFileSync(p, 'utf8'))) {
        hits.push({ file: p, line: hit.line, spec: hit.spec });
      }
    }
  };
  walk(srcDir);
  return hits;
}

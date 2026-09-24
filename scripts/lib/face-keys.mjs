// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// face-keys — 产物宿主面键集提取（保险丝 a，2026-09-03 生产事故立法）。
//
// 起因：新树构建的产物丢进旧 exe → 产物引用的 faceDeps 键在旧宿主缺席 →
// impl.X === undefined → 渲染期 TypeError → React 整树卸载（装载期隔离
// 够不着渲染期）。立法：构建时把产物实际引用的宿主面键写进 face.json，
// 装载器 import 前对拍运行时 faceDeps——缺键拒载，bundle 兜底行不位移。
//
// 提取原理：host.aliased.ts 的 `const impl = host.mods.faceDeps` 经 esbuild
// 内联后产物里必有 `var <名> = <宿主桥>.mods.faceDeps` 声明；该变量的
// 全部 `<名>.X` 属性访问即产物实际依赖的宿主面键集（精确到用没用，
// 不是 host.ts 全导出清单——没用到新键的产物在旧宿主上照常装载）。
// 变量名可能被 esbuild 重命名，故锚定 `.mods.faceDeps` 字面量反查声明名。

/**
 * 从产物 entry.js 源码提取宿主面键集。
 * 无 faceDeps 面（如 renderers 走 renderer-host）返回空数组——零需求。
 *
 * 批 8c（2026-09-25）修一处**误收**：esbuild 会在产物里插模块路径注释
 * （`// src-ui/node_modules/echarts/lib/core/impl.js`），与声明名同名的路径会被属性访问
 * 正则命中（实测：renderers 产物把 `js` 误收成宿主面键 ⇒ face.json 要求一个运行时
 * 不存在的键 ⇒ 装载器按缺键拒载整面）。修法 = 扫描前剔除**路径注释行**；
 * 不做通用注释剥离（字符串里的 `//`（URL）会被误切，得不偿失）。
 * @param {string} entrySrc 产物 entry.js 全文
 * @returns {string[]} 排序去重后的键名
 */
export function extractFaceKeys(entrySrc) {
  const stripped = entrySrc
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') && /\.(js|mjs|cjs|ts|tsx|jsx|css)\b/.test(t));
    })
    .join('\n');
  const decl = /var\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.mods\.faceDeps/.exec(stripped);
  if (!decl) return [];
  const implName = decl[1];
  const use = new RegExp('\\b' + implName + '\\.([A-Za-z_$][\\w$]*)', 'g');
  const keys = new Set();
  for (const m of stripped.matchAll(use)) keys.add(m[1]);
  return [...keys].sort();
}

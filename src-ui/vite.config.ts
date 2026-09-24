// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// ponytail: Vite html-inline-proxy does case-sensitive file.replace(root, …) on
// Windows — when Tauri spawns the build with lower-case cwd, the proxy lookup
// misses. Use .native (GetFinalPathNameByHandleW) which returns canonical case.
//
// ── 产物源码不进壳 bundle（插件化欠账账本 §0.1 构建侧，批 0a）──
// 生产形态：`BUILTIN_PLUGINS` 只装 13 内核装配台，30 个出厂产物从**磁盘产物
// 通道**（`loadExternalPlugins` → `dist-plugins/builtin/hologram/<dir>/entry.js`）
// 装载——产物源码与产物清单（`plugins/factory-products.ts`）都不该进壳 bundle。
// 实测（2026-09-24）生产 bundle 里能 grep 到产物独有串（`hologram/settings-domain`
// · `pp-minimap` · `sr-rack` …）与 `factory-products.ts` 的函数体，即两份死副本
// 随 exe 发货（账本 §0.1：exe 体积虚胖 + 与 docs/plugins/README.md「exe 只留 13
// 内核装配台」矛盾）。
//
// ⚠ 为什么不是「配置 DCE」（两条路都实测无效，别再试）：
//   ① `build.rollupOptions.treeshake.moduleSideEffects` 谓词：Vite 的内置 resolve
//      插件对**每个**相对 import 都回 `moduleSideEffects: <最近 package.json 的
//      sideEffects 字段>`（壳包未声明 ⇒ 恒 true），插件回值优先于该选项 ⇒ 谓词被
//      逐模块覆盖（取证：谓词换成 `() => false` 重建，产物连尺寸都一样）。
//   ② `load` 钩子逐模块回 `moduleSideEffects: false`（钩子优先级更高，实测命中
//      125 个模块，含 factory-products.ts）：**依然无效**——因为
//      `loadExternalPlugins` 里 `const factoryNames = devSourceDomain ?
//      factoryProductNames() : null` 这句**没被折死**（`devSourceDomain` 的初始化
//      依赖 `(import.meta.env as Record<string, unknown>).VITE_FORCE_PRODUCT_CHANNEL`
//      这类动态形态，rollup 不把它当字面量常量）⇒ `factoryProductNames` 是**活引用**
//      ⇒ 模块被保留，`moduleSideEffects` 只对「无人引用的模块」生效，轮不到它。
//      结论写在账本 §0.1：**病灶是「活引用」，不是「副作用标记」**。
//
// 正解 = 构建期把 `./factory-products` 换成空壳（本插件）：生产端那个模块图
// **根本不进 rollup 的解析面**，无需赌任何 DCE 折叠。dev/vitest 不受影响（
// `apply: 'build'`），源码域热重载照旧。
// 守卫：tests/product-source-not-in-bundle.test.ts（dist 在场即断言产物源码串不在
// 产物体内 + 首帧 CSS 面选择器仍在）。
const FACTORY_PRODUCTS_STUB = '\0lantai:factory-products-stub';

/** 生产端置换 `plugins/factory-products`（30 个产物源码清单）为语义等价的空壳。
 *  - `factoryProductPlugins()` → `[]`：生产走磁盘产物通道，源码域展开不存在
 *    （与 `import.meta.env.DEV` 死分支同义）；
 *  - `factoryProductNames()` → 名册派生全集：与真实现**逐名等价**（名册是单一真源，
 *    `tests/builtin-roster.test.ts` 已断言「`factoryProductPlugins()` 序 == buildOrder」），
 *    故即便某条 dev 判据在生产端意外为真，过滤语义也不漂移。 */
function stubFactoryProductsInBuild(): Plugin {
  // 虚拟 id 没有物理位置 ⇒ 它自己的相对 import 由本插件代解析（指回真源文件，
  // 名册仍是单一真源，不在配置里重抄一遍产品名）。
  const rosterPath = fileURLToPath(new URL('./src/plugins/builtin-roster.ts', import.meta.url));
  return {
    name: 'lantai:factory-products-stub',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === FACTORY_PRODUCTS_STUB) return source === './builtin-roster' ? rosterPath : null;
      // 只拦装载链那一处静态 import（别的消费者真出现时，本插件不该替它做决定）
      if (source !== './factory-products') return null;
      if (!importer || !/[\\/]plugins[\\/]loader\.ts$/.test(importer)) return null;
      return FACTORY_PRODUCTS_STUB;
    },
    load(id) {
      if (id !== FACTORY_PRODUCTS_STUB) return null;
      return [
        "import { BUILTIN_ROSTER, builtinScopeName } from './builtin-roster';",
        'export function factoryProductPlugins() { return []; }',
        'export function factoryProductNames() {',
        '  return new Set(BUILTIN_ROSTER.map((e) => builtinScopeName(e.dir)));',
        '}',
        '',
      ].join('\n');
    },
  };
}

export default defineConfig({
  root: realpathSync.native(process.cwd()),
  base: './',
  // 产物域标记的两个域（landmine H2）：产物（esbuild）侧 define 成 "1"，
  // 应用 bundle（本处）侧显式 undefined ⇒ face-css.ts 的守卫在 bundle 域
  // 安全早退（不产生死 link）。⚠ 键必须是**裸标识符**（esbuild define 按
  // 表达式字面形态匹配）；产物侧同名裸键在 scripts/build-builtin-plugins.mjs，
  // 两处形态由 tests/plugin-css-channel 钉住。
  define: { __LANTAI_FACE_ARTIFACT__: 'undefined' },
  plugins: [stubFactoryProductsInBuild()],
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
          three: ['three'],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  optimizeDeps: {
    exclude: ['@tauri-apps/api'],
  },
});

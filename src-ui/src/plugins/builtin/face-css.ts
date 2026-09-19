// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 UI 插件产物 CSS 注入（增补四，first-party-hot-reload-plan）。
//
// 面组件源码 import 的 CSS 在两个运行时域各得其所：
//   - bundle 域：vite 把 `import './X.css'` 打进应用 CSS（首帧即有，兜底行用）；
//   - 产物域：esbuild 抽取为 entry.css（与 entry.js 同目录、随包携带），
//     apply 时经宿主桥 loadCss 注入（装载器负责版本号与摘除，见 loader.ts）。
//
// 域判定走 esbuild define —— ⚠ **必须写成裸标识符**（`__LANTAI_FACE_ARTIFACT__`）：
// esbuild 的 define 按**表达式字面形态**匹配，写成局部别名（`const flags =
// globalThis; flags.X`）或别的成员表达式一律命不中，那句判定就恒早退 ——
// **产物 CSS 一辈子不会被注入**（2026-09-19 前的实况，landmine H2：实机
// `link[id^="lantai-plugin-css"]` 计数 0、插件 CSS 只经 vite 进壳 bundle ⇒
// 任何 CSS 改动都得重建 exe）。现约定三处同源、由 tests/plugin-css-channel
// 钉住：① 本文件用裸标识符 + `typeof` 守卫；② 构建脚本 define 同名裸键；
// ③ 构建脚本另有**产物自检**（产物里若仍残留该标识符 = define 没命中 ⇒
// 构建直接失败，不静默交付一份 CSS 永不生效的产物）。
// bundle 域该标识符不存在（vite define 显式置 undefined）⇒ 守卫安全早退，
// 不产生死 link。
declare const __LANTAI_FACE_ARTIFACT__: string | undefined;

/** 产物域注入本插件 entry.css（bundle 域 no-op）。 */
export function injectFaceArtifactCss(): void {
  if (typeof __LANTAI_FACE_ARTIFACT__ === 'undefined' || __LANTAI_FACE_ARTIFACT__ !== '1') return;
  const host = (
    globalThis as unknown as {
      __lantai_plugin_host__?: { loadCss?: (url: string) => void };
    }
  ).__lantai_plugin_host__;
  if (!host?.loadCss) return;
  host.loadCss(new URL('./entry.css', import.meta.url).href);
}

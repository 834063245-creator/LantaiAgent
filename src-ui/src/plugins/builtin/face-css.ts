// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 UI 插件产物 CSS 注入（增补四，first-party-hot-reload-plan）。
//
// 面组件源码 import 的 CSS 在两个运行时域各得其所：
//   - bundle 域：vite 把 `import './X.css'` 打进应用 CSS（首帧即有）；
//   - 产物域：esbuild 抽取为 entry.css（与 entry.js 同目录、随包携带），
//     apply 时经宿主桥 loadCss 注入（幂等 link，URL 去重）。
//
// 域判定走 esbuild define：产物域注入 __LANTAI_FACE_ARTIFACT__="1"，
// bundle 域该属性不存在 → no-op（不产生死 link）。本文件被 esbuild 内联
// 进各面产物（无裸 import）。

/** 产物域注入本插件 entry.css（bundle 域 no-op）。 */
export function injectFaceArtifactCss(): void {
  const flags = globalThis as unknown as Record<string, string | undefined>;
  if (flags.__LANTAI_FACE_ARTIFACT__ !== '1') return;
  const host = (
    globalThis as unknown as {
      __lantai_plugin_host__?: { loadCss?: (url: string) => void };
    }
  ).__lantai_plugin_host__;
  if (!host?.loadCss) return;
  host.loadCss(new URL('./entry.css', import.meta.url).href);
}

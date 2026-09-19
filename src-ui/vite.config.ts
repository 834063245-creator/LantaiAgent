// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import { realpathSync } from 'node:fs';
import { defineConfig } from 'vite';

// ponytail: Vite html-inline-proxy does case-sensitive file.replace(root, …) on
// Windows — when Tauri spawns the build with lower-case cwd, the proxy lookup
// misses. Use .native (GetFinalPathNameByHandleW) which returns canonical case.
export default defineConfig({
  root: realpathSync.native(process.cwd()),
  base: './',
  // 产物域标记的两个域（landmine H2）：产物（esbuild）侧 define 成 "1"，
  // 应用 bundle（本处）侧显式 undefined ⇒ face-css.ts 的守卫在 bundle 域
  // 安全早退（不产生死 link）。⚠ 键必须是**裸标识符**（esbuild define 按
  // 表达式字面形态匹配）；产物侧同名裸键在 scripts/build-builtin-plugins.mjs，
  // 两处形态由 tests/plugin-css-channel 钉住。
  define: { __LANTAI_FACE_ARTIFACT__: 'undefined' },
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

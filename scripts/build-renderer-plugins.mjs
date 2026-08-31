#!/usr/bin/env node
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 内置渲染器插件构建（P1c，first-party-hot-reload-plan）—— esbuild 增量编译
// `src-ui/src/plugins/builtin/renderers/` → 插件产物目录（生产包随包携带）。
//
// 输出：`src-ui/dist-plugins/builtin/renderers/`
//   - manifest.json（从源码目录拷贝）
//   - entry.js（ESM，自包含——react/overlay/rpc 从宿主桥取）
//
// 编译关键参数（对齐插件自包含契约）：
//   - --jsx=automatic + --jsx-import-source=./renderer-host：JSX 编译为
//     `import { jsx, jsxs, Fragment } from './renderer-host'`；
//   - onResolve 钩子把 `./renderer-host` 重定向到 `./renderer-host.aliased.ts`：
//     构建产物域从宿主桥取 React/hooks/Overlay/rpc（测试/开发域走真
//     renderer-host.ts——esbuild 默认解析到该文件，onsResolve 拦截改名）。
//   - 零外部依赖：除 alias 面外无其它 import（components 内部依赖仅类型）。

import { build } from '../src-ui/node_modules/esbuild/lib/main.js';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const srcDir = join(repoRoot, 'src-ui', 'src', 'plugins', 'builtin', 'renderers');
const outDir = join(repoRoot, 'src-ui', 'dist-plugins', 'builtin', 'renderers');

/** esbuild onResolve 钩子：把 `./renderer-host` 及其 jsx-runtime 子路径
 *  重定向到 aliased 版本（仅对来源在渲染器插件目录内的 import 生效）。
 *  esbuild automatic JSX 会产出 `import … from './renderer-host/jsx-runtime'`
 *  （jsxImportSource 追加 /jsx-runtime）——两种形态都映射到 aliased.ts
 *  （其导出 jsx/jsxs/Fragment 即 jsx-runtime 形状）。 */
const redirectRendererHost = {
  name: 'redirect-renderer-host',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^\.\/renderer-host(?:\/jsx-runtime)?$/ }, (args) => {
      if (args.importer && args.importer.startsWith(srcDir)) {
        return { path: join(srcDir, 'renderer-host.aliased.ts') };
      }
      return undefined;
    });
  },
};

async function main() {
  // 1) 产物目录重建（幂等——每次全量）
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 2) esbuild 编译（verify 产物：自包含 ESM，无裸 import）
  const result = await build({
    entryPoints: [join(srcDir, 'index.tsx')],
    outfile: join(outDir, 'entry.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2021',
    jsx: 'automatic',
    jsxImportSource: './renderer-host',
    plugins: [redirectRendererHost],
    // 产物域行 id 前缀（覆盖 bundle 行的覆盖语义——见 index.tsx ROW_PREFIX）
    define: { 'globalThis.__LANTAI_RENDERER_ROW_PREFIX__': '"plugin/hologram/renderers"' },
    // 产物独立验证明细（供 gate 测断言）
    metafile: true,
    logLevel: 'info',
  });

  // 3) manifest.json 拷贝（manifest 是数据真源，原样带入产物）
  cpSync(join(srcDir, 'manifest.json'), join(outDir, 'manifest.json'));

  // 4) 自包含校验：产物内不得出现裸 import（非相对路径）
  const entrySrc = await import('node:fs/promises').then((fsp) => fsp.readFile(join(outDir, 'entry.js'), 'utf8'));
  const bareImports = [...entrySrc.matchAll(/import\s+[^'"]*?['"](\.[^'"]*|\.\.[^'"]*)['"]/g)].length === 0;
  const dynamicBare = /import\s*\(\s*['"][a-z][^'"]*['"]\s*\)/.test(entrySrc);
  if (dynamicBare) {
    console.error('[build-renderer-plugins] 产物含动态裸 import（插件自包含契约被破）');
    process.exit(1);
  }
  console.log('[build-renderer-plugins] 产物自包含校验通过（无裸 import）');
  console.log(`[build-renderer-plugins] 输出: ${outDir}（${result.metafile ? 'metafile 含 ' + Object.keys(result.metafile.inputs).length + ' 输入' : ''}）`);
}

main().catch((err) => {
  console.error('[build-renderer-plugins] 构建失败:', err);
  process.exit(1);
});
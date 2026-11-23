#!/usr/bin/env node

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// 生成 `app/vendor/lantai-editor.js`（单文件 ESM，随插件提交）。
//
// 用法：
//   cd examples/plugins/md-editor/build
//   npm install
//   npm run build            # 压缩产物
//   npm run build -- --dev   # 不压缩（排查用）
//
// 纪律：产物必须自包含（零裸 import）。窗内没有包管理器，也不该为了编辑器
// 把整个 node_modules 拷进插件目录。

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, 'vendor-entry.js');
const outfile = resolve(here, '..', 'app', 'vendor', 'lantai-editor.js');
const dev = process.argv.includes('--dev');

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome110'],
  legalComments: 'eof',
  minify: !dev,
  sourcemap: false,
  banner: {
    js: `/* 文卷编辑器依赖（CodeMirror 6 / markdown-it / DOMPurify / highlight.js）
 * 由 build/vendor.mjs 生成——不要手改。重新生成：cd build && npm install && npm run build
 * 许可证文本见同目录 LICENSES.md。 */`,
  },
});

writeFileSync(
  resolve(here, '..', 'app', 'vendor', 'LICENSES.md'),
  [
    '# 文卷编辑器依赖许可证',
    '',
    '本目录的 `lantai-editor.js` 是以下包的打包产物：',
    '',
    '| 包 | 许可证 |',
    '|---|---|',
    '| CodeMirror 6（`codemirror` / `@codemirror/*`） | MIT |',
    '| markdown-it | MIT |',
    '| markdown-it-task-lists | ISC |',
    '| markdown-it-footnote | MIT |',
    '| DOMPurify | Apache-2.0 OR MPL-2.0 |',
    '| highlight.js | BSD-3-Clause |',
    '',
    '各包的完整许可证文本随 npm 包分发；本文件只作清单。',
    '',
  ].join('\n'),
  'utf8',
);

const bytes = readFileSync(outfile).byteLength;
console.log(`[ wenjuan/vendor ] ${outfile} (${(bytes / 1024).toFixed(0)} KB, ${dev ? 'dev' : 'minified'})`);

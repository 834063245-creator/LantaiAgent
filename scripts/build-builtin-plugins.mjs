#!/usr/bin/env node
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 内置插件构建管线（P1c + 增补四施工，first-party-hot-reload-plan）——
// esbuild 增量编译 `src-ui/src/plugins/builtin/<dir>/` → 插件产物目录
// （生产包随包携带，Rust 资产通道回退装载，设置面板可重载）。
//
// 输出：`src-ui/dist-plugins/builtin/hologram/<dir>/`
//   - manifest.json（从源码目录拷贝）
//   - entry.js（ESM，自包含——react/宿主依赖经别名桥取用，零裸 import）
//   - entry.css（面组件 import 的 CSS——esbuild 抽取，apply 经宿主
//     loadCss 注入；无 CSS 的插件不产出）
//
// 产物布局修正（增补四）：输出目录为 scope 布局 `hologram/<dir>`——
// loader 的 `manifest.name !== dirId` 校验与 Rust 资产通道回退白名单
// （plugin_assets.rs is_builtin_plugin_path）都按 scope 路径寻址；
// P1 首版 renderers 输出 `builtin/renderers`（单段目录）实际装不进通道，
// 本版一并修正。
//
// 编译关键参数（对齐插件自包含契约）：
//   - --jsx=automatic + --jsx-import-source=./<hostModule>：JSX 编译为
//     `import { jsx, jsxs, Fragment } from './<hostModule>/jsx-runtime'`；
//   - onResolve 钩子把 './<hostModule>'（含 /jsx-runtime 子路径）重定向到
//     host.aliased.ts：产物域从宿主桥取 React/hooks/依赖真实例
//     （测试/开发域走真 host.ts——esbuild 默认解析到该文件，onResolve 拦截改名）；
//   - alias react → builtin/react-bridge.cjs：产物内全部 react import
//     （面组件源码 + 被内联的 npm 依赖）落到宿主注入的同一份 React；
//   - 零外部依赖产物：除 alias/host 重定向外全部 import 被 bundle 内联。
//
// 插件清单（dir = 源码目录名；out = scope 产物目录名）：
//   - renderers（P1）：行 id 分立双走查（builtin/<kind> + plugin/.../），
//     displace 不声明；ROW_PREFIX 经 define 注入。
//   - UI 四面（增补一）：canvas-nav / paper-shell / settings-domain /
//     compose-dock——面组件 + CSS 产物；manifest 声明 displace（位移
//     bundle 兜底行，见 loader 位移机制）。
//   - 工具域 + 段贡献 18 个（增补二）：薄重导出产物（插件对象真源留
//     bundle 域——mods.toolDomains/segments 经宿主桥取用），manifest
//     声明 displace。

import { build } from '../src-ui/node_modules/esbuild/lib/main.js';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFaceKeys } from './lib/face-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const builtinSrcRoot = join(repoRoot, 'src-ui', 'src', 'plugins', 'builtin');
const outRoot = join(repoRoot, 'src-ui', 'dist-plugins', 'builtin', 'hologram');
const reactBridge = join(builtinSrcRoot, 'react-bridge.cjs');

/** UI 四面（增补一批次；displace 位移式装载） */
const UI_FACES = ['canvas-nav', 'paper-shell', 'settings-domain', 'compose-dock', 'paper-minimap'];
/** 工具域 + 段贡献（增补二批次；薄重导出产物，displace 同款） */
const TOOL_DOMAINS = [
  'web-domain',
  'browser-desktop-domain',
  'engine-domain',
  'git-domain',
  'search-domain',
  'fs-domain',
  'shell-domain',
  'agent-isolation-domain',
  'ask-domain',
  'skill-domain',
  'memory-domain',
  'task-domain',
  'agent-domain',
  'wait-domain',
  'cordis-domain',
  'asset-domain',
];
const SEGMENTS = ['prompt-segments', 'capability-segments'];

/** 七个 seam 供应商（S2 真源产物化，plugin-bundle-retirement-plan）。
 *  S5b：agent-loop-service 产物化（模块级状态拆到 agent-loop-active.ts）。 */
const PROVIDERS = [
  'fs-builtin',
  'shell-builtin',
  'sessions-builtin',
  'graph-builtin',
  'subagent-in-process',
  'llm-adapters',
  'agent-loop-service',
];

/** 插件构建规格表。 */
function pluginSpecs() {
  return [
    // P1 渲染器：行 id 分立双走查（非位移），ROW_PREFIX define 注入
    {
      dir: 'renderers',
      hostModule: 'renderer-host',
      entry: 'index.tsx',
      define: { 'globalThis.__LANTAI_RENDERER_ROW_PREFIX__': '"plugin/hologram/renderers"' },
    },
    ...UI_FACES.map((dir) => ({ dir, hostModule: 'host', entry: 'index.ts', face: true })),
    ...[...TOOL_DOMAINS, ...SEGMENTS].map((dir) => ({ dir, hostModule: 'host', entry: 'index.ts' })),
    ...PROVIDERS.map((dir) => ({ dir, hostModule: 'host', entry: 'index.ts' })),
  ];
}

/** esbuild onResolve 钩子工厂：把 `./<hostModule>` 及其 jsx-runtime 子路径
 *  重定向到 aliased 版本（仅对来源在插件目录内的 import 生效）。
 *  esbuild automatic JSX 会产出 `import … from './<hostModule>/jsx-runtime'`
 *  （jsxImportSource 追加 /jsx-runtime）——两种形态都映射到 aliased 文件。 */
function redirectHostModule(srcDir, hostModule) {
  return {
    name: 'redirect-' + hostModule,
    setup(buildApi) {
      const filter = new RegExp('^\\./' + hostModule + '(?:/jsx-runtime)?$');
      buildApi.onResolve({ filter }, (args) => {
        if (args.importer && args.importer.startsWith(srcDir)) {
          return { path: join(srcDir, hostModule + '.aliased.ts') };
        }
        return undefined;
      });
    },
  };
}

async function buildPlugin(spec) {
  const srcDir = join(builtinSrcRoot, spec.dir);
  const outDir = join(outRoot, spec.dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const define = { ...(spec.define ?? {}) };
  if (spec.face) {
    // 产物域标记：apply 据此注入 entry.css（bundle 域 CSS 由 vite 打进应用）
    define['globalThis.__LANTAI_FACE_ARTIFACT__'] = '"1"';
  }

  const result = await build({
    entryPoints: [join(srcDir, spec.entry)],
    outfile: join(outDir, 'entry.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2021',
    jsx: 'automatic',
    jsxImportSource: './' + spec.hostModule,
    plugins: [redirectHostModule(srcDir, spec.hostModule)],
    alias: { react: reactBridge },
    define,
    // 面组件 CSS 引二进制资产（材质批：paper-sheet.jpg 流区纸纹）——dataurl 内联，
    // 保产物自包含契约；bundle 域同文件走 vite 自有 jpg loader，两域互不依赖
    loader: { '.jpg': 'dataurl' },
    metafile: true,
    logLevel: 'warning',
  });

  cpSync(join(srcDir, 'manifest.json'), join(outDir, 'manifest.json'));

  // 自包含校验：产物内不得出现静态 import（全 bundle 内联——宿主依赖经
  // host.aliased 从 window 取，react 经别名桥取）与动态裸 import。
  const fsp = await import('node:fs/promises');
  const entrySrc = await fsp.readFile(join(outDir, 'entry.js'), 'utf8');
  const staticImports = [...entrySrc.matchAll(/(?:^|[;\n])\s*(?:import\s[^'"]*?from\s*|import\s*)['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((src) => !src.startsWith('data:'));
  if (staticImports.length > 0) {
    console.error(`[build-builtin-plugins] ${spec.dir} 产物含静态 import（自包含契约被破）:`, staticImports);
    process.exit(1);
  }
  const dynamicBare = /import\s*\(\s*['"](?!\.)[^'"]*['"]\s*\)/.test(entrySrc);
  if (dynamicBare) {
    console.error(`[build-builtin-plugins] ${spec.dir} 产物含动态裸 import（自包含契约被破）`);
    process.exit(1);
  }
  const hasCss = readdirSync(outDir).some((f) => f.endsWith('.css'));
  // face.json（保险丝 a，2026-09-03 生产事故立法）：产物实际引用的宿主面
  // 键集——装载器 import 前对拍运行时 faceDeps，缺键拒载（防 exe↔产物版本
  // 偏斜在渲染期炸成整树卸载）。无 faceDeps 面（renderers 走 renderer-host）
  // 不产出。
  const faceKeys = extractFaceKeys(entrySrc);
  if (faceKeys.length > 0) {
    await fsp.writeFile(join(outDir, 'face.json'), JSON.stringify({ faceDeps: faceKeys }, null, 2) + '\n');
  }
  const inputCount = result.metafile ? Object.keys(result.metafile.inputs).length : 0;
  console.log(
    `[build-builtin-plugins] ${spec.dir} → hologram/${spec.dir}（${inputCount} 输入${hasCss ? ' + entry.css' : ''}${faceKeys.length > 0 ? ` + face.json（${faceKeys.length} 键）` : ''}）`,
  );
}

async function main() {
  // 产物根重建（幂等——每次全量）
  rmSync(join(repoRoot, 'src-ui', 'dist-plugins'), { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });

  // 源码目录缺席的规格跳过（显式警告，非静默）——迁移过渡期/部分检出容错
  const missing = pluginSpecs().filter((s) => !mkdirExists(join(builtinSrcRoot, s.dir)));
  for (const spec of missing) {
    console.warn(`[build-builtin-plugins] 跳过（源码目录缺席）: ${spec.dir}`);
  }
  const specs = pluginSpecs().filter((s) => mkdirExists(join(builtinSrcRoot, s.dir)));
  for (const spec of specs) {
    await buildPlugin(spec);
  }
  console.log(`[build-builtin-plugins] 完成：${specs.length} 个内置插件产物自包含校验全部通过`);
}

function mkdirExists(dir) {
  try {
    return readdirSync(dir).length >= 0;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('[build-builtin-plugins] 构建失败:', err);
  process.exit(1);
});

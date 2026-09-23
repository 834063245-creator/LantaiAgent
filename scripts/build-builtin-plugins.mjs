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

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src-ui/node_modules/esbuild/lib/main.js';
import { extractFaceKeys } from './lib/face-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const builtinSrcRoot = join(repoRoot, 'src-ui', 'src', 'plugins', 'builtin');
/** 构建根（`src-ui/dist-plugins/`）——本脚本的写盘落点；exe 侧另有资源根（见 syncProducts）。 */
const distPluginsRoot = join(repoRoot, 'src-ui', 'dist-plugins');
const outRoot = join(distPluginsRoot, 'builtin', 'hologram');
const reactBridge = join(builtinSrcRoot, 'react-bridge.cjs');

/* ── 宿主面指纹（保险丝 a′，2026-09-14 立法）──
 * 基线 src/plugins/host-surface.baseline.json 由 `npm run gen:host-surface` 生成、
 * 由 tests/host-surface-seal.test.ts 封印（改宿主面必须同 commit 更新基线）。
 * 本脚本：① 把指纹写进每个产物 face.json（装载器据此精确报错）；② 与本批 HEAD
 * 的基线对比——**变了就大字告警**：产物不能只换产物热更，必须重建 exe。
 * 事故由来：同日乙 批新增 INK_FAIL / buildTocInkBuckets 后按「只换产物」部署，
 * 旧 exe 无此键 → 产物拒载，又因 S5 已退役 displace 兜底 → 插件整面缺席。 */
const HOST_SURFACE_BASELINE = join(repoRoot, 'src-ui', 'src', 'plugins', 'host-surface.baseline.json');

function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 本批（工作区）宿主面基线。 */
const hostSurface = readJsonSafe(HOST_SURFACE_BASELINE);
if (!hostSurface?.fingerprint) {
  console.error(
    `[build-builtin-plugins] 宿主面基线缺失/坏形状：${HOST_SURFACE_BASELINE}\n` +
      '  —— 跑 npm run gen:host-surface 生成（产物 face.json 需要它写 hostApi 指纹）',
  );
  process.exit(1);
}

/** HEAD 版基线（作者期信号：本批相对上一次提交是否动了宿主面）。
 *  git 不可用/无提交 = null（跳过告警，构建照常）。 */
function headHostSurface() {
  try {
    const raw = execFileSync('git', ['show', `HEAD:src-ui/src/plugins/host-surface.baseline.json`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 宿主面若相对 HEAD 变了：大字告警（构建不阻断——改宿主面是合法操作，代价是 exe 重建）。 */
function warnIfHostSurfaceChanged() {
  const head = headHostSurface();
  if (!head?.fingerprint || head.fingerprint === hostSurface.fingerprint) return;
  const before = new Set(head.keys ?? []);
  const after = new Set(hostSurface.keys ?? []);
  const added = [...after].filter((k) => !before.has(k));
  const removed = [...before].filter((k) => !after.has(k));
  const fmt = (list) => (list.length > 8 ? `${list.slice(0, 8).join(', ')} …（共 ${list.length}）` : list.join(', '));
  console.warn(
    [
      '',
      '════════════════════════════════════════════════════════════════════',
      '⚠ 本批触及宿主面（faceDeps）——产物不能只换产物热更：',
      `   指纹 ${head.fingerprint} → ${hostSurface.fingerprint}`,
      added.length ? `   新增键：${fmt(added)}` : null,
      removed.length ? `   删除键：${fmt(removed)}` : null,
      '   影响：旧 exe 里没有这些键 → 新产物装载期拒载（且 S5 已退役 displace',
      '         兜底 = 该插件整面缺席）。要看到本批效果必须重建 exe：',
      '         cd src-tauri && cargo tauri build（或 --no-bundle 只出 exe）',
      '   仅换 dist-plugins 目录里的产物 = 一定会踩这条；dev 态走源码域不受影响。',
      '════════════════════════════════════════════════════════════════════',
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

// ── 名册单一真源（2026-09-06）：31 个内置产物的清单事实唯一在
// src-ui/src/plugins/builtin-roster.json（dir/buildOrder/entry/hostModule/face/
// define/description）。build 规格从名册派生——本文件不再手抄任何分组/名单。
// 旧的分组常量（UI_FACES/TOOL_DOMAINS/SEGMENTS/PROVIDERS/renderers 特例）
// 已删除：加/删产物只许改名册一处。 ──
const roster = JSON.parse(readFileSync(join(repoRoot, 'src-ui', 'src', 'plugins', 'builtin-roster.json'), 'utf8'));

/** 插件构建规格表（名册 buildOrder 升序——与装载序字节契约同源）。
 *  每条含名册完整事实 + 派生 scope 名（产物 manifest 生成用）。 */
function pluginSpecs() {
  return [...roster].sort((a, b) => a.buildOrder - b.buildOrder).map((e) => ({ ...e, name: 'hologram/' + e.dir }));
}

/** esbuild onResolve 钩子工厂：把指向 `./<hostModule>` 的 import（及其 jsx-runtime
 *  子路径）重定向到 aliased 版本（仅对来源在插件目录内的 import 生效）。
 *  esbuild automatic JSX 会产出 `import … from './<hostModule>/jsx-runtime'`
 *  （jsxImportSource 追加 /jsx-runtime）——两种形态都映射到 aliased 文件。
 *
 *  2026-09-23（renderers/viewers 子目录批）：匹配从「同目录形态 `./host`」放宽到
 *  「**末段**是 host 名的任意相对形态」——产物内部允许子目录（`viewers/audio.tsx`
 *  写 `../renderer-host`，其 JSX 注入也是相对自身的 `./renderer-host/jsx-runtime`）。
 *  旧正则只认 `^\./host$` ⇒ 子目录里的 import 漏过重定向、解析到真 `host.ts`，
 *  把 `app/overlay.tsx` 一类宿主文件拖进产物图并在那里炸 jsx-runtime 解析。
 *  仍然按 importer 是否在本产物目录内收口，跨产物不受影响。 */
function redirectHostModule(srcDir, hostModule) {
  return {
    name: 'redirect-' + hostModule,
    setup(buildApi) {
      const filter = new RegExp('(?:^|/)' + hostModule + '(?:/jsx-runtime)?$');
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
    // 产物域标记：apply 据此注入 entry.css（bundle 域 CSS 由 vite 打进应用）。
    // ⚠ **裸标识符形态**，与 face-css.ts 里的 `typeof __LANTAI_FACE_ARTIFACT__`
    // 严格同源——esbuild define 按表达式字面形态匹配，旧版写
    // `globalThis.__LANTAI_FACE_ARTIFACT__`（源码却是 `flags.X` 别名）⇒ 永不命中
    // ⇒ 产物 CSS 从未被注入（landmine H2，2026-09-17 实机撞上、09-19 修）。
    // 下面的产物自检是这条契约的保险丝：命不中即构建失败（不静默交付）。
    define.__LANTAI_FACE_ARTIFACT__ = '"1"';
  }

  const result = await build({
    entryPoints: [join(srcDir, spec.entry)],
    outfile: join(outDir, 'entry.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2021',
    // 产物**字节与调用 cwd 无关**（2026-09-20）：esbuild 在每个模块前写
    // `// <相对 absWorkingDir 的路径>` 注释，默认 absWorkingDir = cwd ⇒
    // 从 src-ui 跑（npm run build / watch）与从仓库根跑（node scripts/…）
    // 产出的注释不同（35 个产物字节不同）⇒ 逐文件 SHA256 的「变没变」判定
    // 失效、镜像无故重写一批。钉死 absWorkingDir = 仓库根，两次调用逐字节一致。
    absWorkingDir: repoRoot,
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

  // 产物 manifest 从名册生成（2026-09-06 起不再 cp 源目录 manifest——源目录
  // manifest.json 已退役，名册是唯一真源）。字段：name（派生）、version（随包
  // 统一 1.0.0）、description（名册文案）、entry（产物入口 entry.js）、inject
  // （名册——与源码插件对象对拍由 builtin-roster.test.ts 守护）。displace 死
  // 字段（S5 已退役位移）不再生成。
  const outManifest = {
    name: spec.name,
    version: '1.0.0',
    description: spec.description,
    entry: 'entry.js',
    inject: spec.inject ?? [],
  };
  await (await import('node:fs/promises')).writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify(outManifest, null, 2) + '\n',
    'utf8',
  );

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
  // 产物域标记自检（landmine H2 保险丝，2026-09-19）：面产物若仍残留
  // `__LANTAI_FACE_ARTIFACT__` 标识符 = esbuild define 没命中（源码形态与 define
  // 键不一致）⇒ 该产物的 CSS 永远不会被注入，且**静默**（页面只是少一份样式，
  // 与「改了但没生效」难以区分——正是 H2 骗过历次批次的原因）。此处构建即失败。
  if (spec.face && entrySrc.includes('__LANTAI_FACE_ARTIFACT__')) {
    console.error(
      `[build-builtin-plugins] ${spec.dir} 产物域标记未被替换（define 未命中）——\n` +
        '  esbuild define 按表达式字面形态匹配：face-css.ts 必须用裸标识符\n' +
        '  `__LANTAI_FACE_ARTIFACT__`，本脚本必须 define 同名裸键（勿加 globalThis. 前缀、\n' +
        '  勿让源码走局部别名）。产物 CSS 靠它才会被注入（landmine H2）——构建中止。',
    );
    process.exit(1);
  }
  // face.json（保险丝 a，2026-09-03 生产事故立法）：产物实际引用的宿主面
  // 键集——装载器 import 前对拍运行时 faceDeps，缺键拒载（防 exe↔产物版本
  // 偏斜在渲染期炸成整树卸载）。无 faceDeps 面（renderers 走 renderer-host）
  // 不产出。
  const faceKeys = extractFaceKeys(entrySrc);
  if (faceKeys.length > 0) {
    await fsp.writeFile(
      join(outDir, 'face.json'),
      JSON.stringify({ faceDeps: faceKeys, hostApi: hostSurface.fingerprint }, null, 2) + '\n',
    );
  }
  const inputCount = result.metafile ? Object.keys(result.metafile.inputs).length : 0;
  console.log(
    `[build-builtin-plugins] ${spec.dir} → hologram/${spec.dir}（${inputCount} 输入${hasCss ? ' + entry.css' : ''}${faceKeys.length > 0 ? ` + face.json（${faceKeys.length} 键）` : ''}）`,
  );
  // 输入表（watch 模式的影响面判定用——绝对路径；metafile 键相对 absWorkingDir）
  const inputs = new Set(Object.keys(result.metafile?.inputs ?? {}).map((k) => resolve(repoRoot, k)));
  return { inputCount, inputs };
}

// ── `--watch`：保存即生效（免手工「构建 + 拷贝」两步）──
//
// 监听 `src-ui/src`（插件源码与其共享输入所在），按 esbuild metafile 的**输入表**
// 精确判定受影响产物（共享输入如 react-bridge.cjs 会让所有面产物一起重建）；
// 新文件 / 名册 / 本脚本自身变化 = 全量重建（保守但正确）。改完自动镜像进
// exe 侧资源根 ⇒ 应用侧只剩「自动重载」这一步。
// 常驻期间写 `.watch.lock`（产物根内）：全量构建（`npm run build` / `cargo tauri
// build`）见活锁即具名拒绝——两者争同一棵树会把构建炸成 ENOTEMPTY。
async function watchMode() {
  assertNoWatcher(); // 双开 watch 同样争树
  const { specs, inputsByDir } = await fullBuild({ sync: !process.argv.includes('--no-sync') });
  writeWatchLock();
  const { watch } = await import('node:fs');
  const watchRoot = join(repoRoot, 'src-ui', 'src');
  const buildOne = async (spec) => {
    const r = await buildPlugin(spec);
    inputsByDir.set(spec.dir, r.inputs);
  };
  const rebuildAndSync = async (specsToBuild) => {
    for (const spec of specsToBuild) await buildOne(spec);
    writeRevFile(false);
    syncProducts(false);
  };

  console.log(`\n[watch] 监听 ${relative(repoRoot, watchRoot)}（Ctrl+C 退出）——保存即重建 + 镜像`);
  let pending = new Set();
  let timer = null;
  let running = false;
  /** 本批首个事件的时刻（去抖硬上限 + 日志里的「保存→重建」时延）。 */
  let firstEventAt = null;
  const flush = async () => {
    timer = null;
    if (running) return; // 上一轮未完成：等它结束再看（pending 已累积）
    running = true;
    const savedAt = firstEventAt;
    firstEventAt = null;
    try {
      do {
        const batch = pending;
        pending = new Set();
        const affected = specs.filter((s) => {
          const inputs = inputsByDir.get(s.dir);
          if (!inputs) return true; // 未知输入面 = 保守全量
          for (const f of batch) if (inputs.has(f)) return true;
          return false;
        });
        // 名册 / 脚本自身 / 未进任何输入表的新文件 → 全量
        const forceAll = [...batch].some(
          (f) =>
            f === join(repoRoot, 'src-ui', 'src', 'plugins', 'builtin-roster.json') ||
            f.startsWith(join(repoRoot, 'scripts')) ||
            !specs.some((s) => inputsByDir.get(s.dir)?.has(f)),
        );
        const target = forceAll ? specs : affected;
        if (target.length === 0) continue;
        console.log(
          `\n[watch] ${[...batch].map((f) => relative(repoRoot, f)).join(', ')}` +
            ` → 重建 ${target.length === specs.length ? '全部' : target.map((s) => s.dir).join(', ')}` +
            (savedAt == null ? '' : `（保存→重建 ${Date.now() - savedAt}ms）`),
        );
        await rebuildAndSync(target);
      } while (pending.size > 0);
    } catch (e) {
      console.error('[watch] 重建失败（监听继续）:', e);
    } finally {
      running = false;
    }
  };
  watch(watchRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const abs = resolve(watchRoot, String(filename));
    if (abs.includes(`${'node_modules'}`) || abs.endsWith('~')) return; // 编辑器临时文件/依赖
    pending.add(abs);
    // 去抖两档：静默 200ms 即干（编辑器单次保存），但**首次事件后最多 1s** 必干
    // ——否则连续事件会不断重置计时器（去抖饥饿），保存到生效被拖成好几秒。
    if (timer) clearTimeout(timer);
    if (firstEventAt == null) firstEventAt = Date.now();
    const waited = Date.now() - firstEventAt;
    timer = setTimeout(() => void flush(), Math.max(0, Math.min(200, 1000 - waited)));
  });
  // 常驻（Ctrl+C 退出）
  await new Promise(() => {});
}

// ── 产物镜像：构建根 → exe 侧资源根（landmine H1 根治，2026-09-20）──
//
// 两个产物根：本脚本写 `src-ui/dist-plugins/`（**构建根**），而**运行中的 exe
// 只认资源根** `target/<profile>/_up_/src-ui/dist-plugins/`（tauri.conf.json 的
// resources 映射落点；plugin_assets.rs::init_builtin_plugins_dir 命中即锁）。
// 只跑构建不拷 = 应用内「重新加载」重载的是旧文件，**静默、无报错、无回执**——
// 2026-09-17 实机「热重载根本没生效」即此（H1 当时只补了文档的手工拷贝步，
// 2026-09-20 实机再次当场漂移一份 canvas-nav 产物 ⇒ 改自动镜像）。
//
// 同步口径：**存在的每个资源根都同步**（debug/release 都可能存在；不猜 profile
// ——这是「幂等镜像全部已存在资源根」，不是猜运行时事实）；逐文件 SHA256 对拍
// （不许靠时间戳判断），产物侧多出的文件删掉（改名/退役不留残余）。

/** 仓库 target 下已存在的 exe 侧资源根（`target/<profile>/_up_/src-ui/dist-plugins`）。 */
function existingResourceRoots() {
  const targetRoot = join(repoRoot, 'target');
  let profiles = [];
  try {
    profiles = readdirSync(targetRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return profiles
    .map((p) => join(targetRoot, p, '_up_', 'src-ui', 'dist-plugins'))
    .filter((p) => existsSync(p))
    .sort();
}

/** 递归列出目录下全部文件的相对路径（`/` 归一，稳定序）。 */
function walkRel(root, rel = '', out = []) {
  let entries = [];
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walkRel(root, r, out);
    else out.push(r);
  }
  return out;
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** 逐文件 SHA256 镜像 src → dst（dryRun = 只报告不写盘）。
 *  **跳过点文件**：产物根里有非产物的内部文件（`.watch.lock`），不该随镜像外流。 */
function mirrorTree(srcRoot, dstRoot, dryRun) {
  const result = { copied: [], removed: [], same: 0 };
  const noDot = (rel) => !rel.split('/').some((seg) => seg.startsWith('.'));
  const srcFiles = walkRel(srcRoot).filter(noDot);
  const srcSet = new Set(srcFiles);
  for (const rel of srcFiles) {
    const s = join(srcRoot, rel);
    const d = join(dstRoot, rel);
    if (existsSync(d) && sha256File(s) === sha256File(d)) {
      result.same++;
      continue;
    }
    result.copied.push(rel);
    if (!dryRun) {
      mkdirSync(dirname(d), { recursive: true });
      copyFileSync(s, d);
    }
  }
  for (const rel of walkRel(dstRoot).filter(noDot)) {
    if (srcSet.has(rel)) continue;
    result.removed.push(rel);
    if (!dryRun) rmSync(join(dstRoot, rel), { force: true });
  }
  return result;
}

/** 产物修订表（`dist-plugins/builtin/_rev.json`）——每个产物目录一份内容指纹。
 *  用途：应用侧拿它当「产物已换 ⇒ 自动重载」的廉价变更信号（通道直取
 *  `/plugins/_rev.json`；该名字不是插件目录、不进索引）。**不含时间戳**：
 *  内容不变则文件不变（镜像对拍不会因它恒报「有更新」）。 */
function writeRevFile(dryRun) {
  const rev = {};
  for (const dir of readdirSync(outRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()) {
    const h = createHash('sha256');
    for (const f of readdirSync(join(outRoot, dir)).sort()) {
      if (!/\.(js|css|json)$/.test(f)) continue;
      h.update(f);
      h.update(readFileSync(join(outRoot, dir, f)));
    }
    rev['hologram/' + dir] = h.digest('hex').slice(0, 16);
  }
  if (!dryRun) {
    writeFileSync(join(distPluginsRoot, 'builtin', '_rev.json'), JSON.stringify(rev, null, 2) + '\n', 'utf8');
  }
  return rev;
}

/** 镜像构建根到全部已存在资源根；返回漂移文件数（dryRun 时即「当前漂移量」）。 */
function syncProducts(dryRun) {
  const roots = existingResourceRoots();
  if (roots.length === 0) {
    console.warn(
      '[build-builtin-plugins] 未发现 exe 侧资源根（target/<profile>/_up_/src-ui/dist-plugins）——' +
        '跳过镜像（尚未跑过 cargo tauri build/dev；打包态资源根由那次构建建立）',
    );
    return 0;
  }
  let drift = 0;
  for (const dst of roots) {
    const r = mirrorTree(distPluginsRoot, dst, dryRun);
    drift += r.copied.length + r.removed.length;
    console.log(
      `[build-builtin-plugins] ${dryRun ? '对拍' : '镜像'} ${relative(repoRoot, dst)}：` +
        `更新 ${r.copied.length} / 未变 ${r.same} / 清除 ${r.removed.length}`,
    );
    for (const rel of r.copied.slice(0, 12)) console.log(`    ${dryRun ? '漂移' : '写入'} ${rel}`);
    if (r.copied.length > 12) console.log(`    ……（其余 ${r.copied.length - 12} 个）`);
    for (const rel of r.removed) console.log(`    删除 ${rel}`);
  }
  return drift;
}

/** `--check`：不写盘，只对拍构建根 ↔ 资源根。有漂移 ⇒ exit 1（红）。 */
function checkDrift() {
  console.log('[build-builtin-plugins] --check：对拍构建根 ↔ exe 资源根（不写盘）');
  const drift = syncProducts(true);
  if (drift > 0) {
    console.error(
      `\n[build-builtin-plugins] ✗ 产物漂移 ${drift} 个文件——运行中的 exe 会重载**旧产物**（landmine H1）。\n` +
        '  修：node scripts/build-builtin-plugins.mjs（构建 + 自动镜像）',
    );
    process.exit(1);
  }
  console.log('[build-builtin-plugins] ✓ 无漂移：资源根与构建根逐文件一致（SHA256）');
  return drift;
}

/** watch 常驻锁（放产物根内——该目录已 gitignore，且随全量构建清空自动回收）。 */
const WATCH_LOCK = join(distPluginsRoot, '.watch.lock');

/** 进程是否还活着（Windows 上 EPERM = 存在但无权限查，按活着算）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** 全量构建前的互斥闸（2026-09-20 实机撞上）：watch 常驻时两者争同一产物树——
 *  全量构建先 `rmSync(dist-plugins)`，watch 同时在写 ⇒ `ENOTEMPTY` 直接把
 *  `cargo tauri build` 的 beforeBuildCommand 炸掉（错误信息与根因毫无关系）。
 *  活着的 watch ⇒ **具名拒绝**；崩溃残留的死锁 ⇒ 忽略并清掉。 */
function assertNoWatcher() {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(WATCH_LOCK, 'utf8'));
  } catch {
    return;
  }
  const pid = Number(raw?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) {
    rmSync(WATCH_LOCK, { force: true });
    return;
  }
  console.error(
    `[build-builtin-plugins] ✗ 另一个 watch:builtin-plugins 正在跑（pid ${pid}，起于 ${raw.startedAt ?? '?'}）——\n` +
      '  全量构建要清空产物根，与它争同一棵树（实测 rmSync ENOTEMPTY 直接炸构建）。\n' +
      '  先停它（那个终端里 Ctrl+C）再跑；只想更新产物不必全量构建，watch 本身就是增量的。',
  );
  process.exit(1);
}

/** 全量构建（清空产物根重出）+ 可选镜像；返回 specs 与各自的输入表（watch 用）。 */
async function fullBuild({ sync }) {
  warnIfHostSurfaceChanged();
  // 产物根重建（幂等——每次全量）
  rmSync(distPluginsRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });

  // 源码目录缺席的规格跳过（显式警告，非静默）——迁移过渡期/部分检出容错
  const missing = pluginSpecs().filter((s) => !mkdirExists(join(builtinSrcRoot, s.dir)));
  for (const spec of missing) {
    console.warn(`[build-builtin-plugins] 跳过（源码目录缺席）: ${spec.dir}`);
  }
  const specs = pluginSpecs().filter((s) => mkdirExists(join(builtinSrcRoot, s.dir)));
  const inputsByDir = new Map();
  for (const spec of specs) {
    const r = await buildPlugin(spec);
    inputsByDir.set(spec.dir, r.inputs);
  }
  writeRevFile(false);
  console.log(`[build-builtin-plugins] 完成：${specs.length} 个内置插件产物自包含校验全部通过`);
  // 镜像进 exe 侧资源根（landmine H1：不镜像 = 应用内重载旧产物，静默）
  if (sync) syncProducts(false);
  else console.warn('[build-builtin-plugins] --no-sync：跳过资源根镜像（运行中的 exe 不会看到本批产物）');
  return { specs, inputsByDir };
}

/** watch 常驻锁的写入与释放（Ctrl+C / 正常退出都清）。 */
function writeWatchLock() {
  mkdirSync(distPluginsRoot, { recursive: true });
  writeFileSync(
    WATCH_LOCK,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
  const release = () => {
    try {
      rmSync(WATCH_LOCK, { force: true });
    } catch {
      /* 退出路径尽力而为 */
    }
  };
  process.on('SIGINT', () => {
    release();
    process.exit(0);
  });
  process.on('SIGTERM', release);
  process.on('exit', release);
}

async function main() {
  if (process.argv.includes('--check')) {
    checkDrift();
    return;
  }
  if (process.argv.includes('--watch')) {
    await watchMode();
    return;
  }
  assertNoWatcher();
  await fullBuild({ sync: !process.argv.includes('--no-sync') });
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

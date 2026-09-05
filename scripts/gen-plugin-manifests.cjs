#!/usr/bin/env node
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// gen-plugin-manifests — 内核插件 manifest 的 TS 镜像生成器（kernel-plugin-runtime）。
// 真源 = src-tauri/src/tool_plugins/<name>/manifest.json（Rust 侧 include_str! 内嵌）；
// 本生成器把全部 manifest 汇成 src-ui/src/agent/tools/kernel-manifests.generated.ts，
// 供前端从 Manifest 生成模型可见工具面（schema 单一真源，双端零漂移）。
// 用法：node scripts/gen-plugin-manifests.cjs [--check]（--check = 与已提交产物逐字节对拍，
// 漂移即非零退出；已挂 doc-sync 门禁）。
//
// 注意：manifest 内 schema 的键序 = zod 发射序，是 convergence 字节契约的一部分——
// 生成器逐字保留键序（JSON.stringify 与解析同序），勿做任何键排序/规整。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src-tauri', 'src', 'tool_plugins');
const OUT_FILE = path.join(ROOT, 'src-ui', 'src', 'agent', 'tools', 'kernel-manifests.generated.ts');

function collectManifests() {
  const entries = fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  const manifests = [];
  for (const dir of entries) {
    const manifestPath = path.join(SRC_DIR, dir.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    const raw = fs.readFileSync(manifestPath, 'utf8');
    manifests.push(JSON.parse(raw));
  }
  // 目录序即装载序——与 Rust 侧 with_system_defaults 的注册序保持一致。
  return manifests;
}

function emit(manifests) {
  const lines = [];
  lines.push('// Copyright (c) 2026 Wenbing Jing. MIT License.');
  lines.push('// SPDX-License-Identifier: MIT');
  lines.push('');
  lines.push('// 生成物 — scripts/gen-plugin-manifests.cjs 从 src-tauri/src/tool_plugins/*/manifest.json 生成。');
  lines.push('// 真源在 Rust 侧 manifest；改动请改 manifest 后重新生成（npm run gen:plugin-manifests），勿手改。');
  lines.push('// schema 键序 = zod 发射序（convergence 字节契约），生成器逐字保留，勿规整。');
  lines.push('');
  lines.push("import type { KernelToolManifest } from './manifest-tools';");
  lines.push('');
  lines.push('export const KERNEL_MANIFESTS: readonly KernelToolManifest[] = [');
  for (const m of manifests) {
    lines.push(`  ${JSON.stringify(m, null, 2).replace(/\n/g, '\n  ')},`);
  }
  lines.push('];');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const manifests = collectManifests();
  // （R4-4b 后出厂 manifest 全部退役——零清单是合法终态，发射空镜像；
  //  本生成器与镜像整个脚手架收在 R5 拆除，届时 doc-sync 登记项同步清。）
  const content = emit(manifests);
  if (check) {
    const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : '';
    if (existing !== content) {
      console.error('[gen-plugin-manifests] 漂移：kernel-manifests.generated.ts 与 manifest 真源不一致，请运行 npm run gen:plugin-manifests');
      process.exit(1);
    }
    console.log(`[gen-plugin-manifests] 对拍通过（${manifests.length} 个 manifest）`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, content, 'utf8');
  console.log(`[gen-plugin-manifests] 已生成 ${OUT_FILE}（${manifests.length} 个 manifest）`);
}

main();

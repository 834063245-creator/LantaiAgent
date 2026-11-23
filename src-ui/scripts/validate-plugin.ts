// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 插件 manifest 校验 CLI（2026-11-23 契约工具包 · 批 2）。
// 用法（根目录薄壳转发，经 tsx 运行）：
//   npm run plugin:validate -- <插件目录> [--json]
//
// 契约：与装载器**同一份**判据（validateManifest 单一真源）——不做第二套规则，
// 否则 CLI 绿而装载红灯是最坏的开发者体验。输出字段路径 + 人话原因（含退役字段
// 的迁移指引）；退出码 = 校验结果（0 通过 / 1 失败 / 2 用法错误）。
//
// 额外两条 **hint**（不影响退出码——装载器自己也会拒/报，这里只是提前说）：
//   - manifest.name 与目录名不一致（装载器按目录名寻址，两处必须逐字一致）；
//   - entry / app.entry 声明的文件不存在。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type PluginManifest, validateManifest } from '../src/plugins/types';

/** 单条校验问题（path = 字段路径，message = 人话）。 */
interface Issue {
  path: string;
  message: string;
}

/** validateManifest 的 `a.b: msg; c.d: msg` 串 → 逐条（分隔符是 '; '，首冒号分路径）。 */
export function parseIssues(error: string): Issue[] {
  return error.split('; ').map((line) => {
    const idx = line.indexOf(': ');
    if (idx <= 0) return { path: '(root)', message: line };
    return { path: line.slice(0, idx), message: line.slice(idx + 2) };
  });
}

/** 装载前置提示（不进退出码）：目录名 / 入口文件。 */
function hints(dir: string, manifest: PluginManifest): string[] {
  const out: string[] = [];
  const dirName = path.basename(dir);
  if (dirName !== manifest.name) {
    out.push(
      `manifest.name（${manifest.name}）与目录名（${dirName}）不一致——装载器按目录名寻址，正式放置前把两处改成同一个 id`,
    );
  }
  const entry = path.join(dir, manifest.entry);
  if (!existsSync(entry)) out.push(`entry 声明的 ${manifest.entry} 不存在（相对插件目录）`);
  if (manifest.app?.entry) {
    const html = path.join(dir, manifest.app.entry);
    if (!existsSync(html)) out.push(`app.entry 声明的 ${manifest.app.entry} 不存在（相对插件目录）`);
  }
  return out;
}

interface Report {
  ok: boolean;
  file: string;
  name?: string;
  version?: string;
  issues: Issue[];
  hints: string[];
}

/** 校验入口（CLI 与测试共用；纯函数：只读文件，不改任何东西）。 */
export function validatePluginDir(dirArg: string): { report: Report; code: number } {
  const dir = path.resolve(dirArg);
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) {
    return {
      report: { ok: false, file, issues: [{ path: '(file)', message: '目录下没有 manifest.json' }], hints: [] },
      code: 1,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      report: { ok: false, file, issues: [{ path: '(file)', message: `JSON 解析失败：${message}` }], hints: [] },
      code: 1,
    };
  }
  const res = validateManifest(raw);
  if (!res.ok) {
    return { report: { ok: false, file, issues: parseIssues(res.error), hints: [] }, code: 1 };
  }
  return {
    report: {
      ok: true,
      file,
      name: res.manifest.name,
      version: res.manifest.version,
      issues: [],
      hints: hints(dir, res.manifest),
    },
    code: 0,
  };
}

function main(argv: string[]): number {
  const json = argv.includes('--json');
  const dirArg = argv.find((a) => !a.startsWith('--'));
  if (!dirArg) {
    console.error('用法：npm run plugin:validate -- <插件目录> [--json]');
    return 2;
  }
  const { report, code } = validatePluginDir(dirArg);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return code;
  }
  if (!report.ok) {
    console.log(`✗ ${report.file}`);
    for (const issue of report.issues) console.log(`  - ${issue.path}: ${issue.message}`);
    console.log(
      '\n提示：manifest 形状真源 = docs/plugins/contract-card.md；跨字段约束仍由本 CLI 校验（JSON Schema 表达不了）。',
    );
    return code;
  }
  console.log(`✓ ${report.name} v${report.version} —— ${report.file}`);
  for (const hint of report.hints) console.log(`  [hint] ${hint}`);
  return 0;
}

// 仅在被直接执行时跑 main（测试 import 本文件时不执行 CLI）。
const isEntry =
  process.argv[1] !== undefined &&
  import.meta.filename !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isEntry) process.exit(main(process.argv.slice(2)));

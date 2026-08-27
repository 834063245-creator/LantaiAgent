// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 开放面契约指纹生成入口（薄壳）——平台化 Phase 3 · P3-C4。
// 真实逻辑在 src-ui/scripts/gen-contract-fingerprint.ts（经 tsx 运行）。
// 用法：node scripts/gen-contract-fingerprint.cjs [--check]
// 等价 npm script（src-ui 下）：npm run gen:contract-fingerprint /
// npm run check:contract-fingerprint

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_UI = path.join(ROOT, 'src-ui');
const CORE_TS = path.join(SRC_UI, 'scripts', 'gen-contract-fingerprint.ts');

const candidates = [path.join(SRC_UI, 'node_modules', 'tsx', 'dist', 'cli.mjs')];
const tsxCli = candidates.find((p) => {
  try {
    require('node:fs').accessSync(p);
    return true;
  } catch {
    return false;
  }
});
if (!tsxCli) {
  console.error('[contract-fingerprint] 未找到 tsx（src-ui devDependencies）——先在 src-ui 下 npm install');
  process.exit(1);
}

const args = process.argv.slice(2);
const res = spawnSync(process.execPath, [tsxCli, CORE_TS, ...args], {
  cwd: SRC_UI,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);

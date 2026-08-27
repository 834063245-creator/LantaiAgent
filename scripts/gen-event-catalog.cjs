// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 事件目录生成入口（薄壳）——平台化 Phase 3 · D9。
// 真实逻辑在 src-ui/scripts/gen-event-catalog.ts（需经 tsx 运行以加载 TS 源）。
// 用法：node scripts/gen-event-catalog.cjs [--check]
// 等价 npm script（src-ui 下）：npm run gen:catalogs:event

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_UI = path.join(ROOT, 'src-ui');
const CORE_TS = path.join(SRC_UI, 'scripts', 'gen-event-catalog.ts');

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
  console.error('[event-catalog] 未找到 tsx（src-ui devDependencies）——先在 src-ui 下 npm install');
  process.exit(1);
}

const args = process.argv.slice(2);
const res = spawnSync(process.execPath, [tsxCli, CORE_TS, ...args], {
  cwd: SRC_UI,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);

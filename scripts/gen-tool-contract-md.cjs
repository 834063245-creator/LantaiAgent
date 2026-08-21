// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 工具面契约文档生成入口（薄壳）。
// 真实逻辑在 src-ui/scripts/gen-tool-contract-md.ts（需经 tsx 运行以加载 TS 源）；
// 本壳只做转发，保证 C1 判据「scripts/gen-tool-contract-md.cjs 存在」与
// gen-rpc-contract-md.cjs 同目录同纪律。用法：
//   node scripts/gen-tool-contract-md.cjs [--check]
// 等价 npm script（src-ui 下）：npm run gen:tool-contract / npm run check:tool-contract

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_UI = path.join(ROOT, 'src-ui');
const CORE_TS = path.join(SRC_UI, 'scripts', 'gen-tool-contract-md.ts');

// tsx 的 CLI 是纯 node 可执行脚本（dist/cli.mjs），直接用当前 node 跑，
// 避免 Windows .bin/*.cmd 的 shell 包装差异。
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
  console.error('[tool-contract] 未找到 tsx（src-ui devDependencies）——先在 src-ui 下 npm install');
  process.exit(1);
}

const args = process.argv.slice(2);
const res = spawnSync(process.execPath, [tsxCli, CORE_TS, ...args], {
  cwd: SRC_UI,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);

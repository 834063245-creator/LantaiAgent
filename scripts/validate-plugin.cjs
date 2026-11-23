// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 插件 manifest 校验入口（薄壳）。
// 真实逻辑在 src-ui/scripts/validate-plugin.ts（经 tsx 运行）；本壳只做转发。用法：
//   node scripts/validate-plugin.cjs <插件目录> [--json]
// 等价 npm script（src-ui 下）：npm run plugin:validate -- <插件目录>
//
// 退出码：0 通过 / 1 校验失败 / 2 用法错误（可进 CI 或 pre-commit）。

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC_UI = path.join(ROOT, 'src-ui');
const CORE_TS = path.join(SRC_UI, 'scripts', 'validate-plugin.ts');

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
  console.error('[plugin:validate] 未找到 tsx（src-ui devDependencies）——先在 src-ui 下 npm install');
  process.exit(1);
}

const args = process.argv.slice(2);
const res = spawnSync(process.execPath, [tsxCli, CORE_TS, ...args], {
  cwd: SRC_UI,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);

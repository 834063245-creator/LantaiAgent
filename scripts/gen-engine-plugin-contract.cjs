// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
// 引擎开放面契约文档生成薄壳（转发到 src-ui/scripts/gen-engine-plugin-contract.ts）。
// 用法：node scripts/gen-engine-plugin-contract.cjs [--check]

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC_UI = path.join(ROOT, "src-ui");
const CORE_TS = path.join(SRC_UI, "scripts", "gen-engine-plugin-contract.ts");

const candidates = [path.join(SRC_UI, "node_modules", "tsx", "dist", "cli.mjs")];
const tsxCli = candidates.find((p) => {
  try {
    require("node:fs").accessSync(p);
    return true;
  } catch {
    return false;
  }
});
if (!tsxCli) {
  console.error("[engine-plugin-contract] 未找到 tsx（src-ui devDependencies）——先在 src-ui 下 npm install");
  process.exit(1);
}

const args = process.argv.slice(2);
const res = spawnSync(process.execPath, [tsxCli, CORE_TS, ...args], { cwd: SRC_UI, stdio: "inherit" });
process.exit(res.status ?? 1);

#!/usr/bin/env node
// 代码量统计（scc 的薄封装）。口径只有两种，故意不开放任意路径参数：
//
// 1) 全仓：直接 `scc .`，让 scc 自己读 .gitignore —— 这样 node_modules / 构建产物 / 生成的
//    tree-sitter parser.c 都不会进来。
// 2) 只看手写代码：按扩展名白名单。文档（Markdown 5 万行）和 JSON 不计入，避免「散文算代码」。
//
// 为什么不让调用方传目录：scc 一旦被显式点名子目录（如 `scc engine`），仓库根 .gitignore 里
// 锚定的规则就失效，engine/grammars/build/**/parser.c 会瞬间灌进 82 万行假数据（实测）。
//
// 用法：npm run loc（等价于 node ../scripts/loc.mjs）
// 环境变量：SCC_BIN 可指定 scc 可执行文件路径。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXT = 'ts,tsx,rs,css,js,mjs,cjs,py,sh,go,html';
const FALLBACK_BIN = 'D:/Cache/scc/scc.exe';

/** 找到可用的 scc：环境变量 > PATH > 本机固定安装位。 */
function findScc() {
  const candidates = [process.env.SCC_BIN, 'scc', FALLBACK_BIN].filter(Boolean);
  for (const bin of candidates) {
    if (bin.includes('/') || bin.includes('\\') ? existsSync(bin) : true) {
      const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
      if (probe.status === 0) return bin;
    }
  }
  return null;
}

const scc = findScc();
if (!scc) {
  console.error('未找到 scc。安装：https://github.com/boyter/scc/releases 下载 scc_Windows_x86_64.zip，');
  console.error('解压后把 scc.exe 放进 PATH 里，或用 SCC_BIN 环境变量指向它。');
  process.exit(1);
}

/** 跑一次 scc 并把表格原样打出来。 */
function report(title, args) {
  console.log(`\n==== ${title} ====`);
  const run = spawnSync(scc, ['.', ...args], { cwd: REPO_ROOT, stdio: 'inherit', shell: false });
  if (run.status !== 0) {
    console.error(`scc 退出码 ${run.status}`);
    process.exit(run.status ?? 1);
  }
}

report('全仓（含文档，.gitignore 生效）', []);
report(`只看手写代码（${SOURCE_EXT}）`, [`--include-ext=${SOURCE_EXT}`]);
console.log('\n注：COCOMO 的成本/工期/人数是用行数乘经验系数得来的估算，不是实际投入，别当报价用。');

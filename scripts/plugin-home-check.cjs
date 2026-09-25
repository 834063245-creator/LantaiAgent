#!/usr/bin/env node
// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugin-home-check —— 插件归家**三色对账报告**（插件化欠账总账 §5 第 4 条 / §7）。
//
// 病灶：账①（通道迁移 ✅）只证明「实现经 ctx.* 通道贡献」，**不证明实现住在产物包里**；
// 账③（从未立项的插件化面）连账都没有。结果是一门禁全绿、`plugins/builtin/` 看着像
// 已完成插件化，而实现仍躺在内核里——「还剩什么」只能靠人肉再验一轮。
//
// 本报告 = 那条常驻对账（此后不必再人肉盘）：
//   红 = **已认领却不在包内**：名册条目 `impl` 里仍在内核的实现真源（搬一个销一条）
//   绿 = **平台白名单** + **已被产物认领的内核模块**（被产物直接 import 或 `shared` 声明）
//   灰 = **内核里没有任何产物认领、也不在白名单**（= 从未立项的面）——**灰区非空即告警**
//
// 口径：只扫 `.ts/.tsx`（导入图）；行数用物理行（`(Get-Content).Count` 语义）。
// 用法：`node scripts/plugin-home-check.cjs [--json] [--top N] [--all]`
//   `--json` 机器可读；`--top N` 明细列前 N 条（默认 15）；`--all` 列全部灰区文件。
// 退出码恒 0（这是报告不是门禁）；机器门禁在 tests/plugin-home-ledger.test.ts
// 与 tests/privileged-zone-freeze.test.ts。

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src-ui', 'src');
const BUILTIN = path.join(SRC, 'plugins', 'builtin');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const listAll = argv.includes('--all');
const topIdx = argv.indexOf('--top');
const TOP = topIdx >= 0 ? Number(argv[topIdx + 1]) || 15 : 15;

/** 平台白名单（**强制层 / 零欠账面**，账本 §3）——每条带理由，加白名单要写清为什么。 */
const PLATFORM = [
  { prefix: 'cordis/', why: 'cordis 内核（vendored 快照）' },
  { prefix: 'composition/', why: '组合解析/装配通道内核（强制层）' },
  { prefix: 'plugins/', why: '装载链（宿主面/名册/RPC 桥）', excludePrefix: 'plugins/builtin/' },
  { prefix: 'shell/', why: '壳行强制层' },
  { prefix: 'state/', why: '跨插件共享状态层（账本 §3：0 欠账）' },
  { prefix: 'lifecycle/', why: 'Workspace 原语 + 通用 promise 工具' },
  {
    files: [
      'main.ts',
      'bridge.ts',
      'rpc-contract.ts',
      'workspace.ts',
      'workspace-scope.ts',
      'mock-data.ts',
      'i18n.ts',
      'agent/logger.ts',
    ],
    why: '平台入口 / RPC 契约 / 工作区原语 / 基础设施',
  },
  // ── 批 9a 账目登记三件（§7 已拍板：§4-6 / §4-7 / §4-12）──
  // 三条都不是「欠账」，而是**分类缺口**（既非 service 产物、也无 feature 归属）：
  // 判定留内核后在此登记，灰区不再重复报警。
  // §4-6 用户 2026-09-25 裁定 A（2026-09-26 落地）：token 计量升为内核第 16 个 service
  // `ctx.tokenMeter`（`agent/token-meter/service.ts`）——内核 service 实现住内核是本仓
  // 常态（对齐 `composition/` 通道内核与 `agent/code-run/runtime-service.ts`），
  // 消费面 = `ctx.tokenMeter.createLedger()/restoreLedger()/usage`，故本前缀留白名单。
  { prefix: 'agent/token-meter/', why: '§4-6 A：第 16 个内核 service ctx.tokenMeter（账本工厂 + 分桶代数，内核不可禁用）' },
  { prefix: 'agent/acp/', why: '§4-7 B：ACP 协议面 = 平台（当前零产线消费者，仅测试 + 类型 import）' },
];

const lines = (p) => {
  const t = fs.readFileSync(p, 'utf8');
  if (t === '') return 0;
  return t.replace(/\r?\n$/, '').split(/\r?\n/).length;
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/');

function isPlatform(r) {
  for (const rule of PLATFORM) {
    if (rule.prefix && r.startsWith(rule.prefix)) {
      if (rule.excludePrefix && r.startsWith(rule.excludePrefix)) continue;
      return rule;
    }
    if (rule.files && rule.files.includes(r)) return rule;
  }
  return null;
}

// ── 数据 ──
const roster = JSON.parse(fs.readFileSync(path.join(SRC, 'plugins', 'builtin-roster.json'), 'utf8')).sort(
  (a, b) => a.buildOrder - b.buildOrder,
);
const allTs = walk(SRC);
const productOf = new Map(); // 内核文件 → Set(产物 dir)
const sharedDecl = new Map(); // 内核文件 → Set(产物 dir)（名册 shared 声明）
for (const f of allTs) {
  if (!f.startsWith(BUILTIN + path.sep)) continue;
  const dir = path.relative(BUILTIN, f).split(path.sep)[0];
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
    const r = resolveSpec(f, m[1]);
    if (!r || r.startsWith(BUILTIN + path.sep)) continue;
    const key = rel(r);
    if (!productOf.has(key)) productOf.set(key, new Set());
    productOf.get(key).add(dir);
  }
}
for (const e of roster) {
  for (const s of e.shared ?? []) {
    if (!sharedDecl.has(s)) sharedDecl.set(s, new Set());
    sharedDecl.get(s).add(e.dir);
  }
}

// ── 红：已认领却不在包内 ──
const red = [];
for (const e of roster) {
  const impl = e.impl ?? [];
  if (impl.length === 0) continue;
  const remaining = impl.filter((r) => fs.existsSync(path.join(SRC, r)));
  if (remaining.length === 0) continue;
  red.push({
    dir: e.dir,
    files: remaining.map((r) => ({ path: r, lines: lines(path.join(SRC, r)), imported: productOf.has(r) })),
  });
}

// ── 灰 / 绿 ──
const grey = [];
let greenPlatform = 0;
let greenClaimed = 0;
for (const f of allTs) {
  const r = rel(f);
  if (r.startsWith('plugins/builtin/')) continue; // 产物包本体 = 已归家
  if (isPlatform(r)) {
    greenPlatform += 1;
    continue;
  }
  if (productOf.has(r) || sharedDecl.has(r)) {
    greenClaimed += 1;
    continue;
  }
  grey.push({ path: r, lines: lines(f) });
}
grey.sort((a, b) => b.lines - a.lines);

const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
const redFiles = red.flatMap((r) => r.files);
const byDir = new Map();
for (const g of grey) {
  const d = g.path.includes('/') ? g.path.slice(0, g.path.indexOf('/')) : '(src 顶层)';
  const cur = byDir.get(d) ?? { dir: d, files: 0, lines: 0 };
  cur.files += 1;
  cur.lines += g.lines;
  byDir.set(d, cur);
}
const greyDirs = [...byDir.values()].sort((a, b) => b.lines - a.lines);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        red: red.map((r) => ({ dir: r.dir, files: r.files })),
        redLines: sum(redFiles, 'lines'),
        green: { platform: greenPlatform, claimed: greenClaimed },
        grey: { files: grey.length, lines: sum(grey, 'lines'), byDir: greyDirs, list: listAll ? grey : grey.slice(0, TOP) },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log('# 插件归家三色对账（plugins/builtin-roster.json 的 impl/shared + 全仓导入图）\n');
console.log(`## 🔴 已认领却不在包内：${red.length} 个产物 / ${redFiles.length} 个实现文件 / ${sum(redFiles, 'lines')} 行`);
for (const r of red) {
  console.log(`- hologram/${r.dir}（${r.files.length} 件 / ${sum(r.files, 'lines')} 行）`);
  for (const f of r.files) console.log(`    ${f.imported ? ' ' : '·'} ${f.path}  ${f.lines} 行`);
}
console.log(
  '\n  销账纪律：实现搬进产物包 ⇒ 从名册该条目的 impl 删掉对应路径；impl 清空 = 该产物实心化。',
);
console.log(`\n## 🟢 平台白名单：${greenPlatform} 文件 · 已被产物认领的共享面：${greenClaimed} 文件`);
console.log('\n## ⚪ 灰区（无产物认领、也不在白名单）：' + `${grey.length} 文件 / ${sum(grey, 'lines')} 行`);
for (const d of greyDirs) console.log(`- ${d.dir.padEnd(16)} ${String(d.files).padStart(4)} 文件 ${String(d.lines).padStart(6)} 行`);
console.log(`\n  明细（前 ${listAll ? grey.length : Math.min(TOP, grey.length)} 条，按行数降序）：`);
for (const g of listAll ? grey : grey.slice(0, TOP)) console.log(`    ${String(g.lines).padStart(5)} 行  ${g.path}`);
if (grey.length > 0) {
  console.log('\n⚠ 灰区非空 = 「又有东西该拆」——需要一次归属判定（判定后：随产物归家，或写进该产物的 shared）。');
}

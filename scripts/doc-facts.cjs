// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 文档事实单一真源（文档面大重构 P0 · 立尺，2026-09-16）。
//
// 病症：同一个数字在 N 份文档里手抄，改了一处漏三处（实测先例：AgentConfig
// 字段数 28 已在 AGENTS/CLAUDE 更正，ARCHITECTURE×2 与根 README 仍写 31）。
// 治法与代码面同构：**抽出真源 + 门禁对拍**。本文件从代码真源解析出所有
// 「跨文档复述的标量事实」，供两处消费：
//   1. `docs/facts.generated.md`（生成物，doc-sync 逐字节对拍）；
//   2. `scripts/doc-check.cjs`（文档里的数字断言与真源对拍）。
//
// 纪律（CONVENTIONS §4）：L0/L1/L2 层文档**禁止手抄**这些数字——要么指向
// 本表，要么直接写指针。改真源 → 重跑本生成器 → 同 commit。
//
// 用法：node scripts/doc-facts.cjs [--check] [--json]
//   --check  只对拍 docs/facts.generated.md（漂移即非零退出，doc-sync 门禁用）
//   --json   打印机器可读事实表
// 新增事实 = 在 FACTS 表加一行（parse 里加一个解析函数）。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_REL = 'docs/facts.generated.md';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

/** 截取 `起点标记` 之后、首次出现的 `结束标记` 之前的内容。找不到即抛（不许静默空集）。 */
function slice(src, startMark, endMark, rel) {
  const i = src.indexOf(startMark);
  if (i < 0) throw new Error(`[doc-facts] ${rel} 未找到起点标记：${startMark}`);
  const j = src.indexOf(endMark, i + startMark.length);
  if (j < 0) throw new Error(`[doc-facts] ${rel} 未找到结束标记：${endMark}`);
  return src.slice(i + startMark.length, j);
}

/** Rust/TS 的 `&[&str] = &[ "a", "b" ]` 形态：数引号字符串。 */
function countQuotedItems(block) {
  return (block.match(/"[^"]+"/g) || []).length;
}

/** 每行一个标识符的列表形态（BUILTIN_PLUGINS）。 */
function countIdentifierLines(block) {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*\s*,?$/.test(l)).length;
}

// ── 解析器（每条事实一个；解析失败一律抛，不静默给 0）──────────────────────

function agentConfigFields() {
  const rel = 'src-ui/src/agent/runtime/types.ts';
  const src = read(rel);
  const block = slice(src, 'export interface AgentConfig {', '\n}', rel);
  // 与 src-ui/tests/convergence/gate.mjs 的计数口径逐字一致（T0 冻结断言）。
  return { value: (block.match(/^\s+[A-Za-z_][A-Za-z0-9_]*\??:/gm) || []).length, source: rel };
}

function builtinServicePlugins() {
  const rel = 'src-ui/src/plugins/loader.ts';
  const src = read(rel);
  const block = slice(src, 'export const BUILTIN_PLUGINS: LantaiPlugin[] = [', '\n];', rel);
  return { value: countIdentifierLines(block), source: rel };
}

function factoryProducts() {
  const rel = 'src-ui/src/plugins/builtin-roster.json';
  const roster = readJson(rel);
  if (!Array.isArray(roster)) throw new Error('[doc-facts] builtin-roster.json 不是数组');
  return { value: roster.length, source: rel };
}

function toolDomains() {
  const rel = 'src-ui/src/agent/tools/domains.ts';
  const src = read(rel);
  const block = slice(src, 'export const DOMAIN_SPECS: DomainSpec[] = [', '\n];', rel);
  // 域条目 = DOMAIN_SPECS 顶层对象的 `name: 'x',`（缩进 4 空格）。
  const names = [...block.matchAll(/^ {4}name: '([a-z0-9-]+)',$/gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error('[doc-facts] DOMAIN_SPECS 解析到零个域（形状变了？）');
  return { value: names.length, list: names, source: rel };
}

function openSurfaceContractVersion() {
  const rel = 'src-ui/src/composition/contract-version.ts';
  const m = read(rel).match(/OPEN_SURFACE_CONTRACT_VERSION\s*=\s*(\d+)/);
  if (!m) throw new Error('[doc-facts] 未解析到 OPEN_SURFACE_CONTRACT_VERSION');
  return { value: Number(m[1]), source: rel };
}

function engineContractVersion() {
  const rel = 'engine/src/contract.rs';
  const m = read(rel).match(/ENGINE_CONTRACT_VERSION:\s*u32\s*=\s*(\d+)/);
  if (!m) throw new Error('[doc-facts] 未解析到 ENGINE_CONTRACT_VERSION');
  return { value: Number(m[1]), source: rel };
}

function engineShellMethods() {
  const rel = 'engine/src/contract.rs';
  const block = slice(read(rel), 'pub const SHELL_METHODS: &[ShellMethodSpec] = &[', '\n];', rel);
  const count = (block.match(/ShellMethodSpec\s*\{/g) || []).length;
  if (count === 0) throw new Error('[doc-facts] SHELL_METHODS 解析到零个方法');
  return { value: count, source: rel };
}

function engineDefaultTools() {
  const rel = 'engine/src/tools/mod.rs';
  const block = slice(read(rel), 'pub const DEFAULT_MCP_TOOLS: &[&str] = &[', '\n    ];', rel);
  const count = countQuotedItems(block);
  if (count === 0) throw new Error('[doc-facts] DEFAULT_MCP_TOOLS 解析到零个工具');
  return { value: count, source: rel };
}

/** 引擎模型可见默认工具数（契约 v5）= 域数 + 未折叠的默认工具数。 */
function engineVisibleTools() {
  const rel = 'engine/src/tools/mod.rs';
  const src = read(rel);
  const domainBlock = slice(src, 'pub const DOMAIN_SPECS: &[DomainSpec] = &[', '\n];', rel);
  const domains = (domainBlock.match(/DomainSpec\s*\{/g) || []).length;
  const folded = new Set(
    [...domainBlock.matchAll(/DomainAction \{ action: "[a-z_]+", tool: "([a-z_]+)"/g)].map((m) => m[1]),
  );
  const defaultBlock = slice(src, 'pub const DEFAULT_MCP_TOOLS: &[&str] = &[', '\n    ];', rel);
  const standalone = [...defaultBlock.matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1])
    .filter((t) => !folded.has(t));
  if (domains === 0 || standalone.length === 0) {
    throw new Error('[doc-facts] DOMAIN_SPECS / 未折叠默认工具解析失效');
  }
  return { value: domains + standalone.length, source: rel };
}

// ── 事实表 ────────────────────────────────────────────────────────────────

const FACTS = [
  { id: 'agent_config_fields', label: 'AgentConfig 冻结字段数', parse: agentConfigFields },
  { id: 'builtin_service_plugins', label: '内核插件数（BUILTIN_PLUGINS 表）', parse: builtinServicePlugins },
  { id: 'factory_products', label: '出厂产物数（builtin-roster.json）', parse: factoryProducts },
  { id: 'tool_domains', label: '兰台应用侧域工具数（src-ui DOMAIN_SPECS）', parse: toolDomains },
  { id: 'open_surface_contract_version', label: '开放面契约版本', parse: openSurfaceContractVersion },
  { id: 'engine_contract_version', label: '引擎开放面契约版本', parse: engineContractVersion },
  { id: 'engine_shell_methods', label: '引擎壳专属方法数', parse: engineShellMethods },
  { id: 'engine_visible_tools', label: '引擎模型可见默认工具数（域 + 未折叠）', parse: engineVisibleTools },
  {
    id: 'engine_default_tools',
    label: '引擎可寻址工具数（DEFAULT_MCP_TOOLS，tools/call 原名）',
    parse: engineDefaultTools,
  },
];

function collectFacts() {
  const facts = new Map();
  for (const spec of FACTS) {
    const { value, list, source } = spec.parse();
    facts.set(spec.id, { id: spec.id, label: spec.label, value, list, source });
  }
  // 派生事实：第一方插件总数 = 内核 + 出厂产物（first-party-manifest.ts 头注口径）。
  const services = facts.get('builtin_service_plugins');
  const products = facts.get('factory_products');
  facts.set('first_party_plugins', {
    id: 'first_party_plugins',
    label: '第一方插件总数（内核 + 出厂产物）',
    value: services.value + products.value,
    source: `${services.source} + ${products.source}`,
  });
  return facts;
}

// ── 渲染 ──────────────────────────────────────────────────────────────────

function render(facts) {
  const rows = [...facts.values()].map(
    (f) => `| \`${f.id}\` | ${f.label} | **${f.value}** | \`${f.source}\` |`,
  );
  const domainList = facts.get('tool_domains').list.map((d) => `\`${d}\``).join(' · ');
  return `# 文档事实单一真源（生成物，勿手改）

<!-- 生成：node scripts/doc-facts.cjs ｜ 门禁：npm run doc-check（--check 逐字节对拍） -->

> 本表是**跨文档复述的标量事实**的唯一权威。L0/L1/L2 层文档禁止手抄下表数字——
> 要么指向本表（\`docs/facts.generated.md\`），要么直接写指针（真源文件）。
> 改真源 → 重跑 \`node scripts/doc-facts.cjs\` → 同 commit（doc-sync 门禁对拍）。

| 事实 id | 含义 | 值 | 真源 |
|---|---|---|---|
${rows.join('\n')}

## 域工具清单（\`tool_domains\` 的展开）

${domainList}

> 域清单 = \`DOMAIN_SPECS\` 顶层 \`name\` 序（注册序 = 可见面构造序，属字节契约）。
> 已退役域（\`graph\` / \`ops\` / \`lsp\` 等，2026-09-09 图谱全量退役）不得再以现状口吻出现。
`;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const facts = collectFacts();

  if (args.includes('--json')) {
    const obj = {};
    for (const [k, v] of facts) obj[k] = { value: v.value, list: v.list, source: v.source };
    console.log(JSON.stringify(obj, null, 2));
    return 0;
  }

  const content = render(facts);
  const outPath = path.join(ROOT, OUT_REL);

  if (args.includes('--check')) {
    let existing = '';
    try {
      existing = fs.readFileSync(outPath, 'utf8');
    } catch {
      console.error(`[doc-facts] 缺少 ${OUT_REL}——先跑 node scripts/doc-facts.cjs`);
      return 1;
    }
    if (existing.replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')) {
      console.error(`[doc-facts] ${OUT_REL} 已漂移（真源变了或手改过）——重跑 node scripts/doc-facts.cjs`);
      return 1;
    }
    console.log(`[ok] doc-facts：${OUT_REL} 与代码真源一致（${facts.size} 条事实）`);
    return 0;
  }

  fs.writeFileSync(outPath, content);
  console.log(`[doc-facts] 写入 ${OUT_REL}（${facts.size} 条事实）`);
  for (const f of facts.values()) console.log(`  ${f.id} = ${f.value}  ← ${f.source}`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { collectFacts, FACTS, ROOT };

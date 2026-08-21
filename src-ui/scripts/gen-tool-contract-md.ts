// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 从 ToolRegistry 装配产物生成模型可见工具面文档（C1，agent-plugin-architecture-plan §3 P1）。
// 用法：node scripts/gen-tool-contract-md.cjs [--check]（根目录薄壳转发到本文件，经 tsx 运行）。
// 纪律：
//   - md 是生成物，勿手改；工具面变更后重新运行本脚本并同 commit。
//   - 输出不含时间戳——字节稳定是 --check 守护的前提（gen-rpc-contract-md 嵌时间戳，
//     此处刻意偏离，原因见 docs/plans/agent-plugin-architecture-plan.md P1 记录）。
//   - 领域折叠形态保持（D2）：文档按「域工具 + action 枚举」呈现，不摊平细粒度工具。
// 装配路径与 tests/convergence/helpers/fixtures.ts 的 buildStandardRegistry 同源：
// 真实 buildToolRegistry 生产行表 + 确定性夹具依赖（无 Tauri bridge；
// hologram 动态 schema 在此环境恒返回空集，引擎侧工具面由 Rust 测试守护）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Tool } from '../src/agent/tool';
import type { SubAgentSpawner } from '../src/agent/tools/subagent';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..', '..');
const OUT_MD = path.join(ROOT, 'docs', 'agents', 'model-tool-contract.md');

// 最小运行环境垫片：src/ 模块树在浏览器/Tauri 里加载，部分模块顶层摸
// window（bridge.ts 的 IS_TAURI 探测等）。vitest 靠 jsdom 环境供这些全局；
// 本脚本走纯 node + tsx，装配路径不触 UI，空对象垫片足够。必须在动态
// import 之前就位（ESM 值导入提升，所以源模块一律经下方 main() 动态加载）。
type RecordAny = Record<string, unknown>;
const g = globalThis as unknown as RecordAny;
g.window ??= {};
g.document ??= { createElement: () => ({ style: {} }) };
g.navigator ??= { userAgent: 'node' };

interface JsonProp {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: { type?: string };
}
interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonProp>;
  required?: string[];
}

/** 与 convergence fixtures 的 buildStandardRegistry 相同的确定性依赖。 */
async function buildStandardRegistry() {
  const [{ SubAgentPool }] = await Promise.all([import('../src/agent/coordinator')]);
  const { buildToolRegistry } = await import('../src/agent/runtime/agent-builder');
  const { TaskManager } = await import('../src/agent/task');
  const stubSpawner = (async () => 'stub-spawn-result') as unknown as SubAgentSpawner;
  return buildToolRegistry({
    graphData: { nodes: [], edges: [] },
    deps: {},
    taskManager: new TaskManager(),
    subAgentPool: new SubAgentPool(),
    subAgentSpawner: stubSpawner,
  });
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function propType(p: JsonProp): string {
  if (p.enum && Array.isArray(p.enum)) {
    const vals = p.enum.map((v) => `\`${String(v)}\``).join(' / ');
    return vals.length > 120 ? `${p.type ?? 'string'}（枚举见 action 表/描述）` : vals;
  }
  let t = p.type ?? 'unknown';
  if (t === 'array' && p.items?.type) t += `\\<${p.items.type}\\>`;
  return t;
}

function renderToolSection(t: Tool): string {
  const name = t.name();
  const desc = t.description().trim();
  const schema = (t.parameters() ?? {}) as JsonSchema;
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const actions = t.actions?.() ?? [];
  const roActions = t.readOnlyActions?.() ?? [];

  let md = `### \`${name}\`\n\n`;
  for (const line of desc.split(/\r?\n/)) md += `> ${line}\n`;
  md += '\n';
  const flags: string[] = [`只读：${t.readOnly() ? '是' : '否'}`];
  if (t.domain?.()) flags.push(`域：\`${t.domain()}\``);
  if (actions.length > 0) {
    flags.push(`action 枚举（${actions.length}）：${actions.map((a) => `\`${a}\``).join(' · ')}`);
  }
  if (roActions.length > 0) {
    flags.push(`只读 action：${roActions.map((a) => `\`${a}\``).join(' · ')}`);
  }
  for (const f of flags) md += `- ${f}\n`;
  md += '\n';
  if (props.length > 0) {
    md += '| 参数 | 必选 | 类型 | 说明 |\n|------|------|------|------|\n';
    for (const [key, p] of props) {
      const d = p.description ? esc(p.description.trim()) : '—';
      md += `| \`${key}\` | ${required.has(key) ? '✓' : '—'} | ${propType(p)} | ${d} |\n`;
    }
    md += '\n';
  }
  return md;
}

async function generate(): Promise<string> {
  const registry = await buildStandardRegistry();
  const visible = registry.visibleTools();
  const visibleNames = new Set(visible.map((t) => t.name()));
  const hidden = registry.names().filter((n) => !visibleNames.has(n));

  let md = '# 模型可见工具面契约（生成物）\n\n';
  md += '> 由 `scripts/gen-tool-contract-md.cjs`（经 tsx 运行 `src-ui/scripts/gen-tool-contract-md.ts`）\n';
  md += '> 从 `buildToolRegistry` 出厂行表装配产物生成 — 勿手改；工具面变更后重新生成并同 commit。\n';
  md += '> 本文档不含时间戳：字节稳定是 `--check` 构建守护的前提。\n\n';
  md += `可见工具 ${visible.length} 个（域折叠形态 + 常驻件）；隐藏旧名 ${hidden.length} 个（附录）。\n\n`;
  md += '装配说明：标准注册表 = composition 行表出厂序；hologram 动态族（graph/ops/lsp 引擎侧\n';
  md += 'schema）在本生成环境（无 Tauri bridge / 无引擎连接）恒为空集，引擎侧工具面以引擎\n';
  md += '`HOLOGRAM_MCP_TOOLS` 清单与 Rust 测试为准。\n';
  md += '范围说明：会话级 capability 工具（Skill / enter_exit_plan_mode / 通信族等）经 blueprint\n';
  md += '在会话装配期追加，不在本文档（其契约由 convergence phase 快照钉住）；本文档覆盖\n';
  md += 'buildToolRegistry 装配产物，与 tool-schemas.full.json 同范围。\n\n';
  md += '## 可见面总览\n\n';
  md += '| 工具 | 只读 | 动作数 | 说明（首行） |\n|------|------|--------|--------------|\n';
  for (const t of visible) {
    const actions = t.actions?.() ?? [];
    const firstLine = esc(t.description().trim().split(/\r?\n/)[0] || '');
    md += `| [\`${t.name()}\`](#${t.name()}) | ${t.readOnly() ? '✓' : '—'} | ${actions.length || '—'} | ${firstLine} |\n`;
  }
  md += '\n## 工具明细\n\n';
  for (const t of visible) md += renderToolSection(t);
  md += '## 附录：隐藏旧名（hide + retireRedirect）\n\n';
  md += '以下细粒度旧名已从模型可见面隐藏，运行时调用会被 `retireRedirect` 拦截并给出重定向提示；\n';
  md += '内部代码/测试仍可经 `registry.get(name)` 解析。新代码不得重新暴露：\n\n';
  md += hidden.map((n) => `\`${n}\``).join(' · ') + '\n';
  return md;
}

/** 供守护测试（tests/tool-contract-doc.test.ts）直接调用：重生成内容与已提交 md 对拍。 */
export const buildContractMarkdown = generate;

async function main() {
  const check = process.argv.includes('--check');
  const md = await generate();
  if (check) {
    if (!existsSync(OUT_MD)) {
      console.error(`[tool-contract] 缺生成物：${OUT_MD}（先运行 npm run gen:tool-contract）`);
      process.exit(1);
    }
    const current = readFileSync(OUT_MD, 'utf8');
    if (current !== md) {
      console.error('[tool-contract] 工具面已漂移而文档未再生成 —— 运行 npm run gen:tool-contract 并同 commit');
      process.exit(1);
    }
    console.log('[ok] model-tool-contract.md 与装配产物一致');
    return;
  }
  writeFileSync(OUT_MD, md, 'utf8');
  console.log(`[ok] model-tool-contract.md written (${md.length} chars)`);
}

// 被 vitest import 时只提供导出，不执行 CLI 主流程。
if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

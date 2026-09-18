// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT
//
// 引擎开放面契约文档生成（engine-plugin-extraction Phase 0）。
// 用法：node scripts/gen-engine-plugin-contract.cjs [--check]（根目录薄壳转发到本文件，经 tsx 运行）。
// 纪律：
//   - md 是生成物，勿手改；契约面变更后重新运行本脚本并同 commit。
//   - 输出不含时间戳——字节稳定是 --check 守护的前提。
// 真源：engine/src/contract.rs（版本 + 壳专属方法清单）、engine/src/tools/mod.rs（模型工具面）。
// GraphJSON 数据契约的权威源 = engine/src/tools/mod.rs 的 graph_snapshot_value
// （2026-09-09 图谱退役：兰台侧 scene/graph-types.ts TS 镜像整删——引擎回归纯
// MCP 供外部消费，GraphJSON 形状真源只剩引擎侧 Rust 实现）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..', '..');
const OUT_MD = path.join(ROOT, 'docs', 'agents', 'engine-plugin-contract.md');
const CONTRACT_RS = path.join(ROOT, 'engine', 'src', 'contract.rs');
const TOOLS_RS = path.join(ROOT, 'engine', 'src', 'tools', 'mod.rs');

function parseContractVersion(src: string): number {
  const m = src.match(/ENGINE_CONTRACT_VERSION:\s*(?:u32\s*=\s*)?(\d+)/);
  return m ? Number(m[1]) : NaN;
}

function parseShellMethods(
  src: string,
): Array<{ name: string; description: string; params: string[]; readOnly: boolean; wiredIn: string }> {
  const start = src.indexOf('pub const SHELL_METHODS');
  if (start < 0) return [];
  const end = src.indexOf('\n];', start);
  const block = src.slice(start, end < 0 ? src.length : end);
  const parts = block.split('    ShellMethodSpec {\n').slice(1);
  const out: Array<{ name: string; description: string; params: string[]; readOnly: boolean; wiredIn: string }> = [];
  for (const part of parts) {
    const name = part.match(/^\s+name: "([a-z_]+)",/m)?.[1];
    if (!name) continue;
    const description = part.match(/^\s+description: "([^"]*)",/m)?.[1] ?? '';
    const params: string[] = [];
    for (const pm of part.matchAll(/ShellParam \{ name: "([a-z_]+)", ptype: "([a-z_]+)", description: "([^"]*)" \}/g)) {
      params.push(pm[1] + ' (' + pm[2] + ')');
    }
    const readOnly = /read_only: (true|false)/.exec(part)?.[1] === 'true';
    const wiredIn = part.match(/wired_in: "([^"]+)"/)?.[1] ?? '';
    out.push({ name, description, params, readOnly, wiredIn });
  }
  return out;
}

function parseModelDefaults(src: string): string[] {
  const defMatch = src.match(/DEFAULT_MCP_TOOLS:\s*&\[\s*&str\s*\]\s*=\s*&\[([\s\S]*?)\];/);
  return defMatch ? [...defMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
}

interface ParsedDomain {
  name: string;
  readOnly: boolean;
  actions: Array<{ action: string; tool: string; hint: string }>;
}

/** 解析出厂域表（契约 v5：DOMAIN_SPECS = 模型可见面的折叠单元）。 */
function parseDomains(src: string): ParsedDomain[] {
  const start = src.indexOf('pub const DOMAIN_SPECS');
  if (start < 0) return [];
  const end = src.indexOf('\n];', start);
  const block = src.slice(start, end < 0 ? src.length : end);
  const out: ParsedDomain[] = [];
  for (const part of block.split('DomainSpec {').slice(1)) {
    const name = part.match(/^\s*name: "([a-z_]+)",/m)?.[1];
    if (!name) continue;
    const readOnly = /read_only: (true|false)/.exec(part)?.[1] === 'true';
    const actions = [...part.matchAll(/DomainAction \{ action: "([a-z_]+)", tool: "([a-z_]+)", hint: "([^"]*)"/g)].map(
      (m) => ({
        action: m[1],
        tool: m[2],
        hint: m[3],
      }),
    );
    out.push({ name, readOnly, actions });
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function main(): void {
  const check = process.argv.includes('--check');
  if (!existsSync(CONTRACT_RS) || !existsSync(TOOLS_RS)) {
    console.error('[engine-plugin-contract] 找不到引擎源文件（engine/src/contract.rs / tools/mod.rs）');
    process.exit(1);
  }
  const contractSrc = readFileSync(CONTRACT_RS, 'utf8');
  const toolsSrc = readFileSync(TOOLS_RS, 'utf8');
  const version = parseContractVersion(contractSrc);
  const methods = parseShellMethods(contractSrc);
  const modelTools = parseModelDefaults(toolsSrc);
  const domains = parseDomains(toolsSrc);
  const foldedTools = new Set(domains.flatMap((d) => d.actions.map((a) => a.tool)));
  const standalone = modelTools.filter((t) => !foldedTools.has(t));
  const surfaceCount = domains.length + standalone.length;
  // GraphJSON 权威源是否在引擎源码里可证（graph_snapshot_value 聚合函数）
  const graphJsonAuthorityOk = toolsSrc.includes('pub fn graph_snapshot_value');

  if (!Number.isInteger(version) || version <= 0) {
    console.error('[engine-plugin-contract] 契约版本缺失或非法');
    process.exit(1);
  }
  if (methods.length === 0) {
    console.error('[engine-plugin-contract] 壳专属方法清单为空——解析失效');
    process.exit(1);
  }
  if (domains.length === 0) {
    console.error('[engine-plugin-contract] 域表解析为空——契约 v5 起 DOMAIN_SPECS 是模型可见面真源');
    process.exit(1);
  }

  const md: string[] = [];
  md.push('# 引擎开放面契约（Engine Plugin Contract）');
  md.push('');
  md.push(
    '> 生成物（勿手改）。真源：`engine/src/contract.rs`（版本 + 壳专属方法清单）、`engine/src/tools/mod.rs`（域表 + 可寻址工具面）。',
  );
  md.push(
    '> 重新生成：`node scripts/gen-engine-plugin-contract.cjs`（根目录薄壳）或 `npm run gen:engine-contract`（src-ui）。',
  );
  md.push(
    '> 契约面文件变更 → 必须升 `ENGINE_CONTRACT_VERSION` + 重新生成本文档 + 同步 `src-ui/tests/engine-contract.test.ts` 的 `EXPECTED_SHELL_METHODS`，同 commit。',
  );
  md.push('');
  md.push('## 契约版本');
  md.push('');
  md.push('| 项 | 值 |');
  md.push('|---|---|');
  md.push('| 当前版本 | ' + version + ' |');
  md.push(
    '| 模型可见工具数（`tools/list` 缺省面） | ' +
      surfaceCount +
      '（' +
      domains.length +
      ' 域 + ' +
      standalone.length +
      ' 未折叠） |',
  );
  md.push('| 可寻址工具数（`tools/call` 原名直达） | ' + modelTools.length + ' |');
  md.push('| 壳专属方法数 | ' + methods.length + ' |');
  md.push(
    '| GraphJSON 权威源 | engine/src/tools/mod.rs `graph_snapshot_value`' +
      (graphJsonAuthorityOk ? '' : '（⚠️ 缺失）') +
      ' |',
  );
  md.push('');
  md.push('## 模型可见默认工具面（tools/list 默认返回，契约 v6 起恒定）');
  md.push('');
  md.push('### 域工具（只读工具折叠为 `域 + action` 调用面）');
  md.push('');
  md.push('| 域 | 只读 | 动作 → 原名 |');
  md.push('|---|---|---|');
  for (const d of domains) {
    const acts = d.actions.map((a) => '`' + a.action + '`→`' + a.tool + '`').join('，');
    md.push('| `' + d.name + '` | ' + (d.readOnly ? '✓' : '—') + ' | ' + esc(acts) + ' |');
  }
  md.push('');
  md.push('调用形态：`tools/call {"name":"graph","arguments":{"action":"impact","nodeId":"…"}}`。');
  md.push('每个域另带保留动作 `action:"help"` —— 回该域全部动作的完整说明书');
  md.push('（完整 description / 参数表 / required，取自 `ToolSchema` 单一真源）。');
  md.push('折叠**无损**：原文只是从常驻上下文挪到按需一问。');
  md.push('');
  md.push('### 动作路由提示（模型实际看到的迷你说明书）');
  md.push('');
  for (const d of domains) {
    md.push('**`' + d.name + '`**');
    md.push('');
    for (const a of d.actions) {
      md.push('- `' + a.action + '`（`' + a.tool + '`）：' + esc(a.hint));
    }
    md.push('');
  }
  md.push('### 未折叠工具（写操作留在顶层）');
  md.push('');
  md.push(standalone.map((t) => '`' + t + '`').join(' · '));
  md.push('');
  md.push('## 可寻址工具面（折叠不改可达性）');
  md.push('');
  md.push('下列原名全部保留 schema，`tools/call` 可按原名直达（壳与外部 MCP 客户端零破坏）：');
  md.push('');
  md.push(modelTools.map((t) => '`' + t + '`').join(' · '));
  md.push('');
  md.push('> 可见面**无档位开关**：`HOLOGRAM_MCP_TOOLS` 已随契约 v6 退役（它当初用于裁剪 36 个');
  md.push('> 扁平工具的可见面，折叠后用途消失，且没有任何宿主通道能设它）。设了不再生效，');
  md.push('> 引擎只在日志留一条 warn。');
  md.push('');
  md.push('## 壳专属方法（host API，永不进模型 tools/list）');
  md.push('');
  md.push('| 方法 | 说明 | 读写 | 接线阶段 |');
  md.push('|---|---|---|---|');
  for (const m of methods) {
    md.push(
      '| `' + m.name + '` | ' + esc(m.description) + ' | ' + (m.readOnly ? '只读' : '写') + ' | ' + m.wiredIn + ' |',
    );
  }
  md.push('');
  md.push('### 壳专属方法参数');
  md.push('');
  md.push('| 方法 | 参数 |');
  md.push('|---|---|');
  for (const m of methods) {
    if (m.params.length === 0) {
      md.push('| `' + m.name + '` | （无参数） |');
    } else {
      md.push('| `' + m.name + '` | ' + m.params.join('，') + ' |');
    }
  }
  md.push('');
  md.push('## 消费方式');
  md.push('');
  md.push('引擎以 `hologram-engine serve`（stdio MCP）或 TCP 9777 暴露同一契约面。');
  md.push('兰台（Phase 3 起）与 DSH（hologram-dsh）经 stdio MCP 消费；Unity 等外部客户端走 TCP 9777 数据面。');
  md.push('壳专属方法经 `tools/call` 调用（与模型工具同一注册面），但 `tools/list` 永不返回它们。');
  md.push('');

  const output = md.join('\n') + '\n';
  if (check) {
    const existing = existsSync(OUT_MD) ? readFileSync(OUT_MD, 'utf8') : '';
    if (existing !== output) {
      console.error('[engine-plugin-contract] 文档漂移——请运行 node scripts/gen-engine-plugin-contract.cjs 重新生成');
      process.exit(1);
    }
    console.log('[engine-plugin-contract] 文档一致 ✓');
    return;
  }
  writeFileSync(OUT_MD, output, 'utf8');
  console.log('[engine-plugin-contract] 已生成 ' + path.relative(ROOT, OUT_MD));
}

main();

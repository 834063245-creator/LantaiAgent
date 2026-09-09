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

  const md: string[] = [];
  md.push('# 引擎开放面契约（Engine Plugin Contract）');
  md.push('');
  md.push(
    '> 生成物（勿手改）。真源：`engine/src/contract.rs`（版本 + 壳专属方法清单）、`engine/src/tools/mod.rs`（模型工具面）。',
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
  md.push('| 模型可见默认工具数 | ' + modelTools.length + ' |');
  md.push('| 壳专属方法数 | ' + methods.length + ' |');
  md.push(
    '| GraphJSON 权威源 | engine/src/tools/mod.rs `graph_snapshot_value`' +
      (graphJsonAuthorityOk ? '' : '（⚠️ 缺失）') +
      ' |',
  );
  md.push('');
  md.push('## 模型可见默认工具面（tools/list 默认返回）');
  md.push('');
  md.push(modelTools.map((t) => '`' + t + '`').join(' · '));
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

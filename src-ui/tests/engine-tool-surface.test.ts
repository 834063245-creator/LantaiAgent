// 引擎工具面 ↔ Agent 工具面 防漂移契约（2026-08 工具面迭代）。
//
// 背景：引擎 all_schemas() 与 DOMAIN_SPECS / mock-data.ts 之间靠人肉同步，
// 已发生过 mock 静默缺 5 个工具（flows 三件套 / grpc_services / import_scip）的
// 真实漂移；引擎再新增工具若漏接 DOMAIN_SPECS，会以裸名直接漏到模型面前，
// 违反「工具一律用领域名」的收敛契约且无任何测试变红。
// 本测试直接解析 engine/src/tools/mod.rs 源码提取权威清单（不维护第二份
// fixture——fixture 本身就是新的漂移点），钉住三层对齐：
//   1. 引擎默认 MCP 工具 ⊆ DOMAIN_SPECS 动作值（防裸名漏出）；
//   2. graph/ops/lsp 域动作值 ⊆ 引擎 schema ∪ TS 桥接白名单（防引擎删工具后动作悬空）；
//   3. mock-data 的 hologram_tools_list 与引擎默认清单一致（浏览器 dev 模式工具面保真）。
// 注：收敛基线（tests/convergence）在无 Tauri 的测试环境里引擎 schema 恒为空，
// 只覆盖静态注册面——引擎↔领域的这层对齐此前无人守护，由本文件补上。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOMAIN_SPECS } from '../src/agent/tools/domains';
import { mockInvoke } from '../src/mock-data';

// vitest cwd = src-ui（对齐 convergence specs 的 readAgentSource 惯例）
const ENGINE_TOOLS_RS = join(process.cwd(), '..', 'engine', 'src', 'tools', 'mod.rs');

/** graph/ops/lsp 三个纯引擎域 —— 动作值应全部能在引擎 schema 里解析到。 */
const ENGINE_DOMAINS = new Set(['graph', 'ops', 'lsp']);

/** 桥接白名单：注册进引擎域、但由 TS 侧提供（非引擎 schema）的工具。
 *  新增条目必须在此登记并写明缘由 —— 白名单的存在本身就是防漂移的一部分。 */
const TS_BRIDGE_IN_ENGINE_DOMAINS = new Set([
  'dataflow_save', // Tauri RPC（保存追踪到 .hologram/dataflow/），2026-08 收敛进 graph 域
  'dataflow_query', // 同上
]);

function parseEngineTools(): { all: string[]; defaults: string[] } {
  const src = readFileSync(ENGINE_TOOLS_RS, 'utf8');
  // ToolSchema 条目形如：name: "explore_deps",（dispatch 的 match 臂是 "x" => ...，不会误匹配）
  const all = [...src.matchAll(/^\s+name:\s*"([a-z_]+)",\s*$/gm)].map((m) => m[1]);
  const defMatch = src.match(/DEFAULT_MCP_TOOLS:\s*&\[\s*&str\s*\]\s*=\s*&\[([\s\S]*?)\];/);
  const defaults = defMatch ? [...defMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
  return { all, defaults };
}

describe('引擎工具面 ↔ Agent 工具面 防漂移', () => {
  const { all, defaults } = parseEngineTools();
  const engineNames = new Set(all);
  const mappedOldNames = new Set(DOMAIN_SPECS.flatMap((s) => Object.values(s.actions)));

  it('能从 engine/src/tools/mod.rs 解析出非空清单（解析失效时本套件整体失效）', () => {
    expect(all.length).toBeGreaterThanOrEqual(35);
    expect(defaults.length).toBeGreaterThanOrEqual(35);
    // 默认清单必须是全量 schema 的子集
    for (const d of defaults) expect(engineNames.has(d), d).toBe(true);
  });

  it('引擎默认 MCP 工具全部映射进 DOMAIN_SPECS（防裸名工具漏到模型面前）', () => {
    const unmapped = defaults.filter((n) => !mappedOldNames.has(n));
    expect(unmapped).toEqual([]);
  });

  it('graph/ops/lsp 域动作值存在于引擎 schema 或 TS 桥接白名单（防动作悬空）', () => {
    for (const spec of DOMAIN_SPECS.filter((s) => ENGINE_DOMAINS.has(s.name))) {
      for (const oldName of Object.values(spec.actions)) {
        const ok = engineNames.has(oldName) || TS_BRIDGE_IN_ENGINE_DOMAINS.has(oldName);
        expect(ok, `${spec.name}(${oldName}) 无法在引擎 schema 解析`).toBe(true);
      }
    }
  });

  it('旧工具名跨域唯一映射（retireRedirect / 门禁解析不允许歧义）', () => {
    const seen = new Map<string, string>();
    for (const spec of DOMAIN_SPECS) {
      for (const [action, oldName] of Object.entries(spec.actions)) {
        const prev = seen.get(oldName);
        expect(prev, `${oldName} 同时映射到 ${prev} 与 ${spec.name}(${action})`).toBeUndefined();
        seen.set(oldName, `${spec.name}(${action})`);
      }
    }
  });

  it('mock hologram_tools_list 与引擎默认清单一致（浏览器 dev 模式保真）', () => {
    const raw = mockInvoke('hologram_tools_list', {});
    const mockNames = (JSON.parse(raw) as Array<{ name: string }>).map((t) => t.name);
    expect(mockNames.length).toBe(new Set(mockNames).size);
    expect([...mockNames].sort()).toEqual([...defaults].sort());
  });

  it('semantic_search 已一等接线（graph.semantic）', () => {
    const graph = DOMAIN_SPECS.find((s) => s.name === 'graph');
    expect(graph?.actions.semantic).toBe('semantic_search');
    expect(defaults).toContain('semantic_search');
  });
});

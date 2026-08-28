// 引擎开放面契约 guard（engine-plugin-extraction Phase 0，2026-08-29）。
// 直接解析 engine/src/contract.rs（版本 + 壳专属方法清单）与 tools/mod.rs（模型工具面），
// 钉住：① 契约版本存在且 >0；② 壳专属方法清单非空、名字唯一、含预期方法；
// ③ 壳专属方法与模型默认工具零冲突（壳方法永不漏到模型面前）。
// 契约面文件的变更 → 必须升 ENGINE_CONTRACT_VERSION + 同步本测试的 EXPECTED_SHELL_METHODS。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest cwd = src-ui（对齐 engine-tool-surface.test.ts 的惯例）
const ENGINE_ROOT = join(process.cwd(), '..', 'engine');
const CONTRACT_RS = join(ENGINE_ROOT, 'src', 'contract.rs');
const TOOLS_RS = join(ENGINE_ROOT, 'src', 'tools', 'mod.rs');

/** 预期壳专属方法（Phase 0 契约定稿；新增方法必须在 contract.rs 与本清单双登记）。 */
const EXPECTED_SHELL_METHODS = [
  'get_graph_page',
  'graph_meta',
  'get_full_graph',
  'analyze_with_progress',
  'save',
  'fts_search',
  'timeline_record',
  'diff',
  'ensure_ready',
  'cache_stale',
  'watcher_subscribe',
];

function parseContract(): { version: number; shellMethods: string[] } {
  const src = readFileSync(CONTRACT_RS, 'utf8');
  const versionMatch = src.match(/ENGINE_CONTRACT_VERSION:\s*(?:u32\s*=\s*)?(\d+)/);
  const version = versionMatch ? Number(versionMatch[1]) : NaN;
  // 壳方法 name 行 = 8 空格缩进（ShellMethodSpec 层）；ShellParam 的 name 在同一行（12 空格起），不匹配。
  const shellMethods = [...src.matchAll(/^ {8}name: "([a-z_]+)",\s*$/gm)].map((m) => m[1]);
  return { version, shellMethods };
}

function parseModelDefaults(): string[] {
  const src = readFileSync(TOOLS_RS, 'utf8');
  const defMatch = src.match(/DEFAULT_MCP_TOOLS:\s*&\[\s*&str\s*\]\s*=\s*&\[([\s\S]*?)\];/);
  return defMatch ? [...defMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
}

describe('引擎开放面契约（engine-plugin-extraction Phase 0）', () => {
  const { version, shellMethods } = parseContract();
  const modelTools = new Set(parseModelDefaults());

  it('契约版本存在且为正整数', () => {
    expect(Number.isInteger(version)).toBe(true);
    expect(version).toBeGreaterThan(0);
  });

  it('壳专属方法清单非空且名字唯一', () => {
    expect(shellMethods.length).toBeGreaterThan(0);
    expect(new Set(shellMethods).size).toBe(shellMethods.length);
  });

  it('壳专属方法清单与契约定稿一致（新增方法双登记）', () => {
    for (const expected of EXPECTED_SHELL_METHODS) {
      expect(shellMethods, `缺少预期壳方法 ${expected}`).toContain(expected);
    }
    // 反向：契约文件里多出的方法也要在定稿登记里（防漏登记漂移）
    for (const m of shellMethods) {
      expect(EXPECTED_SHELL_METHODS, `契约有未登记壳方法 ${m}`).toContain(m);
    }
  });

  it('壳专属方法与模型默认工具零冲突（壳方法永不漏到模型面前）', () => {
    for (const m of shellMethods) {
      expect(modelTools.has(m), `${m} 与模型工具冲突`).toBe(false);
    }
  });

  it('模型默认工具面已由 engine-tool-surface.test.ts 钉住（此处确认非空）', () => {
    expect(modelTools.size).toBeGreaterThanOrEqual(35);
  });
});

import { describe, expect, it } from 'vitest';
import type { ToolExecutor } from '../src/agent/tool';
import { builtinToolRows } from '../src/composition/tool-rows';

// ── S1-2 行表自检：已迁族（fs、shell）──
// 行表是 standard preset 装配序的事实来源（表序 = 组合序）。这里钉住：
//   1. 行 id 唯一且稳定（未来 preset 按 id 引用行）；
//   2. fs 行产出 = 迁移前 createCodingTools 内的现行表序（机械重述）；
//   3. 行 factory 无共享可变状态（多次装配互不串扰）；
//   4. 经 buildToolRegistry 真实装配后 fs 细粒度名全部在册
//      （重名会被 ToolRegistry.register 装载期拒绝——双注册路径会直接炸）。
// 可见面零漂移由 verify:convergence 守护（S1 设计件 §2.4），此处不重复。

const exec: ToolExecutor = async () => '';

/** fs 族现行表序 = 迁移前 createCodingTools 内的声明序（机械重述基准）。 */
const FS_TOOL_ORDER = [
  'read_file_content',
  'write_file',
  'edit_file',
  'list_directory',
  'read_constraints',
  'write_constraints',
  'glob',
  'delete_file',
  'create_directory',
  'move_file',
  'rename_file',
];

/** shell 族现行表序（run_shell → bash_output/kill/wait）。 */
const SHELL_TOOL_ORDER = ['run_shell', 'bash_output', 'bash_kill', 'bash_wait'];

describe('composition/tool-rows（S1-2 行表）', () => {
  it('行 id 唯一且稳定，表序 = 组合序（fs → shell）', () => {
    const ids = builtinToolRows().map((r) => r.id);
    expect(ids).toEqual(['builtin/fs', 'builtin/shell']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fs 行产出 11 个细粒度工具，序 = 迁移前现行表序', () => {
    const [fsRow] = builtinToolRows(); // 表形状由上一测试钉住
    expect(fsRow.id).toBe('builtin/fs');
    const names = fsRow.factory({ codingExec: exec }).map((t) => t.name());
    expect(names).toEqual(FS_TOOL_ORDER);
  });

  it('shell 行产出 4 个细粒度工具，序 = 迁移前现行表序', () => {
    const [, shellRow] = builtinToolRows();
    expect(shellRow.id).toBe('builtin/shell');
    const names = shellRow.factory({ codingExec: exec }).map((t) => t.name());
    expect(names).toEqual(SHELL_TOOL_ORDER);
  });

  it('行 factory 每次调用产出独立实例（无共享可变状态）', () => {
    const row = builtinToolRows()[0];
    const a = row.factory({ codingExec: exec });
    const b = row.factory({ codingExec: exec });
    expect(a).not.toBe(b);
    expect(a.map((t) => t.name())).toEqual(b.map((t) => t.name()));
  });

  it('经 buildToolRegistry 真实装配：fs 细粒度名 + ask_user + read_file 别名全部在册', async () => {
    const { buildStandardRegistry } = await import('./convergence/helpers/fixtures');
    const reg = await buildStandardRegistry();
    const names = reg.names();
    for (const n of [...FS_TOOL_ORDER, ...SHELL_TOOL_ORDER, 'ask_user', 'read_file']) {
      expect(names).toContain(n);
    }
    // 行实例与 createCodingTools 去重后无重名残留（重名 register 会 throw，
    // 能走到这里即证明去重守卫生效）
    expect(new Set(names).size).toBe(names.length);
  });
});

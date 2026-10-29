// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作者模式最小闭环（2026-10）——两半各测一遍：
//   A. creator preset 的形状：只回开 composition 行（defaultOff 语义）+ 插一段指南；
//   B. composition 工具的动作面：list / read / validate / write（IO 注入，零通道依赖）。

import { describe, expect, it } from 'vitest';
import { builtinPresetById, builtinPresets } from '../src/composition/presets';
import {
  type BuiltinToolRow,
  type CompositionPatch,
  CompositionPatchError,
  type factoryComposition,
  resolveRoster,
} from '../src/composition/roster';
import type { CompositionDeps, CompositionIo } from '../src/plugins/builtin/composition-domain/composition';
import {
  createCompositionTool,
  presetDirPath,
  rowsDigest,
} from '../src/plugins/builtin/composition-domain/composition';

const ROW_ID = 'plugin/hologram/composition-domain/composition';

/** 最小出厂组合：一行 defaultOff 的 composition 工具行 + 一行普通工具行。 */
function factory(): ReturnType<typeof factoryComposition> {
  const row = (id: string, defaultOff?: boolean): BuiltinToolRow => ({
    id,
    ...(defaultOff === true ? { defaultOff: true } : {}),
    factory: () => [],
  });
  return {
    tools: [row(ROW_ID, true), row('plugin/hologram/fs-domain/fs_read')],
    prompt: [{ id: 'base', text: 'base' } as never],
    capabilities: [],
    shell: [],
    seams: { llm: [], subagents: [], fs: [], shell: [], sessionPersistence: [], loopEvents: [] },
  };
}

function deps(): CompositionDeps {
  const fac = factory();
  return {
    roster: () => builtinPresets(),
    factory: () => fac,
    resolve: (patch: CompositionPatch) => resolveRoster(fac, [patch]),
  };
}

interface FakeFs {
  files: Map<string, string>;
  rescans: number;
}
function io(fs: FakeFs, root = '/home/u/.lantai/composition'): CompositionIo {
  return {
    dir: async () => root,
    readFile: async (p) => fs.files.get(p) ?? null,
    writeFile: async (p, content) => {
      fs.files.set(p, content);
    },
    makeDir: async () => {},
    rescan: async () => {
      fs.rescans += 1;
    },
  };
}

async function call(tool: ReturnType<typeof createCompositionTool>, args: Record<string, unknown>): Promise<string> {
  return tool.execute(args as never);
}

describe('creator preset（创作者模式）', () => {
  it('内置表含 creator，且只回开 composition 行 + 插指南段', () => {
    const entry = builtinPresetById('creator');
    expect(entry).toBeDefined();
    expect(entry?.builtin).toBe(true);
    expect(entry?.patch?.tools).toEqual([{ id: ROW_ID, disabled: false }]);
    const inserts = entry?.patch?.prompt ?? [];
    expect(inserts).toHaveLength(1);
    const ins = inserts[0] as { insert: Array<{ id: string; text: string }> };
    expect(ins.insert[0].id).toBe('composition-authoring');
    expect(ins.insert[0].text).toContain('composition');
  });

  it('standard 里 defaultOff 的 composition 行不出现；creator 里出现（且不在 unselected 栏）', () => {
    const fac = factory();
    const standard = resolveRoster(fac, [{}]);
    const creator = resolveRoster(fac, [builtinPresetById('creator')?.patch ?? {}]);
    expect(standard.tools.map((r) => r.id)).not.toContain(ROW_ID);
    expect(standard.diagnostics.unselected).toContain(ROW_ID);
    expect(creator.tools.map((r) => r.id)).toContain(ROW_ID);
    expect(creator.diagnostics.unselected).not.toContain(ROW_ID);
    expect(creator.prompt.map((p) => p.id)).toContain('composition-authoring');
  });
});

describe('composition 工具（创作者模式那双手）', () => {
  it('list：给 preset 清单；rows=true 时给可寻址行并标出默认关', async () => {
    const tool = createCompositionTool({ deps: deps() });
    const plain = await call(tool, { action: 'list' });
    expect(plain).toContain('standard');
    expect(plain).toContain('creator');
    const withRows = await call(tool, { action: 'list', rows: true });
    expect(withRows).toContain(ROW_ID);
    expect(withRows).toContain('★');
    expect(withRows).toContain('plugin/hologram/fs-domain/fs_read');
  });

  it('read：内置 preset 回 YAML；未知 id 拒绝', async () => {
    const tool = createCompositionTool({ deps: deps() });
    const yaml = await call(tool, { action: 'read', id: 'minimal' });
    expect(yaml).toContain('tools:');
    expect(yaml).toContain('web_search');
    const missing = await call(tool, { action: 'read', id: 'nope' });
    expect(missing).toContain('不在册');
  });

  it('validate：合法 patch 通过并给组成摘要；坏行 id 指出不可寻址', async () => {
    const tool = createCompositionTool({ deps: deps() });
    const ok = await call(tool, {
      action: 'validate',
      yaml: 'tools:\n  - id: plugin/hologram/fs-domain/fs_read\n    disabled: false\n',
    });
    expect(ok).toContain('通过');
    expect(ok).toContain('tools=1');
    const bad = await call(tool, {
      action: 'validate',
      yaml: 'tools:\n  - id: plugin/ghost/row\n    disabled: true\n',
    });
    expect(bad).toContain('未知行 id');
    const syntax = await call(tool, { action: 'validate', yaml: 'tools: [\n' });
    expect(syntax).toContain('YAML');
  });

  it('write：拒绝内置 id / 拒绝覆盖已有 / 写入并重扫', async () => {
    const fake: FakeFs = { files: new Map(), rescans: 0 };
    const ioImpl = io(fake);
    const tool = createCompositionTool({ io: ioImpl, deps: deps() });
    const yaml = 'tools:\n  - id: plugin/hologram/fs-domain/fs_read\n    disabled: true\n';

    expect(await call(tool, { action: 'write', id: 'standard', yaml })).toContain('内置');
    expect(await call(tool, { action: 'write', id: 'Bad Id', yaml })).toContain('不合法');
    expect(
      await call(tool, { action: 'write', id: 'bad-row', yaml: 'tools:\n  - id: ghost/x\n    disabled: true\n' }),
    ).toContain('拒绝写入');

    const first = await call(tool, { action: 'write', id: 'readonly', yaml, name: '只读研究' });
    expect(first).toContain('已写入');
    const dir = presetDirPath('/home/u/.lantai/composition', 'readonly');
    expect(fake.files.get(dir + '/roster.patch.yml')).toContain('fs_read');
    expect(fake.files.get(dir + '/preset.yml')).toContain('只读研究');
    expect(fake.rescans).toBe(1);

    const again = await call(tool, { action: 'write', id: 'readonly', yaml });
    expect(again).toContain('已存在');
    const overwrite = await call(tool, { action: 'write', id: 'readonly', yaml, overwrite: true });
    expect(overwrite).toContain('已写入');
  });

  it('resolve 抛 CompositionPatchError 时 validate 回具名原因（F1 同款语义）', async () => {
    const tool = createCompositionTool({
      deps: {
        ...deps(),
        resolve: () => {
          throw new CompositionPatchError('未知行 id: plugin/ghost/row');
        },
      },
    });
    const text = await call(tool, { action: 'validate', yaml: 'tools: []\n' });
    expect(text).toContain('未知行 id');
  });
});

describe('rowsDigest', () => {
  it('按 filter 只列命中行', () => {
    const text = rowsDigest('fs-domain', factory());
    expect(text).toContain('fs_read');
    expect(text).not.toContain('composition-domain');
  });
});

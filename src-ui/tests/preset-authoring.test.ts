// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// P-1 authoring 环境测试（2026-09-14，设计件
// docs/plans/composition-architecture/designs/S6-per-agent-composition.md §2 序列 F / §4 P-1）：
//   1. 模板内容**可解析**（生成的 YAML 必须过 parseCompositionPatch——否则
//      用户拿到的第一份底稿就是坏的）；
//   2. 复制语义：路径正确 / 拒覆盖（绝不抹用户已写内容）/ id 围栏 / 内置 id 拒绝；
//   3. 免重启重扫：rescanPresets 重跑 discovery + 刷新解析错误面
//      （取代 boot-once 的"改完要重启"）。
// IO 注入（PresetAuthoringIo）——本测试零 RPC、零磁盘。

import { beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type FetchTextLike, presetsIndexOrigin } from '../src/composition/preset-discovery';
import { builtinPresets } from '../src/composition/presets';
import { factoryComposition, parseCompositionPatch } from '../src/composition/roster';
import {
  createPresetFromTemplate,
  type PresetAuthoringIo,
  presetDirPath,
  rescanPresets,
  templateMetaYaml,
  templatePatchYaml,
} from '../src/plugins/builtin/settings-domain/preset-authoring';
import { useCompositionStore } from '../src/state/composition-store';
import { usePresetStore } from '../src/state/preset-store';

/** 假 IO：内存文件表 + 调用记录。 */
function fakeIo(initial: Record<string, string> = {}): PresetAuthoringIo & {
  files: Record<string, string>;
  mkdirs: string[];
} {
  const files = { ...initial };
  const mkdirs: string[] = [];
  return {
    files,
    mkdirs,
    compositionDir: async () => 'C:/Users/u/.lantai/composition',
    readFile: async (p) => files[p] ?? null,
    writeFile: async (p, content) => {
      files[p] = content;
    },
    makeDir: async (p) => {
      mkdirs.push(p);
    },
  };
}

const ROOT = 'C:/Users/u/.lantai/composition';

describe('P-1 authoring：模板生成', () => {
  it('minimal 模板 = 内置 minimal 的增量，且可被组合解析器接受', async () => {
    const yaml = await templatePatchYaml('minimal');
    expect(yaml).toContain('# 兰台组合补丁（preset 本体）');
    const parsed = parseYaml(yaml);
    const validated = parseCompositionPatch(parsed);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      // 真源单一：内容 = 内置 minimal 的 patch（不另抄一份清单）
      expect(validated.patch).toEqual(builtinPresets().find((p) => p.id === 'minimal')?.patch);
    }
  });

  it('standard 模板 = 注释齐全的空骨架（零生效增量），同样可解析', async () => {
    const yaml = await templatePatchYaml('standard');
    expect(yaml).toContain('tools: []');
    const validated = parseCompositionPatch(parseYaml(yaml));
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.patch).toEqual({ tools: [] });
  });

  it('元数据模板含 id 与来源（name/description 是纯展示面）', () => {
    const yaml = templateMetaYaml('my-preset', 'standard');
    expect(yaml).toContain('name: my-preset');
    expect(yaml).toContain('standard');
  });
});

describe('P-1 authoring：复制为模板（拒覆盖 / 围栏）', () => {
  it('成功：落两个文件到 <组合目录>/presets/<id>/，并建目录', async () => {
    const io = fakeIo();
    const res = await createPresetFromTemplate('my-preset', 'minimal', io);
    expect(res.ok).toBe(true);
    expect(res.dir).toBe(presetDirPath(ROOT, 'my-preset'));
    expect(io.mkdirs).toEqual([`${ROOT}/presets/my-preset`]);
    const patch = io.files[`${ROOT}/presets/my-preset/roster.patch.yml`];
    expect(patch).toBeTruthy();
    expect(parseCompositionPatch(parseYaml(patch)).ok).toBe(true);
    expect(io.files[`${ROOT}/presets/my-preset/preset.yml`]).toContain('name: my-preset');
  });

  it('拒覆盖：目标已存在 → 不写、不建目录、原因可见', async () => {
    const dir = presetDirPath(ROOT, 'mine');
    const io = fakeIo({ [`${dir}/roster.patch.yml`]: 'tools: []\n' });
    const res = await createPresetFromTemplate('mine', 'standard', io);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('不覆盖');
    expect(io.mkdirs).toEqual([]);
    expect(Object.keys(io.files)).toEqual([`${dir}/roster.patch.yml`]); // 原内容未被改写
  });

  it('id 围栏：非法形态拒绝（id 是路径段——防 .. / 分隔符）', async () => {
    for (const bad of ['../escape', 'a/b', 'Upper', '-bad', '', '  ']) {
      const io = fakeIo();
      const res = await createPresetFromTemplate(bad, 'standard', io);
      expect(res.ok).toBe(false);
      expect(io.files).toEqual({});
    }
  });

  it('内置 id 拒绝（内置同 id 胜——写进去只会让人困惑）', async () => {
    const io = fakeIo();
    const res = await createPresetFromTemplate('minimal', 'standard', io);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('内置');
    expect(io.files).toEqual({});
  });

  it('写盘失败 → ok=false 且原因可见（错误不静默）', async () => {
    const io = fakeIo();
    io.makeDir = async () => {
      throw new Error('EACCES');
    };
    const res = await createPresetFromTemplate('my-preset', 'standard', io);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('写盘失败');
    expect(res.error).toContain('EACCES');
  });
});

describe('P-1 authoring：免重启重扫', () => {
  const ORIGIN = presetsIndexOrigin(14570);

  function router(routes: Record<string, { status: number; body?: string }>): FetchTextLike {
    return async (url: string) => {
      const hit = routes[url];
      if (!hit) return { ok: false, status: 404, text: async () => '' };
      return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, text: async () => hit.body ?? '' };
    };
  }

  beforeEach(() => {
    usePresetStore.setState({ selected: 'standard', error: null });
    usePresetStore.getState().setRoster(builtinPresets());
    useCompositionStore.setState({
      status: 'factory',
      patchOrigin: undefined,
      error: undefined,
      resolved: factoryComposition(),
    });
  });

  it('重扫后新建的 preset 出现在 roster（无需重启）', async () => {
    const res = await rescanPresets({
      origin: ORIGIN,
      fetchImpl: router({
        [ORIGIN + '/']: { status: 200, body: '["my-preset"]' },
        [ORIGIN + '/my-preset/roster.patch.yml']: { status: 200, body: 'tools: []\n' },
        [ORIGIN + '/my-preset/preset.yml']: { status: 200, body: 'name: 我的预设\n' },
      }),
    });
    expect(res).toBeUndefined();
    const ids = usePresetStore.getState().roster.map((p) => p.id);
    expect(ids).toEqual(['standard', 'minimal', 'my-preset']);
  });

  it('重扫刷新解析错误面：修好/写坏都会立刻反映到 preset-store.error', async () => {
    // 先落一个「行 id 不存在」的用户 preset（模拟写错），选中它 → 重扫 → 错误可见
    await rescanPresets({
      origin: ORIGIN,
      fetchImpl: router({
        [ORIGIN + '/']: { status: 200, body: '["broken"]' },
        [ORIGIN + '/broken/roster.patch.yml']: {
          status: 200,
          body: 'tools:\n  - id: plugin/hologram/ghost-domain/tools\n    disabled: true\n',
        },
      }),
    });
    usePresetStore.getState().select('broken');
    await rescanPresets({ origin: ORIGIN, fetchImpl: router({}) }); // 通道不可用 = 保持现有 roster
    expect(usePresetStore.getState().error).toContain('未知行 id');
  });
});

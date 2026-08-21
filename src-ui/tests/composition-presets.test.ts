// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-0 preset 数据模型测试 — 设计件 §3 S4-0 验收的纯函数半边：
//   1. standard ≡ factoryComposition（出厂组合，零漂移的构造性保证）；
//   2. minimal 的禁用面符合设计（browser-desktop/web 工具行 + graph-hooks capability）；
//   3. 用户 preset 叠加在用户层 patch 之上（同 id 后写胜前写）；
//   4. 未知 id / broken preset → factory 兜底（占 id 拒绝装载）；
//   5. PresetId 围栏规则；
//   6. 内置与用户同 id → 内置胜（earlier root wins）。

import { describe, expect, it } from 'vitest';
import {
  builtinPresetById,
  builtinPresets,
  isValidPresetId,
  resolvePresetComposition,
} from '../src/composition/presets';
import { type CompositionPatch, factoryComposition } from '../src/composition/roster';
import { builtinToolRows } from '../src/composition/tool-rows';

const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id);

describe('composition/presets（S4-0 preset 数据模型）', () => {
  it('内置表含 standard/minimal/paper，standard 在首（表序 = 呈现序）', () => {
    const table = builtinPresets();
    expect(table.map((p) => p.id)).toEqual(['standard', 'minimal', 'paper']);
    expect(table.every((p) => p.builtin)).toBe(true);
  });

  it('standard ≡ factoryComposition（出厂组合，零 patch）', () => {
    const r = resolvePresetComposition('standard');
    const f = factoryComposition();
    expect(ids(r.tools)).toEqual(ids(f.tools));
    expect(ids(r.prompt)).toEqual(ids(f.prompt));
    expect(r.capabilities.map((c) => c.key)).toEqual(f.capabilities.map((c) => c.key));
    expect(ids(r.shell)).toEqual(ids(f.shell));
    expect(r.diagnostics).toEqual({ disabled: [], overridden: [], inserted: [] });
  });

  it('minimal：browser-desktop/web 工具行 + graph-hooks capability 被禁', () => {
    const r = resolvePresetComposition('minimal');
    const toolIds = ids(r.tools);
    expect(toolIds).not.toContain('builtin/browser-desktop');
    expect(toolIds).not.toContain('builtin/web');
    // 其余行保序保留
    expect(toolIds).toEqual(
      ids(builtinToolRows()).filter((id) => id !== 'builtin/browser-desktop' && id !== 'builtin/web'),
    );
    expect(r.capabilities.map((c) => c.key)).not.toContain('graph-hooks');
    expect(r.diagnostics.disabled).toContain('builtin/browser-desktop');
    expect(r.diagnostics.disabled).toContain('builtin/web');
    expect(r.diagnostics.disabled).toContain('graph-hooks');
  });

  it('用户 preset 叠加在用户层 patch 之上：同 id 后写胜前写（preset 层最上）', () => {
    const userPatch: CompositionPatch = {
      tools: [
        { id: 'builtin/fs', disabled: true },
        { id: 'builtin/web', disabled: false }, // 用户层启用 web
      ],
    };
    // minimal 的 preset 层禁 web → 后写胜 → web 最终被禁
    const r = resolvePresetComposition('minimal', { userPatch });
    expect(ids(r.tools)).not.toContain('builtin/web');
    expect(ids(r.tools)).not.toContain('builtin/fs'); // 用户层禁用仍生效
    // 反向：standard 无 preset 增量 → 用户层启用 web 生效
    const std = resolvePresetComposition('standard', { userPatch });
    expect(ids(std.tools)).toContain('builtin/web');
    expect(ids(std.tools)).not.toContain('builtin/fs');
  });

  it('用户 preset 表解析：userPresets 命中即用其 patch', () => {
    const userPresets = [
      {
        id: 'custom',
        builtin: false,
        patch: { tools: [{ id: 'builtin/git', disabled: true }] } as CompositionPatch,
      },
    ];
    const r = resolvePresetComposition('custom', { userPresets });
    expect(ids(r.tools)).not.toContain('builtin/git');
    expect(ids(r.tools)).toEqual(ids(builtinToolRows()).filter((id) => id !== 'builtin/git'));
  });

  it('内置与用户同 id → 内置胜（earlier root wins）', () => {
    const shadow = {
      id: 'minimal',
      builtin: false,
      patch: { tools: [{ id: 'builtin/fs', disabled: true }] } as CompositionPatch,
    };
    const r = resolvePresetComposition('minimal', { userPresets: [shadow] });
    // 内置 minimal 生效（禁 browser-desktop/web），影子补丁的 fs 禁用不出现
    expect(ids(r.tools)).not.toContain('builtin/browser-desktop');
    expect(ids(r.tools)).toContain('builtin/fs');
  });

  it('未知 id → factory 兜底（用户层仍叠）', () => {
    const r = resolvePresetComposition('ghost', {
      userPatch: { tools: [{ id: 'builtin/wait', disabled: true }] },
    });
    expect(ids(r.tools)).toEqual(ids(builtinToolRows()).filter((id) => id !== 'builtin/wait'));
  });

  it('broken preset（patch = null）→ factory 兜底不炸', () => {
    const broken = { id: 'broken', builtin: false, patch: null, error: 'YAML 语法错误: x' };
    const r = resolvePresetComposition('broken', { userPresets: [broken] });
    expect(ids(r.tools)).toEqual(ids(builtinToolRows()));
  });

  it('PresetId 围栏规则：合法/非法形态', () => {
    expect(isValidPresetId('standard')).toBe(true);
    expect(isValidPresetId('paper-shell')).toBe(true);
    expect(isValidPresetId('a1-b2')).toBe(true);
    expect(isValidPresetId('')).toBe(false);
    expect(isValidPresetId('-bad')).toBe(false);
    expect(isValidPresetId('Upper')).toBe(false);
    expect(isValidPresetId('has/slash')).toBe(false);
    expect(isValidPresetId('..')).toBe(false);
    expect(isValidPresetId('a b')).toBe(false);
  });

  it('builtinPresetById：命中/未命中', () => {
    expect(builtinPresetById('standard')?.patch).toEqual({});
    expect(builtinPresetById('minimal')?.metadata.name).toBe('minimal');
    expect(builtinPresetById('ghost')).toBeUndefined();
  });
});

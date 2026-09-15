// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-0 preset 数据模型测试 — 设计件 §3 S4-0 验收的纯函数半边：
//   1. standard ≡ factoryComposition（出厂组合，零漂移的构造性保证）；
//   2. minimal 的禁用面符合设计（browser-desktop/web 工具行 + state-hooks capability）；
//   3. 用户 preset 叠加在用户层 patch 之上（同 id 后写胜前写）；
//   4. 未知 id / broken preset → factory 兜底（占 id 拒绝装载）；
//   5. PresetId 围栏规则；
//   6. 内置与用户同 id → 内置胜（earlier root wins）。
// ①b（2026-08-23）：minimal/用户层 patch 寻址 plugin 行——寻址 plugin 行的
// 解析须在 withFirstPartyToolChannel 腰内（贡献行在册才可解析；无通道
// 环境 tools 域 = 空行表，plugin id 全部未知会被 all-or-nothing 拒绝）。
// B⑤（2026-08-24）：minimal 的 state-hooks capability 行经 ctx.capabilities
// 通道注册——寻址该 key 的解析须在 withFirstPartyCapabilityChannel 腰内。
// 2026-09-09 图谱退役：graph-hooks 收缩改名 state-hooks，minimal 禁用行随键改。

import { describe, expect, it } from 'vitest';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import {
  builtinPresetById,
  builtinPresets,
  isValidPresetId,
  resolvePresetComposition,
} from '../src/composition/presets';
import { type CompositionPatch, factoryComposition } from '../src/composition/roster';

const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id);

/** ①b 后 minimal 的寻址行（web/browser-desktop 迁插件通道）。 */
const WEB_ROW = 'plugin/hologram/web-domain/web_search';
const WEB_FETCH_ROW = 'plugin/hologram/web-domain/web_fetch';
const BROWSER_DESKTOP_ROW = 'plugin/hologram/browser-desktop-domain/tools';

describe('composition/presets（S4-0 preset 数据模型）', () => {
  it('内置表含 standard/minimal，standard 在首（表序 = 呈现序）', () => {
    const table = builtinPresets();
    // V5 拆除（2026-08-22）：paper preset 行退役——纸壳是唯一主界面，
    // 主视图落点不再经 preset 分叉。
    expect(table.map((p) => p.id)).toEqual(['standard', 'minimal']);
    expect(table.every((p) => p.builtin)).toBe(true);
  });

  it('standard ≡ factoryComposition（出厂组合，零 patch）', () => {
    const r = resolvePresetComposition('standard');
    const f = factoryComposition();
    expect(ids(r.tools)).toEqual(ids(f.tools));
    expect(ids(r.prompt)).toEqual(ids(f.prompt));
    expect(r.capabilities.map((c) => c.id)).toEqual(f.capabilities.map((c) => c.id));
    expect(ids(r.shell)).toEqual(ids(f.shell));
    expect(r.diagnostics).toEqual({ unselected: [], disabled: [], seamCapped: [], overridden: [], inserted: [] });
  });

  it('minimal：browser-desktop/web 工具行 + state-hooks capability 被禁', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const r = resolvePresetComposition('minimal');
        const toolIds = ids(r.tools);
        expect(toolIds).not.toContain(BROWSER_DESKTOP_ROW);
        expect(toolIds).not.toContain(WEB_FETCH_ROW);
        expect(toolIds).not.toContain(WEB_ROW);
        // 其余行保序保留（标准解析产物减去 minimal 禁用行）
        expect(toolIds).toEqual(
          ids(resolvePresetComposition('standard').tools).filter(
            (id) => id !== BROWSER_DESKTOP_ROW && id !== WEB_ROW && id !== WEB_FETCH_ROW,
          ),
        );
        expect(r.capabilities.map((c) => c.id)).not.toContain('state-hooks');
        // 诊断按表序收集（web 行居表首——与 patch 声明序无关）
        expect(r.diagnostics.disabled).toEqual([WEB_ROW, WEB_FETCH_ROW, BROWSER_DESKTOP_ROW, 'state-hooks']);
      }),
    );
  });

  it('用户 preset 叠加在用户层 patch 之上：同 id 后写胜前写（preset 层最上）', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        // ①b：探针改 plugin 行（用户层先禁后启 + minimal preset 层禁——
        // 三层同 id 的后写胜链）
        const userPatch: CompositionPatch = {
          tools: [
            { id: WEB_ROW, disabled: true },
            { id: WEB_ROW, disabled: false }, // 用户层启用 web
          ],
        };
        // minimal 的 preset 层禁 web → 后写胜 → web 最终被禁
        const r = resolvePresetComposition('minimal', { userPatch });
        expect(ids(r.tools)).not.toContain(WEB_ROW);
        // 反向：standard 无 preset 增量 → 用户层启用 web 生效
        const std = resolvePresetComposition('standard', { userPatch });
        expect(ids(std.tools)).toContain(WEB_ROW);
      }),
    );
  });

  it('用户 preset 表解析：userPresets 命中即用其 patch', async () => {
    await withFirstPartyToolChannel(async () => {
      // ①b：禁用目标改 plugin 行（pluginToolRows 现存行）——未知 id 会被
      // all-or-nothing 拒绝
      const userPresets = [
        {
          id: 'custom',
          builtin: false,
          patch: { tools: [{ id: WEB_ROW, disabled: true }] } as CompositionPatch,
        },
      ];
      const r = resolvePresetComposition('custom', { userPresets });
      expect(ids(r.tools)).not.toContain(WEB_ROW);
      expect(ids(r.tools)).toEqual(ids(pluginToolRows()).filter((id) => id !== WEB_ROW));
    });
  });

  it('内置与用户同 id → 内置胜（earlier root wins）', async () => {
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        // 影子补丁禁 plugin 行（wait 贡献行）——内置 minimal 胜出后影子不生效
        const shadow = {
          id: 'minimal',
          builtin: false,
          patch: { tools: [{ id: 'plugin/hologram/wait-domain/wait', disabled: true }] } as CompositionPatch,
        };
        const r = resolvePresetComposition('minimal', { userPresets: [shadow] });
        // 内置 minimal 生效（禁 browser-desktop/web），影子补丁的 wait 禁用不出现
        expect(ids(r.tools)).not.toContain(BROWSER_DESKTOP_ROW);
        expect(ids(r.tools)).toContain('plugin/hologram/wait-domain/wait');
      }),
    );
  });

  it('未知 id → factory 兜底（用户层仍叠）', async () => {
    await withFirstPartyToolChannel(async () => {
      const r = resolvePresetComposition('ghost', {
        userPatch: { tools: [{ id: WEB_ROW, disabled: true }] },
      });
      expect(ids(r.tools)).toEqual(ids(pluginToolRows()).filter((id) => id !== WEB_ROW));
    });
  });

  it('broken preset（patch = null）→ factory 兜底不炸', async () => {
    await withFirstPartyToolChannel(async () => {
      const broken = { id: 'broken', builtin: false, patch: null, error: 'YAML 语法错误: x' };
      const r = resolvePresetComposition('broken', { userPresets: [broken] });
      expect(ids(r.tools)).toEqual(ids(pluginToolRows()));
    });
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-0 preset 发现层测试 — 设计件 §3 S4-0 验收的 TS 发现半边：
//   索引 + 逐 preset 取本体/元数据；坏 preset 目录 = roster 行报 broken
//   不炸发现；非法 id 不入列；内置同 id 胜；无通道/404 = 内置表终态。

import { beforeEach, describe, expect, it } from 'vitest';
import { discoverPresets, type FetchTextLike, presetsIndexOrigin } from '../src/composition/preset-discovery';
import { builtinPresets } from '../src/composition/presets';
import { usePresetStore } from '../src/state/preset-store';

/** 文本响应 mock（按 URL 分派）。 */
function router(routes: Record<string, { status: number; body?: string }>): FetchTextLike {
  return async (url: string) => {
    const hit = routes[url];
    if (!hit) return { ok: false, status: 404, text: async () => '' };
    return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, text: async () => hit.body ?? '' };
  };
}

const ORIGIN = presetsIndexOrigin(14570);

// ①b（2026-08-23）：patch 内容探针改 plugin 行 id（builtin 行表退役）——
// 发现层只 parse/校验不解析（resolveRoster 在 preset-assembly 侧），id
// 形状任意但沿用现行寻址面保持测试语义真实。
const PAPER_PATCH = ['tools:', '  - id: plugin/hologram/web-domain/web_fetch', '    disabled: true'].join('\n');

describe('composition/preset-discovery（S4-0 用户层发现）', () => {
  beforeEach(() => {
    usePresetStore.getState().setRoster(builtinPresets());
    usePresetStore.setState({ selected: 'standard' });
  });

  it('presetsIndexOrigin 构造', () => {
    expect(presetsIndexOrigin(14570)).toBe('http://127.0.0.1:14570/composition/presets');
  });

  it('正常发现：索引 + 本体 + 元数据 → roster 合并（内置在前，用户按 id 序）', async () => {
    await discoverPresets({
      origin: ORIGIN,
      fetchImpl: router({
        [ORIGIN + '/']: { status: 200, body: '["paperx", "alpha"]' },
        [ORIGIN + '/paperx/roster.patch.yml']: { status: 200, body: PAPER_PATCH },
        [ORIGIN + '/paperx/preset.yml']: { status: 200, body: 'name: 纸壳\norder: 2\n' },
        [ORIGIN + '/alpha/roster.patch.yml']: { status: 200, body: '{}' },
        [ORIGIN + '/alpha/preset.yml']: { status: 404 },
      }),
    });
    const roster = usePresetStore.getState().roster;
    expect(roster.map((p) => p.id)).toEqual(['standard', 'minimal', 'alpha', 'paperx']);
    const paperx = roster.find((p) => p.id === 'paperx');
    expect(paperx?.builtin).toBe(false);
    expect(paperx?.patch).toEqual({ tools: [{ id: 'plugin/hologram/web-domain/web_fetch', disabled: true }] });
    expect(paperx?.metadata).toEqual({ name: '纸壳', order: 2 });
    expect(paperx?.error).toBeUndefined();
  });

  it('坏 preset（yml 语法错）：roster 行 broken（error 可见，patch null），发现不炸', async () => {
    await discoverPresets({
      origin: ORIGIN,
      fetchImpl: router({
        [ORIGIN + '/']: { status: 200, body: '["broken"]' },
        [ORIGIN + '/broken/roster.patch.yml']: { status: 200, body: 'tools: [unclosed' },
      }),
    });
    const roster = usePresetStore.getState().roster;
    const broken = roster.find((p) => p.id === 'broken');
    expect(broken?.patch).toBeNull();
    expect(broken?.error).toContain('YAML');
    expect(roster.map((p) => p.id)).toEqual(['standard', 'minimal', 'broken']);
  });

  it('坏 preset（校验失败——未知域形状）：broken 同款', async () => {
    await discoverPresets({
      origin: ORIGIN,
      fetchImpl: router({
        [ORIGIN + '/']: { status: 200, body: '["weird"]' },
        [ORIGIN + '/weird/roster.patch.yml']: {
          status: 200,
          body: 'tools:\n  - id: plugin/hologram/web-domain/web_fetch\n    disabled: true\n    text: 越域\n',
        },
      }),
    });
    const weird = usePresetStore.getState().roster.find((p) => p.id === 'weird');
    expect(weird?.patch).toBeNull();
    expect(weird?.error).toContain('校验失败');
  });

  it('preset.yml 装载失败（404 / 坏形状）→ 无元数据降级，不拒载', async () => {
    await discoverPresets({
      origin: ORIGIN,
      fetchImpl: router({
        [ORIGIN + '/']: { status: 200, body: '["a", "b"]' },
        [ORIGIN + '/a/roster.patch.yml']: { status: 200, body: '{}' },
        [ORIGIN + '/a/preset.yml']: { status: 200, body: 'name: A\n' },
        [ORIGIN + '/b/roster.patch.yml']: { status: 200, body: '{}' },
        [ORIGIN + '/b/preset.yml']: { status: 200, body: 'description: 无名字\n' },
      }),
    });
    const roster = usePresetStore.getState().roster;
    expect(roster.find((p) => p.id === 'a')?.metadata).toEqual({ name: 'A' });
    expect(roster.find((p) => p.id === 'b')?.metadata).toBeUndefined();
    expect(roster.find((p) => p.id === 'b')?.patch).toEqual({});
  });

  it('空 roster.patch.yml（S2 同款严格语义）→ broken', async () => {
    await discoverPresets({
      origin: ORIGIN,
      fetchImpl: router({
        [ORIGIN + '/']: { status: 200, body: '["empty"]' },
        [ORIGIN + '/empty/roster.patch.yml']: { status: 200, body: '' },
      }),
    });
    const empty = usePresetStore.getState().roster.find((p) => p.id === 'empty');
    expect(empty?.patch).toBeNull();
    expect(empty?.error).toBeTruthy();
  });

  it('非法 preset id（围栏）不入列；内置同 id 用户行被剔（内置胜）', async () => {
    await discoverPresets({
      origin: ORIGIN,
      fetchImpl: router({
        [ORIGIN + '/']: { status: 200, body: '["bad/id", "..", "Upper", "minimal", "ok"]' },
        [ORIGIN + '/ok/roster.patch.yml']: { status: 200, body: '{}' },
      }),
    });
    const rosterIds = usePresetStore.getState().roster.map((p) => p.id);
    expect(rosterIds).toEqual(['standard', 'minimal', 'ok']);
  });

  it('索引 404 / 非 JSON 数组 / 500 = 内置表终态（非错误，store 不动）', async () => {
    for (const body of [undefined, 'not a list', '{"error":true}']) {
      await discoverPresets({
        origin: ORIGIN,
        fetchImpl: router({ [ORIGIN + '/']: { status: body === undefined ? 404 : 200, body } }),
      });
      expect(usePresetStore.getState().roster.map((p) => p.id)).toEqual(['standard', 'minimal']);
    }
  });

  it('fetch 网络炸 → 永不 reject，内置表仍在', async () => {
    const boom: FetchTextLike = async () => {
      throw new Error('network down');
    };
    await expect(discoverPresets({ origin: ORIGIN, fetchImpl: boom })).resolves.toBeUndefined();
    expect(usePresetStore.getState().roster.map((p) => p.id)).toEqual(['standard', 'minimal']);
  });

  it('无通道（origin 空）→ 直接返回，内置表即终态', async () => {
    await expect(discoverPresets({ origin: '' })).resolves.toBeUndefined();
    expect(usePresetStore.getState().roster.map((p) => p.id)).toEqual(['standard', 'minimal']);
  });
});

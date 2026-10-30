// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 创作者链路端到端（2026-10-30）：composition(write) → 磁盘 → discovery → 可选中。
// 分段单测各自都绿，但它们之间的**接线**最容易断（写完没重扫 / 发现层不认新目录 /
// 解析面找不到行）。本条只钉这条链，不重复各段细节。

import { describe, expect, it } from 'vitest';
import { withFirstPartyCapabilityChannel } from '../src/composition/first-party-capabilities';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { selectionError } from '../src/composition/preset-assembly';
import { discoverPresets, presetsIndexOrigin } from '../src/composition/preset-discovery';
import { builtinPresets } from '../src/composition/presets';
import type { CompositionIo } from '../src/plugins/builtin/composition-domain/composition';
import { createCompositionTool, presetDirPath } from '../src/plugins/builtin/composition-domain/composition';
import { usePresetStore } from '../src/state/preset-store';

const ROOT = '/home/u/.lantai/composition';
const ORIGIN = presetsIndexOrigin(14571);

function memoryIo(files: Map<string, string>): CompositionIo {
  return {
    dir: async () => ROOT,
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    makeDir: async () => {},
    deleteFile: async (p) => {
      files.delete(p);
    },
    rescan: async () => {},
  };
}

/** 把内存磁盘当发现通道：索引 = 有 roster.patch.yml 的子目录。 */
function fetchFrom(files: Map<string, string>) {
  const ids = new Set<string>();
  for (const p of files.keys()) {
    const m = p.match(/\/presets\/([^/]+)\/roster\.patch\.yml$/);
    if (m) ids.add(m[1]);
  }
  return async (url: string) => {
    const ok = (body?: string) => ({ ok: true, status: 200, text: async () => body ?? '' });
    if (url === ORIGIN + '/') return ok(JSON.stringify([...ids]));
    const rel = url.startsWith(ORIGIN + '/') ? url.slice(ORIGIN.length + 1) : '';
    const m = rel.match(/^([^/]+)\/([^/]+)$/);
    if (!m) return { ok: false, status: 404, text: async () => '' };
    const body = files.get(presetDirPath(ROOT, m[1]) + '/' + m[2]);
    return body === undefined ? { ok: false, status: 404, text: async () => '' } : ok(body);
  };
}

describe('creator 链路端到端（write → 发现 → 可选中）', () => {
  it('造出来的组合出现在清单里，且解析面可用', async () => {
    // 整条链都在通道腰内：写盘前要按真实出厂组合校验行 id（无通道 = 空行表，
    // 写什么都会被拒——这正是生产与测试的差别所在）。
    const files = new Map<string, string>();
    await withFirstPartyToolChannel(() =>
      withFirstPartyCapabilityChannel(async () => {
        const tool = createCompositionTool({ io: memoryIo(files) });
        const written = await tool.execute({
          action: 'write',
          id: 'e2e-mode',
          name: '端到端模式',
          description: '只关 shell 的研究组合',
          yaml: 'tools:\n  - id: plugin/hologram/shell-domain/run_shell\n    disabled: true\n',
        } as never);
        expect(String(written)).toContain('已写入');
        expect(files.has(presetDirPath(ROOT, 'e2e-mode') + '/roster.patch.yml')).toBe(true);

        usePresetStore.getState().setRoster(builtinPresets());
        await discoverPresets({ origin: ORIGIN, fetchImpl: fetchFrom(files) });
        expect(usePresetStore.getState().roster.map((p) => p.id)).toContain('e2e-mode');

        // 解析面：行 id 真实存在 → 无拒绝原因（选中它不会被拦）
        expect(selectionError('e2e-mode')).toBeNull();
      }),
    );
  });
});

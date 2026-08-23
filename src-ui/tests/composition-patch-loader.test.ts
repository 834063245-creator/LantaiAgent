// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S2-2 patch-loader 测试 — 设计件 §3 S2-2 验收的 TS 半边：
//   合法 patch 生效 / 坏 yml / 未知 id / HTTP 异常 → store error + factory
//   兜底 / 404 → factory 非错误。fetch 注入 mock（loader 同款测试面）；
//   origin 显式传入绕过 RPC 解析。
// ①b（2026-08-23）：patch 寻址 plugin 行——装载流程须在 withFirstPartyToolChannel
//   腰内跑（resolveRoster 对 factoryComposition 快照解析，plugin 行在册才可
//   寻址；生产等价时序 = loadBuiltinPlugins 先于 bootShell 组合链）。

import { beforeEach, describe, expect, it } from 'vitest';
import { withFirstPartyToolChannel } from '../src/composition/first-party-tools';
import { compositionOrigin, type FetchTextLike, loadCompositionPatch } from '../src/composition/patch-loader';
import { factoryComposition } from '../src/composition/roster';
import { useCompositionStore } from '../src/state/composition-store';

const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id);

/** 文本响应 mock（404/500/200+yml 三形状）。 */
function textResponse(status: number, body = ''): FetchTextLike {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
}

const WEB_ROW = 'plugin/hologram/web-domain/web_fetch';

const VALID_PATCH = [
  '# 用户层组合 patch',
  'tools:',
  `  - id: ${WEB_ROW}`,
  '    disabled: true',
  'prompt:',
  '  - insert:',
  '      - id: team-convention',
  '        text: |',
  '          ## 团队约定',
  '      - id: team-convention-2',
  '        after: team-convention',
  '        text: |',
  '          ## 团队约定二',
  '  - id: team-convention',
  '    text: |',
  '      【覆盖后的约定】',
].join('\n');

const ORIGIN = compositionOrigin(14570);

describe('composition/patch-loader（S2-2 用户层通道）', () => {
  beforeEach(() => {
    useCompositionStore.setState({
      status: 'factory',
      patchOrigin: undefined,
      error: undefined,
      resolved: factoryComposition(),
    });
  });

  it('compositionOrigin 构造', () => {
    expect(compositionOrigin(14570)).toBe('http://127.0.0.1:14570/composition');
  });

  it('合法 patch：yml 文本 → 解析 → store ok + 诊断透出', async () => {
    await withFirstPartyToolChannel(async () => {
      await loadCompositionPatch({ origin: ORIGIN, fetchImpl: textResponse(200, VALID_PATCH) });
      const s = useCompositionStore.getState();
      expect(s.status).toBe('ok');
      expect(s.patchOrigin).toBe('roster.patch.yml');
      expect(ids(s.resolved.tools)).not.toContain(WEB_ROW);
      expect(s.resolved.diagnostics.disabled).toContain(WEB_ROW);
      expect(s.resolved.diagnostics.overridden).toContain('team-convention');
      expect(s.resolved.diagnostics.inserted).toContain('team-convention');
      expect(s.resolved.diagnostics.inserted).toContain('team-convention-2');
      // 覆盖段生效（已插入段的 text 覆盖——B④ 收官后 prompt 寻址面 = 已插段）
      const section = s.resolved.prompt.find((x) => x.id === 'team-convention');
      expect(section?.render({ projectPath: '' })).toContain('【覆盖后的约定】');
    });
  });

  it('404：无用户层 = factory 非错误', async () => {
    await loadCompositionPatch({ origin: ORIGIN, fetchImpl: textResponse(404) });
    const s = useCompositionStore.getState();
    expect(s.status).toBe('factory');
    expect(s.error).toBeUndefined();
    expect(ids(s.resolved.tools)).toEqual([]); // 无通道 = 空行表（①b 后 factory）
  });

  it('HTTP 异常（500）：error 可见 + factory 兜底', async () => {
    await withFirstPartyToolChannel(async () => {
      await loadCompositionPatch({ origin: ORIGIN, fetchImpl: textResponse(500) });
      const s = useCompositionStore.getState();
      expect(s.status).toBe('error');
      expect(s.error).toContain('500');
      expect(ids(s.resolved.tools)).toEqual(ids(factoryComposition().tools)); // factory 兜底（通道内快照）
    });
  });

  it('坏 yml（语法错误）：error 可见 + factory 兜底', async () => {
    await withFirstPartyToolChannel(async () => {
      await loadCompositionPatch({
        origin: ORIGIN,
        fetchImpl: textResponse(200, 'tools: [unclosed'),
      });
      const s = useCompositionStore.getState();
      expect(s.status).toBe('error');
      expect(s.error).toContain('YAML');
      expect(ids(s.resolved.tools)).toEqual(ids(factoryComposition().tools));
    });
  });

  it('校验失败（越域 text）：error 可见 + factory 兜底', async () => {
    await withFirstPartyToolChannel(async () => {
      const badShape = ['tools:', `  - id: ${WEB_ROW}`, '    disabled: true', '    text: 越域字段'].join('\n');
      await loadCompositionPatch({ origin: ORIGIN, fetchImpl: textResponse(200, badShape) });
      const s = useCompositionStore.getState();
      expect(s.status).toBe('error');
      expect(ids(s.resolved.tools)).toEqual(ids(factoryComposition().tools));
    });
  });

  it('解析失败（未知 id）：error 可见 + factory 兜底（all-or-nothing）', async () => {
    await withFirstPartyToolChannel(async () => {
      const unknownId = ['tools:', '  - id: plugin/nope', '    disabled: true'].join('\n');
      await loadCompositionPatch({ origin: ORIGIN, fetchImpl: textResponse(200, unknownId) });
      const s = useCompositionStore.getState();
      expect(s.status).toBe('error');
      expect(s.error).toContain('plugin/nope');
      expect(ids(s.resolved.tools)).toEqual(ids(factoryComposition().tools));
    });
  });

  it('永不 reject：fetch 网络错 → 捕获 + error 可见', async () => {
    await withFirstPartyToolChannel(async () => {
      const boom: FetchTextLike = async () => {
        throw new Error('network down');
      };
      await expect(loadCompositionPatch({ origin: ORIGIN, fetchImpl: boom })).resolves.toBeUndefined();
      const s = useCompositionStore.getState();
      expect(s.status).toBe('error');
      expect(s.error).toContain('network down');
    });
  });
});

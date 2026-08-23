// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// S4-2 热重载测试 — 设计件 §3 S4-2 验收的 TS 半边：
//   reload 幂等（同输入同输出）/ 坏 patch 重载兜底（error + factory）/
//   patch 删除 → 显式回退 factory（旧组合不残留）/ 装载成功后 preset 层重应用。
// （Rust watcher 的事件语义在 src-tauri composition_watcher.rs 的测试 +
// 手动验收：改 patch → 新会话即新面、在途会话不变。）

import { beforeEach, describe, expect, it } from 'vitest';
import {
  compositionOrigin,
  type FetchTextLike,
  loadCompositionPatch,
  reloadCompositionPatch,
} from '../src/composition/patch-loader';
import { clearUserPatch } from '../src/composition/preset-assembly';
import { factoryComposition } from '../src/composition/roster';
import { builtinToolRows } from '../src/composition/tool-rows';
import { useCompositionStore } from '../src/state/composition-store';
import { usePresetStore } from '../src/state/preset-store';

const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id);

const ORIGIN = compositionOrigin(14570);

/** 可变路由 mock：测试中途换装内容（热重载场景本体）。 */
function mutableFetch(initial: Record<string, { status: number; body?: string }>): {
  impl: FetchTextLike;
  routes: Record<string, { status: number; body?: string }>;
} {
  const routes = { ...initial };
  return {
    routes,
    impl: async (url: string) => {
      const hit = routes[url];
      if (!hit) return { ok: false, status: 404, text: async () => '' };
      return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, text: async () => hit.body ?? '' };
    },
  };
}

// ①c（2026-08-23）：builtin/wait 迁插件通道——V1 禁 builtin/web、
// V2 禁 builtin/browser-desktop（两行都在 builtin 行表，热改切换可观测）。
const PATCH_V1 = ['tools:', '  - id: builtin/web', '    disabled: true'].join('\n');
const PATCH_V2 = ['tools:', '  - id: builtin/browser-desktop', '    disabled: true'].join('\n');
const PATCH_URL = ORIGIN + '/roster.patch.yml';

describe('composition/patch-loader 热重载（S4-2）', () => {
  beforeEach(() => {
    useCompositionStore.setState({
      status: 'factory',
      patchOrigin: undefined,
      error: undefined,
      resolved: factoryComposition(),
    });
    usePresetStore.setState({ selected: 'standard' });
    clearUserPatch();
  });

  it('初次装载 → 改文件 → reload 用新组合（幂等：重跑同输入同输出）', async () => {
    const { impl, routes } = mutableFetch({ [PATCH_URL]: { status: 200, body: PATCH_V1 } });
    await loadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    expect(ids(useCompositionStore.getState().resolved.tools)).not.toContain('builtin/web');

    // 热改：v1 的 web 禁用撤下、v2 的 browser-desktop 禁用生效
    routes[PATCH_URL] = { status: 200, body: PATCH_V2 };
    await reloadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    const s = useCompositionStore.getState();
    expect(s.status).toBe('ok');
    expect(ids(s.resolved.tools)).toContain('builtin/web'); // v1 的禁用被撤下
    expect(ids(s.resolved.tools)).not.toContain('builtin/browser-desktop'); // v2 生效
    expect(s.resolved.diagnostics.disabled).toEqual(['builtin/browser-desktop']);

    // 幂等：同输入再 reload → 同样的终态
    await reloadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    const s2 = useCompositionStore.getState();
    expect(ids(s2.resolved.tools)).not.toContain('builtin/browser-desktop');
    expect(ids(s2.resolved.tools)).toContain('builtin/web');
  });

  it('坏 patch 重载 → error 可见 + factory 兜底（旧组合撤下，不残留）', async () => {
    const { impl, routes } = mutableFetch({ [PATCH_URL]: { status: 200, body: PATCH_V1 } });
    await loadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    expect(useCompositionStore.getState().status).toBe('ok');

    routes[PATCH_URL] = { status: 200, body: 'tools: [unclosed' }; // 坏 yml
    await reloadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    const s = useCompositionStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toContain('YAML');
    expect(ids(s.resolved.tools)).toEqual(ids(builtinToolRows())); // factory 兜底
  });

  it('patch 删除（404）→ 显式回退 factory 态（非静默、非残留）', async () => {
    const { impl, routes } = mutableFetch({ [PATCH_URL]: { status: 200, body: PATCH_V1 } });
    await loadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    expect(useCompositionStore.getState().status).toBe('ok');

    routes[PATCH_URL] = { status: 404 }; // 热删除
    await reloadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    const s = useCompositionStore.getState();
    expect(s.status).toBe('factory'); // 显式回退（不是残留 ok 态）
    expect(s.patchOrigin).toBeUndefined();
    expect(ids(s.resolved.tools)).toEqual(ids(builtinToolRows()));
  });

  it('reload 成功后 preset 层重应用（minimal 叠在新用户层之上）', async () => {
    usePresetStore.getState().select('minimal');
    const { impl } = mutableFetch({ [PATCH_URL]: { status: 200, body: PATCH_V1 } });
    await loadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    await reloadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    const s = useCompositionStore.getState();
    // 双层叠加：用户层禁 web + preset 层禁 web/browser-desktop（同 id 后写胜）
    expect(ids(s.resolved.tools)).not.toContain('builtin/web');
    expect(ids(s.resolved.tools)).not.toContain('builtin/browser-desktop');
    expect(s.patchOrigin).toContain('preset:minimal');
  });

  it('reload 通道网络炸 → 永不 reject + 旧组合保持（热重载失败 ≠ 组合失效）', async () => {
    const { impl, routes } = mutableFetch({ [PATCH_URL]: { status: 200, body: PATCH_V1 } });
    await loadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });

    const boom: FetchTextLike = async () => {
      throw new Error('network down');
    };
    await expect(reloadCompositionPatch({ origin: ORIGIN, fetchImpl: boom })).resolves.toBeUndefined();
    // 旧组合继续生效（error 未被覆盖——网络失败不是 patch 被拒）
    const s = useCompositionStore.getState();
    expect(s.status).toBe('ok');
    expect(ids(s.resolved.tools)).not.toContain('builtin/web');
    // 路由仍可用——恢复后 reload 成功
    routes[PATCH_URL] = { status: 200, body: PATCH_V2 };
    await reloadCompositionPatch({ origin: ORIGIN, fetchImpl: impl });
    expect(ids(useCompositionStore.getState().resolved.tools)).not.toContain('builtin/browser-desktop');
  });
});

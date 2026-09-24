// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 随包引擎探测 · **生产线形**回归（2026-09-24 实机缺陷「开关拨不开」）。
//
// 病灶：`engine_bundled_info` 不在 `src-tauri/src/rpc.rs` 的 `rpc_result_shape()` 表内
// ⇒ 兜底臂 `Text` ⇒ Rust 出口把 JSON 当**字符串**直通；而 `probeBundledEngine()` 用
// `typedRpc`（直通、不 parse；双形态 shim 在 `typedJsonRpc`）读属性 ⇒
// `raw?.available === true` 恒 false ⇒ `McpPage` 的 `disabled={!info?.available}` 置灰，
// 用户看到「引擎开关拨不开」。09-16 的 CDP 探针读到的是那条 JSON 字符串本身
// （文本里写着 "available":true）⇒ 假阳性，把缺陷掩盖了 8 天。
//
// 既有 `tests/bundled-engine.test.ts` 自陈「测试内不触发真 RPC」（直接构造已探测 info），
// 于是**这条形状差从未被任何用例覆盖**。本文件补上：桩到 bridge 层，喂产线两种线形。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ rpc: null as null | ReturnType<typeof vi.fn> }));

// 只替换 bridge 的 rpc 出口，其余保持真实（typedRpc / typedJsonRpc 的真实语义要跑到）。
vi.mock('../src/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bridge')>();
  const rpc = vi.fn();
  H.rpc = rpc;
  return { ...actual, rpc };
});

import { pluginToolRows } from '../src/composition/plugin-tool-rows';
import { compositionServicesPlugin } from '../src/composition/services';
import { Context } from '../src/cordis';
import {
  probeBundledEngine,
  registerBundledEngineTools,
  resetBundledEngineForTests,
} from '../src/plugins/bundled-engine';
import type { McpBridgeIO } from '../src/plugins/mcp-bridge';

/** 引擎就位时 Rust 侧 `serde_json::json!({path,dir,available})` 的线形。 */
const ENGINE_ON_DISK = { path: 'D:/x/hologram-engine.exe', dir: 'D:/x', available: true };

beforeEach(() => {
  H.rpc?.mockReset();
  resetBundledEngineForTests();
});

describe('随包引擎探测 · 生产线形（实机「开关拨不开」回归）', () => {
  it('Rust 出口 Text（JSON 字符串）时仍必须判定 available=true', async () => {
    H.rpc?.mockResolvedValueOnce(JSON.stringify(ENGINE_ON_DISK));
    const info = await probeBundledEngine();
    expect(info.available, '字符串线形下 available 被读成 false ⇒ 设置页开关置灰').toBe(true);
    expect(info.path).toBe(ENGINE_ON_DISK.path);
    expect(info.dir).toBe(ENGINE_ON_DISK.dir);
  });

  it('出口已展开为结构化 Value（表内 JsonValue 形态）时同样成立', async () => {
    H.rpc?.mockResolvedValueOnce({ ...ENGINE_ON_DISK });
    const info = await probeBundledEngine();
    expect(info.available).toBe(true);
    expect(info.path).toBe(ENGINE_ON_DISK.path);
  });

  it('真未找到（available=false）不得被误判成命中', async () => {
    H.rpc?.mockResolvedValueOnce(JSON.stringify({ path: null, dir: null, available: false }));
    const info = await probeBundledEngine();
    expect(info.available).toBe(false);
    expect(info.path).toBeNull();
  });

  it('RPC 抛错 → 降级为不可用且**不缓存**（下次可重试）', async () => {
    H.rpc?.mockRejectedValueOnce(new Error('RPC 未装配'));
    expect((await probeBundledEngine()).available).toBe(false);
    H.rpc?.mockResolvedValueOnce(JSON.stringify(ENGINE_ON_DISK));
    expect((await probeBundledEngine()).available, '失败结果一旦被缓存，恢复后永不翻身').toBe(true);
  });
});

describe('随包引擎接线（实机三连回归，2026-09-24）', () => {
  it('工作区 scope ctx（不声明 inject）下：接线成功 + 声明激活 + 开工作区即预热拉起', async () => {
    localStorage.setItem('lantai.bundledEngine.enabled', 'true');
    resetBundledEngineForTests();
    H.rpc?.mockResolvedValueOnce(JSON.stringify(ENGINE_ON_DISK));

    const root = new Context();
    await root.plugin(compositionServicesPlugin);
    // 与 workspace.ts 的 workspaceScopePlugin 逐字同形：apply 为空、无 inject。
    const scope = await root.plugin({ name: 'hologram/workspace', apply() {} });

    const spawns: string[] = [];
    const io: McpBridgeIO = {
      createProcIO: async (id) => {
        spawns.push(id);
        // 不真起进程：让治理器 start 立刻失败（预热路径的失败面也因此被走到）
        throw new Error('测试环境不真 spawn');
      },
      pluginDir: async () => 'D:/x',
    };

    const wiring = await registerBundledEngineTools(scope.ctx, 'D:/proj', io);
    expect(wiring.wired, `接线应成功（reason=${wiring.reason ?? '—'}）`).toBe(true);
    expect(pluginToolRows().map((r) => r.id)).toContain('plugin/hologram-engine/mcp/hologram');
    // 实机第二症状（UI 已接线、任务管理器无进程）的钉子：受治面**必须**在激活账里
    // 声明过——否则装配期 retainForComposition 看不到它，治理器永不被拉起。
    expect(
      root.activation.has('hologram-engine'),
      '接线必须把 lazy 档受治面声明进激活账（loader 对 manifest 插件做的那一步）',
    ).toBe(true);
    // 实机第二症状的另一半：开工作区即预热（fire-and-forget）——否则首个会话
    // （工具行物化先于 retain）拿不到工具。createProcIO 首参是 bridgeId（不是插件名），
    // 故只断言「发生了一次拉起尝试」。
    expect(spawns, '开工作区即尝试拉起引擎进程（预热，不阻塞开工作区）').toHaveLength(1);

    // 归属与回收仍挂调用方 ctx：scope dispose ⇒ 子 fiber 一并 dispose ⇒ 行摘除
    await scope.dispose();
    expect(pluginToolRows().map((r) => r.id)).not.toContain('plugin/hologram-engine/mcp/hologram');
    await root[Symbol.asyncDispose]?.();
    localStorage.removeItem('lantai.bundledEngine.enabled');
  });
});

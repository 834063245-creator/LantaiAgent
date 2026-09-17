// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// agent-config 信号路由守护（2026-08-24 工作区归属根治 Phase A 重写）：
// 占位工作区进 shellRefs.workspace 单槽后，persistence 行的路由坍缩为单分支——
//   ① refs.workspace 存在（真目录或 path='' 占位）→ 热切换
//   ② workspace/chatPanel 缺席 → 显式 warn（错误不静默）
// 旧「三分支占位投递」（getPlaceholderWorkspace 影子实例）随单槽统一退役。
// 静态钉（源扫描，断言片段对 biome 换行免疫）+ 行为钉（mock 订阅驱动）双轨。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const src = readFileSync(resolve(__dirname, '../src/shell/rows/persistence.ts'), 'utf8');
const wsRowSrc = readFileSync(resolve(__dirname, '../src/shell/rows/workspace.ts'), 'utf8');

describe('persistence 行 — agent-config 信号单分支路由（单槽统一）', () => {
  it('影子占位实例退役：persistence 不再引用 getPlaceholderWorkspace，workspace 行无模块级 _placeholderWs', () => {
    expect(src).not.toContain('getPlaceholderWorkspace');
    expect(wsRowSrc).not.toContain('let _placeholderWs');
    expect(wsRowSrc).not.toContain('export function getPlaceholderWorkspace');
  });

  it('占位工作区进单槽（shellRefs.workspace = ws）', () => {
    expect(wsRowSrc).toContain('shellRefs.workspace = ws');
  });

  it('落点缺席必须显式可见（错误不静默）', () => {
    expect(src).toContain('丢弃信号');
  });

  it("行为：workspace 在场（含 path='' 占位）→ 信号投给槽内工作区", async () => {
    const applyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/settings', () => ({
      loadSettings: () => ({ display: { fontScale: 1 } }),
    }));
    vi.doMock('../src/state/turn-done-store', () => ({
      useTurnDoneStore: { subscribe: () => () => {} },
    }));
    vi.resetModules();
    const { bootPersistence } = await import('../src/shell/rows/persistence');
    const { notifyAgentConfigChanged } = await import('../src/state/agent-config-store');
    const chatPanel = { id: 'panel', setOnOpenSettings: vi.fn() };
    const ws = { path: '', applyAgentConfig: applyMock };
    bootPersistence({ workspace: ws, chatPanel } as never);
    notifyAgentConfigChanged('settings-saved');
    await new Promise((r) => setTimeout(r, 0));
    expect(applyMock).toHaveBeenCalledTimes(1);
    // 方案甲（2026-08-27）：第三参 sessionId（全局信号 = undefined）随信号透传
    expect(applyMock).toHaveBeenCalledWith(chatPanel, 'settings-saved', undefined);
  });

  it('行为：workspace 缺席 → 不投递（warn 可见）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('../src/settings', () => ({
      loadSettings: () => ({ display: { fontScale: 1 } }),
    }));
    vi.doMock('../src/state/turn-done-store', () => ({
      useTurnDoneStore: { subscribe: () => () => {} },
    }));
    vi.resetModules();
    const { bootPersistence } = await import('../src/shell/rows/persistence');
    const { notifyAgentConfigChanged } = await import('../src/state/agent-config-store');
    const chatPanel = { id: 'panel', setOnOpenSettings: vi.fn() };
    bootPersistence({ workspace: null, chatPanel } as never);
    notifyAgentConfigChanged('settings-saved');
    await new Promise((r) => setTimeout(r, 0));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

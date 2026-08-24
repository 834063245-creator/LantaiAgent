// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// agent-config 信号路由守护（2026-08-24「配置 provider 后会话读不到」死路根治）：
// persistence 行的 useAgentConfigStore 订阅必须覆盖三条落点——
//   ① refs.workspace 非空 → 主工作区热切换
//   ② refs.workspace 缺席 + 占位工作区存在（零目录会话）→ 占位实例投递
//     （旧版在此静默丢弃：首次配置 API Key 后占位会话永远读不到，提示
//      「请重启应用」——重启也无济于事，冷启动同样不装配）
//   ③ 两者皆缺席 → 显式 warn（错误不静默）
// 静态钉（源扫描，断言片段对 biome 换行免疫）+ 行为钉（mock 订阅驱动）双轨。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const src = readFileSync(resolve(__dirname, '../src/shell/rows/persistence.ts'), 'utf8');
const wsRowSrc = readFileSync(resolve(__dirname, '../src/shell/rows/workspace.ts'), 'utf8');

describe('persistence 行 — agent-config 信号三落点路由', () => {
  it('refs.workspace 缺席时向占位工作区投递（不再静默丢弃）', () => {
    expect(src).toContain('getPlaceholderWorkspace()');
    // 占位分支专属 catch 标签 —— 与主工作区分支可区分
    expect(src).toContain('placeholder hot-switch failed');
    // 两者皆缺席必须显式可见（错误不静默）
    expect(src).toContain('workspace 与占位装配均缺席，丢弃信号');
  });

  it('占位工作区句柄由 rows/workspace.ts 记忆化导出（单一实例，重复装配不累积）', () => {
    expect(wsRowSrc).toContain('let _placeholderWs: Workspace | null = null');
    expect(wsRowSrc).toContain('export function getPlaceholderWorkspace()');
  });

  it('行为：workspace 缺席 + 占位存在 → 信号投给占位实例', async () => {
    const applyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/settings', () => ({
      loadSettings: () => ({ display: { fontScale: 1 } }),
    }));
    vi.doMock('../src/state/turn-done-store', () => ({
      useTurnDoneStore: { subscribe: () => () => {} },
    }));
    vi.doMock('../src/shell/rows/workspace', () => ({
      getPlaceholderWorkspace: () => ({ applyAgentConfig: applyMock }),
    }));
    vi.resetModules();
    const { bootPersistence } = await import('../src/shell/rows/persistence');
    const { notifyAgentConfigChanged } = await import('../src/state/agent-config-store');
    const chatPanel = { id: 'panel', setOnOpenSettings: vi.fn() };
    bootPersistence({ workspace: null, chatPanel } as never);
    notifyAgentConfigChanged('settings-saved');
    await new Promise((r) => setTimeout(r, 0));
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(chatPanel, 'settings-saved');
  });

  it('行为：主工作区在场 → 信号只投主工作区（占位不参与）', async () => {
    const applyMock = vi.fn().mockResolvedValue(undefined);
    const phApplyMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/settings', () => ({
      loadSettings: () => ({ display: { fontScale: 1 } }),
    }));
    vi.doMock('../src/state/turn-done-store', () => ({
      useTurnDoneStore: { subscribe: () => () => {} },
    }));
    vi.doMock('../src/shell/rows/workspace', () => ({
      getPlaceholderWorkspace: () => ({ applyAgentConfig: phApplyMock }),
    }));
    vi.resetModules();
    const { bootPersistence } = await import('../src/shell/rows/persistence');
    const { notifyAgentConfigChanged } = await import('../src/state/agent-config-store');
    const chatPanel = { id: 'panel', setOnOpenSettings: vi.fn() };
    const ws = { applyAgentConfig: applyMock };
    bootPersistence({ workspace: ws, chatPanel } as never);
    notifyAgentConfigChanged('settings-saved');
    await new Promise((r) => setTimeout(r, 0));
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(chatPanel, 'settings-saved');
    expect(phApplyMock).not.toHaveBeenCalled();
  });
});

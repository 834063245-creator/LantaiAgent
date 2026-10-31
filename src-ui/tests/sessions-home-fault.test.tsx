// @vitest-environment jsdom

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// §8 真机验收降维（rpc 边界校验层批一，2026-09-01）：设计件原验收项
// 「真机 CDP：workspace_list 人为缺字段 → 首页显式报错」的 UI 接线语义
// 钉进组件级测试（release 壳无 devtools，CDP 取证路径随本测试退役）。
// 走真实 typedJsonRpc（仅 mock 桥——schema 校验是真实链路的一部分）：
//   - 违形载荷（缺 dir_exists）→ throw → SessionsHome catch → listState
//     'error'：渲染「工作区清单读取失败」+ 重试，绝不静默落入「还没有
//     工作区」空态（那正是设计件 §1 的静默走错分支病）；
//   - 合法载荷（结构化 Value——真机 Rust 出口形态）→ 正常渲染卡片；
//   - 合法空表 →「还没有工作区」空态（注册表缺席不报错，2026-08-29 走查
//     语义保持不变——空是合法形状，违形才是故障）。

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();

vi.mock('../src/bridge', () => ({
  rpc: (method: string, params?: Record<string, unknown>) => mockRpc(method, params),
  invoke: vi.fn(),
  listen: vi.fn(),
  isMockMode: () => false,
}));

import { SessionsHome } from '../src/plugins/builtin/sessions-home/SessionsHome';

/** workspace_list 合法行（Rust WorkspaceSummary 同形，结构化 Value——真机出口形态）。 */
const VALID_ROW = {
  path: 'D:/works/nebula-novel',
  name: '星云小说',
  last_opened_at: '2026-09-01T08:00:00Z',
  pinned: true,
  session_count: 3,
  latest_saved_at: '2026-09-01T07:52:00Z',
  dir_exists: true,
  graph_engine: true,
};

describe('SessionsHome × workspace_list 边界校验接线（§8 验收降维）', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(async () => {
    // P1-2：workspace_list 短期缓存（rpc-contract 模块级）跨测试泄漏——
    // mock 的结果会被下一测试拿到。动态 import 清空（静态 import 会在
    // vi.mock 注册前实例化真 bridge）。
    const { clearWorkspaceListCache } = await import('../src/rpc-contract');
    clearWorkspaceListCache();
    mockRpc.mockReset();
    // 首页挂载期两个读面：workspace_list（主体，用例逐条给 Once）+ get_last_project
    // （上卷记忆；本组用例不涉及 → 诚实空给定，避免违形噪声）。
    mockRpc.mockImplementation((method: string) =>
      method === 'get_last_project' ? Promise.resolve(null) : Promise.resolve([]),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  async function mountHome(): Promise<HTMLDivElement> {
    act(() => {
      root = createRoot(container);
      root.render(createElement(SessionsHome));
    });
    // flush 挂载期 workspace_list 拉取（promise 链 + setState）
    await act(async () => {});
    return container;
  }

  it('违形载荷（缺 dir_exists）→ 显式报错态，绝不静默落「还没有工作区」空态', async () => {
    const { dir_exists: _stripped, ...broken } = VALID_ROW;
    mockRpc.mockResolvedValueOnce([broken]);
    const c = await mountHome();
    expect(mockRpc).toHaveBeenCalledWith('workspace_list', {});
    expect(c.textContent).toContain('工作区清单读取失败');
    expect(c.querySelector('.sh-retry')).not.toBeNull();
    expect(c.textContent).not.toContain('还没有工作区');
    expect(c.querySelector('.sh-row')).toBeNull();
  });

  it('违形载荷重试仍违形 → 错误态保持（不闪回空态）', async () => {
    const { dir_exists: _stripped, ...broken } = VALID_ROW;
    mockRpc.mockImplementation((method: string) =>
      method === 'get_last_project' ? Promise.resolve(null) : Promise.resolve([broken]),
    );
    const c = await mountHome();
    expect(c.textContent).toContain('工作区清单读取失败');
    const retry = c.querySelector<HTMLButtonElement>('.sh-retry');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
    });
    expect(c.textContent).toContain('工作区清单读取失败');
    expect(c.querySelector('.sh-row')).toBeNull();
  });

  it('合法载荷（结构化 Value）→ 正常渲染登记行', async () => {
    mockRpc.mockResolvedValueOnce([VALID_ROW]);
    const c = await mountHome();
    expect(c.querySelector('.sh-row')).not.toBeNull();
    expect(c.textContent).toContain('星云小说');
    // 行的进入动作 = 主按钮的 aria-label（旧卡片的「进入画布」文字随丁案退役）
    const enter = c.querySelector('.sh-row-main');
    expect(enter?.getAttribute('aria-label')).toContain('进入工作区');
    expect(c.textContent).not.toContain('工作区清单读取失败');
  });

  it('合法空表 →「还没有工作区」空态（空是合法形状，不报错）', async () => {
    mockRpc.mockResolvedValueOnce([]);
    const c = await mountHome();
    expect(c.textContent).toContain('还没有工作区');
    expect(c.textContent).not.toContain('工作区清单读取失败');
  });

  it('上次工作区目录已丢失 → 上卷显式「目录已丢失」，不伪装成「还没有卷」', async () => {
    // 病灶：fs 层对缺席目录返回空集（不抛）——若上卷按「读面空 = 无卷」显示，
    // 移走的目录会被伪装成「这张纸还空着」。清单的 dir_exists 才是权威判据。
    mockRpc.mockImplementation((method: string) => {
      if (method === 'get_last_project') return Promise.resolve('D:/works/gone');
      return Promise.resolve([
        { ...VALID_ROW, path: 'D:/works/gone', name: '旧项目', dir_exists: false, session_count: 0 },
      ]);
    });
    const c = await mountHome();
    await act(async () => {});
    expect(c.textContent).toContain('目录已丢失');
    expect(c.textContent).not.toContain('这张纸还空着');
  });
});

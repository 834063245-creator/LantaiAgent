// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// browser 复合动作编排测试：
//   - browser_fill 逐字段路由 browser_type + replace 透传
//   - browser_navigate_snapshot = navigate → snapshot 一次往返
// （R4-2：细粒度动作已迁 browser_cap 直呼——观察点为 typedRpc('browser_cap')。）

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  return { ...actual, typedRpc: vi.fn(async () => '{"done":true}') };
});

import { ToolRegistry } from '../src/agent/tool';
import { createBrowserTools } from '../src/plugins/builtin/browser-desktop-domain/browser';
import { typedRpc } from '../src/rpc-contract';

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of createBrowserTools()) registry.register(t);
  return registry;
}

const rpcMock = typedRpc as unknown as ReturnType<typeof vi.fn>;

function reg(name: string) {
  const t = buildRegistry().get(name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
}

describe('browser_fill', () => {
  it('逐字段路由 browser_type（selector/text/replace 透传）', async () => {
    rpcMock.mockClear();
    const out = await reg('browser_fill').execute({
      fields: [
        { selector: '12', text: 'alice' },
        { selector: '#pw', text: 'secret', replace: true },
      ],
    });
    expect(out).toContain('browser_fill 完成 2 个字段');
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_type', selector: '12', text: 'alice' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_type', selector: '#pw', text: 'secret', replace: true }),
    );
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('空字段数组被 schema 拒绝（min(1)）', async () => {
    await expect(reg('browser_fill').execute({ fields: [] })).rejects.toThrow('参数校验失败');
  });

  it('是写动作（非只读）', () => {
    expect(reg('browser_fill').readOnly()).toBe(false);
  });
});

describe('browser_navigate_snapshot', () => {
  it('一次往返组合 navigate + snapshot（maxResults 透传）', async () => {
    rpcMock.mockClear();
    const out = await reg('browser_navigate_snapshot').execute({ url: 'https://example.com/', maxResults: 40 });
    expect(out).toContain('== navigation ==');
    expect(out).toContain('== snapshot ==');
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_navigate', url: 'https://example.com/' }),
    );
    expect(rpcMock).toHaveBeenCalledWith(
      'browser_cap',
      expect.objectContaining({ action: 'browser_snapshot', max_results: 40 }),
    );
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('是写动作（navigate 改变页面状态）', () => {
    expect(reg('browser_navigate_snapshot').readOnly()).toBe(false);
  });
});

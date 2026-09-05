import { describe, expect, it, vi } from 'vitest';

// desktop 领域工具已迁 uia_cap 能力口直呼（R4-3，kernel-capability-d4-handle-
// design.md：builtin.uia 信封退役）——mock typedRpc 捕获直呼路由；其余导出
// 保留真实实现。
vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  return { ...actual, typedRpc: vi.fn(async () => '{"process_count":0,"processes":[]}') };
});

import { ToolRegistry } from '../src/agent/tool';
import { createBrowserTools, createDesktopTools } from '../src/agent/tools/browser';
import { convergeRegistry } from '../src/agent/tools/domains';
import { typedRpc } from '../src/rpc-contract';

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of createBrowserTools()) registry.register(t);
  for (const t of createDesktopTools()) registry.register(t);
  convergeRegistry(registry);
  return registry;
}

const rpcMock = typedRpc as unknown as ReturnType<typeof vi.fn>;

describe('desktop 领域工具注册', () => {
  it('领域工具 desktop 可见，细粒度 desktop_probe 被隐藏但可解析', () => {
    const registry = buildRegistry();
    const visible = registry.schemas().map((s) => s.name);
    expect(visible).toContain('desktop');
    expect(visible).not.toContain('desktop_probe');
    expect(registry.get('desktop_probe')).toBeDefined();
  });

  it('desktop 领域 action 覆盖 probe', () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    const actions = t.actions?.() ?? [];
    expect(actions).toContain('probe');
  });

  it('desktop 领域未标记为只读（含 uia_click/type/scroll 写动作）', () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    expect(t.readOnly()).toBe(false);
  });

  it('desktop 领域读动作（probe/screenshot/uia_tree/uia_find/uia_window_shot）细粒度工具只读', () => {
    const registry = buildRegistry();
    for (const name of [
      'desktop_probe',
      'desktop_screenshot',
      'desktop_uia_tree',
      'desktop_uia_find',
      'desktop_uia_window_shot',
    ]) {
      expect(registry.get(name)!.readOnly(), `${name} 应只读`).toBe(true);
    }
  });

  it('未知 action 返回错误提示', async () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    const result = await t.execute({ action: 'fly_to_desktop' });
    expect(result).toContain('unsupported action');
  });
});

describe('desktop 动作路由（走 uia_cap 直呼）', () => {
  it('probe 路由到 desktop_probe 并透传空参数', async () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    await t.execute({ action: 'probe' });
    expect(rpcMock).toHaveBeenCalledWith(
      'uia_cap',
      expect.objectContaining({ action: 'desktop_probe', is_agent: true }),
    );
  });

  it('desktop_probe 细粒度工具标记只读', () => {
    const registry = buildRegistry();
    const t = registry.get('desktop_probe')!;
    expect(t.readOnly()).toBe(true);
  });

  it('screenshot 路由到 desktop_screenshot（而非 browser_screenshot）', async () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    await t.execute({ action: 'screenshot' });
    expect(rpcMock).toHaveBeenCalledWith('uia_cap', expect.objectContaining({ action: 'desktop_screenshot' }));
    // 不误路由到 browser_screenshot
    expect(rpcMock).not.toHaveBeenCalledWith('uia_cap', expect.objectContaining({ action: 'browser_screenshot' }));
  });

  it('desktop_screenshot 细粒度工具存在且只读', () => {
    const registry = buildRegistry();
    const t = registry.get('desktop_screenshot')!;
    expect(t.readOnly()).toBe(true);
  });
});

describe('desktop UIA 动作参数校验', () => {
  it('uia_click 无定位条件时返回明确错误而非静默 ref=0', async () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    const result = await t.execute({ action: 'uia_click' });
    expect(result).toContain('至少要给一个定位条件');
    // 无定位条件 → 守卫在 TS 工具层拦截，不直呼发后端
    expect(rpcMock).not.toHaveBeenCalledWith('uia_cap', expect.objectContaining({ action: 'desktop_uia_click' }));
  });

  it('uia_click 给 ref 或 name 时正常放行', async () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    await t.execute({ action: 'uia_click', ref: 3 });
    expect(rpcMock).toHaveBeenCalledWith('uia_cap', expect.objectContaining({ action: 'desktop_uia_click', ref: 3 }));
    rpcMock.mockClear();
    await t.execute({ action: 'uia_click', name: 'OK' });
    expect(rpcMock).toHaveBeenCalledWith(
      'uia_cap',
      expect.objectContaining({ action: 'desktop_uia_click', name: 'OK' }),
    );
  });

  it('uia_type 无定位条件时报错，有 text + name 时放行', async () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    const bad = await t.execute({ action: 'uia_type', text: 'hello' });
    expect(bad).toContain('至少要给一个定位条件');
    await t.execute({ action: 'uia_type', text: 'hello', name: '输入框' });
    expect(rpcMock).toHaveBeenCalledWith(
      'uia_cap',
      expect.objectContaining({ action: 'desktop_uia_type', text: 'hello', name: '输入框' }),
    );
  });

  it('uia_tree 支持 depth 参数透传', async () => {
    const registry = buildRegistry();
    const t = registry.get('desktop')!;
    await t.execute({ action: 'uia_tree', depth: 2, title: 'Notepad' });
    expect(rpcMock).toHaveBeenCalledWith(
      'uia_cap',
      expect.objectContaining({ action: 'desktop_uia_tree', depth: 2, title: 'Notepad' }),
    );
  });
});

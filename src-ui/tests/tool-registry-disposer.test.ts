// 注册表 disposer 契约测试（agent-core-convergence Phase 1 / 验证计划 T1 + T5）。
// 覆盖 ToolRegistry / HookRegistry / PreflightHookRegistry 三个注册 API：
// 返回的 disposer 删除指定项、重复调用 no-op、陈旧 disposer 不误删后来者、
// 100 次注册/释放循环后注册表归零（泄漏检测）。
import { describe, expect, it } from 'vitest';
import { HookRegistry, PreflightHookRegistry } from '../src/agent/hooks';
import { type Tool, ToolRegistry } from '../src/agent/tool';

function toyTool(name: string): Tool {
  return {
    name: () => name,
    description: () => `${name} desc`,
    parameters: () => ({ type: 'object', properties: {} }),
    readOnly: () => true,
    execute: async () => `${name}-ok`,
  };
}

describe('ToolRegistry.register → Disposer', () => {
  it('disposer 删除指定工具；重复调用 no-op', () => {
    const reg = new ToolRegistry();
    const dispose = reg.register(toyTool('alpha'));
    expect(reg.names()).toContain('alpha');
    dispose();
    expect(reg.names()).not.toContain('alpha');
    expect(reg.get('alpha')).toBeUndefined();
    expect(() => dispose()).not.toThrow();
    expect(reg.names()).toEqual([]);
  });

  it('hidden 状态随 disposer 一并清除（unregister 语义）', () => {
    const reg = new ToolRegistry();
    const dispose = reg.register(toyTool('legacy_thing'));
    reg.hide('legacy_thing');
    expect(reg.isHidden('legacy_thing')).toBe(true);
    dispose();
    expect(reg.isHidden('legacy_thing')).toBe(false);
    // 同名重注册不受残留 hidden 影响
    const dispose2 = reg.register(toyTool('legacy_thing'));
    expect(reg.schemas().map((s) => s.name)).toContain('legacy_thing');
    dispose2();
  });

  // ── 程序内专属面（2026-11-21 code 模式）：直调面 ≠ 程序面 ──
  it('programOnly：直调面（schemas）扣掉，程序面（visibleTools）照常在内', () => {
    const reg = new ToolRegistry();
    reg.register(toyTool('fs'));
    reg.register(toyTool('ask_user'));
    reg.setProgramOnly('fs', true);

    expect(reg.schemas().map((s) => s.name)).toEqual(['ask_user']);
    // 绑定集读 visibleTools —— 程序里必须还能 await tools.fs(...)
    expect(
      reg
        .visibleTools()
        .map((t) => t.name())
        .sort(),
    ).toEqual(['ask_user', 'fs']);
    expect(reg.directTools().map((t) => t.name())).toEqual(['ask_user']);
    expect(reg.isProgramOnly('fs')).toBe(true);
    expect(reg.programOnlyNamesList()).toEqual(['fs']);

    // 撤销：直调面回来（后层覆盖前层同款语义）
    reg.setProgramOnly('fs', false);
    expect(
      reg
        .schemas()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['ask_user', 'fs']);
  });

  it('programOnly 与 hide 正交；标记按名字续命；未在册名照记不造工具', () => {
    const reg = new ToolRegistry();
    reg.register(toyTool('fs'));
    reg.setProgramOnly('ghost', true); // 未在册：照记账，但不制造工具
    expect(reg.programOnlyNamesList()).toEqual(['ghost']);
    expect(reg.get('ghost')).toBeUndefined();

    reg.setProgramOnly('fs', true);
    reg.hide('fs');
    // 两条面各自独立：hide 是「旧名淘汰」，programOnly 是「收进程序」
    expect(reg.visibleTools().map((t) => t.name())).toEqual([]);
    expect(reg.directTools().map((t) => t.name())).toEqual([]);

    // 标记按**名字**续命（组合声明，不是工具实例属性）：领域收敛会先 unregister
    // 再重注册同名门面，清标记会让 code 模式在装配后静默失效。
    reg.unregister('fs');
    reg.register(toyTool('fs'));
    expect(reg.isProgramOnly('fs')).toBe(true);
    expect(reg.directTools().map((t) => t.name())).toEqual([]);
  });

  it('directOnly：allowlist 内才进直调面；其余仍进 visibleTools，直调被引导拦截', () => {
    const reg = new ToolRegistry();
    reg.register(toyTool('fs'));
    reg.register(toyTool('ask_user'));
    reg.register(toyTool('new_future_tool'));
    reg.setDirectOnlyAllowlist(['ask_user']);

    expect(reg.schemas().map((s) => s.name)).toEqual(['ask_user']);
    expect(reg.directTools().map((t) => t.name())).toEqual(['ask_user']);
    expect(
      reg
        .visibleTools()
        .map((t) => t.name())
        .sort(),
    ).toEqual(['ask_user', 'fs', 'new_future_tool']);
    expect(reg.isDirectOnlyBlocked('fs')).toBe(true);
    expect(reg.isDirectOnlyBlocked('ask_user')).toBe(false);
    expect(reg.directOnlyNamesList()).toEqual(['ask_user']);

    // fail-closed：后加的新工具也不会自动出现在直调面
    reg.register(toyTool('another_new_tool'));
    expect(reg.schemas().map((s) => s.name)).toEqual(['ask_user']);

    reg.setDirectOnlyAllowlist(null);
    expect(
      reg
        .schemas()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['another_new_tool', 'ask_user', 'fs', 'new_future_tool']);
  });

  it('clone：工具引用与 hidden / programOnly 策略全量保真（runtime 装配回归）', () => {
    const reg = new ToolRegistry();
    const fs = toyTool('fs');
    reg.register(fs);
    reg.register(toyTool('legacy'));
    reg.register(toyTool('ask_user'));
    reg.hide('legacy');
    reg.setProgramOnly('fs', true);
    reg.setDirectOnlyAllowlist(['ask_user']);

    const copy = reg.clone();
    expect(copy.get('fs')).toBe(fs); // 工具实例不复制实现，只复制表
    expect(copy.isHidden('legacy')).toBe(true);
    expect(copy.isProgramOnly('fs')).toBe(true);
    expect(copy.directOnlyNamesList()).toEqual(['ask_user']);
    expect(copy.schemas().map((s) => s.name)).toEqual(['ask_user']);
    expect(
      copy
        .visibleTools()
        .map((t) => t.name())
        .sort(),
    ).toEqual(['ask_user', 'fs']);

    // 克隆是独立策略账：后续变更不串回源表
    copy.setProgramOnly('fs', false);
    copy.setDirectOnlyAllowlist(null);
    copy.unhide('legacy');
    expect(reg.isProgramOnly('fs')).toBe(true);
    expect(reg.isHidden('legacy')).toBe(true);
    expect(reg.directOnlyNamesList()).toEqual(['ask_user']);
  });

  it('陈旧 disposer 不误删同名的新工具', () => {
    const reg = new ToolRegistry();
    const t1 = toyTool('shared');
    const dispose1 = reg.register(t1);
    reg.unregister('shared');
    const t2 = toyTool('shared');
    reg.register(t2);
    dispose1(); // 陈旧清理器——不得删掉 t2
    expect(reg.get('shared')).toBe(t2);
  });

  it('注册 100 次再全部 dispose，注册表归零（T5 泄漏检测）', () => {
    const reg = new ToolRegistry();
    const disposers = [];
    for (let i = 0; i < 100; i++) disposers.push(reg.register(toyTool(`tool_${i}`)));
    expect(reg.names()).toHaveLength(100);
    for (const d of disposers) d();
    expect(reg.names()).toEqual([]);
    expect(reg.schemas()).toEqual([]);
    expect(reg.visibleTools()).toEqual([]);
  });
});

describe('HookRegistry.register → Disposer', () => {
  it('disposer 移除 hook；apply 不再触发；重复调用 no-op', async () => {
    const hooks = new HookRegistry();
    const dispose = hooks.register({
      name: 'test',
      shouldEnrich: () => true,
      enrich: async (_n, _a, r) => `${r}+enriched`,
    });
    expect(await hooks.apply('x', {}, 'raw')).toBe('raw+enriched');
    dispose();
    dispose();
    expect(await hooks.apply('x', {}, 'raw')).toBe('raw');
  });

  it('多 hook 各自独立释放', async () => {
    const hooks = new HookRegistry();
    const d1 = hooks.register({
      name: 'h1',
      shouldEnrich: () => true,
      enrich: async (_n, _a, r) => `${r}+1`,
    });
    hooks.register({
      name: 'h2',
      shouldEnrich: () => true,
      enrich: async (_n, _a, r) => `${r}+2`,
    });
    d1();
    expect(await hooks.apply('x', {}, 'raw')).toBe('raw+2');
  });
});

describe('PreflightHookRegistry.register → Disposer', () => {
  it('disposer 移除 preflight hook；check 不再触发；重复调用 no-op', () => {
    const pre = new PreflightHookRegistry();
    const dispose = pre.register({
      name: 'p1',
      shouldCheck: () => true,
      check: () => 'warn',
    });
    expect(pre.check('edit_file', {})).toBe('warn');
    dispose();
    dispose();
    expect(pre.check('edit_file', {})).toBeNull();
  });
});

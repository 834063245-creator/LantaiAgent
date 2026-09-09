import { describe, expect, it } from 'vitest';
import { HookRegistry, PreflightHookRegistry } from '../src/agent/hooks';

// （图谱 hooks——GraphContext/GraphContextHook/GraphPreflightHook 的测试——
// 随图谱功能全量退役整段删除，2026-09-09；hooks.ts 只保留注册表 + 状态
// hooks 装配面，注册表行为由本文件守护，状态 hook 个体行为经 blueprint/
// state-inject 测试面覆盖。）

// ═══════════════════════════════════════════════════════════
// HookRegistry / PreflightHookRegistry — 崩溃静默降级
// ═══════════════════════════════════════════════════════════

describe('HookRegistry', () => {
  it('apply 多个 hook 叠加', async () => {
    const reg = new HookRegistry();
    reg.register({
      name: 'a',
      shouldEnrich: () => true,
      enrich: async (_t, _a, r) => '[A]' + r,
    });
    reg.register({
      name: 'b',
      shouldEnrich: () => true,
      enrich: async (_t, _a, r) => '[B]' + r,
    });
    const out = await reg.apply('read_file', {}, 'original');
    expect(out).toBe('[B][A]original');
  });

  it('apply hook 崩溃不影响后续', async () => {
    const reg = new HookRegistry();
    reg.register({
      name: 'crash',
      shouldEnrich: () => true,
      enrich: async () => {
        throw new Error('boom');
      },
    });
    reg.register({
      name: 'ok',
      shouldEnrich: () => true,
      enrich: async (_t, _a, r) => '[OK]' + r,
    });
    const out = await reg.apply('read_file', {}, 'original');
    expect(out).toBe('[OK]original');
  });
});

describe('PreflightHookRegistry', () => {
  it('check 聚合所有非 null 警告', () => {
    const reg = new PreflightHookRegistry();
    reg.register({
      name: 'a',
      shouldCheck: () => true,
      check: () => 'WARN_A',
    });
    reg.register({
      name: 'b',
      shouldCheck: () => true,
      check: () => 'WARN_B',
    });
    const out = reg.check('edit_file', {});
    expect(out).toContain('WARN_A');
    expect(out).toContain('WARN_B');
  });

  it('check 全部 null 返回 null', () => {
    const reg = new PreflightHookRegistry();
    reg.register({
      name: 'silent',
      shouldCheck: () => true,
      check: () => null,
    });
    expect(reg.check('edit_file', {})).toBeNull();
  });
});

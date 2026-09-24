import { describe, expect, it } from 'vitest';
import { HookRegistry, PreflightHookRegistry } from '../src/agent/hooks';
import { createStateReadHook } from '../src/plugins/builtin/state-hooks/hook-factories';

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

// ── state-read 钩子 — 附图信封不被前缀污染（2026-09-18 附图读图批）──
// fs(read) 读到图片时输出是附图信封（机器可读 JSON）；状态前缀拼在其上会让
// executor 的 parseToolImageOutput 解析失败、图静默丢。图片没有诊断/blame 可注，
// 跳过即语义无损。
describe('state-read 钩子 — 附图信封放行', () => {
  const diagSource = () => [
    {
      severity: 'error' as const,
      message: 'boom',
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 1,
    },
  ];

  it('普通 read 结果：有诊断 → 注入状态前缀（对照组，行为回归）', async () => {
    const hook = createStateReadHook('D:/proj', diagSource);
    const out = await hook.enrich('read_file_content', { filePath: 'D:/proj/a.ts' }, 'const a = 1;');
    expect(out.startsWith('📋 [状态]')).toBe(true);
    expect(out.endsWith('const a = 1;')).toBe(true);
  });

  it('附图信封：原样返回（前缀会破坏 JSON 解析 → 图静默丢）', async () => {
    const hook = createStateReadHook('D:/proj', diagSource);
    const envelope = JSON.stringify({
      path: 'D:/proj/x.png',
      image: { id: 'a'.repeat(64), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    });
    const out = await hook.enrich('read_file_content', { filePath: 'D:/proj/x.png' }, envelope);
    expect(out).toBe(envelope);
  });
});

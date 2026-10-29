// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 启动自愈面的判定逻辑（app/boot-recovery.ts）——2026-10-29 事故立法。
//
// 每组用例对应一个**真实现场**的判据（不是编的构造）：
//   ① 全部产物因宿主面指纹被拒 ⇒ skew（本次事故形态）；
//   ② 部分产物因其它原因失败 ⇒ product（要读者看具体插件）；
//   ③ boot 审计 fail-loud ⇒ audit（异常里带 [boot-gate] 清单）；
//   ④ 壳行/未捕获异常 ⇒ shell；
//   ⑤ 假绿兜底：审计全绿 + 无异常，但 home 槽为空 ⇒ empty-shell（事故里真正
//      让用户看到纯白的那一层——产物在 manifest 闸被拒，一个 fiber 都没建）；
//   ⑥ 安全模式的判定与说明面。

import { describe, expect, it } from 'vitest';
import { diagnoseBoot, failedProducts, isSkewError, safeModeFailure, safeModeRequest } from '../src/app/boot-recovery';
import type { PluginRecord } from '../src/state/plugin-store';

const SKEW_MSG =
  '宿主面版本偏斜（拒载防渲染期整树卸载）: 产物需宿主面 d57775e9，当前 exe 是 3840339f —— 本批触及了 faceDeps 面';

/** 出厂产物记录（meta.kind=feature）。 */
function feature(name: string, over: Partial<PluginRecord> = {}): PluginRecord {
  return {
    name,
    manifest: null,
    status: 'error',
    builtin: true,
    meta: { name, version: '0.1.0', description: '', kind: 'feature' },
    ...over,
  };
}

describe('failedProducts：只认产物面的失败（disabled 是用户意愿，不算）', () => {
  it('error / blocked 计入；active / disabled / 内核 service 不计入', () => {
    const records: PluginRecord[] = [
      feature('hologram/paper-shell', { status: 'error', error: SKEW_MSG }),
      feature('hologram/ask-cards', { status: 'blocked', missingPermissions: ['bash'], error: undefined }),
      feature('hologram/renderers', { status: 'disabled' }),
      feature('hologram/sessions-home', { status: 'active', error: undefined }),
      {
        name: 'hologram/tools-service',
        manifest: null,
        status: 'error',
        error: 'x',
        builtin: true,
        meta: { name: 'hologram/tools-service', version: '0.1.0', description: '', kind: 'service' },
      },
    ];
    expect(failedProducts(records).map((r) => r.name)).toEqual(['hologram/paper-shell', 'hologram/ask-cards']);
  });
});

describe('isSkewError：两把闸的具名文案', () => {
  it('指纹闸 / 键集闸都算偏斜；其它错误不算', () => {
    expect(isSkewError(feature('a', { error: SKEW_MSG }))).toBe(true);
    expect(
      isSkewError(feature('b', { error: '宿主面缺键（产物与 exe 版本偏斜，拒载防渲染期整树卸载）: ANCHOR' })),
    ).toBe(true);
    expect(isSkewError(feature('c', { error: '插件入口未导出 { name, apply } 形状的对象' }))).toBe(false);
    expect(isSkewError(feature('d'))).toBe(false);
  });
});

describe('diagnoseBoot：因果优先序 产物失败 > 引导异常 > 空壳', () => {
  it('① 全部失败都是指纹偏斜 ⇒ skew，并给出重建 exe 的指引', () => {
    const f = diagnoseBoot({
      error: null,
      records: [
        feature('hologram/paper-shell', { error: SKEW_MSG }),
        feature('hologram/task-domain', { error: SKEW_MSG }),
      ],
      homeViews: 0,
      logPath: 'D:/ws/.lantai/logs/ui.log',
    });
    expect(f?.kind).toBe('skew');
    expect(f?.summary).toContain('2 个出厂产物被拒载');
    expect(f?.hints.join('\n')).toContain('build.cmd');
    expect(f?.hints.join('\n')).toContain('日志：D:/ws/.lantai/logs/ui.log');
    // 证据逐条列出插件名 + 原因（不倾倒全表）
    expect(f?.evidence[0]).toContain('hologram/paper-shell');
  });

  it('② 非偏斜失败 ⇒ product；证据超过 12 条时如实记账余数', () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      feature('hologram/p' + i, { error: '插件入口未导出 { name, apply } 形状的对象' }),
    );
    const f = diagnoseBoot({ error: null, records, homeViews: 1 });
    expect(f?.kind).toBe('product');
    expect(f?.summary).toContain('15 个出厂产物装载失败');
    expect(f?.evidence).toHaveLength(13); // 12 条 + 余数行
    expect(f?.evidence[12]).toContain('另有 3 条');
  });

  it('③ 产物失败与引导异常同时发生 ⇒ 仍报产物（根因优先），异常只作一条线索', () => {
    const f = diagnoseBoot({
      error: new Error('[boot-gate] 插件装载失败:\n  - hologram/task-domain: x'),
      records: [feature('hologram/paper-shell', { error: SKEW_MSG })],
      homeViews: 0,
    });
    expect(f?.kind).toBe('skew');
    expect(f?.evidence.some((e) => e.includes('引导链同时报错'))).toBe(true);
  });

  it('④ 只有引导异常：带 [boot-gate] ⇒ audit，否则 ⇒ shell', () => {
    const audit = diagnoseBoot({
      error: new Error('[boot-gate] 插件装载失败:\n  - hologram/tools-service: state=0（依赖永缺）'),
      records: [],
      homeViews: 1,
    });
    expect(audit?.kind).toBe('audit');
    expect(audit?.evidence.join('\n')).toContain('hologram/tools-service');

    const shell = diagnoseBoot({ error: new Error('apply boom'), records: [], homeViews: 1 });
    expect(shell?.kind).toBe('shell');
  });

  it('⑤ 假绿兜底：无失败记录、无异常，但首帧 home 槽为空 ⇒ empty-shell', () => {
    const f = diagnoseBoot({
      error: null,
      records: [feature('a', { status: 'active', error: undefined })],
      homeViews: 0,
    });
    expect(f?.kind).toBe('empty-shell');
    expect(f?.summary).toContain('没有任何内容可渲染');
  });

  it('⑥ 一切正常 ⇒ null（不打扰）', () => {
    expect(
      diagnoseBoot({
        error: null,
        records: [feature('hologram/paper-shell', { status: 'active', error: undefined })],
        homeViews: 1,
      }),
    ).toBeNull();
  });
});

describe('安全模式（防砖）：判定 + 说明面', () => {
  it('连续失败未到阈值 ⇒ 不强制；超过阈值 ⇒ 自动进；用户旗标 ⇒ 用户意图', () => {
    expect(safeModeRequest(1, false)).toEqual({ forced: false, reason: null });
    expect(safeModeRequest(2, false)).toEqual({ forced: false, reason: null });
    expect(safeModeRequest(3, false)).toEqual({ forced: true, reason: 'attempts' });
    expect(safeModeRequest(1, true)).toEqual({ forced: true, reason: 'user' });
  });

  it('说明面写清「跳过了什么」与「怎么退出」', () => {
    const auto = safeModeFailure('attempts', 3);
    expect(auto.kind).toBe('safe-mode');
    expect(auto.summary).toContain('连续 3 次');
    expect(auto.evidence.join('\n')).toContain('退出安全模式');
    expect(safeModeFailure('user', 1).summary).toContain('跳过了全部出厂产物装载');
  });
});

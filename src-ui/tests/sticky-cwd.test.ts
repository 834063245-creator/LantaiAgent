// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 粘性 cwd TS 编排层测试（R3-d，kernel-capability-c3-design.md §9 裁定：
// 粘性归 TS，Rust sticky_cwd.rs 随 builtin.shell 退役拆除——本文件是原 Rust
// sticky_cwd.rs 滤波器测试的 TS 转录 + session-context 粘性字段生命周期）。

import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearOwnerContextsForTest,
  registerOwnerContext,
  setStickyCwd,
  stickyCwdOf,
} from '../src/agent/session-context';
import { CWD_MARKER_END, CWD_MARKER_START, CwdMarkerFilter, normalizeMsysPath } from '../src/agent/sticky-cwd';

beforeEach(() => {
  clearOwnerContextsForTest();
});

afterEach(() => {
  clearOwnerContextsForTest();
});

function tmpdir(tag: string): string {
  return path.join(os.tmpdir(), `lantai_sticky_ts_${tag}_${process.pid}`);
}

describe('normalizeMsysPath（MSYS → Windows 规整）', () => {
  it('盘符挂载直转（绝对主流形态）', () => {
    expect(normalizeMsysPath('/d/HoloGramHG/engine')).toBe('d:/HoloGramHG/engine');
    expect(normalizeMsysPath('/c/')).toBe('c:/');
  });

  it('UNC / 相对路径 → null（放弃捕获，粘性不动自愈）', () => {
    expect(normalizeMsysPath('//server/share')).toBeNull();
    expect(normalizeMsysPath('relative/x')).toBeNull();
  });

  it('Windows 风格直通（pwsh 路径）', () => {
    expect(normalizeMsysPath('D:\\HoloGramHG\\src-ui')).toBe('D:\\HoloGramHG\\src-ui');
  });
});

describe('CwdMarkerFilter（流式截流 + 捕获提交）', () => {
  it('完整 marker：剥除、捕获归一化落点、后续放行', () => {
    const f = new CwdMarkerFilter();
    const { clean, captured } = f.push(`build ok\n${CWD_MARKER_START}/d/HoloGramHG/engine${CWD_MARKER_END}\n`);
    // printf 不带换行；本例 marker 后带 \n，随余段一起放行 → "build ok\n" + "\n"
    expect(clean).toBe('build ok\n\n');
    expect(captured).toBe('d:/HoloGramHG/engine');
    // 已捕获后放行一切（每次命令只有一个 marker）
    const second = f.push('more');
    expect(second.clean).toBe('more');
    expect(second.captured).toBeNull();
  });

  it('跨块分裂：START / 路径 / END 各自分裂在多块之间', () => {
    const f = new CwdMarkerFilter();
    const real = tmpdir('split').replace(/\\/g, '/');
    const msys = `/${real[0]?.toLowerCase()}${real.slice(2)}`;
    const p1 = f.push(`before${CWD_MARKER_START.slice(0, 5)}`);
    expect(p1.clean).toBe('before');
    expect(p1.captured).toBeNull();
    const p2 = f.push(`${CWD_MARKER_START.slice(5)}${msys}${CWD_MARKER_END}tail`);
    expect(normalizeMsysPath(msys)).not.toBeNull(); // 卫：tmpdir 形态必然可归一
    expect(p2.captured).toBe(normalizeMsysPath(msys));
    expect(p2.clean).toBe('tail');
  });

  it('无 marker 尾段挂起：flush 原样放行（无提交）', () => {
    const f = new CwdMarkerFilter();
    const p = f.push(`tail${CWD_MARKER_START.slice(0, 5)}`);
    expect(p.clean).toBe('tail');
    expect(p.captured).toBeNull();
    expect(f.flush()).toBe(CWD_MARKER_START.slice(0, 5));
  });

  it('伪 marker（带换行）：放行且不再截留（命令自己 echo 的同形文本）', () => {
    const f = new CwdMarkerFilter();
    const { clean, captured } = f.push(`echo ${CWD_MARKER_START}not-a-path\nnext`);
    expect(captured).toBeNull();
    expect(clean).toContain('not-a-path');
    expect(clean).not.toContain('next', '换行后的正文应在挂起区等后续块');
    expect(f.flush()).toBe('next');
  });

  it('marker 未闭合超 4KB：全部放行 + consumed（挂起上限保护）', () => {
    const f = new CwdMarkerFilter();
    const huge = `${CWD_MARKER_START}${'x'.repeat(5000)}`;
    const { clean, captured } = f.push(huge);
    expect(captured).toBeNull();
    expect(clean.length).toBe(huge.length);
    const after = f.push('trailing');
    expect(after.clean).toBe('trailing');
    expect(after.captured).toBeNull();
  });

  it('不可归一化路径（UNC）：marker 剥除但 captured 为 null（粘性不动自愈）', () => {
    const f = new CwdMarkerFilter();
    const { clean, captured } = f.push(`${CWD_MARKER_START}//server/share${CWD_MARKER_END}rest`);
    expect(captured).toBeNull();
    expect(clean).toBe('rest');
  });
});

describe('session-context stickyCwd（per-owner 注册表）', () => {
  it('注册 owner 可读写粘性值；未注册 owner 静默忽略（UI/直连路径无粘性）', () => {
    const dispose = registerOwnerContext('agent-a', 'D:/proj-a');
    expect(stickyCwdOf('agent-a')).toBeUndefined();
    setStickyCwd('agent-a', 'D:/proj-a/sub');
    expect(stickyCwdOf('agent-a')).toBe('D:/proj-a/sub');
    // 未注册 owner：设置不生效（无行可写）
    setStickyCwd('agent-b', 'D:/nowhere');
    expect(stickyCwdOf('agent-b')).toBeUndefined();
    dispose();
  });

  it('owner 拆卸（agent 拆卸 = 切工作区重置）后粘性值消失', () => {
    const dispose = registerOwnerContext('agent-c', 'D:/proj-b');
    setStickyCwd('agent-c', 'D:/proj-b/deep');
    expect(stickyCwdOf('agent-c')).toBe('D:/proj-b/deep');
    dispose();
    expect(stickyCwdOf('agent-c')).toBeUndefined();
  });

  it('截流器捕获 → 提交流（滤波器 + 注册表组合语义）', () => {
    const dispose = registerOwnerContext('agent-d', 'D:/proj-d');
    const f = new CwdMarkerFilter();
    const { clean, captured } = f.push(`ok\n${CWD_MARKER_START}/d/proj-d/engine${CWD_MARKER_END}\n`);
    expect(clean).toBe('ok\n\n');
    if (captured != null) setStickyCwd('agent-d', captured);
    expect(stickyCwdOf('agent-d')).toBe('d:/proj-d/engine');
    dispose();
  });
});

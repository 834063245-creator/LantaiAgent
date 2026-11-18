// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 记忆注入上限：MEMORY_LIMIT 曾是一条**死代码**（2026-11-19 修复）。
//
// 历史：超过 10 条时按「与当前图节点的相关性」排序取前 10。图谱退役（2026-09-09）
// 后全部调用点都不传 graphNodes（workspace / runtime 各一处），判据
// `graphNodes && length > 0` 恒假 ⇒ 上限从未生效：26 条项目记忆每次全量注入
// 2,250 token（实测），而设计意图是 10 条 / 831 token。
//
// 现在：上限恢复，排序键换成**无图谱时代仍在的**那个信号 —— hit_count（回想频率），
// 图相关性作有锚时的主键。fact 恒含（用户明确要求的规则不该被频率挤掉）。
//
// mock 站到 rpc-contract 具名 helper 层（与 memory-delete-integrity 同一套内存 fs）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  kernelFs: null as null | ReturnType<typeof import('./helpers/kernel-fs').createKernelFsMock>,
}));

vi.mock('../src/rpc-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rpc-contract')>();
  H.kernelFs = (await import('./helpers/kernel-fs')).createKernelFsMock();
  return { ...actual, ...H.kernelFs.overrides };
});

import { MemoryManager } from '../src/plugins/builtin/memory-domain/memory';

const ROOT = 'D:/proj';
const MEM_DIR = ROOT + '/.lantai/memory';

function disk() {
  return H.kernelFs!.fs;
}

/** 直接往内存盘写一条记忆 + 索引行（不经过 save，便于精确控制 hit_count）。 */
function seedOne(name: string, opts: { desc: string; body: string; hit?: number; conf?: string }): string {
  const raw = [
    '---',
    'name: ' + name,
    'description: ' + opts.desc,
    'metadata:',
    '  type: project',
    '  confidence: ' + (opts.conf ?? 'reference'),
    '  hit_count: ' + (opts.hit ?? 0),
    '---',
    '',
    opts.body,
  ].join('\n');
  disk().files.set(MEM_DIR + '/' + name + '.md', raw);
  return '- [' + opts.desc + '](' + name + '.md) — ' + opts.desc;
}

function seedIndex(lines: string[]) {
  disk().files.set(MEM_DIR + '/MEMORY.md', lines.join('\n'));
}

function bulletsOf(section: string): string[] {
  return section.split('\n').filter((l) => l.startsWith('- **'));
}

describe('记忆注入上限（MEMORY_LIMIT 复活）', () => {
  beforeEach(() => {
    const k = disk();
    k.files.clear();
    k.dirs.clear();
    k.writes.length = 0;
    k.fail = {};
  });

  it('超过 10 条时只注入 10 条 —— 上限真的生效了', async () => {
    const idx: string[] = [];
    for (let i = 0; i < 26; i++) idx.push(seedOne('m' + i, { desc: '记忆' + i, body: '正文' + i }));
    seedIndex(idx);
    const section = await new MemoryManager(ROOT).loadPromptSection();
    expect(bulletsOf(section)).toHaveLength(10);
  });

  it('按回想频率取前 10（无图锚时的判据）', async () => {
    const idx: string[] = [];
    for (let i = 0; i < 12; i++) idx.push(seedOne('m' + i, { desc: '记忆' + i, body: '正文' + i, hit: i }));
    seedIndex(idx);
    const section = await new MemoryManager(ROOT).loadPromptSection();
    // 频率最高的 m11 必在；频率最低的 m0 应被挤掉
    expect(section).toContain('记忆11');
    expect(section).not.toContain('记忆0**');
    expect(bulletsOf(section)).toHaveLength(10);
  });

  it('fact 恒含 —— 不被频率挤掉（用户明确要求的规则）', async () => {
    const idx: string[] = [];
    idx.push(seedOne('rule', { desc: '铁律', body: '必须遵守', conf: 'fact', hit: 0 }));
    for (let i = 0; i < 11; i++) idx.push(seedOne('m' + i, { desc: '记忆' + i, body: '正文' + i, hit: 99 }));
    seedIndex(idx);
    const section = await new MemoryManager(ROOT).loadPromptSection();
    expect(section).toContain('铁律');
    expect(bulletsOf(section)).toHaveLength(10); // 1 fact + 9 reference
  });

  it('不超过 10 条时全量注入（上限不误伤小记忆库）', async () => {
    const idx: string[] = [];
    for (let i = 0; i < 3; i++) idx.push(seedOne('m' + i, { desc: '记忆' + i, body: '正文' + i }));
    seedIndex(idx);
    const section = await new MemoryManager(ROOT).loadPromptSection();
    expect(section).toContain('记忆0');
    expect(section).toContain('记忆1');
    expect(section).toContain('记忆2');
  });
});

// Copyright (c) 2026 Wenbing Jing. MIT License. SPDX-License-Identifier: MIT

// fs_cap 返回形状回归钉（2026-09-05「加载不出历史会话」修复 → 2026-09-26 单形态化）。
//
// 病理（第一版，双形态时代）：fs_cap 是 JsonValue 形态 RPC——真实 Tauri 运行时
// Rust 出口已把 JSON 展开为真结构化 Value（对象），而 fs helper 群
// （kernelReadFileRaw / kernelListDirectory / kernelReadMemoryBatch…）按「返回
// JSON 字符串」编写，对对象 JSON.parse → "[object Object]" 炸 → catch 直通信封
// 对象 → 消费方二次 parse 再炸 / zod 拒收包装体。全链路静默 null：会话卷读取
// 失败、列表恒空、发号对账归零、画布恢复空。
// 当时的修法是**每处 helper 都写双形态守卫**——治住了症状，代价是把形态猜测
// 永久留在代码里（每处解包都带 `typeof raw === 'string'` 分支）。
//
// 终态（2026-09-26）：mock 与真机同形，双形态分支整体删除。本文件现在钉两件事：
//   ① 真机线形（结构化对象）下 helper 正确解包——712fda8d 那类静默 null 不回潮；
//   ② 字符串线形**不再被接受**：当出口分类漂移时 helper 必须显式 throw，
//      不许把「形态错位」读成「文件是空的」。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();

vi.mock('../src/bridge', () => ({
  rpc: (method: string, params?: Record<string, unknown>) => rpcMock(method, params),
  invoke: vi.fn(),
  listen: vi.fn().mockResolvedValue(() => {}),
  isMockMode: () => false,
}));

vi.mock('../src/ui/graph', () => ({ StarGraph: class {} }));
vi.mock('../src/ui/icons', () => ({ iconHtml: () => '', iconSvg: () => '' }));
vi.mock('../src/ui/app-shell', () => ({ appShell: {} }));
vi.mock('../src/agent/permission', () => ({
  showApprovalDialog: vi.fn(),
  cancelPendingApprovals: vi.fn(),
}));
vi.mock('../src/agent/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/settings', () => ({ loadSettings: () => ({ display: { language: 'zh', fontScale: 1 } }) }));

import { kernelListDirectory, kernelReadFileRaw, kernelReadMemoryBatch } from '../src/rpc-contract';

beforeEach(() => {
  rpcMock.mockReset();
});

describe('fs_cap 返回形状（单形态：结构化对象）', () => {
  it('kernelListDirectory：{entries} + children:null（Rust 真实形状）→ 正常返回', async () => {
    // Rust 出口形状：fs_cap list → json!({entries: DirEntry[]}) 展开；
    // 文件条目 children 恒在（null）——线格式契约见 confined_fs
    // dir_entry_wire_format_children_key_always_present。
    rpcMock.mockResolvedValue({
      entries: [
        { name: '12.json', path: 'D:/ws/.lantai/sessions/12.json', is_dir: false, children: null },
        { name: 'sub', path: 'D:/ws/.lantai/sessions/sub', is_dir: true, children: [] },
      ],
    });
    const entries = await kernelListDirectory('D:/ws/.lantai/sessions', false);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('12.json');
    expect(entries[0].children).toBeNull();
    expect(rpcMock).toHaveBeenCalledWith('fs_cap', expect.objectContaining({ action: 'list' }));
  });

  it('kernelListDirectory：JSON 字符串线形 → 显式违形（不许读成空列表）', async () => {
    // 行为变更（2026-09-26）：字符串形态不再被 parse。出口分类漂移时
    // helper 必须喊出来——把「形态错位」读成「目录是空的」正是 712fda8d
    // 那类静默事故的土壤。
    rpcMock.mockResolvedValue(
      JSON.stringify({ entries: [{ name: '1.json', path: 'D:/x/1.json', is_dir: false, children: null }] }),
    );
    await expect(kernelListDirectory('D:/ws/.lantai/sessions', false)).rejects.toThrow(/返回形状违反契约/);
  });

  it('kernelReadFileRaw：{path, content} 结构化对象 → 解出 content 原文（而非信封）', async () => {
    const volume = JSON.stringify({ id: 12, label: '案卷 12', messages: [{ role: 'user', parts: [] }] });
    rpcMock.mockResolvedValue({ path: 'D:/ws/.lantai/sessions/12.json', content: volume });
    const raw = await kernelReadFileRaw('D:/ws/.lantai/sessions/12.json');
    // 回归点：修复前此处返回信封对象本身，消费方 JSON.parse 再炸 → 静默 null。
    expect(typeof raw).toBe('string');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).id).toBe(12);
  });

  it('kernelReadMemoryBatch：结构化对象 → 正常返回记录', async () => {
    rpcMock.mockResolvedValue({ 'a.json': 'A', 'b.json': null });
    const out = await kernelReadMemoryBatch(['a.json', 'b.json']);
    expect(out).toEqual({ 'a.json': 'A', 'b.json': null });
  });
});

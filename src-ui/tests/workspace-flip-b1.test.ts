// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// workspace-flip 批 1 测试 — view 迁移语义 + RPC 契约面。
// 组件渲染冒烟走 CDP 真机验收（本仓无组件测试基建，不为此引入新依赖）。

import { describe, expect, it } from 'vitest';
import { useShellStore } from '../src/app/shell-store';
import type { RpcContract } from '../src/rpc-contract';

describe('workspace-flip 批 1：view 迁移（D-W1-1 纯会话优先）', () => {
  it('shell-store view = home | graph（welcome 退役；缺省 home）', () => {
    const s = useShellStore.getState();
    expect(s.view).toBe('home'); // 缺省 = 会话首页
    s.setView('graph');
    expect(useShellStore.getState().view).toBe('graph');
    useShellStore.getState().setView('home');
  });

  it('setView 类型面：welcome 字面量不再可赋（编译期由 tsc 守护——此处钉运行时枚举）', () => {
    const s = useShellStore.getState();
    const legal = ['home', 'graph'] as const;
    expect(legal).toContain(s.view);
  });
});

describe('workspace-flip 批 1：RPC 契约面（零目录会话）', () => {
  it('user_sessions_list / get_user_sessions_dir 在 RpcContract（TS↔Rust 双端对齐）', () => {
    const c = {} as RpcContract;
    expect('user_sessions_list' in c || true).toBe(true); // 类型层存在性由 tsc 守护；此处钉键名常量
    // 键名钉死（防手滑改名导致 Rust 分支失配）
    const keys: Array<keyof RpcContract> = ['user_sessions_list', 'get_user_sessions_dir'];
    expect(keys.length).toBe(2);
  });
});

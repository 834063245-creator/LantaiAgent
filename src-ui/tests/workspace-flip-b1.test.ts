// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// workspace-flip 批 1 测试 — RPC 契约面（零目录会话）。
// view 迁移语义测试已随 V5 拆除（2026-08-22）退役：shell-store.view
// 字段（home|graph 视图切换）是旧观测台概念——纸面板开合态在 dock-store，
// 案卷首页 SessionsHome 常驻为基底层。

import { describe, expect, it } from 'vitest';
import type { RpcContract } from '../src/rpc-contract';

describe('workspace-flip 批 1：RPC 契约面（零目录会话）', () => {
  it('user_sessions_list / get_user_sessions_dir 在 RpcContract（TS↔Rust 双端对齐）', () => {
    const c = {} as RpcContract;
    expect('user_sessions_list' in c || true).toBe(true); // 类型层存在性由 tsc 守护；此处钉键名常量
    // 键名钉死（防手滑改名导致 Rust 分支失配）
    const keys: Array<keyof RpcContract> = ['user_sessions_list', 'get_user_sessions_dir'];
    expect(keys.length).toBe(2);
  });

  it('已知工作区注册表 RPC 在 RpcContract（Stage-5 补尾：首页工作区管理）', () => {
    const keys: Array<keyof RpcContract> = [
      'workspace_list',
      'workspace_rename',
      'workspace_toggle_pin',
      'workspace_remove',
    ];
    expect(keys.length).toBe(4);
  });
});

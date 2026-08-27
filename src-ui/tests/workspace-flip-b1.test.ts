// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// workspace-flip 批 1 测试 — RPC 契约面。
// workspace-session-ownership-rework（2026-08-27）：user_sessions_list /
// get_user_sessions_dir（零目录/全局会话列表）随「会话物理归属工作区」退役——
// 首页工作区清单由 workspace_list 承担，会话列表按工作区会话根扫描。
// view 迁移语义测试已随 V5 拆除（2026-08-22）退役：shell-store.view
// 字段（home|graph 视图切换）是旧观测台概念——纸面板开合态在 dock-store，
// 案卷首页 SessionsHome 常驻为基底层。

import { describe, expect, it } from 'vitest';
import type { RpcContract } from '../src/rpc-contract';

describe('workspace-flip 批 1：RPC 契约面', () => {
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置会话持久化 provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/sessions-provider.ts
// 整体迁入；运行时依赖 typedRpc 经宿主桥取用。

import type {
  SessionPersistAction,
  SessionPersistenceProvider,
} from '../../../composition/session-persistence-service';
import type { Context } from '../../../cordis';
import { typedRpc } from './host';

/** 会话持久化动作 → Rust 命令绑定的类型（typedRpc 泛型约束）。 */
type SessionRpcMethod = Parameters<typeof typedRpc>[0];

/** 会话持久化动作 → Rust 命令绑定（现状恒等映射）。 */
export const SESSIONS_COMMAND_BY_ACTION: Record<SessionPersistAction, SessionRpcMethod> = {
  read: 'read_file_content',
  write: 'write_file_content',
  append: 'agent_session_append',
  appendLog: 'log_append',
  mkdir: 'create_directory',
  delete: 'delete_file_or_dir',
};

/** 默认 Rust 会话持久化 provider（id 'builtin/rust-sessions'）。 */
export const builtinSessionsProvider: SessionPersistenceProvider = {
  id: 'builtin/rust-sessions',
  async execute(action, args) {
    const result = await typedRpc(SESSIONS_COMMAND_BY_ACTION[action], args as never);
    return result ?? '';
  },
};

/** builtin 会话持久化 provider 贡献插件（loader 表序：sessionPersistenceServicePlugin 之后）。 */
export const builtinSessionsPlugin = {
  name: 'hologram/sessions-builtin',
  inject: ['sessionPersistence'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.sessionPersistence.register(builtinSessionsProvider), 'sessions-builtin');
  },
};

export default builtinSessionsPlugin;

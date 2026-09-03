// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置会话持久化 provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/sessions-provider.ts
// 整体迁入；运行时依赖 typedRpc 经宿主桥取用。
// kernel-plugin-runtime P2-2：fs 域动作（read/write/appendLog/mkdir/delete）
// 换 tool_call 信封寻址 builtin.fs（旧 RPC 分支退役）；append（会话 NDJSON
// 增量 agent_session_append）保留 RPC 直呼——非 fs 域命令。

import type {
  SessionPersistAction,
  SessionPersistenceProvider,
} from '../../../composition/session-persistence-service';
import type { Context } from '../../../cordis';
import { typedRpc } from './host';

/** 会话持久化动作 → tool_call 信封目标（fs 域动作；append 走 RPC 直呼，
 *  见 builtinSessionsProvider——会话 NDJSON 增量非 fs 域命令）。
 *  导出供 sessions-seam.test.ts 形状钉（P2-C1 惯例，同 FS_PLUGIN_TOOL_BY_ACTION）。 */
export const SESSIONS_PLUGIN_TOOL_BY_ACTION: Partial<Record<SessionPersistAction, { plugin: string; tool: string }>> = {
  read: { plugin: 'builtin.fs', tool: 'read_file_content' },
  write: { plugin: 'builtin.fs', tool: 'write_file_content' },
  appendLog: { plugin: 'builtin.fs', tool: 'log_append' },
  mkdir: { plugin: 'builtin.fs', tool: 'create_directory' },
  delete: { plugin: 'builtin.fs', tool: 'delete_file_or_dir' },
};

/** seam 的 snake_case args（与旧 RPC 参数逐字节一致）→ 插件 manifest 的
 *  camelCase 键（fs 域动作；path/content 本就同形）。 */
function fsPluginArgs(action: SessionPersistAction, args: Record<string, unknown>): Record<string, unknown> {
  switch (action) {
    case 'read':
      return { filePath: args.file_path };
    case 'write':
      return { filePath: args.file_path, content: args.content };
    case 'appendLog':
      return { path: args.path, content: args.content };
    case 'mkdir':
    case 'delete':
      return { path: args.path };
    default:
      return args;
  }
}

/** 默认 Rust 会话持久化 provider（id 'builtin/rust-sessions'）。 */
export const builtinSessionsProvider: SessionPersistenceProvider = {
  id: 'builtin/rust-sessions',
  async execute(action, args) {
    const envelope = SESSIONS_PLUGIN_TOOL_BY_ACTION[action];
    const result = envelope
      ? await typedRpc('tool_call', {
          plugin: envelope.plugin,
          tool: envelope.tool,
          args: fsPluginArgs(action, args),
        })
      : await typedRpc('agent_session_append', args as never); // append（NDJSON 增量）
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

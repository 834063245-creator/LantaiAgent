// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置会话持久化 provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/sessions-provider.ts
// 整体迁入；运行时依赖 typedRpc 经宿主桥取用。
// P2-2 曾把 fs 域动作（read/write/appendLog/mkdir/delete）改走 tool_call 信封
// 寻址 builtin.fs；R5 脚手架拆除（2026-09-05）信封退役——fs 域动作换 fs_cap
// 能力口直呼。seam 的 args 本就是 snake_case RPC 参数（无腰设计，无键映射，
// 顶层透传）；append（会话 NDJSON 增量 agent_session_append）保留 RPC 直呼
// ——非 fs 域命令。

import type {
  SessionPersistAction,
  SessionPersistenceProvider,
} from '../../../composition/session-persistence-service';
import type { Context } from '../../../cordis';
import { typedRpc } from './host';

/** 会话持久化动作 → fs_cap 能力口动作（fs 域五动作；append 走 RPC 直呼，
 *  见 builtinSessionsProvider——会话 NDJSON 增量非 fs 域命令）。
 *  导出供 sessions-seam.test.ts 形状钉（P2-C1 惯例，同 fs-builtin
 *  FS_ACTION_TO_CAP）。read 即 fs_cap 原文语义（缺省 line_numbers=false——
 *  JSON 消费面惯用形，kernelReadFileRaw/canvas 先例；信封时代 read_file_content
 *  默认行号文本由旧消费面 agent-store 自剥，该消费面已内存化退役，无字节级
 *  保真对象）。 */
export const SESSIONS_FS_CAP_BY_ACTION: Partial<
  Record<SessionPersistAction, 'read' | 'write' | 'append' | 'create_dir' | 'delete'>
> = {
  read: 'read',
  write: 'write',
  appendLog: 'append',
  mkdir: 'create_dir',
  delete: 'delete',
};

/** 默认 Rust 会话持久化 provider（id 'builtin/rust-sessions'）。 */
export const builtinSessionsProvider: SessionPersistenceProvider = {
  id: 'builtin/rust-sessions',
  async execute(action, args) {
    const capAction = SESSIONS_FS_CAP_BY_ACTION[action];
    if (!capAction) {
      return (await typedRpc('agent_session_append', args as never)) ?? ''; // append（NDJSON 增量）
    }
    const raw = await typedRpc('fs_cap', { ...args, action: capAction } as never);
    if (action === 'read') {
      // fs_cap read 返回 {path, content}——解包 content 原文（fs-builtin read 分支
      // 同款；非 JSON（异常文本）直通）。
      try {
        const parsed = JSON.parse(raw) as { content?: unknown };
        if (typeof parsed.content === 'string') return parsed.content;
      } catch {
        // 非 JSON——直通
      }
    }
    return raw ?? '';
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

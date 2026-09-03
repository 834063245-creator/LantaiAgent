// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 fs provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/fs-provider.ts
// 整体迁入；零运行时依赖（类型导入经 esbuild 擦除，产物自包含）。

import type { FsAction, FsProvider } from '../../../composition/fs-service';
import type { Context } from '../../../cordis';

/** fs 动作 → tool_call 信封目标（kernel-plugin-runtime P2-2 收满：fs/editor/
 *  constraints 三域全部经信封寻址 builtin.<插件>.<工具>，旧 RPC 分支退役）。
 *  信封外层键（plugin/tool/args）单字无大小写歧义，args 原样（camelCase 不
 *  经 bridge 转换——manifest schema 的语言）。
 *  该表同时是 coding.ts manifest 驱动工具面的 schema 寻址真源。 */
export const FS_PLUGIN_TOOL_BY_ACTION: Record<FsAction, { plugin: string; tool: string }> = {
  read: { plugin: 'builtin.fs', tool: 'read_file_content' },
  write: { plugin: 'builtin.fs', tool: 'write_file_content' },
  edit: { plugin: 'builtin.editor', tool: 'edit_file' },
  list: { plugin: 'builtin.fs', tool: 'list_directory' },
  glob: { plugin: 'builtin.fs', tool: 'glob' },
  mkdir: { plugin: 'builtin.fs', tool: 'create_directory' },
  move: { plugin: 'builtin.fs', tool: 'move_file' },
  rename: { plugin: 'builtin.fs', tool: 'rename_file_or_dir' },
  delete: { plugin: 'builtin.fs', tool: 'delete_file_or_dir' },
  constraints: { plugin: 'builtin.constraints', tool: 'read_constraints' },
  write_constraints: { plugin: 'builtin.constraints', tool: 'write_constraints' },
};

/** 默认 Rust fs provider（id 'builtin/rust-fs'）。 */
export const builtinFsProvider: FsProvider = {
  id: 'builtin/rust-fs',
  execute(action, args, opts) {
    const envelope = FS_PLUGIN_TOOL_BY_ACTION[action];
    return opts.dispatch(
      'tool_call',
      { plugin: envelope.plugin, tool: envelope.tool, args },
      opts.onProgress,
      opts.signal,
    );
  },
};

/** builtin fs provider 贡献插件（loader 表序：fsServicePlugin 之后）。 */
export const builtinFsPlugin = {
  name: 'hologram/fs-builtin',
  inject: ['fs'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.fs.register(builtinFsProvider), 'fs-builtin');
  },
};

export default builtinFsPlugin;

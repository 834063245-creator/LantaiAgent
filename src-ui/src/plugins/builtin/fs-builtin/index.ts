// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 fs provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/fs-provider.ts
// 整体迁入；零运行时依赖（类型导入经 esbuild 擦除，产物自包含）。

import type { FsAction, FsProvider } from '../../../composition/fs-service';
import type { Context } from '../../../cordis';

/** fs 动作 → tool_call 信封目标（kernel-plugin-runtime P2-1 起：已迁内核插件的
 *  动作换信封寻址 builtin.<插件>.<工具>；表随各域批推进逐步填满，P2-2 收满）。
 *  信封外层键（plugin/tool/args）单字无大小写歧义，args 原样（camelCase 不
 *  经 bridge 转换——manifest schema 的语言）。 */
export const FS_PLUGIN_TOOL_BY_ACTION: Partial<Record<FsAction, { plugin: string; tool: string }>> = {
  edit: { plugin: 'builtin.editor', tool: 'edit_file' },
  constraints: { plugin: 'builtin.constraints', tool: 'read_constraints' },
  write_constraints: { plugin: 'builtin.constraints', tool: 'write_constraints' },
};

/** fs 动作 → Rust 命令绑定（尚未迁移插件的动作仍旧名直呼；rename 的
 *  path/new_name→filePath/newName 键名改写留在工具层——行为不变，
 *  见 coding.ts rename_file）。 */
export const FS_COMMAND_BY_ACTION: Record<FsAction, string> = {
  read: 'read_file_content',
  write: 'write_file_content',
  edit: 'edit_file',
  list: 'list_directory',
  glob: 'glob',
  mkdir: 'create_directory',
  move: 'move_file',
  rename: 'rename_file_or_dir',
  delete: 'delete_file_or_dir',
  constraints: 'read_constraints',
  write_constraints: 'write_constraints',
};

/** 默认 Rust fs provider（id 'builtin/rust-fs'）。 */
export const builtinFsProvider: FsProvider = {
  id: 'builtin/rust-fs',
  execute(action, args, opts) {
    const envelope = FS_PLUGIN_TOOL_BY_ACTION[action];
    if (envelope) {
      return opts.dispatch(
        'tool_call',
        { plugin: envelope.plugin, tool: envelope.tool, args },
        opts.onProgress,
        opts.signal,
      );
    }
    return opts.dispatch(FS_COMMAND_BY_ACTION[action], args, opts.onProgress, opts.signal);
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

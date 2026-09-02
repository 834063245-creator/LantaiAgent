// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 fs provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/fs-provider.ts
// 整体迁入；零运行时依赖（类型导入经 esbuild 擦除，产物自包含）。

import type { FsAction, FsProvider } from '../../../composition/fs-service';
import type { Context } from '../../../cordis';

/** fs 动作 → Rust 命令绑定（现状恒等映射；rename 的 path/new_name→filePath/newName
 *  键名改写留在工具层——行为不变，见 coding.ts rename_file）。 */
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

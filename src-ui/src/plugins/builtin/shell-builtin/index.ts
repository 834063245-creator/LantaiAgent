// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 shell provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/shell-provider.ts
// 整体迁入；零运行时依赖（类型导入经 esbuild 擦除，产物自包含）。

import type { ShellAction, ShellProvider } from '../../../composition/shell-service';
import type { Context } from '../../../cordis';

/** shell 动作 → Rust 命令绑定（现状恒等映射）。 */
export const SHELL_COMMAND_BY_ACTION: Record<ShellAction, string> = {
  run: 'exec_command',
  output: 'bash_output',
  kill: 'bash_kill',
  wait: 'bash_wait',
};

/** 默认 Rust shell provider（id 'builtin/rust-shell'）。 */
export const builtinShellProvider: ShellProvider = {
  id: 'builtin/rust-shell',
  execute(action, args, opts) {
    return opts.dispatch(SHELL_COMMAND_BY_ACTION[action], args, opts.onProgress, opts.signal);
  },
};

/** builtin shell provider 贡献插件（loader 表序：shellServicePlugin 之后）。 */
export const builtinShellPlugin = {
  name: 'hologram/shell-builtin',
  inject: ['shell'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.shell.register(builtinShellProvider), 'shell-builtin');
  },
};

export default builtinShellPlugin;

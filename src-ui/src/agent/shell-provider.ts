// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 内置 shell provider（平台化 Phase 2 · D11 默认实现，2026-08-27）——
// 现有 Rust shell 命令的薄包装：动作→命令恒等映射经注入的 dispatch 腰转发，
// 零逻辑改动（行为与现状逐字节一致，由既有工具套件钉住）。

import type { ShellAction, ShellProvider } from '../composition/shell-service';
import type { Context } from '../cordis';

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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 内置 shell provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/shell-provider.ts
// 整体迁入；零运行时依赖（类型导入经 esbuild 擦除，产物自包含）。

import type { ShellAction, ShellProvider } from '../../../composition/shell-service';
import type { Context } from '../../../cordis';

/** shell 动作 → tool_call 信封目标（kernel-plugin-runtime P2-4 收满：
 *  run/output/kill/wait 经信封寻址 builtin.shell，旧 RPC 分支退役）。
 *  信封外层键（plugin/tool/args）单字无大小写歧义，args 原样（camelCase 不
 *  经 bridge 转换——manifest schema 的语言）。
 *  该表同时是 coding.ts manifest 驱动工具面的 schema 寻址真源。 */
export const SHELL_PLUGIN_TOOL_BY_ACTION: Record<ShellAction, { plugin: string; tool: string }> = {
  run: { plugin: 'builtin.shell', tool: 'exec_command' },
  output: { plugin: 'builtin.shell', tool: 'bash_output' },
  kill: { plugin: 'builtin.shell', tool: 'bash_kill' },
  wait: { plugin: 'builtin.shell', tool: 'bash_wait' },
};

/** 默认 Rust shell provider（id 'builtin/rust-shell'）。 */
export const builtinShellProvider: ShellProvider = {
  id: 'builtin/rust-shell',
  execute(action, args, opts) {
    const envelope = SHELL_PLUGIN_TOOL_BY_ACTION[action];
    return opts.dispatch(
      'tool_call',
      { plugin: envelope.plugin, tool: envelope.tool, args },
      opts.onProgress,
      opts.signal,
    );
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

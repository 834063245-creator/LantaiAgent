// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 内置 shell provider（平台化 Phase 2 · D11 默认实现）——真源产物化
// （plugin-bundle-retirement S2，2026-09-03）。原 agent/shell-provider.ts
// 整体迁入；零运行时依赖（类型导入经 esbuild 擦除，产物自包含）。
//
// shell 域收口（kernel-capability-c3-design.md R3-d）：execute 从 tool_call
// 信封（寻址 builtin.shell 插件——已退役）换 process_cap 能力口直呼——
// dispatch 即 exec（executor 注入 is_agent 到顶层，与 fs_cap/git_cap 同构）。
// 模型族工具 schema 真源已回 TS zod（coding.ts SHELL_CAP_SCHEMA）；粘性 cwd
// 候选值由工具层（coding.ts shellCapTool）注入 args.stickyCwd——本文件不做
// 注册表读（产物自包含纪律：bundle 内不能持有宿主 session-context 实例）。

import type { ShellAction, ShellProvider } from '../../../composition/shell-service';
import type { Context } from '../../../cordis';

/** shell 动作 → process_cap 能力口 action + 模型面键（camelCase）→ 顶层 snake 键。
 *  command/cwd/interpreter 本就 snake 安全（无大小写驼峰），映射表只列转换键。 */
const SHELL_ACTION_TO_CAP: Record<ShellAction, { action: string; keys: Record<string, string> }> = {
  run: {
    action: 'exec_command',
    keys: {
      timeoutMs: 'timeout_ms',
      runInBackground: 'run_in_background',
      streamToolId: 'stream_tool_id',
      stickyCwd: 'sticky_cwd',
    },
  },
  output: { action: 'bash_output', keys: { jobId: 'job_id' } },
  kill: { action: 'bash_kill', keys: { jobId: 'job_id' } },
  wait: { action: 'bash_wait', keys: { jobId: 'job_id', timeoutMs: 'wait_timeout_ms' } },
};

/** 把模型面 args（camelCase + meta）映射为 process_cap 顶层 snake 参数。
 *  meta 键（_owner_id/_agent_id/_forceGate/_callId）原样透传（executor 注入
 *  身份——snake 已保写下划线，bridge.rpc() 顶层转换对它们幂等）。 */
function toCapArgs(action: ShellAction, args: Record<string, unknown>): Record<string, unknown> {
  const { action: capAction, keys } = SHELL_ACTION_TO_CAP[action];
  const out: Record<string, unknown> = { action: capAction };
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('_')) {
      out[k] = v; // meta 透传
      continue;
    }
    out[keys[k] ?? k] = v;
  }
  return out;
}

/** 默认 Rust shell provider（id 'builtin/rust-shell'）——R3-d 起 execute 经
 *  process_cap 能力口直呼（dispatch 即 executor 的 codingExec——注入 is_agent，
 *  与 fs/git 直呼同构）。fg 流式语义：codingExec 对 exec_command 非后台调用
 *  拦截进 execStreamedShell（事件闭环零改）；后台三动词直通 ledger。 */
export const builtinShellProvider: ShellProvider = {
  id: 'builtin/rust-shell',
  execute(action, args, opts) {
    return opts.dispatch('process_cap', toCapArgs(action, args), opts.onProgress, opts.signal);
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

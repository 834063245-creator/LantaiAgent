// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// shell 域工具族（run/wait/job 等四动作）（**归家后真源**，2026-09-24 批 4c-3）。
//
// 来历：原 agent/tools/coding.ts（一文件载五族）的该段整段移出——定义逐字保留，
// 内核依赖改走包内宿主面（./host）。本批之后 coding.ts 整文件退役（五族全部归家）。
// sticky-cwd 取用经 faceDeps（该件留内核，见账本）；seam 裁剪读面同 fs 族。

import { z } from 'zod';
import {
  activeShellProviders,
  ownerIdOf,
  ownerSeamView,
  type ShellAction,
  stickyCwdOf,
  type Tool,
  type ToolExecutor,
  toInputJsonSchema,
} from './host';

/** shell 域消费面（平台化 Phase 2 · D11 施工⑤）：经 ctx.shell 注册表解析 provider
 *  （后注册胜；subprocess 并入本 seam——spawn/stdio/进程树即后台任务族，见计划
 *  D11 修订注记）。强制层 gate 在 executor 管道层、先于本调用——换 provider 不豁免。
 *  S6 P2a：同 fsExecute，provider 视图按本调用所属 Agent 的组合裁剪。 */
export function shellExecute(
  action: ShellAction,
  args: Record<string, unknown>,
  exec: ToolExecutor,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const providers = activeShellProviders(ownerSeamView(args));
  const provider = providers[providers.length - 1];
  if (!provider) {
    return Promise.reject(
      new Error('SHELL_PROVIDER: 无已注册 shell provider——请确认 shell 通道装配（生产 = loadBuiltinPlugins）'),
    );
  }
  return provider.execute(action, args, { dispatch: exec, onProgress, signal });
}

// ═══════════════════════════════════════════════════════════════
// shell 域模型族 zod 真源（kernel-capability-c3-design.md shell 域收口 R3-d，
// 2026-09-05）：builtin.shell 插件信封退役，shell 域 4 模型族工具 schema 真源
// 回 TS zod——逐键等价于退役前 manifest 的 schema 发射（键名 camelCase、
// description 字节、default/int 界/enum/additionalProperties 全对齐，
// convergence 快照 stableStringify 字典序下零漂移；fs/git 域同款范式）。
// shell_env/background_activity/drain_bg_notifications 是内部消费工具（无模型
// 面），不转录。execute 经 shellExecute → provider seam（builtinShellProvider
// → process_cap 直呼）；粘性 cwd 候选由本层注入（withStickyCwd——产物自包含
// 的 provider 不持宿主 session-context 实例）。
// ═══════════════════════════════════════════════════════════════

/** run_shell（exec_command）schema——manifest 字节转录（command/cwd/timeoutMs/
 *  runInBackground/interpreter；声明序 = manifest properties 序）。 */
const runShellSchema = z.object({
  command: z.string().describe('The shell command to run (e.g. "npm test", "cargo build", "pytest -x")'),
  cwd: z
    .string()
    .describe('Optional working directory for the command. Defaults to the current workspace root.')
    .optional(),
  timeoutMs: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(600000)
    .default(300000)
    .describe('Timeout in milliseconds (default: 300000 = 5 min, max: 600000 = 10 min)'),
  runInBackground: z
    .boolean()
    .default(false)
    .describe(
      'Set to true to run in background (returns job ID immediately). Use bash_output(id) to check progress, bash_wait(id) to wait for completion, bash_kill(id) to stop.',
    ),
  interpreter: z
    .enum(['bash', 'pwsh'])
    .describe(
      'Optional interpreter. Default/omit = bundled bash (Unix syntax). Set "pwsh" ONLY for Windows-native tasks bash cannot do (registry queries, ACL, MSI, COM, WMI) — PowerShell syntax required.',
    )
    .optional(),
});

/** bash 后台任务 jobId schema——manifest 字节转录（output/kill 共形）。 */
const bashJobIdSchema = z.object({
  jobId: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .describe('The job ID returned by run_shell with runInBackground: true'),
});

/** bash_wait schema——manifest 字节转录（jobId + timeoutMs 无 default 全界）。 */
const bashWaitSchema = z.object({
  jobId: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .describe('The job ID returned by run_shell with runInBackground: true'),
  timeoutMs: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .describe('Maximum wait time in milliseconds (default: 60000 = 60s, max: 600000 = 10min)')
    .optional(),
});

/** shell 域动作 → zod schema（schema 真源表）。 */
const SHELL_CAP_SCHEMA: Record<ShellAction, z.ZodObject<z.ZodRawShape>> = {
  run: runShellSchema,
  output: bashJobIdSchema,
  kill: bashJobIdSchema,
  wait: bashWaitSchema,
};

/** shell 域动作 → 模型面 description（manifest 字节转录）。 */
const SHELL_CAP_DESCRIPTION: Record<ShellAction, string> = {
  run: 'Execute a shell command in the bundled bash (Unix syntax) and return stdout + stderr. The working directory is STICKY per agent: a successful `cd` in one call carries over to later calls, and every result ends with a `[cwd: ...]` line showing where you landed. Pass the `cwd` parameter to set the directory explicitly for one call. Do NOT write `cd /d X:\\...` (cmd syntax — fails in bash); write `cd /x/path` or `cd \'X:/path\'`. Default timeout 5 min (max 10 min). Long output is truncated head+tail, but the FULL log is spilled to a file whose path is always printed in the result. To find output the truncation cut (e.g. a buried error), do NOT re-run the command with pipes (`| head`, `| tail`, `| grep`) — that wastes build/test time. Grep the spill file directly with the bundled bash instead (`grep -n -iE "error|failed" <path>`), or read its tail via fs(read) with offset; explicit-path grep bypasses search/glob ignore rules. For long or iterative work (builds, test loops, watch modes) set runInBackground: true and poll with bash_output — it returns ONLY output produced since your last read, so repeated polls cost no extra tokens. Commands run from the current sticky cwd by default. IMPORTANT: Do NOT use run_shell for file search, code search, or git operations — use glob (file patterns), search_content (text search), list_directory (directory listing), and the dedicated git_* tools instead. run_shell is ONLY for building and testing commands (npm test, cargo build, pytest, etc.).',
  output:
    'Read NEW output from a background shell job — only bytes produced since your previous bash_output call are returned (incremental; old output is never re-sent, so repeated polling of watch modes/dev servers is cheap). The header reports whether the job is still running ([任务运行中...]) or finished ([任务已完成, exit code: N...]).',
  kill: 'Kill a running background shell job and return any accumulated output.',
  wait: 'Block until a background shell job completes (or timeout), then return full output + exit code. Use after run_shell with runInBackground: true to wait for a long-running task.',
};

/** shell 域动作 → readOnly（manifest 字节转录）。 */
const SHELL_CAP_READONLY: Record<ShellAction, boolean> = {
  run: false,
  output: true,
  kill: false,
  wait: true,
};

/** run 派发前注入粘性 cwd 候选（R3-d c3 §9：粘性归 TS 编排层——本层读
 *  per-owner 注册表 session-context，产物自包含的 provider 不持宿主实例）。
 *  owner = executor 注入的 _owner_id（bus id），缺失回退 _agent_id。 */
function withStickyCwd(args: Record<string, unknown>): Record<string, unknown> {
  const sticky = stickyCwdOf(ownerIdOf(args));
  return sticky ? { ...args, stickyCwd: sticky } : args;
}

/** shell 域模型族工具（shell 域收口后 schema/description/readOnly 自持 zod 真源，
 *  不再查 builtin.shell 镜像）；TS 工具名保持历史名（run_shell/bash_output/
 *  bash_kill/bash_wait——模型面契约）；execute 走 shellExecute → provider seam
 *  （平台化 D11 开放面不动——provider 表已换 process_cap 直呼）。 */
function shellCapTool(action: ShellAction, localName: string, exec: ToolExecutor): Tool {
  const schema = SHELL_CAP_SCHEMA[action];
  const parameters = toInputJsonSchema(schema.passthrough());
  return {
    name: () => localName,
    description: () => SHELL_CAP_DESCRIPTION[action],
    parameters: () => parameters,
    readOnly: () => SHELL_CAP_READONLY[action] ?? false,
    execute: (args, onProgress, signal) =>
      shellExecute(action, action === 'run' ? withStickyCwd(args) : args, exec, onProgress, signal),
  };
}

/** shell 域工具族（S1-2 从 createCodingTools 迁出；R3-d 起 zod 真源）。
 *  声明序 = 领域合并/装配的字节契约序——勿重排。*/
export function createShellTools(exec: ToolExecutor): Tool[] {
  return [
    // ── Shell ──
    shellCapTool('run', 'run_shell', exec),

    // ── Shell: 后台任务管理 ──
    shellCapTool('output', 'bash_output', exec),
    shellCapTool('kill', 'bash_kill', exec),
    shellCapTool('wait', 'bash_wait', exec),
  ];
}

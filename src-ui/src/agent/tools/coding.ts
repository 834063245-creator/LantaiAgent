// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════
// MCP 动态工具工厂 — Step 1: 从 MCP tools/list 自动生成
// ═══════════════════════════════════════════════════════
// Coding Tools — Shell / Git（fs/search/web 已迁内核插件，见 manifest-tools.ts
// 与下方 createFsTools 的 manifest 驱动形态——kernel-plugin-runtime P2-2）
// ═══════════════════════════════════════════════════════

import { z } from 'zod';
import { activeFsProviders, type FsAction } from '../../composition/fs-service';
import { activeShellProviders, type ShellAction } from '../../composition/shell-service';
import { FS_PLUGIN_TOOL_BY_ACTION } from '../../plugins/builtin/fs-builtin';
import type { Tool, ToolExecutor } from '../tool';
import { defineTool } from './define-tool';
import { kernelManifestOf } from './manifest-tools';

/** fs 域消费面（平台化 Phase 2 · D11，2026-08-27）：经 ctx.fs 注册表解析 provider
 *  （后注册胜取默认），默认 builtin/rust-fs 借注入的 dispatch 腰转发既有 Rust 命令。
 *  替代 provider（JS 内存 / MCP / 远程）实现同一 FsProvider 接口即插即用；
 *  强制层 gate（plan/权限/审计）在 executor 管道层、先于本调用——换 provider 不豁免。 */
export function fsExecute(
  action: FsAction,
  args: Record<string, unknown>,
  exec: ToolExecutor,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const providers = activeFsProviders();
  const provider = providers[providers.length - 1];
  if (!provider) {
    return Promise.reject(
      new Error('FS_PROVIDER: 无已注册 fs provider——请确认 fs 通道装配（生产 = loadBuiltinPlugins）'),
    );
  }
  return provider.execute(action, args, { dispatch: exec, onProgress, signal });
}

/** shell 域消费面（平台化 Phase 2 · D11 施工⑤）：经 ctx.shell 注册表解析 provider
 *  （后注册胜；subprocess 并入本 seam——spawn/stdio/进程树即后台任务族，见计划
 *  D11 修订注记）。强制层 gate 在 executor 管道层、先于本调用——换 provider 不豁免。 */
export function shellExecute(
  action: ShellAction,
  args: Record<string, unknown>,
  exec: ToolExecutor,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const providers = activeShellProviders();
  const provider = providers[providers.length - 1];
  if (!provider) {
    return Promise.reject(
      new Error('SHELL_PROVIDER: 无已注册 shell provider——请确认 shell 通道装配（生产 = loadBuiltinPlugins）'),
    );
  }
  return provider.execute(action, args, { dispatch: exec, onProgress, signal });
}

/** ask_user 单条问题（单问表单或批量 questions 数组元素）。 */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: { label: string; description: string }[];
  multiSelect?: boolean;
}

/** ask_user 工具的 UI 请求 — 由 workspace 注入的回调转发到 UI 总线。
 *  保持 agent 层不 import ui/ 模块。
 *  单问：question/options/multiSelect + callback(answer)；
 *  批量：questions 一次推全部 + callback(answers)（与 questions 对齐，未答/跳过为 null）。
 *  并发会话（2026-08-26）：agentId = 发起 Agent 的 bus id（executor 注入
 *  _owner_id，主 Agent 即 main-<ts>-<rand>）——UI 据此路由到所属卷的提问卡。 */
export interface AskUserRequest {
  id: string;
  agentId?: string;
  question?: string;
  header?: string;
  options?: { label: string; description: string }[];
  multiSelect?: boolean;
  /** 批量多问：完整题目列表，UI 分页收集后一次性返回 */
  questions?: AskUserQuestionItem[];
  callback: (answer: string[] | null | (string[] | null)[]) => void;
}

export interface CodingToolsUI {
  askUser?: (req: AskUserRequest) => void;
}

/** manifest 驱动的 fs 域工具（kernel-plugin-runtime P2-2）：schema/description/
 *  readOnly = manifest 字节（convergence 零漂移——schema 字节转录纪律）；TS 工具名
 *  保持历史名（write_file/edit_file/delete_file/rename_file——领域收敛与守护测试
 *  的既有契约，非 manifest 工具名）；execute 仍走 fsExecute → provider seam
 *  （平台化 D11 开放面不动——provider 表已全量换 tool_call 信封）。 */
function fsManifestTool(action: FsAction, localName: string, exec: ToolExecutor): Tool {
  const target = FS_PLUGIN_TOOL_BY_ACTION[action];
  const manifest = kernelManifestOf(target.plugin);
  const spec = manifest.tools.find((t) => t.name === target.tool);
  if (!spec) throw new Error(`manifest-tools: 插件 '${target.plugin}' 无工具 '${target.tool}'`);
  const parameters = spec.schema;
  return {
    name: () => localName,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => spec.read_only ?? false,
    execute: (args, onProgress, signal) => fsExecute(action, args, exec, onProgress, signal),
  };
}

/** fs 域工具族（S1-2 从 createCodingTools 迁出；P2-2 起 manifest 驱动）。
 *  声明序 = 领域合并/装配的字节契约序——勿重排。 */
export function createFsTools(exec: ToolExecutor): Tool[] {
  const rename = fsManifestTool('rename', 'rename_file', exec);
  return [
    fsManifestTool('read', 'read_file_content', exec),
    fsManifestTool('write', 'write_file', exec),
    fsManifestTool('edit', 'edit_file', exec),
    fsManifestTool('list', 'list_directory', exec),
    fsManifestTool('constraints', 'read_constraints', exec),
    fsManifestTool('write_constraints', 'write_constraints', exec),
    fsManifestTool('glob', 'glob', exec),
    fsManifestTool('delete', 'delete_file', exec),
    fsManifestTool('mkdir', 'create_directory', exec),
    fsManifestTool('move', 'move_file', exec),
    // rename：模型面 schema 键是 path/new_name（历史契约），派发前折到
    // filePath/newName（插件契约键）——键名改写保留在工具层（行为不变；
    // 信封内 args 不经 bridge 转换，必须显式折写）。
    {
      ...rename,
      execute: (args, onProgress, signal) => {
        const { path, new_name, ...rest } = args;
        return fsExecute('rename', { ...rest, filePath: path, newName: new_name }, exec, onProgress, signal);
      },
    },
  ];
}

/** shell 域工具族（S1-2 从 createCodingTools 迁出）——纯机械移动，定义零改写。
 *  迁出动机同 createFsTools：工具定义与装配分离，行化铺路。*/
export function createShellTools(exec: ToolExecutor): Tool[] {
  return [
    // ── Shell ──
    defineTool({
      name: 'run_shell',
      description:
        'Execute a shell command in the bundled bash (Unix syntax) and return stdout + stderr. ' +
        'The working directory is STICKY per agent: a successful `cd` in one call carries over to later calls, and every result ends with a `[cwd: ...]` line showing where you landed. ' +
        'Pass the `cwd` parameter to set the directory explicitly for one call. ' +
        "Do NOT write `cd /d X:\\...` (cmd syntax — fails in bash); write `cd /x/path` or `cd 'X:/path'`. " +
        'Default timeout 5 min (max 10 min). Long output is truncated head+tail, but the FULL log is spilled to a file whose path is always printed in the result. To find output the truncation cut (e.g. a buried error), do NOT re-run the command with pipes (`| head`, `| tail`, `| grep`) — that wastes build/test time. Grep the spill file directly with the bundled bash instead (`grep -n -iE "error|failed" <path>`), or read its tail via fs(read) with offset; explicit-path grep bypasses search/glob ignore rules. ' +
        'For long or iterative work (builds, test loops, watch modes) set runInBackground: true and poll with bash_output — it returns ONLY output produced since your last read, so repeated polls cost no extra tokens. ' +
        'Commands run from the current sticky cwd by default. IMPORTANT: Do NOT use run_shell for file search, code search, or git operations — use glob (file patterns), search_content (text search), list_directory (directory listing), and the dedicated git_* tools instead. run_shell is ONLY for building and testing commands (npm test, cargo build, pytest, etc.).',
      schema: z.object({
        command: z.string().describe('The shell command to run (e.g. "npm test", "cargo build", "pytest -x")'),
        cwd: z
          .string()
          .optional()
          .describe('Optional working directory for the command. Defaults to the current workspace root.'),
        timeoutMs: z.coerce
          .number()
          .int()
          .max(600000)
          .optional()
          .default(300000)
          .describe('Timeout in milliseconds (default: 300000 = 5 min, max: 600000 = 10 min)'),
        runInBackground: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Set to true to run in background (returns job ID immediately). Use bash_output(id) to check progress, bash_wait(id) to wait for completion, bash_kill(id) to stop.',
          ),
        interpreter: z
          .enum(['bash', 'pwsh'])
          .optional()
          .describe(
            'Optional interpreter. Default/omit = bundled bash (Unix syntax). Set "pwsh" ONLY for Windows-native tasks bash cannot do (registry queries, ACL, MSI, COM, WMI) — PowerShell syntax required.',
          ),
      }),
      execute: (args, onProgress, signal) => shellExecute('run', args, exec, onProgress, signal),
    }),

    // ── Shell: 后台任务管理 ──
    defineTool({
      name: 'bash_output',
      description:
        'Read NEW output from a background shell job — only bytes produced since your previous bash_output call are returned (incremental; old output is never re-sent, so repeated polling of watch modes/dev servers is cheap). The header reports whether the job is still running ([任务运行中...]) or finished ([任务已完成, exit code: N...]).',
      schema: z.object({
        jobId: z.coerce.number().int().describe('The job ID returned by run_shell with runInBackground: true'),
      }),
      readOnly: true,
      execute: (args, onProgress) => shellExecute('output', { jobId: args.jobId }, exec, onProgress),
    }),
    defineTool({
      name: 'bash_kill',
      description: 'Kill a running background shell job and return any accumulated output.',
      schema: z.object({
        jobId: z.coerce.number().int().describe('The job ID returned by run_shell with runInBackground: true'),
      }),
      execute: (args, onProgress) =>
        // 所有权身份：bus id（_owner_id — 与 spawn 时的 job owner 对齐）。
        shellExecute(
          'kill',
          {
            jobId: args.jobId,
            agentId: (args as { _owner_id?: string })._owner_id,
          },
          exec,
          onProgress,
        ),
    }),
    defineTool({
      name: 'bash_wait',
      description:
        'Block until a background shell job completes (or timeout), then return full output + exit code. Use after run_shell with runInBackground: true to wait for a long-running task.',
      schema: z.object({
        jobId: z.coerce.number().int().describe('The job ID returned by run_shell with runInBackground: true'),
        timeoutMs: z.coerce
          .number()
          .int()
          .optional()
          .describe('Maximum wait time in milliseconds (default: 60000 = 60s, max: 600000 = 10min)'),
      }),
      readOnly: true,
      execute: (args, onProgress) =>
        shellExecute('wait', { jobId: args.jobId, timeoutMs: args.timeoutMs }, exec, onProgress),
    }),
  ];
}

/** manifest 驱动的 git 域工具（kernel-plugin-runtime P2-3）：schema/description/
 *  readOnly = manifest 字节（convergence 零漂移——生成器发射 = zod 发射序）；
 *  TS 工具名保持历史名（模型面契约，非 manifest 工具名）；execute 经 tool_call
 *  信封寻址 builtin.git（search/web 同款直 exec 族，无 provider seam）。
 *  git_diff 双目标路由（staged → git_diff_staged / 缺省 → git_diff_unstaged）
 *  与 git_stage 拆单（'.'/'all' → git_stage_all）保留在工具层——模型面
 *  schema 与插件实收形状之间的既有折写。 */
function gitManifestTool(rustTool: string, localName: string, exec: ToolExecutor): Tool {
  const manifest = kernelManifestOf('builtin.git');
  const spec = manifest.tools.find((t) => t.name === rustTool);
  if (!spec) throw new Error(`manifest-tools: 插件 'builtin.git' 无工具 '${rustTool}'`);
  const parameters = spec.schema;
  return {
    name: () => localName,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => spec.read_only ?? false,
    execute: (args, onProgress, signal) =>
      exec('tool_call', { plugin: 'builtin.git', tool: rustTool, args }, onProgress, signal),
  };
}

/** git 域工具族（S1-2 从 createCodingTools 迁出；P2-3 起 manifest 驱动）。
 *  声明序 = 领域合并/装配的字节契约序——勿重排。 */
export function createGitTools(exec: ToolExecutor): Tool[] {
  return [
    gitManifestTool('git_status', 'git_status', exec),
    {
      ...gitManifestTool('git_diff_unstaged', 'git_diff', exec),
      execute: (args, onProgress, signal) => {
        const { staged, ...rest } = args as { staged?: boolean };
        return exec(
          'tool_call',
          { plugin: 'builtin.git', tool: staged ? 'git_diff_staged' : 'git_diff_unstaged', args: rest },
          onProgress,
          signal,
        );
      },
    },
    gitManifestTool('git_log', 'git_log', exec),
    {
      ...gitManifestTool('git_stage', 'git_stage', exec),
      execute: async (args, onProgress, signal) => {
        const files = String((args as { files?: string }).files ?? '').trim();
        if (files === '.' || files === 'all') {
          return exec(
            'tool_call',
            { plugin: 'builtin.git', tool: 'git_stage_all', args: { path: (args as { path?: string }).path } },
            onProgress,
            signal,
          );
        }
        // 暂存单个文件（逐个派发——与既有行为一致）
        const fileList = files.split(',').map((f) => f.trim());
        const results: string[] = [];
        for (const f of fileList) {
          const r = await exec(
            'tool_call',
            { plugin: 'builtin.git', tool: 'git_stage', args: { path: (args as { path?: string }).path, files: [f] } },
            onProgress,
            signal,
          );
          results.push(r);
        }
        return results.join('\n');
      },
    },
    gitManifestTool('git_commit', 'git_commit', exec),
    gitManifestTool('git_push', 'git_push', exec),
    gitManifestTool('git_pull', 'git_pull', exec),
    // ── Phase 2b: Git 操作 ──
    gitManifestTool('git_init', 'git_init', exec),
    gitManifestTool('git_checkout', 'git_checkout', exec),
    gitManifestTool('git_create_branch', 'git_create_branch', exec),
    gitManifestTool('git_discard', 'git_discard', exec),
    gitManifestTool('git_stash_push', 'git_stash_push', exec),
    gitManifestTool('git_stash_pop', 'git_stash_pop', exec),
  ];
}

// search/web 两域已迁内核插件（builtin.search / builtin.web，kernel-plugin-runtime
// Phase 1）：zod 版定义删除，真源 = src-tauri/src/tool_plugins/*/manifest.json，
// TS 面经 agent/tools/manifest-tools.ts 生成。

/** agent-isolation 工具族（S1-2 从 createCodingTools 迁出）——纯机械移动，定义零改写。*/
export function createAgentIsolationTools(exec: ToolExecutor): Tool[] {
  return [
    // ── Phase 2c: Agent Worktree 隔离（Tauri 命令已存在） ──
    defineTool({
      name: 'agent_isolation_create',
      description:
        'Create an isolated git worktree for a sub-agent to work in. Returns the isolation path. Use before spawning a sub-agent that mutates files — prevents conflicts when multiple agents modify the same repo concurrently.',
      schema: z.object({
        agent_id: z.string().describe('Identifier for this isolation workspace'),
      }),
      execute: (args, onProgress) => exec('agent_isolation_create', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_diff',
      description:
        'Show the diff of changes made in an isolation workspace. ' +
        'Diffs over ~8000 chars are spilled to .lantai/spill/ — the result then carries the file path; read it with read_file to get the full diff.',
      schema: z.object({
        agent_id: z.string().describe('Isolation workspace to diff'),
      }),
      readOnly: true,
      execute: (args, onProgress) => exec('agent_isolation_diff', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_merge',
      description: 'Merge changes from an isolation workspace back into the main repository.',
      schema: z.object({
        agent_id: z.string().describe('Isolation workspace to merge'),
      }),
      execute: (args, onProgress) => exec('agent_isolation_merge', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_discard',
      description:
        "Discard an isolation workspace and delete its worktree. Use when the sub-agent's changes are no longer needed.",
      schema: z.object({
        agent_id: z.string().describe('Isolation workspace to discard'),
      }),
      execute: (args, onProgress) => exec('agent_isolation_discard', args, onProgress),
    }),
    defineTool({
      name: 'agent_isolation_status',
      description: 'List all isolation workspaces and their current status.',
      schema: z.object({}),
      readOnly: true,
      execute: (args, onProgress) => exec('agent_isolation_status', args, onProgress),
    }),
  ];
}

/** ask 工具族（S1-2 从 createCodingTools 迁出）——纯机械移动，定义零改写。
 *  ui 缺帐时 execute 返回“UI 未接线”错误（原行为保留）。*/
export function createAskUserTools(ui?: CodingToolsUI): Tool[] {
  return [
    // ── 用户交互 ──
    defineTool({
      name: 'ask_user',
      description:
        "Ask the user one or more questions when you need clarification or confirmation before proceeding. Use when the request is ambiguous, you need to choose between approaches, or you need approval for a destructive action. Supports: single question (question/header/options/multiSelect), multiple questions in one call (questions array — recommended for 2+, asked one at a time), and open-ended questions (omit options — the user types a free-text answer). Returns the user's answer(s).",
      schema: z.object({
        question: z
          .string()
          .optional()
          .describe(
            'The question to ask the user (single-question form). For 2+ questions use the questions array instead.',
          ),
        header: z
          .string()
          .optional()
          .describe('Short label (max 12 chars) shown as a tag, e.g. "Confirm", "Approach", "File"'),
        options: z
          .array(
            z.object({
              label: z.string().describe('Display text (1-5 words)'),
              description: z.string().describe('Explanation of what this option means'),
            }),
          )
          .optional()
          .describe(
            '2-4 predefined choices the user can pick from. Omit for an open-ended question — the user types a free-text answer.',
          ),
        multiSelect: z
          .boolean()
          .optional()
          .default(false)
          .describe('Set to true to allow selecting multiple options (default: false)'),
        questions: z
          .array(
            z.object({
              question: z.string().describe('The question to ask the user. Be specific about what you need to know.'),
              header: z
                .string()
                .optional()
                .describe('Short label (max 12 chars) shown as a tag, e.g. "Confirm", "Approach", "File"'),
              options: z
                .array(
                  z.object({
                    label: z.string().describe('Display text (1-5 words)'),
                    description: z.string().describe('Explanation of what this option means'),
                  }),
                )
                .optional()
                .describe(
                  '2-4 predefined choices the user can pick from. Omit for an open-ended question — the user types a free-text answer.',
                ),
              multiSelect: z
                .boolean()
                .optional()
                .default(false)
                .describe('Set to true to allow selecting multiple options (default: false)'),
            }),
          )
          .optional()
          .describe(
            'Multiple questions in one call (recommended for 2+). Asked one at a time in order; the returned answers array aligns with this array. Each answer is a string (single choice / free text) or an array of strings (multi-select), or null if the user cancelled.',
          ),
      }),
      readOnly: true,
      execute: async (args) => {
        if (!ui?.askUser) {
          return JSON.stringify({ answer: null, error: 'ask_user 不可用：UI 未接线' });
        }
        const batch = Array.isArray(args.questions) && args.questions.length > 0 ? args.questions : null;
        if (!batch && !args.question) {
          return JSON.stringify({ error: 'ask_user: 需要提供 question（单问）或 questions（多问）' });
        }
        // 发起 Agent 身份（executor 注入的 _owner_id meta key——不在 zod 类型内，
        // 见 define-tool 注释的 meta key 约定）——UI 路由提问卡到所属卷
        const agentId =
          typeof (args as { _owner_id?: unknown })._owner_id === 'string'
            ? ((args as { _owner_id?: unknown })._owner_id as string)
            : undefined;
        // 批量：一次推全部 questions，UI 渲成分页表单一次性收集；取消 → 整批 null
        if (batch) {
          const answers = await new Promise<(string[] | null)[] | null>((resolve) => {
            ui.askUser?.({
              id: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              agentId,
              questions: batch,
              callback: (res) => resolve(Array.isArray(res) ? (res as (string[] | null)[]) : null),
            });
          });
          if (answers === null) return JSON.stringify({ answer: null });
          // 返回与 questions 对齐：多选 → label 数组；单选/开放式 → 字符串；未答 → null
          return JSON.stringify({
            answers: answers.map((a, i) => {
              if (a === null) return null;
              const multi = (batch[i].options?.length ?? 0) > 0 && !!batch[i].multiSelect;
              return multi ? a : (a[0] ?? null);
            }),
          });
        }
        // 单问（含开放式：options 省略）
        const multi = (args.options?.length ?? 0) > 0 && !!args.multiSelect;
        const ans = await new Promise<string[] | null>((resolve) => {
          ui.askUser?.({
            id: `ask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            agentId,
            question: args.question,
            header: args.header,
            options: args.options ?? [],
            multiSelect: multi,
            callback: (res) => resolve(Array.isArray(res) ? (res as string[]) : null),
          });
        });
        if (ans === null) return JSON.stringify({ answer: null });
        return JSON.stringify(multi ? { answers: ans } : { answer: ans[0] ?? null });
      },
    }),
  ];
}

export function createCodingTools(exec: ToolExecutor, ui?: CodingToolsUI): Tool[] {
  return [
    // 文件操作（fs 域工具族，S1-2 迁出至 createFsTools）
    ...createFsTools(exec),
    // Shell 域工具族（S1-2 迁出至 createShellTools）
    ...createShellTools(exec),
    // Git 域工具族（S1-2 迁出至 createGitTools）
    ...createGitTools(exec),
    // Agent Worktree 隔离（agent-isolation 族，S1-2 迁出至 createAgentIsolationTools）
    ...createAgentIsolationTools(exec),
    // 用户交互（ask 族，S1-2 迁出至 createAskUserTools）
    ...createAskUserTools(ui),
  ];
}

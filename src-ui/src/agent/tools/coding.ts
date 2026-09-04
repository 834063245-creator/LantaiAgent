// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════
// MCP 动态工具工厂 — Step 1: 从 MCP tools/list 自动生成
// ═══════════════════════════════════════════════════════
// Coding Tools（fs/git/shell/search/web 全部已迁内核插件，见 manifest-tools.ts
// 与下方各 manifest 驱动形态——kernel-plugin-runtime P2-2/P2-3/P2-4）
// ═══════════════════════════════════════════════════════

import { z } from 'zod';
import { activeFsProviders, type FsAction } from '../../composition/fs-service';
import { activeShellProviders, type ShellAction } from '../../composition/shell-service';
import { FS_PLUGIN_TOOL_BY_ACTION } from '../../plugins/builtin/fs-builtin';
import { SHELL_PLUGIN_TOOL_BY_ACTION } from '../../plugins/builtin/shell-builtin';
import type { Tool, ToolExecutor } from '../tool';
import { defineTool, toInputJsonSchema } from './define-tool';
import { kernelManifestOf, withProgressStream } from './manifest-tools';

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

// ═══════════════════════════════════════════════════════════════
// fs 域模型族 zod 真源（kernel-capability-c3-design.md fs 域收口 R3-b 后，
// 2026-09-04）：builtin.fs 插件信封退役，fs 域 8 工具（read/write/list/glob/
// mkdir/move/rename/delete）schema 真源回 TS zod——逐键等价于退役前 manifest
// 的 schema 发射（键名 camelCase/snake_case 模型面契约、description 字节，
// convergence 快照 stableStringify 字典序下零漂移）。
// edit/constraints/write_constraints 仍经 manifest 镜像（builtin.editor /
// builtin.constraints 未退役——见 fsManifestTool）。
// ═══════════════════════════════════════════════════════════════

/** read_file_content schema——manifest 字节转录（filePath/offset/limit）。 */
const readFileContentSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to read'),
  offset: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .optional()
    .describe('Line number to start reading from (0-indexed, default: 0)'),
  limit: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .optional()
    .describe('Maximum number of lines to return (default: all lines)'),
});

/** write_file_content schema——manifest 字节转录（filePath/content/_forceGate）。 */
const writeFileSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to create or overwrite'),
  content: z.string().describe('Full file content to write'),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** list_directory schema——manifest 字节转录（path）。 */
const listDirectorySchema = z.object({
  path: z.string().describe('Absolute path to the directory to list'),
});

/** glob schema——manifest 字节转录（pattern/path）。 */
const globSchema = z.object({
  pattern: z
    .string()
    .describe('Glob pattern to match file paths against (e.g. "**/*.rs", "src/**/agent*.ts", "*.json")'),
  path: z.string().optional().describe('Directory to search in. Defaults to the current workspace root.'),
});

/** create_directory schema——manifest 字节转录（path）。 */
const createDirectorySchema = z.object({
  path: z.string().describe('Absolute path to the directory to create'),
});

/** move_file schema——manifest 字节转录（from/to/_forceGate）。 */
const moveFileSchema = z.object({
  from: z.string().describe('Source path'),
  to: z.string().describe('Destination path'),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** rename_file_or_dir schema——manifest 字节转录（path/new_name/_forceGate，
 *  模型面历史契约——工具层 execute 折写 filePath/newName 后派发）。 */
const renameFileSchema = z.object({
  path: z.string().describe('Absolute path to the file/directory to rename'),
  new_name: z.string().describe('New name (not path, just the name)'),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** delete_file_or_dir schema——manifest 字节转录（path/_forceGate）。 */
const deleteFileSchema = z.object({
  path: z.string().describe('Absolute path to the file or directory to delete'),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** fs 域动作 → zod schema（schema 真源表）。 */
const FS_CAP_SCHEMA: Record<string, z.ZodObject<z.ZodRawShape>> = {
  read: readFileContentSchema,
  write: writeFileSchema,
  list: listDirectorySchema,
  glob: globSchema,
  mkdir: createDirectorySchema,
  move: moveFileSchema,
  rename: renameFileSchema,
  delete: deleteFileSchema,
};

/** fs 域动作 → 模型面 description（manifest 字节转录）。 */
const FS_CAP_DESCRIPTION: Record<string, string> = {
  read: 'Read the content of a file on disk. Returns text in cat -n format (6-digit line number + tab + content). Use offset and limit to read a specific range of lines (0-indexed). Use to inspect source code files when analyzing dependencies or investigating violations.',
  write:
    'Create or overwrite a file with the given content. Creates parent directories if needed. Use to write new files or modify existing ones.',
  list: 'List files and subdirectories in a directory (recursive up to 4 levels deep). Returns name, path, type (file/dir), and size for each entry.',
  glob: 'Fast file pattern matching using glob patterns. Returns matching file paths sorted by modification time. Supports ** for recursive matching (e.g. "**/*.rs", "src/**/*.ts", "*.json"). Use this instead of run_shell to find files by name pattern — it is faster and respects .gitignore-style exclusions.',
  mkdir:
    'Create a new directory (and any missing parent directories). Use before writing new files into a directory that may not exist yet.',
  move: 'Move or rename a file or directory. The destination path determines the new name/location.',
  rename:
    'Rename a file or directory (keep it in the same parent directory). For moving to a different directory, use move_file instead.',
  delete:
    'Delete a file or directory at the specified path. Use to clean up temporary files or remove unwanted code. DANGEROUS — cannot be undone. Verify with user if deleting important files.',
};

/** fs 域动作 → readOnly（manifest 字节转录）。 */
const FS_CAP_READONLY: Record<string, boolean> = {
  read: true,
  write: false,
  list: true,
  glob: true,
  mkdir: false,
  move: false,
  rename: false,
  delete: false,
};

/** fs 域模型族工具（fs 域收口后 schema/description/readOnly 自持 zod 真源，
 *  不再查 builtin.fs 镜像）；TS 工具名保持历史名（write_file/edit_file/
 *  delete_file/rename_file——领域收敛与守护测试的既有契约）；execute 仍走
 *  fsExecute → provider seam（builtinFsProvider → fs_cap 直呼）。 */
function fsCapTool(action: FsAction, localName: string, exec: ToolExecutor): Tool {
  const schema = FS_CAP_SCHEMA[action];
  const parameters = toInputJsonSchema(schema.passthrough());
  return {
    name: () => localName,
    description: () => FS_CAP_DESCRIPTION[action],
    parameters: () => parameters,
    readOnly: () => FS_CAP_READONLY[action] ?? false,
    execute: (args, onProgress, signal) =>
      withProgressStream(args, onProgress, () => fsExecute(action, args, exec, onProgress, signal)),
  };
}

/** manifest 驱动的 fs 域工具（kernel-plugin-runtime P2-2 遗留面）——仅
 *  edit/constraints/write_constraints（builtin.editor / builtin.constraints
 *  未退役，仍从镜像取 schema/description）；schema/description/readOnly =
 *  manifest 字节；TS 工具名保持历史名。 */
function fsManifestTool(action: FsAction, localName: string, exec: ToolExecutor): Tool {
  const target = FS_PLUGIN_TOOL_BY_ACTION[action];
  if (!target) throw new Error(`coding: 动作 '${action}' 无 manifest 信封目标（fs 域收口后应走 fsCapTool zod 面）`);
  const manifest = kernelManifestOf(target.plugin);
  const spec = manifest.tools.find((t) => t.name === target.tool);
  if (!spec) throw new Error(`manifest-tools: 插件 '${target.plugin}' 无工具 '${target.tool}'`);
  const parameters = spec.schema;
  return {
    name: () => localName,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => spec.read_only ?? false,
    execute: (args, onProgress, signal) =>
      withProgressStream(args, onProgress, () => fsExecute(action, args, exec, onProgress, signal)),
  };
}

/** fs 域工具族（S1-2 从 createCodingTools 迁出；fs 域收口后 8 模型族 zod 真源
 *  + edit/constraints 仍 manifest 驱动）。
 *  声明序 = 领域合并/装配的字节契约序——勿重排。 */
export function createFsTools(exec: ToolExecutor): Tool[] {
  const rename = fsCapTool('rename', 'rename_file', exec);
  return [
    fsCapTool('read', 'read_file_content', exec),
    fsCapTool('write', 'write_file', exec),
    fsManifestTool('edit', 'edit_file', exec),
    fsCapTool('list', 'list_directory', exec),
    fsManifestTool('constraints', 'read_constraints', exec),
    fsManifestTool('write_constraints', 'write_constraints', exec),
    fsCapTool('glob', 'glob', exec),
    fsCapTool('delete', 'delete_file', exec),
    fsCapTool('mkdir', 'create_directory', exec),
    fsCapTool('move', 'move_file', exec),
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

/** manifest 驱动的 shell 域工具（kernel-plugin-runtime P2-4）：schema/description/
 *  readOnly = manifest 字节；TS 工具名保持历史名（模型面契约，非 manifest 工具名——
 *  run_shell → exec_command 等）；execute 仍走 shellExecute → provider seam
 *  （平台化 D11 开放面不动——provider 表已换 tool_call 信封）。 */
function shellManifestTool(action: ShellAction, localName: string, exec: ToolExecutor): Tool {
  const target = SHELL_PLUGIN_TOOL_BY_ACTION[action];
  const manifest = kernelManifestOf(target.plugin);
  const spec = manifest.tools.find((t) => t.name === target.tool);
  if (!spec) throw new Error(`manifest-tools: 插件 '${target.plugin}' 无工具 '${target.tool}'`);
  const parameters = spec.schema;
  return {
    name: () => localName,
    description: () => spec.description,
    parameters: () => parameters,
    readOnly: () => spec.read_only ?? false,
    execute: (args, onProgress, signal) =>
      withProgressStream(args, onProgress, () => shellExecute(action, args, exec, onProgress, signal)),
  };
}

/** shell 域工具族（S1-2 从 createCodingTools 迁出；P2-4 起 manifest 驱动）。
 *  声明序 = 领域合并/装配的字节契约序——勿重排。*/
export function createShellTools(exec: ToolExecutor): Tool[] {
  return [
    // ── Shell ──
    shellManifestTool('run', 'run_shell', exec),

    // ── Shell: 后台任务管理 ──
    shellManifestTool('output', 'bash_output', exec),
    shellManifestTool('kill', 'bash_kill', exec),
    shellManifestTool('wait', 'bash_wait', exec),
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
      withProgressStream(args, onProgress, () =>
        exec('tool_call', { plugin: 'builtin.git', tool: rustTool, args }, onProgress, signal),
      ),
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

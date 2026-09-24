// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════
// MCP 动态工具工厂 — Step 1: 从 MCP tools/list 自动生成
// ═══════════════════════════════════════════════════════
// Coding Tools（fs/git/shell/search/web 全部已迁内核插件，见 manifest-tools.ts
// 与下方各域形态——kernel-plugin-runtime P2-2/P2-3/P2-4；域收口后 fs 8 模型族
// （R3-b）/ git 13 模型族（R3-c）/ shell 4 模型族（R3-d）schema 真源回 TS zod
// （FS_CAP_SCHEMA / GIT_CAP_SCHEMA / SHELL_CAP_SCHEMA），execute 各自换
// fs_cap/git_cap/process_cap 能力口直呼）
// ═══════════════════════════════════════════════════════

import { z } from 'zod';
import { activeFsProviders, type FsAction } from '../../composition/fs-service';
import { seamScopeOf } from '../../composition/seam-scope';
import { activeShellProviders, type ShellAction } from '../../composition/shell-service';
import { parseGitLogCommits, parseGitStatusPorcelain } from '../git-porcelain';
import { stickyCwdOf } from '../session-context';
import type { CodingToolsUI, Tool, ToolExecutor } from '../tool';
import { defineTool, toInputJsonSchema } from './define-tool';

/** 发起方身份 = executor 注入的 `_owner_id`（bus id），缺失回退 `_agent_id`
 *  （fork 子 Agent 的隔离开关）。与 withStickyCwd / domains.ts 同一把钥匙。 */
function ownerIdOf(args: Record<string, unknown>): string | undefined {
  return typeof args._owner_id === 'string'
    ? args._owner_id
    : typeof args._agent_id === 'string'
      ? args._agent_id
      : undefined;
}

/** 本调用所属 Agent 的组合裁剪面（S6 P2a）——装配期登记、请求期查表
 *  （composition/seam-scope.ts）。未登记（无组合上下文/UI 直调/单测）= undefined
 *  ⇒ 消费点落全局当前选择（P2 前语义，零漂移）。 */
function ownerSeamView(args: Record<string, unknown>) {
  return seamScopeOf(ownerIdOf(args));
}

/** fs 域消费面（平台化 Phase 2 · D11，2026-08-27）：经 ctx.fs 注册表解析 provider
 *  （后注册胜取默认），默认 builtin/rust-fs 借注入的 dispatch 腰转发既有 Rust 命令。
 *  替代 provider（JS 内存 / MCP / 远程）实现同一 FsProvider 接口即插即用；
 *  强制层 gate（plan/权限/审计）在 executor 管道层、先于本调用——换 provider 不豁免。
 *  S6 P2a：provider 视图按**本调用所属 Agent 的组合**裁剪（同一次工具实例、两卷
 *  可落不同 provider——裁剪面取值见 ownerSeamView）。 */
export function fsExecute(
  action: FsAction,
  args: Record<string, unknown>,
  exec: ToolExecutor,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const providers = activeFsProviders(ownerSeamView(args));
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

// ── UI 依赖面**类型**已上收内核契约（2026-09-24 批 4c 前置）──
// `AskUserQuestionItem` / `AskUserRequest` / `CodingToolsUI` 三件现定义在
// `agent/tool.ts`（消费方住内核：agent-builder / tool-rows / ask-store）；
// 五族各归其包时，各包只需 `import type { … } from '<内核>'`，不构成反向依赖。

// ═══════════════════════════════════════════════════════════════
// fs 域模型族 zod 真源（kernel-capability-c3-design.md fs 域收口 R3-b 后，
// 2026-09-04）：builtin.fs 插件信封退役，fs 域 8 工具（read/write/list/glob/
// mkdir/move/rename/delete）schema 真源回 TS zod——逐键等价于退役前 manifest
// 的 schema 发射（键名 camelCase/snake_case 模型面契约、description 字节，
// convergence 快照 stableStringify 字典序下零漂移）。
// edit/constraints 全部 R4-4/4b 起 zod 真源（经 provider seam →
// editor_cap / constraints_cap 直呼）——manifest 镜像消费面清零。
// ═══════════════════════════════════════════════════════════════

/** read_file_content schema——行号 opt-in（2026-09 工具缺陷报告 Bug 1 拍板：
 *  payload 缺省原文，lineNumbers:true 才带 cat -n 行号）。 */
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
  lineNumbers: z
    .boolean()
    .optional()
    .describe(
      'Set to true to prefix each line with a cat -n style line number (6-digit + tab). Default: raw file text — use this for exact string matching.',
    ),
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

/** fs 域动作 → 模型面 description（read 经 2026-09 工具缺陷报告 Bug 1 拍板
 *  改写：缺省原文 + lineNumbers opt-in；其余动作 manifest 字节转录）。 */
const FS_CAP_DESCRIPTION: Record<string, string> = {
  read: 'Read the content of a file on disk. Returns the raw file text (byte-exact, no line-number prefixes — safe for string matching). Use offset and limit to read a specific range of lines (0-indexed). Set lineNumbers: true when you need cat -n style line numbers for quoting line addresses. Use to inspect source code files when analyzing dependencies or investigating violations.',
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
    // 附图通道（2026-09-18 按路径读图）：read 读到图片字节时输出带 image 引用
    // （Rust 侧落内容寻址附件）。旗标归实现工具——模型侧走 fs 门面，executor 按
    // guardName（read_file_content）解析；其余 fs 动作输出无 image 键，同旗标无害。
    ...(action === 'read' ? { imageChannel: true } : {}),
    execute: (args, onProgress, signal) => fsExecute(action, args, exec, onProgress, signal),
  };
}

// ═══════════════════════════════════════════════════════════════
// editor 域模型族 zod 真源（kernel-capability-d4-handle-design.md R4-4b 小面
// 清偿收官，2026-09-05）：builtin.editor 插件退役（R5 拆信封前最后在册），
// edit_file schema 真源回 TS zod（逐键等价退役前 manifest 发射，含
// _forceGate 模型面声明键——INVARIANTS #9）；execute 经 fsExecute → provider
// seam（D11 开放面不动）→ builtinFsProvider 换 editor_cap 直呼。
// ═══════════════════════════════════════════════════════════════

const editFileSchema = z.object({
  filePath: z.string().describe('Absolute path to the file to modify'),
  oldString: z
    .string()
    .describe('The exact text to find and replace (must match the file exactly, including whitespace)'),
  newString: z.string().describe('The text to replace it with (must be different from oldString)'),
  replaceAll: z
    .boolean()
    .default(false)
    .describe(
      'Replace all occurrences instead of just the first (default: false). Use when the old_string appears multiple times.',
    ),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** editor 域模型面 description（manifest 字节转录）。 */
const EDITOR_CAP_DESCRIPTION =
  'Perform exact string replacement in a file. The old_string must match exactly (including indentation and whitespace) and must be unique in the file (unless replace_all is true). This is the preferred way to modify code — safer and cheaper than rewriting the entire file.';

// ═══════════════════════════════════════════════════════════════
// （constraints 域模型族工具随图谱全量退役删除，2026-09-09——
//  hologram.constraints.yaml 读写仅服务引擎 run_check，兰台侧已无消费方；
//  曾于 R4-4（2026-09-05）从 builtin.constraints 插件迁 zod 真源 +
//  constraints_cap 直呼，本批整族退役。）
// ═══════════════════════════════════════════════════════════════

/** editor 域模型族工具（R4-4b 起 zod 真源，不查 builtin.editor 镜像）；
 *  TS 工具名保持历史名（模型面契约）；execute 经 provider seam
 *  （edit 动作 → builtinFsProvider → editor_cap 直呼）。 */
function editCapTool(localName: string, exec: ToolExecutor): Tool {
  const parameters = toInputJsonSchema(editFileSchema.passthrough());
  return {
    name: () => localName,
    description: () => EDITOR_CAP_DESCRIPTION,
    parameters: () => parameters,
    readOnly: () => false,
    execute: (args, onProgress, signal) => fsExecute('edit', args, exec, onProgress, signal),
  };
}

/** fs 域工具族（S1-2 从 createCodingTools 迁出；fs 域收口后 8 模型族 zod 真源
 *  + edit 仍 manifest 驱动；constraints 两件随图谱退役移除）。
 *  声明序 = 领域合并/装配的字节契约序——勿重排。 */
export function createFsTools(exec: ToolExecutor): Tool[] {
  const rename = fsCapTool('rename', 'rename_file', exec);
  return [
    fsCapTool('read', 'read_file_content', exec),
    fsCapTool('write', 'write_file', exec),
    editCapTool('edit_file', exec),
    fsCapTool('list', 'list_directory', exec),
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

// ═══════════════════════════════════════════════════════════════
// git 域模型族 zod 真源（kernel-capability-c3-design.md git 域收口 R3-c，
// 2026-09-05）：builtin.git 插件信封退役，git 域 13 模型族工具 schema 真源
// 回 TS zod——逐键等价于退役前 manifest 的 schema 发射（键名/description/
// default/int 界/additionalProperties 全对齐，convergence 快照
// stableStringify 字典序下零漂移；fs 域 R3-b 同款范式）。git_blame 无模型面
// （state-inject 内部消费）；git_diff_staged 由 git_diff 工具层双目标路由
// 派发（schema 同 unstaged，不经本表模型面）。
// ═══════════════════════════════════════════════════════════════

/** git_status schema——manifest 字节转录（path）。 */
const gitStatusSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
});

/** git_diff_unstaged schema——manifest 字节转录（path/file default "."/staged
 *  default false；staged 由工具层消费做双目标路由，不下沉能力口）。 */
const gitDiffSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
  file: z.string().default('.').describe('Optional: specific file to diff. If omitted, shows all unstaged changes.'),
  staged: z.boolean().default(false).describe('Set to true to show staged changes instead of unstaged'),
});

/** git_log schema——manifest 字节转录（path/count default 10）。 */
const gitLogSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
  count: z
    .number()
    .int()
    .min(-9007199254740991)
    .max(9007199254740991)
    .default(10)
    .describe('Number of recent commits to show (default: 10)'),
});

/** git_stage schema——manifest 字节转录（path/files 逗号串——模型面契约，
 *  工具层拆单后以 files 数组派发）。 */
const gitStageSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
  files: z.string().describe('File path(s) to stage, separated by commas. Use "." to stage all.'),
});

/** git_commit schema——manifest 字节转录（path/message/_forceGate）+ files
 *  自动暂存键（2026-09 工具缺陷报告 Bug 2 拍板：commit 接受 files 参数时
 *  先自动暂存再提交，与其它写类工具的参数语义对齐）。 */
const gitCommitSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
  message: z.string().describe('Commit message (conventional commits format recommended)'),
  files: z
    .string()
    .optional()
    .describe(
      'File path(s) to stage before committing, separated by commas (same syntax as git stage). Omit to commit whatever is already staged.',
    ),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** git_push schema——manifest 字节转录（path）。 */
const gitPushSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
});

/** git_pull schema——manifest 字节转录（path）。 */
const gitPullSchema = z.object({
  path: z.string().describe('Absolute path to the git repository root'),
});

/** git_init schema——manifest 字节转录（path——manifest 原文是目录语义）。 */
const gitInitSchema = z.object({
  path: z.string().describe('Absolute path to the directory'),
});

/** git_checkout schema——manifest 字节转录（path/branch/_forceGate）。 */
const gitCheckoutSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
  branch: z.string().describe('Branch name to switch to'),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** git_create_branch schema——manifest 字节转录（path/branch）。 */
const gitCreateBranchSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
  branch: z.string().describe('New branch name'),
});

/** git_discard schema——manifest 字节转录（path/file/_forceGate）。 */
const gitDiscardSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
  file: z.string().describe('File path to discard changes for (relative to repo root)'),
  _forceGate: z
    .boolean()
    .optional()
    .describe(
      'Bypass the architecture gate for HIGH-risk writes. Set to true only after confirming safety via trace_impact.',
    ),
});

/** git_stash_push schema——manifest 字节转录（path/message 可选识别位——退役前
 *  业务即不传给 git，保持原样）。 */
const gitStashPushSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
  message: z.string().optional().describe('Optional stash message for identification'),
});

/** git_stash_pop schema——manifest 字节转录（path）。 */
const gitStashPopSchema = z.object({
  path: z.string().describe('Absolute path to the git repository'),
});

/** git 域动作 → zod schema（schema 真源表；键 = 能力口 action = 退役前
 *  builtin.git 工具名）。 */
const GIT_CAP_SCHEMA: Record<string, z.ZodObject<z.ZodRawShape>> = {
  git_status: gitStatusSchema,
  git_diff_unstaged: gitDiffSchema,
  git_log: gitLogSchema,
  git_stage: gitStageSchema,
  git_commit: gitCommitSchema,
  git_push: gitPushSchema,
  git_pull: gitPullSchema,
  git_init: gitInitSchema,
  git_checkout: gitCheckoutSchema,
  git_create_branch: gitCreateBranchSchema,
  git_stash_push: gitStashPushSchema,
  git_stash_pop: gitStashPopSchema,
  git_discard: gitDiscardSchema,
};

/** git 域动作 → 模型面 description（manifest 字节转录）。 */
const GIT_CAP_DESCRIPTION: Record<string, string> = {
  git_status:
    'Get the current git status — branch name, ahead/behind count, and list of changed files with their status (modified, added, deleted, untracked).',
  git_diff_unstaged:
    'Show the git diff for unstaged changes. Returns unified diff output. Use to review changes before staging/committing.',
  git_log:
    'Show recent git commit history. Returns structured JSON with commit hash, message, author, and date for each commit.',
  git_stage: 'Stage files for commit. Use before git_commit to add changes to the staging area.',
  git_commit:
    'Commit changes with a message. Optionally pass files to auto-stage them first (comma-separated, "." stages all — same syntax as git stage); without files, commits whatever is already staged. Returns the commit summary.',
  git_push: 'Push committed changes to the remote repository.',
  git_pull: 'Pull latest changes from the remote repository (fast-forward only, no merge conflicts).',
  git_init: 'Initialize a new git repository in the given directory.',
  git_checkout: 'Switch to a different branch. Use git_create_branch first if the branch does not exist.',
  git_create_branch: 'Create a new git branch from the current HEAD. Does NOT switch to it — use git_checkout after.',
  git_stash_push: 'Stash current uncommitted changes. Use before switching branches with dirty working tree.',
  git_stash_pop:
    'Restore the most recently stashed changes. Pops the stash — the changes are applied and the stash entry is removed.',
  git_discard: 'Discard unstaged changes to a file (git checkout -- <file>). Loses all uncommitted modifications.',
};

/** git 域动作 → readOnly（manifest 字节转录）。 */
const GIT_CAP_READONLY: Record<string, boolean> = {
  git_status: true,
  git_diff_unstaged: true,
  git_log: true,
  git_stage: false,
  git_commit: false,
  git_push: false,
  git_pull: false,
  git_init: false,
  git_checkout: false,
  git_create_branch: false,
  git_stash_push: false,
  git_stash_pop: false,
  git_discard: false,
};

/** 模型面键（manifest 语言）→ git_cap 顶层契约键：path → repo_path 是唯一
 *  折写（c3 §8 repo_path 位）；file/files/message/branch/count 恒等；meta 键
 *  （_agent_id/_forceGate/_callId）原样透传（executor 注入身份）。 */
function toGitCapArgs(action: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { action };
  for (const [k, v] of Object.entries(args)) {
    if (k === 'path') out.repo_path = v;
    else out[k] = v;
  }
  return out;
}

/** 成功时 git 不打印任何输出的动作——空回执不是错误，但也不该是零信息：模型据此
 *  无法自证"到底做没做"。补一句派生口径 + 回读入口（2026-09-16 反馈回路审计）。 */
const SILENT_GIT_RECEIPTS: Record<string, string> = {
  git_stage:
    '[git] add 完成（git 对成功不打印输出）：暂存区已按 files 更新。要核对用 git(status) 或 git(diff, staged:true)。',
  git_discard: '[git] 工作区改动已丢弃（git 对成功不打印输出）。要核对用 git(status)。',
};

/** git_cap stdout → 模型面输出形状（退役前插件原形状——行为零漂移）：
 *  git_status → JSON {branch,ahead,behind,files}（porcelain 解析，git-porcelain.ts）；
 *  git_log → commits JSON 数组（\x00 split）；其余动作 stdout 直通（diff/blame
 *  的 32K 截断已在能力口内）。唯一增量：零输出动作补可导航回执（见上表）。 */
function shapeGitCapOutput(action: string, raw: string): string {
  if (action === 'git_status') return JSON.stringify(parseGitStatusPorcelain(raw));
  if (action === 'git_log') return JSON.stringify(parseGitLogCommits(raw));
  const silent = SILENT_GIT_RECEIPTS[action];
  if (silent && raw.trim() === '') return silent;
  return raw;
}

/** git 域模型族工具（git 域收口后 schema/description/readOnly 自持 zod 真源，
 *  不再查 builtin.git 镜像）；TS 工具名保持历史名（模型面契约，非能力口
 *  action 名）；execute 走 git_cap 能力口直呼（信封退役；is_agent 由
 *  executor 层 agentInvoke 注入——与 searchCapTool 同构）。 */
function gitCapTool(action: string, localName: string, exec: ToolExecutor): Tool {
  const schema = GIT_CAP_SCHEMA[action];
  const parameters = toInputJsonSchema(schema.passthrough());
  return {
    name: () => localName,
    description: () => GIT_CAP_DESCRIPTION[action],
    parameters: () => parameters,
    readOnly: () => GIT_CAP_READONLY[action] ?? false,
    execute: async (args, onProgress, signal) =>
      shapeGitCapOutput(action, await exec('git_cap', toGitCapArgs(action, args), onProgress, signal)),
  };
}

/** git_stage 拆单编排（git_stage 与 git_commit(files) 共用）：'.'/'all' →
 *  git_stage_all；逗号分隔逐文件派发 git_stage。files 模型面是逗号串（与
 *  能力口 files 数组之间的既有折写）。 */
async function stageFilesViaCap(
  exec: ToolExecutor,
  path: string | undefined,
  files: string,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (files === '.' || files === 'all') {
    return shapeGitCapOutput(
      'git_stage',
      await exec('git_cap', toGitCapArgs('git_stage_all', { path }), onProgress, signal),
    );
  }
  const fileList = files
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  if (fileList.length === 0) {
    throw new Error("git_stage: 'files' 为空——请给出逗号分隔的文件路径，或用 '.' 暂存全部");
  }
  const results: string[] = [];
  for (const f of fileList) {
    const r = await exec('git_cap', toGitCapArgs('git_stage', { path, files: [f] }), onProgress, signal);
    results.push(r);
  }
  // 空回执归一放在**合并后**：逐文件都成功无输出 → 只出一次可导航回执；
  // 任一文件有输出则整体原样直通（不逐条包话术）。
  return shapeGitCapOutput('git_stage', results.join('\n'));
}

/** git 域工具族（S1-2 从 createCodingTools 迁出；P2-3 起 manifest 驱动 →
 *  R3-c git 域收口后 zod 真源 + git_cap 直呼）。
 *  声明序 = 领域合并/装配的字节契约序——勿重排。 */
export function createGitTools(exec: ToolExecutor): Tool[] {
  return [
    gitCapTool('git_status', 'git_status', exec),
    {
      ...gitCapTool('git_diff_unstaged', 'git_diff', exec),
      // git_diff 双目标路由（staged → git_diff_staged / 缺省 →
      // git_diff_unstaged）保留在工具层——staged 由本层消费做路由，
      // 不下沉能力口（模型面 schema 与能力口 action 之间的既有折写）。
      execute: (args, onProgress, signal) => {
        const { staged, ...rest } = args as { staged?: boolean };
        return exec(
          'git_cap',
          toGitCapArgs(staged ? 'git_diff_staged' : 'git_diff_unstaged', rest),
          onProgress,
          signal,
        ).then((raw) => shapeGitCapOutput('git_diff_unstaged', raw));
      },
    },
    gitCapTool('git_log', 'git_log', exec),
    {
      ...gitCapTool('git_stage', 'git_stage', exec),
      // git_stage 拆单（'.'/'all' → git_stage_all；逗号分隔逐文件派发）——
      // 模型面 schema（files 逗号串）与能力口 action 之间的既有折写。
      execute: async (args, onProgress, signal) => {
        const files = String((args as { files?: string }).files ?? '').trim();
        return stageFilesViaCap(exec, (args as { path?: string }).path, files, onProgress, signal);
      },
    },
    {
      ...gitCapTool('git_commit', 'git_commit', exec),
      // git_commit files 自动暂存（2026-09 工具缺陷报告 Bug 2）：模型面给了
      // files 就先 stage 再 commit（与其他写类工具「给什么操作什么」的参数
      // 语义对齐）；不给 files 沿用「提交已暂存内容」。stage 失败时错误直接
      // 上抛（不再空手 commit）。
      execute: async (args, onProgress, signal) => {
        const { files, ...rest } = args as { files?: string };
        const filesStr = String(files ?? '').trim();
        if (filesStr !== '') {
          await stageFilesViaCap(exec, (rest as { path?: string }).path, filesStr, onProgress, signal);
        }
        return shapeGitCapOutput(
          'git_commit',
          await exec('git_cap', toGitCapArgs('git_commit', rest), onProgress, signal),
        );
      },
    },
    gitCapTool('git_push', 'git_push', exec),
    gitCapTool('git_pull', 'git_pull', exec),
    // ── Phase 2b: Git 操作 ──
    gitCapTool('git_init', 'git_init', exec),
    gitCapTool('git_checkout', 'git_checkout', exec),
    gitCapTool('git_create_branch', 'git_create_branch', exec),
    gitCapTool('git_discard', 'git_discard', exec),
    gitCapTool('git_stash_push', 'git_stash_push', exec),
    gitCapTool('git_stash_pop', 'git_stash_pop', exec),
  ];
}

// （search/web 两域工具族不在本文件：search/web 的 schema zod 真源 + 编排
//  在 agent/tools/manifest-tools.ts——R2/R4 收口后与 fs/git/shell 同为
//  能力口直呼 + zod 真源形态。manifest 真源已随 R5 脚手架拆除。）

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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// fs 域工具族（read/write/edit/list/glob/mkdir/move/rename/delete）（**归家后真源**，2026-09-24 批 4c-3）。
//
// 来历：原 agent/tools/coding.ts（一文件载五族）的该段整段移出——定义逐字保留，
// 内核依赖改走包内宿主面（./host）。本批之后 coding.ts 整文件退役（五族全部归家）。
// seam 裁剪读面（ownerSeamView）+ 活跃 provider 表从 composition 层经 faceDeps 取用。

import { z } from 'zod';
import {
  activeFsProviders,
  type FsAction,
  ownerSeamView,
  type Tool,
  type ToolExecutor,
  toInputJsonSchema,
} from './host';

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

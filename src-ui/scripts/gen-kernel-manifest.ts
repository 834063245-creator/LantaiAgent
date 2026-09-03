// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.
//
// kernel-manifest 迁移生成器（基建 B，kernel-plugin-runtime P2-3 前置落地）。
// Rust 内核插件 manifest.json 的唯一 schema 转录通道：数据源 = TS Tool 访问面
// （createFsTools / createGitTools … 的 t.name() / t.description() / t.readOnly()
// / t.parameters()），schema 字节 = zod 发射序由构造保证（convergence 消费的
// 是同一函数的输出）——「dump 临时测试 → 肉眼 → 手写 JSON」的人工转录环节退役。
//
// 用法：node scripts/gen-kernel-manifest.cjs [--check] [domain ...]
//   缺省       发射全部域（写入 src-tauri/src/tool_plugins/<domain>/manifest.json）
//   --check    只对拍不写入；任何域 diff 非空 → 退出码 1
//   domain…    域过滤（fs / editor / constraints / git）
//
// 纪律（P2-3 起）：
//   - manifest schema 一律本生成器发射，禁手写新工具 schema；
//     手写仅限 TOOLS_SPEC 的 permission 声明与无 TS zod 面的内部工具
//   - 输出 LF + 2 空格缩进 + 尾换行——与既有 manifest 逐字节一致（round-trip
//     实证：fs/editor/constraints 三份现文件 === JSON.stringify(obj, null, 2)+'\n'）
//   - 对拍时读入文件先归一 \r\n → \n（工作树 CRLF 检出是 autocrlf 假象，blob 恒 LF）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Tool } from '../src/agent/tool';

// 最小运行环境垫片（同 gen-tool-contract-md.ts：src/ 模块树部分顶层摸
// window——bridge.ts 的 IS_TAURI 探测等；空对象足够，须在动态 import 前就位）
type RecordAny = Record<string, unknown>;
const g = globalThis as unknown as RecordAny;
g.window ??= {};
g.document ??= { createElement: () => ({ style: {} }) };
g.navigator ??= { userAgent: 'node' };

const ROOT = path.resolve(import.meta.dirname ?? '.', '..', '..');
const TOOL_PLUGINS = path.join(ROOT, 'src-tauri', 'src', 'tool_plugins');

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/** manifest ToolSpec.permission（P2-0 形状——dispatch 构造 adapter 时消费）。
 *  family：家族回退名（Read/Edit/Bash/Git/WebFetch）；path_key/command_key：
 *  参数提取键；Git family 用 subcommand 走家族按子命令裁决。 */
interface ManifestPermission {
  family: string;
  path_key?: string;
  command_key?: string;
  subcommand?: string;
}

interface ToolSpec {
  /** manifest 工具名 = 旧 RPC 方法名（信封恒等映射——基建 A shim 翻译表同源）。 */
  name: string;
  /** TS 工具名（factory 产物中按 name() 寻址）——description/read_only/schema
   *  直出；缺省时下方三个手写字段必填（无 TS zod 面的内部工具）。 */
  tsTool?: string;
  /** 描述覆盖（一份 TS schema 双目标发射时区分用途，如 diff_unstaged/diff_staged）。 */
  descriptionOverride?: string;
  permission?: ManifestPermission;
  description?: string;
  read_only?: boolean;
  schema?: Record<string, unknown>;
}

interface DomainSpec {
  /** src-tauri/src/tool_plugins/<domain>/ 目录名。 */
  domain: string;
  id: string;
  description: string;
  capabilities: string[];
  factory: () => Promise<Tool[]>;
  tools: ToolSpec[];
}

// ─────────────────────────────────────────────────────────────
// 权限声明助手（照 P2-2 模式）
// ─────────────────────────────────────────────────────────────

const readPerm = (pathKey: string): ManifestPermission => ({ family: 'Read', path_key: pathKey });
const editPerm = (pathKey: string): ManifestPermission => ({ family: 'Edit', path_key: pathKey });
const gitPerm = (subcommand: string): ManifestPermission => ({
  family: 'Git',
  path_key: 'path',
  subcommand,
});

// ─────────────────────────────────────────────────────────────
// 域配置表（TOOLS_SPEC——生成器的手写部分：permission 声明、TS 名→Rust 名
// 映射、无 TS zod 面工具的完整定义）
// ─────────────────────────────────────────────────────────────

const dummyExec = async () => 'gen-kernel-manifest:dummy';

async function fsToolsFactory(): Promise<Tool[]> {
  const { createFsTools } = await import('../src/agent/tools/coding');
  return createFsTools(dummyExec);
}

async function gitToolsFactory(): Promise<Tool[]> {
  const { createGitTools } = await import('../src/agent/tools/coding');
  return createGitTools(dummyExec);
}

async function shellToolsFactory(): Promise<Tool[]> {
  const { createShellTools } = await import('../src/agent/tools/coding');
  return createShellTools(dummyExec);
}

const DOMAINS: DomainSpec[] = [
  // ── builtin.fs（P2-2 已落地——本域 TS 面已 manifest 驱动，--check 验证
  //    发射格式 + 装配接线与既有文件逐字节一致；内部 5 工具无 TS zod 面，手写）──
  {
    domain: 'fs',
    id: 'builtin.fs',
    description: '文件系统操作（自 commands/filesystem.rs + search.rs 的 glob 拆出，kernel-plugin-runtime P2-2）',
    capabilities: ['filesystem_read', 'filesystem_write'],
    factory: fsToolsFactory,
    tools: [
      { name: 'list_directory', tsTool: 'list_directory', permission: readPerm('path') },
      {
        name: 'list_directory_flat',
        description:
          'List the immediate files and subdirectories of a directory (non-recursive). Internal consumer tool (not model-facing).',
        read_only: true,
        permission: readPerm('path'),
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the directory to list' },
          },
          required: ['path'],
          additionalProperties: {},
        },
      },
      { name: 'read_file_content', tsTool: 'read_file_content', permission: readPerm('filePath') },
      {
        name: 'read_memory_batch',
        description: 'Read multiple memory files under .lantai in one call. Internal consumer tool (not model-facing).',
        read_only: true,
        schema: {
          type: 'object',
          properties: {
            paths: {
              description: 'Absolute file paths to read',
              items: { type: 'string' },
              type: 'array',
            },
          },
          required: ['paths'],
          additionalProperties: {},
        },
      },
      {
        name: 'read_file_base64',
        description:
          'Read a file and return its content base64-encoded (for in-app media rendering). Internal consumer tool (not model-facing).',
        read_only: true,
        permission: readPerm('filePath'),
        schema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute path to the file to read' },
          },
          required: ['filePath'],
          additionalProperties: {},
        },
      },
      { name: 'write_file_content', tsTool: 'write_file', permission: editPerm('filePath') },
      {
        name: 'log_append',
        description: 'Append content to a log file (create if missing). Internal consumer tool (not model-facing).',
        read_only: false,
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the log file' },
            content: { type: 'string', description: 'Content to append' },
          },
          required: ['path', 'content'],
          additionalProperties: {},
        },
      },
      { name: 'create_directory', tsTool: 'create_directory', permission: editPerm('path') },
      {
        name: 'get_global_memory_dir',
        description: 'Return the global memory directory path. Internal consumer tool (not model-facing).',
        read_only: true,
        schema: {
          type: 'object',
          properties: {},
          additionalProperties: {},
        },
      },
      { name: 'delete_file_or_dir', tsTool: 'delete_file', permission: editPerm('path') },
      // rename/move/log_append/read_memory_batch/get_global_memory_dir 业务自检
      // （P2-2 裁决：双路径/无路径语义不走 manifest 单键 permission 声明）
      { name: 'rename_file_or_dir', tsTool: 'rename_file' },
      { name: 'move_file', tsTool: 'move_file' },
      { name: 'glob', tsTool: 'glob', permission: readPerm('path') },
    ],
  },
  // ── builtin.editor（P2-1 已落地；TS 面经 createFsTools('edit')——manifest 驱动）──
  {
    domain: 'editor',
    id: 'builtin.editor',
    description: '代码编辑器（自 commands/editor.rs 拆出，kernel-plugin-runtime P2-1）',
    capabilities: ['filesystem_read', 'filesystem_write'],
    factory: fsToolsFactory,
    tools: [{ name: 'edit_file', tsTool: 'edit_file', permission: editPerm('filePath') }],
  },
  // ── builtin.constraints（P2-1 已落地；TS 面经 createFsTools——manifest 驱动）──
  {
    domain: 'constraints',
    id: 'builtin.constraints',
    description: '约束配置读写（自 commands/constraints.rs 拆出，kernel-plugin-runtime P2-1）',
    capabilities: ['filesystem_read', 'filesystem_write'],
    factory: fsToolsFactory,
    tools: [
      { name: 'read_constraints', tsTool: 'read_constraints' },
      { name: 'write_constraints', tsTool: 'write_constraints' },
    ],
  },
  // ── builtin.git（P2-3 用——createGitTools 今日仍是 zod 面（真实发射源）；
  //    13 TS 面直出 + diff 双目标共享 git_diff schema + stage_all/blame 手写 ──
  {
    domain: 'git',
    id: 'builtin.git',
    description: 'Git 仓库操作（自 commands/git_cmds.rs 拆出，kernel-plugin-runtime P2-3）',
    capabilities: ['git_read', 'git_write'],
    factory: gitToolsFactory,
    tools: [
      { name: 'git_status', tsTool: 'git_status', permission: readPerm('path') },
      {
        // 描述不覆盖：保持 git_diff 原文——TS git_diff 工具读本条，模型可见
        // 字节与迁移前零漂移（schema 内 staged 参数自述双目标语义）
        name: 'git_diff_unstaged',
        tsTool: 'git_diff',
        permission: readPerm('path'),
      },
      {
        name: 'git_diff_staged',
        tsTool: 'git_diff',
        permission: readPerm('path'),
      },
      { name: 'git_log', tsTool: 'git_log', permission: readPerm('path') },
      { name: 'git_stage', tsTool: 'git_stage', permission: gitPerm('stage') },
      {
        name: 'git_stage_all',
        description: 'Stage all changes (including untracked files) for commit. Equivalent of `git add .`.',
        read_only: false,
        permission: gitPerm('stage'),
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the git repository root' },
          },
          required: ['path'],
          additionalProperties: {},
        },
      },
      { name: 'git_commit', tsTool: 'git_commit', permission: gitPerm('commit') },
      { name: 'git_push', tsTool: 'git_push', permission: gitPerm('push') },
      { name: 'git_pull', tsTool: 'git_pull', permission: gitPerm('pull') },
      { name: 'git_init', tsTool: 'git_init', permission: gitPerm('init') },
      { name: 'git_checkout', tsTool: 'git_checkout', permission: gitPerm('checkout') },
      { name: 'git_create_branch', tsTool: 'git_create_branch', permission: gitPerm('create_branch') },
      { name: 'git_stash_push', tsTool: 'git_stash_push', permission: gitPerm('stash_push') },
      { name: 'git_stash_pop', tsTool: 'git_stash_pop', permission: gitPerm('stash_pop') },
      { name: 'git_discard', tsTool: 'git_discard', permission: gitPerm('discard') },
      {
        name: 'git_blame',
        description:
          'Show who last modified each line of a file (git blame). Output is porcelain-format and truncated for very large results.',
        read_only: true,
        permission: readPerm('path'),
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the git repository root' },
            file: { type: 'string', description: 'File to blame (relative to the repository root)' },
          },
          required: ['path', 'file'],
          additionalProperties: {},
        },
      },
    ],
  },
  // ── builtin.shell（P2-4）——4 TS 面直出（run→exec_command 等动作映射）+
  //    3 内部消费工具手写（shell_env/background_activity/drain_bg_notifications）。
  //    权限形状：全族业务自检（exec_command 的 bg/fg 双检查不对称——bg 走 sync
  //    免 Ask，dispatch 侧单键 adapter 表达不了，v1 形态不声明 permission）──
  {
    domain: 'shell',
    id: 'builtin.shell',
    description: 'Shell 执行与后台任务管理（自 commands/shell.rs 拆出，kernel-plugin-runtime P2-4）',
    capabilities: ['shell_exec'],
    factory: shellToolsFactory,
    tools: [
      { name: 'exec_command', tsTool: 'run_shell' },
      { name: 'bash_output', tsTool: 'bash_output' },
      { name: 'bash_kill', tsTool: 'bash_kill' },
      { name: 'bash_wait', tsTool: 'bash_wait' },
      {
        name: 'shell_env',
        description:
          'Return the current shell environment (OS, shell, path, bundled notes) for prompt injection. Internal consumer tool (not model-facing).',
        read_only: true,
        schema: {
          type: 'object',
          properties: {},
          additionalProperties: {},
        },
      },
      {
        name: 'background_activity',
        description:
          'Aggregate read-only snapshot of running shell background jobs and browser sessions (status-bar HUD). Internal consumer tool (not model-facing).',
        read_only: true,
        schema: {
          type: 'object',
          properties: {},
          additionalProperties: {},
        },
      },
      {
        name: 'drain_bg_notifications',
        description:
          'Drain pending background-job notifications (done/stalled notes) for an agent and return them as JSON. Internal consumer tool (not model-facing).',
        read_only: true,
        schema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Owner agent id whose notifications to drain' },
          },
          additionalProperties: {},
        },
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────
// 发射
// ─────────────────────────────────────────────────────────────

function emitTool(spec: ToolSpec, byName: Map<string, Tool>): Record<string, unknown> {
  const t = spec.tsTool ? byName.get(spec.tsTool) : undefined;
  if (spec.tsTool && !t) {
    throw new Error(`gen-kernel-manifest: TS 工具 '${spec.tsTool}' 未在 factory 产物中找到（spec '${spec.name}'）`);
  }
  const description = spec.descriptionOverride ?? t?.description() ?? spec.description;
  if (description === undefined) throw new Error(`spec '${spec.name}': 缺 description（tsTool 与手写均无）`);
  const tool: Record<string, unknown> = { name: spec.name, description };
  tool.read_only = t ? t.readOnly() : spec.read_only;
  if (tool.read_only === undefined) throw new Error(`spec '${spec.name}': 缺 read_only`);
  if (spec.permission) tool.permission = spec.permission;
  tool.schema = t ? t.parameters() : spec.schema;
  if (tool.schema === undefined) throw new Error(`spec '${spec.name}': 缺 schema`);
  return tool;
}

async function emitDomain(spec: DomainSpec): Promise<string> {
  const tools = await spec.factory();
  const byName = new Map(tools.map((t) => [t.name(), t]));
  const manifest = {
    id: spec.id,
    version: '1.0.0',
    trust: 'system',
    description: spec.description,
    capabilities: spec.capabilities,
    tools: spec.tools.map((t) => emitTool(t, byName)),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const wanted = argv.filter((a) => !a.startsWith('--'));
  const domains = wanted.length > 0 ? DOMAINS.filter((d) => wanted.includes(d.domain)) : DOMAINS;
  if (domains.length === 0) {
    console.error(
      `[kernel-manifest] 未知域过滤: ${wanted.join(', ')}（可用：${DOMAINS.map((d) => d.domain).join(' / ')}）`,
    );
    process.exit(1);
  }

  let dirty = false;
  for (const spec of domains) {
    const text = await emitDomain(spec);
    const file = path.join(TOOL_PLUGINS, spec.domain, 'manifest.json');
    if (check) {
      if (!existsSync(file)) {
        console.error(`[kernel-manifest] --check: ${file} 不存在（先跑发射）`);
        dirty = true;
        continue;
      }
      const current = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      if (current !== text) {
        console.error(`[kernel-manifest] 漂移: ${file}（重新发射可修）`);
        dirty = true;
      } else {
        console.log(`[ok] ${spec.id} 对拍一致（${spec.tools.length} 工具）`);
      }
    } else {
      mkdirSync(path.join(TOOL_PLUGINS, spec.domain), { recursive: true });
      writeFileSync(file, text, 'utf8');
      console.log(`[ok] ${spec.id} 发射（${spec.tools.length} 工具）→ ${path.relative(ROOT, file)}`);
    }
  }
  if (dirty) process.exit(1);
}

await main();

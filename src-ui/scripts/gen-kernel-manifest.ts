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

const editPerm = (pathKey: string): ManifestPermission => ({ family: 'Edit', path_key: pathKey });
// （readPerm 已随 git 域收口退役——Read 家族唯一消费方是 builtin.git 的只读
//  五工具，2026-09-05 R3-c；editPerm 的消费方是 builtin.editor。）

// ─────────────────────────────────────────────────────────────
// 域配置表（TOOLS_SPEC——生成器的手写部分：permission 声明、TS 名→Rust 名
// 映射、无 TS zod 面工具的完整定义）
// ─────────────────────────────────────────────────────────────

const dummyExec = async () => 'gen-kernel-manifest:dummy';

async function fsToolsFactory(): Promise<Tool[]> {
  const { createFsTools } = await import('../src/agent/tools/coding');
  return createFsTools(dummyExec);
}

// （builtin.git 域已随 git 域收口退役——2026-09-05，kernel-capability-c3-design.md
//  R3-c：git 13 模型族 schema 真源回 TS zod（coding.ts GIT_CAP_SCHEMA），
//  execute 换 git_cap 能力口直呼，反向生成源随插件一并拆除；fs 域同款先例。）

// （builtin.shell 域已随 shell 域收口退役——2026-09-05，kernel-capability-
//  c3-design.md R3-d：shell 4 模型族 schema 真源回 TS zod（coding.ts
//  SHELL_CAP_SCHEMA），execute 换 process_cap 能力口直呼，反向生成源随插件
//  一并拆除；fs/git 域同款先例。）

async function ptyToolsFactory(): Promise<Tool[]> {
  // pty/lsp 无模型面 TS zod 工具（lsp-client 经 typedRpc 内部消费）——
  // 工具面经本生成器以手写 spec 发射（内部消费工具：schema 非模型面契约）。
  return [];
}

async function lspToolsFactory(): Promise<Tool[]> {
  return [];
}

const DOMAINS: DomainSpec[] = [
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
  // ── builtin.git 域已退役（git 域收口 2026-09-05，R3-c——schema 真源回 TS zod
  //    （coding.ts GIT_CAP_SCHEMA），execute 走 git_cap 能力口直呼；域条目随
  //    tool_plugins/git/ 一并拆除，fs 域收口同款先例）──

  // ── builtin.shell 域已退役（shell 域收口 2026-09-05，R3-d——schema 真源回
  //    TS zod（coding.ts SHELL_CAP_SCHEMA），execute 走 process_cap 能力口直呼；
  //    域条目随 tool_plugins/shell/ 一并拆除，fs/git 域收口同款先例）──

  // ── builtin.browser 域已退役（browser 域收口 2026-09-05，R4-2——schema
  //    真源回 TS zod（agent/tools/browser.ts BROWSER_CAP_SCHEMA），execute 走
  //    browser_cap 能力口直呼；域条目随 tool_plugins/browser/ 一并拆除，
  //    fs/git/shell 域收口同款先例）──

  // ── builtin.uia 域已退役（browser 域收口 2026-09-05，R4-3——schema 真源
  //    回 TS zod（agent/tools/browser.ts UIA_CAP_SCHEMA），execute 走 uia_cap
  //    能力口直呼；域条目随 tool_plugins/uia/ 一并拆除，fs/git/shell/browser
  //    域收口同款先例）──

  // ── builtin.pty（P2-6）——4 RPC 分支信封化。权限形状（§8.5）：无家族规则，
  //    不进 manifest permission（原本就无工具级家族对应）；Passthrough +
  //    pty_manager::* 原函数（生命周期注册表不暴露 ToolContext）。
  //    TS 面无模型工具（pty 由 UI/内部消费）——schema 手写声明。──
  {
    domain: 'pty',
    id: 'builtin.pty',
    description: 'PTY 终端会话（自 rpc.rs PTY 分区拆出，kernel-plugin-runtime P2-6）',
    capabilities: ['pty'],
    factory: ptyToolsFactory,
    tools: [
      {
        name: 'pty_spawn',
        description: 'Spawn an interactive PTY shell session. Returns the numeric session id.',
        read_only: false,
        schema: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory for the shell' },
            shell: { type: 'string', description: 'Optional shell command (default: cmd.exe on Windows)' },
            cols: { type: 'integer', description: 'Initial terminal width in columns' },
            rows: { type: 'integer', description: 'Initial terminal height in rows' },
          },
          required: ['cwd', 'cols', 'rows'],
          additionalProperties: {},
        },
      },
      {
        name: 'pty_write',
        description: 'Write raw input data to a PTY session.',
        read_only: false,
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'integer', description: 'PTY session id' },
            data: { type: 'string', description: 'Input data to write' },
          },
          required: ['session_id', 'data'],
          additionalProperties: {},
        },
      },
      {
        name: 'pty_resize',
        description: 'Resize a PTY session terminal window.',
        read_only: false,
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'integer', description: 'PTY session id' },
            cols: { type: 'integer', description: 'New width in columns' },
            rows: { type: 'integer', description: 'New height in rows' },
          },
          required: ['session_id', 'cols', 'rows'],
          additionalProperties: {},
        },
      },
      {
        name: 'pty_kill',
        description: 'Terminate a PTY session and its child process tree.',
        read_only: false,
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'integer', description: 'PTY session id' },
          },
          required: ['session_id'],
          additionalProperties: {},
        },
      },
    ],
  },
  // ── builtin.lsp（P2-6）——3 RPC 分支信封化。权限形状（§8.5）：无家族规则，
  //    不进 manifest permission；Passthrough + lsp_manager::* 原函数。
  //    lsp-message 事件通道原样保留（Rust 侧 app.emit 不变，TS typedListen 消费）。
  //    TS 面无模型工具——lsp-client.ts 经信封内部消费；schema 手写声明。──
  {
    domain: 'lsp',
    id: 'builtin.lsp',
    description: 'LSP 语言服务器会话（自 rpc.rs LSP 分区拆出，kernel-plugin-runtime P2-6）',
    capabilities: ['lsp'],
    factory: lspToolsFactory,
    tools: [
      {
        name: 'lsp_start',
        description: 'Start an LSP server for a language over a workspace root. Returns the numeric session id.',
        read_only: false,
        schema: {
          type: 'object',
          properties: {
            language: { type: 'string', description: 'Language id (e.g. typescript, rust, python)' },
            root_uri: { type: 'string', description: 'Workspace root file:// URI' },
          },
          required: ['language', 'root_uri'],
          additionalProperties: {},
        },
      },
      {
        name: 'lsp_request',
        description: 'Send a JSON-RPC request/notification to an LSP session. Returns the JSON-RPC result.',
        read_only: false,
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'integer', description: 'LSP session id' },
            method: { type: 'string', description: 'JSON-RPC method' },
            params: { type: 'object', description: 'JSON-RPC params (optional for notifications)' },
          },
          required: ['session_id', 'method'],
          additionalProperties: {},
        },
      },
      {
        name: 'lsp_stop',
        description: 'Stop an LSP server session.',
        read_only: false,
        schema: {
          type: 'object',
          properties: {
            session_id: { type: 'integer', description: 'LSP session id' },
          },
          required: ['session_id'],
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

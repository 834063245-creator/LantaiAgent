// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// office 域（C 路）——OfficeCLI 一等域工具
// ═══════════════════════════════════════════════════════════════
// 为什么不再走 MCP 挂接（2026-09-13 改判，过程见
// docs/plans/office-cli-integration-plan.md §10）：MCP 挂接把 OfficeCLI 原样搬成
// 「一个收命令行字符串的工具」——它绕开兰台的强制面（MCP 子进程是全权用户进程：
// 不经 fs_cap、不受 os_sandbox 约束）、参数无类型、整块被标成一个写动作（plan 模式
// 连 view 都被拦）。本域把同一能力做成兰台原生形状：
//   · zod 真源收窄动作面（不做 CLI 全语法复刻——11 个动作够交付物/注疏/xlsx 三批用）；
//   · 经 ctx.shell seam → process_cap 能力口受控 spawn：os_sandbox 沙箱 + Bash 权限类
//     + 审计，与 run_shell 同一条路（**不新增能力口**：口数 = 能力族数，office 是
//     process 族的消费者，不是新的能力族）；
//   · readOnlyActions 白名单 ⇒ plan 模式按 action 分读写（view/get/query/validate 放行）；
//   · 命令行由本层拼装（模型不碰引号/转义），相对路径按工作区根解析。
//
// 两个刻意的产品决定：
//   1) 写动作**自动落盘**：子进程带 OFFICECLI_RESIDENT_FLUSH=each——officecli 的
//      resident 默认延迟写盘，而别的程序（兰台媒体回读、外部打开、交付）读的是盘上
//      字节；不钉这个开关就会出现"截图/预览是旧内容"这类静默错。
//   2) 关掉后台更新检查（OFFICECLI_SKIP_UPDATE=1）：确定性优先，升级走 pin + 安装器。

import { z } from 'zod';
import { isAbsolutePath, ownerContext, resolveAgainstRoot, stickyCwdOf } from '../session-context';
import type { Tool, ToolExecutor } from '../tool';
import { shellExecute } from './coding';
import { defineTool } from './define-tool';

/** 动作面（收窄）——**只收真会用的**：读（view/get/query/validate）、写（create/set/
 *  add/remove/batch）、交付（merge/screenshot）。CLI 的 raw/raw-set/add-part/refresh/
 *  mark/watch/load_skill 等不进模型面：前三个属 L3 逃生舱（真需要时走 shell 域），
 *  load_skill 由兰台技能体系承担，watch 是活预览窗的事。 */
export const OFFICE_ACTIONS = [
  'view',
  'get',
  'query',
  'validate',
  'create',
  'set',
  'add',
  'remove',
  'batch',
  'merge',
  'screenshot',
  'playbook',
] as const;
export type OfficeAction = (typeof OFFICE_ACTIONS)[number];

/** plan 模式放行的只读动作（screenshot 会写 PNG 文件，不算只读）。 */
export const OFFICE_READONLY_ACTIONS = ['view', 'get', 'query', 'validate', 'playbook'] as const;

/** 专项技能名（officecli 内置 load_skill 的清单——逐格式构建指南，正文 25–65 KB）。 */
export const OFFICE_PLAYBOOKS = [
  'word',
  'academic-paper',
  'word-form',
  'pptx',
  'pitch-deck',
  'morph-ppt',
  'morph-ppt-3d',
  'excel',
  'financial-model',
  'data-dashboard',
] as const;

/** 会改动目标文件的动作（用于结果里的落盘提示文案）。 */
const MUTATING_ACTIONS = new Set<OfficeAction>(['create', 'set', 'add', 'remove', 'batch', 'merge']);

/** view 的读数模式（透传 officecli；`screenshot` 走独立动作）。 */
const VIEW_MODES = ['text', 'annotated', 'outline', 'stats', 'issues', 'html', 'svg', 'forms'] as const;

/** 单引号包裹（POSIX shell 唯一通用安全写法）：内嵌单引号按 '\'' 收尾拼接。
 *  **模型不参与引号**——参数由本层拼装，路径里的空格/尖括号/方括号（`/slide[1]`
 *  这类会被 bash 当 glob）在这里一次解决。 */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** officecli 定位 + 环境钉扎（**在被 spawn 的 shell 里解析**）。
 *
 *  为什么不在 TS 侧探测：① 工具层碰不到盘；② `~/.lantai/tools` 不在沙箱用户数据
 *  白名单里（白名单只有 global_memory/skills/mcp.json），fs 能力口读不到它。
 *  解析顺序：$OFFICECLI_PATH（宿主若注入）→ 标准安装位 → PATH 兜底。两者皆无时
 *  bash 报 command not found，本层转成安装指引（见 cleanShellOutput）。 */
const BIN_RESOLVE =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是 **shell 参数展开**（${VAR:-默认}），不是 JS 模板串
  'BIN="${OFFICECLI_PATH:-$HOME/.lantai/tools/officecli/officecli.exe}"; [ -x "$BIN" ] || BIN=officecli; ';

/** 环境钉扎前缀：跳过后台更新检查 + 每次改动立即落盘（见文件头决定 1/2）。 */
const ENV_PIN = 'OFFICECLI_SKIP_UPDATE=1 OFFICECLI_RESIDENT_FLUSH=each ';

/** argv → 完整 shell 命令行（argv 逐项单引号包裹）。 */
export function buildOfficeCommand(argv: readonly string[]): string {
  return `${BIN_RESOLVE}${ENV_PIN}"$BIN" ${argv.map(shQuote).join(' ')}`;
}

/** 域工具入参（zod infer 的对偶形状——纯函数构造器只依赖这些字段，便于单测）。 */
export interface OfficeToolArgs {
  action: OfficeAction;
  /** 目标文件（playbook 不需要）。 */
  file?: string;
  path?: string;
  mode?: (typeof VIEW_MODES)[number];
  selector?: string;
  props?: Record<string, string>;
  /** add 的元素类型（如 paragraph/slide/shape/table）。 */
  type?: string;
  /** add 的父路径（缺省 / ——元素类型自身决定层级语义）。 */
  parent?: string;
  json?: boolean;
  items?: unknown[];
  data?: Record<string, string>;
  out?: string;
  page?: number;
  grid?: boolean;
  depth?: number;
  /** 专项技能名（load_skill）。 */
  playbook?: (typeof OFFICE_PLAYBOOKS)[number];
}

/** 动作 → argv（纯函数；`resolve` 负责把相对路径按工作区根解析为绝对路径）。
 *  返回 string = 参数不合法（作为工具结果直给模型，不抛）；返回 string[] = argv。 */
export function buildOfficeArgv(a: OfficeToolArgs, resolve: (p: string) => string): string | string[] {
  // playbook 不需要文件；其余动作都要。
  if (a.action !== 'playbook' && (!a.file || a.file.trim() === '')) {
    return `${a.action} 需要 file（目标 .docx/.xlsx/.pptx；相对路径按工作区根解析）`;
  }
  const f = resolve(a.file ?? '');
  const json = a.json === true ? ['--json'] : [];
  const props = Object.entries(a.props ?? {}).flatMap(([k, v]) => ['--prop', `${k}=${v}`]);
  switch (a.action) {
    case 'view': {
      // 无 mode 缺省 text：读数最常用且最省 token。
      const mode = a.mode ?? 'text';
      const page = a.page !== undefined ? ['--page', String(a.page)] : [];
      return ['view', f, mode, ...json, ...page];
    }
    case 'get': {
      if (!a.path) return 'get 需要 path（元素路径，如 /body/p[2]、/slide[1]/shape[@id=2]、/Sheet1/A1）';
      const depth = a.depth !== undefined ? ['--depth', String(a.depth)] : [];
      return ['get', f, a.path, ...depth, ...json];
    }
    case 'query': {
      if (!a.selector) return 'query 需要 selector（CSS 式选择器，如 paragraph[style=Heading1]、cell[value>5000]）';
      return ['query', f, a.selector, ...json];
    }
    case 'validate':
      return ['validate', f];
    case 'create':
      return ['create', f];
    case 'set': {
      if (!a.path) return 'set 需要 path';
      if (props.length === 0) return 'set 需要至少一个 props（key=value，如 {"bold":"true","color":"red"}）';
      return ['set', f, a.path, ...props];
    }
    case 'add': {
      if (!a.type) return 'add 需要 type（元素类型，如 paragraph/slide/shape/table/cell）';
      return ['add', f, a.parent ?? '/', '--type', a.type, ...props];
    }
    case 'remove': {
      if (!a.path) return 'remove 需要 path';
      return ['remove', f, a.path];
    }
    case 'batch': {
      // 3 处以上改动走 batch：一次开关 + 原子回滚；JSON 走 argv 单引号形态（免 shell 撕碎）。
      if (!a.items || a.items.length === 0)
        return 'batch 需要 items（数组，每项 {command,parent,type,props} 或 {command,path,props}）';
      return ['batch', f, '--commands', JSON.stringify(a.items), ...json];
    }
    case 'merge': {
      if (!a.out) return 'merge 需要 out（成品输出路径）';
      if (!a.data) return 'merge 需要 data（{"{{key}}": "值"} 的映射）';
      return ['merge', f, resolve(a.out), '--data', JSON.stringify(a.data)];
    }
    case 'screenshot': {
      if (!a.out) return 'screenshot 需要 out（PNG 输出路径；建议工作区内绝对路径）';
      const page = a.grid === true ? ['--grid', 'auto'] : a.page !== undefined ? ['--page', String(a.page)] : [];
      return ['view', f, 'screenshot', '-o', resolve(a.out), ...page];
    }
    case 'playbook': {
      // 专项技能：officecli 内置逐格式构建指南（load_skill）。保留这一动作是为了不丢
      // MCP 路原有的能力面——研报/路演/财务模型这些场景的权威规则都在里面（正文 25–65 KB）。
      if (!a.playbook) return `playbook 需要 playbook 参数（可选：${OFFICE_PLAYBOOKS.join(' / ')}）`;
      return ['load_skill', a.playbook];
    }
    default:
      return `unsupported action "${String(a.action)}". Available: ${OFFICE_ACTIONS.join(', ')}`;
  }
}

/** shell 层返回包的清洗：剥掉粘性 cwd 回显行（officecli 调用一律绝对路径，cwd 回显
 *  对模型是噪声），并在"找不到二进制"时补安装指引（错误不静默——别让模型去猜）。 */
export function cleanShellOutput(raw: string): string {
  const withoutCwd = raw
    .split('\n')
    .filter((line) => !/^\[cwd: .*\]$/.test(line.trim()))
    .join('\n')
    .trimEnd();
  if (/command not found|No such file or directory/i.test(withoutCwd)) {
    return `${withoutCwd}\n[office] 未找到 officecli 可执行文件。安装：examples/office-cli/install-officecli.ps1（pin 版本 + 哈希校验），或把它放进 PATH；诊断：examples/office-cli/preflight.ps1。`;
  }
  return withoutCwd;
}

const officeSchema = z.object({
  action: z
    .enum(OFFICE_ACTIONS)
    .describe('动作（读：view/get/query/validate/playbook；写：create/set/add/remove/batch；交付：merge/screenshot）'),
  file: z
    .string()
    .optional()
    .describe('目标 Office 文件（.docx/.xlsx/.pptx）。相对路径按工作区根解析。除 playbook 外所有动作必填。'),
  playbook: z
    .enum(OFFICE_PLAYBOOKS)
    .optional()
    .describe(
      'playbook 动作的专项技能名（逐格式构建指南，正文 25–65 KB）：word/academic-paper/word-form/pptx/pitch-deck/morph-ppt/morph-ppt-3d/excel/financial-model/data-dashboard。一件产物只载一个，别重复载。',
    ),
  path: z
    .string()
    .optional()
    .describe('元素路径（get/set/remove 用）：1-based 本地名路径，如 /body/p[2]、/slide[1]/shape[@id=2]、/Sheet1/A1。'),
  mode: z
    .enum(VIEW_MODES)
    .optional()
    .describe('view 的读数模式（缺省 text）：text/annotated/outline/stats/issues/html/svg/forms。'),
  selector: z.string().optional().describe('query 的 CSS 式选择器，如 paragraph[style=Heading1]、cell[value>5000]。'),
  props: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'set/add 的属性表（值一律字符串，如 {"text":"标题","style":"Heading1"}；单位/颜色写法见 officecli 技能 §8）。',
    ),
  type: z.string().optional().describe('add 的元素类型：paragraph/run/table/slide/shape/picture/comment/sheet/cell…'),
  parent: z.string().optional().describe('add 的父路径（缺省 /），如 /body、/slide[1]、/Sheet1、/styles。'),
  json: z
    .boolean()
    .optional()
    .describe('view/get/query/validate/batch 追加 --json（结构化输出；token 更贵，按需开）。'),
  items: z.array(z.unknown()).optional().describe('batch 的改动项数组（≥3 处改动优先用它：一次开关 + 原子回滚）。'),
  data: z.record(z.string(), z.string()).optional().describe('merge 的数据映射（键 = 模板里的 {{key}}）。'),
  out: z.string().optional().describe('输出路径（screenshot 的 PNG / merge 的成品文件）。相对路径按工作区根解析。'),
  page: z.number().int().optional().describe('screenshot 的页号（1-based）。'),
  grid: z.boolean().optional().describe('screenshot 出整册联系表（--grid auto）而不是单页。'),
  depth: z.number().int().optional().describe('get 的展开深度。'),
});

/** office 域工具族（S1 三层里的域插件经 ctx.tools 贡献；本族只有一条工具）。 */
export function createOfficeTools(exec: ToolExecutor): Tool[] {
  const tool = defineTool({
    name: 'office',
    description:
      'Read, edit, and produce Office files (.docx / .xlsx / .pptx) through OfficeCLI — the same engine as the `officecli` command line, but with typed actions and no quoting on your side.\n' +
      'Actions: view (read text/annotated/outline/stats/issues) · get (element + children) · query (CSS-like selector) · validate (OpenXML schema) · create · set / add / remove (element edits) · batch (≥3 edits in one atomic pass) · merge (fill {{key}} templates) · screenshot (render page/slides to PNG) · playbook (load a per-format build guide: word/academic-paper/pptx/pitch-deck/excel/financial-model/…).\n' +
      'Writes flush to disk immediately, so other tools and the user see fresh bytes at once.\n' +
      'Before producing a deliverable, run the delivery gate: validate → view issues (overflow/format/structure) → scan view text for leftover placeholders — note issues does NOT catch placeholders, missing image alt text, or empty content; and it does catch pptx overflow/off-slide shapes and xlsx formula errors.\n' +
      'Load the `officecli` skill for the full playbook (units, colors, template flow, tracked changes, pitfalls).',
    schema: officeSchema,
    domain: 'office',
    actions: OFFICE_ACTIONS,
    readOnlyActions: OFFICE_READONLY_ACTIONS,
    readOnly: false,
    execute: async (args, _onProgress, signal) => {
      const a = args as OfficeToolArgs;
      // meta key（executor 注入）取 owner 身份：相对路径按**该会话的工作区根**解析。
      const owner =
        typeof (args as { _owner_id?: unknown })._owner_id === 'string'
          ? ((args as { _owner_id?: string })._owner_id as string)
          : typeof (args as { _agent_id?: unknown })._agent_id === 'string'
            ? ((args as { _agent_id?: string })._agent_id as string)
            : undefined;
      const ctx = ownerContext(owner);
      const root = ctx?.workspaceRoot;
      const resolve = (p: string): string => {
        const norm = p.replace(/\\/g, '/');
        if (isAbsolutePath(norm) || !root) return norm;
        return resolveAgainstRoot(root, norm).replace(/\\/g, '/');
      };
      const argv = buildOfficeArgv(a, resolve);
      if (typeof argv === 'string') return `[office] ${argv}`;
      // cwd：沿用该 owner 的粘性 cwd（若无则工作区根）——execStreamedShell 会按命令
      // 落点回写粘性 cwd，这里刻意给"当前值"以免 office 调用把 shell 域的 cwd 顶掉。
      const cwd = stickyCwdOf(owner) ?? root;
      const out = await shellExecute(
        'run',
        { command: buildOfficeCommand(argv), ...(cwd ? { cwd } : {}), timeoutMs: 120_000 },
        exec,
        undefined,
        signal,
      );
      const text = cleanShellOutput(out);
      const tail = MUTATING_ACTIONS.has(a.action) ? '\n[office] 改动已落盘（resident 立即 flush）。' : '';
      return `${text}${tail}`;
    },
  });
  return [tool];
}

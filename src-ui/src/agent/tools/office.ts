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
//
// ⚠️ 已知边界（2026-09-15 实测，尚未修）：FLUSH=each 只在**由本工具启动**的子进程里
//    生效。若目标文件上已经存在一个**外来的裸 resident**（别处 `officecli open` 起的、
//    不带 FLUSH 的常驻进程），后续调用会被路由进那个进程，本工具的 FLUSH 开关随之失效
//    —— 实测：工具报 `Updated ...: value=TOOL_WRITE` 成功，磁盘却仍是空的。此时
//    OFFICECLI_NO_AUTO_RESIDENT 也**不能**绕开（实测同样落空），只能先 `close` 掉外来
//    resident。这是 officecli 的 resident 语义所致，不是本工具的开关能解的。
//
// ── 2026-09-15 事故修复批（用户会话 23「复杂 excel」实测复盘）────────────────
// 那场测试里模型只调了 5 次本工具、其余 71 次全在绕路（shell / code_execution），
// 最后用一个 Node 脚本直接驱动 officecli 收场。四处病灶 + 修法：
//   · 假成功信号 → 结果脚注改**退出码感知**（失败/未知一律不声明落盘）。
//   · 一次 batch 塞 2174 项（>100KB argv）→ 回执"零失败"而磁盘只落 19/180 行：
//     现在 >100 项或 >12KB 自动切块顺序执行，失败停在原地并报"前 N 批已落盘"。
//   · playbook 正文是 officecli 自带的**命令行**指南（488 行 / 101 条 officecli 命令，
//     含强制的 Help-First Rule）→ 模型照它下 shell → `command not found` → 转去找二进制
//     → 与本工具抢 resident。正文改不了，改为返回时前置护栏头（PLAYBOOK_GUARD_HEADER）。
//   · cleanShellOutput 的"找不到二进制"判定过宽（任何 No such file or directory 都命中）
//     → 收窄为 officecli(.exe) 与错误文案相邻。
//
// ⚠️ 未修（P0，需权限族级改造，2026-09-15 探针实证）：本工具的命令串在**默认权限模式下
//    每次调用都触发 Ask**，且任何 allow 规则都压不住——`bash::check` 把 argv 里含 `/` 的
//    token 一律当路径解析：① `BIN=${...}` 赋值段；② DOM 路径 `/body/p[1]`；③ batch 的 JSON
//    载荷（含 `/Sheet1/A1`）。三者都解析失败 ⇒ "项目外路径" ⇒ Ask，而该判定在
//    **allow 规则匹配之前提前返回**（bash.rs 步骤 3 → 4），所以"始终允许"写进去也不生效。
//    只在 yolo 模式下不可见（用户那次测试正是 yolo）。修法见
//    docs/plans/office-cli-integration-plan.md §11。

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
      if (!a.items || a.items.length === 0) {
        return (
          'batch 需要 items（数组，不能为空）。每项形状：' +
          '{command:"set"|"add"|"remove"|"move"|"swap", path?, parent?, type?, props?, selector?, to?, after?, before?} —— ' +
          'command 是**裸动词**，动词的参数是**同级字段**（不是塞进 command 的字符串）。' +
          '例：[{command:"set",path:"/Sheet1/A1",props:{value:"标题"}},{command:"add",parent:"/Sheet1",type:"row",props:{}}]'
        );
      }
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
 *  对模型是噪声），并在"找不到二进制"时补安装指引（错误不静默——别让模型去猜）。
 *
 *  ⚠️ 判定必须**只认二进制缺席**（2026-09-15 收窄）：早先只匹配 `No such file or directory`
 *  ⇒ 目标文件不存在、路径写错、DOM 路径里带空格等一切"文件找不到"都被误报成"officecli 没装"，
 *  把模型推去装二进制。现在要求 officecli(可选 .exe) 与错误文案相邻出现。 */
export function cleanShellOutput(raw: string): string {
  const withoutCwd = raw
    .split('\n')
    .filter((line) => !/^\[cwd: .*\]$/.test(line.trim()))
    .join('\n')
    .trimEnd();
  if (/officecli(\.exe)?["']?:\s*(command not found|no such file or directory)/i.test(withoutCwd)) {
    return `${withoutCwd}\n[office] 未找到 officecli 可执行文件（解析序：$OFFICECLI_PATH → ~/.lantai/tools/officecli/officecli.exe → PATH）。安装：examples/office-cli/install-officecli.ps1（pin 版本 + 哈希校验）；诊断：examples/office-cli/preflight.ps1。**不要**自己下 shell 找二进制跑——那会另起常驻进程抢同一个文件。`;
  }
  return withoutCwd;
}

/** shell 层结果里的退出码（`[exit N]` 前缀）。读不到 = null —— **绝不把未知当成功**。 */
export function parseShellExit(raw: string): number | null {
  const m = raw.match(/^\s*\[exit\s+(\d+)\]/i);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/** batch 单次 CLI 调用的两条硬上限（取先到者）：
 *  · 条数 100 —— officecli 官方建议 ≤50 ops/块、实测 80+ 零失败（见 playbook），留余量；
 *  · 序列化 12KB —— 命令是经 `bash -c` 单串进 CreateProcess 的，Windows 命令行上限
 *    32767 字符，**超限静默截断**。2026-09-15 实测事故：2174 项塞一条命令（>100KB），
 *    回执「零失败」而磁盘只落 19/180 行，没有任何一层报错。 */
export const OFFICE_BATCH_MAX_ITEMS = 100;
export const OFFICE_BATCH_MAX_BYTES = 12_000;

/** batch items → 分块（超大单项独占一块；空表 → 空块表）。 */
export function splitOfficeBatchItems(
  items: readonly unknown[],
  maxItems: number = OFFICE_BATCH_MAX_ITEMS,
  maxBytes: number = OFFICE_BATCH_MAX_BYTES,
): unknown[][] {
  const chunks: unknown[][] = [];
  let cur: unknown[] = [];
  let bytes = 2; // '[' + ']'
  for (const item of items) {
    const size = (JSON.stringify(item) ?? '').length + 1; // +1 = 分隔逗号
    if (cur.length > 0 && (cur.length >= maxItems || bytes + size > maxBytes)) {
      chunks.push(cur);
      cur = [];
      bytes = 2;
    }
    cur.push(item);
    bytes += size;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** 分批执行时单批输出的展示上限（防 20+ 批把工具结果撑爆）。 */
function clipBatchOutput(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[本批输出已截断，共 ${text.length} 字符]`;
}

/** playbook 正文的护栏头（2026-09-15 实测事故补丁）：正文是 **officecli 自带的命令行
 *  指南**，模型照它去 shell 里跑 `officecli help …` → `command not found` → 转去找二进制
 *  → 另起常驻进程与本工具抢同一文件 → 写入静默丢失。正文不在本仓、改不了，只能在返回时
 *  补这一层「翻译 + 禁止」。 */
export const PLAYBOOK_GUARD_HEADER = [
  '[兰台] 以下正文来自 OfficeCLI 自带的构建指南。**正文里的 `officecli …` 命令行在本环境不可执行**：',
  '① `officecli` 不在 shell 的 PATH 里；② 直调它会另起一个常驻进程，与本工具的 resident 抢同一个文件 ⇒ 写入静默丢失（2026-09-15 实测：回执「零失败」而磁盘只落 19/180 行）。',
  '读法：把正文每条命令**翻译**成 office 域工具动作（view/get/query/validate/create/set/add/remove/batch/merge/screenshot）。',
  '正文要求「先查 help 确认属性名」——本环境没有 help 通道：属性名没把握时用**一条最小 batch（1 项）**试探，不要下 shell 去试。',
].join('\n');

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
      // cwd：沿用该 owner 的粘性 cwd（若无则工作区根）——execStreamedShell 会按命令
      // 落点回写粘性 cwd，这里刻意给"当前值"以免 office 调用把 shell 域的 cwd 顶掉。
      const cwd = stickyCwdOf(owner) ?? root;

      const runOne = async (argv: readonly string[]): Promise<{ text: string; exit: number | null }> => {
        const out = await shellExecute(
          'run',
          { command: buildOfficeCommand(argv), ...(cwd ? { cwd } : {}), timeoutMs: 120_000 },
          exec,
          undefined,
          signal,
        );
        return { text: cleanShellOutput(out), exit: parseShellExit(out) };
      };

      // 落盘脚注：**只看退出码说话**（2026-09-15 事故——失败也追加"已落盘"，模型据此
      // 当成功继续）。成功也只声明"已提交 + flush 开关已带"，不再承诺"别人一定看到新字节"：
      // 该开关只对**本进程持有的 resident** 生效，外来裸 resident 会让它失效（文件头已知边界）。
      const flushTail = (exit: number | null): string => {
        if (!MUTATING_ACTIONS.has(a.action)) return '';
        if (exit === 0) {
          return '\n[office] 改动已提交（resident flush=each）。注意：若该文件此前已被**另一个** officecli 进程打开，本开关不生效、磁盘字节可能滞后——要确定时用 office(action:"view") 复核。';
        }
        if (exit === null) {
          return '\n[office] ⚠️ 本次调用没拿到退出码 —— 结果**未知**，不要当成功继续。';
        }
        return `\n[office] ⚠️ 本次改动**未成功**（退出码 ${exit}）：上面的报错才是真相，按它修参数后重试，不要当成功继续。`;
      };

      // batch：超大 items 必须切块执行（见 OFFICE_BATCH_MAX_*）——一次 CLI 调用装不下，
      // 而且超限是**静默**的。批间不原子，所以失败要停在原地并说清哪几批已落盘。
      if (a.action === 'batch' && Array.isArray(a.items) && a.items.length > 0) {
        const chunks = splitOfficeBatchItems(a.items);
        if (chunks.length > 1) {
          const lines: string[] = [
            `[office] batch 共 ${a.items.length} 项 → 分 ${chunks.length} 批执行（每批自身原子回滚；**批与批之间不原子**，已成功的批次不回退）。`,
          ];
          let failedAt = 0;
          for (let i = 0; i < chunks.length; i++) {
            const argv = buildOfficeArgv({ ...a, items: chunks[i] }, resolve);
            if (typeof argv === 'string') return `[office] ${argv}`;
            const r = await runOne(argv);
            lines.push(`── 批 ${i + 1}/${chunks.length}（${chunks[i]?.length ?? 0} 项）──\n${clipBatchOutput(r.text)}`);
            if (r.exit !== 0) {
              failedAt = i + 1;
              break;
            }
          }
          lines.push(
            failedAt === 0
              ? `[office] ${chunks.length} 批全部成功，共 ${a.items.length} 项。${flushTail(0)}`
              : `[office] ⚠️ 第 ${failedAt}/${chunks.length} 批失败并已停下：前 ${failedAt - 1} 批已落盘、第 ${failedAt} 批起**未执行**。修好该批的报错后**只补做第 ${failedAt} 批起的数据**，不要整表重来。`,
          );
          return lines.join('\n');
        }
      }

      const argv = buildOfficeArgv(a, resolve);
      if (typeof argv === 'string') return `[office] ${argv}`;
      const r = await runOne(argv);
      const body = a.action === 'playbook' ? `${PLAYBOOK_GUARD_HEADER}\n\n────────────\n\n${r.text}` : r.text;
      return `${body}${flushTail(r.exit)}`;
    },
  });
  return [tool];
}

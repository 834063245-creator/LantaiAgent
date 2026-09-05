// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件规范层（WO-S0B）——manifest 与插件对象的宿主无关契约。
// 设计边界（composition 计划 D0 拍板）：manifest 形状设计为将来可迁移的规范层，
// 不耦合兰台的 UI/RPC 细节；宿主交互面（四 service：panels/commands/
// tools/llm——2026-08-27 providers 键升格更名 llm）是 S1 的事，本文件不预设。
//
// 纪律（CONVENTIONS §1.6 defineTool 同款）：一个 zod schema 同时产出运行时校验
// 与 TS 类型（z.infer），禁止手写平行接口后再 as 强转。

import { z } from 'zod';
import type { Context } from '../cordis';

/** 插件唯一 id：npm scope 风格，最多两段（如 hologram/settings）。 */
const PLUGIN_NAME_RE = /^[a-z0-9-]+(\/[a-z0-9-]+)?$/;

/** semver（含 prerelease / build 元数据）。 */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** 入口路径字符白名单（URL 安全；回溯/绝对段由 isSafeEntry 拒绝）。 */
const ENTRY_CHARS_RE = /^[a-z0-9._/-]+$/i;

/** entry 合法性：相对 ESM 路径，段非空且不为 . / ..，以 .js/.mjs 结尾。 */
function isSafeEntry(value: string): boolean {
  if (value.startsWith('/') || !/\.(js|mjs)$/.test(value)) return false;
  const segments = value.split('/');
  return segments.every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** app 窗口入口合法性（app shell 件 A · S3）：`./` 前缀的相对 HTML 路径
 *  （插件自包含——段非空且不为 . / ..，以 .html 结尾）。强制 `./` 前缀让
 *  「相对插件目录」显式化（与 mcpServers args 的 `./` 约定同构）；绝对路径
 *  与回溯段拒绝。 */
function isSafeAppEntry(value: string): boolean {
  if (!value.startsWith('./') || !/\.html$/.test(value)) return false;
  if (!ENTRY_CHARS_RE.test(value)) return false;
  const segments = value.slice(2).split('/');
  return segments.every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** MCP server 声明（manifest.mcpServers 条目，S4-4 乙机器桥）：stdio（command
 *  相对插件目录解析）| http（url 直连）二选一；failurePolicy 缺省 lazy——瞬态
 *  机器不是装载失败的合格理由（进程挂了工具报错/空集，不炸装载）。
 *
 *  治理字段（app shell 件 C · S2，受治进程生命周期治理）：restart / lifecycle
 *  任一在场 = 该条目进入受治面（mcp-bridge 治理器接管：就绪 = initialize 握手
 *  完成带时限、崩溃退避重启、三档生命周期、空闲回收——failurePolicy 对该条目
 *  退役）。两字段皆缺席 = 旧形态，现行为逐字节不变（兼容钉死）。治理字段只对
 *  stdio 进程有意义——http 条目无受治进程面，声明即拒。 */
const McpServerDeclSchema = z
  .strictObject({
    /** server 名——工具名前缀 `mcp__<name>__*` + 行 id 尾段。 */
    name: z.string().min(1),
    transport: z.enum(['stdio', 'http']),
    /** stdio：可执行命令。相对路径（含分隔符）相对插件目录解析；裸名走 PATH。 */
    command: z.string().min(1).optional(),
    /** stdio：命令参数。`./`/`../` 前缀的相对形态相对插件目录解析
     *  （平台化 P4 · D1 示例：`["./server.cjs"]`）；其余原样透传（用绝对路径
     *  或 PATH 可执行）。 */
    args: z.array(z.string()).optional(),
    /** http：直连端点。 */
    url: z.string().min(1).optional(),
    /** http：请求头（明文进 manifest——插件目录是全信任区，与 command 同级）。 */
    headers: z.record(z.string(), z.string()).optional(),
    /** startup-error：装载期急连接验证，失败 → 插件 error 记录；
     *  lazy（缺省）：首装配连接，失败 → 空集 + warn（下次装配重试）。
     *  治理字段在场时对本条目退役（治理面接管失败语义）。 */
    failurePolicy: z.enum(['startup-error', 'lazy']).optional(),
    /** 崩溃重启策略（S2 治理字段）：off（缺省）= 不自动重启（下次装配/调用
     *  兜底拉起）；on-crash = 进程意外退出后指数退避自动重启。 */
    restart: z.enum(['off', 'on-crash']).optional(),
    /** 生命周期三档（S2 治理字段，决策 1/4）：lazy（缺省）= 首次装配/调用/开窗
     *  拉起，无窗且空闲超时回收，再调用再拉起；eager = 装载即拉起，卸载才停
     *  （装配/调用发现未就绪时兜底拉起）；with-window = 随窗开合（开窗拉起，
     *  关窗即杀——keep-alive 属 S3 窗口面扩展位）。 */
    lifecycle: z.enum(['lazy', 'eager', 'with-window']).optional(),
  })
  .refine((v) => (v.transport === 'stdio' ? !!v.command && !v.url : !!v.url && !v.command), {
    message: 'mcpServers 条目：stdio 必须 command（禁 url）；http 必须 url（禁 command）',
  })
  .refine((v) => !(v.transport === 'http' && (v.restart !== undefined || v.lifecycle !== undefined)), {
    message: 'mcpServers 条目：治理字段（restart/lifecycle）只对 stdio 受治进程有意义——http 无进程面',
  });

/** manifest.tools 条目 schema（C11-1 工具声明可序列化）：模型面三字段与
 *  DSH L1 契约同构（ToolSchema——name/description/parameters JSON Schema，
 *  p4a-dsh-contract-notes §1.1）+ readOnly。声明是纯数据（免编译挂载前提
 *  ——装载期可见，无需执行插件代码）。 */
const ToolManifestDeclSchema = z.strictObject({
  /** 模型可见工具名（全局唯一——Tool.name() 撞名在行装载期拒绝）。 */
  name: z.string().min(1),
  description: z.string().min(1),
  /** 参数 JSON Schema（与 defineTool 的 toInputJsonSchema 输出同一规范，
   *  draft-7 object 形态）。 */
  parameters: z.record(z.string(), z.unknown()).refine((v) => (v as { type?: unknown }).type === 'object', {
    message: 'parameters 必须是 type:"object" 的 JSON Schema（工具参数是对象形态）',
  }),
  /** 是否只读（可安全并行）；缺省 false。 */
  readOnly: z.boolean().optional(),
});

/** 权限类枚举（C11-2）——Rust 权限咽喉的五个域（PascalCase 规则名的
 *  lowercase 形态：Read/Edit/Bash/Git/WebFetch）。枚举闭集（未知类拒绝
 *  ——「写了但不生效」的类名是手误，错误不静默）。 */
const PLUGIN_PERMISSION_CLASS = z.enum(['read', 'edit', 'bash', 'git', 'web']);

/** manifest.app 声明（app shell 件 A · S3，应用视图通道）：插件声明自己的
 *  窗内容入口与窗模式——装载只登记窗口定义（注册表数据），开窗才实例化
 *  iframe 视口（宿主窗口注册表 + postMessage 白名单桥，见 state/
 *  plugin-window-store.ts 与 plugins/window-bridge.ts）。窗内渲染完全归
 *  插件（iframe 真隔离，§4-3 拍板）。 */
const APP_WINDOW_MODE = z.enum(['floating', 'dock', 'fullscreen']);

const AppDeclSchema = z.strictObject({
  /** 窗内容入口：`./` 前缀相对插件目录的 HTML（资产通道寻址）。 */
  entry: z.string().refine(isSafeAppEntry, {
    message: 'app.entry 必须是 "./" 前缀的相对 HTML 路径（如 ./app/index.html），禁止绝对路径/回溯段',
  }),
  /** 窗模式：floating（缺省，画布上浮动窗）/ dock（右侧停靠栏）/ fullscreen
   *  （盖满视口）。 */
  mode: APP_WINDOW_MODE.optional(),
  /** 窗标题（书眉显示；缺省用插件名）。 */
  title: z.string().min(1).optional(),
});

export const PluginManifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE, 'name 必须是 npm scope 风格 id（如 hologram/settings）'),
  version: z.string().regex(SEMVER_RE, 'version 必须是 semver（如 1.0.0）'),
  description: z.string().optional(),
  entry: z
    .string()
    .regex(ENTRY_CHARS_RE, 'entry 含非法字符')
    .refine(isSafeEntry, 'entry 必须是相对 ESM 路径（如 entry.js），禁止绝对路径/回溯段/非 js 后缀'),
  /** 依赖的 ctx service 名——装载期校验存在性，缺 → error 状态（WO-S0B）。 */
  inject: z.array(z.string().min(1)).optional(),
  /** 权限声明（C11-2 permissions.json 接插件声明，2026-08-24）：插件声明
   *  需要的权限类（read/edit/bash/git/web——Rust 权限咽喉的五个域）。
   *  装载期一票否决：plugins.json 的 granted 段未覆盖全部声明类 → 插件
   *  不装载（blocked 状态，设置面板可见缺哪些授权）。声明是安装期信任面
   *  ——逐调用强制仍在 Rust 命令层（声明与否，权限规则与模式照常生效）。 */
  permissions: z.array(PLUGIN_PERMISSION_CLASS).optional(),
  /** 位移式装载（增补四施工，first-party-hot-reload-plan）：声明 true 的
   *  内置产物与 bundle 同名行贡献 id 共享（面板/工具行 id 不分立），装载
   *  前 dispose bundle fiber（贡献面单活互换）；产物失败/停用 → bundle
   *  兜底行恢复。缺省 false（渲染器双行走查语义：行 id 分立、后注册胜，
   *  bundle 行恒在）。第三方同名产物声明 true 可覆盖同名内置插件（用户
   *  目录权威语义与 Rust 资产通道回退一致）。 */
  displace: z.boolean().optional(),
  /** 数据地盘（app shell 四件套 · 件 B，S1）：声明 true 的插件装载即分配
   *  专属数据目录 `<dataRoot>/<名>/`（幂等 ensure——wrapper apply 先于插件
   *  代码调用，失败 = 装载失败记录）；宿主桥 fs 面（ensure/list/read/
   *  write/delete）读写列删，路径锁死在插件根（Rust plugin_data 双围栏 +
   *  canonicalize 前缀）；卸载随 plugin_uninstall 整体挪 `.trash` 回收
   *  （备份一个目录全家走——决策 2）。缺省/false 不分配不侵入。 */
  dataDir: z.boolean().optional(),
  /** 应用窗声明（app shell 四件套 · 件 A，S3）：声明 = 插件以软件形态住进
   *  兰台——装载只登记窗口定义（数据），开窗才实例化视口。窗内容 = 插件
   *  自包含 HTML 经 iframe 载体渲染（真隔离）；窗内向宿主要能力走
   *  postMessage 白名单桥（默认最小集 fs 数据目录 + notify）。卸载随插件
   *  收口：定义注销 + 开着窗口全关（受治进程 with-window 档随关窗杀）。 */
  app: AppDeclSchema.optional(),
  /** 声明式工具（C11-1 工具声明可序列化，2026-08-24）：声明是数据
   *  （name/description/parameters JSON Schema/readOnly——与 DSH L1 契约
   *  同构的三字段 + readOnly）；执行函数经 entry 模块的 `toolHandlers`
   *  命名导出映射（name → execute）。装载器折算为工具贡献（行 id
   *  `plugin/<插件名>/<工具名>`，patch/preset 可寻址禁用）；声明与实现
   *  一一对应（缺/多均插件 error，失败隔离）。 */
  tools: z.array(ToolManifestDeclSchema).optional(),
  /** 声明式挂接外部 MCP server（S4-4 乙机器桥，设计件 S4 §2.7）：装载期逐个
   *  折算为工具行贡献（行 id `plugin/<插件名>/mcp/<server名>`）——patch/preset
   *  可寻址禁用某插件的某个 MCP server，组合均匀性不破。进程 kill 归插件
   *  fiber disposer。条目声明治理字段（restart/lifecycle，app shell 件 C · S2）
   *  = 受治进程：就绪 = initialize 握手完成（带时限）、崩溃退避重启、三档
   *  生命周期、空闲回收（见 mcp-bridge.ts 治理器）。 */
  mcpServers: z.array(McpServerDeclSchema).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** manifest.tools 条目（C11-1 声明式工具）。 */
export type ToolManifestDecl = z.infer<typeof ToolManifestDeclSchema>;

/** 权限类（C11-2）——插件可声明的权限域。 */
export type PluginPermissionClass = z.infer<typeof PLUGIN_PERMISSION_CLASS>;

/** manifest.mcpServers 条目（S4-4 乙机器桥）。 */
export type McpServerDecl = z.infer<typeof McpServerDeclSchema>;

/** manifest.app 声明（app shell 件 A · S3）。 */
export type AppDecl = z.infer<typeof AppDeclSchema>;

/** 窗模式（app shell 件 A · S3）——窗口注册表/设施面共用。 */
export type PluginWindowMode = z.infer<typeof APP_WINDOW_MODE>;

/** 插件对象：apply 只做注册动作；本阶段可注册的只有 cordis 原生能力（effect 等），
 * 四 service 是 S1。装载期禁止任何 UI 副作用（WO-S0B 红线）。 */
export interface LantaiPlugin {
  name: string;
  apply(ctx: Context): void | Promise<void>;
}

export type ManifestValidation = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

/** manifest 校验单一入口（loader 与测试共用；错误显式返回，不做静默兜底）。 */
export function validateManifest(raw: unknown): ManifestValidation {
  const result = PluginManifestSchema.safeParse(raw);
  if (result.success) return { ok: true, manifest: result.data };
  const error = result.error.issues
    .map((issue) => (issue.path.join('.') || '(root)') + ': ' + issue.message)
    .join('; ');
  return { ok: false, error };
}

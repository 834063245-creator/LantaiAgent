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

/** MCP server 声明（manifest.mcpServers 条目，S4-4 乙机器桥）：stdio（command
 *  相对插件目录解析）| http（url 直连）二选一；failurePolicy 缺省 lazy——瞬态
 *  机器不是装载失败的合格理由（进程挂了工具报错/空集，不炸装载）。 */
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
     *  lazy（缺省）：首装配连接，失败 → 空集 + warn（下次装配重试）。 */
    failurePolicy: z.enum(['startup-error', 'lazy']).optional(),
  })
  .refine((v) => (v.transport === 'stdio' ? !!v.command && !v.url : !!v.url && !v.command), {
    message: 'mcpServers 条目：stdio 必须 command（禁 url）；http 必须 url（禁 command）',
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
   *  fiber disposer。 */
  mcpServers: z.array(McpServerDeclSchema).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** manifest.tools 条目（C11-1 声明式工具）。 */
export type ToolManifestDecl = z.infer<typeof ToolManifestDeclSchema>;

/** 权限类（C11-2）——插件可声明的权限域。 */
export type PluginPermissionClass = z.infer<typeof PLUGIN_PERMISSION_CLASS>;

/** manifest.mcpServers 条目（S4-4 乙机器桥）。 */
export type McpServerDecl = z.infer<typeof McpServerDeclSchema>;

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

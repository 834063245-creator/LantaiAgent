// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件规范层（WO-S0B）——manifest 与插件对象的宿主无关契约。
// 设计边界（composition 计划 D0 拍板）：manifest 形状设计为将来可迁移的规范层，
// 不耦合兰台的 UI/RPC 细节；宿主交互面（四 service：panels/commands/
// tools/llm——2026-08-27 providers 键升格更名 llm）是 S1 的事，本文件不预设。
//
// 纪律（CONVENTIONS §1.6 defineTool 同款）：一个 zod schema 同时产出运行时校验
// 与 TS 类型（z.infer），禁止手写平行接口后再 as 强转。

import { satisfies, validRange, valid as validVersion } from 'semver';
import { z } from 'zod';
import { ACTIVATION_RESOURCE_KINDS } from '../composition/activation';
import { OPEN_SURFACE_CONTRACT_VERSION } from '../composition/contract-version';
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
 *  受治进程（app shell 件 C · S2 治理面；2026-11-23 减形后只剩一种语义）：
 *  `governed: true` = 该条目进入受治面（mcp-bridge 治理器接管：就绪 = initialize
 *  握手完成带时限、崩溃退避重启、空闲回收、未就绪调用 fail-fast——failurePolicy
 *  对该条目退役）。`governed` 缺席 = 旧形态，现行为逐字节不变（兼容钉死）。
 *  `restart` 是受治面的**策略旋钮**，不是另一条入场路径：写它必须同时写
 *  `governed: true`（受治面会改变失败语义，不能被一个策略字段隐式打开）。
 *  受治字段只对 stdio 进程有意义——http 条目无受治进程面，声明即拒。 */
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
    /** 该 server 全部工具的只读担保（P0，2026-09-13）：**缺省不表态**——按远端
     *  `annotations.readOnlyHint` 判，远端亦无声明则 fail-closed **视为写**
     *  （plan 模式拦截 + 不进只读并行组）。
     *  声明 true = 插件作者担保该 server 工具集全只读；声明 false = 强制写。
     *  误声明 true 会重现「写动作绕过 plan 门禁」的旧洞（本字段即为修复该洞的
     *  显式通道）——声明前务必核对 server 侧真实行为。
     *  判定真源 = agent/mcp/registry.resolveMcpToolReadOnly（单一真源）。 */
    readOnly: z.boolean().optional(),
    /** 受治进程开关（S2 治理字段，2026-11-23 减形）：声明 true = 本条目进受治面
     *  （就绪握手带时限 / 崩溃退避重启 / 空闲回收 / 未就绪调用 fail-fast）。
     *  缺省 = 旧形态。三档 `lifecycle`（lazy / eager / with-window）已退役：
     *  真实消费者只有「懒起」一种语义，另两档除测试外零消费者。 */
    governed: z.boolean().optional(),
    /** 崩溃重启策略（S2 治理字段，**只对受治进程有意义**——与 governed: true
     *  同时出现，见下方 refine）：off（缺省）= 不自动重启（下次装配/调用兜底
     *  拉起）；on-crash = 进程意外退出后指数退避自动重启。 */
    restart: z.enum(['off', 'on-crash']).optional(),
  })
  .refine((v) => (v.transport === 'stdio' ? !!v.command && !v.url : !!v.url && !v.command), {
    message: 'mcpServers 条目：stdio 必须 command（禁 url）；http 必须 url（禁 command）',
  })
  .refine((v) => !(v.transport === 'http' && (v.governed !== undefined || v.restart !== undefined)), {
    message: 'mcpServers 条目：受治字段（governed/restart）只对 stdio 受治进程有意义——http 无进程面',
  })
  .refine((v) => v.restart === undefined || v.governed === true, {
    message:
      'mcpServers 条目：restart 只对受治进程有意义——同时声明 governed: true' +
      '（受治面会改变失败语义〔未就绪调用 fail-fast〕，不能被一个策略字段隐式打开）',
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

/** 宿主兼容声明（2026-11-23 契约 v74）：`lantai` = 宿主版本 semver range。
 *
 *  语义：**声明了就必须满足**——装载期不满足 ⇒ 具名拒载（原因带「需要 X，当前 Y」）。
 *  宿主版本未知（开发/测试/产物域，`__LANTAI_BUILD__.v` 缺席）⇒ **跳过检查 + warn**，
 *  不阻断——版本未知不是「不兼容」，拿它拒载会把整个开发面打死。
 *  `engines` 是**兼容声明**不是能力：它不改变任何装载语义，只提前把「你这插件要
 *  新宿主」变成可行动的错误。 */
const EnginesDeclSchema = z.strictObject({
  lantai: z.string().min(1).optional(),
});

/** 权限类枚举（C11-2）——Rust 权限咽喉的五个域（PascalCase 规则名的
 *  lowercase 形态：Read/Edit/Bash/Git/WebFetch）。枚举闭集（未知类拒绝
 *  ——「写了但不生效」的类名是手误，错误不静默）。 */
const PLUGIN_PERMISSION_CLASS = z.enum(['read', 'edit', 'bash', 'git', 'web']);

/** 环回主机白名单（app.url 形态的硬边界）：只许本机服务，禁任意公网页面。
 *  `URL.hostname` 对 IPv6 字面量返回带方括号形态，故 `[::1]` 也在表内。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** app.url 合法性：**环回 http(s)**——协议 http/https + 主机在环回白名单 +
 *  不带凭据（user:pass@）。任何一条不满足即拒（错误不静默）。
 *
 *  为什么只许环回：远端文档以 `allow-same-origin` 承载（它必须保住自己的
 *  origin，同源 SSE/fetch 才通——见 PluginWindowFrame 的 sandbox 分档），
 *  虽然拿不到宿主 DOM 与宿主桥，但它**能覆盖宿主的视觉面**；允许任意 URL
 *  等于允许插件在兰台窗里嵌一个公网页面冒充界面。白名单是这条路的边界。 */
export function isLoopbackAppUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '') return false;
  return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
}

/** manifest.app 声明（app shell 件 A · S3，应用视图通道）：插件声明自己的
 *  窗内容入口与窗模式——装载只登记窗口定义（注册表数据），开窗才实例化
 *  iframe 视口（宿主窗口注册表 + postMessage 白名单桥，见 state/
 *  plugin-window-store.ts 与 plugins/window-bridge.ts）。窗内渲染完全归
 *  插件（iframe 真隔离，§4-3 拍板）。
 *
 *  **入口二态（2026-09-13，契约 v28）**——两者互斥，必给其一：
 *    · `entry`：插件自包含 HTML（资产通道，`./` 相对插件目录）——iframe 走
 *      opaque origin（不给 allow-same-origin），**宿主桥是它唯一的能力通道**；
 *    · `url`：**环回**远端页（如本机 `http://127.0.0.1:<port>` 的活预览服务）
 *      ——iframe 给 allow-same-origin（跨源文档保住自己 origin，同源
 *      SSE/fetch 才通），**不绑宿主桥**（远端文档不是插件代码），且禁
 *      fullscreen（可覆盖宿主视觉面的形态不放大到全屏）。 */
const APP_WINDOW_MODE = z.enum(['floating', 'dock', 'fullscreen']);

/** 窗首选尺寸的上下界（px）——`manifest.app.size` 的围栏，也是宿主窗口夹持的
 *  同一把尺子（`state/window-metrics.ts` 从这里取值，宿主算式不另抄数字）。
 *  下限 = 书眉 + 可读内容的底（320×240）；上限按桌面屏给（2400×1600），实际
 *  开窗还会夹进当前视口（视口减 24）。 */
export const APP_WINDOW_SIZE_MIN = { w: 320, h: 240 } as const;
export const APP_WINDOW_SIZE_MAX = { w: 2400, h: 1600 } as const;

const AppDeclSchema = z
  .strictObject({
    /** 窗内容入口 A：`./` 前缀相对插件目录的 HTML（资产通道寻址）。 */
    entry: z
      .string()
      .refine(isSafeAppEntry, {
        message: 'app.entry 必须是 "./" 前缀的相对 HTML 路径（如 ./app/index.html），禁止绝对路径/回溯段',
      })
      .optional(),
    /** 窗内容入口 B：环回 http(s) 远端页（本机服务，如 officecli watch 的活预览）。 */
    url: z
      .string()
      .refine(isLoopbackAppUrl, {
        message: 'app.url 必须是环回 http(s) URL（127.0.0.1 / localhost / ::1，禁凭据）——公网页面不得进兰台窗',
      })
      .optional(),
    /** 窗模式：floating（缺省，画布上浮动窗）/ dock（右侧停靠栏）/ fullscreen
     *  （盖满视口）。 */
    mode: APP_WINDOW_MODE.optional(),
    /** 窗标题（书眉显示；缺省用插件名）。 */
    title: z.string().min(1).optional(),
    /** 窗的首选初始尺寸（px，v75）：只在**这个窗第一次开**（用户没拖过）时生效；
     *  用户拖过右下角握把后，宿主记住的是用户的几何（localStorage），声明值让位。
     *  只对 floating 有意义——dock 的宽度属停靠栏、fullscreen 即视口，给它们声明
     *  size 是 manifest 错误（具名拒绝，不静默忽略）。 */
    size: z
      .strictObject({
        w: z
          .number()
          .int({ message: 'app.size.w 必须是整数 px' })
          .min(APP_WINDOW_SIZE_MIN.w, { message: `app.size.w 不能小于 ${APP_WINDOW_SIZE_MIN.w}px` })
          .max(APP_WINDOW_SIZE_MAX.w, { message: `app.size.w 不能超过 ${APP_WINDOW_SIZE_MAX.w}px` }),
        h: z
          .number()
          .int({ message: 'app.size.h 必须是整数 px' })
          .min(APP_WINDOW_SIZE_MIN.h, { message: `app.size.h 不能小于 ${APP_WINDOW_SIZE_MIN.h}px` })
          .max(APP_WINDOW_SIZE_MAX.h, { message: `app.size.h 不能超过 ${APP_WINDOW_SIZE_MAX.h}px` }),
      })
      .optional(),
    /** 文档通道（批 1 只读）：声明 true 才允许窗经桥 `doc.read` 读宿主文档——
     *  令牌由宿主在开窗时签发（`openPluginWindow(name, { document })`），窗只说
     *  「读 token X」，路径解释权只在宿主。不声明 ⇒ 桥里没有 `doc.*`、开窗也不
     *  接受 document 载荷（kill switch：不声明 = 不发生）。 */
    documents: z.boolean().optional(),
  })
  .refine((v) => (v.entry !== undefined) !== (v.url !== undefined), {
    message: 'app 必须且只能声明 entry（资产 HTML）或 url（环回远端页）之一',
  })
  .refine((v) => !(v.url !== undefined && v.mode === 'fullscreen'), {
    message: 'app.url（环回远端视图）不允许 fullscreen——远端文档可覆盖宿主视觉面，全屏形态把界面辨识度也拿走',
  })
  .refine((v) => !(v.size !== undefined && v.mode !== undefined && v.mode !== 'floating'), {
    message: 'app.size 只对 floating 窗生效——dock 的宽度属停靠栏、fullscreen 即视口（别声明一个不会生效的尺寸）',
  });

/** manifest.activation 声明（S6 P3a，2026-09-15）——「登记 ≠ 激活」的**策略面**。
 *
 *  语义：声明本块的插件 = 资源型插件——登记（boot 期）与副作用启动（装配期）
 *  分离：apply 里只 `ctx.activation.declare(名字, spec)` 登记回调，组合装配期
 *  按引用计数激活（首次 start / 归零 stop，见 composition/activation.ts）。
 *  **整块缺席 = kill switch**：完全退回 P3 前语义（登记即激活），不需要 revert 代码
 *  （设计件 §5）。
 *
 *  `lazy`：显式宣告懒激活。缺省 false = 本块只作元数据/资源声明，行为不变。
 *  `resources`：占用的资源类型（闭集，真源 composition/activation.ts）。
 *  `exclusive`：不可共享的资源实例名（`port:9310` / `stdio` / `listener:<名>`）——
 *  同一时刻只允许一个组合持有；冲突在装配期 fail loud（消费面 = P3b 的
 *  冲突检测；与「走 realm 隔离」正交，realm 逃生门见设计件 §7.4）。
 *
 *  与 mcpServers 的关系（2026-11-23 减形）：原先「`lazy: true` 与
 *  `mcpServers[].lifecycle: "eager"` 互斥」的 manifest 级 refine 随 `lifecycle`
 *  退役一并删除——受治进程只剩懒起一档（`governed: true`），「apply 期起进程」
 *  这个口子已不存在，无需互斥规则。 */
const ActivationDeclSchema = z.strictObject({
  lazy: z.boolean().optional(),
  resources: z.array(z.enum(ACTIVATION_RESOURCE_KINDS)).optional(),
  exclusive: z.array(z.string().min(1)).optional(),
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
   *  收口：定义注销 + 开着窗口全关（受治进程走离职清理）。 */
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
   *  fiber disposer。条目声明 `governed: true`（app shell 件 C · S2）= 受治进程：
   *  就绪 = initialize 握手完成（带时限）、崩溃退避重启、空闲回收、未就绪调用
   *  fail-fast（见 mcp-bridge.ts 治理器）。 */
  mcpServers: z.array(McpServerDeclSchema).optional(),
  /** 激活声明（S6 P3a）——见 ActivationDeclSchema 头注；整块缺席 = kill switch。 */
  activation: ActivationDeclSchema.optional(),
  /** 宿主兼容声明（v74）——见 EnginesDeclSchema 头注。 */
  engines: EnginesDeclSchema.optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** manifest.tools 条目（C11-1 声明式工具）。 */
export type ToolManifestDecl = z.infer<typeof ToolManifestDeclSchema>;

/** 权限类（C11-2）——插件可声明的权限域。 */
export type PluginPermissionClass = z.infer<typeof PLUGIN_PERMISSION_CLASS>;

/** manifest.mcpServers 条目（S4-4 乙机器桥）——用户级 mcp.json 条目同构。 */
export type McpServerDecl = z.infer<typeof McpServerDeclSchema>;

/** McpServerDeclSchema 导出（用户级 mcp.json 装载复用——单一真源，不重抄）。 */
export { McpServerDeclSchema };

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

export type ManifestValidation =
  | {
      ok: true;
      manifest: PluginManifest;
      /** 非阻断警告（未知顶层字段…——装载照常，但「写了但没生效」必须可见）。 */
      warnings: string[];
    }
  | { ok: false; error: string };

/** 退役形状的具名拒绝（2026-11-23 减形）：schema 删掉的字段若仍出现在 manifest 里，
 *  `strictObject` 只会回「Unrecognized key」——读者不知道该改成什么。这里在语义
 *  校验之前逐条点名：**退场 = 具名拒绝**，不静默剥掉（剥掉 = 让作者以为声明生效了）。
 *  新退役一个字段 = 本表加一行，`plugin-surface-budget.test` 钉住它不许回到 schema。 */
const RETIRED_MANIFEST_SHAPES: ReadonlyArray<{
  /** 字段路径（错误前缀——作者照它定位）。 */
  at: string;
  /** 命中判据（形状守卫：非数组/非对象条目交给 zod 判，这里不算）。 */
  pick: (manifest: Record<string, unknown>) => boolean;
  /** 迁移指引（一句话说清改成什么）。 */
  reason: string;
}> = [
  {
    at: 'mcpServers[].lifecycle',
    pick: (manifest) => listHasKey(manifest.mcpServers, 'lifecycle'),
    reason: '已退役——改写成 `governed: true`（受治进程只剩「装配/调用/开窗拉起 + 空闲回收」一种语义）',
  },
  {
    at: 'tools[].async',
    pick: (manifest) => listHasKey(manifest.tools, 'async'),
    reason:
      '已退役——工具口异步整条路删了（宿主桥 `deferred` 键同时消失）。长任务改成插件自带 MCP server：' +
      '调用期宿主绑 deferred progressToken，server 完成时发 `lantai/deferred` 通知唤醒发起 Agent',
  },
];

/** 数组条目里是否出现某键（只认对象条目；非数组 / 非对象条目不是本表的活）。 */
function listHasKey(value: unknown, key: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => item !== null && typeof item === 'object' && !Array.isArray(item) && key in item);
}

/** 退役字段具名拒绝（见 RETIRED_MANIFEST_SHAPES）；无命中 = null。 */
function retiredShapeError(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const manifest = raw as Record<string, unknown>;
  for (const shape of RETIRED_MANIFEST_SHAPES) {
    if (shape.pick(manifest)) return shape.at + ': ' + shape.reason;
  }
  return null;
}

/** 顶层允许键（schema 真源派生——手抄清单会漂，派生不会）。 */
const MANIFEST_TOP_KEYS: ReadonlySet<string> = new Set(Object.keys(PluginManifestSchema.shape));

/** 未知顶层字段警告（**不阻断**）：schema 非 strict，未知键会被静默剥掉——
 *  剥掉 = 作者以为声明生效了。这里把它变成可见警告（设置页/CLI 都看得到）。 */
function unknownKeyWarnings(raw: Record<string, unknown>): string[] {
  const unknown = Object.keys(raw).filter((key) => !MANIFEST_TOP_KEYS.has(key));
  if (unknown.length === 0) return [];
  return unknown.map(
    (key) =>
      `未知顶层字段 "${key}" 已被忽略（当前契约 v${OPEN_SURFACE_CONTRACT_VERSION} 不认这个键）` +
      '——检查是否拼错，或本插件要求的宿主比当前更新',
  );
}

/** 宿主版本是否满足 `engines.lantai`（纯函数：版本由调用方给，便于测试与 CLI 复用）。
 *
 *  三态：未声明 / 满足 ⇒ ok；声明且不满足 ⇒ 具名原因；range 本身非法 ⇒ 具名原因
 *  （手误不许静默通过）。`hostVersion` = null 表示宿主版本未知 ⇒ ok（调用方负责 warn）。 */
export function checkEngines(
  manifest: Pick<PluginManifest, 'engines'>,
  hostVersion: string | null,
): { ok: true } | { ok: false; reason: string } {
  const range = manifest.engines?.lantai;
  if (range === undefined) return { ok: true };
  const valid = validRange(range);
  if (valid === null) return { ok: false, reason: `engines.lantai（${range}）不是合法的 semver range` };
  if (hostVersion === null) return { ok: true }; // 版本未知 = 跳过（开发/测试），由调用方 warn
  if (validVersion(hostVersion) === null) return { ok: true }; // 非 semver 的宿主版本同样按未知处理
  if (satisfies(hostVersion, valid)) return { ok: true };
  return { ok: false, reason: `需要兰台 ${range}，当前宿主是 ${hostVersion}` };
}

/** manifest 校验单一入口（loader 与测试共用；错误显式返回，不做静默兜底）。 */
export function validateManifest(raw: unknown): ManifestValidation {
  const retired = retiredShapeError(raw);
  if (retired) return { ok: false, error: retired };
  const result = PluginManifestSchema.safeParse(raw);
  if (result.success) {
    const warnings =
      Array.isArray(raw) || raw === null || typeof raw !== 'object'
        ? []
        : unknownKeyWarnings(raw as Record<string, unknown>);
    return { ok: true, manifest: result.data, warnings };
  }
  const error = result.error.issues
    .map((issue) => (issue.path.join('.') || '(root)') + ': ' + issue.message)
    .join('; ');
  return { ok: false, error };
}

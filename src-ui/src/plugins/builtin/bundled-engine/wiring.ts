// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 随包图谱引擎 · 接线实现（批 10 部件三，2026-09-26）——原内核 `plugins/bundled-engine.ts`
// 的**接线部分**随 `plugins/builtin/bundled-engine/` 包；同文件的**探测面与开关面**留内核
// `plugins/bundled-engine-prefs.ts`（平台只读面 + 平台偏好，设置面板经 faceDeps 取用）。
//
// 现状（2026-09-16 立项 `engine-bundled-mcp-distribution`；2026-09-24 一天连修四个实机缺陷）：
//   - 工具行 id = `plugin/hologram-engine/mcp/hologram`（与插件贡献同寻址域 ⇒ patch/preset 可禁用）；
//   - 引擎契约「一进程一工作区根」（ensure_ready 异根拒绝）：root 进 `args --project-root`；
//   - `lifecycle: 'lazy'` + `restart: 'on-crash'`（启动路径零阻塞、崩了指数退避自愈）；
//   - **判据 = 工具面真的在册**（wired ⟺ toolCount > 0），不是「行注册成功」。
//
// 与内核的取用面：经包内宿主桥 `./host`（dev/测试域 = 内核真身；产物域 = faceDeps 真实例）
// ——`registerMcpServerTools` / `waitWithin` / `ASSEMBLY_READY_WAIT_MS` / `createTauriProcIO`
// 与探测、开关两件（后者住 `bundled-engine-prefs.ts`）。**不得直连内核模块路径**：产物域
// esbuild 会把内核模块整件内联成副本（§0.6 实机事故纪律）。

import type { Context } from '../../../cordis';
import type { McpServerDecl } from '../../types';
import {
  ASSEMBLY_READY_WAIT_MS,
  createTauriProcIO,
  type GovernedActivationFace,
  isBundledEngineEnabled,
  type McpBridgeIO,
  probeBundledEngine,
  registerMcpServerTools,
  waitWithin,
} from './host';

/** MCP server 名（工具名前缀 `mcp__<name>__*` + 行 id 尾段）。 */
const SERVER_NAME = 'hologram';

/** 工具贡献归属名（行 id 首段：`plugin/<此名>/mcp/<server>`）。 */
export const OWNER = 'hologram-engine';

/** 工作区根 → MCP server 声明（引擎契约：一进程一根，root 进 args）。
 *
 *  `lifecycle: 'lazy'`——首次装配/调用才拉起进程，**启动路径零阻塞**
 *  （引擎首次全量分析可达分钟级，不能挡开工作区）。
 *  `restart: 'on-crash'`——引擎崩了指数退避自愈（治理器自带）。
 *  `readOnly` 不声明——按远端 `annotations.readOnlyHint` 判（引擎 36 工具中
 *  `analyze_project`/`rename_symbol` 是写，缺省 fail-closed 更安全）。 */
export function bundledEngineDecl(root: string, exePath: string): McpServerDecl {
  return {
    name: SERVER_NAME,
    transport: 'stdio',
    command: exePath,
    args: ['serve', '--project-root', root],
    restart: 'on-crash',
    lifecycle: 'lazy',
  };
}

/** 随包引擎接线结果（调用方/诊断消费）。 */
export interface BundledEngineWiring {
  /** 是否真的接上了（未启用 / 引擎缺席 / 无工作区根 → false）。
   *
   *  **判据 = 工具面真的在册**（不只是「行注册成功」）：2026-09-24 用户实机报
   *  「接线显示正常 + 进程起了，Agent 手里却没工具」——旧口径把「行注册」当成功，
   *  而装配面读的是**就绪后**的工具面快照，两者中间的窗口正好是用户看到的那一幕。
   *  现在 wired=true ⟹ toolCount > 0（本工作区的 Agent 立刻能用上这些工具）。 */
  wired: boolean;
  /** 未接上的原因（enabled=false 时不填——那是用户意图不是异常）。 */
  reason?: string;
  /** 在册的引擎工具数（wired=true 时 > 0；未接线时不填）。 */
  toolCount?: number;
}

/** 装配前等待引擎就绪的预算（ms）——**共享常量**：受治进程的装配期就绪等待
 *  由 `mcp-bridge` 统一定义（随包引擎与任何声明 restart/lifecycle 的第三方
 *  server 同一语义、同一上限）。此处只做别名，防两处数字各自漂移。 */
const PREHEAT_BUDGET_MS = ASSEMBLY_READY_WAIT_MS;

/** 引擎空闲回收预算（ms）——覆写受治面缺省的 5 分钟。
 *
 *  为什么引擎要**更长**：受治面的空闲计时只认「MCP 调用在途」（mcp-bridge 的
 *  inFlight 计数），而引擎的长尾工作跑在**调用之后**——向量索引重建是流水线
 *  里的后台线程（`engine/src/engine/pipeline.rs` 的 `std::thread::spawn`），
 *  最后一次调用返回时它才刚起步。
 *
 *  实测（2026-09-25）：嵌入吞吐 ≈26.5 节点/秒 ⇒ 21798 节点全量重建 ≈13.7 分钟，
 *  而缺省预算 5 分钟——实测 `18:56:55` 起跑、`19:01:28` 到 7168/21798 被回收
 *  （进程静默消失），落盘索引永久滞后于图（21760 vs 22244）= 语义搜索一直在
 *  旧快照上跑。且嵌入缓存是**进程内**的（`hologram-vector` 的 VECTOR_CACHE）
 *  ——被杀 = 缓存清零，下次从零重来（实测命中率仅 2%）。
 *
 *  30 分钟 = 上述全量重建 ×2 余量；**仍有上界**（不是永不回收）——预算用完仍会
 *  回收内存，只是不再把一次正常重建砍在半路。 */
export const ENGINE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** 注册随包引擎工具（**须在 Agent 装配前调用**——工具行先于装配进注册表）。
 *
 *  @param ctx   工作区 fiber ctx（工具行挂它 ⇒ 随 fiber dispose 自动摘）
 *  @param root  工作区根（引擎绑此根）
 *  @param io    测试注入面（缺省生产实现）
 *
 *  返回 wired=false 的情形都**不是错误**：未启用（用户意图）、引擎缺席
 *  （未随包/未构建）、root 为空（无目录工作区）、就绪超预算（可见降级，
 *  带具名原因——调用方写回执 + 状态栏）。
 */
export async function registerBundledEngineTools(
  ctx: Context,
  root: string,
  io?: McpBridgeIO,
): Promise<BundledEngineWiring> {
  if (!isBundledEngineEnabled()) {
    return { wired: false };
  }
  if (!root) {
    return { wired: false, reason: '工作区根为空' };
  }
  const info = await probeBundledEngine();
  if (!info.available || !info.path) {
    return { wired: false, reason: '未找到随包引擎二进制' };
  }
  const exePath = info.path;
  // 注入 IO：pluginDir 锚点 = 引擎安装目录（绕开 plugin_dir RPC 对非插件名报错）
  const dir = info.dir ?? exePath.replace(/[\\/][^\\/]+$/, '');
  const engineIo: McpBridgeIO = io ?? {
    createProcIO: async (bridgeId, command, args, env) => createTauriProcIO(bridgeId, command, args, env),
    pluginDir: async () => dir,
  };
  // 挂载点（2026-09-24）：**自带 inject 的子 fiber**——不能把调用方 ctx 直接交给
  // registerMcpServerTools。它内部要属性访问 `ctx.tools`，而工作区 scope 插件
  // 不能声明 inject（声明即撞 cordis realm：`new LspService(fiber.ctx)` 报
  // 「service "lsp" has been registered」——见 workspace.ts 的 ⚠ 注释），
  // 于是抛 `cannot get property "tools" without inject`（实机症状
  // 「随包引擎接线失败：… without inject」）。
  // 子 fiber 自持 inject ⇒ 服务可见性归它；**归属与回收仍挂调用方 ctx**：
  // 下面把子 fiber 的 dispose 登记进调用方 ctx.effect ⇒ 离开/切换工作区时
  // fiber.dispose 链式摘行 + 治理器杀进程树（与「工具行直挂工作区 ctx」等价，
  // 不依赖 cordis 的父 dispose 级联语义）。
  // 持有体而非裸 `let`：apply 里赋值、外面读——TS 会把裸 let 的控制流收窄成 never。
  const holder: { face: GovernedActivationFace | null } = { face: null };
  try {
    const fiber = await ctx.plugin({
      name: 'hologram/bundled-engine-mcp',
      // activation：受治面 lazy 档的拉起/停止交给激活账（与 loader 给声明
      // manifest.mcpServers 的插件补的那两条同款）。
      inject: ['tools', 'activation'],
      apply: async (c: Context) => {
        const registered = await registerMcpServerTools(c, OWNER, [bundledEngineDecl(root, exePath)], engineIo, {
          // 引擎的空闲预算比受治面缺省长（长尾后台重建——见 ENGINE_IDLE_TIMEOUT_MS）。
          timing: { idleTimeoutMs: ENGINE_IDLE_TIMEOUT_MS },
        });
        if (!registered) return;
        holder.face = registered;
        // 声明激活（**登记 ≠ 激活**）——loader 对 manifest 插件做的那一步，
        // 引擎路径此前整个丢掉了 ⇒ 治理器永不被拉起：实机症状「UI 显示已接线、
        // 任务管理器无 hologram-engine.exe、Agent 无图谱工具」（2026-09-24）。
        // 账键 = 插件名（激活是插件级生命周期），而本接线贡献的行 id 前缀正是
        // `plugin/hologram-engine/…`（= OWNER）⇒ 组合里该行存活即 retain。
        // ⚠ 取服务必须用子 fiber 的 `c`（它 inject 了 activation）——调用方 ctx
        // 没声明 inject，属性访问与 resolve 都会被 cordis 拒（见 mcp-bridge 头注）。
        const activation = c.get('activation');
        if (activation && !activation.has(OWNER)) {
          activation.declare(OWNER, {
            resources: ['stdio'],
            start: () => registered.startLazy(),
            stop: () => registered.stopLazy(),
          });
        }
      },
    });
    ctx.effect(
      () => () => {
        void fiber.dispose();
      },
      'hologram/bundled-engine-mcp',
    );
  } catch (e) {
    // 接线失败可见（不静默）：调用方写回执 / 状态栏
    return { wired: false, reason: `接线失败：${e instanceof Error ? e.message : String(e)}` };
  }
  // inject 未解析（组合层 service 不在调用方所在 cordis 树）时子 fiber 停在 PENDING：
  // ctx.plugin 不抛、行也没注册——不当成「已接线」上报（错误不静默）。
  const governed = holder.face;
  if (!governed) {
    return { wired: false, reason: '接线未生效：引擎工具行未注册（组合层 tools/activation 服务不可见）' };
  }
  // **有界等待就绪**（2026-09-24 缺陷②）：工具面在装配时点冻结，而本函数返回后
  // 调用方立刻建注册表 ⇒ 必须在这里把 initialize + tools/list 走完。旧实现是
  // fire-and-forget 预热（「不阻塞开工作区」），赌「首个会话装配在进程起来之后」
  // —— 实测必输（装配只花微秒级，进程经 Rust 桥起要数百毫秒），且输了就
  // **永久**没有工具（共享注册表路径没有下次装配）。故：等待有界（见
  // PREHEAT_BUDGET_MS 的实测依据），超时/失败即降级为具名原因上报。
  try {
    const ready = await waitWithin(governed.startLazy(), PREHEAT_BUDGET_MS);
    if (!ready) {
      return {
        wired: false,
        reason: `引擎就绪超时（${PREHEAT_BUDGET_MS / 1000}s）——本次装配无引擎工具，重开工作区重试`,
      };
    }
  } catch (e) {
    // 拉起失败不是静默降级：原因进回执（治理器另有诊断面；重试挂下次装配）
    return { wired: false, reason: `引擎拉起失败：${e instanceof Error ? e.message : String(e)}` };
  }
  const toolCount = governed.toolCount();
  if (toolCount === 0) {
    // 就绪但工具面为空（引擎 tools/list 返回空表）——如实上报，不冒充「已接线」
    return { wired: false, reason: '引擎已就绪但未提供任何工具（tools/list 为空）' };
  }
  return { wired: true, toolCount };
}

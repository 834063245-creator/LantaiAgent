// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 随包图谱引擎接线（engine-bundled-mcp-distribution，2026-09-16）。
//
// 背景（缺口的另一半）：引擎一直随兰台安装包分发（`tauri.conf.json`
// `bundle.resources` 含 exe + grammars/onnxruntime/models，实测 196MB），但
// 09-09 图谱全量退役（`51047f99`）删掉了 `engine_transport.rs`——里面装着
// 「自动定位 + 每工作区 spawn」的配套胶水，而**同一批没人回头动打包清单**
// （`git show 51047f99 -- tauri.conf.json` 为空）。结果：分发包留着、接线删了，
// 兰台零行代码知道引擎在哪。
//
// 本模块补回「接线」那一半——**不复活 engine_transport**，改走既有 MCP 受治
// 进程通道（复用 `registerMcpServerTools` 的全部治理：生命周期三档 / 崩溃
// 指数退避重启 / 空闲回收 / 进程树终止）。结构镜像 `user-mcp.ts`（同为
// 「非插件目录的 stdio server 声明」先例）。
//
// 形态契约（引擎侧 `ensure_ready` 定的，不可绕过）：**一进程一工作区根**——
// 同根幂等、异根拒绝（「a different project root requires a separate engine
// process」）。故注册粒度 = 工作区：打开 W1 起进程绑 W1，离开随 fiber 释放，
// 打开 W2 按 W2 重注册（= `engine_init` 注释说的「工作区切换 = 换整个实例」）。
//
// 关键坑（已定位）：`openStdio` 无条件调 `io.pluginDir(pluginName)`，而
// `plugin_dir` RPC 对**非已安装插件名报错**（引擎不是插件）。故注入自定义
// `McpBridgeIO` 覆盖 `pluginDir` → 返回安装目录（顺带让 args 的 `./` 相对
// 形态有正确锚点）。同 `user-mcp.ts` 覆写 pluginDir 的做法。
//
// 开关语义（方案乙，2026-09-16 用户拍板）：**默认关**。随包分发到位（探测 +
// 设置面板可见 + 一键启用），但默认不改 Agent 工具面——尊重 09-09 图谱工具面
// 退役决策。启用态存 localStorage（镜像 `state/plugin-prefs.ts`）。
//
// 工具行 id = `plugin/hologram-engine/mcp/hologram`（与插件贡献同寻址域 ⇒
// patch/preset 可禁用，免费 kill switch）。

import { log } from '../agent/logger';
import type { Context } from '../cordis';
import { typedJsonRpc } from '../rpc-contract';
import { type McpBridgeIO, registerMcpServerTools } from './mcp-bridge';
import type { McpServerDecl } from './types';

/** 随包引擎探测结果（`engine_bundled_info` RPC 的形状）。 */
export interface BundledEngineInfo {
  /** 引擎 exe 绝对路径；null = 未找到（降级，非错误）。 */
  path: string | null;
  /** 安装目录（stdio command/args 相对解析锚点）；null = 同上。 */
  dir: string | null;
  /** 二进制是否就位。 */
  available: boolean;
}

/** 探测缓存（模块级可变态归属 CONVENTIONS §1.10 第 3 类：键控自清理——
 *  单键、生命周期 = 进程；安装目录在运行期不变，缓存安全）。
 *  测试经 `resetBundledEngineForTests` 复位。 */
let cachedInfo: BundledEngineInfo | null = null;

/** 探测随包引擎（惰性 + 缓存）。RPC 失败 → 返回不可用（非抛错——随包引擎
 *  缺席不该炸任何启动路径，错误经 available=false 可见）。 */
export async function probeBundledEngine(): Promise<BundledEngineInfo> {
  if (cachedInfo) return cachedInfo;
  try {
    // typedJsonRpc（2026-09-24 换轨）：本命令是 `// JSON` 形态，双形态兼容
    // （Rust 出口已展开为 Value / 表外仍为 JSON 字符串——**两者都要吃**），
    // 且违形即 throw 而非静默读成 false。旧实现用 typedRpc（直通、不 parse）
    // ⇒ 出口按 Text 直通字符串时 `raw?.available` 恒 undefined ⇒ 设置页开关
    // 置灰「拨不开」（实机缺陷；回归 tests/bundled-engine-probe-shape.test.ts）。
    const raw = await typedJsonRpc('engine_bundled_info');
    const info: BundledEngineInfo = {
      path: typeof raw?.path === 'string' ? raw.path : null,
      dir: typeof raw?.dir === 'string' ? raw.dir : null,
      available: raw?.available === true,
    };
    cachedInfo = info;
    return info;
  } catch (e) {
    // 探测失败 = 引擎不可用（不缓存失败结果——代理未起等瞬态可重试）。
    // 但**不静默**：此前 catch 无输出，UI 只会说「未检测到引擎二进制」，
    // 把「RPC/形状故障」误报成「二进制缺席」——留一行 warn 进 ui.log 可查。
    log.warn('plugins', `[bundled-engine] 探测失败（按不可用降级）: ${e instanceof Error ? e.message : String(e)}`);
    return { path: null, dir: null, available: false };
  }
}

/** 测试/诊断复位（生产不消费）。 */
export function resetBundledEngineForTests(): void {
  cachedInfo = null;
}

/** MCP server 名（工具名前缀 `mcp__<name>__*` + 行 id 尾段）。 */
const SERVER_NAME = 'hologram';

/** 工具贡献归属名（行 id 首段：`plugin/<此名>/mcp/<server>`）。 */
const OWNER = 'hologram-engine';

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
  /** 是否真的接上了（未启用 / 引擎缺席 / 无工作区根 → false）。 */
  wired: boolean;
  /** 未接上的原因（enabled=false 时不填——那是用户意图不是异常）。 */
  reason?: string;
}

/** 注册随包引擎工具（**须在 Agent 装配前调用**——工具行先于装配进注册表）。
 *
 *  @param ctx   工作区 fiber ctx（工具行挂它 ⇒ 随 fiber dispose 自动摘）
 *  @param root  工作区根（引擎绑此根）
 *  @param io    测试注入面（缺省生产实现）
 *
 *  返回 wired=false 的三种情形都**不是错误**：未启用（用户意图）、引擎缺席
 *  （未随包/未构建）、root 为空（无目录工作区）。
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
    createProcIO: async (bridgeId, command, args, env) => {
      const { createTauriProcIO } = await import('../agent/mcp/tauri-io');
      return createTauriProcIO(bridgeId, command, args, env);
    },
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
  try {
    const fiber = await ctx.plugin({
      name: 'hologram/bundled-engine-mcp',
      // activation：受治面 lazy 档的拉起/停止交给激活账（与 loader 给声明
      // manifest.mcpServers 的插件补的那两条同款）。
      inject: ['tools', 'activation'],
      apply: async (c: Context) => {
        const face = await registerMcpServerTools(c, OWNER, [bundledEngineDecl(root, exePath)], engineIo);
        if (!face) return;
        // ① 声明激活（**登记 ≠ 激活**）——loader 对 manifest 插件做的那一步，
        //    引擎路径此前整个丢掉了 ⇒ 治理器永不被拉起：实机症状「UI 显示已接线、
        //    任务管理器无 hologram-engine.exe、Agent 无图谱工具」（2026-09-24）。
        //    账键 = 插件名（激活是插件级生命周期），而本接线贡献的行 id 前缀正是
        //    `plugin/hologram-engine/…`（= OWNER）⇒ 组合里该行存活即 retain。
        const activation = c.get('activation');
        if (activation && !activation.has(OWNER)) {
          activation.declare(OWNER, {
            resources: ['stdio'],
            start: () => face.startLazy(),
            stop: () => face.stopLazy(),
          });
        }
        // ② 开工作区即预热（fire-and-forget）——**不阻塞开工作区**（不 await），
        //    但必须在首个 Agent 装配之前把进程与 tools/list 备好：装配面物化工具行
        //    先于激活账 retain（runtime.ts 的注册表构建 → retainForComposition 次序），
        //    行工厂又按 `toolFace()` 快照产出 —— 只靠 retain 的话**首个会话**拿不到
        //    工具（工具面在会话创建时点冻结，要等下一个新卷）。引擎的 tools/list 走
        //    静态表（快），慢的是分析，故预热窗口足够。
        //    失败不静默：warn 进 ui.log，治理器另有诊断面（重试挂在下次装配）。
        void face.startLazy().catch((e) => {
          log.warn(
            'plugins',
            `[bundled-engine] 预热拉起失败（工具面待下次装配重试）: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      },
    });
    ctx.effect(
      () => () => {
        void fiber.dispose();
      },
      'hologram/bundled-engine-mcp',
    );
    return { wired: true };
  } catch (e) {
    // 接线失败可见（不静默）：调用方写回执 / 状态栏
    return { wired: false, reason: `接线失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ═══════════════════════════════════════════════════════
// 启用开关（方案乙：默认关，localStorage 持久化）
// ═══════════════════════════════════════════════════════

/** localStorage 键（与 `state/plugin-prefs.ts` 同族约定：`lantai.` 前缀）。 */
const PREF_KEY = 'lantai.bundledEngine.enabled';

/** 开关变更订阅者（设置面板即时反馈 + 启动重载提示）。 */
const listeners = new Set<() => void>();

/** 随包引擎是否启用（**默认 false**——方案乙；不改写则零行为变更）。 */
export function isBundledEngineEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'true';
  } catch {
    // 无 localStorage（SSR/测试环境）→ 缺省关（安全向）
    return false;
  }
}

/** 设置启用态（写 localStorage + 通知订阅者）。生效时机：**下次启动 / 下次
 *  打开工作区**（工具行注册在 boot 后的工作区激活点，不热改已装配的 Agent）。
 */
export function setBundledEngineEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, enabled ? 'true' : 'false');
  } catch {
    // 写失败不炸（隐私模式等）——内存态仍生效于本会话
  }
  for (const l of listeners) l();
}

/** 订阅开关变更（返回退订器）。 */
export function onBundledEnginePrefChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

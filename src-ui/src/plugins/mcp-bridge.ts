// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// MCP 机器桥（S4-4 乙，设计件 S4-preset-realm-distribution.md §2.7）——
// manifest.mcpServers 声明式挂接外部 MCP server；app shell 件 C（S2）升级为
// 受治进程生命周期治理（app-shell-software-plugin-plan §5-S2，决策 1/4/7/8）。
//
// 关键裁定（设计件原文）：MCP 工具是**工具行贡献**（composition 的 tools
// 域），不是旁路注册——装载期把每个 mcpServer 折算成一条工具贡献（行 id
// `plugin/<插件名>/mcp/<server名>`，factory = 远端工具整组产出）。preset/patch
// 可以禁用某插件的某个 MCP server（S4-4 甲起贡献行全量可寻址——组合均匀性
// 不破）。
//
// 治理分岔（S2）：manifest 条目声明治理字段（restart / lifecycle 任一在场）=
// 受治面——ServerGovernor 接管：
//   - 就绪 = initialize 握手 + tools/list 完成，带就绪时限（缺省 60s）——
//     到点未握上 = 启动失败报错（免 stdout 探测，决策 8）；
//   - 崩溃重启（restart: on-crash）：意外退出 → 指数退避自动重启，就绪即清零；
//   - 三档生命周期（lifecycle，决策 1/4）：lazy（缺省——首次装配/调用/开窗
//     拉起，无窗且空闲超时回收，再调用再拉起）/ eager（装载即拉起，卸载才停，
//     装配/调用发现未就绪时兜底拉起）/ with-window（随窗开合——开窗拉起、
//     关窗即杀；S2 经 notifyPluginWindow* 合成事件接线，S3 窗口原语接真实
//     开合）；
//   - 未就绪调用（决策 7 fail-fast）：立即抛结构化错 service_not_ready（带
//     starting / not-running 状态）+ 触发拉起——宿主永不阻塞等待受治进程
//     就绪，「等待」由调用方（模型）按需重试承担；
//   - 进程回收：插件 fiber disposer（卸载/停用链式停），Rust 侧
//     protocol_bridge_kill 连进程树终止（含孙进程）。
// 旧形态（治理字段皆缺席）：failurePolicy 语义原样（startup-error 装载期急
// 连接 / lazy 首装配连接 + 空集 warn 重试），client 实例闭包缓存——现行为逐
// 字节不变（兼容钉死；mcp-bridge.test.ts 既有套件即兼容面守护）。
//
// 数据目录衔接（S1 × S2）：spawn 追加注入 env `LANTAI_PLUGIN_DATA_DIR`=
// 插件数据目录绝对路径（loader 从 plugin_data_ensure 捕获传入；未声明 dataDir
// 的插件不注入）。定形 env 而非 initialize 参数：env 对任意语言后端可用且
// 握手前即可读（HTTP 面等非 MCP 消费同源），MCP initialize 参数是协议面——
// 不掺宿主私货。
//
// 边界（ADR §5 维持）：这是「插件挂外部机器」，不是「进程内宿主插件」——
// 后者永久关闭，本批不开口子。砍除项（决策 8）：不做「服务地址注入」、
// 不做「工具执行体 fetch 自己进程」的代理层——需要进程的软件，其后端就是
// MCP server；纯 GUI 软件的后端 = 零工具 MCP server。
//
// 可注入面（McpBridgeIO）：ProcIO 构造与插件目录解析都是宿主能力（Rust
// protocol_bridge / plugin_dir RPC）——测试注入 fake（loopback JSON-RPC
// 行协议），生产走默认实现。

import {
  McpClient,
  type McpToolSchema,
  mcpClientTool,
  type ProcIO,
  publicToolName,
  resolveMcpToolReadOnly,
} from '../agent/mcp';
import { createTauriProcIO } from '../agent/mcp/tauri-io';
import type { Tool } from '../agent/tool';
import type { Context } from '../cordis';
import { typedRpc } from '../rpc-contract';
import { bindMcpDeferredToken, completeMcpDeferred, type PluginDeferredStatus } from './deferred';
import type { McpServerDecl } from './types';

/** S4（app shell 件 D）——server 完成通知 method：调用期发出的 deferred
 *  progressToken 在 params.progressToken 回带，taskId/status 是 server 自订
 *  任务键。MCP 通知面标准语义（server 主动发、无 id、client dispatch 到
 *  onNotification 面）。 */
const MCP_DEFERRED_NOTIFICATION = 'lantai/deferred';

/** 宿主 IO 能力（生产 = Rust 桥；测试注入 fake）。 */
export interface McpBridgeIO {
  /** 起一个 stdio 子进程桥（bridgeId 唯一寻址，kill 归 ProcIO）。env =
   *  追加注入的子进程环境（app shell S2——数据目录寻址面；缺省不注入）。 */
  createProcIO(bridgeId: string, command: string, args: string[], env?: Record<string, string>): Promise<ProcIO>;
  /** 插件目录绝对路径（stdio command 相对解析的锚点）。 */
  pluginDir(pluginName: string): Promise<string>;
}

/** 生产 IO：Rust protocol_bridge spawn + plugin_dir RPC。 */
export const tauriMcpBridgeIO: McpBridgeIO = {
  createProcIO: (bridgeId, command, args, env) => createTauriProcIO(bridgeId, command, args, env),
  pluginDir: (name) => typedRpc('plugin_dir', { name }),
};

/** 受治进程数据目录 env 键（spawn 注入；server 进程读自身 env 取地盘路径）。 */
export const PLUGIN_DATA_DIR_ENV = 'LANTAI_PLUGIN_DATA_DIR';

// ── 治理时序（生产缺省；测试注入小值——缺省 60s/5min 在单测不可等待）──

/** 治理时序参数（app shell S2）。 */
export interface McpGovernorTiming {
  /** 就绪时限（ms）：initialize 握手 + tools/list 未在此窗口完成 = 启动失败
   *  报错（决策 7「到点没就绪 → 报错」）。缺省 60s。 */
  startupDeadlineMs?: number;
  /** lazy 空闲回收（ms）：无窗且超此时长无调用即停（决策 4）。缺省 5 分钟。 */
  idleTimeoutMs?: number;
  /** 崩溃重启退避基值（ms）：指数 ×2 封顶 30s，就绪即清零。缺省 1s。 */
  restartBackoffMs?: number;
}

const DEFAULT_STARTUP_DEADLINE_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const RESTART_BACKOFF_CAP_MS = 30_000;

function resolveTiming(opts: RegisterMcpServerOptions | undefined): Required<McpGovernorTiming> {
  const t = opts?.timing ?? {};
  return {
    startupDeadlineMs: t.startupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS,
    idleTimeoutMs: t.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    restartBackoffMs: t.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS,
  };
}

/** registerMcpServerTools 的治理接线参数。 */
export interface RegisterMcpServerOptions {
  /** 插件数据目录绝对路径（S1 plugin_data_ensure 返回——loader wrapper 捕获
   *  传入）。在场 = 全部 spawn 追加注入 `LANTAI_PLUGIN_DATA_DIR`；缺省不注入
   *  （manifest 未声明 dataDir 的插件无地盘）。 */
  dataDirPath?: string;
  /** 治理时序注入（测试面——生产用缺省值）。 */
  timing?: McpGovernorTiming;
}

/** stdio command 解析：含路径分隔符的相对形态 → 相对插件目录（归一 `./`
 *  前缀与分隔符）；裸名（无分隔符）/绝对路径原样（PATH / 绝对定位）。 */
function resolveCommand(command: string, pluginDir: string): string {
  const looksRelative = !/^[a-zA-Z]:[\\/]/.test(command) && /[\\/]/.test(command);
  if (!looksRelative) return command;
  return resolvePluginRel(command, pluginDir);
}

/** `./`/`../` 前缀的 arg → 相对插件目录解析（平台化 P4 · D1 端到端例子：
 *  让示例插件能以 `args: ["./server.cjs"]` 便携声明脚本参数——裸名 arg
 *  （如 `-v`、`--flag`、`file.json`）不受影响，向后兼容）。 */
function resolvePluginRel(p: string, pluginDir: string): string {
  const base = pluginDir.replace(/[\\/]$/, '');
  const tail = p
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .filter((seg) => seg !== '.')
    .join('/');
  return base + '/' + tail;
}

/** stdio 开线：spawn（相对插件目录解析 + env 注入）+ client 构造（不 connect
 *  ——connect 由调用方掌时限/复用）。legacy 与受治共用；bridgeId 由调用方
 *  给（受治进程带代次后缀——重启换代不覆盖 Rust PROCS 注册表行）。 */
async function openStdio(
  server: McpServerDecl,
  pluginName: string,
  io: McpBridgeIO,
  env: Record<string, string> | undefined,
  bridgeId: string,
): Promise<{ client: McpClient; proc: ProcIO }> {
  const pluginDir = await io.pluginDir(pluginName);
  const args = (server.args ?? []).map((a) => (/^\.{1,2}[\\/]/.test(a) ? resolvePluginRel(a, pluginDir) : a));
  const proc = await io.createProcIO(bridgeId, resolveCommand(server.command ?? '', pluginDir), args, env);
  const client = new McpClient({
    serverName: server.name,
    failurePolicy: server.failurePolicy ?? 'lazy',
    procIO: proc,
  });
  return { client, proc };
}

/** 组装一个 server 的 McpClient 配置并完成连接（stdio 经注入 IO；http 直连）。
 *  旧形态专用（受治面走 ServerGovernor）。 */
async function connectServer(
  server: McpServerDecl,
  pluginName: string,
  io: McpBridgeIO,
  env?: Record<string, string>,
): Promise<McpClient> {
  if (server.transport === 'http') {
    const client = new McpClient({
      serverName: server.name,
      failurePolicy: server.failurePolicy ?? 'lazy',
      url: server.url,
      headers: server.headers,
    });
    await client.connect();
    return client;
  }
  const { client } = await openStdio(server, pluginName, io, env, `mcp-bridge/${pluginName}/${server.name}`);
  await client.connect();
  return client;
}

/** S4（app shell 件 D · MCP 路翻译）：client 挂 lantai/deferred 完成通知
 *  监听——progressToken → 发起者 → 同一唤醒。返回退订（client 生命周期
 *  归属方持有）。 */
function attachDeferredNotifications(client: McpClient): () => void {
  return client.onNotification((msg) => {
    if (msg.method !== MCP_DEFERRED_NOTIFICATION) return;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const rawToken = params.progressToken;
    const token = typeof rawToken === 'string' ? rawToken : typeof rawToken === 'number' ? String(rawToken) : undefined;
    if (!token) return;
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const status: PluginDeferredStatus = params.status === 'failed' ? 'failed' : 'completed';
    const message = typeof params.message === 'string' ? params.message : undefined;
    completeMcpDeferred(token, { taskId, status, message });
  });
}

// ── 受治进程治理器（app shell 件 C · S2 本体）──

type GovernorState = 'not-running' | 'starting' | 'ready';

/** 插件名 → 治理器集合（受治进程注册表——窗口事件寻址面）。 */
const governedByPlugin = new Map<string, Set<ServerGovernor>>();
/** 插件名 → 开窗计数（>0 = 有窗开着——with-window 生命周期锚点、lazy 空闲
 *  回收闸；S3 窗口注册表在真实开合处调 notifyPluginWindow*）。 */
const windowOpenCounts = new Map<string, number>();

function addGovernor(governor: ServerGovernor): void {
  let set = governedByPlugin.get(governor.pluginName);
  if (!set) {
    set = new Set();
    governedByPlugin.set(governor.pluginName, set);
  }
  set.add(governor);
}

function removeGovernor(governor: ServerGovernor): void {
  const set = governedByPlugin.get(governor.pluginName);
  if (!set) return;
  set.delete(governor);
  if (set.size === 0 && windowOpenCounts.get(governor.pluginName) === undefined) {
    governedByPlugin.delete(governor.pluginName);
  }
}

function windowOpenCount(pluginName: string): number {
  return windowOpenCounts.get(pluginName) ?? 0;
}

/** 插件窗口开（S2 合成事件面；S3 窗口原语在真实开窗处调用）。
 *  语义（决策 1/4）：lazy / with-window 首开窗拉起；窗开期间 lazy 不空闲回收；
 *  多窗计数——全关才触发 with-window 回收。 */
export function notifyPluginWindowOpened(pluginName: string): void {
  windowOpenCounts.set(pluginName, (windowOpenCounts.get(pluginName) ?? 0) + 1);
  for (const g of governedByPlugin.get(pluginName) ?? []) g.onWindowOpened();
}

/** 插件窗口关（S2 合成事件面；S3 接真实关窗）。
 *  with-window：计数归零即回收（默认杀，决策 4——keep-alive 是 S3 窗口面
 *  的显式声明扩展位）；lazy：重新起算空闲回收。 */
export function notifyPluginWindowClosed(pluginName: string): void {
  const next = (windowOpenCounts.get(pluginName) ?? 1) - 1;
  if (next <= 0) windowOpenCounts.delete(pluginName);
  else windowOpenCounts.set(pluginName, next);
  for (const g of governedByPlugin.get(pluginName) ?? []) g.onWindowClosed();
}

/** 受治进程的**激活面**（S6 P3d）——把「装配期拉起 / 引用归零停止」交给激活账
 *  （`ctx.activation`），只对 manifest 声明了 `activation` 的插件接线。
 *
 *  **只覆盖 lazy 档**（含缺省）：它的拉起语义本就是「装配/调用/开窗拉起 + 空闲
 *  回收」，把它接到组合引用计数上只是换了个释放触发源。另两档**不经手**（如实
 *  声明，WO-S6P3 §2.7）：
 *    - `eager`：装载即拉起、卸载才停（生命周期 = 插件装载期，不是组合）；
 *    - `with-window`：开窗拉起、关窗即杀（生命周期 = 窗口，组合无权替它决定）。
 *  ⇒ 接线的净效果 = 「所有持有它的卷都关了 ⇒ 进程停」（不再等空闲回收）。 */
export interface GovernedActivationFace {
  /** 拉起全部 lazy 档受治进程到就绪（幂等：已在就绪/在途 ⇒ 复用）。失败抛出
   *  （由激活账记 failure——诊断第四栏「被跳过」可见，装配本身不因此失败）。 */
  startLazy(): Promise<void>;
  /** 停止全部 lazy 档受治进程（组合引用归零）。 */
  stopLazy(): void;
}

/** 由受治进程集合产出激活面（无 lazy 档 ⇒ null = 不接线）。 */
function governedActivationFace(governors: readonly ServerGovernor[]): GovernedActivationFace | null {
  const lazy = governors.filter((g) => g.lifecycle === 'lazy');
  if (lazy.length === 0) return null;
  return {
    startLazy: async () => {
      for (const g of lazy) await g.start();
    },
    stopLazy: () => {
      for (const g of lazy) g.stop();
    },
  };
}

/** 单个受治 server 的生命周期治理器（每个声明治理字段的 mcpServers 条目一个，
 *  生命周期 = 插件 fiber——dispose 链式杀进程）。 */
class ServerGovernor {
  private state: GovernorState = 'not-running';
  /** tools/list 快照（就绪期刷新；停机不清——快照面让调用期 fail-fast 有
   *  工具可报错，重启后刷新）。 */
  private schemas: McpToolSchema[] = [];
  private client: McpClient | null = null;
  private proc: ProcIO | null = null;
  private unsubExit: (() => void) | null = null;
  /** S4：lantai/deferred 完成通知监听退订（随 client 生命周期）。 */
  private unsubNotify: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  /** 启动途中的立即判负口（启动途中进程退出/被停止——不等就绪时限）。 */
  private failStart: ((err: Error) => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  /** bridgeId 代次（受治进程重启换代——Rust PROCS 行不覆盖，旧代 exit/stdout
   *  事件不会误伤新代）。 */
  private spawnGen = 0;
  private crashAttempts = 0;
  private disposed = false;
  private stopping = false;

  constructor(
    readonly pluginName: string,
    readonly server: McpServerDecl,
    private readonly io: McpBridgeIO,
    private readonly env: Record<string, string> | undefined,
    private readonly timing: Required<McpGovernorTiming>,
  ) {}

  get status(): GovernorState {
    return this.state;
  }

  get lifecycle(): 'lazy' | 'eager' | 'with-window' {
    return this.server.lifecycle ?? 'lazy';
  }

  /** 受治进程是否应当常在（with-window 无窗 = 不该在跑——崩溃不自动重启）。 */
  private shouldBeRunning(): boolean {
    return this.lifecycle !== 'with-window' || windowOpenCount(this.pluginName) > 0;
  }

  /** 拉起（到就绪 settle；失败抛出——eager 装载期 / 测试 await 消费）。
   *  就绪 = initialize 握手 + tools/list 在时限内完成。已卸载的治理器不可
   *  再拉起（终态——进程回收出口不得被绕过）。 */
  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error(`受治进程 "${this.server.name}"（${this.pluginName}）已随插件卸载——不可再拉起`);
    }
    if (this.state === 'ready') return;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.state = 'starting';
    this.clearTimers();
    const attempt = this.startOnce();
    this.startPromise = attempt;
    try {
      await attempt;
    } finally {
      this.startPromise = null;
    }
  }

  private async startOnce(): Promise<void> {
    const exitFail = new Promise<never>((_resolve, reject) => {
      this.failStart = (err: Error) => {
        this.failStart = null;
        reject(err);
      };
    });
    let connectP: Promise<void> | null = null;
    try {
      const bridgeId = `mcp-bridge/${this.pluginName}/${this.server.name}#${++this.spawnGen}`;
      const opened = await openStdio(this.server, this.pluginName, this.io, this.env, bridgeId);
      const unsubExit = opened.proc.onExit(() => this.handleExit());
      this.client = opened.client;
      this.proc = opened.proc;
      this.unsubExit = unsubExit;
      // S4：完成通知翻译随 client 上线（每代重启重挂——旧代 client 已死）
      this.unsubNotify = attachDeferredNotifications(opened.client);
      connectP = opened.client.connect();
      await this.raceStartupDeadline(connectP, exitFail);
      this.schemas = opened.client.listRemoteTools();
      this.state = 'ready';
      this.crashAttempts = 0;
      this.armIdle();
    } catch (e) {
      // 启动失败：吞掉时限外迟到的 connect 结局（已判负，不再看）；清场杀
      // 挂壁进程；状态回落 not-running（lazy 下次调用/装配再拉起）
      connectP?.catch(() => {});
      this.failStart = null;
      this.teardownProc();
      this.state = 'not-running';
      throw e;
    } finally {
      this.failStart = null;
    }
  }

  /** 就绪竞速：connect vs 就绪时限 vs 启动途中退出/停止。 */
  private raceStartupDeadline(connectP: Promise<void>, exitFail: Promise<never>): Promise<void> {
    const ms = this.timing.startupDeadlineMs;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `受治进程 "${this.server.name}"（${this.pluginName}）就绪超时（${ms}ms）——initialize 握手未在时限内完成`,
          ),
        );
      }, ms);
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      connectP.then(
        () => settle(resolve),
        (e: unknown) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))),
      );
      exitFail.then(
        () => settle(() => reject(new Error('unreachable'))),
        (e: unknown) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))),
      );
    });
  }

  /** 非阻塞拉起（失败 warn——装配/调用/开窗触发面共享）。退避监管中不拉起
   *  （on-crash 的重启归退避计时器——调用触发不得绕过退避，防快速崩环下
   *  的 spawn 风暴；backoff 触发时自行直接 start）。 */
  ensureStarted(): void {
    if (this.backoffTimer) return;
    void this.start().catch((e: unknown) => {
      console.warn(`[mcp-bridge] 受治进程 "${this.server.name}"（${this.pluginName}）拉起失败:`, e);
    });
  }

  /** 装配期触发（factory）：with-window 不拉起（窗是生命周期主）；
   *  lazy/eager 兜底拉起（eager 崩溃且 restart=off 时由装配兜底恢复）。 */
  requestFromAssembly(): void {
    if (this.disposed || this.state === 'ready' || this.lifecycle === 'with-window') return;
    this.ensureStarted();
  }

  /** 调用期触发（决策 7——lazy 失败调用本身已触发拉起）：with-window 不拉起。 */
  requestFromCall(): void {
    if (this.disposed || this.state === 'ready' || this.lifecycle === 'with-window') return;
    this.ensureStarted();
  }

  /** 调用期就绪口：ready → 当前 client（记活跃）；否则**捕获调用时状态**后
   *  触发拉起并返回 notReady（触发会把状态同步翻成 starting——报错必须
   *  报调用时真因，不报副作用）。 */
  acquireForCall(): { client: McpClient } | { notReady: GovernorState } {
    if (this.state === 'ready' && this.client) {
      this.touch();
      return { client: this.client };
    }
    const statusAtCall = this.state;
    this.requestFromCall();
    return { notReady: statusAtCall };
  }

  /** 工具面快照（factory 产出源——never-connected 期为空集，装配空集不缓存
   *  （pluginToolRows 语义），下装配重试）。 */
  toolFace(): McpToolSchema[] {
    return this.schemas;
  }

  /** 进程退出处理：意图停止（stopping/disposed）不触发重启；意外退出按
   *  restart 策略退避重启。 */
  private handleExit(): void {
    this.unsubExit?.();
    this.unsubExit = null;
    const wasReady = this.state === 'ready';
    const wasStarting = this.state === 'starting';
    this.client = null;
    this.proc = null;
    this.clearTimers();
    this.state = 'not-running';
    if (this.disposed || this.stopping) {
      this.stopping = false;
      return;
    }
    if (!wasReady && !wasStarting) return; // 不在运行——迟到的退出事件，忽略
    if (wasStarting) {
      // 启动途中崩溃：立即判负在途 start（不等就绪时限）
      this.failStart?.(new Error(`受治进程 "${this.server.name}"（${this.pluginName}）启动途中退出`));
    }
    if (this.server.restart !== 'on-crash') return;
    if (!this.shouldBeRunning()) return;
    this.crashAttempts += 1;
    const delay = Math.min(this.timing.restartBackoffMs * 2 ** (this.crashAttempts - 1), RESTART_BACKOFF_CAP_MS);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      // 直接 start（不经 ensureStarted——那是触发面的退避防卫，此处是退避
      // 本体到点）
      void this.start().catch((e: unknown) => {
        console.warn(`[mcp-bridge] 受治进程 "${this.server.name}"（${this.pluginName}）崩溃重启失败:`, e);
      });
    }, delay);
  }

  /** 记活跃（调用/交互）——lazy 空闲回收从现在重新起算。 */
  private touch(): void {
    this.armIdle();
  }

  /** lazy 空闲回收布防：ready 且无窗才计时；窗开/停机即撤。 */
  private armIdle(): void {
    this.clearIdle();
    if (this.disposed || this.lifecycle !== 'lazy' || this.state !== 'ready') return;
    if (windowOpenCount(this.pluginName) > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.stop();
    }, this.timing.idleTimeoutMs);
  }

  /** 开窗：lazy / with-window 首开窗拉起；窗开期间不空闲回收。 */
  onWindowOpened(): void {
    this.clearIdle();
    if (this.disposed || this.state === 'ready') return;
    this.ensureStarted();
  }

  /** 关窗：with-window 计数归零即杀（默认杀，决策 4）；lazy 重新起算空闲。 */
  onWindowClosed(): void {
    if (this.disposed) return;
    if (this.lifecycle === 'with-window' && windowOpenCount(this.pluginName) <= 0) {
      this.stop();
    } else if (this.state === 'ready') {
      this.armIdle();
    }
  }

  /** 意图停止（空闲回收 / 关窗 / 卸载）：杀进程，状态回落 not-running。 */
  stop(): void {
    this.clearTimers();
    if (this.state === 'not-running') {
      this.stopping = false;
      return;
    }
    this.stopping = true;
    this.failStart?.(new Error(`受治进程 "${this.server.name}"（${this.pluginName}）启动被停止`));
    this.teardownProc();
    this.state = 'not-running';
  }

  /** 卸载（插件 fiber dispose）：终态——杀进程 + 出注册表（不可再拉起）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.schemas = [];
    removeGovernor(this);
  }

  private teardownProc(): void {
    this.unsubExit?.();
    this.unsubExit = null;
    this.unsubNotify?.();
    this.unsubNotify = null;
    const client = this.client;
    const proc = this.proc;
    this.client = null;
    this.proc = null;
    if (client) void client.ownedDisposer()(); // connected：断开 + transport close + proc.kill
    // 兜底直杀：connect 未完成时 McpClient.disconnect 早退不杀（挂壁防线——
    // 就绪超时清场必须杀掉挂壁进程；已杀时 ProcIO 幂等）
    proc?.kill();
  }

  private clearTimers(): void {
    this.clearIdle();
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/** 受治工具包装：就绪检查在**调用期**做（client 从治理器现取——回收/重启后
 *  旧 client 不会滞留在缓存的 Tool 实例里），未就绪立即抛结构化错并触发
 *  拉起（决策 7）。 */
function governedTool(governor: ServerGovernor, schema: McpToolSchema): Tool {
  const rawName = schema.name;
  const qualified = publicToolName(governor.server.name, rawName);
  const inputSchema = schema.inputSchema ?? { type: 'object', properties: {} };
  const required = inputSchema.required ?? [];
  return {
    name: () => qualified,
    description: () => schema.description ?? `(external MCP tool from ${governor.server.name})`,
    parameters: () => ({
      type: 'object',
      properties: inputSchema.properties ?? {},
      required,
    }),
    readOnly: () => resolveMcpToolReadOnly(schema, governor.server.readOnly),
    execute: async (args: Record<string, unknown>, onProgress?: (chunk: string) => void, signal?: AbortSignal) => {
      const acquired = governor.acquireForCall();
      if ('notReady' in acquired) {
        throw new Error(
          `service_not_ready: mcp server "${governor.server.name}"（插件 "${governor.pluginName}"）未就绪` +
            `（state: ${acquired.notReady}）——已触发拉起，请稍后重试`,
        );
      }
      const client = acquired.client;
      // S4：Agent 发起的调用绑 deferred token（server 完成通知回带关联唤醒；
      // 无 _owner_id = 无 Agent 语境，不绑）。onProgress 语境沿用进度 token。
      const ownerId = typeof args._owner_id === 'string' ? args._owner_id : undefined;
      const dfToken = ownerId
        ? bindMcpDeferredToken({ ownerId, plugin: governor.pluginName, tool: qualified })
        : undefined;
      const token = dfToken ?? (onProgress ? `tok-${rawName}-${Date.now()}` : undefined);
      const res = await client.callTool(rawName, args, signal, token);
      if (res.isError) {
        return `[MCP ${qualified} ERROR] ${res.text}`;
      }
      return res.text;
    },
  };
}

/** 受治面注册（治理字段在场的条目）：一条 ctx.tools 贡献（行 id 同 legacy）+
 *  治理器挂插件 fiber（dispose → 杀进程）。eager 装载期拉起（到就绪时限
 *  settle；失败抛出 → 插件 error 记录）；lazy/with-window 不在装载期拉起。 */
async function registerGovernedServer(
  ctx: Context,
  pluginName: string,
  server: McpServerDecl,
  io: McpBridgeIO,
  env: Record<string, string> | undefined,
  timing: Required<McpGovernorTiming>,
): Promise<ServerGovernor> {
  const governor = new ServerGovernor(pluginName, server, io, env, timing);
  addGovernor(governor);
  if (governor.lifecycle === 'eager') {
    // 装载即拉起：就绪时限内未握上 = 启动失败报错（registerMcpServerTools
    // 抛出 → loader 记插件 error；治理器出注册表防幽灵进程）
    try {
      await governor.start();
    } catch (e) {
      removeGovernor(governor);
      throw e;
    }
  }
  const contribId = `${pluginName}/mcp/${server.name}`;
  const dispose = ctx.tools.register({
    id: contribId,
    // noCache（①c 路线一纪律）：受治行的 factory 每装配重调——装配期真值族
    // （就绪状态/快照面）经此跨装配取新真值；非空结果不进实例缓存，崩溃后
    // 的装配才能真正打到治理器（触发兜底拉起）。旧形态行不受影响（缓存
    // 语义由 mcp-bridge.test 既有断言钉死）。
    noCache: true,
    factory: async () => {
      if (governor.status !== 'ready') governor.requestFromAssembly();
      return governor.toolFace().map((schema) => governedTool(governor, schema));
    },
  });
  ctx.effect(
    () => () => {
      dispose();
      governor.dispose();
    },
    `${contribId}`,
  );
  return governor;
}

/**
 * 注册一个插件声明的全部 MCP server 工具贡献（loader 装载期调用）。
 *
 * 返回值 = **受治进程的激活面**（S6 P3d）：调用方（loader）在 manifest 声明
 * `activation` 时把它交给 `ctx.activation`，于是「装配期拉起 / 组合引用归零停止」
 * 由激活账驱动（只覆盖 lazy 档，见 `GovernedActivationFace` 头注）；无受治条目
 * 或受治条目都不是 lazy 档 ⇒ null（不接线，行为逐字节不变）。
 *
 * 每个 server：一条 ctx.tools 贡献（id `<插件名>/mcp/<server名>`——折算行
 * id `plugin/<插件名>/mcp/<server名>`）；贡献注销 + 进程 kill 挂该 server
 * 自己的 ctx.effect（插件 fiber dispose → 进程链式停）。
 *
 * 治理分岔（S2）：声明治理字段（restart/lifecycle）的条目走 ServerGovernor
 * （受治面）；皆缺席的条目走旧形态（startup-error 装载期急连接失败抛出 →
 * 插件 error；lazy 缺省首装配连接失败 = 空集 + warn，pluginToolRows 的
 * 「空集不缓存」保证下次装配重试——服务器恢复后新会话即得工具面）。
 * 断线后的自动重连监督是旧形态的未决项（v1 以装配期重试承担）；受治面
 * 由 restart: on-crash 承担。
 *
 * @param opts.dataDirPath 插件数据目录绝对路径——在场即对全部 spawn 注入
 *   `LANTAI_PLUGIN_DATA_DIR`（受治/旧形态同注——dataDir 是 S1 契约，与进程
 *   治理正交；未声明 dataDir 的旧 manifest 无此参数，行为不变）。
 */
export async function registerMcpServerTools(
  ctx: Context,
  pluginName: string,
  servers: McpServerDecl[],
  io: McpBridgeIO = tauriMcpBridgeIO,
  opts: RegisterMcpServerOptions = {},
): Promise<GovernedActivationFace | null> {
  const env = opts.dataDirPath ? { [PLUGIN_DATA_DIR_ENV]: opts.dataDirPath } : undefined;
  const governed: ServerGovernor[] = [];
  for (const server of servers) {
    // 治理分岔：任一治理字段在场 = 受治面；皆缺席 = 旧形态逐字节不变
    if (server.restart !== undefined || server.lifecycle !== undefined) {
      governed.push(await registerGovernedServer(ctx, pluginName, server, io, env, resolveTiming(opts)));
      continue;
    }
    // 急连接（startup-error）：装载期验证机器起得来；失败即抛（→ 插件 error）
    let eager: McpClient | null = null;
    if (server.failurePolicy === 'startup-error') {
      eager = await connectServer(server, pluginName, io, env);
    }
    // 惰性连接（lazy 缺省 / startup-error 急连接复用）：首装配建连 + tools/list
    let client: McpClient | null = eager;
    // S4：lantai/deferred 完成通知翻译随 client 生命周期挂/摘
    let unsubNotify: (() => void) | null = eager != null ? attachDeferredNotifications(eager) : null;
    const contribId = `${pluginName}/mcp/${server.name}`;
    const dispose = ctx.tools.register({
      id: contribId,
      factory: async () => {
        try {
          if (!client) {
            client = await connectServer(server, pluginName, io, env);
            unsubNotify?.();
            unsubNotify = attachDeferredNotifications(client);
          }
          if (!client.isConnected) await client.connect();
          return client.listRemoteTools().map((schema) =>
            // 只读语义同受治面：条目级声明 > 远端 readOnlyHint > 缺省 false
            mcpClientTool(
              client as McpClient,
              schema,
              { readOnly: () => resolveMcpToolReadOnly(schema, server.readOnly) },
              { plugin: pluginName, bindToken: bindMcpDeferredToken },
            ),
          );
        } catch (e) {
          // lazy 语义：瞬态机器不炸装配——空集 + 可见 warn；空集不缓存
          // （pluginToolRows），下次装配重试
          client = null;
          console.warn(`[mcp-bridge] server "${server.name}"（${pluginName}）连接失败——本次装配空集，下次装配重试:`, e);
          return [];
        }
      },
    });
    ctx.effect(
      () => () => {
        dispose();
        unsubNotify?.();
        unsubNotify = null;
        if (client) {
          void client.ownedDisposer()();
          client = null;
        }
      },
      `${contribId}`,
    );
  }
  return governedActivationFace(governed);
}

/** 测试复位：清空治理器注册表与窗口计数（vitest 同 worker 模块态跨用例
 *  共享——防用例间串味；生产不消费。resetPluginRuntimeForTests 同款纪律）。 */
export function resetMcpGovernorForTests(): void {
  governedByPlugin.clear();
  windowOpenCounts.clear();
}

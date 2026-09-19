// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件装载器（WO-S0B）——外部插件的发现/校验/导入/装配管道。
//
// 通道：插件资产由 src-tauri/src/plugin_assets.rs 服务（挂在 llm_proxy 的
// 127.0.0.1:14570 hyper 监听上；WO-S0A spike 已证实 webview 可从此通道动态
// import ES module）。端口经 llm_proxy_port RPC 运行时解析（14570 被占时自增），
// 不在 TS 侧硬编码两处——复用 provider/transport 的 getProxyPort 现有导出。
//
// 铁律：
//   - 失败隔离：单个插件任何一步失败 → plugin-store 记 error 并继续下一个；
//     loader 本身永不 reject（main.ts 接线是 void 调用，错误不进 console.exception）。
//   - 装载期不执行任何插件 UI 副作用（apply 只有注册动作；四 service 是 S1）。
//   - 完全信任模型：不校验插件代码内容，只校验 manifest 形状（Rust 侧负责遍历防护）。

import React, {
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { codeRuntimePlugin } from '../agent/code-run/runtime-service';
import { dynamicRunnerPlugin } from '../agent/dynamic-runner/dynamic-runner-service';
import { Overlay } from '../app/overlay';
import { useShellStore } from '../app/shell-store';
import { capabilitiesServicePlugin } from '../composition/capability-service';
import { fsServicePlugin } from '../composition/fs-service';
import { hooksServicePlugin } from '../composition/hook-service';
import { overlayServicePlugin } from '../composition/overlay-service';
import { promptsServicePlugin } from '../composition/prompt-service';
import { rendererServicePlugin } from '../composition/renderer-service';
import { compositionServicesPlugin } from '../composition/services';
import { sessionPersistenceServicePlugin } from '../composition/session-persistence-service';
import { shellServicePlugin } from '../composition/shell-service';
import { spaceServicePlugin } from '../composition/space-service';
import { subagentsServicePlugin } from '../composition/subagent-service';
import type { Context, Fiber } from '../cordis';
import { getProxyPort } from '../provider/transport';
import { typedRpc } from '../rpc-contract';
import { usePluginPrefs } from '../state/plugin-prefs';
import { type PluginRecord, usePluginStore } from '../state/plugin-store';
import { faceDepsKeys, hostSurfaceFingerprint, pluginHostMods } from './builtin/host-modules';
import { ensurePluginDataDir, type PluginDataFs, pluginDataFs } from './data-fs';
import { completePluginTask } from './deferred';
import { factoryProductNames, factoryProductPlugins } from './factory-products';
import { FIRST_PARTY_MANIFEST, type FirstPartyPluginMeta } from './first-party-manifest';
import { type GovernedActivationFace, type McpBridgeIO, registerMcpServerTools } from './mcp-bridge';
import { mountToolDeclarations } from './tool-declarations';
import { type LantaiPlugin, type PluginManifest, validateManifest } from './types';
import { mountPluginApp, type PluginWindowFacility, pluginWindowFacility } from './window-facility';

/** loader 消费的最小 fetch 形状（测试可用普通对象实现，不依赖 Response 全局）。 */
export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** 测试注入面：fetch 与 dynamic import 皆可替换（vitest 用 URL 注入 mock）。 */
export interface LoadExternalPluginsOptions {
  /** 资产 origin（缺省经 llm_proxy_port RPC 解析）。 */
  origin?: string;
  /** fetch 实现（缺省全局 fetch）。 */
  fetchImpl?: FetchLike;
  /** dynamic import 实现（缺省运行时 import + @vite-ignore 防 vite 编译期分析）。 */
  importModule?: (url: string) => Promise<Record<string, unknown>>;
  /** MCP 机器桥宿主 IO（S4-4 乙；缺省 Rust protocol_bridge / plugin_dir RPC）。 */
  mcpBridgeIO?: McpBridgeIO;
  /** 数据目录 ensure 注入面（S1；缺省真源 typedJsonRpc plugin_data_ensure——
   *  vitest 用 mock 隔离 RPC 通道）。 */
  pluginDataEnsure?: (name: string) => Promise<string>;
}

/** 插件静态资源 origin 构造（端口运行时解析；WO-S0A spike 验证过的通道）。 */
export function pluginAssetsOrigin(port: number): string {
  return 'http://127.0.0.1:' + port + '/plugins';
}

/** 第一方插件表（编译期 bundle 内，不走磁盘通道；S3 起逐域填充）。
 * 表序 = 装配序。首项固定为组合层四 service（内核线第 3 条的实体化——
 * panels/commands/tools/llm 注册表本身，常驻且先于外部插件，
 * 保证外部插件 manifest 的 inject 依赖可解析）。第二行为 llm-adapters
 * （平台化 Phase 1 · D2 修订版 2026-08-27：内核 anthropic/openai 协议方言经
 * ctx.llm 贡献为默认 adapter——排位紧随四 service 使 ctx.llm 可解析，且先于
 * 外部插件装载保持「后注册胜」覆盖方向；取代 resolveProviderDialect 的内核回落分支）。P3：codeRuntime 服务行
 * （agent/code-run——执行腰，四 service 之后）。V3b：块渲染器第五 service。
 * S3：settings 域行化（面板 + 命令双贡献）。P4 A-1（2026-08-23）：
 * prompts 第六 service（system-prompt 段贡献注册表）。P4 B①+②（2026-08-23）：
 * 表尾接第一方工具域插件清单（git/search 两域 B① + fs/shell/agent-isolation
 * 三域 ②，经 ctx.tools 贡献工具，单一真源 composition/first-party-tools.ts
 * ——贡献行序 = 清单序，且必须列于四 service 之后使 inject ['tools'] 可解析
 * ）。P4 B④ 收官（2026-08-23）：表尾接第一方 prompt 段插件清单（8 段全量经
 * ctx.prompts 贡献——试点 memory/claude-md + 续批 graph-snapshot +
 * 收官批 10 段；单一真源 composition/first-party-prompts.ts——贡献序 =
 * 清单序，列于 promptsServicePlugin 之后使 inject ['prompts'] 可解析；
 * 出厂段表 builtinPromptSections() 已退役，本通道是出厂段唯一来源）。
 * P4 A-2（2026-08-24）：hooks 第七 service（工具管道钩子贡献注册表——
 * ctx.hooks，enrich/preflight 两类；runtime 装配折叠消费，见
 * composition/hook-service.ts）。P4 A-3（2026-08-24）：capabilities 第八
 * service（capability 贡献注册表——ctx.capabilities，会话级能力的插件
 * 装载；贡献经 factoryComposition 快照进 capabilities 域，runtime
 * fromRoster 穿线零改动，见 composition/capability-service.ts）。P4 B⑤
 * 收官（2026-08-24）：表尾接第一方 capability 插件清单（十四项会话级
 * 能力全量经 ctx.capabilities 贡献——单一真源 composition/first-party-
 * capabilities.ts，贡献序 = 清单序 = 迁移前出厂表序；出厂
 * builtinCapabilities() 退役，本通道是出厂 capability 面唯一来源）。
 * 2026-08-29 起 export（守护测试对拍 first-party-manifest 完备性）。 */
/** S5（plugin-bundle-retirement）：bundle 双轨拆除（**计数以代码真源为准**——
 *  13 内核 = 下方 BUILTIN_PLUGINS / SERVICE_META 13 条；30 出厂产物 =
 *  builtin-roster.json 条目数。旧记「15 内核 / 29 产物」是 S5 当时的过期手抄）。
 *  生产形态：BUILTIN_PLUGINS 只装 13 内核；30 个出厂产物从磁盘产物通道
 *  （loadExternalPlugins）装载。
 *  开发形态：`import.meta.env.DEV` 分支展开 30 个出厂产物（源码路径，
 *  vite HMR 热重载；产物仅发布形态）——分支经 vite define 在生产端展开为
 *  `false ? [...] : []`，rollup 死代码消除后 factory-products.ts 及其
 *  传递导入不进生产 bundle。
 *  表序 = 贡献注册序 = 字节契约（组合解析快照/工具契约生成/DeepSeek 前缀
 *  缓存依赖此序，不得重排）。 */
/** dev 强制产物通道（boot 性能测量，2026-09-03）：置 1 时 dev 下也不展开
 *  源码工厂产物、不过滤产物通道工厂名——装载形态与生产逐位一致（磁盘
 *  产物 HTTP import），用于测量真实 I/O 耗时。默认关，行为与开关前一致。 */
const forceProductChannel = (import.meta.env as Record<string, unknown>).VITE_FORCE_PRODUCT_CHANNEL === '1';

export const BUILTIN_PLUGINS: LantaiPlugin[] = [
  compositionServicesPlugin,
  subagentsServicePlugin,
  fsServicePlugin,
  shellServicePlugin,
  sessionPersistenceServicePlugin,
  spaceServicePlugin,
  overlayServicePlugin,
  codeRuntimePlugin,
  dynamicRunnerPlugin,
  rendererServicePlugin,
  promptsServicePlugin,
  hooksServicePlugin,
  capabilitiesServicePlugin,
];

/** 全部第一方插件（13 内核 + dev 出厂产物源码路径）。
 *  ⚠ 2026-09-06：出厂产物展开从 BUILTIN_PLUGINS 顶层挪到本函数——顶层展开会在
 *  模块加载期调用 factoryProductPlugins()，而 settings-domain → SettingsPanel →
 *  PluginsPage → loader 的循环 import 使插件对象在加载期未初始化（TDZ/undefined
 *  ——s3-settings-domain 实测炸）。运行期调用（loadBuiltinPlugins / 测试）时
 *  模块图已闭合。
 *  生产形态：import.meta.env.DEV=false → 仅 13 内核（产物走磁盘通道装载）；
 *  dev 形态：追加 factoryProductPlugins()（vite HMR 源码热重载；forceProductChannel
 *  =1 时不追加——产物通道是唯一装载面，形态同生产）。 */
export function allBuiltinPlugins(): LantaiPlugin[] {
  const factory = import.meta.env.DEV && !forceProductChannel ? factoryProductPlugins() : [];
  return factory.length > 0 ? [...BUILTIN_PLUGINS, ...factory] : BUILTIN_PLUGINS;
}

// ── 插件宿主桥（S4-5；P1 扩展 2026-08-30；增补四施工扩面 2026-08-31）──
// 外部插件经 webview 动态 import 装载——模块语境没有裸 import 解析面
// （无包管理器、无 import map，平台契约 = 插件自包含）。需要宿主能力的
// 插件经 window.__lantai_plugin_host__ 取用：
//   - createElement：React.createElement（面板组件构造——无 JSX 插件的路由）；
//   - react：React 全量（jsx-runtime 形状取用——渲染器插件 P1 的 JSX 面；
//     增补四起是 UI 面产物 react 别名桥 react-bridge.cjs 的落点）；
//   - hooks（完整 hooks 子集）：UI 面产物的 hooks 面（P1a 为 useState/
//     useEffect/useRef 三件，增补四扩到面组件实际使用全集）；
//   - Overlay：浮层组件（媒体渲染器预览用，P1a）；
//   - rpc：typedRpc（媒体渲染器 read_file_base64 用，P1a）；
//   - notify：状态栏通知（命令动作的最小 UI 反馈面）；
//   - loadCss：产物 CSS 注入（UI 面产物 entry.css——幂等 link 注入）；
//   - fs：插件数据目录面（S1——ensure/list/read/write/delete 锁
//     <dataRoot>/<插件名>/，Rust plugin_data 围栏；manifest.dataDir 声明
//     插件的专属数据地盘，桥面插件名是参数——全信任区，S3 窗口面才绑定）；
//   - windows：窗口设施 API（S3 app shell 件 A——开/关/聚焦/模式/查询，
//     宿主能力面非工具面；工具语义归插件：插件工具执行体调它开自己的窗）；
//   - deferred：后台唤醒回调（S4 app shell 件 D——async:true 工具的后台
//     完成口：complete(taskId, status, message?) 唤醒发起 Agent + minimal
//     定位键；MCP 路走 server 完成通知不经此面）；
//   - mods：项目模块真实例注册表（pluginHostMods()——面组件依赖的
//     store/service 单例与工具域/段贡献插件对象，见 builtin/host-modules.ts）。
// 桥在装载第一方插件前注入（装载期红线：注入是平台动作不是插件副作用）。
declare global {
  interface Window {
    __lantai_plugin_host__?: {
      createElement: typeof createElement;
      react: typeof React;
      hooks: {
        useState: typeof useState;
        useEffect: typeof useEffect;
        useRef: typeof useRef;
        useCallback: typeof useCallback;
        useContext: typeof useContext;
        useId: typeof useId;
        useImperativeHandle: typeof useImperativeHandle;
        useLayoutEffect: typeof useLayoutEffect;
        useMemo: typeof useMemo;
        useReducer: typeof useReducer;
        useSyncExternalStore: typeof useSyncExternalStore;
      };
      Overlay: typeof Overlay;
      rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      notify: (text: string) => void;
      loadCss: (url: string) => void;
      fs: PluginDataFs;
      windows: PluginWindowFacility;
      deferred: { complete: typeof completePluginTask };
      mods: Record<string, unknown>;
    };
  }
}

/** 产物 CSS 的 link 记账（landmine H3，2026-09-19 修）——两条都在这里收口：
 *  ① **URL 带版本号**（会话戳 + 注入序号）：`<link>` 与 JS 的 `import` 不同，
 *     同一 href 不会被重新请求（channel 的 `cache-control: no-store` 救不了它），
 *     于是「改了 CSS + 点重新加载」= 新 DOM + 旧 CSS 的偏斜。版本号恒新 ⇒
 *     浏览器必重新请求（本地产物，放弃跨会话缓存复用是划算的）。
 *  ② **每产品一 link**：同产品再次注入先摘旧 link（否则旧规则留场：新样式里
 *     **删掉**的规则会一直生效），插件停用时也摘（不留累积的死 link）。
 *  键 = CSS URL 的产物路径（= 插件名，如 `hologram/compose-dock`）；异形 URL
 *  退回按原 URL 归并。摘除按名匹配（三等形态，见 cssKeyMatches）。 */
const pluginCssLinks = new Map<string, HTMLLinkElement>();
/** 会话戳（模块初始化一次性）+ 注入序号：合起来保证同文档内 href 恒新。 */
const cssSessionStamp = Date.now().toString(36);
let cssSeq = 0;

/** CSS URL → 记账键：产物 CSS 落在 `<origin>/<pluginName>/entry.css`，取其
 *  路径段当键（与 `manifest.name` 同形，停用时按名摘得掉）；异形退回原 URL。 */
function cssKeyOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const m = /^\/(.+)\/entry\.css$/.exec(path);
    if (m) return m[1];
  } catch {
    /* 非绝对 URL：退回原串（幂等语义不变，只是不参与按名摘除） */
  }
  return url;
}

/** 键与插件名是否指同一产品（名 = `hologram/<dir>`，键 = URL 路径，两者同形；
 *  容错三种形态：全等 / 一方是另一方的路径尾段）。 */
function cssKeyMatches(key: string, name: string): boolean {
  return key === name || key.endsWith('/' + name) || name.endsWith('/' + key);
}

/** 摘掉某产品的产物 CSS link（幂等；返回是否真摘掉）。 */
function removePluginCss(nameOrKey: string): boolean {
  if (typeof document === 'undefined') return false;
  let removed = false;
  for (const [key, link] of [...pluginCssLinks]) {
    if (!cssKeyMatches(key, nameOrKey)) continue;
    link.remove(); // 摘掉即失效：本会话内被删的规则不再留场（壳 bundle 那份另说，见 docs/dev-workflow）
    pluginCssLinks.delete(key);
    removed = true;
  }
  return removed;
}

/** 产物 CSS 注入（版本号 + 每产品一 link；H3 修后不再是「同 URL 只注一次」——
 *  同产品重注 = 换新 link，正是「重新加载后 CSS 也得换新」要的）. */
function injectPluginCss(url: string): void {
  if (typeof document === 'undefined') return;
  const key = cssKeyOf(url);
  removePluginCss(key); // 同产品旧 link 先摘（旧规则不许留场）
  const link = document.createElement('link');
  link.id = 'lantai-plugin-css:' + key;
  link.rel = 'stylesheet';
  link.href = url + (url.includes('?') ? '&' : '?') + 'v=' + cssSessionStamp + '-' + cssSeq++;
  document.head.appendChild(link);
  pluginCssLinks.set(key, link);
}

/** 装插件宿主桥（幂等；`loadBuiltinPlugins` 装载前调用）。
 *  **导出于测试**：产物 CSS 通道的行为面考官（tests/plugin-css-channel）要经
 *  `__lantai_plugin_host__.loadCss` 走**真实**注入路径，而不是复制一份判据。 */
export function installPluginHostBridge(): void {
  if (typeof globalThis !== 'undefined') {
    (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__ = {
      createElement,
      react: React,
      hooks: {
        useState,
        useEffect,
        useRef,
        useCallback,
        useContext,
        useId,
        useImperativeHandle,
        useLayoutEffect,
        useMemo,
        useReducer,
        useSyncExternalStore,
      },
      Overlay,
      rpc: (method: string, params: Record<string, unknown>) => typedRpc(method as never, params as never),
      notify: (text: string) => useShellStore.getState().pushStatus(text),
      loadCss: injectPluginCss,
      fs: pluginDataFs,
      windows: pluginWindowFacility,
      deferred: { complete: completePluginTask },
      mods: pluginHostMods(),
    };
  }
}

/** 装载第一方插件表。返回根 Context（main.ts 接线链式取用）。
 * 同步装载（apply 内的 provide 同步生效——外部插件的 inject 依赖立即可解析）；
 * fiber await 的 rejection 显式接住（内核装配失败必须可见，不留 unhandled）。
 * S4-5：装载前先注入插件宿主桥（外部插件的 createElement/notify 来源）。
 * 2026-08-29：装载结果折算为 PluginRecord 写入 plugin-store（builtin=true +
 * first-party-manifest 元数据）——第一方插件从此进插件列表；用户禁用的
 * feature 插件跳过装载（下次启动生效），记录 status=disabled；platform
 * 类（service）常驻不提供禁用。清单缺失 = 装配断层，跳过 + error 记录
 * （错误不静默；守护测试拦死，这里兜底）。 */
export function loadBuiltinPlugins(root: Context): Context {
  installPluginHostBridge();
  const bootT0 = performance.now();
  const records: PluginRecord[] = [];
  for (const plugin of allBuiltinPlugins()) {
    const meta = FIRST_PARTY_MANIFEST[plugin.name];
    if (!meta) {
      records.push({
        name: plugin.name,
        manifest: null,
        status: 'error',
        builtin: true,
        error: 'first-party-manifest 缺条目（name=' + plugin.name + '）',
      });
      continue;
    }
    if (meta.kind === 'feature' && usePluginPrefs.getState().isDisabled(plugin.name)) {
      records.push({ name: plugin.name, manifest: null, status: 'disabled', builtin: true, meta });
      continue;
    }
    const fiber = root.plugin(plugin);
    void Promise.resolve(fiber).catch((err: unknown) => {
      console.error('[plugins] 第一方插件装载失败:', plugin.name, err);
    });
    records.push({ name: plugin.name, manifest: null, status: 'active', builtin: true, meta });
  }
  // merge 而非 setPlugins：第一方先装载、第三方异步后到不得冲刷第一方记录
  usePluginStore.getState().mergePlugins(records);
  if (import.meta.env.MODE !== 'test') {
    console.log(
      `[boot-timing] loadBuiltinPlugins：${records.length} 条目同步调度 ${(performance.now() - bootT0).toFixed(1)}ms（异步 apply 完成见 boot-gate settle）`,
    );
  }
  return root;
}

/** 惰性解析资产 origin；'' = 无通道（无后端/代理未起 → 静默跳过，非错误）。 */
async function resolveOrigin(): Promise<string> {
  const port = await getProxyPort();
  if (!port) return '';
  return pluginAssetsOrigin(port);
}

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 读 plugins.json 启用态与授权态（{"disabled": [...], "granted":
 *  {"<插件名>": ["bash", ...]}}；缺文件/坏形状 = 空集/空表——INVARIANTS
 *  #11.2 毒化容忍：坏文件不炸装载，按无声明处理）。 */
async function readPluginsState(
  fetchImpl: FetchLike,
  origin: string,
): Promise<{ disabled: Set<string>; granted: Map<string, Set<string>> }> {
  const raw = await fetchJson(fetchImpl, origin + '/plugins.json');
  const empty = { disabled: new Set<string>(), granted: new Map<string, Set<string>>() };
  if (raw == null || typeof raw !== 'object') return empty;
  const record = raw as { disabled?: unknown; granted?: unknown };
  const disabled = new Set<string>();
  if (Array.isArray(record.disabled)) {
    for (const name of record.disabled) {
      if (typeof name === 'string') disabled.add(name);
    }
  }
  const granted = new Map<string, Set<string>>();
  if (record.granted != null && typeof record.granted === 'object' && !Array.isArray(record.granted)) {
    for (const [name, classes] of Object.entries(record.granted as Record<string, unknown>)) {
      if (Array.isArray(classes)) {
        granted.set(name, new Set(classes.filter((c): c is string => typeof c === 'string')));
      }
    }
  }
  return { disabled, granted };
}

function errorRecord(name: string, manifest: PluginManifest | null, error: string): PluginRecord {
  return { name, manifest, status: 'error', error };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.name + ': ' + e.message : String(e);
}

// ── D6 运行时热重载（平台化 Phase 4，2026-08-27）──
// 外部插件的「活跃注册表」：插件名 → 装载 fiber。boot 期 loadExternalPlugins
// 填充；此后设置面板的 装/卸/启用/禁用 走 activateExternalPlugin /
// deactivateExternalPlugin 增量装卸——fiber dispose 链式回收贡献（工具行/
// 面板/命令/prompt 段/MCP 进程 kill 全挂插件 fiber 的 ctx.effect）。
// 模块级可变态归属（CONVENTIONS §1.10 第 3 类）：单键进程级状态，
// 生命周期 = 进程（与 _activePanels 等活动服务面同款）。
interface PluginRuntime {
  root: Context;
  deps: {
    origin: string;
    fetchImpl: FetchLike;
    importModule: (url: string) => Promise<Record<string, unknown>>;
    mcpBridgeIO?: McpBridgeIO;
    pluginDataEnsure: (name: string) => Promise<string>;
  };
}
let runtime: PluginRuntime | null = null;
const activeExternalFibers = new Map<string, Fiber>();

/** 当前活跃的外部插件名清单（诊断/测试面）。 */
export function activeExternalPluginNames(): string[] {
  return [...activeExternalFibers.keys()];
}

/** 测试复位：清空运行时绑定与活跃注册表（vitest 同 worker 模块态跨用例
 *  共享——loader 测试的 beforeEach 调用，防用例间串味）。 */
export function resetPluginRuntimeForTests(): void {
  runtime = null;
  activeExternalFibers.clear();
  for (const link of pluginCssLinks.values()) link.remove();
  pluginCssLinks.clear();
}

/** 增量装载一个外部插件（安装/启用后的运行时生效入口）。
 *  已活跃 = 先 dispose 旧 fiber 再重载（升级重装路径）。装载语义与
 *  loadOne 逐字节一致（manifest 校验 / inject 检查 / 权限门禁 / 失败
 *  隔离——永不 reject，结果写 plugin-store 并返回）。 */
export async function activateExternalPlugin(dirId: string): Promise<PluginRecord> {
  if (runtime == null) {
    return errorRecord(dirId, null, '插件运行时未引导（main.ts loadExternalPlugins 未跑）');
  }
  const { root, deps } = runtime;
  // 重装载路径：旧 fiber 先拆（dispose 链式回收全部贡献）
  await deactivateExternalPlugin(dirId);
  bootTiming.length = 0; // 增量装载计时独立汇总（loadOne 会写采集器）
  // 权限门禁读最新 granted 段（plugins.json 可被授权流手改——不 boot 缓存）
  const { granted } = await readPluginsState(deps.fetchImpl, deps.origin);
  const { record, fiber } = await loadOne(root, dirId, { ...deps, disabled: new Set(), granted });
  if (fiber) activeExternalFibers.set(record.name, fiber);
  usePluginStore.getState().upsertPlugin(record);
  reportBootTiming('activateExternalPlugin(' + dirId + ')');
  return record;
}

/** 增量停用（禁用/卸载后的运行时生效入口）：dispose fiber → 贡献链式
 *  回收。位移式内置插件的产物停用后重启 bundle 插件（出厂兜底行恢复，
 *  记录翻回 bundle 形态）。未活跃 = no-op 返回 false。
 *  产物 CSS 的 link 一并摘掉（H3：停用/重载不许留累积的死 link——先摘再判
 *  fiber，故未活跃时也幂等摘净）。 */
export async function deactivateExternalPlugin(name: string): Promise<boolean> {
  removePluginCss(name);
  const fiber = activeExternalFibers.get(name);
  if (!fiber) return false;
  activeExternalFibers.delete(name);
  await fiber.dispose();
  return true;
}

/** boot 计时汇总（诊断 2026-09-03）；vitest 环境跳过不刷屏。
 *  串行装载下各段 Σ ≈ 总墙钟，慢插件定位看各行。 */
function reportBootTiming(tag: string): void {
  if (import.meta.env.MODE === 'test') return;
  if (bootTiming.length === 0) return;
  const sum = (key: 'manifestMs' | 'faceMs' | 'importMs' | 'applyMs'): number =>
    bootTiming.reduce((acc, t) => acc + (t[key] ?? 0), 0);
  // 总墙钟 = max(totalMs)（并发下 Σ totalMs 重复计数虚高——2026-09-03 修正：
  // 串行时 max ≈ Σ，并发时 max = 从首波启动到最晚装配完成的真实时间）。
  const total = bootTiming.reduce((acc, t) => Math.max(acc, t.totalMs), 0);
  console.group(`[boot-timing] ${tag}：${bootTiming.length} 插件，总 ${total.toFixed(1)}ms`);
  for (const t of bootTiming) {
    console.log(
      `${t.name.padEnd(32)} manifest=${(t.manifestMs ?? 0).toFixed(1)}ms face=${(t.faceMs ?? 0).toFixed(1)}ms import=${(t.importMs ?? 0).toFixed(1)}ms apply=${(t.applyMs ?? 0).toFixed(1)}ms total=${t.totalMs.toFixed(1)}ms [${t.status}]`,
    );
  }
  console.log(
    `Σ manifest=${sum('manifestMs').toFixed(1)}ms face=${sum('faceMs').toFixed(1)}ms import=${sum('importMs').toFixed(1)}ms apply=${sum('applyMs').toFixed(1)}ms`,
  );
  console.groupEnd();
  bootTiming.length = 0;
}

/** 外部插件装载主入口（main.ts 引导期调用；永不 reject）。 */
export async function loadExternalPlugins(root: Context, opts: LoadExternalPluginsOptions = {}): Promise<void> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const importModule = opts.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
  const mcpBridgeIO = opts.mcpBridgeIO;
  try {
    bootTiming.length = 0; // 清上一轮残留（activate 增量装载也写采集器），本轮独立汇总
    const origin = opts.origin ?? (await resolveOrigin());
    if (!origin) return; // 无后端通道（浏览器 mock / 代理未起）——非错误
    runtime = {
      root,
      deps: {
        origin,
        fetchImpl,
        importModule,
        mcpBridgeIO,
        pluginDataEnsure: opts.pluginDataEnsure ?? ensurePluginDataDir,
      },
    };
    const index = await fetchJson(fetchImpl, origin + '/');
    if (!Array.isArray(index)) {
      console.warn('[plugins] 装载通道索引不可用');
      return;
    }
    const { disabled, granted } = await readPluginsState(fetchImpl, origin);
    // 装载序纪律（增补四 + S5）：出厂产物按 factoryProductPlugins() 表序装载——
    // 产物重激活的注册序必须与原 bundle 序逐位一致（S1 表序字节契约：
    // 组合解析快照 / 工具契约生成 / DeepSeek 前缀缓存都依赖贡献注册序，
    // 磁盘索引的字母序会让 assembly 面漂移）。其余用户插件按索引序随后。
    // dev 模式过滤：出厂产物已在源码域装载（BUILTIN_PLUGINS 的 DEV 分支），
    // 产物通道的磁盘副本是过期缓存——跳过防重复装载/覆盖热重载。
    // forceProductChannel=1（性能测量）：不过滤——产物通道是唯一装载面
    // （BUILTIN_PLUGINS 同步不展开源码工厂产物，形态与生产一致）。
    const factoryNames = factoryProductNames();
    const indexNames =
      import.meta.env.DEV && !forceProductChannel
        ? index.map(String).filter((n) => !factoryNames.has(n))
        : index.map(String);
    const factoryOrder = factoryProductPlugins().map((p) => p.name);
    const builtinFirst = factoryOrder.filter((n) => indexNames.includes(n));
    const rest = indexNames.filter((n) => !builtinFirst.includes(n));
    // 三波并行装载（2026-09-03 性能重构，保序契约不变）：
    //   波 1 并发拉全部 manifest + face（阶段 1——本地校验与拒载分支，无副作用）
    //   波 2 并发 import 全部通过产物（阶段 2——模块解析/形状校验，无副作用）
    //   波 3 按表序串行 apply（root.plugin——注册贡献，字节契约依赖此序）
    // 串行 → 三波后：总墙钟从 Σ全部段（≈2s）降到最慢单条链（≈0.5s）。
    const order = [...builtinFirst, ...rest];
    const bootT0 = performance.now();
    const deps: LoadOneDeps = {
      origin,
      disabled,
      granted,
      fetchImpl,
      importModule,
      mcpBridgeIO,
      pluginDataEnsure: opts.pluginDataEnsure ?? ensurePluginDataDir,
    };
    const stage1 = await Promise.all(order.map((dirId) => manifestStage(String(dirId), deps)));
    const stage2 = await Promise.all(stage1.map((s1) => (s1.ok ? moduleStage(s1, deps) : s1)));
    const records: PluginRecord[] = [];
    for (const s2 of stage2) {
      if (!s2.ok) {
        s2.tim.totalMs = performance.now() - bootT0;
        s2.tim.status = s2.record.status;
        bootTiming.push(s2.tim);
        records.push(s2.record);
        continue;
      }
      let fiber: Fiber | null = null;
      try {
        const tApply = performance.now();
        fiber = await root.plugin(s2.target);
        s2.tim.applyMs = performance.now() - tApply;
        s2.tim.status = 'active';
      } catch (e) {
        // apply 抛错 → 装载失败记录（失败隔离：单个失败不影响后续）
        s2.tim.status = 'error';
        s2.tim.totalMs = performance.now() - bootT0;
        bootTiming.push(s2.tim);
        records.push(withBuiltinMeta(s2.manifest.name, s2.manifest, errText(e)));
        continue;
      }
      s2.tim.totalMs = performance.now() - bootT0;
      bootTiming.push(s2.tim);
      const record: PluginRecord = s2.isBuiltinNamed
        ? { name: s2.manifest.name, manifest: s2.manifest, status: 'active', builtin: true, meta: s2.bundleMeta }
        : { name: s2.manifest.name, manifest: s2.manifest, status: 'active' };
      records.push(record);
      activeExternalFibers.set(record.name, fiber);
    }
    // 装配断层对账（2026-09-06）：S5 起产物通道是唯一装载面（位移/bundle 兜底
    // 退役），boot 审计只看 fiber——从未装载的产物（索引缺条目）根本不进审计，
    // 面会静默缺行（renderers 缺席 = 资产块全部落 JSON 兜底）。此处对第一方
    // 清单逐名对账：既无 active 也无 error/disabled 记录 = 断层，补 error 记录
    // （设置页可见）+ console.error（错误不静默）。产物通道激活时才跑：
    // origin 空 = 无通道环境；MODE 'test' = vitest 的 mock 通道（部分索引是
    // 夹具常态，不是断层——对账会淹没测试断言面）。
    if (origin && import.meta.env.MODE !== 'test') {
      const seen = new Set<string>([
        ...records.map((r) => r.name),
        ...usePluginStore.getState().plugins.map((r) => r.name),
      ]);
      for (const [name, meta] of Object.entries(FIRST_PARTY_MANIFEST)) {
        if (meta.kind !== 'feature' || seen.has(name)) continue;
        console.error(
          '[plugins] 装配断层：第一方产物在装载通道无记录（' +
            name +
            '）' +
            '——磁盘 dist-plugins 索引缺条目或装载被静默跳过；对应功能面将缺行（错误不静默）',
        );
        records.push({
          name,
          manifest: null,
          status: 'error',
          builtin: true,
          meta,
          error:
            '装配断层：产物通道索引无此条目（dist-plugins 缺失或过旧）——用与 exe 同源的源码树重建产物（build:builtin-plugins），或更新应用版本',
        });
      }
    }
    // merge 而非 setPlugins：外部插件装载不得冲刷第一方 boot 记录
    usePluginStore.getState().mergePlugins(records);
    reportBootTiming('loadExternalPlugins');
  } catch (e) {
    // 通道级失败（内部已全捕获，理论不可达；防御性兜底防未处理拒绝）
    console.warn('[plugins] 装载通道失败:', e);
    reportBootTiming('loadExternalPlugins(失败)');
  }
}

interface LoadOneDeps {
  origin: string;
  disabled: Set<string>;
  /** plugins.json granted 段（C11-2 授权态：插件名 → 已授予权限类集）。 */
  granted: Map<string, Set<string>>;
  fetchImpl: FetchLike;
  importModule: (url: string) => Promise<Record<string, unknown>>;
  mcpBridgeIO?: McpBridgeIO;
  /** 数据目录分配（S1——dataDir 插件的 wrapper apply 先行调用）。 */
  pluginDataEnsure: (name: string) => Promise<string>;
}

/** 插件装载段耗时（boot 计时诊断，2026-09-03——只进日志，不改装载语义）。 */
interface LoadTimingEntry {
  name: string;
  manifestMs: number | null;
  faceMs: number | null;
  importMs: number | null;
  applyMs: number | null;
  totalMs: number;
  status: string;
}
/** boot 计时采集器（模块级可变态；loadExternalPlugins / activateExternalPlugin
 *  各自清空 + 汇总；vitest 环境不打印不刷屏）。 */
const bootTiming: LoadTimingEntry[] = [];

/** manifestStage 成功结果（阶段 1 通过）。 */
interface ManifestStageOk {
  ok: true;
  dirId: string;
  manifest: PluginManifest;
  bundleMeta: FirstPartyPluginMeta | undefined;
  isBuiltinNamed: boolean;
  tim: LoadTimingEntry;
}
type ManifestStageResult = ManifestStageOk | { ok: false; record: PluginRecord; tim: LoadTimingEntry };

/** moduleStage 成功结果（阶段 2 通过）。 */
interface ModuleStageOk {
  ok: true;
  manifest: PluginManifest;
  bundleMeta: FirstPartyPluginMeta | undefined;
  isBuiltinNamed: boolean;
  target: LantaiPlugin;
  tim: LoadTimingEntry;
}
type ModuleStageResult = ModuleStageOk | { ok: false; record: PluginRecord; tim: LoadTimingEntry };

/** 阶段 1：manifest + face 拉取与全部拒载分支判定（并发安全、无副作用）。
 *  face 与 manifest 并发拉（双 URL 均按 dirId 寻址——第 2 步强制
 *  manifest.name === dirId，故等价原 manifest.name 寻址）；4b' 宿主面键
 *  对拍在 import 前完成（保险丝语义保持——偏斜产物不 import）。 */
async function manifestStage(dirId: string, deps: LoadOneDeps): Promise<ManifestStageResult> {
  const { origin, fetchImpl } = deps;
  const tim: LoadTimingEntry = {
    name: dirId,
    manifestMs: null,
    faceMs: null,
    importMs: null,
    applyMs: null,
    totalMs: 0,
    status: 'error',
  };
  const t0 = performance.now();
  // 并发拉 manifest + face（同一并发窗——manifestMs/faceMs 记窗长）
  const [raw, faceDoc] = await Promise.all([
    fetchJson(fetchImpl, origin + '/' + dirId + '/manifest.json'),
    fetchJson(fetchImpl, origin + '/' + dirId + '/face.json'),
  ]);
  tim.manifestMs = performance.now() - t0;
  tim.faceMs = performance.now() - t0;
  if (raw == null) return { ok: false, record: errorRecord(dirId, null, 'manifest.json 缺失或不可解析'), tim };
  const validated = validateManifest(raw);
  if (!validated.ok) {
    return { ok: false, record: errorRecord(dirId, null, 'manifest 校验失败: ' + validated.error), tim };
  }
  const manifest = validated.manifest;
  // 2) 名字与目录一致（URL 按名字寻址磁盘目录，不一致 = 装不上）
  if (manifest.name !== dirId) {
    return {
      ok: false,
      record: errorRecord(dirId, manifest, 'manifest.name (' + manifest.name + ') 与目录名 (' + dirId + ') 不一致'),
      tim,
    };
  }
  const bundleMeta = FIRST_PARTY_MANIFEST[manifest.name];
  const isBuiltinNamed = bundleMeta != null;
  // 2b) 第一方 feature 的用户禁用态（plugin-prefs）对产物通道同样生效
  //     （bundle 域 boot 跳过 + 产物域装载跳过——两域一致，下次启动语义不变）
  if (bundleMeta?.kind === 'feature' && usePluginPrefs.getState().isDisabled(manifest.name)) {
    return {
      ok: false,
      record: { name: manifest.name, manifest, status: 'disabled', builtin: true, meta: bundleMeta },
      tim,
    };
  }
  // 3) S4：inject 依赖存在性检查退役——cordis fiber PENDING 挂起语义取代
  //    一次性存在性拒载。manifest.inject 合并进插件对象 inject（见阶段 2
  //    target 构造），缺依赖 = fiber PENDING 等待；boot 审计（boot-gate.ts）
  //    settle 后判全 ACTIVE 才放行——PENDING 且依赖永缺 = 审计 fail-loud。
  // 4) disabled 跳过（不 import）
  if (deps.disabled.has(manifest.name)) {
    return {
      ok: false,
      record: isBuiltinNamed
        ? { name: manifest.name, manifest, status: 'disabled', builtin: true, meta: bundleMeta }
        : { name: manifest.name, manifest, status: 'disabled' },
      tim,
    };
  }
  // 4b) 权限门禁（C11-2 装载期一票否决）：manifest.permissions 声明的
  //     权限类未被 plugins.json granted 段全覆盖 → 不装载（blocked 状态
  //     ——不 import 插件代码，缺哪些授权对设置面板可见）。无声明 = 零
  //     摩擦直接装载（纯 JS 插件）。
  const declaredPerms = manifest.permissions ?? [];
  if (declaredPerms.length > 0) {
    const grantedFor = deps.granted.get(manifest.name) ?? new Set<string>();
    const missing = declaredPerms.filter((p) => !grantedFor.has(p));
    if (missing.length > 0) {
      return {
        ok: false,
        record: {
          ...(isBuiltinNamed ? { builtin: true as const, meta: bundleMeta } : {}),
          name: manifest.name,
          manifest,
          status: 'blocked',
          missingPermissions: missing,
        },
        tim,
      };
    }
  }
  // 4b') 宿主面指纹对拍（保险丝 a′，2026-09-14 立法）：产物 face.json 里的 hostApi
  //       = 构建时（与本批源码同源）的宿主面指纹。与运行时指纹不符 = 产物与 exe
  //       版本偏斜——报错直接给出两个指纹；旧版只报「缺键 X、Y」，读者得自己
  //       推断「是不是这批动了宿主面」。缺 hostApi 的产物（旧产物/第三方）跳过
  //       本闸，由下面的键集闸（4b）兜底。
  if (faceDoc != null && typeof faceDoc === 'object') {
    const declared = (faceDoc as { hostApi?: unknown }).hostApi;
    if (typeof declared === 'string' && declared.length > 0) {
      const current = hostSurfaceFingerprint();
      if (declared !== current) {
        return {
          ok: false,
          record: withBuiltinMeta(
            manifest.name,
            manifest,
            `宿主面版本偏斜（拒载防渲染期整树卸载）: 产物需宿主面 ${declared}，当前 exe 是 ${current}` +
              ' —— 本批触及了 faceDeps 面：产物不能只换产物热更，用与 exe 同源的源码树重建产物，或重建 exe',
          ),
          tim,
        };
      }
    }
  }
  // 4b) 宿主面键集对拍（保险丝 a，2026-09-03 生产事故立法）：产物 face.json
  //       声明的需求键在运行时 faceDeps 缺席 = 产物与 exe 版本偏斜——装载期
  //       拒载（偏斜产物不 import）。face.json 缺席/坏形状 = 零需求
  //       （旧产物 / 第三方 / renderers 走 renderer-host 面）——回退兼容。
  if (faceDoc != null && typeof faceDoc === 'object' && Array.isArray((faceDoc as { faceDeps?: unknown }).faceDeps)) {
    const required = (faceDoc as { faceDeps: unknown[] }).faceDeps.filter((k): k is string => typeof k === 'string');
    const have = faceDepsKeys();
    const missing = required.filter((k) => !have.has(k));
    if (missing.length > 0) {
      return {
        ok: false,
        record: withBuiltinMeta(
          manifest.name,
          manifest,
          '宿主面缺键（产物与 exe 版本偏斜，拒载防渲染期整树卸载）: ' +
            missing.join(', ') +
            ' —— 用与 exe 同源的源码树重建产物，或更新 exe',
        ),
        tim,
      };
    }
  }
  return { ok: true, dirId, manifest, bundleMeta, isBuiltinNamed, tim };
}

/** 阶段 2：模块 import + 形状校验 + 声明式包装（并发安全、无副作用）。
 *  仅 manifest（阶段 1 通过）驱动；wrapper 构造归这里，apply 执行归阶段 3。 */
async function moduleStage(entry: ManifestStageOk, deps: LoadOneDeps): Promise<ModuleStageResult> {
  const { origin, importModule } = deps;
  const { manifest, bundleMeta, isBuiltinNamed, tim } = entry;
  try {
    // 5) 导入（S5：displace 位移机制退役——产物是唯一装载面）
    const url = origin + '/' + manifest.name + '/' + manifest.entry;
    const tImport = performance.now();
    const mod = await importModule(url);
    const candidate = pickPluginObject(mod);
    if (!isPluginShape(candidate)) {
      return {
        ok: false,
        record: withBuiltinMeta(manifest.name, manifest, '插件入口未导出 { name, apply } 形状的对象'),
        tim,
      };
    }
    if (candidate.name !== manifest.name) {
      return {
        ok: false,
        record: withBuiltinMeta(
          manifest.name,
          manifest,
          '插件对象 name (' + candidate.name + ') 与 manifest.name 不一致',
        ),
        tim,
      };
    }
    // 声明式挂接（S4-4 乙机器桥 + C11-1 工具声明）：manifest 声明
    // mcpServers/tools 时包装插件——entry.apply 之后挂接（注册动作归包装
    // 层，kill/贡献注销挂同一 fiber 的 ctx.effect——插件 fiber dispose 链式
    // 停）。inject 并集补 'tools'（cordis 注入纪律；与 entry 自身 inject
    // 合并声明）。C11-1：manifest.tools 的执行函数 = entry 模块的
    // toolHandlers 命名导出（声明数据 + 执行映射一一对应，失配 → 插件
    // error 记录，失败隔离）。
    // S4：manifest.inject 并入插件对象 inject——cordis fiber PENDING 挂起
    // 语义（缺依赖不拒载，等 provide；boot 审计判全 ACTIVE）。
    const needsToolDecls = (manifest.tools?.length ?? 0) > 0;
    const needsMcp = (manifest.mcpServers?.length ?? 0) > 0;
    const needsDataDir = manifest.dataDir === true;
    const needsApp = manifest.app != null;
    // S6 P3a：activation 声明需要包装层做「声明-接线对齐」校验（见 apply 内）。
    const needsActivation = manifest.activation != null;
    const candidateInject = (candidate as { inject?: string[] }).inject ?? [];
    const manifestInject = manifest.inject ?? [];
    const extraInject = manifestInject.filter((n) => !candidateInject.includes(n));
    const needsWrapper =
      needsToolDecls || needsMcp || needsDataDir || needsApp || needsActivation || extraInject.length > 0;
    const target = needsWrapper
      ? {
          name: candidate.name,
          inject: [
            ...new Set([
              ...candidateInject,
              ...extraInject,
              ...(needsToolDecls || needsMcp ? ['tools'] : []),
              // S6 P3a：声明 activation 的插件必然要调 ctx.activation.declare ——
              // 装载层补 inject（与 tools 同款纪律：inject 并集，不要求插件作者
              // 两处手工同步）。
              ...(needsActivation ? ['activation'] : []),
            ]),
          ],
          async apply(ctx: Context) {
            // S1（app shell 件 B）：数据地盘先于插件代码到位（装载期基础设施
            // 动作；manifest.dataDir 声明 = 要地盘的显式契约）。分配失败 =
            // 装载失败记录（失败隔离——apply 抛错走 error 路径，设置面板可见）。
            // 路径捕获传给 MCP 机器桥（S2——受治进程 spawn 注入
            // LANTAI_PLUGIN_DATA_DIR，进程用自身 fs 读写自己的地盘）。
            let dataDirPath: string | undefined;
            if (needsDataDir) {
              try {
                dataDirPath = await deps.pluginDataEnsure(manifest.name);
              } catch (e) {
                throw new Error('插件数据目录分配失败: ' + errText(e));
              }
            }
            await candidate.apply(ctx);
            if (needsToolDecls) {
              mountToolDeclarations(ctx, manifest.name, manifest.tools ?? [], mod.toolHandlers);
            }
            let mcpFace: GovernedActivationFace | null = null;
            if (needsMcp) {
              mcpFace = await registerMcpServerTools(ctx, manifest.name, manifest.mcpServers ?? [], deps.mcpBridgeIO, {
                dataDirPath,
              });
            }
            // S6 P3d：manifest 声明 activation 的插件，其**受治进程的 lazy 档**
            // 拉起/停止由激活账驱动（所有持有它的卷都关 ⇒ 进程停，不再等空闲
            // 回收）。插件自己在 apply 里登记过就不用推导（自登记优先）。
            if (manifest.activation && mcpFace) {
              const activation = ctx.get('activation');
              if (activation && !activation.has(manifest.name)) {
                const face = mcpFace;
                activation.declare(manifest.name, {
                  resources: manifest.activation.resources,
                  exclusive: manifest.activation.exclusive,
                  start: () => face.startLazy(),
                  stop: () => face.stopLazy(),
                });
              }
            }
            // S6 P3a/P3d：「声明了开关却没接线」= 手误，装载期 fail loud（不静默
            // 放过）——声明 `lazy: true` 的插件必须真的登记了激活回调（apply 里
            // 自登记，或装载层从受治进程推导出来），否则它的副作用永不启动，
            // 而用户看到的是一个「装上了」的插件。
            if (manifest.activation?.lazy === true) {
              const activation = ctx.get('activation');
              if (activation && !activation.has(manifest.name)) {
                throw new Error(
                  'manifest 声明 activation.lazy 但 apply 未登记激活回调（ctx.activation.declare）、也无 lazy 档受治进程可推导——副作用将永不启动',
                );
              }
            }
            // S3（app shell 件 A）：manifest.app 声明 → 窗口定义登记（装载只
            // 登记数据，开窗才实例化视口；卸载收口挂 ctx.effect——摘定义 +
            // 关窗 + 治理器关窗通知）。
            if (needsApp && manifest.app) {
              mountPluginApp(ctx, manifest.name, manifest.app, deps.origin);
            }
          },
        }
      : candidate;
    tim.importMs = performance.now() - tImport;
    return { ok: true, manifest, bundleMeta, isBuiltinNamed, target, tim };
  } catch (e) {
    // 装载失败：error 记录可见（S5：位移恢复已退役——产物是唯一装载面）。
    return { ok: false, record: withBuiltinMeta(manifest.name, manifest, errText(e)), tim };
  }
}

/** 装载单个插件（阶段 1→2→3 串行组合；给 activateExternalPlugin 增量装载用）。
 *  任何一步失败 → error 记录（失败隔离，永不抛出）。返回 fiber
 *  （D6 运行时热重载的 dispose 锚点——未装载态为 null）。 */
async function loadOne(
  root: Context,
  dirId: string,
  deps: LoadOneDeps,
): Promise<{ record: PluginRecord; fiber: Fiber | null }> {
  const t0 = performance.now();
  const s1 = await manifestStage(dirId, deps);
  if (!s1.ok) {
    s1.tim.totalMs = performance.now() - t0;
    s1.tim.status = s1.record.status;
    bootTiming.push(s1.tim);
    return { record: s1.record, fiber: null };
  }
  const s2 = await moduleStage(s1, deps);
  if (!s2.ok) {
    s2.tim.totalMs = performance.now() - t0;
    s2.tim.status = s2.record.status;
    bootTiming.push(s2.tim);
    return { record: s2.record, fiber: null };
  }
  try {
    const tApply = performance.now();
    const fiber = await root.plugin(s2.target);
    s2.tim.applyMs = performance.now() - tApply;
    s2.tim.totalMs = performance.now() - t0;
    s2.tim.status = 'active';
    bootTiming.push(s2.tim);
    return {
      record: s2.isBuiltinNamed
        ? { name: s2.manifest.name, manifest: s2.manifest, status: 'active', builtin: true, meta: s2.bundleMeta }
        : { name: s2.manifest.name, manifest: s2.manifest, status: 'active' },
      fiber,
    };
  } catch (e) {
    // apply 抛错 → 装载失败记录（失败隔离）
    s2.tim.totalMs = performance.now() - t0;
    bootTiming.push(s2.tim);
    return { record: withBuiltinMeta(s2.manifest.name, s2.manifest, errText(e)), fiber: null };
  }
}

/** 内置插件的 error 记录补 meta（设置面板按 builtin+meta 分组陈列——
 *  产物域记录不补位会掉进「已安装」组）。 */
function withBuiltinMeta(name: string, manifest: PluginManifest | null, error: string): PluginRecord {
  const meta = FIRST_PARTY_MANIFEST[name];
  return meta != null
    ? { name, manifest, status: 'error', error, builtin: true, meta }
    : errorRecord(name, manifest, error);
}

/** 取 default 或模块本身为 plugin 对象（WO-S0B 约定）。 */
function pickPluginObject(mod: Record<string, unknown>): unknown {
  if (mod != null && typeof mod === 'object' && 'default' in mod) {
    return mod.default;
  }
  return mod;
}

/** 运行时形状守卫：插件入口必须是 { name, apply }（WO-S0B 契约）。
 * 唯一的 as 在守卫边界——字段形状已逐项运行时验证，非静默数据解包。 */
function isPluginShape(value: unknown): value is LantaiPlugin {
  if (value == null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && record.name !== '' && typeof record.apply === 'function';
}

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

import { createElement } from 'react';
import { codeRuntimePlugin } from '../agent/code-run/runtime-service';
import { builtinFsPlugin } from '../agent/fs-provider';
import { builtinShellPlugin } from '../agent/shell-provider';
import { inProcessSubagentPlugin } from '../agent/subagent-provider';
import { useShellStore } from '../app/shell-store';
import { capabilitiesServicePlugin } from '../composition/capability-service';
import { firstPartyCapabilityPlugins } from '../composition/first-party-capabilities';
import { firstPartyPromptPlugins } from '../composition/first-party-prompts';
import { firstPartyToolPlugins } from '../composition/first-party-tools';
import { fsServicePlugin } from '../composition/fs-service';
import { hooksServicePlugin } from '../composition/hook-service';
import { overlayServicePlugin } from '../composition/overlay-service';
import { promptsServicePlugin } from '../composition/prompt-service';
import { rendererServicePlugin } from '../composition/renderer-service';
import { compositionServicesPlugin } from '../composition/services';
import { shellServicePlugin } from '../composition/shell-service';
import { spaceServicePlugin } from '../composition/space-service';
import { subagentsServicePlugin } from '../composition/subagent-service';
import type { Context } from '../cordis';
import { paperPlugin } from '../paper/paper-plugin';
import { getProxyPort } from '../provider/transport';
import { type PluginRecord, usePluginStore } from '../state/plugin-store';
import { canvasNavPlugin } from './canvas-nav-plugin';
import { composeDockPlugin } from './compose-dock-plugin';
import { llmAdaptersPlugin } from './llm-adapters-plugin';
import { type McpBridgeIO, registerMcpServerTools } from './mcp-bridge';
import { settingsPlugin } from './settings-plugin';
import { spaceDemoPlugin } from './space-demo-plugin';
import { mountToolDeclarations } from './tool-declarations';
import { type LantaiPlugin, type PluginManifest, validateManifest } from './types';

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
 * ）。P4 B④ 收官（2026-08-23）：表尾接第一方 prompt 段插件清单（13 段全量经
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
 * 收官（2026-08-24）：表尾接第一方 capability 插件清单（十五项会话级
 * 能力全量经 ctx.capabilities 贡献——单一真源 composition/first-party-
 * capabilities.ts，贡献序 = 清单序 = 迁移前出厂表序；出厂
 * builtinCapabilities() 退役，本通道是出厂 capability 面唯一来源）。 */
const BUILTIN_PLUGINS: LantaiPlugin[] = [
  compositionServicesPlugin,
  llmAdaptersPlugin,
  subagentsServicePlugin,
  inProcessSubagentPlugin,
  fsServicePlugin,
  builtinFsPlugin,
  shellServicePlugin,
  builtinShellPlugin,
  spaceServicePlugin,
  overlayServicePlugin,
  codeRuntimePlugin,
  rendererServicePlugin,
  promptsServicePlugin,
  hooksServicePlugin,
  capabilitiesServicePlugin,
  paperPlugin,
  settingsPlugin,
  spaceDemoPlugin,
  canvasNavPlugin,
  composeDockPlugin,
  ...firstPartyToolPlugins(),
  ...firstPartyPromptPlugins(),
  ...firstPartyCapabilityPlugins(),
];

// ── 插件宿主桥（S4-5）──
// 外部插件经 webview 动态 import 装载——模块语境没有裸 import 解析面
// （无包管理器、无 import map，平台契约 = 插件自包含）。需要 React 或
// 通知能力的插件经 window.__lantai_plugin_host__ 取宿主能力：
//   - createElement：React.createElement（面板组件构造——无 JSX 插件的路由）；
//   - notify：状态栏通知（命令动作的最小 UI 反馈面）。
// 桥在装载第一方插件前注入（装载期红线：注入是平台动作不是插件副作用）。
declare global {
  interface Window {
    __lantai_plugin_host__?: {
      createElement: typeof createElement;
      notify: (text: string) => void;
    };
  }
}

function installPluginHostBridge(): void {
  if (typeof globalThis !== 'undefined') {
    (globalThis as { __lantai_plugin_host__?: unknown }).__lantai_plugin_host__ = {
      createElement,
      notify: (text: string) => useShellStore.getState().pushStatus(text),
    };
  }
}

/** 装载第一方插件表。返回根 Context（main.ts 接线链式取用）。
 * 同步装载（apply 内的 provide 同步生效——外部插件的 inject 依赖立即可解析）；
 * fiber await 的 rejection 显式接住（内核装配失败必须可见，不留 unhandled）。
 * S4-5：装载前先注入插件宿主桥（外部插件的 createElement/notify 来源）。 */
export function loadBuiltinPlugins(root: Context): Context {
  installPluginHostBridge();
  for (const plugin of BUILTIN_PLUGINS) {
    const fiber = root.plugin(plugin);
    void Promise.resolve(fiber).catch((err: unknown) => {
      console.error('[plugins] 第一方插件装载失败:', plugin.name, err);
    });
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

/** 外部插件装载主入口（main.ts 引导期调用；永不 reject）。 */
export async function loadExternalPlugins(root: Context, opts: LoadExternalPluginsOptions = {}): Promise<void> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const importModule = opts.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
  const mcpBridgeIO = opts.mcpBridgeIO;
  try {
    const origin = opts.origin ?? (await resolveOrigin());
    if (!origin) return; // 无后端通道（浏览器 mock / 代理未起）——非错误
    const index = await fetchJson(fetchImpl, origin + '/');
    if (!Array.isArray(index)) {
      console.warn('[plugins] 装载通道索引不可用');
      return;
    }
    const { disabled, granted } = await readPluginsState(fetchImpl, origin);
    const records: PluginRecord[] = [];
    for (const dirId of index) {
      records.push(
        await loadOne(root, String(dirId), { origin, disabled, granted, fetchImpl, importModule, mcpBridgeIO }),
      );
    }
    usePluginStore.getState().setPlugins(records);
  } catch (e) {
    // 通道级失败（内部已全捕获，理论不可达；防御性兜底防未处理拒绝）
    console.warn('[plugins] 装载通道失败:', e);
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
}

/** 装载单个插件；任何一步失败 → error 记录（失败隔离，永不抛出）。 */
async function loadOne(root: Context, dirId: string, deps: LoadOneDeps): Promise<PluginRecord> {
  const { origin, fetchImpl, importModule } = deps;
  // 1) manifest 获取 + 校验
  const raw = await fetchJson(fetchImpl, origin + '/' + dirId + '/manifest.json');
  if (raw == null) return errorRecord(dirId, null, 'manifest.json 缺失或不可解析');
  const validated = validateManifest(raw);
  if (!validated.ok) return errorRecord(dirId, null, 'manifest 校验失败: ' + validated.error);
  const manifest = validated.manifest;
  // 2) 名字与目录一致（URL 按名字寻址磁盘目录，不一致 = 装不上）
  if (manifest.name !== dirId) {
    return errorRecord(dirId, manifest, 'manifest.name (' + manifest.name + ') 与目录名 (' + dirId + ') 不一致');
  }
  // 3) inject 依赖存在性（缺 → error 状态，WO-S0B 装载期校验）
  if (manifest.inject) {
    const missing = manifest.inject.filter((name) => root.reflect.get(name) == null);
    if (missing.length > 0) return errorRecord(manifest.name, manifest, '缺少依赖服务: ' + missing.join(', '));
  }
  // 4) disabled 跳过（不 import）
  if (deps.disabled.has(manifest.name)) {
    return { name: manifest.name, manifest, status: 'disabled' };
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
        name: manifest.name,
        manifest,
        status: 'blocked',
        missingPermissions: missing,
      };
    }
  }
  // 5) 导入 + 装配（cordis fiber 记录生命周期；apply 抛错 → await reject）
  try {
    const url = origin + '/' + manifest.name + '/' + manifest.entry;
    const mod = await importModule(url);
    const candidate = pickPluginObject(mod);
    if (!isPluginShape(candidate)) {
      return errorRecord(manifest.name, manifest, '插件入口未导出 { name, apply } 形状的对象');
    }
    if (candidate.name !== manifest.name) {
      return errorRecord(manifest.name, manifest, '插件对象 name (' + candidate.name + ') 与 manifest.name 不一致');
    }
    // 声明式挂接（S4-4 乙机器桥 + C11-1 工具声明）：manifest 声明
    // mcpServers/tools 时包装插件——entry.apply 之后挂接（注册动作归包装
    // 层，kill/贡献注销挂同一 fiber 的 ctx.effect——插件 fiber dispose 链式
    // 停）。inject 并集补 'tools'（cordis 注入纪律；与 entry 自身 inject
    // 合并声明）。C11-1：manifest.tools 的执行函数 = entry 模块的
    // toolHandlers 命名导出（声明数据 + 执行映射一一对应，失配 → 插件
    // error 记录，失败隔离）。
    const needsToolDecls = (manifest.tools?.length ?? 0) > 0;
    const needsMcp = (manifest.mcpServers?.length ?? 0) > 0;
    const target =
      needsToolDecls || needsMcp
        ? {
            name: candidate.name,
            inject: [...new Set([...((candidate as { inject?: string[] }).inject ?? []), 'tools'])],
            async apply(ctx: Context) {
              await candidate.apply(ctx);
              if (needsToolDecls) {
                mountToolDeclarations(ctx, manifest.name, manifest.tools ?? [], mod.toolHandlers);
              }
              if (needsMcp) {
                await registerMcpServerTools(ctx, manifest.name, manifest.mcpServers ?? [], deps.mcpBridgeIO);
              }
            },
          }
        : candidate;
    await root.plugin(target);
    return { name: manifest.name, manifest, status: 'active' };
  } catch (e) {
    return errorRecord(manifest.name, manifest, errText(e));
  }
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

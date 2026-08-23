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
import { useShellStore } from '../app/shell-store';
import { firstPartyToolPlugins } from '../composition/first-party-tools';
import { promptsServicePlugin } from '../composition/prompt-service';
import { rendererServicePlugin } from '../composition/renderer-service';
import { compositionServicesPlugin } from '../composition/services';
import type { Context } from '../cordis';
import { paperPlugin } from '../paper/paper-plugin';
import { getProxyPort } from '../provider/transport';
import { type PluginRecord, usePluginStore } from '../state/plugin-store';
import { settingsPlugin } from './settings-plugin';
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
}

/** 插件静态资源 origin 构造（端口运行时解析；WO-S0A spike 验证过的通道）。 */
export function pluginAssetsOrigin(port: number): string {
  return 'http://127.0.0.1:' + port + '/plugins';
}

/** 第一方插件表（编译期 bundle 内，不走磁盘通道；S3 起逐域填充）。
 * 表序 = 装配序。首项固定为组合层四 service（内核线第 3 条的实体化——
 * panels/commands/tools/providers 注册表本身，常驻且先于外部插件，
 * 保证外部插件 manifest 的 inject 依赖可解析）。P3：codeRuntime 服务行
 * （agent/code-run——执行腰，四 service 之后）。V3b：块渲染器第五 service。
 * S3：settings 域行化（面板 + 命令双贡献）。P4 A-1（2026-08-23）：
 * prompts 第六 service（system-prompt 段贡献注册表）。P4 B①（2026-08-23）：
 * 表尾接第一方工具域插件清单（git/search 两域经 ctx.tools 贡献工具，
 * 单一真源 composition/first-party-tools.ts——贡献行序 = 清单序，且必须
 * 列于四 service 之后使 inject ['tools'] 可解析）。 */
const BUILTIN_PLUGINS: LantaiPlugin[] = [
  compositionServicesPlugin,
  codeRuntimePlugin,
  rendererServicePlugin,
  promptsServicePlugin,
  paperPlugin,
  settingsPlugin,
  ...firstPartyToolPlugins(),
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

/** 读启用态（plugins.json：{"disabled": [...]}；缺文件/坏形状 = 空集）。 */
async function readDisabledSet(fetchImpl: FetchLike, origin: string): Promise<Set<string>> {
  const raw = await fetchJson(fetchImpl, origin + '/plugins.json');
  if (raw == null || typeof raw !== 'object') return new Set();
  const disabled = (raw as { disabled?: unknown }).disabled;
  if (!Array.isArray(disabled)) return new Set();
  return new Set(disabled.filter((name): name is string => typeof name === 'string'));
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
  try {
    const origin = opts.origin ?? (await resolveOrigin());
    if (!origin) return; // 无后端通道（浏览器 mock / 代理未起）——非错误
    const index = await fetchJson(fetchImpl, origin + '/');
    if (!Array.isArray(index)) {
      console.warn('[plugins] 装载通道索引不可用');
      return;
    }
    const disabled = await readDisabledSet(fetchImpl, origin);
    const records: PluginRecord[] = [];
    for (const dirId of index) {
      records.push(await loadOne(root, String(dirId), { origin, disabled, fetchImpl, importModule }));
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
  fetchImpl: FetchLike;
  importModule: (url: string) => Promise<Record<string, unknown>>;
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
    await root.plugin(candidate);
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件医生（2026-11-23 契约工具包 · 批 3）——**只读**聚合。
//
// 住 `state/` 而不是 `plugins/` 顶层：后者是特权区、自由度是**负数**
// （tests/privileged-zone-freeze.test.ts 封口「装载链只减不增」），而本模块不是装载链的
// 一环——它是既有 store / 注册表 / 账的**读面拼装**。
//
// 纪律：
//   - 只读：不改任何账、不建第二条真源。每个字段都指向既有的 store / 注册表读数
//     （plugin-store 记录 / mcp-bridge 治理器 / plugin-window-store / activation 账 /
//     rpc-contract 的路径面），本模块只做「一处可见」的拼装。
//   - 内置插件没有磁盘目录（或 plugin_dir 对内核名拒绝）⇒ null 不是错误，界面显示
//     「内置」。诊断不许把「本来就没有」渲染成「坏了」。
//   - 路径读面可注入（生产 = RPC；测试注入 fake）——诊断不新增 RPC 通路。

import { activationFailure, activationStates } from '../composition/activation';
import { OPEN_SURFACE_CONTRACT_VERSION } from '../composition/contract-version';
import { ensurePluginDataDir } from '../plugins/data-fs';
import { type GovernorStateView, governorStatesFor } from '../plugins/mcp-bridge';
import { typedRpc } from '../rpc-contract';
import type { PluginRecord } from './plugin-store';
import { usePluginWindowStore } from './plugin-window-store';

/** 路径读面（生产 = RPC；测试注入——读面不制造第二条通路）。 */
export interface DiagnosticsPaths {
  /** 插件目录绝对路径（不可得 = null，例如内置）。 */
  pluginDir: (name: string) => Promise<string | null>;
  /** 数据地盘绝对路径（只对声明 dataDir 的插件调用；ensure 幂等）。 */
  dataDir: (name: string) => Promise<string | null>;
}

const rpcPaths: DiagnosticsPaths = {
  pluginDir: async (name) => {
    try {
      const dir = await typedRpc('plugin_dir', { name });
      return typeof dir === 'string' && dir.trim() !== '' ? dir : null;
    } catch {
      return null; // 内置 / 未落盘插件没有目录——读面不制造错误
    }
  },
  dataDir: async (name) => {
    try {
      return await ensurePluginDataDir(name);
    } catch {
      return null;
    }
  },
};

/** 单个插件的诊断快照（固定形状——UI 表 / 复制 JSON 共用一份）。 */
export interface PluginDiagnostics {
  name: string;
  /** 第一方（编译期内核或出厂产物）。 */
  builtin: boolean;
  status: PluginRecord['status'];
  /** 装载/校验错误原文（null = 无）。 */
  error: string | null;
  /** 非阻断警告（未知顶层字段 / engines 版本未知…）。 */
  warnings: string[];
  /** manifest 摘要（null = 无 manifest，例如内核插件或校验失败）。 */
  manifest: { version: string; entry: string } | null;
  /** 当前开放面契约版本（诊断时一眼看得出「产物与宿主是否同代」）。 */
  contractVersion: number;
  /** 插件目录（null = 内置 / 无磁盘目录）。 */
  pluginDir: string | null;
  /** 数据地盘（null = 未声明 dataDir 或取不到）。 */
  dataDir: string | null;
  tools: {
    /** 声明式工具名（manifest.tools）。 */
    declared: string[];
    /** 每个受治 MCP server 的状态。 */
    mcp: GovernorStateView[];
  };
  windows: {
    /** 是否登记了窗口定义（manifest.app）。 */
    declared: boolean;
    mode: string | null;
    /** 当前开着的窗数。 */
    open: number;
  };
  activation: {
    declared: boolean;
    lazy: boolean;
    resources: string[];
    exclusive: string[];
    /** 激活账上是否已 started（未声明 activation = false）。 */
    started: boolean;
    /** 激活失败原因（诊断第四栏同源；null = 无）。 */
    failure: string | null;
  };
}

/** 聚合一个插件的诊断（唯一入口；UI 与测试共用）。 */
export async function collectPluginDiagnostics(
  record: PluginRecord,
  paths: DiagnosticsPaths = rpcPaths,
): Promise<PluginDiagnostics> {
  const { name } = record;
  const manifest = record.manifest;
  const declared = manifest?.activation;
  const state = activationStates().find((s) => s.plugin === name);
  const windows = usePluginWindowStore.getState();
  const def = windows.defs[name];
  return {
    name,
    builtin: record.builtin === true,
    status: record.status,
    error: record.error ?? null,
    warnings: [...(record.warnings ?? [])],
    manifest: manifest ? { version: manifest.version, entry: manifest.entry } : null,
    contractVersion: OPEN_SURFACE_CONTRACT_VERSION,
    // 内核插件（builtin 且无 manifest）没有磁盘目录——不问 RPC，直接 null
    pluginDir: record.builtin === true && manifest === null ? null : await paths.pluginDir(name),
    dataDir: manifest?.dataDir === true ? await paths.dataDir(name) : null,
    tools: {
      declared: (manifest?.tools ?? []).map((t) => t.name),
      mcp: governorStatesFor(name),
    },
    windows: {
      declared: def !== undefined,
      mode: def?.mode ?? null,
      open: windows.windows.filter((w) => w.pluginName === name).length,
    },
    activation: {
      declared: declared !== undefined,
      lazy: declared?.lazy === true,
      resources: [...(declared?.resources ?? [])],
      exclusive: [...(declared?.exclusive ?? [])],
      started: state?.started === true,
      failure: activationFailure(name) ?? state?.failure ?? null,
    },
  };
}

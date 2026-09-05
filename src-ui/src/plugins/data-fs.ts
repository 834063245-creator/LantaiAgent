// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件数据目录宿主面（app shell 四件套 · 件 B，S1）——装载期 ensure 与
// 宿主桥 fs 面的 TS 侧。Rust 真源 commands/plugin_data.rs（名字 + rel 双围栏
// + canonicalize 前缀，越界/junction 逃逸拒绝）；本文件只做调用面。
//
// 信任模型：桥面插件名是参数（已装插件全信任区，与桥 rpc/mods 同级——
// 不做调用方绑定）；S3 的 iframe 窗口面才由宿主容器侧绑定插件身份。

import { typedJsonRpc, typedRpc } from '../rpc-contract';

/** plugin_data_list 返回元素（Rust 同形；目录在前、名字序）。 */
export interface PluginDataEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

/** plugin_data_list 返回形状。 */
export interface PluginDataListResult {
  entries: PluginDataEntry[];
}

/** plugin_data_ensure 返回形状。 */
export interface PluginDataEnsureResult {
  path: string;
}

/** 装载期分配（loader wrapper apply 消费；幂等）。失败 = 装载失败记录
 *  （错误不静默——设置面板可见）。返回数据目录绝对路径（S2 受治进程
 *  spawn 注入路径的同一入口）。 */
export async function ensurePluginDataDir(name: string): Promise<string> {
  const { path } = await typedJsonRpc('plugin_data_ensure', { name });
  return path;
}

/** 宿主桥 fs 面：读写列删锁死在 `<dataRoot>/<插件名>/`（围栏在 Rust——
 *  名字 + rel 双段校验 + canonicalize 前缀，越界即拒绝；插件根 read/write/
 *  delete 拒绝，list 可枚举根）。 */
export const pluginDataFs = {
  ensure: (name: string) => typedJsonRpc('plugin_data_ensure', { name }),
  list: (name: string, path = '') => typedJsonRpc('plugin_data_list', { name, path }),
  read: (name: string, path: string) => typedRpc('plugin_data_read', { name, path }),
  write: (name: string, path: string, content: string) => typedRpc('plugin_data_write', { name, path, content }),
  delete: (name: string, path: string) => typedRpc('plugin_data_delete', { name, path }),
} as const;

export type PluginDataFs = typeof pluginDataFs;

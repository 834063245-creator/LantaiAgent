// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugin-store — 插件装载状态（WO-S0B；2026-08-29 收编第一方插件）。
// app 级单例 store（CONVENTIONS §1.2）。
// 历史职责：外部插件装载状态（磁盘通道）。2026-08-29 起：**全部插件**的
// 装载结果唯一权威源——loadBuiltinPlugins 写入第一方记录（builtin=true +
// first-party-manifest 元数据），loadExternalPlugins 写入第三方记录
// （manifest 携带元数据）。UI（设置面板插件 tab / devtools）从这里读。
// 分层铁律：store 落 src/state/（WO-S0B 红线：不放 src/ui/）。

import { create } from 'zustand';
import type { FirstPartyPluginMeta } from '../plugins/first-party-manifest';
import type { PluginManifest } from '../plugins/types';

export type PluginStatus = 'active' | 'error' | 'disabled' | 'blocked';

export interface PluginRecord {
  name: string;
  /** 校验失败 / 取不到 manifest 时为 null（此时 name 来自目录 id）。 */
  manifest: PluginManifest | null;
  status: PluginStatus;
  /** 失败原因（status = error 时必填）。 */
  error?: string;
  /** 待授权的权限类（status = blocked 时必填——C11-2 装载期一票否决：
   *  manifest.permissions 声明未被 plugins.json granted 段覆盖的部分）。 */
  missingPermissions?: string[];
  /** 第一方插件（编译期 bundle 内，非磁盘通道）。缺省 = 第三方。 */
  builtin?: boolean;
  /** 第一方元数据（builtin=true 时必有——守护测试钉死）。 */
  meta?: FirstPartyPluginMeta;
}

interface PluginStoreState {
  plugins: PluginRecord[];
  /** 全量替换（测试/复位用；历史语义保留）。 */
  setPlugins: (plugins: PluginRecord[]) => void;
  /** 按 name 合并（覆盖同名、保留其余）——第一方 boot 与第三方异步装载
   *  互不冲刷：loadBuiltinPlugins 先跑，loadExternalPlugins 后到不得清掉
   *  第一方记录。 */
  mergePlugins: (records: PluginRecord[]) => void;
  /** 增量更新（D6 运行时热重载）：按 name 替换或追加记录。 */
  upsertPlugin: (record: PluginRecord) => void;
  /** 按 name 就地改状态（第一方启用/禁用切换——保留 meta/error 等字段）。 */
  setPluginStatus: (name: string, status: PluginStatus) => void;
  /** 移除记录（D6：卸载后从清单撤下）。 */
  removePlugin: (name: string) => void;
}

export const usePluginStore = create<PluginStoreState>((set) => ({
  plugins: [],
  setPlugins: (plugins) => set({ plugins }),
  mergePlugins: (records) =>
    set((s) => {
      const byName = new Map(s.plugins.map((p) => [p.name, p]));
      for (const record of records) byName.set(record.name, record);
      return { plugins: [...byName.values()] };
    }),
  upsertPlugin: (record) =>
    set((s) => {
      const rest = s.plugins.filter((p) => p.name !== record.name);
      // 稳定序：按 name 插回原位或表尾（UI 清单不因增量更新跳序）
      const idx = s.plugins.findIndex((p) => p.name === record.name);
      if (idx < 0) return { plugins: [...s.plugins, record] };
      return { plugins: [...rest.slice(0, idx), record, ...rest.slice(idx)] };
    }),
  setPluginStatus: (name, status) =>
    set((s) => ({ plugins: s.plugins.map((p) => (p.name === name ? { ...p, status } : p)) })),
  removePlugin: (name) => set((s) => ({ plugins: s.plugins.filter((p) => p.name !== name) })),
}));

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// plugin-store — 外部插件装载状态（WO-S0B）。app 级单例 store（CONVENTIONS §1.2）。
// 本阶段无消费 UI（S1 四 service / S4 安装 UI 才接入）；它是「装载结果可见」的
// 唯一权威源——loader 写入，devtools / 未来设置面板读取。
// 分层铁律：store 落 src/state/（WO-S0B 红线：不放 src/ui/）。

import { create } from 'zustand';
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
}

interface PluginStoreState {
  plugins: PluginRecord[];
  setPlugins: (plugins: PluginRecord[]) => void;
}

export const usePluginStore = create<PluginStoreState>((set) => ({
  plugins: [],
  setPlugins: (plugins) => set({ plugins }),
}));

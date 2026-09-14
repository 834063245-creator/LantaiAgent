// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// preset-store（S4-0）— preset realm 的运行时状态（设计件 §2.2）。
//
// 状态面：
//   - roster：发现的 preset 清单（内置表 + 用户目录合并，内置同 id 胜）；
//   - selected：当前生效 preset id（缺省 'standard'）；
//   - error：preset 层解析失败原因（F1 捕获网可见面，2026-09-15）——null = 无错误。
//
// 装配消费（S4-1a 接线）：boot 壳解析读 selected（shell 域）+ Agent 装配
// 读 selected（tools/prompt/capabilities 域）；preset 文件自己决定说哪些域。
// app 级单例 store（CONVENTIONS §1.2），初始态 = 内置表（无通道/发现前即
// 可用——standard/minimal 是代码常量）。

import { create } from 'zustand';
import { builtinPresets, type PresetEntry } from '../composition/presets';

export interface PresetStoreState {
  /** 发现层合并后的 preset 清单（内置行恒在）。 */
  roster: PresetEntry[];
  /** 当前生效 preset id（缺省 standard；未知 id 由解析侧回退 factory）。 */
  selected: string;
  /** preset 层最近一次解析失败原因（null = 无）。
   *  唯一写入口 = composition/preset-assembly 的 noteSelectionError——行 id
   *  不可寻址（插件被禁用 / 写错 id）时解析抛错，该错必须可见：解析侧回退
   *  「只叠用户层」的组合，失败原因在这里（设置面板「组合」节渲染）。
   *  旧口径（发现层报 broken 即够）不成立：发现层只跑 schema，行 id 能不能
   *  寻址只有真解析才知道（2026-09-15 审计 F1）。 */
  error: string | null;
  /** 替换 roster（discovery 完成时写入；内置同 id 胜的合并在 discovery 侧）。 */
  setRoster: (roster: PresetEntry[]) => void;
  /** 选择 preset（装配作用域下次装配生效；壳作用域重启生效——§2.1）。 */
  select: (id: string) => void;
  /** 记录/清除解析失败原因（noteSelectionError 专用）。 */
  setError: (error: string | null) => void;
}

export const usePresetStore = create<PresetStoreState>((set) => ({
  roster: builtinPresets(),
  selected: 'standard',
  error: null,
  setRoster: (roster) => set({ roster }),
  select: (id) => set({ selected: id }),
  setError: (error) => set({ error }),
}));

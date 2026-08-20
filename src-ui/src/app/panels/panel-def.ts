// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P3：dock 面板注册表 — DockRail（轨道按钮）与 DockPanel（面板容器）的唯一清单。
// 增删面板只改这里；开合状态在 state/dock-store，不在本表。
// S4-1.5 消费闭环（设计件 §2.3）：清单源从「PANEL_DEFS 常量」扩为
// panelDefs() = 常量 + ctx.panels 贡献（合流点不是改写点——常量面零改动；
// 贡献变更经 state/panel-defs-store 的 tick 信号即时生效）。

import type { ComponentType } from 'react';
import { activePanelContributions } from '../../composition/services';
import { AgentsPanel } from './AgentsPanel';
import { CheckPanel } from './CheckPanel';
import { ConstraintsPanel } from './ConstraintsPanel';
import { DataflowPanel } from './DataflowPanel';
import { SettingsPanel } from './SettingsPanel';
import { TasksPanel } from './TasksPanel';

export interface PanelDef {
  /** 面板 id——S1-5 起 string 开集（原 DockPanelId union 退役） */
  id: string;
  /** 轨道侧；null = 不上轨道（命令面板 / 快捷键唤起） */
  side: 'left' | 'right' | null;
  title: string;
  icon: string;
  /** 面板内提供「问 Agent」入口 */
  askAgent?: boolean;
  /** 关闭即卸载、重开重置状态（对齐旧 Controller 的 unmount 语义）；
   *  缺省常驻挂载 + class 切换（保 CSS 滑入滑出过渡） */
  unmountOnClose?: boolean;
  component: ComponentType;
}

export const PANEL_DEFS: PanelDef[] = [
  { id: 'check', side: 'right', title: '简报', icon: 'check', askAgent: true, component: CheckPanel },
  { id: 'constraints', side: 'right', title: '约束', icon: 'constraints', askAgent: true, component: ConstraintsPanel },
  { id: 'dataflow', side: null, title: '数据流', icon: 'dataflow', unmountOnClose: true, component: DataflowPanel },
  { id: 'settings', side: null, title: '设置', icon: 'settings', unmountOnClose: true, component: SettingsPanel },
  { id: 'agents', side: 'right', title: '智能体', icon: 'agent', askAgent: false, component: AgentsPanel },
  { id: 'tasks', side: 'right', title: '待办', icon: 'task', askAgent: false, component: TasksPanel },
];

// ── 装载期运行时校验（S1-5：id 从编译期 union 约束迁到运行时清单校验）──
// union 退役后合法 id 的守门在这里：重复 id / 缺组件在模块加载时直接 throw
// （错误不静默——对齐 composition/services ContributionRegistry 的装载期
// 拒绝语义）。外部插件面板（S2/S4）将经 PanelsService 注册走同款校验。
{
  const seen = new Set<string>();
  for (const def of PANEL_DEFS) {
    if (seen.has(def.id)) {
      throw new Error('[panel-def] duplicate panel id "' + def.id + '" —— 装载期拒绝');
    }
    if (!def.component) {
      throw new Error('[panel-def] panel "' + def.id + '" 缺 component —— 装载期拒绝');
    }
    seen.add(def.id);
  }
}

// ── S4-1.5 消费闭环合流点（设计件 §2.3）──

/**
 * 有效面板清单：内置常量 + ctx.panels 贡献（即时生效——贡献 register/
 * dispose 时 panel-defs-store bump，消费组件重取本函数）。
 * 合流纪律：常量面零改写；贡献与内置同 id → 内置胜（console.warn 可见）；
 * 缺 id/component 的贡献跳过（运行时形状守卫——插件代码不受编译期类型约束）。
 */
export function panelDefs(): PanelDef[] {
  const out: PanelDef[] = [...PANEL_DEFS];
  const builtinIds = new Set(PANEL_DEFS.map((d) => d.id));
  for (const c of activePanelContributions()) {
    if (c == null || typeof c.id !== 'string' || c.id === '' || !c.component) {
      console.warn('[panel-def] 无效面板贡献被跳过（缺 id/component）');
      continue;
    }
    if (builtinIds.has(c.id)) {
      console.warn('[panel-def] 面板贡献 "' + c.id + '" 与内置面板同 id——内置胜（内置 id 是部署事实）');
      continue;
    }
    out.push(c);
  }
  return out;
}

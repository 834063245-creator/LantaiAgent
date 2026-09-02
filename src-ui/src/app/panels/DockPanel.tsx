// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P3：dock 面板容器 — 按注册表挂载六个面板（全部活在单 React 树内）。
// unmountOnClose 的面板（dataflow/settings）关闭即卸载（对齐旧 Controller 的
// close=unmount 语义）；其余常驻挂载，组件内部用 class 切换保 CSS 过渡。
// S4-1.5：清单源改读 panelDefs()（常量 + 插件贡献），panelDefsTick 驱动
// 贡献变更后的即时重挂载（设计件 §2.3）。
// 保险丝 b（2026-09-03 生产事故立法）：面板组件（插件贡献面——含纸壳
// paper 面板本体）包 PluginBoundary——单面板渲染崩溃只死自己那格，
// 崩溃面可见可重试，React 整树卸载绝迹（此前产物/exe 偏斜即全 UI 死）。

import { useDockStore } from '../../state/dock-store';
import { usePanelDefsStore } from '../../state/panel-defs-store';
import { PluginBoundary } from '../PluginBoundary';
import { type PanelDef, panelDefs } from './panel-def';

function PanelSlot({ def }: { def: PanelDef }) {
  const open = useDockStore((s) => s.open[def.id]);
  if (def.unmountOnClose && !open) return null;
  const C = def.component;
  return (
    <PluginBoundary label={`面板 ${def.id}`}>
      <C />
    </PluginBoundary>
  );
}

export function DockPanel() {
  const panelDefsTick = usePanelDefsStore((s) => s.panelDefsTick);
  const defs = panelDefs();
  void panelDefsTick; // 信号驱动重渲染；清单在渲染期重取（合流点幂等）
  return (
    <>
      {defs.map((def) => (
        <PanelSlot key={def.id} def={def} />
      ))}
    </>
  );
}

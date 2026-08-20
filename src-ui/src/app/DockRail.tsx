// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// P1：左右 dock 轨道 — 替代旧 #left-tabs / #right-tabs。
// P3：面板清单改读 panel-def 注册表；开合状态改读 dock-store（原 shell-store.panels 快照链已删）。
// 行为对齐旧 updateTabs：本侧有面板打开时整条轨道隐藏；按钮激活态跟面板开合。
// S4-1.5：清单源改读 panelDefs()（常量 + 插件贡献），panelDefsTick 驱动
// 贡献变更后的即时重渲染（设计件 §2.3）。

import { useDockStore } from '../state/dock-store';
import { usePanelDefsStore } from '../state/panel-defs-store';
import { getAction, runAction } from './actions';
import { Icon } from './Icon';
import { panelDefs } from './panels/panel-def';

export function DockRail({ side }: { side: 'left' | 'right' }) {
  const open = useDockStore((s) => s.open);
  const panelDefsTick = usePanelDefsStore((s) => s.panelDefsTick);
  const items = panelDefs().filter((d) => d.side === side);
  void panelDefsTick; // 信号驱动重渲染；清单在渲染期重取（合流点幂等）
  const anyOpen = items.some((it) => open[it.id]);
  if (anyOpen) return null; // 旧行为：面板打开时让位
  return (
    <nav className={`dr-rail dr-${side}`}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`dr-btn${open[it.id] ? ' on' : ''}`}
          title={it.title}
          onClick={() => {
            // 内置面板：走注册动作（含关兄弟面板/触发简报等既有行为）；
            // 插件面板（S4-1.5）：无注册动作 → 直接开合 dock（保底语义）。
            if (getAction(`panel.${it.id}`)) runAction(`panel.${it.id}`);
            else useDockStore.getState().togglePanel(it.id);
          }}
        >
          <Icon name={it.icon} />
          <span className="dr-label">{it.title}</span>
        </button>
      ))}
    </nav>
  );
}

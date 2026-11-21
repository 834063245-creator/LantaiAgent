// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DockSlot — **壳给的盒子**（v66，2026-11-21）。面板只提供内容，位置 / 尺寸 /
// 层级 / 书眉 / 关闭钮由本组件出。
//
// 病灶（docs/issues/lantai-plugin-panels-no-home）：ctx.panels 通道的出口
// （DockRail）随 V5 拆除，PanelDef.side 从此零消费者——面板组件裸挂在文档流里，
// 而纸壳根 .pp-root 是 position: fixed; inset: 0; z-index: 280 ⇒ 第三方插件面板
// **在任何应用状态下都不可能可见**（纸开着被纸盖、纸关着被首页底版盖）。
// 内置面板当年靠各自写 position: fixed 活着，故这个洞潜伏了三个月。
//
// 分流（DockPanel 决定，本组件只负责 'shell' 这一支）：
//   - side === null                     → 全屏覆盖槽（自己定位：paper / settings）
//   - side !== null && frame === 'self' → 自持槽（家具：书脊 / 案卷侧栏）
//   - 其余                               → **本组件**（第三方面板的默认形态）
//
// 与 ctx.overlays 同一条纪律：**壳只长通道，不写具体形态**——盒子里装什么由
// 面板决定，盒子本身只承诺「看得见、关得掉、不跟纸打架」。
//
// 只出盒子（children = 面板内容）：开合 / 退场相位机仍在 DockPanel 的 PanelSlot——
// 盒子若自己判 open，就会与相位机抢「什么时候真卸载」这一个决定。

import type { ReactNode } from 'react';
import { useDockStore } from '../../state/dock-store';
import { Icon } from '../Icon';
import type { PanelDef } from './panel-def';

export function DockSlot({ def, children }: { def: PanelDef; children: ReactNode }) {
  // side 非 null 是调用方的分流前提；兜底 right 只为类型收敛（不该走到）。
  const side = def.side ?? 'right';
  return (
    <section
      className="dock-slot"
      data-side={side}
      data-panel-id={def.id}
      style={def.width ? { width: def.width + 'px' } : undefined}
      aria-label={def.title}
    >
      <header className="dock-slot-head">
        <span className="dock-slot-icon">
          <Icon name={def.icon} />
        </span>
        <span className="dock-slot-title">{def.title}</span>
        <button
          type="button"
          className="dock-slot-close"
          aria-label={'关闭' + def.title}
          onClick={() => useDockStore.getState().closePanel(def.id)}
        >
          ×
        </button>
      </header>
      <div className="dock-slot-body">{children}</div>
    </section>
  );
}

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
//
// 宽度（2026-11-23 批）：**不是定数**——内侧缘一条拖拽柄（`useDragGesture`），
// 拖动写回 dock-store 的 panelWidths，←→ 聚焦后微调。`PanelDef.width` 降级为
// 「作者建议的起手宽度」，盖不过用户的手。
// 记忆（同批）：手势结束/键盘松开时落 localStorage（state/dock-panel-widths.ts），
// 启动由 dock-store 灌回——拖过的宽度重启还在。

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useRef,
} from 'react';
import { savePanelWidth } from '../../state/dock-panel-widths';
import { useDockStore } from '../../state/dock-store';
import { Icon } from '../Icon';
import { useDragGesture } from '../interaction/use-drag-gesture';
import type { PanelDef } from './panel-def';

/** 宽度下限（与 dock-slot.css 的 min-width 同值）：再窄书眉就装不下标题与关闭钮。 */
const PANEL_MIN_WIDTH = 260;
/** 键盘微调步长（px）——与侧栏调宽同档。 */
const PANEL_RESIZE_STEP = 16;

/** 用户能拖到多宽：视口 2/3、封顶 900px——面板是侧栏，不是第二个主界面。 */
function maxPanelWidth(): number {
  return Math.max(PANEL_MIN_WIDTH, Math.min(900, Math.round(window.innerWidth * 0.66)));
}

export function DockSlot({ def, children }: { def: PanelDef; children: ReactNode }) {
  // side 非 null 是调用方的分流前提；兜底 right 只为类型收敛（不该走到）。
  const side = def.side ?? 'right';
  const runtimeWidth = useDockStore((s) => s.panelWidths[def.id]);
  const slotRef = useRef<HTMLElement | null>(null);
  /** 起手宽度（按下那一刻的量）。 */
  const startWidthRef = useRef(PANEL_MIN_WIDTH);

  const clampWidth = (w: number): number => Math.round(Math.min(maxPanelWidth(), Math.max(PANEL_MIN_WIDTH, w)));

  /** 渲染宽度：用户拖过的先夹进当前视口（换屏后落盘的宽度可能超出可用区），
   *  没拖过才轮到作者声明的起手宽度。 */
  const width = runtimeWidth === undefined ? def.width : clampWidth(runtimeWidth);

  /** 量眼前实际宽度：fit-content 时 PanelDef.width 未必是实际值；量不到
   *  （未布局 / 测试环境返回 0）退回 store → 声明 → 兜底下限。 */
  const measureWidth = (): number => {
    const live = slotRef.current?.getBoundingClientRect().width ?? 0;
    if (live > 0) return Math.round(live);
    return useDockStore.getState().panelWidths[def.id] ?? def.width ?? PANEL_MIN_WIDTH;
  };

  /** 宽度落盘：读 store 的最新值（拖动逐帧写 store，闭包里的 width 可能滞后）。 */
  const persistWidth = () => {
    const live = useDockStore.getState().panelWidths[def.id];
    if (live !== undefined) savePanelWidth(def.id, live);
  };

  /** 拖内侧缘的方向：右侧面板贴右缘，往左拖 = 变宽；左侧面板反之。 */
  const widenSign = side === 'right' ? -1 : 1;

  const widthGesture = useDragGesture({
    onStart: () => {
      startWidthRef.current = measureWidth();
    },
    onMove: (_e, d) => {
      useDockStore.getState().setPanelWidth(def.id, clampWidth(startWidthRef.current + d.dx * widenSign));
    },
    onEnd: () => persistWidth(),
    /* 取消也落盘：宽度已在拖动期逐帧写进 store（取消不回滚），落盘保持与眼前一致。 */
    onCancel: () => persistWidth(),
  });

  const onResizePointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    /* 拖柄 = 改宽度，不是扫过纸面选区。 */
    e.preventDefault();
    widthGesture.begin(e);
  };

  const onResizeKeyDown = (e: ReactKeyboardEvent) => {
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    useDockStore.getState().setPanelWidth(def.id, clampWidth(measureWidth() + dir * PANEL_RESIZE_STEP * widenSign));
  };

  /** 键盘微调后落盘（keyup 一次；按住方向键中途不写）。 */
  const onResizeKeyUp = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') persistWidth();
  };

  return (
    <section
      ref={slotRef}
      className="dock-slot"
      data-side={side}
      data-panel-id={def.id}
      /* 用户拖过的宽度要盖过 CSS 的 45vw 兜底上限（那是「没声明宽度」时的护栏）。 */
      data-resized={runtimeWidth === undefined ? undefined : ''}
      style={width ? { width: width + 'px' } : undefined}
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
      {/* 内侧缘调宽柄：纯热区、hover/focus 显形墨条（同 .ss-resize 的形态纪律）。 */}
      <button
        type="button"
        className="dock-slot-resize"
        aria-label={'拖拽调整面板宽度：' + def.title + '（聚焦后 ← → 微调）'}
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
        onKeyUp={onResizeKeyUp}
      />
    </section>
  );
}

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
// 2026-10-15 §15 批 3b：加**退场窗**（`animateExit`）——见 PanelSlot 相位机注。

import { useEffect, useState } from 'react';
import { useDockStore } from '../../state/dock-store';
import { usePanelDefsStore } from '../../state/panel-defs-store';
import { PluginBoundary } from '../PluginBoundary';
import { type PanelDef, panelDefs } from './panel-def';

/** 面板退场窗（ms）——**必须与 `tokens.css` 的 `--m-sheet`（0.26s）同值**：
 *  两把尺子一把，CSS 侧播出场、壳层侧等这么久才真卸载（不等 = 动画播到一半就
 *  被卸载掐断）。镜像由 `tests/motion-contract.test.ts` 钉死（改一处不改另一处即红）。 */
const PANEL_LEAVE_MS = 260;

function PanelSlot({ def }: { def: PanelDef }) {
  const open = useDockStore((s) => s.open[def.id]);
  const canLeave = def.unmountOnClose === true && def.animateExit === true;

  /* 相位机（退场对称，§15）：open → 'open'；open 由 true 转 false → 'leaving'
   * →（PANEL_LEAVE_MS）→ 'closed'（真卸载）。
   *
   *  ⚠ **相位必须在渲染期收敛，不许挪进 useEffect**（2026-10-16 真机报「侧栏收藏
   *  时跳变」的根治点）：`mounted` 判据在**渲染期**读相位，而 effect 在绘制之后才跑
   *  ——相位晚一趟推进的话，收面那一趟 `open` 已 false 而相位还是 'open' ⇒
   *  `mounted=false` ⇒ 面被 `return null` **拆掉**；effect 随后把相位推到 'leaving'，
   *  面被当**新元素**挂回来：入场（各面板自己的 `@starting-style` 起手式 / keyframes）
   *  在退场窗里重播，窗满时又按退场目标值一帧到位——用户读数 =
   *  「面闪掉 → 滑回来 → 啪一下没了」。重挂还各带一次组件状态重建（重开重置
   *  语义被提前执行）。
   *
   *  写成**渲染期修正 state**（React 官方「props 变了就调 state」模式，同组件、
   *  收敛即止）而非 effect：同一个 commit 里相位就是 'leaving'，DOM 节点不拆不动，
   *  `[data-panel-leaving]` 与 `open=false` 同帧落 ⇒ 退场过渡从当前值起手。
   *  转移是 (open, phase) 的纯函数、幂等，StrictMode 双调用不误开窗；初始相位直取
   *  `open`，故启动期（所有面板 open=false）不会凭空多出一个空窗。 */
  const [phase, setPhase] = useState<'open' | 'leaving' | 'closed'>(open ? 'open' : 'closed');
  if (open && phase !== 'open') setPhase('open');
  else if (!open && phase === 'open') setPhase(canLeave ? 'leaving' : 'closed');
  useEffect(() => {
    if (phase !== 'leaving') return;
    const t = setTimeout(() => setPhase('closed'), PANEL_LEAVE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  const mounted = open || phase === 'leaving';
  if (def.unmountOnClose && !mounted) return null;
  const C = def.component;
  return (
    /* 退场标记层：`display: contents` = **不生成盒子**，对既有布局零影响；
       面板自己的 CSS 以 `[data-panel-leaving] <本面板根>` 播出场（壳层供钩、
       产物消费——见 panel-def 的 animateExit 注）。 */
    <div data-panel-leaving={phase === 'leaving' ? '' : undefined} style={{ display: 'contents' }}>
      <PluginBoundary label={`面板 ${def.id}`}>
        <C />
      </PluginBoundary>
    </div>
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 空间手势立枝域（P4-①，2026-09-19）——按住块上的「枝」握把**拖出一条引线、松手落在纸上**
// = 就地立枝（枝卷落在松手的位置）。立项件 `docs/plans/session-tree-plan.md` §5 / §12.8。
//
// 判据（为什么不与既有三条手势打架，见 plan §5）：握把是块 hover 才出现的**独立小把手**，
// 落在块体**之外**的底间距带里（右对齐，与动作行同一条带）：
//   · 不是文类签（`.pp-kind` 是既有的「整块拖出钉住」把手）⇒ 两条手势各占各的把手；
//   · 不在正文上 ⇒ 划词选字（纸面唯一的文本手势）一行不动；
//   · 是 `.pp-block` 的子件 + mousedown 停传 ⇒ 不落成画布平移。
// 弃案（修饰键 / 拖动作行按钮）的理由记在 plan §5——不在代码里复述。
//
// 手势语言与拖块族同源（`use-paper-drag`）：阈值起（`DRAG_THRESHOLD`，区分点击）→ 全程跟手
// （引线预览直接画在枝边层那一支笔上，装配根按 view 现算）→ 松手定夺。收尾三分：
//   · 落在纸上 ⇒ `core.branchFromMessage(本块, 本卷, 落点世界坐标)`——立枝 + 落位 + 摊开定位
//     （**空间权威入口只有 chat-core 那一处**，本域不碰 `requestFocus`）；
//   · 松手落回原块 / Esc ⇒ **取消**（不立卷、不留定位请求）；
//   · 落在纸外（坞 / 侧栏 / 窗口外）⇒ 取消（与书脊拖行「松手落回本栏 = 中止」同族）。

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, SourcedBlock } from './host';
import { screenToWorld, useCanvasViewStore } from './host';
import { DRAG_THRESHOLD } from './use-paper-drag';
import type { PaperCore } from './use-paper-sessions';

/** 拖动预览态（**屏幕坐标**，画布左上为原点）：块 id + 卷 + 指针位——
 *  引线几何由装配根按当前 view 现算（与枝边层同一层位、同一支笔）。 */
export interface BranchDragState {
  blockId: string;
  sessionId: string;
  screen: { x: number; y: number };
}

/** 握把的 hover 说明（一句话后果，禁内部名词）。 */
export const BRANCH_GRIP_TITLE = '按住拖出一条引线，落在纸上就地立枝（本卷原样保留）';

/** 空间手势立枝（装配根持渲染态，引线预览与落位在别处消费）。 */
export function useBranchDrag(params: {
  core: PaperCore | null;
  canvasRef: MutableRefObject<HTMLDivElement | null>;
  blockSessionRef: MutableRefObject<Map<string, string>>;
  regionMsgs: Record<string, { messages: readonly ChatMessage[]; tick: number }>;
  /** 手动接管视口（取消在途定位飞行 + 清挂起定位）：起手势 = 用户接管摄像机，
   *  与拖块/滚轮/拖画布同纪律（由装配根持 focusRaf/focusFlight 穿参下来）。 */
  takeOverViewport: () => void;
}): {
  branchDrag: BranchDragState | null;
  onBranchGripMouseDown: (e: React.MouseEvent, block: SourcedBlock) => void;
} {
  const { core, canvasRef, blockSessionRef, regionMsgs, takeOverViewport } = params;
  const [branchDrag, setBranchDrag] = useState<BranchDragState | null>(null);
  /** 消息表读面（手势收尾要取**最新**那条消息交给 chat-core）——走 ref 以免把
   *  `regionMsgs` 放进 effect 依赖（流式每 tick 换引用 ⇒ 手势中途拆装监听器）。 */
  const msgsRef = useRef(regionMsgs);
  msgsRef.current = regionMsgs;

  const dragRef = useRef<{
    blockId: string;
    messageId: string;
    sessionId: string;
    sx: number;
    sy: number;
    moved: boolean;
    /** 原块矩形（client 坐标）：松手落回它 = 取消（与拖块族「回槽取消」同语义）。 */
    origin: { left: number; top: number; right: number; bottom: number } | null;
  } | null>(null);

  const onBranchGripMouseDown = useCallback(
    (e: React.MouseEvent, block: SourcedBlock) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // 不落成画布平移 / 不触发流区激活
      e.preventDefault(); // 不起原生拖拽 / 不划词
      if (!core) return;
      const sessionId = blockSessionRef.current.get(block.id);
      if (!sessionId) return; // 不在任何摊开卷里（握把只长在流块上，理论不达）
      const root = (e.currentTarget as HTMLElement).closest('.pp-block');
      const rect = root?.getBoundingClientRect();
      dragRef.current = {
        blockId: block.id,
        messageId: block.source.messageId,
        sessionId,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        origin: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
      };
    },
    [core, blockSessionRef],
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        takeOverViewport(); // 起手势 = 手动接管视口（否则在途飞行跟手抢 pan）
      }
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setBranchDrag({
        blockId: d.blockId,
        sessionId: d.sessionId,
        screen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      });
    };
    const cancel = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setBranchDrag(null);
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setBranchDrag(null);
      if (!d?.moved) return; // 未过阈值 = 点击（握把是拖拽件，点击不落动作）
      const o = d.origin;
      // 落回原块 = 取消（不立卷）
      if (o && e.clientX >= o.left && e.clientX <= o.right && e.clientY >= o.top && e.clientY <= o.bottom) return;
      // 落在纸外（坞 / 侧栏 / 窗口外）= 取消——与书脊拖行「松手落回本栏 = 中止」同族
      if (!(e.target as HTMLElement | null)?.closest?.('.pp-canvas')) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const msg = msgsRef.current[d.sessionId]?.messages.find((m) => m._id === d.messageId);
      if (!msg) return; // 块已不在消息表里（卷被换掉/关掉）：无从立枝，取消
      // 落点 = **世界坐标**（与书脊拖落同一把尺子：pickDropAnchor + place 在 chat-core）
      const w = screenToWorld(useCanvasViewStore.getState().view, e.clientX - rect.left, e.clientY - rect.top);
      void core?.branchFromMessage(msg, Number(d.sessionId), { x: w.x, y: w.y });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('keydown', key);
    };
    /* ⚠ 依赖表刻意不含 regionMsgs（走 msgsRef 读最新值）——与拖块域「拖拽回调零
     *  依赖稳定」同源纪律：流式每 tick 换引用会把监听器拆装一遍。 */
  }, [core, canvasRef, takeOverViewport]);

  return { branchDrag, onBranchGripMouseDown };
}

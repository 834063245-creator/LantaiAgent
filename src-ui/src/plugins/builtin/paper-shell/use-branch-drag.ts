// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 空间手势立枝域（P4-①，2026-09-19）——按住块上的「枝」握把**拖出一条引线、松手落在纸上**
// = 就地立枝（枝卷落在松手的位置）。立项件 `docs/archive/session-line/session-tree-plan.md` §5 / §12.8。
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
import { useCallback, useRef, useState } from 'react';
import { useDragGesture } from '../../../app/interaction/use-drag-gesture';
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
  onBranchGripPointerDown: (e: React.PointerEvent, block: SourcedBlock) => void;
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
    /** 本块对应的 part（`BlockSource.part` 活引用）——松手时的**块坐标**（按块定位）。 */
    part: object | null;
    sessionId: string;
    sx: number;
    sy: number;
    moved: boolean;
    /** 原块矩形（client 坐标）：松手落回它 = 取消（与拖块族「回槽取消」同语义）。 */
    origin: { left: number; top: number; right: number; bottom: number } | null;
  } | null>(null);

  /* 手势核心（2026-11-17 批 C3 收编）：阈值/失联即收/松手定夺都交给 `useDragGesture`。
   * 本域只留「这一支手势的语义」：起手记下落点基准、跟手画引线、松手判三分。 */
  const gesture = useDragGesture({
    threshold: DRAG_THRESHOLD,
    onStart: () => {
      takeOverViewport(); // 起手势 = 手动接管视口（否则在途飞行跟手抢 pan）
    },
    onMove: (_e, d) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const cur = dragRef.current;
      if (!rect || !cur) return;
      setBranchDrag({
        blockId: cur.blockId,
        sessionId: cur.sessionId,
        screen: { x: d.x - rect.left, y: d.y - rect.top },
      });
    },
    onEnd: (e, d) => {
      const cur = dragRef.current;
      setBranchDrag(null);
      if (!cur) return;
      const o = cur.origin;
      /* 落回原块 = 取消（不立卷）。用**指针**坐标判：`e.target` 在捕获面下恒是握把
       * 自己（旧实现读 target 判「在不在纸上」是 capture 未接管时的权宜）。 */
      if (o && d.x >= o.left && d.x <= o.right && d.y >= o.top && d.y <= o.bottom) return;
      /* 落在纸外（坞 / 侧栏 / 窗口外）= 取消——与书脊拖行「松手落回本栏 = 中止」同族。
       * ⚠ 捕获面下 `e.target` 恒是**握把自己**（setPointerCapture 重新定向了指针事件），
       * 于是「落点在哪个面上」要靠 `elementFromPoint` 现取；没有捕获（回退路径）时
       * `target` 就是真落点，两条腿都留着，判据不变。 */
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const landedOn = d.captured
        ? document.elementFromPoint(d.x, d.y)
        : ((e?.target as Element | null) ?? document.elementFromPoint(d.x, d.y));
      if (landedOn && !landedOn.closest('.pp-canvas')) return;
      const sx = d.x - rect.left;
      const sy = d.y - rect.top;
      if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return;
      const msg = msgsRef.current[cur.sessionId]?.messages.find((m) => m._id === cur.messageId);
      if (!msg) return; // 块已不在消息表里（卷被换掉/关掉）：无从立枝，取消
      // 落点 = **世界坐标**（与书脊拖落同一把尺子：pickDropAnchor + place 在 chat-core）
      const w = screenToWorld(useCanvasViewStore.getState().view, sx, sy);
      // 块坐标随点击一起交出去（2026-09-22 按块定位）：握把长在**块**上，切点就必须是
      // 该块所在那一步的末尾——只给消息 = 整轮末尾（一条助手消息在实时形态里聚合整轮）。
      /* indexOf 需要同型参数——`cur.part` 是块来源的活引用（`BlockSource.part`），
       * 与 `msg.parts` 的元素同型（存的就是它），故按元素型断言，不改判据。 */
      const partIndex = msg.role === 'assistant' ? msg.parts.indexOf(cur.part as (typeof msg.parts)[number]) : -1;
      // 第三位 = 落点（旧核也认），第四位 = 块坐标（旧核忽略）——见 chat-core 该函数的注
      void core?.branchFromMessage(
        msg,
        Number(cur.sessionId),
        { x: w.x, y: w.y },
        msg.role === 'assistant' ? { parts: msg.parts, index: partIndex } : undefined,
      );
      void e;
    },
    onCancel: () => {
      setBranchDrag(null);
    },
  });

  const onBranchGripPointerDown = useCallback(
    (e: React.PointerEvent, block: SourcedBlock) => {
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
        part: block.source.part,
        sessionId,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        origin: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
      };
      gesture.begin(e);
    },
    [core, blockSessionRef, gesture],
  );

  /* Esc = 取消（原来那条 window keydown 只做这一件事，握把手势是它的唯一消费者）——
   * 挂在握把元素自己的 onKeyDown 上不再需要 window 级监听。 */

  return { branchDrag, onBranchGripPointerDown };
}

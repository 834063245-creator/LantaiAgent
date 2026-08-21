// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// PaperPanel — paper-shell 走查弹（tracer bullet）· 纸视图壳。
//
// 挂法：panel-def 常量注册（side:null 全屏覆盖，SettingsPanel/DataflowPanel 同款）。
// 数据：真实会话消息（msgStoreForActive(core.panelId)——不 mock，穿全层：
//   ChatMessage[] → paper/translate 转译 → SourcedBlock[] → 灰框渲染）。
// 流锚甲（D-R1-3）：流自视口下缘向上生长，输入条固定底部，最新块贴下缘。
// 无限画布（D-R1-1）：平移/缩放 + 原点十字方位感。
// 钉住（D-R2-1）：按住块拖出流外松手即钉；按钮收回（D-R2-2，confirm 占位）。
// 丑得理直气壮：灰框系统字，零视觉打磨——结构对即可。
//
// 输入条：写 input-store（真实输入框同款真相源），提交走 core.sendMessage()
// ——agent 层零改动，消息追加后走查弹经 version 订阅自动重转译。

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourcedBlock } from '../../paper/block-model';
import {
  ANCHOR,
  identityView,
  layoutFlow,
  panBy,
  screenToWorld,
  viewForAnchor,
  wheelFactor,
  zoomAt,
} from '../../paper/canvas-math';
import { translateMessages } from '../../paper/translate';
import { useDockStore } from '../../state/dock-store';
import { getChatStore, msgStoreForActive } from '../../ui/chat-store';
import { useCoreStore } from '../chat/core-instance';
import './PaperPanel.css';

/* ── 块高估算（走查弹不做真测量——Pretext 接入是 V3a 的事；
 *    估算=内容行数×行高+内边距，误差可接受：流内块是垂直排布，
 *    高估/低估只影响块间距，不影响「流的感觉」验证）── */
function estimateBlockHeight(b: SourcedBlock): number {
  const lineH = 20;
  const monoH = 17;
  let textLen = 0;
  let monoLen = 0;
  switch (b.kind) {
    case 'user':
    case 'markdown':
    case 'reasoning':
    case 'notice':
      textLen = (b.payload as { text: string }).text.length;
      break;
    case 'diff':
      monoLen = (b.payload as { text: string }).text.length;
      break;
    case 'tool': {
      const p = b.payload as { args: string; output?: string };
      monoLen = p.args.length + (p.output?.length ?? 0);
      break;
    }
    case 'plan':
      textLen = (b.payload as { content: string }).content.length;
      break;
  }
  const textLines = Math.max(1, Math.ceil(textLen / 60)); // ~60 字符/行
  const monoLines = Math.max(0, Math.ceil(monoLen / 90));
  const head = 22;
  const pad = 20;
  return head + pad + textLines * lineH + monoLines * monoH;
}

/* ── 灰框块渲染器 ── */

function BlockView({ block, onUnpin }: { block: SourcedBlock; onUnpin: (id: string) => void }) {
  const p = block.payload;
  return (
    <>
      <div className="pp-kind">
        <span>{block.kind}</span>
        {block.kind === 'tool' && (
          <span className={`pp-status pp-${(p as { status: string }).status}`}>{(p as { status: string }).status}</span>
        )}
        {block.state === 'pinned' && <span>📌</span>}
      </div>
      {block.kind === 'user' && <div>{(p as { text: string }).text}</div>}
      {block.kind === 'markdown' && <div>{(p as { text: string }).text}</div>}
      {block.kind === 'reasoning' && <div>{(p as { text: string }).text}</div>}
      {block.kind === 'notice' && <div>{(p as { text: string }).text}</div>}
      {block.kind === 'diff' && <pre>{(p as { text: string }).text}</pre>}
      {block.kind === 'plan' && <pre>{(p as { content: string }).content}</pre>}
      {block.kind === 'tool' && (
        <>
          <pre>{(p as { args: string }).args}</pre>
          {(p as { output?: string }).output && <div className="pp-out">{(p as { output?: string }).output}</div>}
          {(p as { err?: string }).err && (
            <div className="pp-out" style={{ color: '#e08a84' }}>
              {(p as { err?: string }).err}
            </div>
          )}
        </>
      )}
      {block.state === 'pinned' && (
        <button
          type="button"
          className="pp-unpin"
          onClick={(e) => {
            e.stopPropagation();
            onUnpin(block.id);
          }}
        >
          收回
        </button>
      )}
    </>
  );
}

/* ── 主组件 ── */

/** 拖动阈值（px）：超过即视为拖块（区分点击） */
const DRAG_THRESHOLD = 6;
/** 流内占位符高度（pinned 块在流原序位的洞——设计文档 §2.3） */
const GHOST_H = 32;

export function PaperPanel() {
  const closePanel = useDockStore((s) => s.closePanel);
  const core = useCoreStore((s) => s.core);

  /* 真实消息（穿全层第一段：消息 store → 转译）。
   * tick 是重转译触发器：消息原位变更时 messages 引用不变（touchMessage 语义），
   * version bump / 会话切换 / 钉位变化都走 tick+1。 */
  const [msgState, setMsgState] = useState<{
    messages: readonly import('../../ui/message-model').ChatMessage[];
    tick: number;
  }>({ messages: [], tick: 0 });

  const syncMessages = useCallback(() => {
    if (!core) return;
    const store = msgStoreForActive(core.panelId);
    if (!store) {
      setMsgState((s) => (s.messages.length === 0 ? s : { messages: [], tick: s.tick + 1 }));
      return;
    }
    const st = store.getState();
    setMsgState((s) => ({ messages: st.messages, tick: s.tick + 1 }));
  }, [core]);

  useEffect(() => {
    if (!core) return;
    syncMessages();
    // 订阅链：① 直订活跃会话的消息 store（流式 part.text += chunk + touchMessage →
    // version bump → syncMessages 重转译）；② sess 变化（会话切换）→ 重解析活跃
    // store 并重订（msgStoreForActive 换实例）。
    let unsub: (() => void) | undefined;
    const resub = () => {
      unsub?.();
      const store = msgStoreForActive(core.panelId);
      unsub = store?.subscribe(syncMessages);
      syncMessages();
    };
    const sessStore = getChatStore(core.panelId).sess;
    const unSess = sessStore.subscribe(resub);
    resub();
    return () => {
      unSess();
      unsub?.();
    };
  }, [core, syncMessages]);

  /* 钉住位置表（活引用续命：重转译时经 pinnedPositions 传回 translate） */
  const pinnedRef = useRef(new Map<string, { x: number; y: number }>());

  /* 转译（穿全层第二段）——msgState.tick 驱动重算（pinnedRef 是可变 ref，
   * 位置表读取发生在 translate 内——ref 身份恒定，无需进依赖） */
  const blocks = useMemo(
    () => translateMessages(msgState.messages, { pinnedPositions: pinnedRef.current }),
    [msgState],
  );

  /* 视口状态 */
  const [view, setView] = useState(identityView());
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });

  /* 初始视口：锚点对视口下缘（D-R1-3）。画布尺寸变化时保持锚点关系 */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // 流锚：世界 (0,0)（最新块底边）对到屏幕 (w/2, h - margin)
    const { panX, panY } = viewForAnchor(canvasSize.w, canvasSize.h);
    setView((v) => ({ ...v, panX, panY }));
    // 仅在画布首次出现/尺寸变化时对锚（用户平移后不打扰——走查弹简化：
    // 尺寸变化即回锚，可接受）
  }, [canvasSize.w, canvasSize.h]);

  /* 流布局（穿全层第三段：块 → 世界坐标）。
   * 走完整序列栈：flow 块占实际高度，pinned 块在原序位留占位符（ghost）——
   * 设计文档 §2.3「原位置留占位符」+ D-R2-2「收回回原位」的可验证基础。 */
  const stack = useMemo(
    () =>
      blocks.map((b) =>
        b.state === 'flow' ? { id: b.id, h: estimateBlockHeight(b), w: b.w } : { id: b.id, h: GHOST_H, w: b.w },
      ),
    [blocks],
  );
  const layout = useMemo(() => layoutFlow(stack), [stack]);

  /* ── 交互：平移 / 缩放 / 拖块 ── */
  const panningRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const [panning, setPanning] = useState(false);

  /* 缩放：原生非被动监听（React 合成 wheel 是 passive，preventDefault 无效） */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((v) => zoomAt(v, e.clientX - rect.left, e.clientY - rect.top, wheelFactor(e.deltaY)));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);

  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    // 空白处按下 → 开始平移（块/占位符有自己的处理，不落到这里）
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('pp-world')) {
      panningRef.current = { lastX: e.clientX, lastY: e.clientY };
      setPanning(true);
    }
  }, []);

  useEffect(() => {
    if (!panning) return;
    const move = (e: MouseEvent) => {
      const p = panningRef.current;
      if (!p) return;
      const dx = e.clientX - p.lastX;
      const dy = e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      if (dx !== 0 || dy !== 0) setView((v) => panBy(v, dx, dy));
    };
    const up = () => setPanning(false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [panning]);

  /* 拖块（D-R2-1 拖出钉住）：阈值即脱流（钉在当前渲染位，无瞬跳）→
   * 全程跟手（dragPos 覆盖渲染，不逐帧重转译）→ 松手判位：带外=钉住落位，
   * 带内且原为 flow=回流（占位符处复活）。 */
  const dragRef = useRef<{
    id: string;
    sx: number;
    sy: number;
    moved: boolean;
    wasFlow: boolean;
    bw: number;
    offX: number;
    offY: number;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);

  const onBlockMouseDown = useCallback(
    (e: React.MouseEvent, block: SourcedBlock) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // 不触发画布平移
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      // 偏移基于「当前渲染位」：flow 块取流布局位（block.x 是默认值 0，非渲染位）
      const rx = block.state === 'flow' ? (layout.get(block.id)?.x ?? block.x) : block.x;
      const ry = block.state === 'flow' ? (layout.get(block.id)?.y ?? block.y) : block.y;
      dragRef.current = {
        id: block.id,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        wasFlow: block.state === 'flow',
        bw: block.w,
        offX: w.x - rx,
        offY: w.y - ry,
      };
    },
    [view, layout],
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      if (!d.moved) {
        d.moved = true;
        setDraggingId(d.id);
        if (d.wasFlow) {
          // 脱流：钉在当前渲染位（视觉无跳变），流内该序位出现占位符
          pinnedRef.current.set(d.id, { x: w.x - d.offX, y: w.y - d.offY });
          setMsgState((s) => ({ messages: s.messages, tick: s.tick + 1 }));
        }
      }
      setDragPos({ x: w.x - d.offX, y: w.y - d.offY });
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDraggingId(null);
      if (!d?.moved) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = screenToWorld(view, e.clientX - rect.left, e.clientY - rect.top);
      const fx = w.x - d.offX;
      const fy = w.y - d.offY;
      // 松手判位：流锚窄带外 → 钉住落位；带内且原为 flow → 回流（不钉）
      if (d.wasFlow && Math.abs(fx + d.bw / 2) <= ANCHOR.bandHalfWidth) {
        pinnedRef.current.delete(d.id);
      } else {
        pinnedRef.current.set(d.id, { x: fx, y: fy });
      }
      setDragPos(null);
      setMsgState((s) => ({ messages: s.messages, tick: s.tick + 1 }));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [view]);

  /* 收回（D-R2-2 按钮+确认主通道） */
  const onUnpin = useCallback((id: string) => {
    if (window.confirm('收回该块到对话流原位？')) {
      pinnedRef.current.delete(id);
      setMsgState((s) => ({ messages: s.messages, tick: s.tick + 1 }));
    }
  }, []);

  /* 占位符点击恢复（原型同款等价手势，即时——R2 注记「走查弹验证哪种顺手」） */
  const onGhostClick = useCallback((id: string) => {
    pinnedRef.current.delete(id);
    setMsgState((s) => ({ messages: s.messages, tick: s.tick + 1 }));
  }, []);

  /* ── 输入条：真相走 input-store，提交走 core.sendMessage（agent 层零改动）── */
  const [inputText, setInputText] = useState('');
  const onSend = useCallback(async () => {
    const t = inputText.trim();
    if (!t || !core) return;
    getChatStore(core.panelId).input.getState().setInputText(t);
    setInputText('');
    await core.sendMessage();
  }, [inputText, core]);

  /* 世界层 transform */
  const worldStyle = useMemo(
    () => ({ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }),
    [view],
  );

  const zoomLabel = Math.round(view.zoom * 100) + '%';

  return (
    <div className="pp-root">
      <div className="pp-topbar">
        <span className="pp-title">纸</span>
        <span className="pp-tag">走查弹 tracer bullet · 灰框=结构验证，非视觉</span>
        <span className="pp-zoom">
          {zoomLabel} · {blocks.length} 块（钉 {pinnedRef.current.size}）
        </span>
        <button type="button" className="pp-close" onClick={() => closePanel('paper')}>
          关闭
        </button>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: 无限画布是鼠标平移/缩放交互面（缩放走原生非被动监听，平移在这里）；键盘可达性属走查弹范围外 */}
      <div ref={canvasRef} className={`pp-canvas${panning ? ' pp-panning' : ''}`} onMouseDown={onCanvasMouseDown}>
        {blocks.length === 0 && (
          <div className="pp-empty">
            当前会话还没有消息。
            <br />
            在主聊天里发一条，或直接在下面输入。
          </div>
        )}

        {/* 世界层 */}
        <div className="pp-world" style={worldStyle}>
          {/* 原点十字（方位感） */}
          <div className="pp-origin" style={{ left: 0, top: 0 }}>
            <span className="pp-origin-label">origin</span>
          </div>

          {/* 流序列：flow 块按序渲染；pinned 块渲染占位符（原序位）+ 钉住实体 */}
          {blocks.map((b) => {
            const slot = layout.get(b.id);
            if (!slot) return null;
            if (b.state === 'flow') {
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: 块拖拽面（拖出钉住手势 D-R2-1，无原生等价物）；收回/展开已有原生按钮
                <div
                  key={b.id}
                  className={`pp-block pp-${b.kind}`}
                  style={{ left: slot.x, top: slot.y, width: b.w, minHeight: estimateBlockHeight(b) }}
                  onMouseDown={(e) => onBlockMouseDown(e, b)}
                >
                  <BlockView block={b} onUnpin={onUnpin} />
                </div>
              );
            }
            const isDragged = draggingId === b.id;
            const pos = isDragged && dragPos ? dragPos : { x: b.x, y: b.y };
            return (
              <Fragment key={b.id}>
                {/* 占位符：流原序位的洞，点击即时恢复（D-R2-2 等价手势，原生 button 免 a11y ignore） */}
                <button
                  type="button"
                  className="pp-ghost"
                  style={{ left: slot.x, top: slot.y, width: b.w, height: GHOST_H }}
                  onClick={() => onGhostClick(b.id)}
                >
                  已移出 · 点击恢复
                </button>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: 钉住块拖拽面（同 flow 块 D-R2-1 手势）；收回有原生按钮 */}
                <div
                  className={['pp-block', `pp-${b.kind}`, 'pp-pinned', isDragged ? 'pp-dragging' : ''].join(' ')}
                  style={{ left: pos.x, top: pos.y, width: b.w }}
                  onMouseDown={(e) => onBlockMouseDown(e, b)}
                >
                  <BlockView block={b} onUnpin={onUnpin} />
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>

      <div className="pp-composer">
        <input
          type="text"
          value={inputText}
          placeholder="向 Agent 写字（真实发送到当前会话）…"
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSend();
          }}
        />
        <button type="button" onClick={onSend}>
          发送
        </button>
      </div>
    </div>
  );
}

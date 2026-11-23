// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// 插件应用窗帧（app shell 件 A · S3）——iframe 载体 + 书眉 + 拖拽。
//
// 隔离与绑定（**入口二态**，契约 v28——判定单一真源 = `def.kind`）：
//   · `asset`（插件自包含 HTML，资产通道）：iframe sandbox **不给
//     allow-same-origin**（opaque origin——窗内容拿不到宿主桥，postMessage
//     白名单桥是唯一能力通道；绑定在容器侧——bindBridgeWindow 以
//     contentWindow 身份登记插件名）。
//   · `remote`（环回远端页，app.url——如 officecli watch 的活预览）：iframe
//     **给 allow-same-origin**——跨源文档加此许可只让它保住自己的 origin
//     （父页仍拿不到它的 DOM），而它的同源 `EventSource`/`fetch` 才通；
//     同时**不绑宿主桥**（远端文档不是插件代码，不该拿到插件身份与桥能力）。
//     环回白名单 + 禁 fullscreen 在 manifest schema 层把过（types.ts）。
// 崩溃隔离：帧体包 PluginBoundary（宿主渲染面自保——iframe 内容异常天然隔离
// 在独立 document，到不了宿主）。
//
// 尺寸（floating，2026-11-23 批）：**窗不是固定大小的**——右下角握把 `useDragGesture`
// 拖拽改宽高（实例 w/h 落在 plugin-window-store），←→↑↓ 微调；最小 320×240、
// 最大视口减 24。写死 460×360 是遗留（所有软件共用一个宽高 = 替插件决定一页纸多大），
// 不是设计决定。dock/fullscreen 不吃握把（前者的宽度是停靠栏的、后者是视口）。
//
// 拖拽（floating）：书眉 pointerdown → `useDragGesture`（2026-11-17 交互原语批 C3 · 4/9）。
// 换 pointer 的好处在这里最实在：**指针拖出窗口仍然收得到**——旧实现靠
// document 级 mousemove 硬扛（快速拖出书眉会断线），现在 `setPointerCapture`
// 把事件锁在书眉上，出窗照跟。位置经 store moveWindow 写回（视口边界夹持——
// 书眉恒可达）。帧内指针事件 stopPropagation：不向画布底座漏（pan 抢占防线第二道）。
//
// ⚠ **交互件不承载拖拽**（2026-11-18 实机修）：书眉带 pointer capture，按下关窗钮
// 再松手时指针事件被重定向到书眉，按钮收不到自己的 pointerup ⇒ 浏览器凑不齐
// click ⇒「× 点不动、窗关不掉」（批 C3 换 pointer 时埋的，旧 mousedown 不捕获故
// 无此症）。判据 = `isTopbarInteractiveTarget` 早退，与坞 `isComposerDragSurface` 同族。

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
} from 'react';
import { bindBridgeWindow, postBridgeEvent, unbindBridgeWindow } from '../../plugins/window-bridge';
import { closePluginWindow, focusPluginWindow } from '../../plugins/window-facility';
import { clampWindowPosition, clampWindowSize, type ViewportSize, type WindowSize } from '../../plugins/window-metrics';
import { pendingDocumentGrant } from '../../state/plugin-document-store';
import { type PluginWindowDef, type PluginWindowInstance, usePluginWindowStore } from '../../state/plugin-window-store';
import { useDragGesture } from '../interaction/use-drag-gesture';
import { PluginBoundary } from '../PluginBoundary';
import { isTopbarInteractiveTarget } from '../window-drag';

interface FrameProps {
  instance: PluginWindowInstance;
  def: PluginWindowDef;
}

/** 键盘微调步长（px）——与书脊/侧栏调宽同档，可聚焦件的键盘义务。 */
const RESIZE_STEP = 16;

/** 当前视口（夹持用）；渲染环境没有 window 时交给纯常量边界。 */
function viewportSize(): ViewportSize | undefined {
  return typeof window === 'undefined' ? undefined : { w: window.innerWidth, h: window.innerHeight };
}

/** 尺寸夹持（单一算式在 plugins/window-metrics）。 */
function clampSize(w: number, h: number): WindowSize {
  return clampWindowSize(w, h, viewportSize());
}

export function PluginWindowFrame({ instance, def }: FrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const boundWindowRef = useRef<Window | null>(null);
  const dragRef = useRef<{ offX: number; offY: number } | null>(null);
  /** 远端形态（环回页）：保住自己 origin + **不绑宿主桥**（见头注）。 */
  const remote = def.kind === 'remote';

  // 桥绑定生命周期：iframe onLoad 绑（容器侧绑定插件身份 + 广播就绪）；
  // 卸载时先尽力广播 window-closing（同拍移除，收到无保证——告警为限），
  // 再解绑。远端形态整段不参与（没绑过就不解）。
  useEffect(() => {
    if (remote) return;
    const bound = boundWindowRef;
    return () => {
      const cw = bound.current;
      if (cw) {
        postBridgeEvent(cw, 'window-closing', instance.windowId);
        unbindBridgeWindow(cw);
      }
    };
  }, [instance.windowId, remote]);

  const handleLoad = () => {
    if (remote) return; // 远端页不绑宿主桥（它不是插件代码，且拿不到桥协议）
    const cw = iframeRef.current?.contentWindow;
    if (!cw) return;
    boundWindowRef.current = cw;
    bindBridgeWindow(cw, instance.pluginName, instance.windowId, undefined, { documents: def.documents });
    postBridgeEvent(cw, 'bridge-ready', instance.windowId);
    // 文档通道（批 1）：开窗时带过文档 ⇒ 就绪后推令牌（窗凭令牌 doc.read，
    // 宿主从不把路径交给它去拼——路径只在这条事件里随令牌同行，窗拿到的仍只是
    // 「你要读哪一页」的标识而非文件系统权限）。
    const grant = def.documents ? pendingDocumentGrant(instance.windowId) : null;
    if (grant) {
      postBridgeEvent(cw, 'doc-open', instance.windowId, { docToken: grant.docToken, path: grant.path });
    }
  };

  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  /** 拖动期夹持：书眉恒可达（窗口最多缩到 120×48 露在屏上）。 */
  const winDrag = useDragGesture({
    onMove: (_e, d) => {
      const off = dragRef.current;
      if (!off) return;
      const { x, y } = clampWindowPosition(d.x - off.offX, d.y - off.offY, viewportSize());
      usePluginWindowStore.getState().moveWindow(instance.windowId, x, y);
    },
    onEnd: () => {
      dragRef.current = null;
    },
    onCancel: () => {
      dragRef.current = null;
    },
  });

  /** 尺寸手势（右下角握把）：起手快照 w/h，位移直接加——x/y 不动，只长身体。 */
  const sizeAtStartRef = useRef<{ w: number; h: number }>({ w: instance.w, h: instance.h });
  const sizeGesture = useDragGesture({
    onStart: () => {
      sizeAtStartRef.current = { w: instance.w, h: instance.h };
    },
    onMove: (_e, d) => {
      const next = clampSize(sizeAtStartRef.current.w + d.dx, sizeAtStartRef.current.h + d.dy);
      usePluginWindowStore.getState().resizeWindow(instance.windowId, next.w, next.h);
    },
  });

  const onResizePointerDown = (e: ReactPointerEvent) => {
    stop(e);
    focusPluginWindow(instance.windowId);
    if (e.button !== 0) return;
    /* 拖握把 = 改尺寸，不是扫过纸面选区（与书眉拖动同一条选区政策）。 */
    e.preventDefault();
    sizeGesture.begin(e);
  };

  const onResizeKeyDown = (e: ReactKeyboardEvent) => {
    const dw = e.key === 'ArrowRight' ? RESIZE_STEP : e.key === 'ArrowLeft' ? -RESIZE_STEP : 0;
    const dh = e.key === 'ArrowDown' ? RESIZE_STEP : e.key === 'ArrowUp' ? -RESIZE_STEP : 0;
    if (dw === 0 && dh === 0) return;
    e.preventDefault();
    const next = clampSize(instance.w + dw, instance.h + dh);
    usePluginWindowStore.getState().resizeWindow(instance.windowId, next.w, next.h);
  };

  const onTitlePointerDown = (e: ReactPointerEvent) => {
    stop(e);
    focusPluginWindow(instance.windowId);
    if (instance.mode !== 'floating') return;
    /* 交互件（关窗钮）**自己接手势**：书眉一旦 `setPointerCapture`，后续指针事件被
     * 重定向到书眉 ⇒ 按钮收不到配对的 pointerup ⇒ 浏览器凑不齐一次 click
     * ⇒「× 点不动」（2026-11-18 实机报障，批 C3 换 pointer 时引入；旧 mousedown
     * 实现在按钮上起拖但**不捕获**，click 照常派发，故那时没这个症状）。
     * 与坞的 `isComposerDragSurface`、侧栏行拖的「交互子件不承载拖行」同一条判据。 */
    if (isTopbarInteractiveTarget(e.target)) return;
    /* 拖动期禁选（2026-09-17 选区政策批）：浮窗是**页内**拖动（mousemove 移 DOM），
     * 指针会横穿纸面——不掐断就是「拖窗口 = 顺手划过一段纸面选区」（全应用默认
     * 不可选之后残留的最后一条：其它拖动面要么走 Tauri 原生移动循环、要么活动
     * 范围被自身家具圈住，只有浮窗能扫过整张纸）。交互件已在上一条闸门整段让路。 */
    e.preventDefault();
    dragRef.current = { offX: e.clientX - instance.x, offY: e.clientY - instance.y };
    winDrag.begin(e);
  };

  const modeClass = `pw-frame pw-frame-${instance.mode}`;
  // 浮动窗海拔 = 窗口档 + 焦点序（store z 单调递增——最后触碰在最上）；
  // dock 帧随停靠栏层，fullscreen 单窗盖满。
  const style =
    instance.mode === 'floating'
      ? {
          left: `${instance.x}px`,
          top: `${instance.y}px`,
          width: `${instance.w}px`,
          height: `${instance.h}px`,
          zIndex: `calc(var(--z-plugin-window) + ${instance.z})`,
        }
      : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 帧内指针事件是阻断面（stopPropagation 防漏画布 pan），非交互控件
    <div className={modeClass} style={style} onMouseDown={stop} onMouseUp={stop} onPointerDown={stop}>
      <PluginBoundary label={`插件窗 ${instance.windowId}`}>
        <div className="pw-frame-inner">
          {/* 书眉拖拽手柄（关窗有原生按钮）——批 C3 起走 pointerdown，不再触发
           *  noStaticElementInteractions（那条规则针对 onMouseDown 这类静态元素交互） */}
          <div className="pw-titlebar" onPointerDown={onTitlePointerDown}>
            <span className="pw-title">{def.title}</span>
            <span className="pw-title-plugin">{instance.pluginName}</span>
            <button
              type="button"
              className="pw-close"
              aria-label="关闭窗口"
              onClick={(e) => {
                stop(e);
                closePluginWindow(instance.windowId);
              }}
            >
              ✕
            </button>
          </div>
          <div className="pw-frame-body">
            <iframe
              ref={iframeRef}
              className="pw-iframe"
              title={def.title}
              src={def.entryUrl}
              // asset：opaque origin 隔离——不给 allow-same-origin（窗内容与宿主桥
              // 天然隔离；localStorage 等同源存储面不开——数据地盘走桥 fs）。
              // remote：给 allow-same-origin——跨源文档保住自己 origin（同源
              // EventSource/fetch 才通），父页仍拿不到它的 DOM；桥另行不绑。
              sandbox={
                remote
                  ? 'allow-scripts allow-forms allow-modals allow-same-origin'
                  : 'allow-scripts allow-forms allow-modals'
              }
              onLoad={handleLoad}
            />
          </div>
          {/* 右下角调宽握把（只 floating）：纯热区、hover/focus 显形墨角——
              与侧栏 `.ss-resize` 同一形态纪律。 */}
          {instance.mode === 'floating' ? (
            <button
              type="button"
              className="pw-resize"
              aria-label="拖拽调整窗口大小（聚焦后方向键微调）"
              onPointerDown={onResizePointerDown}
              onKeyDown={onResizeKeyDown}
            />
          ) : null}
        </div>
      </PluginBoundary>
    </div>
  );
}

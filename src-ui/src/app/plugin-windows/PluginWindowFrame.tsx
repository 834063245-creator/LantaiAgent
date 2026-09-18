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
// 拖拽（floating）：书眉 mousedown → document 级 mousemove/mouseup（快速
// 拖出书眉不断线——PaperPanel panningRef 同款 document 监听纪律）；
// 位置经 store moveWindow 写回（视口边界夹持——书眉恒可达）。帧内指针
// 事件 stopPropagation：不向画布底座漏（pan 抢占防线第二道）。

import { type MouseEvent as ReactMouseEvent, useEffect, useRef } from 'react';
import { bindBridgeWindow, postBridgeEvent, unbindBridgeWindow } from '../../plugins/window-bridge';
import { closePluginWindow, focusPluginWindow } from '../../plugins/window-facility';
import { type PluginWindowDef, type PluginWindowInstance, usePluginWindowStore } from '../../state/plugin-window-store';
import { PluginBoundary } from '../PluginBoundary';
import { isTopbarInteractiveTarget } from '../window-drag';

interface FrameProps {
  instance: PluginWindowInstance;
  def: PluginWindowDef;
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
    bindBridgeWindow(cw, instance.pluginName, instance.windowId);
    postBridgeEvent(cw, 'bridge-ready', instance.windowId);
  };

  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  const onTitleMouseDown = (e: ReactMouseEvent) => {
    stop(e);
    focusPluginWindow(instance.windowId);
    if (instance.mode !== 'floating') return;
    /* 拖动期禁选（2026-09-17 选区政策批）：浮窗是**页内**拖动（mousemove 移 DOM），
     * 指针会横穿纸面——不掐断就是「拖窗口 = 顺手划过一段纸面选区」（全应用默认
     * 不可选之后残留的最后一条：其它拖动面要么走 Tauri 原生移动循环、要么活动
     * 范围被自身家具圈住，只有浮窗能扫过整张纸）。交互件（关窗钮）除外——
     * 掐掉它的 mousedown 默认就是掐掉它的取焦，闸门不拦自己人。 */
    if (!isTopbarInteractiveTarget(e.target)) e.preventDefault();
    dragRef.current = { offX: e.clientX - instance.x, offY: e.clientY - instance.y };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const maxX = Math.max(0, window.innerWidth - 120);
      const maxY = Math.max(0, window.innerHeight - 48);
      const x = Math.min(Math.max(0, ev.clientX - d.offX), maxX);
      const y = Math.min(Math.max(0, ev.clientY - d.offY), maxY);
      usePluginWindowStore.getState().moveWindow(instance.windowId, x, y);
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const modeClass = `pw-frame pw-frame-${instance.mode}`;
  // 浮动窗海拔 = 窗口档 + 焦点序（store z 单调递增——最后触碰在最上）；
  // dock 帧随停靠栏层，fullscreen 单窗盖满。
  const style =
    instance.mode === 'floating'
      ? {
          left: `${instance.x}px`,
          top: `${instance.y}px`,
          zIndex: `calc(var(--z-plugin-window) + ${instance.z})`,
        }
      : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 帧内指针事件是阻断面（stopPropagation 防漏画布 pan），非交互控件
    <div className={modeClass} style={style} onMouseDown={stop} onMouseUp={stop} onPointerDown={stop}>
      <PluginBoundary label={`插件窗 ${instance.windowId}`}>
        <div className="pw-frame-inner">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: 书眉拖拽手柄（关窗有原生按钮） */}
          <div className="pw-titlebar" onMouseDown={onTitleMouseDown}>
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
        </div>
      </PluginBoundary>
    </div>
  );
}

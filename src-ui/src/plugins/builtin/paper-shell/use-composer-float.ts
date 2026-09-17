// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-float — 创作坞浮动化的纸壳侧机制域（paper-panel-split 同族的
// use-*.ts 落位）：坞位 state + 实测尺寸 + 拖动手势 + 让位带下发。
//
// 分工（单一权威源）：
//   - 坞位真源 = 本 hook 的 `pos`（null = 无覆盖 = CSS 默认居中坐底），落
//     localStorage（composer-float.ts 的 load/save）；
//   - 几何/吸附/命中判据 = composer-float.ts 纯函数（可单测）；
//   - 让位带 --composer-band 由本 hook 写 :root（旧 --composer-h-live 由坞自己
//     上报「坞高」，浮动态失效——让位带是槽主人的几何，收归一处）。**过渡期**由
//     本 hook 代发旧 token 一版：运行中 exe 内嵌的外壳 CSS 仍读它，只换产物不重编
//     exe 时那两处消费面要它续命（拆除条件见下方 effect 注释）；
//   - 坞本体（compose-dock 插件）**一字不知**：抓手判据基于坞书眉行的 DOM 命中
//     （事件从坞冒泡到槽，槽主人接手势），不给 PaperDockContext 加回调、不动
//     宿主面（faceDeps）基线。
//
// 手感（2026-09-17 拍板）：坞书眉行空白处/卷名按住即拖（无阈值——坞头点击本身
// 无其它语义）；拖动全程磁吸（左右缘/版心中轴/底带/最底缘）；双击坞头复位；
// 松手才落盘。**刻意不 preventDefault**：取消 pointerdown 会连带影响 dblclick
// 的跨引擎互操作（Chromium 曾按此对齐），复位手势优先；防误选由 CSS 的
// user-select:none（.pp-composer-header）承担——按下点不可选即不起选区。

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposerBox, ComposerPos, ComposerViewport } from './composer-float';
import {
  clampComposerPos,
  composerBandOf,
  isComposerHandle,
  loadComposerPos,
  saveComposerPos,
  snapComposerPos,
} from './composer-float';

/** 坞浮动域对 PaperPanel 的公开面。 */
export interface ComposerFloat {
  /** 槽元素 callback ref（React 19 清理式：量实测宽高，供夹紧/让位带用）。 */
  slotRef: (el: HTMLDivElement | null) => (() => void) | undefined;
  /** 槽内联位置（undefined = 无覆盖，走 CSS 默认位）。 */
  style: CSSProperties | undefined;
  /** 拖动中（CSS 抓手手感：grabbing）。 */
  dragging: boolean;
  /** 让位带 = 视口底 → 坞顶线（px）——覆盖层消费面按它重算。 */
  band: number;
  /** 槽 pointerdown（坞头命中判据在内）。 */
  onPointerDown: (e: React.PointerEvent) => void;
  /** 槽 dblclick（坞头双击 = 复位到版心居中坐底）。 */
  onDoubleClick: (e: React.MouseEvent) => void;
}

export function useComposerFloat(): ComposerFloat {
  /* 坞位（null = 无覆盖）——懒初始化读盘：挂载即回到用户上次摆的位置。 */
  const [pos, setPos] = useState<ComposerPos | null>(loadComposerPos);
  const [box, setBox] = useState<ComposerBox>({ w: 0, h: 0 });
  const [vp, setVp] = useState<ComposerViewport>(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const [dragging, setDragging] = useState(false);
  const slotEl = useRef<HTMLDivElement | null>(null);
  /** 松手落盘要读最新值（拖动期逐帧 setPos，闭包拿不到当帧值）。 */
  const posRef = useRef<ComposerPos | null>(pos);

  /* 视口尺寸（拖拽夹紧 + 存量坞位的读侧夹紧都按它算）。 */
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* 槽实测宽高：坞高随内容变（思考展开/附件/墨量册），宽随窗口变——
   * ResizeObserver 一处跟上（jsdom 无 RO：只量首帧，测试自铺桩）。 */
  const slotRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    slotEl.current = el;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (slotEl.current === el) slotEl.current = null;
    };
  }, []);

  /* 读侧夹紧：存量坞位遇窗口缩小不越界（值不改写——窗口涨回去坞回原处）。
   * 未实测（宽高为 0）时不夹：无真尺寸的夹紧只会算错。 */
  const effective = useMemo(() => {
    if (!pos) return null;
    if (box.w <= 0 || box.h <= 0) return pos;
    return clampComposerPos(pos, vp, box);
  }, [pos, vp, box]);

  const band = composerBandOf(effective, box.h);

  /* 让位带下发 :root（CSS 消费面：递牒卡宿主 / 插件 dock）。 */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--composer-band', `${Math.round(band)}px`);
    return () => {
      root.style.removeProperty('--composer-band');
    };
  }, [band]);

  /* ── 过渡期旧 token 代发（**随下次整包重编删除**，债在 docs/landmine-map.md）──
   * 旧 `--composer-h-live`（坞自报坞高）的出版者已随坞产物拆除，但**运行中 exe 的
   * 外壳 CSS 是内嵌在 exe 里的**（`shell.css` 的 .psh-host / `plugin-windows.css` 的
   * .pw-dock 仍读它）——只换产物不重编 exe 时那两处会回退到 `--composer-h`(66px)，
   * 让位少 44px/32px、压住坞顶。故由槽主人（本 hook 已测坞高）在过渡期代发旧口径，
   * 新口径 `--composer-band` 同帧并存：新旧两代消费面都正确。
   * 拆除条件：下一次 `cargo tauri build`（整包重编 ⇒ 内嵌 CSS 换成本仓库的新式）——
   * 届时本 effect 内两行与 landmine 条目一并删除。 */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--composer-h-live', `${Math.round(box.h)}px`);
    return () => {
      root.style.removeProperty('--composer-h-live');
    };
  }, [box.h]);

  const style = useMemo<CSSProperties | undefined>(
    () => (effective ? { left: `${effective.left}px`, bottom: `${effective.bottom}px`, transform: 'none' } : undefined),
    [effective],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!isComposerHandle(e.target)) return;
    const el = slotEl.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return; // 未实测（jsdom / 未布局）：不起拖
    /* 起拖快照：坞位 + 指针起点 + 当帧视口（拖动期窗口若变，松手后由读侧夹紧收）。
     * 坞在 CSS 默认位（pos=null）时也从实测矩形起算——拖动即接管为显式坞位。 */
    const vpNow = { w: window.innerWidth, h: window.innerHeight };
    const start = { x: e.clientX, y: e.clientY, left: r.left, bottom: vpNow.h - r.bottom };
    const boxNow = { w: r.width, h: r.height };
    let moved = false;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      moved = true;
      const raw = {
        left: start.left + (ev.clientX - start.x),
        bottom: start.bottom - (ev.clientY - start.y),
      };
      const next = snapComposerPos(clampComposerPos(raw, vpNow, boxNow), vpNow, boxNow);
      posRef.current = next;
      setPos(next);
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      setDragging(false);
      /* 只点不拖（moved=false）= 坞位原样（不落盘）——否则单击坞头会把已存的
       * 坞位当「无覆盖」清掉，坞无故跳回底部。 */
      if (moved) saveComposerPos(posRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }, []);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!isComposerHandle(e.target)) return;
    posRef.current = null;
    setPos(null);
    saveComposerPos(null);
  }, []);

  return { slotRef, style, dragging, band, onPointerDown, onDoubleClick };
}

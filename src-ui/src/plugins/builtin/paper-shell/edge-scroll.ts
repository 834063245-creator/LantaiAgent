// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 边缘滚动子系统（2026-09-17 立为原生功能）——拖拽手势贴视口四缘即持续平移视口
// （RTS 缘滚同族：入带起滚、越深越快、越出画布封顶）。三件事一处收口：
//
// ① **策略**：基准带宽/限速 + 灵敏度映射 + 设置缺省容错（`edgeScrollTuning`）。
//    曲线本身仍是 `paper/canvas-math.autoPanVector`（纯几何，单一真源）；本模块只
//    提供它的**参数与开关**。策略常量刻意落在插件域：`autoPanVector` 早已收显式
//    band/maxSpeed 参数 ⇒ 产物自带策略即可换手感，**宿主面零动**（不必重编 exe）。
// ② **设置订阅**：挂载读一次 + 保存广播重读（`useEdgeScrollTuning`）——手势帧里
//    绝不 JSON.parse（滚屏是每帧路径）。
// ③ **帧循环**：`useEdgeAutoScroll` 一个 rAF 循环服务全部拖拽手势（起手势给
//    「取指针 + 跟手回调」的取数器，松手即撤）。此前拖块/拖选各写一套循环，
//    参数与停摆语义漂移只是时间问题。
//
// 手势接入三步（样板见 use-paper-drag / use-paper-viewport）：
//   const edge = useEdgeAutoScroll(canvasRef);
//   // 起手势（阈值过后）：
//   edge.start(() => { const d = ref.current; if (!d?.moved) return null;
//     return { x: d.lastX, y: d.lastY, afterPan: () => syncPreview(d) }; });
//   // 松手：edge.stop()

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
/* 类型面直连真源（esbuild 擦除 `import type`，不进产物）；**运行时**依赖一律经
 * './host'（产物域重定向到 host.aliased），勿混。 */
import type { AppSettings } from '../../../settings';
/* ⚠ 只经 './host' 引用宿主面（产物域由 esbuild 重定向到 host.aliased）——
 *  直接 import 项目内模块会破「插件自包含」契约。 */
import { autoPanVector, loadSettings, onSettingsSaved, panBy, useCanvasViewStore } from './host';

/** 边缘滚动基准与可调区（**唯一真源**——改手感只改这里）。
 *  带宽/限速沿用 2026-09-07 拖选自动滚屏的原值（两代手势同一条曲线，禁各自调参）。 */
export const EDGE_SCROLL = {
  /** 基准感应带宽（px）：指针距画布边缘进带即起滚 */
  band: 36,
  /** 基准单帧平移上限（px/帧；60fps ≈ 1560px/s）；越出画布封顶 1.5× */
  maxSpeed: 26,
  /** 灵敏度可调区（倍率）与缺省 */
  sensMin: 0.5,
  sensMax: 2,
  sensDefault: 1,
} as const;

/** 一帧的力（px）：dx/dy = 该帧应施加的视口平移量（喂 panBy 即内容向指针反方向让出）。 */
export interface EdgePan {
  dx: number;
  dy: number;
}

const NO_PAN: EdgePan = { dx: 0, dy: 0 };

/** 生效调参（读侧产出：曲线直接吃这三个数）。 */
export interface EdgeScrollTuning {
  enabled: boolean;
  band: number;
  maxSpeed: number;
}

export function clampSensitivity(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : EDGE_SCROLL.sensDefault;
  return Math.min(EDGE_SCROLL.sensMax, Math.max(EDGE_SCROLL.sensMin, n));
}

/** 设置 → 调参（缺省容错：旧存储无此字段 = 开 + 基准灵敏度；毒化值一律夹clamp）。
 *  灵敏度 = **一个滑杆的整体强弱**：滚速线性跟手（× sens），感应带宽温和同向放大
 *  （× √sens）——「越灵敏 = 起滚越早 + 滚得越快」，避免单改一项造成手感错位。 */
export function edgeScrollTuning(s: AppSettings): EdgeScrollTuning {
  const raw = s.canvas?.edgeScroll;
  const sens = clampSensitivity(raw?.sensitivity);
  return {
    enabled: raw?.enabled !== false,
    band: Math.round(EDGE_SCROLL.band * Math.sqrt(sens)),
    maxSpeed: EDGE_SCROLL.maxSpeed * sens,
  };
}

/** 设置订阅载体（挂载读一次 + 保存广播重读；手势帧只读 ref）。 */
export function useEdgeScrollTuning(): MutableRefObject<EdgeScrollTuning> {
  const ref = useRef<EdgeScrollTuning>(edgeScrollTuning(loadSettings()));
  useEffect(() => {
    const sync = (): void => {
      ref.current = edgeScrollTuning(loadSettings());
    };
    sync();
    return onSettingsSaved(sync);
  }, []);
  return ref;
}

/** 手势每帧取数：返回 null = 手势已收（循环自然停摆）。 */
export interface EdgeScrollFrame {
  /** 指针最新位（client 坐标） */
  x: number;
  y: number;
  /** 视口平移**之前**（选区延伸用：延伸要反映已提交布局，先延后滚） */
  beforePan?: (pan: EdgePan) => void;
  /** 视口平移**之后**（块影/纸条/ghost 跟手：要按新 pan 复位，块才不脱手） */
  afterPan?: (pan: EdgePan) => void;
}

/** 边缘滚动帧循环（一手势一个实例；松手 stop() 或取数器返回 null 即停摆）。 */
export function useEdgeAutoScroll(canvasRef: MutableRefObject<HTMLElement | null>): {
  start: (frame: () => EdgeScrollFrame | null) => void;
  stop: () => void;
} {
  const tuningRef = useEdgeScrollTuning();
  const rafRef = useRef(0);
  const frameRef = useRef<(() => EdgeScrollFrame | null) | null>(null);

  const tick = useCallback((): void => {
    rafRef.current = 0;
    const frame = frameRef.current?.() ?? null;
    if (!frame) {
      frameRef.current = null; // 手势已收——停摆（下一次 start 重新起循环）
      return;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) {
      const t = tuningRef.current;
      const pan = t.enabled
        ? autoPanVector(frame.x - rect.left, frame.y - rect.top, rect.width, rect.height, t.band, t.maxSpeed)
        : NO_PAN;
      frame.beforePan?.(pan);
      if (pan.dx !== 0 || pan.dy !== 0) {
        useCanvasViewStore.getState().setView((cur) => panBy(cur, pan.dx, pan.dy));
      }
      frame.afterPan?.(pan);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [canvasRef, tuningRef]);

  const start = useCallback(
    (frame: () => EdgeScrollFrame | null): void => {
      frameRef.current = frame;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
    },
    [tick],
  );

  const stop = useCallback((): void => {
    frameRef.current = null;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  /* 卸载即撤（挂载期手势跨卸载 = 循环永久跟着跑）。 */
  useEffect(() => stop, [stop]);

  return { start, stop };
}

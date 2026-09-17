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
  /** **悬停即滚**（2026-09-17 用户「为什么不支持直接滚动视口」）：指针停在画布边缘就
   *  滚，不必先按住东西（RTS 相机标准形态）。**缺省开**——同日首版判为缺省关，理由是
   *  「画布铺满正文，读的时候鼠标停在屏底会让内容跑掉」；实测反馈是**根本发现不了这个
   *  功能**（用户「好像没生效」），且本档的误触面早被三处约束压住（画布外不滚 / 按键
   *  让位 / 交互件当悬停面 + 入带驻留 120ms）——故翻案为缺省开，不想要的人关掉即可。 */
  hover: boolean;
  band: number;
  maxSpeed: number;
}

export function clampSensitivity(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : EDGE_SCROLL.sensDefault;
  return Math.min(EDGE_SCROLL.sensMax, Math.max(EDGE_SCROLL.sensMin, n));
}

/** 设置 → 调参（缺省容错：旧存储无此字段 = 全开 + 基准灵敏度；毒化值一律夹取）。
 *  灵敏度 = **一个滑杆的整体强弱**：滚速线性跟手（× sens），感应带宽温和同向放大
 *  （× √sens）——「越灵敏 = 起滚越早 + 滚得越快」，避免单改一项造成手感错位。 */
export function edgeScrollTuning(s: AppSettings): EdgeScrollTuning {
  const raw = s.canvas?.edgeScroll;
  const sens = clampSensitivity(raw?.sensitivity);
  return {
    enabled: raw?.enabled !== false,
    hover: raw?.hover !== false,
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

/* ── 悬停边缘滚动（RTS 相机标准形态，2026-09-17 用户「为什么不支持直接滚动视口」）──
 * 指针停在画布边缘就滚，不必先按住东西。与拖拽族**共用**同一策略/曲线/帧循环，
 * 但有三处刻意不同（都不是疏漏，是两类场景的差别）：
 *
 * ① **只在指针画布内时滚**。拖拽族允许越出画布继续追（封顶 1.5×）——那是「把手里的
 *    东西带出可视区」；悬停族若照办，指针挪去侧栏/书眉就永远滚不停（跟随相机）。
 * ② **任一鼠标键按下即让位**。拖拽手势自带循环，两套同时跑 = 双倍速；且按下键的那一
 *    刻就是「我在操作内容」而不是「我在挪镜头」。
 * ③ **指针悬在交互面上不滚**（按钮/输入件/创作坞/小地图/纸条/文类签/宽度柄/角柄）——
 *    否则想点按钮、想在输入框打字，画布会自己跑掉；画布上的正文（.pp-block）**不豁免**：
 *    RTS 的镜头就是贴地图边缘走，纸面即地图。**贴边浮件（目次带）视为画布本体**
 *    （见 HOVER_ALLOW_DOCKS 注：它不属画布 DOM 却压在右缘感应带上，不认它 = 右缘没有
 *    边缘滚动）。
 *
 * 另加一段**入带驻留**（HOVER_DWELL_MS）：路过边缘（例如去点创作坞）不触发，只有
 * 真的把指针停在带上才起滚——抵消悬停族没有「按住」这个显式意图的代价。 */

/** 入带驻留（ms）：指针在带内停够这么久才起滚（路过不算）。 */
export const HOVER_DWELL_MS = 120;

/** 悬停不滚的交互面（选择器；`.pp-block` 刻意不在列——纸面即地图）。
 *  ⚠ 只列**交互件与物理件**，不列容器（见下方 HOVER_ALLOW_DOCKS 的缘由）；
 *  `.pp-composer` / `.pp-minimap` 是「瞄准面」（前者含输入件、后者点击即跳转）整块豁免。 */
const HOVER_EXCLUDE = [
  'button',
  'input',
  'textarea',
  'select',
  'a',
  '[contenteditable="true"]',
  '.pp-composer',
  '.pp-minimap',
  '.pp-strip',
  '.pp-kind',
  '.pp-resize',
  '.pp-region-edge',
  '.pp-region-corner',
].join(',');

/** 贴边浮件 = **画布的一部分**（覆盖件宿主不属画布 DOM，但压在画布边缘上）：
 *  目次带是全高 64px、贴在画布最右侧——正盖住右缘那条 36px 感应带（实机：画布
 *  2560 宽、右带 2524–2560、目次带 2496–2560）。若不认它，用户把鼠标贴到屏幕最右
 *  （真机此处命中的是 `nav.pp-toc` 本身，不是卡片）会被判「不在画布上」⇒ 右缘在
 *  用户视角里**根本没有边缘滚动**（2026-09-17 实机报「右缘不生效」即此）。
 *  故：贴边浮件上的悬停**照滚**，只豁免它上面的交互件——卡片是 `button`（已在
 *  HOVER_EXCLUDE），瞄准卡片时不滚（卡片随世界滚动，一滚就点不中）。 */
const HOVER_ALLOW_DOCKS = '.pp-toc';

/** 悬停此刻是否**该滚**（纯判据，供 hook 与考官共用）：
 *  开关+悬停档都开着、没按键、指针落在画布上（画布本体**或**贴边浮件；贴边浮件见
 *  HOVER_ALLOW_DOCKS 注）、且不在交互面上。带宽判据不在此（交给循环里的 autoPanVector）。 */
export function hoverEdgeEligible(args: {
  target: Element | null;
  canvas: Element | null;
  clientX: number;
  clientY: number;
  buttons: number;
  tuning: EdgeScrollTuning;
  /** 画布 rect（调用方给，避免纯判据自己碰布局） */
  rect: { left: number; top: number; width: number; height: number } | null;
}): boolean {
  const { target, canvas, clientX, clientY, buttons, tuning, rect } = args;
  if (!tuning.enabled || !tuning.hover) return false;
  if (buttons !== 0) return false; // 拖拽手势在途 → 让位（避免两套同时滚）
  if (!canvas || !target) return false;
  if (target.closest(HOVER_EXCLUDE)) return false;
  // 在画布上（本体或贴边浮件）——**不含**画布外的宿主/弹层（设置面板、递牒卡等）
  if (!canvas.contains(target) && !target.closest(HOVER_ALLOW_DOCKS)) return false;
  if (!rect) return false;
  const ix = clientX - rect.left;
  const iy = clientY - rect.top;
  // ① 画布内（带内带外交给 autoPanVector 判；此处只排除画布外——见本段注 ①）
  return ix >= 0 && iy >= 0 && ix <= rect.width && iy <= rect.height;
}

/** 悬停即滚（相机自主滚动）：常驻监听指针，满足条件即起循环；不满足即停。
 *  挂载点 = 视口域（use-paper-viewport——摄像机的家）。 */
export function useHoverEdgeScroll(canvasRef: MutableRefObject<HTMLElement | null>): void {
  const tuningRef = useEdgeScrollTuning();
  const { start, stop } = useEdgeAutoScroll(canvasRef);
  /** 指针最新位（client）+ 是否暖机完成（驻留期满） */
  const ptrRef = useRef<{ x: number; y: number } | null>(null);
  const dwellTimerRef = useRef(0);
  const armedRef = useRef(false);

  useEffect(() => {
    const disarm = (): void => {
      if (dwellTimerRef.current) {
        window.clearTimeout(dwellTimerRef.current);
        dwellTimerRef.current = 0;
      }
      armedRef.current = false;
      stop();
    };

    /** 指针此刻是否**可滚**（判据 = hoverEdgeEligible，与考官共用同一函数）。 */
    const eligible = (e: MouseEvent): boolean =>
      hoverEdgeEligible({
        target: e.target instanceof Element ? e.target : null,
        canvas: canvasRef.current,
        clientX: e.clientX,
        clientY: e.clientY,
        buttons: e.buttons,
        tuning: tuningRef.current,
        rect: canvasRef.current?.getBoundingClientRect() ?? null,
      });

    const arm = (): void => {
      if (armedRef.current) return;
      armedRef.current = true;
      start(() => {
        const p = ptrRef.current;
        const canvas = canvasRef.current;
        if (!p || !canvas) return null;
        return { x: p.x, y: p.y };
      });
    };

    const move = (e: MouseEvent): void => {
      if (!eligible(e)) {
        ptrRef.current = null;
        disarm();
        return;
      }
      ptrRef.current = { x: e.clientX, y: e.clientY };
      if (armedRef.current) return; // 循环在跑：位置已更新，驻留不必重来
      // ② 入带驻留：进带计时，出带清零（路过不算，停够才滚）
      if (dwellTimerRef.current) return;
      const canvas = canvasRef.current as HTMLElement;
      const rect = canvas.getBoundingClientRect();
      const t = tuningRef.current;
      const nearEdge =
        e.clientX - rect.left <= t.band ||
        rect.right - e.clientX <= t.band ||
        e.clientY - rect.top <= t.band ||
        rect.bottom - e.clientY <= t.band;
      if (!nearEdge) return;
      dwellTimerRef.current = window.setTimeout(() => {
        dwellTimerRef.current = 0;
        arm();
      }, HOVER_DWELL_MS);
    };

    /* 按下键 / 指针离开文档 / 窗口失焦：立即收（③ 让位拖拽族；④ 不给「跟随相机」）。
     * mousedown 走捕获面：先于拖拽域的 window 监听跑到，绝不多滚一帧。 */
    const down = (): void => disarm();
    const leave = (): void => disarm();

    window.addEventListener('mousemove', move);
    window.addEventListener('mousedown', down, true);
    document.addEventListener('mouseleave', leave);
    window.addEventListener('blur', leave);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mousedown', down, true);
      document.removeEventListener('mouseleave', leave);
      window.removeEventListener('blur', leave);
      disarm();
    };
  }, [canvasRef, start, stop, tuningRef]);
}

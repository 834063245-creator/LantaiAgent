// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 视口域（paper-panel-split C2）——PaperPanel 的摄像机：view/canvasSize 订阅、
// 平移（rAF 帧合并）、滚轮缩放、Home 回锚、LOD 缩远、重栅格化锐化、视口
// 持久化、尺寸 RO、世界点守恒、重挂清除。焦点飞行（flyTo 族）在
// use-paper-focus——本域只产出飞行抢占所需的 focusRafRef/focusFlightRef 载体。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createFocusFlightScheduler,
  getCanvasStore,
  injectPaperTokens,
  lodActive,
  panBy,
  scheduleCanvasSave,
  useCanvasViewStore,
  useShellStore,
  viewForAnchor,
  viewportWorldRect,
  wheelFactor,
  zoomAt,
} from './host';
import type { PaperCore } from './use-paper-sessions';

/** 视口域（paper-panel-split C2，自 PaperPanel 739-1049 + 1698-1813 域内原样搬入）。
 *  挂载序硬约束（paper-panel-split-plan §3）：本 hook 必须晚于 usePaperSessions
 *  （activeRegion 镜像先落，重挂清除 effect 才能选到活跃卷）。 */
export function usePaperViewport(core: PaperCore | null) {
  /* 视口状态（Stage-3：书脊定位器共享真源——canvas-view-store app 级单例，
   * PaperPanel 读写；书脊/侧边栏经 requestFocus 驱动摄像机） */
  const view = useCanvasViewStore((s) => s.view);
  const setView = useCanvasViewStore((s) => s.setView);
  const canvasSize = useCanvasViewStore((s) => s.canvasSize);
  const setCanvasSize = useCanvasViewStore((s) => s.setCanvasSize);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** 纸面根（.pp-root）：挂载时注入版式 token 为 CSS 变量（单一真源 type-tokens）。 */
  const paperRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (paperRootRef.current) injectPaperTokens(paperRootRef.current);
  }, []);
  /** 世界层（pp-world）引用：缩放停稳后摘 will-change + 强制 reflow 用。 */
  const worldRef = useRef<HTMLDivElement | null>(null);

  /* ── 缩远墨迹（P4 LOD）：zoom 低于迟滞阈值时块/纸条 DOM 退场，InkLayer 画
   * 真墨行条骨架——远看真卷轴 + 远缩性能防线（阈值间往返不闪烁）。 ── */
  const [lod, setLod] = useState(false);
  const lodRef = useRef(false);
  useEffect(() => {
    const sync = () => {
      const next = lodActive(useCanvasViewStore.getState().view.zoom, lodRef.current);
      if (next !== lodRef.current) {
        lodRef.current = next;
        setLod(next);
      }
    };
    sync();
    return useCanvasViewStore.subscribe(sync);
  }, []);

  /* ── 文字锐化（2026-08-30）：世界层 will-change 只在交互期挂。
   * 常驻 will-change:transform 会让浏览器固定合成层栅格化分辨率，放大时
   * GPU 拉伸旧位图、文字发虚；只有层内容变 dirty（重排）才按当前档位重新
   * 栅格化。这里订阅 view 变化（wheel/pan/动画全源）：变化中挂 live 保合成
   * 层流畅 + 重置 settle 定时器；停稳 120ms 摘 live + 强制 reflow，逼浏览器
   * 按当前档位重新栅格化。subscribe 模式对齐 LOD effect（不依赖 React 渲染
   * 周期，view 变化在 store 层即触发）。 */
  const rerasterTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const sync = () => {
      const world = worldRef.current;
      if (!world) return;
      world.classList.add('pp-world--live');
      if (rerasterTimerRef.current) window.clearTimeout(rerasterTimerRef.current);
      rerasterTimerRef.current = window.setTimeout(() => {
        const el = worldRef.current;
        if (!el) return;
        el.classList.remove('pp-world--live');
        void el.offsetHeight; // 强制同步 reflow → 触发重新栅格化
        rerasterTimerRef.current = null;
      }, 120);
    };
    sync();
    return useCanvasViewStore.subscribe(sync);
  }, []);
  useEffect(
    () => () => {
      if (rerasterTimerRef.current) window.clearTimeout(rerasterTimerRef.current);
    },
    [],
  );

  /* R2 视口持久化（2026-09-05）：view 变化（pan/zoom）→ 防抖落盘 canvas.json
   * （复用 scheduleCanvasSave 500ms 窗口）。平移/缩放是高频写——防抖合并；
   * 恢复视图（restoreView）也触发，但用户不动视口时不会反复写。 */
  useEffect(() => {
    if (!core) return;
    let saveTimerRef = 0;
    const sync = () => {
      if (saveTimerRef) window.clearTimeout(saveTimerRef);
      saveTimerRef = window.setTimeout(() => {
        const pp = useShellStore.getState().projectPath;
        if (pp) void scheduleCanvasSave(core.panelId, pp);
      }, 500);
    };
    sync();
    const un = useCanvasViewStore.subscribe(sync);
    return () => {
      un();
      if (saveTimerRef) window.clearTimeout(saveTimerRef);
    };
  }, [core]);

  /* 初始视口：锚点对视口下缘（D-R1-3）。画布尺寸变化时保持锚点关系 */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setCanvasSize(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);
    setCanvasSize(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, [setCanvasSize]);

  /* 尺寸变化 = 世界点守恒（2026-09-01 视角抢夺修复）：旧实现任何尺寸变化都把
   * pan 重置回默认锚点——用户视角被暴力抢回原点（模型下拉开合/窗口缩放/侧栏
   * 开合等一切引发画布 1px 尺寸差的场景全中招）。新语义：保持「锚点屏幕位置
   * 下的世界坐标」跨尺寸不动；只有首测（无前尺寸）才落默认锚点 pan。
   * ⚠ 首测读 render 闭包值（挂载时 = store 陈旧值/默认 800×600），RO effect
   * 先跑会同步写入真实尺寸——随后本 effect 二跑守恒从旧锚点 (400,504) 推世界
   * 点。此自洽链路期间**禁止任何其它 effect 抢先改写 pan**（2026-09-02 首挂
   * 视角错位尸检：旧「重挂回锚」effect 用 live 尺寸抢先落锚 (632,613)，守恒
   * 二跑从被改的 pan 反推出虚构世界点 (−232,−109)，把新旧锚差 (+232,+109)
   * 当用户平移补偿回去 → 首次进画布 pan=(864,722) 偏移，重进（store 尺寸已
   * 持久）反而正常——间歇性病灶的来源）。 */
  const prevCanvasSizeRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const cur = { w: canvasSize.w, h: canvasSize.h };
    const prev = prevCanvasSizeRef.current;
    prevCanvasSizeRef.current = cur;
    if (!prev) {
      // R2 冷启动聚焦（2026-09-05）：恢复过视口（canvas.json view 字段 →
      // loadCanvasFromDisk 已 restoreView 写进 store）→ 用恢复值，不落默认锚
      //（restoredView 非空 = 本次恢复的视图尚未被用户动过）；否则照旧落锚。
      const restored = useCanvasViewStore.getState().restoredView;
      if (!restored) {
        const { panX, panY } = viewForAnchor(cur.w, cur.h);
        setView((v) => ({ ...v, panX, panY }));
      }
      return;
    }
    if (prev.w === cur.w && prev.h === cur.h) return;
    const v = useCanvasViewStore.getState().view;
    const a0 = { x: prev.w / 2, y: viewForAnchor(prev.w, prev.h).panY };
    const world = { x: (a0.x - v.panX) / v.zoom, y: (a0.y - v.panY) / v.zoom };
    const a1 = { x: cur.w / 2, y: viewForAnchor(cur.w, cur.h).panY };
    setView((old) => ({ ...old, panX: a1.x - world.x * old.zoom, panY: a1.y - world.y * old.zoom }));
  }, [canvasSize.w, canvasSize.h, setView]);

  /* 画布重挂 = 干净的定位面：清掉上一轮残留定位请求（2026-09-02 修复：原版
   * 还在此处 setView 回锚——与上方守恒 effect 首测分支职责重复，且用 live
   * 尺寸抢先落锚破坏守恒自洽（见上注释尸检）。回锚职责收归守恒 effect：每次
   * 挂载 prevCanvasSizeRef 归 null，首测分支天然落锚（重挂时闭包 = store
   * 持久尺寸，即时回锚，语义等价且无竞态）。
   * R2 冷启动聚焦兜底（2026-09-05）：本工作区画布无恢复视图（旧版 canvas.json
   * 无 view 字段）且摊开卷非空 → 定位到活跃卷（或首个摊开卷）——不裸站原点。
   * 有恢复视图（新数据）→ 视角已在上次视野，只清残留 pending。 */
  useEffect(() => {
    const cvs = useCanvasViewStore.getState();
    if (!cvs.restoredView && core) {
      const canvas = getCanvasStore(core.panelId).getState();
      const spreadKeys = Object.keys(canvas.spread);
      if (spreadKeys.length > 0) {
        const target =
          canvas.activeSessionId && canvas.spread[canvas.activeSessionId] ? canvas.activeSessionId : spreadKeys[0];
        cvs.requestFocus(target);
        return;
      }
    }
    cvs.requestFocus(null);
  }, [core]);

  /* 视口虚拟化输入 */
  const viewRect = useMemo(
    () => viewportWorldRect(view, canvasSize.w, canvasSize.h),
    [view, canvasSize.w, canvasSize.h],
  );

  /* ── 交互：平移 / 缩放 ── */
  const panningRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const [panning, setPanning] = useState(false);
  /* rework P1-1：缩放守卫——滚轮缩放期间/刚停（600ms）不判自动选中（缩放是读细节不改归属） */
  const zoomGuardUntilRef = useRef(0);
  /* 焦点飞行载体（use-paper-focus / 自动选中消费——wheel 与手动拖拽抢占飞行）。 */
  const focusRafRef = useRef(0);
  const focusFlightRef = useRef(createFocusFlightScheduler());

  /* 缩放：原生非被动监听（React 合成 wheel 是 passive，preventDefault 无效） */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      // R3.5 浮动 minimap：滚轮在 minimap 上 = 缩放 minimap 本体，不缩放画布
      if (t?.closest('.pp-minimap')) return;
      if (!e.ctrlKey && t?.closest('pre, .pp-out')) return;
      e.preventDefault();
      // 用户缩放 = 手动接管视口：取消在途定位动画（否则动画会跟手抢 pan）
      if (focusRafRef.current) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = 0;
        focusFlightRef.current.end();
      }
      useCanvasViewStore.getState().requestFocus(null);
      // 缩放守卫：记录「最近一次缩放」时刻，自动选中在其后 600ms 内不判
      zoomGuardUntilRef.current = performance.now() + 600;
      const rect = el.getBoundingClientRect();
      setView((v) => zoomAt(v, e.clientX - rect.left, e.clientY - rect.top, wheelFactor(e.deltaY)));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [setView]);

  /* 回原点快捷键（D-R1-1 方位感）：Home → 视口回锚点几何 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Home' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      const { panX, panY } = viewForAnchor(canvasSize.w, canvasSize.h);
      setView((v) => ({ ...v, panX, panY }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canvasSize.w, canvasSize.h, setView]);

  const onCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    // 空白处按下 → 开始平移（块/流区有自己的处理，不落到这里）
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('pp-world')) {
      if (e.button !== 0) return;
      e.preventDefault();
      // 用户拖拽 = 手动接管视口：取消在途定位动画（否则动画会跟手抢 pan）
      if (focusRafRef.current) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = 0;
        focusFlightRef.current.end();
      }
      useCanvasViewStore.getState().requestFocus(null);
      panningRef.current = { lastX: e.clientX, lastY: e.clientY };
      setPanning(true);
    }
  }, []);

  useEffect(() => {
    if (!panning) return;
    /* 材质批修复（2026-09-01）：平移 setView 按 rAF 帧合并——mousemove 只累计
     * 增量，每帧至多一次 setView。此前鼠标事件频率直接打满同步重渲染，区域
     * 巨大（万级像素高）+ 目次带重渲染时更新嵌套爆 React #185 上限，帧呈现
     * 饿死 = 整窗冻在旧帧（实机打回「流区透明」即此：新样式永远排不上屏）。 */
    let raf = 0;
    let pendX = 0;
    let pendY = 0;
    const flush = () => {
      raf = 0;
      const dx = pendX;
      const dy = pendY;
      pendX = 0;
      pendY = 0;
      if (dx !== 0 || dy !== 0) setView((v) => panBy(v, dx, dy));
    };
    const move = (e: MouseEvent) => {
      const p = panningRef.current;
      if (!p) return;
      pendX += e.clientX - p.lastX;
      pendY += e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const up = () => {
      // ⚠ 必须清 panningRef：否则 moving 里 panningRef.current != null 恒 true，
      // 第一次拖画布后自动选中永远被当成“平移中”而取消计时。
      panningRef.current = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      flush(); // 松手把尾巴增量落完，视角精确停在指针下
      setPanning(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [panning, setView]);

  /* 稳定引用（性能专项第二刀）：平移/缩放每帧 view 变——回调读 ref 而非依赖
   * view/layout，拖拽/移位回调才可零依赖稳定（memo 友好，不逐帧重建闭包）。 */
  const viewRef = useRef(view);
  viewRef.current = view;

  return {
    view,
    canvasSize,
    canvasRef,
    paperRootRef,
    worldRef,
    lod,
    viewRect,
    viewRef,
    panning,
    panningRef,
    zoomGuardUntilRef,
    focusRafRef,
    focusFlightRef,
    onCanvasMouseDown,
  };
}

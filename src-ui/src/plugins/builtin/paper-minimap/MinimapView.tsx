// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 小地图（D-R1-1 方位感件——全画布内容包围盒 + 视口框投影，点击跳转）。
// 2026-09-05 插件化：从 PaperPanel 迁出的独立插件组件（hologram/paper-minimap），
// 消费 usePaperRegion / usePaperDock（覆盖层上下文）——数据真源仍在纸壳
// （画布状态所有者），插件只拿渲染形态。
//
// 历史沿革（保留内联注释）：
//   V3b 欠账接回（2026-08-30）：pointer-events 开启，点击像素反解世界坐标滑过去。
//   R3 多卷版（2026-09-05）：全量摊开卷墨条 + 每卷卷框（活跃卷朱砂加粗）+
//     原点十字。纯几何抽离到 paper/minimap-core（可单测）。重画依赖沿用 P2-3
//     纪律：以 blocks/layout/extent 内层引用为依赖 → 平移帧零重画。
//   R3.5 浮动化：可拖动 + 滚轮缩放 + localStorage 记忆。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampViewportFrame,
  inkBarsFor,
  inkColorOf,
  minimapProject,
  regionFrame,
  usePaperDock,
  usePaperRegion,
} from './host';
import './minimap.css';

/** 书眉高（tokens.css --bar-h 的 TS 侧镜像）——小地图默认位不得爬进书眉带
 *  （那一段是窗口拖动热区，压上去会把设置/窗口钮挡掉）。 */
const TITLE_BAR_H = 56;
/** 拖动阈值（px）：超过即视为拖块（区分点击） */
const DRAG_THRESHOLD = 6;

/** 小地图默认位（右下角）：bottom = 创作坞让位带 + 18 呼吸（2026-09-17 浮动化：
 *  带 = 视口底 → 坞顶线，坞拖到哪跟到哪）。坞在上半屏时带会很大——夹在「书眉
 *  之下」：默认位可以跟随，但不能被送出屏外。纯函数（模块级：不进 effect 依赖）。 */
function defaultMinimapPref(band: number, mmH: number): { right: number; bottom: number; w: number; h: number } {
  return {
    right: 18,
    bottom: Math.max(18, Math.min(band + 18, window.innerHeight - TITLE_BAR_H - mmH - 18)),
    w: 156,
    h: 116,
  };
}

export const MinimapView = memo(function MinimapView() {
  /* 数据面：覆盖层上下文（PaperPanel provider）——P2-3 缓存原样下发 */
  const { regions, activeSessionId, viewRect, composerBand, foldedOf, minimap, inkCache } = usePaperRegion();
  const { glideTo } = usePaperDock();
  const content = minimap.content;
  const inkRegions = minimap.geo;
  const viewport = viewRect;

  /* R3.5 浮动化（2026-09-05）：可拖动 + 可缩放 + localStorage 记忆。
   * 默认右下角（bottom 随创作坞让位带），拖动改 right/bottom 偏移，
   * 滚轮改尺寸；偏好存 localStorage（组件级，非工作区数据）。
   * 2026-09-17 创作坞浮动化：默认位改读 composerBand（默认位时 = 抬高 + 坞高
   * ⇒ 与旧口径零漂移）——**只在用户没摆过小地图时生效**：用户摆过就尊重用户的
   * 位置（拖动创作坞不去推已放置的小地图）。 */
  const MM_PREF_KEY = 'lantai.minimap.pref';
  const [pref, setPref] = useState(() => {
    try {
      const raw = localStorage.getItem(MM_PREF_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { right?: number; bottom?: number; w?: number; h?: number };
        const base = defaultMinimapPref(composerBand, 116);
        return {
          right: typeof p.right === 'number' ? p.right : base.right,
          bottom: typeof p.bottom === 'number' ? p.bottom : base.bottom,
          w: typeof p.w === 'number' ? Math.min(280, Math.max(120, p.w)) : base.w,
          h: typeof p.h === 'number' ? Math.min(220, Math.max(90, p.h)) : base.h,
        };
      }
      return defaultMinimapPref(composerBand, 116);
    } catch {
      return defaultMinimapPref(composerBand, 116);
    }
  });
  const persistPref = useCallback((next: typeof pref) => {
    setPref(next);
    try {
      localStorage.setItem(MM_PREF_KEY, JSON.stringify(next));
    } catch {
      /* localStorage 不可用（隐私模式等）——不持久化，不影响使用 */
    }
  }, []);
  /* 首帧校正：挂载时让位带可能尚未实测（坞高 0）——若用户未曾持久化过，
   * 用真实 bottom 把默认位置补正（只跑一次；didInitRef 保证幂等）。 */
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    if (!localStorage.getItem(MM_PREF_KEY)) {
      persistPref({ ...pref, bottom: defaultMinimapPref(composerBand, pref.h).bottom });
    }
  }, [composerBand, persistPref, pref]);

  const W = pref.w;
  const H = pref.h;
  const proj = useMemo(() => minimapProject(content, W, H), [content, W, H]);
  const { scale, offX, offY } = proj;
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mmBoxRef = useRef<HTMLDivElement | null>(null);
  /* 拖动状态（R3.5）：按下空白区记起点，move 换算 right/bottom 增量；
   * 松手位移 < DRAG_THRESHOLD = 点击 → 跳转到该世界点（原 V3b 手势保留）。 */
  const dragRef = useRef<{ sx: number; sy: number; right: number; bottom: number; moved: boolean } | null>(null);
  const onContainerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // 卷框 / 视口框有自己的 handler（stopPropagation），空白区和 canvas 才走到这
      e.stopPropagation();
      // R3.5 收尾：preventDefault 掐断拖动时的原生文本选择（配合 CSS user-select:none，
      // 双保险——WebView 下 pointerdown 选择在 capture 阶段就启动了）
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      dragRef.current = { sx: e.clientX, sy: e.clientY, right: pref.right, bottom: pref.bottom, moved: false };
      const onMove = (ev: PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < DRAG_THRESHOLD) return;
        d.moved = true;
        // 相对画布容器（.pp-canvas）右下角的偏移增量
        const crect = (document.querySelector('.pp-canvas') as HTMLElement | null)?.getBoundingClientRect();
        if (!crect) return;
        const right = Math.min(crect.width - 8, Math.max(8, d.right - (ev.clientX - d.sx)));
        const bottom = Math.min(crect.height - 8, Math.max(8, d.bottom - (ev.clientY - d.sy)));
        persistPref({ ...pref, right, bottom });
      };
      const onUp = (ev: PointerEvent) => {
        const d = dragRef.current;
        dragRef.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        // 未拖动 = 点击跳转：像素反解世界坐标
        if (d && !d.moved) {
          const mx = ev.clientX - rect.left - 4 - offX;
          const my = ev.clientY - rect.top - 4 - offY;
          glideTo(content.x0 + mx / scale, content.y0 + my / scale);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [pref, persistPref, offX, offY, scale, content.x0, content.y0, glideTo],
  );
  /* 滚轮缩放（R3.5，2026-09-05 收尾）：原生 wheel 监听（passive:false）——
   * React 合成 onWheel 在 WebView 是 passive，preventDefault 失效且事件会被
   * 画布原生 wheel 监听器吞掉 → 缩放「没实装」的根因。原生监听保证
   * preventDefault 生效，并阻断冒泡（minimap 上滚轮 = 只缩放 minimap）。 */
  useEffect(() => {
    const el = mmBoxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const step = e.deltaY > 0 ? -16 : 16;
      const w = Math.min(280, Math.max(120, pref.w + step));
      // 等比缩放（保持宽高比近似原 156:116）
      const h = Math.min(220, Math.max(90, Math.round((w * pref.h) / pref.w)));
      persistPref({ ...pref, w, h });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pref, persistPref]);
  useEffect(() => {
    const canvas = inkCanvasRef.current;
    if (!canvas || inkRegions.length === 0 || !foldedOf || !inkCache) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { scale, offX, offY } = proj;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    for (const r of inkRegions) {
      // 全卷墨条：真墨（非 stub）/ 占位砖（stub 离屏卷）
      const bars = inkBarsFor(r, foldedOf, inkCache, content, proj);
      for (const b of bars) {
        ctx.fillStyle = b.kind === 'stub' ? 'rgba(38, 34, 28, 0.16)' : inkColorOf(b.kind);
        ctx.fillRect(b.x, b.y, Math.max(0.5, b.w), Math.max(0.5, b.h));
      }
      // 卷框（活跃卷朱砂加粗）
      const frame = regionFrame(r, content, proj);
      if (frame) {
        const isActive = activeSessionId != null && r.sessionId === activeSessionId;
        ctx.strokeStyle = isActive ? '#a63a2e' : 'rgba(38, 34, 28, 0.28)';
        ctx.lineWidth = isActive ? 1.5 : 1;
        ctx.strokeRect(frame.x - 1.5, frame.y - 1.5, frame.w + 3, frame.h + 3);
      }
    }

    // 原点十字（方位感：无限画布的锚）
    const ox = 4 + (0 - content.x0) * scale + offX;
    const oy = 4 + (0 - content.y0) * scale + offY;
    ctx.strokeStyle = 'rgba(166, 58, 46, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox - 4, oy);
    ctx.lineTo(ox + 4, oy);
    ctx.moveTo(ox, oy - 4);
    ctx.lineTo(ox, oy + 4);
    ctx.stroke();
    // P2-3（2026-09-02）平移零重画纪律，R3 多卷化（2026-09-03）延续：依赖全为
    // 内容/stub 侧稳定引用——inkRegions（sameKey 缓存，pan 帧不换）、content/proj
    // （minimapContent 同款缓存 + W/H 派生，pan 稳定）、W/H（尺寸 state）、
    // foldedOf/inkCache（稳定引用）、activeSessionId（卷框色）。唯 pan 变化的
    // regions 外层不在此列 → 平移帧零重画，内容/几何/stub 切换即时重画。
  }, [inkRegions, content, proj, foldedOf, inkCache, W, H, activeSessionId]);
  const toMap = (x: number, y: number) => ({
    left: 4 + (x - content.x0) * scale + offX,
    top: 4 + (y - content.y0) * scale + offY,
  });
  // 视口框投影——clamp 到容器内（防止 content 极小/视口极大时红框溢出，
  // 2026-09-05 空卷红框事故的保险丝；clamp 逻辑抽在 minimap-core 可测）
  const vp = clampViewportFrame(
    {
      left: toMap(viewport.x0, viewport.y0).left,
      top: toMap(viewport.x0, viewport.y0).top,
      width: (viewport.x1 - viewport.x0) * scale,
      height: (viewport.y1 - viewport.y0) * scale,
    },
    W,
    H,
  );
  // 卷框 DOM 层（hover 高亮 + 点击跳该卷）：canvas 只画墨，交互框叠 div——
  // 命中与语义天然合一（R3 多卷导航）
  const volFrames = useMemo(
    () =>
      regions
        .map((r) => {
          const f = regionFrame(r, content, proj);
          return f
            ? { sessionId: r.sessionId, label: r.label, frame: f, active: r.sessionId === activeSessionId }
            : null;
        })
        .filter((x): x is NonNullable<typeof x> => x != null),
    [regions, content, proj, activeSessionId],
  );
  /* 案头态（零摊开卷）不渲染——无内容可导航，浮在半空是噪音（对齐纸壳 desk 语义）。
   * ⚠ 放所有 hooks 之后（hooks 顺序纪律：条件 return 不得截断 hooks 序列）。 */
  if (regions.length === 0) return null;
  return (
    <div
      ref={mmBoxRef}
      className="pp-minimap"
      style={{ right: pref.right, bottom: pref.bottom, width: W, height: H }}
      title="小地图 · 点击跳转 · Home 键回原点 · Alt+↑↓ 走块 · Alt+←→ 走卷 · 拖动移动 · 滚轮缩放"
      onPointerDown={onContainerPointerDown}
    >
      <canvas ref={inkCanvasRef} className="pp-mm-ink" />
      {volFrames.map((v) => (
        <div
          key={v.sessionId}
          className={`pp-mm-vol${v.active ? ' pp-mm-vol-active' : ''}`}
          style={{ left: v.frame.x, top: v.frame.y, width: v.frame.w, height: v.frame.h }}
          title={v.label}
          onPointerDown={(e) => {
            e.stopPropagation();
            // 跳卷：把卷包围盒中心滑到视口中心
            const wx = content.x0 + (v.frame.x + v.frame.w / 2 - 4 - offX) / scale;
            const wy = content.y0 + (v.frame.y + v.frame.h / 2 - 4 - offY) / scale;
            glideTo(wx, wy);
          }}
        />
      ))}
      <div className="pp-mm-viewport" style={vp} />
    </div>
  );
});

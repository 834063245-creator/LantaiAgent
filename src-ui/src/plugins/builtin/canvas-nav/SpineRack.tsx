// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SpineRack — 书脊列 = 画布空间导航器（Stage-3，docs/plans/canvas-space/stage-3.md）。
//
// 隐喻：案头多卷并陈——左缘一列函套书脊，一卷一脊（只列**摊开**的卷；
// 未摊开的卷在侧边栏 SessionSidebar 管），当前卷「抽出一半」。
//
// 职责（2026-08-25 用户反馈收敛——书脊只管空间定位，功能别太多）：
//   - 左键 = 定位器：ctx.space.focus 切活跃会话 + canvas-view-store
//     requestFocus 让 PaperPanel 把摄像机轻动画飞到该流区最新块。
//   - 拖动 = 落位（抽书放桌）：按住书脊拖进画布，幽灵预览，松手在
//     「竖向不打架」的空列展开（pickDropAnchor：x 吸附网格 + 跳过占用列，
//     y 取用户落点），经 ctx.space.place 落位。
//   - hover 小卡 = 合卷（收起，数据保留；自动存）——改名/删除留在侧边栏
//     （会话管理那一摊）。右键菜单已按用户反馈移除。
//
// 挂载：画布导航插件贡献行（plugins/builtin/canvas-nav/index.ts →
// ctx.panels 注册 'canvas-spine' 面板，side:'left' + unmountOnClose），
// 随纸面板开合。
// 消费 ctx.space（activeSpace() 读面 + 四命令），不新增核心 API。
// 视口动画经 canvas-view-store 与 PaperPanel 共享（app 级单例）。
//
// 双走查形态（增补四）：本文件是产物域源码（esbuild 编译进插件产物，
// 视觉迭代秒级热更）——项目内依赖一律经 './host' 取宿主共享真实例
// （store/service 单例不可内联副本），react 由构建期别名桥共享。
// 例外 = **纯函数**（无实例身份）：卷名显示兜底 volumeDisplayName 直连
// state/volume-name（产物内联副本与真身同行为，同 InkLedger 直连 token-meter）。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { volumeDisplayName } from '../../../state/volume-name';
import {
  activeSpace,
  agentSessionState,
  getChatStore,
  pickDropAnchor,
  screenToWorld,
  useCanvasViewStore,
  useCoreStore,
  useDockStore,
  useSessionVolumesStore,
  useShellStore,
} from './host';
import { mergeSessionRows } from './session-sidebar-model';
import './spine-rack.css';

/** 拖动阈值（px）：超过即视为拖脊（区分点击定位）。 */
const DRAG_THRESHOLD = 6;

/** 卷运行态快照（书脊小点）：运行态唯一读面（v43）。 */
function readRunning(storeId: string, sid: number): boolean {
  return agentSessionState.runStateOf(storeId, sid).running;
}

/** 书脊卷序 = 侧边栏合流序（摊开组：savedAt 倒序，未落盘按卷号新者上）——
 *  书脊与侧边栏并陈两份名单，顺序打架是可见 bug（2026-08-31 前
 *  书脊用内存数组序，与侧边栏「新者上」相反）。
 *  `branch` = 有父卷（会话树「枝」）——书脊上标「枝」（血缘由清单投影的盘上行供给）。 */
function spineOrder(
  open: Array<{ id: number; label: string; msgCount: number }>,
  saved: Parameters<typeof mergeSessionRows>[1],
): Array<{ id: number; label: string; branch: boolean }> {
  return mergeSessionRows(open, saved)
    .filter((r) => r.open)
    .map((r) => ({ id: r.id, label: volumeDisplayName(r.label, r.id), branch: r.parentId != null }));
}

export const SpineRack = memo(function SpineRack() {
  const core = useCoreStore((s) => s.core);
  /* ── 两源分离（2026-09-14「被合卷那根闪回来」根治）──
   * 摊开集（内存 sess store）与磁盘已存卷清单（listSavedSessions）各入各的
   * state，卷序在渲染期 useMemo 合流。
   * 病史：此前把合流结果直接 setSessions，而**异步磁盘应答的续体用的是发起
   * 那一刻捕获的摊开集**——合卷一瞬会连发数次 listSavedSessions（exec/agent/
   * space/sess 四条订阅各触发一次 resync，且 listSavedSessions 内部是
   * 「list_volumes + 每卷并行读文件」的多跳异步），先发的应答后到时就把
   * 「还没发合卷」的旧清单写回书脊 → 已合卷的卷闪回来。
   * 现在：摊开集只由内存写（旧值永不回灌），磁盘应答按请求序号收敛（旧的丢弃）。 */
  const [openRows, setOpenRows] = useState<Array<{ id: number; label: string; msgCount: number }>>([]);
  const [savedRows, setSavedRows] = useState<Parameters<typeof mergeSessionRows>[1]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set());
  const sessions = useMemo(() => spineOrder(openRows, savedRows), [openRows, savedRows]);

  /* ── 磁盘卷清单：请求序号防竞态（只认最新一次请求的应答）──
   * 缓存留在 state（resync 不清空）——resync 高频触发（运行态跳变即触发），
   * 每次先回内存数组序再等磁盘应答会让卷序肉眼可见地抖动。
   * 2026-09-18 载入成本批（与 SessionSidebar 同批）：单飞 + 只在**磁盘清单可能变了**
   * 的事件上拉（listSavedSessions 读全部卷体——实测 32 MB 目录 → 21 MB / 240 ms），
   * 运行态/空间事件走内存源。 */
  const savedSeqRef = useRef(0);
  const sweepingRef = useRef(false);
  const sweepPendingRef = useRef(false);
  const refreshSaved = useCallback(() => {
    if (!core) return;
    if (sweepingRef.current) {
      sweepPendingRef.current = true;
      return;
    }
    sweepingRef.current = true;
    const run = () => {
      const seq = ++savedSeqRef.current;
      // 同 SessionSidebar 的 P4-1 教训：工作区路径变化必须重拉 listSavedSessions
      const pp = useShellStore.getState().projectPath;
      void core
        .listSavedSessions(pp)
        .then((saved) => {
          if (seq !== savedSeqRef.current) return; // 在途旧应答：丢弃（不得回灌已合卷的卷）
          setSavedRows(saved);
        })
        .catch((e) => {
          // 读面失败：保留上次清单（不得把已知卷序抹空）——可见化在控制台
          console.error('[spine] 案卷清单读取失败（保留上次结果）:', e);
        })
        .finally(() => {
          sweepingRef.current = false;
          if (sweepPendingRef.current) {
            sweepPendingRef.current = false;
            run();
          }
        });
    };
    run();
  }, [core]);

  /* 内存侧重读（**廉价**——运行态/空间事件走这条）：摊开集 + 活跃卷 + 运行态。 */
  const resyncMemory = useCallback(() => {
    if (!core) return;
    const st = getChatStore(core.panelId).sess.getState();
    setOpenRows(st.sessions.map((s) => ({ id: s.id, label: s.label, msgCount: 0 })));
    const active = st.sessions[st.activeIdx];
    setActiveId(active ? active.id : null);
    const running = new Set<number>();
    for (const s of st.sessions) {
      if (readRunning(core.panelId, s.id)) running.add(s.id);
    }
    setRunningIds(running);
  }, [core]);

  /* 全量重读（摊开集变化 = 卷开合/改名/新建/删除 → 磁盘清单可能变了）。 */
  const resync = useCallback(() => {
    resyncMemory();
    refreshSaved();
  }, [resyncMemory, refreshSaved]);

  useEffect(() => {
    if (!core) return;
    resync();
    // 摊开集：磁盘清单可能变了 → 全量
    const unSess = getChatStore(core.panelId).sess.subscribe(resync);
    // 运行态 / 空间：只影响脊面点位与呼吸点 → 内存源
    const unAgents = agentSessionState.subscribe(resyncMemory);
    const unSpace = activeSpace()?.subscribe(resyncMemory);
    // 卷文件落定写入（保存/改名/合卷/删除）→ 全量（写代缓存重读零 I/O）——
    // 卷序按 savedAt，落盘晚于摊开集变化，只挂摊开集会读到写前状态
    const unVolumes = useSessionVolumesStore.subscribe(resync);
    const unShell = useShellStore.subscribe((s, prev) => {
      if (s.projectPath !== prev.projectPath) resync();
    });
    return () => {
      unSess();
      unAgents();
      unSpace?.();
      unVolumes();
      unShell();
    };
  }, [core, resync, resyncMemory]);

  /* 运行态变化：订阅面 = subscribeExecAll（v43 收口）：账本**实例表**变更（迟到/被换/
   *  注销重建都重挂）+ 既有账本的运行记录起落。旧实现在挂载时对「当时已存在」的账本
   *  逐个 onChange——后来才铸的账本永远没订阅（会话在跑而书脊光点不亮那个病灶族）。 */
  useEffect(() => {
    if (!core) return;
    return agentSessionState.subscribeExecAll(core.panelId, resyncMemory);
  }, [core, resyncMemory]);

  /* ── 手势 1：左键定位器 ── */
  const onLocate = useCallback(
    (id: number) => {
      if (!core) return;
      activeSpace()?.focus(String(id));
      useCanvasViewStore.getState().requestFocus(String(id));
    },
    [core],
  );

  /* ── 手势 2：拖动落位（抽书放桌）── */
  const dragRef = useRef<{ id: number; sx: number; sy: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const onSpineMouseDown = useCallback((e: React.MouseEvent, id: number) => {
    if (e.button !== 0) return;
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, moved: false };
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
      d.moved = true;
      setGhost({ x: e.clientX, y: e.clientY });
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setGhost(null);
      if (!d?.moved || !core) return;
      // 画布坐标换算：读 .pp-canvas 的视口 rect（只读坐标，不建游离 DOM——
      // 书脊是 DockPanel 上层覆盖，跨组件取坐标是 ponytail 例外）。
      const rect = document.querySelector('.pp-canvas')?.getBoundingClientRect();
      if (!rect) return;
      const v = useCanvasViewStore.getState().view;
      const w = screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top);
      const space = activeSpace();
      const regions = space?.getState().regions ?? [];
      const anchor = pickDropAnchor(regions, String(d.id), w.x, w.y);
      space?.place(String(d.id), anchor.anchorX, anchor.anchorY);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core]);

  /* ── hover 小卡：合卷（收起，数据保留 + 自动存）── */
  const onClose = useCallback(
    (id: number) => {
      if (!core || readRunning(core.panelId, id)) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => s.id === id);
      if (idx >= 0) core.closeSession(idx);
    },
    [core],
  );

  if (!core) return null;

  return (
    <div className="sr-rack" role="tablist" aria-label="画布书脊（空间导航器）">
      <button
        type="button"
        className="sr-sidebar-toggle"
        title="案卷侧边栏（可折叠）"
        onClick={() => useDockStore.getState().togglePanel('canvas-sidebar')}
      >
        <span className="sr-sidebar-toggle-label">案卷</span>
      </button>

      {sessions.map((s) => {
        const isActive = s.id === activeId;
        const isRunning = runningIds.has(s.id);
        return (
          <div
            key={s.id}
            className={['sr-spine', isActive ? 'sr-active' : '', isRunning ? 'sr-running' : ''].join(' ')}
          >
            <div
              className="sr-spine-main"
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              title={`${s.label}${s.branch ? '（枝）' : ''}${isRunning ? '（运行中）' : ''} — 左键定位 · 拖动落位 · hover 合卷`}
              onClick={() => onLocate(s.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onLocate(s.id);
                }
              }}
              onMouseDown={(e) => onSpineMouseDown(e, s.id)}
            >
              <span className="sr-label" dir="ltr">
                {s.label}
              </span>
              {s.branch && (
                <span className="sr-branch-tag" title="枝：从父卷的某个节点分出">
                  枝
                </span>
              )}
              {isRunning && <span className="sr-run-dot" role="presentation" />}
            </div>

            {/* hover 小卡：卷名 + 运行态 + 合卷钮（改名/删除在侧边栏——各管一摊） */}
            <div className="sr-hover-card">
              <div className="sr-hover-title">{s.label}</div>
              <div className="sr-hover-meta">
                {s.branch ? '枝 · ' : ''}
                {isRunning ? '运行中 · 不可合卷' : '左键定位 · 拖动落位'}
              </div>
              <button type="button" className="sr-close-btn" disabled={isRunning} onClick={() => onClose(s.id)}>
                合卷（自动存）
              </button>
            </div>
          </div>
        );
      })}
      {sessions.length === 0 && <div className="sr-empty">画布暂无摊开的卷</div>}

      {/* 拖动落位幽灵预览（屏幕坐标浮层——抽书放桌的即时应答） */}
      {ghost && (
        <div className="sr-drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <span className="sr-drag-ghost-tag">放桌</span>
        </div>
      )}
    </div>
  );
});

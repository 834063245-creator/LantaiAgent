// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionSidebar — 当前工作区案卷管理侧边栏（Stage-3 挂载 + 2026-08-31 注疏重排
// + 2026-09-02 UX/浸墨批）。
//
// 职责：管「这个工作区有哪些案卷、什么状态、怎么出生/改名/合卷/删除」。
//   - 全量列表：摊开案卷（sess store）+ 未摊开已存卷（listSavedSessions）
//     两源合流，常驻滚动、不截断。
//   - 注疏分节：摊开中（OPEN）/ 已合卷（CLOSED）两节，节头点线引出 + 等宽
//     计数，可折叠（localStorage 持久）；已合卷节内按时间分桶（今天 /
//     7 天内 / 更早——桶头仅在多桶时立，「更早」默认收起 = 大卷量下的
//     归档语义：老卷不删也出视野）。
//   - 检索：常驻检索条即输即滤（filterRows 纯函数；Esc 清空）。
//   - 键盘：↑↓/Home/End 移动游标（roving tabindex + 就近滚动）、Enter/Space
//     摊开定位、F2 改名、C 合卷、Delete 两击确认删除、X 勾选、Ctrl+A 全选
//     可见、Esc 四级撤退（解武删除 → 解武批量 → 清选择 → 收侧栏）。
//   - 行操作：改名 / 合卷（收起，数据保留）/ 删除（两击确认）；热区 ≥24px。
//   - 多选批量删除：行首勾选格（hover/选中时替换状态点位显形）+ Ctrl+点击
//     + X 键；脚部批量条两击确认；运行中卷跳过并报数（不可半途 dispose）。
//   - 行拖放落位：行拖进画布 = 闭合卷「先落位再摊开」（region 先写，装载
//     即用落点位） / 摊开卷再落位——书脊手势同族（互斥两态下书脊退场，
//     空间手势由本栏承接）。
//   - 宽度可拖：右缘拖拽 240–420px（localStorage 持久）。
//   - 新建按钮（出生仪式：createNewSession，自动落位画布线性排比）。
//   - 互斥两态（2026-09-02 拍板）：书脊列 = 本栏的收起态（canvas-nav 插件
//     互斥守卫），本栏展开时独占左缘（left:0）。
//
// 挂载：画布导航插件贡献行（plugins/builtin/canvas-nav/index.ts →
// ctx.panels 注册 'canvas-sidebar' 面板，side:'left' + unmountOnClose），
// 随纸面板开合。
// 消费 ctx.space（activeSpace()：展开未摊开卷/定位/落位）+ 现有 core 会话命令。
//
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享
// 真实例（store 单例不可内联副本），react 由构建期别名桥共享。

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  activeSpace,
  agentSessionState,
  getChatStore,
  msgStoreFor,
  pickDropAnchor,
  screenToWorld,
  useAskStore,
  useCanvasViewStore,
  useCoreStore,
  useDockStore,
  useShellStore,
} from './host';
import {
  bucketClosed,
  CLOSED_BUCKET_LABEL,
  type ClosedBucket,
  filterRows,
  mergeSessionRows,
  type SessionStatus,
  type SidebarRow,
  sessionMeta,
  splitSections,
  statusLabel,
} from './session-sidebar-model';
import './session-sidebar.css';

/** 拖动阈值（px）：超过即视为拖行（区分点击摊开）。 */
const DRAG_THRESHOLD = 6;
/** 宽度拖拽区间 + 默认值（px）。 */
const WIDTH_MIN = 240;
const WIDTH_MAX = 420;
const WIDTH_DEFAULT = 264;
const WIDTH_KEY = 'lantai.sidebar.width';
const FOLDS_KEY = 'lantai.sidebar.folds';

/** 折叠面键：两节头 + 三桶头。默认全展开，唯「更早」默认收起。 */
type FoldKey = 'open' | 'closed' | ClosedBucket;
const DEFAULT_FOLDED: Record<string, boolean> = { earlier: true };

/** localStorage 毒化容忍（INVARIANTS #11 同款）：坏值 → 默认。 */
function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw == null ? Number.NaN : Number(raw);
    if (Number.isFinite(n)) return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
  } catch {
    /* 坏值 → 默认宽 */
  }
  return WIDTH_DEFAULT;
}
function loadFolds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLDS_KEY);
    if (raw) {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === 'object') return v as Record<string, boolean>;
    }
  } catch {
    /* 坏 JSON → 默认折叠面 */
  }
  return {};
}

/** 桶机读码（节头等宽计数位）。 */
const BUCKET_CODE: Record<ClosedBucket, string> = { today: 'TODAY', week: 'WEEK', earlier: 'EARLIER' };

/** 行状态点（数据源：exec.isRunning + ask pending + 消息数；未摊开卷 = done）。 */
function computeStatus(
  panelId: string,
  row: Pick<SidebarRow, 'id' | 'open' | 'msgCount'>,
  activeSid: number | null,
  askPending: boolean,
): SessionStatus {
  if (row.open) {
    const exec = agentSessionState.getExec(panelId, row.id);
    if (exec?.isRunning) {
      return askPending && activeSid === row.id ? 'pending' : 'running';
    }
  }
  return row.msgCount > 0 ? 'done' : 'idle';
}

export const SessionSidebar = memo(function SessionSidebar() {
  const core = useCoreStore((s) => s.core);
  const [rows, setRows] = useState<SidebarRow[]>([]);
  /** 当前活跃卷 id（渲染当前卷朱砂标记；status 计算也要用）。 */
  const [activeSid, setActiveSid] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** 键盘游标（roving tabindex）：可见行中当前聚焦的卷 id。 */
  const [cursorId, setCursorId] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  /** 新建防抖（双击竞态：createNewSession 发号在 await factory 之后）。 */
  const newBusyRef = useRef(false);
  const [newBusy, setNewBusy] = useState(false);
  /** 删除二次确认：已武装的卷 id（第一击变红，再击才删；null = 未武装）。 */
  const confirmingDeleteIdRef = useRef<number | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);
  /** 多选批量删除：已勾选卷 id 集 + 批量钮武装态。 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchArmed, setBatchArmed] = useState(false);
  /** 节/桶折叠面（默认全展开，「更早」默认收起）。 */
  const [folds, setFolds] = useState<Record<string, boolean>>(loadFolds);
  /** 侧栏宽度（右缘拖拽）。 */
  const [width, setWidth] = useState<number>(loadWidth);
  /** 行拖放：拖行中跟随光标的幽灵预览（屏幕坐标）。 */
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ id: number; open: boolean; sx: number; sy: number; moved: boolean } | null>(null);
  /** 拖行结束后抑制紧随的 click（mousedown/mouseup 不同元素时 click 落公共
   *  祖先——落点在行内时仍会打到行，靠本旗截停）。 */
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (renamingId !== null) renameInputRef.current?.focus();
  }, [renamingId]);

  const refresh = useCallback(() => {
    if (!core) return;
    const panelId = core.panelId;
    const pp = useShellStore.getState().projectPath;
    const st = getChatStore(panelId).sess.getState();
    const active = st.sessions[st.activeIdx]?.id ?? null;
    setActiveSid(active);
    // 并发会话：任一卷有在途提问即标记活跃卷 pending（提问卡本身带卷徽标）
    const askPending = useAskStore.getState().pendingBySession.size > 0;
    const open = st.sessions.map((s) => ({
      id: s.id,
      label: s.label,
      msgCount: msgStoreFor(panelId, s.id).getState().messages.length,
    }));
    void core
      .listSavedSessions(pp)
      .then((saved) => {
        const merged = mergeSessionRows(open, saved).map((r) => ({
          ...r,
          status: computeStatus(panelId, r, active, askPending),
        }));
        setRows(merged);
      })
      .catch(() => {
        const merged = mergeSessionRows(open, []).map((r) => ({
          ...r,
          status: computeStatus(panelId, r, active, askPending),
        }));
        setRows(merged);
      });
  }, [core]);

  useEffect(() => {
    if (!core) return;
    refresh();
    const panelId = core.panelId;
    // 每卷消息 store 订阅（2026-09-01 面审）：行注记「N 块」数的是消息条数，
    // 此前只订 sess/ask/agent/space——流式追加/回填后块数恒陈旧（种子注入后
    // 侧边栏恒「0 块」实锤）。会话集变化时重挂订阅。
    let unMsgs: Array<() => void> = [];
    const syncMsgSubs = () => {
      for (const u of unMsgs) u();
      unMsgs = [];
      const st = getChatStore(panelId).sess.getState();
      for (const s of st.sessions) unMsgs.push(msgStoreFor(panelId, s.id).subscribe(refresh));
    };
    syncMsgSubs();
    const unSess = getChatStore(panelId).sess.subscribe(() => {
      syncMsgSubs();
      refresh();
    });
    const unAgents = agentSessionState.subscribe(refresh);
    const unAsk = useAskStore.subscribe(refresh);
    const unSpace = activeSpace()?.subscribe(refresh);
    // rework P4-1：工作区路径变化（进工作区/切换）必须重拉 listSavedSessions——
    // 首拉若早于 projectPath 落定（Workspace.open 之后才写 shell-store），
    // 会拉到空集且再无重试点。
    const unShell = useShellStore.subscribe((s, prev) => {
      if (s.projectPath !== prev.projectPath) refresh();
    });
    return () => {
      for (const u of unMsgs) u();
      unSess();
      unAgents();
      unAsk();
      unSpace?.();
      unShell();
    };
  }, [core, refresh]);

  /* 多选集随行集收敛（删除/过滤后已选卷可能不在场）。 */
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(rows.map((r) => r.id));
      const next = new Set<number>();
      for (const id of prev) if (alive.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  /** 取消删除武装 + 批量解武（改名/点击行/新建等任何其它动作都解武）。 */
  const disarmAll = useCallback(() => {
    confirmingDeleteIdRef.current = null;
    setConfirmingDeleteId(null);
    setBatchArmed(false);
  }, []);

  /* ── 多选 ── */
  const toggleSelect = useCallback(
    (id: number) => {
      disarmAll();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [disarmAll],
  );

  /* ── 折叠面 ── */
  const folded = useCallback((key: FoldKey) => folds[key] ?? DEFAULT_FOLDED[key] === true, [folds]);
  const toggleFold = useCallback((key: FoldKey) => {
    setFolds((prev) => {
      const next = { ...prev, [key]: !(prev[key] ?? DEFAULT_FOLDED[key] === true) };
      try {
        localStorage.setItem(FOLDS_KEY, JSON.stringify(next));
      } catch {
        /* 写失败仅本次会话生效 */
      }
      return next;
    });
  }, []);

  /* ── 宽度拖拽（右缘） ── */
  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      let latest = width;
      const move = (ev: MouseEvent) => {
        latest = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startW + ev.clientX - startX));
        setWidth(latest);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        try {
          localStorage.setItem(WIDTH_KEY, String(Math.round(latest)));
        } catch {
          /* 写失败仅本次会话生效 */
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [width],
  );

  /* 拖拽柄键盘：←→ 微调 ±16px（可聚焦件的键盘义务）。 */
  const onResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (step === 0) return;
    e.preventDefault();
    setWidth((prev) => {
      const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, prev + step));
      try {
        localStorage.setItem(WIDTH_KEY, String(next));
      } catch {
        /* 写失败仅本次会话生效 */
      }
      return next;
    });
  }, []);

  /* ── 行拖放落位（书脊手势同族）：闭合卷 = 先落位再摊开（region 先写，
   * 装载即用落点位，不落默认位）；摊开卷 = 再落位。 ── */
  const onRowMouseDown = useCallback((e: React.MouseEvent, row: SidebarRow) => {
    if (e.button !== 0) return;
    // 行内交互子件（勾选格/行操作/改名输入）不承载拖行手势
    if ((e.target as HTMLElement).closest('.ss-check, .ss-actions, .ss-rename-input')) return;
    // 压旗复位：拖行结束（mouseup 在行外）不会有 click 落到行上清旗——
    // 不复位会把下一次真点击误吞
    suppressClickRef.current = false;
    dragRef.current = { id: row.id, open: row.open, sx: e.clientX, sy: e.clientY, moved: false };
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
      suppressClickRef.current = true;
      // 松手落回本栏（拖了又反悔）= 中止，不在栏底落位
      if ((e.target as HTMLElement | null)?.closest?.('.ss-sidebar')) return;
      const rect = document.querySelector('.pp-canvas')?.getBoundingClientRect();
      if (!rect) return;
      const v = useCanvasViewStore.getState().view;
      const w = screenToWorld(v, e.clientX - rect.left, e.clientY - rect.top);
      const space = activeSpace();
      const regions = space?.getState().regions ?? [];
      const anchor = pickDropAnchor(regions, String(d.id), w.x, w.y);
      space?.place(String(d.id), anchor.anchorX, anchor.anchorY);
      if (!d.open) space?.expand(String(d.id)); // expand 自带视角聚焦（用户拍板）
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [core]);

  /* ── 行点击：摊开/定位（Ctrl+点击 = 勾选）——键盘 Enter/Space 同入口，
   *  只取修饰键窄形（MouseEvent/KeyboardEvent 双兼容） ── */
  const onRowClick = useCallback(
    (e: { ctrlKey: boolean; metaKey: boolean }, row: SidebarRow) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (!core) return;
      disarmAll(); // 点击行 = 其它意图，解除一切武装
      setCursorId(row.id);
      if (e.ctrlKey || e.metaKey) {
        toggleSelect(row.id);
        return;
      }
      const sid = String(row.id);
      if (row.open) {
        activeSpace()?.focus(sid);
        useCanvasViewStore.getState().requestFocus(sid);
      } else {
        activeSpace()?.expand(sid);
        useCanvasViewStore.getState().requestFocus(sid);
      }
    },
    [core, disarmAll, toggleSelect],
  );

  /* ── 行操作：改名 / 合卷（收起）/ 删除 ── */
  const commitRename = useCallback(
    (id: number, label: string) => {
      if (!core) return;
      const next = label.trim();
      if (!next) {
        setRenamingId(null);
        return;
      }
      const st = getChatStore(core.panelId).sess.getState();
      const open = st.sessions.some((s) => s.id === id);
      if (open) core.renameSession(id, next);
      else void core.renameSavedSession(id, next);
      setRenamingId(null);
      refresh();
    },
    [core, refresh],
  );

  const onCollapse = useCallback(
    (id: number) => {
      if (!core) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => s.id === id);
      if (idx < 0) return;
      if (agentSessionState.getExec(core.panelId, id)?.isRunning) {
        setLocalNotice('运行中的卷不能合卷——先停止再收起');
        return;
      }
      core.closeSession(idx);
      refresh();
    },
    [core, refresh],
  );

  const onDelete = useCallback(
    (id: number) => {
      if (!core) return;
      if (agentSessionState.getExec(core.panelId, id)?.isRunning) {
        setLocalNotice('运行中的卷不能删除——先停止再移除');
        return;
      }
      // 二次确认（2026-08-28 会话管理专项，用户拍板）：第一击武装（按钮变红），
      // 再击才真正写墓碑——「删」与「改」「合」相邻，防误触不可撤销。
      if (confirmingDeleteIdRef.current !== id) {
        confirmingDeleteIdRef.current = id;
        setConfirmingDeleteId(id);
        return;
      }
      confirmingDeleteIdRef.current = null;
      setConfirmingDeleteId(null);
      const pp = useShellStore.getState().projectPath;
      void core.deleteSessionFile(pp, id);
      refresh();
    },
    [core, refresh],
  );

  /* ── 批量删除（两击确认同款）：运行中卷跳过并报数。 ── */
  const onBatchDelete = useCallback(() => {
    if (!core || selectedIds.size === 0) return;
    if (!batchArmed) {
      setBatchArmed(true);
      return;
    }
    setBatchArmed(false);
    const pp = useShellStore.getState().projectPath;
    let skipped = 0;
    let done = 0;
    for (const id of selectedIds) {
      if (agentSessionState.getExec(core.panelId, id)?.isRunning) {
        skipped++;
        continue;
      }
      void core.deleteSessionFile(pp, id);
      done++;
    }
    setSelectedIds(new Set());
    setLocalNotice(`已删 ${done} 卷${skipped > 0 ? `（${skipped} 卷运行中已跳过）` : ''}`);
    refresh();
  }, [core, selectedIds, batchArmed, refresh]);

  const onNew = useCallback(() => {
    if (!core) return;
    setLocalNotice(null);
    disarmAll();
    // busy 防抖（2026-08-28 会话管理专项）：createNewSession 先 await factory
    // 再发号自增——双击落在 await 窗口内会读到同一 nextSessionId → 同号双建
    // + 泄漏一个 Agent 句柄。防抖期间忽略重复点击。
    if (newBusyRef.current) return;
    newBusyRef.current = true;
    setNewBusy(true);
    // 出生 = 一种展开：绑定视角聚焦（用户拍板）——新卷落点（最近空位）
    // 相对视口中心，聚焦把它带到眼前
    void (async () => {
      try {
        await core.createNewSession();
        const st = getChatStore(core.panelId).sess.getState();
        const sid = st.sessions[st.activeIdx]?.id;
        if (sid != null) useCanvasViewStore.getState().requestFocus(String(sid));
      } finally {
        newBusyRef.current = false;
        setNewBusy(false);
      }
    })();
  }, [core, disarmAll]);

  const onCollapseSidebar = useCallback(() => {
    useDockStore.getState().closePanel('canvas-sidebar');
  }, []);

  /* ── 检索 ── */
  const visible = useMemo(() => filterRows(rows, query), [rows, query]);
  const sections = useMemo(() => splitSections(visible), [visible]);
  const buckets = useMemo(() => bucketClosed(sections.closed), [sections.closed]);
  /** 桶头仅在合卷集横跨多桶时立（单桶立头是噪音）。 */
  const showBucketHeads = buckets.length > 1;
  const flat = useMemo(() => {
    const out: SidebarRow[] = [];
    if (!folded('open')) out.push(...sections.open);
    if (!folded('closed')) {
      for (const b of buckets) {
        if (!showBucketHeads || !folded(b.bucket)) out.push(...b.rows);
      }
    }
    return out;
  }, [sections, buckets, showBucketHeads, folded]);

  /* 游标随可见行收窄而收敛（过滤/折叠/删除后游标行可能消失）。 */
  useEffect(() => {
    if (flat.length === 0) {
      if (cursorId !== null) setCursorId(null);
      return;
    }
    if (cursorId === null || !flat.some((r) => r.id === cursorId)) {
      setCursorId(flat[0].id);
    }
  }, [flat, cursorId]);

  /* ── 检索条键盘：Esc 清空（截停——不落收侧栏）；↓ 直落列表首行 ── */
  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setQuery('');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const first = flat[0];
        if (first) {
          setCursorId(first.id);
          rowRefs.current.get(first.id)?.focus();
        }
      }
    },
    [flat],
  );

  /* ── 列表键盘导航：↑↓/Home/End 移动游标，F2 改名，C 合卷，Delete 两击
   * 删除，X 勾选，Ctrl+A 全选可见。Enter/Space 交给行自身激活处理。 ── */
  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (renamingId !== null) return; // 改名输入自理（Enter/Escape 已在行内截停）
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'a' || e.key === 'A') {
          e.preventDefault();
          disarmAll();
          setSelectedIds(new Set(flat.map((r) => r.id)));
        }
        return;
      }
      if (flat.length === 0) return;
      const idx = flat.findIndex((r) => r.id === cursorId);
      let next = -1;
      if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(flat.length - 1, idx + 1);
      else if (e.key === 'ArrowUp') next = idx < 0 ? 0 : Math.max(0, idx - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = flat.length - 1;
      else if (e.key === 'F2' && idx >= 0) {
        e.preventDefault();
        const row = flat[idx];
        disarmAll();
        setRenamingId(row.id);
        setDraftLabel(row.label || `案卷 ${row.id}`);
        return;
      } else if ((e.key === 'c' || e.key === 'C') && idx >= 0) {
        const row = flat[idx];
        if (!row.open) return; // 合卷只对摊开卷有意义
        e.preventDefault();
        disarmAll();
        onCollapse(row.id);
        return;
      } else if ((e.key === 'x' || e.key === 'X') && idx >= 0) {
        e.preventDefault();
        toggleSelect(flat[idx].id);
        return;
      } else if (e.key === 'Delete' && idx >= 0) {
        e.preventDefault();
        onDelete(flat[idx].id);
        return;
      } else {
        return;
      }
      e.preventDefault();
      const row = flat[next];
      setCursorId(row.id);
      rowRefs.current.get(row.id)?.focus();
      rowRefs.current.get(row.id)?.scrollIntoView?.({ block: 'nearest' });
    },
    [flat, cursorId, renamingId, onDelete, onCollapse, toggleSelect, disarmAll],
  );

  /* Esc 四级撤退（列表外，如书眉/检索失焦后）：解武删除 → 解武批量 →
   * 清选择 → 收侧栏（互斥两态：收起回书脊）。改名输入的 Esc 不冒泡。 */
  const onRootKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmingDeleteId !== null) {
        disarmAll();
        return;
      }
      if (selectedIds.size > 0) {
        setSelectedIds(new Set());
        return;
      }
      useDockStore.getState().closePanel('canvas-sidebar');
    },
    [confirmingDeleteId, selectedIds, disarmAll],
  );

  if (!core) return null;

  const renderRow = (r: SidebarRow) => {
    const isRenaming = renamingId === r.id;
    const isCurrent = r.open && r.id === activeSid;
    const isSelected = selectedIds.has(r.id);
    return (
      // biome-ignore lint/a11y/useSemanticElements: 行容器内含行操作按钮，button 嵌套交互元素非法——用 div 承载行级点击
      <div
        key={r.id}
        ref={(el) => {
          if (el) rowRefs.current.set(r.id, el);
          else rowRefs.current.delete(r.id);
        }}
        role="button"
        tabIndex={cursorId === r.id ? 0 : -1}
        className={`ss-row${r.open ? ' open' : ''}${isCurrent ? ' current' : ''}${isSelected ? ' selected' : ''}`}
        title={`${r.label || `案卷 ${r.id}`}${isCurrent ? ' · 当前卷' : ''} · ${statusLabel(r.status)} · 左键摊开/定位 · 拖动落位`}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={(e) => onRowClick(e, r)}
        onMouseDown={(e) => onRowMouseDown(e, r)}
        onFocus={() => setCursorId(r.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onRowClick(e, r);
          }
        }}
      >
        <button
          type="button"
          className={`ss-check${isSelected ? ' on' : ''}`}
          aria-pressed={isSelected}
          aria-label={`${isSelected ? '取消选择' : '选择'}案卷：${r.label || `案卷 ${r.id}`}`}
          title="勾选后可批量删除（Ctrl+点击 / X 键同效）"
          onClick={(e) => {
            e.stopPropagation();
            toggleSelect(r.id);
          }}
        />
        <span className={`ss-dot ss-dot-${r.status}`} role="presentation" />
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="ss-rename-input"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename(r.id, draftLabel);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenamingId(null);
              }
              e.stopPropagation();
            }}
            onBlur={() => commitRename(r.id, draftLabel)}
          />
        ) : (
          <div className="ss-row-main">
            <span className="ss-label">{r.label || `案卷 ${r.id}`}</span>
            <span className="ss-meta">{sessionMeta(r)}</span>
          </div>
        )}
        {!isRenaming && (
          <div className="ss-actions">
            <button
              type="button"
              title="改名"
              onClick={(e) => {
                e.stopPropagation();
                disarmAll();
                setRenamingId(r.id);
                setDraftLabel(r.label || `案卷 ${r.id}`);
              }}
            >
              改
            </button>
            {r.open && (
              <button
                type="button"
                title="合卷（收起，数据保留；C 键同效）"
                onClick={(e) => {
                  e.stopPropagation();
                  disarmAll();
                  onCollapse(r.id);
                }}
              >
                合
              </button>
            )}
            {confirmingDeleteId === r.id ? (
              <button
                type="button"
                className="ss-danger"
                title="再点一次确认删除（不可撤销）；点其它处取消"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(r.id);
                }}
              >
                确删?
              </button>
            ) : (
              <button
                type="button"
                title="彻底删除（点两次确认）"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(r.id);
                }}
              >
                删
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderBucket = ({ bucket, rows: brows }: { bucket: ClosedBucket; rows: SidebarRow[] }) => {
    const isFolded = folded(bucket);
    return (
      <div className="ss-bucket" key={bucket}>
        <button
          type="button"
          className={`ss-bucket-head${isFolded ? ' folded' : ''}`}
          aria-expanded={!isFolded}
          onClick={() => toggleFold(bucket)}
        >
          <span className="t">{CLOSED_BUCKET_LABEL[bucket]}</span>
          <span className="leader" role="presentation" />
          <span className="n">
            {BUCKET_CODE[bucket]} · {brows.length}
          </span>
        </button>
        {!isFolded && brows.map(renderRow)}
      </div>
    );
  };

  const openFolded = folded('open');
  const closedFolded = folded('closed');

  return (
    <aside className="ss-sidebar" style={{ width }} aria-label="当前工作区案卷管理" onKeyDown={onRootKeyDown}>
      <div className="ss-head">
        <span className="ss-title">案卷</span>
        <span className="ss-count">SESSIONS · {rows.length}</span>
        <button
          type="button"
          className="ss-fold"
          title="收起侧边栏（回到书脊）"
          aria-label="收起侧边栏"
          onClick={onCollapseSidebar}
        >
          ◂
        </button>
      </div>

      <div className="ss-search">
        <span className="ss-search-lbl">检</span>
        <input
          type="text"
          value={query}
          placeholder="卷名或卷号…"
          aria-label="检索案卷"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
        />
      </div>

      {localNotice && (
        <div className="ss-notice">
          {localNotice}
          <button type="button" onClick={() => setLocalNotice(null)}>
            知道了
          </button>
        </div>
      )}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: 键盘导航容器（↑↓/F2/C/Delete/X 经事件冒泡统一处理） */}
      <div className="ss-list" onKeyDown={onListKeyDown}>
        {sections.open.length > 0 && (
          <div className="ss-section">
            <button
              type="button"
              className={`ss-section-head${openFolded ? ' folded' : ''}`}
              aria-expanded={!openFolded}
              onClick={() => toggleFold('open')}
            >
              <span className="t">摊开中</span>
              <span className="leader" role="presentation" />
              <span className="n">OPEN · {sections.open.length}</span>
            </button>
            {!openFolded && sections.open.map(renderRow)}
          </div>
        )}
        {sections.closed.length > 0 && (
          <div className="ss-section">
            <button
              type="button"
              className={`ss-section-head${closedFolded ? ' folded' : ''}`}
              aria-expanded={!closedFolded}
              onClick={() => toggleFold('closed')}
            >
              <span className="t">已合卷</span>
              <span className="leader" role="presentation" />
              <span className="n">CLOSED · {sections.closed.length}</span>
            </button>
            {!closedFolded &&
              (showBucketHeads ? buckets.map(renderBucket) : buckets.flatMap((b) => b.rows.map(renderRow)))}
          </div>
        )}
        {rows.length === 0 && <div className="ss-empty">本工作区暂无案卷</div>}
        {rows.length > 0 && visible.length === 0 && <div className="ss-empty">无匹配案卷</div>}
      </div>

      {selectedIds.size > 0 ? (
        <div className="ss-batch">
          <span className="ss-batch-n">已选 {selectedIds.size} 卷</span>
          {batchArmed ? (
            <button
              type="button"
              className="ss-batch-del ss-danger"
              title="再点一次确认批量删除（不可撤销）；Esc 取消"
              onClick={onBatchDelete}
            >
              确删 {selectedIds.size} 卷?
            </button>
          ) : (
            <button
              type="button"
              className="ss-batch-del"
              title="批量删除所选（点两次确认；运行中卷自动跳过）"
              onClick={onBatchDelete}
            >
              删除所选
            </button>
          )}
          <button
            type="button"
            className="ss-batch-cancel"
            onClick={() => {
              setBatchArmed(false);
              setSelectedIds(new Set());
            }}
          >
            取消
          </button>
        </div>
      ) : (
        <div className="ss-foot">
          <button
            type="button"
            className="ss-new"
            onClick={onNew}
            disabled={newBusy}
            title={newBusy ? '正在创建…' : undefined}
          >
            ＋ 另起一卷
          </button>
        </div>
      )}

      {/* 宽度拖拽柄（右缘）：拖拽调宽 + 聚焦后 ←→ 微调 */}
      <button
        type="button"
        className="ss-resize"
        aria-label="拖拽调整侧栏宽度（聚焦后 ← → 微调）"
        onMouseDown={onResizeMouseDown}
        onKeyDown={onResizeKeyDown}
      />

      {/* 拖行落位幽灵预览（屏幕坐标浮层——抽卷放桌的即时应答） */}
      {ghost && (
        <div className="ss-drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <span className="ss-drag-ghost-tag">放桌</span>
        </div>
      )}
    </aside>
  );
});

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
//   - 新建按钮（出生仪式：createNewSession，自动落位画布线性排比）——
//     检索条下常驻（2026-09-02 用户拍板：上移，沉底翻屏才能开新卷）。
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
import { isUnnamedVolumeLabel, volumeDisplayName } from '../../../state/volume-name';
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
  useSessionVolumesStore,
  useShellStore,
} from './host';
import {
  bucketClosed,
  CLOSED_BUCKET_LABEL,
  type ClosedBucket,
  familyForest,
  filterRows,
  markOrphans,
  mergeSessionRows,
  relativeTime,
  type SessionStatus,
  type SidebarRow,
  sessionMeta,
  splitSections,
  statusLabel,
  withAncestorContext,
} from './session-sidebar-model';
import './session-sidebar.css';

/** 拖动阈值（px）：超过即视为拖行（区分点击摊开）。 */
const DRAG_THRESHOLD = 6;
/** 面板核类型（`useCoreStore` 所持 core 的非空形状）——本文件不 import ChatCore
 *  （产物域依赖一律经 './host'），删除连坐的返回值类型从能力位本身取。 */
type SidebarCore = NonNullable<ReturnType<typeof useCoreStore.getState>['core']>;
/** 宽度拖拽区间 + 默认值（px）。 */
const WIDTH_MIN = 240;
const WIDTH_MAX = 420;
const WIDTH_DEFAULT = 264;
const WIDTH_KEY = 'lantai.sidebar.width';
const FOLDS_KEY = 'lantai.sidebar.folds';
const VIEW_KEY = 'lantai.sidebar.view';

/** 视角（2026-09-20 用户拍板「双视角」，立案 `docs/plans/sidebar-two-views-plan.md`）：
 *  `case` = 案卷（纯时间序扁平列表 + 血缘记号）/ `tree` = 枝（森林 + 引线）。
 *  **默认 `case`**——日常找卷的动线零漂移；视角只影响列表区。 */
type SidebarView = 'case' | 'tree';

/** 折叠面键：两节头 + 三桶头 + 族（`fam:<根号>`）+ 独卷组（`solo`）。默认全展开，唯「更早」默认收起。 */
type FoldKey = string;
/** 折枝/独卷组的折叠面键（走同一份 `folds` 账：节/桶 + 族 + 独卷组）。 */
const famFoldKey = (id: number) => `fam:${id}`;
const SOLO_KEY = 'solo';
const DEFAULT_FOLDED: Record<string, boolean> = { earlier: true, [SOLO_KEY]: true };

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
/** 视角读取（同款毒化容忍）：未知值 → `case`。 */
function loadView(): SidebarView {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw === 'tree' || raw === 'case') return raw;
  } catch {
    /* 坏值 → 默认视角 */
  }
  return 'case';
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
    // 运行态唯一读面（v43）
    if (agentSessionState.runStateOf(panelId, row.id).running) {
      return askPending && activeSid === row.id ? 'pending' : 'running';
    }
  }
  return row.msgCount > 0 ? 'done' : 'idle';
}

export const SessionSidebar = memo(function SessionSidebar() {
  const core = useCoreStore((s) => s.core);
  /* ── 两源分离（2026-09-14：与 SpineRack 同批的竞态根治）──
   * 摊开集（内存 sess store）与磁盘已存卷清单（listSavedSessions）各入各的
   * state，行集在渲染期合流。病史：此前把合流结果直接 setRows，而**异步磁盘
   * 应答的续体用的是发起那一刻捕获的摊开集**——合卷/删卷一瞬连发数次
   * listSavedSessions（sess/agent/ask/space/消息 store 多条订阅各触发一次），
   * 先发的应答后到就把旧清单写回，已合卷的卷闪回「摊开中」节（书脊同病灶，
   * 2026-09-14 用户报书脊「被合卷那根先消失又闪回来」）。 */
  const [openRows, setOpenRows] = useState<Array<{ id: number; label: string; msgCount: number }>>([]);
  const [savedRows, setSavedRows] = useState<Parameters<typeof mergeSessionRows>[1]>([]);
  /** 当前活跃卷 id（渲染当前卷朱砂标记；status 计算也要用）。 */
  const [activeSid, setActiveSid] = useState<number | null>(null);
  /** 任一卷有在途提问（提问卡本身带卷徽标）——行状态点 pending 判据。 */
  const [askPending, setAskPending] = useState(false);
  const panelId = core?.panelId ?? '';
  const rows = useMemo<SidebarRow[]>(
    () =>
      mergeSessionRows(openRows, savedRows).map((r) => ({
        ...r,
        status: computeStatus(panelId, r, activeSid, askPending),
      })),
    [openRows, savedRows, activeSid, askPending, panelId],
  );
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  /** 磁盘清单读取失败（读面可见化：旧实现失败即空集 → 侧栏显示「本工作区暂无案卷」）。 */
  const [loadError, setLoadError] = useState<string | null>(null);
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
  /** 武装时按**磁盘真源**核出的枝数（确认文案「将同时删除 N 枝」——用户据此同意）。 */
  const [deleteBranchCount, setDeleteBranchCount] = useState(0);
  /** 多选批量删除：已勾选卷 id 集 + 批量钮武装态。 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchArmed, setBatchArmed] = useState(false);
  /** 节/桶/族折叠面（默认全展开，「更早」与「独立卷」默认收起）。 */
  const [folds, setFolds] = useState<Record<string, boolean>>(loadFolds);
  /** 视角（案卷 ⇄ 枝）：状态持久化（`VIEW_KEY`），默认案卷。 */
  const [view, setView] = useState<SidebarView>(loadView);
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

  const refreshSeqRef = useRef(0);
  /** 磁盘清单在途 / 待重扫（single-flight：并发 store 事件合并为一次重扫）。 */
  const sweepingRef = useRef(false);
  const sweepPendingRef = useRef(false);

  /* ── 刷新分频（2026-09-18 载入成本批：本栏「半天加载不出来」的根治）──
   * 内存源（摊开集/活跃卷/提问态）= 廉价，任何 store 事件都同步；
   * 磁盘源（listSavedSessions：读**全部卷体**——实测 32 MB 目录 → 21 MB / 240 ms）
   * 只在「磁盘清单可能变了」时才拉。
   * 病史：旧实现把两者塞进同一个 refresh，且订阅了**每卷消息 store**——流式追加
   * 逐块触发全量重扫（50 块消息 = 51 次读盘，守护 tests/session-sidebar-load.test.tsx），
   * 并发重扫还能把 10s 超时压爆（超时旧实现 resolve([]) → 侧栏显示「本工作区暂无案卷」）。 */
  const syncMemory = useCallback(() => {
    if (!core) return;
    const pid = core.panelId;
    const st = getChatStore(pid).sess.getState();
    setActiveSid(st.sessions[st.activeIdx]?.id ?? null);
    // 并发会话：任一卷有在途提问即标记活跃卷 pending（提问卡本身带卷徽标）
    setAskPending(useAskStore.getState().pendingBySession.size > 0);
    setOpenRows(
      st.sessions.map((s) => ({
        id: s.id,
        label: s.label,
        msgCount: msgStoreFor(pid, s.id).getState().messages.length,
      })),
    );
  }, [core]);

  /** 磁盘清单拉取（单飞 + 请求序号防竞态）。失败**保留上次结果**并明示——
   *  读面失败不得伪装成「本工作区暂无案卷」。 */
  const sweepDisk = useCallback(() => {
    if (!core) return;
    if (sweepingRef.current) {
      sweepPendingRef.current = true;
      return;
    }
    sweepingRef.current = true;
    const run = () => {
      const pp = useShellStore.getState().projectPath;
      const seq = ++refreshSeqRef.current;
      void core
        .listSavedSessions(pp)
        .then((saved) => {
          if (seq !== refreshSeqRef.current) return;
          setLoadError(null);
          setSavedRows(saved);
        })
        .catch((e) => {
          if (seq !== refreshSeqRef.current) return;
          console.error('[sidebar] 案卷清单读取失败（保留上次结果）:', e);
          setLoadError(e instanceof Error ? e.message : String(e));
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

  const refresh = useCallback(() => {
    syncMemory();
    sweepDisk();
  }, [syncMemory, sweepDisk]);

  useEffect(() => {
    if (!core) return;
    refresh();
    const panelId = core.panelId;
    // 每卷消息 store 订阅（2026-09-01 面审）：行注记「N 块」数的是消息条数，
    // 此前只订 sess/ask/agent/space——流式追加/回填后块数恒陈旧（种子注入后
    // 侧边栏恒「0 块」实锤）。会话集变化时重挂订阅。
    // 2026-09-18：这里只接**内存源**——它正是流式追加逐块触发的那条路。
    let unMsgs: Array<() => void> = [];
    const syncMsgSubs = () => {
      for (const u of unMsgs) u();
      unMsgs = [];
      const st = getChatStore(panelId).sess.getState();
      for (const s of st.sessions) unMsgs.push(msgStoreFor(panelId, s.id).subscribe(syncMemory));
    };
    syncMsgSubs();
    // 摊开集变化 = 卷的开合/改名/新建/删除 → 磁盘清单可能变了（拉）
    const unSess = getChatStore(panelId).sess.subscribe(() => {
      syncMsgSubs();
      refresh();
    });
    // 运行态/提问态/空间事件：只影响行状态点与游标，不碰磁盘（内存源同步）
    const unAgents = agentSessionState.subscribe(syncMemory);
    const unAsk = useAskStore.subscribe(syncMemory);
    const unSpace = activeSpace()?.subscribe(syncMemory);
    // 卷文件落定写入（保存/改名/合卷/删除）→ 重读清单投影（写代缓存已就地更行，
    // 这次重读零 I/O）。必须挂信号而非只挂摊开集：落盘**晚于**摊开集变化，
    // 新卷首存之后更是再无摊开集事件（否则行注记恒「未存」——假信号）。
    const unVolumes = useSessionVolumesStore.subscribe(refresh);
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
      unVolumes();
      unShell();
    };
  }, [core, refresh, syncMemory]);

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
    setDeleteBranchCount(0);
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
      // 摊开/定位统一走 expand（已摊开 = 聚焦 + 飞；未摊开 = 读盘成功才飞）——
      // 旧实现在调用侧无条件 requestFocus，卷已删/坏档时留下永不兑现的悬空
      // 定位请求（2026-09-10 收口；expand 内注释详述失败语义）。
      activeSpace()?.expand(sid);
    },
    [core, disarmAll, toggleSelect],
  );

  /* ── 行操作：改名 / 合卷（收起）/ 删除 ──
   * 磁盘写**先落定再重读**（2026-09-18）：卷清单走写代投影缓存（chat-session
   * 「卷清单投影缓存」头注），写未落定就重读会读到写前状态并被缓存下来。 */
  const commitRename = useCallback(
    async (id: number, label: string) => {
      if (!core) return;
      const next = label.trim();
      if (!next) {
        setRenamingId(null);
        return;
      }
      const st = getChatStore(core.panelId).sess.getState();
      const open = st.sessions.some((s) => s.id === id);
      if (open) core.renameSession(id, next);
      else await core.renameSavedSession(id, next);
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
      if (agentSessionState.runStateOf(core.panelId, id).running) {
        setLocalNotice('运行中的卷不能合卷——先停止再收起');
        return;
      }
      core.closeSession(idx);
      refresh();
    },
    [core, refresh],
  );

  const onDelete = useCallback(
    async (id: number) => {
      if (!core) return;
      // 二次确认（2026-08-28 会话管理专项，用户拍板）：第一击武装（按钮变红），
      // 再击才真正写墓碑——「删」与「改」「合」相邻，防误触不可撤销。
      if (confirmingDeleteIdRef.current !== id) {
        // 第一击 = 按**磁盘真源**核对血缘（plan §8 硬规①）：确认文案要如实说出
        // 「将同时删除 N 枝」；子树里有运行中的卷 ⇒ 整体拒绝并列出（§9）。
        // 核对要逐卷读头行（几百卷的工作区要几秒）——给可见的等待，别让用户以为没反应。
        setLocalNotice('正在核对血缘（逐卷读头行）…');
        let plan: Awaited<ReturnType<SidebarCore['planBranchDelete']>>;
        try {
          plan = await core.planBranchDelete(id);
        } catch (e) {
          setLocalNotice(`血缘核对失败（未删除任何卷）：${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        setLocalNotice(null);
        if (plan.blocked.length > 0) {
          const running = plan.blocked.flatMap((b) => b.running);
          setLocalNotice(
            `这一枝里有 ${running.length} 卷运行中，不能删除——先停止再移除：${running.map((n) => `案卷 ${n}`).join('、')}`,
          );
          return;
        }
        confirmingDeleteIdRef.current = id;
        setConfirmingDeleteId(id);
        setDeleteBranchCount(plan.branchCount);
        return;
      }
      confirmingDeleteIdRef.current = null;
      setConfirmingDeleteId(null);
      setDeleteBranchCount(0);
      // 再击 = 连坐删除（后序、逐卷可见——部分失败不静默）
      let outcome: Awaited<ReturnType<SidebarCore['deleteSessionWithBranches']>>;
      try {
        outcome = await core.deleteSessionWithBranches(id);
      } catch (e) {
        setLocalNotice(`删除失败：${e instanceof Error ? e.message : String(e)}`);
        refresh();
        return;
      }
      const running = outcome.blocked.flatMap((b) => b.running);
      if (outcome.deleted.length === 0 && running.length > 0) {
        setLocalNotice(
          `这一枝里有 ${running.length} 卷运行中，已整体拒绝：${running.map((n) => `案卷 ${n}`).join('、')}`,
        );
      } else {
        const branches = outcome.deleted.length - 1;
        const why =
          outcome.failed.length > 0
            ? `；${outcome.failed.length} 卷没删掉（${outcome.failed.map((f) => `案卷 ${f.id}：${f.reason}`).join('；')}）`
            : '';
        setLocalNotice(`已删 ${outcome.deleted.length} 卷${branches > 0 ? `（含 ${branches} 枝）` : ''}${why}`);
      }
      refresh();
    },
    [core, refresh],
  );

  /* ── 批量删除（两击确认同款）：同样**连坐**（选中的卷各自带整棵子树），
   *  子树里有运行中的卷 ⇒ 该选择卷整体跳过并报数。 ── */
  const onBatchDelete = useCallback(async () => {
    if (!core || selectedIds.size === 0) return;
    if (!batchArmed) {
      setBatchArmed(true);
      return;
    }
    setBatchArmed(false);
    let outcome: Awaited<ReturnType<SidebarCore['deleteSessionsWithBranches']>>;
    try {
      outcome = await core.deleteSessionsWithBranches([...selectedIds]);
    } catch (e) {
      setLocalNotice(`删除失败（未删除任何卷）：${e instanceof Error ? e.message : String(e)}`);
      refresh();
      return;
    }
    setSelectedIds(new Set());
    const parts = [`已删 ${outcome.deleted.length} 卷`];
    if (outcome.blocked.length > 0) {
      parts.push(
        `${outcome.blocked.length} 卷的子树里有运行中的卷已跳过（${outcome.blocked.map((b) => `案卷 ${b.id}`).join('、')}）`,
      );
    }
    if (outcome.failed.length > 0) {
      parts.push(`${outcome.failed.length} 卷没删掉（${outcome.failed.map((f) => `案卷 ${f.id}`).join('、')}）`);
    }
    setLocalNotice(parts.join('；'));
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
        const before = getChatStore(core.panelId).sess.getState().sessions.length;
        await core.createNewSession();
        const st = getChatStore(core.panelId).sess.getState();
        // 建卷失败（无工作区等）= 案头未变：不定位（旧实现会照读 activeIdx，
        // 对上一个活跃卷发起一次无意义飞行）——2026-09-10 同族收口。
        if (st.sessions.length <= before) return;
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

  /* ── 视角（2026-09-20 双视角批）──
   * 案卷 = 纯时间序扁平列表（不缩进、不被建树打断）；枝 = 森林（族不拆 + 引线）。
   * 视角只影响列表区；切换时解武一切破坏性动作（同「点击行 = 其它意图」纪律）。 */
  const switchView = useCallback(
    (v: SidebarView) => {
      disarmAll();
      setView(v);
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        /* 写失败仅本次会话生效 */
      }
    },
    [disarmAll],
  );

  /* ── 案卷视图：全量分节 → 节内过滤（**祖先上下文行只在同节内补**，血缘不因检索丢） ── */
  const sections = useMemo(() => splitSections(rows), [rows]);
  /** 在场卷号（全部行）：血缘悬空的判据——父卷被检索滤掉不算悬空，**不在场**才算。 */
  const presentIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const caseSections = useMemo(
    () => ({
      open: markOrphans(
        query ? withAncestorContext(filterRows(sections.open, query), sections.open) : sections.open,
        presentIds,
      ),
      closed: markOrphans(
        query ? withAncestorContext(filterRows(sections.closed, query), sections.closed) : sections.closed,
        presentIds,
      ),
    }),
    [sections, query, presentIds],
  );
  const buckets = useMemo(() => bucketClosed(caseSections.closed), [caseSections.closed]);
  /** 桶头仅在合卷集横跨多桶时立（单桶立头是噪音）。 */
  const showBucketHeads = buckets.length > 1;
  /** 案卷视图的可见行（扁平序；合卷节内按桶展开）。 */
  const caseFlat = useMemo(() => {
    const out: SidebarRow[] = [];
    if (!folded('open')) out.push(...caseSections.open);
    if (!folded('closed')) {
      for (const b of buckets) {
        if (!showBucketHeads || !folded(b.bucket)) out.push(...b.rows);
      }
    }
    return out;
  }, [caseSections, buckets, showBucketHeads, folded]);

  /* ── 枝视图：森林（族 = 根卷 + 整棵子树，**跨摊开/已合卷不拆**） ── */
  const forest = useMemo(() => {
    const src = query ? withAncestorContext(filterRows(rows, query), rows) : rows;
    return familyForest(src);
  }, [rows, query]);
  const treeFlat = useMemo(() => {
    const out: SidebarRow[] = [];
    for (const fam of forest.families) {
      out.push(fam.rows[0]);
      if (!folded(famFoldKey(fam.root.id))) out.push(...fam.rows.slice(1));
    }
    if (!folded(SOLO_KEY)) out.push(...forest.solo);
    return out;
  }, [forest, folded]);
  /** 可见行（键盘游标 / Ctrl+A / 全选可见都读它）——当前视角那一份。 */
  const flat = view === 'case' ? caseFlat : treeFlat;
  /** 族根查表（hover 整族高亮的判据；坏血缘由 guard 兜底，绝不无限上溯）。 */
  const rootOfRow = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const cache = new Map<number, number>();
    const rootOf = (id: number): number => {
      const hit = cache.get(id);
      if (hit != null) return hit;
      let cur = byId.get(id);
      const seen = new Set<number>([id]);
      while (cur?.parentId != null && byId.has(cur.parentId) && !seen.has(cur.parentId)) {
        seen.add(cur.parentId);
        cur = byId.get(cur.parentId);
      }
      const root = cur?.id ?? id;
      for (const s of seen) cache.set(s, root);
      cache.set(id, root);
      return root;
    };
    return rootOf;
  }, [rows]);
  const [hoverId, setHoverId] = useState<number | null>(null);
  /** 血缘卡（案卷视图）：父卷名 + 号 + 相对时间；「枝」牌 hover/聚焦/点击开合。
   *  **热区与宽限**（真机报「鼠标一动卡片就消失」的修法）：牌与卡同属 `.ss-lineage`
   *  子树（进卡不触发 mouseleave），再加 200ms 关延迟——牌在名行、卡在行外，
   *  指针总要横穿一截非热区（meta 行），没有宽限就必然中途掉出。 */
  const [cardId, setCardId] = useState<number | null>(null);
  const cardTimerRef = useRef<number | null>(null);
  const openCard = useCallback((id: number) => {
    if (cardTimerRef.current != null) {
      clearTimeout(cardTimerRef.current);
      cardTimerRef.current = null;
    }
    setCardId(id);
  }, []);
  const closeCardNow = useCallback(() => {
    if (cardTimerRef.current != null) {
      clearTimeout(cardTimerRef.current);
      cardTimerRef.current = null;
    }
    setCardId(null);
  }, []);
  const closeCardSoon = useCallback(() => {
    if (cardTimerRef.current != null) clearTimeout(cardTimerRef.current);
    cardTimerRef.current = window.setTimeout(() => {
      cardTimerRef.current = null;
      setCardId(null);
    }, 200);
  }, []);
  useEffect(
    () => () => {
      if (cardTimerRef.current != null) clearTimeout(cardTimerRef.current);
    },
    [],
  );
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  /* 当前卷进场（2026-09-20 双视角批）：切换当前卷后把它滚进视野（nearest = 已在视野内不动）。 */
  useEffect(() => {
    if (activeSid == null) return;
    rowRefs.current.get(activeSid)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeSid]);

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
      /* ← →（枝视图专属；案卷视图无树可走 ⇒ 不吞键，留给其它面）
       *  → = 折着就展开本行；已展开就进第一个子行；无枝 = 空操作
       *  ← = 展着就折起本行；否则回父行（父不在可见集 = 空操作） */ else if (
        (e.key === 'ArrowRight' || e.key === 'ArrowLeft') &&
        view === 'tree' &&
        idx >= 0
      ) {
        const row = flat[idx];
        const kids = row.kids ?? 0;
        const foldKey = famFoldKey(row.id);
        const isFolded = folded(foldKey);
        if (e.key === 'ArrowRight') {
          if (kids === 0) return;
          e.preventDefault();
          if (isFolded) toggleFold(foldKey);
          else {
            const childId = flat[idx + 1]?.parentId === row.id ? flat[idx + 1].id : null;
            if (childId != null) {
              setCursorId(childId);
              rowRefs.current.get(childId)?.focus();
            }
          }
          return;
        }
        e.preventDefault();
        if (kids > 0 && !isFolded) toggleFold(foldKey);
        else if (row.parentId != null && flat.some((x) => x.id === row.parentId)) {
          setCursorId(row.parentId);
          rowRefs.current.get(row.parentId)?.focus();
        }
        return;
      } else if (e.key === 'F2' && idx >= 0) {
        e.preventDefault();
        const row = flat[idx];
        disarmAll();
        setRenamingId(row.id);
        // 预填**原名**（未命名/旧默认名 → 空）：显示兜底「案卷 N」不得被洗成写入值
        // （否则改一次名就把一个假名字钉进卷文件）——见 state/volume-name 头注。
        setDraftLabel(isUnnamedVolumeLabel(row.label) ? '' : row.label);
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
        void onDelete(flat[idx].id);
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
    [flat, cursorId, renamingId, onDelete, onCollapse, toggleSelect, disarmAll, view, folded, toggleFold],
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

  /**
   * 行渲染（两视角共用壳，差异集中在三处）：
   *  · **案卷视图**（`variant === 'case'`）＝不缩进；血缘 = 名后一枚等宽 `↳N` 记号（hover/聚焦/点击
   *    开血缘卡）——树不画进窄栏，时间序不被打断（2026-09-20 双视角批）；
   *  · **枝视图**（`variant === 'tree'`）＝引线折角（轴走左标记列）+ 父行 `▾ N 枝` 汇总 + 族高亮。
   */
  const renderRow = (r: SidebarRow, variant: SidebarView) => {
    const isRenaming = renamingId === r.id;
    const isCurrent = r.open && r.id === activeSid;
    const isSelected = selectedIds.has(r.id);
    const branch = r.parentId != null;
    const depth = variant === 'tree' ? (r.depth ?? 0) : 0;
    const tree = variant === 'tree';
    const kids = r.kids ?? 0;
    const famFolded = tree && kids > 0 && folded(famFoldKey(r.id));
    const famHot = tree && hoverId != null && rootOfRow(hoverId) === rootOfRow(r.id);
    const parentRow = r.parentId != null ? rowById.get(r.parentId) : undefined;
    // 引线：逐层「末子」旗标 ⇒ ├ / └ / 竖线 / 空（与原型同一套判据）
    const guides: React.ReactNode[] = [];
    if (tree && depth > 0) {
      for (let i = 0; i < depth; i++) {
        const last = r.lastAt?.[i] ?? true;
        guides.push(<i key={i} className={`gl ${i === depth - 1 ? (last ? 'end' : 'tee') : last ? 'blank' : 'v'}`} />);
      }
    }
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
        className={`ss-row${r.open ? ' open' : ''}${isCurrent ? ' current' : ''}${isSelected ? ' selected' : ''}${
          branch ? ' branch' : ''
        }${r.orphan ? ' orphan' : ''}${r.contextOnly ? ' context' : ''}${famHot ? ' fam' : ''}${
          famFolded ? ' folded' : ''
        }`}
        data-id={r.id}
        data-depth={depth}
        title={`${volumeDisplayName(r.label, r.id)}${branch ? ` · 枝（父卷 Nº ${r.parentId}）` : ''}${
          r.orphan ? ' · 父卷已删' : ''
        }${isCurrent ? ' · 当前卷' : ''} · ${statusLabel(r.status)} · 左键摊开/定位 · 拖动落位`}
        aria-current={isCurrent ? 'true' : undefined}
        aria-expanded={tree && kids > 0 ? !famFolded : undefined}
        onClick={(e) => onRowClick(e, r)}
        onMouseDown={(e) => onRowMouseDown(e, r)}
        onMouseEnter={tree ? () => setHoverId(r.id) : undefined}
        onMouseLeave={tree ? () => setHoverId((prev) => (prev === r.id ? null : prev)) : undefined}
        onFocus={() => {
          setCursorId(r.id);
          if (tree) setHoverId(r.id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onRowClick(e, r);
          }
        }}
      >
        {guides.length > 0 && (
          <span className="ss-guide" aria-hidden="true">
            {guides}
          </span>
        )}
        {tree && kids > 0 && !famFolded && (
          <i className="ss-desc" aria-hidden="true" style={{ left: 18 + 16 * depth }} />
        )}
        <span className={tree ? 'ss-mark' : 'ss-bare'}>
          <button
            type="button"
            className={`ss-check${isSelected ? ' on' : ''}`}
            aria-pressed={isSelected}
            aria-label={`${isSelected ? '取消选择' : '选择'}案卷：${volumeDisplayName(r.label, r.id)}`}
            title="勾选后可批量删除（Ctrl+点击 / X 键同效）"
            onClick={(e) => {
              e.stopPropagation();
              toggleSelect(r.id);
            }}
          />
          <span className={`ss-dot ss-dot-${r.status}`} role="presentation" />
        </span>
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
                void commitRename(r.id, draftLabel);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenamingId(null);
              }
              e.stopPropagation();
            }}
            onBlur={() => void commitRename(r.id, draftLabel)}
          />
        ) : (
          <div className="ss-row-main">
            <span className="ss-label-row">
              <span className="ss-label">{volumeDisplayName(r.label, r.id)}</span>
              {/* 案卷视图：枝卷的**明显标识** = 与书脊/卷首同一枚「枝」牌（一屏一语言），
                  牌上带父卷号、牌是血缘卡的热区；卡与牌同属 .ss-lineage 子树
                  ⇒ 指针从牌移到卡不会触发 mouseleave（旧实现把卡挂在行上、热区只在记号上，
                  指针一动就掉出热区 = 真机报的「鼠标一动卡片就消失」）。 */}
              {!tree && branch && (
                // biome-ignore lint/a11y/noStaticElementInteractions: 悬停宽限区——可交互件是里面的「枝」牌按钮；本 span 只负责让指针从牌走到卡时不掉出热区
                <span className="ss-lineage" onMouseEnter={() => openCard(r.id)} onMouseLeave={closeCardSoon}>
                  <button
                    type="button"
                    className="ss-branch-tag"
                    aria-label={`枝：这一卷分出案卷 Nº ${r.parentId}`}
                    aria-expanded={cardId === r.id}
                    title={`枝：从父卷 Nº ${r.parentId} 的某个节点分出（内容自包含）${parentRow ? '' : '；父卷不在场'}`}
                    onFocus={() => openCard(r.id)}
                    onBlur={closeCardSoon}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (cardId === r.id) closeCardNow();
                      else openCard(r.id);
                    }}
                  >
                    枝<i className="ss-tag-src">{r.parentId}</i>
                  </button>
                  {cardId === r.id && (
                    <div className="ss-lineage-card">
                      <div className="t">
                        {parentRow
                          ? volumeDisplayName(parentRow.label, parentRow.id)
                          : `案卷 Nº ${r.parentId}（不在场）`}
                      </div>
                      <span className="m">
                        Nº {r.parentId}
                        {parentRow ? ` · ${parentRow.msgCount} 块 · 枝自它分出` : ' · 外部删除或拷走'}
                      </span>
                      <div className="acts">
                        {parentRow ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              closeCardNow();
                              activeSpace()?.expand(String(r.parentId));
                            }}
                          >
                            摊开父卷
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeCardNow();
                          }}
                        >
                          知道了
                        </button>
                      </div>
                    </div>
                  )}
                </span>
              )}
              {r.contextOnly && <span className="ss-context-tag">上下文</span>}
            </span>
            {/* 悬空血缘的注记由 sessionMeta 出（「父卷已删」，两视角同一处，不重复写） */}
            <span className="ss-meta">{sessionMeta(r)}</span>
          </div>
        )}
        <span className="ss-tail">
          {tree && kids > 0 && (
            <button
              type="button"
              className="ss-kids"
              aria-expanded={!famFolded}
              title={famFolded ? '展开这一枝' : '收起这一枝'}
              onClick={(e) => {
                e.stopPropagation();
                disarmAll();
                toggleFold(famFoldKey(r.id));
              }}
            >
              {famFolded ? '▸' : '▾'} {kids} 枝
            </button>
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
                  setDraftLabel(isUnnamedVolumeLabel(r.label) ? '' : r.label); // 原名（未命名 → 空）
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
                  title={
                    deleteBranchCount > 0
                      ? `再点一次确认：将同时删除 ${deleteBranchCount} 枝（删父卷连坐整棵子树，不可撤销）`
                      : '再点一次确认删除（不可撤销）；点其它处取消'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    void onDelete(r.id);
                  }}
                >
                  {deleteBranchCount > 0 ? `确删 ${deleteBranchCount + 1} 卷?` : '确删?'}
                </button>
              ) : (
                <button
                  type="button"
                  title="彻底删除（点两次确认）"
                  onClick={(e) => {
                    e.stopPropagation();
                    void onDelete(r.id);
                  }}
                >
                  删
                </button>
              )}
            </div>
          )}
        </span>
        {/* 血缘卡随「枝」牌走（在 .ss-lineage 子树里）——见 renderRow 头注的病灶说明 */}
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
        {!isFolded && brows.map((r) => renderRow(r, 'case'))}
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

      {/* 出生仪式（2026-09-02 用户拍板：上移检索条下常驻——沉底要翻一整屏才能开新卷） */}
      <div className="ss-new-row">
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

      {(localNotice || loadError) && (
        <div className="ss-notice">
          {localNotice ?? `案卷清单读取失败：${loadError}——已保留上次结果，重开侧栏可重试`}
          <button
            type="button"
            onClick={() => {
              setLocalNotice(null);
              setLoadError(null);
            }}
          >
            知道了
          </button>
        </div>
      )}

      {/* 视角分段（2026-09-20 双视角批）：案卷 = 时间序（默认）/ 枝 = 血缘森林。
          紧贴列表之上——它管的就是下面这一屏，不挤「另起一卷」那条主动作。 */}
      <div className="ss-views" role="tablist" aria-label="案卷列表视角">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'case'}
          className={view === 'case' ? 'on' : ''}
          title="案卷：按时间排（最近动过的在上），血缘看每行那枚 ↳ 记号"
          onClick={() => switchView('case')}
        >
          案卷
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'tree'}
          className={view === 'tree' ? 'on' : ''}
          title="枝：按血缘排（一族一卷一棵树），父子不拆"
          onClick={() => switchView('tree')}
        >
          枝
        </button>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: 键盘导航容器（↑↓/←→/F2/C/Delete/X 经事件冒泡统一处理）。
          role=tree 语义留待重排 DOM 的小批（分组头/折枝注记是并列件，硬套 role=tree 结构不成立）——
          本批只给折枝钮 aria-expanded + 行 aria-current（见 plan §2.4 裁定）。 */}
      <div className="ss-list" onKeyDown={onListKeyDown} data-view={view}>
        {view === 'case' && caseSections.open.length > 0 && (
          <div className="ss-section">
            <button
              type="button"
              className={`ss-section-head${openFolded ? ' folded' : ''}`}
              aria-expanded={!openFolded}
              onClick={() => toggleFold('open')}
            >
              <span className="t">摊开中</span>
              <span className="leader" role="presentation" />
              <span className="n">OPEN · {caseSections.open.length}</span>
            </button>
            {!openFolded && caseSections.open.map((r) => renderRow(r, 'case'))}
          </div>
        )}
        {view === 'case' && caseSections.closed.length > 0 && (
          <div className="ss-section">
            <button
              type="button"
              className={`ss-section-head${closedFolded ? ' folded' : ''}`}
              aria-expanded={!closedFolded}
              onClick={() => toggleFold('closed')}
            >
              <span className="t">已合卷</span>
              <span className="leader" role="presentation" />
              <span className="n">CLOSED · {caseSections.closed.length}</span>
            </button>
            {!closedFolded &&
              (showBucketHeads
                ? buckets.map(renderBucket)
                : buckets.flatMap((b) => b.rows.map((r) => renderRow(r, 'case'))))}
          </div>
        )}

        {view === 'tree' && forest.families.length > 0 && (
          <div className="ss-section">
            <button
              type="button"
              className={`ss-section-head${folded('trees') ? ' folded' : ''}`}
              aria-expanded={!folded('trees')}
              onClick={() => toggleFold('trees')}
            >
              <span className="t">有一枝的卷</span>
              <span className="leader" role="presentation" />
              <span className="n">TREES · {forest.families.length}</span>
            </button>
            {!folded('trees') &&
              forest.families.map((fam) => {
                const foldKey = famFoldKey(fam.root.id);
                const isFolded = folded(foldKey);
                const latest = fam.rows.reduce((acc, x) => ((x.savedAt || '') > acc ? x.savedAt || '' : acc), '');
                return (
                  <div className="ss-fam" key={fam.root.id}>
                    {renderRow(fam.rows[0], 'tree')}
                    {!isFolded && fam.rows.slice(1).map((r) => <div key={r.id}>{renderRow(r, 'tree')}</div>)}
                    {isFolded && (
                      <div className="ss-folded-note">
                        … 折起的 {fam.rows.length - 1} 枝（点 ▸ 展开，最近 {relativeTime(latest)}）
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
        {view === 'tree' && forest.solo.length > 0 && (
          <div className="ss-section">
            <button
              type="button"
              className={`ss-section-head${folded(SOLO_KEY) ? ' folded' : ''}`}
              aria-expanded={!folded(SOLO_KEY)}
              onClick={() => toggleFold(SOLO_KEY)}
            >
              <span className="t">独立卷（无枝）</span>
              <span className="leader" role="presentation" />
              <span className="n">SOLO · {forest.solo.length}</span>
            </button>
            {!folded(SOLO_KEY) && forest.solo.map((r) => renderRow(r, 'tree'))}
          </div>
        )}

        {rows.length === 0 && <div className="ss-empty">本工作区暂无案卷</div>}
        {rows.length > 0 && flat.length === 0 && <div className="ss-empty">无匹配案卷</div>}
      </div>

      {selectedIds.size > 0 && (
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionsHome — 案卷首页 = 案头（上卷 + 登记簿）（丁案，2026-10-31 用户拍板）。
//
// 定案（docs/plans/canvas-space/stage-2.md §3.5 方案 A + Stage-5 补尾拍板，
// 2026-10-31 用户「合个第四版」后拍板丁案）：
// **上半「上卷」**——当前工作区最近落盘的一卷（卷名 / 末次 / 块数），
//   「继续」= 开画布并摊开该卷；右栏是同工作区其他卷（点 = 摊开该卷）。
//   数据 = `core.listSavedSessions(projectPath)`——冷启动已恢复工作区、
//   侧栏卷清单投影已在内存，**零新 RPC / 零新 faceDeps 键**。
// **下半「登记簿」**——工作区目录：档号 / 工作区 / 案卷 / 最近 / 路径 / 进入。
//   工作区管理（新建 / 改名 / 固定 / 移除）仍在这里；会话管理仍在画布侧栏。
// 无工作区 → 「库房还空着」虚线框 + 双路入口；有工作区但本区无卷 → 上卷退化为
// 「这张纸还空着」（另起一卷）。
//
// 数据源：`workspace_list` 单一来源——Rust 把 ~/.lantai/workspaces.json 注册表
// 全量列出，每个工作区的会话计数/最近时间扫**自己的会话根**
// `{path}/.lantai/sessions/`（workspace-session-ownership-rework 2026-08-27）。
//
// 版式对齐 prototype/home-audit/direction-d.html（丁案取帧，2026-10-31）。

import { useCallback, useEffect, useRef, useState } from 'react';
import './home.css';
import { volumeDisplayName } from '../../../state/volume-name';
import {
  activeSpace,
  clearWorkspaceListCache,
  onTopbarDoubleClick,
  onTopbarPointerDown,
  pickFolder,
  shellRefs,
  typedJsonRpc,
  typedRpc,
  useCoreStore,
  useDockStore,
  useSessionVolumesStore,
  useShellStore,
  useUpdateStore,
  WinControls,
  type WorkspaceSummary,
  workspaceFlow,
  workspaceListCached,
} from './host';

/** 已知工作区行（Rust WorkspaceSummary 同形——类型由 workspace_list schema 推导）。 */
type KnownWorkspace = WorkspaceSummary;

/** 当前工作区的卷行（`listSavedSessions` 的结构子集——只取上卷/其他卷要用的字段）。 */
interface SavedVolume {
  id: number;
  label: string;
  msgCount: number;
  savedAt: string;
}

/** 卷清单读面三态（loading 首拉骨架 / ready 含合法空集 / error 保留上次结果）。 */
type VolumeState = 'loading' | 'ready' | 'error';

/** 工作区显示名：登记名优先，缺省 = 路径末段。 */
function wsDisplayName(ws: KnownWorkspace): string {
  if (ws.name?.trim()) return ws.name.trim();
  return pathBasename(ws.path);
}

function pathBasename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const last = norm.split('/').filter(Boolean).pop();
  return last ?? norm;
}

/** 路径等值比较（大小写/斜杠不敏感——与 Rust registry norm_path 同规）。
 *  本地内联小函数：避免 import workspace.ts 巨型模块图进首页。 */
function isSamePath(a: string, b: string): boolean {
  return (
    a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  );
}

/** 表内路径中段省略：尾部（末段目录名）比开头更认得出是哪个工作区。
 *  （不用 CSS direction:rtl——Windows 路径的 bidi 会把盘符/反斜杠重排，实测踩过。） */
function shortPath(p: string, max = 36): string {
  if (p.length <= max) return p;
  const segs = p.replace(/\//g, '\\').split('\\').filter(Boolean);
  for (let keep = segs.length - 1; keep >= 1; keep -= 1) {
    const s = `…\\${segs.slice(-keep).join('\\')}`;
    if (s.length <= max) return s;
  }
  return `…\\${segs.slice(-1).join('')}`;
}

/** 恢复卡死判定阈值（2026-09-09 事故立法）：切区/冷启动恢复 busy 超过
 *  此时长视为挂死——健康恢复链（大工作区实测秒级）远低于此。超阈值后
 *  isBusy 守卫从「请稍候」升级为亮「强制重置」逃生口（workspaceFlow.
 *  stuckRecover），不再把用户锁死在所有工作区外面。 */
const STUCK_SWITCH_MS = 60_000;

/** 案卷日期列：MM-DD（卷行与上卷 meta 同款）。 */
function formatSessionDate(iso: string | null | undefined): string {
  if (!iso) return '——';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '——';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 两位机读计数（04 / 00——印版与节题同款）。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 点「继续」/点其他卷：纸面板挂载与空间注册是异步的——逐帧等 `activeSpace()`
 *  就位再 expand（最多 ~10 帧）。空间始终不到 = 只开画布（不假装已定位）。 */
function expandWhenReady(id: number, tries = 10): void {
  const space = activeSpace();
  if (space) {
    space.expand(String(id));
    return;
  }
  if (tries > 0) requestAnimationFrame(() => expandWhenReady(id, tries - 1));
}

/* 顶栏拖拽/双击最大化：实现收在 app/window-drag.ts（单一真源，画布顶部浮件
 * 与首页顶栏共用）。2026-09-14 app-region 全面退役——页面两处标题栏都不再
 * 声明 app-region，命中范围由元素自己判定（见该文件头注：WebView2 行窗只在
 * 启动时算一次）。首页顶栏（.sh-head）**保留**：首页不是画布，没有「顶缘即
 * 屏缘」的诉求，那条带仍是拖窗口最顺手的落点。 */

export function SessionsHome() {
  const openPanel = useDockStore((s) => s.openPanel);

  // ── 已知工作区清单（workspace_list：注册表 + 会话推导合流）──
  // listState 三态（2026-08-29 走查）：Rust 侧注册表缺席/毒化返回空表不报错，
  // 因此 RPC 失败必是真故障——不再把错误伪装成「还没有工作区」空态。
  const [workspaces, setWorkspaces] = useState<KnownWorkspace[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  /** 卡死逃生口可见位（2026-09-09 事故立法）：isBusy 守卫发现恢复超过
   *  STUCK_SWITCH_MS 时置位——亮「强制重置」按钮；正常路径复位。 */
  const [forceReset, setForceReset] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 内联改名（一次一行）。 */
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  /** 新建工作区 sheet（2026-08-31 拍板）：choose = 双路选择 / create = 命名创建。
   *  「指定已有目录」直接走系统选择器，不经 create 阶段。 */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetStage, setSheetStage] = useState<'choose' | 'create'>('choose');
  const [newWsName, setNewWsName] = useState('');
  /** 移除确认模态（2026-08-31 拍板「不做退路、确认做足」）：居中弹窗 + 勾选
   *  承认不可恢复后才能点亮红色删除键；取代旧的卡片内两段式点击确认。 */
  const [removeTarget, setRemoveTarget] = useState<KnownWorkspace | null>(null);
  const [removeAck, setRemoveAck] = useState(false);
  /** 创建页名字输入框焦点（noAutofocus 纪律：ref + effect 取代 autoFocus 属性）。 */
  const createNameInputRef = useRef<HTMLInputElement | null>(null);

  // ── 上卷（丁案）：**上次在案**工作区最近落盘的一卷 + 同区其他卷 ──
  // 回首页 = 真关工作区（projectPath 清空），故「上次在案」走 .last_project
  // （冷启动同源）——否则用户一回首页，上卷就凭空消失。
  const projectPath = useShellStore((s) => s.projectPath);
  const core = useCoreStore((s) => s.core);
  const volumesTick = useSessionVolumesStore((s) => s.volumesTick);
  const [lastProject, setLastProject] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<SavedVolume[]>([]);
  const [volState, setVolState] = useState<VolumeState>('loading');
  const [volReload, setVolReload] = useState(0);
  const heroPath = projectPath || lastProject || '';

  useEffect(() => {
    if (renamingPath !== null) renameInputRef.current?.focus();
  }, [renamingPath]);

  useEffect(() => {
    if (sheetOpen && sheetStage === 'create') createNameInputRef.current?.focus();
  }, [sheetOpen, sheetStage]);

  // 刷新时机：挂载期 + 每次纸面板从开到关（回首页即重拉）。
  const paperOpen = useDockStore((s) => s.open.paper);

  // 发给：换区/换「上次在案」→ 上卷立即清空（不拿上一个区的卷冒充本区）；
  // 回到首页/写代变化 → 重拉。
  // biome-ignore lint/correctness/useExhaustiveDependencies: heroPath 是刻意的「换区清空」触发器——正是要响应它变化清上卷，非 effect 体内直接引用值
  useEffect(() => {
    setVolumes([]);
    setVolState('loading');
  }, [heroPath]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: volumesTick / volReload 是刻意的重读触发器（卷落盘写代 / 读失败重试），非 effect 体内直接引用值——与 compose-dock 的 settingsTick 同款手法
  useEffect(() => {
    if (paperOpen) return;
    if (!core || !heroPath) return;
    let alive = true;
    // 首拉/重试才进骨架；已就绪的静默刷新不闪加载态（回首页不闪）
    setVolState((s) => (s === 'error' ? 'loading' : s));
    void core
      .listSavedSessions(heroPath)
      .then((rows) => {
        if (!alive) return;
        setVolumes(rows);
        setVolState('ready');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        console.error('[home] 卷清单读取失败（保留上次结果）:', e);
        setVolState('error');
      });
    return () => {
      alive = false;
    };
  }, [paperOpen, core, heroPath, volumesTick, volReload]);

  const refreshVolumes = useCallback(() => setVolReload((n) => n + 1), []);

  useEffect(() => {
    if (paperOpen) return;
    let alive = true;
    void (async () => {
      try {
        const parsed = await workspaceListCached();
        if (alive) {
          setWorkspaces(parsed);
          setListState('ready');
        }
      } catch {
        if (alive) setListState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [paperOpen]);

  // 回首页 = 真关工作区（projectPath 清空）——「上次在案」从 .last_project 取
  // （冷启动同源；workspace_activate 每次绑定都写）。只读 RPC，失败不编路径。
  // 放在工作区清单之后：挂载期先拉清单（登记簿是主面），再补上卷记忆。
  useEffect(() => {
    if (paperOpen) return;
    let alive = true;
    void typedJsonRpc('get_last_project', {})
      .then((p) => {
        if (alive) setLastProject(p);
      })
      .catch((e: unknown) => {
        console.error('[home] get_last_project 读取失败（上卷暂缺）:', e);
        if (alive) setLastProject(null);
      });
    return () => {
      alive = false;
    };
  }, [paperOpen]);

  const refreshWorkspaces = useCallback(async (): Promise<void> => {
    try {
      // 写操作后刷新：显式清缓存（避免 TTL 内拿到旧数据）
      clearWorkspaceListCache();
      const parsed = await workspaceListCached();
      setWorkspaces(parsed);
      setListState('ready');
    } catch {
      setListState('error');
    }
  }, []);

  /** 上卷重试：卷读面 + 工作区清单一起重取——目录若真没了，`dir_exists`
   *  会在下一份清单里翻成 false，上卷随之落到「目录已丢失」（不是无限重试）。 */
  const retryHero = useCallback(() => {
    refreshVolumes();
    void refreshWorkspaces();
  }, [refreshVolumes, refreshWorkspaces]);

  /** 切区/恢复守卫（2026-09-09 事故立法）：busy 时拦截，超阈值升级为「强制重置」
   *  逃生口。返回 true = 可以继续。 */
  const guardBusy = useCallback((): boolean => {
    if (!shellRefs.wsMachine.isBusy) {
      setForceReset(false);
      return true;
    }
    const stuck = shellRefs.wsMachine.busyMs > STUCK_SWITCH_MS;
    setForceReset(stuck);
    setNotice(stuck ? '工作区恢复仍未完成（已超过 1 分钟）——疑似卡死' : '工作区正在恢复中，请稍候…');
    return false;
  }, []);

  /** 进入工作区画布：打开纸面板 + （必要时）切到该工作区。
   *  摊开集由画布状态文件恢复（Stage-5 拍板 11）。
   *  目录已丢失的工作区禁进（调用侧守卫）。 */
  const onEnterWorkspace = useCallback(
    (ws: string) => {
      setRemoveTarget(null);
      if (!guardBusy()) return;
      setNotice(null);
      openPanel('paper');
      const current = useShellStore.getState().projectPath;
      if (!isSamePath(ws, current)) {
        void workspaceFlow.switchWorkspace(ws);
      }
    },
    [guardBusy, openPanel],
  );

  /** 上卷「继续」/同区其他卷：开画布并摊开指定卷（best-effort 定位）。
   *  上卷可能是**已关**的工作区（回首页 = 真关工作区）——先切区再定位；
   *  切区 Promise 落定后空间才在册，故 expand 放到 then 里再逐帧等。 */
  const onOpenVolume = useCallback(
    (id: number) => {
      if (!guardBusy()) return;
      setNotice(null);
      const target = heroPath;
      const active = useShellStore.getState().projectPath;
      openPanel('paper');
      if (target && !isSamePath(target, active)) {
        void workspaceFlow
          .switchWorkspace(target)
          .then(() => expandWhenReady(id, 24))
          .catch((e: unknown) => {
            console.error('[home] 续开工作区失败:', e);
            setNotice(`打开失败: ${e instanceof Error ? e.message : String(e)}`);
          });
      } else {
        expandWhenReady(id);
      }
    },
    [guardBusy, heroPath, openPanel],
  );

  /** 「另起一卷」：开画布后起一卷（纸面板挂载/工厂注册在事件提交之后，故让一拍）。
   *  建卷是纯数据操作（chat-session 的 DSH 形态），失败可见不静默。 */
  const onNewVolume = useCallback(() => {
    if (!guardBusy()) return;
    setNotice(null);
    const target = heroPath;
    const active = useShellStore.getState().projectPath;
    openPanel('paper');
    const createVolume = () => {
      window.setTimeout(() => {
        const liveCore = useCoreStore.getState().core;
        if (!liveCore) return;
        void liveCore.createNewSession().catch((e: unknown) => {
          console.error('[home] createNewSession failed:', e);
          setNotice(`另起一卷失败：${e instanceof Error ? e.message : String(e)}`);
        });
      }, 0);
    };
    if (target && !isSamePath(target, active)) {
      void workspaceFlow
        .switchWorkspace(target)
        .then(createVolume)
        .catch((e: unknown) => {
          console.error('[home] 另起一卷前切区失败:', e);
          setNotice(`另起一卷失败: ${e instanceof Error ? e.message : String(e)}`);
        });
    } else {
      createVolume();
    }
  }, [guardBusy, heroPath, openPanel]);

  /** 强制重置卡死的恢复（workspaceFlow.stuckRecover）：回收在途切区 + 状态机
   *  复位——用户随后重新点击工作区卡即走全新 switch。 */
  const onForceReset = useCallback(() => {
    setForceReset(false);
    setNotice(null);
    void workspaceFlow.stuckRecover();
  }, []);

  /** 新建工作区 sheet：创建/指定双路（2026-08-31 拍板——一个按钮管两件事）。
   *  出生仪式在画布——sheet 只负责把工作区实体立起来（建目录/选目录）。 */
  const onOpenCreateSheet = useCallback(() => {
    setNotice(null);
    setNewWsName('');
    setSheetStage('choose');
    setSheetOpen(true);
  }, []);

  /** 「创建」提交：命名 → ~/Documents/兰台/<名字> → activate → 进画布。 */
  const onCreateCommit = useCallback(async () => {
    const name = newWsName.trim();
    if (!name || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const path = await typedRpc('workspace_create_dir', { name });
      // 写操作后清缓存——回首页时 workspaceListCached 重新拉（不拿 TTL 内旧表）
      clearWorkspaceListCache();
      setSheetOpen(false);
      openPanel('paper');
      await workspaceFlow.switchWorkspace(path);
    } catch (e) {
      console.error('[home] workspace_create_dir failed:', e);
      setNotice(`创建失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [newWsName, busy, openPanel]);

  /** 「指定已有目录」提交：系统选择器 → activate → 进画布。 */
  const onPickCommit = useCallback(async () => {
    if (busy) return;
    const folder = await pickFolder();
    if (!folder) return;
    setSheetOpen(false);
    setNotice(null);
    setBusy(true);
    try {
      // activate 会登记新工作区——同样清缓存
      clearWorkspaceListCache();
      openPanel('paper');
      await workspaceFlow.switchWorkspace(folder);
    } catch (e) {
      console.error('[home] pick workspace failed:', e);
      setNotice(`打开失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, openPanel]);

  /** 改名提交：空名 = 取消。 */
  const onRenameCommit = useCallback(
    async (path: string) => {
      const next = renameDraft.trim();
      setRenamingPath(null);
      if (!next) return;
      setBusy(true);
      try {
        await typedRpc('workspace_rename', { path, name: next });
        await refreshWorkspaces();
      } catch (e) {
        console.error('[home] workspace_rename failed:', e);
        setNotice(`改名失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [renameDraft, refreshWorkspaces],
  );

  const onTogglePin = useCallback(
    async (ws: KnownWorkspace) => {
      setBusy(true);
      try {
        await typedRpc('workspace_toggle_pin', { path: ws.path, pinned: !ws.pinned });
        await refreshWorkspaces();
      } catch (e) {
        console.error('[home] workspace_toggle_pin failed:', e);
        setNotice(`固定失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [refreshWorkspaces],
  );

  /** 移除工作区（彻底：连带删其中全部案卷）——模态 + 勾选确认后执行。
   *  「不做退路」拍板（2026-08-31）：没有「仅移出清单」选项；Rust 侧删除
   *  失败会报错且保留登记（不产生孤儿卷）。 */
  const onRemoveConfirmed = useCallback(
    async (ws: KnownWorkspace) => {
      setBusy(true);
      setNotice(null);
      try {
        await typedRpc('workspace_remove', { path: ws.path });
        setRemoveTarget(null);
        setRemoveAck(false);
        await refreshWorkspaces();
        setNotice(
          `已移除工作区「${wsDisplayName(ws)}」${ws.session_count > 0 ? `（含 ${ws.session_count} 卷案卷）` : ''}`,
        );
      } catch (e) {
        console.error('[home] workspace_remove failed:', e);
        setNotice(`移除失败: ${e instanceof Error ? e.message : String(e)}`);
        setRemoveTarget(null);
        setRemoveAck(false);
      } finally {
        setBusy(false);
      }
    },
    [refreshWorkspaces],
  );

  const onOpenSettings = useCallback(() => openPanel('settings'), [openPanel]);
  // 更新角标（update-store）：启动自动检查发现新版本且用户未看过 → 朱砂点
  const updateAvailable = useUpdateStore((s) => s.status === 'available' && !s.badgeDismissed);
  const updateVersion = useUpdateStore((s) => s.version);

  const totalVolumes = workspaces.reduce((n, w) => n + w.session_count, 0);
  const latestActivity = workspaces.reduce<string | null>((acc, w) => {
    const t = w.latest_saved_at;
    if (!t) return acc;
    return !acc || t > acc ? t : acc;
  }, null);
  const lastVolume: SavedVolume | null = volumes[0] ?? null;
  const siblings = volumes.slice(1, 4);
  const heroWs = heroPath ? (workspaces.find((w) => isSamePath(w.path, heroPath)) ?? null) : null;
  const deadWs = heroWs && heroWs.dir_exists === false ? heroWs : null;
  const heroWsName = heroWs ? wsDisplayName(heroWs) : heroPath ? pathBasename(heroPath) : '';
  const heroWsCount = heroWs ? heroWs.session_count : volumes.length;
  const showEmptyShelf = listState === 'ready' && workspaces.length === 0;

  return (
    <div className="sh-root">
      {/* 顶部书眉：印章 + 兰台 wordmark · 右侧设置入口 + 窗口控制 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 窗口拖拽热区（decorations:false 的标题栏） */}
      <header className="sh-head" onPointerDown={onTopbarPointerDown} onDoubleClick={onTopbarDoubleClick}>
        <div className="sh-brand">
          <span className="sh-seal" role="img" aria-label="印章：蘭臺"></span>
          <span className="sh-wordmark">兰台</span>
        </div>
        <div className="sh-head-right">
          <button
            type="button"
            className={`sh-btn-text${updateAvailable ? ' has-update' : ''}`}
            onClick={onOpenSettings}
            data-tip={updateAvailable && updateVersion ? `新版本 ${updateVersion} 可用` : undefined}
          >
            设置
          </button>
          <WinControls />
        </div>
      </header>

      <main className="sh-main">
        {/* 题签：只说一件事——案头（续读）；工作区目录在下面 */}
        <div className="sh-kicker">
          本机档案　·　<b>{pad2(workspaces.length)}</b> 个工作区　·　<b>{pad2(totalVolumes)}</b> 卷在案
        </div>
        <h1 className="sh-h1">
          案头<span className="sh-ju">。</span>
        </h1>
        <div className="sh-lead">上次的卷还摊着。</div>

        {/* ── 上卷（丁案）：上次在案那一卷 + 同区其他卷 ── */}
        {/* 目录已丢失：`dir_exists` 是清单的权威判据——优先于「空卷 / 读失败」，
            否则被移走的目录会被读面返回的空集伪装成「还没有卷」。 */}
        {!showEmptyShelf && heroPath && deadWs && (
          <section className="sh-hero sh-hero--fault sh-hero--dead">
            <div className="sh-hero-main">
              <div className="sh-hero-kicker">
                <span className="dot" />
                上次在案　<b>{heroWsName}</b>
              </div>
              <h2 className="sh-hero-title sh-hero-title--fault">目录已丢失</h2>
              <div className="sh-hero-meta">
                登记的目录不在了——案卷仍保留在清单里。恢复目录后再打开，或在下面移除该工作区。
              </div>
              <div className="sh-hero-acts">
                <button type="button" className="sh-retry" onClick={retryHero}>
                  重试
                </button>
                <button
                  type="button"
                  className="sh-link"
                  onClick={() => {
                    setRemoveTarget(deadWs);
                    setRemoveAck(false);
                  }}
                >
                  移除工作区
                </button>
              </div>
            </div>
          </section>
        )}

        {!showEmptyShelf && heroPath && !deadWs && volState === 'loading' && (
          <section className="sh-hero sh-hero--skeleton" aria-hidden="true">
            <div className="sh-hero-main">
              <span className="sh-skel-line sh-skel-line--kicker" />
              <span className="sh-skel-line sh-skel-line--title" />
              <span className="sh-skel-line sh-skel-line--meta" />
            </div>
          </section>
        )}

        {!showEmptyShelf && heroPath && !deadWs && volState === 'error' && (
          <section className="sh-hero sh-hero--fault">
            <div className="sh-hero-main">
              <div className="sh-hero-kicker">
                <span className="dot" />
                上卷暂不可读
              </div>
              <h2 className="sh-hero-title sh-hero-title--fault">读不到案卷目录</h2>
              <div className="sh-hero-meta">
                {`「${heroWsName}」的案卷目录这次没读出来——可能被移动、删除，或暂时没有访问权限。登记簿与切区不受影响。`}
              </div>
              <div className="sh-hero-acts">
                <button type="button" className="sh-retry" onClick={retryHero}>
                  重试
                </button>
              </div>
            </div>
          </section>
        )}

        {!showEmptyShelf && heroPath && !deadWs && volState === 'ready' && lastVolume && (
          <section className="sh-hero">
            <div className="sh-hero-main">
              <div className="sh-hero-kicker">
                <span className="dot" />
                上次在案　<b>{`${heroWsName} · ${heroWsCount} 卷`}</b>
              </div>
              <h2 className="sh-hero-title" title={volumeDisplayName(lastVolume.label, lastVolume.id)}>
                {volumeDisplayName(lastVolume.label, lastVolume.id)}
              </h2>
              <div className="sh-hero-meta">
                {`末次 ${formatSessionDate(lastVolume.savedAt)} · 第 ${lastVolume.msgCount} 块`}
              </div>
              <div className="sh-hero-acts">
                <button type="button" className="sh-btn-primary" onClick={() => onOpenVolume(lastVolume.id)}>
                  继续 ↓
                </button>
                <button type="button" className="sh-link" onClick={onNewVolume}>
                  另起一卷
                </button>
              </div>
            </div>
            <aside className="sh-hero-side">
              <div className="sh-side-cap">本工作区其他卷</div>
              {siblings.length > 0 ? (
                siblings.map((v) => (
                  <button type="button" key={v.id} className="sh-sib" onClick={() => onOpenVolume(v.id)}>
                    <span className="sh-sib-date">{formatSessionDate(v.savedAt)}</span>
                    <span className="sh-sib-title">{volumeDisplayName(v.label, v.id)}</span>
                  </button>
                ))
              ) : (
                <div className="sh-side-none">暂无其他卷</div>
              )}
            </aside>
          </section>
        )}

        {!showEmptyShelf && heroPath && !deadWs && volState === 'ready' && !lastVolume && (
          <section className="sh-hero sh-hero--blank">
            <div className="sh-hero-main">
              <div className="sh-hero-kicker">
                <span className="dot" />
                上次在案　<b>{`${heroWsName} · ${heroWsCount} 卷`}</b>
              </div>
              <h2 className="sh-hero-title">这张纸还空着</h2>
              <div className="sh-hero-meta">该工作区还没有卷。起一卷，从第一句开始。</div>
              <div className="sh-hero-acts">
                <button type="button" className="sh-btn-primary" onClick={onNewVolume}>
                  另起一卷
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ── 登记簿：工作区目录（管理面不降级） ── */}
        {showEmptyShelf ? (
          <div className="sh-empty">
            <div className="sh-empty-big">库房还空着。</div>
            <div className="sh-empty-sub">
              还没有工作区。建一个新目录，或指定磁盘上已有的文件夹。
              <br />
              默认落在「文档 / 兰台」下；案卷与画布状态都随工作区走。
            </div>
            <div className="sh-empty-acts">
              <button type="button" className="sh-btn-primary" onClick={onOpenCreateSheet}>
                ＋ 新建目录
              </button>
              <button type="button" className="sh-btn-ghost" onClick={() => void onPickCommit()}>
                指定已有目录
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="sh-section">
              <span className="t">工作区</span>
              <span className="n">{`WORKSPACES · ${pad2(workspaces.length)}`}</span>
              <span className="sp" />
              <button type="button" className="sh-link" onClick={() => void onPickCommit()}>
                指定已有目录
              </button>
              <button type="button" className="sh-link" onClick={onOpenCreateSheet}>
                ＋ 新建工作区
              </button>
            </div>

            {listState === 'loading' ? (
              <div className="sh-rows">
                {[0, 1, 2].map((i) => (
                  <div className="sh-skel" key={i} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                ))}
              </div>
            ) : listState === 'error' ? (
              <p className="sh-notice sh-notice--error">
                工作区清单读取失败。
                <button type="button" className="sh-retry" onClick={() => void refreshWorkspaces()}>
                  重试
                </button>
              </p>
            ) : (
              <>
                <div className="sh-cols" aria-hidden="true">
                  <span>档号</span>
                  <span>工作区</span>
                  <span className="r">案卷</span>
                  <span>最近</span>
                  <span className="p">路径</span>
                  <span />
                </div>
                <div className="sh-rows">
                  {workspaces.map((w, i) => {
                    const isRenaming = renamingPath === w.path;
                    const isDead = w.dir_exists === false;
                    const isHere = projectPath ? isSamePath(w.path, projectPath) : false;
                    const no = String(i + 1).padStart(2, '0');
                    const name = wsDisplayName(w);
                    const cells = (
                      <>
                        <span className="sh-no">
                          {w.pinned ? <span className="sh-pin">固</span> : <span className="sh-pin-pad" />}
                          {no}
                        </span>
                        <span className="sh-name">
                          {isRenaming ? (
                            <input
                              ref={renameInputRef}
                              className="sh-rename-input"
                              value={renameDraft}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void onRenameCommit(w.path);
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setRenamingPath(null);
                                }
                                e.stopPropagation();
                              }}
                              onBlur={() => void onRenameCommit(w.path)}
                            />
                          ) : (
                            <>
                              <span className="sh-name-text">{name}</span>
                              {isHere && <span className="sh-here">在案</span>}
                            </>
                          )}
                        </span>
                        <span className={`sh-num${w.session_count === 0 ? ' zero' : ''}`}>
                          {w.session_count > 0 ? w.session_count : '—'}
                        </span>
                        <span className="sh-date">
                          {w.session_count > 0 ? formatSessionDate(w.latest_saved_at) : '——'}
                        </span>
                        {isDead ? (
                          <span className="sh-dead">目录已丢失 · 无法访问案卷</span>
                        ) : (
                          <span className="sh-path" data-tip={w.path}>
                            {shortPath(w.path)}
                          </span>
                        )}
                        <span className="sh-go">{isDead ? '' : '→'}</span>
                      </>
                    );
                    return (
                      <div key={w.path} className={`sh-row${isDead ? ' sh-row--dead' : ''}`}>
                        {isRenaming ? (
                          <div className="sh-row-main">{cells}</div>
                        ) : isDead ? (
                          <div className="sh-row-main sh-row-main--dead">{cells}</div>
                        ) : (
                          <button
                            type="button"
                            className="sh-row-main"
                            onClick={() => onEnterWorkspace(w.path)}
                            aria-label={`进入工作区：${name}（${w.session_count} 卷）`}
                          >
                            {cells}
                          </button>
                        )}
                        {!isRenaming && (
                          <div className="sh-ops">
                            <button
                              type="button"
                              data-tip="重命名"
                              onClick={() => {
                                setRenamingPath(w.path);
                                setRenameDraft(w.name ?? '');
                              }}
                            >
                              改名
                            </button>
                            <button
                              type="button"
                              data-tip={w.pinned ? '取消固定' : '固定（置顶）'}
                              disabled={busy}
                              onClick={() => void onTogglePin(w)}
                            >
                              {w.pinned ? '解固' : '固定'}
                            </button>
                            <button
                              type="button"
                              data-tip="移除工作区（连带删除其中的全部案卷）"
                              disabled={busy}
                              onClick={() => {
                                setRemoveTarget(w);
                                setRemoveAck(false);
                              }}
                            >
                              移除
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        {notice && <p className="sh-notice">{notice}</p>}
        {/* 卡死逃生口（2026-09-09 事故立法）：仅 STUCK_SWITCH_MS 超时后亮——
            强制重置走 stuckRecover（全套回收 + 状态机复位），重进即全新 switch */}
        {forceReset && (
          <p className="sh-notice">
            引擎或后端可能无响应。
            <button type="button" className="sh-retry" onClick={onForceReset}>
              强制重置
            </button>
          </p>
        )}
      </main>

      {/* 底部印版：本机读数 + colophon */}
      <footer className="sh-foot">
        <div className="sh-foot-in">
          <div className="sh-stats">
            <div className="sh-stat">
              <div className="lab">工作区</div>
              <div className="val">{pad2(workspaces.length)}</div>
            </div>
            <div className="sh-stat">
              <div className="lab">在案卷宗</div>
              <div className="val">
                {pad2(totalVolumes)}
                {totalVolumes > 0 && <small>卷</small>}
              </div>
            </div>
            <div className="sh-stat">
              <div className="lab">末次活动</div>
              <div className="val">{latestActivity ? formatSessionDate(latestActivity) : '——'}</div>
            </div>
          </div>
          <div className="sh-colophon">
            兰 台 · 本 机 档 案
            <br />
            <b>{workspaces.length > 0 ? '案卷与画布状态只存本机' : '尚未建立任何工作区'}</b>
          </div>
        </div>
      </footer>

      {/* 新建工作区 sheet（2026-08-31 拍板：一个按钮，指定或创建） */}
      {sheetOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 模态遮罩点击空白 = 取消
        <div
          className="sh-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSheetOpen(false);
          }}
        >
          <div className="sh-modal" role="dialog" aria-modal="true" aria-label="新建工作区">
            {sheetStage === 'choose' ? (
              <>
                <div className="sh-modal-title">新建工作区</div>
                <div className="sh-modal-body sh-sheet-choose">
                  <button type="button" className="sh-sheet-opt" onClick={() => setSheetStage('create')}>
                    <span className="sh-sheet-opt-t">创建新目录</span>
                    <span className="sh-sheet-opt-d">在「文档 / 兰台」下按名字建一个新文件夹</span>
                  </button>
                  <button type="button" className="sh-sheet-opt" onClick={() => void onPickCommit()}>
                    <span className="sh-sheet-opt-t">指定已有目录</span>
                    <span className="sh-sheet-opt-d">选择磁盘上已有的文件夹作为工作区</span>
                  </button>
                </div>
                <div className="sh-modal-foot">
                  <button type="button" onClick={() => setSheetOpen(false)}>
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="sh-modal-title">创建新目录</div>
                <div className="sh-modal-body">
                  <input
                    ref={createNameInputRef}
                    className="sh-modal-input"
                    value={newWsName}
                    placeholder="工作区名字…"
                    onChange={(e) => setNewWsName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void onCreateCommit();
                      }
                    }}
                  />
                </div>
                <div className="sh-modal-foot">
                  <button type="button" onClick={() => setSheetStage('choose')}>
                    返回
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !newWsName.trim()}
                    onClick={() => void onCreateCommit()}
                  >
                    创建并进入
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 移除工作区模态（2026-08-31 拍板：不做退路、确认做足） */}
      {removeTarget && (
        // biome-ignore lint/a11y/noStaticElementInteractions: 模态遮罩点击空白 = 取消
        <div
          className="sh-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setRemoveTarget(null);
              setRemoveAck(false);
            }
          }}
        >
          <div className="sh-modal" role="dialog" aria-modal="true" aria-label="移除工作区">
            <div className="sh-modal-title">移除工作区「{wsDisplayName(removeTarget)}」</div>
            <div className="sh-modal-body">
              <p className="sh-modal-text">
                将删除该工作区的全部案卷（
                {removeTarget.session_count > 0 ? `${removeTarget.session_count} 卷` : '当前没有案卷'}
                ）并从清单移除——此操作不可恢复。
              </p>
              <label className="sh-modal-check">
                <input type="checkbox" checked={removeAck} onChange={(e) => setRemoveAck(e.target.checked)} />
                我了解{removeTarget.session_count > 0 ? ` ${removeTarget.session_count} 卷案卷` : '该工作区'}
                将被永久删除且不可恢复
              </label>
            </div>
            <div className="sh-modal-foot">
              <button
                type="button"
                onClick={() => {
                  setRemoveTarget(null);
                  setRemoveAck(false);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="danger"
                disabled={!removeAck || busy}
                onClick={() => void onRemoveConfirmed(removeTarget)}
              >
                彻底删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

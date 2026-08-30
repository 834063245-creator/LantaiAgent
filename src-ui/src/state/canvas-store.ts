// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state/canvas-store — 工作区画布状态（Stage-5 收尾：布局持久化 + 公共物工作区级）。
//
// 定案（docs/plans/canvas-space/canvas-space-model-notes.md §5 拍板 11/12/13 +
// stage-5.md §3/§4）：
//   - **摊开集合**：会话在画布上摊开 = 永远展开（重启恢复）。spread 存
//     会话 id → 流区位置（有记录 = 摊开）；收起 = 移除（流区退场不重排）。
//   - **公共物 = 不绑死会话的一切**（钉住块/纸条/布局位置）：属纸不属卷，
//     会话退场（收起/删除）不连坐，钉到拔为止。pins/strips 是工作区级容器。
//   - **宿主模型落地**：公共物是独立宿主。钉住块 = 活引用（source，源会话
//     摊开时渲染活块）+ 内容快照（snapshot，源会话退场后仍可显示）。
//   - **持久化**：StoredWorkspaceCanvas ↔ {workspace}/.lantai/canvas.json
//     （工作区级数据文件，随工作区走；消息流仍外置在会话文件）。
//
// 状态权威：本 store 是画布布局 + 公共物的唯一真相（per-panelId 注册表，
// 与旧 paper-store 同族）。活跃会话单一权威仍是 sess store activeIdx，
// 本 store 的 activeSessionId 是画布状态文件里的持久化镜像（重启恢复用）。

import { create } from 'zustand';
import type { BlockAssetMeta, BlockKind, SourcedBlock } from '../paper/block-model';
import { createBlock } from '../paper/block-model';
import type { PaperStrip } from '../paper/selection';
import type { StreamRegionState } from '../paper/space';
import { typedRpc } from '../rpc-contract';
import { getWorkspaceEpoch, isCurrentEpoch } from '../workspace-scope';
import { useBgAlertStore } from './bg-alert-store';
import { createScopedStore } from './scoped-store';

// ── 类型 ──

/** 钉住块的内容快照（源会话退场后仍可显示——公共物不连坐，钉到拔为止）。
 *  kind/text/lang 覆盖文本类块；payload 承载结构化块（plan/tool/code…）的
 *  展示字段。资产块额外保存 asset（身份/表现/载荷），供 update 广播刷新孤儿钉。
 *  渲染层重建块时：有源用活块，无源用快照。 */
export interface PinSnapshot {
  kind: BlockKind;
  text?: string;
  lang?: string;
  payload?: Record<string, unknown>;
  /** 资产块快照（仅 type:block 映射出的块有）——载荷随快照保存，坐标/钉住不属快照。 */
  asset?: BlockAssetMeta & { payload: unknown };
}

/** 工作区级钉住块（独立宿主）。 */
export interface WorkspacePin {
  x: number;
  y: number;
  w: number;
  /** 活引用源（源会话摊开时优先渲染活块）；无源 = 纯公共物快照 */
  source?: { sessionId: number; blockId: string };
  snapshot: PinSnapshot;
}

/** 工作区画布状态文件的磁盘形状。 */
export interface StoredWorkspaceCanvas {
  version: 1;
  /** 摊开集合：摊在画布上的会话 + 各自流区位置（有记录 = 摊开） */
  spread: Array<{
    sessionId: number;
    anchorX: number;
    anchorY: number;
    width: number;
  }>;
  /** 活跃会话（重启恢复创作坞指向；可空） */
  activeSessionId?: number | null;
  /** 公共物（工作区级宿主：钉住块 + 纸条） */
  publics: {
    pinned: Record<string, WorkspacePin>;
    strips: PaperStrip[];
  };
}

export interface CanvasStore {
  /** 摊开集合：key = String(sessionId)，值 = 流区位置（有记录 = 摊开） */
  spread: Record<string, StreamRegionState>;
  /** 公共物 · 钉住块：key = 块 id（pinId 与 blockId 同空间） */
  pins: Record<string, WorkspacePin>;
  /** 公共物 · 纸条（拷贝语义快照，天然独立宿主） */
  strips: PaperStrip[];
  /** 活跃会话（画布状态文件的持久化镜像；渲染权威 = sess activeIdx） */
  activeSessionId: string | null;
  /** 已删除的源会话 id 集（2026-08-28 会话管理专项）：源卷被删后其孤儿钉的
   *  「收回」语义失效——按钮应显示「删除」。deleteSessionFile 标记 + 恢复时
   *  从「钉源不在有效卷集」播种；切换工作区随 loadCanvas/clearCanvas 清空。 */
  deletedSessionIds: Set<number>;

  // ── 读面（非响应式 getter——组件外/测试消费，读的是最新 state）──
  getRegion: (sessionId: string) => StreamRegionState | undefined;
  getPin: (blockId: string) => WorkspacePin | undefined;
  getPins: () => Record<string, WorkspacePin>;
  getStrips: () => PaperStrip[];

  // ── 摊开集合（流区位置）──
  setRegion: (sessionId: string, region: StreamRegionState) => void;
  moveRegion: (sessionId: string, x: number, y: number) => void;
  ensureRegion: (sessionId: string, region: StreamRegionState) => void;
  /** 收起/退场：流区从纸面移除（位置释放，不重排） */
  removeRegion: (sessionId: string) => void;

  // ── 公共物 · 钉住块 ──
  setPin: (blockId: string, pin: WorkspacePin) => void;
  movePin: (blockId: string, x: number, y: number) => void;
  /** 宽度手调（P2b）：pin.w 是钉住几何唯一真相（渲染宽经 pinsMap 进 translate） */
  resizePin: (blockId: string, w: number) => void;
  unpin: (blockId: string) => void;
  replacePins: (pins: Record<string, WorkspacePin>) => void;

  // ── 公共物 · 纸条 ──
  addStrip: (strip: PaperStrip) => void;
  moveStrip: (stripId: string, x: number, y: number) => void;
  /** 宽度手调（P2b）：纸条右缘拖拽改宽 */
  resizeStrip: (stripId: string, w: number) => void;
  removeStrip: (stripId: string) => void;
  replaceStrips: (strips: PaperStrip[]) => void;

  // ── 活跃会话镜像 ──
  setActiveRegion: (sessionId: string | null) => void;

  // ── 已删除源会话标记 ──
  markSessionDeleted: (sessionId: number) => void;
  replaceDeletedSessionIds: (ids: Set<number>) => void;

  // ── 整表 ──
  loadCanvas: (canvas: StoredWorkspaceCanvas | null) => void;
  clearCanvas: () => void;
}

// ── 创建 store 实现 ──

function createCanvasStoreImpl() {
  return create<CanvasStore>((set, get) => ({
    spread: {},
    pins: {},
    strips: [],
    activeSessionId: null,
    deletedSessionIds: new Set(),

    getRegion: (sessionId) => get().spread[sessionId],
    getPin: (blockId) => get().pins[blockId],
    getPins: () => get().pins,
    getStrips: () => get().strips,

    setRegion: (sessionId, region) =>
      set((s) => {
        const cur = s.spread[sessionId];
        if (cur && cur.anchorX === region.anchorX && cur.anchorY === region.anchorY) return s;
        return { spread: { ...s.spread, [sessionId]: region } };
      }),

    moveRegion: (sessionId, x, y) =>
      set((s) => {
        const cur = s.spread[sessionId];
        if (!cur) return s;
        if (cur.anchorX === x && cur.anchorY === y) return s;
        return { spread: { ...s.spread, [sessionId]: { ...cur, anchorX: x, anchorY: y } } };
      }),

    ensureRegion: (sessionId, region) =>
      set((s) => {
        if (s.spread[sessionId]) return s;
        return { spread: { ...s.spread, [sessionId]: region } };
      }),

    removeRegion: (sessionId) =>
      set((s) => {
        if (!s.spread[sessionId]) return s;
        const { [sessionId]: _, ...rest } = s.spread;
        return { spread: rest };
      }),

    setPin: (blockId, pin) => set((s) => ({ pins: { ...s.pins, [blockId]: pin } })),

    movePin: (blockId, x, y) =>
      set((s) => {
        const cur = s.pins[blockId];
        if (!cur) return s;
        if (cur.x === x && cur.y === y) return s;
        return { pins: { ...s.pins, [blockId]: { ...cur, x, y } } };
      }),

    resizePin: (blockId, w) =>
      set((s) => {
        const cur = s.pins[blockId];
        if (!cur || cur.w === w) return s;
        return { pins: { ...s.pins, [blockId]: { ...cur, w } } };
      }),

    unpin: (blockId) =>
      set((s) => {
        if (!s.pins[blockId]) return s;
        const { [blockId]: _, ...rest } = s.pins;
        return { pins: rest };
      }),

    replacePins: (pins) => set({ pins }),

    addStrip: (strip) => set((s) => ({ strips: [...s.strips, strip] })),
    moveStrip: (stripId, x, y) =>
      set((s) => ({
        strips: s.strips.map((st) => (st.id === stripId ? { ...st, x, y } : st)),
      })),
    resizeStrip: (stripId, w) =>
      set((s) => {
        const cur = s.strips.find((st) => st.id === stripId);
        if (!cur || cur.w === w) return s;
        return { strips: s.strips.map((st) => (st.id === stripId ? { ...st, w } : st)) };
      }),
    removeStrip: (stripId) => set((s) => ({ strips: s.strips.filter((st) => st.id !== stripId) })),
    replaceStrips: (strips) => set({ strips }),

    setActiveRegion: (sessionId) => set((s) => (s.activeSessionId === sessionId ? s : { activeSessionId: sessionId })),

    markSessionDeleted: (sessionId) =>
      set((s) => {
        if (s.deletedSessionIds.has(sessionId)) return s;
        const n = new Set(s.deletedSessionIds);
        n.add(sessionId);
        return { deletedSessionIds: n };
      }),

    replaceDeletedSessionIds: (ids) => set(() => ({ deletedSessionIds: new Set(ids) })),

    loadCanvas: (canvas) =>
      set(() => {
        if (!canvas) return { spread: {}, pins: {}, strips: [], activeSessionId: null, deletedSessionIds: new Set() };
        const spread: Record<string, StreamRegionState> = {};
        for (const r of canvas.spread ?? []) {
          spread[String(r.sessionId)] = { anchorX: r.anchorX, anchorY: r.anchorY, width: r.width };
        }
        return {
          spread,
          pins: canvas.publics?.pinned ?? {},
          strips: canvas.publics?.strips ?? [],
          activeSessionId: canvas.activeSessionId != null ? String(canvas.activeSessionId) : null,
          // 工作区切换/重载：已删标记是会话内生命周期状态，随画布整表重置
          deletedSessionIds: new Set(),
        };
      }),

    clearCanvas: () => set({ spread: {}, pins: {}, strips: [], activeSessionId: null, deletedSessionIds: new Set() }),
  }));
}

// ── 注册表 ──

const scoped = createScopedStore('__lantai_canvas_stores__', createCanvasStoreImpl);

export const getCanvasStore = scoped.getStore;

/** 测试复位。 */
export function resetCanvasStoresForTests(): void {
  const key = '__lantai_canvas_stores__';
  const w = window as unknown as Record<string, unknown>;
  const stores = w[key] as Map<string, { setState: (s: Partial<CanvasStore>) => void }> | undefined;
  if (stores) {
    for (const store of stores.values()) {
      store.setState({ spread: {}, pins: {}, strips: [], activeSessionId: null, deletedSessionIds: new Set() });
    }
  }
}

// ── 持久化 ──

/** 工作区路径归一（与 chat-session normWs 同规：反斜杠→正斜杠、去尾斜杠）。 */
function normWs(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 工作区画布状态文件路径（空工作区 = ''，不持久化——零目录不进画布）。 */
export function canvasFilePath(workspace: string): string {
  const norm = normWs(workspace);
  if (!norm) return '';
  return `${norm}/.lantai/canvas.json`;
}

/** 从当前 store 状态快照磁盘形状。 */
export function snapshotCanvas(storeId: string): StoredWorkspaceCanvas {
  const st = getCanvasStore(storeId).getState();
  const spread = Object.entries(st.spread).map(([sid, r]) => ({
    sessionId: Number(sid),
    anchorX: r.anchorX,
    anchorY: r.anchorY,
    width: r.width,
  }));
  return {
    version: 1,
    spread,
    activeSessionId: st.activeSessionId != null ? Number(st.activeSessionId) : null,
    publics: { pinned: st.pins, strips: st.strips },
  };
}

/** 读工作区画布状态（容忍缺失/毒化：缺失/坏 JSON = 空画布，不炸）。 */
export async function loadCanvasFromDisk(storeId: string, workspace: string): Promise<void> {
  const path = canvasFilePath(workspace);
  if (!path) {
    getCanvasStore(storeId).getState().loadCanvas(null);
    return;
  }
  try {
    const raw = await typedRpc('read_file_content', { file_path: path });
    // read_file_content 返回带行号文本——剥行号后解析
    const text = raw
      .split('\n')
      .map((l) => l.replace(/^\s*\d+\t/, ''))
      .join('\n');
    const parsed = JSON.parse(text) as StoredWorkspaceCanvas;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      getCanvasStore(storeId).getState().loadCanvas(null);
      return;
    }
    getCanvasStore(storeId).getState().loadCanvas(parsed);
  } catch {
    // 缺失（首启常态）/毒化（INVARIANTS #11.2：读取容忍，不把坏文件变每次启动必崩）
    getCanvasStore(storeId).getState().loadCanvas(null);
  }
}

/** 写工作区画布状态到盘（原子写，经 write_file_content）。失败必须可见（warn）。 */
export async function saveCanvasToDisk(storeId: string, workspace: string): Promise<boolean> {
  const path = canvasFilePath(workspace);
  if (!path) return false;
  const payload = snapshotCanvas(storeId);
  try {
    await typedRpc('write_file_content', { file_path: path, content: JSON.stringify(payload) });
    // D5（拍板 C）：成功解除警报——下次失败重新弹
    useBgAlertStore.getState().clearBgAlert('canvas-save');
    return true;
  } catch (e) {
    // 尽力而为但不静默：失败态接 StatusLine 警告档 + 一次性提示条（自动重试不变）
    console.error('[canvas] 工作区画布状态落盘失败:', e);
    useBgAlertStore.getState().pushBgAlert('canvas-save', '画布状态落盘失败——未保存改动稍后自动重试');
    return false;
  }
}

/** 防抖保存（与 scheduleAutoSave 同规：500ms 窗口合并密集写入）。
 *  代际防护（INVARIANTS #12，2026-08-28 会话管理专项）：定时器触发时若已
 *  切走工作区则丢弃——否则用「已被新工作区覆盖的画布 store」快照写进旧工作区
 *  canvas.json（跨工作区污染；切走时 deactivate 已显式 flushCanvasSave，此
 *  处丢弃不丢数据）。 */
const _canvasSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const CANVAS_SAVE_DELAY_MS = 500;

export function scheduleCanvasSave(storeId: string, workspace: string): void {
  const key = `${storeId}:${workspace}`;
  const existing = _canvasSaveTimers.get(key);
  if (existing) clearTimeout(existing);
  const epoch = getWorkspaceEpoch();
  const timer = setTimeout(() => {
    _canvasSaveTimers.delete(key);
    if (!isCurrentEpoch(epoch)) return; // 切走工作区：丢弃（deactivate 已 flush）
    void saveCanvasToDisk(storeId, workspace);
  }, CANVAS_SAVE_DELAY_MS);
  _canvasSaveTimers.set(key, timer);
}

/** 立即落盘（取消在途防抖——切换工作区/关闭窗口的显式保存点）。 */
export function flushCanvasSave(storeId: string, workspace: string): void {
  const key = `${storeId}:${workspace}`;
  const t = _canvasSaveTimers.get(key);
  if (t) {
    clearTimeout(t);
    _canvasSaveTimers.delete(key);
  }
  void saveCanvasToDisk(storeId, workspace);
}

/** 测试复位（生产不调用）。 */
export function _resetCanvasSaveTimersForTests(): void {
  for (const t of _canvasSaveTimers.values()) clearTimeout(t);
  _canvasSaveTimers.clear();
}

/** 只读便捷读面：当前工作区钉住块的 blockId 集合（转译层 ghosting 用）。 */
export function pinnedBlockIds(storeId: string): Set<string> {
  return new Set(Object.keys(getCanvasStore(storeId).getState().pins));
}

/** 只读便捷读面：某会话的钉住块（源归属该会话）。 */
export function pinsForSession(storeId: string, sessionId: string): Array<[string, WorkspacePin]> {
  const st = getCanvasStore(storeId).getState();
  const sid = Number(sessionId);
  return Object.entries(st.pins).filter(([, pin]) => pin.source?.sessionId === sid);
}

/** 只读便捷读面：某会话的流区位置（缺失 = undefined，调用方按默认落位处理）。 */
export function regionFor(storeId: string, sessionId: string): StreamRegionState | undefined {
  return getCanvasStore(storeId).getState().spread[sessionId];
}

// ── 钉住块快照 ↔ 块 互转（公共物渲染：有源用活块，无源用快照）──

/** 块 → 钉住快照（钉住时刻捕获，源会话退场后仍可显示）。
 *  _callback 等函数字段不可序列化，随 JSON.stringify 自然丢弃。 */
export function snapshotFromBlock(block: SourcedBlock): PinSnapshot {
  // 资产块：保留完整 asset 元数据 + 原始 payload（可能是 string/json），
  // 不走 text/lang 抽取——更新广播需要按 assetId 找到并整体替换。
  if (block.asset) {
    return {
      kind: block.kind,
      asset: { ...block.asset, payload: block.payload },
    };
  }
  const p = (block.payload ?? {}) as Record<string, unknown>;
  const { text, lang, ...rest } = p;
  const snapshot: PinSnapshot = { kind: block.kind };
  if (typeof text === 'string') snapshot.text = text;
  if (typeof lang === 'string') snapshot.lang = lang;
  if (Object.keys(rest).length > 0) snapshot.payload = rest;
  return snapshot;
}

/** 快照 → 渲染块（公共物独立宿主：源会话未摊开/已删除时渲染它）。 */
export function blockFromSnapshot(blockId: string, pin: WorkspacePin): SourcedBlock {
  const { text, lang, payload, asset } = pin.snapshot;
  const base: Record<string, unknown> = { ...payload };
  if (text !== undefined) base.text = text;
  if (lang !== undefined) base.lang = lang;
  const sourcePayload: unknown = asset ? asset.payload : base;
  return {
    ...createBlock(
      pin.snapshot.kind,
      sourcePayload as never,
      { messageId: '', part: null },
      asset
        ? {
            asset: {
              assetId: asset.assetId,
              presentation: asset.presentation,
              ...(asset.title !== undefined ? { title: asset.title } : {}),
              finalised: asset.finalised,
            },
          }
        : undefined,
    ),
    id: blockId,
    state: 'pinned',
    x: pin.x,
    y: pin.y,
    w: pin.w,
  };
}

/** 资产更新广播（WO-5/A7）：按 assetId 刷新钉住块的快照——包括源已压缩/未摊开/
 *  已删除的 orphan 钉。只换 snapshot.payload/presentation/title/finalised，
 *  不碰坐标、钉住状态、source 与 kind（update 不换 kind 铁律）。 */
export function refreshPinnedAssetSnapshots(
  storeId: string,
  asset: { assetId: string; presentation?: string; title?: string; payload: unknown },
): void {
  const st = getCanvasStore(storeId).getState();
  const nextPins: Record<string, WorkspacePin> = {};
  let changed = false;
  for (const [id, pin] of Object.entries(st.pins)) {
    const snap = pin.snapshot;
    if (snap.asset?.assetId === asset.assetId) {
      nextPins[id] = {
        ...pin,
        snapshot: {
          ...snap,
          asset: {
            ...snap.asset,
            presentation: asset.presentation ?? snap.asset.presentation,
            ...(asset.title !== undefined ? { title: asset.title } : {}),
            finalised: true,
            payload: asset.payload,
          },
        },
      };
      changed = true;
    } else {
      nextPins[id] = pin;
    }
  }
  if (changed) st.replacePins(nextPins);
}

/** 钉住块 → 位置查找表（转译层 ghosting + 渲染层定位共用）。
 *  引用随 canvas.pins 引用稳定——不变化时 translate 缓存命中。 */
export function pinsPositionMap(storeId: string): Record<string, { x: number; y: number }> {
  const pins = getCanvasStore(storeId).getState().pins;
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, pin] of Object.entries(pins)) out[id] = { x: pin.x, y: pin.y };
  return out;
}

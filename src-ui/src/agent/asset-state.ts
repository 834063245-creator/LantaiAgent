// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-state — html 沙箱卡的用户交互状态表（2026-10-07 立项，v1 只服务 kind=html）。
//
// 病灶：html 卡在 `sandbox="allow-scripts"` 的 iframe 里渲染（无 allow-same-origin、
// 文档级 CSP `connect-src 'none'`）——卡里的输入/勾选/拖拽对宿主是黑箱：既读不回，
// 也无法被 Agent 看到。本模块给这类卡配**存档线**：卡内经既有 postMessage 桥写回
// 键值表；表按会话防抖落盘（`.lantai/asset-state/<sessionId>.json`），Agent 侧在
// `list_block_kinds` 的资产清单里读摘要（`listAssetStateSummaryForOwner`）。
//
// 键系（(projectPath, sessionId) × assetId）——刻意**不用** `agent/asset-store` 的
// owner scope（bus id）：bus id 是「本轮装配实例」的 id（重启/重建句柄即换），而状态
// 的真身属于**会话**（落盘文件按会话号命名）。本键系与 TaskBoard / DiscoveryBoard
// 同源（runtime 按 sessionId 建板 + BoardPersistence 按 sessionId 落文件），且写入方
// 是渲染层（iframe 桥知道工作区路径与会话号，拿不到 bus id）。
//
// 语义（v1 定案，施工单 docs/archive/render-paper-line/asset-state-plan.md 的 D1-D7，两处按实况修订：
// ① 键系由 owner scope 改为会话键；② 「删卷清文件」挂真删除路径而非合卷）：
//   - 写入 = 浅合并 patch（输入框只写自己那格），值必须 JSON 可序列化（深校验 + 环检测）；
//   - 单资产上限 64 KiB（合并后序列化字节数；超限整笔拒绝，绝不半写）；
//   - 后写赢（无冲突检测——单写者场景足够）；不做跨会话共享；
//   - 恢复语义：恢复完成前读到 null；**恢复未完成时不落盘**（空表写盘会把磁盘上的
//     旧状态整份覆盖——写前必须先合并），恢复完成后「磁盘打底 + 内存优先」合并
//     （当帧用户输入赢，且磁盘旧值的其它键不丢）。
//
// 纯数据模块（agent 层，零 UI 依赖）；落盘经 BoardPersistence（复用其防抖/串行写链）。

import { BoardPersistence } from './board-persistence';
import { ownerContext, ownerSessionIdOf } from './session-context';

/** 单资产状态上限（合并后 UTF-8 序列化字节数）。超限拒绝——无截断、无半写。 */
export const ASSET_STATE_MAX_BYTES = 64 * 1024;

const DIR_NAME = 'asset-state';

/** 会话定位（渲染层从纸壳拿到的两个字符串；Agent 读口从 owner 解析）。 */
export interface AssetStateKey {
  /** 工作区根（逻辑绝对路径，同 fs 域口径）。 */
  projectPath: string;
  /** 会话号（字符串形，同案卷号——runtime bindSession 的同一把尺子）。 */
  sessionId: string;
}

export type AssetStatePatchResult = { ok: true } | { ok: false; error: string };

/** Agent 读口的一行（派生读数：键数 + 序列化字节数）。 */
export interface AssetStateSummary {
  assetId: string;
  keys: number;
  bytes: number;
}

interface SessionEntry {
  states: Map<string, Record<string, unknown>>;
  persistence: BoardPersistence;
  /** 恢复是否已落定（含失败）。未落定前不落盘（防「空表覆盖磁盘」）。 */
  restoreSettled: boolean;
  /** 恢复期间发生过的写入：落定时补一次 flush（不丢用户输入）。 */
  flushPending: boolean;
  restorePromise: Promise<void>;
}

const sessions = new Map<string, SessionEntry>();

function sessionKeyOf(key: AssetStateKey): string {
  return `${key.projectPath}#${key.sessionId}`;
}

function usableKey(key: AssetStateKey | null | undefined): key is AssetStateKey {
  return (
    !!key &&
    typeof key.projectPath === 'string' &&
    key.projectPath.length > 0 &&
    typeof key.sessionId === 'string' &&
    key.sessionId.length > 0
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function jsonBytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** JSON 值深校验（递归 + 环检测）：不做「宽容转换」——undefined/函数/Symbol/
 *  BigInt/非有限数/类实例一律拒绝并带路径说明（错误即导航，卡作者能定位）。 */
function findJsonViolation(v: unknown, path: string, seen: Set<object>): string | null {
  if (v === null) return null;
  switch (typeof v) {
    case 'boolean':
    case 'string':
      return null;
    case 'number':
      return Number.isFinite(v) ? null : `${path}：数值必须是有限数（收到 NaN/Infinity）`;
    case 'undefined':
      return `${path}：不能含 undefined（JSON 里没有这个值——请用 null 或删键）`;
    case 'function':
      return `${path}：不能含函数`;
    case 'symbol':
      return `${path}：不能含 Symbol`;
    case 'bigint':
      return `${path}：不能含 BigInt`;
    case 'object': {
      const obj = v as object;
      if (seen.has(obj)) return `${path}：循环引用`;
      seen.add(obj);
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          const err = findJsonViolation(obj[i], `${path}[${i}]`, seen);
          if (err) return err;
        }
        seen.delete(obj);
        return null;
      }
      if (!isPlainObject(obj)) return `${path}：只能是纯对象/数组/基本值（收到类实例）`;
      for (const [k, val] of Object.entries(obj)) {
        const err = findJsonViolation(val, `${path}.${k}`, seen);
        if (err) return err;
      }
      seen.delete(obj);
      return null;
    }
    default:
      return `${path}：不支持的值的类型`;
  }
}

function serializeEntry(entry: SessionEntry): string {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [assetId, state] of entry.states) out[assetId] = state;
  return JSON.stringify(out, null, 2);
}

/** 防抖落盘；恢复未完成时挂起（补写时机见 restoreEntry 的 finally）。 */
function scheduleFlush(entry: SessionEntry): void {
  if (!entry.restoreSettled) {
    entry.flushPending = true;
    return;
  }
  entry.persistence.scheduleFlush(() => serializeEntry(entry));
}

/** 会话首次接触：建表 + 启动异步恢复（幂等）。 */
function ensureSession(key: AssetStateKey): SessionEntry {
  const k = sessionKeyOf(key);
  const existing = sessions.get(k);
  if (existing) return existing;
  const entry: SessionEntry = {
    states: new Map(),
    persistence: new BoardPersistence({ projectPath: key.projectPath, sessionId: key.sessionId, dirName: DIR_NAME }),
    restoreSettled: false,
    flushPending: false,
    restorePromise: Promise.resolve(),
  };
  sessions.set(k, entry);
  entry.restorePromise = restoreEntry(entry);
  return entry;
}

/** 读盘恢复：磁盘打底 + 内存优先（逐键合并——恢复期间用户已写的键不被旧值覆盖，
 *  磁盘旧值的其它键也不丢）。坏文件/读失败 = 无数据可恢复（保持内存现状，不炸）。 */
async function restoreEntry(entry: SessionEntry): Promise<void> {
  try {
    const raw = await entry.persistence.restore();
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isPlainObject(parsed)) {
        for (const [assetId, state] of Object.entries(parsed)) {
          if (!isPlainObject(state)) continue;
          const mine = entry.states.get(assetId);
          entry.states.set(assetId, mine ? { ...state, ...mine } : state);
        }
      }
    }
  } catch {
    /* 读失败/坏 JSON：无数据可恢复 */
  } finally {
    entry.restoreSettled = true;
    if (entry.flushPending && !entry.persistence.destroyed) {
      entry.flushPending = false;
      void entry.persistence.flush(serializeEntry(entry));
    }
  }
}

/** 会话预热（runtime 会话绑定时调用）：提前触发恢复，收窄「首读空窗」。
 *  空定位（零目录工作区）静默跳过——同 usableKey 判定，不建脏表。 */
export function prewarmAssetStateSession(projectPath: string, sessionId: string): void {
  const key = { projectPath, sessionId };
  if (!usableKey(key)) return;
  ensureSession(key);
}

/** 读一处状态（无 = null）。首次接触会为该会话建表并触发异步恢复（恢复完成前读到 null）。 */
export function getAssetState(key: AssetStateKey, assetId: string): Record<string, unknown> | null {
  if (!usableKey(key)) return null;
  const state = ensureSession(key).states.get(assetId);
  return state ? cloneJson(state) : null;
}

/** 浅合并写入（写后序列化超限 = 整笔拒绝，既有状态不动）。 */
export function patchAssetState(
  key: AssetStateKey,
  assetId: string,
  patch: Record<string, unknown>,
): AssetStatePatchResult {
  if (!usableKey(key)) {
    return { ok: false, error: '状态存储不可用：缺少工作区路径或会话号（本卡不在已打开的案卷里）' };
  }
  if (typeof assetId !== 'string' || assetId.length === 0) {
    return { ok: false, error: '状态存储不可用：缺少资产 id' };
  }
  if (!isPlainObject(patch)) {
    return { ok: false, error: 'patch 必须是对象（键值对表）' };
  }
  const violation = findJsonViolation(patch, 'patch', new Set());
  if (violation) return { ok: false, error: `值不可序列化：${violation}` };

  let patchBytes: number;
  try {
    patchBytes = jsonBytes(JSON.stringify(patch));
  } catch {
    return { ok: false, error: '值不可序列化：patch 序列化失败' };
  }
  if (patchBytes > ASSET_STATE_MAX_BYTES) {
    return { ok: false, error: `状态超限：单笔写入 ${patchBytes} 字节，超过上限 ${ASSET_STATE_MAX_BYTES}` };
  }

  const entry = ensureSession(key);
  const current = entry.states.get(assetId) ?? {};
  const next = { ...current, ...patch };
  const bytes = jsonBytes(JSON.stringify(next));
  if (bytes > ASSET_STATE_MAX_BYTES) {
    return {
      ok: false,
      error: `状态超限：合并后共 ${bytes} 字节（上限 ${ASSET_STATE_MAX_BYTES}）——请清理键或拆分资产`,
    };
  }
  entry.states.set(assetId, next);
  scheduleFlush(entry);
  return { ok: true };
}

/** 清一处状态（资产删除联动；无 = 无操作）。 */
export function clearAssetState(key: AssetStateKey, assetId: string): void {
  if (!usableKey(key)) return;
  const entry = sessions.get(sessionKeyOf(key));
  if (!entry) return;
  if (!entry.states.delete(assetId)) return;
  scheduleFlush(entry);
}

/** 状态摘要清单（Agent 读口内层；表序 = 首见序）。 */
export function listAssetStateSummary(key: AssetStateKey): AssetStateSummary[] {
  if (!usableKey(key)) return [];
  const entry = sessions.get(sessionKeyOf(key));
  if (!entry) return [];
  const out: AssetStateSummary[] = [];
  for (const [assetId, state] of entry.states) {
    out.push({ assetId, keys: Object.keys(state).length, bytes: jsonBytes(JSON.stringify(state)) });
  }
  return out;
}

/** Agent 读口整合面：owner（agent id）→ (工作区根, 会话号) → 摘要。
 *  解析不出来（零目录工作区 / 未绑会话 / 该卷没碰过状态）= 空表——
 *  调用方如实省略读数，不造假设。 */
export function listAssetStateSummaryForOwner(ownerId: string | undefined | null): AssetStateSummary[] {
  const ctx = ownerContext(ownerId);
  const sessionId = ownerSessionIdOf(ownerId);
  if (!ctx || !sessionId) return [];
  return listAssetStateSummary({ projectPath: ctx.workspaceRoot, sessionId });
}

/** 会话消亡（真删除卷）时：清内存表并删落盘文件（尽力而为）。
 *  先排空在途写链再 destroy——否则「删除前已排队的 flush」会在 destroy 后落盘，
 *  把已删卷的文件写回（复活的正是被删的卷）。合卷（从画布收走）**不走这里**：
 *  状态随卷保留，续开时恢复。 */
export async function removeAssetStateSession(projectPath: string, sessionId: string): Promise<void> {
  const k = `${projectPath}#${sessionId}`;
  const entry = sessions.get(k);
  if (!entry) {
    // 内存里没有：直接删文件（best-effort；文件不存在 = 无操作）
    await new BoardPersistence({ projectPath, sessionId, dirName: DIR_NAME }).destroy();
    return;
  }
  sessions.delete(k);
  entry.persistence.clearFlushTimer();
  await entry.persistence.flush(serializeEntry(entry));
  await entry.persistence.destroy();
}

/** 显式落盘（测试/收尾用）：等恢复落定再写——写前合并是「不覆盖磁盘」的前提。 */
export async function flushAssetStateSession(key: AssetStateKey): Promise<void> {
  if (!usableKey(key)) return;
  const entry = sessions.get(sessionKeyOf(key));
  if (!entry) return;
  await entry.restorePromise;
  entry.persistence.clearFlushTimer();
  await entry.persistence.flush(serializeEntry(entry));
}

/** 测试复位（生产不调用）——清内存表（不动磁盘）。 */
export function clearAssetStateForTests(): void {
  for (const entry of sessions.values()) entry.persistence.clearFlushTimer();
  sessions.clear();
}

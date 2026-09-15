// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// state/asset-store — 会话级资产表（协议 docs/archive/agent-asset-blocks.md §2.5/A7，WO-5）。
//
// 语义：assetId → {kind, presentation, payload, ts} 的轻量索引。真源是会话消息
// （BlockPart）与工具结果；本表只是「按 assetId 定位记录」的查找面，可从日志重建，
// 不是第二真相。每个会话一个实例（storeId:sessionId），随消息 store 同生命周期。
//
// 使用：
//   - chat-stream Asset 事件到达时 upsert（运行时增量入口）
//   - rebuildMessagesFromMessages 后 rebuildFromMessages（回放/恢复时从消息重建）
//   - update_asset 广播时经 get 判断“新资产 vs 更新已有资产”

import { create } from 'zustand';
import type { AssetEventData } from '../agent/agent-types';
import type { AssistantPart, BlockPart, ChatMessage } from '../ui/message-model';
import { createScopedStore } from './scoped-store';

export interface SessionAssetRecord {
  assetId: string;
  kind: string;
  presentation: string;
  title?: string;
  payload: unknown;
  ts: number;
}

interface AssetTableState {
  assets: Record<string, SessionAssetRecord>;
  upsert: (asset: AssetEventData) => void;
  get: (assetId: string) => SessionAssetRecord | undefined;
  list: () => SessionAssetRecord[];
  rebuildFromMessages: (msgs: ChatMessage[]) => void;
  clear: () => void;
}

/** 递归收集 BlockPart（含 subagent 内嵌 part）——资产表重建时同构扫描。 */
function collectBlockParts(parts: AssistantPart[], out: BlockPart[] = []): BlockPart[] {
  for (const p of parts) {
    if (p.type === 'block') out.push(p);
    else if (p.type === 'subagent') collectBlockParts(p.parts, out);
  }
  return out;
}

function createAssetTableImpl() {
  return create<AssetTableState>((set, get) => ({
    assets: {},
    upsert: (asset) =>
      set((s) => ({
        assets: {
          ...s.assets,
          [asset.assetId]: {
            assetId: asset.assetId,
            kind: asset.kind,
            presentation: asset.presentation ?? '',
            ...(asset.title !== undefined ? { title: asset.title } : {}),
            payload: asset.payload,
            ts: Date.now(),
          },
        },
      })),
    get: (assetId) => get().assets[assetId],
    list: () => Object.values(get().assets),
    rebuildFromMessages: (msgs) => {
      const assets: Record<string, SessionAssetRecord> = {};
      for (const msg of msgs) {
        if (msg.role !== 'assistant') continue;
        for (const p of collectBlockParts(msg.parts)) {
          assets[p.assetId] = {
            assetId: p.assetId,
            kind: p.kind,
            presentation: p.presentation,
            ...(p.title !== undefined ? { title: p.title } : {}),
            payload: p.payload,
            ts: Date.now(),
          };
        }
      }
      set({ assets });
    },
    clear: () => set({ assets: {} }),
  }));
}

const scoped = createScopedStore('__lantai_asset_tables__', createAssetTableImpl);

export const getAssetTableStore = scoped.getStore;

/** 精确移除一个会话的资产表（合卷/删卷时随消息 store 一起拆）。 */
export function disposeAssetSessionStore(storeId: string, sessionId: number): void {
  scoped.disposeStore(`${storeId}:${sessionId}`);
}

/** 移除所有以 storeId 开头的资产表（面板/工作区重置时整批清理）。 */
export function disposeAssetTables(storeId: string): void {
  scoped.disposeStoresByPrefix(storeId);
}

/** 从消息数组重建资产表（回放/恢复/撤回重建后调用）。 */
export function rebuildAssetTableFromMessages(storeId: string, sessionId: number, msgs: ChatMessage[]): void {
  getAssetTableStore(`${storeId}:${sessionId}`).getState().rebuildFromMessages(msgs);
}

/** 测试复位（生产不调用）。 */
export function resetAssetTablesForTests(): void {
  const w = window as unknown as Record<string, unknown>;
  const stores = w.__lantai_asset_tables__ as Map<string, ReturnType<typeof createAssetTableImpl>> | undefined;
  if (stores) {
    for (const store of stores.values()) store.getState().clear();
  }
}

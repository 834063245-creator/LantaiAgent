// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-store-lifecycle — 资产表/画布快照的边界与生命周期（WO-5 补充）：
//   重建去重、dispose 语义、测试复位、无匹配刷新 no-op。
// 协议：docs/archive/agent-asset-blocks.md §2.5/A7/§3（WO-5）。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  disposeAssetSessionStore,
  disposeAssetTables,
  getAssetTableStore,
  rebuildAssetTableFromMessages,
  resetAssetTablesForTests,
} from '../src/state/asset-store';
import { getCanvasStore, refreshPinnedAssetSnapshots, resetCanvasStoresForTests } from '../src/state/canvas-store';
import type { AssistantMessage, BlockPart, ChatMessage } from '../src/ui/message-model';

const STORE_ID = 'asset-store-lifecycle-test';
const SESSION_A = 1;
const SESSION_B = 2;

function asstMsg(id: string, parts: AssistantMessage['parts']): AssistantMessage {
  return { role: 'assistant', _id: id, parts, status: 'done', respondingTo: 'u1' };
}

function blockPart(assetId: string, payload: unknown): BlockPart {
  return { type: 'block', assetId, kind: 'chart', presentation: 'chart', payload, finalised: true };
}

beforeEach(() => {
  resetAssetTablesForTests();
  resetCanvasStoresForTests();
});

describe('state/asset-store — 生命周期与重建（WO-5 补充）', () => {
  it('rebuildFromMessages 同 assetId 多记录时后到者胜（原位置换语义）', () => {
    const messages: ChatMessage[] = [asstMsg('m1', [blockPart('as_dup', { v: 1 }), blockPart('as_dup', { v: 2 })])];
    rebuildAssetTableFromMessages(STORE_ID, SESSION_A, messages);
    const rec = getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState().get('as_dup');
    expect(rec?.payload).toEqual({ v: 2 });
    expect(getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState().list()).toHaveLength(1);
  });

  it('disposeAssetSessionStore 只拆指定会话，disposeAssetTables 拆整个 storeId', () => {
    const a = getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState();
    const b = getAssetTableStore(`${STORE_ID}:${SESSION_B}`).getState();
    a.upsert({ assetId: 'as_a', kind: 'chart', payload: {} });
    b.upsert({ assetId: 'as_b', kind: 'chart', payload: {} });

    disposeAssetSessionStore(STORE_ID, SESSION_A);
    // dispose 后惰性重建为空表，但 B 不受影响
    expect(getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState().list()).toHaveLength(0);
    expect(getAssetTableStore(`${STORE_ID}:${SESSION_B}`).getState().get('as_b')).toBeDefined();

    disposeAssetTables(STORE_ID);
    expect(getAssetTableStore(`${STORE_ID}:${SESSION_B}`).getState().list()).toHaveLength(0);
  });

  it('resetAssetTablesForTests 清空全部资产表', () => {
    getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState().upsert({ assetId: 'as_1', kind: 'chart', payload: {} });
    getAssetTableStore(`${STORE_ID}:${SESSION_B}`).getState().upsert({ assetId: 'as_2', kind: 'chart', payload: {} });
    resetAssetTablesForTests();
    expect(getAssetTableStore(`${STORE_ID}:${SESSION_A}`).getState().list()).toHaveLength(0);
    expect(getAssetTableStore(`${STORE_ID}:${SESSION_B}`).getState().list()).toHaveLength(0);
  });
});

describe('state/canvas-store — 无匹配刷新 no-op（WO-5 补充）', () => {
  it('refreshPinnedAssetSnapshots 无匹配时不改 pins 对象', () => {
    getCanvasStore(STORE_ID)
      .getState()
      .setPin('pin1', {
        x: 1,
        y: 2,
        w: 720,
        snapshot: { kind: 'markdown', text: 'x' },
      });
    const before = getCanvasStore(STORE_ID).getState().pins;
    refreshPinnedAssetSnapshots(STORE_ID, { assetId: 'missing', payload: {} });
    expect(getCanvasStore(STORE_ID).getState().pins).toBe(before);
  });
});

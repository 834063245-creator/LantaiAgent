// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-store — 会话级资产表（协议 §2.5/A7 的最小版——WO-2 落地于工具校验面；
// WO-5 接持久化/广播/pinned 孤儿刷新，本文件形状不变）。
//
// 语义：assetId → {kind, presentation, payload, ts} 的轻量索引。payload 的真源
// 在会话 JSONL（工具结果 details），本表只是「按 assetId 定位记录」的索引——
// 可从日志重建，不是第二真相。钥匙 = owner scope（executor 注入的 _owner_id，
// 每 Agent 恒有；主/子 Agent 共享 scope = 会话级资产）。
//
// 纯数据模块（agent 层，零 UI 依赖）。

export interface AssetRecord {
  assetId: string;
  kind: string;
  presentation: string;
  title?: string;
  payload: unknown;
  ts: number;
}

const tables = new Map<string, Map<string, AssetRecord>>();

function tableOf(scope: string, create: boolean): Map<string, AssetRecord> | null {
  let table = tables.get(scope);
  if (!table && create) {
    table = new Map();
    tables.set(scope, table);
  }
  return table ?? null;
}

/** 写入/替换资产记录（show_asset 与 update_asset 共用）。 */
export function upsertAsset(scope: string, record: AssetRecord): void {
  const table = tableOf(scope, true);
  if (!table) throw new Error('[asset-store] 无法创建资产表（create=true 仍为空）');
  table.set(record.assetId, record);
}

/** 查询资产记录（不存在返回 undefined）。 */
export function getAsset(scope: string, assetId: string): AssetRecord | undefined {
  return tableOf(scope, false)?.get(assetId);
}

/** 列出该 scope 全部资产（表序 = 插入序）。 */
export function listAssets(scope: string): AssetRecord[] {
  const table = tableOf(scope, false);
  return table ? [...table.values()] : [];
}

/** 删除单条资产（预留——WO-5 生命周期挂接用）。 */
export function removeAsset(scope: string, assetId: string): void {
  tableOf(scope, false)?.delete(assetId);
}

/** 清空整个 scope 的资产表（会话销毁时调用——WO-5 挂生命周期）。 */
export function dropAssetScope(scope: string): void {
  tables.delete(scope);
}

/** 测试复位（生产不调用）。 */
export function clearAssetTablesForTests(): void {
  tables.clear();
}

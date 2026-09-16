// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// asset-store — 会话级资产表（协议 §2.5/A7 的最小版——WO-2 落地于工具校验面；
// WO-5 接持久化/广播/pinned 孤儿刷新，本文件形状不变）。
//
// 语义：assetId → {kind, presentation, payload, ts} 的轻量索引。payload 的真源
// 在会话 JSONL（工具结果 details），本表只是「按 assetId 定位记录」的索引——
// 可从日志重建，不是第二真相（rebuildAssetsFromSession 兑现这条——此前无重建
// 路径，重启后 update_asset 对旧资产误报「不存在于当前会话」，CRUD 的 U 面
// 跨重启断）。钥匙 = owner scope（executor 注入的 _owner_id，每 Agent 恒有）。
//
// 纯数据模块（agent 层，零 UI 依赖）。

import { parseAssetEventOutput } from './asset-kinds';

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

/** 键序无关的规范化序列化（内容比较用——模型重发同一 payload 时键序可能不同）。 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 内容寻址查找（show_asset 幂等面，2026-09-16 真机事故后立）。
 *
 *  身份判据：kind 相同 + title 相同（两者都给了 title 才算同一逻辑资产）；
 *  无 title 时退回 payload 深等（键序无关）。presentation **不入身份**——
 *  同资产换皮肤属 update 语义（协议 §2.6）。
 *
 *  排除 confirm：交互卡的活回调绑在既有 part 上，复用旧 assetId 会让第二次
 *  等待挂在一个已决议的回调上（空等到超时）——confirm 永不幂等。
 *
 *  返回既有记录（未命中 undefined）；命中时调用方复用其 assetId，
 *  经 _applyAssetBroadcast 的 assetId 命中判定走**原位替换**、不新增块。 */
export function findAssetByContent(
  scope: string,
  kind: string,
  title: string | undefined,
  payload: unknown,
): AssetRecord | undefined {
  if (kind === 'confirm') return undefined;
  const mine = canonicalJson(payload);
  for (const rec of listAssets(scope)) {
    if (rec.kind !== kind) continue;
    if (title !== undefined && title.length > 0) {
      if (rec.title === title) return rec;
      continue;
    }
    if (isPlainObject(payload) && canonicalJson(rec.payload) === mine) return rec;
  }
  return undefined;
}

/** 删除单条资产（预留——WO-5 生命周期挂接用）。 */
export function removeAsset(scope: string, assetId: string): void {
  tableOf(scope, false)?.delete(assetId);
}

/** 清空整个 scope 的资产表（会话销毁时调用——WO-5 挂生命周期）。 */
export function dropAssetScope(scope: string): void {
  tables.delete(scope);
}

/** 从会话消息重建本 scope 的资产表（Agent._replaceSession 四边界统一调用：
 *  构造 init / setSession 恢复 / newSession / 清场）。
 *  真源 = 工具结果 JSONL 里保存的 AssetToolOutput（show_asset/update_asset 的
 *  返回 JSON 全量落会话）；同一 assetId 多次出现按会话序后者胜（更新语义）。
 *  整体替换语义：会话说了算——restore 后表=会话，清场/newSession 后表=空。
 *  截断/畸形的工具结果解析不出 → 跳过（该资产 UI 块仍由消息持久化渲染，
 *  只是失去 update-in-place 寻址——诚实降级，不炸重建）。 */
export function rebuildAssetsFromSession(scope: string, messages: Array<{ role?: string; content?: string }>): void {
  dropAssetScope(scope);
  for (const m of messages) {
    if (m?.role !== 'tool' || typeof m.content !== 'string' || !m.content.startsWith('{')) continue;
    const parsed = parseAssetEventOutput(m.content);
    if (!parsed) continue;
    upsertAsset(scope, {
      assetId: parsed.assetId,
      kind: parsed.kind,
      presentation: parsed.presentation ?? '',
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      payload: parsed.payload,
      ts: Date.now(),
    });
  }
}

/** 测试复位（生产不调用）。 */
export function clearAssetTablesForTests(): void {
  tables.clear();
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 拉取结果落盘层（provider-model-meta，2026-09-11）——「从 API 拉取模型」的
// **唯一 settings 写入口**。三个拉取点（设置页手动刷新 / 添加提供方两步式 /
// OAuth 登录后拉取）此前各写各的，且都只写 id 列表，元数据全丢。
//
// 分工（单一权威源）：
//   - ProviderSettings.models    = 可用模型 **id 列表**（下拉可选面，DSH routable 语义）
//   - ProviderSettings.modelMeta = API 披露的 **per-model 元数据**（持久化缓存）
//   - catalog 的 _dynamicModels  = 进程内目录（含启发式兜底，随进程消失）
// 三面同一次拉取喂饱；进程内目录由调用方另行 mergeDynamicModels（内存态不入 settings）。

import type { AppSettings, ProviderSettings } from '../settings';
import { type ModelMeta, metaHasContent } from './model-meta';
import type { ModelDescriptor } from './types';

/** 一次 /models 拉取的完整产物：描述符（内存目录用）+ 元数据（落盘用）。
 *  meta 只含端点**真披露**的字段——descriptor 上的启发式兜底（reasoning 猜测、
 *  ['text'] 缺省）绝不进 meta（「不编造」纪律的类型边界）。 */
export interface FetchedCatalog {
  models: ModelDescriptor[];
  meta: Record<string, ModelMeta>;
}

/** 把一次拉取并进 settings（不可变返回；调用方 onCommitProvider 落暂存）。
 *  - `models`：拉取到的 id 优先在前，**保留既有手工条目**（2026-09 走查语义：
 *    用户手动补过的模型不被整批清掉）；
 *  - `meta`：字段级合并——本次披露的字段覆盖旧值，本次未披露的字段保留 last-good
 *    （与 catalog 动态层的 last-good 保留同语义：端点临时抽风不毁掉已有元数据）。
 *  未命中 providerName（行已删）= 原样返回。 */
export function applyFetchedModels(settings: AppSettings, providerName: string, catalog: FetchedCatalog): AppSettings {
  // 行不存在（已删/改名）→ 原样返回，不凭空造行
  if (!settings.providers.some((p) => p.name === providerName)) return settings;
  const pulledIds = catalog.models.map((m) => m.id).filter((id) => id.trim().length > 0);
  if (pulledIds.length === 0 && Object.keys(catalog.meta).length === 0) return settings;
  return {
    ...settings,
    providers: settings.providers.map((p) =>
      p.name === providerName ? mergeIntoProvider(p, pulledIds, catalog.meta) : p,
    ),
  };
}

/** 单 provider 合并（导出 = 测试直呼面）。 */
export function mergeIntoProvider(
  p: ProviderSettings,
  pulledIds: readonly string[],
  incoming: Record<string, ModelMeta>,
): ProviderSettings {
  const existing = Array.isArray(p.models) ? p.models.filter((m) => m?.trim()) : [];
  // 旧数据无 models：先把当前默认模型并入，默认模型不因拉取而消失
  const seed = existing.length === 0 && p.model?.trim() ? [p.model.trim()] : [];
  const base = [...seed, ...existing];
  const merged = [...pulledIds, ...base.filter((m) => !pulledIds.includes(m))];
  const models = [...new Set(merged.filter((m) => m.trim().length > 0))];

  const prev = p.modelMeta ?? {};
  const next: Record<string, ModelMeta> = { ...prev };
  for (const [id, meta] of Object.entries(incoming)) {
    if (!metaHasContent(meta)) continue; // 端点什么都没披露——不写空壳条目
    next[id] = { ...prev[id], ...meta };
  }

  return {
    ...p,
    models,
    // 新会话默认：拉取前无默认模型时顶第一个（对齐添加流程的「拉取后设默认」）
    ...(p.model?.trim() ? {} : { model: models[0] ?? '' }),
    ...(Object.keys(next).length > 0 ? { modelMeta: next } : {}),
  };
}

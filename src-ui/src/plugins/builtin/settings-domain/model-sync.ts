// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 拉取结果落盘层（provider-model-meta，2026-09-11）——「从 API 拉取」的
// **唯一 settings 写入口**。三个拉取点（设置页手动刷新 / 添加提供方两步式 /
// OAuth 登录后拉取）共用。
//
// 分工（单一权威源；2026-09-23 三层重构后）：
//   - ProviderSettings.catalog   = **目录**：本次拉取到的 id 全量快照（只读远端事实）
//   - ProviderSettings.modelMeta = API 披露的 **per-model 元数据**（持久化缓存）
//   - ProviderSettings.models    = **启用集**（用户从目录里勾选的模型）——本层不写
//   - catalog 的 _dynamicModels  = 进程内目录（含启发式兜底，随进程消失）
//
// ⚡ 2026-09-23（用户拍板「目录/启用/选中」三层）：拉取**不再灌满启用集**——
//   旧实现把拉到的 id 直接并进 models（只增不减），于是「配一个提供方 = 81 个模型
//   全进创作坞下拉」，配置面失去了「挑」这一步（用户实测报告）。现在拉取只刷新
//   目录与元数据；启用集只由用户在目录里勾选/取消（Provider 页）或添加弹层勾选改变。

import { type ModelMeta, metaHasContent } from '../../../provider/model-meta';
import type { ModelDescriptor } from '../../../provider/types';
import type { AppSettings, ProviderSettings } from '../../../settings';

/** 一次 /models 拉取的完整产物：描述符（内存目录用）+ 元数据（落盘用）。
 *  meta 只含端点**真披露**的字段——descriptor 上的启发式兜底（reasoning 猜测、
 *  ['text'] 缺省）绝不进 meta（「不编造」纪律的类型边界）。 */
export interface FetchedCatalog {
  models: ModelDescriptor[];
  meta: Record<string, ModelMeta>;
}

/** 把一次拉取并进 settings（不可变返回；调用方 onCommitProvider 落暂存）。
 *  - `catalog`：本次拉到的 id **整份替换**（目录是快照，不是并集——远端下架的模型
 *    应从目录消失）；启用集里那些已不在目录中的条目**不受影响**（用户的选择不因
 *    远端变动被静默撤销，UI 照常列出）。
 *  - `meta`：字段级合并——本次披露的字段覆盖旧值，本次未披露的字段保留 last-good
 *    （与 catalog 动态层的 last-good 保留同语义：端点临时抽风不毁掉已有元数据）。
 *  - `models`：**一行不碰**（启用集归用户）。
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
  // 目录快照：空拉取（端点无 data）不清 last-good 目录——与「未拉取」区分开
  const catalog = pulledIds.length > 0 ? [...new Set(pulledIds.filter((m) => m.trim().length > 0))] : p.catalog;

  const prev = p.modelMeta ?? {};
  const next: Record<string, ModelMeta> = { ...prev };
  for (const [id, meta] of Object.entries(incoming)) {
    if (!metaHasContent(meta)) continue; // 端点什么都没披露——不写空壳条目
    next[id] = { ...prev[id], ...meta };
  }

  return {
    ...p,
    ...(catalog !== undefined ? { catalog } : {}),
    ...(Object.keys(next).length > 0 ? { modelMeta: next } : {}),
  };
}

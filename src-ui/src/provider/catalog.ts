// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 模型目录 — 来自 Pi 的 provider 注册表的静态模型数据，已适配兰台。
// 提供数据驱动的模型发现，用户无需手动输入模型名称。
//
// ⚡ 2026-08-07 定稿（docs/design/provider-system-spec.md 裁决 #15）：
//   目录 = 开箱体验优化，非必需——所有消费点均有 fallback。
//   目录 JSON 里的 `kind` 是【协议】（anthropic/openai），不是厂商：
//   DeepSeek Beta 端点挂 kind=anthropic 是特性（官方提供 Anthropic 兼容 API）。
//   JSON 不支持注释，模型条目的协议归属以本文件与 tests/provider-catalog.test.ts 为准。

import anthropicJson from './catalog/anthropic.json';
import deepseekJson from './catalog/deepseek.json';
import glmJson from './catalog/glm.json';
import minimaxJson from './catalog/minimax.json';
import moonshotaiJson from './catalog/moonshotai.json';
import ollamaJson from './catalog/ollama.json';
import openaiJson from './catalog/openai.json';
import opencodeJson from './catalog/opencode.json';
import qwenJson from './catalog/qwen.json';
import type { ModelDescriptor } from './types';

/** 目录 JSON 文件结构：{ [modelId]: ModelDescriptor } */
type CatalogFile = Record<string, ModelDescriptor>;

const CATALOG_FILES: Record<string, CatalogFile> = {
  anthropic: anthropicJson as CatalogFile,
  deepseek: deepseekJson as CatalogFile,
  glm: glmJson as CatalogFile,
  minimax: minimaxJson as CatalogFile,
  moonshotai: moonshotaiJson as CatalogFile,
  ollama: ollamaJson as CatalogFile,
  openai: openaiJson as CatalogFile,
  opencode: opencodeJson as CatalogFile,
  qwen: qwenJson as CatalogFile,
};

interface CatalogData {
  allModels: ModelDescriptor[];
  modelMap: Map<string, ModelDescriptor>;
}

let _catalog: CatalogData | undefined;

// ── 动态模型（运行时从 provider API 获取）──
// 同一模型 ID 以静态目录优先（元数据更丰富：cost、contextWindow 等）
const _dynamicModels = new Map<string, ModelDescriptor[]>();

// ── 动态模型目录失败面（C5 2026-08-27）──
// 拉取失败（网络/超时/端点 4xx/无 Key 等）记在此处；成功 = 清标记。选择器分组头
// 据此显示「目录获取失败」；已合并的 last-good 动态模型不因失败被清掉（静态目录 +
// 上次成功合并结果兜底，与 DSH groups 的「last-good 保留」同语义）。
// 模块级可变态归属（CONVENTIONS §1.10 第 3 类）：键控进程级状态（键 = 提供方名），
// 同 _dynamicModels 归属，无跨工作区所有权问题。
const _dynamicFetchFailures = new Map<string, string>();

/** 记录某 provider 动态模型目录的拉取结果。成功 = 清失败标记；
 *  失败 = 记原因（getDynamicFetchFailure 返回 undefined 表示无失败）。 */
export function recordDynamicFetchResult(providerName: string, ok: boolean, error?: string): void {
  if (ok) {
    _dynamicFetchFailures.delete(providerName);
  } else {
    _dynamicFetchFailures.set(providerName, error?.trim() ? error : '获取失败');
  }
}

/** 某 provider 动态模型目录的拉取失败原因；无失败 = undefined。 */
export function getDynamicFetchFailure(providerName: string): string | undefined {
  return _dynamicFetchFailures.get(providerName);
}

/** 将动态获取的模型合并到目录中。会使缓存失效。
 *  已在静态目录中的模型 ID 会被跳过（静态目录元数据更丰富）。 */
export function mergeDynamicModels(providerName: string, models: ModelDescriptor[]): void {
  if (models.length === 0) return;
  _dynamicModels.set(providerName, models);
  _catalog = undefined; // 使缓存失效
}

/** 获取某个 provider 动态发现的模型数量。 */
export function getDynamicModelCount(providerName: string): number {
  return _dynamicModels.get(providerName)?.length ?? 0;
}

function loadCatalog(): CatalogData {
  if (_catalog) return _catalog;
  const all: ModelDescriptor[] = [];
  const seenIds = new Set<string>();

  // 静态目录优先（元数据丰富 — cost、contextWindow、reasoning 等）
  for (const file of Object.values(CATALOG_FILES)) {
    for (const model of Object.values(file)) {
      all.push(model);
      seenIds.add(model.id);
    }
  }

  // 合并动态模型（已在静态目录中的跳过 — 静态目录元数据更丰富）
  for (const [, models] of _dynamicModels) {
    for (const model of models) {
      if (!seenIds.has(model.id)) {
        all.push(model);
        seenIds.add(model.id);
      }
    }
  }

  // modelMap 先到先得（首个文件为权威）：目录允许不同厂商共享同一模型 id
  // （opencode GO 等网关会复用上游 deepseek/openai 的模型 id），后加载的条目
  // 不覆盖先加载厂商的元数据（定价/上下文窗口）；vendor 过滤仍走 allModels。
  const modelMap = new Map<string, ModelDescriptor>();
  for (const m of all) {
    if (!modelMap.has(m.id)) modelMap.set(m.id, m);
  }
  _catalog = { allModels: all, modelMap };
  return _catalog;
}

/** 获取目录中的所有模型。 */
export function getAllModels(): ModelDescriptor[] {
  return loadCatalog().allModels;
}

/** 查找属于特定 provider 的模型。 */
export function findModels(vendor: string): ModelDescriptor[] {
  return loadCatalog().allModels.filter((m) => m.vendor === vendor);
}

/** 根据 id 查找模型。 */
export function getModel(modelId: string): ModelDescriptor | undefined {
  return loadCatalog().modelMap.get(modelId);
}

/** 将请求的 max_tokens 限制在模型目录的输出上限内。
 *  超出范围的 max_tokens 会导致严格的 provider 在生成任何 token 之前
 *  就以 400 拒绝每次请求（DeepSeek：有效范围 [1, 393216]）。
 *  用户设置覆盖（maxTokensOverride，P14）优先于目录值——目录数据 stale
 *  或厂商临时调整时无需发版，改设置即可纠正。
 *  未知模型（无目录条目）不做限制直接通过。 */
export function clampMaxTokens(modelId: string, requested: number, maxTokensOverride?: number): number {
  const cap = maxTokensOverride ?? getModel(modelId)?.maxTokens;
  return cap && cap > 0 ? Math.min(requested, cap) : requested;
}

/** 按 id 或显示名称模糊搜索模型（不区分大小写的子串匹配）。 */
export function searchModels(query: string): ModelDescriptor[] {
  const { allModels } = loadCatalog();
  const q = query.toLowerCase().trim();
  if (!q) return allModels;
  return allModels.filter(
    (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.vendor.toLowerCase().includes(q),
  );
}

/** 获取某个 provider 推荐的默认模型。 */
export function getDefaultModel(providerName: string): ModelDescriptor | undefined {
  const models = findModels(providerName);
  if (models.length === 0) return undefined;
  // 优先选择目录中的第一个模型（Pi 的数据已按相关性排序）
  return models[0];
}

/** 列出目录中有模型的所有 Vendor 名称（CONTEXT.md「Vendor」）。 */
export function getCatalogVendors(): string[] {
  return [...new Set(loadCatalog().allModels.map((m) => m.vendor))];
}

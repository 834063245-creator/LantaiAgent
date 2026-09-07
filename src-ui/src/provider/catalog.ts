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
//
// ⚡ 2026-09 provider-refactor（方案乙）Phase 1B 定稿：预设厂商目录维护负担退役。
//   静态 JSON 只保留内核 seed（catalog/anthropic.json + openai.json + deepseek.json——
//   官方常用几款，带 contextWindow/maxTokens/thinkingEfforts）；其余厂商一律运行时
//   从 provider /models 拉取。消费面分类：
//   - getModel / clampMaxTokens：模型**元数据**查询（窗口/档位/钳制）——唯一消费
//     catalog JSON seed + 动态模型合并结果（ProviderSettings.models 拉取产物）。
//   - getDefaultModel / getCatalogVendors：预填/回落——catalog JSON 退役后主真源
//     是 vendor-templates.ts（连接模板表），本文件仅在内核 seed 存在时补默认模型。
//   - AddProviderSheet chips 改走 getVendorTemplateVendors()。

import type { ModelDescriptor } from './types';
import { findVendorTemplate, getVendorTemplateVendors } from './vendor-templates';

/** 目录 JSON 文件结构：{ [modelId]: ModelDescriptor } */
type CatalogFile = Record<string, ModelDescriptor>;

// 目录装载 —— glob 化（2026-08-27 provider 插件化收口）：
// 「加一个厂商 = 往 catalog/ 丢一个 json」，无需回本文件挂表。
// 权威规则：modelMap 先到先得 = 文件名字母序先者得（既有重复 id 契约不变——
// opencode/deepseek 共享 id 时 deepseek.json 靠字母序保持权威，tests 已钉住）。
// 环境守卫（2026-08-27 平台化 P3）：import.meta.glob 是 Vite 编译期变换，
// 纯 node/tsx 环境（gen-tool-contract 等脚本）没有它——直接调用时属性不存在
// 抛 TypeError，接住 = 空目录（裁决 #15：目录是开箱优化非必需，消费点全有
// fallback），不得在模块顶层硬炸非 Vite 装载链。注意必须以全名直呼
// `import.meta.glob`（Vite 静态变换要求，别名/解构都会破）。
let CATALOG_MODULES: Record<string, { default: unknown }> = {};
try {
  CATALOG_MODULES = import.meta.glob('./catalog/*.json', { eager: true });
} catch {
  // 非 Vite 环境：空目录 fallback（消费点均有兜底，不静默炸装载链）
}

const CATALOG_FILES: Record<string, CatalogFile> = {};
for (const [file, mod] of Object.entries(CATALOG_MODULES)) {
  const stem = file.slice('./catalog/'.length, -'.json'.length);
  CATALOG_FILES[stem] = mod.default as CatalogFile;
}

interface CatalogData {
  allModels: ModelDescriptor[];
  modelMap: Map<string, ModelDescriptor>;
}

let _catalog: CatalogData | undefined;

// ── 动态模型（运行时从 provider API 获取）──
// 同一模型 ID 以静态目录优先（元数据更丰富：contextWindow/能力声明等）
const _dynamicModels = new Map<string, ModelDescriptor[]>();

// ── 动态模型目录失败面（C5 2026-08-27）──
// 拉取失败（网络/超时/端点 4xx/无 Key 等）记在此处；成功 = 清标记。选择器分组头
// 据此显示「目录获取失败」；已合并的 last-good 动态模型不因失败被清掉（静态目录 +
// 上次成功合并结果兜底，与 DSH groups 的「last-good 保留」同语义）。
// 模块级可变态归属（CONVENTIONS §1.10 第 3 类）：键控进程级状态（键 = 提供方名），
// 同 _dynamicModels 归属，无跨工作区所有权问题。
const _dynamicFetchFailures = new Map<string, string>();

/** 记录某 provider 动态模型目录的拉取结果。成功 = 清失败标记；
 *  失败 = 记原因（getDynamicFetchFailure 返回 undefined 表示无失败）。
 *  同时收掉拉取中标记（markDynamicFetchStart 的配对收尾）并通知订阅者。 */
export function recordDynamicFetchResult(providerName: string, ok: boolean, error?: string): void {
  if (ok) {
    _dynamicFetchFailures.delete(providerName);
  } else {
    _dynamicFetchFailures.set(providerName, error?.trim() ? error : '获取失败');
  }
  _dynamicFetchInflight.delete(providerName);
  _notifyDynamicFetchListeners();
}

// ── 动态目录拉取中面（R5 D8 2026-08-29）──
// 拉取进行中标记（键 = 提供方名），选择器分组头显示「目录获取中…」。
// 开始/收尾经 onDynamicFetchChange 通知——选择器打开期间订阅，拉取完成实时
// 刷新（否则「获取中」会悬挂到下次重开下拉；失败标注是静态读无此诉求）。
// 模块级可变态归属（CONVENTIONS §1.10 第 3 类）：键控进程级状态，同
// _dynamicFetchFailures 归属，无跨工作区所有权问题。
const _dynamicFetchInflight = new Set<string>();
const _dynamicFetchListeners = new Set<() => void>();

/** 标记某 provider 动态目录拉取开始（拉取点：workspace 后台预热 / 设置页手动刷新）。 */
export function markDynamicFetchStart(providerName: string): void {
  _dynamicFetchInflight.add(providerName);
  _notifyDynamicFetchListeners();
}

/** 某 provider 动态目录是否拉取中。 */
export function getDynamicFetchInflight(providerName: string): boolean {
  return _dynamicFetchInflight.has(providerName);
}

/** 是否存在任一进行中的目录拉取（下拉空态文案用）。 */
export function hasDynamicFetchInflight(): boolean {
  return _dynamicFetchInflight.size > 0;
}

/** 订阅拉取状态变更（开始/收尾各通知一次；返回退订函数）。 */
export function onDynamicFetchChange(listener: () => void): () => void {
  _dynamicFetchListeners.add(listener);
  return () => {
    _dynamicFetchListeners.delete(listener);
  };
}

function _notifyDynamicFetchListeners(): void {
  for (const listener of _dynamicFetchListeners) listener();
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

  // 静态目录优先（元数据丰富 — contextWindow、reasoning、能力声明等）
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

/** 获取某个 provider 推荐的默认模型。
 *  模板表优先（vendor-templates.ts 的 defaultModel + kind/baseUrl 对齐）；模板无
 *  该厂商时回落目录 seed 首条（内核三家）；两者皆无 = undefined。 */
export function getDefaultModel(providerName: string): ModelDescriptor | undefined {
  const tpl = findVendorTemplate(providerName);
  if (tpl) {
    // 模板带 defaultModel → 找目录/动态合并结果里同名模型（元数据更丰富）
    if (tpl.defaultModel) {
      const seeded = getModel(tpl.defaultModel);
      // seed 命中且 vendor 归属对得上才用（opencode 复用 deepseek id 时
      // 归属仍应是该 vendor——目录条目 vendor=opencode 覆盖才成立）
      if (seeded?.vendor === providerName) return seeded;
      if (seeded) {
        // 模板厂商复用他厂模型 id（opencode→deepseek-v4-flash）：造最小描述符，
        // 连接参数（kind/baseUrl）以模板为准，不占 catalog seed 的厂商归属
        return {
          ...seeded,
          kind: tpl.kind,
          vendor: providerName,
          baseUrl: tpl.baseUrl,
        };
      }
    }
    // 模板无 defaultModel（ollama 等）→ 目录 seed 首条（有则用）
    const models = findModels(providerName);
    if (models.length > 0) return models[0];
    return undefined;
  }
  // 模板表外（自定义 provider 名）→ 目录 seed 首条兜底
  const models = findModels(providerName);
  if (models.length === 0) return undefined;
  return models[0];
}

/** 列出目录中有模型的所有 Vendor 名称（CONTEXT.md「Vendor」）。
 *  ⚡ 方案乙 Phase 1B：chips/枚举面主真源 = 模板表（getVendorTemplateVendors）；
 *  目录 seed vendor 并入（内核三家 + 动态合并不在此枚举——动态是 provider 行级）。 */
export function getCatalogVendors(): string[] {
  const names = new Set<string>(getVendorTemplateVendors());
  for (const m of loadCatalog().allModels) names.add(m.vendor);
  return [...names];
}

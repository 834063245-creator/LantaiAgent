// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 配方（连接配置的导入/导出，2026-09-17）——
// 「用户拿到 exe、遇到没人适配过的套餐」的逃生通道：一行 provider 的全部**非敏感**
// 连接配置可导出为 JSON 交给别人，对方粘贴即可套用（含自定义请求头、模型元数据、
// 档位/覆盖）。
//
// 纪律：
//   - apiKey 绝不进配方（权威在 credentials.enc）；导入面显式忽略并告知。
//   - 导入是写入边界 → 白名单字段 + 严格校验、整单拒绝（错误不静默）；name 是身份
//     （凭据键 + 动态模型合并键），套用时保持本行名字不变（避免孤儿凭据）。

import type { ProviderSettings } from '../settings';
import { type HeaderEntry, headerEntryError, MAX_CUSTOM_HEADERS } from './custom-headers';
import type { ModelMeta } from './model-meta';
import { isThinkingMode, type StoredThinking, THINKING_MODES, type ThinkingEffort } from './thinking';

/** 配方文件标识（防误贴其它 JSON）。 */
export const RECIPE_FORMAT = 'lantai-provider-recipe';
/** 当前配方版本；结构变更时递增并在此拒绝旧版。 */
export const RECIPE_VERSION = 1;

/** 一行 provider 的非敏感配置（apiKey / lastTest 不在配方内）。 */
export type ProviderRecipe = Omit<ProviderSettings, 'apiKey' | 'lastTest'>;

/** 配方文件外形。 */
export interface ProviderRecipeFile {
  format: typeof RECIPE_FORMAT;
  version: number;
  provider: ProviderRecipe;
}

/** 导入成功：配方 + 需要告知用户的忽略项。 */
export interface ParsedRecipe {
  recipe: ProviderRecipe;
  /** 解析中按纪律忽略的内容（如 apiKey），导入面必须显示。 */
  notices: string[];
}

/** 导入失败：人可读原因（写入边界整单拒绝）。 */
export interface RecipeError {
  error: string;
}

const THINKING_EFFORTS: readonly ThinkingEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 导出当前行为配方 JSON（apiKey / lastTest 剥除）。
 * @param provider - 待导出的提供方行。
 * @returns 人可读的 JSON 文本。
 */
export function exportProviderRecipe(provider: ProviderSettings): string {
  const { apiKey: _apiKey, lastTest: _lastTest, ...rest } = provider;
  const file: ProviderRecipeFile = { format: RECIPE_FORMAT, version: RECIPE_VERSION, provider: rest };
  return JSON.stringify(file, null, 2);
}

/** 由设置页套用配方：只取配方字段，行的身份（name）与密钥（apiKey）保持本行。 */
export function applyRecipeToProvider(target: ProviderSettings, recipe: ProviderRecipe): ProviderSettings {
  return { ...target, ...recipe, name: target.name, apiKey: target.apiKey };
}

/** 校验可选的模型 id 列表。 */
function readStringArray(raw: unknown, field: string, errors: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !v.trim())) {
    errors.push(`provider.${field} 必须是字符串数组`);
    return undefined;
  }
  return (raw as string[]).map((v) => v.trim());
}

/** 校验请求头字段：写入边界严格拒绝非法条目（不静默丢弃）。 */
function readHeaders(raw: unknown, errors: string[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('provider.headers 必须是「头名 → 头值」的对象');
    return undefined;
  }
  const entries = Object.entries(raw) as [string, unknown][];
  if (entries.length > MAX_CUSTOM_HEADERS) {
    errors.push(`provider.headers 请求头过多（${entries.length} 条，上限 ${MAX_CUSTOM_HEADERS} 条）`);
  }
  const clean: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (typeof value !== 'string') {
      errors.push(`provider.headers「${name}」的值必须是字符串`);
      continue;
    }
    const entry: HeaderEntry = { name, value };
    const reason = headerEntryError(entry);
    if (reason) {
      errors.push(`provider.headers「${name}」：${reason}`);
      continue;
    }
    clean[name.trim()] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** 校验 per-model 覆盖（只认已知字段；形状不对整单报错）。 */
function readModelOverrides(raw: unknown, errors: string[]): ProviderSettings['modelOverrides'] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('provider.modelOverrides 必须是「模型 id → 覆盖」的对象');
    return undefined;
  }
  const out: NonNullable<ProviderSettings['modelOverrides']> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim() || !value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`provider.modelOverrides「${id}」必须是非空的对象`);
      continue;
    }
    const ov = value as Record<string, unknown>;
    const next: NonNullable<ProviderSettings['modelOverrides']>[string] = {};
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const v = ov[field];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        errors.push(`provider.modelOverrides「${id}」.${field} 必须是非负数字`);
        continue;
      }
      next[field] = v;
    }
    if (ov.input !== undefined) {
      const input = readStringArray(ov.input, `modelOverrides「${id}」.input`, errors);
      if (input) next.input = input as ('text' | 'image')[];
    }
    // per-model 思考档位（2026-09-23 思考下沉）：只认 canonical 档位 + 空串（自动）
    // ——写入边界严格，遗留数字预算不进配方字段（那是 provider 行级的历史形态）。
    if (ov.thinking !== undefined) {
      if (typeof ov.thinking === 'string' && isThinkingMode(ov.thinking)) {
        next.thinking = ov.thinking;
      } else {
        errors.push(
          `provider.modelOverrides「${id}」.thinking 必须是合法档位（${THINKING_MODES.map((m) => m.value || '自动').join(' / ')}）`,
        );
      }
    }
    out[id] = next;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 校验 per-model 拉取元数据（只认已知字段；形状不对整单报错）。 */
function readModelMeta(raw: unknown, errors: string[]): Record<string, ModelMeta> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('provider.modelMeta 必须是「模型 id → 元数据」的对象');
    return undefined;
  }
  const out: Record<string, ModelMeta> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim() || !value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`provider.modelMeta「${id}」必须是非空的对象`);
      continue;
    }
    const src = value as Record<string, unknown>;
    const fetchedAt = src.fetchedAt;
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) {
      errors.push(`provider.modelMeta「${id}」.fetchedAt 必须是数字（拉取时刻）`);
      continue;
    }
    const meta: ModelMeta = { fetchedAt };
    if (src.name !== undefined) {
      if (typeof src.name !== 'string') errors.push(`provider.modelMeta「${id}」.name 必须是字符串`);
      else meta.name = src.name;
    }
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const v = src[field];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        errors.push(`provider.modelMeta「${id}」.${field} 必须是正数`);
        continue;
      }
      meta[field] = v;
    }
    if (src.reasoning !== undefined) {
      if (typeof src.reasoning !== 'boolean') errors.push(`provider.modelMeta「${id}」.reasoning 必须是布尔`);
      else meta.reasoning = src.reasoning;
    }
    if (src.thinkingOff !== undefined) {
      if (typeof src.thinkingOff !== 'boolean') errors.push(`provider.modelMeta「${id}」.thinkingOff 必须是布尔`);
      else meta.thinkingOff = src.thinkingOff;
    }
    if (src.input !== undefined) {
      const input = readStringArray(src.input, `modelMeta「${id}」.input`, errors);
      if (input) meta.input = input as ('text' | 'image')[];
    }
    if (src.thinkingEfforts !== undefined) {
      const efforts = readStringArray(src.thinkingEfforts, `modelMeta「${id}」.thinkingEfforts`, errors);
      if (efforts) {
        const unknown = efforts.filter((e) => !THINKING_EFFORTS.includes(e as ThinkingEffort));
        if (unknown.length > 0)
          errors.push(`provider.modelMeta「${id}」.thinkingEfforts 含未知档位：${unknown.join(', ')}`);
        else meta.thinkingEfforts = efforts as ThinkingEffort[];
      }
    }
    out[id] = meta;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 解析一张配方 JSON。
 * @param text - 粘贴的 JSON 文本。
 * @returns 配方与忽略项，或人可读的失败原因。
 */
export function parseProviderRecipe(text: string): ParsedRecipe | RecipeError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: '不是合法 JSON——请粘贴完整配方文本' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '配方必须是一个 JSON 对象' };
  }
  const file = parsed as Partial<ProviderRecipeFile>;
  if (file.format !== RECIPE_FORMAT) {
    return { error: `不是兰台 provider 配方（format 应为 "${RECIPE_FORMAT}"）` };
  }
  if (file.version !== RECIPE_VERSION) {
    return { error: `配方版本不受支持（应为 ${RECIPE_VERSION}，实际 ${String(file.version)}）` };
  }
  const raw = file.provider;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '配方缺少 provider 对象' };
  }
  const src = raw as Record<string, unknown>;
  const errors: string[] = [];
  const notices: string[] = [];
  for (const field of ['name', 'kind', 'baseUrl', 'model'] as const) {
    if (typeof src[field] !== 'string' || !(src[field] as string).trim()) {
      errors.push(`配方缺少必填字段 provider.${field}（非空字符串）`);
    }
  }
  if (typeof src.apiKey === 'string' && src.apiKey.trim()) {
    notices.push('配方里的 apiKey 已忽略——密钥只在本机凭据库，请在 Key 输入框单独填写');
  }
  const models = readStringArray(src.models, 'models', errors);
  // 目录快照（2026-09-23 三层）：随配方传递——对方不必先拉一次就有可勾选面
  const catalog = readStringArray(src.catalog, 'catalog', errors);
  const headers = readHeaders(src.headers, errors);
  const modelOverrides = readModelOverrides(src.modelOverrides, errors);
  const modelMeta = readModelMeta(src.modelMeta, errors);
  const thinking = src.thinking;
  if (thinking !== undefined && typeof thinking !== 'string') {
    errors.push('provider.thinking 必须是字符串（档位名或空串）');
  }
  const authMode = src.authMode;
  if (authMode !== undefined && authMode !== 'api-key' && authMode !== 'oauth') {
    errors.push('provider.authMode 只能是 "api-key" 或 "oauth"');
  }
  const oauthProvider = src.oauthProvider;
  if (oauthProvider !== undefined && typeof oauthProvider !== 'string') {
    errors.push('provider.oauthProvider 必须是字符串');
  }
  if (errors.length > 0) return { error: errors.join('\n') };
  return {
    recipe: {
      name: (src.name as string).trim(),
      kind: (src.kind as string).trim(),
      baseUrl: (src.baseUrl as string).trim(),
      model: (src.model as string).trim(),
      ...(models !== undefined ? { models } : {}),
      ...(catalog !== undefined ? { catalog } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(modelOverrides !== undefined ? { modelOverrides } : {}),
      ...(modelMeta !== undefined ? { modelMeta } : {}),
      ...(typeof thinking === 'string' ? { thinking: thinking as StoredThinking } : {}),
      ...(authMode === 'api-key' || authMode === 'oauth' ? { authMode } : {}),
      ...(typeof oauthProvider === 'string' ? { oauthProvider } : {}),
    },
    notices,
  };
}

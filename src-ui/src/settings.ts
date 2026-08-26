// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings — API Key 管理、模型选择、provider 配置
// 存储在 localStorage 中，在可用时由 Tauri store 插件支持

import { ANTHROPIC_DEFAULT_BASE_URL } from './provider/anthropic';
import { getCatalogVendors, getDefaultModel, getModel } from './provider/catalog';
import type { StoredThinking } from './provider/thinking';
import type { Protocol } from './provider/types';

/** 连接探针的结果（CONTEXT.md「ConnectionProbe」）— 非敏感，随 localStorage 持久化。 */
export type ProbeOutcome = 'ok' | 'fail';

export interface ConnectionProbe {
  status: ProbeOutcome;
  /** 端到端耗时（毫秒） */
  latencyMs: number;
  /** 测试完成时间（epoch ms） */
  at: number;
  message?: string;
}

/** Provider 身份（CONTEXT.md「ProviderId」）：唯一不可变，同时是系统凭据键与
 *  动态模型合并键（三合一）。运行时就是 string（存储兼容零迁移），
 *  仅在类型层面与普通字符串隔离——禁止拿任意字符串当 ProviderId 用。 */
export type ProviderId = string & { readonly __brand?: 'ProviderId' };

/** 在输入边界把已验证的字符串提升为 ProviderId（唯一受信任的构造入口）。 */
export function providerId(raw: string): ProviderId {
  return raw as ProviderId;
}

export interface ProviderSettings {
  kind: Protocol; // 持久化字段名保持 kind（存储遗留名）；领域词见 CONTEXT.md「Protocol」
  name: ProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  thinking?: StoredThinking; // 领域词 ThinkingPolicy；存储字段名保持 thinking（遗留名）
  lastTest?: ConnectionProbe; // 存储字段名保持 lastTest（遗留名）；领域词 ConnectionProbe
  /** 该提供方「可用模型」id 列表——创作坞下拉的可选面（DSH routable 列表的
   *  前端配置形态）。与 model（默认模型）解耦：同一提供方可挂多个模型，
   *  会话级在列表内切换；缺省/空 = 视为 [model]（旧数据零迁移）。
   *  从 API 拉取（fetchModels）会填充此列表（写进暂存，随保存落盘）。 */
  models?: string[];
  /** per-model 覆盖（P14 替代旧的 per-provider 单字段 contextWindow/maxTokens——
   *  多模型时代按 Provider 管一个值毫无意义）。键 = 模型 id；0/缺省 = 用目录值。
   *  workspace._contextWindowFor 与 createProvider → buildRequest → clampMaxTokens 消费。 */
  modelOverrides?: Record<string, ModelOverrides>;
}

/** 单模型的 P14 覆盖：目录数据 stale / 目录外自定义模型时的纠正。 */
export interface ModelOverrides {
  /** 上下文窗口（token 数）；0/缺省 = 用目录值（目录无 = 默认 200K）。 */
  contextWindow?: number;
  /** 最大输出 token；0/缺省 = 用目录值（目录无 = 不钳制）。 */
  maxTokens?: number;
}

/** 解析某提供方的「可用模型」id 列表：显式 models 优先，缺省回落 [model]
 *  （旧存档无 models 字段 = 只有一个默认模型，零迁移）。 */
export function effectiveModels(p: ProviderSettings): string[] {
  const list = Array.isArray(p.models) && p.models.length > 0 ? p.models.filter((m) => m?.trim()) : [];
  if (list.length > 0) return list;
  return p.model?.trim() ? [p.model.trim()] : [];
}

/** 某模型生效的上下文窗口：per-model 覆盖 ?? 目录值 ?? 默认（200K）。 */
export function modelContextWindow(p: ProviderSettings, modelId: string, fallback = 200000): number {
  const ov = p.modelOverrides?.[modelId]?.contextWindow;
  if (ov && ov > 0) return ov;
  return getModel(modelId)?.contextWindow || fallback;
}

/** 某模型生效的最大输出 token：per-model 覆盖 ?? 目录值 ?? 0（不钳制）。
 *  （clampMaxTokens 内部另有目录兜底，此处返回 per-model 覆盖优先值。） */
export function modelMaxTokens(p: ProviderSettings, modelId: string): number {
  const ov = p.modelOverrides?.[modelId]?.maxTokens;
  if (ov && ov > 0) return ov;
  return getModel(modelId)?.maxTokens || 0;
}

export interface AgentSettings {
  /** 默认协作模式 */
  collaborationMode?: 'normal' | 'plan';
  /** 默认权限模式 */
  permissionMode?: 'ask' | 'auto' | 'yolo';
}

interface DisplaySettings {
  language: 'zh' | 'en';
  fontScale: number;
}

/** 图谱引擎设置（引擎开关，2026-08-22）——「绑目录 ≠ 开图谱」：
 *  关 = 绑定目录的工作区跳过分析/预热/简报/watcher，graphData 留 null
 *  （零目录会话既有语义），fs/shell/git/权限全套保留。生效时机 =
 *  下次绑定目录（在途工作区不活拆）。 */
export interface GraphEngineSettings {
  /** 引擎总开关（缺省 true = 旧行为零漂移；false 时读取点见 workspace.ts
   *  （绑定期快照——装配面经 graphContext 间接消费，见 blueprint.ts）/
   *  shell/rows/cold-start.ts / app/SessionsHome.tsx）。 */
  enabled: boolean;
}

/** 读取图谱引擎开关（缺省容错：旧存储无此节 = 开）。 */
export function graphEngineEnabled(s: AppSettings): boolean {
  return s.graphEngine?.enabled !== false;
}

/** 读取更新自动检查开关（缺省容错：旧存储无此节 = 开）。 */
export function autoUpdateCheckEnabled(s: AppSettings): boolean {
  return s.updates?.autoCheck !== false;
}

/** 组合层设置（S4-1a）——preset 选择的持久化真源（缺省 standard；
 *  运行时镜像在 state/preset-store.selected，boot 期经
 *  composition/preset-assembly.syncPresetSelectionFromSettings 同步）。 */
export interface CompositionSettings {
  /** 选中的 preset id（内置表 id 或用户 preset 目录 id；未知 id 装配侧回退 factory）。 */
  preset: string;
}

/** 更新器设置（可选——旧存储无此节 = 启动自动检查开）。 */
export interface UpdateSettings {
  /** 启动时延迟自动检查应用更新（壳行 shell-update-check 消费；关闭后手动检查不受影响）。 */
  autoCheck: boolean;
}

export interface AppSettings {
  /** 新会话默认提供方 = 最近使用的 provider（2026-08-26：「设为当前」按钮退役，
   *  activeProvider 不再手动指定，而是在创作坞切模型时自动跟从——compose-store
   *  setModel 定向写）。新卷/未改卷出生默认 = 该 provider + 其 model（最近使用）。
   *  领域词见 CONTEXT.md「ProviderId」。 */
  activeProvider: ProviderId;
  providers: ProviderSettings[];
  projectPath: string;
  agent: AgentSettings;
  display: DisplaySettings;
  /** 组合层设置（可选——旧存储无此字段，loadSettings 缺省容错补 standard）。 */
  composition?: CompositionSettings;
  /** 图谱引擎设置（可选——旧存储无此节 = 引擎开，graphEngineEnabled 容错读取）。 */
  graphEngine?: GraphEngineSettings;
  /** 更新器设置（可选——旧存储无此节 = 自动检查开，autoUpdateCheckEnabled 容错读取）。 */
  updates?: UpdateSettings;
}

const STORAGE_KEY = 'hologram_settings';

/** 协议（kind）→ 默认 Base URL。字面量的唯一事实源——
 *  新增 provider 无目录条目时的兜底；已知厂商优先用
 *  defaultBaseUrl()（目录 getDefaultModel(name).baseUrl 优先）。 */
export const PROVIDER_PROTOCOL_DEFAULTS: Record<Protocol, string> = {
  anthropic: ANTHROPIC_DEFAULT_BASE_URL,
  openai: 'https://api.openai.com/v1',
};

/** provider 默认 Base URL：目录条目优先（单一事实源在 catalog JSON），
 *  目录无此厂商时回退协议默认。 */
export function defaultBaseUrl(name: string, kind: ProviderSettings['kind']): string {
  return getDefaultModel(name)?.baseUrl ?? PROVIDER_PROTOCOL_DEFAULTS[kind];
}

/** 是否仍是「出厂默认」Base URL（协议默认或目录厂商默认）——
 *  设置面板模型切换时的 baseUrl 自动填充判定（用户自定义过就不覆盖）。 */
export function isFactoryBaseUrl(url: string): boolean {
  const defaults = new Set<string>(Object.values(PROVIDER_PROTOCOL_DEFAULTS));
  for (const name of getCatalogVendors()) {
    const u = getDefaultModel(name)?.baseUrl;
    if (u) defaults.add(u);
  }
  return defaults.has(url);
}

const DEFAULTS: AppSettings = {
  activeProvider: providerId('deepseek'),
  providers: [
    {
      kind: 'openai',
      name: providerId('deepseek'),
      apiKey: '',
      baseUrl: defaultBaseUrl('deepseek', 'openai'),
      model: 'deepseek-v4-pro',
    },
    {
      kind: 'anthropic',
      name: providerId('anthropic'),
      apiKey: '',
      baseUrl: PROVIDER_PROTOCOL_DEFAULTS.anthropic,
      model: 'claude-sonnet-4-6',
      thinking: '',
    },
  ],
  projectPath: '.',
  agent: {},
  display: {
    language: 'zh',
    fontScale: 1.2,
  },
  composition: {
    preset: 'standard',
  },
  graphEngine: {
    enabled: true,
  },
  updates: {
    autoCheck: true,
  },
};

export function loadSettings(): AppSettings {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // ⚡ 2026-08-08「null 复活」修复：毒化时期 localStorage 可能残留
        // apiKey:"null" 字面量——它非空、会被当成真 key 展示并回写凭据库。
        // 加载时即清洗为空，下一次保存自动落回干净状态。
        if (Array.isArray(parsed?.providers)) {
          for (const p of parsed.providers) {
            if (p && typeof p.apiKey === 'string' && p.apiKey.trim() === 'null') {
              p.apiKey = '';
            }
          }
        }
        // D1：providers 空数组 = 腐坏存储——回落出厂 provider 表（否则
        // getActiveProvider 兜底链每天都在边缘行走）
        if (!Array.isArray(parsed?.providers) || parsed.providers.length === 0) {
          parsed.providers = DEFAULTS.providers;
        }
        return { ...DEFAULTS, ...parsed };
      }
    }
  } catch {
    // 设置损坏，使用默认值
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: AppSettings): void {
  if (typeof localStorage !== 'undefined') {
    // ⚡ 2026-08-04 状态治理：apiKey 不落 localStorage 明文。
    // 唯一权威 = 系统加密凭据（persistSecrets / restoreSecrets）；
    // localStorage 只存非敏感配置。provider 配置结构保留，仅抹空密钥字段。
    const sanitized: AppSettings = {
      ...s,
      providers: s.providers.map((p) => (p.apiKey ? { ...p, apiKey: '' } : p)),
    };
    // P0-9：localStorage 配额与会话备份共享，耗尽时 setItem 同步抛——
    // 绝不能让异常冲出（曾打断 handleSave，key 因此未落凭据库）
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
    } catch (e) {
      console.warn('[settings] localStorage 写入失败（配额耗尽？），设置仅本次会话生效:', e);
    }
  }
  // 通知订阅者（UI 响应式标签 — ChatFooter/ChatBeacon/ChatHint）
  for (const cb of [..._saveListeners]) cb();
}

// ── 设置保存订阅（UI 响应式标签用）──
const _saveListeners = new Set<() => void>();

/** 订阅 saveSettings 完成事件。返回取消订阅函数。 */
export function onSettingsSaved(cb: () => void): () => void {
  _saveListeners.add(cb);
  return () => {
    _saveListeners.delete(cb);
  };
}

/** 将 API Key 持久化到系统加密存储（DPAPI on Windows），防止 localStorage 被清丢 Key。
 *  ⚡ 2026-08-04：apiKey 唯一权威在此 — 保存设置时同步写入凭据。
 *  ⚡ 2026-08-07 修正：空 key **不再执行 delete**——state 与凭据可能因异步回填
 *  暂时不同步（restoreSecrets 未完成时遍历会把未回填的 provider 误删）。
 *  删除凭据只走两个明确场景：removeProvider（removeSecret）与用户主动清空
 *  输入框（手动落盘后保存空 key 不会删凭据——清空需走 removeProvider）。 */
export async function persistSecrets(s: AppSettings): Promise<string[]> {
  const failed: string[] = [];
  const withKey = s.providers.filter((p) => {
    const k = (p.apiKey || '').trim();
    return k && k !== 'null';
  });
  try {
    const { typedRpc } = await import('./rpc-contract');
    for (const p of withKey) {
      // withKey 过滤保证 apiKey 非空；双重守卫防漏
      const rawKey = p.apiKey;
      if (!rawKey) continue;
      const key = rawKey.trim();
      // 「null」字面量护栏：毒化残留的 apiKey:"null" 绝非真 key，绝不写入凭据库
      try {
        await typedRpc('credential_store', { provider: p.name, key });
      } catch (e) {
        // 雷区地图 P0-7：写失败必须上抛给 UI——「失败报已保存」会让用户重启丢 key
        console.warn(`[settings] credential_store(${p.name}) 失败:`, e);
        failed.push(p.name);
      }
    }
    // Phase C（2026-08-24）：写穿失效凭据内存缓存——live provider 每请求按名
    // 现解析（provider/credentials.ts），不失效则保存后仍读到旧值。动态 import
    // 防环（credentials → settings 静态依赖，此处反向只可运行时引）。
    const { invalidateCredentialCache } = await import('./provider/credentials');
    for (const p of withKey) invalidateCredentialCache(p.name);
  } catch (e) {
    console.warn('[settings] bridge 不可用，凭据未落盘:', e);
    failed.push(...withKey.map((p) => p.name));
  }
  return failed;
}

/** 删除指定 provider 的 API Key from 系统加密存储（DPAPI）。
 *  调用时机：保存「删除 Provider」或「清除已保存 Key」的暂存操作时。 */
export async function removeSecret(providerName: ProviderId): Promise<void> {
  try {
    const { typedRpc } = await import('./rpc-contract');
    await typedRpc('credential_delete', { provider: providerName });
    // Phase C：写穿失效凭据缓存（同 persistSecrets——见上注释）
    const { invalidateCredentialCache } = await import('./provider/credentials');
    invalidateCredentialCache(providerName);
  } catch {
    /* 无加密存储或 Key 未找到 — 非关键 */
  }
}

/** 解析 rpc 返回值中的字符串。rpc 返回 JSON 编码字符串（`"sk-xxx"` 或 `null`），
 *  调用方普遍需 JSON.parse；此处兼容两种形态：
 *  - `"sk-xxx"`（JSON 编码）→ 解析出 `sk-xxx`
 *  - `sk-xxx`（纯字符串，未来 Tauri 行为变化）→ 原样返回
 *  - `null` / 非法 JSON → null
 *  ⚡ 2026-08-08「null 复活」修复：凭据库里被写入过字面量 "null" 的 key 时，
 *  rpc 返回 `"null"`（带引号）——parse 后仍是字符串 "null"，必须按 null 处理，
 *  否则它会被当成真 key 回填并重新写回凭据库，删不掉。 */
export function parseRpcString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === 'null' || trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'string') return null;
    // 解析结果是字面量 "null"/空串 —— 同样是「无 key」，不是合法 key
    if (parsed.trim() === 'null' || parsed.trim() === '') return null;
    return parsed;
  } catch {
    return trimmed;
  }
}

/** 从系统加密存储恢复 API Key（仅填充 apiKey 为空的 provider）。loadSettings 后用。 */
export async function restoreSecrets(s: AppSettings): Promise<AppSettings> {
  try {
    const { typedRpc } = await import('./rpc-contract');
    for (const p of s.providers) {
      if (!p.apiKey || p.apiKey.trim() === '') {
        try {
          const stored = await typedRpc('credential_get', { provider: p.name });
          const key = parseRpcString(stored);
          // 长度护栏：>4096 的「key」必是编码 bug 毒值（2026-08-08 事故：128MiB 毒值
          // 经 IPC 回传 256MB 响应击毁 WebView2）——拒收，按无 key 处理
          if (key?.trim() && key.length <= 4096) {
            p.apiKey = key.trim();
          }
        } catch {
          /* 无加密存储或解密失败 */
        }
      }
    }
  } catch {
    /* 动态导入失败 — 继续使用仅 localStorage 的设置 */
  }
  // ⚡ 2026-08-04：不再 saveSettings 回写 — apiKey 权威在加密凭据，
  // 不允许把恢复出的密钥落回 localStorage 明文。
  return s;
}

/** 读取设置并从系统加密凭据回填 API Key —— 读取「含密钥设置」的唯一入口。
 *  需要 apiKey 的调用方（provider 构建 / 测试连接 / 翻译器等）一律用它，
 *  禁止自行拼接 loadSettings() + restoreSecrets()。 */
export async function loadSettingsWithSecrets(): Promise<AppSettings> {
  return restoreSecrets(loadSettings());
}

export function getActiveProvider(s: AppSettings): ProviderSettings {
  const active = s.providers.find((p) => p.name === s.activeProvider);
  // D1（2026-08-27）：providers 空表兜底——localStorage 腐坏（providers:[] 覆盖
  // DEFAULTS）时此处曾返回 undefined，消费点（_buildProvider 等）拿 .name 直接
  // TypeError。回落出厂首行，宁可指向可修复的默认也不崩。
  return active ?? s.providers[0] ?? DEFAULTS.providers[0];
}

export function updateProvider(s: AppSettings, name: string, patch: Partial<ProviderSettings>): AppSettings {
  return {
    ...s,
    providers: s.providers.map((p) => (p.name === name ? { ...p, ...patch } : p)),
  };
}

export function addProvider(s: AppSettings, name: ProviderId, kind: Protocol): AppSettings {
  if (s.providers.find((p) => p.name === name)) {
    throw new Error(`提供方 "${name}" 已存在`);
  }
  const baseUrl = defaultBaseUrl(name, kind);
  return {
    ...s,
    activeProvider: name,
    providers: [
      ...s.providers,
      {
        kind,
        name,
        apiKey: '',
        baseUrl,
        model: '',
      },
    ],
  };
}

export function removeProvider(s: AppSettings, name: string): AppSettings {
  const idx = s.providers.findIndex((p) => p.name === name);
  if (idx < 0) throw new Error(`提供方 "${name}" 不存在`);
  if (s.providers.length <= 1) throw new Error('至少保留一个提供方');
  const next = s.providers.filter((p) => p.name !== name);
  const active = s.activeProvider === name ? next[0].name : s.activeProvider;
  return { ...s, activeProvider: active, providers: next };
}

// ---- 定价（每百万 token）----

/** 解析显示定价：优先模型目录（权威 USD 数据），读不到才回退硬编码。 */
export function defaultPricing(kind: Protocol, model: string) {
  const m = getModel(model);
  if (m?.cost && m.cost.input > 0) {
    return { cache_hit: m.cost.cacheRead, input: m.cost.input, output: m.cost.output, currency: '$' };
  }
  if (kind === 'anthropic') {
    // Claude Sonnet 4 定价
    return { cache_hit: 0.3, input: 3, output: 15, currency: '$' };
  }
  if (model.includes('deepseek')) {
    return { cache_hit: 0.14, input: 2.0, output: 8.0, currency: '¥' };
  }
  // OpenAI 默认
  return { cache_hit: 2.5, input: 5, output: 15, currency: '$' };
}

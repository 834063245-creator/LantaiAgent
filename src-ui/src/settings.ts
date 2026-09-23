// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Settings — API Key 管理、模型选择、provider 配置
// 存储在 localStorage 中，在可用时由 Tauri store 插件支持

import { ANTHROPIC_DEFAULT_BASE_URL } from './provider/anthropic';
import { getCatalogVendors, getDefaultModel, getModel } from './provider/catalog';
import type { ModelMeta } from './provider/model-meta';
import type { StoredThinking, ThinkingEffort } from './provider/thinking';
import type { CoreProtocol, ModelDescriptor, Protocol } from './provider/types';
import { findVendorTemplate, VENDOR_TEMPLATES } from './provider/vendor-templates';

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
  /** 登录方式（provider-refactor 方案乙 Phase 3D）：缺省/缺字段 = 'api-key'
   *  （零迁移——旧存储无此字段走 API Key 输入）；'oauth' = 系统 OAuth 订阅
   *  登录（grant 存 Rust oauth 平面，请求注入 Bearer + account 头）。 */
  authMode?: 'api-key' | 'oauth';
  /** authMode='oauth' 时的 src-tauri oauth provider 注册表 id（如 codex）。
   *  请求注入面的 account 选择：多账号时取最近登录的 grant（见 oauth.ts）。 */
  oauthProvider?: string;
  thinking?: StoredThinking; // 领域词 ThinkingPolicy；存储字段名保持 thinking（遗留名）
  lastTest?: ConnectionProbe; // 存储字段名保持 lastTest（遗留名）；领域词 ConnectionProbe
  /** 该提供方「可用模型」id 列表 = **用户启用的模型**——创作坞下拉的可选面
   *  （DSH routable 列表的前端配置形态）。与 model（默认模型）解耦：同一提供方
   *  可挂多个模型，会话级在列表内切换；缺省/空 = 视为 [model]（旧数据零迁移）。
   *  ⚡ 2026-09-23 provider 配置面三层重构：本字段**不再由「从 API 拉取」直接填充**
   *  ——拉取只更新 `catalog`（目录快照），启用集由用户在目录里勾选（写这里）。
   *  旧存档（models = 拉取并集）语义不变：它们就是「全部已启用」，零迁移。 */
  models?: string[];
  /** 模型**目录**快照 = 最近一次「从 API 拉取」拿到的模型 id 全量列表（含端点
   *  未披露任何元数据的条目——故不能只靠 modelMeta 的键复原）。与 `models`
   *  （启用集）分工：目录是只读远端事实，启用集是用户选择。
   *  缺省/空 = 从未拉取过目录（旧存档零迁移：启用集照常可用，只少一个可勾选面）。 */
  catalog?: string[];
  /** per-model 覆盖（P14 替代旧的 per-provider 单字段 contextWindow/maxTokens——
   *  多模型时代按 Provider 管一个值毫无意义）。键 = 模型 id；0/缺省 = 用目录值。
   *  workspace._contextWindowFor 与 createProvider → buildRequest → clampMaxTokens 消费。 */
  modelOverrides?: Record<string, ModelOverrides>;
  /** per-model 的 API 拉取元数据缓存（provider-model-meta，2026-09-11）——
   *  「从 API 拉取」时由适配器的宽容解析层（provider/model-meta.parseModelEntry）
   *  写入，随后**持久化**。解析链第二优先层（低于 modelOverrides 的用户手改，
   *  高于静态目录 seed）：聚合网关/自定义端点在静态目录里没有条目，此前拉取只
   *  留下 id 列表，元数据（上下文窗口/视觉/推理）随进程消失——99% 的模型只能
   *  吃「目录无值」的 200K 假默认。键 = 模型 id。 */
  modelMeta?: Record<string, ModelMeta>;
  /** 自定义请求头（2026-09-17）：网关怪癖的用户可编辑面——如 OpenCode GO 强制
   *  的 `x-opencode-session`。三方言（openai/anthropic/responses）请求一律携带；
   *  合并序固定「自定义头在前、内核必需头与凭据头在后」，故自定义头不能覆写
   *  Authorization / x-api-key（单一权威源 = 凭据库）。校验与清洗见
   *  provider/custom-headers.ts（写入边界严格、加载边界容忍毒化）。 */
  headers?: Record<string, string>;
}

/** 单模型的 P14 覆盖：目录数据 stale / 目录外自定义模型时的纠正。 */
export interface ModelOverrides {
  /** 上下文窗口（token 数）；0/缺省 = 用目录值（目录无 = 默认 200K）。 */
  contextWindow?: number;
  /** 最大输出 token；0/缺省 = 用目录值（目录无 = 不钳制）。 */
  maxTokens?: number;
  /** 输入模态覆盖（B5 · D-8①，multimodal-image-plan）：['text','image'] = 视觉
   *  模型（附图入口开 + 请求期图投影放行）；缺省 = 用目录声明；目录亦无 =
   *  ['text']（不编造能力）。GLM-4V/Qwen-VL 等目录外 vision 模型在此补声明。 */
  input?: ('text' | 'image')[];
  /** 思考档位覆盖（2026-09-23 思考下沉）：缺省 = 用提供方行值（`ProviderSettings
   *  .thinking`，语义 = 本家默认档位）；显式写入 = 本模型自己的档位（'' 也是显式值
   *  ——「自动」是真实选择，不是缺省）。消费面 = `modelThinking` 一把尺子
   *  （live provider 请求期 / 设置页参数面板 / 创作坞 pill）。 */
  thinking?: StoredThinking;
}

/** 解析某提供方的「可用模型」id 列表：显式 models 优先，缺省回落 [model]
 *  （旧存档无 models 字段 = 只有一个默认模型，零迁移）。 */
export function effectiveModels(p: ProviderSettings): string[] {
  const list = Array.isArray(p.models) && p.models.length > 0 ? p.models.filter((m) => m?.trim()) : [];
  if (list.length > 0) return list;
  return p.model?.trim() ? [p.model.trim()] : [];
}

/** 某模型生效的上下文窗口（provider-model-meta 2026-09-11 四层链）：
 *  用户覆盖 ?? API 拉取元数据 ?? 静态目录 seed ?? 默认（200K）。
 *  中间层的意义：聚合网关/自定义端点在静态目录里没有条目，窗口此前一律吃
 *  200K 假默认（实测某网关 69 个模型真实窗口 200K～1.05M 全被压成 200K，
 *  自动压缩阈值因此全错）。 */
export function modelContextWindow(p: ProviderSettings, modelId: string, fallback = 200000): number {
  const ov = p.modelOverrides?.[modelId]?.contextWindow;
  if (ov && ov > 0) return ov;
  const meta = p.modelMeta?.[modelId]?.contextWindow;
  if (meta && meta > 0) return meta;
  return getModel(modelId)?.contextWindow || fallback;
}

/** 某模型生效的最大输出 token（同四层链；末层 0 = 不钳制）。
 *  （clampMaxTokens 内部另有目录兜底，此处返回 per-model 覆盖优先值。） */
export function modelMaxTokens(p: ProviderSettings, modelId: string): number {
  const ov = p.modelOverrides?.[modelId]?.maxTokens;
  if (ov && ov > 0) return ov;
  const meta = p.modelMeta?.[modelId]?.maxTokens;
  if (meta && meta > 0) return meta;
  return getModel(modelId)?.maxTokens || 0;
}

/** 某模型生效的输入模态（四层链：覆盖 ?? 拉取元数据 ?? 目录声明 ?? ['text']）。
 *  消费面 = createProvider 能力戳（请求期图投影）+ 创作坞附图门禁 + ModelSelector
 *  徽标——三面同链（覆盖一处声明即三面生效）。provider 缺省（未配置厂商）=
 *  只查目录（目录外自定义模型恒 ['text']——除非有拉取元数据或覆盖）。 */
export function modelInput(p: ProviderSettings | undefined, modelId: string): ('text' | 'image')[] {
  const ov = p?.modelOverrides?.[modelId]?.input;
  if (ov && ov.length > 0) return [...ov];
  const meta = p?.modelMeta?.[modelId]?.input;
  if (meta && meta.length > 0) return [...meta];
  return getModel(modelId)?.input ?? ['text'];
}

/** 某模型是否支持推理/思考（拉取元数据 ?? 目录声明；皆无 = undefined 未知）。
 *  未知不编造——UI 不据此显示任何能力徽标。 */
export function modelReasoning(p: ProviderSettings | undefined, modelId: string): boolean | undefined {
  return p?.modelMeta?.[modelId]?.reasoning ?? getModel(modelId)?.reasoning;
}

/** 某模型声明的思考档位（拉取元数据 ?? 目录声明；皆无 = undefined）。
 *  现实：当前主流端点均不披露档位清单——缺省即「无声明」，UI 不显示档位选择器、
 *  请求不发 effort 参数（P14 能力协商）。 */
export function modelThinkingEfforts(
  p: ProviderSettings | undefined,
  modelId: string,
): readonly ThinkingEffort[] | undefined {
  return p?.modelMeta?.[modelId]?.thinkingEfforts ?? getModel(modelId)?.thinkingEfforts;
}

/** 某模型生效的思考档位**值**（与 modelThinkingEfforts 的**能力**面对偶，
 *  2026-09-23 思考下沉）：per-model 覆盖 ?? 提供方行值（行值 = 本家默认档位，
 *  没单独设置过的模型用它）。会话级覆盖（compose-store 的创作坞 pill）优先级
 *  更高，在消费点另行解析——本函数是「设置面 / 请求面 / 显示面」共用的同一把尺子
 *  （live provider 请求期、设置页参数面板、创作坞 pill）。
 *  '' 是显式值（「自动」= 不发 effort 参数），与「无覆盖」区分。 */
export function modelThinking(p: ProviderSettings | undefined, modelId: string): StoredThinking | undefined {
  const ov = p?.modelOverrides?.[modelId]?.thinking;
  if (ov !== undefined) return ov;
  return p?.thinking;
}

/** 拉取元数据与静态目录 seed + 用户覆盖合并成完整 ModelDescriptor——
 *  方言请求期（thinkingCapability / clampMaxTokens）读它而非全局 getModel，
 *  使 provider 级的拉取元数据与覆盖真正抵达 wire 层。
 *  seed 与 meta 皆无 = undefined（调用面落回「目录外模型」语义，不编造）。
 *  kind/vendor/baseUrl 由连接配置补齐（provider 名即 vendor，见 ModelSelector
 *  「写错家 400」同族纪律）。 */
export function modelDescriptor(p: ProviderSettings, modelId: string): ModelDescriptor | undefined {
  const seed = getModel(modelId);
  const meta = p.modelMeta?.[modelId];
  if (!seed && !meta) return undefined;
  const input = modelInput(p, modelId);
  const contextWindow = modelContextWindow(p, modelId, 0);
  const maxTokens = modelMaxTokens(p, modelId);
  const reasoning = modelReasoning(p, modelId);
  const thinkingEfforts = modelThinkingEfforts(p, modelId);
  return {
    id: modelId,
    name: meta?.name ?? seed?.name ?? modelId,
    kind: p.kind,
    vendor: p.name,
    baseUrl: p.baseUrl || seed?.baseUrl || '',
    reasoning: reasoning ?? false,
    input: [...input],
    contextWindow,
    maxTokens,
    ...(thinkingEfforts !== undefined ? { thinkingEfforts } : {}),
    ...(seed?.thinkingOff !== undefined ? { thinkingOff: seed.thinkingOff } : {}),
    ...(seed?.deepseekThinking !== undefined ? { deepseekThinking: seed.deepseekThinking } : {}),
  };
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

// （图谱引擎设置 graphEngine/graphEngineEnabled 随图谱全量退役删除，
//  2026-09-09——旧存储残留的 graphEngine 节由 loadSettings 展开自然荒废。）

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

/** 画布设置（可选——旧存储无此节 = 平滚，canvasWheelMode 容错读取）。
 *  2026-09-08 缩放舒适度拍板：滚轮裸操作给「平滚视角」或「缩放画布」二选一
 *  （Miro 派 vs Whimsical 派），另一操作恒有 Ctrl+滚轮 + 顶部浮件缩放控件兜底。
 *  2026-09-17 边缘滚动立为原生功能：拖拽手势贴视口四缘自动滚屏的开关 + 灵敏度。
 *  **行为真源在插件域**（`plugins/builtin/paper-shell/edge-scroll.ts`——基准带宽/限速、
 *  灵敏度映射、缺省容错都在那里；本字段只是持久化载体）。故此处不设缺省值：旧存储
 *  无此字段 = 读侧兜底为「开 + 基准灵敏度」，与面板显示口径一致。 */
export interface CanvasSettings {
  /** 滚轮行为：'pan' = 平滚视角（默认）；'zoom' = 缩放画布。 */
  wheelMode: 'pan' | 'zoom';
  /** 边缘滚动（拖拽手势贴边自动平移视口）：enabled = 总开关，sensitivity = 灵敏度倍率，
   *  hover = 悬停即滚（指针停在边缘就滚，不必先按住东西；缺省关——见 edge-scroll.ts 注）。
   *  缺省 = 开 + 1.0 + 悬停关（读侧容错，见上注）。 */
  edgeScroll?: { enabled: boolean; sensitivity: number; hover?: boolean };
}

/** 读取画布滚轮行为（缺省容错：旧存储无此节/未知值 = 平滚视角）。 */
export function canvasWheelMode(s: AppSettings): 'pan' | 'zoom' {
  return s.canvas?.wheelMode === 'zoom' ? 'zoom' : 'pan';
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
  /** 更新器设置（可选——旧存储无此节 = 自动检查开，autoUpdateCheckEnabled 容错读取）。 */
  updates?: UpdateSettings;
  /** 画布设置（可选——旧存储无此节 = 平滚视角，canvasWheelMode 容错读取）。 */
  canvas?: CanvasSettings;
}

const STORAGE_KEY = 'hologram_settings';

/** 协议（kind）→ 默认 Base URL。字面量的唯一事实源——
 *  ⚡ provider-refactor Phase 1A：收窄到内核两族（Protocol 已开放，闭合 Record
 *  只覆盖内核；未知 kind 回落链见 defaultBaseUrl——模板表跳过后协议未命中
 *  时返回 undefined，由调用方决定（新增未知协议不静默给错端点）。 */
export const PROVIDER_PROTOCOL_DEFAULTS: Record<CoreProtocol, string> = {
  anthropic: ANTHROPIC_DEFAULT_BASE_URL,
  openai: 'https://api.openai.com/v1',
};

/** provider 默认 Base URL 回落链（三级）：
 *  ① vendor 连接模板表（vendor-templates.ts —— 出厂厂商连接参数真源）；
 *  ② catalog seed 默认模型（内核 seed JSON —— 模板表外的自定义厂商仍可命中目录）；
 *  ③ 内核协议默认端点（PROVIDER_PROTOCOL_DEFAULTS）。
 *  三级皆未命中（未知 kind 且无目录无模板）= undefined——调用方自行决策，
 *  不静默给错端点（错误不静默宪法）。 */
export function defaultBaseUrl(name: string, kind: ProviderSettings['kind']): string | undefined {
  const tpl = findVendorTemplate(name);
  if (tpl?.baseUrl) return tpl.baseUrl;
  return getDefaultModel(name)?.baseUrl ?? PROVIDER_PROTOCOL_DEFAULTS[kind as CoreProtocol];
}

/** 是否仍是「出厂默认」Base URL（协议默认、模板默认或目录厂商默认）——
 *  设置面板模型切换时的 baseUrl 自动填充判定（用户自定义过就不覆盖）。 */
export function isFactoryBaseUrl(url: string): boolean {
  const defaults = new Set<string>(Object.values(PROVIDER_PROTOCOL_DEFAULTS));
  for (const tpl of VENDOR_TEMPLATES) {
    if (tpl.baseUrl) defaults.add(tpl.baseUrl);
  }
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
      baseUrl: defaultBaseUrl('deepseek', 'openai') ?? 'https://api.deepseek.com/v1',
      // 出厂默认模型（2026-09-18 随官方改名刷新）：deepseek-flash = 现役
      // DeepSeek V4.1 Flash（原生多模态，官方推荐款）；旧名 deepseek-v4-pro
      // 仍在目录中可选用。
      model: 'deepseek-flash',
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
  updates: {
    autoCheck: true,
  },
  canvas: {
    wheelMode: 'pan',
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
          // 2026-09-01 审计：元素级校验——[null]/["x"] 腐坏条目此前能穿过空数组
          // 护栏，后续 find((p) => p.name) 直接 TypeError。非 {name:string} 剔除。
          parsed.providers = parsed.providers.filter(
            (p: unknown) => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string',
          );
          for (const p of parsed.providers) {
            if (p && typeof p.apiKey === 'string' && p.apiKey.trim() === 'null') {
              p.apiKey = '';
            }
            // P14 遗留死字段清理（2026-09-11）：per-provider contextWindow/maxTokens
            // 已拆为 per-model modelOverrides——旧存储里的值**读都不读**（多模型
            // 时代按 Provider 管一个值是错语义），加载时即归档清掉，下次保存落回
            // 干净状态（同上方 apiKey "null" 清洗惯例）。
            if (p && typeof p === 'object') {
              delete (p as { contextWindow?: unknown }).contextWindow;
              delete (p as { maxTokens?: unknown }).maxTokens;
              // ⚡ 2026-09-24 配方改文件批：headers/catalog 等**意图字段**的权威已迁
              // `~/.lantai/providers.yml`，这里不再逐字段清洗——旧存档整行只当
              // 「运行态读数的壳」，意图由 provider-store 投影覆盖（未启用文件权威
              // 时=测试与降级路径，走的是旧语义）。
            }
          }
        }
        // D1：providers 空数组 = 腐坏存储——回落出厂 provider 表（否则
        // getActiveProvider 兜底链每天都在边缘行走）
        if (!Array.isArray(parsed?.providers) || parsed.providers.length === 0) {
          parsed.providers = DEFAULTS.providers;
        }
        const merged = { ...DEFAULTS, ...parsed };
        return prefersFileProviders() ? { ...merged, providers: fileProvidersProjection(merged.providers) } : merged;
      }
    }
  } catch {
    // 设置损坏，使用默认值
  }
  const fallback = { ...DEFAULTS };
  return prefersFileProviders() ? { ...fallback, providers: fileProvidersProjection(fallback.providers) } : fallback;
}

// ── provider 意图 → 文件；运行态 → localStorage（2026-09-24 配方改文件批）─────
//
// ⚡ 权威三分（互不重叠，各自只有一处权威）：
//   1. **意图**（kind/baseUrl/模型/请求头/覆盖/档位）→ `~/.lantai/providers.yml`
//      （人可手写、agent 可读写、改动约 1 秒热生效）；见 `provider/providers-store.ts`。
//   2. **密钥** → 系统加密凭据（`persistSecrets` / `restoreSecrets`，权威不变）。
//   3. **运行态读数**（连接探针结果 / 模型目录快照）→ 本文件的 localStorage
//      投影（那是本机读数，不是用户意图——照 DSH `settings-file`「文件里只放
//      用户层」的同一分工，不进配置文件）。
//
// 这里是**投影口**：provider 意图由 provider-store 持有内存投影，loadSettings
// 在读取边界把它合上来。这样「文件改了 → 全应用即时看到」不需要改几十个
// `loadSettings()` 调用点，也不会在打字/滚轮热路径上做文件 IO
// （`onSettingsSaved` 订阅方在文件变更后照常重读）。

/** localStorage 只承载 provider 的**运行态读数**（意图在文件里）。 */
export type ProviderRuntime = Pick<ProviderSettings, 'apiKey' | 'lastTest' | 'catalog'>;

/** provider 文档投影口（由 provider-store 在 boot 期注入；缺省 = 未启用文件权威）。 */
interface ProvidersProjection {
  /** 文件里的 provider（顺序 = 文件键序）合上运行态读数。 */
  rows(fallback: ProviderSettings[]): ProviderSettings[];
}

let providersProjection: ProvidersProjection | null = null;

/** 装配投影口（provider-store 调用一次；boot 期先于一切 provider 消费）。 */
export function installProvidersProjection(p: ProvidersProjection | null): void {
  providersProjection = p;
}

/** 是否已启用文件权威（未装配时按旧语义走 localStorage——测试与降级路径）。 */
function prefersFileProviders(): boolean {
  return providersProjection !== null;
}

function fileProvidersProjection(fallback: ProviderSettings[]): ProviderSettings[] {
  return providersProjection ? providersProjection.rows(fallback) : fallback;
}

/** 读某 provider 的运行态读数（文件权威下 localStorage 里只留这些）。 */
export function providerRuntimeOf(name: string): ProviderRuntime {
  const row = loadSettings().providers.find((p) => p.name === name);
  return { apiKey: row?.apiKey ?? '', lastTest: row?.lastTest, catalog: row?.catalog };
}

/**
 * localStorage 里**原样躺着**的 provider 行（不经文件投影）。
 *
 * 2026-09-24 配方改文件批的迁移专用口：首次启动时配置文件还不存在，而意图还躺在
 * 旧存档里——迁移必须读**未投影**的存量（loadSettings 在文件权威下会拿文件投影，
 * 空文件 = 空行表，用它做迁移源会把存量整份丢掉）。
 */
export function storedProviderRows(): ProviderSettings[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { providers?: unknown };
    if (!Array.isArray(parsed?.providers)) return [];
    return parsed.providers.filter(
      (p): p is ProviderSettings => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string',
    );
  } catch {
    return [];
  }
}

export function saveSettings(s: AppSettings): void {
  if (typeof localStorage !== 'undefined') {
    // ⚡ 2026-08-04 状态治理：apiKey 不落 localStorage 明文。
    // 唯一权威 = 系统加密凭据（persistSecrets / restoreSecrets）；
    // localStorage 只存非敏感配置。provider 配置结构保留，仅抹空密钥字段。
    // ⚡ 2026-09-24 配方改文件批：provider 的**意图**也一并剥掉（权威在
    // `~/.lantai/providers.yml`）——localStorage 只留运行态读数，否则
    // 「文件已删掉某行、localStorage 还留着」会造出第二份真相。
    const sanitized: AppSettings = {
      ...s,
      providers: s.providers.map(
        (p) =>
          ({
            name: p.name,
            apiKey: '',
            ...(p.lastTest !== undefined ? { lastTest: p.lastTest } : {}),
            ...(p.catalog !== undefined ? { catalog: p.catalog } : {}),
          }) as ProviderSettings,
      ),
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

/** 从系统加密存储恢复 API Key（仅填充 apiKey 为空的 provider）。loadSettings 后用。
 *  P0-2 优化（2026-09-02）：N 个 provider 的 credential_get 从串行改并行——
 *  Windows DPAPI 解密是独立的文件读+解密，互相无依赖；串行 N 次 = N×(IPC+DPAPI)，
 *  并行 = max(单次)。长度护栏与失败容忍语义不变。 */
export async function restoreSecrets(s: AppSettings): Promise<AppSettings> {
  try {
    const { typedRpc } = await import('./rpc-contract');
    const needKey = s.providers.filter((p) => !p.apiKey || p.apiKey.trim() === '');
    if (needKey.length > 0) {
      const keys = await Promise.all(
        needKey.map(async (p) => {
          try {
            const stored = await typedRpc('credential_get', { provider: p.name });
            const key = parseRpcString(stored);
            // 长度护栏：>4096 的「key」必是编码 bug 毒值（2026-08-08 事故：128MiB 毒值
            // 经 IPC 回传 256MB 响应击毁 WebView2）——拒收，按无 key 处理
            if (key?.trim() && key.length <= 4096) return key.trim();
            return null;
          } catch {
            /* 无加密存储或解密失败 */
            return null;
          }
        }),
      );
      needKey.forEach((p, i) => {
        if (keys[i]) p.apiKey = keys[i];
      });
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
        // 模板/目录命中 = 出厂默认端点；未知协议无模板 = 空串（两步式添加的
        // onAdd 随后会带真实 baseUrl 覆盖；直接 addProvider 时需手填）。
        baseUrl: baseUrl ?? '',
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider 配方文档（2026-09-24 配方改文件批）——**一份 YAML 文件统管所有 provider
// 的非敏感连接配置**：`~/.lantai/providers.yml`。人和 agent 都能直接读写它。
//
// 为什么不是「导出/导入两个动作」（本批要根治的病灶）：
//   - 导出/导入把配置做成了**剪贴板里的一段 JSON**——没有落点、不能 diff、不能进 git、
//     agent 碰不到，每次分享/复用都要人来回复制粘贴；
//   - 一份文件则是：复制文件 = 导入，文件本身就是导出，agent 用 fs 工具直接改。
//
// 与设置页/存储的分工（照 DSH `settings-file` 的「一份用户可编辑文档 + 用户层覆盖」）：
//   - **本文件 = 用户意图的权威源**（kind / baseUrl / 可用模型 / 请求头 / 覆盖 / 档位）；
//   - 系统凭据库 = 密钥权威（apiKey 永不进本文件——写进去就是明文落盘）；
//   - localStorage = 运行态权威（lastTest 探针结果 / catalog 目录快照）——那是 app
//     自己的读数，不是用户意图，不进文件（DSH 同款：文件里只放用户层）。
//
// 数据流向（人机双向）：
//   人改文件 → Rust watcher（providers:changed）→ 重读 → 解析 → 装配面即时生效
//   UI 保存  → 本模块 leaf-diff 写文件（**保住手写注释与排版**）→ 上面那条路收回
//
// 校验纪律（照 DSH「boot fails loud, reload keeps last good」并落到本仓库语义）：
//   - **逐节校验**：单个 provider 节出错只影响该节（设置页点名报错、该节回落上次可用值），
//     其余节照常生效——手写文件的迭代性决定了不能「一处写错整份作废」；
//   - **整份解析失败**：保留上次可用文档 + 报错，且**拒绝写盘**（绝不覆盖用户手稿）；
//   - 未知字段/密钥字段/身份不符 = 该节点名报错（不静默丢弃——错误不静默）。

import { Document, isMap, parseDocument, type YAMLMap, type Node as YamlNode } from 'yaml';
import type { ProviderId, ProviderSettings } from '../settings';
import { type HeaderEntry, headerEntryError, MAX_CUSTOM_HEADERS } from './custom-headers';
import type { ModelMeta } from './model-meta';
import { THINKING_EFFORTS, type ThinkingEffort, type ThinkingLevelMap } from './thinking';
import { CORE_PROTOCOLS } from './types';

/** 配置文件里一节 provider 的全部字段（= 用户意图；身份在键名里）。
 *
 *  ⚡ 2026-11-16 本机读数迁出批：`modelMeta`（API 拉取回来的模型元数据缓存）也在这里
 *  被剥掉了。实测真机上它占配置文件的 **87%**（15642 字节里 12838 字节），是每次
 *  刷新目录都会被重写的自动生成内容——把它当「用户意图」写进人手写的文件，等于让
 *  一个每天自动生成的大块数据去承担手写错误的爆炸半径：真机事故（2026-11-16）
 *  就是一行 `input: [audio]` 打死了 359 行、84 条元数据的整节。运行态读数与
 *  `lastTest` / `catalog` 同类，回 localStorage。 */
export type ProviderIntent = Omit<
  ProviderSettings,
  'name' | 'apiKey' | 'model' | 'lastTest' | 'catalog' | 'modelMeta' | 'lastThinking'
>;

/** 解析成功的一节：身份（键名）+ 意图。 */
export interface ProviderSection {
  name: ProviderId;
  intent: ProviderIntent;
  /** **字段级**警告：这一节可用，但某个字段的值写错了、已按缺省处理
   *  （坏字段只丢字段——整节不因一处笔误而消失）。 */
  warnings: string[];
  /** 文件里遗留的 `model`（2026-11-30 R5：已从意图面退役）。
   *  `model` 是「最近使用」运行态读数；旧文件里的值只用于一次性迁移，
   *  装载时收进本机运行态，下次写盘从文件里消失。 */
  legacyModel?: string;
  /** 文件里遗留的 `modelMeta`（本机读数，已不在意图面）。
   *  只用于一次性迁移：装载时收进运行态、下次写盘从文件里消失。 */
  legacyModelMeta?: Record<string, ModelMeta>;
}

/** 一节的身份/字段错误（设置页点名报错用；坏节回落上次可用值）。 */
export interface SectionError {
  /** provider 身份（键名）。 */
  name: string;
  /** 人可读原因（多条换行拼接）。 */
  message: string;
}

/** 整份文档的解析结果（**永不抛**——解析失败也是一种结果，调用方决定回落/拒绝写盘）。 */
export interface ProvidersDoc {
  /** 逐节解析成功的意图（顺序 = 文件里的键序）。 */
  sections: ProviderSection[];
  /** **整节**不可用（身份非法 / 不是映射 / 缺 kind / 缺 baseUrl）——这一节没进行表，
   *  由装载方按「上一次可用」回落。 */
  errors: SectionError[];
  /** **字段级**问题：这一节在 sections 里照常生效，只是这些字段被按缺省处理。 */
  warnings: SectionError[];
  /** 文件里所有顶层键的原始顺序（含读不出来的坏节）——行表按它排，
   *  坏节回落上一次可用时仍回到它原本的位置。 */
  order: string[];
  /** 整份不可用（YAML 语法错 / 根不是映射）——此时 sections 为空，装载方保留
   *  上一次可用的整份文档。 */
  fatal?: string;
}

/** 文档里**不属于**用户意图的保留键（写进来必定是写错了——点名报错，不静默丢弃）。 */
const RUNTIME_ONLY_KEYS: readonly { key: string; why: string }[] = [
  { key: 'apiKey', why: '密钥永不进本文件（明文落盘会被误分享）——请到设置页「API Key」栏填写，权威在系统凭据库' },
  { key: 'model', why: '「最近使用」是本机运行态读数、不进配置——创作坞切模型时自动记；新卷默认跟从它' },
  { key: 'lastTest', why: '连接探针结果是本机读数、不进配置（本文件是用户意图）' },
  { key: 'catalog', why: '模型目录快照是本机读数、不进配置（设置页「刷新目录」拉取）' },
  { key: 'modelMeta', why: '模型元数据是「刷新目录」拉取回来的本机读数、不进配置（2026-11-16 起只在本机存储）' },
  { key: 'lastThinking', why: '「该模型上次用过的思考档位」是本机阅读记忆（创作坞拨档位自动记）、不进配置' },
];

/** provider 身份围栏（键名即身份：凭据键 + 目录合并键三合一）——同 AddProviderSheet。 */
export const PROVIDER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** 文件头（人手写的第一眼读物；写盘时留在文件顶部）。 */
export const PROVIDERS_DOC_HEADER = [
  '兰台 provider 连接配置——人和 agent 都直接改这个文件，改完即时生效（约 1 秒）。',
  '',
  '· 一行 provider = 一个顶层键，键名就是 provider 身份（字母/数字/下划线/连字符）。',
  '· 这里只放**非敏感**连接配置；密钥（apiKey）权威在本机系统凭据库，不写在这里。',
  '· 本机读数（最近使用模型、连接探针、模型目录快照、模型元数据）也不在这里，它们只活在本机存储。',
  '· 删掉某一节 = 删掉那行 provider（密钥仍留在凭据库，设置页「清除」可一并删）。',
  '· 设置页保存会**按字段**回写本文件，你手写的注释与排版会保留。',
  '',
  '最小例子：',
  '',
  '# my-gateway:',
  '#   kind: openai                                  # 协议：anthropic / openai / responses',
  '#   baseUrl: https://gateway.example.com/v1',
  '#   models: [deepseek-v4.1-flash, claude-opus-4-6] # 可用模型（创作坞下拉的可选面）',
  '#   headers:                                      # 网关怪癖（可选）',
  '#     x-opencode-session: sess-1',
  '#   modelOverrides:                               # 单模型纠正（可选；模型的窗口/视觉声明属这里，',
  '#                                                 #  「刷新目录」拉回来的元数据属本机读数、不写文件）',
  '#     deepseek-v4.1-flash:',
  '#       contextWindow: 1000000',
  '#       maxTokens: 384000',
  '#       reasoningEfforts:                         # 本模型的推理等级（档位 → API 参数值；可选）',
  '#         off: null                               # null = 该档不发送参数',
  '#         high: deep                              # 默认发送档位原名，这里改成厂商要求的值',
].join('\n');

/** 是否本文件格式（扩展名围栏）——只认 .yml / .yaml。 */
export function isProvidersDocPath(path: string): boolean {
  return /\.ya?ml$/i.test(path.trim());
}

/** 由完整行取意图（剥掉非文件字段）——UI 写盘与文件解析共用同一把尺子。 */
export function intentOf(p: ProviderSettings): ProviderIntent {
  const {
    name: _name,
    apiKey: _apiKey,
    model: _model,
    lastTest: _lastTest,
    catalog: _catalog,
    modelMeta: _modelMeta,
    lastThinking: _lastThinking,
    ...intent
  } = p;
  return intent;
}

/** 由意图 + 身份 + 运行态合成完整行（装配面/设置页消费的形态）。 */
export function mergeIntent(
  name: ProviderId,
  intent: ProviderIntent,
  runtime: Pick<ProviderSettings, 'apiKey' | 'lastTest' | 'catalog' | 'modelMeta' | 'lastThinking'> & {
    model?: string;
  },
): ProviderSettings {
  // model = 本机「最近使用」运行态，不是文件意图；空串是合法起始态。
  return { ...intent, name, ...runtime, model: runtime.model ?? '' };
}

/** 读字符串数组字段（缺省 = undefined；非法 = 报错，不静默清洗）。 */
function readStringArray(raw: unknown, field: string, errors: string[]): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !v.trim())) {
    errors.push(`${field} 必须是字符串数组`);
    return undefined;
  }
  return (raw as string[]).map((v) => v.trim());
}

/** 校验请求头字段：非法条目点名报错（不静默丢弃）。 */
function readHeaders(raw: unknown, errors: string[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('headers 必须是「头名 → 头值」的对象');
    return undefined;
  }
  const entries = Object.entries(raw) as [string, unknown][];
  if (entries.length > MAX_CUSTOM_HEADERS) {
    errors.push(`headers 请求头过多（${entries.length} 条，上限 ${MAX_CUSTOM_HEADERS} 条）`);
  }
  const clean: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (typeof value !== 'string') {
      errors.push(`headers「${name}」的值必须是字符串`);
      continue;
    }
    const entry: HeaderEntry = { name, value };
    const reason = headerEntryError(entry);
    if (reason) {
      errors.push(`headers「${name}」：${reason}`);
      continue;
    }
    clean[name.trim()] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** 校验 per-model 自定义推理等级（DSH `reasoningEfforts` 形状）。 */
function readReasoningEfforts(raw: unknown, field: string, errors: string[]): false | ThinkingLevelMap | undefined {
  if (raw === undefined) return undefined;
  if (raw === false) return false;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${field} 必须是「档位 → API 参数值」的对象，或 false（声明该模型不推理）`);
    return undefined;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    errors.push(`${field} 不能是空对象——至少声明一个档位（关闭之外还要有思考档位）`);
    return undefined;
  }
  const out: ThinkingLevelMap = {};
  let thinking = 0;
  for (const [level, value] of entries) {
    if (level !== 'off' && !(THINKING_EFFORTS as readonly string[]).includes(level)) {
      errors.push(`${field} 含未知档位「${level}」（可用：off / ${THINKING_EFFORTS.join(' / ')}）`);
      continue;
    }
    if (level === 'off') {
      if (value === null) {
        out.off = null;
      } else if (typeof value === 'string' && value.trim()) {
        out.off = value.trim();
      } else {
        errors.push(`${field}.off 只能是 null（不发送参数）或非空字符串`);
      }
      continue;
    }
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`${field}.${level} 必须是非空字符串（请求里发送的 API 参数值）`);
      continue;
    }
    out[level as ThinkingEffort] = value.trim();
    thinking++;
  }
  if (thinking === 0) {
    errors.push(`${field} 至少要有一个 off 之外的思考档位（不需要思考请整个字段设为 false）`);
    return undefined;
  }
  return out;
}

/** 校验 per-model 覆盖（只认已知字段；形状不对点名报错）。 */
function readModelOverrides(raw: unknown, errors: string[]): ProviderSettings['modelOverrides'] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('modelOverrides 必须是「模型 id → 覆盖」的对象');
    return undefined;
  }
  const out: NonNullable<ProviderSettings['modelOverrides']> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim() || !value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`modelOverrides「${id}」必须是非空的对象`);
      continue;
    }
    const ov = value as Record<string, unknown>;
    const next: NonNullable<ProviderSettings['modelOverrides']>[string] = {};
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const v = ov[field];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        errors.push(`modelOverrides「${id}」.${field} 必须是非负数字`);
        continue;
      }
      next[field] = v;
    }
    if (ov.input !== undefined) {
      const input = readStringArray(ov.input, `modelOverrides「${id}」.input`, errors);
      if (input) {
        if (input.some((m) => m !== 'text' && m !== 'image')) {
          errors.push(`modelOverrides「${id}」.input 只认 "text" / "image"`);
        } else {
          next.input = input as ('text' | 'image')[];
        }
      }
    }
    // per-model 思考档位随「默认档位」一并退役（2026-11-21）：只在创作坞按会话选。
    if (ov.thinking !== undefined) {
      errors.push(`modelOverrides「${id}」.thinking 已废弃（思考档位只在创作坞按会话选择）——请删除该字段`);
    }
    // per-model 自定义推理等级（2026-10-22 对齐 DSH）：档位 → 请求里发送的 API 参数值。
    if (ov.reasoningEfforts !== undefined) {
      const reasoningEfforts = readReasoningEfforts(
        ov.reasoningEfforts,
        `modelOverrides「${id}」.reasoningEfforts`,
        errors,
      );
      if (reasoningEfforts !== undefined) next.reasoningEfforts = reasoningEfforts;
    }
    out[id] = next;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 校验 per-model 拉取元数据（app 也会写这段——形状错点名报错）。 */
function readModelMeta(raw: unknown, errors: string[]): Record<string, ModelMeta> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('modelMeta 必须是「模型 id → 元数据」的对象');
    return undefined;
  }
  const out: Record<string, ModelMeta> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim() || !value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`modelMeta「${id}」必须是非空的对象`);
      continue;
    }
    const src = value as Record<string, unknown>;
    const fetchedAt = src.fetchedAt;
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) {
      errors.push(`modelMeta「${id}」.fetchedAt 必须是数字（拉取时刻）`);
      continue;
    }
    const meta: ModelMeta = { fetchedAt };
    if (src.name !== undefined) {
      if (typeof src.name !== 'string') errors.push(`modelMeta「${id}」.name 必须是字符串`);
      else meta.name = src.name;
    }
    for (const field of ['contextWindow', 'maxTokens'] as const) {
      const v = src[field];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        errors.push(`modelMeta「${id}」.${field} 必须是正数`);
        continue;
      }
      meta[field] = v;
    }
    if (src.reasoning !== undefined) {
      if (typeof src.reasoning !== 'boolean') errors.push(`modelMeta「${id}」.reasoning 必须是布尔`);
      else meta.reasoning = src.reasoning;
    }
    if (src.thinkingOff !== undefined) {
      if (typeof src.thinkingOff !== 'boolean') errors.push(`modelMeta「${id}」.thinkingOff 必须是布尔`);
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
        if (unknown.length > 0) errors.push(`modelMeta「${id}」.thinkingEfforts 含未知档位：${unknown.join(', ')}`);
        else meta.thinkingEfforts = efforts as ThinkingEffort[];
      }
    }
    if (src.thinkingLevelMap !== undefined) {
      const levelMap = readReasoningEfforts(src.thinkingLevelMap, `modelMeta「${id}」.thinkingLevelMap`, errors);
      if (levelMap === false) {
        errors.push(`modelMeta「${id}」.thinkingLevelMap 必须是「档位 → API 参数值」对象`);
      } else if (levelMap !== undefined) {
        meta.thinkingLevelMap = levelMap;
      }
    }
    out[id] = meta;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 已知协议集合（校验 kind 用）。 */
export interface KnownProtocols {
  /** 该 kind 是否有装配中的适配器（内核两族 + ctx.llm adapter 贡献）。 */
  has(kind: string): boolean;
}

/** 出厂已知协议（无适配器注册表时的兜底：内核两族 + 出厂 responses 方言）。 */
export const FACTORY_PROTOCOLS: KnownProtocols = {
  has: (kind) => kind === 'responses' || (CORE_PROTOCOLS as readonly string[]).includes(kind),
};

/** 单个 provider 节的字段清单（写盘时的字段顺序 = 这份表）。 */
const INTENT_FIELDS = [
  'kind',
  'baseUrl',
  'models',
  'authMode',
  'oauthProvider',
  'oauthAccountId',
  'headers',
  'modelOverrides',
] as const satisfies readonly (keyof ProviderIntent)[];

/** 一节的解析结果：意图能否成立，取决于**身份/连接**是否可判——
 *  其余字段写坏了只降级那个字段（字段级警告），不拖整节下水。 */
export interface ParsedSection {
  intent: ProviderIntent;
  /** 字段级问题：这些字段已按缺省处理，节的其余部分照常生效。 */
  warnings: string[];
  /** 文件里遗留的 `model`（最近使用运行态；迁移用，不再写回文件）。 */
  legacyModel?: string;
  /** 文件里遗留的 `modelMeta`（运行态读数，迁移用；不再写回文件）。 */
  legacyModelMeta?: Record<string, ModelMeta>;
}

/** 这一节**非死不可**的原因（身份/连接层面无法判断它是哪个 provider）：
 *  返回非空 = 整节作废、由装载方按「上一次可用」回落；返回空 = 意图可成立。 */
function fatalSectionErrors(name: string, src: Record<string, unknown> | null, protocols: KnownProtocols): string[] {
  const errors: string[] = [];
  if (!PROVIDER_NAME_RE.test(name)) {
    errors.push(
      `provider 名「${name}」不合法（只允许字母、数字、下划线、连字符）——键名就是 provider 身份，也是系统凭据的键`,
    );
  }
  if (src === null) {
    errors.push('这一节必须是一个键值映射（如 kind / baseUrl / model）');
    return errors;
  }
  const kind = src.kind;
  if (typeof kind !== 'string' || !kind.trim()) {
    errors.push('缺少 kind（协议：anthropic / openai / responses）');
  } else if (!protocols.has(kind.trim())) {
    errors.push(`kind「${kind.trim()}」没有对应的协议适配器（内核两族 + 已装载的方言插件）`);
  }
  const baseUrl = src.baseUrl;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    errors.push('缺少 baseUrl（完整端点前缀，含 /v1）');
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(baseUrl.trim())) {
    errors.push(`baseUrl「${baseUrl.trim()}」不像完整地址（需要 http(s):// 开头）`);
  }
  return errors;
}

/**
 * 解析一节 provider（键名 = 身份）。
 *
 * ⚡ 2026-11-16 字段级校验批（真机事故根治）：**能用的节绝不整节作废**。
 *  只有「这一节是谁、连到哪」判不出来时（名字非法 / 不是映射 / 缺 kind /
 *  缺 baseUrl）才整节判死；其余字段写错只丢那个字段并记一条警告。
 *  事故形态：一行 `input: [audio]` 让 359 行、84 条元数据的整节从应用侧蒸发。
 *
 * @returns `{ errors }` = 整节不可用；`ParsedSection` = 可用（可能带字段级警告）。
 */
export function parseSection(
  name: string,
  raw: unknown,
  protocols: KnownProtocols = FACTORY_PROTOCOLS,
): ParsedSection | { errors: string[] } {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const fatal = fatalSectionErrors(name, src, protocols);
  if (fatal.length > 0) return { errors: fatal };

  // 走到这里 src 一定是映射（fatalSectionErrors 已保证），且 kind/baseUrl 可判。
  const fields = src as Record<string, unknown>;
  const warnings: string[] = [];

  // 本机读数键（apiKey / model / lastTest / catalog / modelMeta）：点名提示 + **忽略**
  // ——model / modelMeta 例外，它们是迁移源（旧文件里的值要收进本机运行态）。
  let legacyModel: string | undefined;
  let legacyModelMeta: Record<string, ModelMeta> | undefined;
  for (const { key, why } of RUNTIME_ONLY_KEYS) {
    if (fields[key] === undefined) continue;
    if (key === 'model') {
      if (typeof fields.model === 'string' && fields.model.trim()) legacyModel = fields.model.trim();
      else warnings.push('model 必须是字符串——已忽略该字段');
      warnings.push('model 已从本文件迁出（最近使用是本机运行态）；装载时会收进本机存储，下次保存即从文件消失');
      continue;
    }
    if (key === 'modelMeta') {
      legacyModelMeta = readModelMeta(fields.modelMeta, warnings);
      warnings.push('modelMeta 已从本文件迁出（本机读数）；装载时会收进本机存储，下次保存即从文件消失');
      continue;
    }
    warnings.push(`${key} 不该出现在本文件（已忽略）：${why}`);
  }
  // 未知字段一律忽略（前向兼容：旧版本打开新文件不该炸，也不该丢掉整节）
  for (const key of Object.keys(fields)) {
    if (RUNTIME_ONLY_KEYS.some((r) => r.key === key)) continue;
    if (!(INTENT_FIELDS as readonly string[]).includes(key)) {
      warnings.push(`未知字段「${key}」已忽略（本版本可写字段：${INTENT_FIELDS.join(' / ')}）`);
    }
  }

  const models = readStringArray(fields.models, 'models', warnings);
  const headers = readHeaders(fields.headers, warnings);
  const modelOverrides = readModelOverrides(fields.modelOverrides, warnings);

  // ⚡ 2026-11-21：提供方级「默认思考档位」退役——思考档位只在创作坞按会话选。
  // 老文件里的该字段读都不读，点名提示一次（下次保存即从文件消失）。
  if (fields.thinking !== undefined) {
    warnings.push('thinking 已废弃（思考档位只在创作坞按会话选择）——本字段已忽略，下次保存时移除');
  }
  const authMode = fields.authMode;
  if (authMode !== undefined && authMode !== 'api-key' && authMode !== 'oauth') {
    warnings.push('authMode 只能是 "api-key" 或 "oauth"——已忽略该字段');
  }
  const oauthProvider = fields.oauthProvider;
  if (oauthProvider !== undefined && typeof oauthProvider !== 'string') {
    warnings.push('oauthProvider 必须是字符串（如 codex）——已忽略该字段');
  }
  const oauthAccountId = fields.oauthAccountId;
  if (oauthAccountId !== undefined && typeof oauthAccountId !== 'string') {
    warnings.push('oauthAccountId 必须是字符串——已忽略该字段');
  }

  const authOk = authMode === 'api-key' || authMode === 'oauth';
  const intent: ProviderIntent = {
    kind: (fields.kind as string).trim(),
    baseUrl: (fields.baseUrl as string).trim(),
    ...(models !== undefined ? { models } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(modelOverrides !== undefined ? { modelOverrides } : {}),
    ...(authOk ? { authMode } : {}),
    ...(typeof oauthProvider === 'string' ? { oauthProvider } : {}),
    ...(typeof oauthAccountId === 'string' && oauthAccountId.trim() ? { oauthAccountId: oauthAccountId.trim() } : {}),
  };
  return {
    intent,
    warnings,
    ...(legacyModel !== undefined ? { legacyModel } : {}),
    ...(legacyModelMeta !== undefined ? { legacyModelMeta } : {}),
  };
}

/**
 * 解析整份 provider 文档。
 * @param text - 文件原文（空文本 = 空文档，合法）。
 * @param protocols - 已知协议集合（缺省 = 出厂集）。
 * @returns 逐节意图 + 逐节错误；整份不可用时带 fatal（**不抛**）。
 */
export function parseProvidersDoc(text: string, protocols: KnownProtocols = FACTORY_PROTOCOLS): ProvidersDoc {
  const sections: ProviderSection[] = [];
  const errors: SectionError[] = [];
  const warnings: SectionError[] = [];
  const order: string[] = [];

  if (!text.trim()) return { sections, errors, warnings, order };

  const doc: Document = parseDocument(text);
  if (doc.errors.length > 0) {
    return { sections, errors, warnings, order, fatal: `YAML 解析失败：${doc.errors[0].message}` };
  }
  const root = doc.contents;
  if (root === null) return { sections, errors, warnings, order };
  if (!isMap(root)) {
    return { sections, errors, warnings, order, fatal: '文档根必须是一个映射：顶层键 = provider 名' };
  }

  const seen = new Map<string, string>();
  // 节点树 → 纯 JS 值再校验（`doc.get` 给的是 YAMLMap 节点，不是用户写的值）
  const plain = (doc.toJS() ?? {}) as Record<string, unknown>;
  for (const item of (root as YAMLMap).items) {
    const key = item.key;
    const name =
      typeof key === 'object' && key !== null && 'value' in key ? String(key.value ?? '') : String(key ?? '');
    if (!name.trim()) {
      errors.push({ name: '(空键)', message: 'provider 名不能为空' });
      continue;
    }
    order.push(name.trim());
    const lower = name.trim().toLowerCase();
    const prev = seen.get(lower);
    if (prev !== undefined) {
      errors.push({
        name: name.trim(),
        message: `provider 名「${name.trim()}」与本文件里的「${prev}」重复（本机文件名/凭据键大小写不敏感）`,
      });
      continue;
    }
    seen.set(lower, name.trim());
    const parsed = parseSection(name.trim(), plain[name.trim()], protocols);
    if ('errors' in parsed) {
      errors.push({ name: name.trim(), message: parsed.errors.join('\n') });
      continue;
    }
    sections.push({
      name: name.trim() as ProviderId,
      intent: parsed.intent,
      warnings: parsed.warnings,
      ...(parsed.legacyModel !== undefined ? { legacyModel: parsed.legacyModel } : {}),
      ...(parsed.legacyModelMeta !== undefined ? { legacyModelMeta: parsed.legacyModelMeta } : {}),
    });
    if (parsed.warnings.length > 0) {
      warnings.push({ name: name.trim(), message: parsed.warnings.join('\n') });
    }
  }
  return { sections, errors, warnings, order };
}

// ── 写盘：注释与排版保留的 leaf-diff ──────────────────────────────

/** 把一节意图摊平成一个「字段 → 值」表（缺省字段 = undefined，写盘时删键）。 */
function sectionFields(intent: ProviderIntent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of INTENT_FIELDS) {
    const v = (intent as Record<string, unknown>)[field];
    if (v === undefined) continue;
    out[field] = v;
  }
  return out;
}

/** 该路径在文档里是否已是映射（leaf-diff 需要；标量/序列必须先删再设）。 */
function isMappingAt(doc: Document, path: string[]): boolean {
  const node: unknown = doc.getIn(path, true);
  return !!node && typeof node === 'object' && isMap(node as YamlNode);
}

/**
 * 把「provider 名 → 意图」补丁写进文档文本（**保住手写注释与排版**）。
 *
 * 照 DSH `settings-file` 的 YAML 渲染：只设变更的叶子值、只删没了的键，
 * 未触及的节点逐字保留；改变数组或其它非映射值则整值替换（YAML 语义使然）。
 * 手写注释随它描述的键一起保留——这正是「文件能被人手写」的前提：
 * 应用写盘不会把用户的注释和排版冲掉。
 *
 * @param text - 现有文件原文（空 = 从新建骨架开始）。
 * @param patch - provider 名 → 意图（**这一节的全量字段**；不在表里的字段会被删）。
 * @param opts.keep - 补丁里没有、但**必须原样保留**的节名（解析失败的坏节：
 *   「这一节没读出来」绝不等于「用户删了它」——2026-11-16 事故：坏节状态下点一次
 *   保存，359 行手写配置连同元数据被静默抹掉）。
 * @returns 新的文件文本。
 */
export function applyProvidersDoc(
  text: string,
  patch: Readonly<Record<string, ProviderIntent>>,
  opts: { keep?: Iterable<string> } = {},
): string {
  const doc: Document = text.trim().length > 0 ? parseDocument(text) : new Document({});
  if (doc.errors.length > 0) {
    // 手稿解析不了 ⇒ 绝不覆盖（调用方应先报错）；这里原样返回，写盘方负责拒写。
    return text;
  }
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) return text;
  // 文件头只在**新建**时补（已有手稿的头一个字都不动——那是用户的地盘）
  if (doc.contents.items.length === 0 && !doc.commentBefore) {
    doc.commentBefore = ` ${PROVIDERS_DOC_HEADER.replace(/\n/g, '\n ')}`;
  }

  // 1) 删掉文档里有、补丁里没有的 provider 节（键序不乱动）。
  //    ⚡ keep 里的节**永不删**：那是「解析失败」的节，不是用户删掉的节。
  const wanted = new Set(Object.keys(patch));
  for (const kept of opts.keep ?? []) wanted.add(kept);
  for (const item of [...(doc.contents as YAMLMap).items]) {
    const key = item.key;
    const name =
      typeof key === 'object' && key !== null && 'value' in key ? String(key.value ?? '') : String(key ?? '');
    if (!wanted.has(name)) doc.delete(name);
  }

  // 2) 逐节 leaf-diff（keep 里的节不在外观：它们读不出来，原样留着）
  for (const [name, intent] of Object.entries(patch)) {
    const fields = sectionFields(intent);
    const existing = doc.get(name, true);
    if (existing === undefined || existing === null) {
      const sec = doc.createNode(fields);
      sec.commentBefore = ' 一行 provider = 一个顶层键；键名即 provider 身份';
      doc.set(name, sec);
      continue;
    }
    if (!isMappingAt(doc, [name])) {
      // 该键下原是个标量/序列（手写笔误）——整节替换成映射
      const sec = doc.createNode(fields);
      doc.set(name, sec);
      continue;
    }
    const current = new Set(
      (doc.getIn([name], true) as YAMLMap).items.map((it) => {
        const k = it.key;
        return typeof k === 'object' && k !== null && 'value' in k ? String(k.value ?? '') : String(k ?? '');
      }),
    );
    for (const key of current) {
      if (!(key in fields)) doc.deleteIn([name, key]);
    }
    for (const [key, value] of Object.entries(fields)) {
      // 非映射旧值（标量/序列）先删再设——setIn 遇到标量会抛
      if (key in fields && value !== null && typeof value === 'object' && !isMappingAt(doc, [name, key])) {
        doc.deleteIn([name, key]);
      }
      doc.setIn([name, key], value);
    }
  }
  return String(doc);
}

/** 空文档骨架（首次落盘时写出去——用户打开就看到格式说明与例子）。 */
export function emptyProvidersDoc(): string {
  const doc = new Document({});
  doc.commentBefore = ` ${PROVIDERS_DOC_HEADER.replace(/\n/g, '\n ')}`;
  return String(doc);
}

/** 单节 YAML 片段（设置页「本行配置长这样」预览 + 复制分享）。 */
export function renderSection(name: string, intent: ProviderIntent): string {
  const doc = new Document({});
  doc.set(name, doc.createNode(sectionFields(intent)));
  return String(doc);
}

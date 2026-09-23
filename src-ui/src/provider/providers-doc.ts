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
//   - **本文件 = 用户意图的权威源**（kind / baseUrl / 模型 / 请求头 / 覆盖 / 档位）；
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
import { isThinkingMode, type StoredThinking, THINKING_MODES, type ThinkingEffort } from './thinking';
import { CORE_PROTOCOLS } from './types';

/** 配置文件里一节 provider 的全部字段（= 用户意图；身份在键名里）。 */
export type ProviderIntent = Omit<ProviderSettings, 'name' | 'apiKey' | 'lastTest' | 'catalog'>;

/** 解析成功的一节：身份（键名）+ 意图。 */
export interface ProviderSection {
  name: ProviderId;
  intent: ProviderIntent;
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
  /** 逐节错误（坏节不进 sections）。 */
  errors: SectionError[];
  /** 整份不可用（YAML 语法错 / 根不是映射）——此时 sections 为空。 */
  fatal?: string;
}

/** 文档里**不属于**用户意图的保留键（写进来必定是写错了——点名报错，不静默丢弃）。 */
const RUNTIME_ONLY_KEYS: readonly { key: string; why: string }[] = [
  { key: 'apiKey', why: '密钥永不进本文件（明文落盘会被误分享）——请到设置页「API Key」栏填写，权威在系统凭据库' },
  { key: 'lastTest', why: '连接探针结果是本机读数、不进配置（本文件是用户意图）' },
  { key: 'catalog', why: '模型目录快照是本机读数、不进配置（设置页「刷新目录」拉取）' },
];

/** provider 身份围栏（键名即身份：凭据键 + 目录合并键三合一）——同 AddProviderSheet。 */
export const PROVIDER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** 文件头（人手写的第一眼读物；写盘时留在文件顶部）。 */
export const PROVIDERS_DOC_HEADER = [
  '兰台 provider 连接配置——人和 agent 都直接改这个文件，改完即时生效（约 1 秒）。',
  '',
  '· 一行 provider = 一个顶层键，键名就是 provider 身份（字母/数字/下划线/连字符）。',
  '· 这里只放**非敏感**连接配置；密钥（apiKey）权威在本机系统凭据库，不写在这里。',
  '· 本机读数（连接探针结果、模型目录快照）也不在这里，它们只活在本机存储。',
  '· 删掉某一节 = 删掉那行 provider（密钥仍留在凭据库，设置页「清除」可一并删）。',
  '· 设置页保存会**按字段**回写本文件，你手写的注释与排版会保留。',
  '',
  '最小例子：',
  '',
  '# my-gateway:',
  '#   kind: openai                                  # 协议：anthropic / openai / responses',
  '#   baseUrl: https://gateway.example.com/v1',
  '#   model: deepseek-v4.1-flash                    # 新会话默认模型',
  '#   models: [deepseek-v4.1-flash, claude-opus-4-6] # 可用模型（缺省 = 只有 model 一个）',
  '#   thinking: high                                # 本家默认思考档位（缺省 = 自动）',
  '#   headers:                                      # 网关怪癖（可选）',
  '#     x-opencode-session: sess-1',
  '#   modelOverrides:                               # 单模型纠正（可选）',
  '#     deepseek-v4.1-flash:',
  '#       contextWindow: 1000000',
  '#       maxTokens: 384000',
].join('\n');

/** 是否本文件格式（扩展名围栏）——只认 .yml / .yaml。 */
export function isProvidersDocPath(path: string): boolean {
  return /\.ya?ml$/i.test(path.trim());
}

/** 由完整行取意图（剥掉非文件字段）——UI 写盘与文件解析共用同一把尺子。 */
export function intentOf(p: ProviderSettings): ProviderIntent {
  const { name: _name, apiKey: _apiKey, lastTest: _lastTest, catalog: _catalog, ...intent } = p;
  return intent;
}

/** 由意图 + 身份 + 运行态合成完整行（装配面/设置页消费的形态）。 */
export function mergeIntent(
  name: ProviderId,
  intent: ProviderIntent,
  runtime: Pick<ProviderSettings, 'apiKey' | 'lastTest' | 'catalog'>,
): ProviderSettings {
  return { ...intent, name, ...runtime };
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
    // per-model 思考档位：只认 canonical 档位 + 空串（自动）；遗留数字预算不进本文件。
    if (ov.thinking !== undefined) {
      if (typeof ov.thinking === 'string' && (ov.thinking === '' || isThinkingMode(ov.thinking))) {
        next.thinking = ov.thinking;
      } else {
        errors.push(
          `modelOverrides「${id}」.thinking 必须是合法档位（${THINKING_MODES.map((m) => m.value || '自动').join(' / ')}）`,
        );
      }
    }
    out[id] = next;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const THINKING_EFFORTS: readonly ThinkingEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

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
  'model',
  'models',
  'thinking',
  'authMode',
  'oauthProvider',
  'headers',
  'modelOverrides',
  'modelMeta',
] as const satisfies readonly (keyof ProviderIntent)[];

/** 解析一节 provider（键名 = 身份）。返回意图或点名字段错误。 */
export function parseSection(
  name: string,
  raw: unknown,
  protocols: KnownProtocols = FACTORY_PROTOCOLS,
): { intent: ProviderIntent } | { errors: string[] } {
  const errors: string[] = [];
  if (!PROVIDER_NAME_RE.test(name)) {
    errors.push(
      `provider 名「${name}」不合法（只允许字母、数字、下划线、连字符）——键名就是 provider 身份，也是系统凭据的键`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('这一节必须是一个键值映射（如 kind / baseUrl / model）');
    return { errors };
  }
  const src = raw as Record<string, unknown>;

  for (const { key, why } of RUNTIME_ONLY_KEYS) {
    if (src[key] !== undefined) errors.push(`${key} 不该出现在本文件：${why}`);
  }
  for (const key of Object.keys(src)) {
    if (!(INTENT_FIELDS as readonly string[]).includes(key)) {
      errors.push(`未知字段「${key}」（可写字段：${INTENT_FIELDS.join(' / ')}）`);
    }
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
  const model = src.model;
  if (typeof model !== 'string' || !model.trim()) errors.push('缺少 model（新会话默认模型 id）');

  const models = readStringArray(src.models, 'models', errors);
  const headers = readHeaders(src.headers, errors);
  const modelOverrides = readModelOverrides(src.modelOverrides, errors);
  const modelMeta = readModelMeta(src.modelMeta, errors);

  const thinking = src.thinking;
  if (thinking !== undefined && typeof thinking !== 'string') {
    errors.push('thinking 必须是字符串（档位名或空串 = 自动）');
  } else if (typeof thinking === 'string' && thinking !== '' && !isThinkingMode(thinking)) {
    errors.push(
      `thinking「${thinking}」不是合法档位（${THINKING_MODES.map((m) => m.value || '自动').join(' / ')}）——遗留数字预算只在设置页里保留，不写进本文件`,
    );
  }
  const authMode = src.authMode;
  if (authMode !== undefined && authMode !== 'api-key' && authMode !== 'oauth') {
    errors.push('authMode 只能是 "api-key" 或 "oauth"');
  }
  const oauthProvider = src.oauthProvider;
  if (oauthProvider !== undefined && typeof oauthProvider !== 'string') {
    errors.push('oauthProvider 必须是字符串（如 codex）');
  }
  if (errors.length > 0) return { errors };

  return {
    intent: {
      kind: (kind as string).trim(),
      baseUrl: (baseUrl as string).trim(),
      model: (model as string).trim(),
      ...(models !== undefined ? { models } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(modelOverrides !== undefined ? { modelOverrides } : {}),
      ...(modelMeta !== undefined ? { modelMeta } : {}),
      ...(typeof thinking === 'string' ? { thinking: thinking as StoredThinking } : {}),
      ...(authMode === 'api-key' || authMode === 'oauth' ? { authMode } : {}),
      ...(typeof oauthProvider === 'string' ? { oauthProvider } : {}),
    },
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
  const wrap = (name: string, list: string[]): void => {
    errors.push({ name, message: list.join('\n') });
  };

  if (!text.trim()) return { sections, errors };

  const doc: Document = parseDocument(text);
  if (doc.errors.length > 0) {
    return { sections, errors, fatal: `YAML 解析失败：${doc.errors[0].message}` };
  }
  const root = doc.contents;
  if (root === null) return { sections, errors };
  if (!isMap(root)) {
    return { sections, errors, fatal: '文档根必须是一个映射：顶层键 = provider 名' };
  }

  const seen = new Map<string, string>();
  // 节点树 → 纯 JS 值再校验（`doc.get` 给的是 YAMLMap 节点，不是用户写的值）
  const plain = (doc.toJS() ?? {}) as Record<string, unknown>;
  for (const item of (root as YAMLMap).items) {
    const key = item.key;
    const name =
      typeof key === 'object' && key !== null && 'value' in key ? String(key.value ?? '') : String(key ?? '');
    if (!name.trim()) {
      wrap('(空键)', ['provider 名不能为空']);
      continue;
    }
    const lower = name.trim().toLowerCase();
    const prev = seen.get(lower);
    if (prev !== undefined) {
      wrap(name.trim(), [`provider 名「${name.trim()}」与本文件里的「${prev}」重复（本机文件名/凭据键大小写不敏感）`]);
      continue;
    }
    seen.set(lower, name.trim());
    const parsed = parseSection(name.trim(), plain[name.trim()], protocols);
    if ('errors' in parsed) wrap(name.trim(), parsed.errors);
    else sections.push({ name: name.trim() as ProviderId, intent: parsed.intent });
  }
  return { sections, errors };
}

// ── 写盘：注释与排版保留的 leaf-diff ──────────────────────────────

/** 把一节意图摊平成一个「字段 → 值」表（缺省字段 = undefined，写盘时删键）。 */
function sectionFields(intent: ProviderIntent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of INTENT_FIELDS) {
    const v = (intent as Record<string, unknown>)[field];
    if (v === undefined) continue;
    // modelMeta 全空对象不写（只有 fetchedAt 的条目不值得落盘——同 metaHasContent 纪律）
    if (field === 'modelMeta' && Object.keys(v as object).length === 0) continue;
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
 * @returns 新的文件文本。
 */
export function applyProvidersDoc(text: string, patch: Readonly<Record<string, ProviderIntent>>): string {
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

  // 1) 删掉文档里有、补丁里没有的 provider 节（键序不乱动）
  const wanted = new Set(Object.keys(patch));
  for (const item of [...(doc.contents as YAMLMap).items]) {
    const key = item.key;
    const name =
      typeof key === 'object' && key !== null && 'value' in key ? String(key.value ?? '') : String(key ?? '');
    if (!wanted.has(name)) doc.delete(name);
  }

  // 2) 逐节 leaf-diff
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

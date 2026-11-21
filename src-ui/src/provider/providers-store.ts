// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// provider 配置文件通道（2026-09-24 配方改文件批）——
// `~/.lantai/providers.yml` 的装载 / 写盘 / 热重载，一份文件统管所有 provider。
//
// 病灶（本批要根治的）：配方此前只是设置页里一段剪贴板 JSON，「导出」= 复制、
// 「导入」= 粘贴套用——没有落点、不能 diff、agent 碰不到。本模块把它变成一份
// 真正的磁盘文件：复制文件就是导入，文件本身就是导出，agent 用 fs 工具直接改。
//
// 权威三分（见 settings.ts 同段注释）：意图 → 本文件；密钥 → 系统凭据；
// 运行态读数（探针结果 / 目录快照 / 模型元数据）→ localStorage。三者不重叠。
//
// **只有一份文件**：`~/.lantai/providers.yml`（2026-11-16 项目级整份拆除——
// 见下方「项目级配置文件整份拆除」段）。
//
// 时序（照 DSH `settings-file` 的「boot 先读、watcher 后武装、就绪后再对账」）：
//   boot: loadProvidersDoc() → installProvidersDocProjection() ← 装配面首次读设置之前
//   live: typedListen('providers:changed') → loadProvidersDoc()（外部编辑热生效）
//   save: saveProvidersDoc(patch)           ← 设置页「保存」统一入口
//
// 纪律（2026-11-16 字段级校验批重写）：
//   - **手稿解析不了 ⇒ 拒写**（绝不覆盖用户正在编辑的文件——DSH 同款）；
//   - **字段级降级**：一个字段写错只丢那个字段（点名提示），整节照常生效；
//     只有「这一节是谁 / 连到哪」判不出来（名字非法 / 缺 kind / 缺 baseUrl）才整节作废；
//   - **坏节回落上一次可用**：整节作废时行表不消失（按名顶上上一次解析成功的样子）；
//   - **有整节读不出来 ⇒ 拒写整份**：面板行表里没有它，写盘会把「没读出来」当成
//     「用户删了」，真机上就这么抹掉过 359 行手写配置；
//   - 写盘 = 读-改-写（先重读磁盘再渲染）：绝不复活陈旧文档、不丢本进程没观察到的兄弟节点。

import { log } from '../agent/logger';
import * as Obs from '../agent/obs';
import { activeLlmAdapters } from '../composition/services';
import {
  applyProvidersDoc,
  emptyProvidersDoc,
  intentOf,
  isProvidersDocPath,
  mergeIntent,
  PROVIDER_NAME_RE,
  type ProviderIntent,
  parseProvidersDoc,
  parseSection,
  type SectionError,
} from '../provider/providers-doc';
import { clearDynamicProviderState } from './catalog';
import { CORE_PROTOCOLS } from '../provider/types';
import { kernelReadFile, kernelWriteFile, typedListen, typedRpc } from '../rpc-contract';
import {
  installProviderRuntimeSink,
  installProvidersFileReadyCheck,
  installProvidersProjection,
  loadSettings,
  type ProviderRuntime,
  type ProviderSettings,
  saveSettings,
  storedProviderRows,
} from '../settings';

/** 当前文档状态（设置页显示：路径 / 逐节错误 / 整份是否可用）。 */
export interface ProvidersDocStatus {
  /** 配置文件绝对路径（Rust 侧计算；未就绪 = 空串）。 */
  path: string;
  /** **整节**不可用（坏节点名 + 可读原因）——这些节按「上一次可用」回落，
   *  不再从行表里消失。 */
  errors: SectionError[];
  /** **字段级**问题：这一节照常生效，只是这些字段被按缺省处理。 */
  warnings: SectionError[];
  /** 整份不可用原因（YAML 语法错 / 根不是映射）——此时**拒写**，以手写稿优先。 */
  fatal?: string;
  /** 磁盘上还没有内容（文件不存在 / 全空）——迁移的判据：
   *  空 → 把旧存档的存量写出去（一次性迁移）；非空 → 文件就是权威，不再回填。 */
  empty: boolean;
  /** 是否已从磁盘装载（false = 还没读到，界面应显示「装载中」）。 */
  loaded: boolean;
  /** 磁盘装载代数：文件原文每变一次 +1。保存请求带上「编辑起点」代数，watcher
   *  已重读而面板仍拿旧草稿时即可在写盘前判冲突。 */
  revision: number;
  /** 本次 fatal 是否用了本机独立 intent 备份（跨重启 last-good；无 = undefined）。 */
  recoveredFromBackup?: boolean;
  /** 配置文件通道是否可用（false = 拿不到有效路径：降级环境/契约不满足）。
   *  不可用时保存管道**不阻断面板**——只跳过写文件并把原因写进 lastError
   *  （与「文件在手但解析不了 ⇒ 拒写」是两回事：后者是保护手稿，必须硬失败）。 */
  available: boolean;
  /** 最近一次装载/写盘/拒写的可读原因（设置页显示用；无 = 空串）。 */
  lastError: string;
}

type Listener = () => void;
type Sections = Array<{ name: ProviderSettings['name']; intent: ProviderIntent }>;

// ── 模块状态（声明先于一切函数：投影在模块初始化后立刻可能被读）──────────
const state: ProvidersDocStatus = {
  path: '',
  errors: [],
  warnings: [],
  empty: true,
  loaded: false,
  available: false,
  lastError: '',
  revision: 0,
};

/** 路径是否像一条真路径（RPC 通道缺失时 mock 会回 "null" 一类哨兵字符串——
 *  那不是路径，写进去只会造出 `./null` 这种垃圾文件）。 */
function looksLikePath(p: string): boolean {
  const t = p.trim();
  if (!t || t === 'null' || t === 'undefined') return false;
  return /^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('/') || t.startsWith('\\\\');
}

/** 文件权威是否**已确认**可用（setting.ts 只在这个条件下才敢剥掉 localStorage
 *  里的意图副本——通道没确认之前剥 = 丢掉用户唯一的配置来源）。
 *
 *  ⚡ 2026-09-26 补一条：**空文档不算权威**（`!state.empty`）。设计件原文是
 *  「磁盘上已有内容 ⇒ 文件就是权威」（docs/design/provider-system-spec.md §配方
 *  改文件），而此前判据只看通道可用性 ⇒ 文件**还空着**（迁移没跑 / 跑了但失败）
 *  时它也报「权威」，投影当场返回**空行表**。用户 2026-09-23 报「之前配好的
 *  供应商也没了」正是这个形态。此前唯一挡住它的是「迁移失败 ⇒ state.fatal
 *  置位」这条**巧合**——而 `retryProvidersPath()` 与 watcher 重读都会把 fatal
 *  清成 undefined（`state.fatal = doc.fatal`），巧合一破就丢配置。 */
export function providersFileReady(): boolean {
  return state.available && state.loaded && !state.fatal && fileAuthorityConfirmed;
}
/** 运行态读数（provider 名 → 探针结果/目录快照/元数据/密钥），localStorage 的作者。
 *  ⚡ 2026-11-16 本机读数迁出批：`modelMeta`（刷新目录拉回来的模型元数据）从配置
 *  文件搬到这一层——它是每天被自动重写的大块数据（真机占文件 87%），不该让它的
 *  一处笔误决定整节 provider 的生死。旧文件里的遗留值在装载时收割到这里。 */
let runtimeMap = new Map<string, ProviderRuntime>();
/** 用户级文件原文（写盘时做读-改-写的底）。 */
let lastFileText = '';
/** 用户级解析出的节。 */
let lastSections: Sections = [];
/** **上一次可用**的节（按名）。坏节不进行表时用它顶上——
 *  设计件「坏节只坏自己、该节回落上次可用值」的兑现（2026-11-16 事故：此前
 *  这句话只写在注释里，代码里没有，于是坏节直接从应用侧消失）。 */
let lastGoodSections = new Map<string, Sections[number]>();

/** 本文件里出现过的坏节名（保存时**永不删**——「没读出来」≠「用户删了」）。 */
let brokenSectionNames = new Set<string>();
/** 文件里的顶层键顺序（含坏节）——行表按它排。 */
let fileKeyOrder: string[] = [];
let cachedRows: ProviderSettings[] | null = null;
let cachedSignature = '';
const listeners = new Set<Listener>();
/** 文件权威是否曾经确认成功（非空且整份可解析）。fatal 后仍用它决定投影走 last-good。 */
let fileAuthorityConfirmed = false;
/** 本次 fatal 用的是独立 intent 备份（不是文件、也不是同进程 last-good）。 */
let intentBackupActive = false;

/** 完整 intent 快照的独立本机备份键。
 *
 *  为什么不放在 hologram_settings：那份存档在文件权威下只留运行态壳（saveSettings 会
 *  剥掉意图）。进程一重启就只剩 name/apiKey/catalog，fatal 时没有任何可回落的完整
 *  intent。这里单独存一份**不含密钥/运行态**的纯意图快照，fatal 且内存无 last-good
 *  时优先读它——与配置文件本体互不污染，也不违反「文件 = 意图权威」。 */
export const PROVIDERS_INTENT_BACKUP_KEY = 'hologram_provider_intent_backup_v1';
const INTENT_BACKUP_VERSION = 1;

interface ProvidersIntentBackup {
  version: 1;
  path: string;
  capturedAt: number;
  order: string[];
  sections: Array<{ name: string; intent: ProviderIntent }>;
}

/** 订阅文档状态变更（设置页用；返回退订）。 */
export function onProvidersDocChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notify(): void {
  for (const cb of [...listeners]) cb();
}

/** 当前文档状态快照（只读）。 */
export function providersDocStatus(): Readonly<ProvidersDocStatus> {
  return state;
}

/**
 * 手动重试取路径（设置页「重试路径」按钮）。
 *
 * 用武之地：壳与前端版本错位时（前端热更跑在旧壳上 / 壳刚重建完而窗口没重启），
 * 前一次取路径失败过——那之后**不必重启应用**，通道就绪后点一下就接上。
 * 失败**绝不缓存**，所以这里就是再跑一次装载。
 */
export async function retryProvidersPath(): Promise<void> {
  await loadProvidersDoc({ reloadRuntime: true });
  notify();
}

/** 配置文件绝对路径（未装载 = 空串）。 */
export function providersFilePath(): string {
  return state.path;
}

/** 已知协议集合：内核两族（出厂）+ 出厂 responses 方言 + ctx.llm adapter 贡献。 */
function knownProtocols(): { has(kind: string): boolean } {
  const kinds = new Set<string>([...CORE_PROTOCOLS, 'responses']);
  try {
    for (const a of activeLlmAdapters()) kinds.add(a.kind);
  } catch {
    // 组合层未就绪（早期调用/测试环境）= 只有出厂集，不炸
  }
  return { has: (kind: string) => kinds.has(kind) };
}

/** 当前生效的节 = 文件里的节 + 坏节的「上一次可用」回落。
 *
 *  ⚡ 2026-11-16：坏节不再从行表里消失——按名回落到上一次解析成功的意图
 *  （设计件承诺的语义，此前只有注释没有实现）。文件里彻底删掉的节才真的消失。 */
function effectiveSections(): Sections {
  if (lastGoodSections.size === 0) return lastSections;
  const byName = new Map<string, Sections[number]>();
  for (const [name, section] of lastGoodSections) byName.set(name, section);
  // 文件里读得出来的节覆盖旧值（最新状态优先）
  for (const s of lastSections) byName.set(s.name, s);
  // 顺序 = 文件里的键序（坏节回到原位），文件里已删掉的节才排在后面
  const out: Sections = [];
  const seen = new Set<string>();
  for (const name of fileKeyOrder) {
    const s = byName.get(name);
    if (s) {
      out.push(s);
      seen.add(name);
    }
  }
  for (const [name, s] of byName) if (!seen.has(name)) out.push(s);
  return out;
}

/** 把当前完整意图投影写进独立备份（每次整份非 fatal 装载后调用）。
 *
 *  口径：写的是 effectiveSections()——坏节已经由内存 last-good 顶上，因此备份里仍是
 *  「最后一次可用」的完整意图，而不是这次只解析成功的残片。只存意图，不存密钥、
 *  探针、目录快照或模型元数据（那些仍是 localStorage 运行态层）。 */
function persistProvidersIntentBackup(): void {
  try {
    if (typeof localStorage === 'undefined' || !state.path) return;
    const sections = effectiveSections();
    const byName = new Map(sections.map((section) => [section.name, section]));
    const order: string[] = [];
    for (const name of fileKeyOrder) {
      if (byName.has(name) && !order.includes(name)) order.push(name);
    }
    for (const section of sections) if (!order.includes(section.name)) order.push(section.name);
    const payload: ProvidersIntentBackup = {
      version: INTENT_BACKUP_VERSION as 1,
      path: state.path,
      capturedAt: Date.now(),
      order,
      sections: order.map((name) => ({ name, intent: byName.get(name)!.intent })),
    };
    localStorage.setItem(PROVIDERS_INTENT_BACKUP_KEY, JSON.stringify(payload));
  } catch (e) {
    // 备份写不进去不能反过来阻断正常装载；但必须留痕（下次真需要它时才知道缺）。
    log.warn('provider-doc', 'intent 备份写入失败（跨重启 last-good 可能不完整）', { error: errText(e) });
  }
}

/** 读取并校验独立 intent 备份；路径不符 / 形状腐坏 = null。
 *
 *  逐节走与文件同一把 parseSection 尺子：备份是本机缓存，不是第二真相源——字段
 *  或协议已不再支持时只丢该节，不让一份旧 JSON 反向污染当前配置语义。 */
function readProvidersIntentBackup(): {
  sections: Sections;
  order: string[];
  capturedAt: number;
  legacyModels: Map<string, string>;
} | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(PROVIDERS_INTENT_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProvidersIntentBackup>;
    if (parsed.version !== INTENT_BACKUP_VERSION || parsed.path !== state.path || !Array.isArray(parsed.sections)) {
      return null;
    }
    const sections: Sections = [];
    const legacyModels = new Map<string, string>();
    const seen = new Set<string>();
    for (const item of parsed.sections) {
      if (!item || typeof item !== 'object') continue;
      const name = (item as { name?: unknown }).name;
      if (typeof name !== 'string' || !PROVIDER_NAME_RE.test(name)) continue;
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue;
      const section = parseSection(name, (item as { intent?: unknown }).intent, knownProtocols());
      if ('errors' in section) continue;
      seen.add(lower);
      sections.push({ name: name as ProviderSettings['name'], intent: section.intent });
      if (section.legacyModel) legacyModels.set(name, section.legacyModel);
    }
    // 空快照是合法状态（用户删空所有 provider）；但「原本有 N 条、最后 0 条可解析」
    // 是腐坏/版本不兼容，不是可信的空配置——宁可不恢复，也不能用空表盖住运行态壳。
    if (parsed.sections.length > 0 && sections.length === 0) return null;
    const valid = new Set(sections.map((section) => section.name));
    const order: string[] = [];
    if (Array.isArray(parsed.order)) {
      for (const name of parsed.order) {
        if (typeof name === 'string' && valid.has(name) && !order.includes(name)) order.push(name);
      }
    }
    for (const section of sections) if (!order.includes(section.name)) order.push(section.name);
    return {
      sections,
      order,
      capturedAt: typeof parsed.capturedAt === 'number' ? parsed.capturedAt : 0,
      legacyModels,
    };
  } catch {
    return null;
  }
}

/** 投影可否使用「意图」行：文件 authority 已确认，或本次 fatal 已读到独立备份。
 *  后者单独开关——providersFileReady 仍必须为 false（fatal 时绝不能写盘/剥本机意图）。 */
function providerIntentAvailable(): boolean {
  return fileAuthorityConfirmed || intentBackupActive;
}

/** 旧文件/旧备份里的 `model` 是「最近使用」迁移源：只有当前没有本机值时采用；
 *  已有最近使用值时，本机那份一定更新。 */
function adoptLegacyModel(name: string, model: string | undefined): void {
  const clean = model?.trim();
  if (!clean) return;
  const prev = runtimeMap.get(name) ?? { apiKey: '' };
  if (!prev.model?.trim()) runtimeMap.set(name, { ...prev, model: clean });
}

function runtimeOf(p: ProviderSettings): ProviderRuntime {
  return {
    apiKey: p.apiKey ?? '',
    ...(typeof p.model === 'string' ? { model: p.model } : {}),
    ...(p.lastTest !== undefined ? { lastTest: p.lastTest } : {}),
    ...(p.catalog !== undefined ? { catalog: p.catalog } : {}),
    ...(p.modelMeta !== undefined ? { modelMeta: p.modelMeta } : {}),
    ...(p.lastThinking !== undefined ? { lastThinking: p.lastThinking } : {}),
  };
}

/** 投影时归一「最近使用」：显式启用集存在时，model 必须是其中一项；
 *  否则自动回落到第一个可用模型（用户 2026-11-30 拍板：A + 自动回落第一个）。 */
function mergedProviderRow(
  name: ProviderSettings['name'],
  intent: ProviderIntent,
  runtime: ProviderRuntime,
): ProviderSettings {
  const row = mergeIntent(name, intent, runtime);
  if (Array.isArray(intent.models)) {
    const available = [...new Set(intent.models.map((model) => model.trim()).filter(Boolean))];
    if (!available.includes(row.model)) row.model = available[0] ?? '';
  }
  return row;
}

/** 重新计算投影（签名没变则复用同一数组引用——打字/滚轮热路径上 loadSettings 高频）。 */
function refreshRows(): void {
  const runtimeSig = [...runtimeMap.entries()]
    .map(
      ([k, v]) =>
        `${k}|${v.apiKey.length}|${v.model ?? ''}|${v.lastTest?.at ?? 0}|${v.catalog?.length ?? 0}|${v.modelMeta ? Object.keys(v.modelMeta).length : 0}|${v.lastThinking ? JSON.stringify(v.lastThinking) : ''}`,
    )
    .join(',');
  const signature = `${lastFileText.length}:${state.fatal ?? ''}:${lastGoodSections.size}:${brokenSectionNames.size}:${fileKeyOrder.length}:${runtimeSig}`;
  if (cachedRows && signature === cachedSignature) return;
  cachedSignature = signature;
  const rt = (name: string): ProviderRuntime => runtimeMap.get(name) ?? { apiKey: '', model: '' };
  cachedRows = effectiveSections().map(({ name, intent }) => mergedProviderRow(name, intent, rt(name)));
}

/** 运行态读数的写出回执（`settings.installProviderRuntimeSink` 的装配面）。
 *
 *  为什么必须有（2026-11-21 真机排查）：runtimeMap 此前只在 boot / `reloadRuntime`
 *  重建，而 `reloadRuntime` 又从**投影**（= runtimeMap 自己）读——循环。于是
 *  「刷新目录 → 保存」写进 localStorage 的 catalog / modelMeta 在下一次
 *  providers:changed 广播（`saveSettings(loadSettings())`）里被换回**装载时**的旧值：
 *  目录快照与元数据永远停在文件权威接管那天（实测存档：opencode 的 catalog 停在
 *  2026-09-23 的 33 条，其余行走进「无 catalog」）。
 *
 *  合并口径：apiKey 以本次写出的值为准（设置页清 Key 要当场生效，权威仍在系统凭据库）；
 *  其余字段本次缺省（undefined）时保留上一次——只写部分字段的调用（`persistProbe` 一类）
 *  不该把已有读数清掉。 */
function syncRuntimeFromSaved(rows: readonly ProviderSettings[]): void {
  const next = new Map(runtimeMap);
  const present = new Set(rows.map((row) => row.name));
  for (const name of [...next.keys()]) if (!present.has(name)) next.delete(name);
  for (const row of rows) {
    const rt = runtimeOf(row);
    next.set(row.name, mergeRuntime(next.get(row.name), rt, rt.apiKey ?? ''));
  }
  runtimeMap = next;
  cachedRows = null; // 投影下次读时按新运行态重算
}

/** 运行态合并（`syncRuntimeFromSaved` / `reloadRuntimeFromStorage` 共用）：
 *  `prev` 里已有的字段在新值缺省（undefined）时保留——只写部分字段的调用不该把
 *  已有读数清掉；apiKey 的取舍由调用方决定（它不在本机存储里，且有「清 Key」语义）。 */
function mergeRuntime(
  prev: ProviderRuntime | undefined,
  next: ProviderRuntime | undefined,
  apiKey: string,
): ProviderRuntime {
  const base = prev ?? { apiKey: '', model: '' };
  return {
    apiKey,
    ...(next?.model !== undefined
      ? { model: next.model }
      : base.model !== undefined
        ? { model: base.model }
        : {}),
    ...(next?.lastTest !== undefined
      ? { lastTest: next.lastTest }
      : base.lastTest !== undefined
        ? { lastTest: base.lastTest }
        : {}),
    ...(next?.catalog !== undefined
      ? { catalog: next.catalog }
      : base.catalog !== undefined
        ? { catalog: base.catalog }
        : {}),
    ...(next?.modelMeta !== undefined
      ? { modelMeta: next.modelMeta }
      : base.modelMeta !== undefined
        ? { modelMeta: base.modelMeta }
        : {}),
    ...(next?.lastThinking !== undefined
      ? { lastThinking: next.lastThinking }
      : base.lastThinking !== undefined
        ? { lastThinking: base.lastThinking }
        : {}),
  };
}

/** 装配投影口：把「文件意图 + 运行态读数」合成完整行，供 loadSettings 读取边界使用。
 *  boot 期调用一次（早于一切 provider 消费）。 */
export function installProvidersDocProjection(): void {
  installProvidersProjection({
    rows: (fallback) => {
      // ⚡ 文件权威未确认（通道缺失/取路径失败）⇒ **本机那份整行仍是权威**
      //    （2026-09-23 真机事故：此前这里回空数组，与 saveSettings 剥意图叠加
      //      = 用户配好的 provider 凭空消失）。只有在文件确认接管之后，
      //      「文件里的键」才成为行表真源。
      if (!state.available || !state.loaded || !providerIntentAvailable()) return fallback;
      refreshRows();
      return cachedRows ?? [];
    },
  });
  installProvidersFileReadyCheck(providersFileReady);
  installProviderRuntimeSink(syncRuntimeFromSaved);
}

/** 装载读数快照（`obs.configLoad` 的载荷）。
 *
 *  ⚡ 为什么值得单列一条事件：事故（2026-09-27）里第一个岔路口就是「这行 provider
 *  存不存在、从哪来」——旧实现只在 fatal 时留痕，**成功不留**，于是「配置到底装进来
 *  没有」在日志上不可答。这里把「读到哪个文件、几节、哪几节坏了、投影来自文件还是
 *  本机副本、有多少行带着 Key」一次说清。
 *
 *  `rows` 取 `loadSettings().providers` = **用户实际看到的那张行表**（经投影），
 *  而不是文件里的节数——两者不等正是要暴露的形态。 */
function docSnapshotForObs(): Obs.ObsDocSnapshot {
  const rows = loadSettings().providers;
  const ready = providersFileReady();
  return {
    path: state.path,
    sections: lastSections.length,
    rows: rows.length,
    errors: [
      ...state.errors.map((e) => ({ name: e.name, reason: `[整节] ${e.message}` })),
      ...state.warnings.map((e) => ({ name: e.name, reason: `[字段] ${e.message}` })),
    ],
    fatal: state.fatal,
    empty: state.empty,
    source: ready ? 'file' : 'localStorage',
    keysCarried: {
      withKey: rows.filter((r) => (r.apiKey ?? '').trim().length > 0).length,
      total: rows.length,
    },
  };
}

/** 从本机存储（localStorage）重取运行态读数。
 *
 *  ⚡ 2026-11-21 修一个循环：旧实现读 `loadSettings()`——而 loadSettings 的 provider 行
 *  正是**本函数要重建的那份 runtimeMap** 的投影 ⇒ 「重取」读回自己，永远拿不到本机
 *  存储里的新值；再配合「providers:changed 广播 = saveSettings(loadSettings())」，
 *  刷新目录写下的 catalog / modelMeta 每次都被换回装载时的旧值（真机：目录快照停在
 *  文件权威接管那天）。现在读**未经投影的**本机行（storedProviderRows）。
 *
 *  密钥不在 localStorage（权威在系统凭据库）：内存里已回填的 apiKey 必须保住
 *  （2026-09-26 真机报障「设置页丢 key」同族），故 apiKey 一律取内存现值。
 *  其余字段：本机存储里这次有值的覆盖，没有的保留内存现值（部分写入不清读数）。 */
function reloadRuntimeFromStorage(): void {
  const stored = new Map(storedProviderRows().map((p) => [p.name, runtimeOf(p)]));
  // 内存里已回填的密钥（面板/装配面 loadSettingsWithSecrets 注入过的那批）——本机存储
  // 永远不含 apiKey（那是本层的纪律），只能从「内存账 + 当前投影」两处取。
  const injected = new Map(loadSettings().providers.map((p) => [p.name, p.apiKey ?? '']));
  const next = new Map<string, ProviderRuntime>();
  // 行表可能整套来自文件（本机存储里一条运行态都没有）——名字集合取两边的并集。
  const names = new Set<string>([...runtimeMap.keys(), ...injected.keys(), ...stored.keys()]);
  for (const name of names) {
    const prev = runtimeMap.get(name);
    next.set(name, mergeRuntime(prev, stored.get(name), prev?.apiKey || injected.get(name) || ''));
  }
  // 本机存储里有、内存里还没有的行（另一窗口新增 / 装载前写入）：补进来
  for (const [name, rt] of stored) if (!next.has(name)) next.set(name, rt);
  runtimeMap = next;
  cachedRows = null;
}

/** 装载一次用户级文档（boot / watcher / 保存后重读三处共用）。
 *  @param opts.reloadRuntime - true = 同时从 localStorage 重取运行态读数。
 *  @returns 是否读到（fatal 也算读到了——错误在 status 里，由设置页点名显示）。 */
export async function loadProvidersDoc(opts: { reloadRuntime?: boolean } = {}): Promise<boolean> {
  if (!state.path) {
    // ⚡ **每次重试、绝不缓存失败**（2026-09-23 真机事故）：失败会被缓存的话，
    //    任何一次早期调用（壳还没把 RPC 挂上 / 前端热更跑在旧壳上 / 宿主是 mock）
    //    就把文件权威永久钉死成不可用——此后既不建文件也不迁移，用户看到
    //    「provider 全没了」而盘上什么都没写。取路径是纯本地计算，重试零成本。
    try {
      const dir = typeof typedRpc === 'function' ? await typedRpc('providers_dir', { open: false }) : '';
      if (looksLikePath(dir)) {
        state.path = `${dir.replace(/[\\/]+$/, '')}/providers.yml`;
        state.available = true;
      } else {
        state.loaded = true;
        state.available = false;
        state.lastError = `配置文件通道不可用（providers_dir 返回的不是路径：${String(dir)}）——本机仍按内置存储工作`;
        log.error('provider-doc', 'providers_dir 返回的不是路径', { got: String(dir) });
        notify();
        // 通道不可用也是**装载结果**——必须可答（事故里 87 条 error 全是路径噪声，
        // 却没有一条说「provider 配置根本没装进来」）
        Obs.configLoad({ ...docSnapshotForObs(), fatal: state.lastError });
        return false;
      }
    } catch (e) {
      state.loaded = true;
      state.available = false;
      state.lastError = `取配置文件路径失败：${errText(e)}——本机仍按内置存储工作`;
      // 失败必须留痕（2026-09-23 教训）：此前只写在内存里，用户看到的是一句
      // 读不出原因的冷话，事后连 ui.log 都查不到。落 console + ui.log 两处。
      log.error('provider-doc', '取配置文件路径失败（providers_dir）', { error: errText(e) });
      notify();
      Obs.configLoad({ ...docSnapshotForObs(), fatal: state.lastError });
      return false;
    }
  }
  if (opts.reloadRuntime) reloadRuntimeFromStorage();
  let text = '';
  try {
    text = await kernelReadFile(state.path);
  } catch {
    // 文件不存在 = 空文档（首启常态：DSH 同款「缺失文档 = 空 store」）
    text = '';
  }
  const doc = parseProvidersDoc(text, knownProtocols());
  if (text !== lastFileText) state.revision += 1;
  lastFileText = text;
  state.loaded = true;
  state.empty = text.trim().length === 0;
  state.errors = doc.errors;
  state.warnings = doc.warnings;
  state.fatal = doc.fatal;
  state.lastError = doc.fatal ?? '';
  if (!doc.fatal && text.trim().length > 0) fileAuthorityConfirmed = true;
  lastSections = doc.sections.map((s) => ({ name: s.name, intent: s.intent }));
  brokenSectionNames = new Set(doc.errors.map((e) => e.name));
  fileKeyOrder = doc.order;
  intentBackupActive = false;
  state.recoveredFromBackup = undefined;
  // 进程刚重启且内存 last-good 为空时，先把独立备份灌进账本：整份 fatal 时它是唯
  // 一回落；逐节报错时有效节会覆盖它、坏节继续由它顶上（与同进程 last-good 同语义）。
  // 同进程已有 last-good 时绝不读盘外备份——内存那份一定更新。
  const backup = lastGoodSections.size === 0 ? readProvidersIntentBackup() : null;
  if (backup) {
    lastGoodSections = new Map(backup.sections.map((section) => [section.name, section]));
    for (const [name, model] of backup.legacyModels) adoptLegacyModel(name, model);
    if (doc.fatal) fileKeyOrder = backup.order;
  }
  if (doc.fatal) {
    if (backup) {
      intentBackupActive = true;
      state.recoveredFromBackup = true;
      const when = backup.capturedAt > 0 ? new Date(backup.capturedAt).toLocaleString() : '时间未知';
      state.lastError = `${doc.fatal}；已从本机 intent 备份恢复 ${backup.sections.length} 节（${when}）`;
    }
  } else {
    // ── 「上一次可用」账（2026-11-16 事故根治）────────────────────────
    // 成功解析的节逐名刷新；坏节按名**保留旧值**（行表靠 effectiveSections 顶上）。
    for (const s of lastSections) lastGoodSections.set(s.name, s);
    // 文件里已经删掉的节必须从 last-good 里除名——否则「上一次可用」会把用户删掉的
    // 行复活（删除是他们明确表达过的意图，不能当成「没读出来」）。
    const alive = new Set(doc.order);
    for (const name of [...lastGoodSections.keys()]) {
      if (alive.has(name)) continue;
      lastGoodSections.delete(name);
      runtimeMap.delete(name);
      clearDynamicProviderState(name);
    }
    // 成功装载 = 本机 last-good 快照的原子刷新点。空文本是「首启/迁移前」，
    // 不拿它覆盖旧备份；有内容（含仅剩文件头 = 用户删空所有 provider）才刷新。
    if (text.trim().length > 0) persistProvidersIntentBackup();
  }
  // 遗留的 model / modelMeta（旧文件里的本机读数）：收进运行态，下次写盘即从文件消失。
  for (const s of doc.sections) {
    adoptLegacyModel(s.name, s.legacyModel);
    if (!s.legacyModelMeta) continue;
    const prev = runtimeMap.get(s.name) ?? { apiKey: '' };
    runtimeMap.set(s.name, { ...prev, modelMeta: { ...prev.modelMeta, ...s.legacyModelMeta } });
  }
  cachedRows = null; // 强制重算
  refreshRows();
  notify();
  // **成功也写**（本接缝的要点）：成功与失败在日志上必须长得不一样，
  // 否则「配置装进来了吗」只能靠推断
  Obs.configLoad(docSnapshotForObs());
  return true;
}

// ⚡ 2026-11-16 项目级配置文件整份拆除（用户裁定｜原设计不是有用的东西）：
//   `{工作区}/.lantai/providers.yml`「同 id 整节覆盖用户级」这套——它带来的是
//   三份互相打架的真相（用户级 / 项目级 / localStorage），而收益（一个仓库一个
//   内网网关不污染全局）在实际使用里不存在。更糟的是它**没有热重载**（watcher
//   只监听用户级），prompt 段却告诉 agent「改完约 1 秒生效」——真机实测：agent
//   写了项目级文件，ui.log 一个字都没有，它还以为配好了。
//   现在只有一份 provider 配置文件：`~/.lantai/providers.yml`。

/** 保存请求的并发/删除约束。 */
export interface SaveProvidersDocOptions {
  /** 用户开始编辑时的磁盘装载代数（`providersDocStatus().revision`）。
   *  watcher 在外改后已重读、而面板还拿着旧草稿时，此值落后于当前代数 ⇒ 拒写。 */
  expectedRevision?: number;
  /** 用户在 UI 里明确删除的节。补丁里没有、这里也没点名的磁盘有效节一律保留
   *  （「没看见」绝不等于「用户删了」）。 */
  pendingDeletes?: readonly string[];
}

export interface SaveProvidersDocResult {
  ok: boolean;
  error?: string;
  /** true = 外部冲突/过期草稿；设置页应转入「放弃暂存并重读」安全出口。 */
  conflict?: boolean;
  /** 冲突后是否可安全重读盘面。磁盘读不到/被删除时为 false——此时别把「读失败」
   *  当成「空配置」灌进投影（先让用户修文件/路径）。 */
  reloadable?: boolean;
}

function rejectProviderSaveConflict(message: string, reloadable = true): SaveProvidersDocResult {
  state.lastError = message;
  notify();
  return { ok: false, error: message, conflict: true, reloadable };
}

/**
 * 写盘：把「provider 名 → 意图」补丁落到**用户级**配置文件（读-改-写，保住手写注释）。
 *
 * **拒写纪律**：
 *   - 磁盘上的手稿解析不了（YAML 语法错）时拒绝写入并给出原因——绝不覆盖用户手稿；
 *   - 保存前比对 `lastFileText` + 编辑起点 revision：外部改动若未被本次补丁吸收，
 *     直接冲突态（不靠 watcher 是否恰好已送达）；
 *   - 磁盘上存在、补丁没写、`pendingDeletes` 也没点名的有效节**原样保留**。
 *
 * @param patch - provider 名 → 意图（名字即身份）。
 * @param opts - 编辑起点 revision + 用户明确删除的节。
 * @returns ok / 人可读失败原因 / 是否外部冲突。
 */
export async function saveProvidersDoc(
  patch: Readonly<Record<string, ProviderIntent>>,
  opts: SaveProvidersDocOptions = {},
): Promise<SaveProvidersDocResult> {
  for (const name of Object.keys(patch)) {
    if (!PROVIDER_NAME_RE.test(name)) {
      return { ok: false, error: `provider 名「${name}」不合法（只允许字母、数字、下划线、连字符）` };
    }
    const sectionCheck = parseSection(name, patch[name], knownProtocols());
    if ('errors' in sectionCheck) return { ok: false, error: sectionCheck.errors.join('\n') };
  }
  if (!state.path && !state.loaded) await loadProvidersDoc();
  if (!state.available || !state.path) {
    // 通道不可用（降级/测试宿主）：不算配置错误，只如实记一条原因让设置页显示
    // ——本机继续按旧语义工作（设置页仍能保存），绝不假装写了文件。
    state.lastError = state.lastError || '配置文件通道不可用——本机按内置存储保存';
    notify();
    return { ok: true };
  }
  if (!isProvidersDocPath(state.path)) {
    return { ok: false, error: `配置文件路径不是 .yml/.yaml：${state.path}` };
  }
  if (opts.expectedRevision !== undefined && opts.expectedRevision !== state.revision) {
    return rejectProviderSaveConflict(
      `配置文件已被外部修改（编辑起点 revision ${opts.expectedRevision}，当前 ${state.revision}）——已阻止保存，请放弃当前暂存并重读后再改。`,
    );
  }
  // 读-改-写：以**磁盘现状**为底。这里同时做文件级冲突闸：watcher 还没送达的
  // 外部编辑也必须挡住；读不到而上次有内容时更不能当成「空文件」重建。
  let disk = '';
  let diskRead = true;
  try {
    disk = await kernelReadFile(state.path);
  } catch {
    disk = '';
    diskRead = false;
  }
  if (disk !== lastFileText) {
    const reason = diskRead
      ? '磁盘内容与上次装载不一致'
      : lastFileText.trim().length > 0
        ? '上次装载的配置文件现在无法读取或已被删除'
        : '配置文件读取状态与上次装载不一致';
    return rejectProviderSaveConflict(
      `配置文件在你编辑期间被外部修改（${reason}）——已阻止保存，请放弃当前暂存并重读后再改。`,
      diskRead || lastFileText.trim().length === 0,
    );
  }
  const check = parseProvidersDoc(disk, knownProtocols());
  if (check.fatal) {
    return { ok: false, error: `配置文件当前无法解析，已拒绝写入（绝不覆盖你正在编辑的内容）：${check.fatal}` };
  }
  // ⚡ 目录里还有**整节读不出来**的节 ⇒ 拒绝整份写入（2026-11-16 事故）：
  //   面板行表里没有那一节，补丁里也就没有它；若照旧写盘，'删掉补丁里没有的节'
  //   会把用户手写的整节（真机上 359 行）静默抹掉。手写错误必须当场修，
  //   修好之前本进程一个字节都不写——错误可见（下面点名到节）。
  if (check.errors.length > 0) {
    const names = check.errors.map((e) => e.name).join('、');
    return {
      ok: false,
      error: `配置文件里这些节读不出来：${names}——修好之前不会写盘（否则会覆盖掉你手写的内容）`,
    };
  }
  // 补丁没覆盖的有效节：只有 pendingDeletes 点名的才允许删；其余原样保留，
  // 连注释/未知前向字段都不碰。坏节双保险继续 keep（见 2026-11-16 事故）。
  const patched = new Set(Object.keys(patch).map((name) => name.toLowerCase()));
  const deleting = new Set((opts.pendingDeletes ?? []).map((name) => name.toLowerCase()));
  const preserve = check.sections
    .filter((section) => {
      const lower = section.name.toLowerCase();
      return !patched.has(lower) && !deleting.has(lower);
    })
    .map((section) => section.name);
  const keep = [...new Set([...brokenSectionNames, ...preserve])];
  try {
    await kernelWriteFile(state.path, applyProvidersDoc(disk, patch, { keep }));
  } catch (e) {
    return { ok: false, error: `写配置文件失败：${errText(e)}` };
  }
  await loadProvidersDoc();
  return { ok: true };
}

/** 单节意图补丁：只改一节里的几个字段，其余节原样。
 *
 *  providers.yml 是连接意图权威；调用方负责只传真正属于文件的字段（`ProviderIntent`
 *  已排除 model / apiKey / 运行态读数）。
 *
 *  两段式（照 `selectPreset` 的「内存态先行、持久化失败可见」口径）：
 *    ① 内存投影立刻改（`loadSettings()` 同拍读到）；
 *    ② 串行落盘（以磁盘现状为底，读-改-写）：失败写进 `state.lastError` + ui.log，
 *       设置页点名可见；下一次装载（watcher / 重启）回落到盘上的旧值——**不假装成功**。
 *
 *  降级域（文件通道不可用 / 文件还空着 / 手稿坏了）：沿用旧语义写 localStorage 那份
 *  ——那个域里 `saveSettings` 不会剥意图（同一判据 `providersFileReady`）。 */
export function patchProviderIntent(name: string, patch: Partial<ProviderIntent>): void {
  if (!PROVIDER_NAME_RE.test(name)) {
    log.error('provider-doc', '意图补丁的 provider 名不合法', { name });
    return;
  }
  if (!providersFileReady()) {
    try {
      const s = loadSettings();
      saveSettings({ ...s, providers: s.providers.map((p) => (p.name === name ? { ...p, ...patch } : p)) });
    } catch (e) {
      log.error('provider-doc', '意图补丁落盘失败（降级域：本地存档）', { name, error: errText(e) });
    }
    return;
  }
  const base = effectiveSections().find((s) => s.name === name)?.intent ?? {};
  /* base 来自已解析的节（kind/baseUrl 必在，节才进得了行表）——补丁只叠字段，
   * 故整体仍是完整意图；`as` 只为把「Partial 叠在完整上」这件事告诉 tsc。 */
  const next = { ...base, ...patch } as ProviderIntent;
  applyIntentInMemory(name, next);
  /* 队列吞掉异常（写盘失败已在 writeIntentPatch 里留痕）——一次失败不许卡死后续写入。 */
  intentWrites = intentWrites.then(() =>
    writeIntentPatch(name, patch).catch((e) =>
      log.error('provider-doc', '意图补丁写盘抛错', { name, error: errText(e) }),
    ),
  );
}

/** 内存投影改一节（串行写盘的底 + 立刻可读的读数；不做磁盘 IO）。 */
function applyIntentInMemory(name: string, next: ProviderIntent): void {
  const clean: ProviderIntent = { ...next };
  for (const key of Object.keys(clean) as (keyof ProviderIntent)[]) {
    if (clean[key] === undefined) delete clean[key];
  }
  const section: Sections[number] = { name: name as ProviderSettings['name'], intent: clean };
  const idx = lastSections.findIndex((s) => s.name === name);
  lastSections = idx >= 0 ? lastSections.map((s, i) => (i === idx ? section : s)) : [...lastSections, section];
  lastGoodSections.set(section.name, section);
  if (!fileKeyOrder.includes(name)) fileKeyOrder = [...fileKeyOrder, name];
  cachedRows = null;
  refreshRows();
  notify();
}

/** 串行写盘队列（拨模型是连点动作：并发写同一份文件会互相覆盖）。 */
let intentWrites: Promise<void> = Promise.resolve();

/** 以**磁盘现状**为底做单节读-改-写（本进程可能错过一次外部编辑；
 *  手稿坏掉/有整节读不出来时 `saveProvidersDoc` 自己会拒写并把原因带回来）。 */
async function writeIntentPatch(name: string, patch: Partial<ProviderIntent>): Promise<void> {
  let disk = '';
  try {
    disk = await kernelReadFile(state.path);
  } catch {
    disk = '';
  }
  const fresh = parseProvidersDoc(disk, knownProtocols());
  if (fresh.fatal) {
    // 手稿解析不了：内存已经改了（本进程读数生效），但**绝不覆盖手稿**——原因可见
    state.lastError = `provider 配置当前无法解析，未写盘：${fresh.fatal}`;
    notify();
    log.error('provider-doc', '意图补丁未写盘（手稿解析失败）', { name, error: fresh.fatal });
    return;
  }
  const full: Record<string, ProviderIntent> = {};
  for (const s of fresh.sections) full[s.name] = s.intent;
  if (!(name in full)) {
    /* 盘上没有这一节（本进程那条来自「上一次可用」回落 / 已被外部删掉）：
     * 只把这一节拼进补丁会写出**缺 kind/baseUrl 的坏节** —— 宁可不动盘，原因可见。 */
    state.lastError = `provider「${name}」不在配置文件里，意图未写盘（先在设置页或文件里补一节）`;
    notify();
    log.error('provider-doc', '意图补丁未写盘（该节不在盘上）', { name });
    return;
  }
  full[name] = { ...full[name], ...patch };
  const res = await saveProvidersDoc(full);
  if (!res.ok) {
    state.lastError = res.error ?? '未知原因';
    notify();
    log.error('provider-doc', '意图补丁写盘失败（下次装载回旧值）', { name, error: res.error });
  }
}

/** 首次落盘骨架（文件不存在时把当前行写出去——存量迁移与首启共用同一条路）。 */
export async function seedProvidersDoc(rows: readonly ProviderSettings[]): Promise<{ ok: boolean; error?: string }> {
  const patch: Record<string, ProviderIntent> = {};
  for (const row of rows) patch[row.name] = intentOf(row);
  if (Object.keys(patch).length > 0) return saveProvidersDoc(patch);
  if (!state.path && !state.loaded) await loadProvidersDoc();
  if (!state.available || !state.path) return { ok: true };
  try {
    await kernelWriteFile(state.path, emptyProvidersDoc());
    await loadProvidersDoc();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `写出配置骨架失败：${errText(e)}` };
  }
}

/** boot 装载 + **一次性存量迁移**（2026-09-24）——必须在装配面第一次
 *  `loadSettings()` 之前调用（bootShell 第一句）。
 *
 *  语义：磁盘上还没有配置内容 ⇒ 把 localStorage 旧存档里的 provider 行写成
 *  配置文件（随后文件即权威）；磁盘上已有内容 ⇒ 只取运行态读数（密钥/探针/
 *  目录快照）挂到同名行上，文件的连接配置一字不动。 */
export async function bootstrapProvidersDoc(): Promise<void> {
  installProvidersDocProjection();
  await loadProvidersDoc();
  // 装载时从旧文件里收割的 model / modelMeta（本机读数迁移源）——下面重建
  // runtimeMap 时**必须合并进来**，否则刚收上来的那批会当场丢掉。
  const harvested = new Map(runtimeMap);
  const stored = storedProviderRows();
  // 运行态读数（密钥/探针/最近模型/目录快照/模型元数据）先按名挂上——**必须在写盘之前**：
  // 迁移出文件之后投影立刻生效，此时 apiKey 就该在（否则设置页那一下会显示空 Key）。
  runtimeMap = new Map(
    stored.map((p) => {
      const rt = runtimeOf(p);
      const legacyRt = harvested.get(p.name);
      // 旧文件里的遗留值补到本机壳缺省处；本机已有最近模型/元数据时以本机为准。
      const model = rt.model?.trim() ? rt.model : legacyRt?.model;
      const modelMeta = legacyRt?.modelMeta ? { ...rt.modelMeta, ...legacyRt.modelMeta } : rt.modelMeta;
      return [
        p.name,
        {
          ...rt,
          ...(model !== undefined && model !== '' ? { model } : {}),
          ...(modelMeta !== undefined ? { modelMeta } : {}),
        },
      ];
    }),
  );
  for (const [name, rt] of harvested) {
    if ((rt.model || rt.modelMeta) && !runtimeMap.has(name)) runtimeMap.set(name, rt);
  }
  cachedRows = null;
  refreshRows();
  if (!state.loaded || state.fatal) {
    notify();
    return;
  }
  if (state.empty && stored.length > 0) {
    const res = await seedProvidersDoc(stored);
    if (!res.ok) {
      // 迁移失败必须可见（否则用户看到「provider 全没了」却不知为什么）——
      // 三处一起：设置页 fatal 文案 + console + ui.log。
      // ⚡ 2026-09-26 真机教训：此前只写内存里的 fatal，ui.log **一个字都没有**，
      //    于是「文件永远建不出来」藏了两天（同期通道失败那条路写了 14 行日志，
      //    两相对比，静默的这条才是最难查的）。失败路径不留痕 = 下次还得靠猜。
      const reason = res.error ?? '未知原因';
      state.fatal = `存量 provider 迁移到配置文件失败：${reason}`;
      log.error('provider-doc', '存量 provider 迁移到配置文件失败', { error: reason, path: state.path });
      notify();
      return;
    }
  }
  cachedRows = null;
  refreshRows();
  notify();
}

/** 武装 watcher 监听（boot 期一次登记；生命周期 = 应用生命周期）。
 *  Rust 侧 `providers:changed`（mtime 轮询）→ 重读 → 复用 settings 广播通道
 *  （UI 重读 + 逐会话重解析），与 composition:changed 同款「热重载 = 重跑装载」。 */
let armed = false;
export function armProvidersWatcher(): void {
  if (armed) return;
  armed = true;
  if (typeof typedListen !== 'function') return; // 通道缺失（mock 宿主）：不武装，不炸
  void typedListen('providers:changed', () => {
    void loadProvidersDoc({ reloadRuntime: true }).then(() => {
      try {
        // 广播走既有 saveSettings（订阅方 UI 重读 + settings-saved 逐会话重解析）
        saveSettings(loadSettings());
      } catch {
        // 广播失败不影响已生效的投影
      }
    });
  });
}

/** 确保配置目录存在（首启用户第一次打开设置页就能看到路径）。
 *  `providers_dir` RPC 自身按需 create_dir_all，这里只负责先把路径取回来。 */
export async function ensureProvidersDir(): Promise<void> {
  if (!state.path && !state.loaded) await loadProvidersDoc();
}

/** **测试专用**：把模块态清回未装载（同一进程内多组用例各跑一遍真实时序）。
 *  生产不使用——应用生命周期里只装载一次，且失败不缓存（见 loadProvidersDoc 注释）。 */
export function __resetProvidersDocForTests(): void {
  state.path = '';
  state.errors = [];
  state.warnings = [];
  state.fatal = undefined;
  state.empty = true;
  state.loaded = false;
  state.available = false;
  state.lastError = '';
  state.revision = 0;
  state.recoveredFromBackup = undefined;
  fileAuthorityConfirmed = false;
  intentBackupActive = false;
  runtimeMap = new Map();
  lastFileText = '';
  lastSections = [];
  lastGoodSections = new Map();
  brokenSectionNames = new Set();
  fileKeyOrder = [];
  cachedRows = null;
  cachedSignature = '';
  armed = false;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

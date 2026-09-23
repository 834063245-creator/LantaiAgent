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
// 运行态读数（探针结果 / 目录快照）→ localStorage。三者不重叠。
//
// 两层文件（单一权威源不破——每层各只有一个来源）：
//   `~/.lantai/providers.yml`  用户级：全局可用的连接配置（人/agent 都能写）；
//   `{工作区}/.lantai/providers.yml` 项目级：同 id **整节覆盖**用户级（一个仓库的
//   内网网关不该污染全局，也不该逼人手抄进全局文件）。
//
// 时序（照 DSH `settings-file` 的「boot 先读、watcher 后武装、就绪后再对账」）：
//   boot: loadProvidersDoc() → installProvidersDocProjection() ← 装配面首次读设置之前
//   live: typedListen('providers:changed') → loadProvidersDoc()（外部编辑热生效）
//   save: saveProvidersDoc(patch)           ← 设置页「保存」统一入口
//
// 纪律：
//   - **手稿解析不了 ⇒ 拒写**（绝不覆盖用户正在编辑的文件——DSH 同款）；
//   - 坏节只坏自己（其余节照常生效），错误面点名到 provider（设置页显示）；
//   - 写盘 = 读-改-写（先重读磁盘再渲染）：绝不复活陈旧文档、不丢本进程没观察到的兄弟节点。

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
  type SectionError,
} from '../provider/providers-doc';
import { CORE_PROTOCOLS } from '../provider/types';
import { kernelReadFile, kernelWriteFile, typedListen, typedRpc } from '../rpc-contract';
import {
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
  /** 逐节错误（坏节点名 + 可读原因）。 */
  errors: SectionError[];
  /** 整份不可用原因（YAML 语法错 / 根不是映射）——此时**拒写**，以手写稿优先。 */
  fatal?: string;
  /** 磁盘上还没有内容（文件不存在 / 全空）——迁移的判据：
   *  空 → 把旧存档的存量写出去（一次性迁移）；非空 → 文件就是权威，不再回填。 */
  empty: boolean;
  /** 是否已从磁盘装载（false = 还没读到，界面应显示「装载中」）。 */
  loaded: boolean;
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
  empty: true,
  loaded: false,
  available: false,
  lastError: '',
};

/** 路径是否像一条真路径（RPC 通道缺失时 mock 会回 "null" 一类哨兵字符串——
 *  那不是路径，写进去只会造出 `./null` 这种垃圾文件）。 */
function looksLikePath(p: string): boolean {
  const t = p.trim();
  if (!t || t === 'null' || t === 'undefined') return false;
  return /^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('/') || t.startsWith('\\\\');
}

/** 文件权威是否**已确认**可用（setting.ts 只在这个条件下才敢剥掉 localStorage
 *  里的意图副本——通道没确认之前剥 = 丢掉用户唯一的配置来源）。 */
export function providersFileReady(): boolean {
  return state.available && state.loaded && !state.fatal;
}
/** 运行态读数（provider 名 → 探针结果/目录快照/密钥），localStorage 的作者。 */
let runtimeMap = new Map<string, ProviderRuntime>();
/** 用户级文件原文（写盘时做读-改-写的底）。 */
let lastFileText = '';
/** 用户级解析出的节。 */
let lastSections: Sections = [];
/** 项目级文件解析出的节/错误（打开工作区时装载）。 */
let projectSections: Sections = [];
let projectErrors: SectionError[] = [];
let projectFatal: string | undefined;
let cachedRows: ProviderSettings[] | null = null;
let cachedSignature = '';
const listeners = new Set<Listener>();

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

/** 当前生效的节 = 项目级覆盖同名用户级节（顺序：用户级在前，项目级独有接尾）。 */
function effectiveSections(): Sections {
  if (projectSections.length === 0) return lastSections;
  const override = new Map(projectSections.map((s) => [s.name, s.intent]));
  const out: Sections = lastSections.map((s) => {
    const hit = override.get(s.name);
    return hit ? { name: s.name, intent: hit } : s;
  });
  const seen = new Set(lastSections.map((s) => s.name));
  for (const s of projectSections) if (!seen.has(s.name)) out.push(s);
  return out;
}

function runtimeOf(p: ProviderSettings): ProviderRuntime {
  return {
    apiKey: p.apiKey ?? '',
    ...(p.lastTest !== undefined ? { lastTest: p.lastTest } : {}),
    ...(p.catalog !== undefined ? { catalog: p.catalog } : {}),
  };
}

/** 重新计算投影（签名没变则复用同一数组引用——打字/滚轮热路径上 loadSettings 高频）。 */
function refreshRows(): void {
  const runtimeSig = [...runtimeMap.entries()]
    .map(([k, v]) => `${k}|${v.apiKey.length}|${v.lastTest?.at ?? 0}|${v.catalog?.length ?? 0}`)
    .join(',');
  const signature = `${lastFileText.length}:${state.fatal ?? ''}:${projectSections.length}:${projectFatal ?? ''}:${runtimeSig}`;
  if (cachedRows && signature === cachedSignature) return;
  cachedSignature = signature;
  const rt = (name: string): ProviderRuntime => runtimeMap.get(name) ?? { apiKey: '' };
  cachedRows = effectiveSections().map(({ name, intent }) => mergeIntent(name, intent, rt(name)));
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
      if (!providersFileReady()) return fallback;
      refreshRows();
      return cachedRows ?? [];
    },
  });
  installProvidersFileReadyCheck(providersFileReady);
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
        notify();
        return false;
      }
    } catch (e) {
      state.loaded = true;
      state.available = false;
      state.lastError = `取配置文件路径失败：${errText(e)}——本机仍按内置存储工作`;
      notify();
      return false;
    }
  }
  if (opts.reloadRuntime) {
    runtimeMap = new Map(loadSettings().providers.map((p) => [p.name, runtimeOf(p)]));
  }
  let text = '';
  try {
    text = await kernelReadFile(state.path);
  } catch {
    // 文件不存在 = 空文档（首启常态：DSH 同款「缺失文档 = 空 store」）
    text = '';
  }
  const doc = parseProvidersDoc(text, knownProtocols());
  lastFileText = text;
  state.loaded = true;
  state.empty = text.trim().length === 0;
  state.errors = doc.errors;
  state.fatal = doc.fatal;
  state.lastError = doc.fatal ?? '';
  lastSections = doc.sections.map((s) => ({ name: s.name, intent: s.intent }));
  cachedRows = null; // 强制重算
  refreshRows();
  notify();
  return true;
}

/** 读项目级覆盖（打开工作区时调一次；无文件 = 无覆盖，常态）。 */
export async function loadProjectProvidersDoc(projectPath: string): Promise<void> {
  const path = projectProvidersFilePath(projectPath);
  projectSections = [];
  projectErrors = [];
  projectFatal = undefined;
  if (path) {
    try {
      const text = await kernelReadFile(path);
      const doc = parseProvidersDoc(text, knownProtocols());
      projectSections = doc.sections.map((s) => ({ name: s.name, intent: s.intent }));
      projectErrors = doc.errors;
      projectFatal = doc.fatal;
    } catch {
      // 无项目级文件 = 常态
    }
  }
  cachedRows = null;
  refreshRows();
  notify();
}

/** 项目级配置文件路径（工作区未打开 = 空串）。 */
export function projectProvidersFilePath(projectPath: string): string {
  const base = projectPath.replace(/[\\/]+$/, '');
  return base ? `${base}/.lantai/providers.yml` : '';
}

/** 项目级文档的逐节错误（设置页显示；与用户级错误分开报）。 */
export function projectProvidersErrors(): readonly SectionError[] {
  return projectErrors;
}

/** 项目级文档整份不可用原因。 */
export function projectProvidersFatal(): string | undefined {
  return projectFatal;
}

/**
 * 写盘：把「provider 名 → 意图」补丁落到**用户级**配置文件（读-改-写，保住手写注释）。
 *
 * **拒写纪律**：磁盘上的手稿解析不了（YAML 语法错）时拒绝写入并给出原因——
 * 绝不覆盖用户正在编辑的文件（那会把它的手稿整份冲掉）。
 *
 * @param patch - provider 名 → 意图（名字即身份；不在补丁里的节会被删）。
 * @returns ok / 人可读失败原因。
 */
export async function saveProvidersDoc(
  patch: Readonly<Record<string, ProviderIntent>>,
): Promise<{ ok: boolean; error?: string }> {
  for (const name of Object.keys(patch)) {
    if (!PROVIDER_NAME_RE.test(name)) {
      return { ok: false, error: `provider 名「${name}」不合法（只允许字母、数字、下划线、连字符）` };
    }
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
  // 读-改-写：以**磁盘现状**为底（本进程可能错过了一次外部编辑）
  let disk = '';
  try {
    disk = await kernelReadFile(state.path);
  } catch {
    disk = '';
  }
  const check = parseProvidersDoc(disk, knownProtocols());
  if (check.fatal) {
    return { ok: false, error: `配置文件当前无法解析，已拒绝写入（绝不覆盖你正在编辑的内容）：${check.fatal}` };
  }
  try {
    await kernelWriteFile(state.path, applyProvidersDoc(disk, patch));
  } catch (e) {
    return { ok: false, error: `写配置文件失败：${errText(e)}` };
  }
  await loadProvidersDoc();
  return { ok: true };
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
  const stored = storedProviderRows();
  // 运行态读数（密钥/探针/目录快照）先按名挂上——**必须在写盘之前**：
  // 迁移出文件之后投影立刻生效，此时 apiKey 就该在（否则设置页那一下会显示空 Key）。
  runtimeMap = new Map(stored.map((p) => [p.name, runtimeOf(p)]));
  cachedRows = null;
  refreshRows();
  if (!state.loaded || state.fatal) {
    notify();
    return;
  }
  if (state.empty && stored.length > 0) {
    const res = await seedProvidersDoc(stored);
    if (!res.ok) {
      // 迁移失败必须可见（否则用户看到「provider 全没了」却不知为什么）
      state.fatal = `存量 provider 迁移到配置文件失败：${res.error ?? '未知原因'}`;
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

/** 运行态读数写回（探针结果 / 目录快照——设置页保存与后台拉取共用）。
 *  合并语义：只覆盖给到的字段，其余保持磁盘现状。 */ export function persistProviderRuntime(
  name: string,
  patch: Partial<ProviderRuntime>,
): void {
  const s = loadSettings();
  runtimeMap.set(name, { ...(runtimeMap.get(name) ?? { apiKey: '' }), ...patch });
  cachedRows = null;
  saveSettings({
    ...s,
    providers: s.providers.map((p) => (p.name === name ? { ...p, ...patch } : p)),
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
  state.fatal = undefined;
  state.empty = true;
  state.loaded = false;
  state.available = false;
  state.lastError = '';
  runtimeMap = new Map();
  lastFileText = '';
  lastSections = [];
  projectSections = [];
  projectErrors = [];
  projectFatal = undefined;
  cachedRows = null;
  cachedSignature = '';
  armed = false;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

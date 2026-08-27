// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// roster 组合引擎（S2-0）—— 组合外化的解析层（设计件
// docs/plans/composition-architecture/designs/S2-composition-externalization.md §2.1-2.3）。
//
// 四行域模型：tools（插件贡献行——①b 后 builtin 行表退役）/ prompt（通道段
// 贡献快照——S4-4 甲）/ capabilities（ctx.capabilities 贡献快照——B⑤ 后
// builtin 表退役，第一方十五项经通道注册，plugins/capability-segments-plugin）
// / shell（builtinShellRows）。
// 七 seam 裁剪域（平台化 Phase 3，2026-08-27）：`seam/llm` `seam/subagents`
// `seam/fs` `seam/shell` `seam/sessionPersistence` `seam/graph` `seam/loopEvents`
// ——Phase 1/2 的 swappable seam 贡献并进组合解析域，patch/preset 可禁用/
// 换默认 provider（禁用默认行后「后注册胜」落到替代 provider；loopEvents =
// D4 emit 观测域的事件面开关）。键名 `seam/` 前缀与四行域隔离（`shell` 键
// 已被壳行域占用）；行源 = factoryComposition() 的 seams 快照（注册表 =
// 实现真源，组合 = 裁剪真源，见 seam-resolution.ts）。
// 出厂层是代码——行实现留代码、patch 只写增量，杜绝「yml 复述全量清单」的
// 双真源漂移（对 DSH 的第一处刻意偏离：学它的 patch 语义——id 寻址 /
// disabled / insert / last-write-wins——不学它的文件形态，它的行是 npm 包
// 所以必须全量 yml，兰台的行是编译期 factory）。
//
// 解析域（S4-4 甲，2026-08-23）：factoryComposition() 是「出厂组合快照」
// ——tools 域 = pluginToolRows()（①b 后 builtin 行表退役，插件贡献行是
// 唯一行源；序 = 通道注册序），prompt 域 = ctx.prompts 段贡献，patch/
// preset 因此寻址贡献行。快照语义：读取时点的通道装载态决定解析域——同
// 装载态同输出；resolveRoster 本身仍是纯函数（factory 是输入不是环境
// 读取）。无通道环境 = 空行表 + 空段表（B④ 收官的注册面依赖语义不变
// ——convergence 夹具经通道腰复现生产装配）。
//
// 解析语义（§2.3）：
//   - 纯函数：同输入同输出（不读环境/时钟/盘）——确定性按构造保证，
//     不按环境保证（S1 设计件 §2.3 纪律的延续）；
//   - 逐层逐条按序应用，last-write-wins：后层覆盖先层，同层同 id 后条
//     覆盖前条；disabled:false = 显式启用（供 overlay 层反向覆盖先层禁用）；
//   - prompt 域 text 覆盖 = 整段替换（对齐 DSH「patch replaces the targeted
//     row's whole config rather than merging」）：保 id、保表位、保 applicable
//     参与条件，仅 render 换固定文本——动态插值（graphSnapshot/memory 等）
//     随覆盖丢失，用户换整段就接管整段（文档如实声明）；
//   - insert 仅 prompt 域；锚点（before/after）必须存在于当前工作列表
//     （含已禁用行——禁用行在终步才被丢弃；同层先插的段可作后插段的锚）。
//     insert 带位置锚是对 DSH 的第二处刻意偏离：DSH 行序无装载语义可
//     append，兰台行序 = 字节契约（表序 = 组合序 = 前缀缓存语义），
//     插到哪必须显式声明；
//   - 终步才丢禁用行（工作列表全程保留标记，锚定/诊断都不受影响）。
//
// 错误政策（all-or-nothing，按文件）：校验失败、未知 id、insert 撞 id、
// 锚点不存在 → resolveRoster throw CompositionPatchError，整个 patch 拒绝、
// 任何一条不应用——部分应用 = 静默错配（用户以为禁了，实际没禁）。
// 调用方（composition/patch-loader.ts，S2-2）捕获后回退出厂组合并让
// 错误可见（对齐 INVARIANTS #11.2 的用户级数据文件毒化容忍纪律）。
//
// 本文件不 parse yaml（loader 的职责，S2-2）——输入是已 parse 的 unknown，
// zod v4 校验产出 CompositionPatch（与 plugins/types.ts 的 manifest 同一
// 纪律：一个 schema 产出运行时校验 + 类型，禁手写平行接口）。
// 同理不提供 !!js 表达式（对 DSH 的第三处偏离）：保纯函数确定性，
// 组合文件不是代码执行面（完全信任模型由通道层承担，不由表达式层承担）。

import { z } from 'zod';
import type { AgentCapability } from '../agent/blueprint';
import { LOOP_EVENT_NAMES } from '../agent/events';
import { activeCapabilityContributions } from './capability-service';
import { registeredFsProviders } from './fs-service';
import { registeredGraphProviders } from './graph-service';
import { pluginToolRows } from './plugin-tool-rows';
import type { PromptSection } from './prompt-sections';
import { activePromptContributions } from './prompt-service';
import { EMPTY_SEAM_DISABLED, SEAM_DOMAINS, type SeamDisabledMap } from './seam-resolution';
import { registeredLlmAdapters } from './services';
import { registeredSessionPersistenceProviders } from './session-persistence-service';
import { builtinShellRows, type ShellRow } from './shell-rows';
import { registeredShellProviders } from './shell-service';
import { registeredSubagentProviders } from './subagent-service';
import type { BuiltinToolRow } from './tool-rows';

// ── patch 条目 schema ──

const idField = z.string().min(1);

/** disable-only 域（tools/capabilities/shell）条目：id + disabled 必填
 *  （false = 显式启用，供后层覆盖先层禁用；无操作条目在 schema 层拒绝）。 */
const DisableEntrySchema = z.strictObject({
  id: idField,
  disabled: z.boolean(),
});

/** prompt 域普通条目：disabled 与 text 二选一（并存/全缺均拒绝——
 *  「写了但什么都不发生」的字段是手误，错误不静默）。 */
const PromptEntrySchema = z
  .strictObject({
    id: idField,
    disabled: z.boolean().optional(),
    text: z.string().optional(),
  })
  .refine((v) => (v.disabled !== undefined) !== (v.text !== undefined), {
    message: 'prompt 条目必须且只能带 disabled 或 text 之一',
  });

/** prompt 域 insert 条目：文本段 + 可选位置锚（before/after 互斥，
 *  都缺省 = 追加表尾）。 */
const PromptInsertSchema = z
  .strictObject({
    id: idField,
    text: z.string(),
    before: idField.optional(),
    after: idField.optional(),
  })
  .refine((v) => !(v.before !== undefined && v.after !== undefined), {
    message: 'insert 的 before 与 after 互斥，只能带一个',
  });

/** prompt 域条目：普通条目 | 单条 insert 包装（数组至少一项——空 insert
 *  是无操作条目，拒绝）。 */
const PromptDomainEntrySchema = z.union([
  PromptEntrySchema,
  z.strictObject({ insert: z.array(PromptInsertSchema).min(1) }),
]);

/** 用户组合 patch 文件的结构（S2 设计件 §2.2）：一个文件、四个行域键 + 七个
 *  seam 裁剪域键（平台化 Phase 3——`seam/<域>` 键名，与行域键隔离），缺哪个
 *  域 = 该域无增量。未知顶层键拒绝（strict）。 */
export const CompositionPatchSchema = z.strictObject({
  tools: z.array(DisableEntrySchema).optional(),
  prompt: z.array(PromptDomainEntrySchema).optional(),
  capabilities: z.array(DisableEntrySchema).optional(),
  shell: z.array(DisableEntrySchema).optional(),
  // ── seam 裁剪域（平台化 Phase 3）：disable 条目，语义 = 对应 ctx seam 注册
  //    表的「后注册胜」扫描面剔除该 id（消费视图 = 活动注册表 − 禁用集）。
  //    loopEvents 域条目 id = D4 事件名（emit 观测域；裁决域不开放）。 ──
  'seam/llm': z.array(DisableEntrySchema).optional(),
  'seam/subagents': z.array(DisableEntrySchema).optional(),
  'seam/fs': z.array(DisableEntrySchema).optional(),
  'seam/shell': z.array(DisableEntrySchema).optional(),
  'seam/sessionPersistence': z.array(DisableEntrySchema).optional(),
  'seam/graph': z.array(DisableEntrySchema).optional(),
  'seam/loopEvents': z.array(DisableEntrySchema).optional(),
});

export type CompositionPatch = z.infer<typeof CompositionPatchSchema>;

export type PatchParseResult = { ok: true; patch: CompositionPatch } | { ok: false; error: string };

/** patch 文件（已 parse 的 unknown）→ 校验结果。错误显式返回不静默兜底
 *  （对齐 plugins/types.ts 的 validateManifest 形状）。 */
export function parseCompositionPatch(raw: unknown): PatchParseResult {
  const result = CompositionPatchSchema.safeParse(raw);
  if (result.success) return { ok: true, patch: result.data };
  const error = result.error.issues
    .map((issue) => (issue.path.join('.') || '(root)') + ': ' + issue.message)
    .join('; ');
  return { ok: false, error };
}

// ── 组合数据类型 ──

/** seam 寻址行（平台化 Phase 3）：`seam/<域>` 域的行源——provider / 事件的
 *  稳定 id。解析只消费 id（裁剪寻址面）；实现本体由各 seam 注册表持有
 *  （注册表 = 实现真源，组合 = 裁剪真源，见 seam-resolution.ts 头注）。 */
export interface SeamAddressRow {
  id: string;
}

/** seam 寻址域快照（factoryComposition 按域聚合；键 = SEAM_DOMAINS）。 */
export type SeamAddressRows = Readonly<Record<(typeof SEAM_DOMAINS)[number], readonly SeamAddressRow[]>>;

/** 出厂组合 — 三张 TS 表 + 壳行表 + seam 寻址域的聚合（唯一真源，永不出 yml）。 */
export interface FactoryComposition {
  tools: BuiltinToolRow[];
  prompt: PromptSection[];
  capabilities: AgentCapability[];
  shell: ShellRow[];
  /** seam 寻址域（平台化 Phase 3）——`seam/<域>` 域的合法行 id 源。 */
  seams: SeamAddressRows;
}

/** 解析产物 — 存活行列表（按最终表序）+ seam 寻址行/裁剪面 + 诊断信息。
 *  S2-1 起穿线进装配面（buildToolRegistry / assembleSystemPrompt /
 *  AgentBlueprint.fromRoster / 壳引导）；S2-2 起由 composition-store 持有。
 *  结构可赋给 FactoryComposition（resolvePresetComposition / patch-loader
 *  以 factoryComposition() 产物直接作入参——既有穿线保持）。 */
export interface ResolvedComposition {
  tools: BuiltinToolRow[];
  prompt: PromptSection[];
  capabilities: AgentCapability[];
  shell: ShellRow[];
  /** seam 寻址域存活行（平台化 Phase 3）——禁用行已滤除；实现本体归各
   *  seam 注册表（注册表 = 实现真源），此处是寻址/展示/后续装配绑定的行面。 */
  seams: SeamAddressRows;
  /** seam 裁剪面（平台化 Phase 3）——各 seam 域被禁用的 provider/事件 id。
   *  消费视图 = 活动注册表 − 本表（晚注册可见，除非显式禁用）；composition-store
   *  写入口经 applySeamDisabled 灌入运行时（seam-resolution.ts）。 */
  seamDisabled: SeamDisabledMap;
  /** 终态诊断（信息性，供 store/UI 呈现）：禁用行 / 被覆盖段 / 插入段 id。 */
  diagnostics: CompositionDiagnostics;
}

export interface CompositionDiagnostics {
  disabled: string[];
  overridden: string[];
  inserted: string[];
}

/** patch 应用失败（未知 id / insert 撞 id / 锚点不存在）——调用方捕获后
 *  回退出厂组合（all-or-nothing：throw 即整体拒绝，无部分应用）。 */
export class CompositionPatchError extends Error {
  constructor(message: string) {
    super('[composition] ' + message);
    this.name = 'CompositionPatchError';
  }
}

/** 出厂组合 — 段清单/壳行表 + 当前通道贡献的快照（恒等解析产物：
 *  零增量 + 空诊断）。既作 resolveRoster 的 FactoryComposition 入参，也作
 *  穿线的 ResolvedComposition 缺省值。
 *  S4-4 甲（2026-08-23）：tools 域收编插件贡献折算行（plugin/<贡献 id>，
 *  序 = 通道注册序）；prompt 域收编 ctx.prompts 段贡献（注册序）。快照
 *  读取时点的通道装载态——贡献 register/dispose 后须重取（preset-assembly
 *  的 cache 代数 + bootShell 贡献监听负责重解析）。①b（2026-08-23）：
 *  builtin 行表全量迁毕退役——tools 域唯一行源 = pluginToolRows()。
 *  B⑤（2026-08-24）：capabilities 域 = ctx.capabilities 贡献快照（唯一
 *  行源——第一方十五项经 capabilitySegmentsPlugin 通道注册，序 = 迁移前
 *  出厂表序；builtinCapabilities() 退役，无通道环境 = 空表——B④ prompt
 *  域注册面依赖同款语义；贡献 register/dispose 同为组合输入变更，第三条
 *  代数挂点）。 */
export function factoryComposition(): ResolvedComposition {
  return {
    tools: pluginToolRows(),
    prompt: activePromptContributions(),
    capabilities: activeCapabilityContributions(),
    shell: builtinShellRows(),
    seams: {
      llm: registeredLlmAdapters().map((a) => ({ id: a.id })),
      subagents: registeredSubagentProviders().map((p) => ({ id: p.id })),
      fs: registeredFsProviders().map((p) => ({ id: p.id })),
      shell: registeredShellProviders().map((p) => ({ id: p.id })),
      sessionPersistence: registeredSessionPersistenceProviders().map((p) => ({ id: p.id })),
      graph: registeredGraphProviders().map((p) => ({ id: p.id })),
      loopEvents: LOOP_EVENT_NAMES.map((id) => ({ id })),
    },
    seamDisabled: EMPTY_SEAM_DISABLED,
    diagnostics: { disabled: [], overridden: [], inserted: [] },
  };
}

// ── 解析引擎 ──

/** 工作列表条目：寻址 id + 行 + 禁用标记（终步才过滤，锚定与诊断全程可见）。
 *  id 是 roster 寻址面：tools/prompt/shell 用行自身 id；capabilities 用
 *  capability key（行无 id 字段——S2 设计件 §2.1「行 id = 现 key」）。 */
interface WorkRow<T> {
  id: string;
  row: T;
  disabled: boolean;
}

/** prompt 域工作条目：额外记录 text 覆盖（诊断用）。 */
interface PromptWorkRow extends WorkRow<PromptSection> {
  overridden: boolean;
}

function toWorkRows<T extends { id: string }>(rows: T[]): WorkRow<T>[] {
  return rows.map((row) => ({ id: row.id, row, disabled: false }));
}

function toCapWorkRows(caps: AgentCapability[]): WorkRow<AgentCapability>[] {
  return caps.map((row) => ({ id: row.key, row, disabled: false }));
}

function toPromptWorkRows(sections: PromptSection[]): PromptWorkRow[] {
  return sections.map((row) => ({ id: row.id, row, disabled: false, overridden: false }));
}

/** disable 应用：id 寻址 + last-write-wins（重复条目后写覆盖先写）。 */
function applyDisable<T>(list: WorkRow<T>[], id: string, disabled: boolean, domain: string): void {
  const entry = list.find((e) => e.id === id);
  if (!entry)
    throw new CompositionPatchError(`未知行 id: "${id}"（${domain} 域——不在出厂行表/插件贡献行 nor 已插入行）`);
  entry.disabled = disabled;
}

/** insert 应用：id 冲突拒绝 + 锚点寻址（含禁用行）+ 即时生效（后插段
 *  可锚先插段）。insert 段恒参与拼装（无 applicable）。 */
function insertPromptRow(list: PromptWorkRow[], ins: PromptInsertEntry): void {
  if (list.some((e) => e.id === ins.id)) {
    throw new CompositionPatchError(`insert 段 id 冲突: "${ins.id}"（prompt 域已有同 id 行）`);
  }
  const row: PromptSection = { id: ins.id, render: () => ins.text };
  const entry: PromptWorkRow = { id: ins.id, row, disabled: false, overridden: false };
  if (ins.before !== undefined) {
    const idx = list.findIndex((e) => e.id === ins.before);
    if (idx < 0) throw new CompositionPatchError(`insert 锚点不存在: before "${ins.before}"`);
    list.splice(idx, 0, entry);
    return;
  }
  if (ins.after !== undefined) {
    const idx = list.findIndex((e) => e.id === ins.after);
    if (idx < 0) throw new CompositionPatchError(`insert 锚点不存在: after "${ins.after}"`);
    list.splice(idx + 1, 0, entry);
    return;
  }
  list.push(entry);
}

/** zod 推断的窄化别名（insert 条目形状）。 */
type PromptInsertEntry = z.infer<typeof PromptInsertSchema>;

/** patch 条目类型（disable 域条目）。 */
type DisableEntry = z.infer<typeof DisableEntrySchema>;

/** seam 域条目寻址（穷举 switch——计算键不能索引 strictObject 推断类型，
 *  漏域由 exhaustiveness 编译期钉住）。 */
function seamEntries(
  layer: CompositionPatch,
  domain: (typeof SEAM_DOMAINS)[number],
): readonly DisableEntry[] | undefined {
  switch (domain) {
    case 'llm':
      return layer['seam/llm'];
    case 'subagents':
      return layer['seam/subagents'];
    case 'fs':
      return layer['seam/fs'];
    case 'shell':
      return layer['seam/shell'];
    case 'sessionPersistence':
      return layer['seam/sessionPersistence'];
    case 'graph':
      return layer['seam/graph'];
    case 'loopEvents':
      return layer['seam/loopEvents'];
  }
}

/** 组合解析主入口（纯函数）。
 *
 *  语义见文件头注释；空层列表 = 恒等（resolveRoster(factory, []) 与出厂
 *  表 id+序 全等、seamDisabled 全空——这是 S2 各批「零漂移」的构造性保证，
 *  S2-0 测试钉住）。抛 CompositionPatchError = 整体拒绝（all-or-nothing）。 */
export function resolveRoster(factory: FactoryComposition, layers: CompositionPatch[]): ResolvedComposition {
  const tools = toWorkRows(factory.tools);
  const capabilities = toCapWorkRows(factory.capabilities);
  const shell = toWorkRows(factory.shell);
  const prompt = toPromptWorkRows(factory.prompt);

  // seam 裁剪域（平台化 Phase 3）：每域一张工作列表；条目 id = provider/事件
  // 稳定 id。禁用集 = 终态 disabled 行的 per-域收集（ResolvedComposition.
  // seamDisabled —— 消费视图的裁剪面）；启用的 seam 行进解析产物寻址面。
  const seamWork: Record<(typeof SEAM_DOMAINS)[number], WorkRow<SeamAddressRow>[]> = {
    llm: toWorkRows([...factory.seams.llm]),
    subagents: toWorkRows([...factory.seams.subagents]),
    fs: toWorkRows([...factory.seams.fs]),
    shell: toWorkRows([...factory.seams.shell]),
    sessionPersistence: toWorkRows([...factory.seams.sessionPersistence]),
    graph: toWorkRows([...factory.seams.graph]),
    loopEvents: toWorkRows([...factory.seams.loopEvents]),
  };

  const overriddenIds: string[] = [];
  const insertedIds: string[] = [];

  for (const layer of layers) {
    for (const entry of layer.tools ?? []) {
      applyDisable(tools, entry.id, entry.disabled, 'tools');
    }
    for (const entry of layer.capabilities ?? []) {
      applyDisable(capabilities, entry.id, entry.disabled, 'capabilities');
    }
    for (const entry of layer.shell ?? []) {
      applyDisable(shell, entry.id, entry.disabled, 'shell');
    }
    for (const domain of SEAM_DOMAINS) {
      const entries = seamEntries(layer, domain) ?? [];
      for (const entry of entries) {
        applyDisable(seamWork[domain], entry.id, entry.disabled, 'seam/' + domain);
      }
    }
    for (const entry of layer.prompt ?? []) {
      if ('insert' in entry) {
        for (const ins of entry.insert) {
          insertPromptRow(prompt, ins);
          insertedIds.push(ins.id);
        }
        continue;
      }
      // 普通条目（schema refine 已保证 disabled XOR text，此处再 narrowing）
      const idx = prompt.findIndex((e) => e.id === entry.id);
      if (idx < 0)
        throw new CompositionPatchError(`未知段 id: "${entry.id}"（prompt 域——不在段贡献/出厂段表 nor 已插入段）`);
      if (entry.disabled !== undefined) {
        prompt[idx].disabled = entry.disabled;
      } else {
        const text = entry.text ?? '';
        prompt[idx].row = { ...prompt[idx].row, render: () => text };
        if (!prompt[idx].overridden) {
          prompt[idx].overridden = true;
          overriddenIds.push(entry.id);
        }
      }
    }
  }

  // 终步：过滤禁用行（disabled 诊断按表序收集终态）+ seam 禁用集收集
  const disabledIds: string[] = [];
  const finish = <T>(list: WorkRow<T>[]): T[] => {
    const out: T[] = [];
    for (const e of list) {
      if (e.disabled) {
        disabledIds.push(e.id);
        continue;
      }
      out.push(e.row);
    }
    return out;
  };

  const seamResolved: Record<(typeof SEAM_DOMAINS)[number], SeamAddressRow[]> = {
    llm: [],
    subagents: [],
    fs: [],
    shell: [],
    sessionPersistence: [],
    graph: [],
    loopEvents: [],
  };
  const seamDisabledOut: Record<(typeof SEAM_DOMAINS)[number], string[]> = {
    llm: [],
    subagents: [],
    fs: [],
    shell: [],
    sessionPersistence: [],
    graph: [],
    loopEvents: [],
  };
  for (const domain of SEAM_DOMAINS) {
    for (const e of seamWork[domain]) {
      if (e.disabled) {
        disabledIds.push(e.id);
        seamDisabledOut[domain].push(e.id);
        continue;
      }
      seamResolved[domain].push(e.row);
    }
  }

  return {
    tools: finish(tools),
    prompt: finish(prompt),
    capabilities: finish(capabilities),
    shell: finish(shell),
    seams: seamResolved,
    seamDisabled: seamDisabledOut,
    diagnostics: { disabled: disabledIds, overridden: overriddenIds, inserted: insertedIds },
  };
}

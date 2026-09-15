// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 插件激活账（S6 P3a，2026-09-15）——「登记 ≠ 激活」的载体。
//
// 病灶（设计件 §1.2 缺口 3）：插件的**登记**（行/段/capability 进注册表）与
// 副作用的**启动**在今天不可分——都在 `apply()` 那一刻。于是「某插件的常驻服务
// 只在选中它的卷上激活」做不到：boot 期一次装载就是全局的。
//
// 本模块把两件事拆开：
//   登记（boot 期，全局）：插件在 apply 里 `declareActivation(名字, spec)` 只**登记**
//     一份 spec（含 start/stop），**不启动任何副作用**；
//   激活（装配期，按组合）：某组合里有该插件的存活行 ⇒ `retainActivation` →
//     引用计数 ++，**首次** 才 `start()`；释放（Agent dispose / 切组合）→ 计数 --，
//     归零 → `stop()`。
//
// 键 = **插件名**（manifest.name，npm scope 风格），不是行 id：激活是插件级的
// 生命周期，一行一账会把同一插件的多个行拆成多份副作用。
//
// 谁被激活（P3a 的来源面）：**只问声明过激活的插件**——声明本身就是索引，故
// 不需要全量插件名册（不引第二真源）。判定 = 该组合**存活工具行**里有没有
// `plugin/<插件名>/…` 前缀的行（行 id 由 composition/plugin-tool-rows 折算，
// 见 tool-rows.ts 的 id 命名空间）。P3b 另加显式来源 `requires:`（组合层声明）；
// 只贡献面板/命令/提示词段（无工具行）的插件因此**必须**靠 requires 显式声明
// ——这是本层的诚实边界，不为它建第二条索引。
//
// kill switch（设计件 §5）：**没有插件声明激活 ⇒ 本层全程 no-op**（retain 返回
// null、plan 空集、release 无动作）⇒ P3 前语义（登记即激活）逐字节保持不变，
// 不需要 revert 代码。
//
// 生命周期与所有权：`retain` 由装配面调用，返回的句柄交给调用方挂 `ctx.effect`
// （与 composition/seam-scope.ts 同款）——释放走既有 ctx 所有权链，不新造拆除路径
// （INVARIANTS #12）。
//
// 模块级可变态归属（CONVENTIONS §1.10 第 3 类：键控自清理注册表——键 = 插件名，
// 卸载即清、归零即清账）。**叶模块纪律**：零项目内运行时 import（仅类型可用
// `import type`，esbuild 擦除）——本文件一旦长出一条通往 state/*-store 或
// composition/preset-assembly 的静态边即成环（症状见
// tests/composition-import-cycle.test.ts 头注：曾连坐 46 个测试文件）。

/** 资源类型闭集（设计件 §3.5 / WO-S6P3 §2.4）——手误的类名是错误，不静默放过。 */
export const ACTIVATION_RESOURCE_KINDS = ['pty', 'stdio', 'port', 'listener', 'window'] as const;

export type ActivationResource = (typeof ACTIVATION_RESOURCE_KINDS)[number];

/** 插件的激活声明（apply 期登记；P3 前语义 = 登记即启动，本层把启动挪到激活时）。 */
export interface ActivationSpec {
  /** 该插件占用的资源类型（诊断/清单面；`exclusive` 的实例名另见下）。 */
  resources?: readonly ActivationResource[];
  /** **不可共享**的资源实例名（`port:9310` / `listener:fs-watch` / `stdio` …）：
   *  同一时刻只允许一个组合持有——冲突在装配期 fail loud（P3b 的冲突检测消费面；
   *  P3a 只登记，不检测）。 */
  exclusive?: readonly string[];
  /** 首次激活（引用计数 0 → 1）时启动副作用。抛错 = 激活失败（可见，不静默）。 */
  start(): void | Promise<void>;
  /** 引用计数归零时停止副作用（缺省 = 无需停止）。 */
  stop?(): void | Promise<void>;
}

/** 激活句柄——装配期记账的凭据（释放只减自己那一份；幂等）。 */
export interface ActivationHandle {
  plugin: string;
  /** 持有者（装配面传 Agent id；诊断与「同一持有者只计一次」的判据）。 */
  holder: string;
  /** 该次激活是否成功（false = start 抛错——P3b 据此跳过该插件的行并进诊断第四栏）。 */
  ok: boolean;
  failure: string | null;
}

/** 激活账读面（诊断/测试：某插件当前几个持有者、起没起来、上一次失败原因）。 */
export interface ActivationState {
  plugin: string;
  holders: number;
  started: boolean;
  failure: string | null;
}

/** 组合里参与激活判定的最小形状：
 *  - `tools`：存活的工具行 id 清单（隐含属主来源——ResolvedComposition 的结构子集）；
 *  - `activationDecl`：组合层的 `requires` / `exclusive` 声明（S6 P3b）——
 *    `requires` 是**显式**激活来源（只贡献面板/命令、没有工具行的插件靠它声明），
 *    `exclusive` 是组合自己声明的独占资源（与插件 spec.exclusive 同等参与冲突检测）。 */
export interface CompositionActivationInput {
  tools: readonly { id: string }[];
  activationDecl?: { requires?: readonly string[]; exclusive?: readonly string[] } | null;
}

interface LedgerEntry {
  holders: Set<string>;
  started: boolean;
  /** 在途的首次 start（并发 retain 共享同一份，不重复启动）。 */
  starting: Promise<void> | null;
  failure: string | null;
  /** 本插件当前持有的独占资源实例名（归零时释放）。 */
  claims: string[];
}

/** 被跳过的条目（诊断第四栏的生产者：插件激活失败——副作用没起来）。 */
export interface ActivationSkip {
  /** 被跳过的对象 id——这里 = 插件名（它的行面可能因此不可用）。 */
  id: string;
  reason: string;
}

/** 独占资源冲突记录（拒绝后装配者的原因；留档供诊断面回看）。 */
export interface ActivationConflict {
  resource: string;
  /** 已持有该资源的插件。 */
  heldBy: string;
  /** 本次被拒绝的插件（后装配者）。 */
  rejected: string;
  reason: string;
}

// ── 声明表（键 = 插件名） ──

const declarations = new Map<string, ActivationSpec>();

// ── 账（键 = 插件名；归零即删——不留零计数空账） ──

const ledger = new Map<string, LedgerEntry>();

// ── 独占资源持有表（键 = 资源实例名 → 持有它的插件） ──

const claims = new Map<string, string>();

/** 上一次独占冲突（null = 无）。 */
let lastConflict: ActivationConflict | null = null;

function errText(e: unknown): string {
  return e instanceof Error ? e.name + ': ' + e.message : String(e);
}

/** 声明形状校验（装载期拒绝，错误不静默——对齐 ContributionChannel.validate 纪律）。 */
function validateSpec(plugin: string, spec: ActivationSpec): void {
  if (typeof plugin !== 'string' || plugin.trim() === '') {
    throw new Error('[activation] 声明必须带非空插件名（manifest.name 形状，如 acme/notes）');
  }
  if (typeof spec?.start !== 'function') {
    throw new Error('[activation] 插件 ' + plugin + ' 的 activation 声明缺 start 回调（登记即激活 = 没接线）');
  }
  for (const r of spec.resources ?? []) {
    if (!(ACTIVATION_RESOURCE_KINDS as readonly string[]).includes(r)) {
      throw new Error(
        '[activation] 插件 ' +
          plugin +
          ' 声明了未知资源类型 "' +
          r +
          '（合法：' +
          ACTIVATION_RESOURCE_KINDS.join(' / ') +
          '）',
      );
    }
  }
}

/** 登记一份激活声明（apply 期调用；**不启动任何副作用**）。返回 disposer
 *  （幂等 + 陈旧性守卫：同插件换 spec 重登记后，旧 disposer 不误清新声明）。 */
export function declareActivation(plugin: string, spec: ActivationSpec): () => void {
  validateSpec(plugin, spec);
  if (declarations.has(plugin)) {
    throw new Error('[activation] 插件 ' + plugin + ' 重复声明激活（装载期拒绝，不静默覆盖）');
  }
  declarations.set(plugin, spec);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (declarations.get(plugin) === spec) {
      declarations.delete(plugin);
      // 声明撤销 = 该插件的账失去启动依据：账条目一并清（在途副作用归调用方
      // 经 ctx.effect 的 release 收）；已启动的 stop 由 release 路径负责。
      ledger.delete(plugin);
    }
  };
}

/** 已声明激活的插件名清单（诊断/测试面）。 */
export function declaredActivations(): string[] {
  return [...declarations.keys()];
}

/** 该插件是否声明过激活（loader 的「声明-接线对齐」校验消费面）。 */
export function activationDeclared(plugin: string): boolean {
  return declarations.has(plugin);
}

/** 本组合要激活的插件 = **声明在册** ∩（组合里有它的存活工具行 ∪ 组合显式 `requires` 它）。
 *
 *  隐含来源判定 = 行 id 前缀 `plugin/<插件名>/`（行 id 由 composition/plugin-tool-rows
 *  折算；贡献 id 约定 `<插件名>/<行名>` ⇒ 行 id 恒有第三段，前缀含尾斜杠故
 *  不会把 `hologram/web` 与 `hologram/web-domain` 判混）。
 *  显式来源（S6 P3b）= 组合层 `requires`——只贡献面板/命令（无工具行）的插件
 *  只能靠它声明，这是本层的诚实边界（不为它建第二条索引）。
 *
 *  纯读、不 mutate；无声明插件 ⇒ 空集（零漂移：出厂 43 插件今天零声明）。
 *  `requires` 里**未声明激活**的插件不进激活集（没有副作用可起；它的可满足性
 *  由 preset-assembly.selectionError 判定——两件事分开）。 */
export function activationPlan(comp: CompositionActivationInput | null | undefined): string[] {
  if (!comp || declarations.size === 0) return [];
  const ids = comp.tools.map((r) => r.id);
  const required = new Set(comp.activationDecl?.requires ?? []);
  const out: string[] = [];
  for (const plugin of declarations.keys()) {
    const prefix = 'plugin/' + plugin + '/';
    if (ids.some((id) => id.startsWith(prefix)) || required.has(plugin)) out.push(plugin);
  }
  return out;
}

/** 本组合声明的独占资源（组合层 `exclusive`）由装配面（ctx.activation 的
 *  retainForComposition）取出并随 retain 传入本模块——与插件 spec.exclusive
 *  并集后参与持有表（同一个资源被两处声明 = 同一份约束，不重复登记）。 */

/** 激活某插件（引用计数 ++）。未声明 ⇒ null（**no-op**——kill switch 语义）；
 *  首次激活 ⇒ `await start()`；start 抛错 ⇒ 记账可见（failure）且**不抛**给
 *  装配面（P3b 据此跳过行，装配本身不因一个插件起不来而整链失败）。
 *  并发首次激活共享同一份在途 start（不重复启动副作用）。 */
export async function retainActivation(
  plugin: string,
  holder: string,
  extraExclusive: readonly string[] = [],
): Promise<ActivationHandle | null> {
  const spec = declarations.get(plugin);
  if (!spec) return null;
  // 独占资源冲突（S6 P3b）：同一资源实例同一时刻只允许一个插件持有——
  // 冲突发生在**装配期**（fail loud，拒绝后装配者），不在运行时静默降级。
  // 同一插件重复 retain（多卷）不构成冲突（它就是持有者本身）。
  // ⚠ 冲突检查必须在**建账之前**：被拒绝的插件不得留下任何账目（连零计数
  // 空账也不行——否则诊断面会把它当成「在场的插件」，且它是装配被拒者）。
  const exclusive = [...new Set([...(spec.exclusive ?? []), ...extraExclusive])];
  for (const resource of exclusive) {
    const heldBy = claims.get(resource);
    if (heldBy !== undefined && heldBy !== plugin) {
      const reason =
        '独占资源冲突：「' +
        resource +
        '」已被插件 ' +
        heldBy +
        ' 持有，插件 ' +
        plugin +
        ' 不能同时持有（两个组合都在位——关掉其中一个，或把资源声明改成可共享）';
      lastConflict = { resource, heldBy, rejected: plugin, reason };
      throw new Error('[activation] ' + reason);
    }
  }
  let entry = ledger.get(plugin);
  if (!entry) {
    entry = { holders: new Set(), started: false, starting: null, failure: null, claims: [] };
    ledger.set(plugin, entry);
  }
  for (const resource of exclusive) {
    claims.set(resource, plugin);
    if (!entry.claims.includes(resource)) entry.claims.push(resource);
  }
  entry.holders.add(holder);
  if (!entry.started) {
    if (!entry.starting) {
      const target = entry;
      target.starting = Promise.resolve()
        .then(() => spec.start())
        .then(
          () => {
            target.started = true;
            target.failure = null;
            target.starting = null;
          },
          (e: unknown) => {
            target.failure = errText(e);
            target.starting = null;
            console.warn('[activation] 插件 ' + plugin + ' 激活失败（副作用未启动）:', e);
          },
        );
    }
    await entry.starting;
  }
  return { plugin, holder, ok: entry.started && entry.failure === null, failure: entry.failure };
}

/** 释放一份激活（引用计数 --；归零 ⇒ `await stop()` + 清账）。幂等：同一句柄
 *  重复释放只减一次（持有者集合判据，不是裸计数）。 */
export async function releaseActivation(handle: ActivationHandle | null | undefined): Promise<void> {
  if (!handle) return;
  const entry = ledger.get(handle.plugin);
  if (!entry) return;
  if (!entry.holders.delete(handle.holder)) return; // 幂等 / 陈旧句柄
  if (entry.holders.size > 0) return;
  const spec = declarations.get(handle.plugin);
  ledger.delete(handle.plugin);
  // 归零 ⇒ 独占资源释放（只释放仍归自己的那些：别的插件可能已接手同名声明的重登记路径）
  for (const resource of entry.claims) {
    if (claims.get(resource) === handle.plugin) claims.delete(resource);
  }
  if (entry.started && spec?.stop) {
    try {
      await spec.stop();
    } catch (e) {
      // 停止失败必须可见（INVARIANTS #11.2 的「失败不静默」同族），但不得
      // 让拆卸链断在这里——调用方（ctx.effect disposer）已无补救手段。
      console.warn('[activation] 插件 ' + handle.plugin + ' 停用失败:', e);
    }
  }
}

/** 批量释放（装配面把句柄数组交给一个 ctx.effect disposer——组内串行逆序由
 *  fiber 负责；本函数按传入序释放）。 */
export async function releaseActivations(handles: readonly ActivationHandle[]): Promise<void> {
  for (const h of handles) await releaseActivation(h);
}

/** 激活账快照（诊断/测试面；只读拷贝）。 */
export function activationStates(): ActivationState[] {
  return [...ledger.entries()].map(([plugin, e]) => ({
    plugin,
    holders: e.holders.size,
    started: e.started,
    failure: e.failure,
  }));
}

/** 某插件上一次激活失败原因（null = 无失败）。 */
export function activationFailure(plugin: string): string | null {
  return ledger.get(plugin)?.failure ?? null;
}

/** 诊断第四栏的读面（S6 P3b）：**被跳过的插件**（激活失败——副作用没起来）。
 *  这是「某行不见了」的第四种原因（前三：未选中 / 被禁用 / seam 裁剪），
 *  与它们处置动作相同（去设置›插件处理），故与前三栏并列呈现、但**带原因**
 *  （前三栏是单因纯 id 列表，第四栏三因同栏，纯 id 会让「原因可见」落空）。 */
export function activationSkipped(): ActivationSkip[] {
  return [...ledger.entries()]
    .filter(([, e]) => e.failure !== null)
    .map(([plugin, e]) => ({ id: plugin, reason: e.failure as string }));
}

/** 上一次独占资源冲突（null = 无）——冲突时装配被拒（fail loud），本记录
 *  让「拒了谁、因为谁」在诊断面可回看。 */
export function activationConflict(): ActivationConflict | null {
  return lastConflict;
}

/** 当前被持有的独占资源（诊断/测试面：资源名 → 持有它的插件）。 */
export function activationClaims(): Array<{ resource: string; plugin: string }> {
  return [...claims.entries()].map(([resource, plugin]) => ({ resource, plugin }));
}

/** 测试隔离辅助——清空声明表与账（生产代码禁用；vitest 同 worker 模块态跨用例共享）。 */
export function clearActivationsForTest(): void {
  declarations.clear();
  ledger.clear();
  claims.clear();
  lastConflict = null;
}

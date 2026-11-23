// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// code-run 宿主侧 — Worker 生命周期 + 敌意校验 + 嵌套执行桥。
//
// 一次 run() = 一个 worker 实例（用完即弃——免去跨 run 状态清理的坑；
// worker 创建 ~ms 级，一次 code_execution 的体量下可忽略）。
//
// 三层防御（对齐计划 D1/R1 与 DSH protocol 纪律）：
//   1. 形状层（parseWorkerMessage）：非法消息静默丢弃；
//   2. 语义层（本文件 run 循环）：call.id 一次性（Set 记账，重复应答过即拒）、
//      name 必须属于绑定集、args 无损 JSON 归一失败即拒；
//   3. 预算层：logs + 完成值字节预算，宿主侧独立计账（不信 worker 上报），
//      超限即 terminate 并归一为 output-limit 失败。
//
// 嵌套执行语义（P3 起）：绑定面 = CodeBindingSpec（name + invoke + readOnly），
// invoke 闭包持有全部宿主上下文（executor 等价体/审计钩子）——runtime 不知道
// 工具与会话，消费者自己管（DSH 接缝纪律）。
//
// 并发契约（P2，2026-10-30 换代）：读类不进任何链（并行不设限）；写类按
// `lockKey` 分片——`'file:<abs path>'` 同键串行、异键并行；`'*'` 是排他闸
// （等在途键控写排空 → 阻塞新键控写 → 自己跑 → 放行，跨工具安全网：shell/git）；
// `null` 不加锁。缺省 `'*'` ⇒ 未声明分片的写行为与旧实现逐字等价（这是本批
// 「零漂移」的证据，见 tests/code-execution.test.ts 的读并行写串行用例）。
// 域工具的只读判定走 `readOnlyFor(args)`（按动作），否则回落 `readOnly`。

import { WORKER_BOOTSTRAP_SOURCE } from './bootstrap';
import type { CodeDispatchRecord } from './dispatch-record';
import {
  type CodeReplyCode,
  type CodeRunResult,
  nearestName,
  normalizeJsonArgs,
  parseWorkerMessage,
  type WorkerToHost,
} from './protocol';

/** 绑定调用结果（P3）：`code`/`hint` 会原样进 reply，成为程序内 Error 的属性。 */
export interface CodeBindingOutcome {
  output: string;
  isError: boolean;
  /** 失败分类；缺省且 isError ⇒ 'tool-error'。 */
  code?: CodeReplyCode;
  /** 可行动的提示（"你是不是想写 X" / 可用清单 / 换哪条路走）。 */
  hint?: string;
}

/** 嵌套调用的运行时上下文（P0，2026-11 长任务批）。
 *
 *  为什么给 invoke 这个第二参数：外层程序的墙钟是**唯一**知道「还剩多少真实时间」
 *  的地方，而内层工具（shell）自己的超时预算可能比它更长——那个倒挂正是
 *  「vitest 永远跑不完」的根因（120s 墙 vs 300s shell 超时，外层先死、job id
 *  永远产生不了）。把剩余预算与 run 作用域信号交给 binding，内层才有机会在
 *  外层死之前把自己转成后台作业。 */
export interface CodeBindingContext {
  /** 距本次 run 的 deadline 还剩多少毫秒（惰性调用时刻算，可 ≤ 0 = 已过期）。 */
  remainingMs: number;
  /** run 作用域中止信号：外层中止、超时、任何 finish 都会触发（INV-1 永不孤儿）。
   *  内层工具据此 kill 子进程——不再出现「程序死了、进程还在跑」。 */
  signal: AbortSignal;
  /** 宿主侧预算改写（P0-2，2026-11-22）：只在真改写时出现。
   *  `args` = 改写**前**的 args —— 审计必须记模型给的那一份，否则日志会撒谎
   *  （卷 155/167 的 `timeoutMs: 111983` 就是这么写进历史的）。 */
  budget?: {
    args: Record<string, unknown>;
    rewrite: BudgetRewrite;
  };
}

/** 前台窗口预算（P0-2，2026-11-22）：**按动作**声明哪些超时可以压。
 *
 *  判据只有一条：**压短不改变结果类别**。
 *  - `run`：超时 = 转后台（Rust promote），命令继续跑、模型拿到 job id；
 *  - `wait`：超时 = 「还在跑」（Rust 返回 `[任务运行中]`），再等一次即可。
 *  两者压短都只让「结果更早到」，不制造失败。其余动作（`output`/`kill`…）没有
 *  前台窗口这回事，压它们只会往 args 里塞模型没给过的参数——卷 167 的
 *  `DISPATCH#7 shell output 3 tmo=111991` 就是这么来的（审计污染）。
 *
 *  为什么按动作而不是按工具（2026-11-22 卷 167 事故）：旧声明 `deadline:'promote'`
 *  是**整条工具**的属性，于是 shell 的 `wait` 借走了 `run` 的「无损」语义——
 *  可 wait 的超时当时是 Err，压完就变成「程序里 await 抛异常」。工具级声明
 *  太粗：它把兄弟动作的语义一起借走了。 */
export interface SoftTimeoutPlan {
  /** 模型面超时参数名（缺省 `'timeoutMs'`）。 */
  arg?: string;
  /** 模型没给时的请求预算（惰性——读**活 schema** 的 default，别闭包捕获死实例）。
   *  缺省 = 不参与判定（只有模型显式给了 timeoutMs 才压）。 */
  defaultTimeoutMs?: () => number | undefined;
  /** 已不需要前台窗口的调用：原样透传（不压也不改）。
   *  卷 155 实证：`runInBackground:true` 的命令压 timeoutMs 没有任何行为效果，
   *  只会把模型没传过的值写进审计。 */
  detached?: (args: Record<string, unknown>) => boolean;
  /** 压缩余量（缺省 = SOFT_TIMEOUT_MARGIN_MS）。wait 没有 promote 宽限窗，
   *  余量只留给 IPC，可以小得多。 */
  marginMs?: number;
  /** 压缩下限（缺省 = MIN_FOREGROUND_MS）：低于它时按 `onExhausted` 改写；
   *  没声明 `onExhausted` 就压到极短窗口兜底（软动作，仍然无损）。 */
  floorMs?: number;
  /** 剩不下前台窗口时的**改写**（返回改写后的 args；缺省 = 不改，交 abort）。
   *  shell run 用 `runInBackground:true`：给模型一个句柄，而不是让外层墙把
   *  刚起的进程 kill 掉（尾部窗口里唯一无损的处置）。 */
  onExhausted?: (args: Record<string, unknown>) => Record<string, unknown>;
}

/** 一次预算改写的台账（审计要同时记「模型给的原值」与「改写」，缺一不可）。 */
export interface BudgetRewrite {
  /** 被改写的参数名。 */
  arg: string;
  /** 请求原值（模型显式给的，或动作缺省算出来的——改写只在拿到数值时发生）。 */
  from: number;
  /** 压到的值（detach 时无）。 */
  to?: number;
  kind: 'clamp' | 'detach';
}

/** 绑定声明（P3）：一个可被程序调用的宿主能力。
 *  invoke 闭包持有宿主上下文（executor 等价体/审计）——runtime 不知道
 *  工具与会话，消费者自己管。 */
export interface CodeBindingSpec {
  /** 程序内命名空间名（`tools.<name>`）。 */
  name: string;
  /** 是否只读（可并行）。域工具按动作判定时用 readOnlyFor，本字段是兜底。 */
  readOnly: boolean;
  /** 按**本次参数**判定是否只读（域工具：`action` 命中只读动作白名单即并行）。
   *  缺省（undefined）= 回落 `readOnly`。注意：读取必须走**活注册表**
   *  （域门面是构建期快照，闭包捕获构造期实例会读到过期动作集——计划 §3.4）。 */
  readOnlyFor?: (args: Record<string, unknown>) => boolean;
  /** 写锁键：null = 不加锁；'*' = 排他闸；其余 = 键控（同键串行、异键并行）。
   *  缺省（undefined）= '*'（保守：未声明分片的写仍全局串行）。 */
  lockKey?: (args: Record<string, unknown>) => string | null;
  /** 前台窗口预算（P0-2）：动作名 → 压制策略。未列出的动作原样透传。
   *  非域工具（没有 action 参数）用 `'*'` 键。 */
  softTimeout?: Record<string, SoftTimeoutPlan>;
  /** 执行体：返回结果文本 + 是否失败（+ 可选分类码/提示——P3；+ P0 的运行时上下文）。 */
  invoke: (args: Record<string, unknown>, ctx?: CodeBindingContext) => Promise<CodeBindingOutcome>;
}

/** code run 宿主配置。 */
export interface CodeRunHostOptions {
  /** 输出预算（字节，logs+完成值共享）。缺省 256KB。
   *  为什么是 256KB 而不是 DSH 的 64MB：兰台的预算直接进上下文（没有 spill 面），
   *  256KB ≈ 65k tokens 已是「真的倒了一大片输出」的量级；再大只会压爆窗口。 */
  maxOutputBytes?: number;
  /** 单次 run 墙钟上限（ms）。缺省 120s（对齐 shell 兜底）。 */
  timeoutMs?: number;
  /** 中止信号（外层 agent run 中止时级联）。 */
  signal?: AbortSignal | null;
  /** 绑定集（P3 起为唯一能力面；空集 = 程序只能纯计算）。 */
  bindings: CodeBindingSpec[];
  /** 每次嵌套调用落定后的回调（2026-11-21 纸面显形批）：给展示面用的
   *  **旁路**——不改变程序看到的返回值，也不替代 session-log 审计
   *  （审计在 capability 段的 invoke 闭包里，两本账互不替代）。
   *  为什么挂在宿主侧：这是唯一同时知道 name / args / outcome / 序的位置。 */
  onDispatch?: (d: CodeDispatchRecord) => void;
  /** 程序结束后才落定的一次调用（P1-2 待领信箱）：每落定一条回调一次。
   *  与 onDispatch 的分工：onDispatch 只在 run 活着时报展示面；本回调专收「程序
   *  已经结束、结果迟到」的那些——消费者（Agent）负责存到下一轮注入，只投递一次。 */
  onLateResult?: (entry: LateNestedResult) => void;
  /** 程序返回后等写链排空的宽限（ms）。缺省 3000（对齐 DSH stopGraceMs）：
   *  不理会取消的写调用（MCP / office）不该把「完成」拖成「超时」——到点照样
   *  结算为完成，迟到的结果走待领信箱（onLateResult）。 */
  settleGraceMs?: number;
  /** 同时在途的嵌套调用上限。缺省 128（对齐 DSH maxPendingCalls）。
   *  读类不进任何链——没有这个上限，`Promise.all` 一千个读会同时打宿主
   *  （每个都是一次 IPC + 一次工具执行），表现为整机卡顿而不是一条可读错误。 */
  maxPendingCalls?: number;
  /** Worker 工厂（注入面 — 测试用 fake；缺省真实 Web Worker）。 */
  createWorker?: (source: string) => CodeWorkerLike;
}

/** 嵌套分发面（旧注入形状，工具装配层适配用）— P3 兼容别名。
 *  dispatch + (name/readOnly) 清单的组合在此折叠为绑定集。 */
export type ToolDispatchFn = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ output: string; isError: boolean }>;

/** P2 兼容构造：dispatch + 名称清单 → 绑定集（闭包捕获 dispatch）。 */
export function bindingsFromDispatch(
  dispatch: ToolDispatchFn,
  names: Array<{ name: string; readOnly: boolean }>,
): CodeBindingSpec[] {
  return names.map((n) => ({ ...n, invoke: (args) => dispatch(n.name, args) }));
}

/** worker 最小面（注入抽象）。 */
export interface CodeWorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** 默认 worker 工厂：blob module worker（R5 spike 验证可用）。 */
function createRealWorker(source: string): CodeWorkerLike {
  const blob = new Blob([source], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url, { type: 'module' });
  // url 立即释放安全：worker 已加载脚本（规范允许 revoke 后已启动的 worker 继续）
  URL.revokeObjectURL(url);
  return w as unknown as CodeWorkerLike;
}

/** 结果首行（展示面摘要用）：截到 80 字符，空白归一。
 *  只做「一眼看出它干了什么」，完整输出仍在程序里 / 日志里。 */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const t = line.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

/** 失败回复里的**调用身份**（P0-2）：`name(action:"…", jobId:N)`。
 *  程序内的一条失败只有 message 能回到模型；没有身份时「等待超时」这种文本
 *  无法定位是哪个调用、哪个 job——下一次排查等于重跑一遍。 */
function callLabel(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof args.action === 'string') parts.push(`action:"${args.action}"`);
  if (typeof args.jobId === 'number') parts.push(`jobId:${args.jobId}`);
  return parts.length > 0 ? `${name}(${parts.join(', ')})` : name;
}

/** 工具层已把失败统一写成 `error: <msg>`——再加身份时不重复这个前缀。 */
function stripErrorPrefix(output: string): string {
  return output.startsWith('error: ') ? output.slice('error: '.length) : output;
}

/** UTF-8 字节计长（与 worker 侧 byteLen 同语义；宿主侧独立计账用）。 */
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 按 UTF-8 字节上限取前缀（P4）：按码点切，不劈开代理对。 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Len(text) <= maxBytes) return text;
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const cost = utf8Len(ch);
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    out += ch;
  }
  return out;
}

/** 写调度闸（P2）：读不进闸；写按 lockKey 分片 ——
 *  - `'file:<path>'` 同键串行、异键并行；
 *  - `'*'` 排他：等在途键控写排空 → 阻塞新键控写 → 自己跑 → 放行（跨工具安全网）；
 *  - `null` 不加锁（仅测试/显式声明）。
 *  公平性约定：排他闸一经请求即**同步**计入 pending，其后到达的键控写一律排在它后面
 *  ——提交序 = 审计序，可预测；代价是排他闸闻到前的一个键控写仍会先跑完（有界）。 */
interface WriteGate {
  write(lockKey: string | null, task: () => Promise<void>): Promise<void>;
  /** 等在途写全部排空（finish 收尾用——审计完整性是同一条纪律）。 */
  drain(): Promise<void>;
}

function createWriteGate(): WriteGate {
  /** 锁键 → 该键的链尾（同键串行）。 */
  const keyed = new Map<string, Promise<void>>();
  let activeKeyed = 0;
  let exclusivePending = 0;
  let exclusiveRunning = false;
  let exclusiveChain: Promise<void> = Promise.resolve();
  const keyedIdle: Array<() => void> = [];
  const exclusiveIdle: Array<() => void> = [];

  const wake = (list: Array<() => void>): void => {
    for (const f of list.splice(0)) f();
  };
  const keyedIdlePromise = (): Promise<void> =>
    activeKeyed === 0 ? Promise.resolve() : new Promise<void>((res) => keyedIdle.push(res));
  const exclusiveIdlePromise = (): Promise<void> =>
    exclusivePending === 0 && !exclusiveRunning
      ? Promise.resolve()
      : new Promise<void>((res) => exclusiveIdle.push(res));

  async function writeKeyed(key: string, task: () => Promise<void>): Promise<void> {
    while (exclusivePending > 0 || exclusiveRunning) await exclusiveIdlePromise();
    activeKeyed++;
    const prev = keyed.get(key) ?? Promise.resolve();
    const cur = prev
      .then(task)
      .catch(() => {})
      .finally(() => {
        activeKeyed--;
        if (activeKeyed === 0) wake(keyedIdle);
      });
    keyed.set(key, cur);
    await cur;
    if (keyed.get(key) === cur) keyed.delete(key);
  }

  function writeExclusive(task: () => Promise<void>): Promise<void> {
    exclusivePending++;
    const run = exclusiveChain
      .then(async () => {
        await keyedIdlePromise();
        exclusiveRunning = true;
        try {
          await task();
        } finally {
          exclusiveRunning = false;
        }
      })
      .catch(() => {});
    exclusiveChain = run;
    void run.finally(() => {
      exclusivePending--;
      if (exclusivePending === 0 && !exclusiveRunning) wake(exclusiveIdle);
    });
    return run;
  }

  return {
    write(lockKey, task) {
      if (lockKey === null) return task();
      if (lockKey === '*') return writeExclusive(task);
      return writeKeyed(lockKey, task);
    },
    async drain() {
      await exclusiveChain.catch(() => {});
      await keyedIdlePromise();
    },
  };
}

/** Rust 前台超时后的**宽限窗**（`src-tauri/src/commands/process_cap.rs` 的
 *  `PROMOTE_GRACE_MS`）：超时点之后 Rust 还会再等这么久让命令自己收尾；真没完
 *  才 promote 成 job，并把 `shell:done{promotedJobId}` 发回来。
 *
 *  跨语言同源数字，**必须与 Rust 逐字一致**——守护测试
 *  `tests/code-budget-contract.test.ts` 直接读 process_cap.rs 对拍。
 *  卷 167 的教训：宿主只减了 8s 余量，而宽限窗是 10s，于是「无损压缩」差 2s 就
 *  变成「外层先死 → abort 把刚起/刚 promote 的进程 kill 掉」。预算算术必须把
 *  **对端自己的收尾延迟**算进去，不能只算 IPC 往返。 */
export const PROMOTE_GRACE_MS = 10_000;
/** 压缩余量 = 宽限窗 + IPC/drain 头寸（5s：事件回传、drain 线程、调度抖动）。 */
export const SOFT_TIMEOUT_MARGIN_MS = PROMOTE_GRACE_MS + 5_000;
/** 前台下限：压到这里以下就不再压——尾部窗口改走 `onExhausted`（给句柄），
 *  没声明 `onExhausted` 的软动作则压到极短窗口兜底（见 `MIN_TINY_WINDOW_MS`）。 */
const MIN_FOREGROUND_MS = 15_000;
/** 软动作的极短窗口下限：再小就不压（程序本身已经要结束了）。 */
const MIN_TINY_WINDOW_MS = 1_000;
/** 程序墙钟硬上限（P2-1）：模型可传 timeoutMs，但不得超过它（对齐 shell 的 10 分钟）。 */
const MAX_TIMEOUT_MS = 600_000;

/** 在途调用台账的一条（INV-3）：run 结束时要能说清「谁还在跑、跑了多久」。
 *  seq 是展示面旁路的配对键（2026-11-23 运行态批）：收尾时据此把还没落定的那条
 *  running 记录收成 error，而不是让卡片永远显示「在跑」。 */
interface InflightCall {
  seq: number;
  name: string;
  startedAt: number;
}

/** 程序已结束后才落定的调用（P1-2 待领信箱的原料）。
 *  为什么必须留：程序超时/中止时，不可后台化的长调用（MCP / office / 子 Agent）
 *  可能几秒后**成功了**——旧行为在这里静默 return，等于让模型把同一件事重做一遍。 */
export interface LateNestedResult {
  name: string;
  elapsedMs: number;
  output: string;
  isError: boolean;
}

/** 给失败结果补一段在途清算（INV-3：超时不得只回一句 typing）。
 *  只补有在途的场合——程序自身异常时它已经拿到了自己的栈，再垫一段清单是噪音。 */
function withInflightNote(result: CodeRunResult, pending: InflightCall[], late: LateNestedResult[]): CodeRunResult {
  if (!result.error || (pending.length === 0 && late.length === 0)) return result;
  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push('在途调用已中止（内层收到取消信号，子进程一并停止）：');
    const now = Date.now();
    for (const c of pending) lines.push(`- ${c.name} 已跑 ${((now - c.startedAt) / 1000).toFixed(1)}s`);
  }
  if (late.length > 0) {
    lines.push(`另有 ${late.length} 个调用在程序结束后才返回，结果未纳入本次结果。`);
  }
  return { ...result, error: { ...result.error, message: `${result.error.message}\n\n${lines.join('\n')}` } };
}

/** INV-2 预算穿透（P0-2 改写）：把本次调用的超时压到外层剩余预算内。
 *
 *  只对 `softTimeout` 里**显式列出的动作**生效——判据是「压短不改变结果类别」
 *  （run → 转后台；wait → 还在跑）。压别的动作 = 提前杀它，所以必须由 binding
 *  按动作声明，不能按工具名猜（旧的工具级 `deadline:'promote'` 让 wait 借走了
 *  run 的语义，见卷 167）。
 *
 *  三条不压：预算本来就够（零漂移）、动作没声明、调用已交后台或请求值拿不到。
 *  压不出一个前台窗口时（尾部窗口）按 `onExhausted` 改写——shell run 直接给
 *  job id，而不是压出一个「刚起就超时」的命令、更不是让外层墙把进程 kill 掉。 */
export function applyBudget(
  binding: CodeBindingSpec,
  args: Record<string, unknown>,
  remaining: number,
): { args: Record<string, unknown>; rewrite?: BudgetRewrite } {
  const plan = binding.softTimeout;
  if (!plan) return { args };
  const action = typeof args.action === 'string' ? args.action : '*';
  const entry = plan[action] ?? plan['*'];
  if (!entry) return { args };
  if (entry.detached?.(args)) return { args };
  const arg = entry.arg ?? 'timeoutMs';
  const raw = args[arg];
  const requested = typeof raw === 'number' ? raw : entry.defaultTimeoutMs?.();
  if (typeof requested !== 'number') return { args };
  const budget = remaining - (entry.marginMs ?? SOFT_TIMEOUT_MARGIN_MS);
  if (requested <= budget) return { args };
  const floor = entry.floorMs ?? MIN_FOREGROUND_MS;
  if (budget >= floor) {
    const to = Math.floor(budget);
    return { args: { ...args, [arg]: to }, rewrite: { arg, from: requested, to, kind: 'clamp' } };
  }
  if (entry.onExhausted) {
    return { args: entry.onExhausted(args), rewrite: { arg, from: requested, kind: 'detach' } };
  }
  // 软动作的尾部兜底：极短的前台窗口也比「让外层墙把进程 kill 掉」好——
  // 压到 1s 起仍然无损（run 会立刻 promote，wait 会立刻回「还在跑」）。
  const tiny = Math.floor(budget);
  if (tiny >= MIN_TINY_WINDOW_MS) {
    return { args: { ...args, [arg]: tiny }, rewrite: { arg, from: requested, to: tiny, kind: 'clamp' } };
  }
  return { args };
}

/** 运行一次 code run。resolve 恒为 CodeRunResult（失败也在 error 字段里，
 *  不 reject——外层工具把 error 归一为结构化失败文本）。 */
export async function runCode(program: string, opts: CodeRunHostOptions): Promise<CodeRunResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? 256 * 1024;
  const timeoutMs = Math.min(opts.timeoutMs ?? 120_000, MAX_TIMEOUT_MS);
  const settleGraceMs = opts.settleGraceMs ?? 3_000;
  const maxPendingCalls = opts.maxPendingCalls ?? 128;
  const bindingMap = new Map(opts.bindings.map((b) => [b.name, b]));
  const createWorker = opts.createWorker ?? createRealWorker;
  const signal = opts.signal ?? null;

  const logs: string[] = [];
  let usedBytes = 2; // "[]" 形态（与 worker 侧同口径）
  let outputLimited = false;
  let settled = false;
  // 展示面旁路的调用序（与 session-log 的 dispatchCounter 各自独立）：2026-11-23
  // 起在**起跑时**发号，落定事件沿用同一 seq——展示面才能原地把「在跑」改成成败。
  let dispatchSeq = 0;

  // 预算穿透的唯一时钟（INV-2）：每次嵌套调用按「此刻还剩多少」算，不另设第二套计时。
  const deadlineAt = Date.now() + timeoutMs;
  const remainingMs = (): number => deadlineAt - Date.now();
  // run 作用域取消（INV-1）：跟随外层 signal，且任何 finish 都会触发——
  // 在途调用据此自行 kill 子进程，而不是被 worker.terminate() 甩成孤儿。
  const runController = new AbortController();
  const runSignal = runController.signal;
  // 在途台账（INV-3）：调用开始登记、落定删除；run 结束时剩下什么就报什么。
  const inflight = new Map<number, InflightCall>();
  // 程序结束后才返回的调用（P0 报个数 / P1-2 起把它们的结果投递给下一轮）。
  const lateSettled: LateNestedResult[] = [];

  // 写调度闸：读不进闸；写按 lockKey 分片（缺省 '*' = 与旧「一条写链」逐字等价）
  const gate = createWriteGate();

  const worker = createWorker(WORKER_BOOTSTRAP_SOURCE);

  /** 展示面旁路（2026-11-21）：一次调用两条——起跑与落定。故障不阻断程序
   *  （与 hooks 的降级同款；旁路只是纸面，不是执行事实）。 */
  const emitDispatch = (d: CodeDispatchRecord): void => {
    try {
      opts.onDispatch?.(d);
    } catch {
      /* 展示面故障不阻断程序 */
    }
  };

  const finish = (result: CodeRunResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // 顺序要紧：先快照在途 → 再 abort（同步触发内层 kill 路径）→ 最后杀 worker。
    // 反过来就会在台账里读到已被 abort 的调用，报出「跑了 0.0s」这种假账。
    const pending = [...inflight.values()];
    inflight.clear();
    // 运行态收口（2026-11-23）：程序结束（完成/超时/中止/崩溃）时还挂在台账里的
    // 调用不会再有人给它们发落定事件——纸面会永远停在「⋯ 在跑」。这里统一收成
    // error（如实说「未落定」，不假装成功）；若它随后真的返回，迟到路径会按同一
    // seq 更新成真实的 done/error。
    for (const c of pending) {
      emitDispatch({
        seq: c.seq,
        name: c.name,
        status: 'error',
        summary: '未落定',
        startedAt: c.startedAt,
      });
    }
    try {
      runController.abort(result.error?.kind ?? 'settled');
    } catch {
      /* 已经 abort 过（外层与超时同时到点） */
    }
    try {
      worker.terminate();
    } catch {
      /* 已死 */
    }
    void gate.drain().catch(() => {}); // 静默化在途写的记账错误（结果已落定）
    settledResolve(withInflightNote(result, pending, lateSettled));
  };

  let settledResolve!: (r: CodeRunResult) => void;
  const donePromise = new Promise<CodeRunResult>((resolve) => {
    settledResolve = resolve;
  });

  const timer = setTimeout(() => {
    finish({ logs, error: { kind: 'timeout', message: `code run exceeded ${timeoutMs}ms` } });
  }, timeoutMs);

  const onAbort = (): void => {
    finish({ logs, error: { kind: 'aborted', message: 'code run aborted' } });
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      return donePromise;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  // 完成值也计预算：done.value 到达时校验剩余额度
  const chargeLog = (text: string): boolean => {
    if (outputLimited) return false;
    const cost = utf8Len(JSON.stringify(text)) + (logs.length > 0 ? 1 : 0);
    if (usedBytes + cost > maxOutputBytes) {
      outputLimited = true;
      return false;
    }
    usedBytes += cost;
    return true;
  };

  worker.onerror = (): void => {
    finish({
      logs,
      error: { kind: 'substrate', message: 'worker crashed (script error)' },
    });
  };

  worker.onmessage = (ev: { data: unknown }): void => {
    if (settled) return;
    const msg = parseWorkerMessage(ev.data);
    if (!msg) return; // 敌意/垃圾流量：静默丢弃（预算不消耗在垃圾上）

    switch (msg.t) {
      case 'log': {
        if (chargeLog(msg.text)) {
          logs.push(msg.text);
        } else if (!outputLimited) {
          outputLimited = true;
        }
        return;
      }
      case 'output-limit': {
        // worker 侧已截断；宿主侧继续跑（我们的账本可能还没满——以先到者为准）
        outputLimited = true;
        return;
      }
      case 'call': {
        void handleCall(msg);
        return;
      }
      case 'done': {
        if (msg.error) {
          finish({ logs, error: msg.error });
          return;
        }
        // 预算（P4）：超限**不再失败**——按剩余额度截断、记下丢弃量。宿主侧独立计账
        // （不信 worker 上报），与 worker 的截断取「谁的丢弃量更大」并集。
        let value = msg.value;
        let truncated = msg.truncated
          ? { droppedBytes: msg.truncated.droppedBytes, valueDropped: msg.truncated.valueDropped === true }
          : undefined;
        if (value !== undefined) {
          const remaining = Math.max(0, maxOutputBytes - usedBytes);
          if (utf8Len(value) > remaining) {
            const cut = truncateUtf8(value, remaining);
            const dropped = utf8Len(value) - utf8Len(cut);
            truncated = {
              droppedBytes: (truncated?.droppedBytes ?? 0) + dropped,
              valueDropped: cut.length === 0,
            };
            value = cut;
          }
          usedBytes += utf8Len(value);
        }
        // 程序已返回 ⇒ 未 await 的在途调用一律中止（INV-1）：先 abort 再 drain。
        // 旧顺序（先 drain 后 finish）会把一个已经没人要的写调用拖到外层超时——
        // 结果从「完成」变成「超时」，而程序其实早就算完了（真机形态：程序里
        // fire-and-forget 了一条写，然后 return）。
        try {
          runController.abort('program-settled');
        } catch {
          /* 已经 abort 过 */
        }
        // 等写链排空再收尾——审计完整（结果值不依赖写，但 dispatch-end 事件
        // 必须全部落账后才 finish，否则审计缺口）。
        // 宽限（对齐 DSH stopGraceMs）：不理会取消的写调用（MCP / office）不能
        // 把「完成」拖成「超时」——到点照样结算成完成，迟到的结果走待领信箱。
        const finishDone = (): void => {
          clearTimeout(graceTimer);
          finish({
            logs,
            ...(value !== undefined ? { result: value } : {}),
            ...(truncated ? { truncated } : {}),
          });
        };
        const graceTimer = setTimeout(finishDone, settleGraceMs);
        void gate.drain().then(finishDone);
        return;
      }
    }
  };

  const answeredIds = new Set<number>();

  // 在途调用计数（P2-3 并发配额）：handleCall 通过校验即 +1，run 收尾 -1
  // （包括被闸拦下/被 abort 提前退出的路径——用 finally 保证不漏减）。
  let activeCalls = 0;

  async function handleCall(msg: Extract<WorkerToHost, { t: 'call' }>): Promise<void> {
    const { id, name } = msg;
    // 敌意校验三连：一次性 id / 绑定集 / 无损参数
    if (answeredIds.has(id)) return; // 重复 id：忽略（worker 侧也应只发一次）
    answeredIds.add(id);
    const binding = bindingMap.get(name);
    if (!binding) {
      // 未知名：最近邻 + 可用清单（模型最常犯的错是少个下划线/记成顶层函数）
      const near = nearestName(name, [...bindingMap.keys()]);
      worker.postMessage({
        t: 'reply',
        id,
        ok: false,
        message: `unknown tool binding "${name}"${near ? ` — did you mean "${near}"?` : ''}`,
        code: 'unknown-binding',
        hint: `Available bindings: ${[...bindingMap.keys()].join(', ')}`,
      } as const);
      return;
    }
    const args = normalizeJsonArgs(msg.args);
    if (!args) {
      worker.postMessage({
        t: 'reply',
        id,
        ok: false,
        message: 'tool arguments must be lossless JSON',
        code: 'invalid-args',
        hint: 'arguments must be plain JSON (no Date/Map/Set/functions/undefined) — pass primitives or plain objects',
      } as const);
      return;
    }
    // run 已结束（超时/中止）后才到达的调用：不启动。旧行为会照常起一个进程，
    // 再被 worker.terminate() 甩成孤儿——vitest 越滚越多正是这条路。
    // 不回包：worker 已 terminate，回包在真实链路里无处可去（fake worker 里则会
    // 变成无人 await 的 rejection）。静默丢掉才是这一处的正确语义。
    if (runSignal.aborted) return;
    // 并发配额（P2-3）：超限的调用直接回可读拒绝，由程序自己分批——
    // 不排队（排队等于把「整机卡顿」换成「静默变慢」，模型看不出因果）。
    if (activeCalls >= maxPendingCalls) {
      worker.postMessage({
        t: 'reply',
        id,
        ok: false,
        message: `too many concurrent nested calls (limit ${maxPendingCalls}); await in batches`,
        code: 'subcall-limit',
        hint: `at most ${maxPendingCalls} nested calls may be in flight at once — split the work into batches and await them`,
      } as const);
      return;
    }
    activeCalls++;
    // INV-2 预算穿透（只对 softTimeout 里声明的动作生效；见 applyBudget）
    const decision = applyBudget(binding, args, remainingMs());
    const callArgs = decision.args;
    const action =
      typeof (args as { action?: unknown }).action === 'string'
        ? String((args as { action: unknown }).action)
        : undefined;
    const seq = ++dispatchSeq;
    const startedAt = Date.now();
    inflight.set(id, { seq, name, startedAt });
    // 运行态第一拍（2026-11-23）：通过校验即算「在办」——写类还在排他闸上排队时
    // 也是程序在等它，不是没发生。落定前用户就能看到「现在在跑什么」。
    emitDispatch({ seq, name, status: 'running', ...(action ? { action } : {}), startedAt });

    const run = async (): Promise<void> => {
      try {
        // 排队期间 run 可能已经结束（写类要过排他闸，等闸的过程里 done/超时都可能到）：
        // 这时不能再启动——起一个进程再立刻 abort 它，等于白起一次，还会把 drain 拖住。
        if (runSignal.aborted) {
          inflight.delete(id);
          // 已发过起跑，就必须给落定（否则纸面永远「在跑」）。
          emitDispatch({
            seq,
            name,
            status: 'error',
            summary: '未执行（程序已结束）',
            ...(action ? { action } : {}),
            startedAt,
          });
          return;
        }
        let outcome: CodeBindingOutcome;
        try {
          outcome = await binding.invoke(callArgs, {
            remainingMs: remainingMs(),
            signal: runSignal,
            ...(decision.rewrite ? { budget: { args, rewrite: decision.rewrite } } : {}),
          });
        } catch (e) {
          outcome = {
            output: (e as { message?: string })?.message ?? String(e),
            isError: true,
            code: 'tool-error',
          };
        }
        inflight.delete(id);
        if (settled) {
          // 程序已结束才落定：存进台账（结果里报个数）并投递给待领信箱（P1-2）——
          // 旧行为在这里静默 return，连「丢了一条结果」都无从得知（INV-3）。
          const late: LateNestedResult = {
            name,
            elapsedMs: Date.now() - startedAt,
            output: outcome.output,
            isError: outcome.isError,
          };
          lateSettled.push(late);
          // 展示面第二拍（迟到版）：finish 已把这条收成「未落定」——它其实回来了，
          // 按同一 seq 更新成真实结果（不把一次成功的调用永远写成失败）。
          emitDispatch({
            seq,
            name,
            status: outcome.isError ? 'error' : 'done',
            summary: firstLine(outcome.output),
            ...(action ? { action } : {}),
            startedAt,
          });
          try {
            opts.onLateResult?.(late);
          } catch {
            /* 投递面故障不阻断收尾（与 onDispatch 同款降级） */
          }
          return;
        }
        // 展示面第二拍（2026-11-21 建立）：落定时刻才知道胜负与输出，按起跑 seq
        // 原地更新那一行——同一笔调用在纸面只有一条记录。
        emitDispatch({
          seq,
          name,
          status: outcome.isError ? 'error' : 'done',
          summary: firstLine(outcome.output),
          ...(action ? { action } : {}),
          startedAt,
        });
        worker.postMessage(
          outcome.isError
            ? ({
                t: 'reply',
                id,
                ok: false,
                // 身份进 message：程序只有一个字段能把失败带回模型（P0-2）。
                message: `${callLabel(name, args)}: ${stripErrorPrefix(outcome.output)}`,
                code: outcome.code ?? 'tool-error',
                ...(outcome.hint ? { hint: outcome.hint } : {}),
              } as const)
            : ({ t: 'reply', id, ok: true, value: outcome.output } as const),
        );
      } finally {
        activeCalls--;
      }
    };
    const isReadOnly = binding.readOnlyFor ? binding.readOnlyFor(args) : binding.readOnly;
    if (isReadOnly) {
      // 读类不进任何链（并行不设限）
      void run().catch(() => {});
      return;
    }
    const lockKey = binding.lockKey ? binding.lockKey(args) : '*';
    void gate.write(lockKey, run).catch(() => {});
  }

  // 启动
  worker.postMessage({
    t: 'run',
    code: program,
    names: [...bindingMap.keys()],
    maxOutputBytes,
  });

  return donePromise;
}

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
import {
  type CodeReplyCode,
  type CodeRunResult,
  nearestName,
  normalizeJsonArgs,
  parseWorkerMessage,
  type WorkerToHost,
} from './protocol';

/** 程序内调用的一笔事实（展示面旁路；2026-11-21）。 */
export interface CodeDispatchRecord {
  /** 程序内调用序（1 起，按落定序——与 session-log 的 dispatchCounter 不同源）。 */
  seq: number;
  name: string;
  /** 该动作（域工具的 args.action；非域工具为 undefined）。 */
  action?: string;
  ok: boolean;
  /** 结果首行（已截断）——只够「一眼看出它干了什么」，不做正文。 */
  summary: string;
}

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
  /** 长任务策略（INV-2 预算穿透）：'promote' = 宿主可把本次 `timeoutMs` 压到
   *  剩余预算内，让工具自己转后台（promote）并交付 job id；'abort'（缺省）=
   *  不压，超时由 run 作用域 abort 兜底。只给**能把超时转成后台作业**的工具声明。 */
  deadline?: 'promote' | 'abort';
  /** 'promote' 策略下，模型没给 `timeoutMs` 时的请求预算来源（惰性函数——
   *  要从**活 schema** 的 default 读，域门面是构建期快照，别闭包捕获死实例）。
   *  缺省/undefined = 缺省参数不参与压制（只有模型显式给了 timeoutMs 才压）。 */
  defaultTimeoutMs?: () => number | undefined;
  /** 执行体：返回结果文本 + 是否失败（+ 可选分类码/提示——P3；+ P0 的运行时上下文）。 */
  invoke: (args: Record<string, unknown>, ctx?: CodeBindingContext) => Promise<CodeBindingOutcome>;
}

/** code run 宿主配置。 */
export interface CodeRunHostOptions {
  /** 输出预算（字节，logs+完成值共享）。缺省 64KB。 */
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

/** 预算穿透的两个常数（INV-2，2026-11 长任务批）。
 *
 *  `PROMOTE_MARGIN_MS`：留给「shell 超时 → Rust promote → 事件回到宿 → 程序拿到
 *  job id → 程序继续跑完」这条链的余量。实测一次 promote 往返是几十 ms 级，
 *  8s 是保守值：既不会因为机器抖动把余量吃掉，又不会把可用的前台窗口压得太小。
 *  `MIN_FOREGROUND_MS`：压到这个下限以下就不再压——那说明外层预算已经不够跑完
 *  任何有意义的命令，应该让它走 abort 兜底（并由清单如实报出），而不是把命令
 *  刚起就 promote 成后台。 */
const PROMOTE_MARGIN_MS = 8_000;
const MIN_FOREGROUND_MS = 15_000;

/** 在途调用台账的一条（INV-3）：run 结束时要能说清「谁还在跑、跑了多久」。 */
interface InflightCall {
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

/** INV-2 预算穿透：把本次调用的 `timeoutMs` 压到外层剩余预算内。
 *
 *  只对声明 `deadline:'promote'` 的 binding 生效（当前 = shell run）——这类工具的
 *  超时语义是「转后台」而不是「杀死」，压缩它是**无损**的：命令不会失败，只是更早
 *  拿到 job id。对没有这套语义的工具压缩超时等于提前杀它，所以必须由 binding 显式
 *  声明，不能按名字猜。
 *
 *  三条不压的例外：预算本来就够（零漂移）、压完低于前台下限（交给 abort 兜底并
 *  如实报账）、请求值根本拿不到（模型没给且 binding 没交缺省来源）。 */
function applyBudget(
  binding: CodeBindingSpec,
  args: Record<string, unknown>,
  remaining: number,
): Record<string, unknown> {
  if (binding.deadline !== 'promote') return args;
  const requested = typeof args.timeoutMs === 'number' ? args.timeoutMs : binding.defaultTimeoutMs?.();
  if (typeof requested !== 'number') return args;
  const budget = remaining - PROMOTE_MARGIN_MS;
  if (requested <= budget) return args;
  if (budget < MIN_FOREGROUND_MS) return args;
  return { ...args, timeoutMs: Math.floor(budget) };
}

/** 运行一次 code run。resolve 恒为 CodeRunResult（失败也在 error 字段里，
 *  不 reject——外层工具把 error 归一为结构化失败文本）。 */
export async function runCode(program: string, opts: CodeRunHostOptions): Promise<CodeRunResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const settleGraceMs = opts.settleGraceMs ?? 3_000;
  const bindingMap = new Map(opts.bindings.map((b) => [b.name, b]));
  const createWorker = opts.createWorker ?? createRealWorker;
  const signal = opts.signal ?? null;

  const logs: string[] = [];
  let usedBytes = 2; // "[]" 形态（与 worker 侧同口径）
  let outputLimited = false;
  let settled = false;
  let dispatchSeq = 0; // 展示面旁路的调用序（与 session-log 的 dispatchCounter 各自独立）

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

  const finish = (result: CodeRunResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // 顺序要紧：先快照在途 → 再 abort（同步触发内层 kill 路径）→ 最后杀 worker。
    // 反过来就会在台账里读到已被 abort 的调用，报出「跑了 0.0s」这种假账。
    const pending = [...inflight.values()];
    inflight.clear();
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
    // INV-2 预算穿透（只对声明 promote 的工具生效；见 applyBudget）
    const callArgs = applyBudget(binding, args, remainingMs());
    const startedAt = Date.now();
    inflight.set(id, { name, startedAt });

    const run = async (): Promise<void> => {
      // 排队期间 run 可能已经结束（写类要过排他闸，等闸的过程里 done/超时都可能到）：
      // 这时不能再启动——起一个进程再立刻 abort 它，等于白起一次，还会把 drain 拖住。
      if (runSignal.aborted) {
        inflight.delete(id);
        return;
      }
      let outcome: CodeBindingOutcome;
      try {
        outcome = await binding.invoke(callArgs, { remainingMs: remainingMs(), signal: runSignal });
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
        try {
          opts.onLateResult?.(late);
        } catch {
          /* 投递面故障不阻断收尾（与 onDispatch 同款降级） */
        }
        return;
      }
      // 展示面旁路（2026-11-21）：落定时刻才知道胜负与输出，这里正好齐了。
      try {
        opts.onDispatch?.({
          seq: ++dispatchSeq,
          name,
          action:
            typeof (args as { action?: unknown }).action === 'string'
              ? String((args as { action: unknown }).action)
              : undefined,
          ok: !outcome.isError,
          summary: firstLine(outcome.output),
        });
      } catch {
        /* 展示面故障不阻断程序（与 hooks 的降级同款） */
      }
      worker.postMessage(
        outcome.isError
          ? ({
              t: 'reply',
              id,
              ok: false,
              message: outcome.output,
              code: outcome.code ?? 'tool-error',
              ...(outcome.hint ? { hint: outcome.hint } : {}),
            } as const)
          : ({ t: 'reply', id, ok: true, value: outcome.output } as const),
      );
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

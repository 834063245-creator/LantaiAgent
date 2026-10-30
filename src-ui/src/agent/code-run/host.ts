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

/** 绑定调用结果（P3）：`code`/`hint` 会原样进 reply，成为程序内 Error 的属性。 */
export interface CodeBindingOutcome {
  output: string;
  isError: boolean;
  /** 失败分类；缺省且 isError ⇒ 'tool-error'。 */
  code?: CodeReplyCode;
  /** 可行动的提示（"你是不是想写 X" / 可用清单 / 换哪条路走）。 */
  hint?: string;
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
  /** 执行体：返回结果文本 + 是否失败（+ 可选分类码/提示——P3）。 */
  invoke: (args: Record<string, unknown>) => Promise<CodeBindingOutcome>;
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

/** UTF-8 字节计长（与 worker 侧 byteLen 同语义；宿主侧独立计账用）。 */
function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
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

/** 运行一次 code run。resolve 恒为 CodeRunResult（失败也在 error 字段里，
 *  不 reject——外层工具把 error 归一为结构化失败文本）。 */
export async function runCode(program: string, opts: CodeRunHostOptions): Promise<CodeRunResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const bindingMap = new Map(opts.bindings.map((b) => [b.name, b]));
  const createWorker = opts.createWorker ?? createRealWorker;
  const signal = opts.signal ?? null;

  const logs: string[] = [];
  let usedBytes = 2; // "[]" 形态（与 worker 侧同口径）
  let outputLimited = false;
  let settled = false;

  // 写调度闸：读不进闸；写按 lockKey 分片（缺省 '*' = 与旧「一条写链」逐字等价）
  const gate = createWriteGate();

  const worker = createWorker(WORKER_BOOTSTRAP_SOURCE);

  const finish = (result: CodeRunResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      worker.terminate();
    } catch {
      /* 已死 */
    }
    void gate.drain().catch(() => {}); // 静默化在途写的记账错误（结果已落定）
    settledResolve(result);
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
        // 预算已耗（worker 截断或宿主计账超限）：完成值不可信——归一失败。
        // 对齐 DSH：LogBuffer 截断后 prepareCompletion 报 output-limit。
        if (outputLimited) {
          finish({
            logs,
            error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` },
          });
          return;
        }
        if (msg.value !== undefined) {
          const cost = utf8Len(msg.value);
          if (usedBytes + cost > maxOutputBytes) {
            finish({
              logs,
              error: { kind: 'output-limit', message: `outer output exceeded ${maxOutputBytes} bytes` },
            });
            return;
          }
          usedBytes += cost;
        }
        // 等写链排空再收尾——审计完整（结果值不依赖写，但 dispatch-end 事件
        // 必须全部落账后才 finish，否则审计缺口）
        void gate.drain().then(() => finish({ logs, ...(msg.value !== undefined ? { result: msg.value } : {}) }));
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
    const run = async (): Promise<void> => {
      let outcome: CodeBindingOutcome;
      try {
        outcome = await binding.invoke(args);
      } catch (e) {
        outcome = {
          output: (e as { message?: string })?.message ?? String(e),
          isError: true,
          code: 'tool-error',
        };
      }
      if (settled) return; // run 已结束（超时/中止）：不再回话
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

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
// 工具与会话，消费者自己管（DSH 接缝纪律）。并发契约：同一时刻只允许一个
// 「写类」调用在途（readOnly === false），读类并行不设限——与
// streaming-executor 的现行 readOnly 并行规则对齐（计划 C7）。

import { WORKER_BOOTSTRAP_SOURCE } from './bootstrap';
import { type CodeRunResult, normalizeJsonArgs, parseWorkerMessage, type WorkerToHost } from './protocol';

/** 绑定声明（P3）：一个可被程序调用的宿主能力。
 *  invoke 闭包持有宿主上下文（executor 等价体/审计）——runtime 不知道
 *  工具与会话，消费者自己管。 */
export interface CodeBindingSpec {
  /** 程序内命名空间名（`tools.<name>`）。 */
  name: string;
  /** 是否只读（可并行）。 */
  readOnly: boolean;
  /** 执行体：返回 [结果文本, isError]。 */
  invoke: (args: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>;
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

  // 写类串行门闩：同一时刻至多一个写调用在途
  let writeChain: Promise<void> = Promise.resolve();

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
    void writeChain.catch(() => {}); // 静默化在途写的记账错误（结果已落定）
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
        void writeChain.then(() => finish({ logs, ...(msg.value !== undefined ? { result: msg.value } : {}) }));
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
      worker.postMessage({ t: 'reply', id, ok: false, message: `unknown tool binding "${name}"` } as const);
      return;
    }
    const args = normalizeJsonArgs(msg.args);
    if (!args) {
      worker.postMessage({
        t: 'reply',
        id,
        ok: false,
        message: 'tool arguments must be lossless JSON',
      } as const);
      return;
    }
    const run = async (): Promise<void> => {
      let outcome: { output: string; isError: boolean };
      try {
        outcome = await binding.invoke(args);
      } catch (e) {
        outcome = { output: (e as { message?: string })?.message ?? String(e), isError: true };
      }
      if (settled) return; // run 已结束（超时/中止）：不再回话
      worker.postMessage(
        outcome.isError
          ? ({ t: 'reply', id, ok: false, message: outcome.output } as const)
          : ({ t: 'reply', id, ok: true, value: outcome.output } as const),
      );
    };
    if (binding.readOnly) {
      void run().catch(() => {});
    } else {
      // 写类串行：挂到链尾（保持提交序）
      writeChain = writeChain.then(run);
    }
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

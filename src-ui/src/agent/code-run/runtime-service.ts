// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// codeRuntime — 执行腰的 cordis Service（P3 收口，DSH CodeRuntime 对标）。
//
// 接缝纪律（DSH code-runtime/src/index.ts 同款）：runtime 不知道工具和会话，
// 消费者自己管——run() 只收程序体 + 绑定集（CodeBindingSpec，invoke 闭包
// 持有 executor 等价体/审计钩子）；budget/abort/substrate 失败全部在
// CodeRunResult 里 resolve，只有契约误用才 reject。
//
// 兰台落地形态：单后端（Web Worker，R5 spike 验证）先收口——本 Service 是
// 绑定面归一 + run 门面；后端可换（sidecar/进程隔离是后续硬化选项，
// 接口不破即可换，这是 P3 的意义）。挂载经 codeRuntimePlugin（根 Context，
// loadBuiltinPlugins 表序——与四 service/renderer 同批）。
//
// 兜底语义（对齐 lsp-client 先例）：无服务挂载时（单测/无根 Context 路径）
// 惰性建游离实例——行为与直接调 runCode 等价，消费面（code_execution 工具）
// 永不因「服务未挂」走静默死路。

import { type Context, Service } from '../../cordis';
import { type CodeBindingSpec, type CodeRunHostOptions, type CodeWorkerLike, runCode } from './host';
import type { CodeRunResult } from './protocol';

/** 一次 code run 请求 — 请求携带 runtime 需要的一切，无隐藏缺省
 *  （DSH CodeRunRequest 同哲学；预算/超时的工具面缺省在工具层填）。 */
export interface CodeRunRequest {
  /** 程序体（async function body，纯 JS）。 */
  program: string;
  /** 绑定集（runtime 不知道工具——invoke 闭包持有全部宿主上下文）。 */
  bindings: CodeBindingSpec[];
  /** 输出预算（字节）。 */
  maxOutputBytes?: number;
  /** 墙钟上限（ms）。 */
  timeoutMs?: number;
  /** 中止信号。 */
  signal?: AbortSignal | null;
  /** Worker 工厂注入面（测试）。 */
  createWorker?: (source: string) => CodeWorkerLike;
}

declare module '../../cordis/context' {
  interface Context {
    /** 执行腰服务（P3）——run() 门面 + 绑定面归一；后端可换。 */
    codeRuntime: CodeRuntimeService;
  }
}

/** ctx.codeRuntime 服务：单后端（blob Web Worker）实现。
 *  run() 恒 resolve CodeRunResult（失败在 error 字段）；只有契约误用
 *  （program 非字符串等）才 reject。 */
export class CodeRuntimeService extends Service {
  /** 执行基底标识（DSH isolation 同款——信息性描述，非安全声明）。 */
  readonly isolation = 'web-worker';
  /** 程序语言标识。 */
  readonly language = 'javascript';

  constructor(ctx: Context) {
    super(ctx, 'codeRuntime');
    setActiveRuntime(this); // 消费闭环读取面（工具 facade 经 active ?? ambient）
  }

  /** 执行一次程序体。 */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (typeof request.program !== 'string' || request.program.length === 0) {
      // 契约误用——唯一 reject 路径（对齐 DSH「只有 Service Definition 契约
      // 误用才拒绝」）
      throw new Error('[codeRuntime] run(): program 必须是非空字符串');
    }
    const opts: CodeRunHostOptions = {
      bindings: request.bindings,
      maxOutputBytes: request.maxOutputBytes,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      createWorker: request.createWorker,
    };
    return runCode(request.program, opts);
  }
}

// ── 消费闭环读取面（services.ts / lsp-client.ts 同款：模块级活动服务，
//    CONVENTIONS §1.10 第 3 类可变态——键控自清理，生命周期 = 进程）──

let _activeRuntime: CodeRuntimeService | null = null;

function setActiveRuntime(svc: CodeRuntimeService): void {
  _activeRuntime = svc;
}

/** 兜底游离实例（无根 Context 路径——单测/工具直接消费）。 */
let _ambientRuntime: { run(request: CodeRunRequest): Promise<CodeRunResult> } | null = null;

/** run() 门面：active 服务优先，无服务走游离实例（行为等价 direct runCode）。 */
export function runViaRuntime(request: CodeRunRequest): Promise<CodeRunResult> {
  if (_activeRuntime) return _activeRuntime.run(request);
  _ambientRuntime ??= {
    run: (req: CodeRunRequest) => {
      if (typeof req.program !== 'string' || req.program.length === 0) {
        return Promise.reject(new Error('[codeRuntime] run(): program 必须是非空字符串'));
      }
      const opts: CodeRunHostOptions = {
        bindings: req.bindings,
        maxOutputBytes: req.maxOutputBytes,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        createWorker: req.createWorker,
      };
      return runCode(req.program, opts);
    },
  };
  return _ambientRuntime.run(request);
}

/** 测试复位（生产不调用）。 */
export function resetCodeRuntimeForTests(): void {
  _activeRuntime = null;
  _ambientRuntime = null;
}

// ── 挂载插件（loadBuiltinPlugins 表序——内核线服务，先于外部插件）──

export const codeRuntimePlugin = {
  name: 'hologram/code-runtime',
  apply(ctx: Context) {
    new CodeRuntimeService(ctx);
  },
};

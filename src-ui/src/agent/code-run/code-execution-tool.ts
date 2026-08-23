// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// code_execution — 执行原语工具（P2 交付物，DSH run_code 对标；P3 起经
// ctx.codeRuntime 服务运行——runtime 不知道工具和会话，绑定集闭包持有
// executor 等价体/审计钩子，后端可换）。
//
// 模型一次工具调用 = 一个 JS 程序体，在 Web Worker 沙箱里执行；程序内以
// `await tools.<name>(args)` 调当前 registry 的可见工具（原生并发 + try/catch
// + 循环——组合逻辑从下一 token 预测坍缩进代码）。
//
// schema 面纪律（计划 D2）：单工具增量=1，不摊平工具面；绑定集不在 schema
// 里声明（程序体运行时按 registry 可见面物化）。
//
// 嵌套语义（C5/C7）：
//   - 子分发逐条落 session-log（tool/code-dispatch-start/end）——审计粒度
//     与直接调用完全一致，只换调用者（D5/R4）；
//   - 门禁不豁免：invoke 闭包走 executor 等价体（planGate/preflight/hooks/
//     截断全套），plan 模式白名单同样生效于嵌套调用（P2 施工序 6）；
//   - 并发：读类并行、写类串行（C7 显式声明）。
//
// 失败语义（C6）：程序异常/预算超限/超时/中止/substrate 死亡分类报错
// （结构化失败文本输出，模型可自我修正——DSH CodeRunFailedError 同款）。

import { z } from 'zod';
import type { Tool } from '../tool';
import { defineTool } from '../tools/define-tool';
import type { CodeBindingSpec } from './host';
import { runViaRuntime } from './runtime-service';

/** code_execution 的宿主依赖 — 由装配层（blueprint capability）注入。 */
export interface CodeExecutionDeps {
  /** 绑定集（invoke 闭包持有 executor 等价体 + 审计；不含 code_execution 自身——防自递归）。 */
  bindings: CodeBindingSpec[];
  /** 输出预算（字节）。缺省 64KB。 */
  maxOutputBytes?: number;
  /** 墙钟上限（ms）。缺省 120s。 */
  timeoutMs?: number;
  /** Worker 工厂注入面（测试 fake；缺省真实 blob worker）。 */
  createWorker?: (source: string) => import('./host').CodeWorkerLike;
}

export function createCodeExecutionTool(deps: CodeExecutionDeps): Tool {
  return defineTool({
    name: 'code_execution',
    description:
      'Execute a JavaScript program body against the available tools. `code` is the BODY of an async function: ' +
      'top-level `await` and `return` work. Call tools as `await tools.<name>(args)` — e.g. ' +
      '`const r = await tools.fs({action:"read", filePath:"x.ts"}); return r.length;`. ' +
      'Use this for loops, fan-out reads, try/catch retries, and multi-step compositions instead of ' +
      'repeated single tool calls. Concurrency: read-only tools run in parallel; write tools are serialized. ' +
      'Only what you console.log or return is program output — curate it (output budget is capped). ' +
      'Nested tool calls are audited exactly like direct calls (permissions/plan-mode rules apply).',
    schema: z.object({
      code: z
        .string()
        .describe(
          'The program: body of an async JavaScript function (plain JS, no imports; top-level await/return work).',
        ),
      description: z
        .string()
        .describe(
          'Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). ' +
            'Examples: "Count TODO markers across packages"; "Read failing test and its fixture".',
        ),
    }),
    readOnly: false,
    execute: async (args, _onProgress, signal) => {
      const { code } = args;
      const result = await runViaRuntime({
        program: code,
        bindings: deps.bindings,
        maxOutputBytes: deps.maxOutputBytes,
        timeoutMs: deps.timeoutMs,
        createWorker: deps.createWorker,
        signal,
      });

      // 结构化输出：logs + result / error 分类文本（对齐 DSH「失败也是可读结果」）
      const lines: string[] = [];
      if (result.logs.length > 0) {
        lines.push('── logs ──');
        lines.push(...result.logs);
      }
      if (result.error) {
        lines.push(`── code run failed (${result.error.kind}) ──`);
        lines.push(result.error.message);
        // 失败走正常返回（分类文本可读，模型可自我修正）
        return `[code_execution 失败] kind=${result.error.kind}\n${lines.join('\n')}`;
      }
      if (result.result !== undefined) {
        lines.push('── result ──');
        lines.push(result.result);
      }
      if (lines.length === 0) return '(程序完成，无输出)';
      return lines.join('\n');
    },
  });
}

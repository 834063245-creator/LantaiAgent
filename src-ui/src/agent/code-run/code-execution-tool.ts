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
// 绑定目录（2026-10-30，计划 P1）：描述里带**本卷的绑定清单 + 派生签名**。
// 数据源必须是**活注册表**（`deps.catalog`），不是 install 期的
// `deps.bindings` 快照——域门面是构建期冻结的实例（`tools/domains.ts:486-501`
// 把 actions/parameters 算好就固定），装配期取一次会晚一次收敛（实测
// snapshot=["fs"] vs live=["fs","agent"]，见计划 §3.4）。所以描述走
// `defineTool` 的惰性求值形态（每次 description() 重算）。
// 签名只投影三样：名字 / 动作枚举 / 必填键——参数**说明**永不进（那是 schema
// 的活，抄一份才是第二真源）。
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
//
// 完成值形态（2026-09-19 换代）：字符串完成值原样出（文本本体——不再二次
// JSON 编码，真换行/单反斜杠直达模型与纸面），其余值出 JSON 文本。

import { z } from 'zod';
import type { Tool } from '../tool';
import { defineTool } from '../tools/define-tool';
import type { CodeBindingSpec } from './host';
import { runViaRuntime } from './runtime-service';

/** code_execution 的宿主依赖 — 由装配层（blueprint capability）注入。 */
export interface CodeExecutionDeps {
  /** 绑定集（invoke 闭包持有 executor 等价体 + 审计；不含 code_execution 自身——防自递归）。 */
  bindings: CodeBindingSpec[];
  /** 目录数据源：**调用时刻**返回当前可见工具（活注册表投影）。缺省 = 退化为
   *  `bindings` 的名单（只有名字，没有签名）。 */
  catalog?: () => Tool[];
  /** 输出预算（字节）。缺省 64KB。 */
  maxOutputBytes?: number;
  /** 墙钟上限（ms）。缺省 120s。 */
  timeoutMs?: number;
  /** Worker 工厂注入面（测试 fake；缺省真实 blob worker）。 */
  createWorker?: (source: string) => import('./host').CodeWorkerLike;
}

/** 目录条目 —— 纯投影：名字 / 动作枚举 / 必填键。 */
export interface BindingCatalogEntry {
  name: string;
  /** 域工具的动作枚举（原样；渲染时缩写）。 */
  actions?: string[];
  /** JSON Schema 的必填键（已剔除 `action`——它由动作枚举单独表达）。 */
  required?: string[];
}

/** 动作列表缩写上限（超出打 `…`；完整枚举在工具自己的 schema 里）。 */
const ACTION_CAP = 6;

/** 活 Tool → 目录条目。纯函数：不缓存、不猜——同一个 Tool 每次投影结果一致。 */
export function projectBindingEntry(tool: Tool): BindingCatalogEntry {
  const actions = tool.actions?.() ?? [];
  const raw = tool.parameters() as { required?: unknown };
  const required = Array.isArray(raw.required)
    ? raw.required.filter((k): k is string => typeof k === 'string' && k !== 'action')
    : [];
  return {
    name: tool.name(),
    ...(actions.length > 0 ? { actions: [...actions] } : {}),
    ...(required.length > 0 ? { required } : {}),
  };
}

function renderEntry(e: BindingCatalogEntry): string {
  const rest = (e.required ?? []).join(', ');
  if (e.actions && e.actions.length > 0) {
    const shown = e.actions.slice(0, ACTION_CAP).join('|');
    const more = e.actions.length > ACTION_CAP ? '|…' : '';
    return `${e.name}(action: ${shown}${more}${rest ? `; ${rest}` : ''})`;
  }
  return rest ? `${e.name}(${rest})` : e.name;
}

/** 目录块（空集 = 空串）。名字排序 ⇒ 绑定集不变则字节不变（前缀缓存不抖）。 */
export function renderBindingCatalog(entries: BindingCatalogEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `  ${renderEntry(e)}`);
  return [
    "Available bindings in this session (call as `await tools.<name>(args)`; an action list ending in `…` is abbreviated — each tool's full parameter schema is its own tool definition):",
    ...lines,
  ].join('\n');
}

const CODE_EXECUTION_DESCRIPTION =
  'Execute a JavaScript program body against the available tools. `code` is the BODY of an async function: ' +
  'top-level `await` and `return` work. Call tools as `await tools.<name>(args)` — e.g. ' +
  '`const r = await tools.fs({action:"read", filePath:"x.ts"}); return r.length;`. ' +
  'Use this for loops, fan-out reads, try/catch retries, and multi-step compositions instead of ' +
  'repeated single tool calls. Concurrency: read-only tools run in parallel; write tools are serialized. ' +
  'Only what you console.log or return is program output — curate it (output budget is capped). ' +
  'Nested tool calls are audited exactly like direct calls (permissions/plan-mode rules apply).';

/** 描述（惰性）：基础文案 + 本卷绑定目录。 */
function buildDescription(deps: CodeExecutionDeps): string {
  const entries = deps.catalog
    ? deps
        .catalog()
        .filter((t) => t.name() !== 'code_execution')
        .map(projectBindingEntry)
    : deps.bindings.map((b) => ({ name: b.name }));
  const catalog = renderBindingCatalog(entries);
  return catalog ? `${CODE_EXECUTION_DESCRIPTION}\n\n${catalog}` : CODE_EXECUTION_DESCRIPTION;
}

export function createCodeExecutionTool(deps: CodeExecutionDeps): Tool {
  return defineTool({
    name: 'code_execution',
    description: () => buildDescription(deps),
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
      // 信封（`── logs ──` / `── result ──` / `[code_execution 失败]`）是展示面的
      // 解析契约（paper/tool-text 的 codeSections 分段成真段头）——改格式同改那边。
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
        // 字符串完成值已是文本本体（worker 侧不再二次编码），原样进段
        lines.push(result.result);
      }
      if (lines.length === 0) return '(程序完成，无输出)';
      return lines.join('\n');
    },
  });
}

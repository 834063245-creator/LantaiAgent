// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 类型化事件管道 — agent-core-convergence Phase 2 + 平台化 Phase 1 D4 扩域。
//
// 把 StreamingToolExecutor 的执行阶段显式化为可组合、可排序、可短路的事件：
//   tool/guard    (waterfall·同步短路) 派发前裁决——planGate 等守卫，非空返回 = 拦截
//   tool/preflight(serial·同步聚合)    执行前预检——聚合 warning，保持 HIGH gate 语义
//   tool/around   (waterfall·异步串流) 执行后富化——输出流过监听器
//   tool/result   (emit·广播)          结果落定
//   tool/error    (emit·广播)          错误路径
//
// D4（2026-08-27）扩域——loop 生命周期 + 能力事件域（全部 emit·广播，观察者语义）：
//   turn/start|end  step/start|end  request/start|end   subagent/spawn|done
// 发射点：Agent.runLoop / Agent.spawnSubAgent（消费漏斗）；监听面 = Agent.onLoopEvent。
// R1 声明：本域事件是可观测监听面，**非模型可见、不进 session log**——session 溯源
// 仍走三入口 + 既有 'turn/start' sessionLog append，双轨不混。
//
// 与 EventKind sink 的关系：本 bus 是执行管道内部机制；模型/UI 可见事件仍由
// executor 双发（bus + sink），UI 零改动。
//
// 纪律（验证计划 Phase 2 T0 + D4 完整性 guard）：新增事件必须声明 mode 且 ∈
// serial|parallel|waterfall|emit；loop/能力域事件必须同时在 LOOP_EVENT_PAYLOADS
// 声明载荷形状（tests/agent-loop-events.test.ts 双向钉住）。容错语义与历史
// 实现逐点对齐：
//   - guard 不吞异常（历史 planGate 直调无 try/catch，抛错即传播）；
//   - preflight / around 的静默降级由适配层（attach*）负责，与旧 executor 相同；
//   - emit 不吞异常（观察者抛错是 bug，暴露优于掩盖）。

import { type SeamDisabledMap, seamDisabled } from '../composition/seam-resolution';
import type { ToolPipelineContext } from './agent-types';
import type { HookRegistry, PreflightHookRegistry } from './hooks';
import type { Disposer } from './lifecycle';
import type { PlanGate } from './plan/plan-registry';

export type EventMode = 'serial' | 'parallel' | 'waterfall' | 'emit';

export const EVENT_MODES: readonly EventMode[] = ['serial', 'parallel', 'waterfall', 'emit'];

/** 事件声明表 —— 单一事实源；T0 门禁校验每个 mode 合法。 */
export const AGENT_EVENT_MAP = {
  // ── 工具管道（Phase 2 既有）──
  'tool/guard': { mode: 'waterfall' },
  'tool/preflight': { mode: 'serial' },
  'tool/around': { mode: 'waterfall' },
  'tool/result': { mode: 'emit' },
  'tool/error': { mode: 'emit' },
  // ── loop 生命周期 + 能力事件域（平台化 Phase 1 · D4，2026-08-27）──
  'turn/start': { mode: 'emit' },
  'turn/end': { mode: 'emit' },
  'step/start': { mode: 'emit' },
  'step/end': { mode: 'emit' },
  'request/start': { mode: 'emit' },
  'request/end': { mode: 'emit' },
  'subagent/spawn': { mode: 'emit' },
  'subagent/done': { mode: 'emit' },
} as const;

export type AgentEventName = keyof typeof AGENT_EVENT_MAP;

// ── D4 loop/能力域载荷（单一真源；与 emit 域一一对应，双向 guard 钉住）──

export interface TurnStartPayload {
  agentId: string;
  /** 提供方身份（settings.providers[].name）——**不是**模型 id（2026-09-12 拆碑：
   *  此前该字段名为 `model` 却装 provider 名，排查时误导）。 */
  provider: string;
  /** 本回合实际调用的模型 id。 */
  model: string;
}
export interface TurnEndPayload {
  agentId: string;
  ok: boolean;
  aborted: boolean;
}
export interface StepStartPayload {
  agentId: string;
  /** 0 起步的迭代序（UI 进度显示用的 step+1 与此区分）。 */
  step: number;
}
export interface StepEndPayload {
  agentId: string;
  step: number;
  /** 本步派发的工具调用数（早退路径 = 0）。 */
  toolCalls: number;
}
export interface RequestStartPayload {
  agentId: string;
  /** 人类序步号（step + 1，与请求日志 turn 字段一致）。 */
  step: number;
  /** 提供方身份（settings.providers[].name）。 */
  provider: string;
  /** 本次请求实际调用的模型 id。 */
  model: string;
}
export interface RequestEndPayload {
  agentId: string;
  step: number;
  totalTokens: number | null;
  err: string | null;
}
export interface SubagentSpawnPayload {
  parentId: string;
  /** agentIdOverride 存在时可知；进程内自动生成 id 时为 null（生成点在 provider 内核）。 */
  agentId: string | null;
  mode: 'fork' | 'fresh';
  async: boolean;
}
export interface SubagentDonePayload {
  parentId: string;
  agentId: string | null;
  ok: boolean;
  async: boolean;
}

/** loop/能力域载荷形状表 —— emit 域新事件的强制登记处（完整性 guard：emit 域
 *  除 tool/result|error 外必须在此有键；此处的键必须在 AGENT_EVENT_MAP 为 emit）。 */
export interface LoopEventPayload {
  'turn/start': TurnStartPayload;
  'turn/end': TurnEndPayload;
  'step/start': StepStartPayload;
  'step/end': StepEndPayload;
  'request/start': RequestStartPayload;
  'request/end': RequestEndPayload;
  'subagent/spawn': SubagentSpawnPayload;
  'subagent/done': SubagentDonePayload;
}

export type LoopEventName = keyof LoopEventPayload;

/** loop/能力域事件名的运行时镜像（interface 无运行时键——satisfies 钉编译期同步，
 *  完整性 guard 测试用它与 AGENT_EVENT_MAP 双向对拍）。 */
export const LOOP_EVENT_NAMES = [
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'request/start',
  'request/end',
  'subagent/spawn',
  'subagent/done',
] as const satisfies readonly LoopEventName[];

/** guard：同步裁决，非 null = 拦截（返回拦截文案）。 */
export type GuardListener = (ctx: ToolPipelineContext) => string | null;
/** preflight：同步预检，非 null = 警告（聚合 join '\n\n'，与 PreflightHookRegistry 一致）。 */
export type PreflightListener = (ctx: ToolPipelineContext) => string | null;
/** around：富化输出（可异步），值按优先级流过。 */
export type AroundListener = (ctx: ToolPipelineContext, output: string) => string | Promise<string>;
/** result：结果广播。err 非 null 表示错误路径产物。 */
export type ResultListener = (
  ctx: ToolPipelineContext,
  result: { output: string; truncated: boolean; err: string | null },
) => void;
/** error：错误路径广播（err 为首行错误文案）。 */
export type ErrorListener = (ctx: ToolPipelineContext, err: string) => void;

export interface ListenerOptions {
  /** 数值越大越先执行（默认 0）；同优先级按注册序。 */
  priority?: number;
}

type AnyListener = (...args: never[]) => unknown;

interface Entry {
  fn: AnyListener;
  priority: number;
  seq: number;
}

export class AgentEventBus {
  private listeners = new Map<AgentEventName, Entry[]>();
  private seq = 0;
  /** 本总线的组合裁剪面（S6 P2a）——每 Agent 一条总线（agent.ts 构造期灌入
   *  该 Agent 组合的 seamDisabled）；null = 未灌入 ⇒ emitLoopEvent 读**全局
   *  当前选择**（无 agent 上下文的总线 / 单测，零漂移）。 */
  private _seamView: SeamDisabledMap | null = null;

  /** 装配期灌入本总线的组合裁剪面（S6 P2a；emit 调用点零改动——发射点不必
   *  知道自己的组合，总线自己回答）。 */
  setSeamView(view: SeamDisabledMap | null | undefined): void {
    this._seamView = view ?? null;
  }

  /** 注册监听并返回 disposer（Phase 1 契约）。 */
  on(event: AgentEventName, fn: AnyListener, opts: ListenerOptions = {}): Disposer {
    const list = this.listeners.get(event) ?? [];
    const entry: Entry = { fn, priority: opts.priority ?? 0, seq: this.seq++ };
    list.push(entry);
    this.listeners.set(event, list);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const cur = this.listeners.get(event);
      if (!cur) return;
      const i = cur.indexOf(entry);
      if (i >= 0) cur.splice(i, 1);
    };
  }

  listenerCount(event: AgentEventName): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** 派发前守卫：按优先级同步执行，首个非 null 返回值短路。
   *  不吞异常——历史 planGate 直调无 try/catch，抛错即传播。 */
  runGuard(ctx: ToolPipelineContext): string | null {
    for (const e of this.ordered('tool/guard')) {
      const verdict = (e.fn as GuardListener)(ctx);
      if (verdict) return verdict;
    }
    return null;
  }

  /** 预检：按优先级同步执行，聚合非 null 警告（join '\n\n'）。
   *  监听器自身负责静默降级（适配层已内置，与旧 executor 相同）。 */
  runPreflight(ctx: ToolPipelineContext): string | null {
    const warnings: string[] = [];
    for (const e of this.ordered('tool/preflight')) {
      const w = (e.fn as PreflightListener)(ctx);
      if (w) warnings.push(w);
    }
    return warnings.length > 0 ? warnings.join('\n\n') : null;
  }

  /** 富化：output 按优先级异步流过监听器（waterfall）。
   *  监听器自身负责静默降级（适配层已内置）。 */
  async runAround(ctx: ToolPipelineContext, output: string): Promise<string> {
    let value = output;
    for (const e of this.ordered('tool/around')) {
      value = await (e.fn as AroundListener)(ctx, value);
    }
    return value;
  }

  /** 结果广播（fire-and-forget，不等待）。 */
  emitResult(ctx: ToolPipelineContext, result: { output: string; truncated: boolean; err: string | null }): void {
    for (const e of this.ordered('tool/result')) {
      (e.fn as ResultListener)(ctx, result);
    }
  }

  /** 错误广播（fire-and-forget，不等待）。 */
  emitError(ctx: ToolPipelineContext, err: string): void {
    for (const e of this.ordered('tool/error')) {
      (e.fn as ErrorListener)(ctx, err);
    }
  }

  /** D4 loop/能力域事件广播（emit 语义，fire-and-forget，不吞异常）。
   *  非 emit 域事件名在运行时响亮拒绝（类型层已收窄到 LoopEventName，此为
   *  JS 调用方守卫——错误不静默宪法）。
   *  事件面开关（平台化 Phase 3）：组合 `seam/loopEvents` 域禁用的事件
   *  不广播（观测面裁剪——R1 语义不变：事件非模型可见、不进 session log，
   *  禁用仅影响监听方观测，不影响 loop 执行本身）。
   *  裁剪面取值（S6 P2a）：本总线所属 Agent 的组合（setSeamView 灌入）；
   *  未灌入 = 全局当前选择（旧路径零漂移）。 */
  emitLoopEvent<E extends LoopEventName>(event: E, payload: LoopEventPayload[E]): void {
    const mode = AGENT_EVENT_MAP[event]?.mode;
    if (mode !== 'emit') {
      throw new Error(`[events] ${event} 非 emit 域事件（mode=${String(mode)}）——请走专用 runner`);
    }
    if (seamDisabled('loopEvents', this._seamView).has(event)) return;
    for (const e of this.ordered(event)) {
      (e.fn as (payload: LoopEventPayload[E]) => void)(payload);
    }
  }

  /** D4 类型化监听入口（返回 disposer）。目录单一真源 = AGENT_EVENT_MAP。 */
  onLoopEvent<E extends LoopEventName>(
    event: E,
    fn: (payload: LoopEventPayload[E]) => void,
    opts: ListenerOptions = {},
  ): Disposer {
    return this.on(event, fn as AnyListener, opts);
  }

  private ordered(event: AgentEventName): Entry[] {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return [];
    return [...list].sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }
}

// ── 适配层：planGate / preflight / hooks 经 bus 监听接线（生产路径）──
// 平台化 Phase 5：executor 统一走 eventBus（Agent 构造期 attach* 接线）；
// 本层即生产事实，executor 不再有 legacy 直调参数。

/** planGate → tool/guard 监听。非法 JSON（args null）放行至 invalid-JSON 错误路径。 */
export function attachPlanGate(bus: AgentEventBus, gate: PlanGate, opts: ListenerOptions = {}): Disposer {
  return bus.on(
    'tool/guard',
    (ctx: ToolPipelineContext) => (ctx.args && ctx.tool ? gate(ctx.call.name, ctx.args, ctx.tool) : null),
    opts,
  );
}

/** PreflightHookRegistry → tool/preflight 监听。静默降级与旧 executor 直调一致。 */
export function attachPreflightRegistry(
  bus: AgentEventBus,
  registry: PreflightHookRegistry,
  opts: ListenerOptions = {},
): Disposer {
  return bus.on(
    'tool/preflight',
    (ctx: ToolPipelineContext) => {
      if (!ctx.args) return null;
      try {
        return registry.check(ctx.guardName, ctx.args);
      } catch {
        return null; // 静默降级 — 不阻止执行
      }
    },
    opts,
  );
}

/** HookRegistry → tool/around 监听。静默降级与旧 executor 直调一致（不破坏结果）。 */
export function attachHookRegistry(bus: AgentEventBus, registry: HookRegistry, opts: ListenerOptions = {}): Disposer {
  return bus.on(
    'tool/around',
    async (ctx: ToolPipelineContext, output: string) => {
      if (!ctx.args) return output;
      try {
        return await registry.apply(ctx.guardName, ctx.args, output);
      } catch {
        return output; // 静默降级 — 不破坏结果
      }
    },
    opts,
  );
}

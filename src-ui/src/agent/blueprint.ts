// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// AgentBlueprint — 声明式组合层（agent-core-convergence Phase 6）。
//
// 目标：Agent 的组成（工具/hook/接线）以 capability 表描述，不再靠往
// AgentConfig 加字段 + 在 _assembleAgent 里写 if。新增一个工具或 hook =
// 在 blueprint 上 add 一个 capability（或经 createAgentFromContext 第 3 参
// 注入扩展蓝图）——AgentConfig 字段面从此冻结（specs/phase-6 T0 钉住）。
//
// 铁律（Phase 6 重写 _assembleAgent 的等价性基础）：
//   1. 注册顺序 = capability 表声明顺序。工具 schema 面的字节稳定性
//      （DeepSeek 前缀缓存 + phase-1 effective 快照）依赖此序——
//      第一方 capability 表（firstPartyCapabilities()，B⑤ 起经
//      ctx.capabilities 通道贡献）的表序与 Phase 5 末 _assembleAgent
//      的手写注册序一一对应，插入新 capability 必须显式选择位置
//      （表是唯一的序真源）；
//   2. capability 分两个阶段执行：'context'（Agent 构造前，可写 ctx 服务）与
//      'agent'（Agent 构造后）。阶段内按表序，阶段间先 context 后 agent；
//   3. 生命周期所有权（board/lifecycle/runtime-maps 的 ctx.effect）留在
//      runtime 装配层（Phase 4 语义）——capability 只做组合，不做 teardown；
//   4. hooks 统一注册进 scope 上的共享 HookRegistry/PreflightHookRegistry，
//      由 runtime 在 capability 循环后一次性 setHooks（Agent.setHooks 是
//      整体替换语义，capability 各自 set 会互相覆盖）。
//
// 行为规约（tests/blueprint.test.ts 钉住）：重复 key 拒绝；capabilities()
// 保持声明序；when() 缺省恒装；fromRoster 每次返回全新实例（调用方扩展
// 不得污染标准装配——标准面经组合解析产物派生，B⑤ 后 = 通道快照）。
//
// P4 B⑤（2026-08-24，agent-plugin-architecture-plan §5 B 表 ⑤ 收官）：
// 出厂 builtinCapabilities() 退役（B④ builtinPromptSections 退役同款终态）
// ——十四项定义仍留本文件（capability 单一真源），改名
// firstPartyCapabilities() 供第一方 capability 插件（plugins/
// capability-segments-plugin.ts）经 ctx.capabilities 通道注册装载；
// 装配缺省蓝图 = fromRoster(组合解析产物)（S2-1 既有穿线，零 runtime
// 改动），standard() 快捷方式随之退役（生产标准面 = 通道快照，测试钉面
// 经 composition/first-party-capabilities.ts 的 withFirstPartyCapabilityChannel）。

import type { Agent } from './agent';
import { createCodeExecutionTool } from './code-run/code-execution-tool';
import type { CodeBindingSpec } from './code-run/host';
import type { AgentContext } from './context';
import {
  createBuildResultHook,
  createStatePreflightHook,
  createStateReadHook,
  type HookRegistry,
  type PreflightHookRegistry,
} from './hooks';
import { createBoardTrackingHook } from './hooks/board-tracking-hook';
import type { MessageBus } from './message-bus';
import { activePlanImplementation } from './plan/plan-impl';
import { registerCompactionTools } from './runtime/agent-builder';
import type { AgentAssemblyInputs } from './runtime/types';
import type { DiagnosticsSource } from './state-inject';
import { createTaskTools, TaskManager } from './task';
import type { ToolRegistry } from './tool';
import { createBoardStatusTool } from './tools/board-status';
import { createCommunicationTools } from './tools/communication';
import { createDiscoveryTools } from './tools/discovery';
import { convergeRegistry } from './tools/domains';
import { createMergeTool } from './tools/merge';
import { createRequestTool } from './tools/request';
import { createAgentKillTool, createSubAgentTool } from './tools/subagent';

// ── 装配视图 ──

/** capability 装配阶段 — Agent 构造前（可写 ctx 服务）或构造后。 */
export type CapabilityPhase = 'context' | 'agent';

/** runtime 私有依赖经此注入 blueprint（capability 不直接触碰 runtime 内部状态）。 */
export interface BlueprintDeps {
  /** 隔离命令执行器（agent_isolation_* 的 invoke 包装 — merge/kill 共用）。 */
  isolationExec: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** runtime 全局消息总线 — 通信族工具的路由面（与旧装配的 this._bus 同源）。 */
  messageBus: MessageBus;
  /** LSP 诊断源（state hooks 用；缺省不注册 state 注入）。 */
  diagnosticsSource?: DiagnosticsSource;
  /** plan 模式变更通知（runtime notifier 路由；缺省静默）。 */
  onPlanModeChange?: (active: boolean, planFilePath: string | null) => void;
  /** 登记 per-Agent TaskManager（UI TasksPanel 经 runtime 读取）。 */
  registerTaskManager?: (tm: TaskManager) => void;
}

/** capability 安装时拿到的装配视图（只读材料 + 写入面）。 */
export interface BlueprintScope {
  /** 装配 context — 身份与服务真源。 */
  readonly ctx: AgentContext;
  /** 非服务装配输入（提示词原料/调优参数/工厂注入）。 */
  readonly inputs: AgentAssemblyInputs;
  /** 工具有效注册表（克隆件 — 模型可见面的唯一写入点）。 */
  readonly tools: ToolRegistry;
  /** 共享 hook 注册表 — capability 只注册，runtime 统一 setHooks。 */
  readonly hooks: HookRegistry;
  /** 共享 preflight hook 注册表 — 同上。 */
  readonly preflightHooks: PreflightHookRegistry;
  /** runtime 私有依赖。 */
  readonly deps: BlueprintDeps;
  /** 已构造的 Agent 实例 — 仅 'agent' 阶段可用。 */
  readonly agent?: Agent;
}

/** 一项声明式装配能力：条件 + 安装动作。id 全局唯一（重复即拒绝）。 */
export interface AgentCapability {
  /** 稳定标识 — 审计/排序/差分对拍/通道寻址用（M1 收口：字段名与其余七条
   *  贡献通道统一为 id；历史名 key 已废弃）。 */
  readonly id: string;
  /** 装配阶段。 */
  readonly phase: CapabilityPhase;
  /** 缺省恒装；返回 false 跳过。 */
  when?(scope: BlueprintScope): boolean;
  /** 安装动作 — 注册工具/hook、接线。不得做 teardown（那是 ctx.effect 的职责）。 */
  install(scope: BlueprintScope): void;
}

/** 取 'agent' 阶段的 Agent 实例 — context 阶段误用即抛错。 */
function requireAgent(scope: BlueprintScope): Agent {
  if (!scope.agent) {
    throw new Error('[blueprint] 该 capability 需要 Agent 实例 — phase 必须是 "agent"');
  }
  return scope.agent;
}

// ── AgentBlueprint ──

export class AgentBlueprint {
  private readonly _caps: AgentCapability[];

  /** 构造蓝图。capabilities 的 id 必须唯一（重复抛错 — 序与审计都依赖 id 唯一）。 */
  constructor(capabilities: AgentCapability[] = []) {
    const seen = new Set<string>();
    for (const cap of capabilities) {
      if (seen.has(cap.id)) throw new Error(`[blueprint] capability id 重复: ${cap.id}`);
      seen.add(cap.id);
    }
    this._caps = [...capabilities];
  }

  /** 追加 capability（链式）。返回本实例 — 扩展只应作用于调用方私有蓝图。 */
  add(...caps: AgentCapability[]): this {
    for (const cap of caps) {
      if (this._caps.some((c) => c.id === cap.id)) {
        throw new Error(`[blueprint] capability id 重复: ${cap.id}`);
      }
      this._caps.push(cap);
    }
    return this;
  }

  /** 按 id 查找。 */
  capability(id: string): AgentCapability | undefined {
    return this._caps.find((c) => c.id === id);
  }

  /** 全部 capability id（声明序）。 */
  ids(): string[] {
    return this._caps.map((c) => c.id);
  }

  /** 按阶段过滤（保持声明序）。缺省返回全部。 */
  capabilities(phase?: CapabilityPhase): AgentCapability[] {
    return phase ? this._caps.filter((c) => c.phase === phase) : [...this._caps];
  }

  /** 从 roster 行列表构造蓝图（S2-1 组合外化的装配入口；B⑤ 后唯一构造
   *  入口——standard() 快捷方式已退役）。表序 = 行序（roster 解析产物
   *  保序）；每次返回全新实例：调用方 add() 的扩展不得污染标准装配
   *  ——Phase 6 铁律「换真源不改语义」的表序契约在此保持。 */
  static fromRoster(capabilities: AgentCapability[]): AgentBlueprint {
    return new AgentBlueprint([...capabilities]);
  }
}

/** 第一方 capability 清单（序 = 迁移前出厂表序，十四项）——B⑤（2026-08-24）
 *  起经 ctx.capabilities 第一方插件通道贡献（plugins/capability-segments-
 *  plugin.ts 装载本清单，装配腰 composition/first-party-capabilities.ts）。
 *  出厂 builtinCapabilities() 退役，本清单即出厂装配面的全部 capability
 *  来源。行 id = capability id（roster patch 用户组合文件在 capabilities
 *  域的寻址面）。S2-0 从 standard() 内联数组原样拆出，内容零改写。 */
export function firstPartyCapabilities(): AgentCapability[] {
  return [
    // ── context 阶段（Agent 构造前）──
    {
      id: 'plan-tools',
      phase: 'context',
      install: ({ ctx, tools }) => {
        // 批 6a：实现在产物包 hologram/plan-mode，经内核登记表取用（feature 类——
        // 未登记/被禁用 = 静默不装，工具面少 enter/exit_plan_mode）。
        // readOnly: true → 两种模式都存活；planState 由 ctx 提供（翻译层或物化层创建）
        const plan = activePlanImplementation();
        if (!plan) return;
        tools.register(plan.createEnterTool(ctx.resolve('planState'), ctx.projectPath));
        // exit_plan_mode 使用 eventSink 将 PlanReview 事件推入聊天流
        tools.register(plan.createExitTool(ctx.resolve('planState'), ctx.get('eventSink')));
      },
    },
    // ── agent 阶段（Agent 构造后 — 表序即工具面注册序）──
    {
      // 通信族 — bus 注册本身在 Agent 构造内经 ctx 完成，这里补模型可见工具面
      id: 'communication-tools',
      phase: 'agent',
      install: (scope) => {
        const agent = requireAgent(scope);
        for (const tool of createCommunicationTools(scope.deps.messageBus, () => agent.id)) {
          scope.tools.register(tool);
        }
      },
    },
    {
      // discovery 族 — 同上；proxy 已由物化层静态绑定到该 Agent 的会话板
      id: 'discovery-tools',
      phase: 'agent',
      install: (scope) => {
        const agent = requireAgent(scope);
        for (const tool of createDiscoveryTools(scope.ctx.resolve('discoveryBoard'), () => agent.id)) {
          scope.tools.register(tool);
        }
      },
    },
    {
      // 子 Agent 管理族（merge/board/kill）— 需要会话级 pool
      id: 'merge-tools',
      phase: 'agent',
      when: ({ ctx }) => !!ctx.get('subAgentPool'),
      install: (scope) => {
        const agent = requireAgent(scope);
        const subPool = scope.ctx.get('subAgentPool');
        if (!subPool) return;
        const taskProxy = scope.ctx.resolve('taskBoard');
        scope.tools.register(
          createMergeTool(taskProxy, () => agent.id, scope.deps.isolationExec, {
            projectPath: scope.ctx.projectPath,
          }),
        );
        scope.tools.register(createBoardStatusTool(taskProxy, () => agent.id));
        scope.tools.register(createAgentKillTool(subPool, scope.deps.isolationExec));
      },
    },
    {
      // 同步请求工具 — agent_request
      id: 'request-tool',
      phase: 'agent',
      install: (scope) => {
        const agent = requireAgent(scope);
        scope.tools.register(createRequestTool(scope.deps.messageBus, () => agent.id));
      },
    },
    {
      // 替换 agent_spawn 为绑定本 Agent 的版本 — 修复多会话下 spawn 路由错位
      id: 'spawn-tool',
      phase: 'agent',
      when: ({ ctx, inputs }) => !!ctx.get('subAgentPool') && !!inputs.subAgentSpawner,
      install: (scope) => {
        const agent = requireAgent(scope);
        const subPool = scope.ctx.get('subAgentPool');
        const spawner = scope.inputs.subAgentSpawner;
        if (!subPool || !spawner) return;
        scope.tools.unregister('agent_spawn');
        scope.tools.register(
          createSubAgentTool(
            (desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride, outputSchema) =>
              agent.spawnSubAgent(desc, prompt, prog, mode, al, sig, asyncMode, agentIdOverride, outputSchema),
            subPool,
          ),
        );
      },
    },
    {
      // 替换 task_* 为绑定本 Agent 实例的专属待办 — 每 Agent 一份清单
      id: 'task-tools',
      phase: 'agent',
      install: (scope) => {
        const perAgentTaskManager = new TaskManager();
        for (const taskTool of createTaskTools(perAgentTaskManager)) {
          scope.tools.unregister(taskTool.name());
          scope.tools.register(taskTool);
        }
        scope.deps.registerTaskManager?.(perAgentTaskManager);
      },
    },
    {
      // 压缩工具 + tracker 持久化路径
      id: 'compaction-tools',
      phase: 'agent',
      install: (scope) => {
        const agent = requireAgent(scope);
        agent.setCompactionConfigPath(scope.ctx.projectPath);
        registerCompactionTools(agent, scope.tools);
      },
    },
    {
      // code_execution 执行原语（P2 建立，P3 起经 ctx.codeRuntime 服务运行）：
      // 绑定面 = CodeBindingSpec（invoke 闭包持有 executor 等价体 + 审计），
      // runtime 不知道工具和会话（DSH 接缝纪律）。审计序在闭包内自持
      // （dispatchCounter——装配期局部，不落模块态）。
      // 位置：compaction-tools 之后、converge-tools 之前——常驻名不进
      // DOMAIN_SPECS（与 ask_user/wait 同类的会话级原语），注册序在此
      // 显式选定（D7：表序 = 字节契约）。
      id: 'code-execution-tool',
      phase: 'agent',
      install: (scope) => {
        const agent = requireAgent(scope);
        const sessionLog = agent.sessionLog;
        let dispatchCounter = 0;
        // 绑定集：注册表可见面快照（排除自身——防程序内自递归撞 worker 上限）；
        // invoke 闭包 = dispatchNestedTool（executor 等价体）+ 逐条审计落账
        //（与旧 onDispatch 语义一致：start/end 各一条，seq 单调递增）。
        const bindings: CodeBindingSpec[] = scope.tools
          .visibleTools()
          .filter((t) => t.name() !== 'code_execution')
          .map(
            (t): CodeBindingSpec => ({
              name: t.name(),
              readOnly: t.readOnly(),
              invoke: async (args) => {
                const seq = ++dispatchCounter;
                sessionLog.append('tool/code-dispatch-start', { seq, name: t.name(), args });
                const outcome = await agent.dispatchNestedTool(t.name(), args);
                sessionLog.append('tool/code-dispatch', {
                  seq,
                  name: t.name(),
                  isError: outcome.isError,
                  output: outcome.output,
                });
                return outcome;
              },
            }),
          );
        scope.tools.register(createCodeExecutionTool({ bindings }));
        agent.setCodeDispatch((name, args) => agent.dispatchNestedTool(name, args));
      },
    },
    {
      // 工具层收敛：领域工具 + 隐藏旧名（必须在全部工具注册之后 — 表序保证）
      id: 'converge-tools',
      phase: 'agent',
      install: ({ tools }) => {
        convergeRegistry(tools);
      },
    },
    {
      // 状态 + 构建结果 hooks（提示注入类 — 受 hooksEnabled 总开关）。
      // 2026-09-09 图谱退役：graph-hooks 收缩为纯状态面并改名 state-hooks——
      // graphContext 系（graph-context/graph-preflight/plan 增强/引擎快照加载）
      // 随图谱全量退役删除；state-read/state-preflight 的数据源是 LSP 诊断
      //（与图谱引擎无关），build-result 承接原 graph-context hook 的
      // run_shell 构建缓存分支（[构建] turn-start 注入源）。
      id: 'state-hooks',
      phase: 'agent',
      install: ({ ctx, inputs, hooks, preflightHooks, deps }) => {
        if (inputs.hooksEnabled === false) return;
        if (deps.diagnosticsSource) {
          hooks.register(createStateReadHook(ctx.projectPath, deps.diagnosticsSource));
        }
        hooks.register(createBuildResultHook());
        if (deps.diagnosticsSource) {
          preflightHooks.register(createStatePreflightHook(deps.diagnosticsSource));
        }
      },
    },
    {
      // Board 追踪 hook — board 可用时始终注册（有实际副作用，不受 hooksEnabled 影响）
      id: 'board-tracking-hook',
      phase: 'agent',
      install: ({ ctx, hooks }) => {
        hooks.register(createBoardTrackingHook(ctx.agentId, ctx.resolve('taskBoard')));
      },
    },
    {
      // Plan 模式接线 — runLoop 提醒注入器 + 状态通知（批 6a：实现经登记表取自
      // 产物包 hologram/plan-mode；未登记 = 静默不装）
      id: 'plan-injector',
      phase: 'agent',
      install: (scope) => {
        const plan = activePlanImplementation();
        if (!plan) return;
        const agent = requireAgent(scope);
        agent.setPlanState(scope.ctx.resolve('planState'), plan.createInjector(), scope.ctx.projectPath);
        scope.ctx.resolve('planState').onChange((s) => {
          scope.deps.onPlanModeChange?.(s.active, s.planFilePath);
        });
      },
    },
    {
      // 自动调优 — fire-and-forget
      id: 'auto-tune',
      phase: 'agent',
      install: (scope) => {
        const agent = requireAgent(scope);
        void agent.applyAutoTuneConfig().catch(() => {});
      },
    },
  ];
}

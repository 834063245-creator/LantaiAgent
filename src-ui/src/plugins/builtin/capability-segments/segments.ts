// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

import type { Agent, AgentCapability, BlueprintScope, CodeBindingSpec } from './host';
// capability-segments · 第一方 capability 内容表（批 9h-1，2026-09-26 自 agent/blueprint.ts 随包）。
//
// 判据（同批 9g-1 prompt 段）：**内容 vs 机制**——十四项 capability 定义是出厂内容
//（改一项 = 换产物热更），而 `AgentBlueprint` 类 + 形状（`AgentCapability` / `BlueprintScope` /
// `BlueprintDeps`）是内核组合机制（runtime 装配面读它）。
//
// 序纪律：数组序 = 注册序 = 工具面表序（DeepSeek 前缀缓存 + effective 快照依赖此序）——
// 搬移逐字不改序；注册走 `ctx.capabilities` 通道（本包 index.ts 的 apply）。
//
// 内核取用面（登记表读面 + 工具工厂）全部经宿主桥 `./host`：本表只做组合，不持状态。
import {
  activeDiscoveryTools,
  activeMergeTools,
  activePlanImplementation,
  activeStateHooksImplementation,
  activeSubAgentTools,
  convergeRegistry,
  createBoardStatusTool,
  createCodeExecutionTool,
  createTaskTools,
  registerCompactionTools,
  requireMultiagentComm,
  TaskManager,
} from './host';

// ── 表内 helper（原样随迁：仅本表使用）──

/** 取 'agent' 阶段的 Agent 实例 — context 阶段误用即抛错。 */
function requireAgent(scope: BlueprintScope): Agent {
  if (!scope.agent) {
    throw new Error('[blueprint] 该 capability 需要 Agent 实例 — phase 必须是 "agent"');
  }
  return scope.agent;
}

/** 出厂 hook 实现缺失时的装配期错误（service 类：hook 管道是内核语义，缺了就是装歪）。 */
const STATE_HOOKS_UNAVAILABLE =
  '出厂 hook 实现缺失：hologram/state-hooks 产物未装载（service 类产物不可禁用）——检查产物通道 / loadBuiltinPlugins。';

/** 第一方 capability 清单（序 = 迁移前出厂表序，十四项）——B⑤（2026-08-24）
 *  起经 ctx.capabilities 第一方插件通道贡献（本包 index.ts 装载本清单，装配腰
 *  composition/first-party-capabilities.ts）。
 *  出厂 builtinCapabilities() 退役，本清单即出厂装配面的全部 capability
 *  来源。行 id = capability id（roster patch 用户组合文件在 capabilities
 *  域的寻址面）。S2-0 从 standard() 内联数组原样拆出，内容零改写；
 *  批 9h-1 自 `agent/blueprint.ts` 整段随包（逐字搬移，序原样）。 */
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
        // 批 7b：通信域实现在产物包 hologram/multiagent-comm，经内核登记表取用
        for (const tool of requireMultiagentComm().createCommunicationTools(scope.deps.messageBus, () => agent.id)) {
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
        const discoveryTools = activeDiscoveryTools();
        if (!discoveryTools) return;
        for (const tool of discoveryTools.createDiscoveryTools(scope.ctx.resolve('discoveryBoard'), () => agent.id)) {
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
        // 批 7c-1：merge 工具族实现在产物包 subagent-in-process，经内核登记表取用
        // （feature 类——未登记 = 静默不装）
        const mergeTools = activeMergeTools();
        if (mergeTools) {
          scope.tools.register(
            mergeTools.createMergeTool(taskProxy, () => agent.id, scope.deps.isolationExec, {
              projectPath: scope.ctx.projectPath,
            }),
          );
        }
        scope.tools.register(createBoardStatusTool(taskProxy, () => agent.id));
        // 批 7a：工具族实现在产物包 hologram/agent-domain，经内核登记表取用
        // （feature 类——未登记/被禁用 = 静默不装）
        const subagentTools = activeSubAgentTools();
        if (subagentTools) scope.tools.register(subagentTools.createAgentKillTool(subPool, scope.deps.isolationExec));
      },
    },
    {
      // 同步请求工具 — agent_request
      id: 'request-tool',
      phase: 'agent',
      install: (scope) => {
        const agent = requireAgent(scope);
        scope.tools.register(requireMultiagentComm().createRequestTool(scope.deps.messageBus, () => agent.id));
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
        const subagentTools = activeSubAgentTools();
        if (!subagentTools) return;
        scope.tools.unregister('agent_spawn');
        scope.tools.register(
          subagentTools.createSubAgentTool(
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
        // 批 6c：出厂 hook 实现在产物包 hologram/state-hooks，经内核登记表取用。
        // service 类（不可禁用）：缺实现 = 装歪了，装配期 fail-loud（不静默降级）。
        const impl = activeStateHooksImplementation();
        if (!impl) throw new Error(STATE_HOOKS_UNAVAILABLE);
        if (deps.diagnosticsSource) {
          hooks.register(impl.createStateReadHook(ctx.projectPath, deps.diagnosticsSource));
        }
        hooks.register(impl.createBuildResultHook());
        if (deps.diagnosticsSource) {
          preflightHooks.register(impl.createStatePreflightHook(deps.diagnosticsSource));
        }
      },
    },
    {
      // Board 追踪 hook — board 可用时始终注册（有实际副作用，不受 hooksEnabled 影响）。
      // 批 6c：同上，实现经登记表取自产物包。
      id: 'board-tracking-hook',
      phase: 'agent',
      install: ({ ctx, hooks }) => {
        const impl = activeStateHooksImplementation();
        if (!impl) throw new Error(STATE_HOOKS_UNAVAILABLE);
        hooks.register(impl.createBoardTrackingHook(ctx.agentId, ctx.resolve('taskBoard')));
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

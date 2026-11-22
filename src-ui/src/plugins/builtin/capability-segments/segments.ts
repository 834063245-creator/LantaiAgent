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
  createTaskManager,
  createTaskTools,
  registerCompactionTools,
  requireMultiagentComm,
} from './host';

// ── 表内 helper（原样随迁：仅本表使用）──

/** shell `run` 的缺省超时兜底（P0 预算穿透用）。取数走**活 schema** 的 default
 *  （单一真源在 shell-domain 的 zod，改那边这里跟着变）；只有读不到 schema 时才
 *  用它。惰性求值：域门面是构建期快照，闭包捕获会读到过期实例（同 readOnlyFor 的取证）。 */
const SHELL_RUN_DEFAULT_TIMEOUT_MS = 300_000;

/** shell `wait` 的缺省等待预算——与 Rust 同源（`process_cap.rs` 的
 *  `wait_timeout_ms.unwrap_or(60_000)`）。用于判断「模型没给 timeoutMs 时，
 *  60s 的缺省等待会不会撞穿外层墙」。守护测试逐字对拍两处。 */
const SHELL_WAIT_DEFAULT_TIMEOUT_MS = 60_000;

function shellRunDefaultTimeoutMs(parameters: unknown): number {
  const props = (parameters as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties;
  const d = props?.timeoutMs?.default;
  return typeof d === 'number' ? d : SHELL_RUN_DEFAULT_TIMEOUT_MS;
}

/** 取 'agent' 阶段的 Agent 实例 — context 阶段误用即抛错。 */
function requireAgent(scope: BlueprintScope): Agent {
  if (!scope.agent) {
    throw new Error('[blueprint] 该 capability 需要 Agent 实例 — phase 必须是 "agent"');
  }
  return scope.agent;
}

/** 写锁键归一（P2）：工作区相对路径 → 绝对、去 `./`、统一分隔符、小写折叠。
 *  折叠方向是**过度串行**（Windows 大小写、Linux `Foo`/`foo` 会并成一把锁）——
 *  安全的错误方向；漏串行才是 race。 */
function codeWriteKey(projectPath: string, raw: string): string {
  const unified = raw.replace(/\\/g, '/');
  const absolute = unified.startsWith('/') || /^[a-zA-Z]:\//.test(unified);
  const base = projectPath.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const seg of (absolute ? unified : `${base}/${unified}`).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/').toLowerCase();
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
        const perAgentTaskManager = createTaskManager();
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
              // 按动作判定只读（P2）：动作白名单从**活注册表**取——域门面是构建期
              // 快照，闭包捕获 t 会读到过期动作集（计划 §3.4 取证）。
              readOnlyFor: (args) => {
                const live = scope.tools.get(t.name());
                const ro = live?.readOnlyActions?.() ?? [];
                if (ro.length === 0) return live?.readOnly?.() ?? t.readOnly();
                const action = typeof args.action === 'string' ? args.action : undefined;
                return action !== undefined && ro.includes(action);
              },
              // 写锁键（P2）：只有明确的单文件动作分片（fs 的 read/write/edit…），
              // 其余（mv/rm/shell/git…）一律回落排他闸 '*'——路径不明确的分片
              // 等于把「串行」换成 race。
              lockKey: (args) => {
                const p = args.filePath;
                return typeof p === 'string' && p.length > 0 ? `file:${codeWriteKey(scope.ctx.projectPath, p)}` : '*';
              },
              // 前台窗口预算（P0-2，2026-11-22）：按**动作**声明可压超时。
              //   run  ：超时 = 转后台（Rust promote）。内层 300s > 外层 120s 墙时的
              //          「vitest 永远跑不完」正解——压到 promote 点之前是无损的。
              //   wait ：超时 = 还在跑（Rust 返回 [任务运行中]）。压短只让它更早回话，
              //          也是卷 167 exception 的修复点（旧声明让 wait 借走了 run 的语义）。
              //   output/kill：不压。它们没有前台窗口，压了只会往审计塞模型没给过的参数。
              ...(t.name() === 'shell'
                ? {
                    softTimeout: {
                      run: {
                        defaultTimeoutMs: () => shellRunDefaultTimeoutMs(scope.tools.get('shell')),
                        // 后台命令不需要前台窗口（卷 155：压它只污染审计）。
                        detached: (a: Record<string, unknown>) => a.runInBackground === true,
                        // 尾部窗口：压不出一个前台窗口就**直接给句柄**。让外层墙把刚起的
                        // 进程 kill 掉是最坏结局（工作没了，模型还以为是失败）。
                        onExhausted: (a: Record<string, unknown>) => ({ ...a, runInBackground: true }),
                      },
                      // wait 没有 promote 宽限窗：余量只留给 IPC；压到 2s 以上都无害。
                      wait: {
                        defaultTimeoutMs: () => SHELL_WAIT_DEFAULT_TIMEOUT_MS,
                        marginMs: 3_000,
                        floorMs: 2_000,
                      },
                    },
                  }
                : {}),
              invoke: async (args, ctx) => {
                const seq = ++dispatchCounter;
                // 审计用独立快照（P2-4）：分发与日志共用同一个 args 引用时，工具在
                // execute 里 mutate 参数会把已落账的 dispatch-start 一起改掉——
                // session-log.append 只浅冻结事件对象，`data.args` 仍是同一引用。
                // P0-2：预算改写时 args 是**改写后**的——落账记模型给的原值 + 改写台账，
                // 否则日志会声称模型传过一个它没传的数（卷 155/167 的 1119xx 就是这么来的）。
                sessionLog.append('tool/code-dispatch-start', {
                  seq,
                  name: t.name(),
                  args: structuredClone(ctx?.budget?.args ?? args),
                  ...(ctx?.budget ? { budget: ctx.budget.rewrite } : {}),
                });
                // P0：把 run 作用域信号传下去——超时/中止时工具本体收到取消，
                // shell 据此 kill 子进程（不做这件事就是刷孤儿 vitest）。
                const outcome = await agent.dispatchNestedTool(t.name(), args, ctx?.signal);
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
        scope.tools.register(
          createCodeExecutionTool({
            bindings,
            // 目录数据源 = **活注册表**（不是上面那个 install 期快照）：域门面是
            // 构建期冻结的实例，装配期取会晚一次收敛——计划 §3.4 取证（实测
            // snapshot=["fs"] vs live=["fs","agent"]）。描述本身惰性求值。
            catalog: () => scope.tools.visibleTools(),
            // P1-2 待领信箱：程序结束后才返回的调用结果存进 Agent，由每步的
            // applyPendingMemoryUpdates 注入一次（不可后台化的长调用不再白丢）。
            onLateResult: (entry) => agent.noteLateNestedResult(entry),
          }),
        );
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

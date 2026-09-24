// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 子 Agent 派生 — 并行/委派工作。从 agent.ts 机械搬移（11c），零逻辑改动。
// 宿主模式：Agent 类经受控转换（as unknown as SubAgentSpawnHost）传入本模块；
// 循环 import（agent.ts ↔ 本文件）是安全的 — Agent 仅在函数体内引用，模块求值期不触达。

import type { Provider } from '../provider/types';
import { Agent } from './agent';
import type { AgentStore } from './agent-store';
import type { AgentUINotifier } from './agent-types';
import type { AgentContext } from './context';
import type { DiscoveryBoard } from './discovery-board';
import { createExecState } from './execution-state';
import { extractFilePath, FileOwnership, WRITE_TOOLS } from './file-ownership';
import { HookRegistry } from './hooks';
import { enqueueIsolationOp } from './isolation-queue';
import { log } from './logger';
import type { MessageBus } from './message-contract';
import { planRegistry } from './plan/plan-registry';
import type { PlanStateManager } from './plan/plan-state';
import { buildOutputSchemaInstruction } from './schema-validate';
import { activeStateHooksImplementation } from './state-hooks-impl';
import { removeSubAgentActivity, wrapSubAgentSink } from './subagent-activity';
import { activeDiscoveryTools } from './subagent-runtime-impl';
import type { TaskBoard } from './task-board';
import type { Tool } from './tool';
import { ToolRegistry } from './tool';
import { convergeRegistry } from './tools/domains';

/** 子 Agent 派生对宿主 Agent 的最小状态面（成员与 Agent 类声明逐字对齐）。 */
export interface SubAgentSpawnHost {
  readonly id: string;
  readonly prov: Provider;
  readonly tools: ToolRegistry;
  readonly contextWindow: number;
  readonly _subagentDepth: number;
  readonly _ctx: AgentContext;
  readonly _planState: PlanStateManager | null;
  readonly _discoveryBoard: DiscoveryBoard | null;
  readonly _taskBoard: TaskBoard | null;
  readonly _bus: MessageBus | null;
  readonly _ui: AgentUINotifier;
  readonly _uiSessionId: number;
  readonly agentStore: AgentStore | null;
  _currentRunSignal: AbortSignal | null;
  _fileOwnership: FileOwnership | null;
  /** 附图字节读取器（B3 multimodal-image-plan）——子 Agent 继承父读取器。 */
  _imageReader: import('./request-images').RequestImageReader | null;
  extractRecentContext(maxMessages: number): string;
  /** 父 preflight 注册表（null = 主 Agent 未接线）— 子 Agent 门禁继承用。 */
  getPreflightHooks(): import('./hooks').PreflightHookRegistry | null;
}

const MAX_SUBAGENT_DEPTH = 3;

/** 用自定义 execute 函数包装一个 Tool，返回新的 Tool 对象。
 *  原始 Tool 永远不会被修改 — 这点至关重要，因为父 Agent
 *  与其子 Agent 共享 Tool 引用。 */
export function wrapTool(original: Tool, execute: Tool['execute']): Tool {
  return {
    name: () => original.name(),
    description: () => original.description(),
    parameters: () => original.parameters(),
    readOnly: () => original.readOnly(),
    execute,
  };
}

/** 构造子 Agent 工具集：从源注册表克隆 + 可选允许列表，再剥离委派越权工具。
 *  独立为纯函数 — 委派边界（不可扩权）是正确性语义，必须可单测断言。 */
export function buildSubAgentTools(source: ToolRegistry, toolAllowlist?: string[] | null): ToolRegistry {
  const subTools = new ToolRegistry();
  const allowed = toolAllowlist && toolAllowlist.length > 0 ? new Set(toolAllowlist) : null;
  for (const t of source.all()) {
    if (!allowed || allowed.has(t.name())) {
      subTools.register(t);
    }
  }
  // 子 Agent 是工人不是编排者 — 不递归派生、不杀兄弟、不观测池
  subTools.unregister('agent_spawn');
  subTools.unregister('agent_kill');
  subTools.unregister('agent_status');
  // 委派不可扩权（DSH delegation policy 对应物）：
  // - ask_user：子 Agent 不直接与人类交互 — 需要人类决策时写进报告由父 Agent 转达
  // - enter/exit_plan_mode：plan 状态机是父级协作模式，闭包绑定父 planState —
  //   子 Agent 调用会翻父 Agent 的模式，构成越权
  subTools.unregister('ask_user');
  subTools.unregister('enter_plan_mode');
  subTools.unregister('exit_plan_mode');
  return subTools;
}

/** 派生子 Agent 处理聚焦任务。阻塞直到子 Agent 完成；
 *  子 Agent 的最终报告（加合并备注）成为工具结果。
 *  `mode: 'fork'`（默认）注入父 Agent 的近期上下文并在
 *  git worktree 中隔离文件编辑；`mode: 'fresh'` 是全新 Agent。
 *  中止源合并: 用户停止（当前 run signal）+ pool 停止/超时。 */
export async function spawnSubAgentImpl(
  ag: SubAgentSpawnHost,
  description: string,
  prompt: string,
  onProgress?: (chunk: string) => void,
  mode: 'fork' | 'fresh' = 'fork',
  toolAllowlist?: string[] | null,
  poolSignal?: AbortSignal,
  asyncMode?: boolean,
  agentIdOverride?: string,
  outputSchema?: Record<string, unknown> | null,
): Promise<{ text: string; err?: string }> {
  // 基于深度的递归守卫 — fork 与 fresh 一视同仁：递归爆炸与继承上下文无关，
  // 到达深度上限后两种模式都不许再派生子 Agent。
  if (ag._subagentDepth >= MAX_SUBAGENT_DEPTH) {
    return { text: '', err: `Exceeded max subagent depth (${MAX_SUBAGENT_DEPTH})` };
  }

  // 合并中止源 — 子 Agent 在用户运行停止或 pool 停止/超时时终止。
  // （旧接线太晚移交 pool signal，导致 "已停止" 的 Agent 继续脱离运行。）
  // async 模式下子 agent 生命周期独立于父单轮 run；
  // sync 模式下父 agent 在等，父被 stop 子 agent 也该 stop
  const abortSources: AbortSignal[] = [];
  if (ag._currentRunSignal && !asyncMode) abortSources.push(ag._currentRunSignal);
  if (poolSignal) abortSources.push(poolSignal);
  const signal =
    abortSources.length > 1 ? AbortSignal.any(abortSources) : (abortSources[0] ?? new AbortController().signal);

  // 自动隔离: 为 fork 子 Agent 创建 git worktree，使文件修改
  // 被沙箱化并可在合并前审阅（diff）。隔离工具不可用时静默降级为直接模式
  // （headless/测试环境无 git 隔离）；创建失败必须显式告警 —— 静默降级意味着
  // 子 Agent 裸写主仓且无人知晓（2026-08-13 事故 R2）。
  let isolationId: string | null = null;
  let isolationError: string | null = null;
  if (mode === 'fork' && ag.tools.get('agent_isolation_create')) {
    isolationId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const createT = ag.tools.get('agent_isolation_create');
      if (createT) await createT.execute({ agent_id: isolationId });
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      isolationError = m || String(e);
      isolationId = null;
      log.warn('agent', `fork 子 Agent worktree 创建失败，降级为直写主仓: ${isolationError}`);
    }
  }
  const degradeNote = isolationError
    ? `⚠️ [隔离降级] worktree 创建失败（${isolationError}）。该子 Agent 的修改直接写入主仓工作区、未经隔离；` +
      '请用 git_status / git_diff 核验其实际改动，不要按「已隔离合并」处理。'
    : '';

  // 从父 Agent 克隆工具 — 如指定则应用允许列表过滤。
  // plan 模式：主 Agent 是单一注册表 + 执行层门禁（schema 恒定保缓存），
  // 但子 Agent 生命周期可能跨越 plan 退出，故静态降级为只读克隆，
  // 保持"plan 中 spawn = 并行只读探索"语义（与原 planR 克隆一致）。
  const cloneSource = ag._planState?.state.active ? planRegistry(ag.tools, ag._planState) : ag.tools;
  const subTools = buildSubAgentTools(cloneSource, toolAllowlist);

  // 用子 Agent 自己的 id 重新注册 discovery 工具 — 克隆的
  // 工具的 getAgentId 闭包捕获的是父 Agent 的 id，会导致
  // archive() 永远匹配不上（onFinish 传的是子 Agent 的模型可见 id）。
  if (ag._discoveryBoard) {
    const subDiscId = agentIdOverride ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // 批 7c-1：discovery 工具族实现在产物包 subagent-in-process，经内核登记表取用
    const discoveryTools = activeDiscoveryTools();
    for (const tool of discoveryTools ? discoveryTools.createDiscoveryTools(ag._discoveryBoard, () => subDiscId) : []) {
      subTools.unregister(tool.name());
      subTools.register(tool);
    }
  }

  // ── 硬性阻止子 Agent 执行构建/测试命令 ──
  // 这些命令并行运行时会争抢文件锁（cargo target/、node_modules/、
  // .git/index.lock），导致死锁或超时。
  // 子 Agent 应完成文件修改并报告改了什么；
  // 父 Agent 在所有子 Agent 完成后统一运行验证。
  const BUILD_TEST_RE =
    /\b(?:cargo|npm|npx|pnpm|yarn|make|docker|rustc|tsc|gradle|gradlew|mvn|mvnw|cmake|pytest|dotnet|xcodebuild|zig)\b|go\s+(?:build|test|vet|run)|python\s+-m\s+pytest/;
  const shellTool = subTools.get('run_shell');
  if (shellTool) {
    const origShellExec = shellTool.execute.bind(shellTool);
    subTools.unregister('run_shell');
    subTools.register(
      wrapTool(shellTool, async (args, onProgress, signal) => {
        const cmd = (args.command as string) || '';
        if (BUILD_TEST_RE.test(cmd)) {
          return (
            `[已拦截] 子 Agent 不允许执行构建/测试/包管理命令（"${cmd.slice(0, 100)}"）。\n` +
            `原因：并行子 Agent 同时跑这类命令会争抢文件锁（target/、node_modules/、.git/index.lock 等），导致死锁或超时。\n` +
            `请直接完成文件修改，在结论中说明：你改了哪些文件、建议主 Agent 跑什么命令来验证。`
          );
        }
        return origShellExec(args, onProgress, signal);
      }),
    );
  }

  // ── fresh 子 Agent 的文件所有权（fork 有 worktree 隔离） ──
  // 先写者声明文件；其他子 Agent 被拒绝。
  // 防止多个 fresh Agent 并发编辑同一工作区时
  // 静默的"后写覆盖先写"。
  // fork 隔离创建失败（降级直写主仓）时同样需要所有权兜底。
  if (mode === 'fresh' || (mode === 'fork' && !isolationId)) {
    if (!ag._fileOwnership) {
      ag._fileOwnership = new FileOwnership();
    }
    const ownership = ag._fileOwnership;
    const subAgentId = agentIdOverride ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (const toolName of WRITE_TOOLS) {
      const tool = subTools.get(toolName);
      if (!tool) continue;
      const origExec = tool.execute.bind(tool);
      subTools.unregister(toolName);
      subTools.register(
        wrapTool(tool, async (args, onProgress, signal) => {
          const filePath = extractFilePath(toolName, args);
          if (filePath) {
            const result = ownership.claim(filePath, subAgentId);
            if (!result.ok) {
              return (
                `[已拒绝] 文件 "${filePath}" 正在被另一个子 Agent (${result.owner}) 修改。\n` +
                `原因：并行子 Agent 同时写同一文件会导致后写覆盖先写（静默丢改动）。\n` +
                `请只修改分配给你的文件。如果确实需要改这个文件，在结论中说明，由主 Agent 统一处理。`
              );
            }
          }
          // move_file also claims the destination
          if (toolName === 'move_file' && args.to) {
            const result = ownership.claim(args.to as string, subAgentId);
            if (!result.ok) {
              return `[已拒绝] 目标路径 "${args.to}" 正在被另一个子 Agent (${result.owner}) 修改。`;
            }
          }
          return origExec(args, onProgress, signal);
        }),
      );
    }
  }

  // ── 领域工具必须对 subTools 重建 ──
  // 克隆进来的 fs/shell 等领域工具对象，其 execute 闭包绑定的是**父注册表**
  // （domains.ts buildDomainTool 在构建时捕获 registry）。不重建的话，
  // 子 Agent 走 fs(edit)/shell(...) 会查到父注册表里的未包装工具 —
  // 上面的所有权包装与构建/测试禁令全部被旁路（2026-08-13 事故 R13）。
  // 顺带把旧工具名在子 Agent 里也隐藏（与主 Agent 可见面一致）。
  convergeRegistry(subTools);

  let subSystem: string;

  if (mode === 'fork') {
    // Fork 模式: 干净的子 Agent，拥有自己的 system prompt（不继承
    // 父 Agent 的会话/system prompt — 那会使 fork 尝试派生自己的
    // 子 Agent）。父 Agent 的近期工具输出作为上下文注入，
    // 使 fork 知道已读取/修改了什么。
    const recentContext = ag.extractRecentContext(6);

    subSystem = `你是主Agent派出的工作进程（fork）。你不是主Agent。

## 你的任务
${prompt}

## 硬性规则
1. **直接执行** — 直接读、写、搜索、跑命令。你不能 spawn 子Agent（该工具已移除）
2. **专注** — 只完成分配给你的任务，不要偏离
3. **先查后动** — 涉及代码库的，先查再动手
4. **直接给结论** — 不要反问、不要建议下一步、不要写论文
5. **不跑构建/测试** — 不要跑 cargo / npm / pnpm / make / docker / go build 等任何构建、测试或包管理命令。这些命令在并行环境下会争抢文件锁（如 target/、node_modules/、.git/index.lock），导致死锁或超时。你只负责改文件，验证由主 Agent 在所有子任务完成后统一执行。如果认为改动有风险，在结论里说明即可。
${
  isolationId
    ? '6. **隔离** — 你的文件修改在独立 git worktree 中进行，正常保存即可；任务成功后变更会自动合并回主仓'
    : '6. **⚠️ 无隔离** — worktree 隔离创建失败，你的修改将直接写入主仓工作区。只改任务必需的文件，绝不碰无关文件；你的改动会由主 Agent 直接核验'
}

## 父Agent近期上下文（⚠️ 快照 — 可能已过期。操作前自行验证文件当前状态）
${recentContext}`;
  } else {
    subSystem = `你是主 Agent 派出的子任务 Agent。执行一个聚焦的专项任务。

## 任务
${prompt}

## 规则
1. **全权** — 你有写文件、跑命令、Git 操作的全部权限。放心干。
2. **专注** — 只完成分配给你的任务，不要偏离。
3. **先查后动** — 涉及代码库的，先调图查询工具（hologram_*）再动手。
4. **直接给结论** — 不要反问或延续对话。完成后直接输出结果。
5. **简短** — 输出精炼，不需要写论文。
6. **不跑构建/测试** — 不要跑 cargo / npm / pnpm / make / docker / go build 等任何构建、测试或包管理命令。这些命令在并行环境下会争抢文件锁（如 target/、node_modules/、.git/index.lock），导致死锁或超时。你只负责改文件，验证由主 Agent 统一执行。如果认为改动有风险，在结论里说明即可。

## 可用工具
${subTools
  .all()
  .map((t) => `- **${t.name()}**: ${t.description().slice(0, 100)}`)
  .join('\n')}`;
  }

  // 委派边界 — 权限范围在派发时固定，会话内不可扩权（DSH delegation 语义）
  subSystem += `

## 委派边界（不可逾越）
- 你的工具集在派发时已固定，就是你的全部能力 — 不可要求新工具，不可绕过限制。
- 你没有 ask_user：不得直接向用户提问或请求授权。需要人类决策时，把问题写进最终报告，由父 Agent 转达。`;

  // 结构化返回：在系统提示末尾追加强制 JSON 输出契约
  if (outputSchema) {
    subSystem += buildOutputSchemaInstruction(outputSchema);
  }

  // ── 将子 Agent 的事件流交给 UI（workspace 注入的端口构建
  // SubAgentPart 并返回 sink；headless → 空操作 sink） ──
  // 对 UI 和 Agent 都使用 agentIdOverride，使 LLM 可见 ID 匹配
  // board/bus 条目（async 模式返回此 ID 给 LLM）。
  const subAgentId = agentIdOverride ?? `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rawSubSink =
    ag._ui.subAgentSpawn?.({ agentId: subAgentId, description, sessionId: ag._uiSessionId }, onProgress) ?? (() => {});
  // 将子 Agent 的事件流分叉到 activity tracker — agent_status 读取它
  // 以报告当前工具调用 + 等待时间（见 subagent-activity.ts）。
  const subSink = wrapSubAgentSink(subAgentId, rawSubSink);

  // 共享 provider，全新会话，不压缩。
  // Phase 3：经父 context child() 派生 — 身份（agentId/parentId/depth）
  // 与继承服务（provider/messageBus/agentStore）来自 ctx，tools/eventSink/
  // execState 为子 Agent 专属覆盖。
  const childCtx = ag._ctx.child({
    agentId: subAgentId,
    isolationId: isolationId ?? undefined,
    services: { tools: subTools, eventSink: subSink, execState: createExecState() },
  });

  const subAgent = new Agent(childCtx, subSystem, {
    temperature: 0.3,
    contextWindow: ag.contextWindow,
    // 附图读取器（multimodal-image-plan B3）：fork 子 Agent 会话可能继承含图
    // 用户消息——与父同读取器，请求期解析面一致。
    imageReader: ag._imageReader ?? undefined,
  });

  // 门禁继承：子 Agent 与主 Agent 同权面跑 preflight（HIGH 风险拦截 + 写前
  // 告警）。此前 setPreflightHooks 仅主 Agent 接线（runtime.ts），子 Agent 的
  // executor（eventBus tool/preflight 监听面）与 dispatchNestedTool 双双静默
  // 免检——fork/fresh 子 Agent 可做破坏性写而零预检（2026-08-30 工具链路审计 C3）。
  const parentPreflight = ag.getPreflightHooks();
  if (parentPreflight) subAgent.setPreflightHooks(parentPreflight);

  // 注册到 TaskBoard + 文件追踪 hook — 仅 async 模式。
  // Sync 模式不需要 board 追踪（结果直接返回，立即合并）。
  if (ag._taskBoard && asyncMode) {
    ag._taskBoard.register({
      agentId: subAgent.id,
      parentAgentId: ag.id,
      description,
      isolationId,
    });
    const subHooks = new HookRegistry();
    // 批 6c：出厂 hook 实现在产物包 hologram/state-hooks，经内核登记表取用
    // （service 类：缺实现 = 装歪了，fail-loud）。
    const stateHooks = activeStateHooksImplementation();
    if (!stateHooks) {
      throw new Error(
        '出厂 hook 实现缺失：hologram/state-hooks 产物未装载（service 类产物不可禁用）——检查产物通道 / loadBuiltinPlugins。',
      );
    }
    subHooks.register(stateHooks.createBoardTrackingHook(subAgent.id, ag._taskBoard));
    subAgent.setHooks(subHooks);
  }

  let subAgentSucceeded = false;
  let result: { text: string; err?: string };
  try {
    // Fork 和 fresh 都使用 run() — fork 有自己的 system prompt + 裁剪后的工具
    await subAgent.run(signal, mode === 'fork' ? prompt : '开始执行。');
    subAgentSucceeded = true;

    // ── 摘要提纯 — 确保子 Agent 交接有用 ──
    // 对低于 300 字符的摘要做单轮续写（"好的，完成了" 的情况）。
    const CONTEXT_LINE_LIMIT = 300;
    const session = subAgent.getSession();
    let lastAssistant = [...session].reverse().find((m) => m.role === 'assistant');
    let summary = lastAssistant?.content || '';

    if (summary.length < CONTEXT_LINE_LIMIT) {
      try {
        const expandPrompt =
          'Please expand your summary: describe exactly what you did, which files you read or modified, what you verified (build/tests), and the outcome. Use at least 200 characters.';
        await subAgent.run(signal, expandPrompt);
        const expandedSession = subAgent.getSession();
        const expanded = [...expandedSession].reverse().find((m) => m.role === 'assistant');
        if (expanded?.content && expanded.content.length > summary.length) {
          lastAssistant = expanded;
          summary = expanded.content;
        }
      } catch (e) {
        // 提纯失败必须留痕 — 空报告 + 静默提纯失败 = 无法区分「没干活」与「干了被丢」
        log.warn('agent', `子 Agent 摘要提纯失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    subAgent.saveState('done').catch(() => {});
    if (summary.trim().length < 50) {
      // 无实质报告的「完成」必须显式标记（A2 事故）——父 Agent 不得
      // 把空报告当正常完成处理，核验产物前不得采信合并状态。
      result = {
        text:
          '⚠️ [报告缺失] 子 Agent 未产出有效报告（可能提前终止或上下文异常），其工作成果无法确认。\n' +
          '请直接核验产物（git log 有无新 commit / 预期文件是否落地），不要用合并状态推断任务完成。\n\n' +
          (summary || '(子 Agent 没有生成回复)'),
      };
    } else {
      result = { text: summary };
    }
  } catch (e) {
    subAgent.saveState('failed').catch(() => {});
    let errReason: string;
    const errMsg = (e instanceof Error ? e.message : '') || String(e);
    if (signal.aborted) {
      errReason = `子 Agent 被中止（超时或手动停止）: ${errMsg || 'aborted'}`;
    } else if ((e as { name?: string }).name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR') {
      errReason = `子 Agent 超时: ${errMsg || 'aborted'}`;
    } else {
      errReason = errMsg || '子 Agent 执行失败（未知原因）';
    }
    result = { text: '', err: errReason };
  } finally {
    ag._ui.subAgentFinished?.(subAgentId, ag._uiSessionId, subAgentSucceeded);
    removeSubAgentActivity(subAgentId);
    // 释放此子 Agent 的文件所有权声明
    ag._fileOwnership?.release(subAgent.id);
  }

  if (asyncMode) {
    // ── Async 模式: 保存 diff 到 board + 通过 bus 通知（不自动合并） ──
    let diffText = '';
    if (isolationId && subAgentSucceeded) {
      try {
        const diffT = ag.tools.get('agent_isolation_diff');
        if (diffT) diffText = await diffT.execute({ agent_id: isolationId });
      } catch {
        /* diff 不可用 */
      }
    }

    if (subAgentSucceeded) {
      ag._taskBoard?.complete(subAgent.id, result.text || '(无摘要)', diffText);
      // Worktree 保留 — 等 agent_merge 时再处理
    } else if (signal.aborted) {
      ag._taskBoard?.stop(subAgent.id);
      // 中止时清理 worktree
      if (isolationId) {
        const discardT = ag.tools.get('agent_isolation_discard');
        await discardT?.execute({ agent_id: isolationId }).catch(() => {});
      }
    } else {
      ag._taskBoard?.fail(subAgent.id, result.err || '子 Agent 执行失败');
      // 失败时清理 worktree
      if (isolationId) {
        const discardT = ag.tools.get('agent_isolation_discard');
        await discardT?.execute({ agent_id: isolationId }).catch(() => {});
      }
    }

    // 通过 bus 通知父 Agent（async 模式下这是**唯一**交付通道——不落 session、不进工具结果）
    if (ag._bus) {
      try {
        ag._bus.send({
          from: subAgent.id,
          to: ag.id,
          type: 'result',
          payload: {
            summary: subAgentSucceeded ? result.text : '',
            success: subAgentSucceeded,
            agentId: subAgent.id,
            error: subAgentSucceeded ? undefined : result.err,
          },
        });
      } catch (e) {
        // ⚠ 投递失败必须留痕（宪法四）：父 Agent 已消亡（卷已关/句柄被换 ⇒ 未注册）或拓扑
        // 拒绝时，这条 result 就没了下文——子 Agent 随即从 bus 注销、无从重投；产出仍在
        // worktree / taskBoard 上，但要人去核验。静默吞掉 = 「任务做完了，父卷永远不知道」。
        log.warn('agent', `子 Agent ${subAgent.id} 的回传投递失败（父 ${ag.id} 不可达？）`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } else {
    // ── Sync 模式: 完成隔离 worktree（串行化） ──
    if (isolationId) {
      const mergeNote = await enqueueIsolationOp(() => finalizeIsolationImpl(ag, isolationId, subAgentSucceeded));
      if (mergeNote) {
        result = { text: (result.text ? result.text + '\n\n' : '') + mergeNote, err: result.err };
      }
    }
    // Sync 模式: 未创建 board 条目（仅 async 模式创建），无需清理
  }

  // 所有完成处理后从 bus 注销子 Agent
  if (ag._bus) {
    ag._bus.unregister(subAgent.id);
  }
  // 隔离降级告警置顶 — 父 Agent 必须最先看到它（sync 直接读 text，
  // async 经 bus result payload 的 summary 上达）。
  if (degradeNote) {
    result = { text: degradeNote + (result.text ? '\n\n' + result.text : ''), err: result.err };
  }
  return result;
}

/** 合并（成功时）或丢弃（失败时）隔离 worktree。
 *  返回可追加到子 Agent 结果的可读备注。 */
export async function finalizeIsolationImpl(ag: SubAgentSpawnHost, agentId: string, success: boolean): Promise<string> {
  const diffT = ag.tools.get('agent_isolation_diff');
  const mergeT = ag.tools.get('agent_isolation_merge');
  const discardT = ag.tools.get('agent_isolation_discard');
  try {
    if (success && mergeT) {
      try {
        const mergeText = await mergeT.execute({ agent_id: agentId });
        await discardT?.execute({ agent_id: agentId }).catch(() => {});
        // 据实报告（A1 事故）：merge 返回「没有变更需要合并」时若报 ✅，
        // 会把「子 Agent 零产出」掩盖成「合并成功」。
        if (mergeText.includes('没有变更需要合并')) {
          return (
            '[隔离合并] ℹ️ 子 Agent 无产出：worktree 中没有任何变更，未向主仓合并任何内容。\n' +
            '请核实该子 Agent 是否真的完成了任务（可能提前终止或未实际写文件），必要时重派。'
          );
        }
        // mergeText 含 commit hash；清理失败时含警告后缀（变更已在主仓，如实转述）
        return `[隔离合并] ✅ ${mergeText}。可用 git_status / git_diff 审阅。`;
      } catch (mergeErr) {
        const errMsg = (mergeErr instanceof Error ? mergeErr.message : '') || String(mergeErr);
        log.warn('agent', `merge conflict for ${agentId}: ${errMsg}`);
        // 抓 diff 供审阅；worktree 保留不丢 — 冲突现场是子 Agent 工作的
        // 唯一完整载体（diff 有 32KB 截断，worktree 是全量）。
        let diffText = '';
        try {
          if (diffT) diffText = await diffT.execute({ agent_id: agentId });
        } catch {
          /* diff 不可用 */
        }
        const clipped = diffText.length > 8000 ? diffText.slice(0, 8000) + '\n…[diff 过长已截断]' : diffText;
        return (
          `[隔离合并] ⚠️ 自动合并失败: ${errMsg}\n` +
          `worktree 已保留（隔离 id: ${agentId}），子 Agent 的完整改动仍在其中：\n` +
          '- 用 agent_isolation_diff 查看完整 diff 后用 edit_file 手动应用需要的部分\n' +
          '- 或解决冲突后调 agent_isolation_merge 重试；确认放弃则 agent_isolation_discard\n\n' +
          (clipped || '(diff 预览获取失败 — worktree 仍保留，可用 agent_isolation_diff 重试)')
        );
      }
    }
    // 子 Agent 失败/中止 — 丢弃 worktree，无需合并。
    await discardT?.execute({ agent_id: agentId }).catch(() => {});
    return '';
  } catch {
    return ''; // 尽力而为 — 清理失败不得中断结果流
  }
}

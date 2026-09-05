// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 流式工具执行器 — 工具调用到达即执行，无需等待整个流结束。
// 在 tool_use 块完成时立即开始执行。
//
// 钩子（GraphContextHook / PreflightHook）在此运行 — 执行前预检，
// 工具后富化 — 这样它们不会被流式执行绕过。
//
// 平台化 Phase 5（D13）：guard/preflight/around 全量经 eventBus 管道
// （AgentEventBus）驱动——executor 不再持有 planGate/hooks/preflightHooks
// 直调参数，统一由事件监听面（attachPlanGate / attachPreflightRegistry /
// attachHookRegistry）接线。eventBus 是唯一管道，没有 legacy 双路径。
//
// CC 参考：StreamingToolExecutor, query.ts:1366-1408

import type { ToolCall } from '../provider/types';
import { type AgentEvent, type AssetEventData, EventKind, type ToolPipelineContext } from './agent-types';
import { generateAssetId } from './asset-kinds';
import { markConfirmEmitted, resolveConfirm } from './confirm-registry';
import type { AgentEventBus } from './events';
import type { Tool, ToolRegistry } from './tool';
import { resolveGuardToolName, retireRedirect } from './tools/domains';
import { truncateToolOutput } from './truncate';

export interface ExecutorToolCall {
  call: ToolCall;
  tool: Tool;
}

interface PendingResult {
  call: ToolCall;
  output: string;
  err?: string;
  truncated: boolean;
}

/**
 * StreamingToolExecutor — 管理流期间的并发工具执行。
 *
 * 在 agent 循环中的用法：
 *   const executor = new StreamingToolExecutor(tools, emitEvent, agentId, signal, eventBus, ownerId);
 *   for await (const chunk of stream) {
 *     if chunk is ToolCall → executor.addTool(chunk.tool_call);
 *     // 每次迭代轮询已完成的结果
 *     for (const result of executor.pollCompleted()) {
 *       results.push(result);
 *     }
 *   }
 *   // 流结束 — 收集剩余
 *   for await (const result of executor.awaitRemaining()) {
 *     results.push(result);
 *   }
 */
export class StreamingToolExecutor {
  /** awaitRemaining 正常路径的总兜底时长——对齐子 Agent 池超时
   *  （coordinator.ts DEFAULT_TIMEOUT_MS 30min）：正常工具（bash/子 Agent/
   *  读文件）最迟都在界内 settle；超界仍 pending = 病态挂起。 */
  private static readonly AWAIT_BACKSTOP_MS = 30 * 60 * 1000;

  private tools: ToolRegistry;
  private emit: (ev: AgentEvent) => void;
  private pending = new Map<string, Promise<PendingResult>>();
  private pendingCalls = new Map<string, ToolCall>();
  private completed: PendingResult[] = [];
  private toolIndex = 0;
  /** 追踪已分发的工具 ID，防止流式重试时重复分发。 */
  private dispatchedIds = new Set<string>();

  private agentId: string | null;
  /** 通知路由身份（bus agent id）— 注入为 args._owner_id，Rust 侧用作后台任务
   *  通知 owner 与 kill 所有权。与 agentId（worktree 隔离 id → _agent_id）分离：
   *  主 Agent / 非隔离子 Agent 无 _agent_id，但同样需要认领自己的后台通知。 */
  private ownerId: string | null;
  /** AbortSignal — 设置后，awaitRemaining 将每个 pending promise 与其竞速。 */
  private signal: AbortSignal | null;
  /** 类型化事件管道（平台化 Phase 5）— 执行阶段全量经 bus 驱动
   *  （guard/preflight/around/result/error），由 events.ts 的 attach* 适配器
   *  把 planGate / hooks / preflightHooks 挂进 bus。eventBus 是唯一管道。 */
  private eventBus: AgentEventBus | null;

  constructor(
    tools: ToolRegistry,
    emitEvent: (ev: AgentEvent) => void,
    agentId?: string | null,
    signal?: AbortSignal | null,
    eventBus?: AgentEventBus | null,
    ownerId?: string | null,
  ) {
    this.tools = tools;
    this.emit = emitEvent;
    this.agentId = agentId ?? null;
    this.ownerId = ownerId ?? null;
    this.signal = signal ?? null;
    this.eventBus = eventBus ?? null;
  }

  /** 从流中添加工具调用。立即开始执行。
   *  跳过已分发的工具 ID（流式重试时可能出现）。 */
  addTool(call: ToolCall): void {
    if (this.dispatchedIds.has(call.id)) return;
    this.dispatchedIds.add(call.id);
    const tool = this.tools.get(call.name);
    const idx = this.toolIndex++;

    // 发出分发事件
    this.emit({
      kind: EventKind.ToolDispatch,
      tool: {
        id: call.id,
        name: call.name,
        args: call.arguments,
        read_only: tool?.readOnly() ?? false,
        partial: false,
      },
    });

    if (!tool) {
      const result: PendingResult = {
        call,
        output: `error: unknown tool "${call.name}"`,
        err: `unknown tool "${call.name}"`,
        truncated: false,
      };
      this.completed.push(result);
      // 未知工具不会到达 executeTool，所以在此发出 ToolResult —
      // 否则子 agent 活动跟踪器会永远将该幻觉调用保持为
      // currentTool（120s 后误报 ⚠️ 疑似卡死），UI 工具
      // 部分无限旋转。
      this.emitPipelineResult(call, null, result, call.name, true);
      return;
    }

    // 旧工具名已收敛：不执行，返回重定向（负反馈驱动模型迁移到领域工具）。
    // 仅拦截模型调用路径；内部委托 / plan 写入直接调旧工具，不走 executor，不受影响。
    if (this.tools.isHidden(call.name)) {
      const redirect = retireRedirect(call.name);
      const hint = redirect ? `已并入 ${redirect}，请直接调用 ${redirect}` : '已淘汰，请查看当前可用工具列表';
      const result: PendingResult = {
        call,
        output: `[已淘汰] ${call.name} ${hint}。不要再使用旧工具名。`,
        truncated: false,
      };
      this.completed.push(result);
      this.emitPipelineResult(call, null, result, call.name, false);
      return;
    }

    // Plan 门禁：plan 激活时在执行层拦截写操作（schema 不切换注册表，
    // DeepSeek 前缀缓存不被 plan 切换击穿；规则见 plan/plan-registry.ts）。
    // 内部 plan 文件写入不走 executor，不受影响。
    // 守卫经 eventBus 的 tool/guard 监听器驱动（attachPlanGate 适配）。
    if (this.eventBus) {
      // 门禁需要解析后的 args（action/filePath）；非法 JSON 放行至
      // executeTool 的 "invalid JSON arguments" 错误路径，保持报错语义。
      let gateArgs: Record<string, unknown> | null = null;
      try {
        gateArgs = JSON.parse(call.arguments || '{}');
      } catch {
        gateArgs = null;
      }
      const blocked = gateArgs ? this.eventBus.runGuard(this.pipelineCtx(call, tool, gateArgs, call.name)) : null;
      if (blocked) {
        const result: PendingResult = {
          call,
          output: blocked,
          truncated: false,
        };
        this.completed.push(result);
        this.emitPipelineResult(call, null, result, call.name, false, gateArgs);
        return;
      }
    }

    // 立即开始执行 — 不等待流结束
    const promise = this.executeTool(call, tool, idx);
    this.pending.set(call.id, promise);
    this.pendingCalls.set(call.id, call);
  }

  /** 等待所有剩余工具执行完成。
   *  同时排出在 addTool 期间同步完成的结果（如未知工具名）。
   *  如设置了中止信号，将每个 pending promise 与其竞速，
   *  使永不解决的工具（如卡住的 Tauri invoke）不会无限阻塞循环。 */
  async awaitRemaining(): Promise<PendingResult[]> {
    // 如已中止：剩余 pending 工具以取消结果落地（发 ToolResult + 返回结果），
    // 而非静默丢弃——否则 UI 卡片永远停在"执行中"，runLoop 还会追加
    // 误导性的 "did not produce a result"（会话 223 事故根因之一）。
    if (this.signal?.aborted) {
      return this._settleCancelled();
    }

    // 正常路径总兜底：排水与兜底定时器竞速。abort 竞速只保护用户停止路径，
    // 管不住正常路径——工具 promise 若永不 settle（Tauri invoke 回包丢失、
    // Rust 命令死锁），没有兜底则 run() 永不 settle → UI 永卡运行态。
    let backstopTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this._drainPending(),
        new Promise<PendingResult[]>((resolve) => {
          backstopTimer = setTimeout(() => resolve(this._settleBackstop()), StreamingToolExecutor.AWAIT_BACKSTOP_MS);
        }),
      ]);
    } finally {
      if (backstopTimer !== undefined) clearTimeout(backstopTimer);
    }
  }

  /** 正常路径排水——逐个等待 pending（带 abort 竞速），返回全部结果。 */
  private async _drainPending(): Promise<PendingResult[]> {
    const remaining: PendingResult[] = [];
    for (const [_id, promise] of this.pending) {
      try {
        const result = this.signal ? await this._raceWithAbort(promise) : await promise;
        remaining.push(result);
      } catch (e) {
        // 中止 — 剩余未完成工具同样以取消结果落地，再停止收集
        if ((e as { name?: string })?.name === 'AbortError' || this.signal?.aborted) {
          remaining.push(...(await this._settleCancelled()));
          break;
        }
        // 其他错误不应发生 — executeTool 捕获所有
      }
    }
    this.pending.clear();
    this.pendingCalls.clear();
    const syncCompleted = [...this.completed];
    this.completed = [];
    for (const r of syncCompleted) {
      this.pending.delete(r.call.id);
    }
    return [...syncCompleted, ...remaining];
  }

  /** 兜底结算：仍 pending 的工具以合成错误结果落地并补发 ToolResult
   *  终结 UI 卡片；迟到的真实结果被丢弃（pending 面已结算）。 */
  private _settleBackstop(): PendingResult[] {
    const out: PendingResult[] = this.completed.splice(0);
    for (const [id, call] of this.pendingCalls) {
      void this.pending.get(id); // 真实结果若迟到即被丢弃
      const minutes = Math.round(StreamingToolExecutor.AWAIT_BACKSTOP_MS / 60_000);
      const result: PendingResult = {
        call,
        output: `[超时兜底] 工具 ${call.name} 超过 ${minutes} 分钟未返回结果（可能丢失回包或后端卡死），本次不再等待。`,
        err: 'await backstop timeout',
        truncated: false,
      };
      this.emitPipelineResult(call, this.tools.get(call.name) ?? null, result, call.name, true);
      out.push(result);
    }
    this.pending.clear();
    this.pendingCalls.clear();
    return out;
  }

  /** 中止时把仍 pending 的工具全部落地为结果：短竞速窗口（100ms）内
   *  已完成的取真实结果，未完成的给"已取消"结果并补发 ToolResult，
   *  保证调用方（runLoop）拿到全部调用对应的结果、UI 卡片全部终结。
   *  仅中止路径调用；正常路径不受影响。 */
  private async _settleCancelled(): Promise<PendingResult[]> {
    const out: PendingResult[] = [];
    const entries = [...this.pending.entries()];
    for (const [id, promise] of entries) {
      const call = this.pendingCalls.get(id);
      let result: PendingResult | null = null;
      try {
        result = await Promise.race([promise, new Promise<null>((res) => setTimeout(() => res(null), 100))]);
      } catch {
        result = null;
      }
      if (!result) {
        if (!call) continue;
        result = {
          call,
          output: '[已取消] 工具执行被中止（agent 运行被中断）。',
          err: 'aborted',
          truncated: false,
        };
      }
      let guardName = call?.name ?? result.call.name;
      try {
        guardName = resolveGuardToolName(this.tools, result.call.name, JSON.parse(result.call.arguments || '{}'));
      } catch {
        // 参数非 JSON — 保持原名
      }
      this.emitPipelineResult(result.call, this.tools.get(result.call.name) ?? null, result, guardName, true);
      out.push(result);
    }
    return out;
  }

  /** 将工具 promise 与中止信号竞速。信号在 promise 完成前触发时
   *  以 AbortError 拒绝。 */
  private _raceWithAbort(promise: Promise<PendingResult>): Promise<PendingResult> {
    const sig = this.signal;
    // 无信号时无从竞速，直接透传（调用面只在信号就绪后才会走到这里）
    if (!sig) return promise;
    if (sig.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise<PendingResult>((resolve, reject) => {
      const onAbort = () => {
        reject(new DOMException('Aborted', 'AbortError'));
        sig.removeEventListener('abort', onAbort);
      };
      sig.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (r) => {
          sig.removeEventListener('abort', onAbort);
          resolve(r);
        },
        (e) => {
          sig.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  /** 丢弃所有待处理执行（如中止时）。 */
  discard(): void {
    this.pending.clear();
    this.pendingCalls.clear();
    this.completed = [];
    this.dispatchedIds.clear();
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** 执行单个工具 — 应用预检 + 工具后钩子。
   *  eventBus 存在时：preflight/around/result/error 经类型化管道驱动（Phase 2），
   *  阶段顺序与旧直调路径逐点镜像（差分测试钉住）。 */
  private async executeTool(call: ToolCall, tool: Tool, _idx: number): Promise<PendingResult> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      const result: PendingResult = {
        call,
        output: `error: invalid JSON arguments: ${call.arguments}`,
        err: 'invalid JSON arguments',
        truncated: false,
      };
      this.emitPipelineResult(call, tool, result, call.name, true);
      return result;
    }

    // 领域工具（fs/shell/git/...）解析回旧工具名，保证门禁 / hooks / 关联按原语义工作
    const guardName = resolveGuardToolName(this.tools, call.name, args);
    const ctx = this.pipelineCtx(call, tool, args, guardName);

    // ── 预检钩子：破坏性写入前警告（经 eventBus 的 tool/preflight 监听面）──
    let preflightWarning: string | null = null;
    if (this.eventBus) {
      preflightWarning = this.eventBus.runPreflight(ctx);
    }

    // ── 架构门禁：HIGH 风险 → 返回阻止结果，不执行 ──
    if (preflightWarning?.includes('风险等级: HIGH')) {
      const forceGate = args._forceGate === true || args._forceGate === 'true';
      if (!forceGate) {
        const blockedResult: PendingResult = {
          call,
          output:
            preflightWarning +
            '\n\n' +
            '🚫 架构门禁已阻止此操作。\n' +
            '使用 trace_impact 查看完整波及范围。\n' +
            '确认安全后，带 _forceGate: true 重试同一工具调用。',
          truncated: false,
        };
        this.emitPipelineResult(call, tool, blockedResult, guardName, false, args);
        return blockedResult;
      }
    }

    // ponytail: 注入 _callId 使子 agent 事件可关联
    if (guardName === 'agent_spawn') {
      args._callId = call.id;
    }

    // 注入 _agent_id 用于隔离 — 告诉 Rust 后端使用哪个工作树
    if (this.agentId) {
      args._agent_id = this.agentId;
    }

    // 注入 _owner_id（bus agent id）— 后台任务通知路由身份（bg:note owner /
    // bash_kill 所有权）。与 _agent_id（worktree 隔离 id）分离：主 Agent 与
    // 非隔离子 Agent 无 _agent_id，但同样需要认领自己的后台任务通知 —
    // 此前 owner 绑定 isolationId，与 bus 注册 id 永不匹配，通知永远无人认领。
    if (this.ownerId) {
      args._owner_id = this.ownerId;
    }

    // 资产通道：预生成 assetId 注入（工具以 args._asset_id 为准；AssetDelta 路由
    // 需要它——工具内部 onProgress 时 executor 已经知道目标资产）
    if (tool.assetChannel === true) {
      const assetId = generateAssetId();
      args._asset_id = assetId;
      // confirm kind：执行前预发卡（终值事件常规通道从工具输出解析，而 confirm
      // 阻塞等用户决议——卡必须先于决议存在，否则死锁）。预发卡标记 UI 通道，
      // 决议回调经事件 onResponse 挂进 BlockPart（重载后历史卡无回调 = 只读态）。
      if (args.kind === 'confirm') {
        markConfirmEmitted(assetId);
        this.emit({
          kind: EventKind.Asset,
          asset: {
            assetId,
            kind: 'confirm',
            presentation: typeof args.presentation === 'string' ? args.presentation : 'form',
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            payload: args.payload,
            onResponse: (r) => resolveConfirm(assetId, r),
          },
        });
      }
    }

    try {
      const _toolStart = performance.now();
      let output = '';

      output = await tool.execute(
        args,
        (chunk) => {
          // 资产通道：onProgress 增量路由为 AssetDelta（append 型资产流式构建）
          if (tool.assetChannel === true) {
            const assetId = typeof args._asset_id === 'string' ? args._asset_id : '';
            const kind = typeof args.kind === 'string' ? args.kind : '';
            this.emit({
              kind: EventKind.AssetDelta,
              assetDelta: { assetId, kind, chunk },
            });
            return;
          }
          this.emit({
            kind: EventKind.ToolProgress,
            tool: {
              id: call.id,
              name: call.name,
              args: call.arguments,
              output: chunk,
              read_only: tool.readOnly(),
            },
          });
        },
        this.signal ?? undefined,
      );

      // 资产通道：终值解析 → Asset 事件（必须在 runAround/前缀拼接之前——
      // 返回的 JSON 不能被富化文本污染；解析失败 = 工具异常路径，错误不静默）
      // confirm 例外：卡已执行前预发（含决议回调），终值解析跳过——若再发会
      // 用无回调的 part 顶掉活卡（applyAssetFinal 按 assetId 原位替换）。
      if (tool.assetChannel === true && args.kind !== 'confirm') {
        const assetEvent = parseAssetEventOutput(output);
        if (assetEvent) {
          this.emit({ kind: EventKind.Asset, asset: assetEvent });
        } else if (output?.trim()) {
          console.warn('[executor] assetChannel tool returned non-asset output', call.name);
        }
      }

      // ── 工具后钩子：用图上下文富化结果（经 eventBus 的 tool/around 监听面）──
      if (this.eventBus) {
        output = await this.eventBus.runAround(ctx, output);
      }

      // 在结果顶部前置预检警告
      if (preflightWarning) {
        output = preflightWarning + '\n\n' + '─'.repeat(40) + '\n\n' + output;
      }

      // ── 截断输出以限制 token 消耗（50KB / 2000 行）──
      const trunc = truncateToolOutput(guardName, output);

      const result: PendingResult = {
        call,
        output: trunc.content,
        truncated: trunc.truncated,
      };
      this.emitPipelineResult(call, tool, result, guardName, false, args);
      return result;
    } catch (e) {
      const eName = (e as { name?: string })?.name;
      const eMsg = (e as { message?: string })?.message;
      if (eName === 'AbortError' || eMsg?.includes('aborted')) {
        throw e; // 不捕获中止 — 交给调用方处理
      }
      const errMsg = eMsg ? eMsg.split('\n')[0] : String(e);
      const result: PendingResult = {
        call,
        output: `error: ${errMsg}`,
        err: errMsg,
        truncated: false,
      };
      this.emitPipelineResult(call, tool, result, guardName, true, args);
      return result;
    }
  }

  /** 管道上下文 — eventBus 各阶段的载荷。 */
  private pipelineCtx(
    call: ToolCall,
    tool: Tool | null,
    args: Record<string, unknown> | null,
    guardName: string,
  ): ToolPipelineContext {
    return { call, tool, args, agentId: this.agentId, signal: this.signal, guardName };
  }

  /** 结果落点统一：eventBus 事件（tool/result 或 tool/error）+ UI sink（EventKind
   *  ToolResult/ToolDispatch 等，模型/UI 可见事件）。两路各自独立：bus 是执行管道
   *  内部机制，sink 是 UI 呈现面，两者都要发。 */
  private emitPipelineResult(
    call: ToolCall,
    tool: Tool | null,
    result: PendingResult,
    guardName: string,
    isError: boolean,
    args: Record<string, unknown> | null = null,
  ): void {
    if (this.eventBus) {
      const ctx = this.pipelineCtx(call, tool, args, guardName);
      if (isError) {
        this.eventBus.emitError(ctx, result.err ?? result.output);
      } else {
        this.eventBus.emitResult(ctx, { output: result.output, truncated: result.truncated, err: result.err ?? null });
      }
    }
    this.emitResult(call, tool, result);
  }

  private emitResult(call: ToolCall, tool: Tool | null, result: PendingResult): void {
    this.emit({
      kind: EventKind.ToolResult,
      tool: {
        id: call.id,
        name: call.name,
        args: call.arguments,
        output: result.output,
        err: result.err,
        read_only: tool?.readOnly() ?? false,
        truncated: result.truncated,
      },
    });
  }
}

/* ── 资产通道终值解析（协议 §2.3——assetChannel 工具返回 JSON 的 AssetEventData 形状）── */

/** 导出面：dispatchNestedTool（agent.ts）的嵌套资产通道复用同一解析。 */
export function parseAssetEventOutput(output: string): AssetEventData | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.assetId !== 'string' || typeof o.kind !== 'string' || !('payload' in o)) return null;
    return {
      assetId: o.assetId,
      kind: o.kind,
      ...(typeof o.presentation === 'string' ? { presentation: o.presentation } : {}),
      ...(typeof o.title === 'string' && o.title.length > 0 ? { title: o.title } : {}),
      payload: o.payload,
    };
  } catch {
    return null;
  }
}

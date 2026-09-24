// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Tool 系统 — Tool 接口 + Registry 注册表 + Hologram 工具定义

// biome-ignore lint/style/noRestrictedImports: agentInvoke 动态方法名分发（工具名运行时确定），无法走 typedRpc
import { rpc } from '../bridge';
import type { ToolSchema } from '../provider/types';
import type { Disposer } from './lifecycle';

// ---- Tool 接口 ----

/** Tool 是 agent 可分发的一个可调用工具。 */
export interface Tool {
  /** 机器名，如 "fragile_modules" */
  name(): string;
  /** 面向模型的描述 */
  description(): string;
  /** 参数的 JSON Schema */
  parameters(): Record<string, unknown>;
  /** 是否只读（可安全并行） */
  readOnly(): boolean;
  /** 领域名（收敛后的可见工具，如 "fs" / "shell" / "agent"） */
  domain?(): string;
  /** 动作列表（领域工具，如 ["read","write","list"]） */
  actions?(): string[];
  /** 只读动作（领域工具在 plan 模式下的白名单） */
  readOnlyActions?(): string[];
  /** 资产通道标记（show_asset/update_asset 等）：工具结果以 Agent 资产事件
   *  （Asset/AssetDelta）广播（协议 docs/archive/agent-asset-blocks.md §2.3）；executor 据此前
   *  路由 onProgress 增量与终值解析，ToolDispatch/ToolResult 照常（管道审计完整）。 */
  assetChannel?: boolean;
  /** 工具附图通道标记（P0a，docs/plans/tool-image-context-plan.md）：工具输出
   *  JSON 里可带 `image`/`images` 引用描述，executor 经 parseToolImageOutput
   *  取出引用挂到本次工具结果的消息上（字节在 {ws}/.lantai/attachments/，
   *  卷里只有引用——INVARIANTS #14）。文本模型/无 image 声明的模型由请求期
   *  投影降级成占位文本，不报错。 */
  imageChannel?: boolean;
  /** 用原始 JSON 参数执行工具。返回结果字符串。
   *  onProgress 是可选回调，用于在执行期间流式输出部分结果。
   *  signal 是可选中止信号 — 目前仅 shell 链路消费（abort 时取消排队/终止进程）。 */
  execute(args: Record<string, unknown>, onProgress?: (chunk: string) => void, signal?: AbortSignal): Promise<string>;
}

// ---- Tool 注册表 ----

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private hiddenNames = new Set<string>();

  /** 注册工具并返回所有权清理器（Phase 1 disposer 契约）。
   *  调用方持有 disposer 即持有该工具的清理责任；幂等。
   *  同名后来被重新注册时，陈旧 disposer 不误删新工具。 */
  register(t: Tool): Disposer {
    if (this.tools.has(t.name())) {
      throw new Error(`ToolRegistry: duplicate tool "${t.name()}"`);
    }
    this.tools.set(t.name(), t);
    const name = t.name();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.tools.get(name) === t) this.unregister(name);
    };
  }

  /** 按名称移除工具。工具不存在时无操作。 */
  unregister(name: string): void {
    this.tools.delete(name);
    this.hiddenNames.delete(name);
  }

  /** 从 schemas()/catalog() 中隐藏工具，但仍保留在 registry 中：
   *  内部代码与测试可直接调用；模型调用隐藏旧名会被 streaming-executor
   *  拦截并返回 [已淘汰] 重定向（retireRedirect），不再静默执行。 */
  hide(name: string): void {
    if (!this.tools.has(name)) return;
    this.hiddenNames.add(name);
  }

  unhide(name: string): void {
    this.hiddenNames.delete(name);
  }

  isHidden(name: string): boolean {
    return this.hiddenNames.has(name);
  }

  /** 注册别名 — 相同实现，向 LLM 显示不同名称。
   *  别名也出现在 schemas() 中，LLM 可用任一名称。 */
  alias(aliasName: string, existingName: string): void {
    const original = this.tools.get(existingName);
    if (!original) throw new Error(`ToolRegistry: cannot alias unknown tool "${existingName}"`);
    if (this.tools.has(aliasName)) return; // 已存在（真实工具或先前的别名）

    // 包装以覆盖 name() — schemas() 必须显示别名而非原名
    const wrapper: Tool = {
      name: () => aliasName,
      description: () => original.description(),
      parameters: () => original.parameters(),
      readOnly: () => original.readOnly(),
      execute: (args, onProgress, signal) => original.execute(args, onProgress, signal),
    };
    this.tools.set(aliasName, wrapper);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 可见工具（未被 hide 的） */
  visibleTools(): Tool[] {
    return this.all().filter((t) => !this.hiddenNames.has(t.name()));
  }

  schemas(): ToolSchema[] {
    return this.visibleTools().map((t) => ({
      name: t.name(),
      description: t.description(),
      parameters: t.parameters(),
    }));
  }

  /** 完整目录（供工具检索器使用） */
  catalog(): Array<{
    name: string;
    description: string;
    domain?: string;
    actions?: string[];
    readOnly: boolean;
  }> {
    return this.visibleTools().map((t) => ({
      name: t.name(),
      description: t.description(),
      domain: t.domain?.(),
      actions: t.actions?.(),
      readOnly: t.readOnly(),
    }));
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  filterReadOnly(): Tool[] {
    return this.all().filter((t) => t.readOnly());
  }

  /** 返回仅包含指定名称工具的新 ToolRegistry（按给定顺序）。
   *  缺失的名称静默跳过。用于构建限定范围的 agent 工具集。 */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const n of names) {
      const t = this.tools.get(n);
      if (t) sub.register(t);
    }
    return sub;
  }
}

// ---- Hologram 图查询工具 (28 tools — 与引擎 MCP 双线对齐) ----
// 硬编码工具 = Agent 的"嘴"：描述经过 LLM 调优，告诉 Agent 什么时候用、用完了下一步调什么。
// MCP = 执行通道：长驻引擎进程 <100ms 响应，挂了降级到进程内 ToolRegistry::dispatch 直调。
// 两者永远对齐——引擎新增 MCP 工具必须同步在此补硬编码定义。

/** 工具执行器：通过 MCP（快速、长驻）或进程内分发（回退）调用工具。
 *  onProgress 是可选回调，用于在执行期间流式输出部分结果。
 *  signal 是可选中止信号 — 目前仅 shell 链路消费。 */
export type ToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
  onProgress?: (chunk: string) => void,
  signal?: AbortSignal,
) => Promise<string>;

/** Agent → backend invoke 包装。恒定注入 isAgent:true，让 Rust 命令走权限路径
 *  (require_read/require_write/git_dispatch) 而非沙箱化的 user-UI 路径。
 *  camelCase 契约: Rust 参数 `is_agent` ↔ JS key `isAgent`。
 *  旧名 `_agent` 因 Tauri 默认 camelCase 重命名永远匹配不上 → is_agent 恒 false
 *  → agent 文件操作被沙箱静默硬拒且不弹 Ask（见 tests/agent-exec.test.ts 守护）。
 *
 * L1 数据上下文：不再注入 _session_id（workspace-session-ownership-rework
 * 2026-08-27）——引擎决议只跟活动工作区（单槽 WorkspaceState）走，
 * 会话 id 不参与引擎路由。
 *
 * rpc Value 化第二步（2026-08-22）：Rust 出口对 JsonValue 形态命令返回真结构化
 * Value（与 rpc.rs rpc_result_shape 表同源）；agentInvoke 是 agent 工具链的
 * string 世界入口，此处对结构化返回回卷 JSON 字符串，全链路（tool execute 返回
 * string 契约 / JSON.parse 消费点 / session 折叠 derivePayload）零改动。 */
export async function agentInvoke<T = string>(name: string, args: Record<string, unknown>): Promise<T> {
  const out = await rpc<unknown>(name, { ...args, isAgent: true });
  return (typeof out === 'string' ? out : JSON.stringify(out)) as T;
}

// ═══════════════════════════════════════════════════════
// Tool 实现已移至 agent/tools/
// ═══════════════════════════════════════════════════════

// ── UI 依赖面契约（2026-09-24 批 4c 前置：类型上收内核）──
// 这三件原定义在 `agent/tools/coding.ts`（一文件载五族），而它们的**消费方住内核**
// （`agent/runtime/agent-builder.ts` 的 onAskUser 回调 · `composition/tool-rows.ts` 的
// 装配 UI 袋 · `state/ask-store.ts` 的提问卡）⇒ 五族各归其产物包之前，先把**类型面**
// 上收为本文件的内核契约（类型面不构成「宿主→插件」反向依赖，值面才是）。
// 语义不变：只是搬家，字段逐字保留。

/** ask_user 单条问题（单问表单或批量 questions 数组元素）。 */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: { label: string; description: string }[];
  multiSelect?: boolean;
}

/** ask_user 工具的 UI 请求 — 由 workspace 注入的回调转发到 UI 总线。
 *  保持 agent 层不 import ui/ 模块。
 *  单问：question/options/multiSelect + callback(answer)；
 *  批量：questions 一次推全部 + callback(answers)（与 questions 对齐，未答/跳过为 null）。
 *  并发会话（2026-08-26）：agentId = 发起 Agent 的 bus id（executor 注入
 *  _owner_id，主 Agent 即 main-<ts>-<rand>）——UI 据此路由到所属卷的提问卡。 */
export interface AskUserRequest {
  id: string;
  agentId?: string;
  question?: string;
  header?: string;
  options?: { label: string; description: string }[];
  multiSelect?: boolean;
  /** 批量多问：完整题目列表，UI 分页收集后一次性返回 */
  questions?: AskUserQuestionItem[];
  callback: (answer: string[] | null | (string[] | null)[]) => void;
}

/** 工具族装配期注入的 UI 袋（当前只有 ask_user 回调）。 */
export interface CodingToolsUI {
  askUser?: (req: AskUserRequest) => void;
}

// 聚合工厂 createCodingTools 已退役（2026-09-24 批 4c-1）：五族各归其产物包，
// 内核不再拼聚合（宿主→插件禁反）。测试用 tests/helpers/coding-tools.ts。
export { createSubAgentTool, type SubAgentSpawner } from './tools/subagent';

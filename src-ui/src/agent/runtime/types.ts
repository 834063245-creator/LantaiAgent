// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Runtime 类型定义 — Agent 层与 UI 层的契约边界
//
// agent/ 层只依赖这些接口，不 import 任何 ui/ 模块。
// ui/ 层实现 RuntimeNotifier，通过 RuntimePort 驱动 Agent。

import type { Message, Provider } from '../../provider/types';
import type { AgentStore } from '../agent-store';
import type { AgentEvent, EventSink } from '../agent-types';
import type { ExecStateInstance } from '../execution-state';
import type { GoalManager } from '../goal-manager';
import type { MemoryManager } from '../memory';
import type { SubAgentPool } from '../subagent-runtime-contract';
import type { TaskBoard } from '../task-board';
import type { ToolRegistry } from '../tool';

// ── Agent 状态 ──

export type AgentStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

// ── Runtime → UI 的通知接口 ──
//
// UI 层实现此接口，Runtime 通过它推送事件。
// 每个 Agent 实例有自己的 notifier，Runtime 负责路由。
// 这是 AgentUINotifier 的演化版本 — 不再绑死 zustand store。

export interface RuntimeNotifier {
  /** Agent 产生了事件（文本流、工具调用、推理等） */
  onAgentEvent(agentId: string, event: AgentEvent): void;
  /** Agent 状态变更（idle/running/paused/...） */
  onAgentStatus(agentId: string, status: AgentStatus): void;
  /** Agent session 被替换（compaction/retract/setSession） */
  onSessionReplaced(agentId: string, messages: Message[]): void;
  /** 子 Agent 启动 — UI 构建渲染状态并返回 EventSink */
  onSubAgentSpawn(info: SubAgentSpawnInfo): EventSink | undefined;
  /** 子 Agent 结束 — UI 收尾渲染状态 */
  onSubAgentFinished(agentId: string, parentAgentId: string, sessionId: number, ok: boolean): void;
  /** 工具执行完成（面板自动刷新） */
  onToolDone(agentId: string, toolName: string, args: Record<string, unknown>, output: string): void;
  /** 循环进度（状态栏） */
  onProgress(agentId: string, step: number, toolName: string): void;
  /** LifecycleManager 告警（泄漏检测、TTL 清理） */
  onLifecycleAlert?(agentId: string, level: 'info' | 'warn' | 'error', text: string): void;
  /** Plan 模式状态变更（UI 更新 plan 模式指示器） */
  onPlanModeChange?(agentId: string, active: boolean, planFilePath: string | null): void;
}

// ── 子 Agent 启动信息 ──

export interface SubAgentSpawnInfo {
  agentId: string;
  parentAgentId: string;
  description: string;
  sessionId: number;
  onProgress?: (chunk: string) => void;
}

// ── Agent 创建配置 ──
//
// 调用者（Workspace 或其他编排者）构造此对象传入 Runtime。
// Runtime 不负责创建 Provider / MemoryManager 等 — 那些由调用者创建。

export interface AgentConfig {
  /** 显式指定 agentId（如 'main'）；不传则自动生成 */
  agentId?: string;
  /** 父 Agent ID（子 Agent 场景） */
  parentId?: string | null;
  /** 子 Agent 深度（0 = 根 Agent） */
  subagentDepth?: number;
  /** 会话 ID — 用于会话级 board 隔离 */
  sessionId?: string;
  /** 项目路径 */
  projectPath: string;
  /** LLM Provider */
  provider: Provider;
  /** 工具注册表（已按权限过滤） */
  tools: ToolRegistry;
  /** 记忆管理器 */
  memoryManager?: MemoryManager;
  /** 目标管理器 */
  goalManager?: GoalManager;
  /** Agent 持久化存储 */
  agentStore?: AgentStore;
  /** 子 Agent 池 */
  subAgentPool?: SubAgentPool;
  /** 子 Agent 派生函数 — 由调用者注入；createAgent 内会用绑定本 Agent 的版本替换
   *  agent_spawn 工具（修复多会话下 spawn 路由到错误 Agent 实例的错位） */
  subAgentSpawner?: import('../subagent-tools-contract').SubAgentSpawner;
  /** 执行状态实例 */
  execState?: ExecStateInstance;
  /** 事件接收器（Agent 事件流） */
  eventSink?: EventSink;
  /** 提示注入类 hooks 总开关（false = 关闭 preflight / state / 构建结果注入；
   *  默认开启。board-tracking 等有实际副作用的 hook 不受影响） */
  hooksEnabled?: boolean;
  /** 隔离 ID（worktree） */
  isolationId?: string;
  /** Agent 选项 */
  temperature?: number;
  contextWindow?: number;
  /** 工具结果批量折叠大小（默认 0 = 禁用；开启需 >0） */
  toolResultWindow?: number;
  /** 协作模式 */
  collaborationMode?: 'normal' | 'plan';
  /** 系统提示词（如果已预构建） */
  systemPrompt?: string;
  /** 会话持久化回调 */
  onSessionPersisted?: (sessionId: string, messages: Message[]) => void;
  /** 附图字节读取器（multimodal-image-plan B3 · D-5）——请求期 ChatImageRef →
   *  **发放载荷**（规整后字节 + 实际编码媒型）。app 层闭包注入（工作区根拼
   *  attachments 路径 → fs_cap read_base64 → wire 规整压进单图发送带）。
   *  ⚡ 2026-09-22：产物从裸 base64 改为 {mediaType, data}——规整可能换编码
   *  （PNG → WebP），媒型沿用 ref 会让 data URI 与字节不符。 */
  imageReader?: import('../request-images').RequestImageReader;
}

// ── AgentContext 入口的装配输入 ──
//
// 非服务的装配素材与调优参数（提示词原料 / 运行参数）。
// 服务与身份一律走 AgentContext；本类型随 Phase 6 blueprint 进一步收敛。
// （图谱素材字段 graphData/graphContext 随图谱退役删除，2026-09-09。）

import type { AgentContext } from '../context';

/** 装配输入字段真源 —— **唯一权威**。类型（AgentAssemblyInputs）与搬运
 *  （pickAssemblyInputs）都从这份清单派生：新增装配素材只在此加一个名字，
 *  类型与搬运两处自动跟上 ⇒ **漏搬在结构上不可能**。
 *
 *  Why 收敛为单一真源（2026-09-19 事故）：同一事实此前手抄三遍——AgentConfig
 *  字段声明 / 本类型字段声明（现已派生化）/ runtime 翻译层的逐键搬运表。
 *  B3（2026-09-09）加 imageReader 时两端都改了、唯独漏了搬运表 ⇒ Agent 持空
 *  读取器 ⇒ 附图静默丢弃、三天无痕（能力戳已声明支持图，故连占位都没有）。
 *  手抄触点 5 → 1（宪法第二条「单一权威源」判定：改这个值要动几个地方 = 1）。
 *  `satisfies` 保证清单里的名字必须真实存在于 AgentConfig——拼错即编译错误。
 *  同款先例：events.ts 的 LOOP_EVENT_NAMES（interface 无运行时键 → 常量镜像
 *  + satisfies 钉编译期同步）。 */
export const ASSEMBLY_INPUT_KEYS = [
  'systemPrompt',
  'hooksEnabled',
  'subAgentSpawner',
  'temperature',
  'contextWindow',
  'toolResultWindow',
  'onSessionPersisted',
  'imageReader',
] as const satisfies readonly (keyof AgentConfig)[];

/** createAgentFromContext 的非服务装配输入 — 与 AgentConfig 的对应字段同语义。
 *  **派生自 ASSEMBLY_INPUT_KEYS，禁在本文件手抄字段名**（手抄 = 又一个漂移点）。 */
export type AgentAssemblyInputs = Pick<AgentConfig, (typeof ASSEMBLY_INPUT_KEYS)[number]>;

/** AgentConfig → AgentAssemblyInputs 的搬运（清单驱动；逐键手抄表已退役）。
 *  只挑清单内的键，undefined 不落键——消费端全部是属性访问 + `??` / falsy
 *  兜底（_assembleAgent 与 blueprint capability 共 9 处，无 `in` / Object.keys
 *  反射），故「键缺失」与「显式 undefined」等价，行为零漂移。
 *  服务与身份字段（provider / tools / execState / …）不进这里——走 AgentContext。 */
export function pickAssemblyInputs(config: AgentConfig): AgentAssemblyInputs {
  const out: AgentAssemblyInputs = {};
  for (const key of ASSEMBLY_INPUT_KEYS) {
    const value = config[key];
    if (value !== undefined) Object.assign(out, { [key]: value });
  }
  return out;
}

// ── Agent 句柄 ──
//
// 调用者通过此接口操作 Agent — 不直接接触 Agent 类。
// 继承 ChatAgentHandle 以保持与 ChatCore 的兼容性。

import type { ChatAgentHandle } from '../chat-agent-handle';

export interface AgentHandle extends ChatAgentHandle {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: AgentStatus;
  /** 销毁并注销此 Agent（幂等）。
   *  句柄即所有权 — 创建者持有句柄，生命周期结束时必须 dispose；
   *  调用后 Agent 从 runtime 注册表、MessageBus、LifecycleManager 中完全移除。 */
  dispose(): void;
  /** 把 board proxies 静态绑定到指定会话（正常只调用一次，重复调用为重绑）。
   *  聊天会话的数字 id 在 createAgent 之后才分配 — 会话层在登记句柄时调用，
   *  此后该 Agent 的 board 写入不再随会话切换改变。 */
  bindSession(sessionId: string): void;
  /** 装配收尾回填本卷 exec 账本 — 转发到 Agent.setExecState（运行态单一权威源：
   *  句柄自起的轮次必须与 UI 读的注册表实例同账，见 chat-session.bindSessionExec）。
   *  **必实现**：这是一层薄转发，少接一跳 = 静默退回孤儿账本（同 run 少接 images
   *  的 B3 事故形态），由 tests/session-exec-single-authority.test.ts 走真链路钉住。 */
  setExecState(exec: ExecStateInstance): void;
}

// ── Agent 概况 ──

export interface AgentSummary {
  id: string;
  parentId: string | null;
  status: AgentStatus;
  description: string;
  subagentDepth: number;
}

// ── UI → Runtime 的调用接口 ──

export interface RuntimePort {
  /** 等待启动恢复完成 — createAgent 前必须 await */
  ready(): Promise<void>;
  /** 创建一个 Agent 实例。返回的句柄拥有该 Agent 的生命周期 —
   *  调用者负责在生命周期结束时 handle.dispose()。
   *  S4-1a：可选 compositionOverride — 会话级组合覆盖（缺省 = runtime
   *  组合，S2 语义零变化）；AgentConfig 字段面冻结不受影响。 */
  createAgent(
    config: AgentConfig,
    compositionOverride?: import('../../composition/roster').ResolvedComposition,
  ): Promise<AgentHandle>;
  /** 从 AgentContext 创建 Agent — Phase 3 收敛入口（agent-core-convergence）。
   *  身份与服务来自 ctx；缺失的会话级基础设施（board proxies / planState /
   *  execState）由 runtime 物化并写回 ctx。与 AgentConfig 入口的等价性由
   *  convergence specs/phase-3 差分钉住。
   *  S4-1a：可选 composition 覆盖——缺省 this._composition（S2 语义零变化）；
   *  会话工厂为「resolved ≠ 工作区默认组合」的会话传会话作用域组合
   *  （工具面/prompt/capability 三域整体换源，cache 引用稳定由
   *  composition/preset-assembly 保证）。 */
  createAgentFromContext(
    ctx: AgentContext,
    inputs?: AgentAssemblyInputs,
    blueprint?: import('../blueprint').AgentBlueprint,
    composition?: import('../../composition/roster').ResolvedComposition,
  ): Promise<AgentHandle>;
  /** 获取 Agent */
  getAgent(agentId: string): AgentHandle | null;
  /** 销毁所有 Agent — 编排者（Workspace）整体停用时调用。
   *  单个 Agent 的销毁只能经 AgentHandle.dispose()（句柄即所有权），
   *  不提供按 id 的外部销毁入口。 */
  disposeAll(): void;
  /** 获取所有 Agent 概况 */
  listAgents(): AgentSummary[];
  /** 获取指定会话的 TaskBoard（UI 面板用） */
  getTaskBoard(sessionId?: string): TaskBoard;
  /** 获取指定会话的 DiscoveryBoard（UI 面板用） */
  getDiscoveryBoard(sessionId?: string): import('../discovery-board').DiscoveryBoard;
  /** 销毁会话级 board 并删除持久化文件 */
  destroySessionBoards(sessionId: string): Promise<void>;
  /** 切换当前活跃会话 — 仅触发该会话 board 的懒加载恢复（供面板查询），
   *  不改写任何 Agent 的 board 绑定（由 AgentHandle.bindSession 静态绑定） */
  setCurrentSession(sessionId: string): void;
}

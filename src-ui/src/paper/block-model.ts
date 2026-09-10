// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/block-model — 走查弹块数据模型（paper-shell 走查弹 · tracer bullet）。
//
// 设计地基：docs/design/一张纸-Agent软件交互形态设计.md §3.1 三层分离——
//   真相层（本文件）/ 渲染层（React 壳）/ 交互层（画布数学）。
// 拍板决定：
//   - D-R1-2：Agent 产出默认 flow（流走），钉住是显式动作 → state 默认 'flow'
//   - D-R1-4：世界坐标数据模型 { id, 类型, state, x/y/w }
//   - D-R2-4：块的世界坐标是唯一真相——x/y 数据模型说了算，纸壳不保留摆放特权
//   - D-R2-3：钉住块 = 活引用而非拷贝（存储挂源，渲染层是视图——走查弹阶段
//     源 = 消息 store 的消息/part 引用，转译层保证同源不拷贝语义字段）
//
// 走查弹纪律：丑得理直气壮——本层不做任何视觉决定，只做结构与几何。

/** 块状态：流内（随对话流走）| 钉住（用户主权，世界坐标说了算） */
import type { PlanApprovalResponse, PlanOptionOutcome } from '../agent/plan/plan-tools';
import type { ChatImageRef } from '../provider/types';
import type { AssistantPart, ToolCallPart } from '../ui/message-model';

export type BlockState = 'flow' | 'pinned';

/** 内置块类型（走查弹 v1 集合：markdown / diff / tool result + 用户与通知） */
export type BuiltinBlockKind =
  | 'user' // 用户消息（右对齐气泡的语义源）
  | 'markdown' // agent 文本（markdown 渲染）
  | 'reasoning' // 推理段（可折叠语义，走查弹平铺）
  | 'diff' // 代码/diff（等宽渲染）
  | 'tool' // 工具调用卡（name/args/status/output）
  | 'code' // 程序执行卡（code_execution 专属：程序体+日志+完成值，P2-A）
  | 'plan' // 计划卡
  | 'toolgroup' // 工具组（同轮并发调用的折叠头，2026-08-30 会话流专项）
  | 'subagent' // 子代理组（2026-09-01 三轴审计 F4：子过程收进组内，不摊平正文流）
  | 'notice' // 系统通知（2026-08-31 收窄为「会话事件」：仅压缩等稀缺大事）
  | 'turn-error'; // 回合错误（2026-08-31 贴黄拆迁：错误贴回合尾的墓碑）

/** 块类型——自 Agent 资产块（WO-3）起开放：内置 8 种强类型保留，
 *  资产 kind（show_asset 的语义 kind）与插件贡献的块类型走开放 string 面。 */
export type BlockKind = BuiltinBlockKind | (string & {});

/** 块内容判别联合：kind 决定 payload 形状（块协议 §3.2 语义声明的走查弹子集） */
export interface BlockPayloads {
  user: {
    text: string;
    /** 附件行（C10 结构化：真机拾遗的真路径文件；渲染层独立小行展示，
     *  不再拼进入文楷书正文） */
    files?: Array<{ path: string; name: string }>;
    /** 附图引用（B4 · D-1/D-9：与 files 并列旁挂——渲染层缩略行独立展示，
     *  字节永不进块/卷，INVARIANTS #14） */
    images?: ChatImageRef[];
  };
  markdown: {
    text: string;
    /** 眉批（P5 夹注旁注化）：配对吸附的夹注全文——渲染正文右侧眉批栏，
     *  测高 = max(正文@全宽, 夹注@侧栏宽)。translate 配对注入，纯可选字段。 */
    sidecar?: { text: string };
  };
  reasoning: { text: string };
  diff: { lang?: string; text: string };
  tool: {
    toolId: string;
    name: string;
    label: string;
    args: string;
    status: 'pending' | 'running' | 'done' | 'error';
    output?: string;
    err?: string;
    /** 起跑时刻（毫秒）——文类签行走秒的计时源；缺省（历史卡片）只显「行」。 */
    startedAt?: number;
  };
  /** 程序执行卡（P2-A）：code_execution 调用的专属形态——三段式
   *  （程序体 / 日志流 / 完成值），与 tool 块的单进单出语义分离。 */
  code: {
    toolId: string;
    /** 模型给的 description（UI 标题语义，对齐 DSH run_code 的卡片标题）。 */
    description: string;
    /** 程序体（async function body）。 */
    code: string;
    status: 'pending' | 'running' | 'done' | 'error';
    /** 合并输出（logs + 完成值 / 错误）——终态一次性写入（code run 无流式进度）。 */
    output?: string;
    err?: string;
    /** 起跑时刻（毫秒）——同 tool 块行走秒。 */
    startedAt?: number;
  };
  plan: {
    planId: string;
    title: string;
    content: string;
    status: string;
    /** 备选方案（exit_plan_mode 的 options 透传）——有则 PlanBody 渲染选择 */
    options?: { label: string; description: string; outcome?: PlanOptionOutcome }[];
    /** 审批回调——PlanPart._callback 透传，PlanBody 按钮触发（纸块活引用语义，施工单 #1） */
    _callback?: (response: PlanApprovalResponse) => void;
  };
  /** 工具组（2026-08-30 会话流专项）：同轮连续工具调用的折叠头。
   *  items 持有活 part 引用（status 流转直接可读）；子卡是独立 tool 块，
   *  折叠/钉住/操作全复用既有机制——组头只负责「一行摘要 + 收起摘除」。 */
  toolgroup: {
    childIds: string[];
    items: ToolCallPart[];
  };
  /** 子代理组（2026-09-01 三轴审计 F4）：SubAgentPart 的组内折叠形态——
   *  组头一行（描述+状态），子 parts 是独立块（reasoning/text/tool…），
   *  折叠/钉住/摘除全复用工具组机制；items 持活 part 引用（流式直读）。 */
  subagent: {
    agentId: string;
    description: string;
    status: 'running' | 'done' | 'error';
    childIds: string[];
    items: AssistantPart[];
  };
  notice: { text: string; level: 'info' | 'warn' | 'error' };
  /** 回合错误（2026-08-31）：assistant 回合终止失败/暂停时的墓碑行——
   *  错误不静默 + 不入会话流：贴在该回合正文块的尾部，跟着回合走。 */
  'turn-error': { text: string; level: 'info' | 'warn' | 'error' };
}

export type BlockPayload = BlockPayloads[keyof BlockPayloads];

/** 资产块元数据（译自 BlockPart——资产身份与表现选择不混进 payload；
 *  渲染层据此走 resolveAssetBlock(kind, presentation)，WO-4 接入）。 */
export interface BlockAssetMeta {
  /** 资产身份——Agent 后续引用/更新的唯一键（会话内唯一） */
  assetId: string;
  /** 表现形态（presentation）——kind 白名单内的表现原语名；空串 = 渲染层回落 default */
  presentation: string;
  /** 面向用户的标题（文类签展示语义，可空） */
  title?: string;
  /** 流式最终化标记（对齐 TextPart.finalised 语义） */
  finalised: boolean;
  /** 确认卡决议回调（confirm kind 实时卡；PlanPart._callback 同构）——瞬态
   *  函数不持久化（快照 JSON 序列化自然丢弃），重载/重拍的历史卡只读态。 */
  _confirm?: (response: import('../agent/agent-types').ConfirmCardResponse) => void;
}

/** 块物件——真相层唯一实体。
 *  x/y/w：世界坐标。flow 块的 x/y 由布局器计算（复算不存），
 *  pinned 块的 x/y 是唯一真相（D-R2-4）。w 对两类块都是布局宽度。
 *  payload：内置 8 种强类型；开放/资产 kind 兜底 unknown（纯 JSON 形状）。 */
export interface Block<K extends BlockKind = BlockKind> {
  id: string;
  kind: K;
  payload: K extends keyof BlockPayloads ? BlockPayloads[K] : unknown;
  /** 资产块元数据（仅 type:block 映射出的块有；非资产块缺省） */
  asset?: BlockAssetMeta;
  state: BlockState;
  /** 钉住时的世界坐标（state==='flow' 时无意义，布局器给流内位置） */
  x: number;
  y: number;
  /** 块宽（世界单位） */
  w: number;
}

/** 源引用——活引用语义（D-R2-3）：块永远知道自己来自哪条消息/哪个 part，
 *  外部对账（消息更新）经此定位，不拷贝内容做第二真相。 */
export interface BlockSource {
  /** 源消息 _id */
  messageId: MessageId;
  /** assistant 消息内的 part 引用（user/notice 为 null） */
  part: object | null;
}

export type MessageId = string;

/** 带源引用的块（转译层产出；走查弹全链路保持活引用） */
export interface SourcedBlock<K extends BlockKind = BlockKind> extends Block<K> {
  source: BlockSource;
}

/* ── 块工厂 ── */

let blockSeq = 0;
/** 走查弹块 id（独立于消息 id——块与消息不是 1:1，一条 assistant 消息可拆多块） */
export function nextBlockId(): string {
  blockSeq += 1;
  return `pb${blockSeq}`;
}

/** 测试复位（生产不调用）。 */
export function resetBlockIdCounterForTests(): void {
  blockSeq = 0;
}

export function createBlock<K extends BlockKind>(
  kind: K,
  payload: K extends keyof BlockPayloads ? BlockPayloads[K] : unknown,
  source: BlockSource,
  opts?: Partial<Pick<Block<K>, 'state' | 'x' | 'y' | 'w' | 'asset'>>,
): SourcedBlock<K> {
  return {
    id: nextBlockId(),
    kind,
    payload,
    state: opts?.state ?? 'flow', // D-R1-2：默认 flow
    x: opts?.x ?? 0,
    y: opts?.y ?? 0,
    w: opts?.w ?? DEFAULT_BLOCK_WIDTH,
    ...(opts?.asset ? { asset: opts.asset } : {}),
    source,
  };
}

/** 流内默认块宽（世界单位；走查弹取观测台聊天列同族宽度） */
export const DEFAULT_BLOCK_WIDTH = 720;

/* ── 湿墨判定（2026-09-06 纸面运行态）── */

/** 正在书写的块 id：块序列中最后一个 source part 仍未干墨
 *  （finalised === false——TextPart 未收尾 / 资产块增量中）的块。
 *  文本拆围栏时多个段共享同一 part，取最末 = 书写头。语义注记：同一模型
 *  响应内文本在工具执行期间仍可续墨（Message 事件收口才 finalise），
 *  故工具在跑时文本段带墨点是诚实信号，不是误报。全干返回 null。 */
export function writingBlockIdOf(blocks: readonly SourcedBlock[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.source.part != null && (b.source.part as { finalised?: unknown }).finalised === false) return b.id;
  }
  return null;
}

/* ── 纯函数操作（交互层只改坐标/状态，不碰渲染）── */

/** 钉住：flow → pinned，落世界坐标。D-R2-1 基础手势的语义核心。 */
export function pinBlock(b: SourcedBlock, x: number, y: number): SourcedBlock {
  if (b.state === 'pinned' && b.x === x && b.y === y) return b;
  return { ...b, state: 'pinned', x, y };
}

/** 收回：pinned → flow。D-R2-2（按钮+确认的语义端；确认交互在壳层）。 */
export function unpinBlock(b: SourcedBlock): SourcedBlock {
  if (b.state === 'flow') return b;
  return { ...b, state: 'flow' };
}

/** 拖动中的 pinned 块坐标更新（每 move 一帧）。 */
export function movePinned(b: SourcedBlock, x: number, y: number): SourcedBlock {
  return { ...b, x, y };
}

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
export type BlockState = 'flow' | 'pinned';

/** 块类型（走查弹 v1 集合：markdown / diff / tool result + 用户与通知） */
export type BlockKind =
  | 'user' // 用户消息（右对齐气泡的语义源）
  | 'markdown' // agent 文本（markdown 渲染）
  | 'reasoning' // 推理段（可折叠语义，走查弹平铺）
  | 'diff' // 代码/diff（等宽渲染）
  | 'tool' // 工具调用卡（name/args/status/output）
  | 'plan' // 计划卡
  | 'notice'; // 系统通知

/** 块内容判别联合：kind 决定 payload 形状（块协议 §3.2 语义声明的走查弹子集） */
export interface BlockPayloads {
  user: { text: string };
  markdown: { text: string };
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
  };
  plan: { planId: string; title: string; content: string; status: string };
  notice: { text: string; level: 'info' | 'warn' | 'error' };
}

export type BlockPayload = BlockPayloads[keyof BlockPayloads];

/** 块物件——真相层唯一实体。
 *  x/y/w：世界坐标。flow 块的 x/y 由布局器计算（复算不存），
 *  pinned 块的 x/y 是唯一真相（D-R2-4）。w 对两类块都是布局宽度。 */
export interface Block<K extends BlockKind = BlockKind> {
  id: string;
  kind: K;
  payload: BlockPayloads[K];
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
  payload: BlockPayloads[K],
  source: BlockSource,
  opts?: Partial<Pick<Block, 'state' | 'x' | 'y' | 'w'>>,
): SourcedBlock<K> {
  return {
    id: nextBlockId(),
    kind,
    payload,
    state: opts?.state ?? 'flow', // D-R1-2：默认 flow
    x: opts?.x ?? 0,
    y: opts?.y ?? 0,
    w: opts?.w ?? DEFAULT_BLOCK_WIDTH,
    source,
  };
}

/** 流内默认块宽（世界单位；走查弹取观测台聊天列同族宽度） */
export const DEFAULT_BLOCK_WIDTH = 720;

/** 拟策内容 → 条目列表（渲染 PlanBody 与测量 measureBlockHeight 共用的单一解析：
 * 逐行剥列表标记（- / * / 1. / 1)），剥后为空的行丢弃。 */
export function parsePlanItems(content: string): string[] {
  return content
    .split('\n')
    .map((s) => s.replace(/^[-*]\s+|^\d+[.)]\s*/, '').trim())
    .filter(Boolean);
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 精确 token 计数 — 用 gpt-tokenizer（cl100k_base，GPT-4、DeepSeek
// 和大多数 OpenAI 兼容模型使用的同一分词器）替代 chars/2.5 启发式。
//
// Anthropic 模型的分词器略有差异，但估算误差 < 8%，
// 在压缩决策的安全范围内。旧的 chars/2.5 启发式偏差达 30-60%。

import { encode } from 'gpt-tokenizer';
import type { Message, ToolSchema } from '../provider/types';

// 每条消息的格式化开销 — 角色标记、分隔符等。
// OpenAI 每条消息约 4 token 的角色格式化。
// 我们用 6 以保守并计入 JSON 序列化框架开销。
const MSG_OVERHEAD = 6;

/** 计数专用编码 — 允许特殊 token 按真实 ID 计入，而非抛错。
 *  会话内容不可控：模型输出 / 工具结果 / 文件内容里可能混入
 *  `<|im_end|>` 之类的字面特殊 token，gpt-tokenizer 默认遇之则抛
 *  `Disallowed special token found`，会把预检 / 压缩 / 轮次统计
 *  整条链炸掉（用户看到的 "错误: Disallowed special token found"）。
 *  兜底：tokenizer 自身异常时退化为 chars/2.5 估算 — 计数永不抛出。 */
function safeCount(text: string): number {
  try {
    return encode(text, { allowedSpecial: 'all' }).length;
  } catch {
    return Math.ceil(text.length / 2.5);
  }
}

/** 逐消息计数记忆（**按对象身份**缓存 —— 消息是不可变的，见下）。
 *
 *  为什么需要：压缩预检在**每一步**都要量整个载荷，而载荷里 99% 的消息上一步就量过
 *  （实测 500 条消息、33.9 万 token 的卷，全量重算是 50–100ms/步，步步如此）。会话越
 *  长越贵，且 pre-flight / maybeCompact / 诊断三处各调一次。
 *
 *  ⚠ **正确性前提 = 消息对象不可变**。这不是新立的规矩，是全仓既有事实：
 *  session 里的消息只在 `_appendMessage` 处**新增**，全仓无一处就地改 `content` /
 *  `reasoning_content` / `tool_calls`（INVARIANTS #14 同源纪律；`replace`/retract
 *  走的是 splice 换元素，不是改对象）。谁哪天要就地改，必须先在此处失效缓存——
 *  用 WeakMap 而非 Map 是因为消息被替换后会自然回收，不会把旧消息钉在内存里。
 *
 *  缓存的是**整条消息**的计数（不是逐字段）：一次命中就省掉全部分词，粒度最粗、
 *  失效面最小。 */
const messageTokens = new WeakMap<Message, number>();

/** 使用 cl100k_base 分词器计算单条消息的 token 数（结果按对象身份记忆）。 */
export function countMessage(m: Message): number {
  const hit = messageTokens.get(m);
  if (hit !== undefined) return hit;
  const total = countMessageUncached(m);
  messageTokens.set(m, total);
  return total;
}

function countMessageUncached(m: Message): number {
  let total = MSG_OVERHEAD;

  if (typeof m.content === 'string') {
    total += safeCount(m.content);
  }
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      total += safeCount(tc.name ?? '');
      total += safeCount(tc.arguments ?? '');
    }
  }
  if (m.reasoning_content) {
    total += safeCount(m.reasoning_content);
  }
  if (m.name) {
    total += safeCount(m.name);
  }

  return total;
}

/** 计算消息数组的 token 数。 */
export function countMessages(msgs: readonly Message[]): number {
  let total = 0;
  for (const m of msgs) total += countMessage(m);
  return total;
}

/** 计算原始文本字符串的 token 数（如临时提醒）。 */
export function countText(text: string): number {
  return safeCount(text);
}

/** 计算多条原始文本字符串的 token 数。 */
export function countTexts(texts: readonly string[]): number {
  let total = 0;
  for (const t of texts) total += countText(t);
  return total;
}

/** 计算工具 schema 定义的 token 数。
 *  这些作为 JSON 发送给 API 并消耗 prompt token。 */
export function countToolSchemas(schemas: readonly ToolSchema[]): number {
  let total = 0;
  for (const s of schemas) total += countOneToolSchema(s);
  return total;
}

/** 单条工具 schema 的分词数。
 *
 *  ⚠ **不要在这里做逐条缓存**（2026-11-17 台架实测否决过一次）：`ToolRegistry.schemas()`
 *  每次调用都 `map` 出**全新对象**（tool.ts），所以按对象身份缓存恒不命中；按 name 缓存
 *  又会在「同名不同定义」时返回旧值。真正的重复不在单条，而在**整批**——
 *  见 `agent.ts` 的 `_schemaTokens`（按选择器锁存结果缓存整批，装配换代即失效）。 */
function countOneToolSchema(s: ToolSchema): number {
  let total = safeCount(s.name);
  total += safeCount(s.description);
  try {
    const params = typeof s.parameters === 'string' ? s.parameters : JSON.stringify(s.parameters);
    total += safeCount(params);
  } catch {
    // 忽略不可字符串化的参数
  }
  return total;
}

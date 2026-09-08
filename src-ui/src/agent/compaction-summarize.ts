// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 上下文压缩 — 分块 / 机械摘要 / prompt 构建。从 agent.ts 机械搬移（11c），零逻辑改动。
// 消费方：agent.ts 的 summarizeRegion / mergePartials / callSummaryLLM 管线。

import type { Message } from '../provider/types';
import { extractFilePath, WRITE_TOOLS } from './file-ownership';
import { parseFilePathArg } from './loop-helpers';
import { countMessage, countText } from './token-counter';
import type { ToolRegistry } from './tool';
import { resolveGuardToolName } from './tools/domains';

/** 摘要调用的输出预算（token）— 固定上界。配合 chunkCap 保证
 *  每次调用 输入+输出 严格小于摘要模型窗口（"永不塞爆"的硬上界）。
 *  2026-09 迭代：2048 → 4096 — 摘要内容（结构化简报 + 合并）需要更高
 *  上限才能在一次压缩里承载完整任务恢复信息，避免多段合并被截断。 */
export const SUMMARY_OUTPUT_BUDGET = 4096;
/** prompt 预算：摘要指令 + 合并指令 + priorSummary 预留。 */
export const SUMMARY_PROMPT_BUDGET = 4000;
/** 摘要模型最低窗口 — 低于此值切块会碎到失去意义，直接无参选资格。 */
export const SUMMARY_MIN_WINDOW = 64_000;
/** 单次调用至少要的输入预算 — 不足说明窗口不可行，走纯机械摘要。 */
export const SUMMARY_MIN_INPUT = 4000;
/** LLM 处理的最多块数 — 超出时最老的块走机械提取（成本/时延封顶）。 */
export const SUMMARY_MAX_LLM_CHUNKS = 8;

/** 摘要 prompt — 单块时 priorSummary 直接嵌入（与旧行为一致）；
 *  分块时告知 LLM 这是第几段，只总结本段。 */
export function buildSummaryPrompt(priorSummary: string | null, chunkInfo?: { index: number; total: number }): string {
  const mergeInstruction = priorSummary
    ? `\n以下是在本次压缩之前生成的会话背景简报。新消息可能覆盖或补充其中的内容——合并时以新消息为准，未变的旧事实直接保留：\n\n<previous-summary>\n${priorSummary}\n</previous-summary>`
    : '';
  const chunkInstruction = chunkInfo
    ? `\n注意：以下是完整历史的第 ${chunkInfo.index}/${chunkInfo.total} 段（按时间顺序）。只总结本段内容，不要推测其他分段。`
    : '';

  return `你是对话压缩器。把以下编码 Agent 的对话历史浓缩为一份简报。Agent 只会保留你的摘要（原始消息会被丢弃），因此必须能从摘要中恢复任务。

按这些标题写（没有内容的标题可以省略）：

## 目标
用户的需求和意图，尽量用用户的措辞。包含明确的约束和偏好。

## 决策与理由
已做出的关键选择及原因——避免被推翻或重复争论。

## 文件与代码
读取或修改过的文件，包含具体事实：签名、位置、数据形状、应用的具体编辑。

## 命令与结果
执行过的命令（构建、测试、git）及结果——哪些通过、哪些失败、错误信息。

## 错误与修复
遇到的问题及解决方式（或未解决），避免走重复的弯路。

## 待办与下一步
仍在进行中或未开始的工作，以及最具体的下一个行动。

规则：简洁——用要点和片段而非散文。准确保留标识符、路径和数字。不编造任何不存在于消息中的内容。${chunkInstruction}${mergeInstruction}`;
}

/** 合并 prompt — 把多份分段简报（可能含 previous-summary）合并为一份。 */
export function buildMergePrompt(): string {
  return `你是对话压缩器。以下是同一编码 Agent 会话历史的多份分段简报（按时间顺序排列，可能包含一份 <previous-summary> 背景简报）。把它们合并成一份连贯简报——Agent 将仅凭它恢复任务。

按这些标题写（没有内容的标题可以省略）：

## 目标
用户的需求和意图，尽量用用户的措辞。包含明确的约束和偏好。

## 决策与理由
已做出的关键选择及原因——避免被推翻或重复争论。

## 文件与代码
读取或修改过的文件，包含具体事实：签名、位置、数据形状、应用的具体编辑。

## 命令与结果
执行过的命令（构建、测试、git）及结果——哪些通过、哪些失败、错误信息。

## 错误与修复
遇到的问题及解决方式（或未解决），避免走重复的弯路。

## 待办与下一步
仍在进行中或未开始的工作，以及最具体的下一个行动。

规则：相同事实去重；事实冲突时以靠后的分段为准；未变的旧事实直接保留。简洁——用要点和片段而非散文。准确保留标识符、路径和数字。不编造任何不存在于输入中的内容。`;
}

export function renderTranscript(msgs: Message[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    switch (m.role) {
      case 'user':
        lines.push(`[用户]\n${m.content || ''}`);
        // B3（multimodal-image-plan D-12）：摘要模型看不到图——折叠区内的
        // 附图以确定性事实行交代（数量/尺寸），字节永不进摘要转录。
        if (m.images !== undefined && m.images.length > 0) {
          const dims = m.images.map((ref) => `${ref.width}×${ref.height}`).join('、');
          lines.push(`[本消息含 ${m.images.length} 张附图已折叠（${dims}）——图片内容不在摘要范围]`);
        }
        lines.push('');
        break;
      case 'assistant': {
        if (m.content) lines.push(`[助手]\n${m.content}`);
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            lines.push(`[助手调用 ${tc.name}] ${tc.arguments}`);
          }
        }
        lines.push('');
        break;
      }
      case 'tool':
        lines.push(`[工具 ${m.name || ''} 结果]\n${m.content || ''}\n`);
        break;
      case 'system':
        lines.push(`[系统]\n${m.content || ''}\n`);
        break;
      default:
        lines.push(`[${m.role}]\n${m.content || ''}\n`);
        break;
    }
  }
  return lines.join('\n');
}

/** 把消息区域按 token 上限切成块（map-reduce 的 map 输入）。
 *  单条消息超限时先"炸开"为转录片段再切 — 任何消息形状
 *  都能被装进 capTokens 内，这是"永不塞爆"的第一道保证。 */
export function chunkMessages(msgs: Message[], capTokens: number): Message[][] {
  const exploded: Message[] = [];
  for (const m of msgs) {
    if (countMessage(m) <= capTokens) {
      exploded.push(m);
    } else {
      exploded.push(...explodeTranscript(m, capTokens));
    }
  }
  const chunks: Message[][] = [];
  let cur: Message[] = [];
  let curTokens = 0;
  for (const m of exploded) {
    const t = countMessage(m);
    if (cur.length > 0 && curTokens + t > capTokens) {
      chunks.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(m);
    curTokens += t;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** 把超限单条消息炸开为若干 ≤ capTokens 的转录片段消息。
 *  按行累积（精确 countText）；单行仍超限时按字符硬切，
 *  步长 capTokens/2 字符 — 任何语言都低于 token 上界。 */
function explodeTranscript(m: Message, capTokens: number): Message[] {
  const out: Message[] = [];
  let cur = '';
  const pushFrag = (text: string) => out.push({ role: 'user' as const, content: `[历史转录片段]\n${text}` });
  for (const line of renderTranscript([m]).split('\n')) {
    if (countText(line) > capTokens) {
      if (cur) {
        pushFrag(cur);
        cur = '';
      }
      const step = Math.max(500, Math.floor(capTokens / 2));
      for (let i = 0; i < line.length; i += step) pushFrag(line.slice(i, i + step));
      continue;
    }
    if (cur && countText(cur + '\n' + line) > capTokens) {
      pushFrag(cur);
      cur = '';
    }
    cur = cur ? cur + '\n' + line : line;
  }
  if (cur) pushFrag(cur);
  return out;
}

/** 机械摘要 — 不依赖任何 LLM/key/窗口的本地兜底。
 *  从消息里机械提取结构化简报：用户目标、文件读写、命令与退出码、
 *  错误、工具使用统计、最近助手结论。瞬时、零 token、永不超时。
 *  质量低于 LLM 摘要，但保证压缩管线在任何失败下都能落地。 */
export function digestMessages(msgs: Message[], registry?: ToolRegistry): string {
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const commands: string[] = [];
  const errors: string[] = [];
  const toolCounts = new Map<string, number>();
  const callInfo = new Map<string, { name: string; args: Record<string, unknown> }>();
  const SHELL_TOOLS = new Set(['run_shell', 'exec_command']);
  let firstUser = '';
  let lastUser = '';
  let lastAssistant = '';

  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
  const firstLine = (s: string) => s.split('\n').find((l) => l.trim()) ?? '';

  for (const m of msgs) {
    if (m.role === 'user' && m.content && !m.content.startsWith('<compacted-context>')) {
      if (!firstUser) firstUser = m.content;
      lastUser = m.content;
    }
    if (m.role === 'assistant') {
      if (m.content) lastAssistant = m.content;
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || '{}');
        } catch {}
        // 领域调用（fs/shell/...）解析回旧语义名 — 机械摘要按旧名统计
        const guardName = registry ? resolveGuardToolName(registry, tc.name, args) : tc.name;
        toolCounts.set(guardName, (toolCounts.get(guardName) ?? 0) + 1);
        callInfo.set(tc.id, { name: guardName, args });
        if (guardName === 'read_file_content' || guardName === 'read_file') {
          const fp = parseFilePathArg(tc.arguments);
          if (fp) filesRead.add(fp);
        } else if (WRITE_TOOLS.has(guardName)) {
          const fp = extractFilePath(guardName, args);
          if (fp) filesWritten.add(fp);
        } else if (SHELL_TOOLS.has(guardName)) {
          const cmd = String(args.command || args.cmd || '').trim();
          // 相邻去重 — 重试场景下同一命令常连续出现
          if (cmd && commands[commands.length - 1] !== cmd) commands.push(cmd);
        }
      }
    }
    if (m.role === 'tool') {
      const info = m.tool_call_id ? callInfo.get(m.tool_call_id) : undefined;
      const content = m.content || '';
      if (info && SHELL_TOOLS.has(info.name)) {
        const exitMatch = /\[exit (-?\d+)\]/.exec(content.slice(0, 40));
        if (exitMatch && exitMatch[1] !== '0' && errors.length < 10) {
          const cmd = String(info.args.command || info.args.cmd || '');
          errors.push(`\`${trunc(cmd, 80)}\` → exit ${exitMatch[1]}: ${trunc(firstLine(content), 160)}`);
        }
      } else if (errors.length < 10 && /错误|失败|error[: ]|failed|panic/i.test(content.slice(0, 300))) {
        errors.push(`${info?.name ?? 'tool'}: ${trunc(firstLine(content), 160)}`);
      }
    }
  }

  const sections: string[] = [];
  if (firstUser) {
    let goal = `## 目标（用户原话摘录）\n${trunc(firstUser, 400)}`;
    if (lastUser && lastUser !== firstUser) goal += `\n\n最近要求: ${trunc(lastUser, 300)}`;
    sections.push(goal);
  }
  if (filesRead.size > 0 || filesWritten.size > 0) {
    const lines: string[] = ['## 文件操作'];
    if (filesRead.size > 0) lines.push(`- 读取: ${[...filesRead].slice(0, 20).join(', ')}`);
    if (filesWritten.size > 0) lines.push(`- 修改: ${[...filesWritten].slice(0, 20).join(', ')}`);
    sections.push(lines.join('\n'));
  }
  if (commands.length > 0) {
    sections.push(
      `## 命令执行\n${commands
        .slice(0, 15)
        .map((c) => `- \`${trunc(c, 100)}\``)
        .join('\n')}`,
    );
  }
  if (errors.length > 0) {
    sections.push(`## 错误\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
  if (toolCounts.size > 0) {
    const top = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, n]) => `${name} ×${n}`)
      .join(', ');
    sections.push(`## 工具使用\n${top}`);
  }
  if (lastAssistant) {
    sections.push(`## 最近助手结论\n${trunc(lastAssistant, 600)}`);
  }
  return sections.length > 0 ? sections.join('\n\n') : '（无有效内容）';
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/translate — 宿主侧块转译 v1（走查弹核心件）。
//
// 拍板决定（paper-shell README V3a「宿主侧块转译」+ R1 staging）：
//   现有 chat-stream（markdown + 工具事件）→ 语义块，**agent 层零改动**。
//   转译是纯函数：ChatMessage[] → SourcedBlock[]，输入是 ui/message-model
//   的既有类型，输出是 paper/block-model 的块。不做反向写回（走查弹只读消费 +
//   输入条转发 core.sendMessage，会话真相仍在消息 store——活引用语义 D-R2-3）。
//
// 转译规则（一条消息 → 0..n 块）：
//   UserMessage        → 1 块 user
//   NoticeMessage      → 1 块 notice
//   AssistantMessage   → parts 顺序映射：
//     reasoning → 1 块 reasoning
//     text      → 1 块 markdown
//     tool      → 1 块 tool（status/output 直映）
//     plan      → 1 块 plan
//     subagent  → 递归展开（其 parts 同上映射；走查弹不建嵌套组）
// part → 块保持引用（source.part = part 对象）——外部改动可经消息
// version 信号触发重转译，块 id 按消息 id+part 索引稳定重建。

import type { AssistantMessage, ChatMessage, UserMessage } from '../ui/message-model';
import type { SourcedBlock } from './block-model';
import { createBlock, DEFAULT_BLOCK_WIDTH } from './block-model';

/** 稳定块 id：同一消息同一 part 在重转译后得到同一 id（React key 稳定 +
 *  钉住状态可跨转译保持——pinned 块按 id 续命）。 */
function partBlockId(messageId: string, partIndex: number): string {
  return `pb:${messageId}:${partIndex}`;
}

/** 用户块稍窄（视觉语义：对话流里用户话轮占次要宽度——布局层消费） */
export const USER_BLOCK_WIDTH = 560;

/** 夹注收窄至正文列宽约 86%（spec §1：夹注缩进列边——布局层居中消费） */
export const REASONING_BLOCK_WIDTH = Math.round(DEFAULT_BLOCK_WIDTH * 0.86);

interface TranslateOpts {
  /** 钉住状态续命表：id → pinned 坐标（重转译时保持已钉块不回flow） */
  pinnedPositions?: ReadonlyMap<string, { x: number; y: number }>;
}

/** 转译主函数（纯函数，可无头测试）。 */
export function translateMessages(messages: readonly ChatMessage[], opts?: TranslateOpts): SourcedBlock[] {
  const out: SourcedBlock[] = [];
  const pinned = opts?.pinnedPositions;

  const adopt = (b: SourcedBlock): void => {
    const pos = pinned?.get(b.id);
    if (pos) {
      out.push({ ...b, state: 'pinned', x: pos.x, y: pos.y });
    } else {
      out.push(b);
    }
  };

  for (const msg of messages) {
    if (msg.role === 'user') {
      adopt(translateUser(msg));
    } else if (msg.role === 'notice') {
      const b = createBlock('notice', { text: msg.text, level: msg.level }, { messageId: msg._id, part: null });
      out.push(b);
    } else {
      translateAssistantParts(msg, out, pinned);
    }
  }
  return out;
}

function translateUser(msg: UserMessage): SourcedBlock {
  // 附件不再拼进入文正文（旧病灶：等宽路径挤进楷书朱砂批注体，字体语义全乱）。
  // 结构化进 payload.files，渲染层独立小行（石青 mono）展示。
  const files = msg.files?.length ? msg.files.map((f) => ({ path: f.path, name: f.name })) : undefined;
  return {
    ...createBlock('user', { text: msg.text, ...(files ? { files } : {}) }, { messageId: msg._id, part: null }),
    id: `pb:${msg._id}`, // 用户消息 1:1，id 直接挂消息 id
    w: USER_BLOCK_WIDTH,
  };
}

/* ── 围栏拆分：text part → markdown / diff 块序列 ──
 * 走查弹定义（R1）：灰框块 = markdown + diff + tool result。真实会话里 diff
 * 以 markdown 围栏（```diff）出现在 text part 内——转译层把它拆出来。
 * 流式友好：围栏未闭合（token 还在到达）时按已闭合处理（差分块持续生长）。
 * id 方案：无围栏的纯文本保持 pb:{msg}:{i}（兼容）；拆分后 text 段
 * pb:{msg}:{i}t{n}、围栏段 pb:{msg}:{i}f{n}——围栏标记位置稳定则 id 稳定。 */

interface TextSegment {
  kind: 'markdown' | 'diff';
  text: string;
  lang?: string;
}

export function splitFencedSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  // 行首 ``` 开围栏；语言标记跟在后（如 ```diff / ```ts）
  const fenceRe = /^```([^\n]*)$/;
  const lines = text.split('\n');
  let i = 0;
  let buf: string[] = [];
  const flushText = (): void => {
    // 去掉围栏前后的空行（块边界干净）
    while (buf.length > 0 && buf[0].trim() === '') buf.shift();
    while (buf.length > 0 && buf[buf.length - 1].trim() === '') buf.pop();
    if (buf.length > 0) segments.push({ kind: 'markdown', text: buf.join('\n') });
    buf = [];
  };
  while (i < lines.length) {
    const m = lines[i].match(fenceRe);
    if (m) {
      const lang = m[1].trim() || undefined;
      const code: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (fenceRe.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        code.push(lines[i]);
        i++;
      }
      void closed; // 未闭合 = 流式中：照常产出（块内容持续增长）
      flushText();
      segments.push({ kind: 'diff', text: code.join('\n'), lang });
    } else {
      buf.push(lines[i]);
      i++;
    }
  }
  flushText();
  return segments;
}

function emitTextWithFences(
  messageId: string,
  text: string,
  partIndex: number,
  part: object,
  out: SourcedBlock[],
  pinned: ReadonlyMap<string, { x: number; y: number }> | undefined,
): void {
  const segs = splitFencedSegments(text);
  if (segs.length === 1 && segs[0].kind === 'markdown') {
    // 纯文本：保持 1:1 映射与稳定 id（兼容既有行为）
    const id = partBlockId(messageId, partIndex);
    const base = {
      ...createBlock('markdown', { text: segs[0].text }, { messageId, part }),
      id,
      w: DEFAULT_BLOCK_WIDTH,
    };
    const pos = pinned?.get(id);
    out.push(pos ? { ...base, state: 'pinned', x: pos.x, y: pos.y } : base);
    return;
  }
  // 拆分序列：t{n} 文本段 / f{n} 围栏段
  let tN = 0;
  let fN = 0;
  for (const seg of segs) {
    const id =
      seg.kind === 'markdown' ? `pb:${messageId}:${partIndex}t${tN++}` : `pb:${messageId}:${partIndex}f${fN++}`;
    const base = {
      ...createBlock(seg.kind, seg.kind === 'diff' ? { lang: seg.lang, text: seg.text } : { text: seg.text }, {
        messageId,
        part,
      }),
      id,
      w: seg.kind === 'diff' ? 640 : DEFAULT_BLOCK_WIDTH,
    };
    const pos = pinned?.get(id);
    out.push(pos ? { ...base, state: 'pinned', x: pos.x, y: pos.y } : base);
  }
}

function translateAssistantParts(
  msg: AssistantMessage,
  out: SourcedBlock[],
  pinned: ReadonlyMap<string, { x: number; y: number }> | undefined,
): void {
  const emit = (
    kind: SourcedBlock['kind'],
    payload: SourcedBlock['payload'],
    partIndex: number,
    part: object,
    w?: number,
  ): void => {
    const id = partBlockId(msg._id, partIndex);
    const base = {
      ...createBlock(kind, payload as never, { messageId: msg._id, part }),
      id,
      w: w ?? DEFAULT_BLOCK_WIDTH,
    };
    const pos = pinned?.get(id);
    out.push(pos ? { ...base, state: 'pinned', x: pos.x, y: pos.y } : base);
  };

  msg.parts.forEach((part, idx) => {
    switch (part.type) {
      case 'reasoning':
        emit('reasoning', { text: part.text }, idx, part, REASONING_BLOCK_WIDTH);
        break;
      case 'text':
        emitTextWithFences(msg._id, part.text, idx, part, out, pinned);
        break;
      case 'tool': {
        // code_execution 专属块（P2-A 拍板）：三段式形态与 tool 单进单出分离；
        // 判据 name === 'code_execution'（常驻名，不进 DOMAIN_SPECS）。
        if (part.name === 'code_execution') {
          let code = '';
          let description = part.label;
          try {
            const parsed = JSON.parse(part.args || '{}') as { code?: string; description?: string };
            if (typeof parsed.code === 'string') code = parsed.code;
            if (typeof parsed.description === 'string') description = parsed.description;
          } catch {
            /* args 未流完/非 JSON：保持空程序体（终态会被 ToolResult 覆盖） */
          }
          emit(
            'code',
            {
              toolId: part.toolId,
              description,
              code,
              status: part.status,
              output: part.output,
              err: part.err,
            },
            idx,
            part,
            640,
          );
          break;
        }
        emit(
          'tool',
          {
            toolId: part.toolId,
            name: part.name,
            label: part.label,
            args: part.args,
            status: part.status,
            output: part.output,
            err: part.err,
          },
          idx,
          part,
          640,
        );
        break;
      }
      case 'plan':
        emit('plan', { planId: part.planId, title: '计划', content: part.content, status: part.status }, idx, part);
        break;
      case 'subagent':
        // 走查弹：拍平（不建嵌套组）。子 agent parts 顺序展开，
        // id 带子前缀防与父消息 part 撞号。
        part.parts.forEach((sp, sIdx) => {
          const subId = `pb:${msg._id}:${idx}s${sIdx}`;
          const make = (): SourcedBlock => {
            switch (sp.type) {
              case 'reasoning':
                return {
                  ...createBlock('reasoning', { text: sp.text }, { messageId: msg._id, part: sp }),
                  id: subId,
                  w: REASONING_BLOCK_WIDTH,
                };
              case 'text':
                return { ...createBlock('markdown', { text: sp.text }, { messageId: msg._id, part: sp }), id: subId };
              case 'tool':
                // code_execution 专属块同父路径（子 Agent parts 同构）
                if (sp.name === 'code_execution') {
                  let subCode = '';
                  let subDesc = sp.label;
                  try {
                    const pp = JSON.parse(sp.args || '{}') as { code?: string; description?: string };
                    if (typeof pp.code === 'string') subCode = pp.code;
                    if (typeof pp.description === 'string') subDesc = pp.description;
                  } catch {
                    /* 未流完 */
                  }
                  return {
                    ...createBlock(
                      'code',
                      {
                        toolId: sp.toolId,
                        description: `[子] ${subDesc}`,
                        code: subCode,
                        status: sp.status,
                        output: sp.output,
                        err: sp.err,
                      },
                      { messageId: msg._id, part: sp },
                    ),
                    id: subId,
                    w: 640,
                  };
                }
                return {
                  ...createBlock(
                    'tool',
                    {
                      toolId: sp.toolId,
                      name: sp.name,
                      label: `[子] ${sp.label}`,
                      args: sp.args,
                      status: sp.status,
                      output: sp.output,
                      err: sp.err,
                    },
                    { messageId: msg._id, part: sp },
                  ),
                  id: subId,
                  w: 640,
                };
              case 'plan':
                return {
                  ...createBlock(
                    'plan',
                    { planId: sp.planId, title: '计划', content: sp.content, status: sp.status },
                    { messageId: msg._id, part: sp },
                  ),
                  id: subId,
                };
              default:
                return { ...createBlock('markdown', { text: '' }, { messageId: msg._id, part: sp }), id: subId };
            }
          };
          const b = make();
          const pos = pinned?.get(subId);
          out.push(pos ? { ...b, state: 'pinned', x: pos.x, y: pos.y } : b);
        });
        break;
      default:
        break;
    }
  });
}

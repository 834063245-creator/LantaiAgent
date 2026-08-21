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
  const files = msg.files?.length ? '\n\n' + msg.files.map((f) => `📎 ${f.name} (${f.path})`).join('\n') : '';
  return {
    ...createBlock('user', { text: msg.text + files }, { messageId: msg._id, part: null }),
    id: `pb:${msg._id}`, // 用户消息 1:1，id 直接挂消息 id
    w: USER_BLOCK_WIDTH,
  };
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
        emit('reasoning', { text: part.text }, idx, part);
        break;
      case 'text':
        emit('markdown', { text: part.text }, idx, part);
        break;
      case 'tool': {
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
                return { ...createBlock('reasoning', { text: sp.text }, { messageId: msg._id, part: sp }), id: subId };
              case 'text':
                return { ...createBlock('markdown', { text: sp.text }, { messageId: msg._id, part: sp }), id: subId };
              case 'tool':
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

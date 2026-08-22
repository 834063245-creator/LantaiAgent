// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ── 来文圈点解析（C7）──
//
// 语法约定：来文里的【关键词】在纸面渲染为朱砂圈点（.pp-circled），括号被消费。
// 设计要点：
//   - 零数据契约：UserMessage / session-log / block-model 均不加字段——【】就是
//     text 的组成部分，解析只发生在渲染层，历史消息零影响；
//   - 语义铁律：圈点列于朱砂（人的批改）名下——用户自己敲的圈是「人在圈」，
//     Agent 不得代圈（石青=机 不越界）；
//   - 软上限：内容超过 MAX_CIRCLED_CHARS 字不圈、保留原文（长词组的椭圆会被
//     拉扁，视觉重量失控）；
//   - 安全边界：括号内含换行 / 未闭合 / 嵌套一律按字面保留，不做启发式猜。

/** 圈点内容的最大字符数（超过则整段按字面保留）。 */
export const MAX_CIRCLED_CHARS = 8;

/** 圈点解析片段：circled = true 的段渲染为 .pp-circled（text 已去括号）。 */
export interface CircledSegment {
  text: string;
  circled: boolean;
}

/**
 * 把来文文本切成「普通段 / 圈点段」序列。
 * 规则：【内容】且 0 < 内容长度 ≤ MAX_CIRCLED_CHARS 且不含换行 → 圈点段
 * （括号消费）；其余一切（超长 / 未闭合 / 括号内换行）→ 字面段。
 */
export function parseCircledSegments(text: string): CircledSegment[] {
  if (!text.includes('【')) return [{ text, circled: false }];
  const out: CircledSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(/【([^【】\n]*)】/g)) {
    const start = m.index ?? 0;
    if (m[1].length > 0 && m[1].length <= MAX_CIRCLED_CHARS) {
      if (start > last) out.push({ text: text.slice(last, start), circled: false });
      out.push({ text: m[1], circled: true });
      last = start + m[0].length;
    }
    // 超长：不 push，让该段连同括号留在后续普通段里（matchAll 继续找后面的）
  }
  if (last < text.length) out.push({ text: text.slice(last), circled: false });
  return out.length > 0 ? out : [{ text, circled: false }];
}

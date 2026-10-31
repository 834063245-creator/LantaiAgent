// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 卷名概括（B 批，2026-10-31）：**prompt 与回包解析的纯函数面**。
// 调用 / 超时 / usage 记账都不在这里——调用点见 `ui/chat-session.ts` 的
// `refineVolumeTitleIfDerived`（复用 Agent 的旁路能力位 `callSideLLM`）。
//
// 纪律（docs/plans/volume-naming-plan.md §3.4）：
//   · 只产「一句题名」，不做解释；模型跑偏时宁可返回空串（调用点据此保留派生名）；
//   · 入参是**本卷自己的首条来文**，按 JSON 包裹下发（用户文本里的分隔符不得破结构）；
//   · 解析只认第一个非空行——模型常把题名放首行、把解释跟在后面。
//
// 归属：纯函数 + 冻结常量（CONVENTIONS §1.10 第 4 类），无模块级可变态。

/** 下发给模型的首条来文上限（字符）。超长粘贴（整段报错 / 日志）取开头即可概括。 */
export const VOLUME_TITLE_INPUT_MAX_CHARS = 2000;

/** 卷名概括的 system 指令（长度与主语言口径写在这里，改口径只改这一处）。 */
const TITLE_SYSTEM_PROMPT = [
  '你为兰台的「案卷」起题名——一句概括本次会话要做什么。',
  '只输出题名本身：一行、纯文本、无引号、无前缀、无 Markdown、无句末标点。',
  '用消息本身的语言；中文 8–14 字，英文 4–7 词。',
  '信息不足时给一个最简短的尽力题名（如「问候」），不要解释。',
].join('\n');

/** 一次卷名概括的两段输入（system 指令 + JSON 包裹后的来文）。 */
export interface VolumeTitlePrompt {
  system: string;
  user: string;
}

/**
 * 组一次卷名概括的 prompt。
 * @param firstUserText - 本卷自己的首条来文（原文，未清洗——清洗交给卷名规范化）。
 * @returns system 指令与 JSON 包裹后的 user 输入。
 */
export function buildVolumeTitlePrompt(firstUserText: string): VolumeTitlePrompt {
  const text = firstUserText.slice(0, VOLUME_TITLE_INPUT_MAX_CHARS);
  return {
    system: TITLE_SYSTEM_PROMPT,
    user: `从下面这段人类来文中起一个卷名（JSON，text 字段即来文）：\n${JSON.stringify({ text })}`,
  };
}

/** 整行被星号强调包裹（`**题名**`）：剥掉标记对；内容里仍含标记则不动。 */
const EMPHASIS_WRAPPER = /^(?<marker>\*{1,3})(?<inner>\S(?:.*\S)?)\k<marker>$/u;

/** 除 \t 外的 C0/C1 控制符：模型可能回显转义 / 颜色码的前导字节。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 解析模型回包必须剔除控制符——范围字面量即规格（先例 src/paper/tool-text.ts）
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/**
 * 解析模型回包：第一个非空行 → 剥整行星号强调 → 去控制符 → 折叠空白 → trim。
 * @param reply - 模型原始文本（可能多行、可能带解释）。
 * @returns 题名候选（已清洗、**未**按卷名上限截断；空串 = 本轮回包不可用）。
 */
export function parseVolumeTitleReply(reply: string): string {
  const line =
    reply
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? '';
  const groups = EMPHASIS_WRAPPER.exec(line)?.groups;
  const marker = groups?.marker;
  const inner = groups?.inner;
  const unwrapped = marker === undefined || inner === undefined || inner.includes(marker) ? line : inner;
  return unwrapped.replace(CONTROL_CHARACTER, ' ').replace(/\s+/gu, ' ').trim();
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/fence — 围栏码（fenced code block）标记的**单一真源**：开围栏 / 闭围栏 / 回吐。
//
// 缘起（2026-11-19 病灶）：转译层的 `splitFencedSegments` 与 markdown 解析层各自写死
// 「正好三个反引号」——模型按 CommonMark 惯例用**四反引号**包一层来演示围栏（示例里
// 本身含 ```mermaid）时：多出来的那个反引号被吃进语言签（纸上抄录块语言行显示
// `text），内层 ```mermaid 被当成闭围栏把块截断，后半截 flowchart 掉回正文、末尾
// 再产出一个空抄录块。
//
// CommonMark 规则（spec 4.5，只取本仓需要的那几条）：
//   · 开围栏 = 行首 ≤3 空格 + **≥3 个**反引号或波浪线 + 信息串；同一围栏的字符全程一致。
//   · 闭围栏 = 行首 ≤3 空格 + **同种字符** + **不短于**开围栏的一段，其后只允许空白。
//   · 反引号围栏的信息串里不得出现反引号（这正是「外层必须更长」的由来）。
//
// 三处消费方（转译拆分 / 块级解析 / 查看器分段）共用本件——判据各判一份必然漂
// （markdown-doc.tsx 此前就手抄了同一份正则）。

/** 一段围栏标记：字符（反引号 / 波浪线）+ 长度（≥3）。 */
export interface FenceMark {
  char: '`' | '~';
  len: number;
}

/** 一行可能产出的围栏信息。 */
export interface FenceInfo {
  /** 围栏标记（开 / 闭同一形状）。 */
  mark: FenceMark;
  /** 语言标记（信息串首词，已 trim；无 = undefined）。摘图 / 代码高亮按它认领。 */
  lang?: string;
  /** 信息串原文（已 trim，可能含 `title="x"` 之类元数据；回吐时原样还原）。 */
  info?: string;
}

/** 闭围栏行：同种字符 + 不短于开围栏 + 其后只允许空白（````` / ~~ / ```lang 都不行）。 */
function isFenceClose(line: string, mark: FenceMark): boolean {
  let n = 0;
  while (n < line.length && line[n] === mark.char) n++;
  return n >= mark.len && line.slice(n).trim() === '';
}

/**
 * 行判据（行首围栏）：是围栏行就返回标记形态（开 / 闭同一形状；是否开或闭由调用方
 * 按「当前是否在围栏内」定），否则 undefined。**不判长度是否够**——闭围栏的不短于
 * 检查在 {@link isFenceClose}（开围栏一次定长，后续每行都要比）。
 */
export function fenceMarkOf(line: string): FenceMark | undefined {
  const m = /^(`{3,}|~{3,})/.exec(line);
  if (!m) return undefined;
  const run = m[1];
  return { char: run[0] as FenceMark['char'], len: run.length };
}

/** 开围栏行判定：返回标记 + 语言（信息串首词）；不是开围栏 = undefined。 */
export function fenceOpenOf(line: string): FenceInfo | undefined {
  const chars = /^(`{3,}|~{3,})/.exec(line);
  if (!chars) return undefined;
  const char = chars[1][0] as FenceMark['char'];
  const mark: FenceMark = { char, len: chars[1].length };
  const rest = line.slice(chars[1].length);
  // 反引号围栏的信息串不得含反引号（```a`b 不是围栏）；不合法 ⇒ undefined，
  // 由调用方的「行首 ```」兜底判据接住（信息串里的反引号按字面留着）。
  if (char === '`' && rest.includes('`')) return undefined;
  const info = rest.trim();
  if (info.length === 0) return { mark };
  return { mark, lang: info.split(/\s+/)[0], info };
}

/**
 * 闭围栏判定：闭围栏行**不带信息串**——```mermaid 在开围栏 ```` 下不是闭合
 * （长度不够 ⇒ 它只是围栏体里的一行），在开围栏 ``` 下也不是闭合（其后还剩
 * `mermaid`，不满足「只允许空白」）。
 */
export function fenceCloseOf(line: string, mark: FenceMark): boolean {
  return isFenceClose(line, mark);
}

/**
 * 回吐：标记 + 围栏体 → 围栏原文（**按原长度还原**，不是一律三个——四反引号围栏
 * 回吐成三个就换了围栏、内容里若有 ``` 会当场破块）。
 */
export function reemitFence(mark: FenceMark, lang: string | undefined, body: readonly string[]): string {
  const rail = mark.char.repeat(mark.len);
  return [`${rail}${lang ?? ''}`, ...body, rail].join('\n');
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Protocol（协议）展示层唯一事实源（CONTEXT.md「Protocol」）：
// 全仓库的「OpenAI 兼容 / Anthropic」标签只在这里定义，
// 禁止在组件里再写 kindLabel 之类的内联拷贝。
//
// ⚡ provider-refactor（方案乙）Phase 1A：Protocol 已开放为 string。
// 展示层不再用闭合 Record——内核/出厂协议走字面量表，注册表贡献的协议
// （ctx.llm adapter 的 label）在运行时经 protocolLabel 的 label 参数传入，
// 未知 kind 回落显示 kind 本身（不闭合、不炸）。

import type { Protocol } from '../../../provider/types';

/** 出厂协议的人类可读标签（唯一事实源）。
 *  anthropic/openai = 内核两族；responses = 出厂 Responses 协议
 *  （llm-adapters 产物插件注册，Phase 2）。 */
const KNOWN_PROTOCOL_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI 兼容',
  responses: 'OpenAI Responses',
};

/** 协议 → 人类可读标签。
 *  @param label 调用方从 adapter 注册表带来的贡献标签（未知 kind 时可选）；
 *               缺省/查不到 = 回落显示 kind 本身。 */
export function protocolLabel(k: Protocol, label?: string): string {
  if (label?.trim()) return label.trim();
  return KNOWN_PROTOCOL_LABELS[k] ?? k;
}

/** 是否为内核 anthropic 协议（Anthropic Messages API 方言特判点）。 */
export function isAnthropic(k: Protocol): boolean {
  return k === 'anthropic';
}

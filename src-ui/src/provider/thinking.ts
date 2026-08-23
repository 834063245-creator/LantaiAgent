// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ThinkingPolicy — CONTEXT.md「ThinkingPolicy」：用户对「模型作答前推理多少」的配置。
// 存储字段名保持 `thinking`（遗留名）；领域词 ThinkingPolicy。
// 数字字符串是历史遗留（Anthropic 支持直接写 token 预算），UI 仅提供命名档位。
//
// ⚡ P14（2026-08-22）能力协商定稿：档位支持与否是 per-model 数据（ModelDescriptor
// .thinkingEfforts / .thinkingOff / .deepseekThinking），不是厂商嗅探。本模块只保留：
// 词表 + 标签、Anthropic budget 映射、内部强制关闭语义、声明驱动的 UI 选项构造。
// 退役：effortVendor / toOpenAIEffort / thinkingModesFor（name/baseUrl/model 字符串
// 嗅探 + low→high 静默归一——选了低实际发高，用户无从得知）；
// 全局「深度思考」开关（SettingsPanel Agent 页，2026-08-24 拆除——Provider 页
// 档位含「关闭」，其目录外兜底在 OpenAI 兼容协议下本就不发参数、实际空转）。

import type { ModelDescriptor, Protocol } from './types';

/** 思考档位 canonical 词表——各厂商声明子集（pi-ai canonical 集对齐）。
 *  minimal = 最浅；xhigh = 介于 high 与 max（OpenAI gpt-5.2+）；
 *  存储值即此词表成员，新增档位向后兼容（旧存储子集不受影响）。 */
export type ThinkingEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ThinkingMode = '' | 'off' | ThinkingEffort;

/** ProviderSettings.thinking 的完整存储形态：命名档位 + 历史遗留数字预算。 */
export type StoredThinking = ThinkingMode | `${number}`;

/** 词表标签（顺序即展示顺序；'' = 自动，存储值即 select value）。 */
const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  minimal: '最浅 (minimal)',
  low: '低 (low)',
  medium: '中 (medium)',
  high: '高 (high)',
  xhigh: '较深 (xhigh)',
  max: '极限 (max)',
};

/** 词表展示顺序（含自动/关闭两端的完整 UI 档位表）。 */
export const THINKING_MODES: readonly { value: ThinkingMode; label: string }[] = [
  { value: '', label: '自动（模型自定）' },
  ...Object.entries(EFFORT_LABELS).map(([value, label]) => ({
    value: value as ThinkingEffort,
    label,
  })),
  { value: 'off', label: '关闭' },
];

/** 命名档位 → Anthropic budget_tokens（唯一事实源，原 anthropic.ts 内联映射收口于此）。
 *  budget 钮是 Anthropic 协议 uniform 能力（1024 ≤ budget < max_tokens），
 *  六档预设是我们自己的刻度，非厂商档位。 */
export const THINKING_EFFORT_BUDGETS: Record<ThinkingEffort, number> = {
  minimal: 2048,
  low: 4000,
  medium: 8000,
  high: 16000,
  xhigh: 24000,
  max: 32000,
};

export function isThinkingMode(v: string): v is ThinkingMode {
  return THINKING_MODES.some((o) => o.value === v);
}

export function thinkingModeLabel(v: string | undefined): string {
  if (!v) return THINKING_MODES[0].label;
  return THINKING_MODES.find((o) => o.value === v)?.label ?? `自定义 (${v})`;
}

/** 调用方强制关闭思考（翻译器/摘要路径的 options.disableThinking，非用户设置）
 *  对单 Provider 思考策略的生效结果（provider/index.ts 使用）。 */
export function withThinkingDisabled(
  thinking: StoredThinking | undefined,
  disableThinking: boolean | undefined,
): StoredThinking | undefined {
  return disableThinking ? 'off' : thinking || undefined;
}

// ── 能力协商（P14）────────────────────────────────────────────

/** 一个模型的思考能力声明（从 ModelDescriptor 提炼，openai/anthropic 共用查询面）。 */
export interface ThinkingCapability {
  /** 声明支持的档位（canonical 子集；空/缺省 = 无档位证据，UI 不显示选择器）。 */
  efforts: readonly ThinkingEffort[];
  /** 「关闭」是否可表达。 */
  off: boolean;
  /** DeepSeek 思考方言：effort 参数需 thinking:{type} 包裹（仅 openai 协议消费）。 */
  deepseekWrap: boolean;
}

/** 从模型描述符提炼思考能力声明。
 *  描述符缺省（目录外/动态模型）= 无声明：不编造档位、不编造关闭语义。 */
export function thinkingCapability(desc: ModelDescriptor | undefined): ThinkingCapability {
  return {
    efforts: desc?.thinkingEfforts ? [...desc.thinkingEfforts] : [],
    off: desc?.thinkingOff === true,
    deepseekWrap: desc?.deepseekThinking === true,
  };
}

/** 声明驱动的 UI 档位表（替代退役的 thinkingModesFor 嗅探）：
 *  自动档恒有；声明档位按词表序给出；声明 off 才有关闭。
 *  无声明（目录外模型）→ 不显示档位选择器——思考走模型默认，无法控制。 */
export function thinkingOptionsFor(
  desc: ModelDescriptor | undefined,
): readonly { value: ThinkingMode; label: string }[] {
  const cap = thinkingCapability(desc);
  if (cap.efforts.length === 0) return [];
  const tiers = THINKING_MODES.filter(
    (o): o is { value: ThinkingEffort; label: string } =>
      o.value !== '' && o.value !== 'off' && cap.efforts.includes(o.value as ThinkingEffort),
  );
  return [
    { value: '', label: THINKING_MODES[0].label },
    ...tiers,
    ...(cap.off ? [{ value: 'off' as const, label: '关闭' }] : []),
  ];
}

/** 校验已存储的思考策略是否在声明清单内（发请求前的响亮门禁）。
 *  - 自动（''/遗留数字）与「关闭」：协议层各自处理，此函数不拦（关闭未声明时
 *    openai 协议降级为不发参数——翻译路径的强制关闭不能因未知模型而炸）。
 *  - 命名档位：模型未声明或不在清单内 → 抛错（用户改选，绝不静默替换）。
 *  协议差异（budget vs effort）由调用方在捕获后自行组织文案。 */
export function assertEffortDeclared(
  stored: StoredThinking | undefined,
  cap: ThinkingCapability,
  protocol: Protocol,
): void {
  const v = stored || '';
  if (!isThinkingMode(v) || v === '' || v === 'off') return; // 数字遗留/自动/关闭不在此拦
  if (cap.efforts.length > 0 && !cap.efforts.includes(v)) {
    throw new Error(
      `[思考档位不支持] 当前模型不支持「${thinkingModeLabel(v)}」。` +
        `可用档位：${cap.efforts.map((e) => EFFORT_LABELS[e]).join('、')}${cap.off ? '、关闭' : ''}。` +
        `请到 设置 → Provider 重新选择（${protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}协议）。`,
    );
  }
}

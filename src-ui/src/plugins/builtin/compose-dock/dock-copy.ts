// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// dock-copy — 创作坞的**静态文案表**（2026-11-15 V2 拆出；语义零新增）。
//
// 为什么单独立文件：ComposerDock 已在大文件账上（1700 行档），而这三张表是纯数据
// ——没有状态、没有 props、没有副作用。搬出去不改任何行为，只让坞本体少 60 行。

/* 律（快捷键总览）已于 2026-11-28 搬去 `app/help/shortcut-groups.ts`——「案」抽屉退役，
 * 它成为应用级帮助页（入口 = 全局搜索 / runAction('shortcuts')），而 app 层不许 import
 * 插件目录。本文件只剩坞自己的文案表。 */

/** 历史导航眉批：一次性提示旗标（localStorage，毒化容忍——读写全包 try）。 */
export const HIST_HINT_KEY = 'lantai.hint.historySeen';

/** rework P2-2：思考档位纯中文展示词（创作坞内不再中英混排）。 */
const THINKING_ZH: Record<string, string> = {
  '': '自动',
  off: '关闭',
  minimal: '最浅',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '较深',
  max: '极限',
};

export function thinkingZhLabel(value: string | undefined): string {
  if (value == null || value === '') return THINKING_ZH[''] ?? '自动';
  return THINKING_ZH[value] ?? value;
}

/** DSH thinkingDesc 语义（中文）——思考档位下拉选项的说明行。 */
export const THINKING_DESC: Record<string, string> = {
  '': '模型自定推理强度',
  off: '不推理，直接作答',
  minimal: '最浅推理，响应最快',
  low: '轻度推理',
  medium: '均衡推理',
  high: '深入推理',
  xhigh: '较深推理',
  max: '极限推理',
};

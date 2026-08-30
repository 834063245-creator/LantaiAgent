// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// paper/tool-text — 脚注（tool）参数的展示规整：渲染与测量共用的单一变换。
//
// 缘起（2026-08-30 会话流渲染专项）：ToolBody 直接平铺 args 原始 JSON 串
// （单行长串靠 break-all 硬折），展开后不可读。此处规整为 pretty JSON；
// 测量端（measure.ts 的 tool/code argsH）必须消费同一变换——否则测高与
// 渲染行数漂移（镜像纪律）。

/** 工具参数规整：可解析 JSON → 两空格缩进 pretty；不可解析（流式未完/非 JSON）→ 原样。 */
export function prettyToolArgs(args: string): string {
  if (!args) return '';
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
    return args;
  } catch {
    return args;
  }
}

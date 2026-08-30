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

/** 参数摘要键优先级：edit/shell 族的关键目标（file_path/command）按这些键名先取。 */
const DIGEST_KEY_RE = /path|file|cmd|command|query|url|pattern|skill|description|name/i;
const DIGEST_MAX = 40;

/** 工具参数摘要（折叠行用，2026-08-30 会话流专项）：从 args 取「这个调用干了什么」
 *  的短摘要——优先命中目标键（file_path/command/query…）的首个字符串值，兜底
 *  首个字符串值；非对象取原串。流式未完（JSON 没闭合）按原串首行兜底。 */
export function toolDigest(args: string, max = DIGEST_MAX): string {
  if (!args) return '';
  const shorten = (s: string): string => {
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  };
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === 'string') return shorten(parsed);
    if (Array.isArray(parsed)) {
      const v = parsed.find((x) => typeof x === 'string' && x.length > 0);
      return typeof v === 'string' ? shorten(v) : '';
    }
    if (parsed && typeof parsed === 'object') {
      const entries = Object.entries(parsed as Record<string, unknown>);
      const keyed = entries.find(([k, v]) => DIGEST_KEY_RE.test(k) && typeof v === 'string' && v.length > 0);
      const first = entries.find(([, v]) => typeof v === 'string' && v.length > 0);
      const v = keyed?.[1] ?? first?.[1];
      return typeof v === 'string' ? shorten(v) : '';
    }
    return '';
  } catch {
    const firstLine = args.split('\n')[0] ?? '';
    return firstLine.trim() ? shorten(firstLine) : '';
  }
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 会话磁盘形状的测试夹具（Phase 3b 权威翻转后）：
//   · 卷本体 = 事件日志 `{id}.ndjson`（头行 + 事件行）；
//   · UI 投影缓存 = `{id}.json`（带 `seq`/`ver`——陈旧即不采信）。
//
// 形状与生产写面同源（`app/chat/session-log-store.ts` 的物化 + `chat-session` 的缓存写），
// 差异只在此处不落盘、直接交给内存盘 / mock。

/** 造一份事件日志文本（`{root}/{id}.ndjson` 的内容）。
 *  **头行不带卷名**（2026-09-18 命名收口）：卷名的家 = 投影缓存（`cacheText` 的
 *  `label`）。头行 write-once，带 label 只会是陈旧副本。 */
export function logText(
  id: number,
  messages: Array<{ role: string; content?: string; [k: string]: unknown }>,
  savedAt?: string,
  presetId?: string,
): string {
  const header = JSON.stringify({
    type: 'session',
    version: 1,
    id,
    createdAt: savedAt ?? '2026-01-01T00:00:00Z',
    ...(presetId ? { presetId } : {}),
  });
  const sys = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const events: string[] = [];
  let seq = 1;
  if (sys.length > 0) {
    events.push(JSON.stringify({ seq: seq++, ts: 1, kind: 'session/reset', data: { messages: sys, reason: 'init' } }));
  }
  for (const m of rest) {
    const kind = m.role === 'user' ? 'user/message' : m.role === 'assistant' ? 'assistant/text' : 'tool/result';
    events.push(JSON.stringify({ seq: seq++, ts: 2, kind, data: { message: m } }));
  }
  return `${header}\n${events.map((e) => `${e}\n`).join('')}`;
}

/** 造一份投影缓存文本（`{root}/{id}.json` 的内容）——`seq` 必须 ≥ 日志末序号才算新鲜。 */
export function cacheText(
  id: number,
  opts: {
    label?: string;
    savedAt?: string;
    seq?: number;
    uiMessages?: unknown[];
    tokensUsed?: number;
    /** token 账本快照（`tokens` 字段）——累计账，不受新鲜度门管。 */
    tokens?: unknown;
  } = {},
): string {
  return JSON.stringify({
    id,
    label: opts.label ?? '', // 缺省 = 未命名（卷名的家在这里，见 logText 头注）
    savedAt: opts.savedAt ?? '2026-01-01T00:00:00Z',
    tokensUsed: opts.tokensUsed ?? 0,
    seq: opts.seq ?? 999, // 缺省给足（新鲜）
    ver: 1,
    ...(opts.uiMessages ? { uiMessages: opts.uiMessages } : {}),
    ...(opts.tokens ? { tokens: opts.tokens } : {}),
  });
}

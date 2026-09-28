// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// provider 实现的共享工具函数 — 从 anthropic.ts 和 openai.ts 中提取

import { classifyError, llmDone, proxyFetch } from './host';

/** 合并自定义请求头与内核必需头（2026-09-17）。
 *
 *  HTTP 头名大小写不敏感——若自定义头与必需头同名但大小写不同（`authorization`
 *  vs `Authorization`），Fetch 会把两条值合并成 `"a, b"` 送出，凭据头被污染。
 *  故按键（小写）剔除自定义侧的冲突项，而不是依赖对象展开的覆盖序。
 *  @param custom - 用户在设置里配置的请求头（可缺省）。
 *  @param required - 内核必需头 + 凭据头（协议与凭据权威，恒胜）。
 *  @returns 可直接送 fetch 的头表。
 */
export function mergeHeaders(
  custom: Readonly<Record<string, string>> | undefined,
  required: Record<string, string>,
): Record<string, string> {
  const reserved = new Set(Object.keys(required).map((name) => name.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(custom ?? {})) {
    if (!reserved.has(name.toLowerCase())) merged[name] = value;
  }
  return { ...merged, ...required };
}

/** 从流式 JSON 参数中提取 write/edit 工具的部分内容。
 *  处理不完整的 JSON — content 字符串可能尚未闭合。
 *  工具收敛后模型调用领域工具 fs(action=write/edit)：从部分参数中正则提取 action。 */
export function extractWritePreview(toolName: string, args: string): string | null {
  let isWrite = toolName === 'write_file' || toolName === 'write_file_content';
  let isEdit = toolName === 'edit_file';
  if (toolName === 'fs' && !isWrite && !isEdit) {
    const m = args.match(/"action"\s*:\s*"(write|edit)"/);
    if (m) {
      isWrite = m[1] === 'write';
      isEdit = m[1] === 'edit';
    }
  }
  if (!isWrite && !isEdit) return null;

  const key = isEdit ? 'newString' : 'content';
  // 正则从部分 JSON 中提取 "key": "..."。
  // 处理字符串值中的转义字符（\"、\\、\n 等）。
  const re = new RegExp(`"${key}"\\s*:\\s*"(.*)`, 's');
  const m = args.match(re);
  if (!m) return null;

  // 反转义 JSON 转义字符，使预览可读
  return (
    m[1]
      .replace(
        /\\(["\\/bfnrt])/g,
        (_, c: string) => ({ '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[c] || c,
      )
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      // 去除尾部垃圾（部分 JSON 可能以 " 或 "} 结尾，也可能没有尾部内容）
      .replace(/"\s*\}?\s*$/, '')
  );
}

/** 通过短生命周期的请求预热 HTTP 连接池。尽力而为 — 失败静默处理。 */
export function prewarmEndpoint(url: string, headers: Record<string, string>): void {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 3000);
  proxyFetch(url, { headers, signal: ctrl.signal }).catch(() => {});
}

/** 带超时的 JSON 获取结果：`json` = 载荷（非 ok / 网络错误 / 超时 / 非 JSON 皆 null）；
 *  `status` = HTTP 状态码（0 = 网络层失败/超时，没有拿到响应）。 */
export interface JsonFetchOutcome {
  json: unknown | null;
  status: number;
}

/** 带超时的 JSON 获取。任何失败 json 均为 null（非 ok、网络错误、超时）。
 *  ⚡ 2026-09-28 无 Key 放行批：status 一并回给调用方——无 Key 行被 401/403 拒时
 *  说「网络错误或端点无响应」是误导（用户会去查网线而不是去填 Key）。 */
export async function fetchJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<JsonFetchOutcome> {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await proxyFetch(url, { headers, signal: ctrl.signal });
    if (!resp.ok) return { json: null, status: resp.status };
    return { json: await resp.json(), status: resp.status };
  } catch {
    return { json: null, status: 0 };
  }
}

/** 这组请求头里有没有凭据（`Authorization` / `x-api-key` 非空）。
 *
 *  ⚡ 2026-09-28 无 Key 放行批：空 Key 不再拦在请求前（本地端点无 Key 是常态），
 *  于是 401/403 的文案归属必须由「到底发没发凭据」回答——没发 = 这行没配 Key
 *  （`classifyError` 的 keyless 支），发了 = Key 无效（既有文案）。
 *  判据取自**实际要发出的头表**（而非各方言另传一个标志）：方言改头时不会漏同步；
 *  自定义请求头里带了 `x-api-key` 的行也如实算「发了凭据」（保守，宁窄勿宽）。 */
export function sentCredential(headers: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    const k = name.toLowerCase();
    if ((k === 'authorization' || k === 'x-api-key') && value.trim() !== '') return true;
  }
  return false;
}

/** `/models` 拉取失败的文案（三方言共用）。
 *  无 Key 行被端点以 401/403 拒 → 走 `classifyError` 的 keyless 支（与对话路径
 *  同一句文案——唯一真源）；其余形态（网络错 / 超时 / 其它状态码）沿用既有文案。 */
export function modelsFetchFailure(name: string, status: number, keyless: boolean): string {
  if (keyless && (status === 401 || status === 403)) return classifyError(name, status, '', undefined, true);
  return `${name}: 模型目录获取失败（网络错误或端点无响应）`;
}

/** SSE 事件基类型 — 各 provider 方言按 type 判别，其余字段由调用方接口细化。 */
export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/** `sseEvents` 的日志接缝描述面（`llm.done` 用；缺省不记）。 */
export interface SseLogMeta {
  model: string;
  /** 方言名（openai / anthropic / responses）。 */
  kind: string;
  /** 请求 URL（门面自己削成 host:port）。 */
  url: string;
}

/** 解析 SSE 流并 yield 解码后的 JSON 事件。处理 reader/decoder/buffer
 *  管理和尾部数据刷新。调用方按各 provider 格式处理每个事件。
 *
 *  边界（P0 定稿）：只解析单行 `data:` 事件——所有目标服务商
 *  （Anthropic/DeepSeek/Moonshot/Minimax/Qwen/OpenAI 兼容）均以单行
 *  data 发送 JSON，`[DONE]` 为流结束标记。不支持 `event:` 字段与
 *  多行 data（SSE 规范特性），无需求不做。
 *
 *  ⚡ 日志接缝（2026-09-27 批 2）：出网四相的第四相 `llm.done` 落在这里——
 *  这是「流什么时候读完」的唯一公共面（方言无关，新方言自动继承）。
 *  前三相（send / first_byte / error）在 `retry.ts` 的 `sendWithRetry`。 */
export async function* sseEvents<T extends SseEvent = SseEvent>(
  body: ReadableStream<Uint8Array>,
  name: string,
  signal?: AbortSignal,
  obsMeta?: SseLogMeta,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const t0 = Date.now();
  let events = 0;
  let completed = false;

  try {
    while (true) {
      if (signal?.aborted) throw new Error(`${name}: aborted`);
      const { done, value } = await reader.read();
      if (done) {
        // 刷新 decoder 内部状态并处理 buffer 中的尾部数据
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留不完整的最后一行

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          events += 1;
          yield JSON.parse(data);
        } catch {}
      }
    }

    // 流结束后处理 buffer 中剩余的完整行
    if (buffer.trim()) {
      const remaining = buffer.split('\n').filter((l) => l.trim());
      for (const raw of remaining) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          events += 1;
          yield JSON.parse(data);
        } catch {}
      }
    }
    completed = true;
  } finally {
    reader.releaseLock();
    // ⚡ 只在**正常读完**时报 done：消费者提前 break（`.return()`）、中止、抛错都会
    //    走到这个 finally——那三种形态报 ✓ 是假账（中止另有 `turn.failed` 收口）。
    if (completed && obsMeta) {
      llmDone({
        provider: name,
        model: obsMeta.model,
        kind: obsMeta.kind,
        url: obsMeta.url,
        ms: Date.now() - t0,
        events,
      });
    }
  }
}

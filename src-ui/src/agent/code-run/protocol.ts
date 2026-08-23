// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// code-run 协议腰线 — 宿主 ↔ Web Worker 的窄腰消息契约。
//
// 对标 DSH code-runtime-worker-thread/src/protocol.ts（agent-plugin-architecture-plan
// P2 第 1 步），语义对齐三条铁律：
//   1. correlation-id 一次性：worker 发的每个 call id 宿主至多应答一次；
//      宿主发的每个 reply id worker 至多结算一次，重复/未知 id 忽略。
//   2. 宿主视入站流量为敌意：模型代码可伪造 self.postMessage（call/log/done
//      全可伪造）——宿主对每个字段做形状校验，未知/重复消息静默丢弃，
//      预算超限即 terminate。
//   3. 无损 JSON 才能过线：call 的 args 经 JSON roundtrip 归一（structured
//      clone 之后的值必须仍是无损 JSON——Date/Map 等克隆安全但非 JSON 的
//      值在归一时被拒）；完成值同理，不可归一 → invalid-output。
//
// 「协议纪律沙箱」定位（计划 D1）：Web Worker 不是进程级硬边界，安全面
// = 本协议的实现质量。工具本体永不进 worker——worker 只拿工具名清单，
// 调用经 postMessage 桥回宿主侧 executor 语义（门禁/hooks/审计全在宿主）。

/** 宿主 → worker：应答一次嵌套工具调用。 */
export type CodeReplyMessage =
  | { t: 'reply'; id: number; ok: true; value: string }
  | { t: 'reply'; id: number; ok: false; message: string };

/** worker → 宿主：一次嵌套工具调用请求。args 为结构化克隆安全的参数对象。 */
export interface CodeCallMessage {
  t: 'call';
  /** worker 发号的一次性 correlation id（宿主拒绝重复 id）。 */
  id: number;
  /** 目标工具名（宿主侧校验必须属于 boot 时声明的绑定集）。 */
  name: string;
  /** 调用参数（plain object；宿主侧做无损 JSON 归一）。 */
  args: unknown;
}

/** worker → 宿主：一行捕获日志（日志先行——逐条即发，中途被杀也不丢）。 */
export interface CodeLogMessage {
  t: 'log';
  text: string;
}

/** worker → 宿主：worker 侧预算耗尽的主动上报（宿主侧独立计账，双保险）。 */
export interface CodeOutputLimitMessage {
  t: 'output-limit';
}

/** worker → 宿主：程序落定（恰好一条生效，后续忽略）。 */
export interface CodeDoneMessage {
  t: 'done';
  /** 完成值（无损 JSON 文本；无返回值/异常时缺省）。 */
  value?: string;
  /** 失败分类：exception 程序抛错 / invalid-output 返回值非无损 JSON /
   *  output-limit 超输出预算（宿主侧超限/超时/中止也归一为同形状）。 */
  error?: {
    kind: 'exception' | 'invalid-output' | 'output-limit' | 'timeout' | 'aborted' | 'substrate';
    message: string;
  };
}

/** worker → 宿主全部消息。 */
export type WorkerToHost = CodeCallMessage | CodeLogMessage | CodeOutputLimitMessage | CodeDoneMessage;

/** 宿主 → worker 全部消息。 */
export type HostToWorker = CodeReplyMessage;

/** 失败分类（宿主侧统一出口）。 */
export type CodeRunErrorKind = NonNullable<CodeDoneMessage['error']>['kind'];

/** 一次 code run 的结构化结果 — 宿主侧 run() 的返回值。 */
export interface CodeRunResult {
  /** 捕获日志（按序；预算内的全部行）。 */
  logs: string[];
  /** 完成值 JSON 文本（程序 return 了无损 JSON 时存在）。 */
  result?: string;
  /** 失败时的分类与消息（成功时缺省）。 */
  error?: { kind: CodeRunErrorKind; message: string };
}

/** 宿主侧入站消息形状校验 — 敌意流量在这里被拒。
 *  返回 null = 丢弃（形状非法）；合法形状原样返回（语义级校验由调用方做）。 */
export function parseWorkerMessage(data: unknown): WorkerToHost | null {
  if (data === null || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  switch (m.t) {
    case 'call':
      return typeof m.id === 'number' && Number.isInteger(m.id) && m.id > 0 && typeof m.name === 'string'
        ? (m as unknown as CodeCallMessage)
        : null;
    case 'log':
      return typeof m.text === 'string' ? (m as unknown as CodeLogMessage) : null;
    case 'output-limit':
      return { t: 'output-limit' };
    case 'done': {
      const hasValue = typeof m.value === 'string';
      const err = m.error as Record<string, unknown> | undefined;
      const hasError =
        err !== null && typeof err === 'object' && typeof err.kind === 'string' && typeof err.message === 'string';
      if (!hasValue && !hasError) return null;
      return m as unknown as CodeDoneMessage;
    }
    default:
      return null;
  }
}

/** 无损 JSON 归一 — structured clone 之后的值必须仍能以 JSON 往返。
 *  Date/Map/Set/循环引用等克隆安全但非 JSON 的值在此被拒（返回 null）。
 *  对齐 DSH snapshotJsonValue：dispatch 与日志共享同一份脱离原值的快照。 */
export function normalizeJsonArgs(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null; // 值含 undefined/函数/symbol 的根级不可序列化
    const back = JSON.parse(text) as Record<string, unknown>;
    return back;
  } catch {
    return null;
  }
}

/** 完成值无损校验 — 程序 return 的值必须是无损 JSON（返回 JSON 文本，非法 null）。 */
export function normalizeCompletion(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null;
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

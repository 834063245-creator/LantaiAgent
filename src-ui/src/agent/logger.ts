// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 兰台 UI 日志器 — 结构化 NDJSON 写入 .lantai/logs/ui.log
// 零外部依赖。通过 rpc('log_append') 写入。
//
// ⚡ 2026-09-27 日志可观测性批 1：本文件从「唯一的写口」升为**两层**——
//   传输层（本文件：缓冲 / flush / 落盘）不动，之上加事件层 `agent/obs.ts`
//   （公共字段 + 唯一脱敏点 + 事件名规范）。旧 `log.debug/info/warn/error`
//   调用**零迁移**（本批零回归面）：它们只是多了一个**可选的第 4 参** `extra`
//   （event/ids/dur_ms/out/err/build/truncated），不传 = 逐字节同旧行为。
//   ⚡ 事件字段**搭既有 `log.*` 而不是另开写口**是刻意的：`log.*` 是本仓库测试
//   替身（vi.mock logger）唯一复现过的写面——另开导出会让几十处替身当场缺键
//   （写口 undefined），而那是**测试替身与模块面不一致**的问题，不该由产品面
//   替它兜。形态上也不发明第二套写 API。
//   立项理由见 docs/plans/log-observability-plan.md。

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 落盘条目。前五个字段是历史形状（解析器依赖），其余为 obs 事件层扩展。 */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  message: string;
  ctx?: Record<string, unknown>;
  /** ASCII 点分稳定事件名（`boot` / `config.load` / `llm.error` / `turn.failed`…）。
   *  ⚡ 不用中文句子当事件名——事件名是**判据**，文案是给人读的（两者混同正是
   *  本次事故里「日志答不了问题」的一半原因）。 */
  event?: string;
  /** 会话/回合/运行身份（哪个卷、哪一轮、哪条运行记录）。 */
  ids?: Record<string, unknown>;
  /** 耗时（毫秒）——有起止的事件才带。 */
  dur_ms?: number;
  /** 结局：`ok` / `fail` / `miss` / `hit` / `skip`。 */
  out?: string;
  /** 失败结构化面：`{kind,status,phase,raw}`（raw = 原始错误文本，经脱敏）。 */
  err?: Record<string, unknown>;
  /** 构建锚：`{v,commit}` —— 收到的 log 靠它定位代码（事故里只能靠「有无
   *  method 字段」反推壳的构建时间，这是补上这一课）。 */
  build?: Record<string, unknown>;
  /** 条目超过 4KB 上限被截断（截断后仍是一条可读记录，不是丢弃）。 */
  truncated?: boolean;
}

let logPath: string | null = null;
let logBuffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
const MAX_BUFFER = 50;
const FLUSH_MS = 2000;

export async function initLogger(projectPath: string): Promise<void> {
  // 刷新旧 workspace 的剩余日志，然后清除旧定时器
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();

  try {
    logPath = `${projectPath}/.lantai/logs/ui.log`;
  } catch {
    logPath = null;
  }
  flushTimer = setInterval(flush, FLUSH_MS);
}

function buildEntry(level: LogLevel, module: string, message: string, ctx?: Record<string, unknown>): LogEntry {
  return { ts: new Date().toISOString(), level, module, message, ctx };
}

async function appendToFile(path: string, content: string): Promise<void> {
  try {
    const { kernelLogAppend } = await import('../rpc-contract');
    await kernelLogAppend(path, content);
  } catch {
    // 日志写入失败静默忽略 — 日志不能破坏应用
  }
}

function write(entry: LogEntry): void {
  logBuffer.push(JSON.stringify(entry));
  if (logBuffer.length >= MAX_BUFFER) flush();
}

async function flush(): Promise<void> {
  if (logBuffer.length === 0 || !logPath) return;
  const batch = logBuffer.splice(0).join('\n') + '\n';
  logBuffer = [];
  try {
    await appendToFile(logPath, batch);
  } catch {
    // silent
  }
}

export const log = {
  debug(m: string, msg: string, ctx?: Record<string, unknown>, extra?: Partial<LogEntry>) {
    write({ ...buildEntry('debug', m, msg, ctx), ...extra });
  },
  info(m: string, msg: string, ctx?: Record<string, unknown>, extra?: Partial<LogEntry>) {
    write({ ...buildEntry('info', m, msg, ctx), ...extra });
  },
  warn(m: string, msg: string, ctx?: Record<string, unknown>, extra?: Partial<LogEntry>) {
    write({ ...buildEntry('warn', m, msg, ctx), ...extra });
    console.warn(`[${m}] ${msg}`, ctx ?? '');
  },
  error(m: string, msg: string, ctx?: Record<string, unknown>, extra?: Partial<LogEntry>) {
    write({ ...buildEntry('error', m, msg, ctx), ...extra });
    console.error(`[${m}] ${msg}`, ctx ?? '');
  },
};

/** 日志通道当前是否可写（`boot` 事件如实上报；批 3 的健康度计数同源）。 */
export function logChannelState(): 'ok' | 'unavailable' {
  return logPath ? 'ok' : 'unavailable';
}

/** 当前日志文件绝对路径（诊断面读；未 init = null）。 */
export function logFilePath(): string | null {
  return logPath;
}

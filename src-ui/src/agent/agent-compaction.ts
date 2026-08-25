// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 上下文压缩域 — 折叠状态机 / 触发判定 / 摘要管线调度 / 自动调优。
// 从 agent.ts 机械搬移（11c），零逻辑改动。
// 宿主模式：Agent 类经受控转换（as unknown as CompactionHost）传入本模块。

import { createProvider } from '../provider';
import { getAllModels } from '../provider/catalog';
import { streamWithIdleTimeout } from '../provider/idle-stream';
import type { Message, Provider, Usage } from '../provider/types';
import { ChunkType } from '../provider/types';
import { typedRpc } from '../rpc-contract';
import { loadSettingsWithSecrets } from '../settings';
import { type AgentEvent, EventKind, type Pricing } from './agent-types';
import type { CompactionConfig, CompactionEvent, CompactionTracker } from './compaction-model';
import { maybeTune } from './compaction-model';
import {
  buildMergePrompt,
  buildSummaryPrompt,
  chunkMessages,
  digestMessages,
  renderTranscript,
  SUMMARY_MAX_LLM_CHUNKS,
  SUMMARY_MIN_INPUT,
  SUMMARY_MIN_WINDOW,
  SUMMARY_OUTPUT_BUDGET,
  SUMMARY_PROMPT_BUDGET,
} from './compaction-summarize';
import type { ExecStateInstance } from './execution-state';
import { log } from './logger';
import { buildCompactedSummaryMessage } from './session-log';
import { countMessages, countText } from './token-counter';
import type { ToolRegistry } from './tool';
import { foldToolResults, nextFoldBoundary } from './tool-fold';

/** 压缩域对宿主 Agent 的最小状态面（成员与 Agent 类声明逐字对齐）。 */
export interface CompactionHost {
  readonly session: Message[];
  readonly prov: Provider;
  readonly tools: ToolRegistry;
  readonly pricing: Pricing | undefined;
  readonly contextWindow: number;
  readonly compactionTracker: CompactionTracker;
  readonly _execState: ExecStateInstance;
  _sink: (ev: AgentEvent) => void;
  compactRatio: number;
  recentKeep: number;
  compactStuck: boolean;
  compactRetryAfterLen: number;
  compactFailCount: number;
  compactRunning: boolean;
  _summaryProv: { prov: Provider; window: number } | null;
  _compactionConfigPath: string | null;
  _compactionTrackerPath: string | null;
  _compactSummary: string | null;
  _compactTailStart: number;
  stormSig: string;
  stormCount: number;
  /** 工具结果折叠边界 + 窗口（payloadMessages 尾段消费）。 */
  _toolFoldBoundary: number;
  _toolResultWindow: number;
  /** Phase 5 事件日志 — 压缩折叠事件（session/compaction）直写。 */
  _sessionLog: { append(kind: string, data: unknown): void };
  _foldHead(): number;
  payloadMessages(): Message[];
  tokenCountWithEstimation(): number;
}

// ── 折叠视图（根治核心）──

/** session 头部偏移: 若第一条是 system prompt 则为 1，否则为 0。 */
export function foldHead(host: CompactionHost): number {
  return host.session.length > 0 && host.session[0].role === 'system' ? 1 : 0;
}

/** 发送给 LLM 的载荷 — 完整历史 + 压缩折叠（若已有压缩记录）+ 工具结果滚动折叠。
 *  根治: session 永远是完整历史（UI/存档读取），压缩与折叠只影响这里。 */
export function payloadMessagesImpl(host: CompactionHost): Message[] {
  let msgs: Message[];
  if (!host._compactSummary || host._compactTailStart < 0) {
    msgs = host.session;
  } else {
    const head = host._foldHead();
    const tailStart = Math.min(Math.max(host._compactTailStart, head), host.session.length);
    // Phase 5 来源替换：摘要消息构造与 session-log.ts derivePayload 共用单一实现（字节级一致）
    const summaryMsg: Message = buildCompactedSummaryMessage(host._compactSummary);
    msgs = [...host.session.slice(0, head), summaryMsg, ...host.session.slice(tailStart)];
  }
  // 窗口外的旧工具结果折叠为占位符 — 保留 tool_call_id 配对，模型需细节时可重新调用工具。
  // 折叠边界批量前移（跨整批阈值才动），绝不逐轮滚动——否则前缀每轮漂移击穿缓存。
  let totalTool = 0;
  for (const m of host.session) if (m.role === 'tool') totalTool++;
  host._toolFoldBoundary = nextFoldBoundary(totalTool, host._toolFoldBoundary, host._toolResultWindow);
  return foldToolResults(msgs, host._toolFoldBoundary);
}

/** 设置自动调优压缩配置的持久化路径。 */
export function setCompactionConfigPathImpl(host: CompactionHost, projectPath: string): void {
  const base = projectPath.replace(/\\/g, '/');
  host._compactionConfigPath = base + '/.lantai/compaction-config.json';
  // E5: tracker 状态（事件 + filesRead）单独持久化，使
  // 压缩调优在重启后不从零开始。
  host._compactionTrackerPath = base + '/.lantai/compaction-tracker.json';
}

/** E5: 从磁盘加载持久化的 tracker 状态（事件 + filesRead）。
 *  启动时调用，使压缩调优有历史数据。 */
export async function loadCompactionTrackerImpl(host: CompactionHost): Promise<void> {
  if (!host._compactionTrackerPath) return;
  try {
    const raw = await typedRpc('read_file_content', { file_path: host._compactionTrackerPath });
    const stripped = raw.replace(/^\s*\d+\t/gm, '');
    host.compactionTracker.deserializeState(stripped);
    const stats = host.compactionTracker.getStats(host.pricing);
    if (stats.events.length > 0) {
      log.info('agent', 'compaction tracker restored', {
        events: stats.events.length,
        filesRead: stats.filesReadPreCompact.size,
      });
    }
  } catch {
    /* 文件尚不存在 — 从零开始 */
  }
}

/** E5: 将 tracker 状态保存到磁盘。Best-effort，不抛异常。 */
async function saveCompactionTracker(host: CompactionHost): Promise<void> {
  if (!host._compactionTrackerPath) return;
  try {
    await typedRpc('write_file_content', {
      file_path: host._compactionTrackerPath,
      content: host.compactionTracker.serializeState(),
    });
  } catch {
    /* 尽力而为 */
  }
}

/** 尝试加载持久化的压缩配置。无保存则返回 null。 */
export async function loadCompactionConfigImpl(host: CompactionHost): Promise<CompactionConfig | null> {
  if (!host._compactionConfigPath) return null;
  try {
    const raw = await typedRpc('read_file_content', { file_path: host._compactionConfigPath });
    // 去除 cat -n 行号
    const stripped = raw.replace(/^\s*\d+\t/gm, '');
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/** 应用自动调优的压缩参数。返回应用的配置。 */
export async function applyAutoTuneConfigImpl(host: CompactionHost): Promise<CompactionConfig | null> {
  // E5: 先加载 tracker 状态，使调优有历史数据
  await loadCompactionTrackerImpl(host);
  const config = await loadCompactionConfigImpl(host);
  if (!config) return null;
  // 注意: 不要在这里修改 contextWindow — 它在 Agent 创建时
  // 从活跃模型派生。compactRatio/recentKeep 是无量纲的，
  // 适用于模型拥有的任何窗口。（旧的 `contextWindow = 1M` 硬编码
  // 在每个新 Agent 上静默覆盖了按模型的限制。）
  host.compactRatio = config.compactRatio;
  host.recentKeep = config.recentKeep;
  log.info('agent', 'auto-tune applied', {
    compactRatio: config.compactRatio,
    recentKeep: config.recentKeep,
    tunedAt: new Date(config.tunedAt).toISOString(),
    samples: config.sampleCount,
  });
  return config;
}

/** 检查是否有足够数据，若有则计算并持久化最优参数。
 *  每次压缩后调用。不抛异常 — best-effort 后台调优。 */
async function tryAutoTune(host: CompactionHost): Promise<void> {
  const result = maybeTune(
    host.compactionTracker,
    host.compactRatio,
    host.recentKeep,
    host.pricing,
    host.contextWindow,
  );
  if (!result?.changed) return;

  const { config } = result;
  log.info('agent', 'auto-tune recommendation', {
    compactRatio: config.compactRatio,
    recentKeep: config.recentKeep,
    samples: config.sampleCount,
    reasoning: config.reasoning,
  });

  host._sink({
    kind: EventKind.Notice,
    level: 'info',
    text: `[自动调优] ${config.reasoning}。参数已保存，下次会话生效。`,
  });

  // 持久化供下次会话使用
  if (host._compactionConfigPath) {
    try {
      await typedRpc('write_file_content', {
        file_path: host._compactionConfigPath,
        content: JSON.stringify(config, null, 2),
      });
    } catch {
      // 尽力而为
    }
  }
}

/** ponytail: 记录压缩事件 + 若为摘要结果则自动调优。
 *  集中 compactNow 和 triggerAutoCompact 中重复的模式。
 *  E5: 同时持久化 tracker 状态以在重启后存活。 */
function recordCompactionEvent(host: CompactionHost, event: CompactionEvent): void {
  host.compactionTracker.recordCompaction(event);
  // E5: 持久化 tracker 状态（事件 + filesRead）以跨会话存活
  void saveCompactionTracker(host);
  if (event.outcome === 'summary') void tryAutoTune(host);
}

/** 计算本次要折叠的中间区域。返回 null = 无可折叠内容（stuck）。
 *  区域 = session[foldPoint..tailStart]，foldPoint 是上次折叠点
 *  （首次压缩 = system 之后），tailStart 前保留最近 N 条消息 —
 *  每次压缩只处理"上次折叠后新增的消息"，摘要成本可控且累积正确。
 *  不拆分 tool-call 组: 若尾部以孤立的 tool 结果开始，将其拉入区域。 */
export function computeCompactRegionImpl(
  host: CompactionHost,
): { region: Message[]; tailStart: number; priorSummary: string | null } | null {
  const msgs = host.session;
  const head = foldHead(host);
  const tailCount = Math.max(4, host.recentKeep);
  const foldPoint = host._compactTailStart >= 0 ? Math.max(host._compactTailStart, head) : head;
  const regionEnd = msgs.length - tailCount;
  if (regionEnd - foldPoint <= 0) return null; // 无可折叠内容
  let tailStart = regionEnd;
  while (tailStart < msgs.length && msgs[tailStart].role === 'tool') tailStart++;
  const region = msgs.slice(foldPoint, tailStart);
  if (region.length === 0) return null;
  return { region, tailStart, priorSummary: host._compactSummary };
}

/** 应用折叠状态: 记录摘要 + 折叠点。session（完整历史）不变。 */
function applyCompactState(host: CompactionHost, tailStart: number, summary: string): void {
  host._compactSummary = summary;
  host._compactTailStart = tailStart;
  // session 可能已被 retract 缩短或替换 — 修正折叠点
  const head = foldHead(host);
  if (host._compactTailStart < head) host._compactTailStart = head;
  if (host._compactTailStart > host.session.length) host._compactTailStart = host.session.length;
  // Phase 5：压缩折叠事件（记录钳制后的最终边界 — 与投影侧二次钳制幂等）
  host._sessionLog.append('session/compaction', {
    summary,
    tailStart: host._compactTailStart,
  });
}

/** 手动压缩触发器（来自 /compact 命令）。返回摘要文本或错误。
 *  根治: 压缩只生成摘要并记录折叠点 — 不触碰 this.session（完整历史），
 *  不触发 sessionReplaced，不写盘 — UI 渲染与磁盘存档永远完整。 */
export async function compactNowImpl(host: CompactionHost, signal: AbortSignal): Promise<string> {
  if (host.compactRunning) throw new Error('compaction already in progress');
  host.compactRunning = true;
  try {
    const regionInfo = computeCompactRegionImpl(host);
    if (!regionInfo) {
      // 头尾之间无内容可折叠 — 不再永久闩锁（对话增长后自然可折叠），
      // 仅设置增长门槛，避免响应式路径在空区域上空转。
      host.compactRetryAfterLen = host.session.length + Math.max(4, host.recentKeep);
      recordCompactionEvent(host, {
        ts: Date.now(),
        regionMsgCount: 0,
        regionTokensEst: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        tailMsgCount: Math.max(0, host.session.length - foldHead(host)),
        preTokens: host.tokenCountWithEstimation(),
        postTokens: host.tokenCountWithEstimation(),
        outcome: 'stuck',
      });
      host._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: '对话太短，无法压缩。若上下文确实已满，请用 /new 开启新会话。',
      });
      return 'stuck';
    }
    const { region, tailStart, priorSummary } = regionInfo;
    let result: { text: string; degraded: boolean } | null = null;
    try {
      result = await summarizeRegionImpl(host, signal, region, priorSummary);
    } catch (e) {
      log.warn('agent', `summarizeRegion failed (${errMessage(e)})`);
    }
    if (!result?.text) {
      // 摘要失败 = 放弃本次压缩。历史保持完整，仅继续增长。
      // 根治: 绝不截断/删除历史消息。
      recordCompactionEvent(host, {
        ts: Date.now(),
        regionMsgCount: region.length,
        regionTokensEst: countMessages(region),
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        tailMsgCount: host.session.length - tailStart,
        preTokens: host.tokenCountWithEstimation(),
        postTokens: host.tokenCountWithEstimation(),
        outcome: 'stuck',
      });
      host._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: '压缩失败，本次跳过（完整历史仍保留）。可继续对话或用 /new 开启新会话。',
      });
      return 'stuck';
    }
    const summary = result.text;

    // 应用折叠状态 — session 不变，发送载荷变小
    applyCompactState(host, tailStart, summary);
    host.stormSig = '';
    host.stormCount = 0;
    host.compactStuck = false;
    host.compactRetryAfterLen = 0;
    host.compactFailCount = 0;

    // ── 压缩模型埋点 ──
    const preTokens = host.tokenCountWithEstimation();
    recordCompactionEvent(host, {
      ts: Date.now(),
      regionMsgCount: region.length,
      regionTokensEst: countMessages(region),
      summaryInputTokens: countMessages(region), // 近似值
      summaryOutputTokens: countText(summary),
      tailMsgCount: host.session.length - tailStart,
      preTokens,
      postTokens: host.tokenCountWithEstimation(),
      outcome: result.degraded ? 'digest' : 'summary',
    });
    host._sink({
      kind: EventKind.Notice,
      level: 'info',
      text: `上下文已压缩: ${region.length} 条消息 → 摘要 (保留最近 ${host.session.length - tailStart} 条，完整历史仍保留)`,
    });
    return summary;
  } finally {
    host.compactRunning = false;
  }
}

export function maybeCompactImpl(host: CompactionHost, usage: Usage | undefined): void {
  if (host.contextWindow <= 0) return;

  // 有 API 报告的 token 时优先使用，否则回退到估算。
  // 估算基于发送载荷（折叠视图），与真实 API 压力一致 —
  // 压缩成功后载荷变小，比例自然回落，不会反复触发。
  const estimated = usage && usage.total_tokens > 0 ? usage.total_tokens : host.tokenCountWithEstimation();
  const ratio = estimated / host.contextWindow;

  if (ratio < host.compactRatio) {
    host.compactStuck = false;
    host.compactFailCount = 0;
    return;
  }
  if (host.compactStuck) return;
  if (host.compactRunning) {
    host._sink({ kind: EventKind.Notice, level: 'info', text: '压缩已在运行中，跳过重复触发' });
    return;
  }
  // 退避门控: 空区域（对话太短）或失败后，session 未增长足够不重试。
  // 瞬时错误随对话增长自动自愈 — 没有永久闩锁。
  if (host.session.length < host.compactRetryAfterLen) return;
  host.compactRunning = true;

  // 自动压缩: 本轮后在后台生成摘要并更新折叠状态
  host._sink({
    kind: EventKind.Notice,
    level: 'info',
    text: `上下文使用率 ${(ratio * 100).toFixed(0)}% — 自动压缩中…`,
  });

  // 异步运行压缩（不阻塞当前轮次）
  const genAtStart = host._execState.bumpVersion();
  const regionInfo = computeCompactRegionImpl(host);
  if (!regionInfo) {
    // 无可折叠内容 — 不闩锁、不告警、不记录失败事件。
    // 对话继续增长后自然出现可折叠区域，设增长门槛后静默跳过。
    host.compactRetryAfterLen = host.session.length + Math.max(4, host.recentKeep);
    host.compactRunning = false;
    log.debug('agent', 'compact skipped: nothing to fold yet', {
      sessionLen: host.session.length,
      retryAfterLen: host.compactRetryAfterLen,
    });
    return;
  }

  const abortCtrl = new AbortController();
  summarizeRegionImpl(host, abortCtrl.signal, regionInfo.region, regionInfo.priorSummary)
    .then(({ text: summary, degraded }) => {
      if (genAtStart !== host._execState.sessionVersion) {
        host.compactRunning = false;
        return;
      } // 会话已替换，丢弃
      if (!summary) {
        host.compactRunning = false;
        return;
      }
      // 应用折叠 — session（完整历史）不变，载荷变小
      applyCompactState(host, regionInfo.tailStart, summary);
      host.stormSig = '';
      host.stormCount = 0;
      host.compactRetryAfterLen = 0;
      host.compactFailCount = 0;

      // 检查压缩是否足够 — 若折叠后载荷仍高于 95%，则已卡住
      // （尾部保留的消息本身就占满窗口 — 压缩确实无能为力，
      //  这是唯一合法的"卡死"，只有 /new 能解决）
      const postEstimate = host.tokenCountWithEstimation();
      if (postEstimate / host.contextWindow > 0.95) {
        host.compactStuck = true;
        host.compactRunning = false;
        host._sink({
          kind: EventKind.Notice,
          level: 'warn',
          text: `压缩后上下文仍占用 ${((postEstimate / host.contextWindow) * 100).toFixed(0)}%。建议用 /new 开启新会话。`,
        });
        return;
      }

      host.compactStuck = false;
      host.compactRunning = false;

      // ── 压缩模型埋点 ──
      recordCompactionEvent(host, {
        ts: Date.now(),
        regionMsgCount: regionInfo.region.length,
        regionTokensEst: countMessages(regionInfo.region),
        summaryInputTokens: countMessages(regionInfo.region),
        summaryOutputTokens: countText(summary),
        tailMsgCount: host.session.length - regionInfo.tailStart,
        preTokens: estimated,
        postTokens: postEstimate,
        outcome: degraded ? 'digest' : 'summary',
      });
      host._sink({
        kind: EventKind.Notice,
        level: 'info',
        text: `自动压缩完成: ${regionInfo.region.length} 条消息 → 摘要（完整历史仍保留）`,
      });
    })
    .catch((e) => {
      if (genAtStart !== host._execState.sessionVersion) {
        host.compactRunning = false;
        return;
      } // 会话已替换，丢弃
      // 失败不闩锁 — 退避重试：失败越多等越久（每级多等 4 条消息，封顶 16 条）。
      // summarizeRegion 内部已有机械摘要兜底，能走到这里的基本只剩
      // 用户中止与极端异常 — 静默退避，仅在逼近窗口上限且连续失败时升级。
      host.compactFailCount++;
      host.compactRunning = false;
      host.compactRetryAfterLen = host.session.length + Math.min(host.compactFailCount, 4) * 4;
      log.warn('agent', `auto-compact failed (${errMessage(e)}), backoff #${host.compactFailCount}`);
      if (host.compactFailCount >= 3 && estimated / host.contextWindow >= 0.9) {
        host._sink({
          kind: EventKind.Notice,
          level: 'warn',
          text: '上下文已接近窗口上限，且自动压缩连续多次失败。建议用 /new 开启新会话。',
        });
      }
    });
}

/** 对消息区域生成摘要 — map-reduce 分块管线。
 *
 *  硬保证（不存在"塞爆"这个状态）：
 *    每次 LLM 调用的输入 ≤ prompt(≤SUMMARY_PROMPT_BUDGET) + chunkCap，
 *    输出 ≤ SUMMARY_OUTPUT_BUDGET，两者之和严格小于摘要模型窗口；
 *    窗口连最低可行条件都不满足的模型直接走机械摘要，不调 LLM。
 *
 *  降级阶梯（任何环节失败只降质量，管线永不闩死）：
 *    LLM 全量摘要 > 部分块机械提取 > 纯机械提取。
 *
 *  @param priorSummary 来自上次 `<compacted-context>` 块的内容，用于
 *    与新区域合并（累积压缩），若为首次压缩则为 null。
 *  @returns text = 摘要文本；degraded = 是否有环节降级为机械提取 */
export async function summarizeRegionImpl(
  host: CompactionHost,
  signal: AbortSignal,
  msgs: Message[],
  priorSummary: string | null = null,
): Promise<{ text: string; degraded: boolean }> {
  // priorSummary 防御性截断 — 理论上每轮 LLM 输出 ≤ 摘要预算不会无限涨，
  // 但手工编辑/旧版本数据可能异常，超限时保留头部
  if (priorSummary && countText(priorSummary) > SUMMARY_PROMPT_BUDGET - 1000) {
    priorSummary = priorSummary.slice(0, (SUMMARY_PROMPT_BUDGET - 1000) * 4);
  }

  const { window } = await summaryProviderImpl(host);
  const inputBudget = window - SUMMARY_OUTPUT_BUDGET - SUMMARY_PROMPT_BUDGET;
  if (inputBudget < SUMMARY_MIN_INPUT) {
    log.warn('agent', `summary model window too small (${window}) — 走机械摘要`);
    return { text: digestMessages(msgs, host.tools), degraded: true };
  }
  const chunkCap = Math.floor(inputBudget * 0.8);
  const chunks = chunkMessages(msgs, chunkCap);

  // 单块 — 与旧行为一致：一次调用，priorSummary 直接嵌入 prompt
  if (chunks.length <= 1) {
    try {
      const text = await callSummaryLLMImpl(host, signal, buildSummaryPrompt(priorSummary), renderTranscript(msgs));
      if (!text) throw new Error('empty summary');
      return { text, degraded: false };
    } catch (e) {
      if (signal.aborted) throw e; // 用户中止 — 不兜底，直接传播
      log.warn('agent', `summarize LLM failed (${errMessage(e)}) — 降级为机械摘要`);
      return { text: digestMessages(msgs), degraded: true };
    }
  }

  // 多块 — map-reduce。块数超上限时最老的块直接机械消化，
  // LLM 预算只花在最新内容上（成本与时延封顶）。
  const partials: string[] = [];
  let degraded = false;
  let startIdx = 0;
  if (chunks.length > SUMMARY_MAX_LLM_CHUNKS) {
    const oldMsgs = chunks.slice(0, chunks.length - SUMMARY_MAX_LLM_CHUNKS).flat();
    partials.push('## 早期历史（机械提取）\n' + digestMessages(oldMsgs, host.tools));
    startIdx = chunks.length - SUMMARY_MAX_LLM_CHUNKS;
    degraded = true;
  }
  for (let i = startIdx; i < chunks.length; i++) {
    try {
      const text = await callSummaryLLMImpl(
        host,
        signal,
        buildSummaryPrompt(null, { index: i + 1, total: chunks.length }),
        renderTranscript(chunks[i]),
      );
      if (!text) throw new Error('empty summary');
      partials.push(text);
    } catch (e) {
      if (signal.aborted) throw e;
      log.warn('agent', `chunk ${i + 1}/${chunks.length} summary failed (${errMessage(e)}) — 该块机械提取`);
      partials.push(digestMessages(chunks[i], host.tools));
      degraded = true;
    }
  }
  // mergePartials 只报告合并阶段的降级 — 块阶段的降级必须透传
  const merged = await mergePartialsImpl(host, signal, priorSummary, partials, chunkCap);
  return { text: merged.text, degraded: degraded || merged.degraded };
}

/** 缓存的摘要模型选择。 */
export async function summaryProviderImpl(host: CompactionHost): Promise<{ prov: Provider; window: number }> {
  if (!host._summaryProv) host._summaryProv = await selectSummaryProviderImpl(host);
  return host._summaryProv;
}

/** 运行时自动选择摘要模型 — 无用户配置项。
 *  规则：已配置 key 覆盖的模型中，窗口 ≥ SUMMARY_MIN_WINDOW 且
 *  输入价严格低于主模型者，取价格最低（窗口大者破平）。
 *  主模型自己参与竞选 — 没有严格占优的候选时维持现状。
 *  只可能在"窗口不小、价格更低"时偏离主模型，永远不会让事情变糟。
 *  ⚡ 2026-08-07 修复：必须走 loadSettingsWithSecrets()——localStorage 不落
 *  key，裸 loadSettings() 让 keyed 永远为空，本特性从未触发过。 */
export async function selectSummaryProviderImpl(host: CompactionHost): Promise<{ prov: Provider; window: number }> {
  const fallback = { prov: host.prov, window: host.contextWindow };
  try {
    const s = await loadSettingsWithSecrets();
    const active = s.providers.find((p) => p.name === s.activeProvider);
    if (!active) return fallback;
    const all = getAllModels();
    const main = all.find((m) => m.id === active.model);
    const mainWindow = main && main.contextWindow > 0 ? main.contextWindow : host.contextWindow;
    const mainCost = main?.cost?.input ?? Infinity;
    const keyed = new Map(s.providers.filter((p) => p.apiKey?.trim()).map((p) => [p.name, p]));
    const winner = all
      .filter(
        (m) =>
          m.id !== active.model &&
          keyed.has(m.vendor) &&
          m.contextWindow >= SUMMARY_MIN_WINDOW &&
          (m.cost?.input ?? 0) > 0 &&
          (m.cost?.input ?? Infinity) < mainCost,
      )
      .sort((a, b) => a.cost.input - b.cost.input || b.contextWindow - a.contextWindow)[0];
    if (!winner) return { prov: host.prov, window: mainWindow };
    const ps = keyed.get(winner.vendor);
    if (!ps) return { prov: host.prov, window: mainWindow };
    const prov = createProvider({ ...ps, model: winner.id, thinking: '' }, { disableThinking: true });
    log.info('agent', 'summary model auto-selected', {
      model: winner.id,
      window: winner.contextWindow,
      costIn: winner.cost.input,
      mainModel: active.model,
    });
    return { prov, window: winner.contextWindow };
  } catch (e) {
    log.warn('agent', `summary model selection failed (${errMessage(e)}) — 使用主模型`);
    return fallback;
  }
}

/** 单次摘要 LLM 调用 — 30s 空闲超时守卫（挂起判定，streamWithIdleTimeout），
 *  流仍在产出就让它跑完。max_tokens 固定为输出预算，
 *  配合 chunkCap 构成"永不塞爆"的输入/输出硬上界。 */
export async function callSummaryLLMImpl(
  host: CompactionHost,
  signal: AbortSignal,
  systemPrompt: string,
  userText: string,
): Promise<string> {
  const { prov } = await summaryProviderImpl(host);
  const stream = streamWithIdleTimeout(prov, signal, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    tools: [], // 摘要不需要工具
    temperature: 0.3, // 低温用于事实性摘要
    max_tokens: SUMMARY_OUTPUT_BUDGET,
  });

  try {
    let text = '';
    for await (const chunk of stream.chunks) {
      if (chunk.type === ChunkType.Text && chunk.text) {
        text += chunk.text;
      }
      if (chunk.type === ChunkType.Error) throw chunk.err ?? new Error('stream error');
    }
    return text.trim();
  } catch (e) {
    if (stream.idleTimedOut && !signal.aborted) {
      log.warn('agent', 'summary LLM call stalled (30s no output) — 该次调用放弃');
    }
    throw e;
  }
}

/** 滚动合并分段摘要（含 priorSummary）— 每轮把尽量多段塞进
 *  budgetTokens 内合并为一，直到只剩一段。合并调用失败时
 *  降级为直接拼接（结构化文本拼接本身就是及格的简报）。 */
export async function mergePartialsImpl(
  host: CompactionHost,
  signal: AbortSignal,
  priorSummary: string | null,
  partials: string[],
  budgetTokens: number,
): Promise<{ text: string; degraded: boolean }> {
  let texts = [...(priorSummary ? [`<previous-summary>\n${priorSummary}\n</previous-summary>`] : []), ...partials];
  let degraded = false;
  while (texts.length > 1) {
    const group = [texts[0], texts[1]];
    let rest = texts.slice(2);
    while (rest.length && countText(group.join('\n\n---\n\n') + '\n\n---\n\n' + rest[0]) <= budgetTokens) {
      group.push(rest[0]);
      rest = rest.slice(1);
    }
    try {
      const merged = await callSummaryLLMImpl(host, signal, buildMergePrompt(), group.join('\n\n---\n\n'));
      if (!merged) throw new Error('empty merge');
      texts = [merged, ...rest];
    } catch (e) {
      if (signal.aborted) throw e;
      log.warn('agent', `merge round failed (${errMessage(e)}) — 降级为拼接`);
      texts = [group.join('\n\n---\n\n'), ...rest];
      degraded = true;
    }
  }
  let final = texts[0] ?? '';
  // 防御性封顶 — 拼接路径下摘要可能超长
  if (countText(final) > 8192) final = final.slice(0, 32768) + '\n…(过长摘要已截断)';
  return { text: final, degraded };
}

/** catch(e) unknown 取消息（对齐旧 e?.message || e 语义）。 */
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return String(e);
}

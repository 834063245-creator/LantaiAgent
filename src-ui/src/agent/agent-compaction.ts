// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 上下文压缩域 — 折叠状态机 / 触发判定 / 摘要管线调度 / 自动调优。
// 从 agent.ts 机械搬移（11c），零逻辑改动。
// 宿主模式：Agent 类经受控转换（as unknown as CompactionHost）传入本模块。

import { streamWithIdleTimeout } from '../provider/idle-stream';
import type { Message, Provider, Usage } from '../provider/types';
import { ChunkType } from '../provider/types';
import { kernelReadFile, kernelWriteFile } from '../rpc-contract';
import { type AgentEvent, EventKind } from './agent-types';
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
  SUMMARY_PROMPT_BUDGET,
} from './compaction-summarize';
import type { ExecStateInstance } from './execution-state';
import { log } from './logger';
import { buildCompactedSummaryMessage } from './session-log';
import { countMessage, countMessages, countText } from './token-counter';
import type { ToolRegistry } from './tool';
import { foldToolResults, nextFoldBoundary } from './tool-fold';

/** 压缩域对宿主 Agent 的最小状态面（成员与 Agent 类声明逐字对齐）。 */
export interface CompactionHost {
  readonly session: Message[];
  readonly prov: Provider;
  readonly tools: ToolRegistry;
  readonly contextWindow: number;
  readonly compactionTracker: CompactionTracker;
  readonly _execState: ExecStateInstance;
  _sink: (ev: AgentEvent) => void;
  compactRatio: number;
  recentKeep: number;
  /** 自动压缩尾部保留的 token 预算比例（占 contextWindow；0 缺省用
   *  DEFAULT_RETAIN_RATIO）。手动 /compact 不消费它（保留 recentKeep 条）。 */
  retainRatio: number;
  /** 摘要调用的输出上限（token）——缺省 SUMMARY_OUTPUT_BUDGET；
   *  配置面 = .lantai/compaction-config.json 的 summaryMaxTokens。 */
  summaryMaxTokens: number;
  compactStuck: boolean;
  compactRetryAfterLen: number;
  compactFailCount: number;
  compactRunning: boolean;
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

// ── 摘要调用账（cap + usage）──
// 2026-09-23：摘要调用的 usage 此前被整条丢弃（只收 Text 块），发出的 cap 也无处可查
// ——「摘要为什么返回空」只能猜。下列形状对齐 DSH `SummaryResult`（provider/model/
// maxTokens/usage）；本仓摘要模型恒为主模型，provider/model 不入账。

/** 单次摘要调用的产物。usage 缺省 = 提供方未回报（该次调用不可归因）。 */
export interface SummaryCall {
  text: string;
  /** 写进本次请求的输出上限（= 摘要 cap；适配器另按模型 maxTokens 钳制） */
  maxTokens: number;
  usage?: Usage;
}

/** 摘要区段（summarizeRegion / mergePartials）的产物。 */
export interface SummaryRun {
  text: string;
  /** 有环节降级为机械提取 / 拼接（机械提取是兜底，但降级必须可见且可归因） */
  degraded: boolean;
  /** 降级原因（degraded=true 时非空） */
  failure?: string;
  /** 本次区段的全部调用账（**含失败那次** —— 空返回的 usage 正是归因核心） */
  calls: SummaryCall[];
}

/** cap/usage 单行摘要 —— 日志与错误消息共用同一口径（不两处各写一份）。 */
function capStats(call: SummaryCall): string {
  const u = call.usage;
  const parts = [`max_tokens=${call.maxTokens}`];
  if (u) {
    parts.push(
      `finish_reason=${u.finish_reason || '未知'}`,
      `completion=${u.completion_tokens}`,
      `reasoning=${u.reasoning_tokens}`,
    );
  } else {
    parts.push('usage 未回报');
  }
  parts.push(`text_chars=${call.text.length}`);
  return parts.join(', ');
}

/** 撞输出上限判据：① 提供方 finish_reason='length'（协议直给）；
 *  ② completion 用满发出的 cap —— openai 兼容方言的 usage 独立帧不带
 *  finish_reason（适配器在该帧只能置 'stop'），缺了这条真机上「撞 cap」不可判。 */
function hitOutputCap(call: SummaryCall): boolean {
  if (call.usage?.finish_reason === 'length') return true;
  return call.usage !== undefined && call.usage.completion_tokens >= call.maxTokens;
}

/** 摘要调用的 fail-closed 判据（对齐 DSH `summarizer.ts` 的 `finishError` +
 *  空文本报错）：撞 cap = 检查点不完整（截断的残稿不许当摘要用），
 *  空文本 = 提供方没产出可用文本。两者都抛 —— 由调用方降级为机械提取并**明说原因**。 */
function assertUsableSummary(call: SummaryCall, label = 'summary'): void {
  if (hitOutputCap(call)) throw new Error(`${label} truncated at the token cap (${capStats(call)})`);
  if (!call.text) throw new Error(`empty ${label} (${capStats(call)})`);
}

/** 降级原因汇总（去重 + 封顶 —— 8 块全失败时不写成 8 份同样的理由）。 */
function failureText(reasons: string[]): { failure?: string } {
  const uniq = [...new Set(reasons.filter((r) => r.length > 0))];
  if (uniq.length === 0) return {};
  const text = uniq.join(' | ');
  return { failure: text.length > 400 ? `${text.slice(0, 400)}…` : text };
}

/** 调用账 → 事件账字段（真 usage 单独入账 summaryUsage；summaryInput/OutputTokens
 *  保持原有本地估算口径 —— 两者不混账）。 */
function meteringOf(
  host: CompactionHost,
  run: { calls: SummaryCall[]; failure?: string },
): Pick<CompactionEvent, 'summaryCalls' | 'summaryMaxTokens' | 'summaryUsage' | 'summaryError'> {
  const reported = run.calls.filter((c) => c.usage !== undefined);
  const sum = (pick: (u: Usage) => number) => reported.reduce((acc, c) => acc + pick(c.usage as Usage), 0);
  return {
    summaryCalls: run.calls.length,
    summaryMaxTokens: host.summaryMaxTokens,
    ...(reported.length === 0
      ? {}
      : {
          summaryUsage: {
            calls: reported.length,
            promptTokens: sum((u) => u.prompt_tokens),
            completionTokens: sum((u) => u.completion_tokens),
            reasoningTokens: sum((u) => u.reasoning_tokens),
            cacheHitTokens: sum((u) => u.cache_hit_tokens),
          },
        }),
    ...(run.failure ? { summaryError: run.failure } : {}),
  };
}

/** 块进度文案 —— 摘要长杆是**一次** LLM 调用，调用内没有可读百分比：
 *  诚实的真进度只有「第 i/N 块 + 已用秒数」，约 30 秒一跳。 */
function chunkDoneText(index: number, total: number, startedAt: number): string {
  return `压缩中 · 第 ${index}/${total} 块完成（用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s）`;
}

/** token 数的人类读数 —— 压前/压后**同口径**（千分位），不混「万」与裸数字。 */
function fmtTokens(n: number): string {
  return n.toLocaleString();
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
    const raw = await kernelReadFile(host._compactionTrackerPath);
    host.compactionTracker.deserializeState(raw);
    const stats = host.compactionTracker.getStats();
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
    await kernelWriteFile(host._compactionTrackerPath, host.compactionTracker.serializeState());
  } catch {
    /* 尽力而为 */
  }
}

/** 尝试加载持久化的压缩配置。无保存则返回 null。 */
export async function loadCompactionConfigImpl(host: CompactionHost): Promise<CompactionConfig | null> {
  if (!host._compactionConfigPath) return null;
  try {
    const raw = await kernelReadFile(host._compactionConfigPath);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 摘要 cap 的可接受面：有限数且 ≥ 256 —— 低于此值连标题都写不完，
 *  视作坏配置回退缺省（不静默接受垃圾值）。 */
const MIN_SUMMARY_MAX_TOKENS = 256;

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
  // 摘要输出上限（2026-09-23）：压缩配置里手写的 summaryMaxTokens 生效。
  // 缺省 / 坏值 = 保持 SUMMARY_OUTPUT_BUDGET（8192，对齐 DSH）。
  const cap = config.summaryMaxTokens;
  if (typeof cap === 'number' && Number.isFinite(cap) && cap >= MIN_SUMMARY_MAX_TOKENS) {
    host.summaryMaxTokens = Math.floor(cap);
  }
  log.info('agent', 'auto-tune applied', {
    compactRatio: config.compactRatio,
    recentKeep: config.recentKeep,
    summaryMaxTokens: host.summaryMaxTokens,
    tunedAt: new Date(config.tunedAt).toISOString(),
    samples: config.sampleCount,
  });
  return config;
}

/** 检查是否有足够数据，若有则计算并持久化最优参数。
 *  每次压缩后调用。不抛异常 — best-effort 后台调优。 */
async function tryAutoTune(host: CompactionHost): Promise<void> {
  const result = maybeTune(host.compactionTracker, host.compactRatio, host.recentKeep, host.contextWindow);
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

  // 持久化供下次会话使用（summaryMaxTokens 是手写配置面 —— 透传保留，
  // 别让自动调优把用户的 cap 顺手写没）。
  if (host._compactionConfigPath) {
    try {
      await kernelWriteFile(
        host._compactionConfigPath,
        JSON.stringify({ ...config, summaryMaxTokens: host.summaryMaxTokens }, null, 2),
      );
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

/** 自动压缩的尾部保留起点：从尾部往回累计 token 到 retainRatio×窗口预算，
 *  返回**保留尾部**的起点 index（含），起点前的内容进压缩区域。
 *  尾部起点钳制到最近完整 user 回合（user 消息及其后所有 assistant/tool
 *  同属一个回合，不拆开）。
 *
 *  对齐 DSH retainRatio(0.16) 经济模型：工具密集会话里模型手里必须保留
 *  足够近期工作现场（token 预算），而不是旧实现的固定 recentKeep 条数。
 *  手动 /compact 不走此路径 — 它保留 recentKeep 条（见 computeCompactRegionImpl）。
 *
 *  与 DSH selectCompactableRange 同语义：foldPoint 之后全部内容累计仍
 *  不足预算（会话太短）→ 返回 null（不压，等对话增长）— 触发线 80% 压力
 *  下内容必远大于 16% 预算，此分支只在测试构造 / 极端小载荷时命中。
 *  ⚡ 2026-09-23：另有两条 null 出口——单轮工具循环比预算还大时退到预算位置后
 *  无处可退（边界落在 foldPoint / 尾部会空），见函数内注。 */
function autoTailStart(host: CompactionHost, foldPoint: number): number | null {
  const msgs = host.session;
  const budget = Math.max(1, Math.floor(host.contextWindow * host.retainRatio));
  let acc = 0;
  // 已扫过的最靠后完整 user 回合起点 — 达标时从它开始保留尾部。
  let lastUser = -1;
  let reachedBudget = false;
  let i = msgs.length - 1;
  for (; i > foldPoint; i--) {
    acc += countMessage(msgs[i]);
    if (msgs[i].role === 'user') lastUser = i;
    if (acc >= budget) {
      reachedBudget = true;
      break;
    }
  }
  if (!reachedBudget) return null; // 会话太短 — 不足保留预算，无可压价值
  if (lastUser > foldPoint) return lastUser;
  // 单轮工具循环比尾部预算还大：从尾部往回扫到预算位置，**一个 user 消息都没经过**
  // ——「保留完整 user 回合」这条判据在此无解（案卷 35 实测：1 条用户消息 + 54 步
  // 工具循环 ≈ 80 万 token，而预算 = 1M×0.16 = 16 万 ⇒ 此前一路返回 null，压缩每步
  // 空转 16 次直到撞窗口）。退到**预算位置**，再把边界向前滚过孤立的 tool 结果：
  // 尾部不以 tool 开头（不拆 tool-call 组，与手动路径同规），近期现场仍按预算保留；
  // 「保留整轮」退化为「保留预算内的最近工具组」是可压与不可压之间唯一的安全落点。
  let fallback = i;
  while (fallback < msgs.length && msgs[fallback].role === 'tool') fallback++;
  if (fallback <= foldPoint || fallback >= msgs.length) return null; // 无可折叠 / 尾部会空
  return fallback;
}

/** 计算本次要折叠的中间区域。返回 null = 无可折叠内容（stuck）。
 *  区域 = session[foldPoint..tailStart]，foldPoint 是上次折叠点
 *  （首次压缩 = system 之后），tailStart 前保留最近消息 —
 *  每次压缩只处理"上次折叠后新增的消息"，摘要成本可控且累积正确。
 *  @param mode 'auto' = 自动（step 前预检）路径：尾部按 retainRatio token
 *    预算保留完整 user 回合；'manual' = 手动 /compact：保留 recentKeep 条
 *    完整消息（现状语义）。二者都不拆 tool-call 组。 */
export function computeCompactRegionImpl(
  host: CompactionHost,
  mode: 'auto' | 'manual' = 'manual',
): { region: Message[]; tailStart: number; priorSummary: string | null } | null {
  const msgs = host.session;
  const head = foldHead(host);
  const foldPoint = host._compactTailStart >= 0 ? Math.max(host._compactTailStart, head) : head;
  let tailStart: number;
  if (mode === 'auto') {
    const t = autoTailStart(host, foldPoint);
    if (t === null) return null;
    tailStart = t;
  } else {
    const tailCount = Math.max(4, host.recentKeep);
    const regionEnd = msgs.length - tailCount;
    if (regionEnd - foldPoint <= 0) return null; // 无可折叠内容
    tailStart = regionEnd;
    // 尾部以孤立的 tool 结果开头 → 拉进区域（现状语义：不把断腿结果留给模型）
    while (tailStart < msgs.length && msgs[tailStart].role === 'tool') tailStart++;
  }
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
  return runCompactionImpl(host, signal, 'manual');
}

/** 自动压缩入口（step 前 pre-flight 调用）— 与手动路径同管线，但尾部按
 *  retainRatio token 预算保留完整 user 回合（见 computeCompactRegionImpl
 *  'auto' 模式）。返回摘要文本或 'stuck'。 */
export async function compactIfNeededImpl(host: CompactionHost, signal: AbortSignal): Promise<string> {
  return runCompactionImpl(host, signal, 'auto');
}

/** 压缩管线主体（手动与自动共用）：算区域 → LLM/机械摘要 → 应用折叠状态。
 *  失败/无可折叠一律不截历史，记 stuck 事件 + 退避门槛后返回 'stuck'。
 *  摘要成本防护（硬校验）在自动路径启用：摘要+保留尾 ≥ 压缩前估算则
 *  不落地 —— 防"压了没变小还费一次 LLM"（对齐 DSH summary 必须小于
 *  shadowed content 的 shrink 校验；手动 /compact 是用户显式动作，失败
 *  记 stuck 提示 /new 即可）。 */
export async function runCompactionImpl(
  host: CompactionHost,
  signal: AbortSignal,
  mode: 'auto' | 'manual',
): Promise<string> {
  if (host.compactRunning) throw new Error('compaction already in progress');
  host.compactRunning = true;
  try {
    const regionInfo = computeCompactRegionImpl(host, mode);
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
    let result: SummaryRun | null = null;
    let hardFailure: string | undefined;
    try {
      result = await summarizeRegionImpl(host, signal, region, priorSummary);
    } catch (e) {
      hardFailure = errMessage(e);
      log.warn('agent', `summarizeRegion failed (${hardFailure})`);
    }
    if (!result?.text) {
      // 摘要失败 = 放弃本次压缩。历史保持完整，仅继续增长。
      // 根治: 绝不截断/删除历史消息。（原因随通知/事件账可见 —— 失败不许静默）
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
        ...(result ? meteringOf(host, result) : hardFailure ? { summaryError: hardFailure } : {}),
      });
      host._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `压缩失败，本次跳过（完整历史仍保留）。${hardFailure ? `原因：${hardFailure}。` : ''}可继续对话或用 /new 开启新会话。`,
      });
      return 'stuck';
    }
    const summary = result.text;

    // ── 摘要成本防护（硬校验，自动路径）──
    // 摘要 + 保留尾 ≥ 压缩前载荷估算 → 本次压缩不落地（记 stuck，历史不动）。
    // 对齐 DSH「summary 必须小于被遮蔽内容」的 shrink 校验；防自动压缩
    // 在尾预算过大 / 摘要退化时"压了没变小还白费一次 LLM"。手动 /compact
    // 是用户显式动作，不做此拦截（stuck 提示已足够）。
    const preEstimate = host.tokenCountWithEstimation();
    if (mode === 'auto') {
      // 压后载荷 = head(≈估算 − 区域内 token) + 摘要 + 保留尾 + schema/transient。
      // 用「压后 ≈ 原载荷 − 区域 + 摘要」的线性近似；摘要退化到接近区域时
      // 此式会接近原值甚至更大 → 拦截。
      const summaryTokens = countText(summary);
      const postApprox = preEstimate - countMessages(region) + summaryTokens;
      if (postApprox >= preEstimate) {
        recordCompactionEvent(host, {
          ts: Date.now(),
          regionMsgCount: region.length,
          regionTokensEst: countMessages(region),
          summaryInputTokens: countMessages(region),
          summaryOutputTokens: summaryTokens,
          tailMsgCount: host.session.length - tailStart,
          preTokens: preEstimate,
          postTokens: preEstimate,
          outcome: 'stuck',
          ...meteringOf(host, result),
        });
        host._sink({
          kind: EventKind.Notice,
          level: 'warn',
          text: '压缩未能减少上下文（摘要不小于被压缩内容），本次跳过。建议用 /new 开启新会话。',
        });
        return 'stuck';
      }
    }

    // 应用折叠状态 — session 不变，发送载荷变小
    applyCompactState(host, tailStart, summary);
    host.stormSig = '';
    host.stormCount = 0;
    host.compactStuck = false;
    host.compactRetryAfterLen = 0;
    host.compactFailCount = 0;

    // ── 压缩模型埋点 ──
    // preTokens = 折叠**前**的载荷估算（preEstimate，上面已测）；旧实现两次都在
    // applyCompactState 之后取，两个读数恒等 —— 事件账里的压缩比因此恒 0%。
    const postTokens = host.tokenCountWithEstimation();
    recordCompactionEvent(host, {
      ts: Date.now(),
      regionMsgCount: region.length,
      regionTokensEst: countMessages(region),
      summaryInputTokens: countMessages(region), // 近似值（真 usage 见 summaryUsage）
      summaryOutputTokens: countText(summary),
      tailMsgCount: host.session.length - tailStart,
      preTokens: preEstimate,
      postTokens,
      outcome: result.degraded ? 'digest' : 'summary',
      ...meteringOf(host, result),
    });
    host._sink({
      kind: EventKind.Notice,
      level: 'info',
      text: `上下文已压缩: ${region.length} 条消息 → ${result.degraded ? '机械摘要（LLM 摘要降级）' : '摘要'} (保留最近 ${
        host.session.length - tailStart
      } 条，完整历史仍保留)；压前 ${fmtTokens(preEstimate)} → 压后 ${fmtTokens(postTokens)}`,
    });
    return summary;
  } finally {
    host.compactRunning = false;
  }
}

/** ⚠️ 退役中的异步自动压缩入口（2026-09 迭代）。
 *  出厂 default-loop 已弃用它（自动压缩主触发前移到 step 头同步 pre-flight，
 *  见 default-loop.ts）——保留函数与宿主面成员有两个原因：
 *    ① AgentLoopHost 是开放替换契约，第三方 loop 可能仍靠它在轮末按 usage
 *      异步触发；
 *    ② compaction-pipeline 测试 #5/#6/#7 直调它验证异步飞行语义（版本守卫 /
 *      增长自愈 / 会话替换丢弃）。
 *  新代码不应新增调用点；语义与 compactIfNeededImpl('auto') 等价但异步。 */
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
  const regionInfo = computeCompactRegionImpl(host, 'auto');
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
    .then((run) => {
      const { text: summary, degraded } = run;
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
        ...meteringOf(host, run),
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
 *    输出 ≤ host.summaryMaxTokens，两者之和严格小于摘要模型窗口；
 *    窗口连最低可行条件都不满足的模型直接走机械摘要，不调 LLM。
 *
 *  降级阶梯（任何环节失败只降质量，管线永不闩死）：
 *    LLM 全量摘要 > 部分块机械提取 > 纯机械提取。
 *  降级**不静默**（2026-09-23）：每个块/合并环节的失败都发一条 warn 通知说清原因
 *  （撞 cap / 空文本 / 提供方错误），并把原因与调用账写进 CompactionEvent。
 *
 *  @param priorSummary 来自上次 `<compacted-context>` 块的内容，用于
 *    与新区域合并（累积压缩），若为首次压缩则为 null。
 *  @returns text = 摘要文本；degraded = 是否有环节降级为机械提取；
 *    failure = 降级原因；calls = 本次区段的调用账（cap + usage） */
export async function summarizeRegionImpl(
  host: CompactionHost,
  signal: AbortSignal,
  msgs: Message[],
  priorSummary: string | null = null,
): Promise<SummaryRun> {
  // priorSummary 防御性截断 — 理论上每轮 LLM 输出 ≤ 摘要预算不会无限涨，
  // 但手工编辑/旧版本数据可能异常，超限时保留头部
  if (priorSummary && countText(priorSummary) > SUMMARY_PROMPT_BUDGET - 1000) {
    priorSummary = priorSummary.slice(0, (SUMMARY_PROMPT_BUDGET - 1000) * 4);
  }

  const outputBudget = host.summaryMaxTokens;
  const { window } = await summaryProviderImpl(host);
  const inputBudget = window - outputBudget - SUMMARY_PROMPT_BUDGET;
  if (inputBudget < SUMMARY_MIN_INPUT) {
    log.warn('agent', `summary model window too small (${window}) — 走机械摘要`);
    return {
      text: digestMessages(msgs, host.tools),
      degraded: true,
      failure: `摘要模型窗口 ${window} 装不下 cap ${outputBudget} + 输入下限 ${SUMMARY_MIN_INPUT}`,
      calls: [],
    };
  }
  const chunkCap = Math.floor(inputBudget * 0.8);
  const chunks = chunkMessages(msgs, chunkCap);
  const calls: SummaryCall[] = [];
  const failures: string[] = [];

  // 进度首拍（2026-09-23 用户要求）：压缩期间此前 1–3 分钟毫无提示，像挂死。
  // 诚实约束：百分比做不了（一块 = 一次 LLM 调用，调用内无可读进度），
  // 真进度只有「共 N 块」+ 每块的用时。
  host._sink({
    kind: EventKind.Notice,
    level: 'info',
    text: `压缩中 · 共 ${chunks.length} 块（约 ${(countMessages(msgs) / 10_000).toFixed(1)} 万 token）`,
  });

  // 单块 — 与旧行为一致：一次调用，priorSummary 直接嵌入 prompt
  if (chunks.length <= 1) {
    const startedAt = Date.now();
    try {
      const call = await callSummaryLLMImpl(host, signal, buildSummaryPrompt(priorSummary), renderTranscript(msgs));
      calls.push(call);
      assertUsableSummary(call);
      host._sink({ kind: EventKind.Notice, level: 'info', text: chunkDoneText(1, 1, startedAt) });
      return { text: call.text, degraded: false, calls };
    } catch (e) {
      if (signal.aborted) throw e; // 用户中止 — 不兜底，直接传播
      const reason = errMessage(e);
      log.warn('agent', `summarize LLM failed (${reason}) — 降级为机械摘要`);
      host._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `压缩降级 · ${reason} —— 本次改用机械提取（完整历史仍保留）`,
      });
      return { text: digestMessages(msgs), degraded: true, failure: reason, calls };
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
    const startedAt = Date.now();
    try {
      const call = await callSummaryLLMImpl(
        host,
        signal,
        buildSummaryPrompt(null, { index: i + 1, total: chunks.length }),
        renderTranscript(chunks[i]),
      );
      calls.push(call);
      assertUsableSummary(call);
      partials.push(call.text);
      host._sink({ kind: EventKind.Notice, level: 'info', text: chunkDoneText(i + 1, chunks.length, startedAt) });
    } catch (e) {
      if (signal.aborted) throw e;
      const reason = errMessage(e);
      log.warn('agent', `chunk ${i + 1}/${chunks.length} summary failed (${reason}) — 该块机械提取`);
      host._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `压缩中 · 第 ${i + 1}/${chunks.length} 块失败（${reason}）—— 该块改用机械提取`,
      });
      partials.push(digestMessages(chunks[i], host.tools));
      failures.push(reason);
      degraded = true;
    }
  }
  // mergePartials 只报告合并阶段的降级 — 块阶段的降级必须透传
  const merged = await mergePartialsImpl(host, signal, priorSummary, partials, chunkCap);
  return {
    text: merged.text,
    degraded: degraded || merged.degraded,
    ...failureText([...failures, ...(merged.failure ? [merged.failure] : [])]),
    calls: [...calls, ...merged.calls],
  };
}

/**
 * 摘要模型解析 — 固定使用主模型（host.prov + host.contextWindow）。
 * ⚡ 2026-09-06 价格表拆除：旧的「自动选择更便宜的 keyed 模型」逻辑退役——
 * 不再维护每模型价格后没有客观的「更便宜」，跨家选摘要模型失去依据；
 * 摘要本就是主模型同一前缀下的补充调用，用主模型可复用热前缀。
 */
export async function summaryProviderImpl(host: CompactionHost): Promise<{ prov: Provider; window: number }> {
  return { prov: host.prov, window: host.contextWindow };
}

/** 单次摘要 LLM 调用 — 30s 空闲超时守卫（挂起判定，streamWithIdleTimeout），
 *  流仍在产出就让它跑完。max_tokens = host.summaryMaxTokens（缺省 8192），
 *  配合 chunkCap 构成"永不塞爆"的输入/输出硬上界。
 *
 *  usage 与发出的 cap 全部入账（2026-09-23）：此前只收 Text 块、usage 被整条丢弃
 *  ——「摘要为什么返回空」在真机上不可判。空文本**不在这里抛**（调用账要能被
 *  调用方收下再判），fail-closed 判据在 assertUsableSummary。 */
export async function callSummaryLLMImpl(
  host: CompactionHost,
  signal: AbortSignal,
  systemPrompt: string,
  userText: string,
): Promise<SummaryCall> {
  const { prov } = await summaryProviderImpl(host);
  const maxTokens = host.summaryMaxTokens;
  const startedAt = Date.now();
  const stream = streamWithIdleTimeout(prov, signal, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    tools: [], // 摘要不需要工具
    temperature: 0.3, // 低温用于事实性摘要
    max_tokens: maxTokens,
  });

  try {
    let text = '';
    let usage: Usage | undefined;
    for await (const chunk of stream.chunks) {
      if (chunk.type === ChunkType.Text && chunk.text) {
        text += chunk.text;
      }
      // 提供方回报的 usage（含 reasoning_tokens / finish_reason）—— 收下并入账
      if (chunk.type === ChunkType.Usage && chunk.usage) usage = chunk.usage;
      if (chunk.type === ChunkType.Error) throw chunk.err ?? new Error('stream error');
    }
    const call: SummaryCall = { text: text.trim(), maxTokens, ...(usage ? { usage } : {}) };
    // 每次调用都落一行（含空返回那次）—— 探针可查「发出的 cap / 回报的 usage」。
    log.info('agent', 'summary llm response', {
      provider: prov.name(),
      model: prov.model(),
      max_tokens: maxTokens,
      text_chars: call.text.length,
      finish_reason: usage?.finish_reason,
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      reasoning_tokens: usage?.reasoning_tokens,
      cache_hit_tokens: usage?.cache_hit_tokens,
      elapsed_ms: Math.round(Date.now() - startedAt),
    });
    return call;
  } catch (e) {
    if (stream.idleTimedOut && !signal.aborted) {
      log.warn('agent', 'summary LLM call stalled (30s no output) — 该次调用放弃');
    }
    throw e;
  }
}

/** 滚动合并分段摘要（含 priorSummary）— 每轮把尽量多段塞进
 *  budgetTokens 内合并为一，直到只剩一段。合并调用失败时
 *  降级为直接拼接（结构化文本拼接本身就是及格的简报），并**明说原因**。 */
export async function mergePartialsImpl(
  host: CompactionHost,
  signal: AbortSignal,
  priorSummary: string | null,
  partials: string[],
  budgetTokens: number,
): Promise<SummaryRun> {
  let texts = [...(priorSummary ? [`<previous-summary>\n${priorSummary}\n</previous-summary>`] : []), ...partials];
  let degraded = false;
  const calls: SummaryCall[] = [];
  const failures: string[] = [];
  while (texts.length > 1) {
    const group = [texts[0], texts[1]];
    let rest = texts.slice(2);
    while (rest.length && countText(group.join('\n\n---\n\n') + '\n\n---\n\n' + rest[0]) <= budgetTokens) {
      group.push(rest[0]);
      rest = rest.slice(1);
    }
    try {
      const merged = await callSummaryLLMImpl(host, signal, buildMergePrompt(), group.join('\n\n---\n\n'));
      calls.push(merged);
      assertUsableSummary(merged, 'merge');
      texts = [merged.text, ...rest];
    } catch (e) {
      if (signal.aborted) throw e;
      const reason = errMessage(e);
      log.warn('agent', `merge round failed (${reason}) — 降级为拼接`);
      host._sink({
        kind: EventKind.Notice,
        level: 'warn',
        text: `压缩降级 · 分段摘要合并失败（${reason}）—— 已直接拼接`,
      });
      texts = [group.join('\n\n---\n\n'), ...rest];
      failures.push(reason);
      degraded = true;
    }
  }
  let final = texts[0] ?? '';
  // 防御性封顶 — 拼接路径下摘要可能超长
  if (countText(final) > 8192) final = final.slice(0, 32768) + '\n…(过长摘要已截断)';
  return { text: final, degraded, ...failureText(failures), calls };
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 运行看门狗 —— 「不认 signal 的 await」的通用硬截止（landmine L3 拆弹）。
//
// 病灶（`docs/landmine-map.md` 第四批 L3）：模型请求这条链上唯一的活性守卫是
// `provider/idle-stream.ts` 的 30s 空闲计时器，而它只做一件事 —— **abort 一个
// AbortController**。等待方不认 signal（本机 IPC / 凭据解析 / 吞掉 abort 的
// 适配器与 SSE 读）时 `for await` 永不返回 ⇒ 连「停滞错误」都产不出来 ⇒
// `provider/retry.ts` 的 15 分钟停滞预算永不生效 ⇒ `agent.run()` 永不 settle。
// 停止钮因此无效（signal 已 abort，没人听），v43 之后记账会注销 ⇒ UI 能回空闲、
// 能发新消息（逃生舱），但那条 loop 永留栈上（`_loopDepth > 0`）＝幽灵轮。
//
// 本模块补的是**第二层、与 signal 无关的那一层**：按「有没有进展」计时，
// 到点就（① 打栅栏 ② abort ③ 让 run() 以具名错误 settle）。两条语义线：
//
//   - **脉搏（pulse）**：什么算「有进展」——三个点，全部是既有的天然边界：
//     ① `Agent.streamOnce` 收到一个 chunk（chunk 循环内，`streamWithAbort` 之后）；
//     ② 工具结果落盘（`tool/result` 进 `Agent._appendMessage` 那一刻）；
//     ③ loop 步骤边界（default-loop 每步入场调 `host.stepBoundary`）。
//     ⚠️ **不许**把 idle-stream 那 30s 计时器改造成看门狗：它只管「fetch 该不该
//     abort」（连接级事实），本模块管「这一轮还有没有在动」（运行级事实）。
//     两件事混在一起，慢模型会先被 30s 那层误杀，而真正挂死的 await 仍旧没人管。
//
//   - **阈值**：`NO_PROGRESS_WARN_MS`（默认 5min，只报警不动刀）与
//     `RUN_ABANDON_MS`（默认 20min，硬截止 = 作废该轮）。**无进展**语义而非绝对
//     截止 —— 每 4 分钟吐一个 token 的慢模型照常活到正常结束（脉搏含 chunk 到达）；
//     绝对上限本批**刻意不设**（无进展 20min 已覆盖挂死形态，绝对上限只会误杀长任务）。
//
// 参数**不扩 `AgentConfig`**（23 字段冻结，`tests/convergence/gate.mjs` 断言）：
// 常量在 `DEFAULTS` 单点，注入面 = `setRunWatchdogThresholds()`（装配期一次 /
// 测试直调）。真机复现用 60s 阈值时走这个注入点（见 S6 验尸记录），不新造 config 字段。

import { log } from './logger';

/** 无进展报警阈值（默认）：只 log.warn + 一条 UI 提示，**不改行为**。 */
export const NO_PROGRESS_WARN_MS = 5 * 60_000;

/** 硬截止阈值（默认）：到点作废该轮（栅栏 + abort + 具名错误 settle）。 */
export const RUN_ABANDON_MS = 20 * 60_000;

/** 看门狗巡检间隔 —— 阈值判定的量化步长（不决定阈值，只决定「多久看一眼」）。
 *  固定 `setInterval` 而非自重排 `setTimeout`：自安排在回调内、被外部 `await`
 *  挡住时整条链会一起停摆（那正是要看守的形态），固定间隔的每次触发独立。 */
const WATCHDOG_TICK_MS = 30_000;

/** 脉搏种类 —— 诊断口径（真机日志里回答「最后动的是什么」）。 */
export type PulseKind = 'chunk' | 'tool' | 'step';

/** 阈值注入面（缺省 = 上两常量）。**不扩 AgentConfig**：调用方按需一次注入。 */
export interface RunWatchdogThresholds {
  warnMs: number;
  abandonMs: number;
}

const DEFAULTS: RunWatchdogThresholds = { warnMs: NO_PROGRESS_WARN_MS, abandonMs: RUN_ABANDON_MS };

let thresholds: RunWatchdogThresholds = DEFAULTS;

/** 阈值注入（装配期 / 测试 / 真机复现）。 */
export function setRunWatchdogThresholds(t: Partial<RunWatchdogThresholds>): void {
  thresholds = { warnMs: t.warnMs ?? DEFAULTS.warnMs, abandonMs: t.abandonMs ?? DEFAULTS.abandonMs };
}

export function runWatchdogThresholds(): RunWatchdogThresholds {
  return thresholds;
}

/** 硬截止到期时抛出的具名错误（调用方据此落墓碑 —— 不许靠错误文本猜，宪法四）。
 *  `name` 定死：跨模块判据（chat-core 的 catch）读的是**类型 / name**，不是 message。 */
export class RunDeadlineExceededError extends Error {
  override readonly name = 'RunDeadlineExceededError';
  /** 作废时的运行身份 / 无进展时长 / 最后脉搏（墓碑与日志共用同一组事实）。 */
  readonly runId: number;
  readonly kind: RunKindLabel;
  readonly noProgressMs: number;
  readonly lastPulse: PulseKind;

  constructor(opts: { runId: number; kind: RunKindLabel; noProgressMs: number; lastPulse: PulseKind }) {
    super(
      `[超硬截止] 本轮 ${Math.round(opts.noProgressMs / 1000)}s 无任何进展（最后进展：${pulseLabel(opts.lastPulse)}），已作废本次运行（runId=${opts.runId} / ${opts.kind}）`,
    );
    this.runId = opts.runId;
    this.kind = opts.kind;
    this.noProgressMs = opts.noProgressMs;
    this.lastPulse = opts.lastPulse;
  }
}

/** 硬截止作废判据（调用方墓碑的唯一入口）——先认类型，再认 `name`：
 *  跨包/跨副本（打包后的插件产物）时 `instanceof` 可能失效（同一份源码两份副本），
 *  `name` 是它的兜底。**绝不读 message 文本**（2026-09-14 拆 `msg.includes('aborted')`
 *  的同一纪律）。 */
export function isRunDeadlineExceeded(err: unknown): boolean {
  if (err instanceof RunDeadlineExceededError) return true;
  return err instanceof Error && err.name === 'RunDeadlineExceededError';
}

/** 运行种类标签（`execution-state.RunKind` 的结构子集 —— 本模块不 import 它，
 *  避免看门狗与运行账互相依赖；值的真源仍是 RunKind）。 */
export type RunKindLabel = string;

export function pulseLabel(kind: PulseKind): string {
  switch (kind) {
    case 'chunk':
      return '模型数据块到达';
    case 'tool':
      return '工具结果落盘';
    case 'step':
      return 'loop 步骤边界';
  }
}

/** 一次运行的脉搏 + 看门狗。
 *
 *  生命周期 = 一条运行记录（`Agent.run()` 的起止）。`abandoned` 是**栅栏**：
 *  打上之后，该轮的迟到 chunk / 迟到工具结果一律不进 session 投影（审计面照旧，
 *  见 `session-log` 的 `tool/call` 事实），`runLoop` 也在步骤边界拒进。
 *
 *  不新造第二本账：「这一轮还在不在跑」的唯一事实仍是运行账（`execution-state.ts`
 *  的 RunRecord）；本类的 `abandoned` 标志只表达「被看门狗作废过」，与
 *  「用户按了停止」是**两回事**（后者不拦收尾投影 —— 停止后已收到的部分输出
 *  照常入卷，历史行为不变）。 */
export class RunPulse {
  readonly runId: number;
  readonly kind: RunKindLabel;
  private _abandoned = false;
  private _lastPulse: PulseKind = 'step';
  private _lastAt = Date.now();
  private _warned = false;
  private _timer: ReturnType<typeof setInterval> | undefined;
  /** 注册键（本次运行的 signal）—— `pulseOf` 按它寻址。 */
  private _signal: AbortSignal | null = null;
  /** 作废收尾钩子（顺序：栅栏 → abort → 记账作废）——见 `Agent.run()` 的注入。 */
  private readonly onAbandon: (runId: number, signal: AbortSignal) => void;
  private readonly onWarn: (info: {
    runId: number;
    kind: RunKindLabel;
    noProgressMs: number;
    lastPulse: PulseKind;
  }) => void;
  private readonly done: Promise<never>;
  private readonly _reject: (e: Error) => void;

  constructor(opts: {
    runId: number;
    kind: RunKindLabel;
    onAbandon: (runId: number, signal: AbortSignal) => void;
    onWarn: (info: { runId: number; kind: RunKindLabel; noProgressMs: number; lastPulse: PulseKind }) => void;
  }) {
    this.runId = opts.runId;
    this.kind = opts.kind;
    this.onAbandon = opts.onAbandon;
    this.onWarn = opts.onWarn;
    // 永不 resolve 的哨兵：硬截止到期由 `_abandon()` 显式 reject（单点、幂等）。
    let rejectFn: (e: Error) => void = () => {};
    this.done = new Promise<never>((_resolve, reject) => {
      rejectFn = reject;
    });
    this._reject = rejectFn;
    this._timer = setInterval(() => this._tick(), WATCHDOG_TICK_MS);
  }

  /** 被看门狗作废过（栅栏判据）。 */
  get abandoned(): boolean {
    return this._abandoned;
  }

  get lastPulse(): PulseKind {
    return this._lastPulse;
  }

  get noProgressMs(): number {
    return Date.now() - this._lastAt;
  }

  /** 绑定本次运行的 signal（登记进 `pulseOf` 的可寻址面）。 */
  bindSignal(signal: AbortSignal): void {
    this._signal = signal;
    pulseRecords.set(signal, this);
  }

  /** 记一次脉搏（有进展）。 */
  pulse(kind: PulseKind): void {
    if (this._abandoned) return;
    this._lastPulse = kind;
    this._lastAt = Date.now();
  }

  /** 本次运行自己的脉搏（供不持有 signal 的调用点，如 `Agent._appendMessage`
   *  这一层的落盘脉搏）——无绑定 signal = no-op。 */
  beat(kind: PulseKind): void {
    this.pulse(kind);
  }

  /** 硬截止承诺 —— `Agent.run()` 与 `runLoop` 竞速。 */
  get deadline(): Promise<never> {
    return this.done;
  }

  private _tick(): void {
    if (this._abandoned) return;
    const quiet = Date.now() - this._lastAt;
    if (quiet >= thresholds.abandonMs) {
      this._abandon(quiet);
      return;
    }
    if (!this._warned && quiet >= thresholds.warnMs) {
      this._warned = true; // 一次，不刷屏
      this.onWarn({ runId: this.runId, kind: this.kind, noProgressMs: quiet, lastPulse: this._lastPulse });
    }
  }

  /** 到期动作（顺序要紧）：① 打栅栏 ② abort ③ 记账作废 + 让 run() 以具名错误 settle。 */
  private _abandon(quietMs: number): void {
    if (this._abandoned) return;
    this._abandoned = true;
    const sig = this._signal;
    if (sig) this.onAbandon(this.runId, sig);
    this._reject(
      new RunDeadlineExceededError({
        runId: this.runId,
        kind: this.kind,
        noProgressMs: quietMs,
        lastPulse: this._lastPulse,
      }),
    );
  }

  /** 收尾（幂等）：停表 + 摘登记。**不动 `abandoned`** —— 已作废是既成事实
   *  （收尾后仍可能被读到，例如 finally 里的补唤醒判定）。 */
  end(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    if (this._signal) {
      pulseRecords.delete(this._signal);
      this._signal = null;
    }
  }
}

/** signal → 脉搏的登记表。WeakMap：运行收尾后条目随 signal 自然回收。
 *  为什么按 signal 寻址：`Agent.streamOnce` 只拿得到 signal（它不知道自己的
 *  RunHandle），而 signal 是本次运行的唯一身份 —— 与运行账 `runFor(signal)`
 *  同一把钥匙。 */
const pulseRecords = new WeakMap<AbortSignal, RunPulse>();

/** 本次 signal 所属运行的脉搏（无 = 该运行未起看门狗，如压缩 / 子 Agent 内轮）。 */
export function pulseOf(signal: AbortSignal): RunPulse | null {
  return pulseRecords.get(signal) ?? null;
}

/** 记一次脉搏（无登记 = no-op —— 不经 `Agent.run()` 的驱动面照旧零开销）。 */
export function beatPulse(signal: AbortSignal, kind: PulseKind): void {
  pulseRecords.get(signal)?.pulse(kind);
}

/** 是否已被看门狗作废（无登记 = false）。栅栏判据的唯一读法。 */
export function isAbandoned(signal: AbortSignal): boolean {
  return pulseRecords.get(signal)?.abandoned === true;
}

/** 无进展报警的日志 + 可见出口（`Agent.run()` 注入的两个钩子共用同一组事实）。 */
export function watchdogWarnContext(info: {
  runId: number;
  kind: RunKindLabel;
  noProgressMs: number;
  lastPulse: PulseKind;
}): Record<string, unknown> {
  return {
    runId: info.runId,
    run: info.kind,
    no_progress_ms: info.noProgressMs,
    no_progress: `${Math.round(info.noProgressMs / 1000)}s`,
    last_pulse: info.lastPulse,
    last_pulse_label: pulseLabel(info.lastPulse),
  };
}

/** 报警文案（UI 可见一口 —— 走既有 Notice 通道，不新造 store）。 */
export function watchdogWarnText(info: { noProgressMs: number; lastPulse: PulseKind }): string {
  const mins = Math.round(info.noProgressMs / 60_000);
  const limit = Math.round(thresholds.abandonMs / 60_000);
  return `本轮已 ${mins} 分钟无任何进展（最后进展：${pulseLabel(info.lastPulse)}）——若到 ${limit} 分钟仍无进展，将自动作废本轮。`;
}

/** 作废时的用户可见文案（UI 一口 —— 走既有 Notice 通道，不新造 store）。
 *
 *  文案纪律（用户 2026-09-20 定的口径）：**「本轮超硬截止已作废，结果未知，
 *  勿当成功继续」逐字在**——作废 / 结果未知 / 别当成功读下去，三件事缺一，
 *  用户就会把这一轮当成正常回复继续。
 *  第二行是事实行（可折叠的取证面）：无进展时长 + 最后脉搏 + runId + 运行种类
 *  ——与 `ui.log` 的作废行同一组字段，用户报障时能直接对上。 */
export function watchdogAbandonText(info: {
  runId: number;
  kind: RunKindLabel;
  noProgressMs: number;
  lastPulse: PulseKind;
}): string {
  const mins = Math.max(1, Math.round(info.noProgressMs / 60_000));
  return (
    '本轮超硬截止已作废，结果未知，勿当成功继续。' +
    `\n（${mins} 分钟无任何进展——最后进展：${pulseLabel(info.lastPulse)}；runId=${info.runId} / ${info.kind}）`
  );
}

/** 看门狗日志出口（模块内唯一 —— 调用方不各自 log，避免刷屏与口径漂移）。 */
export function logWatchdogWarn(info: {
  runId: number;
  kind: RunKindLabel;
  noProgressMs: number;
  lastPulse: PulseKind;
}): void {
  log.warn(
    'agent',
    `运行看门狗：${Math.round(info.noProgressMs / 1000)}s 无进展（仍未放弃）`,
    watchdogWarnContext(info),
  );
}

export function logWatchdogAbandon(info: {
  runId: number;
  kind: RunKindLabel;
  noProgressMs: number;
  lastPulse: PulseKind;
}): void {
  log.warn('agent', '运行看门狗：无进展超硬截止，作废本轮', watchdogWarnContext(info));
}

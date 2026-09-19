// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// SessionLogWriteBehind — 会话事件日志的有界写后队列（DSH 参照移植，2026-09-15）。
//
// 来源：`deepseek-harness/packages/session/session-persistence/src/write-behind.ts`
// （HEAD 4e84901e64）。兰台原样采用其四条语义，因为这四条正是「增量写」能当天花板
// 用的原因：
//
//   1. **固定批量窗口**：队列空→有货时起一个 maxDelayMs 窗口（DSH = 200ms），
//      窗口到期才落盘；窗口内到达的事件自然合并成一批（一次 append 而不是 N 次）。
//   2. **flush() = 静默屏障**：取消窗口、等在途写、再排空到队列真的空——
//      这就是「检查点」的全部实现（模型请求前 / 工具副作用前 / step 前各一次）。
//      并发调用 join 同一个屏障（不是各自起一轮）。
//   3. **失败整批回灌**：落盘失败的批次按原顺序 splice 回队首 + 暂停自动写 +
//      上报；**不丢事件**，下一个检查点自动重试（DSH 的 `startWrite` catch）。
//   4. **背景写不反噬生产者**：自动路径的失败不 reject 入队方（生产者是 Agent
//      主循环，不能因为磁盘抖动被拖死）；只有显式 flush() 才把失败抛给等待者。
//
// 与 DSH 的差异（记录在案，不是遗漏）：DSH 的 enqueue 用 structuredClone 快照事件；
// 兰台事件是可 JSON 序列化的纯数据（`SessionEvent`），这里用 JSON 深拷贝——
// 语义等价（剥离冻结态与共享引用），且与 `SessionLog.snapshot()` 同一把尺子。

import type { SessionEvent } from './session-log';

/** 默认批量窗口（毫秒）——与 DSH `DEFAULT_WRITE_BATCH_MAX_DELAY_MS` 同值。 */
export const DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200;

export interface SessionLogWriteBehindOptions {
  /** 队列空→有货后的最长刻意等待（固定窗口，滚动不续期）。 */
  readonly maxDelayMs: number;
  /** 落盘一批（按 seq 顺序、完整前缀）；resolve = 已持久。 */
  readonly write: (events: readonly SessionEvent[]) => Promise<void>;
  /** 观察背景写失败（不反噬生产者）——调用方负责可见化。 */
  readonly reportBackgroundFailure: (error: unknown) => void;
}

function cloneEvent(ev: SessionEvent): SessionEvent {
  return JSON.parse(JSON.stringify(ev)) as SessionEvent;
}

/**
 * 一条会话日志的待落盘队列：拥有「待写事件 / 固定窗口定时器 / 在途写 / 失败保留 /
 * 显式静默屏障」。除 `flush()` 外的所有路径都不抛（背景失败只上报）。
 */
export class SessionLogWriteBehind {
  private pending: SessionEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private barrier: Promise<void> | undefined;
  private deadlineExpired = false;
  private automaticPaused = false;

  constructor(private readonly options: SessionLogWriteBehindOptions) {}

  /** 是否还有待写事件或在途写（退出收尾据此判断要不要等）。 */
  get hasWork(): boolean {
    return this.pending.length > 0 || this.active !== undefined;
  }

  /** 待写事件数（观测/测试面）。 */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 入队一条事件（深拷贝，生产者后续 mutate 不影响已入队内容）。 */
  enqueue(event: SessionEvent): void {
    const wasEmpty = this.pending.length === 0;
    this.pending.push(cloneEvent(event));
    if (this.barrier !== undefined) return; // 屏障期间入队 → 由屏障循环排空
    if (this.automaticPaused) {
      // 失败暂停后的第一条：重新起窗口（不是立刻写——避免失败风暴里空转）
      this.automaticPaused = false;
      this.deadlineExpired = false;
      this.armTimer();
    } else if (wasEmpty) {
      this.armTimer();
    }
  }

  /**
   * 取消窗口 → 等在途写 → 排空到队列空（静默点）。并发调用共享同一屏障；
   * 失败时屏障 reject（调用方决定可见等级），队列内容保留待重试。
   */
  flush(): Promise<void> {
    return this.runBarrier(undefined);
  }

  /**
   * **整写屏障**（压实，2026-09-19 A 案）：排空在途 → **持屏障**跑 `op` → 排空 op 期间
   * 到达的事件。
   *
   * 为什么必须持屏障跑：整写（全量重写文件）若与 append 交错，窗口内落盘的批次会被
   * 随后的整写覆盖（事件静默丢失）。持屏障期间 `enqueue` 不自己起窗口（既有语义），
   * 故队列空 + 屏障在手 = 整写独占文件；op 期间到达的事件在其后按 append 落定。
   */
  rewrite(op: () => Promise<void>): Promise<void> {
    return this.runBarrier(op);
  }

  /** 取消当前自动窗口（不清队列）——退出路径「先取消防抖」的对应物。 */
  cancelAutomaticWait(): void {
    this.cancelTimer();
    this.deadlineExpired = false;
  }

  /** 屏障公共入口（flush = 无 op；rewrite = 持屏障跑整写）。 */
  private runBarrier(op?: () => Promise<void>): Promise<void> {
    if (this.barrier !== undefined) return this.barrier;
    this.cancelTimer();
    this.deadlineExpired = false;
    this.automaticPaused = false;
    // ⚠ 赋值必须**先于**启动 drain（DSH withResolvers 同序）：drainBarrier 在队列
    // 已空时会同步跑完并把 this.barrier 清成 undefined，若随后才赋值，就把一个
    // 已 settle 的屏障挂回去——此后所有 flush() 都命中它、永不排空（实测踩过）。
    let resolveBarrier!: () => void;
    let rejectBarrier!: (reason?: unknown) => void;
    const barrier = new Promise<void>((resolve, reject) => {
      resolveBarrier = resolve;
      rejectBarrier = reject;
    });
    this.barrier = barrier;
    void this.drainBarrier(resolveBarrier, rejectBarrier, op);
    return barrier;
  }

  private armTimer(): void {
    this.timer = setTimeout(() => {
      this.onDeadline();
    }, this.options.maxDelayMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private onDeadline(): void {
    this.timer = undefined;
    if (this.active !== undefined) {
      // 在途写吃掉了本次预算：记下「有货但窗口已过」，等它回来立刻续一批
      this.deadlineExpired = true;
      return;
    }
    this.startBackground();
  }

  private startBackground(): void {
    const active = this.startWrite(true);
    void active.then(
      () => {
        this.continueAutomatic();
      },
      () => {},
    );
  }

  private continueAutomatic(): void {
    if (this.barrier !== undefined || this.pending.length === 0) return;
    if (this.deadlineExpired) {
      this.deadlineExpired = false;
      this.startBackground();
    }
  }

  private async drainBarrier(
    resolve: () => void,
    reject: (reason?: unknown) => void,
    op?: () => Promise<void>,
  ): Promise<void> {
    try {
      const overlapping = this.active;
      if (overlapping !== undefined) {
        await Promise.allSettled([overlapping]);
        this.automaticPaused = false;
      }
      while (this.pending.length > 0) await this.startWrite(false);
      // 整写（压实）：队列空 + 仍持屏障 ⇒ 不与任何 append 交错（见 rewrite 注）
      if (op) await op();
      while (this.pending.length > 0) await this.startWrite(false);
    } catch (error: unknown) {
      this.barrier = undefined;
      reject(error);
      return;
    }
    // 在「观察到队列为空」的同一 job 内关闭准入：此后新入队会自己起窗口，
    // 而不是挂在一个已 settle 的屏障后面（DSH 同款注释，实测过的坑）。
    this.barrier = undefined;
    resolve();
  }

  /** 取出一批（完整前缀）落盘；失败按原顺序回灌队首并暂停自动写。 */
  private startWrite(background: boolean): Promise<void> {
    const batch = this.pending.splice(0);
    this.cancelTimer();
    this.deadlineExpired = false;
    const operation = Promise.resolve().then(() => this.options.write(batch));
    const active = operation
      .catch((error: unknown) => {
        this.pending = batch.concat(this.pending);
        this.cancelTimer();
        this.deadlineExpired = false;
        this.automaticPaused = true;
        if (background) this.options.reportBackgroundFailure(error);
        throw error;
      })
      .finally(() => {
        this.active = undefined;
      });
    this.active = active;
    return active;
  }
}

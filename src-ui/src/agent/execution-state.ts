// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ExecutionState — 每卷的**运行账**（「这卷在不在跑」的唯一事实）。
//
// ⚡ 2026-09-20 结构性收口（用户拍板 B 案）：旧模型 = `isRunning: boolean` + 可选令牌
//   `done(runSignal?)`。三周内同一族修了四次（`994c4c4d` 收尾绑发起卷 / `32bc8dd4`
//   订阅身份 / `b67ac7e8` 账本身份 / `54981624` 收尾归属）——每次都只补上链条的一环，
//   因为旧模型把「事实」建模成了**靠约定同步的声明**：
//     - `done()` 不带令牌 = 无条件清账（合法调用、静默毁掉别人的运行态）；
//     - 谁起轮谁记得配对（4 组起停手写），漏一处就是「会话在跑而 UI 说空闲」；
//     - 「声明」与「真在跑」之间没有派生关系 ⇒ 断链无声（违宪法四）。
//   新模型把事实收成一条：**运行记录表（RunRecord）**。
//     - `isRunning` / `runState` 是**派生值**（账上有没有活记录），没有第二个写者；
//     - 每条记录只能由它的**持有者按身份（id）**注销 —— 「清掉别人的运行」在类型上
//       不可能（没有不带身份的 done()）；
//     - 忘了收尾的后果从「静默丢掉运行态」变成「账上留着一条活记录（可见，且
//       `stopAll()` / `discardRuns()` 是逃生舱）」——错误方向反过来了，这是刻意的。
//
// 语义契约（读面/控制面）：
//   - `isRunning` / `runState`：账上是否有活记录。UI 全域**唯一读法** =
//     `agentSessionState.runStateOf(storeId, sid)`（创作坞/纸面/侧栏/书脊/退出守卫/
//     分卷删除都读它，不再各自取账本实例）；
//   - `beginRun(kind)`：起一次运行 —— 铸 signal（给了就借用）+ 登记记录，返回句柄。
//     记录是**可加的事实**：同时存在多条（收尾窗口的旧轮 + 延迟唤醒的新轮 / 压缩 + 回合）
//     都合法，谁也不顶掉谁；并发轮次的闸门在 `Agent.runLoop` 的 loop 深度守卫（执行面）；
//   - `handle.end()`：只注销自己那条记录（幂等；对已被 `stopAll/discardRuns` 作废的
//     记录 = no-op）；
//   - `stopAll()`：**用户停止语义** —— abort 全部活记录 + 注销 + 清权限卡队列，
//     返回被停记录 id（调用方按 id 做兜底身份守卫）；
//   - `discardRuns(ids)`：兜底作废指定记录（运行不认 abort 时把 UI 从「永远在跑」
//     里放出来；只认点名的那几条，绝不误伤新轮）。
//
// 不可序列化对象（AbortController / 记录表）在工厂闭包；可序列化投影
// （runCount / 权限卡计数 / sessionVersion）进 zustand store —— 订阅面（onChange）照旧。
// ⚡ 多窗口重构：单例 → 工厂模式。 createExecState() 每次返回独立实例。

import { createStore } from 'zustand/vanilla';

// ── Types ──

export type StateChangeListener = () => void;

/** 运行种类（诊断 + 读面策略的共同词表）——读面按 kind 分策略（停钮/呼吸线/退出守卫/
 *  将来的后台工作计数），登记方按语义选一个诚实的种类。
 *  - `turn`   用户发起的回合（chat-core 三处起轮）
 *  - `wake`   总线唤醒自起的回合（异步子 Agent 回件 / 后台任务 / 延迟唤醒）
 *  - `goal`   自主目标循环
 *  - `compact` 上下文压缩（跑在 loop 之外）
 *  - `subagent` 子 Agent 自己的运行（子 Agent 各持一本私账，不入会话注册表） */
export type RunKind = 'turn' | 'wake' | 'goal' | 'compact' | 'subagent';

/** 运行态读面（快照）——UI 全域唯一读法的载荷。 */
export interface RunState {
  running: boolean;
  /** 在跑的运行种类（去重，按开始时间序）——读面据此分策略（停钮/呼吸线/退出守卫）。 */
  kinds: readonly RunKind[];
  count: number;
  /** 最早一条在跑记录的开始时刻（epoch ms；无在跑 = null）——「这卷跑了多久」。 */
  since: number | null;
}

/** 一次运行的句柄——**谁起谁收**：`end()` 只注销自己这条记录。 */
export interface RunHandle {
  readonly id: number;
  readonly kind: RunKind;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  /** 注销本次运行（幂等；对已作废的记录 = no-op）。 */
  end(): void;
}

interface PermCard {
  resolve: (r: { allow: boolean; remember: boolean }) => void;
  cleanup: () => void;
}

interface RunRecord {
  id: number;
  kind: RunKind;
  signal: AbortSignal;
  /** 本账铸的 controller（借用调用方 signal 时为 null——那条 signal 的中止权在调用方）。 */
  controller: AbortController | null;
  startedAt: number;
}

// 互斥与并发闸门**不在本层**：运行记录是可加的事实（「旧轮收尾窗口 + 延迟唤醒新轮」
// 两条并存是合法的）。同一 Agent 不许两条 loop 同时在栈上 —— 那是执行面的闸门，
// 由 `Agent.runLoop` 的 loop 深度守卫拦（含 log.error 留痕）。

// ── Zustand store — serialisable projection only ──

interface ExecState {
  /** 活运行条数（`isRunning`/`runState` 在闭包里派生，这里只是订阅触发面）。 */
  runCount: number;
  sessionVersion: number;
  permCardCount: number;
}

// ── Public API type — what createExecState() returns ──

export interface ExecStateInstance {
  // ── 只读属性 ──
  readonly isBusy: boolean;
  /** 派生值：账上是否有活运行记录（没有第二个写者）。 */
  readonly isRunning: boolean;
  /** 运行态快照（唯一读面的原语）。 */
  readonly runState: RunState;
  /** 最新一条在跑记录的 signal（读面兼容；无在跑 = undefined）。 */
  readonly abortSignal: AbortSignal | undefined;
  /** 运行代号：每起一次运行 +1 —— 身份守卫用（「我停之后有没有新轮起来」）。 */
  readonly runEpoch: number;
  readonly sessionVersion: number;
  readonly permCardCount: number;

  // ── 运行记录（起 / 收）──
  /** 起一次运行：铸 signal（给了就借用）+ 登记记录，返回句柄（**谁起谁收**）。 */
  beginRun(kind: RunKind, signal?: AbortSignal): RunHandle;
  /** 按 signal 找已登记的在跑记录（Agent 认领判定：已登记 = 不由本层收尾）。 */
  runFor(signal: AbortSignal): RunHandle | null;
  /** 用户停止语义：abort 全部活记录 + 注销 + 清权限卡队列，返回被停记录 id。 */
  stopAll(): number[];
  /** 兜底作废点名记录（abort + 注销）：运行不认 abort 时把 UI 放出来。 */
  discardRuns(ids: readonly number[]): void;

  // ── 会话版本号 ──
  bumpVersion(): number;

  // ── 权限队列 ──
  registerPermCard(resolve: (r: { allow: boolean; remember: boolean }) => void, cleanup: () => void): void;
  enqueuePerm<T>(fn: () => Promise<T>): Promise<T>;
  resetPermQueue(): void;

  // ── 订阅（委托给 Zustand） ──
  onChange(fn: StateChangeListener): () => void;
}

// ── Factory ──

export function createExecState(): ExecStateInstance {
  const store = createStore<ExecState>(() => ({
    runCount: 0,
    sessionVersion: 0,
    permCardCount: 0,
  }));

  // ── Per-instance closures — non-serialisable mutable state ──

  /** 活运行记录表 —— 「在不在跑」的唯一事实（插入序 = 开始时间序）。 */
  const _runs = new Map<number, RunRecord>();
  let _nextRunId = 1;
  let _runEpoch = 0;
  let _permQueue: Promise<void> = Promise.resolve();
  const _permCards: PermCard[] = [];

  function _set(s: Partial<ExecState>): void {
    store.setState(s);
  }

  /** 记录表变更 → 可序列化投影同步（订阅面据此刷新）。 */
  function _syncRuns(): void {
    _set({ runCount: _runs.size });
  }

  function _runState(): RunState {
    if (_runs.size === 0) return { running: false, kinds: [], count: 0, since: null };
    const kinds: RunKind[] = [];
    let since = Number.POSITIVE_INFINITY;
    for (const r of _runs.values()) {
      if (!kinds.includes(r.kind)) kinds.push(r.kind);
      if (r.startedAt < since) since = r.startedAt;
    }
    return { running: true, kinds, count: _runs.size, since };
  }

  function _handleOf(rec: RunRecord): RunHandle {
    let ended = false;
    return {
      id: rec.id,
      kind: rec.kind,
      signal: rec.signal,
      startedAt: rec.startedAt,
      end: () => {
        if (ended) return; // 幂等
        ended = true;
        // 只注销**自己这条**（id 身份）；已被 stopAll/discardRuns 作废 = no-op
        if (_runs.delete(rec.id)) _syncRuns();
      },
    };
  }

  function _cancelAllPermissions(): void {
    while (_permCards.length > 0) {
      const p = _permCards.pop();
      if (!p) continue;
      p.cleanup();
      p.resolve({ allow: false, remember: false });
    }
  }

  // ── Public API ──

  const self: ExecStateInstance = {
    // ── 只读属性 ──

    get isBusy(): boolean {
      return _runs.size > 0 || store.getState().permCardCount > 0;
    },

    get isRunning(): boolean {
      return _runs.size > 0;
    },

    get runState(): RunState {
      return _runState();
    },

    get abortSignal(): AbortSignal | undefined {
      let newest: RunRecord | null = null;
      for (const r of _runs.values()) newest = r; // Map 保插入序 → 最后一条 = 最新
      return newest?.signal;
    },

    get runEpoch(): number {
      return _runEpoch;
    },

    get sessionVersion(): number {
      return store.getState().sessionVersion;
    },

    get permCardCount(): number {
      return store.getState().permCardCount;
    },

    // ── 运行记录 ──

    beginRun(kind, signal): RunHandle {
      // 纯登记（记录是**可加的事实**）：同时存在两条在跑记录是合法状态——最典型的是
      // 「上一轮 loop 已返回、记录还在收尾窗口」+「延迟唤醒刚起的新一轮」，两条都真在跑。
      // **并发轮次的闸门不在本层**：同一 Agent 不许两条 loop 同时在栈上，由
      // `Agent.runLoop` 的 loop 深度守卫拦截并 log.error（那是执行面的事实，不是账面的）。
      // 旧实现 start() 静默换代（abort 旧 controller）——那正是「旧轮的账被新轮顶掉、
      // 收尾时谁也说不清谁在跑」的来源。
      const controller = signal === undefined ? new AbortController() : null;
      const rec: RunRecord = {
        id: _nextRunId++,
        kind,
        signal: signal ?? (controller as AbortController).signal,
        controller,
        startedAt: Date.now(),
      };
      _runs.set(rec.id, rec);
      _runEpoch += 1;
      _syncRuns();
      return _handleOf(rec);
    },

    runFor(signal): RunHandle | null {
      for (const r of _runs.values()) {
        if (r.signal === signal) return _handleOf(r);
      }
      return null;
    },

    stopAll(): number[] {
      const ids: number[] = [];
      for (const r of _runs.values()) {
        ids.push(r.id);
        r.controller?.abort(); // 借用的 signal 由它的主人中止（子 Agent 池 / 调用方）
      }
      _runs.clear();
      _cancelAllPermissions();
      _permQueue = Promise.resolve();
      _set({ runCount: 0, permCardCount: 0 });
      return ids;
    },

    discardRuns(ids): void {
      let changed = false;
      for (const id of ids) {
        const r = _runs.get(id);
        if (!r) continue; // 已被 stopAll 注销 / 已自行收尾 = no-op（绝不误伤新轮）
        r.controller?.abort();
        _runs.delete(id);
        changed = true;
      }
      if (changed) _syncRuns();
    },

    // ── 会话版本号 ──

    bumpVersion(): number {
      const next = store.getState().sessionVersion + 1;
      _set({ sessionVersion: next });
      return next;
    },

    // ── 权限队列 ──

    registerPermCard(resolve, cleanup): void {
      _permCards.push({ resolve, cleanup });
    },

    enqueuePerm<T>(fn: () => Promise<T>): Promise<T> {
      _set({ permCardCount: store.getState().permCardCount + 1 });

      const prev = _permQueue;
      const result = prev.then(() => fn());

      result.finally(() => {
        _set({ permCardCount: Math.max(0, store.getState().permCardCount - 1) });
      });

      _permQueue = result.catch(() => {}).then(() => {});
      return result;
    },

    resetPermQueue(): void {
      _cancelAllPermissions();
      _permQueue = Promise.resolve();
      _set({ permCardCount: 0 });
    },

    // ── 订阅（委托给 Zustand） ──

    onChange(fn): () => void {
      return store.subscribe(fn);
    },
  };

  return self;
}

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// WorkLedgerStore — 「役台账」：本面板**在跑的后台工作**的唯一读面。
//
// 命名去重：本文件的 task 概念与 `agent/task-board.ts`（TaskBoard = 异步子 Agent
// 的 worktree/diff 账）及 `task_*` 模型工具**不是一回事**。这里记的是「用户视角
// 下，这一卷现在派了哪些活出去」——后台 shell 作业 + 子 Agent 的**运行记录**。
//
// ── 为什么 UI 侧要自建一本账（现状取证，2026-09-22）──────────────────────
// 三本 Agent 侧账都读不出「按会话的在役清单」：
//   ① `SubAgentPool`（agent/coordinator.ts）是**工作区级**单例，句柄无 session /
//      parent 字段，`listRunning()` 只能给「本工作区全部子 Agent」；
//   ② `subagent-activity`（当前工具/最近事件）键 = 子 Agent id、**终态即删**、
//      无订阅，唯一读者是 `agent_status` 模型工具；
//   ③ Rust `BG_JOBS`（utils/bg_jobs.rs）的 `bg_jobs_snapshot()` **只返回仍在跑的
//      job**（`try_wait() == Ok(None)`），已完成待读 / try_wait 出错 / 已移除三者
//      同形（都表现为「不在列表里」），且 exit code 从未落进 BgJob 字段。
//      `bg:note` 事件在 job 完成时才发，**那一刻它已查不到** —— 纯读账本做不出
//      「最近完成」。
// 所以「记录」这半边只能由 UI 在**观察点**上自记：子 Agent 走 AgentUINotifier
// 的 spawn/finished（带 sessionId + parentAgentId，runtime.ts:957-968 补的父身份），
// shell 走 `background_activity` 快照的对账（在役集合）+ `bg:note`（终态时点）。
//
// ── 口径纪律（禁漂移）────────────────────────────────────────────────
//   ① **只读不写 Agent 侧**：本账不调 `bash_output` —— 那个 action 的增量游标是
//      所有读方共用的，且读到终态即 `jobs.remove()`，UI 读一次等于吃掉模型随后要
//      用的输出并销毁 job（bg_jobs.rs:474-479）。本账只读 `background_activity`。
//   ② **终态不编造**：shell 的终态由「从在役集合消失」外推，**不报退出码**（账本
//      没有）；子代理终态来自 finished 回调的 ok 布尔。note 字段如实标注来源。
//   ③ **不落盘**：纯内存、按面板隔离、退出即空——与 `SubAgentPart` 同命运
//      （它也不落卷）。要持久记录是 Agent 侧 TaskBoard 的事。
//   ④ **失败可见**：拉快照失败不静默吞，写进 `error` 由册页页脚显示（宪法四）。
//
// app 级单例（同 bg-alert-store / agent-panel-store 模式）；按 panelId 分桶，
// 面板退场调 `clearPanel`。

import { create } from 'zustand';
import { kernelProcessCall } from '../rpc-contract';
import { showToast, TOAST_LONG_HOLD_MS } from './toast-store';

// ── 类型 ──

/** 在役种类——读面据此分徽标与可用操作。 */
export type WorkKind = 'shell' | 'subagent';

/** 条目状态。`done` 是「已结束」的中性档——账本不报 shell 退出码，不编造成败。 */
export type WorkState = 'running' | 'done' | 'failed' | 'stopped';

export interface WorkEntry {
  /** 稳定身份：shell = `job-<jobId>`；subagent = Agent id（`sub-…`）。 */
  id: string;
  kind: WorkKind;
  /** 显示名：shell = 命令原文（Rust 截 80 字）；subagent = 任务描述。 */
  label: string;
  /** 起算时刻（epoch ms）。shell 由 `elapsedSecs` 反推——Rust 只给单调时钟差值。 */
  startedAt: number;
  endedAt: number | null;
  state: WorkState;
  /** 归属卷；null = 归属未知（owner 解析不出，或 job 无 owner）。 */
  sessionId: number | null;
  /** 子 Agent 的派生者 id（仅 subagent）。 */
  parentAgentId: string | null;
  /** 旁注：`停滞` / `已结束` / 失败原因。只在有话说时非空。 */
  note: string | null;
}

/** `process_cap('background_activity')` 的 shells 元素（bg_jobs.rs:144-150 逐字）。 */
export interface ShellSnapshot {
  jobId: number;
  label: string;
  agent: string | null;
  elapsedSecs: number;
  stalled: boolean;
}

/** 每个面板保留的终态条目上限（在役条目不吃配额）。 */
const MAX_TERMINAL = 40;

/** 键：面板 × 种类 × 身份。种类参与键，防 shell 的 job 号与 Agent id 撞车。 */
function keyOf(panelId: string, kind: WorkKind, id: string): string {
  return `${panelId}\u0000${kind}\u0000${id}`;
}

interface WorkLedgerState {
  /** 全部条目（键见 keyOf）——非序列化不便，用普通对象即可。 */
  entries: Record<string, WorkEntry>;
  /** 最近一次拉取失败的原因（成功即清）；册页页脚据此显形。 */
  error: Record<string, string | null>;

  /** 子 Agent 派生（runtime-adapter 的 onSubAgentSpawn 喂）。 */
  noteSubAgentSpawn(
    panelId: string,
    sessionId: number,
    agentId: string,
    parentAgentId: string | null,
    description: string,
    at?: number,
  ): void;
  /** 子 Agent 收尾（onSubAgentFinished 喂）。找不到条目 = no-op（不是本面板派的）。 */
  noteSubAgentFinished(panelId: string, agentId: string, ok: boolean, at?: number): void;

  /** shell 快照对账：进来的置/留在役，**从在役集合消失的**结转终态。 */
  noteShells(
    panelId: string,
    shells: readonly ShellSnapshot[],
    resolveSession: (owner: string | null) => number | null,
  ): void;
  /** 拉取失败留痕（`null` = 成功，清错）。 */
  noteShellsError(panelId: string, message: string | null): void;

  /** 面板退场：清该面板全部条目与错误。 */
  clearPanel(panelId: string): void;
}

// ── 读面（纯函数：组件与 store 共用同一把尺子，禁各算各的）──────────────

/** 某面板 × 某卷的役视图。 */
export interface SessionWorkView {
  /** 本卷在役（按起算升序）。 */
  running: WorkEntry[];
  /** 本卷终态（按结束倒序）。 */
  settled: WorkEntry[];
  /** 在役但**不属于本卷**（他卷，或归属未知）——坞触发器与「他卷」段用。 */
  others: WorkEntry[];
}

/** 从条目表切出某面板 × 某卷的视图。`sessionId` 为 null = 只认归属未知那批。 */
export function selectSessionWork(
  entries: Readonly<Record<string, WorkEntry>>,
  panelId: string,
  sessionId: number | null,
): SessionWorkView {
  const running: WorkEntry[] = [];
  const settled: WorkEntry[] = [];
  const others: WorkEntry[] = [];
  const prefix = panelId + '\u0000';
  for (const [k, e] of Object.entries(entries)) {
    if (!k.startsWith(prefix)) continue;
    if (e.state !== 'running') {
      if (e.sessionId === sessionId) settled.push(e);
      continue;
    }
    if (e.sessionId === sessionId) running.push(e);
    else others.push(e);
  }
  running.sort((a, b) => a.startedAt - b.startedAt);
  settled.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  others.sort((a, b) => a.startedAt - b.startedAt);
  return { running, settled, others };
}

// ── 内部工具 ──

/** 终态条目配额：超限丢最旧的终态（在役永不淘汰）。 */
function evictTerminal(entries: Record<string, WorkEntry>, panelId: string): void {
  const terminal: Array<[string, WorkEntry]> = [];
  for (const [k, e] of Object.entries(entries)) {
    if (e.state !== 'running' && k.startsWith(panelId + '\u0000')) terminal.push([k, e]);
  }
  const overflow = terminal.length - MAX_TERMINAL;
  if (overflow <= 0) return;
  terminal.sort((a, b) => (a[1].endedAt ?? 0) - (b[1].endedAt ?? 0));
  for (let i = 0; i < overflow; i++) delete entries[terminal[i][0]];
}

export const useWorkLedgerStore = create<WorkLedgerState>((set, get) => ({
  entries: {},
  error: {},

  noteSubAgentSpawn: (panelId, sessionId, agentId, parentAgentId, description, at) => {
    const key = keyOf(panelId, 'subagent', agentId);
    const prev = get().entries[key];
    const entry: WorkEntry = {
      id: agentId,
      kind: 'subagent',
      label: description,
      // 重派同 id（不该发生）时保留原起算——同一身份不重铸时间
      startedAt: prev?.startedAt ?? at ?? Date.now(),
      endedAt: null,
      state: 'running',
      sessionId,
      parentAgentId,
      note: null,
    };
    set((s) => ({ entries: { ...s.entries, [key]: entry } }));
  },

  noteSubAgentFinished: (panelId, agentId, ok, at) => {
    const key = keyOf(panelId, 'subagent', agentId);
    const prev = get().entries[key];
    if (!prev) return; // 非本面板派生 / 未观察到的派生 —— no-op
    const done: WorkEntry = {
      ...prev,
      state: ok ? 'done' : 'failed',
      endedAt: at ?? Date.now(),
      note: ok ? null : '失败',
    };
    set((s) => {
      const entries = { ...s.entries, [key]: done };
      evictTerminal(entries, panelId);
      return { entries };
    });
  },

  noteShells: (panelId, shells, resolveSession) => {
    const now = Date.now();
    set((s) => {
      const entries = { ...s.entries };
      const seen = new Set<string>();

      for (const job of shells) {
        const id = `job-${job.jobId}`;
        const key = keyOf(panelId, 'shell', id);
        seen.add(key);
        const prev = entries[key];
        entries[key] = {
          id,
          kind: 'shell',
          label: job.label,
          // Rust 只给单调时钟差值（Instant 序列化不出来）⇒ 反推起算时刻。
          // 已在册则保留首次反推值：每轮重算会随截断误差漂移。
          startedAt: prev?.startedAt ?? now - job.elapsedSecs * 1000,
          endedAt: null,
          state: 'running',
          sessionId: resolveSession(job.agent),
          parentAgentId: null,
          note: job.stalled ? '停滞' : null,
        };
      }

      // 在役集合里消失 = 已结束。账本不回流退出码，故只写中性终态 +
      // 如实标注来源（不编造成败——口径纪律②）。
      for (const [key, e] of Object.entries(entries)) {
        if (e.kind !== 'shell' || e.state !== 'running') continue;
        if (!key.startsWith(panelId + '\u0000')) continue;
        if (seen.has(key)) continue;
        entries[key] = { ...e, state: 'done', endedAt: now, note: '已结束' };
      }

      evictTerminal(entries, panelId);
      return { entries, error: { ...s.error, [panelId]: null } };
    });
  },

  noteShellsError: (panelId, message) => {
    set((s) => (s.error[panelId] === message ? s : { error: { ...s.error, [panelId]: message } }));
  },

  clearPanel: (panelId) => {
    set((s) => {
      const entries: Record<string, WorkEntry> = {};
      for (const [k, e] of Object.entries(s.entries)) {
        if (!k.startsWith(panelId + '\u0000')) entries[k] = e;
      }
      const error = { ...s.error };
      delete error[panelId];
      return { entries, error };
    });
  },
}));

// ── owner → 会话归属（非序列化，模块闭包——同 execution-state 的「不可序列化
//    对象在闭包里」纪律）────────────────────────────────────────────────
// Rust 只给裸 owner 串（`main-<ts>-<rand>` / `sub-<ts>-<rand>`，或 null），没有
// 「该 owner 属于哪个会话」的字段（bg_jobs.rs:147）。解析要 bus 的父子树 +
// agentSessionState，两者都在**面板的 runtime** 手里 —— 故由 workspace 在装配时
// 注入（能力位：没注入 = 归属未知，条目仍可见，只是落在「归属未知」档）。

/** owner 串 → 会话 id；解析不出返回 null。 */
export type OwnerSessionResolver = (owner: string | null) => number | null;

const _ownerResolvers = new Map<string, OwnerSessionResolver>();

/** 装配期注入（`null` = 撤销）。workspace 的 setup/teardown 对称调用。 */
export function setOwnerSessionResolver(panelId: string, resolve: OwnerSessionResolver | null): void {
  if (resolve) _ownerResolvers.set(panelId, resolve);
  else _ownerResolvers.delete(panelId);
}

/** `background_activity` 返回体的形状校验（rpc.rs 判 `Text`，前端自己 parse）。 */
function parseShells(raw: unknown): ShellSnapshot[] {
  if (typeof raw !== 'object' || raw === null) throw new Error('background_activity 返回体不是对象');
  const shells = (raw as { shells?: unknown }).shells;
  if (!Array.isArray(shells)) throw new Error('background_activity 缺 shells 数组');
  return shells.map((v): ShellSnapshot => {
    if (typeof v !== 'object' || v === null) throw new Error('shells 元素不是对象');
    const o = v as Record<string, unknown>;
    if (typeof o.jobId !== 'number') throw new Error('shells 元素缺 jobId');
    return {
      jobId: o.jobId,
      label: typeof o.label === 'string' ? o.label : '',
      agent: typeof o.agent === 'string' ? o.agent : null,
      elapsedSecs: typeof o.elapsedSecs === 'number' ? o.elapsedSecs : 0,
      stalled: o.stalled === true,
    };
  });
}

/**
 * 拉一次后台 shell 快照并对账。
 *
 * **只读**：绝不调 `bash_output` —— 那个 action 的增量游标是所有读方共用的，且读到
 * 终态即 `jobs.remove()`，UI 读一次等于吃掉模型随后要用的输出并销毁 job
 * （bg_jobs.rs:474-479）。本函数只调 `background_activity`（纯读 + `try_wait`）。
 *
 * 失败不静默：写进 `error[panelId]`，册页页脚显形（宪法四）。
 */
export async function pullShellWork(panelId: string): Promise<void> {
  const resolve = _ownerResolvers.get(panelId);
  try {
    const raw = await kernelProcessCall('background_activity');
    const shells = parseShells(JSON.parse(raw));
    useWorkLedgerStore.getState().noteShells(panelId, shells, resolve ?? (() => null));
  } catch (e) {
    useWorkLedgerStore.getState().noteShellsError(panelId, e instanceof Error ? e.message : String(e));
  }
}

/** 测试复位：清空全部面板条目、错误与归属解析器。 */
export function resetWorkLedgerForTests(): void {
  _ownerResolvers.clear();
  useWorkLedgerStore.setState({ entries: {}, error: {} });
}

/**
 * 停一条在役后台命令（用户路径）。
 *
 * 所有权：Rust `bash_kill` 的 caller = `owner_id.or(agent_id)`；UI 两个都不带
 * ⇒ caller = None ⇒ 走「用户」分支，**可杀任何 job**（bg_jobs.rs:546-560，
 * 测试 :529-547）——这正是该有的边界：人停自己的机器不需要向 Agent 借身份。
 * 故本处**不**注入 `_owner_id`（那会把 UI 降级成某个 Agent，反倒杀不动别人的）。
 *
 * 失败**不写 `error` 槽**：那是「账本读不出」的位（册页页脚），而这是用户的动作
 * 失败——走提示条，且随后的对账不该把它抹掉（两件事两个面）。
 * 杀完立刻对账一次，让条目马上从「在役」落到「已了」（不等下一个轮询周期）。
 */
export async function killShellWork(panelId: string, jobId: number): Promise<void> {
  try {
    await kernelProcessCall('bash_kill', { job_id: jobId });
  } catch (e) {
    showToast(`停止后台命令失败：${e instanceof Error ? e.message : String(e)}`, 'warn', TOAST_LONG_HOLD_MS);
  }
  await pullShellWork(panelId);
}

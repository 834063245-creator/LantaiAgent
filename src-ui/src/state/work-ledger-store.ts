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
  /** 终态退出码（观测面直给；旧的外推路径为 null）。 */
  exitCode?: number | null;
  /** 终态原因（人杀 = `cancelled by the user`）。 */
  detail?: string | null;
  /** 完整日志文件路径（缺口提示用；没有落盘则为 null）。 */
  spill?: { stdout: string | null; stderr: string | null };
}

/** `process_cap('job_list')` 的一行投影（bg_jobs.rs `job_projection` 逐字）。 */
export interface ShellSnapshot {
  jobId: number;
  label: string;
  agent: string | null;
  elapsedSecs?: number;
  stalled: boolean;
  /** 2026-11-12 观测面：注册表直接给生命周期与结局，不再靠「从在役集合消失」外推。 */
  status?: 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
  exitCode?: number | null;
  detail?: string | null;
  startedAt?: number;
  finishedAt?: number | null;
  /** 输出坐标 + 完整日志路径（缺口提示与「完整日志」入口用）。 */
  output?: {
    stdout: { total: number; earliest: number };
    stderr: { total: number; earliest: number };
    spill?: { stdout: string | null; stderr: string | null };
  };
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
      let changed = false;

      for (const job of shells) {
        const id = `job-${job.jobId}`;
        const key = keyOf(panelId, 'shell', id);
        seen.add(key);
        const sessionId = resolveSession(job.agent);
        const prev = entries[key];
        const status = job.status ?? 'running';
        const live = status === 'running' || status === 'stopping';
        const state: WorkState = live
          ? 'running'
          : status === 'killed'
            ? 'stopped'
            : status === 'failed'
              ? 'failed'
              : 'done';
        const note = live
          ? status === 'stopping'
            ? '停止中'
            : job.stalled
              ? '停滞'
              : null
          : (job.detail ?? (job.exitCode != null && job.exitCode !== 0 ? `退出码 ${job.exitCode}` : '已结束'));
        const startedAt = job.startedAt ?? prev?.startedAt ?? now - (job.elapsedSecs ?? 0) * 1000;
        const endedAt = live ? null : (job.finishedAt ?? now);
        /* 稳定字段逐项对表——全等即原样留用（引用不动 ⇒ 下面能整轮判空）。 */
        if (
          prev &&
          prev.state === state &&
          prev.label === job.label &&
          prev.sessionId === sessionId &&
          prev.note === note &&
          prev.endedAt === endedAt &&
          prev.exitCode === (job.exitCode ?? null)
        ) {
          continue;
        }
        entries[key] = {
          id,
          kind: 'shell',
          label: job.label,
          startedAt,
          endedAt,
          state,
          sessionId,
          parentAgentId: null,
          note,
          exitCode: job.exitCode ?? null,
          detail: job.detail ?? null,
          spill: job.output?.spill ?? { stdout: null, stderr: null },
        };
        changed = true;
      }

      // 名册里彻底消失（历史被淘汰/宿主重启）= 中性收尾，不编造成败。
      for (const [key, e] of Object.entries(entries)) {
        if (e.kind !== 'shell' || e.state !== 'running') continue;
        if (!key.startsWith(panelId + '\u0000')) continue;
        if (seen.has(key)) continue;
        entries[key] = { ...e, state: 'done', endedAt: now, note: '已结束' };
        changed = true;
      }

      /* 空转（快照与账上逐项一致）：**返回原 state 对象**——zustand 的 Object.is
       * 早退让订阅面（坞上的触发器与册页）整轮不重渲。对账自 2026-10-07 起恒跑
       * （触发器恒驻设置行，读数不能等点开——见 WorkLedger 头注），每 3s 惊动
       * 一次订阅面是白烧帧。但既往的读取错误仍要清（那是「账本读不出」的位，
       * 不许被空转吞掉）——这一支照常换引用。 */
      if (!changed) {
        if (s.error[panelId] == null) return s;
        return { error: { ...s.error, [panelId]: null } };
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

/** `job_list` 返回体的形状校验（rpc.rs 判 `Text`，前端自己 parse）。 */
function parseJobs(raw: unknown): ShellSnapshot[] {
  if (!Array.isArray(raw)) throw new Error('job_list 返回体不是数组');
  return raw.map((v): ShellSnapshot => {
    if (typeof v !== 'object' || v === null) throw new Error('job_list 元素不是对象');
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'number') throw new Error('job_list 元素缺 id');
    const output = (typeof o.output === 'object' && o.output !== null ? o.output : {}) as {
      stdout?: { total?: unknown; earliest?: unknown };
      stderr?: { total?: unknown; earliest?: unknown };
      spill?: { stdout?: unknown; stderr?: unknown };
    };
    const coords = (s: { total?: unknown; earliest?: unknown } | undefined) => ({
      total: typeof s?.total === 'number' ? s.total : 0,
      earliest: typeof s?.earliest === 'number' ? s.earliest : 0,
    });
    const status = o.status;
    return {
      jobId: o.id,
      label: typeof o.label === 'string' ? o.label : '',
      agent: typeof o.owner === 'string' ? o.owner : null,
      stalled: o.stalled === true,
      status:
        status === 'running' ||
        status === 'stopping' ||
        status === 'completed' ||
        status === 'killed' ||
        status === 'failed'
          ? status
          : 'running',
      exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
      detail: typeof o.detail === 'string' ? o.detail : null,
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : undefined,
      finishedAt: typeof o.finishedAt === 'number' ? o.finishedAt : null,
      output: {
        stdout: coords(output.stdout),
        stderr: coords(output.stderr),
        spill: {
          stdout: typeof output.spill?.stdout === 'string' ? output.spill.stdout : null,
          stderr: typeof output.spill?.stderr === 'string' ? output.spill.stderr : null,
        },
      },
    };
  });
}

/** 一次观测读取的结果（非消费；游标由调用方持有）。 */
export interface JobReadResult {
  stdout: { text: string; next: number; lossy: boolean };
  stderr: { text: string; next: number; lossy: boolean };
}

/**
 * 拉一次后台 job 名册并对账。
 *
 * **只读且非消费**：`job_list` 是注册表投影，`job_read_at` 按绝对偏移读同一份环，
 * 两者都不移动模型游标、不销毁 job（bg_jobs.rs 双读者模型）。
 *
 * 失败不静默：写进 `error[panelId]`，册页页脚显形（宪法四）。
 */
export async function pullShellWork(panelId: string): Promise<void> {
  const resolve = _ownerResolvers.get(panelId);
  try {
    const raw = await kernelProcessCall('job_list');
    const shells = parseJobs(JSON.parse(raw));
    useWorkLedgerStore.getState().noteShells(panelId, shells, resolve ?? (() => null));
  } catch (e) {
    useWorkLedgerStore.getState().noteShellsError(panelId, e instanceof Error ? e.message : String(e));
  }
}

/** 读一条 job 的新增输出（按绝对字节偏移，不消费）。 */
export async function readJobOutput(jobId: number, stdoutFrom: number, stderrFrom: number): Promise<JobReadResult> {
  const raw = await kernelProcessCall('job_read_at', {
    job_id: jobId,
    stdout_from: stdoutFrom,
    stderr_from: stderrFrom,
  });
  const parsed = JSON.parse(raw) as Partial<JobReadResult>;
  const normalize = (s: { text?: unknown; next?: unknown; lossy?: unknown } | undefined) => ({
    text: typeof s?.text === 'string' ? s.text : '',
    next: typeof s?.next === 'number' ? s.next : 0,
    lossy: s?.lossy === true,
  });
  return { stdout: normalize(parsed.stdout), stderr: normalize(parsed.stderr) };
}

/** 测试复位：清空全部面板条目、错误与归属解析器。 */
export function resetWorkLedgerForTests(): void {
  _ownerResolvers.clear();
  useWorkLedgerStore.setState({ entries: {}, error: {} });
}

/**
 * 停一条在役后台命令（用户路径）。
 *
 * 走 `job_kill_human`：Rust 侧不校验 Agent 所有权（人停自己的机器不需要借身份），
 * 原因记进 detail 并推完成通知——模型知道是用户停的，而不是任务神秘消失。
 *
 * 失败**不写 `error` 槽**：那是「账本读不出」的位（册页页脚），而这是用户的动作
 * 失败——走提示条。杀完立刻对账一次，让条目马上落到终态（不等下一个轮询周期）。
 */
export async function killShellWork(panelId: string, jobId: number): Promise<void> {
  try {
    await kernelProcessCall('job_kill_human', {
      job_id: jobId,
      reason: 'cancelled by the user',
    });
  } catch (e) {
    showToast(`停止后台命令失败：${e instanceof Error ? e.message : String(e)}`, 'warn', TOAST_LONG_HOLD_MS);
  }
  await pullShellWork(panelId);
}

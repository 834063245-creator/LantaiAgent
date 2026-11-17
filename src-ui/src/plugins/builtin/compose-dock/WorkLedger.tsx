// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 役册 — 创作坞的后台工作监视装置（2026-09-22）。
//
// 落位理由（为什么在坞里，而不是新开面板 / 塞进标题栏 / 插进流区）：
//   - **标题栏已经在 2026-09-17 由用户亲手拆除**（设计规格书 §14：旧 `.pp-topbar`
//     56px 布局行整条退役，控制件落成右上浮件 `.pp-chrome`，且该浮件占位处的顶缘
//     边缘滚动感应带随之失效、坞顶被上夹紧到 56px 以免盖死窗口钮）——往那儿长监视面
//     等于重建刚拆的东西，并付出两笔已记账的代价；
//   - **流区是内容不是环境态**：块是消息的派生视图（`paper/translate.ts`），要落盘、
//     有块序、有消息语义，且 `EventKind.Notice` 的 info 级根本没有入流通路
//     （`ui/chat-stream.ts:198-209`）。监视面是实时状态，写进会话记录 = 把运行态
//     混进历史。流区已经有它在上下文里的正确位置：`SubAgentPart`（「这次派生的记录」
//     就地显示），那是记录不是监控台；
//   - **创作坞是唯一同时满足「常显 + 跟活跃会话 + 已有同类先例」的位**：§9.1 已为
//     同类装置立法——墨量册 = 设置行行尾一枚读数件 + 坞内向上开的浮层 + 并入浮层
//     互斥（「坞是『配置 + 输入』的家，用量是落笔前最该看的读数」）。「这一卷现在
//     派了哪些活出去」与「还能喂多少上下文」是同一种读数。坞也已经有运行态一族
//     （停钮 / 后台卷指示 / 底缘呼吸线），役册是这一族的展开面。
//
// 归属铁律不变：坞是视图不是容器。台账真源在 `state/work-ledger-store`（由 Agent
// 侧观察点喂：子 Agent 走 AgentUINotifier、shell 走 `job_list` 名册对账），本册只读。
//
// 排印沿墨量册的册页语言：段题复刻首页节题（方墨锚点 + 字距题字）、条目为
// 「徽 + 主文 + 副行」三层、数值 mono 右对齐。石青 = 机/在役（语义铁律），
// 朱砂仍只归人的动作（句读点朱配额不占）。
//
// 2026-11-27 役册 UX 批（用户要「UI/UX 专项迭代」后的一次性收口）：
//   - **展开输出原本没有样式**（`pp-work-output*` 三份 CSS 分片里一个字都没有，
//     `git log -S` 可证）——网格把 `<pre>` 的固有宽度撑进 `1fr` 列，收起钮被推出
//     面板 217px，输出字号比册页正文还大。本批补齐样式 + `minmax(0,1fr)` + 输出
//     整行跨列；stdout / stderr 分块，贴底才自动跟随；
//   - **已了的条目也能展开**（旧实现只有「在役」可展开，命令跑完的那一刻输出就消失
//     ——而那正是最想回看的时刻）；
//   - **失败可见**：退出码非 0 的 shell 与成功的长得一样，本批给失败档标记；
//   - **外点 / Esc 关闭**（与同行的模型菜单同语义；旧实现只能再点触发器）；
//   - 读数去重、时长口径统一（在役「已 X」/ 已了「用时 X」）、旁注去重、
//     「已了」超量不再静默截断、读账失败在触发器上显形。

import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { WorkEntry, WorkKind } from './host';
import {
  loadSessionJobHistory,
  pullShellWork,
  readJobOutput,
  selectSessionWork,
  useDialogEscape,
  useOutsideClose,
  useWorkLedgerStore,
} from './host';

/** 观测面板的轮询周期：只对**展开的那一行**跑，收起即停（非消费读，安全）。 */
const OBSERVE_MS = 400;
/** 客户端保留的渲染尾巴（UTF-16 码元）；超出后从头丢弃并置缺口标记。 */
const RENDER_TAIL = 128 * 1024;
/** 册页「已了」段一次列出几条（余量另起一行说明，不再静默截断）。 */
const SETTLED_SHOWN = 8;

/** 册页里在役时长读数的心跳——只有册页开着才走（关着不烧帧：计时只服务册页条目）。 */
const ELAPSED_TICK_MS = 900;
/* 后台对账周期——只读 `job_list`（纯元数据，不吃输出）。**恒跑**，
 * 不随册页开合：触发器恒驻设置行，它的读数就是「本卷还有多少活在跑」，
 * 对账不能是「点开才发生」的事（2026-10-07 修用户报「后台任务起停后非得点一下
 * 才计数」）。 */
export const WORK_PULL_MS = 3000;

/** 条目在役时长：`12s` / `3m05s` / `1h07m`（机读小字，不做自然语言）。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** 种徽：子 = 子代理（派生的人）/ 命 = 命令行（发出的令）。 */
const KIND_MARK: Record<WorkKind, string> = { subagent: '子', shell: '命' };
const KIND_TITLE: Record<WorkKind, string> = { subagent: '子代理', shell: '后台命令' };
/** 终态字：done = 进程自己退出（成败看 exitCode）；interrupted = 结局未知。 */
const STATE_LABEL: Record<WorkEntry['state'], string> = {
  running: '在役',
  done: '已了',
  failed: '失败',
  stopped: '已停',
  interrupted: '中断',
};

export interface WorkLedgerProps {
  /** 面板 id —— 台账按面板分桶（`state/work-ledger-store`）。 */
  panelId: string;
  /** 活跃卷 id（null = 无主待命态，触发器不渲染）。 */
  sessionId: number | null;
  /** 活跃卷显示名（册书眉）。 */
  sessionLabel: string;
  /** 卷名反查（「他卷」段用；给不出就显 `案卷 N`）。 */
  sessionNameOf?: (sessionId: number | null) => string;
  /** 停一条在役 shell（写面在宿主：坞只回调）。 */
  onStop?: (entry: WorkEntry) => void;
  open: boolean;
  onToggle: () => void;
}

/** 段题（复刻首页节题：方墨锚点 + 字距题字）——与墨量册同款。 */
function Section({ title }: { title: string }) {
  return (
    <div className="pp-work-section">
      <span className="pp-work-section-mark" aria-hidden="true" />
      <span className="pp-work-section-title">{title}</span>
    </div>
  );
}

/** 客户端渲染尾巴：只留最后 RENDER_TAIL 个码元（长跑命令不把内存喂爆）。 */
function trimTail(text: string): string {
  return text.length > RENDER_TAIL ? text.slice(text.length - RENDER_TAIL) : text;
}

/**
 * 展开行的输出面板：400ms 轮询 `job_read_at`（非消费读），收起即卸载停流。
 *
 * 两块分列（stdout 在上、stderr 在下，各自带小标题）——旧实现把 stderr 拼成
 * `\n[stderr]\n` 塞进同一段文本，既分不出界，也分不出这是错误流。
 * 自动跟随只在**用户贴在底部**时发生（往上翻历史时不抢滚动条）。
 */
function ShellOutput({ jobId, spill }: { jobId: number; spill?: { stdout: string | null; stderr: string | null } }) {
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');
  const [gap, setGap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursors = useRef({ out: 0, err: 0 });
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 用户是否还贴在底部（贴底才自动跟随）。 */
  const stick = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await readJobOutput(jobId, cursors.current.out, cursors.current.err);
        if (cancelled) return;
        cursors.current = { out: r.stdout.next, err: r.stderr.next };
        if (r.stdout.lossy || r.stderr.lossy) setGap(true);
        if (r.stdout.text) setOut((prev) => trimTail(prev + r.stdout.text));
        if (r.stderr.text) setErr((prev) => trimTail(prev + r.stderr.text));
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), OBSERVE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [jobId]);

  useEffect(() => {
    // out/err 只作为「有新字节」的触发器存在（贴底才跟随，见上）
    void out;
    void err;
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [out, err]);

  const logPath = spill?.stdout ?? spill?.stderr ?? null;
  return (
    <div className="pp-work-output-wrap">
      {(gap || logPath) && (
        <div className="pp-work-output-note">
          {gap ? '前面有字节已滚出缓冲' : '完整日志'}
          {logPath ? (
            <span className="pp-work-output-path" data-tip={logPath}>
              {' '}
              · {logPath}
            </span>
          ) : null}
        </div>
      )}
      {error ? <div className="pp-work-output-note">读取失败：{error}</div> : null}
      <div
        className="pp-work-output-box"
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {out ? <pre className="pp-work-output">{out}</pre> : null}
        {err ? (
          <>
            <div className="pp-work-stream-tag">stderr</div>
            <pre className="pp-work-output pp-work-output-err">{err}</pre>
          </>
        ) : null}
        {!out && !err ? <pre className="pp-work-output pp-work-output-idle">（暂无输出）</pre> : null}
      </div>
    </div>
  );
}

/** 一条役：徽 + 主文（label）+ 副行（时长 · 状态 · 旁注）+ 操作 + 可选输出。 */
function Item({
  entry,
  now,
  onStop,
  expanded,
  onToggle,
}: {
  entry: WorkEntry;
  now: number;
  onStop?: (entry: WorkEntry) => void;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const running = entry.state === 'running';
  const observable = entry.kind === 'shell';
  /** 退出码非 0 = 失败：账本直给的数字，不是外推（子 Agent 的失败走 state）。 */
  const bad = entry.kind === 'shell' && entry.exitCode != null && entry.exitCode !== 0;

  /* 副行：时长 · 状态 · 退出码 · 旁注。此前三处重复（「已了 · 已结束」/
     「失败 · 失败」/「exit 1 · 退出码 1」）——旁注与状态字相同的就不再念一遍。 */
  const parts: string[] = [];
  if (running) parts.push(`已 ${formatElapsed(now - entry.startedAt)}`);
  else if (entry.endedAt != null) parts.push(`用时 ${formatElapsed(entry.endedAt - entry.startedAt)}`);
  if (!running) parts.push(STATE_LABEL[entry.state]);
  if (entry.exitCode != null) parts.push(`exit ${entry.exitCode}`);
  if (entry.note && entry.note !== STATE_LABEL[entry.state]) parts.push(entry.note);

  /* 起于几点：时长读数是相对的，账本场景里「什么时候起的」常是第一问。 */
  const started = new Date(entry.startedAt);
  const clock = `${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}`;

  const canExpand = observable && onToggle != null;
  const canStop = running && entry.kind === 'shell' && onStop != null;
  return (
    <li className={`pp-work-item pp-work-${entry.kind} pp-work-state-${entry.state}${bad ? ' pp-work-bad' : ''}`}>
      <span className="pp-work-mark" data-tip={KIND_TITLE[entry.kind]} aria-hidden="true">
        {KIND_MARK[entry.kind]}
      </span>
      <span className="pp-work-body">
        <span className="pp-work-label" data-tip={entry.label}>
          {entry.label || '（无名）'}
        </span>
        <span className="pp-work-sub" data-tip={`起于 ${clock}`}>
          {parts.join(' · ')}
        </span>
      </span>
      {(canExpand || canStop) && (
        <span className="pp-work-actions">
          {canExpand && (
            <button
              type="button"
              className="pp-work-expand"
              aria-expanded={expanded === true}
              aria-label={expanded ? '收起这条命令的输出' : '展开这条命令的输出'}
              data-tip={expanded ? '收起输出' : '展开输出'}
              onClick={onToggle}
            >
              {expanded ? '收' : '看'}
            </button>
          )}
          {/* 停止是人的动作 ⇒ 朱砂。子代理侧暂无逐条停止通道（池对 UI 不可达，
              见台账头注），故只在 shell 条目上出。 */}
          {canStop && (
            <button
              type="button"
              className="pp-work-stop"
              aria-label="停止这条后台命令"
              data-tip="停止本条后台命令"
              onClick={() => onStop(entry)}
            >
              停
            </button>
          )}
        </span>
      )}
      {expanded && observable ? <ShellOutput jobId={Number(entry.id.replace('job-', ''))} spill={entry.spill} /> : null}
    </li>
  );
}

/**
 * 役册（触发器 + 展开面板）。坞内使用：trigger 在书眉行，面板向上开
 * （坞贴屏底，向下没有空间），几何与墨量册同档。
 */
export const WorkLedger = memo(function WorkLedger({
  panelId,
  sessionId,
  sessionLabel,
  sessionNameOf,
  onStop,
  open,
  onToggle,
}: WorkLedgerProps) {
  const entries = useWorkLedgerStore((s) => s.entries);
  const error = useWorkLedgerStore((s) => s.error[panelId] ?? null);
  const [now, setNow] = useState(() => Date.now());
  // 展开的 job（一次只开一行：输出面板只对可见行开流，收起即停）。
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const selRef = useRef<HTMLDivElement | null>(null);
  const panelDomId = useId();

  /* 外点 / Esc 关闭（2026-11-27）：同行的模型菜单两样都有，两枚读数册此前都没有——
     用户按惯例点一下空白或按 Esc，册页纹丝不动。语义对齐即可，不新造交互。 */
  const close = useCallback(() => {
    if (open) onToggle();
  }, [open, onToggle]);
  useOutsideClose(selRef, close, { enabled: open });
  useDialogEscape(close, { enabled: open });

  // 在役计时：只在册页打开时走（关着不烧帧——`now` 只喂册页里的时长读数）。
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => window.clearInterval(t);
  }, [open]);

  /* 对账恒跑（不随 `open`）：触发器恒驻书眉行，「还有多少活在跑」是它自己的读数
   * ——台上起停一条后台命令，指示器必须自己亮/灭。此前这一跳只在册页打开时发生，
   * 册页外的变化只能靠用户点一下补齐（2026-10-07 用户报的病灶）。
   *
   * 为什么是轮询而不是等事件：会话侧**没有**「job 已启动」事件；唯一的终态事件
   * `bg:note` 也会漏——job 被 `bash_output`/`bash_wait`/`kill_bg` 提前移除时
   * （bg_jobs.rs:475/526/572），监视线程下一拍 `jobs.get_mut` 拿到 None 直接
   * return，那一跳随 job 一起没了 ⇒ 名册对账是本账在役集合的唯一来源
   * （口径见 `state/work-ledger-store` 头注）。空转那一轮由台账自己做引用守卫，
   * 不惊动本组件的订阅面。 */
  useEffect(() => {
    void pullShellWork(panelId);
    const t = window.setInterval(() => void pullShellWork(panelId), WORK_PULL_MS);
    return () => window.clearInterval(t);
  }, [panelId]);

  /* 重启可查：打开/切换卷时，把该卷日志里的 job/* 事件投影进册
   *（有注册无结算 ⇒ 标「中断」，不编造成功）。只补名册里还没有的行。 */
  useEffect(() => {
    if (sessionId != null) loadSessionJobHistory(panelId, sessionId);
  }, [panelId, sessionId]);

  // 读面走 store 的**同一个选择器**（纯函数，与测试/其他消费面同一把尺子；
  // entries 只是响应式触发切片）。
  const { running, settled, others } = selectSessionWork(entries, panelId, sessionId);
  const subCount = running.filter((e) => e.kind === 'subagent').length;
  const shellCount = running.filter((e) => e.kind === 'shell').length;
  /* 「他卷」段与「归属未知」段分开：owner 解析不出会话的条目不是「别的卷」，
     旧实现把它们混在一段里，段题与内容对不上。 */
  const elsewhereList = others.filter((e) => e.sessionId != null);
  const unknownList = others.filter((e) => e.sessionId == null);
  const elsewhere = others.length;
  const failedRead = error != null;
  const toggleRow = (key: string) => setExpandedKey((k) => (k === key ? null : key));

  return (
    <div className="pp-work-sel" ref={selRef}>
      <button
        type="button"
        className={`pp-work-trigger${open ? ' open' : ''}${running.length > 0 ? ' live' : ''}${
          failedRead ? ' error' : ''
        }`}
        /* 2026-11-09 密度批：空档只留役点（同墨量册）——「役 —」61px 只为说明"没有"，
           而书眉行正缺这点宽度。2026-11-27 修正：判据只看**在役**（旧判据把「已了」
           也算进去，于是只要这卷跑过任何一条活，触发器就永久占着那 61px 写「役 —」）。
           真值仍在 aria-label / data-tip-hint 里。 */
        data-empty={running.length === 0 ? '' : undefined}
        aria-label={
          failedRead
            ? '役册——后台账本读取失败'
            : running.length > 0
              ? `役册——本卷在役 ${running.length} 条${elsewhere > 0 ? `，另 ${elsewhere} 条在他卷` : ''}`
              : '役册——本卷在役与已了的后台工作'
        }
        data-tip="役册"
        data-tip-hint={
          failedRead
            ? `后台账本读取失败：${error}`
            : running.length > 0
              ? `本卷在役 ${running.length} 条（子代理 ${subCount} · 后台命令 ${shellCount}）${
                  elsewhere > 0 ? `，另 ${elsewhere} 条在他卷` : ''
                }`
              : '本卷在役与已了的后台工作'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelDomId}
        onClick={onToggle}
      >
        {/* 役点 = 在役信号：空档灰墨点，有活转石青并呼吸——呼吸走 CSS 族
            （pp-ink-live，与落笔点/呼吸线同拍，动效敏感用户由 foundation.css
            全局豁免成静态）。读账失败时转朱砂（这是「账本读不出」，不是「没活」）。 */}
        <span className="pp-work-trigger-dot" aria-hidden="true" />
        <span className="pp-work-trigger-label" aria-live="polite" aria-atomic="true">
          役 {running.length > 0 ? running.length + (elsewhere > 0 ? `+${elsewhere}` : '') : '—'}
        </span>
      </button>

      {open && (
        <div className="pp-work-panel" id={panelDomId} role="dialog" aria-label="役册">
          <div className="pp-work-head">
            <span className="pp-work-head-title">役 · {sessionLabel}</span>
            {/* 读数只留「已了」这一半：在役条数由下方大号读数承担（旧实现两处重复）。 */}
            {settled.length > 0 && <span className="pp-work-head-figures">已了 {settled.length}</span>}
          </div>

          {/* 空态（2026-10-22 P2）：零在役时只留一句；去处说明只在**真·空册**时出现
              （有已了条目时它还挂着，会与下面的「已了」段自相矛盾）。 */}
          {running.length > 0 ? (
            <>
              {/* 读数（全册唯一题字）：在役条数——石青 = 机/运行态 */}
              <div className="pp-work-reading">
                <span className="pp-work-count live">{running.length}</span>
                <span className="pp-work-reading-label">在役</span>
              </div>
              <p className="pp-work-note">
                子代理 {subCount} · 后台命令 {shellCount}
                {elsewhere > 0 && (
                  <>
                    <span className="pp-work-note-sep" aria-hidden="true">
                      ·
                    </span>
                    他卷 {elsewhere}
                  </>
                )}
              </p>
              <Section title="在役" />
              <ul className="pp-work-list">
                {running.map((e) => (
                  <Item
                    key={`${e.kind}:${e.id}`}
                    entry={e}
                    now={now}
                    onStop={onStop}
                    expanded={expandedKey === `${e.kind}:${e.id}`}
                    onToggle={() => toggleRow(`${e.kind}:${e.id}`)}
                  />
                ))}
              </ul>
            </>
          ) : (
            <>
              <div className="pp-work-empty">本卷无在役</div>
              {settled.length === 0 && elsewhere === 0 && (
                <p className="pp-work-empty-sub">子代理与后台命令会在这里出现</p>
              )}
            </>
          )}

          {elsewhereList.length > 0 && (
            <>
              <Section title="他卷" />
              <ul className="pp-work-list">
                {elsewhereList.map((e) => (
                  <li key={`${e.kind}:${e.id}`} className={`pp-work-item pp-work-${e.kind}`}>
                    <span className="pp-work-mark" data-tip={KIND_TITLE[e.kind]} aria-hidden="true">
                      {KIND_MARK[e.kind]}
                    </span>
                    <span className="pp-work-body">
                      <span className="pp-work-label" data-tip={e.label}>
                        {e.label || '（无名）'}
                      </span>
                      <span className="pp-work-sub">
                        {sessionNameOf?.(e.sessionId) ?? `案卷 ${e.sessionId}`} · 已 {formatElapsed(now - e.startedAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {unknownList.length > 0 && (
            <>
              <Section title="归属未知" />
              <ul className="pp-work-list">
                {unknownList.map((e) => (
                  <li key={`${e.kind}:${e.id}`} className={`pp-work-item pp-work-${e.kind}`}>
                    <span className="pp-work-mark" data-tip={KIND_TITLE[e.kind]} aria-hidden="true">
                      {KIND_MARK[e.kind]}
                    </span>
                    <span className="pp-work-body">
                      <span className="pp-work-label" data-tip={e.label}>
                        {e.label || '（无名）'}
                      </span>
                      <span className="pp-work-sub">归属未知 · 已 {formatElapsed(now - e.startedAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {settled.length > 0 && (
            <>
              <Section title="已了" />
              <ul className="pp-work-list">
                {settled.slice(0, SETTLED_SHOWN).map((e) => (
                  <Item
                    key={`${e.kind}:${e.id}`}
                    entry={e}
                    now={now}
                    expanded={expandedKey === `${e.kind}:${e.id}`}
                    onToggle={() => toggleRow(`${e.kind}:${e.id}`)}
                  />
                ))}
              </ul>
              {settled.length > SETTLED_SHOWN && (
                <p className="pp-work-more">另有 {settled.length - SETTLED_SHOWN} 条更早的已了</p>
              )}
            </>
          )}

          <p className="pp-work-foot">
            {error ? `⚠ 后台账本读取失败：${error}` : '本窗记账 · 终态与退出码来自后台账本'}
          </p>
        </div>
      )}
    </div>
  );
});

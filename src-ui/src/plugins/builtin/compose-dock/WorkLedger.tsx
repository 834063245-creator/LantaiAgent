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
// 侧观察点喂：子 Agent 走 AgentUINotifier、shell 走 background_activity 对账），
// 本册只读。
//
// 排印沿墨量册的册页语言：段题复刻首页节题（方墨锚点 + 字距题字）、条目为
// 「徽 + 主文 + 副行」三层、数值 mono 右对齐。石青 = 机/在役（语义铁律），
// 朱砂仍只归人的动作（句读点朱配额不占）。

import { memo, useEffect, useState } from 'react';
import type { WorkEntry, WorkKind } from './host';
import { pullShellWork, selectSessionWork, useWorkLedgerStore } from './host';

/** 在役呼吸点翻转周期（与状态字同族）。 */
const PULSE_MS = 900;
/** 册页打开期间的后台对账周期——只读 `background_activity`（纯元数据，不吃输出）。 */
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
/** 终态字：done 是中性的「已了」——账本不回流 shell 退出码，不编造成败。 */
const STATE_LABEL: Record<WorkEntry['state'], string> = {
  running: '在役',
  done: '已了',
  failed: '失败',
  stopped: '已停',
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

/** 一条役：徽 + 主文（label）+ 副行（时长 · 状态 · 旁注）+ 可选停止钮。 */
function Item({ entry, now, onStop }: { entry: WorkEntry; now: number; onStop?: (entry: WorkEntry) => void }) {
  const ended = entry.endedAt ?? now;
  const running = entry.state === 'running';
  const sub = [
    running ? `已 ${formatElapsed(ended - entry.startedAt)}` : formatElapsed(ended - entry.startedAt),
    running ? null : STATE_LABEL[entry.state],
    entry.note,
  ]
    .filter((s): s is string => !!s)
    .join(' · ');
  return (
    <li className={`pp-work-item pp-work-${entry.kind} pp-work-state-${entry.state}`}>
      <span className="pp-work-mark" title={KIND_TITLE[entry.kind]} aria-hidden="true">
        {KIND_MARK[entry.kind]}
      </span>
      <span className="pp-work-body">
        <span className="pp-work-label" title={entry.label}>
          {entry.label || '（无名）'}
        </span>
        <span className="pp-work-sub">{sub}</span>
      </span>
      {/* 停止是人的动作 ⇒ 朱砂。子代理侧暂无逐条停止通道（池对 UI 不可达，
          见台账头注），故只在 shell 条目上出。 */}
      {running && entry.kind === 'shell' && onStop && (
        <button type="button" className="pp-work-stop" title="停这一条后台命令" onClick={() => onStop(entry)}>
          停
        </button>
      )}
    </li>
  );
}

/**
 * 役册（触发器 + 展开面板）。坞内使用：trigger 在设置行「思考」与「墨量册」之间，
 * 面板向上开（坞贴屏底，向下没有空间），几何与墨量册同档。
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
  const [pulse, setPulse] = useState(false);

  // 在役计时 + 呼吸点：只在册页打开时走（关着不烧帧）。
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => {
      setNow(Date.now());
      setPulse((p) => !p);
    }, PULSE_MS);
    return () => window.clearInterval(t);
  }, [open]);

  // 打开即对账一次（节点外发生的变化靠它补齐）。
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    void pullShellWork(panelId);
    const t = window.setInterval(() => void pullShellWork(panelId), WORK_PULL_MS);
    return () => window.clearInterval(t);
  }, [open, panelId]);

  // 读面走 store 的**同一个选择器**（纯函数，与测试/其他消费面同一把尺子；
  // entries 只是响应式触发切片）。
  const { running, settled, others } = selectSessionWork(entries, panelId, sessionId);
  const subCount = running.filter((e) => e.kind === 'subagent').length;
  const shellCount = running.filter((e) => e.kind === 'shell').length;
  const elsewhere = others.length;

  return (
    <div className="pp-work-sel">
      <button
        type="button"
        className={`pp-work-trigger${open ? ' open' : ''}${running.length > 0 ? ' live' : ''}`}
        title={
          running.length > 0
            ? `役册——本卷在役 ${running.length} 条（子 ${subCount} · 命 ${shellCount}）${
                elsewhere > 0 ? `，另 ${elsewhere} 条在他卷` : ''
              }`
            : '役册——本卷在役与已了的后台工作（子代理 / 后台命令）'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={`pp-work-trigger-dot${pulse && running.length > 0 ? ' on' : ''}`} aria-hidden="true" />
        <span className="pp-work-trigger-label">
          役 {running.length > 0 ? running.length + (elsewhere > 0 ? `+${elsewhere}` : '') : '—'}
        </span>
      </button>

      {open && (
        <div className="pp-work-panel" role="dialog" aria-label="役册">
          <div className="pp-work-head">
            <span className="pp-work-head-title">役 · {sessionLabel}</span>
            <span className="pp-work-head-figures">
              {running.length} 在役 · {settled.length} 已了
            </span>
          </div>

          {/* 读数（全册唯一题字）：在役条数——石青 = 机/运行态 */}
          <div className="pp-work-reading">
            <span className={`pp-work-count${running.length > 0 ? ' live' : ''}`}>{running.length}</span>
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
          {running.length === 0 ? (
            <div className="pp-work-empty">本卷无在役</div>
          ) : (
            <ul className="pp-work-list">
              {running.map((e) => (
                <Item key={`${e.kind}:${e.id}`} entry={e} now={now} onStop={onStop} />
              ))}
            </ul>
          )}

          {elsewhere > 0 && (
            <>
              <Section title="他卷" />
              <ul className="pp-work-list">
                {others.map((e) => (
                  <li key={`${e.kind}:${e.id}`} className={`pp-work-item pp-work-${e.kind}`}>
                    <span className="pp-work-mark" title={KIND_TITLE[e.kind]} aria-hidden="true">
                      {KIND_MARK[e.kind]}
                    </span>
                    <span className="pp-work-body">
                      <span className="pp-work-label" title={e.label}>
                        {e.label || '（无名）'}
                      </span>
                      <span className="pp-work-sub">
                        {sessionNameOf?.(e.sessionId) ?? (e.sessionId == null ? '归属未知' : `案卷 ${e.sessionId}`)} ·{' '}
                        {formatElapsed(now - e.startedAt)}
                        {e.note ? ` · ${e.note}` : ''}
                      </span>
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
                {settled.slice(0, 8).map((e) => (
                  <Item key={`${e.kind}:${e.id}`} entry={e} now={now} />
                ))}
              </ul>
            </>
          )}

          <p className="pp-work-foot">
            {error ? `⚠ 后台账本读取失败：${error}` : '本窗记账 · 后台命令的终态由账本外推，不报退出码'}
          </p>
        </div>
      )}
    </div>
  );
});

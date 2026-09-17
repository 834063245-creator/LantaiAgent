// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// StatusLine — 顶部浮件状态字（C12，2026-08-22；2026-09-17 随浮件自书眉迁入）。
//
// 承接面：shell-store 的 statusText（pushStatus 写入——工作区流大量调用：
// 图谱预热/分析进度/切换提示/插件 notify 等）。V5 拆状态栏后这些信息
// 对用户不可见，本组件把它接回窗口顶部的常显面（与 .pp-zoom-ctl 同语言：mono 小字）。
//
// 展示语义：
//   - analyzing 徽标（◆ 分析中）优先展示——后台预热/分析是用户最关心的
//     异步态，闪烁点提示「正在干活」；
//   - 其余时刻显示 statusText 最新一条；
//   - hover 展开 statusLog 环（最近 15 条）——可追溯但不占常驻位。
//
// 纸面运行态（2026-09-06）：活跃卷 Agent 在跑 → 「行卷中」（running prop，
// PaperPanel 自 runningSessions 真源传入）插在警报之后、分析之前——
// 前台回合是用户视线焦点，比后台分析优先；呼吸点/石青与「分析中」同语言。
//
// 挂载：PaperPanel 顶部浮件（pp-zoom-ctl 旁）。app 级单例 store，无面板生命周期。
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享真实例。

import { memo, useEffect, useRef, useState } from 'react';
import { useBgAlertStore, useDialogEscape, useShellStore } from './host';
import './status-line.css';

const ACTIVITY_PULSE_MS = 900;

/** 日志时刻 HH:mm（跨天记录少见——状态日志是会话级短周期，不做日期展开） */
function formatLogTime(at: number): string {
  const d = new Date(at);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return h + ':' + m;
}

export const StatusLine = memo(function StatusLine({ running = false }: { running?: boolean }) {
  const statusText = useShellStore((s) => s.statusText);
  const statusLog = useShellStore((s) => s.statusLog);
  const analyzing = useShellStore((s) => s.analyzing);
  const bgAlert = useBgAlertStore((s) => s.bgAlert);
  const [logOpen, setLogOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [alertDismissedId, setAlertDismissedId] = useState('');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const alertId = bgAlert?.id ?? '';

  // 警报 id 变化（含成功解除后同源再失败）→ 提示条重新可弹（拍板 C：每次进入失败态弹一次）。
  // React 官方「props/state 变化时重置 state」模式——render 期调 setState，免 effect 免依赖。
  const [prevAlertId, setPrevAlertId] = useState(alertId);
  if (prevAlertId !== alertId) {
    setPrevAlertId(alertId);
    setAlertDismissedId('');
  }

  // 分析中的呼吸点（可停原则：CSS transition + 定时翻转，卸载即清）。
  // 纸面运行态（2026-09-06）：行卷中共用同一呼吸点。
  useEffect(() => {
    if (!analyzing && !running) {
      setPulse(false);
      return;
    }
    const t = window.setInterval(() => setPulse((p) => !p), ACTIVITY_PULSE_MS);
    return () => window.clearInterval(t);
  }, [analyzing, running]);

  // 外点收起日志（弹层一致性，2026-08 UI 大清扫）
  useEffect(() => {
    if (!logOpen) return;
    const onDown = (e: MouseEvent) => {
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) setLogOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [logOpen]);

  // Esc 关闭日志弹层（2026-08-29 overlay 原语收编：非模态气泡——不拦冒泡不挡默认）
  useDialogEscape(() => setLogOpen(false), { enabled: logOpen, capture: false, blockPropagation: false });

  const busy = running || analyzing !== null;
  const alerting = bgAlert !== null;

  return (
    <div ref={hostRef} className="sl-root">
      <button
        type="button"
        className={`sl-chip${busy ? ' sl-chip--busy' : ''}${alerting ? ' sl-chip--warn' : ''}`}
        title={alerting ? `后台警报：${bgAlert?.msg ?? ''}（点击查看最近记录）` : '状态（点击查看最近记录）'}
        aria-label={`工作区状态：${alerting ? `后台警报 ${bgAlert?.msg ?? ''}` : running ? '行卷中' : busy ? '分析中' : statusText}`}
        aria-expanded={logOpen}
        onClick={() => setLogOpen((v) => !v)}
      >
        {alerting && <span className="sl-warn-dot" aria-hidden="true" />}
        {!alerting && busy && <span className={`sl-dot${pulse ? ' sl-dot--on' : ''}`} aria-hidden="true" />}
        <span className="sl-text">
          {alerting
            ? `⚠ ${bgAlert?.msg ?? ''}`
            : running
              ? '行卷中'
              : busy
                ? analyzing === 'reanalyze'
                  ? '重分析中'
                  : '分析中'
                : statusText}
        </span>
      </button>
      {alerting && alertDismissedId !== alertId && (
        // 拍板 C：每次进入失败态弹一次提示条；「知道了」只收提示条，警告档随失败解除才消失
        <div className="sl-alert" role="alert">
          <span className="sl-alert-msg">{bgAlert?.msg}</span>
          <button type="button" className="sl-alert-ok" onClick={() => setAlertDismissedId(alertId)}>
            知道了
          </button>
        </div>
      )}
      {logOpen && (
        <div className="sl-log" role="log" aria-label="最近状态记录">
          {statusLog.length === 0 ? (
            <div className="sl-log-empty">暂无记录</div>
          ) : (
            [...statusLog].reverse().map((e) => (
              <div key={e.id} className="sl-log-line">
                {e.at != null && <span className="sl-log-time">{formatLogTime(e.at)}</span>}
                {e.msg}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
});

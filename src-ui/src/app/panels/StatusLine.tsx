// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT.

// StatusLine — 书眉状态字（C12，2026-08-22）。
//
// 承接面：shell-store 的 statusText（pushStatus 写入——工作区流大量调用：
// 图谱预热/分析进度/切换提示/插件 notify 等）。V5 拆状态栏后这些信息
// 对用户不可见，本组件把它接回书眉（与 .pp-zoom 同语言：mono 小字）。
//
// 展示语义：
//   - analyzing 徽标（◆ 分析中）优先展示——后台预热/分析是用户最关心的
//     异步态，闪烁点提示「正在干活」；
//   - 其余时刻显示 statusText 最新一条；
//   - hover 展开 statusLog 环（最近 15 条）——可追溯但不占常驻位。
//
// 挂载：PaperPanel 书眉（pp-zoom 旁）。app 级单例 store，无面板生命周期。

import { useEffect, useRef, useState } from 'react';
import { useShellStore } from '../shell-store';
import './status-line.css';

const ACTIVITY_PULSE_MS = 900;

/** 日志时刻 HH:mm（跨天记录少见——状态日志是会话级短周期，不做日期展开） */
function formatLogTime(at: number): string {
  const d = new Date(at);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return h + ':' + m;
}

export function StatusLine() {
  const statusText = useShellStore((s) => s.statusText);
  const statusLog = useShellStore((s) => s.statusLog);
  const analyzing = useShellStore((s) => s.analyzing);
  const [logOpen, setLogOpen] = useState(false);
  const [pulse, setPulse] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // 分析中的呼吸点（可停原则：CSS transition + 定时翻转，卸载即清）
  useEffect(() => {
    if (!analyzing) {
      setPulse(false);
      return;
    }
    const t = window.setInterval(() => setPulse((p) => !p), ACTIVITY_PULSE_MS);
    return () => window.clearInterval(t);
  }, [analyzing]);

  // 外点收起日志 + Esc 关闭（弹层键盘一致性，2026-08 UI 大清扫）
  useEffect(() => {
    if (!logOpen) return;
    const onDown = (e: MouseEvent) => {
      if (hostRef.current && !hostRef.current.contains(e.target as Node)) setLogOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLogOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [logOpen]);

  const busy = analyzing !== null;

  return (
    <div ref={hostRef} className="sl-root">
      <button
        type="button"
        className={`sl-chip${busy ? ' sl-chip--busy' : ''}`}
        title="状态（点击查看最近记录）"
        aria-label={`工作区状态：${busy ? '分析中' : statusText}`}
        aria-expanded={logOpen}
        onClick={() => setLogOpen((v) => !v)}
      >
        {busy && <span className={`sl-dot${pulse ? ' sl-dot--on' : ''}`} aria-hidden="true" />}
        <span className="sl-text">{busy ? (analyzing === 'reanalyze' ? '重分析中' : '分析中') : statusText}</span>
      </button>
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
}

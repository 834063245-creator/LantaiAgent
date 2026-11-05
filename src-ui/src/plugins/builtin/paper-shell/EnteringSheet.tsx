// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// EnteringSheet — 展卷页（2026-11-05 入口 UX 批，用户拍板「进区给一个加载态页面」）。
//
// 它接的是 switchWorkspace 的三段（binding → assembling → restoring）：阶段由流程
// 推进、不由计时器猜。旧 UX 的等待藏在一行 11px 状态字后面，这里把它变成一张有
// 名字、有阶段的纸——首页点击不再被丢弃，也不会再看见「旧区纸面 → 空案头」两帧。
//
// 三个阈值（各有理由）：
//   · 最短停留由流程侧保证（ENTRY_MIN_MS = 320）——秒开时展卷页不闪一帧；
//   · 8s 起换成「仍在展开」——大工作区首次装配本机实测 3~5s，8s 已是慢；
//   · 20s 亮「回案头」——旧版的卡死逃生口是 60s 且长在首页；展卷页有名字有阶段，
//     用户对「还在动吗」的容忍度更低，20s 足够区分「慢」与「挂」。
// 失败态 = 具名原因 + 重试 / 回案头（旧版只 pushStatus + 状态栏一行字）。

import { useEffect, useState } from 'react';
import { abortWorkspaceEntry, retryWorkspaceEntry, useDockStore, useWorkspaceEntryStore } from './host';
import './entering-sheet.css';

/** 三段（与 switchWorkspace 的三处 await 一一对应）。 */
const STEPS = [
  { id: 'binding', zh: '落位', sub: '激活工作区目录' },
  { id: 'assembling', zh: '装订', sub: '装配案卷（Agent）' },
  { id: 'restoring', zh: '展卷', sub: '铺回上次摊开的卷' },
] as const;

/** 慢速提示阈值（ms）。 */
const SLOW_MS = 8_000;
/** 逃生口阈值（ms）——旧版 60s 长在首页，这里 20s 长在展卷页。 */
const STUCK_MS = 20_000;

export function EnteringSheet() {
  const name = useWorkspaceEntryStore((s) => s.name);
  const phase = useWorkspaceEntryStore((s) => s.phase);
  const startedAt = useWorkspaceEntryStore((s) => s.startedAt);
  const error = useWorkspaceEntryStore((s) => s.error);
  // 走秒（只重渲这页；500ms 一跳，不必 1s——用户读的是「在动」）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);

  /* 展卷期间纸面不可被「回首页」确认层 / 命令面板二次关闭：守卫归本页所有。
   * 条件清理（只在当前守卫仍是本页那枚时摘）——成功落纸的同一次 commit 里会先
   * 卸载本页、再挂载 PaperPanel，两边都注册/摘除「paper」守卫；无条件摘会把
   * PaperPanel 刚注册的那枚抹掉（不该假设两边的执行顺序）。 */
  useEffect(() => {
    const guard = () => false;
    useDockStore.getState().registerCloseGuard('paper', guard);
    return () => {
      const dock = useDockStore.getState();
      if (dock.closeGuards.paper === guard) dock.unregisterCloseGuard('paper');
    };
  }, []);

  const elapsed = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
  const seconds = Math.floor(elapsed / 1000);
  const failed = error != null;
  const activeIdx = Math.max(
    0,
    STEPS.findIndex((s) => s.id === phase),
  );
  const slow = !failed && elapsed >= SLOW_MS;
  const stuck = !failed && elapsed >= STUCK_MS;

  return (
    <div className={'pp-entry' + (failed ? ' pp-entry--fault' : '')} role="status" aria-live="polite">
      <div className="pp-entry-sheet">
        <div className="pp-entry-kicker">{failed ? '开卷未成' : '展卷'}</div>
        <h1 className="pp-entry-name" title={name}>
          {name}
        </h1>
        <div className="pp-entry-rule" aria-hidden="true" />
        {failed ? (
          <>
            <p className="pp-entry-fault">{error}</p>
            <div className="pp-entry-acts">
              <button type="button" className="pp-entry-primary" onClick={retryWorkspaceEntry}>
                重试
              </button>
              <button type="button" className="pp-entry-link" onClick={() => void abortWorkspaceEntry()}>
                回案头
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="pp-entry-steps">
              {STEPS.map((step, i) => (
                <li
                  key={step.id}
                  className={'pp-entry-step' + (i < activeIdx ? ' is-done' : '') + (i === activeIdx ? ' is-now' : '')}
                  aria-current={i === activeIdx ? 'step' : undefined}
                >
                  <span className="pp-entry-dot" aria-hidden="true" />
                  <span className="pp-entry-zh">{step.zh}</span>
                  <span className="pp-entry-sub">{step.sub}</span>
                </li>
              ))}
            </ol>
            <p className="pp-entry-note">
              <span>{slow ? '仍在展开……首次打开大工作区会慢一些。' : '正在把案卷摆回案上。'}</span>
              {elapsed >= 1_200 && <span className="pp-entry-clock">{seconds}s</span>}
            </p>
            {stuck && (
              <div className="pp-entry-acts">
                <button type="button" className="pp-entry-link" onClick={() => void abortWorkspaceEntry()}>
                  回案头（若长时间没有动静）
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

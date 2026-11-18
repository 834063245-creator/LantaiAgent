// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 快捷键总览（2026-11-28）——「案」抽屉退役后的新家。
//
// 来由：「案」抽屉的五项里，组合 / 图版 / 翰 / 造模式 都已有等价入口，只剩「律 = 快捷键
// 总览」一件真东西。它是一张**帮助页**，不该住在一个「本卷设置」的分诊抽屉里，更不该
// 让用户先找到那个抽屉才看得到键位。⇒ 搬到 app 层做成一个独立浮层，入口 = 全局搜索
// （Ctrl+K 搜「快捷键」）与 `runAction('shortcuts')`。
//
// 交互沿用全库同一套原语（与命令面板同门）：遮罩 + 纸面 + `mountDialogFocus` 圈定 +
// `useOutsideClose` 外点关闭 + Esc 关闭（capture 阶段吃掉，免得被下层 Esc 抢走）。
//
// 数据面 = `app/help/shortcut-groups.ts`（单一真源，改键位只改那一处）。

import { useEffect, useRef } from 'react';
import { mountDialogFocus } from './dialog-focus';
import { SHORTCUT_GROUPS } from './help/shortcut-groups';
import { useOutsideClose } from './overlay';
import { useShellStore } from './shell-store';

export function HelpSheet() {
  const open = useShellStore((s) => s.helpOpen);
  const setOpen = useShellStore((s) => s.setHelpOpen);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 打开：焦点进浮层 + Tab 圈定 + 关闭归还打开者（与命令面板同一原语，不另造）
  useEffect(() => {
    if (!open || !boxRef.current) return;
    return mountDialogFocus(boxRef.current);
  }, [open]);

  useOutsideClose(boxRef, () => setOpen(false), { enabled: open });

  // Esc = 关（capture 阶段：下层画布的逐层关闭不该同时吃到这一下）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="help-veil" role="presentation">
      <div className="help-box" role="dialog" aria-label="快捷键总览" ref={boxRef}>
        <div className="help-head">
          <span className="help-title">快捷键</span>
          <button type="button" className="help-close" onClick={() => setOpen(false)}>
            关闭
          </button>
        </div>
        <div className="help-cols">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} className="help-group" aria-label={g.title}>
              <div className="help-group-title">{g.title}</div>
              {g.rows.map(([key, desc]) => (
                <div key={key} className="help-row">
                  <span className="help-key">{key}</span>
                  <span className="help-desc">{desc}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

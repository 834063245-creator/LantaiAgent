// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// sheet-parts — 待题纸（纸期创作坞）**特有**的两件表现件（2026-11-15 V2 立卷 UX）。
//
// 为什么单独立文件：ComposerDock 是「同一个面、两种宿主」，纸期只多出两件
// （题签芯片 + 纸期书眉）。把它们留在坞里会让那个 1700 行的文件再长一档——
// 而这两件**只被纸期分支用到**，拆出去是零语义成本的分家（坞本体一字不知）。
//
// 纪律：本件只吃 props（显示名 / 开合态 / roster / 回调），不碰 store、不碰 core
// ——组合的读写真源仍在坞（它已经算好），纸期只是换了个宿主渲染。

import { useState } from 'react';
import { MODE_DESCRIPTIONS, MODE_LABELS, PERMISSION_MODES, type PermissionMode } from './host';

/** 题签（纸期设置行的左端）：组合芯片 + 下拉。
 *
 *  与坞期「案 › 组合」那枚是**同一把尺子**（presetRoster + presetError），只是宿主
 *  不同：纸上是常驻一枚（纸只有两件事可题），坞里收进抽屉（坞面要克制）。 */
export function SheetSign({
  label,
  open,
  error,
  roster,
  onToggle,
  onPick,
}: {
  label: string;
  open: boolean;
  error: string | null;
  roster: ReadonlyArray<{
    id: string;
    patch: unknown;
    error?: string;
    metadata?: { name?: string; description?: string };
  }>;
  onToggle: () => void;
  onPick: (id: string) => void;
}) {
  return (
    /* 定位盒（2026-11-28 第二次报障批）：菜单是绝对定位件，**必须有自己的一层**
     * ——挂在签条上（.pp-composer-settings）会让它出现在签条两行之下、并与「权限」的
     * 菜单错位；本层与 .pp-sheet-perm 同形，两个下拉都开在自己那枚按钮的正下方。 */
    <div className="pp-sheet-sign">
      <button
        type="button"
        className={`pp-sheet-comp${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip={error ?? `本卷组合：${label}`}
        data-tip-hint="开卷那一刻落账——跑过一轮即锁"
        onClick={onToggle}
      >
        <span className="pp-sheet-comp-k">组合</span>
        <span className="pp-sheet-comp-v">{label}</span>
        <span className="pp-sheet-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="pp-comp-menu pp-comp-menu-inline" role="listbox" aria-label="组合（preset）">
          {roster.map((pr) => (
            <button
              key={pr.id}
              type="button"
              role="option"
              aria-selected={pr.id === label}
              className={`pp-comp-opt${pr.id === label ? ' selected' : ''}`}
              disabled={pr.patch === null}
              data-tip={pr.patch === null ? '装载失败' : pr.metadata?.description}
              data-tip-hint={pr.patch === null ? (pr.error ?? 'roster.patch.yml 不可用') : undefined}
              onClick={() => onPick(pr.id)}
            >
              {pr.metadata?.name ?? pr.id}
              {pr.patch === null ? '（损坏）' : ''}
            </button>
          ))}
          {error && <div className="pp-comp-note">⚠ {error}</div>}
        </div>
      )}
    </div>
  );
}

/** **题签第四格 · 权限**（2026-11-28 权限卷级批）：这一卷跟 Agent 怎么相处。
 *
 *  与坞期权限段是**同一个开关的两种宿主**：坞期拨本卷、纸期拨题签（开卷那一刻落成
 *  这一卷的卷级覆盖）。默认值 = **跟随工作区**（null）——绝大多数卷不该带覆盖；
 *  只有选过三档之一，才在 `DraftPicks.permission` 里留下一个显式值。
 *  展开面沿用组合菜单的语言（pp-comp-menu），不新增第二种下拉。 */
export function SheetPermission({
  value,
  fallback,
  onPick,
  onInherit,
}: {
  value: PermissionMode | null;
  /** 工作区默认（「跟随」的落点，也是菜单里那行小字的读数）。 */
  fallback: PermissionMode;
  onPick: (m: PermissionMode) => void;
  onInherit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const label = value == null ? '跟随工作区' : MODE_LABELS[value];
  return (
    <div className="pp-sheet-perm">
      <button
        type="button"
        className={`pp-sheet-comp${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip={value == null ? `跟随工作区（当前 ${MODE_LABELS[fallback]}）` : `本卷权限：${MODE_LABELS[value]}`}
        data-tip-hint="只影响这一卷——多卷并行时各管各的"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pp-sheet-comp-k">权限</span>
        <span className="pp-sheet-comp-v">{label}</span>
        <span className="pp-sheet-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="pp-comp-menu pp-comp-menu-inline" role="listbox" aria-label="权限">
          <button
            type="button"
            role="option"
            aria-selected={value == null}
            className={`pp-comp-opt${value == null ? ' selected' : ''}`}
            onClick={() => {
              onInherit?.();
              setOpen(false);
            }}
          >
            跟随工作区（{MODE_LABELS[fallback]}）
          </button>
          {PERMISSION_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={value === m}
              className={`pp-comp-opt${value === m ? ' selected' : ''}`}
              data-tip={MODE_DESCRIPTIONS[m]}
              onClick={() => {
                onPick(m);
                setOpen(false);
              }}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 纸期书眉：没有卷名可报（卷号还没发），只有**状态** + 一条明路（弃纸）。
 *  弃纸是**无框文字**——纸上的主动作只有一个（发送），这里只能读作「一条注」。 */
export function SheetHeader({ onDiscard }: { onDiscard: () => void }) {
  return (
    <div className="pp-composer-header pp-sheet-header">
      <span className="pp-sheet-eyebrow">待题 · 未开卷</span>
      <div className="pp-composer-settings-spacer" />
      <button
        type="button"
        className="pp-sheet-discard"
        data-tip="弃纸"
        data-tip-hint="Esc 同效 · 不烧卷号、不落盘"
        onClick={onDiscard}
      >
        弃纸
      </button>
    </div>
  );
}

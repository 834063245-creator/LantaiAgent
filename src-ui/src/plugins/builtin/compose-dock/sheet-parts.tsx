// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// sheet-parts — 待题纸（纸期创作坞）**特有**的两件表现件（2026-11-15 V2 立卷 UX）。
//
// 2026-11-19 题签重画批之后本件只剩**题签行**一枚：
//   · 旧 `SheetSign` / `SheetPermission`（纸签上那两枚深底控件）→ 随「纸签」整段退役，
//     三笔并进卷首档行（见 `paper-shell/DraftFolioLine.tsx` 头注与 compose-dock 的
//     `DraftFolioPicks`）；
//   · 旧 `SheetHeader`（纸期书眉「待题 · 未开卷 + 弃纸」）→ 整行退役：那句状态与卷首
//     眉行**逐字重复**，弃纸搬成天头右上角一枚（`DraftFolioPicks` 自己渲染）。
//
// 纪律：本件只吃 props（显示名 / roster / 回调），不碰 store、不碰 core——组合的读
// 写真源在坞（它已经算好），纸期只是换了个宿主渲染。

import { useState } from 'react';
import { MODE_DESCRIPTIONS, MODE_LABELS, PERMISSION_MODES, type PermissionMode } from './host';

/** 题签第一格 · 组合（2026-11-19）：卷首档行里的「组合 standard ▾」。
 *
 *  与坞期「案 › 组合」是**同一把尺子**（presetRoster + presetError），只是宿主不同：
 *  纸期这一格落在**卷首档行**（不是纸身里的纸签）。菜单向下开（天头在卷顶，下方是
 *  流区），定位盒 = 本格自己（`.pp-folio-pick`）。 */
export function SheetSign({
  label,
  source,
  open,
  error,
  roster,
  onToggle,
  onPick,
}: {
  label: string;
  /** 这一格的来源（`default` = 跟着全局默认，行上标一枚「默认」）。 */
  source: 'explicit' | 'default';
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
    <span className="pp-folio-pick">
      <button
        type="button"
        className={`pp-folio-pick-btn${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip={error ?? (source === 'default' ? `跟随全局默认：${label}` : `本卷组合：${label}`)}
        data-tip-hint="开卷那一刻落账——跑过一轮即锁"
        onClick={onToggle}
      >
        <span className="pp-folio-pick-k">组合</span>
        <span className="pp-folio-pick-v">{label}</span>
        {source === 'default' && (
          <span className="pp-folio-pick-src" aria-hidden="true">
            默认
          </span>
        )}
        <span className="pp-folio-pick-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="pp-folio-pick-menu" role="listbox" aria-label="组合（preset）">
          {roster.map((pr) => (
            <button
              key={pr.id}
              type="button"
              role="option"
              aria-selected={pr.id === label}
              className={`pp-folio-pick-opt${pr.id === label ? ' selected' : ''}`}
              disabled={pr.patch === null}
              data-tip={pr.patch === null ? '装载失败' : pr.metadata?.description}
              data-tip-hint={pr.patch === null ? (pr.error ?? 'roster.patch.yml 不可用') : undefined}
              onClick={() => onPick(pr.id)}
            >
              {pr.metadata?.name ?? pr.id}
              {pr.patch === null ? '（损坏）' : ''}
            </button>
          ))}
          {error && <div className="pp-folio-pick-note">⚠ {error}</div>}
        </div>
      )}
    </span>
  );
}

/** 题签第三格 · 权限（2026-11-28 权限卷级批）：这一卷跟 Agent 怎么相处。
 *
 *  与坞期权限段是**同一个开关的两种宿主**：坞期拨本卷，纸期拨题签（开卷那一刻落成
 *  这一卷的卷级覆盖）。默认值 = **跟随工作区**（null）——绝大多数卷不该带覆盖；
 *  只有选过三档之一，才在 `DraftPicks.permission` 里留下一个显式值。
 *  展开面沿用组合菜单的语言（pp-folio-pick-menu），不新增第二种下拉。 */
export function SheetPermission({
  value,
  fallback,
  source,
  onPick,
  onInherit,
}: {
  value: PermissionMode | null;
  /** 工作区默认（「跟随」的落点，也是菜单里那行小字的读数）。 */
  fallback: PermissionMode;
  /** 这一格的来源（`default` = 跟随工作区；`explicit` = 这一卷自己定了）。 */
  source: 'explicit' | 'default';
  onPick: (m: PermissionMode) => void;
  onInherit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const label = value == null ? '跟随工作区' : MODE_LABELS[value];
  return (
    <span className="pp-folio-pick">
      <button
        type="button"
        className={`pp-folio-pick-btn${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip={
          value == null
            ? `跟随工作区（当前 ${MODE_LABELS[fallback]}）`
            : `本卷权限：${MODE_LABELS[value]}${source === 'explicit' ? '（这一卷自己定的）' : ''}`
        }
        data-tip-hint="只影响这一卷——多卷并行时各管各的"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pp-folio-pick-k">权限</span>
        <span className="pp-folio-pick-v">{label}</span>
        <span className="pp-folio-pick-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="pp-folio-pick-menu" role="listbox" aria-label="权限">
          <button
            type="button"
            role="option"
            aria-selected={value == null}
            className={`pp-folio-pick-opt${value == null ? ' selected' : ''}`}
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
              className={`pp-folio-pick-opt${value === m ? ' selected' : ''}`}
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
    </span>
  );
}

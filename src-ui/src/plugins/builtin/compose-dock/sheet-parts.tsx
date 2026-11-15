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
    <>
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
    </>
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

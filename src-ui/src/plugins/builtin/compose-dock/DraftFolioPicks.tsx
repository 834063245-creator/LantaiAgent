// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DraftFolioPicks — 待题纸的**题签行**（2026-11-19 题签重画批）。
//
// 一句话：把「这一卷打算怎么跑」的三笔（组合 · 模型 · 权限）写进**卷首第三行**——
// 就是原来那句「题签随首句落账 · 卷号于发送时发出」所在的位置。
//
// 为什么住在这里而不是纸身里（推翻 2026-11-28 的「纸上贴一枚纸签」）：
//   · 卷首本来就是「这一卷是什么」的账；待题期这卷还没名，第三行空着也是空着；
//   · 三项落进**版心**，与玉徽/眉行/题字同轴（版心铁律 2026-09-16）——纸身里贴一枚
//     832 宽的色块，等于在一张印了墨的纸上再贴一张纸，只能靠硬投影硬凹层次；
//   · 静止时它读作**一行读数**（hover 才亮 caret 与朱线，§11 锚点型），不是三枚常驻
//     控件——「等我把这一卷送出去之前要确认的三件事」放在视线第一落点，但不当门槛。
//
// 三格各自是既有组件的换宿主，不是第二套实现：
//   组合 / 权限 → `sheet-parts.tsx` 的 SheetSign / SheetPermission（同一把尺子）
//   模型（含思考）→ `ModelSelector` 的 compact 触发器（坞里那一枚**同一个组件**）
// 写路径仍全在 draft-sheet-store 的题签上（开卷那一刻才落既有账，见 draft-opening.ts）。
//
// 登记：compose-dock 插件把它注册到 overlays 的 'draft-folio' 槽，由 paper-shell 的
// 卷首（DraftSheet / DraftFolioLine）渲染——跨插件直引会把产物 esbuild 内联成第二份
// store（同 toast-store 先例，见 docs/landmine-map.md）。

import type { PermissionMode, RunSources } from './host';
import { ModelSelector } from './ModelSelector';
import { SheetPermission, SheetSign } from './sheet-parts';

export interface DraftFolioPicksProps {
  /** 组合读数（`config.presetId`，单一解析层的生效值）。 */
  compLabel: string;
  compOpen: boolean;
  /** 四笔各自的**来源**（2026-11-30 来源批）：解析层已经给好了，本件只负责显示成「默认」
   *  ——用户报的「我选了它却没记住」有一半是**读不出这一格是这一卷的还是跟着默认的**。 */
  sources: RunSources;
  presetError: string | null;
  presetRoster: ReadonlyArray<{
    id: string;
    patch: unknown;
    error?: string;
    metadata?: { name?: string; description?: string };
  }>;
  onCompToggle: () => void;
  onDraftPresetPick: (id: string) => void;
  /** 权限：null = 跟随工作区；非 null = 开卷时落成本卷的卷级覆盖。 */
  sheetPermission: PermissionMode | null;
  /** 工作区默认权限（菜单里那行小字的读数）。 */
  permissionMode: PermissionMode;
  onPermissionPick: (m: PermissionMode) => void;
  onPermissionInherit: () => void;
  /* 模型 + 思考（坞期与纸期共用同一枚 ModelSelector）。 */
  model: string;
  providerName: string;
  providerKind: string;
  running: boolean;
  thinking: {
    value: string;
    label: string;
    options: ReadonlyArray<{ value: string; label: string; hint: string }>;
    onChange: (value: string) => void;
  };
  onModelChange: (modelId: string, desc?: { vendor: string }) => void;
  onModelBlocked: () => void;
  /** 弃纸（天头右上角那枚「弃纸」）：不烧号、不落盘。 */
  onDiscard: () => void;
}

/** 卷首题签行 = 三笔读数 + 右上角一枚「弃纸」。
 *  「弃纸」搬来这里是有判据的：2026-11-19 之前它住在纸期书眉行（那一行还有一句
 *  「待题 · 未开卷」）——那句话与卷首眉行**逐字重复**，而书眉行只为扛这一枚按钮存在。
 *  册页的右上角本来就是「离开这张纸」的位置（与案卷侧栏的「另起一卷」同族）。 */

export function DraftFolioPicks({
  compLabel,
  compOpen,
  sources,
  presetError,
  presetRoster,
  onCompToggle,
  onDraftPresetPick,
  sheetPermission,
  permissionMode,
  onPermissionPick,
  onPermissionInherit,
  model,
  providerName,
  providerKind,
  running,
  thinking,
  onModelChange,
  onModelBlocked,
  onDiscard,
}: DraftFolioPicksProps) {
  return (
    <>
      <span className="pp-folio-pick-sep" aria-hidden="true" />
      <SheetSign
        label={compLabel}
        source={sources.preset}
        open={compOpen}
        error={presetError}
        roster={presetRoster}
        onToggle={onCompToggle}
        onPick={onDraftPresetPick}
      />
      <span className="pp-folio-pick-sep" aria-hidden="true" />
      {/* 模型：坞期那一枚**同一个组件**（compact 触发器 = 厂章 + 名 + 档位后缀 + caret）。
          它自带容器与菜单，本行只给它一个不缩的位；来源记号是本行自己的（不是它的语言）。 */}
      <span className="pp-folio-pick pp-folio-pick-model">
        <span className="pp-folio-pick-k">模型</span>
        <ModelSelector
          value={model}
          onChange={onModelChange}
          providerName={providerName}
          kind={providerKind}
          compact
          isStreaming={running}
          onBlocked={onModelBlocked}
          thinking={thinking}
        />
        {sources.model === 'default' && (
          <span className="pp-folio-pick-src" data-tip="跟随「新卷出生默认」——拨一下就是这一卷的">
            默认
          </span>
        )}
      </span>
      <span className="pp-folio-pick-sep" aria-hidden="true" />
      <SheetPermission
        value={sheetPermission}
        fallback={permissionMode}
        source={sources.permission}
        onPick={onPermissionPick}
        onInherit={onPermissionInherit}
      />
      <span className="pp-folio-pick-gap" aria-hidden="true" />
      <button
        type="button"
        className="pp-sheet-discard"
        data-tip="弃纸"
        data-tip-hint="Esc 同效 · 不烧卷号、不落盘"
        onClick={onDiscard}
      >
        弃纸
      </button>
    </>
  );
}

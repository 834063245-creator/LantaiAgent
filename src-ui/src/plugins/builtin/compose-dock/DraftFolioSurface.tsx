// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DraftFolioSurface — 待题纸的**题签宿主**（2026-11-19 题签重画批；**2026-11-29 收口批改写**）。
//
// 一句话：卷首第三行那份四笔读数需要的那批坞内 hook（点击/断点之外它们没有别的依赖），
// 在这里组装一次，交给 `DraftFolioPicks` 渲染。
//
// 收口批改写了什么（用户判词：「题签从根上就没做好」——19 次提交里 9 次修的是同一类根因）：
//   · **不再自己拼读数**：四笔一律 `useRunConfig(paperTarget(纸 id))`（单一解析层）。
//     旧实现读 `focusedId`，于是每张纸都显示焦点那张的三笔（aacd693c 只补了现场）；
//   · **不再自己拼写路径**：四笔一律 `patchRunConfig(...)`（唯一写入口，按目标分流）。
//     旧实现四笔各写各的（题签 / 卷级 / 全局 / 出厂值），三条路径互不知情；
//   · 组合的展开面不再借 `useComposerComposition`（那是一整套含卷级异步读面的 hook，
//     纸期永远走不到那一支）——本件只留 roster / error / 开合三件。
//
// ⚠ **这张行属于哪张纸 = `useDraftPaperId()`**（宿主 `DraftFolioLine` 经 context 下发）。
// 不给上下文（裸挂单件）≠ 回落焦点那张：目标是「无主」，四笔读出厂默认、写只落默认——
// 「不给就落焦点那张」正是本批要根除的写法。
// ⚠ `isSheet` 恒为 true：三处写路径（模型/思考/组合）因此都落在题签上——这正是纸期语义。

import { memo, useMemo, useState } from 'react';
import { DraftFolioPicks } from './DraftFolioPicks';
import {
  bareTarget,
  MODE_LABELS,
  paperTarget,
  patchRunConfig,
  useCoreStore,
  useDialogEscape,
  useDraftPaperId,
  useDraftSheetStore,
  useModeStore,
  usePresetStore,
} from './host';
import { useComposerChrome } from './surface/use-composer-chrome';
import { useComposerModels } from './surface/use-composer-models';
import { useComposerSession } from './surface/use-composer-session';
import { useRunConfig } from './surface/use-run-config';

/** 无面板（裸挂单件 / 早期装配）：compose-store 的入口仍要一个稳定 id。
 *  纸期不用会话覆盖表，故这个 id 只影响注册表键、不影响读数。 */
const NO_PANEL = '__no-panel__';

export const DraftFolioSurface = memo(function DraftFolioSurface() {
  const core = useCoreStore((s) => s.core);
  const panelId = core?.panelId ?? NO_PANEL;
  /* 本行挂在**哪张纸**上（宿主给的；没有 = 无主目标，绝不回落焦点那张）。 */
  const paperId = useDraftPaperId();
  /* 纸期没有活跃卷：上下文卷位恒空——坞的「无主态」分支自然接管（与 ComposerSurface 同）。 */
  const activeSessionId = null;
  const target = useMemo(
    () => (paperId === null ? bareTarget(panelId) : paperTarget(paperId, panelId)),
    [paperId, panelId],
  );
  const config = useRunConfig(target);
  const { notice, armHistHintIfDue } = useComposerChrome();
  void armHistHintIfDue; // 历史眉批只属输入面（本件没有输入框）
  const session = useComposerSession({ core, target, activeSessionId, composerRef: { current: null } });
  /* 组合的展开面：roster / error 来自 preset-store（与设置面板同一个发现层），开合是本件状态。
   * 旧实现借的是那整套含卷级异步读面的 hook——纸期永远走不到卷级那一支（死分支）。 */
  const presetRoster = usePresetStore((s) => s.roster);
  const presetError = usePresetStore((s) => s.error);
  const [compOpen, setCompOpen] = useState(false);
  const { onModelChange, thinkingSeat } = useComposerModels({
    core,
    target,
    providerName: session.providerName,
    currentThinking: session.currentThinking,
    thinkingOptions: session.thinkingOptions,
  });

  /* ── 题签第四格 · 权限（2026-11-28 权限卷级批；2026-11-19 随题签升到卷首）──
   * 纸期读的是**题签**里的那一格（来源 = default 即「跟随工作区」，null 语义同前）。 */
  const sheetPermission = config.sources.permission === 'explicit' ? config.permission : null;
  /* 全放二次确认模态的 Esc（同坞期：portal 到 body 后 Escape 只能走 document 级）。
   * 只有**请求者那张纸**的输入面会渲染模态（见 ComposerDock 的同款判据）。
   * `== null` 容旧态（请求者未记名的坞期/旧存档）：那一支当作全局，Esc 照常关。 */
  const pendingYolo = useModeStore((s) => s.pendingYolo);
  const pendingYoloPaper = useModeStore((s) => s.pendingYoloPaper);
  useDialogEscape(() => useModeStore.getState().setPendingYolo(false), {
    enabled: pendingYolo && (pendingYoloPaper == null || pendingYoloPaper === paperId),
  });

  return (
    <DraftFolioPicks
      compLabel={config.presetId}
      compOpen={compOpen}
      presetError={presetError}
      presetRoster={presetRoster}
      onCompToggle={() => setCompOpen((v) => !v)}
      onDraftPresetPick={(id) => {
        setCompOpen(false);
        /* 一笔写完：这一卷的题签（开卷时落卷级登记）+ 新卷出生默认（「题签要能记住选择」）。
         * 校验不过只把原因留在 preset-store.error 上并播一声——题签那一笔照旧记着
         * （纸期不做二次拒绝：预设可能先坏后修）。 */
        const r = patchRunConfig(target, { presetId: id });
        if (!r.ok) notice(r.reason, 'error');
      }}
      sheetPermission={sheetPermission}
      permissionMode={config.permission}
      onPermissionPick={(m) => {
        /* 纸期：写题签这一格——开卷那一刻由 applyDraftPicks 落成这一卷的卷级覆盖。
         *
         * ⚠ 全放（yolo）只**弹确认**，不在这里落账（2026-11-19 真机返工）：
         *   确认模态由纸期输入面（`ComposerSheet` → `YoloConfirmModal`）渲染，
         *   它点「确定」后调的是那一面的 applyMode（经同一个 patchRunConfig 落账）。
         *   本件若也写一次，就是**两个真源**——模态还没点，题签已经变了，读作「弹窗是假的」。
         * ⚠ 请求者要**记名**（2026-11-29）：点完全放又去点别的纸，确认时那一笔仍该落回
         *   请求它的那张纸，而不是「此刻焦点那张」。 */
        if (m === 'yolo' && sheetPermission !== 'yolo') {
          useModeStore.getState().setPendingYolo(true, paperId);
          return;
        }
        patchRunConfig(target, { permission: m });
        notice(`本卷权限将按「${MODE_LABELS[m]}」开卷`, 'info');
      }}
      onPermissionInherit={() => {
        /* 「跟随工作区」也是一次显式选择：出厂值清回 null（下次开纸就跟着工作区，不再预填）。 */
        patchRunConfig(target, { permission: null });
      }}
      model={session.model}
      providerName={session.providerName}
      providerKind={session.providerKind}
      running={false}
      thinking={thinkingSeat}
      onModelChange={onModelChange}
      onModelBlocked={() => notice('Agent 正在运行——本回合结束后才能切换模型。', 'warn')}
      onDiscard={() => {
        const id = paperId;
        if (id === null) return;
        // 弃纸走 core 的能力位：store 焦点 + input 草稿槽 + 交回活跃卷三件事一起做
        if (core?.dismissDraft) core.dismissDraft(id);
        else useDraftSheetStore.getState().dismissOne(id);
      }}
    />
  );
});

export default DraftFolioSurface;

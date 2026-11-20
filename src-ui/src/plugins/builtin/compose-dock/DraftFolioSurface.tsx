// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// DraftFolioSurface — 待题纸的**题签宿主**（2026-11-19 题签重画批）。
//
// 一句话：卷首第三行那份三笔读数需要的**同一批坞内 hook**（点击/断点之外它们没有别的
// 依赖），在这里组装一次，交给 `DraftFolioPicks` 渲染。
//
// 为什么是「第二次挂载」而不是把坞整只搬上去：卷首在 `.pp-world` 里、坞槽在屏底，两者
// 不是同一个层——但读写的**真源仍是同一份**（draft-sheet-store 的题签 + input store 的
// 草稿槽 + compose/preset store）。故本件不持有任何状态：所有 hook 都是既有实现
// （useComposerSession / useComposerModels / useComposerComposition / useComposerChrome），
// 与坞期那份逐字同源——「同一个动作一个实现」这条纪律不因换了宿主而松。
//
// ⚠ **这张行属于哪张纸 = `useDraftPaperId()`**（2026-11-29 多纸错位批）。旧实现一律读
// `draft-sheet-store.focusedId`，而每张纸各挂一行 ⇒ **非焦点那张显示的是焦点那张的三笔**
// （用户报「非焦点态显示的组合/模型/思考强度/权限与实际设置不符」）；写入同理——非焦点
// 那张上拨一下会写进别人的题签。现语义：宿主（paper-shell 的 DraftFolioLine）经 context
// 给纸 id，读数与写入都归**这张纸**的记录；context 缺席（坞期/裸挂单件）= 焦点那张，旧语义。
// ⚠ `isSheet` 恒为 true：三处写路径（模型/思考/组合）因此都落在题签上——这正是纸期语义。

import { memo } from 'react';
import { DraftFolioPicks } from './DraftFolioPicks';
import {
  MODE_LABELS,
  selectPreset,
  useCoreStore,
  useDialogEscape,
  useDraftPaperId,
  useDraftSheetStore,
  useModeStore,
} from './host';
import { writeSheetPermission } from './sheet-picks';
import { useComposerChrome } from './surface/use-composer-chrome';
import { useComposerComposition } from './surface/use-composer-composition';
import { useComposerModels } from './surface/use-composer-models';
import { useComposerSession } from './surface/use-composer-session';

export const DraftFolioSurface = memo(function DraftFolioSurface() {
  const core = useCoreStore((s) => s.core);
  /* 纸期没有活跃卷：上下文卷位恒空——坞的「无主态」分支自然接管（与 ComposerSurface 同）。 */
  const activeSessionId = null;
  /* 本行挂在**哪张纸**上（宿主给的；null = 不在纸上，退回「焦点那张」的旧语义）。 */
  const scopedPaperId = useDraftPaperId();
  const { notice, armHistHintIfDue } = useComposerChrome();
  void armHistHintIfDue; // 历史眉批只属输入面（本件没有输入框）
  const session = useComposerSession({
    core,
    isSheet: true,
    paperId: scopedPaperId,
    activeSessionId,
    composerRef: { current: null },
  });
  const composition = useComposerComposition({ core, activeSessionId, notice });
  /* 纸期的组合读数取自**题签**（2026-11-19 真机报「题签选完组合不变」）：
   * composition.compLabel 走的是「无主态 = 全局默认」那条链——纸期没有活跃卷，
   * 它于是恒报全局默认，选完仍是原来那一个（读作「选了没落账」，而真账其实已经写进
   * 题签了，见 use-composer-composition 的 onDraftPresetChange）。
   * 与模型/思考同一把尺子：题签未填 = 出厂默认（picks.presetId ?? 全局默认）。
   * 多纸（2026-11-29）：读的是**这一张纸**的题签，不是焦点那张。 */
  const paper = useDraftSheetStore((s) => {
    const id = scopedPaperId ?? s.focusedId;
    return id === null ? null : (s.papers.find((p) => p.id === id) ?? null);
  });
  /* 读面：本行那张纸（context 缺席 ⇒ 焦点那张）。写面与读面**同一把尺子**——
   * 旧实现读焦点、写焦点，于是多纸同屏时两边一起错。 */
  const paperId = paper?.id ?? scopedPaperId ?? null;
  const draftPresetId = paper?.picks?.presetId ?? null;
  const { onModelChange, thinkingSeat } = useComposerModels({
    core,
    isSheet: true,
    paperId: scopedPaperId,
    activeSessionId,
    providerName: session.providerName,
    currentThinking: session.currentThinking,
    thinkingOptions: session.thinkingOptions,
  });

  /* ── 题签第四格 · 权限（2026-11-28 权限卷级批；2026-11-19 随题签升到卷首）──
   * 纸期读的是**题签**里的那一格（null = 跟随工作区）；工作区默认只是菜单里的读数。 */
  const globalMode = useModeStore((s) => s.permissionMode);
  const sheetPermission = paper?.picks?.permission ?? null;
  /* 全放二次确认模态的 Esc（同坞期：portal 到 body 后 Escape 只能走 document 级）。
   * 只有**请求者那张纸**的输入面会渲染模态（见 ComposerDock 的同款判据）。
   * `== null` 容旧态（请求者未记名的坞期/旧存档）：那一支当作全局，Esc 照常关。 */
  const pendingYolo = useModeStore((s) => s.pendingYolo);
  const pendingYoloPaper = useModeStore((s) => s.pendingYoloPaper);
  useDialogEscape(() => useModeStore.getState().setPendingYolo(false), {
    enabled: pendingYolo && (pendingYoloPaper == null || pendingYoloPaper === scopedPaperId),
  });

  return (
    <DraftFolioPicks
      compLabel={draftPresetId ?? composition.compLabel}
      compOpen={composition.compOpen}
      presetError={composition.presetError}
      presetRoster={composition.presetRoster}
      onCompToggle={() => composition.setCompOpen((v) => !v)}
      onDraftPresetPick={(id) => {
        /* 先写题签（**这一卷**的组合，开卷才落卷级登记），再记成**新卷出生默认**
         * （2026-11-19「题签要能记住选择」批）——否则每开一张新纸都要重选一遍。
         * 写默认 = selectPreset，与坞期无主态、设置面板是**同一个入口**（含校验与落盘）；
         * 校验不过时它返回 false 并只把原因留在 preset-store.error 上——题签那一笔照旧
         * 存在（纸期不做二次拒绝，见 use-composer-composition 的 onDraftPresetChange 注）。 */
        composition.onDraftPresetChange(id, scopedPaperId);
        selectPreset(id);
      }}
      sheetPermission={sheetPermission}
      permissionMode={globalMode}
      onPermissionPick={(m) => {
        /* 纸期：写题签这一格——开卷那一刻由 applyDraftPicks 落成这一卷的卷级覆盖。
         *
         * ⚠ 全放（yolo）只**弹确认**，不在这里落账（2026-11-19 真机返工）：
         *   确认模态由纸期输入面（`ComposerSheet` → `YoloConfirmModal`）渲染，
         *   它点「确定」后调的是那一面的 applyMode。本件若也写一次，就是**两个真源**
         *   ——模态还没点，题签已经变了，读作「弹窗是假的」。
         *   这也正是用户报的「权限切换弹窗鼠标操作被吞」：弹窗在，点了确定却像没生效。
         * ⚠ 请求者要**记名**（2026-11-29）：点完全放又去点别的纸，确认时那一笔仍该落回
         *   请求它的那张纸，而不是「此刻焦点那张」。 */
        if (m === 'yolo' && sheetPermission !== 'yolo') {
          useModeStore.getState().setPendingYolo(true, paperId);
          return;
        }
        /* 写题签 + **同时记成下一张纸的出厂值**（2026-11-19「题签要能记住选择」批）：
         * 这一格只对**这一卷**成立（开卷时落卷级覆盖）；不记那一笔，用户每次新建都要重拨。
         * 全放路径经输入面的 applyMode 调**同一个** writeSheetPermission（2026-11-29 修：
         * 旧实现那条路只写题签、不记出厂值 ⇒ 全放用户的选择从来没落过盘）。 */
        writeSheetPermission(paperId, m);
        notice(`本卷权限将按「${MODE_LABELS[m]}」开卷`, 'info');
      }}
      onPermissionInherit={() => {
        /* 「跟随工作区」也是一次显式选择：下标同样记住（下次开纸就跟着工作区，不再预填）。 */
        writeSheetPermission(paperId, null);
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

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
// ⚠ 只挂**焦点那张纸**（天头是天头）；点非焦点那张纸 = 换焦点，卷首行随之换主人。
// ⚠ `isSheet` 恒为 true：三处写路径（模型/思考/组合）因此都落在题签上——这正是纸期语义。

import { memo } from 'react';
import { DraftFolioPicks } from './DraftFolioPicks';
import { MODE_LABELS, useCoreStore, useDialogEscape, useDraftSheetStore, useModeStore } from './host';
import { useComposerChrome } from './surface/use-composer-chrome';
import { useComposerComposition } from './surface/use-composer-composition';
import { useComposerModels } from './surface/use-composer-models';
import { useComposerSession } from './surface/use-composer-session';

export const DraftFolioSurface = memo(function DraftFolioSurface() {
  const core = useCoreStore((s) => s.core);
  /* 纸期没有活跃卷：上下文卷位恒空——坞的「无主态」分支自然接管（与 ComposerSurface 同）。 */
  const activeSessionId = null;
  const { notice, armHistHintIfDue } = useComposerChrome();
  void armHistHintIfDue; // 历史眉批只属输入面（本件没有输入框）
  const session = useComposerSession({ core, isSheet: true, activeSessionId, composerRef: { current: null } });
  const composition = useComposerComposition({ core, activeSessionId, notice });
  /* 纸期的组合读数取自**题签**（2026-11-19 真机报「题签选完组合不变」）：
   * composition.compLabel 走的是「无主态 = 全局默认」那条链——纸期没有活跃卷，
   * 它于是恒报全局默认，选完仍是原来那一个（读作「选了没落账」，而真账其实已经写进
   * 题签了，见 use-composer-composition 的 onDraftPresetChange）。
   * 与模型/思考同一把尺子：题签未填 = 出厂默认（picks.presetId ?? 全局默认）。 */
  const draftPresetId = useDraftSheetStore((s) => {
    const id = s.focusedId;
    return id === null ? null : (s.papers.find((pp) => pp.id === id)?.picks?.presetId ?? null);
  });
  const { onModelChange, thinkingSeat } = useComposerModels({
    core,
    isSheet: true,
    activeSessionId,
    providerName: session.providerName,
    currentThinking: session.currentThinking,
    thinkingOptions: session.thinkingOptions,
  });

  /* ── 题签第四格 · 权限（2026-11-28 权限卷级批；2026-11-19 随题签升到卷首）──
   * 纸期读的是**题签**里的那一格（null = 跟随工作区）；工作区默认只是菜单里的读数。 */
  const globalMode = useModeStore((s) => s.permissionMode);
  const sheetPermission = useDraftSheetStore((s) => {
    if (s.focusedId === null) return null;
    return s.papers.find((pp) => pp.id === s.focusedId)?.picks?.permission ?? null;
  });
  /* 全放二次确认模态的 Esc（同坞期：portal 到 body 后 Escape 只能走 document 级）。 */
  const pendingYolo = useModeStore((s) => s.pendingYolo);
  useDialogEscape(() => useModeStore.getState().setPendingYolo(false), { enabled: pendingYolo });

  return (
    <DraftFolioPicks
      compLabel={draftPresetId ?? composition.compLabel}
      compOpen={composition.compOpen}
      presetError={composition.presetError}
      presetRoster={composition.presetRoster}
      onCompToggle={() => composition.setCompOpen((v) => !v)}
      onDraftPresetPick={composition.onDraftPresetChange}
      sheetPermission={sheetPermission}
      permissionMode={globalMode}
      onPermissionPick={(m) => {
        /* 纸期：写题签这一格——开卷那一刻由 applyDraftPicks 落成这一卷的卷级覆盖。
         *
         * ⚠ 全放（yolo）只**弹确认**，不在这里落账（2026-11-19 真机返工）：
         *   确认模态由纸期输入面（`ComposerSheet` → `YoloConfirmModal`）渲染，
         *   它点「确定」后调的是那一面的 applyMode（写题签第四格）。本件若也写一次，
         *   就是**两个真源**——模态还没点，题签已经变了，读作「弹窗是假的」。
         *   这也正是用户报的「权限切换弹窗鼠标操作被吞」：弹窗在，点了确定却像没生效。 */
        if (m === 'yolo' && sheetPermission !== 'yolo') {
          useModeStore.getState().setPendingYolo(true);
          return;
        }
        const st = useDraftSheetStore.getState();
        const paper = st.papers.find((pp) => pp.id === st.focusedId);
        if (paper?.picks) st.setPicks({ ...paper.picks, permission: m }, paper.id);
        notice(`本卷权限将按「${MODE_LABELS[m]}」开卷`, 'info');
      }}
      onPermissionInherit={() => {
        const st = useDraftSheetStore.getState();
        const paper = st.papers.find((pp) => pp.id === st.focusedId);
        if (paper?.picks) st.setPicks({ ...paper.picks, permission: null }, paper.id);
      }}
      model={session.model}
      providerName={session.providerName}
      providerKind={session.providerKind}
      running={false}
      thinking={thinkingSeat}
      onModelChange={onModelChange}
      onModelBlocked={() => notice('Agent 正在运行——本回合结束后才能切换模型。', 'warn')}
      onDiscard={() => {
        const id = useDraftSheetStore.getState().focusedId;
        if (id === null) return;
        // 弃纸走 core 的能力位：store 焦点 + input 草稿槽 + 交回活跃卷三件事一起做
        if (core?.dismissDraft) core.dismissDraft(id);
        else useDraftSheetStore.getState().dismissOne(id);
      }}
    />
  );
});

export default DraftFolioSurface;

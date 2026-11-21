// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 纸壳插件宿主依赖面 · 开发/测试域（增补四，first-party-hot-reload-plan）。
//
// 面组件（PaperPanel/InkLayer/StatusLine）与插件本体的项目内依赖全部从
// 这里取：tsc / vitest / bundle 域直连真实模块（类型检查保真）；esbuild
// 产物域构建期重定向到 './host.aliased.ts'（宿主桥 mods 共享真实例）。
// 两域形状必须一致（host.aliased.ts 以 `typeof import('./host')` 对拍）：
// 本文件只做 re-export，不改写任何实现。
// 加出口三处同步：① 本文件 ② host.aliased.ts 镜像（漏了产物构建 esbuild 红）
// ③ host-modules.ts faceDeps（漏了 satisfies 封蜡 tsc 红）——2026-09-02
// 划词白屏事故即漏了第 ③ 处，exe 里才炸出。

export { agentSessionState } from '../../../agent/agent-session-state';
export { ConfirmDialog } from '../../../app/ConfirmDialog';
export { useCoreStore } from '../../../app/chat/core-instance';
/* 卷首待答角标（2026-11-11 画布多卷审批 UX · A 面）：待答账读面 = 内核
 * state/ask-pending-store（chat-core 交付入账 / 答复结账）。角标只读，不写账。 */
export { useAskPendingStore } from '../../../state/ask-pending-store';
/** 角标用到的最小能力位面（能力位缺席 = 无读数，不炸纸面——与 FolioCompositionChip 同款）。 */
export interface FolioAskBadgeCore {
  switchToSession?(sessionId: number): void;
  /** 把该卷的第一张在等卡顶到队头（A 面「点名」语义；缺席 = 只跳卷不重排）。 */
  promoteAskBySession?(sessionId: number): boolean;
}
/* 架阁（2026-12-08 B2）：收进架阁的两件——读本卡**当刻**状态（getAssetState，内核带
 * 模块级状态，必须走桥）+ 写卡片库（shelveCard，内核实现口径）。faceDeps 两键均在
 * host-modules：getAssetState 既有，shelveCard 本批新增。 */
export { getAssetState } from '../../../agent/asset-state';
export { deleteCard, listCards, readCard, renameCard, shelveCard, writeCardState } from '../../../agent/card-library';
export { Icon } from '../../../app/Icon';
export { useDialogEscape, useOutsideClose } from '../../../app/overlay';
/* 保险丝 b（2026-09-03 生产事故立法）：渲染面错误边界——面组件/块渲染器
 * 的崩溃隔离（单插件渲染崩溃只死自己那格，React 整树卸载绝迹）。 */
export { PluginBoundary } from '../../../app/PluginBoundary';
export { useShellStore } from '../../../app/shell-store';
export { WinControls } from '../../../app/WinControls';
/* 标题栏交互（2026-09-14 app-region 全面退役）：画布顶部浮件拖拽/双击最大化走 Tauri
 * 原生通道——触发范围由元素自己判定（WebView2 的 app-region 行窗只在启动时按当时
 * 页面算一次，进画布后会多出一条幽灵标题栏并吃掉浮件按钮）。见 app/window-drag.ts 头注。 */
export { onTopbarDoubleClick, onTopbarPointerDown } from '../../../app/window-drag';
export {
  activeOverlayContributions,
  subscribeOverlayContributions,
} from '../../../composition/overlay-service';
export { resolveAssetBlock, resolveRenderer } from '../../../composition/renderer-service';
/* 创作坞 v2（2026-08-31）：案头签条开卷（activeSpace.expand）+ 流区运行
 * 呼吸线（agentSessionState exec 订阅）——faceDeps 已含，此处只补开发域出口。 */
export { activeSpace } from '../../../composition/space-service';
// 类型面（产物域经 host.aliased 对拍）
export type { SourcedBlock } from '../../../paper/block-model';
/* 纸面运行态（2026-09-06）：湿墨判定纯函数——RegionView.writingBlockId 的
 * 派生源（faceDeps 已含 host 形状封蜡，三处同步缺一即红）。 */
export { writingBlockIdOf } from '../../../paper/block-model';
// paper 几何 / 墨迹 / 测量 / 选择 / 翻译 / 虚拟化 / 上下文
export {
  ANCHOR,
  autoPanVector,
  layoutRegion,
  nextZoomStep,
  panBy,
  screenToWorld,
  viewFocusRegion,
  viewportCenterWorld,
  wheelFactor,
  worldToScreen,
  zoomAt,
} from '../../../paper/canvas-math';
export { defaultFolded, foldLabel, isFoldable } from '../../../paper/fold';
export type { BlockInk, InkCache, LodTier } from '../../../paper/ink';
export {
  createInkCache,
  INK_LABEL_ALPHA,
  INK_LABEL_MIN_PX,
  INK_SIL_ACCENT_ALPHA,
  INK_SIL_MASS_ALPHA,
  inkBarColorOf,
  inkColorOf,
  inkForBlock,
  LOD_TEXT_MIN_PX,
  lodActive,
  lodFarActive,
  lodTierOf,
} from '../../../paper/ink';
/* 批 9c-4b（2026-09-26）：测量引擎（`measure.ts` 2,016 + 版式 token `type-tokens.ts` 807）
 * 整件随本包 ⇒ 原先经本桥取内核 measure / type-tokens 的 **12 个键全部撤销**（包内组件
 * 直接 `from './measure'` / `from './type-tokens'`）。本桥改为桥**登记口**：引擎随包后由
 * 本包 apply 登记进内核接缝 `paper/measure-seam.ts`（内核读点 = `paper/ink.ts` 墨迹走查 +
 * `state/messages-store.ts` 切卷清态）。登记口**必须经宿主桥**取用——直连内核模块路径会被
 * esbuild 内联成副本，登记落副本 = 实机炸（账本 §0.6 的 memory-domain 先例）。 */
export { clearMeasureImplementation, registerMeasureImplementation } from '../../../paper/measure-seam';
export {
  DraftPaperContext,
  PaperDockContext,
  PaperRegionContext,
  useDraftPaperId,
} from '../../../paper/overlay-context';
export type { RegionView } from '../../../paper/region-view';
export type { StreamRegionState } from '../../../paper/space';
export {
  clampRegionW,
  defaultRegionFor,
  EMPTY_REGION_CONTENT_H,
  nearestFreeRegion,
  REGION_CONTENT_MARGIN,
  REGION_FOOT_GAP,
  STREAM_REGION,
} from '../../../paper/space';
export type { MessageTranslateCache } from '../../../paper/translate';
export { collapseToolGroups, translateMessagesCached } from '../../../paper/translate';
export type { StoredThinking } from '../../../provider/thinking';
export { thinkingOptionsOrDefault } from '../../../provider/thinking';
// 批 9c-4b：`injectPaperTokens` 随 `type-tokens.ts` 进包 ⇒ 包内直接 `from './type-tokens'`
// 设置读面（2026-09-08 缩放舒适度批）：滚轮行为 canvasWheelMode + 保存广播
// onSettingsSaved——视口域滚轮语义随设置即时换轨（ref 缓存 + 广播刷新）。
export { canvasWheelMode, effectiveModels, loadSettings, modelDescriptor, onSettingsSaved } from '../../../settings';
/* 离开工作区回首页（2026-09-08）：真关工作区 + 回首页（PaperPanel 确认弹层
 * 确认后调用——workspace 流函数，运行时 deactivate 在壳层）。 */
/* 展卷页（2026-11-05 入口 UX 批）：进入态 store 与两个出口（逃生 / 重试）。
 * store **必须走桥**——直引内核路径会被产物构建内联成第二份 store，展卷页永远
 * 收不到阶段推进（打包态白屏先例同族：见 useToastStore 注）。faceDeps 三处同步：
 * 本文件 / host.aliased.ts / host-modules.ts。 */
export { abortWorkspaceEntry, leaveToHome, retryWorkspaceEntry } from '../../../shell/rows/workspace';
export { useBgAlertStore } from '../../../state/bg-alert-store';
export type { CanvasStore } from '../../../state/canvas-store';
export { blockFromSnapshot, getCanvasStore, scheduleCanvasSave, snapshotFromBlock } from '../../../state/canvas-store';
export { useCanvasViewStore } from '../../../state/canvas-view-store';
export type { ComposeSessionPrefs } from '../../../state/compose-store';
/* 待题纸开卷时读「新卷出生默认」（题签三笔的出厂值）。写会话覆盖已收进
 * `core.applyDraftPicks`（app/chat/session/draft-opening），本包不再直连 compose-store。 */
export { resolveNewSessionDefault } from '../../../state/compose-store';
export { useDockStore } from '../../../state/dock-store';
export type { DraftPaper, DraftPicks, DraftSheetAnchor } from '../../../state/draft-sheet-store';
/* 待题纸（2026-11-14 立卷 UX）：出生面的开合是**跨产物**的瞬态——创作坞要据此
 * 不出输入条（纸还没成立，没有可写的正文）。故必须经桥取宿主那一份 store 单例
 * （直引内核路径会被产物构建内联成第二份 ⇒ 坞永远读不到开合，同 toast-store 先例）。
 * faceDeps 三处同步：本文件 / host.aliased.ts / host-modules.ts。 */
export {
  draftInputKey,
  draftSheetSeed,
  focusedPaper,
  isRiseVolume,
  setMorphBox,
  useDraftSheetStore,
} from '../../../state/draft-sheet-store';
/* 待题纸出厂权限（2026-11-19「题签要能记住选择」批）：题签第四格的出厂值住在
 * mode-store（**不是**工作区默认——纸上拨一下只给下一张纸留记号，不改所有未覆盖的卷）。
 * 与 compose-dock 同一份单例，故必须走桥（直引会被产物构建内联成第二份）。 */
export { useModeStore } from '../../../state/mode-store';
/* 架阁浮层（entity-shelf-plan B3）要用的两件：软件口径 = plugin-window-store 的
 * defs/windows/openWindow；开合账 = shelf-store（纯 UI 状态，纸壳字件写、浮层读）。 */
export { usePluginWindowStore } from '../../../state/plugin-window-store';
/* 卷首组合芯片（S6 P5a）读面：preset 清单 / 全局选择态 / 装载失败原因。
 * 写面与空白判据不经本出口——它们走 core 的能力位（sessionComposition /
 * isSessionBlank / selectSessionPreset，与创作坞芯片同一套）。faceDeps 已含该
 * key（host-modules.ts 的 usePresetStore，compose-dock 在用），故只补本文件与
 * host.aliased.ts 两处 + gen:host-surface 重生成。 */
export { usePresetStore } from '../../../state/preset-store';
export { useShelfStore } from '../../../state/shelf-store';
/* ⚡ 2026-09-28（A4 销账第一笔）：toast store **必须走桥**——ToastHost 是 toast 通道的
 * 唯一渲染器，而全部生产者在内核侧；直引内核路径会被产物构建内联成第二份 store，
 * 打包态 toast 一条都不显示（开发域单实例 ⇒ 单测看不出来）。 */
export { useToastStore } from '../../../state/toast-store';
export { useUpdateStore } from '../../../state/update-store';
/* 役台账（2026-11-20 帖批）：帖签「召回」要落账（先落账再等收尾回调，否则 abort 分支
 * 会把「人停的」写成「失败」）。**必须经桥取内核同一实例**——直引会在产物里内联成
 * 私有副本，台账分家（构建闸拦下的正是这一条）。 */
export { useWorkLedgerStore } from '../../../state/work-ledger-store';
export { useWorkspaceEntryStore } from '../../../state/workspace-entry-store';
export { getChatStore, msgStoreFor } from '../../../ui/chat-store';
export type { AssistantMessage, ChatMessage, TextPart, UserMessage } from '../../../ui/message-model';
/* 窗口设施（app shell 件 A，B7 修复）：**开窗必须走设施**——它比裸 store 多一步
 * 「通知受治进程治理器」，lazy/with-window 档的后端靠这条通知才会被拉起。 */
export { closePluginWindow, openPluginWindow } from '../../window-facility';
/* 待题纸的题签三件要**与创作坞同一套选择器/同一把尺子**（模型下拉 = ModelSelector，
 * 思考档位表 = thinkingOptionsOrDefault）。两者都在 compose-dock 产物里 ⇒ 经
 * paper-shell 的入站面反引一份（esbuild 内联，无运行时耦合）。 */
export { ModelSelector } from '../compose-dock/ModelSelector';
// 批 5a 注意：本包私有件（provenance / sel-ink / focus-flight / sheet）**不进本面**——
// host 面是「内核桥」专用（host-modules 的 FaceBridgeSeal 要求本文件每个导出都是
// faceDeps 键）；包内符号由消费方直接 `from './<file>'` 取用。

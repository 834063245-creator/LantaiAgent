// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// app/panels/ComposerDock — 创作坞（Stage-4 §4.2 集成任务非新设计）。
// （增补四起源码落位 plugins/builtin/compose-dock/——产物通道化。）
//
// 定位（canvas-space-model-notes.md §5 拍板 9）：带设置的输入条，常驻画布
// 元素，状态跟活跃目标走（显式激活 + 高亮——2026-09-10 拍板：浏览态自动
// 跟随退役），设置项贴输入条（模型/权限/思考强度，展开收起），发送前顺手拨。
// 空白画布无活跃会话时处于无主待命态。
//
// 2026-09-06 收口 + 续批：三行制 = 书眉行（卷名 + 翰/律/后台指示）居顶、
// 输入行居中、设置行（模型/权限/思考）垫底——三控件落位输入行之下的
// 「下方一行」（DSH InputBar 排布），卷名/翰/律恒居书眉行；设置行内模型独居
// 左端、权限+思考成对靠右（组内权限在左）；设置行控件定宽防跳动（详
// PaperPanel.css）；模型选择器触发器恒驻 + 弹层内搜索（详 ModelSelector 头注）。
//
// 归属铁律：创作坞是视图不是容器，不拥有任何会话状态，只"指向"当前活跃
// 会话。草稿按会话隔离 = input-store 既有 sessionDrafts 机制（chat-session
// 切卷时 save/restore，本组件只读写 live inputText）；模型/思考 = compose-store
// 每会话偏好（写全局 settings + 热切换信号）；权限 = mode-store 工作区级
// 单一真相。
//
// 挂载：compose-dock 插件以 ctx.overlays 贡献行注册（slot:'composer'），
// 由 PaperPanel 渲染在底部；经 paper/overlay-context 取活跃会话。
// 双走查形态（增补四）：产物域源码——项目内依赖经 './host' 取宿主共享
// 真实例，react 经构建期别名桥。

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
/* 长按递给别的卷（card-quote-plan §2.2 态二）：手势与卷命中都在纸壳包（与画布同一套
 * 几何的知识），坞只调它的入口——不跨产物取 core 内部，走既有的 inlined 相对 import
 * （同 ModelSelector 先例：esbuild 内联，无运行时耦合）。 */
import { useQuoteHold } from '../paper-shell/quote-drop';
// 浮层门户（2026-09-22 附图预览案）：坞内两处**全局模态**（附图大图预览 /
// 全放二次确认）已随 2026-11-17 P6 拆进 `composer-modals.tsx`——「为什么要 portal
// 到 body」「为什么是裸 createPortal 而不是 Overlay 原语」两条病灶注在那边头注里
// （搬家不是删判据：理由跟着代码走）。Escape 仍走宿主桥既有的 useDialogEscape
// （faceDeps 早已在册，取用零指纹代价），故权限那枚的 Esc 留在本文件。
import { ComposerHeader } from './composer-header';
import { ImagePreviewModal, YoloConfirmModal } from './composer-modals';
import { InputRow, SettingsRow } from './composer-rows';
import { HIST_HINT_KEY } from './dock-copy';
import { GoalStrip } from './goal-strip';
import type { PermissionMode } from './host';
import {
  bareTarget,
  draftInputKey,
  getChatStore,
  paperTarget,
  patchRunConfig,
  useAskPendingStore,
  useCoreStore,
  useDialogEscape,
  useDraftPaperId,
  useDraftSheetStore,
  useModeStore,
  usePaperDock,
  volumeTarget,
} from './host';
import { useComposerAttach } from './surface/use-composer-attach';
import { useComposerChrome } from './surface/use-composer-chrome';
import { useComposerLayers } from './surface/use-composer-layers';
import { useComposerModels } from './surface/use-composer-models';
import { useComposerSend } from './surface/use-composer-send';
import { useComposerSession } from './surface/use-composer-session';
import { useComposerSlash } from './surface/use-composer-slash';
import { useRunConfig } from './surface/use-run-config';
import './composition-chip.css';
import './goal-strip.css';

/* 纯函数三件（providerNameForModel / navigateHistory / flattenDirEntries / fuzzyMatchFiles）
 * 已随坞面拆分落 `composer-helpers.ts`（2026-11-17 上帝文件治理 P6）。
 * ⚠ 三个导出符号在下方**中继 re-export**：行为测试与 desk 用例直接从本文件 import
 * 它们，改 import 面是无谓 churn（re-export 是导出面的搬家，不是新 API）。 */
export { flattenDirEntries, fuzzyMatchFiles, navigateHistory } from './composer-helpers';

/* 律册（HELP_GROUPS）与思考文案（THINKING_ZH / THINKING_DESC / thinkingZhLabel）
 * 已随坞面拆分落 `dock-copy.ts`（2026-11-15 V2：本文件在上帝文件账上，只减不增）。 */

/** 无目录声明模型的思考控件安全兜底表已收口到 provider/thinking 的
 *  THINKING_SAFE_OPTIONS（2026-09-23 思考下沉：设置页参数面板与这里共用同一把
 *  尺子），本件不再自抄一份。 */

/** 无面板（裸挂单件 / 早期装配）：compose-store 的入口仍要一个稳定 id。
 *  坞期不用会话覆盖表以外的账，故这个 id 只影响注册表键、不影响读数。 */
const NO_PANEL = '__no-panel__';

export type ComposerVariant = 'dock' | 'sheet';

/** 正常创作坞（卷成立之后）。待题纸上那张见 `ComposerSheet`——同一个面，另一次挂载。 */
export const ComposerDock = memo(function ComposerDock() {
  const { activeSessionId, composerLock } = usePaperDock();
  /* **焦点在纸上时**坞整只不渲染（V2-P1 的判据在 2026-11-17 多纸改判中收窄）：
   * 旧判据是「纸在画布上」——于是只要有一张题签，坞就消失，**不能回头和已有会话交互**
   * （用户报的那条）。现行判据是**焦点**：纸拿焦点才让位；纸摆在画布上不拿焦点时，
   * 坞照常对着活跃卷工作，点卷即把焦点与输入槽一并拿回来。
   * 判据放在**外壳**而不是 ComposerSurface 里：后者是那一堆 hook 的组装点，早退会
   * 违反 hooks 次序（lint/useHookAtTopLevel）；两层各有一次订阅，代价零。 */
  const draftFocusOn = useDraftSheetStore((s) => s.focusedId !== null);
  if (draftFocusOn) return null;
  return <ComposerSurface variant="dock" contextSessionId={activeSessionId} composerLock={composerLock} />;
});

/** **待题纸的创作坞**（2026-11-15 V2 立卷 UX）：纸在场时坞整只不渲染，输入面长在纸上。
 *
 *  与坞共用**同一份实现**与同一个 input store（设计件 §2 原则 8：禁复制第二份输入面——
 *  复制一份 = 把「一套设置摆两处」换成「一套输入摆两处」，负债更重）。
 *  2026-11-19 题签重画批之后差别只剩两处：
 *    ① 没有书眉、没有设置行（`pp-composer-settings` 整行不进纸期）——「这一卷打算
 *       怎么跑」的三笔已升为**卷首档行**（见 `DraftFolioSurface`），纸身只留一条输入行；
 *    ② 模型/思考写 **draft-sheet-store 的题签**（开卷那一刻才落既有写路径）。
 *  发送 = 起卷 + 把这句话发出去（编排在 `ChatCore.sendMessage` 的纸在场分支，
 *  本件只管点——判据与写入不在视图层）。
 *
 *  为什么经 overlays 的 'draft-sheet' 槽注册而不是直引：跨插件直引会把产物 esbuild
 *  内联成第二份 store（同 toast-store 先例，见 docs/landmine-map.md）。 */
export const ComposerSheet = memo(function ComposerSheet() {
  const draftOpen = useDraftSheetStore((s) => s.focusedId !== null);
  /* **交接窗里也留着**（2026-11-15 化卷批）：纸还在屏上退场，天头之下那段输入面若当帧撤，
   * 发送那一瞬下半张纸会**空一块**（真机定帧实测：纸还整张在那儿，输入行凭空没了）。
   * 留着它跟着纸一起退（`.pp-draft-morph`，`pointer-events: none`）——它不能再被点，
   * 也不该吃焦点，但它不该凭空不见。判据与纸自己那条同一把尺子（open || morph）。
   * ⚠ 多张同屏时「谁吃键盘」不在本件判（2026-11-19）：非焦点那张的**输入栈**由
   * DraftSheet 打 inert（只罩栈、不罩纸壳——纸壳一旦 inert 就再也点不回来）。 */
  const draftMorph = useDraftSheetStore((s) => Object.keys(s.morphs).length > 0);
  if (!draftOpen && !draftMorph) return null;
  return <ComposerSurface variant="sheet" contextSessionId={null} composerLock={undefined} />;
});

const ComposerSurface = memo(function ComposerSurface({
  variant,
  contextSessionId,
  composerLock,
}: {
  variant: ComposerVariant;
  contextSessionId: string | null;
  composerLock?: { unlocked: boolean; toggle: () => void };
}) {
  const isSheet = variant === 'sheet';
  const core = useCoreStore((s) => s.core);
  /* 纸期**没有活跃卷**：把上下文卷位当空——坞的既有「无主态」分支自然接管
   * （prefs 空、无役册/墨量册、running=false、组合走卷级判据的空位），一行不用改。 */
  const activeSessionId = isSheet ? null : contextSessionId;
  /* **本输入面挂在哪张纸上**（2026-11-29 多纸错位批）：多纸同屏时纸身里那份输入面
   * 也是逐纸各挂一个——旧实现读焦点那张的题签，于是非焦点那张的输入面显示的
   * 模型/思考（以及全放确认落哪一张）都是别人的。坞期 = null（不参与）。 */
  const sheetPaperId = useDraftPaperId();
  const draftFocusedId = useDraftSheetStore((s) => s.focusedId);
  /* **本件的草稿槽**（2026-11-30）：非焦点那张纸的输入面读它**自己**那份草稿
   * （`sessionDrafts['draft:<id>']`），不再显示焦点那张的正文；焦点那张/坞期读 live。 */
  const draftSlot =
    isSheet && sheetPaperId !== null && draftFocusedId !== sheetPaperId ? draftInputKey(sheetPaperId) : null;
  /* **本宿主指向的目标**（2026-11-29 收口批）：四笔的读与写都只认它。
   * 纸期 = 这张纸；坞期 = 活跃卷；两者皆无 = 无主（出厂的出生默认）。 */
  const panelId = core?.panelId ?? NO_PANEL;
  const target = useMemo(() => {
    if (isSheet) return sheetPaperId === null ? bareTarget(panelId) : paperTarget(sheetPaperId, panelId);
    if (activeSessionId === null) return bareTarget(panelId);
    return volumeTarget(activeSessionId, panelId);
  }, [isSheet, sheetPaperId, activeSessionId, panelId]);
  const config = useRunConfig(target);

  /* ⚠ 2026-11-17 P6：769 行 hooks 段按「随同一个事件变化」拆成八件（surface/ 目录）——
   * 每件只吃上面这三个判据（core / isSheet / activeSessionId）+ 自己的显式入参，
   * 返回值仍是原样的「值 + 回调」。**没有状态搬家、没有新增真源**：坞仍是唯一的
   * 组装点，件与件之间不互相订阅（宿主无关件不知道别的件存在）。 */

  /* ── 坞级态：提示浮层 / 附图预览 / 历史眉批判据 ── */
  const { notice, imagePreview, setImagePreview, armHistHintIfDue } = useComposerChrome();
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);

  /* ── 浮层五态（律/引/墨/役/案）+ 拖放界栏 + 引面板读数 ── */
  const layers = useComposerLayers({ activeSessionId });

  /* ── 会话面：sess / input / 四笔读数（模型推导在 use-model-seat）── */
  const session = useComposerSession({ core, target, draftSlot, activeSessionId, composerRef });

  /* 组合芯片（本卷身份 + 写入口）不住本坞（2026-11-19）：坞期那一格是书眉的
   * `.pp-comp-sel`（ComposerHeader 自持），纸期在卷首档行（DraftFolioSurface）——
   * 本组件不再自取一份。 */

  /* ── 斜杠命令域 ── */
  const slash = useComposerSlash({ core, inputText: session.inputText });

  /* ── 模型 / 思考热切换（写路径统一经 patchRunConfig）── */
  const { onModelChange, thinkingSeat } = useComposerModels({
    core,
    target,
    providerName: session.providerName,
    currentThinking: session.currentThinking,
    thinkingOptions: session.thinkingOptions,
  });

  /* ── 附件 / 附图 / 拖放入卷 ── */
  const attach = useComposerAttach({
    core,
    imageCapable: session.imageCapable,
    notice,
    dockRef,
    setDragOver: layers.setDragOver,
    composerRef,
    yin: {
      matches: layers.yinMatches,
      idx: layers.yinIdx,
      setIdx: layers.setYinIdx,
      close: () => layers.setYinOpen(false),
    },
  });

  /* ── 他卷待答提示（2026-11-22 二轮）──
   * 卡架是**全局单架**：别的卷在等作答/批准时，本框敲的字仍发给**当前卷**（不会抢答）。
   * 旧形态只有卡片上的卷名徽标，用户在本框里答完才发现没送到——把这句事实摆在输入行
   * 上方，并给「切过去」入口。数据面 = ask-pending-store（与卡架、卷首角标同一本账，
   * 零新状态）；点它 = 顶该卷的卡到队头 + 切卷（与待答缩略行同一手势）。 */
  const pendingAsks = useAskPendingStore((s) => s.entries);
  const askElsewhere =
    !isSheet && session.activeSidNum != null
      ? (pendingAsks.find((e) => e.ownerSid != null && e.ownerSid !== session.activeSidNum) ?? null)
      : null;
  const gotoWaitingVolume = useCallback(() => {
    if (!core || askElsewhere?.ownerSid == null) return;
    const sid = askElsewhere.ownerSid;
    core.promoteAskBySession(sid);
    core.switchToSession(sid);
  }, [core, askElsewhere]);

  /* ── 发送 / 运行态 / 后台卷指示 ── */
  const send = useComposerSend({
    core,
    isSheet,
    activeSidNum: session.activeSidNum,
    composerRef,
    inputText: session.inputText,
    setInputText: session.setInputText,
    slash,
  });
  const { running, bgRunning, sessionNameOf, onSend } = send;

  /* 役册「他卷」段的跳卷入口（2026-11-27）：监视面看到别卷还有活在跑，得能过去看。
     真源是 chat store 的会话表，切卷走 core 的既有 `switchSession`（与侧栏同一条路）。 */
  const goToSession = useCallback(
    (sid: number) => {
      if (!core) return;
      const st = getChatStore(core.panelId).sess.getState();
      const idx = st.sessions.findIndex((s) => s.id === sid);
      if (idx >= 0 && idx !== st.activeIdx) core.switchSession(idx);
    },
    [core],
  );

  /* ── 权限（2026-11-28 起**卷级**：本卷覆盖 ?? 工作区默认；纸期拨题签）──
   * 读数与写入都经 run-config（2026-11-29 收口批）：目标决定「这一卷 / 这一张纸 /
   * 无主」，本件不再自己拼 sessionModes/globalMode 那一串兜底。 */
  const permissionMode = config.permission;
  const pendingYolo = useModeStore((s) => s.pendingYolo);
  const pendingYoloPaper = useModeStore((s) => s.pendingYoloPaper);
  const setPendingYolo = useModeStore((s) => s.setPendingYolo);
  /* 全放二次确认模态的 Esc（同附图预览：portal 到 body 后 Escape 只能走 document 级）。
   * 多纸（2026-11-29）：**只有请求者那张纸**渲染这个模态（旧实现每张纸各渲染一个 portal
   * ——N 张纸 = N 个叠起来的确认框，点哪个都落焦点那张）。`== null` 容旧态（坞期/未记名）。 */
  const yoloMine = !isSheet || pendingYoloPaper == null || pendingYoloPaper === sheetPaperId;
  useDialogEscape(() => setPendingYolo(false), { enabled: pendingYolo && yoloMine });

  /** 直接写入（跳过「全放要二次确认」那道闸——确认模态自己用它落账）。
   *
   *  ⚠ **纸期分支必须留着**（2026-11-19 真机返工）：卷首档行的「全放」只负责**弹确认**，
   *  确认之后落哪一笔由**渲染这个模态的那位**决定——而模态住在纸期输入面
   *  （`ComposerSheet` → 本组件，与坞期同一份实现）。删掉这一支的后果：用户点「确定」，
   *  工作区默认被改成全放，而题签那一格**一个字没变** ⇒ 读作「弹窗吞了我的操作」。
   *
   *  ⚠ 2026-11-29（收口批）：三态（纸 / 卷 / 无主）一律 `patchRunConfig(target, …)`——
   *  旧实现三处各写各的，其中纸期那条**漏了**「下一张纸的出厂权限」⇒ 全放用户（本机工作区
   *  默认正是 yolo）在纸上拨完，重启后记号全无。落账目标 = 请求者那张纸（不是焦点那张）。 */
  const applyMode = useCallback(
    (mode: PermissionMode) => {
      /* 请求者记名时用它（用户点了全放又去点别的纸）；否则就是本宿主自己的目标。 */
      const writeTarget = isSheet && pendingYoloPaper != null ? paperTarget(pendingYoloPaper, panelId) : target;
      patchRunConfig(writeTarget, { permission: mode });
      /* 模态的收合也归这里：坞期靠 setSessionMode/setPermissionMode 顺手清 pendingYolo，
       * 纸期写的是题签、不经过那两个 setter ⇒ 不显式清，确认完弹窗会一直悬着。 */
      setPendingYolo(false);
    },
    [isSheet, pendingYoloPaper, panelId, target, setPendingYolo],
  );

  const selectMode = useCallback(
    (mode: PermissionMode) => {
      if (mode === 'yolo' && permissionMode !== 'yolo') {
        // 请求者记名（纸期 = 本件那张纸；坞期 = null）——确认时按这个名字落账
        setPendingYolo(true, isSheet ? sheetPaperId : null);
        return;
      }
      setPendingYolo(false);
      applyMode(mode);
    },
    [isSheet, permissionMode, setPendingYolo, applyMode, sheetPaperId],
  );
  // rework P0-1：卸载（含关窗）时清掉全放确认态，避免残留 DOM 参与销毁时序
  useEffect(() => () => setPendingYolo(false), [setPendingYolo]);

  /* ── 夹签长按·递给别的卷（方案 §2.2 态二）──
   *  坞只做两件：调手势入口、把落点写进**目标卷的草稿槽**（input-store 的既有能力位
   *  `addAttachedCardToSlot`——它不切活跃卷、不碰 live，正是「递出去」的语义）。
   *  自己那一卷 = 无操作：它本来就在这份槽里。 */
  /** 这次长按是从哪一枚起的（onDrop 里读——手势 hook 只经手 index）。 */
  const quoteHoldIdx = useRef<number | null>(null);
  const quoteHold = useQuoteHold({
    ownSession: session.activeSidNum != null ? String(session.activeSidNum) : '',
    onDrop: (target) => {
      if (!core || quoteHoldIdx.current === null) return;
      const input = getChatStore(core.panelId).input;
      const card = input.getState().attachedCards[quoteHoldIdx.current];
      quoteHoldIdx.current = null;
      if (!card) return;
      /* **拖动 = 挪，不是复制**（2026-11-20 用户报「拖给别的会话后原位那枚还在」）：
       * 卡本体早就在画布上（那才是拓印），夹签本身只有一枚——它换了归属，原处就该没了。
       * `moveAttachedCardToSlot` 一步做成（摘原位 + 写目标槽，不闪断）。 */
      const result = input.getState().moveAttachedCardToSlot(`s:${target}`, card);
      /* 成功不播报（坞内提示的克制纪律：界面变化即反馈——原位没了、切过去就有了）；
       * 只有「目标卷本来就有同一张卡」才说一声（那时不再加，但原位照样摘掉）。 */
      if (result === 'duplicate') notice(`第 ${target} 卷的夹签槽里已经有这枚了（原位已挪走）`, 'warn');
    },
  });
  /** 引面板的空态文案（清单还没拉回来 vs 真无匹配）——判据在坞，件只显示。 */
  const yinEmpty = layers.yinFiles.length === 0 ? '卷宗目录读取中…' : '无匹配文件';
  const onYinKeyDown = attach.onYinKeyDown;

  /* ── 历史眉批（v2 2026-08-31）：一次性提示——有历史且从未提示过时，
   *    首次聚焦浮现 6s（localStorage 旗标，毒化容忍）。提示长在功能所在处，
   *    不再常驻占位符。判据（storage + 历史长度）在 chrome 件，自散在 layers 件。*/
  const onComposerFocus = useCallback(() => {
    if (!core) return;
    const input = getChatStore(core.panelId).input.getState();
    if (armHistHintIfDue(input.inputHistory.length, HIST_HINT_KEY)) layers.showHistHint();
  }, [core, armHistHintIfDue, layers.showHistHint]);
  /* 设置行（**只在坞期**）：模型与权限是「这一趟怎么跑」，垫在输入行之下（2026-11-09
   * 用户裁定的三行制：账 / 笔 / 怎么跑）。
   * 纸期这一行**整行不进纸**（2026-11-19 题签重画批）：「这一卷打算怎么跑」的三笔已升为
   * 卷首档行（compose-dock 的 `DraftFolioSurface`，经 'draft-folio' 槽挂在纸的天头），
   * 纸身只留一条输入行。 */
  const settingsRowEl = (
    <SettingsRow
      variant={variant}
      permissionMode={permissionMode}
      onSelectMode={selectMode}
      model={session.model}
      providerName={session.providerName}
      providerKind={session.providerKind}
      running={running}
      thinking={thinkingSeat}
      onModelChange={onModelChange}
      onModelBlocked={() => notice('Agent 正在运行——本回合结束后才能切换模型。', 'warn')}
    />
  );

  return (
    <div className={`pp-composer${layers.dragOver ? ' pp-droptarget' : ''}`} ref={dockRef}>
      {/* 书眉行（2026-11-09 用户裁定：**模型与权限另起一行**）——左端卷名，右端只有读数 + 移。
          判据（书眉=这一卷的账 / 换模型与拨权限是动作）随件搬进 `composer-header.tsx`。
          ⚡ 纸期**没有书眉**（2026-11-19）：旧纸期书眉只说「待题 · 未开卷」+ 一枚弃纸，
          那句话与卷首眉行逐字重复；弃纸搬进卷首档行右上角（`DraftFolioPicks`）。
          纸替坞的判据仍在外层（ComposerDock 早退），故本件挂在纸上时也不该有书眉——
          杆子只有一根：`isSheet`。 */}
      {!isSheet && (
        <ComposerHeader
          activeSession={session.activeSession}
          activeSidNum={session.activeSidNum}
          panelId={core?.panelId ?? ''}
          tokenStats={session.tokenStats}
          tokenCount={session.tokenCount}
          sessionNameOf={sessionNameOf}
          onGoToSession={goToSession}
          composerLock={composerLock}
          workOpen={layers.workOpen}
          inkOpen={layers.inkOpen}
          onToggleWork={() => layers.toggleLayer('work')}
          onToggleInk={() => layers.toggleLayer('ink')}
          bgRunning={bgRunning}
        />
      )}

      {/* 他卷待答（2026-11-22）：输入前可见的事实——「这框发给本卷，别的卷在等」。
          零他卷待答 = 不渲染（不占行高）。 */}
      {askElsewhere && (
        <div className="pp-ask-elsewhere" role="status">
          <span className="pp-ask-elsewhere-what">
            「{askElsewhere.badge ?? '他卷'}」正在等{askElsewhere.kind === 'perm' ? '批准' : '作答'}
          </span>
          <span className="pp-ask-elsewhere-note">本框输入仍发给当前卷</span>
          <button type="button" className="pp-ask-elsewhere-go" onClick={gotoWaitingVolume}>
            切过去
          </button>
        </div>
      )}

      {/* 附图预览（B2）：大图浮层——点击缩略图开、点遮罩/Esc 关。
          ⚠ DOM 上挂 body（portal），故它**不是**输入行的布局子件；血缘上仍住这行。
          「为什么 portal 到 body」的病灶注随件搬家：见 `composer-modals.tsx` 头注。 */}
      <ImagePreviewModal preview={imagePreview} onClose={() => setImagePreview(null)} />

      {/* 输入行（原 composer 主体）
          ⚡ 2026-11-15 V2：判据从「纸在场 ⇒ 隐藏本行」改为「纸在场 ⇒ 整只坞不渲染」
          （见 ComposerSurface 开头的早退）——本行不再需要 hidden。
          2026-11-17 P6：行件搬进 `composer-rows.tsx` 的 `<InputRow />`（props 全展开）；
          「textarea 必须是第一个布局件」这条左轴判据随件搬家并在那边写明。 */}
      <InputRow
        composerRef={composerRef}
        placeholder={session.activeSession ? '拟文…' : '落笔即另起一卷…'}
        inputText={session.inputText}
        onPaste={attach.onComposerPaste}
        onChange={(e) => {
          session.setInputText(e.target.value);
          // 手输 = 退出历史浏览（浏览下标复位；草稿槽保留到下次进入时覆写）
          if (core) {
            const input = getChatStore(core.panelId).input.getState();
            if (input.inputHistoryIdx !== -1) input.setInputHistoryIdx(-1);
          }
        }}
        onFocus={onComposerFocus}
        onKeyDown={send.handleComposerKeyDown}
        slashCommands={slash.slashCommands}
        slashQuery={slash.slashQuery}
        slashIdx={slash.slashIdx}
        slashHit={slash.slashHit}
        onSlashHover={slash.setSlashIdx}
        onSlashCommit={slash.commitSlash}
        yinOpen={layers.yinOpen}
        yinQuery={layers.yinQuery}
        onYinQuery={layers.setYinQuery}
        yinMatches={layers.yinMatches}
        yinIdx={layers.yinIdx}
        onYinHover={layers.setYinIdx}
        yinEmpty={yinEmpty}
        yinInputRef={layers.yinInputRef}
        onYinKeyDown={onYinKeyDown}
        onYinAttach={attach.onYinAttach}
        onPreviewImage={setImagePreview}
        attachedFiles={session.attachedFiles}
        attachedImages={session.attachedImages}
        attachedCards={session.attachedCards}
        onRemoveAttached={attach.onRemoveAttached}
        onRemoveAttachedImage={attach.onRemoveAttachedImage}
        onRemoveAttachedCard={(idx) => {
          // 撕掉 = 只出槽（方案 §2.7：此时还没写任何盘上文件，没有别的要撤）
          if (!core) return;
          getChatStore(core.panelId).input.getState().removeAttachedCard(idx);
        }}
        onQuoteHold={(e, idx) => {
          quoteHoldIdx.current = idx;
          quoteHold.begin(e);
        }}
        quoteDropState={quoteHold.state}
        onToggleYin={() => layers.toggleLayer('yin')}
        onAttach={attach.onAttach}
        running={running}
        onSend={onSend}
        onAbort={() => core?.abort()}
      />

      {/* 设置行：模型与权限另起一行（2026-11-09 两次裁定）——判据（权限居左 / 模型收右）
          随件搬进 `composer-rows.tsx` 的 `<SettingsRow />` 头注。纸期不进纸（见上方
          settingsRowEl 头注：三笔已升为卷首档行）。 */}
      {!isSheet && settingsRowEl}

      {/* 历史眉批（一次性，6s 自散）：提示长在功能所在处，不常驻占位符 */}
      {layers.histHint && <div className="pp-eyebrow-hint">↑ 可回取上文 · ↓ 返回草稿</div>}

      {/* 目标状态条（2026-10-23 DSH 式目标域）：有目标才出现；暂停/恢复/清除走同一命令面。
          纸期没有活跃卷，`goalView` 仍会留着上一卷的读数——目标属于卷，不属于待题纸，
          故只在坞期挂载；否则一张新纸会莫名继承别的会话的目标。 */}
      {!isSheet && <GoalStrip core={core} />}

      {/* rework P2-3 / P0-1：全放二次确认 = 独立居中模态（不内嵌创作坞，避免高度/关窗竞态）
          ——同附图预览的 portal 理由，见 `composer-modals.tsx` 头注。 */}
      <YoloConfirmModal
        open={pendingYolo && yoloMine}
        onCancel={() => setPendingYolo(false)}
        onConfirm={() => applyMode('yolo')}
      />
    </div>
  );
});

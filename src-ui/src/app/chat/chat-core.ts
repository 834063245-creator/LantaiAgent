// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// ═══════════════════════════════════════════════════════════════
// ChatCore — 聊天无头核心（P2′ 原地重构）
// 从 ui/chat.ts 的 ChatPanel 提炼：保留全部会话/流式/权限/goal 编排，
// 剥离一切 DOM 操作 —— 视图层是 src/app/chat/ChatBeacon.tsx（React）。
//
// 输入文本：textarea 不再存在于此，唯一数据源是 input-store.inputText。
// 面板模式：panel-store.panelMode（pill/input/panel/hud），视图据此渲染。
// chat-session.ts / chat-stream.ts / part-mutator.ts / execution-state.ts
// 全部原样保留 —— 会话 ctx 的 DOM 字段由分离桩元素吸收（写入不可见但兼容）。
// ═══════════════════════════════════════════════════════════════

import { agentSessionState, type OwnedAgentHandle } from '../../agent/agent-session-state';
import type { AgentEvent } from '../../agent/agent-types';
import type { ChatAgentHandle } from '../../agent/chat-agent-handle';
import { createExecState, type ExecStateInstance, type RunKind } from '../../agent/execution-state';
import { log } from '../../agent/logger';
// 批 9h-4：事实保存授权旗标住内核登记表（记忆实现已随 memory-domain 产物包）
import { authorizeFactSave } from '../../agent/memory-impl';
import * as Obs from '../../agent/obs';
import { describeRetryFacts, readRetryFacts } from '../../agent/retry';
import { isRunDeadlineExceeded } from '../../agent/run-watchdog';
import type { RuntimePort } from '../../agent/runtime/types';
import { totalTokens } from '../../agent/token-meter/usage';
import { useShellStore } from '../../app/shell-store';
import type { CommandContribution } from '../../composition/services';
import { activeSpace } from '../../composition/space-service';
import { pickDropAnchor } from '../../paper/space';
import type { ChatImageRef } from '../../provider/types';
import { apiErrorSummary } from '../../provider/types';
import { clipLabel, useAskPendingStore } from '../../state/ask-pending-store';
import { askSessionOf, useAskStore } from '../../state/ask-store';
import { useDockStore } from '../../state/dock-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../../state/toast-store';
import { bumpTurnDone } from '../../state/turn-done-store';
import { deriveVolumeLabel, isUnnamedVolumeLabel, volumeDisplayName } from '../../state/volume-name';
import { useWorkspaceSwitchStore } from '../../state/workspace-switch-store';
import { useAgentPanelStore } from '../../ui/agent-panel-store';
import * as Session from '../../ui/chat-session';
import {
  getChatStore,
  getExpandedReasoningSet,
  getStreamingAssistantId,
  getUserScrolledUp,
  msgStoreFor,
  msgStoreForActive,
} from '../../ui/chat-store';
import * as Stream from '../../ui/chat-stream';
import { type ChatMessage, resetMsgIdCounter, type UserMessage } from '../../ui/message-model';
import { builtinCommands } from '../commands/builtin-commands';
import { listCommands, parseSlashInput } from '../commands/command-catalog';
import { ensureSkillCatalog } from '../commands/skill-catalog';
import type { PromptShelfHandle } from './ask-card-contract';
import { restoreCanvasSpread, saveCanvasState } from './canvas-restore';
import { GoalDriver } from './goal-driver';
import {
  admitImageBlob,
  admitImageFromPath,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_IMAGE_BYTES,
  splitIntakePaths,
} from './image-intake';
import * as Branch from './session-branch';
import * as SessionComposition from './session-composition';

// ── 斜杠技能候选 ──
// 真源 = app/commands/skill-catalog（工作区路径键控缓存）；chat-core 构造时
// 同步确保一次，工作区已变则后台重扫——命令清单是同步读取面，见该模块头注。

/** 视图注册的输入框命令式接口（聚焦/全选），其余输入状态一律走 input-store */
export interface ComposerApi {
  focus: () => void;
  selectEnd: () => void;
}

/** 消息列表命令式句柄 —— /compact 重建会话后强制重拉（bump = bumpChat(panelId)） */
export interface MessagesApi {
  bump(): void;
}

/** 全局 store 订阅登记（2026-09-01 审计）：ChatCore 每次重建都新订四个全局
 *  store（ask/agent-panel/goal/workspace-switch），此前从不退订——重建即累积
 *  （同一事件被多个死实例重复消费）。模块级登记上一实例的退订函数，构造时
 *  先解除再重订；panelId 每实例唯一，全局 store 订阅是唯一跨实例存活的引用面。 */
const _globalStoreUnsubs: Array<() => void> = [];

// ── 辅助函数（模块级：无 this 依赖，发送面共用）──

/** 附加文件 → 文本前缀。暴露路径以便 Agent 读取（大小不做假：openFilePicker 拿不到真实
 *  size，旧实现硬编码 0 导致模型看到「0 B」误判空文件；要真大小需 Rust stat 通道）。
 *  附图不走此处——引用随 agent.run 结构化传递（multimodal-image-plan D-1）。 */
function buildFocusPrefix(files: readonly { path: string }[]): string {
  if (files.length === 0) return '';
  let prefix = '用户附加了以下文件：\n';
  for (const f of files) prefix += `- \`${f.path}\`\n`;
  return `${prefix}你可以用 read_file 读取这些文件。\n\n`;
}

export class ChatCore {
  /** 面板唯一实例 ID。自动生成，用于 store 隔离。 */
  readonly panelId: string;

  /** 执行状态 — 面板级实例。 */
  private _exec: ExecStateInstance;

  /** 目标续行驱动器（状态在会话日志，排程/收尾裁决在它自己的模块里）。 */
  private readonly _goal: GoalDriver;
  /** workspace 接线的公开访问器（面板级兜底 exec——无卷场景）。 */
  get execState(): ExecStateInstance {
    return this._exec;
  }

  /** 会话级 execState（并发会话，2026-08-26）：工厂装配时给 Agent 挂
   *  所属卷的 exec——权限卡队列/停止语义按卷隔离，停 A 卷不杀 B 卷的卡。 */
  getSessionExecState(sessionId: number): ExecStateInstance {
    return Session.getSessionExecState(this.panelId, sessionId);
  }

  /** 流式同步 timer — 按卷隔离（并发会话：两卷各自防抖刷新，互不挤掉对方）。 */
  private _syncTimers = new Map<number, ReturnType<typeof setTimeout>>();

  private onOpenSettings: (() => void) | null = null;

  // ── 视图注册槽（视图挂载后注入组件 ref 句柄）──
  private _composer: ComposerApi | null = null;
  private _promptShelf: PromptShelfHandle | null = null;
  private _chatMessages: MessagesApi | null = null;

  // ── exec 状态广播（视图订阅 stop 按钮/运行态）──
  private _execListeners = new Set<() => void>();

  private get messages(): ChatMessage[] {
    const store = msgStoreForActive(this.panelId);
    return store?.getState().messages ?? [];
  }
  private set messages(msgs: ChatMessage[]) {
    const store = msgStoreForActive(this.panelId);
    if (store) store.getState().setMessages(msgs);
  }

  // ═══════════════════════════════════════════════════════════
  // 构造 — 只做 store 订阅与 exec 绑定，不碰 DOM
  // ═══════════════════════════════════════════════════════════

  constructor() {
    // 上一实例的全局 store 订阅先解除（2026-09-01 审计：重建不累积——
    // 退订函数登记在模块级 _globalStoreUnsubs，声明见类定义上方）
    for (const unsub of _globalStoreUnsubs.splice(0)) unsub();
    this.panelId = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this._exec = createExecState();
    // 目标驱动器：宿主能力位注入本类（每卷账 / 活动卷句柄 / 轮次脚手架），
    // 状态条数据源 = 本面板的 panel store。构造顺序无关——能力位都是方法。
    this._goal = new GoalDriver(
      {
        panelId: this.panelId,
        activeSessionId: () => this.activeSessionId,
        agentOf: () => this.agent,
        activeExecOf: () => this._activeExec(),
        execStateOf: (sid) => Session.getSessionExecState(this.panelId, sid),
        agentOfSession: (sid) => Session.getSessionAgent(this.panelId, sid),
        runAgentTurn: (opts) => this._runAgentTurn(opts),
      },
      () => getChatStore(this.panelId).panel.getState(),
    );

    // 斜杠技能候选：确保当前工作区的清单（键变了则后台重扫；返回值 = 清单变没变，
    // 消费面在 compose-dock 的斜杠面板——它「打开即强制重扫」并据此重取。
    // 详见 app/commands/skill-catalog 头注。）
    void ensureSkillCatalog(useShellStore.getState().projectPath);

    // ── ask_user tool → prompt shelf（视图注册后生效）──
    // P1 总线归零：prompt:ask → state/ask-store（callback-in-store：pending 跨
    // chat-core 重建存活——构造时回放；bus 时代 emit 早于订阅即静默丢失）
    _globalStoreUnsubs.push(
      useAskStore.subscribe((s, prev) => {
        if (s.seq !== prev.seq) this._consumePendingAsk();
      }),
    );
    this._consumePendingAsk(); // 回放在途 pending（chat-core 重建场景）
    // ── 追踪用户焦点已拆除（2026-08-27 死码清扫）：发射点随星图 V5 拆除 /
    // app-shell 死亡而消失——chat-context-store / scene-signal-store 整链删除，
    // @ 自动补全节点名喂给逻辑一并退役（P2 起 starGraph 恒缺席）。
    // P1 总线归零：agent:diag → agent-panel-store.diag（workspace 直写，此处订阅转写）
    _globalStoreUnsubs.push(
      useAgentPanelStore.subscribe((s, prev) => {
        if (s.diag !== prev.diag && s.diag !== null) {
          getChatStore(this.panelId).panel.getState().setLastAgentDiag(s.diag.text);
        }
      }),
    );
    // ── Goal strip：切换工作区/卷后重载（状态真源 = 本卷会话日志）──
    // P1 总线归零：workspace:switched → state/workspace-switch-store
    _globalStoreUnsubs.push(
      useWorkspaceSwitchStore.subscribe((s, prev) => {
        if (s.switchedTick !== prev.switchedTick) {
          // 工作区切换 = 全上下文重置：在途提问/权限卡全部按取消收口
          //（卡片 callback 指向旧工作区已 dispose 的 Agent——按卷杀卡够不到
          // 他卷残留，漂到新工作区只能是死回答回调；2026-09-10 ask 完备化）
          this._promptShelf?.dismiss();
          // 待答账同步清场（卡架 dismiss 会把每个挂起 Promise 按取消结掉，账本跟着空）
          useAskPendingStore.getState().reset();
          this.refreshGoalView();
        }
      }),
    );
    this.refreshGoalView();

    // ⚡ ExecutionState → store 同步：订阅活动会话的 execState。
    // 重绑触发面（2026-09-06 运行态同步根治）：会话切换（sess 表）+ exec
    // 实例表变更（agentSessionState 版本 bump——切卷惰性水合 setExec、拟文
    // getOrCreateExec、removeExec 重建都会换掉订阅目标实例，捕获式订阅指向
    // 孤儿实例，活跃卷起停从此不可见：状态栏不切「分析中」/停止不回焦点）。
    // 版本重绑只重挂订阅不做初始同步——实例表变更时活跃卷的 isRunning 值
    // 未变（换实例必经 stop/新造，二者都是 false 起步），初始同步的
    // dismiss/focus 副作用只由真起停与切卷触发。
    let _execUnsub: (() => void) | null = null;
    let _rebinding = false;
    const _onExecChange = (exec: ExecStateInstance, ownerSid: number | null) => {
      if (exec.isRunning) {
        this._updateStatusBar('thinking', '分析中…');
      } else {
        this._updateStatusBar('idle');
        // ⚡ 停止只收本卷的卡（2026-09-10 ask 用户侧完备化）：卡片生命周期
        // 挂归属卷——旧 dismiss() 一刀切清全架，切卷（新卷 idle 的初始同步）
        // 和停 A 卷都会误杀 B 卷在等答案的提问卡（Agent 收「用户取消」而
        // 用户没答过）。权限卡同理按卷收（enqueuePerm 只管排队态，展示态
        // 的杀卡此前也是一刀切）。
        this._promptShelf?.dismissByOwner(ownerSid);
        // 待答账按卷清场（A+B 画布多卷审批 UX）：停 A 卷不许把 B 卷的待答痕迹一起抹掉
        useAskPendingStore.getState().settleByOwner(ownerSid);
        this._composer?.focus();
      }
      for (const cb of this._execListeners) cb();
    };
    const _bindExecState = (initialSync = true) => {
      // 重入守卫：_activeExec() 的 getOrCreateExec 在实例缺席时会 bump 版本
      // → 同步触发版本监听递归重绑——递归层让位（外层完成同一次绑定即可，
      // 否则内层挂的订阅被外层覆盖句柄 = 漏退订）。
      if (_rebinding) return;
      _rebinding = true;
      try {
        if (_execUnsub) {
          _execUnsub();
          _execUnsub = null;
        }
        const ownerSid = this.activeSessionId;
        const exec = this._activeExec();
        _execUnsub = exec.onChange(() => _onExecChange(exec, ownerSid));
        if (initialSync) _onExecChange(exec, ownerSid); // 初始同步
      } finally {
        _rebinding = false;
      }
    };
    _bindExecState();
    // 用户切换活动会话时重新绑定（含初始同步——换卷即呈现新卷状态）；
    // 退订入 _globalStoreUnsubs（此前漏收——旧实例的订阅永不解除）
    _globalStoreUnsubs.push(getChatStore(this.panelId).sess.subscribe(() => _bindExecState()));
    // exec 实例表变更 → 只重挂订阅（不做副作用式初始同步）
    _globalStoreUnsubs.push(agentSessionState.subscribe(() => _bindExecState(false)));

    // ── Agent 事件通过 eventSink 直接投递 → renderEvent ──
    // (4.2: 取消总线中转 — Agent → ChatCore 是 1:1，无需总线)
  }

  // ═══════════════════════════════════════════════════════════
  // 视图注册
  // ═══════════════════════════════════════════════════════════

  registerComposer(api: ComposerApi): void {
    this._composer = api;
  }
  registerPromptShelf(c: PromptShelfHandle): void {
    this._promptShelf = c;
    // 注册即回放在途 ask（2026-09-10 完备化）：构造期回放撞上 shelf 未注册的
    // 窗口时请求已留在 ask-store，此处补收——不再有「无声取消」路径。
    this._consumePendingAsk();
  }
  registerMessages(c: MessagesApi): void {
    this._chatMessages = c;
  }

  /** 视图订阅 exec 状态变化（运行/权限卡计数）；返回退订函数 */
  onExecChange(cb: () => void): () => void {
    this._execListeners.add(cb);
    return () => this._execListeners.delete(cb);
  }
  get execBusy(): boolean {
    return this._activeExec().isBusy;
  }

  // ═══════════════════════════════════════════════════════════
  // 公共 API（main.ts / workspace.ts 契约面，与旧 ChatPanel 一致）
  // ═══════════════════════════════════════════════════════════

  setOnOpenSettings(fn: () => void): void {
    this.onOpenSettings = fn;
  }
  /** 由视图转发 — Footer 的设置按钮 */
  fireOpenSettings(): void {
    this.onOpenSettings?.();
  }

  /** 面板级事件接收器 — 直接调用，无总线中转。（遗留：无会话身份，
   *  路由兜底活跃卷——仅恢复路径使用；工厂装配一律用 eventSinkFor。） */
  get eventSink(): (ev: AgentEvent) => void {
    return (ev: AgentEvent) => this.renderEvent(ev);
  }
  /** 会话级事件入口 — 工厂装配时绑定（并发会话，2026-08-26）：事件天生
   *  携带所属卷身份，无论哪卷活跃都路由进自己的消息 store。 */
  eventSinkFor(sid: number): (ev: AgentEvent) => void {
    return (ev: AgentEvent) => Stream.renderEvent(this._streamCtxFor(sid), ev);
  }
  /** 面板级 Agent 进度事件接收器。 */
  get progressSink(): (data: { step: number; toolName: string }) => void {
    return (data: { step: number; toolName: string }) => this._updateStatusBar('thinking', `${data.toolName}…`);
  }
  setAgentFactory(fn: ((sessionId: number) => Promise<OwnedAgentHandle | null>) | null): void {
    Session.setAgentFactory(this.panelId, fn);
  }

  private get agent(): ChatAgentHandle | null {
    return Session.getActiveAgent(this.panelId);
  }

  /** 活动会话的执行状态（按会话隔离）。 */
  private _activeExec(): ExecStateInstance {
    const s = getChatStore(this.panelId).sess.getState();
    const sid = s.sessions[s.activeIdx]?.id;
    return sid ? Session.getSessionExecState(this.panelId, sid) : this._exec;
  }

  setAgent(agent: OwnedAgentHandle | null): void {
    if (!agent) {
      // null = 显式拆除（旧语义：API Key 被清空时调用）：注销会话工厂并 dispose
      // 所有会话 Agent 句柄 — 否则旧 provider/工厂会继续服务会话（残留 bug）。
      // Phase B（2026-08-24 工作区归属根治）：会话列表与各卷消息 store 不再
      // 清空——会话的显示不依赖 Agent 是否装配成功（无工厂/无句柄 = 无处发出
      // 请求，中危#5 的「残留服务」由工厂注销 + 句柄 dispose 拦截）。
      Session.setAgentFactory(this.panelId, null);
      Session.clearPanelAgents(this.panelId);
      return;
    }
    // Agent 装配时序归位（2026-08-25，DSH 形态）：启动/切工作区不再预造句柄、
    // 不铺卷——装配链只挂工厂（setupAgent 已挂）+ 清理旧工作区残留。
    // 传入的预造句柄（历史调用形：workspace.ts 初始 Agent）就地 dispose——
    // 句柄的生命周期跟随卷，拟文时 ensureSessionAgent 惰性现造。
    // 会话列表/消息 store 不动：工作区全量重置由 resetSessionState 承担。
    Session.resetSessionState(this.panelId);
    agent.dispose();
    getChatStore(this.panelId).panel.getState().setTotalTokensUsed(0);
    Session.syncActiveSessionTokens(this.panelId, 0);
    getChatStore(this.panelId).panel.getState().clearToolUsage();
    getChatStore(this.panelId).panel.getState().clearToolHistory();
    this.messages = [];
    resetMsgIdCounter(this.panelId);
    // 工作区重置：流式标志随会话级消息 store 整体消亡（disposeMessagesStores
    // 已随 resetSessionState 拆除全部卷 store），面板默认槽一并清零兜底。
    getChatStore(this.panelId).msg.getState().setStreamingAssistantId(null);
  }

  getAgent(): ChatAgentHandle | null {
    return this.agent;
  }
  setProjectPath(p: string): void {
    // projectPath 单一权威 = shell-store（2026-08-04 状态治理收口）。
    const shell = useShellStore.getState();
    shell.setProjectPath(p);
  }

  // ── 模式机（pill/input/panel/hud → panel-store，视图渲染）──

  toggle(): void {
    const mode = getChatStore(this.panelId).panel.getState().panelMode;
    switch (mode) {
      case 'pill':
      case 'input':
        this.summonPanel();
        break;
      case 'panel':
        this.collapseToInput();
        break;
      case 'hud':
        this.restoreFromHud();
        break;
    }
  }
  open(): void {
    this.summonPanel();
  }
  close(): void {
    const mode = getChatStore(this.panelId).panel.getState().panelMode;
    if (mode === 'panel' || mode === 'hud') this.collapseToInput();
    else if (mode === 'input') this.collapseToPill();
  }
  isOpen(): boolean {
    const mode = getChatStore(this.panelId).panel.getState().panelMode;
    return mode === 'panel' || mode === 'hud';
  }
  summonPanel(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('panel');
    this._resetPillBadge();
    this.closeHistory();
    setTimeout(() => this._composer?.focus(), 60);
  }
  collapseToInput(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('input');
  }
  collapseToPill(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('pill');
  }
  expandToInput(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('input');
    setTimeout(() => this._composer?.focus(), 60);
  }
  fadeToHud(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('hud');
  }
  restoreFromHud(): void {
    getChatStore(this.panelId).panel.getState().setPanelMode('panel');
    setTimeout(() => this._composer?.focus(), 60);
  }

  /** 以编程方式向 Agent 提问。唤起面板并发送。
   *  纸视图（走查弹）打开时不唤起观测台聊天面板——纸自己就是输入面，
   *  summon 会造成双层叠影。 */
  ask(question: string): void {
    const mode = getChatStore(this.panelId).panel.getState().panelMode;
    const paperOpen = useDockStore.getState().isOpen('paper');
    const alreadyOpen = mode === 'panel' || mode === 'hud' || paperOpen;
    if (!alreadyOpen) this.summonPanel();
    getChatStore(this.panelId).input.getState().setInputText(question);
    // 延迟片刻，等面板出现后再发送
    setTimeout(() => this.sendMessage(), alreadyOpen ? 0 : 200);
  }

  /** 通过 PromptShelf 渲染权限请求（位于输入框上方，非内联）。
   *  并发会话（2026-08-26）：ownerSid = 请求归属卷（bridges 按 agentId 解析）。
   *  权限卡挂归属卷的 execState 队列——停止语义按卷隔离（停 A 卷只杀 A 的卡，
   *  旧「挂此刻活跃卷」是活 bug：切到 B 后 A 的写权限卡会被 B 的停止键误杀）。
   *  2026-09-10 完备化：展示态同款按卷——ownerSid/badge 进卡（dismissByOwner
   *  按卷收卡 + 归属卷徽标替哪卷批准）。 */
  showPermissionCard(
    toolName: string,
    reason: string,
    subject: string,
    danger?: string,
    ownerSid?: number | null,
  ): Promise<{ allow: boolean; remember: boolean }> {
    if (getChatStore(this.panelId).panel.getState().panelMode !== 'panel') {
      this.summonPanel();
    }
    if (!this._promptShelf) {
      return Promise.resolve({ allow: false, remember: false });
    }
    const shelf = this._promptShelf;
    const exec = ownerSid != null ? Session.getSessionExecState(this.panelId, ownerSid) : this._activeExec();
    const sid = ownerSid ?? null;
    const cardId = `perm-${toolName}-${Date.now()}`;
    // 待答账（2026-11-11 A+B）：排队期与展示期都算「这卷在等我批」——直到点头/拒绝/超时。
    useAskPendingStore.getState().upsert({
      id: cardId,
      ownerSid: sid,
      kind: 'perm',
      label: clipLabel(subject ? `${toolName} · ${subject}` : toolName),
      badge: ownerSid != null ? this._sessionLabelOf(ownerSid) : null,
      at: Date.now(),
    });
    return exec
      .enqueuePerm(() =>
        shelf.showPermission({
          type: 'permission',
          id: cardId,
          ownerSid: sid,
          badge: ownerSid != null ? this._sessionLabelOf(ownerSid) : null,
          toolName,
          reason,
          subject: subject || '',
          danger,
        }),
      )
      .finally(() => useAskPendingStore.getState().settle(cardId));
  }

  // ── Agent status bar → panel-store（视图渲染）──

  private _updateStatusBar(state: 'idle' | 'thinking' | 'running' | 'error', detail?: string): void {
    const p = getChatStore(this.panelId).panel.getState();
    p.setLastAgentState(state);
    p.setLastAgentDetail(detail ?? null);
  }

  // ── 工具使用追踪 ──

  private _recordToolUsage(toolName: string, args: string): void {
    getChatStore(this.panelId).panel.getState().addToolUsage(toolName, args);
  }

  /** 对工具名称进行分类，用于可视化分组。
   *  （graph/ops/lsp 域 36+ 工具名清单已随图谱全量退役删除，2026-09-09——
   *  剩余 holo 类 = hologram_ 前缀的第一方记忆域工具。） */
  static isHoloTool(name: string): boolean {
    return name.startsWith('hologram_'); // 记忆域工具（历史前缀，见 domains.ts memory 域）
  }
  static toolCategory(name: string): 'read' | 'write' | 'exec' | 'holo' {
    if (ChatCore.isHoloTool(name)) return 'holo';
    if (/^(read|search|grep|glob|list|view|show|get|find|cat|head|tail)/i.test(name)) return 'read';
    if (/^(write|edit|create|delete|remove|mv|cp|rename|save)/i.test(name)) return 'write';
    if (/^(run|exec|bash|shell|cmd|build|test|cargo|npm|git|python|node|web_|ask_|agent_)/i.test(name)) return 'exec';
    return 'read';
  }

  // ── Context bridges（chat-session / chat-stream 原样消费）──

  private _sessionCtx(): Session.SessionContext {
    const storeId = this.panelId;
    return {
      storeId,
      getProjectPath: () => useShellStore.getState().projectPath,
      getTotalTokensUsed: () => getChatStore(storeId).panel.getState().totalTokensUsed,
      setTotalTokensUsed: (n) => {
        getChatStore(storeId).panel.getState().setTotalTokensUsed(n);
      },
      setLastUsageText: (s) => {
        getChatStore(storeId).panel.getState().setLastUsageText(s);
      },
      clearInputHistory: () => {
        const s = getChatStore(storeId).input.getState();
        s.setInputHistory([]);
        s.setInputHistoryIdx(-1);
        s.setDraftText('');
      },
      getRuntime: () => useAgentPanelStore.getState().runtimeRef as RuntimePort | null,
    };
  }

  /** 回合失败的**唯一漏斗**（日志可观测性批 1，docs/plans/log-observability-plan.md §2.3）：
   *  墓碑落定后补一条 `turn.failed`。六处出口共用——同回合同层去重由门面负责（不许刷屏）。
   *
   *  ⚡ 为什么在 chat-core 而不在 `Stream.markTurnError` 里：`ui/chat-stream.ts` 是
   *  冻结文件（CONVENTIONS §1.1），而漏斗需要「哪个卷、哪一轮、哪条运行记录」这三样
   *  身份——它们只在这里齐（turnSid / turnGen / run.id）。
   *
   *  phase/kind 默认由错误**类型**推导（`Obs.classifyTurnFailure`：ApiError 的
   *  status/kind 优先，文案只用于凭据闸的契约标记）；调用点知道得更准时显式覆盖
   *  （硬截止作废、目标暂停）。 */
  private _logTurnFailure(
    turnSid: number | null,
    turnGen: number,
    runId: number,
    err: unknown,
    opts: { visible: string; phase?: Obs.ObsPhase; kind?: Obs.TurnFailKind; level?: 'warn' | 'error' },
  ): void {
    const cls = Obs.classifyTurnFailure(err);
    Obs.turnFailed({
      ids: { session: turnSid, turn: turnGen, run: runId },
      phase: opts.phase ?? cls.phase,
      kind: opts.kind ?? cls.kind,
      status: cls.status,
      raw: cls.raw,
      level: opts.level,
      message: opts.visible,
    });
  }

  /** 会话级流上下文（并发会话，2026-08-26）：sid = 事件流所属卷（工厂绑定
   *  的 eventSinkFor 传入）；null = 无身份遗留路径，按活跃卷解析。
   *  流式状态（streamingAssistantId / 同步 timer）随 ctx 按卷隔离——
   *  两卷并发流式互不覆盖。状态栏/用量文本/面板 token 只跟随活跃卷
   *  （后台卷的运行态由创作坞 bgRunning 指示承担）。
   *  ownerSid 在遗留路径（sid=null）下解析为活跃卷——活跃卷缺席时
   *  （无会话）ownerSid 为 null，ctx 上所有会话寻址面降级为 no-op。 */
  private _streamCtxFor(sid: number | null): Stream.StreamContext {
    const storeId = this.panelId;
    // ctx 所属卷（null 时每次调用解析活跃卷——遗留路径语义）
    const ownerSid = sid ?? this.activeSessionId;
    // 同步 timer 按卷隔离（并发流各自防抖，互不挤掉对方的刷新；
    // 无会话（ownerSid null）共用 -1 槽——无消息面，timer 无实际作用）
    const timerKey = ownerSid ?? -1;
    return {
      storeId,
      sessionId: ownerSid,
      getSessionMessages: (s: number) => msgStoreFor(storeId, s).getState().messages,
      getActiveMessages: () => {
        const s = msgStoreForActive(storeId);
        return s?.getState().messages ?? [];
      },
      setSessionMessages: (s: number, msgs: ChatMessage[]) => {
        msgStoreFor(storeId, s).getState().setMessages(msgs);
      },
      bumpSessionMessages: (s: number) => {
        msgStoreFor(storeId, s).getState().bump();
      },
      getStreamingAssistantId: () =>
        ownerSid != null
          ? msgStoreFor(storeId, ownerSid).getState().streamingAssistantId
          : getStreamingAssistantId(storeId),
      setStreamingAssistantId: (id) => {
        if (ownerSid != null) msgStoreFor(storeId, ownerSid).getState().setStreamingAssistantId(id);
        else getChatStore(storeId).msg.getState().setStreamingAssistantId(id);
      },
      getUserScrolledUp: () => getUserScrolledUp(storeId),
      setUserScrolledUp: (v) => {
        getChatStore(storeId).msg.getState().setUserScrolledUp(v);
      },
      getSyncRafId: () => this._syncTimers.get(timerKey) ?? null,
      setSyncRafId: (id) => {
        if (id === null) this._syncTimers.delete(timerKey);
        else this._syncTimers.set(timerKey, id);
      },
      getTurnPairs: () => Session.getTurnPairs(this.panelId, ownerSid ?? undefined),
      getAgent: () => (ownerSid != null ? Session.getSessionAgent(this.panelId, ownerSid) : this.agent),
      setLastUsageText: (s) => {
        // 用量文本是活跃卷的底栏——后台卷事件不覆盖显示
        if (ownerSid == null || ownerSid === this.activeSessionId) {
          getChatStore(storeId).panel.getState().setLastUsageText(s);
        }
      },
      saveActiveSession: async (p) => {
        // StreamContext 契约是 Promise<void>（冻结文件 chat-stream）——落盘结果
        // 在退出 flush 面单独消费，此处吞掉返回值保持形状。
        await this.saveActiveSession(p);
      },
      scheduleAutoSave: (p) => Session.scheduleAutoSave(this._sessionCtx(), p),
      bumpPillBadge: () => {
        this._bumpPillBadge();
      },
      // React 视图没有 DOM 气泡 — 入场动画由组件 CSS 负责
      animateBubbleIn: () => undefined as never,
      setRunning: (_r: boolean) => {
        /* 已迁移到 execState */
      },
      abort: () => this.abort(),
      _updateStatusBar: (s, d) => {
        // 状态栏是活跃卷的——后台卷事件不改状态栏（其进度由纸面流式呈现）
        if (ownerSid == null || ownerSid === this.activeSessionId) this._updateStatusBar(s, d);
      },
      _recordToolUsage: (n, a) => this._recordToolUsage(n, a),
      sendMessage: () => this.sendMessage(),
      _recordTokens: (_record) => {
        // token 计量入库（2026-09-13）：真源 = Agent 侧账本（streamOnce 已记），
        // 这里只取两个投影面：
        //   ① 卷级累计总量 → sess.sessionTokens（坞的订阅触发面 + 卷文件 tokensUsed）；
        //   ② 活跃卷 → panel.totalTokensUsed（状态栏/导出同源）。
        // 无句柄（无 Key 未装配）时无账本可读——保留卷文件里的旧值，不编造。
        if (ownerSid == null) return;
        const stats = Session.getSessionAgent(storeId, ownerSid)?.getTokenStats?.();
        if (!stats) return;
        const total = totalTokens(stats.totals);
        getChatStore(storeId).sess.getState().setSessionTokens(ownerSid, total);
        if (ownerSid === this.activeSessionId) {
          getChatStore(storeId).panel.getState().setTotalTokensUsed(total);
        }
      },
      getProjectPath: () => useShellStore.getState().projectPath,
      getRunning: () => this._activeExec().isRunning,
      getAbortCtrl: () => {
        const signal = this._activeExec().abortSignal;
        if (!signal) return null;
        // 2026-09-01 审计：此前裸 { signal } 冒充 AbortController——消费方一旦
        // 调 .abort() 即 TypeError。补转发 abort 的最小实现（真源仍是运行账）。
        return { signal, abort: () => this._activeExec().stopAll() } as AbortController;
      },
      setAbortCtrl: (_c: unknown) => {
        /* 由 execState 管理 */
      },
      getExpandedReasoning: () => getExpandedReasoningSet(storeId),
    };
  }

  // ── 会话管理（委托给 chat-session.ts）──

  /** 把某卷的第一张在等卡顶到队头（画布多卷审批 A 面「点角标顶队头」）。
   *  返回 false = 该卷没有在等卡 / 本来就在队头（调用方据此决定要不要只跳卷）。 */
  promoteAskBySession(sid: number): boolean {
    return this._promptShelf?.promoteByOwner(sid) ?? false;
  }

  /** 按**卷 id** 切卷（2026-11-11 画布多卷审批 UX：卷首待答角标 / 待答缩略行
   *  手里只有 sid，没有数组下标）。找不到 = no-op（卷已关掉的陈旧点击不炸）。 */
  switchToSession(sid: number): void {
    const st = getChatStore(this.panelId).sess.getState();
    const idx = st.sessions.findIndex((s) => s.id === sid);
    if (idx < 0) return;
    this.switchSession(idx);
  }

  switchSession(idx: number): void {
    Session.switchSession(this._sessionCtx(), idx);
    // 目标状态是卷级的：切卷后重读本卷日志（句柄惰性补建 → 排到微任务后）。
    // 切进一卷也可能是「回到一个 active+armed 却在后台停着的目标」——重排一次
    // 续行，否则它要等用户下一句话的收尾才会被重新捡起（2026-11-12）。
    queueMicrotask(() => {
      this.refreshGoalView();
      this._goal.scheduleGoalDrive();
    });
  }
  closeSession(idx: number): void {
    Session.closeSession(this._sessionCtx(), idx);
    queueMicrotask(() => this.refreshGoalView());
  }
  async createNewSession(): Promise<void> {
    // S6 P4：模块入口返回新卷 id（程序入口判成败用）——本编排面包装器不承载该值
    // （程序入口 = app/chat/session-composition 的模块函数，UI 之外的调用者直接调它）。
    await Session.createNewSession(this._sessionCtx());
    this.refreshGoalView();
  }

  /** 创作者模式入口（2026-10-30）：起一卷 creator，把开场白填进输入框（**不自动发送**
   *  ——需求由用户补完，避免点一下就开始花钱）。失败原因原样返回给控件显示。 */
  async createCreatorSession(): Promise<{ ok: boolean; reason?: string }> {
    const r = await SessionComposition.createSessionWithPreset(this._sessionCtx(), 'creator');
    if (!r.ok) return { ok: false, reason: r.reason };
    getChatStore(this.panelId).input.getState().setInputText(SessionComposition.CREATOR_OPENING_PROMPT);
    this.refreshGoalView();
    return { ok: true };
  }

  /** **立枝**（会话树，2026-09-18）：从某条消息（节点）另起一枝——**枝含该节点**，
   *  本卷原样保留（字节零变化），新枝复制到此为止的历史并摊到案头。
   *  入口 = 块 hover 动作行（与「改」「重发」同族，见 `use-block-ops`）。
   *  返回新枝卷号；null = 未立（具名原因已可见）。
   *  「改」原地重写（破坏性）、「立枝」另起一条（非破坏性）——两者并存。
   *
   *  **摊开 + 定位 = expand 一家的职责**（P0 修复，2026-09-18）：立枝原只走
   *  `loadSessionFromDisk`（卷进了案头），但**没有 requestFocus 就不会飞**——
   *  新卷由落位 effect 用 `nearestFreeRegion` 补位，落点可能在视口外，用户视角
   *  就是「没摊开」。故此处补唯一一次 `expand`（已摊开 ⇒ focus + requestFocus；
   *  未摊开 ⇒ 读盘成功才飞）。**调用侧不得再自己补 requestFocus**：失败路径照样
   *  发请求 = 永不兑现的悬空定位（landmine-map #28）。
   *
   *  `drop`（P4-① 空间手势，2026-09-19）：**落点世界坐标**——按住块上的「枝」握把拖到
   *  纸上松手时给。落位走 `pickDropAnchor`（与既有流区横向重叠 ⇒ 推最近空位；不重叠 ⇒
   *  落哪算哪）+ `space.place`，**再** expand（先落位后摊开，与书脊拖落同一顺序：region
   *  先写、装载即用落点位）。缺省 = 既有点击入口，落位由落位 effect 补（行为零变化）。
   *
   *  `block`（2026-09-22 按块定位）：**本块坐标**（消息 parts + 本块下标）——切点落在
   *  该块所在**那一步**的末尾，而不是整轮末尾。不带 = 只按消息定位（整轮末尾，旧语义）。
   *  **两参数刻意各自独立、都留在原位**（`drop` 第三、`block` 第四）：插件产物是磁盘通道
   *  热更的（换产物不重编译 exe），而本函数住在壳里——产物已更、壳未重建时，按钮路径传的
   *  块坐标若占了第三位，旧核会把它当**落点**（`drop.x` undefined ⇒ NaN 落位）。 */
  async branchFromMessage(
    msg: ChatMessage,
    sessionId: number,
    drop?: { x: number; y: number },
    block?: Branch.BranchBlockRef,
  ): Promise<number | null> {
    const point = Branch.resolveBranchPoint(this.panelId, sessionId, {
      _id: msg._id,
      role: msg.role,
      ...(msg.role === 'assistant' ? { respondingTo: msg.respondingTo } : {}),
      ...(block ? { block } : {}),
    });
    if (!point.ok) {
      showToast(point.reason, 'warn', TOAST_LONG_HOLD_MS);
      return null;
    }
    const result = await Branch.createBranchVolume(this._sessionCtx(), sessionId, point.atSeq);
    if (!result.ok) return null;
    const space = activeSpace();
    if (drop) {
      const anchor = pickDropAnchor(space?.getState().regions ?? [], String(result.sid), drop.x, drop.y);
      space?.place(String(result.sid), anchor.anchorX, anchor.anchorY);
    }
    space?.expand(String(result.sid));
    return result.sid;
  }

  /** **一卷内全部块的可立枝判据**（一次性派生）——「立枝」按钮置灰 + 具名原因的
   *  渲染期读面（`use-block-ops` 每卷问一次，不逐块问；见 `Branch.deriveBranchPoints`）。
   *  节点键 = **块** id（同一条答复的各块切点不同）；判据与点击时的 `branchFromMessage`
   *  同源：置灰是提示，点击仍由后者兜底。 */
  branchPoints(sessionId: number, nodes: Branch.BranchNode[]): Map<string, Branch.BranchPoint> {
    return Branch.deriveBranchPoints(this.panelId, sessionId, nodes);
  }

  /** 连坐删除的准备面（只读、**磁盘真源**血缘）：确认文案的枝数 + 运行中拦截名单。
   *  第一击确认时问一次（子树里有运行中的卷 ⇒ 整体拒绝并列出，plan §9）。 */
  planBranchDelete(sessionId: number): Promise<Branch.CascadePlan> {
    const pp = useShellStore.getState().projectPath;
    return Branch.planBranchDelete(this.panelId, pp, [sessionId]);
  }

  /** **连坐删除**（plan §9 用户裁定）：删父卷 = 删整棵子树，后序（先子后父，永不产生
   *  孤儿），逐卷可见（部分失败不静默）。见 `Branch.deleteBranchSubtrees`。 */
  deleteSessionWithBranches(sessionId: number): Promise<Branch.CascadeOutcome> {
    const pp = useShellStore.getState().projectPath;
    return Branch.deleteBranchSubtrees(this.panelId, pp, [sessionId], (sid) => this.deleteSessionFile(pp, sid));
  }

  /** 批量连坐删除（多选批量条）：同一套准备/执行面，可删的删、被运行中拦下的逐个报。 */
  deleteSessionsWithBranches(sessionIds: readonly number[]): Promise<Branch.CascadeOutcome> {
    const pp = useShellStore.getState().projectPath;
    return Branch.deleteBranchSubtrees(this.panelId, pp, sessionIds, (sid) => this.deleteSessionFile(pp, sid));
  }

  /** **某卷的枝边血缘**（父卷 + 切点）：真源 = 卷日志头行（attach 时已带入内存），
   *  **零 I/O、O(1)**——卷首/侧栏/书脊那枚「枝」标读它（父卷在不在场都不影响「本卷是枝」
   *  这个事实）。null = 根卷 / 无句柄 / 无日志。 */
  branchOrigin(sessionId: number): Branch.BranchNodeOrigin | null {
    return Branch.branchOriginOf(this.panelId, sessionId);
  }

  /** **一枝的画布承接面**（P3）：从本卷头行取父卷与切点，再把切点落到父卷里承载它的
   *  那条界面消息——引线要指的那个节点（plan §5：连回**那个节点**，不是「父卷」整体）。
   *  null = 根卷 / 无句柄 / 父卷没句柄 / 切点落不到节点 ⇒ 调用方不画线（宁可没有，
   *  也不指错）。零 I/O（血缘在头行、attach 时已带入内存）。 */
  branchEdge(sessionId: number): { parentSid: number; nodeMessageId: string } | null {
    const origin = Branch.branchOriginOf(this.panelId, sessionId);
    if (!origin) return null;
    const nodeMessageId = Branch.branchNodeMessageId(this.panelId, origin.id, origin.atSeq);
    if (!nodeMessageId) return null;
    return { parentSid: origin.id, nodeMessageId };
  }

  // ── 组合（S6 P1c：卷级选择）──

  /** 本卷组合身份 + 来源（卷级记录 / 全局默认）——创作坞组合芯片的读面。
   *  异步 = 解析面动态 import（见 ui/session-composition 文件头「解析面动态
   *  import」：静态可达 composition-store 会成环）。 */
  sessionComposition(sessionId: number): Promise<SessionComposition.SessionCompositionInfo> {
    return SessionComposition.sessionCompositionInfo(this.panelId, sessionId);
  }

  /** 本卷是否空白（未跑过一轮）——芯片可拨 ⇔ 空白（跑过一轮即只读标签）。 */
  isSessionBlank(sessionId: number): boolean {
    return SessionComposition.isSessionBlank(this.panelId, sessionId);
  }

  /** 卷级组合选择：校验 → 空白闸 → 登记 → 空白卷即时重建句柄。
   *  返回拒绝原因（不可解析 / 已跑过一轮）供控件面显示——组合面是字节契约，
   *  跑过一轮的卷不给换（另起一卷再选）。 */
  async selectSessionPreset(sessionId: number, presetId: string): Promise<SessionComposition.SessionPresetChange> {
    return SessionComposition.selectSessionPreset(this._sessionCtx(), sessionId, presetId);
  }

  /** 改名（C8 书脊题签）：sess store 单写入口 + 立即落盘（改名即存）。 */
  renameSession(id: number, label: string): void {
    getChatStore(this.panelId).sess.getState().renameSession(id, label);
    const pp = useShellStore.getState().projectPath;
    if (pp) void Session.saveSessionById(this._sessionCtx(), pp, id);
  }

  /** 改名未摊开的已存卷（Stage-3 侧边栏行操作）：磁盘直改，不要求句柄。 */
  async renameSavedSession(id: number, label: string): Promise<void> {
    const pp = useShellStore.getState().projectPath;
    return Session.renameSessionFile(pp, id, label);
  }

  // ── 会话持久化（委托给 chat-session.ts）──

  /** 当前活跃会话 id（L2 持久化分流：turn-done 判后台卷用）。 */
  get activeSessionId(): number | null {
    const st = getChatStore(this.panelId).sess.getState();
    return st.sessions[st.activeIdx]?.id ?? null;
  }

  /** 按 id 落盘指定卷（L2 两动词之 save：不要求活跃；空卷跳过）。
   *  P0（2026-09-15 存盘审计）：返回落盘结果——调用方据此可见化「没落盘」的卷。 */
  async saveSessionById(sid: number): Promise<Session.SessionSaveOutcome> {
    const pp = useShellStore.getState().projectPath;
    return Session.saveSessionById(this._sessionCtx(), pp, sid);
  }

  /** 全部有内容卷落盘（L2 退出收尾：F3 后台卷不丢）。返回逐卷汇总。 */
  async saveAllSessions(): Promise<Session.SessionSaveReport> {
    const pp = useShellStore.getState().projectPath;
    return Session.saveAllSessions(this._sessionCtx(), pp);
  }

  /** 退出 flush 唯一真源（P0）：取消防抖 → 等在途写 settle → 全卷显式落盘 → 再 drain。
   *  关窗/关机/失焦三入口共用本函数（`shell/rows/persistence`）；返回逐卷汇总，
   *  非空 anomalies = 有卷没落盘，调用方必须可见化（不静默）。 */
  async flushSessionsForExit(): Promise<Session.SessionSaveReport> {
    const cancelledDebounce = Session.cancelScheduledAutoSave(this.panelId);
    await Session.drainVolumeWrites();
    const report = await this.saveAllSessions();
    // 退出快照必须最后落盘：等在途写全部 settle 再返回（否则延迟调用方 destroy）
    await Session.drainVolumeWrites();
    return { ...report, cancelledDebounce };
  }

  /** 取消防抖落盘（不重挂）——退出收尾前半句（M7）。 */
  cancelPendingAutoSave(): boolean {
    return Session.cancelScheduledAutoSave(this.panelId);
  }

  async saveActiveSession(projectPath: string): Promise<Session.SessionSaveOutcome> {
    return Session.saveActiveSession(this._sessionCtx(), projectPath);
  }
  scheduleAutoSave(projectPath: string): void {
    Session.scheduleAutoSave(this._sessionCtx(), projectPath);
  }
  async autoRestoreLastSession(projectPath: string): Promise<void> {
    return Session.autoRestoreLastSession(this._sessionCtx(), projectPath);
  }
  async listSavedSessions(projectPath: string): Promise<Session.SavedSessionRow[]> {
    return Session.listSavedSessions(this._sessionCtx(), projectPath);
  }
  /** 单卷续开（返回「是否已在案头摊开」——space-service.expand 依此决定定位）。 */
  async loadSessionFromDisk(projectPath: string, sessionId: number): Promise<boolean> {
    return Session.loadSessionFromDisk(this._sessionCtx(), projectPath, sessionId);
  }
  /** 单卷真删（返回**删除结果**——连坐删除要逐卷报账，见 session-branch 的连坐面）。
   *  产品侧单卷删除的唯一入口 = `deleteSessionWithBranches`（连坐）；本方法是它注入的
   *  逐卷执行面（也是既有单卷删除语义的直呼面，测试据此钉画布/标签页副作用）。 */
  async deleteSessionFile(projectPath: string, sessionId: number): Promise<Session.SessionDeleteResult> {
    return Session.deleteSessionFile(this._sessionCtx(), projectPath, sessionId);
  }

  /** Stage-5：进工作区恢复画布（实现见 app/chat/canvas-restore）——悬空摊开项
   *  自愈、两阶段并行恢复、枝线卷句柄水合全在那边；本类只提供宿主能力位。 */
  async restoreCanvasSpread(workspace: string): Promise<void> {
    return restoreCanvasSpread(
      {
        panelId: this.panelId,
        sessionCtx: () => this._sessionCtx(),
        switchSession: (idx) => this.switchSession(idx),
      },
      workspace,
    );
  }

  /** Stage-5：显式保存点落盘工作区画布状态（切换 / 关闭窗口时调用）。 */
  async saveCanvasState(workspace: string): Promise<void> {
    return saveCanvasState(this.panelId, workspace);
  }

  // ── 轮次撤回定位（委托给 chat-session.ts 沙盒映射，ID 直达）──

  /** 撤回/重发按钮准入：该轮当前能否被唯一定位撤回（不可 = 置灰降级）。 */
  canRetraceUserMessage(msg: UserMessage): boolean {
    const sid = this.activeSessionId;
    return sid != null && Session.canRetraceUserTurn(this.panelId, sid, msg._id);
  }

  /** 导出当前案卷（/export 命令面调用的能力位）。 */
  async exportSession(): Promise<void> {
    return Session.exportSession(this._sessionCtx());
  }

  // ── History panel（视图渲染；core 只提供开关与数据）──

  toggleHistory(): void {
    const p = getChatStore(this.panelId).panel.getState();
    p.setHistoryOpen(!p.historyOpen);
  }
  closeHistory(): void {
    getChatStore(this.panelId).panel.getState().setHistoryOpen(false);
  }

  // ── 发送 ──

  private async sendAgentText(text: string, displayLabel?: string): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    await this._runAgentTurn({
      bubble: displayLabel,
      drive: (signal) => agent.run(signal, text),
    });
  }

  // ── Goal（2026-10-23 DSH 式目标域：状态在会话日志，驱动器在 GoalDriver）──
  // 读/判/排/收尾全在 app/chat/goal-driver.ts；本类只提供宿主能力位（每卷账、
  // 活动卷句柄、轮次脚手架）并转发命令面与状态条刷新。

  /** 本卷目标状态条刷新（切工作区/切卷后重载——状态真源 = 本卷会话日志）。 */
  refreshGoalView(): void {
    this._goal.refreshGoalView();
  }

  /** Agent 轮次的共享脚手架。 */
  private async _runAgentTurn(opts: {
    /** 本轮来文气泡文本（铸气泡 + 记轮次对）；缺省 = 不起泡（目标自动轮）。 */
    bubble?: string;
    /** 本轮回合开始时的一次性动作（发送面清输入框/附件、推历史、起卷命名都在这里）。 */
    onStart?: () => void;
    /** 运行种类（运行账的记录标签：诊断 + 读面策略）——目标自动轮传 'goal'。 */
    runKind?: RunKind;
    drive: (signal: AbortSignal) => Promise<unknown>;
    /** 本轮收尾裁决（目标驱动器用）：中止/异常如实上报，供暂停或停用续行。 */
    onSettled?: (info: { aborted: boolean; error?: unknown }) => void;
    /** 目标自动轮：本轮**恒属于发起时刻的目标卷**，不是"此刻活跃卷"。 */
    goalTurn?: { sid: number | null };
  }): Promise<void> {
    // 并发会话（2026-08-26）：闸门拆除——后台卷运行不再阻止本卷新轮次；
    // 仅本卷自身在跑时拒发（Enter 插话路径由 sendMessage 处理）。
    // 目标自动轮例外（2026-11-12）：它挂的是**目标卷**的账，不受"此刻翻开哪卷"影响——
    // 旧实现取活跃卷账，切卷后目标轮的记录挂到别的卷上（驱动看本卷空闲就再开一轮 →
    // 同卷两条 loop），轮尾收尾用别人的账判暂停。
    const exec = opts.goalTurn
      ? Session.getSessionExecState(this.panelId, opts.goalTurn.sid ?? -1)
      : this._activeExec();
    if (!this.agent || exec.isRunning) return;
    // 回合开始的一次性动作（发送面的命名/清输入/消费附件）——必须在起运行账之前，
    // 与插入路径/作答路径的早退语义一致：拒绝起轮就什么都不该动。
    opts.onStart?.();
    // 起一条运行记录（谁起谁收）：signal 由账铸；收尾 `run.end()` 只注销自己这条
    //（v43 起「清掉别人的运行」在类型上不可能——旧实现的 done(signal) 守卫是约定）。
    const run = exec.beginRun(opts.runKind ?? 'turn');
    const signal = run.signal;
    // L2（session-ledger）：本轮跑的是哪卷——头部捕获，finally 随 turn-done
    // 信号发出（后台卷跑完存它自己，不再只存当前翻开的卷）。
    // 目标自动轮按**发起时刻的目标卷**归属（与上面 exec 账同一身份）。
    let turnSid: number | null = null;
    if (opts.goalTurn) {
      turnSid = opts.goalTurn.sid;
    } else {
      const sessStore = getChatStore(this.panelId).sess.getState();
      turnSid = sessStore.sessions[sessStore.activeIdx]?.id ?? null;
    }
    // 轮次代数 bump —— 本轮成为该卷最新轮次（finally 收尾身份守卫，见下）
    // 轮次代数 bump（账在 session-registry：跨面板实例复用同一本，见 turnGenOf 头注）
    const turnGen = Session.bumpTurnGen(this.panelId, turnSid);

    // 为新轮次重置自动滚动（视图级状态——只在本轮卷即活跃卷时才有意义；
    // _runAgentTurn 恒由活跃卷发起，turnSid == 活跃卷）
    getChatStore(this.panelId).msg.getState().setUserScrolledUp(false);

    // 先铸气泡拿 _id——轮次簿册以它作权威身份（撤回/重发 ID 直达）。
    // 气泡由调用方给（sendMessage 的来文气泡、sendAgentText 的命令标签、目标轮无色），
    // 本层不管气泡长什么样，只管「谁发起了本轮」。
    if (opts.bubble) {
      const bubble = this.appendUserBubble(opts.bubble);
      Session.getTurnPairs(this.panelId, turnSid ?? undefined).push({
        userText: opts.bubble,
        uiMsgId: bubble._id,
        userBubble: null,
        assistantBubble: null,
      });
    }

    // 3.6: 在 Agent 上设置 UI 会话 ID，使子 Agent 通知能正确路由到对应会话
    //（并发会话：轮次路由身份已由工厂绑定的 eventSinkFor 携带；这里只管
    // 子 Agent 通知路由的 agent._uiSessionId）
    // 目标轮按**本轮所属卷**的句柄写（切卷后 this.agent 已是另一卷的句柄）。
    const turnAgent = opts.goalTurn ? Session.getSessionAgent(this.panelId, turnSid ?? -1) : this.agent;
    if (turnSid != null && turnAgent) {
      turnAgent.setUiSessionId(turnSid);
    }

    let settleError: unknown;
    try {
      await opts.drive(signal);
    } catch (err: unknown) {
      settleError = err;
      // 2026-08-31 贴黄拆迁：回合错误改记入回合自身（墓碑），不再播黄纸条
      const msg = err instanceof Error ? err.message : String(err);
      // 用户停止的判据是**事实**（2026-09-14 拆文本猜测）：本轮 signal 是否被中止。
      // 旧实现用 `!msg.includes('aborted')` 判「用户按了停止」——于是传输出自己断掉的
      // 失败（BodyStreamBuffer was aborted）被当作用户意图静默吞掉：案卷里留下一条
      // 悬空来文，用户只看见「模型不响应」。
      if (msg.includes('paused after')) {
        Stream.markTurnError(this._streamCtxFor(turnSid), msg, 'warn');
        this._logTurnFailure(turnSid, turnGen, run.id, err, {
          phase: 'stream',
          kind: 'PAUSED',
          level: 'warn',
          visible: msg,
        });
      } else if (isRunDeadlineExceeded(err)) {
        // ⚡ 硬截止作废（landmine L3，2026-09-20）：**必须**落墓碑，且不能被
        // `!signal.aborted` 挡住——看门狗作废的第一步就是 abort（既有停止语义），
        // 若沿用用户停止的静默分支，这一轮就变成「无错误、无墓碑、无日志」的幽灵轮
        // （正是本雷的用户侧症状）。判据是错误**类型**（RunDeadlineExceededError），
        // 不是文案——与 2026-09-14 拆掉 `msg.includes('aborted')` 同一条纪律。
        Stream.markTurnError(
          this._streamCtxFor(turnSid),
          `本轮超硬截止已作废，结果未知，勿当成功继续——${msg}。` +
            '可直接重发上一条消息；若反复出现，检查出网链路或服务商状态。',
          'error',
        );
        this._logTurnFailure(turnSid, turnGen, run.id, err, {
          phase: 'stream',
          kind: 'RUN_DEADLINE_EXCEEDED',
          visible: `本轮超硬截止已作废——${msg}`,
        });
      } else if (!signal.aborted) {
        const code = apiErrorSummary(err);
        // 直人发送面的引导句（输入框就在眼前，出错后能立刻重发/压缩/新建卷）；
        // 目标自动轮没有人守着输入框，引导句只会干扰对「续行为什么停」的判读。
        const hint = opts.bubble ? '。发送任意消息重试，或输入 /compact 压缩上下文，或输入 /new 新建会话' : '。';
        const visible = `错误: ${msg}${describeRetryFacts(readRetryFacts(err))}${hint}${code ? `\n（${code}）` : ''}`;
        Stream.markTurnError(this._streamCtxFor(turnSid), visible, 'error');
        this._logTurnFailure(turnSid, turnGen, run.id, err, { visible });
      }
      // 正常中止（用户主动停止）：exec 状态已表达，不另播报
    } finally {
      // 收尾**只注销本轮自己那条运行记录**（v43：按 id 身份，清不掉别人的运行；
      // 旧实现的 done(signal) 要靠调用方记得带令牌）。发起时刻捕获的 run 与结算
      // 时刻的活跃卷无关——切卷不影响本卷账。
      run.end();
      // 回合失败去重表随回合结束清理（键控自清理——漏调也不会无界增长，门面另有上限兜底）
      Obs.endTurn({ session: turnSid, turn: turnGen });
      // 轮次代数守卫（2026-09-03「停止后会话坏掉」次因）：本轮仍是该卷最新
      // 轮次时才 finalize——停止后用户立刻发新消息的窗口里，旧轮 finally 迟到
      // 落地会把新轮刚建立的流式助手误终结。让位时新轮自己的
      // TurnStarted/finally 承担终结（语义无缺口）。
      if (Session.turnGenOf(this.panelId, turnSid) === turnGen) {
        // 轮次收尾按轮次所属卷路由（后台卷跑完 finalize 自己的流式助手 +
        // 自动命名自己；用户中途切走不影响）
        Stream.finishTurn(this._streamCtxFor(turnSid));
      }
      bumpTurnDone(turnSid ?? undefined);
      // 收尾裁决：目标轮交给驱动器自己的结算；普通轮收尾后看一眼目标是否该续行
      // （工具在直人轮里创建了目标时，第 1 轮就从这个窗口开出去）。
      if (opts.onSettled) {
        opts.onSettled({ aborted: signal.aborted, ...(settleError === undefined ? {} : { error: settleError }) });
      } else {
        // 本轮所属卷（普通轮 = 活跃卷）——排程按**它的**账判空闲。
        this._goal.scheduleGoalDrive(turnSid ?? undefined);
      }
    }
  }

  /** 卷标签（ask/权限卡徽标用）：显示名——未命名卷由 volumeDisplayName 按档号兜底。 */
  private _sessionLabelOf(sid: number): string {
    const st = getChatStore(this.panelId).sess.getState();
    const s = st.sessions.find((x) => x.id === sid);
    return volumeDisplayName(s?.label, sid);
  }

  /** _sessionLabelOf 的公开出口（bridges 权限卡徽标）。 */
  sessionLabelOf(sid: number): string {
    return this._sessionLabelOf(sid);
  }

  /** 消费 ask-store 的在途请求 → PromptShelf。并发会话：按 seq 最老优先
   *  消费任意队列（PromptShelf 自身 FIFO 多卡，多卷同时提问各答各的）。
   *  2026-09-10 用户侧完备化：无 shelf 时不再按取消回答回调（静默取消 =
   *  用户没见过问题、模型收「用户取消」）——请求留在 store，registerPromptShelf
   *  注册时回放消费（ask-store 的 callback-in-store 先例即为此设计）。 */
  private _consumePendingAsk(): void {
    if (!this._promptShelf) return; // 无承接面：留 store（先判后取，防止出队即丢），注册时回放
    const data = useAskStore.getState().consumeAnyAsk();
    if (!data) return;
    // 归属卷徽标（哪卷在问——多卷并发时用户需要知道替谁作答）
    const ownerSid = askSessionOf(data);
    const badge = ownerSid != null ? this._sessionLabelOf(ownerSid) : null;
    // 待答账（2026-11-11 画布多卷审批 UX）：**交付即入账，答复即结账**。
    // 账本只记事实（哪卷在等 / 等什么），不参与调度——调度仍是 ask-store → 卡架 FIFO。
    const settleAsk = () => useAskPendingStore.getState().settle(data.id);
    useAskPendingStore.getState().upsert({
      id: data.id,
      ownerSid,
      kind: 'ask',
      label: clipLabel(data.question ?? data.questions?.[0]?.question ?? ''),
      badge,
      at: Date.now(),
    });
    // 批量多问（questions 数组）→ 一张分页卡收集；单问 → AskCard
    if (data.questions && data.questions.length > 0) {
      this._promptShelf
        .showAskBatch({
          type: 'ask-batch',
          id: data.id,
          ownerSid,
          badge,
          questions: data.questions,
          header: data.header ?? '提问',
        })
        .then((answers) => {
          try {
            data.callback(answers);
          } finally {
            settleAsk();
          }
        });
      return;
    }
    this._promptShelf
      .showAsk({
        type: 'ask',
        id: data.id,
        ownerSid,
        badge,
        question: data.question ?? '',
        header: data.header ?? '提问',
        options: data.options ?? [],
        multiSelect: !!data.multiSelect,
      })
      .then(
        (answers) => {
          try {
            data.callback(answers);
          } finally {
            settleAsk();
          }
        },
        (err) => {
          settleAsk(); // 展示面异常同样结账（不让账本留死条目）
          throw err;
        },
      );
  }

  /** 主输入文本作答在途提问卡（2026-09-10 完备化）：架头是提问卡且归属本卷
   *  （或无归属——活跃卷兜底语义）时以文本作答；返回 false = 不适用（空架/
   *  权限卡/他卷卡），调用方走常规发送路径。 */
  private _answerActiveAsk(text: string): boolean {
    const shelf = this._promptShelf;
    const active = shelf?.active;
    if (!shelf || !active) return false;
    if (active.type !== 'ask' && active.type !== 'ask-batch') return false;
    const owner = active.ownerSid ?? null;
    if (owner != null && owner !== this.activeSessionId) return false; // 他卷的卡不抢答
    if (!shelf.answerActiveText(text)) return false;
    showToast('已作为提问回答提交', 'info');
    return true;
  }

  async sendMessage(): Promise<void> {
    // 为新轮次重置自动滚动
    getChatStore(this.panelId).msg.getState().setUserScrolledUp(false);

    const text = getChatStore(this.panelId).input.getState().inputText.trim();
    if (!text) return;

    if (!this.agent) {
      // L0 惰性水合（session-ledger）：重启后惰性卷切到/拟文时句柄缺席——
      // 按需补建（factory 现调 + msgStore 内容回填），摊开集大时避免全量起 Agent
      // Phase D（错误不静默，2026-08-28 加固）：工厂/装配抛错此前一路穿透
      // sendMessage 变成 unhandled rejection——界面零反馈（「点发送没反应」）。
      // 这里捕获并双通道暴露（可见 notice + ui.log），同时不再让错误静默消失。
      let hydrated = false;
      try {
        hydrated = await Session.ensureSessionAgent(this._sessionCtx());
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[sendMessage] Agent 装配抛错:', e);
        log.error('chat', `[DEBUG-send] Agent 装配抛错: ${msg}`, {
          stack: e instanceof Error ? e.stack : undefined,
        });
        showToast(`Agent 装配失败: ${msg}`, 'error', TOAST_LONG_HOLD_MS);
        return;
      }
      if (!this.agent) {
        const detail = getChatStore(this.panelId).panel.getState().lastAgentDiag
          ? `${getChatStore(this.panelId).panel.getState().lastAgentDiag} (factory:${Session.getAgentFactory(this.panelId) ? 'yes' : 'NO'})`
          : '请先配置 API Key 或等待项目加载';
        showToast(`Agent 未就绪 — ${detail}${hydrated ? '（水合后句柄仍缺席）' : ''}`, 'error', TOAST_LONG_HOLD_MS);
        return;
      }
    }

    // ── 斜杠命令（真源 = app/commands/command-catalog 合流清单）──
    // 命令词与参数在目录层解析（`/goal resume` → cmd=/goal · arg='resume'），
    // 执行面唯一 = executeCommand——内建命令（/new /compact /export /goal…）与
    // 插件贡献命令（/settings /paper /sidebar /dock）走同一条路；带参命令不再
    // 需要在发送面硬编码分支（2026-09-19 command-surface-rework）。
    if (text.startsWith('/')) {
      const hit = parseSlashInput(listCommands(this), text);
      if (hit) {
        this.executeCommand(hit.cmd, hit.arg);
        return;
      }
      // 未知斜杠命令 — 路由到 Skill 工具
      if (!text.includes(' ')) {
        const skillName = text.slice(1);
        getChatStore(this.panelId).input.getState().setInputText('');
        void this.sendAgentText(`Execute skill: ${skillName}`, text);
        return;
      }
    }

    // ── 在途提问作答（2026-09-10 ask 用户侧完备化）──
    // Agent 运行中架头是本卷的提问卡时，主输入文本作为回答提交——否则运行中
    // 输入只能插话（下轮才见），提问卡干等 5 分钟超时被「取消」+ 一条无关
    // 插话同时砸向模型（用户本能是往主输入框打字，卡片内输入不是唯一路径）。
    // 跨卷不抢答：他卷的卡只认卡内输入（badge 已标替哪卷答），本卷输入语义
    // 优先保给本卷。
    if (this._activeExec().isRunning && this._answerActiveAsk(text)) {
      getChatStore(this.panelId).input.getState().setInputText('');
      getChatStore(this.panelId).input.getState().pushInputHistory(text);
      getChatStore(this.panelId).input.getState().setDraftText('');
      return;
    }

    // ── 插入路径：Agent 运行中，将消息注入会话 ──
    if (this._activeExec().isRunning) {
      this.agent.insertMessage(text);
      getChatStore(this.panelId).input.getState().setInputText('');
      getChatStore(this.panelId).input.getState().pushInputHistory(text);
      getChatStore(this.panelId).input.getState().setDraftText('');
      // C1（2026-08-27）：静默注入曾让用户误以为 Enter 被吞——插话落地要有回音（改 toast，不入流）
      showToast('已插入进行中的回合（Agent 运行中，消息将在下轮生效）', 'info');
      // 纸视图（走查弹）打开时不唤起观测台面板——纸是当前输入面
      if (getChatStore(this.panelId).panel.getState().panelMode === 'input' && !useDockStore.getState().isOpen('paper'))
        this.summonPanel();
      const bubble = this.appendUserBubble(text);
      Session.getTurnPairs(this.panelId, this.activeSessionId ?? undefined).push({
        userText: text,
        uiMsgId: bubble._id,
        userBubble: null,
        assistantBubble: null,
      });
      return;
    }
    // 并发会话（2026-08-26）：后台卷闸门拆除——本卷不在跑即可发起新轮次，
    // 与后台卷并行流式（事件路由由工厂绑定的 eventSinkFor 承担）。

    // 附加文件 + 附图（发送即消费掉附件槽）——文本前缀只载路径附件，
    // 附图引用随 agent.run 结构化传递（multimodal-image-plan D-1）。
    const filesSnapshot = [...getChatStore(this.panelId).input.getState().attachedFiles];
    const imagesSnapshot = [...getChatStore(this.panelId).input.getState().attachedImages];
    const agent = this.agent;

    // 起轮：轮次脚手架（运行账 / 气泡 / 轮次对 / 收尾守卫 / 续行排程）全在
    // _runAgentTurn 一处——与目标自动轮、命令驱动轮同一条路，禁止再长第二份。
    await this._runAgentTurn({
      bubble: text,
      onStart: () => {
        // 首条来文即命名（未命名卷）：判据与派生都走 state/volume-name 的**同一把尺子**
        // （与轮末 autoTitleSessionIfDefault 同规）。旧实现自带一套——只认「会话 」前缀
        // （术语换代后对新卷恒不命中）、27 字截断（与轮末的 28 字不一致）——是收口前
        // 的第三个命名写者，已拆。
        if (Session.getActiveIdx(this.panelId) >= 0) {
          const session = Session.getSessions(this.panelId)[Session.getActiveIdx(this.panelId)];
          if (session && isUnnamedVolumeLabel(session.label)) {
            const name = deriveVolumeLabel(text);
            // 来源 = derived：发送时的自动名可被后续自动概括覆盖（C 批判据）。
            if (name) getChatStore(this.panelId).sess.getState().renameSession(session.id, name, 'derived');
          }
        }

        // 若当前在浮动输入栏中，发送前先唤起完整面板（纸视图打开时除外——纸是输入面）
        if (
          getChatStore(this.panelId).panel.getState().panelMode === 'input' &&
          !useDockStore.getState().isOpen('paper')
        ) {
          this.summonPanel();
        }

        // 推入输入历史 + 清输入面
        getChatStore(this.panelId).input.getState().pushInputHistory(text);
        getChatStore(this.panelId).input.getState().setDraftText('');
        getChatStore(this.panelId).input.getState().setInputText('');

        // 附加文件 — 暴露路径以便 Agent 读取（大小不做假：openFilePicker 拿不到真实
        // size，旧实现硬编码 0 导致模型看到「0 B」误判空文件；要真大小需 Rust stat 通道）。
        if (filesSnapshot.length > 0) getChatStore(this.panelId).input.getState().clearAttachedFiles();
        if (imagesSnapshot.length > 0) getChatStore(this.panelId).input.getState().clearAttachedImages();
      },
      drive: (signal) =>
        agent.run(
          signal,
          buildFocusPrefix(filesSnapshot) + text,
          imagesSnapshot.length > 0 ? imagesSnapshot : undefined,
        ),
      // 直人轮收尾的目标续行排程不在这里给——_runAgentTurn 的 finally 缺省就按
      // **本轮所属卷**排一次（2026-11-12：模型在直人轮里建的目标，该轮收尾就开第 1 轮）。
    });
  }

  abort(): void {
    const stopped = this._activeExec();
    if (!stopped.isRunning) return;

    // ⚡ 统一状态管理：停本卷全部在跑的运行（abort 全部 signal + 注销记录 + 清权限卡队列）
    //   + 级联子 Agent。
    // v43（2026-09-20 运行态收口）：旧的「3 秒安全网」退役——它在旧模型里已是空转
    //   （stop() 同步置 idle → 订阅先于 stop 注册 → 定时器当场被 clear，fire 的条件
    //   `isRunning && abortSignal === stoppedSignal` 永不成立），而新模型按用户意图
    //   **同步注销记录**，没有可判「还没解旋」的事实面。留着它只会在正常停止时误报
    //   「已强制中止（超时）」。停止的可见性改由运行账承担（记录没了 = UI 立刻 idle，
    //   这正是用户按下停止时应得的答复）；未被 stop 覆盖的挂起（工具不认 abort）属
    //   landmine L3 的通用缺口，单独立项，不在此处伪造兜底。
    const stoppedIds = stopped.stopAll();
    log.info('chat', `用户停止：本卷 ${stoppedIds.length} 条运行已中止`, { runs: stoppedIds.join(',') });
    this.agent?.cascadeAbort();
  }

  // ═══════════════════════════════════════════════════════
  // ── 数据驱动的消息模型 — 委托给 chat-stream.ts ──
  // ═══════════════════════════════════════════════════════

  private renderEvent(ev: AgentEvent): void {
    Stream.renderEvent(this._streamCtxFor(null), ev);
  }

  // ── 文件附件 ──

  /** 附件拾遗（C10 修缮，2026-08-22）：真机走 Tauri dialog 拿真路径。
   * 旧实现两病灶：①浏览器回退用 f.name 冒充 path（空头支票——agent
   * 拿假路径 read_file 必报错）；②size 恒 0 写死，来文渲染「0 B」误导。
   * 修法：回退分支只往 input-store 存能兑现的（路径拿不到就不入附件面，
   * 打日志可见）；size 不再伪造（渲染层不显示，agent 只需路径）。 */
  async openFilePicker(): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({ multiple: true, title: '拾遗——选择要附入案卷的文件', filters: [] });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      // B2（multimodal-image-plan）：夹选经共用底座分流——图片一律入附图道
      // （2026-09-22 起不再按模型声明分流，见 attachIntakePaths）。
      await this.attachIntakePaths(paths);
    } catch (e) {
      // 浏览器 dev（mock）环境：File 无真路径——不再用 name 冒充（旧病灶）。
      // 附件链在真机才有意义；dev 下静默提示不可用，错误可见不炸。
      console.warn('[chat] 附件拾遗仅在真机可用（Tauri dialog 缺席）:', e);
    }
  }

  /* ── 附图采集（multimodal-image-plan B2）——三入口（粘贴/拖放/夹选）汇聚底座。
   *    采集→准入规整（image-intake）→ ChatImageRef 入 input-store 图片草稿槽；
   *    发送接线在 B3。能力门禁（D-8②）由创作坞按当前模型 input 声明传入
   *    allowImages——机制在此、策略在视图。 ── */

  /** 单图入槽闸：每卷计数上限 + 总量上限 + id 去重；超限/重复返回 false。 */
  private admitOneImage(ref: ChatImageRef): boolean {
    const input = getChatStore(this.panelId).input.getState();
    if (input.attachedImages.some((img) => img.id === ref.id)) return false; // 同图去重（静默）
    if (input.attachedImages.length >= MAX_IMAGES_PER_MESSAGE) {
      showToast(`附图已达单卷上限 ${MAX_IMAGES_PER_MESSAGE} 张——先发送或移除部分图片`, 'warn');
      return false;
    }
    const totalBytes = input.attachedImages.reduce((sum, img) => sum + img.bytes, 0) + ref.bytes;
    if (totalBytes > MAX_MESSAGE_IMAGE_BYTES) {
      showToast(`附图总量超过 ${MAX_MESSAGE_IMAGE_BYTES / 1024 / 1024}MiB 上限——请精简`, 'warn');
      return false;
    }
    input.addAttachedImage(ref);
    return true;
  }

  /** 粘贴通道：webview File 字节直入（上限 MAX_IMAGE_BYTES 20MiB）。 */
  async intakeImageFiles(files: readonly File[]): Promise<void> {
    const root = useShellStore.getState().projectPath;
    if (!root || files.length === 0) return;
    for (const file of files) {
      try {
        this.admitOneImage(await admitImageBlob(root, file, file.name));
      } catch (e) {
        showToast(`附图失败：${file.name || '剪贴板图片'}（${e instanceof Error ? e.message : String(e)}）`, 'warn');
      }
    }
  }

  /** 路径通道：拖放/夹选（8MiB read_base64 通道上限在 admit 内生效）。 */
  async intakeImagePaths(paths: readonly string[]): Promise<void> {
    const root = useShellStore.getState().projectPath;
    if (!root || paths.length === 0) return;
    for (const p of paths) {
      try {
        this.admitOneImage(await admitImageFromPath(root, p));
      } catch (e) {
        showToast(`附图失败：${p}（${e instanceof Error ? e.message : String(e)}）`, 'warn');
      }
    }
  }

  /** 夹/引/拖放共用底座（v3 B2；2026-09-22 拆 allowImages 参数）：图片扩展名
   *  **一律**入附图道，其余与非图片一并走路径附件老路。
   *  ⚡ 为什么拆掉能力参数：它曾是这里的硬闸门，而 `inputModalities` 四层声明链
   *  末位是缺省 `['text']`——声明缺失/过时（本机 opencode/deepseek-flash 即如此）
   *  时，用户拖进来的图被静默改成「路径附件」，看着就是**拖放失灵**（本次事故的
   *  触发路径：用户拖图没反应，只能手打路径让 Agent 自己读）。发送面 2026-09-19
   *  已改「先发、被拒再降级」，分流不该再问声明。 */
  async attachIntakePaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const { images, files } = splitIntakePaths(paths, true);
    const input = getChatStore(this.panelId).input.getState();
    for (const p of files) {
      if (!input.attachedFiles.some((f) => f.path === p)) {
        input.addAttachedFile({ path: p, name: p.split(/[\\/]/).pop() || p, size: 0 });
      }
    }
    if (images.length > 0) await this.intakeImagePaths(images);
  }

  // 视图拖放转发（T2 WebView 默认接管 dragDrop，网页层收不到 HTML5 drop 事件——
  // 旧 handleFileDrop no-op 已随原生通道落地**删除**：2026-09-22 起走
  // shell/rows/drag-drop.ts 的 Tauri onDragDropEvent → attachIntakePaths。）

  removeAttachedFile(idx: number): void {
    getChatStore(this.panelId).input.getState().removeAttachedFile(idx);
  }

  // ── 辅助函数 ──

  private appendUserBubble(
    text: string,
    files?: { path: string; name: string; size: number }[],
    _skipActions?: boolean,
    images?: ChatImageRef[],
  ): UserMessage {
    return Stream.appendUserBubble(this._streamCtxFor(null), text, files, _skipActions, images);
  }

  // ── 消息操作回调（视图 ChatMessages 委托）──

  copyText(text: string): void {
    navigator.clipboard.writeText(text).catch((e) => console.warn('[chat-core] 复制到剪贴板失败:', e));
  }
  /** 「改」：抄文本回输入框 + 撤旧轮（含其回复），用户改完手动发送——不预发送。
   *  撤回以 msg._id 经沙盒映射 ID 直达；定位失败 = 轮已不可撤（会话已压缩），
   *  输入框与现场原样不动（绝不半撤制造叠尸）。 */
  editUserMessage(msg: UserMessage): void {
    if (this._activeExec().isRunning) {
      showToast('Agent 正在运行，请先停止再编辑', 'warn');
      return;
    }
    if (!Session.retractUserMessage(this._sessionCtx(), msg)) {
      showToast('该轮已不可改（会话已压缩）', 'warn');
      return;
    }
    getChatStore(this.panelId).input.getState().setInputText(msg.text);
    this._composer?.focus();
    this._composer?.selectEnd();
  }
  /** 「重发」：撤旧轮（含其回复）+ 原文本立即新发。 */
  resendUserMessage(msg: UserMessage): void {
    if (this._activeExec().isRunning) {
      showToast('Agent 正在运行，请先停止再重发', 'warn');
      return;
    }
    if (!Session.retractUserMessage(this._sessionCtx(), msg)) {
      showToast('该轮已不可重发（会话已压缩）', 'warn');
      return;
    }
    getChatStore(this.panelId).input.getState().setInputText(msg.text);
    this.sendMessage();
  }

  // ── 会话命令面（斜杠命令真源；消费面 = app/commands/command-catalog）──
  //
  // 内建命令由本卷实例提供（handler 绑 this、作用于本卷）——不再往模块级全局
  // 表里就地写 handler（旧 `_wireCommandHandlers` 的多面板串扰形状，2026-09-19
  // command-surface-rework 拆除）。退役条目随图分析面（/trail · /fragile ·
  // /cycle · /impact · /path）一并删除——面板不再陈列点不动的命令。

  builtinCommands(): CommandContribution[] {
    // 清单是数据（app/commands/builtin-commands）——这里只把本面板的能力位注入进去。
    return builtinCommands({
      newVolume: () => void this.createNewSession(),
      compact: () => void this.compactSession(),
      exportVolume: () => void this.exportSession(),
      goal: (arg) => void this.goalCommand(arg),
      remember: (arg) => this.rememberFact(arg),
    });
  }

  /** /compact — 压缩会重写会话，与运行中的轮次竞争会损坏数据（守卫在方法内）。 */
  private async compactSession(): Promise<void> {
    if (!this.agent) return;
    if (this._activeExec().isRunning) {
      showToast('Agent 正在运行，请先停止或等待完成后再压缩。', 'warn');
      return;
    }
    this.appendUserBubble('/compact');
    const exec = this._activeExec();
    // 压缩 = 本卷的一条运行（kind='compact'）：在账上可见（呼吸线/停钮/退出守卫都不瞎），
    // 收尾按记录身份注销。旧实现 start() 铸的 controller 会被后来的轮次换掉，
    // 而 done() 不带令牌就无条件清账（压缩在途开新轮 = 新轮运行态被清）。
    const run = exec.beginRun('compact');
    void this.agent
      .compactNow(run.signal)
      .then(() => {
        this.messages = [];
        resetMsgIdCounter(this.panelId);
        // 压缩只发生在活跃卷（上方 isRunning 守卫 = 本卷）——清本卷流式槽
        const compactSid = this.activeSessionId;
        if (compactSid != null) msgStoreFor(this.panelId, compactSid).getState().setStreamingAssistantId(null);
        getChatStore(this.panelId).msg.getState().setStreamingAssistantId(null);
        Session._rebuildMessagesFromSession(this._sessionCtx());
        this._chatMessages?.bump();
      })
      .catch((err: Error) => {
        // 压缩失败：旧内容未动、无对话断层——toast 播报即可（错误不静默）
        showToast(`压缩失败: ${err.message}`, 'error');
      })
      .finally(() => {
        run.end(); // 只注销压缩自己那条记录（在途新轮不受影响）
      });
  }

  /** /remember <事实> —— 无参 = 提示用法并填好前缀（用户接着打字）；有参 = 授权保存 + 交模型写库。 */
  private rememberFact(arg: string): void {
    const fact = arg.trim();
    if (!fact) {
      getChatStore(this.panelId).input.getState().setInputText('/remember ');
      this._composer?.focus();
      this._composer?.selectEnd();
      showToast('用法: /remember 要记住的内容', 'info');
      return;
    }
    // 批 9h-4：事实保存授权旗标住内核（记忆实现已随 memory-domain 包）——门面同步导入
    authorizeFactSave();
    void this.sendAgentText(
      `请将以下事实保存到记忆库：${fact}\n\n使用 memory 工具 action="save"，type 取 user/feedback/project/reference 之一；起一个简短的 kebab-case 名称，写清楚 description。`,
      `/remember ${fact}`,
    );
  }

  /** `/goal` 命令面整件在 GoalDriver（app/chat/goal-driver.ts）——本类是它注入的宿主。 */
  private goalCommand(arg: string): Promise<void> {
    return this._goal.goalCommand(arg);
  }

  /** 带参命令的「待编辑」形态（2026-11-07）：只把 `/cmd ` 填进输入框并聚焦，
   *  **不执行**。斜杠面板/命令面板点选 `takesArg` 条目时走这里——避免「点一下就以
   *  空参跑掉」（旧形态对 /goal 是弹状态、对 /remember 是补前缀，两种语义各写各的
   *  handler，插件命令则直接空参执行）。回车执行路不变：用户补完参数再回车。 */
  prepareCommand(cmd: CommandContribution): void {
    const text = `${cmd.slash ?? cmd.kbd ?? ''} `;
    if (!text.trim()) return; // 既无斜杠词也无键位提示——填什么都是空的，交回调用方
    getChatStore(this.panelId).input.getState().setInputText(text);
    const composer = this._composer;
    if (!composer) return;
    composer.focus();
    // 光标落尾要等 DOM 值跟上（同一 tick 里 el.value 还是旧值，selectEnd 会把光标
    // 落在 0 号位——用户接着打字就打到命令词前面去了）
    requestAnimationFrame(() => composer.selectEnd());
  }

  /** 执行命令 —— 斜杠面板 / 命令面板 / 文本解析三入口的唯一执行面（四型全语义）。
   *  arg = 斜杠参数（`/goal resume` → 'resume'；无参空串），fill 型拼在提示文本后。 */
  executeCommand(cmd: CommandContribution, arg = ''): void {
    const action = cmd.action;
    switch (action.type) {
      case 'send':
        getChatStore(this.panelId).input.getState().setInputText('');
        void this.sendAgentText(action.text, action.displayLabel);
        break;
      case 'fill':
        getChatStore(this.panelId)
          .input.getState()
          .setInputText(action.text + arg);
        this._composer?.focus();
        this._composer?.selectEnd();
        break;
      case 'local':
        getChatStore(this.panelId).input.getState().setInputText('');
        action.handler(arg);
        break;
      case 'skill':
        getChatStore(this.panelId).input.getState().setInputText('');
        void this.sendAgentText(`Execute skill: ${action.skillName}`, `/${action.skillName}`);
        break;
    }
  }

  // ── Pill 徽章 → panel-store.pillEventCount ──

  private _bumpPillBadge(): void {
    if (getChatStore(this.panelId).panel.getState().panelMode !== 'pill') return;
    getChatStore(this.panelId).panel.getState().bumpPillEventCount();
  }
  private _resetPillBadge(): void {
    getChatStore(this.panelId).panel.getState().setPillEventCount(0);
  }

  // ── Sink getter（兼容旧契约）──

  get sink() {
    return (ev: AgentEvent) => this.renderEvent(ev);
  }
}

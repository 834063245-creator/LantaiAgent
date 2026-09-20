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
import type { ChatAgentHandle, GoalRunResult } from '../../agent/chat-agent-handle';
import { createExecState, type ExecStateInstance, type RunKind } from '../../agent/execution-state';
import { GoalManager, type GoalRecord } from '../../agent/goal-manager';
import { log } from '../../agent/logger';
import { isRunDeadlineExceeded } from '../../agent/run-watchdog';
import type { RuntimePort } from '../../agent/runtime/types';
import { totalTokens } from '../../agent/token-meter/usage';
import { useShellStore } from '../../app/shell-store';
import type { CommandContribution } from '../../composition/services';
import { sessionExecute } from '../../composition/session-persistence-service';
import { activeSpace } from '../../composition/space-service';
import { pickDropAnchor } from '../../paper/space';
import type { ChatImageRef } from '../../provider/types';
import { apiErrorSummary } from '../../provider/types';
import { askSessionOf, useAskStore } from '../../state/ask-store';
import { useBgAlertStore } from '../../state/bg-alert-store';
import { getCanvasStore, loadCanvasFromDisk, saveCanvasToDisk } from '../../state/canvas-store';
import { useDockStore } from '../../state/dock-store';
import { broadcastGoalRecord, useGoalStore } from '../../state/goal-store';
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
import { getWorkspaceEpoch, isCurrentEpoch } from '../../workspace-scope';
import { listCommands, parseSlashInput } from '../commands/command-catalog';
import { ensureSkillCatalog } from '../commands/skill-catalog';
import {
  admitImageBlob,
  admitImageFromPath,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_IMAGE_BYTES,
  splitIntakePaths,
} from './image-intake';
import type { PromptShelfHandle } from './PromptShelf';
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

export class ChatCore {
  /** 面板唯一实例 ID。自动生成，用于 store 隔离。 */
  readonly panelId: string;

  /** 执行状态 — 面板级实例。 */
  private _exec: ExecStateInstance;
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

  // ── chat-session ctx 的 DOM 桩：分离元素，吸收写入，永不挂载 ──
  private _stubPanel: HTMLElement = document.createElement('div');
  private _stubSessionTabs: HTMLElement = document.createElement('div');
  private _stubTabBar: HTMLElement = document.createElement('div');

  // ── exec 状态广播（视图订阅 stop 按钮/运行态）──
  private _execListeners = new Set<() => void>();

  /** 每卷最新轮次代数（sid → gen）——轮次收尾的身份守卫。
   *  停止后用户立刻发新消息的窗口里，旧轮 finally（abort 传播到挂起工具后
   *  迟到落地）不得终结新轮刚建立的流式助手（finishTurn 会清
   *  streamingAssistantId 并把新轮助手标 done——「停止后新输入无响应/劈开」
   *  的次因）。gen 不匹配 = 该卷已有更新轮次，收尾让位给新轮自己的
   *  TurnStarted/finally。无会话（null sid）共用 -1 槽。 */
  private _turnGenBySid = new Map<number, number>();

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

    // 斜杠技能候选：同步确保当前工作区的清单（键变了则后台重扫；
    // 命令清单是同步读取面，见 app/commands/skill-catalog）
    ensureSkillCatalog(useShellStore.getState().projectPath);

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
    // ── Goal strip：状态迁移驱动显隐；切换工作区后重载 ──
    // P1 总线归零：goal:state → state/goal-store（GoalManager 回调直写，此处订阅）
    _globalStoreUnsubs.push(
      useGoalStore.subscribe((s, prev) => {
        if (s.tick !== prev.tick && s.record !== null) this._updateGoalRecord(s.record);
      }),
    );
    // P1 总线归零：workspace:switched → state/workspace-switch-store
    //（跨工作区触发：_refreshGoalRecord 在途结果按 INVARIANTS #12 epoch 守卫）
    _globalStoreUnsubs.push(
      useWorkspaceSwitchStore.subscribe((s, prev) => {
        if (s.switchedTick !== prev.switchedTick) {
          // 工作区切换 = 全上下文重置：在途提问/权限卡全部按取消收口
          //（卡片 callback 指向旧工作区已 dispose 的 Agent——按卷杀卡够不到
          // 他卷残留，漂到新工作区只能是死回答回调；2026-09-10 ask 完备化）
          this._promptShelf?.dismiss();
          void this._refreshGoalRecord();
        }
      }),
    );
    this._refreshGoalRecord();

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
    return exec.enqueuePerm(() =>
      shelf.showPermission({
        type: 'permission',
        id: `perm-${toolName}-${Date.now()}`,
        ownerSid: sid,
        badge: ownerSid != null ? this._sessionLabelOf(ownerSid) : null,
        toolName,
        reason,
        subject: subject || '',
        danger,
      }),
    );
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
      panel: this._stubPanel,
      sessionTabs: this._stubSessionTabs,
      tabBar: this._stubTabBar,
      getProjectPath: () => useShellStore.getState().projectPath,
      flushReasoning: () => {},
      flushText: () => {},
      clearPendingToolCards: () => {},
      getRunning: () => this._activeExec().isRunning,
      abort: () => this.abort(),
      updateFooter: () => this.updateFooter(),
      getTotalTokensUsed: () => getChatStore(storeId).panel.getState().totalTokensUsed,
      setTotalTokensUsed: (n) => {
        getChatStore(storeId).panel.getState().setTotalTokensUsed(n);
      },
      clearToolUsage: () => {
        getChatStore(storeId).panel.getState().clearToolUsage();
      },
      clearToolHistory: () => {
        getChatStore(storeId).panel.getState().clearToolHistory();
      },
      getLastUsageText: () => getChatStore(storeId).panel.getState().lastUsageText,
      setLastUsageText: (s) => {
        getChatStore(storeId).panel.getState().setLastUsageText(s);
      },
      getLastAgentDiag: () => getChatStore(storeId).panel.getState().lastAgentDiag,
      clearInputHistory: () => {
        const s = getChatStore(storeId).input.getState();
        s.setInputHistory([]);
        s.setInputHistoryIdx(-1);
        s.setDraftText('');
      },
      getRuntime: () => useAgentPanelStore.getState().runtimeRef as RuntimePort | null,
    };
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
      updateFooter: () => this.updateFooter(),
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

  switchSession(idx: number): void {
    Session.switchSession(this._sessionCtx(), idx);
  }
  closeSession(idx: number): void {
    Session.closeSession(this._sessionCtx(), idx);
  }
  async createNewSession(): Promise<void> {
    // S6 P4：模块入口返回新卷 id（程序入口判成败用）——本编排面包装器不承载该值
    // （程序入口 = app/chat/session-composition 的模块函数，UI 之外的调用者直接调它）。
    await Session.createNewSession(this._sessionCtx());
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
   *  先写、装载即用落点位）。缺省 = 既有点击入口，落位由落位 effect 补（行为零变化）。 */
  async branchFromMessage(
    msg: ChatMessage,
    sessionId: number,
    drop?: { x: number; y: number },
  ): Promise<number | null> {
    const point = Branch.resolveBranchPoint(this.panelId, sessionId, msg);
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

  /** **一卷内全部节点的可立枝判据**（一次性派生）——「立枝」按钮置灰 + 具名原因的
   *  渲染期读面（`use-block-ops` 每卷问一次，不逐块问；见 `Branch.deriveBranchPoints`）。
   *  判据与点击时的 `branchFromMessage` 同源：置灰是提示，点击仍由后者兜底。 */
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

  /** Stage-5：进工作区恢复画布——读工作区画布状态文件 → 摊开集合落回画布
   *  （拍板 11：展开 = 永远展开，重启恢复；Q-B 在画布语义下不再适用）。
   *  自愈（2026-08-28 会话管理专项）：画布摊开集可能引用磁盘上不存在的卷——
   *  空卷不落盘（saveActiveSession 只存非空卷）/ 卷文件被删 / 早期切换残留，
   *  直接恢复会每次启动弹「案卷文件读取失败」+ 画布残留幽灵流区。恢复前先探
   *  真实卷集（在开卷 + 磁盘已落盘卷），剪掉悬空摊开项并回写清理后的画布。
   *  剪枝只在目录列表**成功**时进行（列表失败 = 保守不剪，避免误删真实卷）。 */
  async restoreCanvasSpread(workspace: string): Promise<void> {
    await loadCanvasFromDisk(this.panelId, workspace);
    const st = getChatStore(this.panelId).sess.getState();
    const openIds = new Set(st.sessions.map((s) => s.id));

    // 磁盘已落盘卷集（目录缺席/列表失败 = 不剪枝，保守）。
    // P1-1（2026-09-02）：剪枝改为「文件名级 + 读结果级」双面——不再调
    // listSavedSessions（全量读 T 个卷文件）。文件名在目录里 = 存在；读阶段
    // readVolumeData null = 墓碑/空卷/坏 JSON（从摊开集剪掉，不弹失败 toast）。
    // seam（C 定案）：目录枚举换 list_volumes（provider 滤目录——文件名数组，
    // 目录缺席/读失败 = 不剪枝的保守语义保留）。
    // root 拼接收敛：workspaceSessionsDir（chat-session 唯一权威——消费方复用）
    const sessionsDir = Session.workspaceSessionsDir(workspace);
    let volumeNames: string[] | null = null;
    try {
      const raw = await sessionExecute('list_volumes', { root: sessionsDir });
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) volumeNames = parsed.filter((n): n is string => typeof n === 'string');
    } catch {
      /* 目录缺席/列表失败 = 不剪枝 */
    }

    // P0-3 两阶段恢复 + P1-1 去冗余（2026-09-02）：
    //   读阶段——并行读全部摊开卷 + 钉源卷（readVolumeData 互相独立），
    //   替代旧「先 listSavedSessions 全量读 T 卷、再恢复循环串行读 spread 卷」
    //   的双倍 I/O。读结果 null = 墓碑/空卷/缺失（读阶段即发现，不弹 toast）。
    //   应用阶段——串行 setState/消息重建（并行会触发全局 msgId 计数器重置
    //   竞态与 sessions append 覆盖）。
    const canvasState0 = getCanvasStore(this.panelId).getState();
    const readTargets = new Set<number>();
    for (const sid of Object.keys(canvasState0.spread)) {
      const n = Number(sid);
      if (!openIds.has(n)) readTargets.add(n);
    }
    // 钉源卷不在摊开集也要读（孤儿钉「收回/删除」按钮判定需要知道源是否已删）
    for (const pin of Object.values(canvasState0.pins)) {
      if (pin.source && !openIds.has(pin.source.sessionId)) readTargets.add(pin.source.sessionId);
    }
    const readResults = await Promise.all(
      [...readTargets].map((sid) =>
        Session.readVolumeData(workspace, sid)
          .then((data) => ({ sid, data }))
          .catch((e) => {
            console.error('[canvas] 恢复摊开卷预读失败', sid, e);
            return { sid, data: null as null };
          }),
      ),
    );
    const readBySid = new Map<number, import('../../ui/chat-session').StoredSession | null>();
    for (const { sid, data } of readResults) readBySid.set(sid, data);

    if (volumeNames) {
      // 文件名级存在性（剪枝面 1）：摊开/钉源卷的**事件日志**（`.ndjson`——Phase 3b
      // 起卷本体）不在目录里 = 幽灵。`.json` 只是投影缓存，不参与存在性判定。
      // #1 修复的保守语义保留：目录列表失败 = 不剪枝（避免误删真实卷）。
      const fileIds = new Set<number>();
      for (const name of volumeNames) {
        if (!name.endsWith('.ndjson') || name.startsWith('_')) continue;
        const n = parseInt(name.replace('.ndjson', ''), 10);
        if (!Number.isNaN(n)) fileIds.add(n);
      }
      // 读结果级有效性（剪枝面 2）：文件在但 readVolumeData null = 空卷/坏日志——
      // 从摊开集剪掉（替代旧 listSavedSessions 的墓碑过滤，不再弹读取失败 toast）
      const phantom = Object.keys(canvasState0.spread).filter((sid) => {
        const n = Number(sid);
        if (openIds.has(n)) return false; // 已在案头 = 有效
        return !fileIds.has(n) || readBySid.get(n) === null;
      });
      if (phantom.length > 0) {
        for (const sid of phantom) getCanvasStore(this.panelId).getState().removeRegion(sid);
        // 活跃会话指向若落在被剪的幽灵卷 → 一并清掉（不残留失效指向）
        const curActive = getCanvasStore(this.panelId).getState().activeSessionId;
        if (curActive != null && phantom.includes(curActive)) {
          getCanvasStore(this.panelId).getState().setActiveRegion(null);
        }
        // 回写清理后的画布（幂等——下次启动已无悬空项，不再重复剪）
        void saveCanvasToDisk(this.panelId, workspace).catch((e) =>
          console.warn('[chat-core] 画布回写失败（幽灵卷清理未落盘，下次启动重试）:', e),
        );
      }
      // 已删源会话播种（2026-08-28 会话管理专项）：钉的源卷既不在开卷、也
      // 读不出有效数据（墓碑/空卷/文件没了）——「收回」语义失效，孤儿钉
      // 按钮应显示「删除」。deleteSessionFile 运行时另做增量标记。
      const dead = new Set<number>();
      for (const pin of Object.values(getCanvasStore(this.panelId).getState().pins)) {
        const src = pin.source?.sessionId;
        if (src == null || openIds.has(src)) continue;
        const read = readBySid.get(src);
        if (read === null || !fileIds.has(src)) dead.add(src);
      }
      if (dead.size > 0) getCanvasStore(this.panelId).getState().replaceDeletedSessionIds(dead);
    }

    // 应用阶段（P3-1，2026-09-02）：批量铺开——一次 setState 摊全部卷（读数据
    // 已在 readBySid，不再触盘），随后逐卷填内容层（会话级 store 不触 sess 订阅）。
    // 替代旧「逐卷 loadSessionFromDisk = N 次 setState append」——sess 订阅
    // （PaperPanel sessions 同步 + 消息订阅 effect）从 N 次降为 1 次。
    // 活跃卷句柄：末尾 switchSession 的惰性补建承担（批量应用不造 Agent）。
    const batchItems: Array<{ sid: number; data: import('../../ui/chat-session').StoredSession }> = [];
    for (const sid of readTargets) {
      // 钉源补充读的卷可能不在摊开集（只供孤儿钉判定用）——不摊开
      if (!Object.hasOwn(canvasState0.spread, String(sid))) continue;
      // 墓碑/空卷/缺失（read null）——剪枝阶段已从摊开集移除，不进批量
      const data = readBySid.get(sid);
      if (data != null) batchItems.push({ sid, data });
    }
    const restoreFailed = await Session.batchRestoreSessions(this._sessionCtx(), batchItems);
    // D5（拍板 C）：恢复失败可见——StatusLine 警告档 + 一次性提示条
    if (restoreFailed > 0) {
      useBgAlertStore.getState().pushBgAlert('restore-open', `有 ${restoreFailed} 卷恢复失败——可在左侧栏手动展开`);
    } else {
      useBgAlertStore.getState().clearBgAlert('restore-open');
    }
    // #6 修复：恢复活跃会话指向——重新取 state（上方剪枝已产生新 state，
    // 旧 canvas 快照的 activeSessionId 可能已过期）
    const freshActive = getCanvasStore(this.panelId).getState().activeSessionId;
    const activeSid = freshActive ? Number(freshActive) : null;
    if (activeSid != null) {
      const st2 = getChatStore(this.panelId).sess.getState();
      const idx = st2.sessions.findIndex((s) => s.id === activeSid);
      if (idx >= 0 && idx !== st2.activeIdx) this.switchSession(idx);
    }

    // ── 枝线卷的后台句柄水合（2026-09-19，真机报的「重启后引线消失」）──
    // 批量恢复刻意不造句柄（P3-1），只有活跃卷由上面那次 switchSession 惰性补建；
    // 而枝边的画布承接要求**父子卷都有句柄**（血缘在子卷头行、父卷那个节点要走父卷的
    // 投影与定位桥）⇒ 非活跃的枝卷/父卷重启后一条线都画不出来。
    // 只为**参与枝边的摊开卷**补建（子卷 + 其父卷，且都在摊开集内）：数量 = 树上的卷
    // （摊开集按设计只放活跃路径），不是全摊开集。串行补建避免启动期 I/O 突发；
    // 失败可见（console + warn），不挡冷启动。
    const spread = getCanvasStore(this.panelId).getState().spread;
    const edgeSids: number[] = [];
    for (const s of getChatStore(this.panelId).sess.getState().sessions) {
      if (!Object.hasOwn(spread, String(s.id))) continue;
      const parentId = readBySid.get(s.id)?.parentId;
      if (parentId == null) continue;
      if (!edgeSids.includes(s.id)) edgeSids.push(s.id);
      if (Object.hasOwn(spread, String(parentId)) && !edgeSids.includes(parentId)) edgeSids.push(parentId);
    }
    if (edgeSids.length > 0) {
      void (async () => {
        for (const sid of edgeSids) {
          if (agentSessionState.getAgent(this.panelId, sid)) continue;
          try {
            await Session.ensureVolumeAgent(this._sessionCtx(), sid);
          } catch (e) {
            console.error('[chat-core] 枝线卷句柄水合失败', sid, e);
            log.warn('chat', `案卷 ${sid} 的 Agent 未就绪（枝边引线待其就绪后出现）`, { error: String(e) });
          }
        }
      })();
    }
  }

  /** Stage-5：显式保存点落盘工作区画布状态（切换/关闭窗口时调用）。 */
  async saveCanvasState(workspace: string): Promise<void> {
    await saveCanvasToDisk(this.panelId, workspace);
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
      userText: displayLabel,
      bubbleLabel: displayLabel,
      drive: (signal) => agent.run(signal, text),
    });
  }

  /** 恢复先前暂停的目标。 */
  async runGoalResume(): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    await this._runAgentTurn({
      userText: '/goal resume',
      bubbleLabel: '🔄 恢复目标',
      runKind: 'goal',
      drive: (signal) => agent.resumeGoal(signal),
      onResult: (r) => this._notifyGoalResult(r),
    });
  }

  private async runGoal(goal: string): Promise<void> {
    const agent = this.agent;
    if (!agent) return;
    await this._runAgentTurn({
      userText: `/goal ${goal}`,
      bubbleLabel: `🎯 ${goal}`,
      runKind: 'goal',
      drive: (signal) => agent.runGoal(signal, goal),
      onResult: (r) => this._notifyGoalResult(r),
    });
  }

  /** /goal status — 显示活体目标 + 最近历史。 */
  private async showGoalStatus(): Promise<void> {
    const path = useShellStore.getState().projectPath;
    if (!path) return;
    const mgr = new GoalManager(path, broadcastGoalRecord);
    const active = await mgr.getActive();
    const history = (await mgr.list()).filter(
      (r) => r.status !== 'active' && r.status !== 'paused' && r.status !== 'blocked',
    );
    if (!active && history.length === 0) {
      showToast('当前没有目标。用法: /goal 目标描述 — Agent 会自主循环直到完成', 'info');
      return;
    }
    // /goal status 是查询命令——结果以单条多行 toast 呈现（读完即走，不入流）
    const lines: string[] = [];
    if (active) {
      const label = active.status === 'paused' ? '已暂停' : active.status === 'blocked' ? '已受阻' : '进行中';
      const hint = active.status === 'paused' || active.status === 'blocked' ? ' — /goal resume 继续' : '';
      lines.push(`🎯 ${active.text.slice(0, 60)} · ${label} · 第 ${active.iteration + 1} 轮${hint}`);
    }
    for (const r of history.slice(-3).reverse()) {
      const icon =
        r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'blocked' ? '🚧' : '🚫';
      lines.push(`${icon} ${r.text.slice(0, 50)} — ${(r.summary || r.status).slice(0, 60)}`);
    }
    if (lines.length > 0) showToast(lines.join('\n'), 'info', TOAST_LONG_HOLD_MS);
  }

  /** /goal cancel — 取消活体目标(运行中需先停止)。 */
  async cancelGoal(): Promise<void> {
    const path = useShellStore.getState().projectPath;
    if (!path) return;
    if (this._activeExec().isRunning) {
      showToast('目标运行中 — 请先点击停止(或状态条上的暂停),再 /goal cancel', 'warn');
      return;
    }
    const mgr = new GoalManager(path, broadcastGoalRecord);
    const active = await mgr.getActive();
    if (!active) {
      showToast('没有可取消的目标', 'info');
      return;
    }
    await mgr.cancel(active.id);
    showToast(`🚫 已取消目标: ${active.text.slice(0, 50)}`, 'info');
  }

  /** Agent 轮次的共享脚手架。 */
  private async _runAgentTurn(opts: {
    userText?: string;
    bubbleLabel?: string;
    /** 运行种类（运行账的记录标签：诊断 + 读面策略）——目标循环传 'goal'。 */
    runKind?: RunKind;
    drive: (signal: AbortSignal) => Promise<unknown>;
    onResult?: (result: GoalRunResult) => void;
  }): Promise<void> {
    // 并发会话（2026-08-26）：闸门拆除——后台卷运行不再阻止本卷新轮次；
    // 仅本卷自身在跑时拒发（Enter 插话路径由 sendMessage 处理）。
    if (!this.agent || this._activeExec().isRunning) return;
    const exec = this._activeExec();
    // 起一条运行记录（谁起谁收）：signal 由账铸；收尾 `run.end()` 只注销自己这条
    //（v43 起「清掉别人的运行」在类型上不可能——旧实现的 done(signal) 守卫是约定）。
    const run = exec.beginRun(opts.runKind ?? 'turn');
    const signal = run.signal;
    // L2（session-ledger）：本轮跑的是哪卷——头部捕获，finally 随 turn-done
    // 信号发出（后台卷跑完存它自己，不再只存当前翻开的卷）。
    let turnSid: number | null = null;
    {
      const sessStore = getChatStore(this.panelId).sess.getState();
      turnSid = sessStore.sessions[sessStore.activeIdx]?.id ?? null;
    }
    // 轮次代数 bump —— 本轮成为该卷最新轮次（finally 收尾身份守卫，见下）
    const turnGen = (this._turnGenBySid.get(turnSid ?? -1) ?? 0) + 1;
    this._turnGenBySid.set(turnSid ?? -1, turnGen);

    // 为新轮次重置自动滚动（视图级状态——只在本轮卷即活跃卷时才有意义；
    // _runAgentTurn 恒由活跃卷发起，turnSid == 活跃卷）
    getChatStore(this.panelId).msg.getState().setUserScrolledUp(false);

    // 先铸气泡拿 _id——轮次簿册以它作权威身份（撤回/重发 ID 直达）
    const bubble = opts.bubbleLabel ? this.appendUserBubble(opts.bubbleLabel) : null;
    if (opts.userText) {
      Session.getTurnPairs(this.panelId, turnSid).push({
        userText: opts.userText,
        uiMsgId: bubble?._id,
        userBubble: null,
        assistantBubble: null,
      });
    }

    // 3.6: 在 Agent 上设置 UI 会话 ID，使子 Agent 通知能正确路由到对应会话
    //（并发会话：轮次路由身份已由工厂绑定的 eventSinkFor 携带；这里只管
    // 子 Agent 通知路由的 agent._uiSessionId）
    if (turnSid != null) {
      this.agent.setUiSessionId(turnSid);
    }

    try {
      const result = await opts.drive(signal);
      if (result) opts.onResult?.(result as GoalRunResult);
    } catch (err: unknown) {
      // 2026-08-31 贴黄拆迁：回合错误改记入回合自身（墓碑），不再播黄纸条
      const msg = err instanceof Error ? err.message : String(err);
      // 用户停止的判据是**事实**（2026-09-14 拆文本猜测）：本轮 signal 是否被中止。
      // 旧实现用 `!msg.includes('aborted')` 判「用户按了停止」——于是传输出自己断掉的
      // 失败（BodyStreamBuffer was aborted）被当作用户意图静默吞掉：案卷里留下一条
      // 悬空来文，用户只看见「模型不响应」。
      if (msg.includes('paused after')) {
        Stream.markTurnError(this._streamCtxFor(turnSid), msg, 'warn');
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
      } else if (!signal.aborted) {
        const code = apiErrorSummary(err);
        Stream.markTurnError(this._streamCtxFor(turnSid), `错误: ${msg}${code ? `\n（${code}）` : ''}`, 'error');
      }
      // 正常中止（用户主动停止）：exec 状态已表达，不另播报
    } finally {
      // 收尾**只注销本轮自己那条运行记录**（v43：按 id 身份，清不掉别人的运行；
      // 旧实现的 done(signal) 要靠调用方记得带令牌）。发起时刻捕获的 run 与结算
      // 时刻的活跃卷无关——切卷不影响本卷账。
      run.end();
      // 轮次代数守卫（2026-09-03「停止后会话坏掉」次因）：本轮仍是该卷最新
      // 轮次时才 finalize——停止后用户立刻发新消息的窗口里，旧轮 finally 迟到
      // 落地会把新轮刚建立的流式助手误终结。让位时新轮自己的
      // TurnStarted/finally 承担终结（语义无缺口）。
      if ((this._turnGenBySid.get(turnSid ?? -1) ?? 0) === turnGen) {
        // 轮次收尾按轮次所属卷路由（后台卷跑完 finalize 自己的流式助手 +
        // 自动命名自己；用户中途切走不影响）
        Stream.finishTurn(this._streamCtxFor(turnSid));
      }
      bumpTurnDone(turnSid ?? undefined);
    }
  }

  private _notifyGoalResult(result: GoalRunResult): void {
    // 2026-08-31 贴黄拆迁：goal 终结播报改 toast（说完即走），goal 状态条
    // 持续显示运行态——终结结果一句话即可，不留进案卷。
    if (result.status === 'completed') {
      showToast(`✅ 目标达成: ${result.summary.slice(0, 120)}`, 'info');
    } else if (result.status === 'paused') {
      showToast(`⏸️ ${result.summary}`, 'info');
    } else if (result.status === 'blocked') {
      showToast(`🚧 目标受阻: ${result.summary.slice(0, 120)}。条件解除后 /goal resume 继续。`, 'warn');
    } else if (result.status === 'failed') {
      showToast(`❌ 目标失败: ${result.summary.slice(0, 120)}`, 'warn');
    } else {
      showToast('目标被中断', 'warn');
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
        .then((answers) => data.callback(answers));
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
      .then(data.callback);
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

  // ── Goal 状态记录 → panel-store.goalRecord（GoalStrip 组件渲染）──

  private _updateGoalRecord(record: GoalRecord): void {
    const p = getChatStore(this.panelId).panel.getState();
    if (record.status === 'active' || record.status === 'paused' || record.status === 'blocked') {
      p.setGoalRecord(record);
    } else if (p.goalRecord?.id === record.id) {
      p.setGoalRecord(null); // 终态 — 收起状态条
    }
  }

  private async _refreshGoalRecord(): Promise<void> {
    const path = useShellStore.getState().projectPath;
    if (!path) return;
    // INVARIANTS #12：跨工作区 fire-and-forget —— 在途 resolve 后校验代际，过期丢弃
    const epoch = getWorkspaceEpoch();
    try {
      const rec = await new GoalManager(path, broadcastGoalRecord).getActive();
      if (!isCurrentEpoch(epoch)) return;
      getChatStore(this.panelId).panel.getState().setGoalRecord(rec);
    } catch (e) {
      // fire-and-forget 路径：goal 状态条读取失败不应当让未处理的 rejection 外泄
      console.error('[chat] _refreshGoalRecord failed:', e);
    }
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

    // 首条来文即命名（未命名卷）：判据与派生都走 state/volume-name 的**同一把尺子**
    // （与轮末 autoTitleSessionIfDefault 同规）。旧实现自带一套——只认「会话 」前缀
    // （术语换代后对新卷恒不命中）、27 字截断（与轮末的 28 字不一致）——是收口前
    // 的第三个命名写者，已拆。
    if (Session.getActiveIdx(this.panelId) >= 0) {
      const session = Session.getSessions(this.panelId)[Session.getActiveIdx(this.panelId)];
      if (session && isUnnamedVolumeLabel(session.label)) {
        const name = deriveVolumeLabel(text);
        if (name) getChatStore(this.panelId).sess.getState().renameSession(session.id, name);
      }
    }

    // 若当前在浮动输入栏中，发送前先唤起完整面板（纸视图打开时除外——纸是输入面）
    if (getChatStore(this.panelId).panel.getState().panelMode === 'input' && !useDockStore.getState().isOpen('paper')) {
      this.summonPanel();
    }

    // 推入输入历史
    getChatStore(this.panelId).input.getState().pushInputHistory(text);
    getChatStore(this.panelId).input.getState().setDraftText('');
    getChatStore(this.panelId).input.getState().setInputText('');

    // 起一条运行记录（谁起谁收；v43 起 signal 由账铸、收尾按记录身份注销）
    const exec = this._activeExec();
    const run = exec.beginRun('turn');
    const signal = run.signal;

    // 用户气泡（原始文本，焦点上下文仅供 Agent 读取）——先铸气泡拿 _id，
    // 轮次簿册以它作权威身份（撤回/重发 ID 直达）
    const files = getChatStore(this.panelId).input.getState().attachedFiles;
    const filesSnapshot = [...files];
    const images = getChatStore(this.panelId).input.getState().attachedImages;
    const imagesSnapshot = [...images];
    const bubble = this.appendUserBubble(text, filesSnapshot, undefined, imagesSnapshot);
    const turnSidPre = this.activeSessionId;
    Session.getTurnPairs(this.panelId, turnSidPre ?? undefined).push({
      userText: text,
      uiMsgId: bubble._id,
      userBubble: null,
      assistantBubble: null,
    });

    // 焦点上下文前缀已随星图/文件查看器焦点链拆除（2026-08-27 死码清扫）——
    // 仅保留附加文件上下文。
    let focusPrefix = '';

    // 附加文件 — 暴露路径以便 Agent 读取（大小不做假：openFilePicker 拿不到真实
    // size，旧实现硬编码 0 导致模型看到「0 B」误判空文件；要真大小需 Rust stat 通道）。
    // 附图（B3）不走文本前缀——引用随 agent.run 结构化传递（multimodal-image-plan D-1）。
    if (files.length > 0) {
      focusPrefix += '用户附加了以下文件：\n';
      for (const f of files) {
        focusPrefix += `- \`${f.path}\`\n`;
      }
      focusPrefix += '你可以用 read_file 读取这些文件。\n\n';
      getChatStore(this.panelId).input.getState().clearAttachedFiles();
    }
    if (imagesSnapshot.length > 0) {
      getChatStore(this.panelId).input.getState().clearAttachedImages();
    }

    // 追踪启动本次运行的会话 — 事件路由身份已由工厂绑定的 eventSinkFor
    // 携带；这里只管子 Agent 通知路由的 agent._uiSessionId。
    const turnSid: number | null = this.activeSessionId;
    // 轮次代数 bump —— 本轮成为该卷最新轮次（finally 收尾身份守卫，见下）
    const turnGen = (this._turnGenBySid.get(turnSid ?? -1) ?? 0) + 1;
    this._turnGenBySid.set(turnSid ?? -1, turnGen);
    if (turnSid != null) {
      this.agent?.setUiSessionId(turnSid);
    }

    // 运行 Agent（附图引用随用户消息入 session——B3；文本前缀只载路径附件）
    try {
      await this.agent.run(signal, focusPrefix + text, imagesSnapshot.length > 0 ? imagesSnapshot : undefined);
    } catch (err: unknown) {
      // 2026-08-31 贴黄拆迁：回合错误写进回合自身（墓碑），不播黄纸条
      const msg = err instanceof Error ? err.message : String(err);
      // 用户停止的判据是**事实**（2026-09-14 拆文本猜测）：本轮 signal 是否被中止
      // （同 _runAgentTurn 的 catch——两处同款病灶同治）。
      if (msg.includes('paused after')) {
        Stream.markTurnError(this._streamCtxFor(turnSid), msg, 'warn');
      } else if (isRunDeadlineExceeded(err)) {
        // 硬截止作废（landmine L3）：墓碑照落——判据是错误类型，不是「signal 是否
        // 中止」（作废的第一步就是 abort，沿用静默分支会把这一轮变成幽灵轮）。
        Stream.markTurnError(
          this._streamCtxFor(turnSid),
          `本轮超硬截止已作废，结果未知，勿当成功继续——${msg}。` +
            '可直接重发上一条消息；若反复出现，检查出网链路或服务商状态。',
          'error',
        );
      } else if (!signal.aborted) {
        const code = apiErrorSummary(err);
        Stream.markTurnError(
          this._streamCtxFor(turnSid),
          `错误: ${msg}。发送任意消息重试，或输入 /compact 压缩上下文，或输入 /new 新建会话${code ? `\n（${code}）` : ''}`,
          'error',
        );
      }
    } finally {
      // 收尾只注销**本轮自己那条**运行记录（v43：按 id 身份；旧实现 done(signal) 靠
      // 调用方记得带令牌）。与结算时刻的活跃卷无关——切卷不影响本卷账。
      run.end();
      // 轮次代数守卫（2026-09-03「停止后会话坏掉」次因）：本轮仍是该卷最新
      // 轮次时才 finalize——停止后用户立刻发新消息的窗口里，旧轮 finally 迟到
      // 落地会把新轮刚建立的流式助手误终结（streamingAssistantId 被清、新轮
      // 响应丢失/劈开）。让位时新轮自己的 TurnStarted/finally 承担终结。
      if ((this._turnGenBySid.get(turnSid ?? -1) ?? 0) === turnGen) {
        // 轮次收尾按轮次所属卷路由（用户中途切卷，后台卷 finalize 自己的流）
        Stream.finishTurn(this._streamCtxFor(turnSid));
      }
    }
    // 通知持久化链（P1 总线归零：chat:turn-done → state/turn-done-store 信号；
    // L2：携带跑完的会话 id——谁跑完存谁）
    bumpTurnDone(turnSid ?? undefined);
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

  // ── Footer — V5 拆除后 ChatFooter 退役；updateFooter 保留为空操作
  // （StreamContext API 契约，chat-stream/chat-session 冻结文件仍调用）

  private updateFooter(): void {
    // no-op: ChatFooter 已退役（V5），槽不再需要注册方
  }

  // ── 文件附件 ──

  /** 附件拾遗（C10 修缮，2026-08-22）：真机走 Tauri dialog 拿真路径。
   * 旧实现两病灶：①浏览器回退用 f.name 冒充 path（空头支票——agent
   * 拿假路径 read_file 必报错）；②size 恒 0 写死，来文渲染「0 B」误导。
   * 修法：回退分支只往 input-store 存能兑现的（路径拿不到就不入附件面，
   * 打日志可见）；size 不再伪造（渲染层不显示，agent 只需路径）。 */
  async openFilePicker(opts?: { images?: boolean }): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({ multiple: true, title: '拾遗——选择要附入案卷的文件', filters: [] });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      // B2（multimodal-image-plan）：夹选经共用底座分流——图片扩展名且当前
      // 模型声明 vision 时入附图道；否则与非图片一并走路径附件老路。
      await this.attachIntakePaths(paths, opts?.images === true);
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

  /** 夹/引/拖放共用底座（v3 B2）：图片扩展名分流——allowImages 时入附图道，
   *  否则与非图片文件一并走路径附件老路（文本模型零回归）。 */
  async attachIntakePaths(paths: readonly string[], allowImages: boolean): Promise<void> {
    if (paths.length === 0) return;
    const { images, files } = splitIntakePaths(paths, allowImages);
    const input = getChatStore(this.panelId).input.getState();
    for (const p of files) {
      if (!input.attachedFiles.some((f) => f.path === p)) {
        input.addAttachedFile({ path: p, name: p.split(/[\\/]/).pop() || p, size: 0 });
      }
    }
    if (images.length > 0) await this.intakeImagePaths(images);
  }

  /** 视图拖放转发 — T2 WebView 默认接管 dragDrop，网页层收不到 HTML5 drop
   * 事件，本方法自旧 Composer 迁来但从未在真机触发；纸壳不接（要做须走
   * Tauri onDragDropEvent 原生通道，另立任务）。保留给潜在消费方。 */
  handleFileDrop(_e: DragEvent): void {
    // no-op（见注释）
  }

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
    return [
      {
        id: 'new',
        label: '重置当前案卷',
        description: '清空对话历史，保留项目上下文',
        group: '案卷',
        slash: '/new',
        action: { type: 'local', handler: () => void this.createNewSession() },
      },
      {
        id: 'compact',
        label: '压缩上下文',
        description: '压缩对话历史以节省 token',
        group: '案卷',
        slash: '/compact',
        action: { type: 'local', handler: () => void this.compactSession() },
      },
      {
        id: 'compact-stats',
        label: '压缩统计',
        description: '查看上下文压缩的运行数据',
        group: '案卷',
        slash: '/compact-stats',
        action: {
          type: 'send',
          text: '查看上下文压缩的运行状态和数据（使用 hologram_compaction_stats 工具）。',
          displayLabel: '/compact-stats',
        },
      },
      {
        id: 'export',
        label: '导出对话',
        description: '导出当前案卷为 Markdown',
        group: '案卷',
        slash: '/export',
        action: { type: 'local', handler: () => void this.exportSession() },
      },
      {
        id: 'goal',
        label: '自主目标',
        description: 'Agent 自主循环直到完成目标 —— /goal · /goal status · /goal resume · /goal cancel',
        group: '案卷',
        slash: '/goal',
        action: { type: 'local', handler: (arg) => void this.goalCommand(arg) },
      },
      {
        id: 'memory',
        label: '查看记忆',
        description: '列出所有已保存的记忆',
        group: '记忆',
        slash: '/memory',
        action: {
          type: 'send',
          text: '列出所有已保存的记忆（使用 memory 工具 action="list"）。',
          displayLabel: '/memory',
        },
      },
      {
        id: 'remember',
        label: '记住一件事',
        description: '保存一条事实到记忆库',
        group: '记忆',
        slash: '/remember',
        action: { type: 'local', handler: (arg) => this.rememberFact(arg) },
      },
    ];
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
    void import('../../agent/memory.js').then((m) => m.authorizeFactSave());
    void this.sendAgentText(
      `请将以下事实保存到记忆库：${fact}\n\n使用 memory 工具 action="save"，type 取 user/feedback/project/reference 之一；起一个简短的 kebab-case 名称，写清楚 description。`,
      `/remember ${fact}`,
    );
  }

  /** /goal 命令面 —— 参数由命令目录解析后传入（status/resume/cancel/目标文本）。 */
  private async goalCommand(arg: string): Promise<void> {
    const a = arg.trim();
    if (a === '' || a === 'status') return this.showGoalStatus();
    if (a === 'resume') return this.runGoalResume();
    if (a === 'cancel') return this.cancelGoal();
    return this.runGoal(a);
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

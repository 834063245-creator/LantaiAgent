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

import type { OwnedAgentHandle } from '../../agent/agent-session-state';
import type { AgentEvent } from '../../agent/agent-types';
import type { ChatAgentHandle, GoalRunResult } from '../../agent/chat-agent-handle';
import { createExecState, type ExecStateInstance } from '../../agent/execution-state';
import { GoalManager, type GoalRecord } from '../../agent/goal-manager';
import { log } from '../../agent/logger';
import type { RuntimePort } from '../../agent/runtime/types';
import { useShellStore } from '../../app/shell-store';
import type { ToolSchema } from '../../provider/types';
import { typedJsonRpc } from '../../rpc-contract';
import type { StarGraph } from '../../scene/graph-types';
import { askSessionOf, useAskStore } from '../../state/ask-store';
import { useBgAlertStore } from '../../state/bg-alert-store';
import { getCanvasStore, loadCanvasFromDisk, saveCanvasToDisk } from '../../state/canvas-store';
import { useDockStore } from '../../state/dock-store';
import { broadcastGoalRecord, useGoalStore } from '../../state/goal-store';
import { bumpTurnDone } from '../../state/turn-done-store';
import { useWorkspaceSwitchStore } from '../../state/workspace-switch-store';
import { showToast, TOAST_LONG_HOLD_MS } from '../../state/toast-store';
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
import { type CommandDef, CommandRegistry, DEFAULT_COMMANDS } from '../../ui/command-registry';
import { type AssistantMessage, type ChatMessage, resetMsgIdCounter, type UserMessage } from '../../ui/message-model';
import { getWorkspaceEpoch, isCurrentEpoch } from '../../workspace-scope';
import type { PromptShelfHandle } from './PromptShelf';

/** 视图注册的输入框命令式接口（聚焦/全选），其余输入状态一律走 input-store */
export interface ComposerApi {
  focus: () => void;
  selectEnd: () => void;
}

/** 视图注册的 @ 自动补全句柄（V5 拆除后无注册方——旧聊天视图退役；
 *  注册槽保留：纸壳未来接块内 @ 引用时复用此契约）。 */
export interface AtAutocompleteHandle {
  /** 每次输入事件调用。textBefore = value.slice(0, cursorPos) */
  update(textBefore: string, cursorPos: number): void;
  /** 更新可用节点名（来自星图/图数据） */
  setNodeNames(names: string[]): void;
  /** 键盘上下导航 — 输入框 keydown 转发 */
  navigate(delta: number): void;
  /** 选中当前高亮项 */
  select(): void;
  /** 弹层是否有可选项（非加载/空态） */
  readonly open: boolean;
}

/** 视图注册的斜杠面板句柄（V5 拆除后无注册方——SlashPanel 退役；
 *  斜杠命令本身仍由 sendMessage 的文本解析面承接，槽保留待纸壳 autocomplete）。 */
export interface SlashPanelHandle {
  show(query?: string): void;
  hide(): void;
  navigate(delta: number): boolean;
  select(): CommandDef | null;
  readonly visible: boolean;
}

/** 消息列表命令式句柄 —— /compact 重建会话后强制重拉（bump = bumpChat(panelId)） */
export interface MessagesApi {
  bump(): void;
}

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

  private starGraph: StarGraph | null = null;

  /** 流式同步 timer — 按卷隔离（并发会话：两卷各自防抖刷新，互不挤掉对方）。 */
  private _syncTimers = new Map<number, ReturnType<typeof setTimeout>>();

  private onOpenSettings: (() => void) | null = null;
  private _onTrailToggle: (() => void) | null = null;

  // ── 视图注册槽（ChatBeacon 挂载后注入组件 ref 句柄）──
  private _composer: ComposerApi | null = null;
  private _promptShelf: PromptShelfHandle | null = null;
  private _slashController: SlashPanelHandle | null = null;
  private _atAutocomplete: AtAutocompleteHandle | null = null;
  private _chatMessages: MessagesApi | null = null;

  // ── chat-session ctx 的 DOM 桩：分离元素，吸收写入，永不挂载 ──
  private _stubPanel: HTMLElement = document.createElement('div');
  private _stubSessionTabs: HTMLElement = document.createElement('div');
  private _stubTabBar: HTMLElement = document.createElement('div');

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
    this.panelId = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this._exec = createExecState();

    CommandRegistry.instance.registerAll(DEFAULT_COMMANDS);
    this._wireCommandHandlers();

    // ── ask_user tool → prompt shelf（视图注册后生效）──
    // P1 总线归零：prompt:ask → state/ask-store（callback-in-store：pending 跨
    // chat-core 重建存活——构造时回放；bus 时代 emit 早于订阅即静默丢失）
    useAskStore.subscribe((s, prev) => {
      if (s.seq !== prev.seq) this._consumePendingAsk();
    });
    this._consumePendingAsk(); // 回放在途 pending（chat-core 重建场景）
    // ── 追踪用户焦点已拆除（2026-08-27 死码清扫）：发射点随星图 V5 拆除 /
    // app-shell 死亡而消失——chat-context-store / scene-signal-store 整链删除，
    // @ 自动补全节点名喂给逻辑一并退役（P2 起 starGraph 恒缺席）。
    // P1 总线归零：agent:diag → agent-panel-store.diag（workspace 直写，此处订阅转写）
    useAgentPanelStore.subscribe((s, prev) => {
      if (s.diag !== prev.diag && s.diag !== null) {
        getChatStore(this.panelId).panel.getState().setLastAgentDiag(s.diag.text);
      }
    });
    // ── Goal strip：状态迁移驱动显隐；切换工作区后重载 ──
    // P1 总线归零：goal:state → state/goal-store（GoalManager 回调直写，此处订阅）
    useGoalStore.subscribe((s, prev) => {
      if (s.tick !== prev.tick && s.record !== null) this._updateGoalRecord(s.record);
    });
    // P1 总线归零：workspace:switched → state/workspace-switch-store
    //（跨工作区触发：_refreshGoalRecord 在途结果按 INVARIANTS #12 epoch 守卫）
    useWorkspaceSwitchStore.subscribe((s, prev) => {
      if (s.switchedTick !== prev.switchedTick) void this._refreshGoalRecord();
    });
    this._refreshGoalRecord();

    // ⚡ ExecutionState → store 同步：订阅活动会话的 execState，会话切换时重绑
    let _execUnsub: (() => void) | null = null;
    const _onExecChange = (exec: ExecStateInstance) => {
      if (exec.isRunning) {
        this._updateStatusBar('thinking', '分析中…');
      } else {
        this._updateStatusBar('idle');
        this._promptShelf?.dismiss(); // ⚡ 停止时关闭 ask/permission 弹层
        this._composer?.focus();
      }
      for (const cb of this._execListeners) cb();
    };
    const _bindExecState = () => {
      if (_execUnsub) {
        _execUnsub();
        _execUnsub = null;
      }
      const exec = this._activeExec();
      _execUnsub = exec.onChange(() => _onExecChange(exec));
      _onExecChange(exec); // 初始同步
    };
    _bindExecState();
    // 用户切换活动会话时重新绑定
    getChatStore(this.panelId).sess.subscribe(() => _bindExecState());

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
  }
  registerSlash(c: SlashPanelHandle): void {
    this._slashController = c;
  }
  registerAt(c: AtAutocompleteHandle): void {
    this._atAutocomplete = c;
    if (this.starGraph) c.setNodeNames(this.starGraph.getNodeNames());
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

  setToolSchemas(schemas: ToolSchema[]): void {
    getChatStore(this.panelId).panel.getState().setToolSchemas(schemas);
  }
  setOnOpenSettings(fn: () => void): void {
    this.onOpenSettings = fn;
  }
  setOnTrailToggle(fn: () => void): void {
    this._onTrailToggle = fn;
  }
  /** 由视图转发 — Footer 的设置按钮 */
  fireOpenSettings(): void {
    this.onOpenSettings?.();
  }
  fireTrailToggle(): void {
    this._onTrailToggle?.();
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
  setStarGraph(g: StarGraph): void {
    this.starGraph = g;
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
    this._hideSlashPanel();
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
   *  旧「挂此刻活跃卷」是活 bug：切到 B 后 A 的写权限卡会被 B 的停止键误杀）。 */
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
    return exec.enqueuePerm(() =>
      shelf.showPermission({
        type: 'permission',
        id: `perm-${toolName}-${Date.now()}`,
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

  /** 对工具名称进行分类，用于可视化分组。 */
  private static _holoTools?: Set<string>;
  static isHoloTool(name: string): boolean {
    if (name.startsWith('hologram_')) return true; // 记忆 / 遗留工具
    if (!ChatCore._holoTools) {
      ChatCore._holoTools = new Set([
        'explore_deps',
        'search_symbols',
        'get_neighbors',
        'trace_impact',
        'find_dep_path',
        'inspect_symbol',
        'symbol_history',
        'get_community',
        'cluster_report',
        'async_edges',
        'fragile_modules',
        'detect_cycles',
        'thread_conflicts',
        'coupling_report',
        'project_timeline',
        'arch_blindspots',
        'graph_summary',
        'graph_diff',
        'analyze_project',
        'preflight_check',
        'validate_project',
        'project_health',
        'rename_symbol',
        'engine_status',
        'check_boundaries',
        'find_unused',
        'trace_dataflow',
        'resolve_call',
        'infer_type',
        'find_implementations',
        'find_references',
        'dataflow_save',
        'dataflow_query',
      ]);
    }
    return ChatCore._holoTools.has(name);
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
      getStarGraph: () => this.starGraph,
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
      getStarGraph: () => this.starGraph,
      updateFooter: () => this.updateFooter(),
      setLastUsageText: (s) => {
        // 用量文本是活跃卷的底栏——后台卷事件不覆盖显示
        if (ownerSid == null || ownerSid === this.activeSessionId) {
          getChatStore(storeId).panel.getState().setLastUsageText(s);
        }
      },
      saveActiveSession: (p) => this.saveActiveSession(p),
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
      _retractUserMessage: (m) => this._retractUserMessage(m),
      retractTurn: (i) => this.retractTurn(i),
      sendMessage: () => this.sendMessage(),
      _updateTokens: (n) => {
        // token 按卷入账（会话级）；面板显示只跟随活跃卷
        if (ownerSid != null) {
          getChatStore(storeId).sess.getState().setSessionTokens(ownerSid, n);
          if (ownerSid === this.activeSessionId) {
            getChatStore(storeId).panel.getState().setTotalTokensUsed(n);
          }
        } else {
          getChatStore(storeId).panel.getState().setTotalTokensUsed(n);
        }
      },
      getProjectPath: () => useShellStore.getState().projectPath,
      getRunning: () => this._activeExec().isRunning,
      getAbortCtrl: () =>
        this._activeExec().abortSignal ? ({ signal: this._activeExec().abortSignal } as AbortController) : null,
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
    return Session.createNewSession(this._sessionCtx());
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
    return Session.renameSessionFile(this._sessionCtx(), pp, id, label);
  }

  // ── 会话持久化（委托给 chat-session.ts）──

  /** 当前活跃会话 id（L2 持久化分流：turn-done 判后台卷用）。 */
  get activeSessionId(): number | null {
    const st = getChatStore(this.panelId).sess.getState();
    return st.sessions[st.activeIdx]?.id ?? null;
  }

  /** 按 id 落盘指定卷（L2 两动词之 save：不要求活跃；空卷跳过）。 */
  async saveSessionById(sid: number): Promise<void> {
    const pp = useShellStore.getState().projectPath;
    return Session.saveSessionById(this._sessionCtx(), pp, sid);
  }

  /** 全部有内容卷落盘（L2 beforeunload 收尾：F3 后台卷不丢）。 */
  async saveAllSessions(): Promise<void> {
    const st = getChatStore(this.panelId).sess.getState();
    await Promise.all(st.sessions.map((s) => this.saveSessionById(s.id)));
  }

  async saveActiveSession(projectPath: string): Promise<void> {
    return Session.saveActiveSession(this._sessionCtx(), projectPath);
  }
  scheduleAutoSave(projectPath: string): void {
    Session.scheduleAutoSave(this._sessionCtx(), projectPath);
  }
  async autoRestoreLastSession(projectPath: string): Promise<void> {
    return Session.autoRestoreLastSession(this._sessionCtx(), projectPath);
  }
  async listSavedSessions(
    projectPath: string,
  ): Promise<Array<{ id: number; label: string; msgCount: number; savedAt: string }>> {
    return Session.listSavedSessions(this._sessionCtx(), projectPath);
  }
  async loadSessionFromDisk(projectPath: string, sessionId: number): Promise<void> {
    return Session.loadSessionFromDisk(this._sessionCtx(), projectPath, sessionId);
  }
  async deleteSessionFile(projectPath: string, sessionId: number): Promise<void> {
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
    const canvas = getCanvasStore(this.panelId).getState();
    const st = getChatStore(this.panelId).sess.getState();
    const openIds = new Set(st.sessions.map((s) => s.id));

    // 磁盘已落盘卷集（目录缺席/列表失败 = 不剪枝，保守）。
    // 用 listSavedSessions 取**有效**卷集（过滤墓碑 deleted:true / 坏 JSON /
    // 空卷）——不能按文件名收集（墓碑/坏文件会被误判为有效卷，导致已删卷的
    // 摊开项不剪枝、每次启动弹「案卷文件读取失败」）。
    const sessionsDir = `${workspace.replace(/[\\/]+$/, '')}/.lantai/sessions`;
    let listed = false;
    try {
      const parsed = await typedJsonRpc<Array<{ name: string; is_dir?: boolean }>>('list_directory', {
        path: sessionsDir,
        filter_ignored: false,
      });
      listed = Array.isArray(parsed);
    } catch {
      /* 目录缺席/列表失败 = 不剪枝 */
    }
    if (listed) {
      const validIds = new Set<number>([...openIds]);
      const saved = await this.listSavedSessions(workspace);
      for (const s of saved) validIds.add(s.id);
      const phantom = Object.keys(canvas.spread).filter((sid) => !validIds.has(Number(sid)));
      if (phantom.length > 0) {
        for (const sid of phantom) canvas.removeRegion(sid);
        // 活跃会话指向若落在被剪的幽灵卷 → 一并清掉（不残留失效指向）
        if (canvas.activeSessionId != null && phantom.includes(canvas.activeSessionId)) {
          canvas.setActiveRegion(null);
        }
        // 回写清理后的画布（幂等——下次启动已无悬空项，不再重复剪）
        void saveCanvasToDisk(this.panelId, workspace).catch(() => {});
      }
      // 已删源会话播种（2026-08-28 会话管理专项）：钉的源卷既不在开卷也不在
      // 有效落盘卷集 = 源已删（或空卷从未落盘）——「收回」语义失效，孤儿钉
      // 按钮应显示「删除」。deleteSessionFile 运行时另做增量标记。
      const dead = new Set<number>();
      for (const pin of Object.values(canvas.pins)) {
        if (pin.source && !validIds.has(pin.source.sessionId)) dead.add(pin.source.sessionId);
      }
      if (dead.size > 0) canvas.replaceDeletedSessionIds(dead);
    }

    let restoreFailed = 0;
    for (const sid of Object.keys(getCanvasStore(this.panelId).getState().spread)) {
      const n = Number(sid);
      if (!openIds.has(n)) {
        try {
          await this.loadSessionFromDisk(workspace, n);
        } catch (e) {
          restoreFailed += 1;
          console.error('[canvas] 恢复摊开卷失败', n, e);
        }
      }
    }
    // D5（拍板 C）：恢复失败可见——StatusLine 警告档 + 一次性提示条
    if (restoreFailed > 0) {
      useBgAlertStore.getState().pushBgAlert('restore-open', `有 ${restoreFailed} 卷恢复失败——可在左侧栏手动展开`);
    } else {
      useBgAlertStore.getState().clearBgAlert('restore-open');
    }
    // 恢复活跃会话指向（画布状态文件的 activeSessionId——创作坞/输入条跟随）
    const activeSid = canvas.activeSessionId ? Number(canvas.activeSessionId) : null;
    if (activeSid != null) {
      const st2 = getChatStore(this.panelId).sess.getState();
      const idx = st2.sessions.findIndex((s) => s.id === activeSid);
      if (idx >= 0 && idx !== st2.activeIdx) this.switchSession(idx);
    }
  }

  /** Stage-5：显式保存点落盘工作区画布状态（切换/关闭窗口时调用）。 */
  async saveCanvasState(workspace: string): Promise<void> {
    await saveCanvasToDisk(this.panelId, workspace);
  }

  // ── 轮次撤回（委托给 chat-session.ts）──

  private retractTurn(idx: number): string | null {
    return Session.retractTurn(this._sessionCtx(), idx);
  }
  private _retractUserMessage(msg: UserMessage): void {
    Session._retractUserMessage(this._sessionCtx(), msg);
  }

  private async exportSession(): Promise<void> {
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
    drive: (signal: AbortSignal) => Promise<unknown>;
    onResult?: (result: GoalRunResult) => void;
  }): Promise<void> {
    // 并发会话（2026-08-26）：闸门拆除——后台卷运行不再阻止本卷新轮次；
    // 仅本卷自身在跑时拒发（Enter 插话路径由 sendMessage 处理）。
    if (!this.agent || this._activeExec().isRunning) return;
    const exec = this._activeExec();
    const signal = exec.start();
    // L2（session-ledger）：本轮跑的是哪卷——头部捕获，finally 随 turn-done
    // 信号发出（后台卷跑完存它自己，不再只存当前翻开的卷）。
    let turnSid: number | null = null;
    {
      const sessStore = getChatStore(this.panelId).sess.getState();
      turnSid = sessStore.sessions[sessStore.activeIdx]?.id ?? null;
    }

    // 为新轮次重置自动滚动（视图级状态——只在本轮卷即活跃卷时才有意义；
    // _runAgentTurn 恒由活跃卷发起，turnSid == 活跃卷）
    getChatStore(this.panelId).msg.getState().setUserScrolledUp(false);

    if (opts.userText) {
      Session.getTurnPairs(this.panelId, turnSid).push({
        userText: opts.userText,
        userBubble: null,
        assistantBubble: null,
        sessionIndex: this.agent.nextInsertIndex,
      });
    }
    if (opts.bubbleLabel) {
      this.appendUserBubble(opts.bubbleLabel);
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
      if (!msg.includes('aborted') && !msg.includes('AbortError')) {
        if (msg.includes('paused after')) {
          Stream.markTurnError(this._streamCtxFor(turnSid), msg, 'warn');
        } else {
          Stream.markTurnError(this._streamCtxFor(turnSid), `错误: ${msg}`, 'error');
        }
      }
      // 正常中止（用户主动停止）：exec 状态已表达，不另播报
    } finally {
      // 发起时刻捕获的 exec + signal 守卫（execution-state.done 注释）——
      // 收尾清「发起轮次的卷」的状态，与结算时刻的活跃卷无关
      exec.done(signal);
      // 轮次收尾按轮次所属卷路由（后台卷跑完 finalize 自己的流式助手 +
      // 自动命名自己；用户中途切走不影响）
      Stream.finishTurn(this._streamCtxFor(turnSid));
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

  /** 卷标签（ask/权限卡徽标用）：优先用户改过的标签，缺省「案卷 N」。 */
  private _sessionLabelOf(sid: number): string {
    const st = getChatStore(this.panelId).sess.getState();
    const s = st.sessions.find((x) => x.id === sid);
    return s?.label || `案卷 ${sid}`;
  }

  /** _sessionLabelOf 的公开出口（bridges 权限卡徽标）。 */
  sessionLabelOf(sid: number): string {
    return this._sessionLabelOf(sid);
  }

  /** 消费 ask-store 的在途请求 → PromptShelf（无 shelf 时立即按取消回答回调）。
   *  并发会话：按 seq 最老优先消费任意队列（PromptShelf 自身 FIFO 多卡，
   *  多卷同时提问各答各的）。 */
  private _consumePendingAsk(): void {
    const data = useAskStore.getState().consumeAnyAsk();
    if (!data) return;
    if (!this._promptShelf) {
      data.callback(null);
      return;
    }
    // 归属卷徽标（哪卷在问——多卷并发时用户需要知道替谁作答）
    const ownerSid = askSessionOf(data);
    const sessionBadge = ownerSid != null ? this._sessionLabelOf(ownerSid) : null;
    // 批量多问（questions 数组）→ 一张分页卡收集；单问 → AskCard
    if (data.questions && data.questions.length > 0) {
      this._promptShelf
        .showAskBatch({
          type: 'ask-batch',
          id: data.id,
          questions: data.questions,
          header: (sessionBadge ? `${sessionBadge} · ` : '') + (data.header ?? '提问'),
        })
        .then((answers) => data.callback(answers));
      return;
    }
    this._promptShelf
      .showAsk({
        type: 'ask',
        id: data.id,
        question: data.question ?? '',
        header: (sessionBadge ? `${sessionBadge} · ` : '') + (data.header ?? '提问'),
        options: data.options ?? [],
        multiSelect: !!data.multiSelect,
      })
      .then(data.callback);
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
        return;      }
      if (!this.agent) {
        const detail = getChatStore(this.panelId).panel.getState().lastAgentDiag
          ? `${getChatStore(this.panelId).panel.getState().lastAgentDiag} (factory:${Session.getAgentFactory(this.panelId) ? 'yes' : 'NO'})`
          : '请先配置 API Key 或等待项目加载';
        showToast(`Agent 未就绪 — ${detail}${hydrated ? '（水合后句柄仍缺席）' : ''}`, 'error', TOAST_LONG_HOLD_MS);
        return;
      }
    }

    // ── 注册表驱动的斜杠命令 ──
    if (text.startsWith('/')) {
      if (text.startsWith('/remember ')) {
        const fact = text.slice('/remember '.length).trim();
        getChatStore(this.panelId).input.getState().setInputText('');
        if (!fact) {
          showToast('用法: /remember 要记住的内容', 'info');
          return;
        }
        import('../../agent/memory.js').then((m) => m.authorizeFactSave());
        this.sendAgentText(
          `请将以下事实保存到记忆库：${fact}\n\n使用 hologram_memory_save 工具。选择合适的 type（user/feedback/project/reference），起一个简短的 kebab-case 名称，写清楚 description。`,
          `/remember ${fact}`,
        );
        return;
      }
      if (text === '/goal' || text.startsWith('/goal ')) {
        const arg = text === '/goal' ? '' : text.slice('/goal '.length).trim();
        getChatStore(this.panelId).input.getState().setInputText('');
        if (arg === '' || arg === 'status') {
          this.showGoalStatus();
          return;
        }
        if (arg === 'resume') {
          this.runGoalResume();
          return;
        }
        if (arg === 'cancel') {
          this.cancelGoal();
          return;
        }
        this.runGoal(arg);
        return;
      }
      const cmd = CommandRegistry.instance.findByShortcut(text.trim());
      if (cmd) {
        this._executeCommand(cmd);
        return;
      }
      // 未知斜杠命令 — 路由到 Skill 工具
      if (!text.includes(' ')) {
        const skillName = text.slice(1);
        getChatStore(this.panelId).input.getState().setInputText('');
        this.sendAgentText(`Execute skill: ${skillName}`, text);
        return;
      }
    }

    // ── 插入路径：Agent 运行中，将消息注入会话 ──
    if (this._activeExec().isRunning) {
      const sessIdx = this.agent.nextInsertIndex;
      this.agent.insertMessage(text);
      getChatStore(this.panelId).input.getState().setInputText('');
      getChatStore(this.panelId).input.getState().pushInputHistory(text);
      getChatStore(this.panelId).input.getState().setDraftText('');
      // C1（2026-08-27）：静默注入曾让用户误以为 Enter 被吞——插话落地要有回音（改 toast，不入流）
      showToast('已插入进行中的回合（Agent 运行中，消息将在下轮生效）', 'info');
      // 纸视图（走查弹）打开时不唤起观测台面板——纸是当前输入面
      if (getChatStore(this.panelId).panel.getState().panelMode === 'input' && !useDockStore.getState().isOpen('paper'))
        this.summonPanel();
      Session.getTurnPairs(this.panelId, this.activeSessionId ?? undefined).push({
        userText: text,
        userBubble: null,
        assistantBubble: null,
        sessionIndex: sessIdx,
      });
      this.appendUserBubble(text);
      return;
    }
    // 并发会话（2026-08-26）：后台卷闸门拆除——本卷不在跑即可发起新轮次，
    // 与后台卷并行流式（事件路由由工厂绑定的 eventSinkFor 承担）。

    // 首条用户消息时自动标记会话
    if (Session.getActiveIdx(this.panelId) >= 0) {
      const session = Session.getSessions(this.panelId)[Session.getActiveIdx(this.panelId)];
      if (session && (session.label.startsWith('会话 ') || session.label === '已恢复的会话')) {
        session.label = text.length > 28 ? text.slice(0, 27) + '…' : text;
        // in-place 变更不会触发 store 订阅 — 换数组引用通知视图
        getChatStore(this.panelId)
          .sess.getState()
          .setSessions([...Session.getSessions(this.panelId)]);
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

    const exec = this._activeExec();
    const signal = exec.start();

    // 重试用轮次对 — sessionIndex 是用户消息将要落地的位置
    const sessIdx = this.agent.getSession().length;
    const turnSidPre = this.activeSessionId;
    Session.getTurnPairs(this.panelId, turnSidPre ?? undefined).push({
      userText: text,
      userBubble: null,
      assistantBubble: null,
      sessionIndex: sessIdx,
    });

    // 用户气泡（原始文本，焦点上下文仅供 Agent 读取）
    const files = getChatStore(this.panelId).input.getState().attachedFiles;
    const filesSnapshot = [...files];
    this.appendUserBubble(text, filesSnapshot);

    // 焦点上下文前缀已随星图/文件查看器焦点链拆除（2026-08-27 死码清扫）——
    // 仅保留附加文件上下文。
    let focusPrefix = '';

    // 附加文件 — 暴露路径以便 Agent 读取（大小不做假：openFilePicker 拿不到真实
    // size，旧实现硬编码 0 导致模型看到「0 B」误判空文件；要真大小需 Rust stat 通道）
    if (files.length > 0) {
      focusPrefix += '用户附加了以下文件：\n';
      for (const f of files) {
        focusPrefix += `- \`${f.path}\`\n`;
      }
      focusPrefix += '你可以用 read_file 读取这些文件。\n\n';
      getChatStore(this.panelId).input.getState().clearAttachedFiles();
    }

    // 追踪启动本次运行的会话 — 事件路由身份已由工厂绑定的 eventSinkFor
    // 携带；这里只管子 Agent 通知路由的 agent._uiSessionId。
    const turnSid: number | null = this.activeSessionId;
    if (turnSid != null) {
      this.agent?.setUiSessionId(turnSid);
    }

    // 运行 Agent
    try {
      await this.agent.run(signal, focusPrefix + text);
    } catch (err: unknown) {
      // 2026-08-31 贴黄拆迁：回合错误写进回合自身（墓碑），不播黄纸条
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('aborted') && !msg.includes('AbortError')) {
        if (msg.includes('paused after')) {
          Stream.markTurnError(this._streamCtxFor(turnSid), msg, 'warn');
        } else {
          Stream.markTurnError(
            this._streamCtxFor(turnSid),
            `错误: ${msg}。发送任意消息重试，或输入 /compact 压缩上下文，或输入 /new 新建会话`,
            'error',
          );
        }
      }
    } finally {
      // 发起时刻捕获的 exec + signal 守卫（execution-state.done 注释）——
      // 收尾清「发起轮次的卷」的状态，与结算时刻的活跃卷无关
      exec.done(signal);
      // 轮次收尾按轮次所属卷路由（用户中途切卷，后台卷 finalize 自己的流）
      Stream.finishTurn(this._streamCtxFor(turnSid));
    }
    // 通知持久化链（P1 总线归零：chat:turn-done → state/turn-done-store 信号；
    // L2：携带跑完的会话 id——谁跑完存谁）
    bumpTurnDone(turnSid ?? undefined);
  }

  abort(): void {
    if (!this._activeExec().isRunning) return;

    // ⚡ 统一状态管理：停止主Agent + 级联子Agent + 清权限队列
    this._activeExec().stop();
    this.agent?.cascadeAbort();

    // 停止按钮/exec 状态已表达中止意图——不再播报「正在中止…」（2026-08-31）

    // 安全超时：3 秒内若 Agent 没响应，强制复位
    const safety = setTimeout(() => {
      if (this._activeExec().isRunning) {
        this._activeExec().forceReset();
        this.finishTurn();
        showToast('已强制中止（超时）', 'warn');
      }
    }, 3000);
    // Zustand 订阅代替轮询 — 状态变为 idle 时自动取消超时
    const exec = this._activeExec();
    const unsub = exec.onChange(() => {
      if (!exec.isBusy) {
        clearTimeout(safety);
        unsub();
      }
    });
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
  async openFilePicker(): Promise<void> {
    const input = getChatStore(this.panelId).input.getState();
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({ multiple: true, title: '拾遗——选择要附入案卷的文件', filters: [] });
      if (!result) return;
      const paths = Array.isArray(result) ? result : [result];
      for (const p of paths) {
        const name = p.replace(/\\/g, '/').split('/').pop() || p;
        if (!input.attachedFiles.some((f) => f.path === p)) input.addAttachedFile({ path: p, name, size: 0 });
      }
    } catch (e) {
      // 浏览器 dev（mock）环境：File 无真路径——不再用 name 冒充（旧病灶）。
      // 附件链在真机才有意义；dev 下静默提示不可用，错误可见不炸。
      console.warn('[chat] 附件拾遗仅在真机可用（Tauri dialog 缺席）:', e);
    }
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
    skipActions?: boolean,
  ): void {
    Stream.appendUserBubble(this._streamCtxFor(null), text, files, skipActions);
  }

  private finishTurn(): void {
    Stream.finishTurn(this._streamCtxFor(null));
  }

  // ── 消息操作回调（视图 ChatMessages 委托）──

  copyText(text: string): void {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  navigateToNode(nodeName: string): void {
    if (this.starGraph) this.starGraph.focusNode(nodeName);
  }
  editUserMessage(msg: UserMessage): void {
    if (this._activeExec().isRunning) {
      showToast('Agent 正在运行，请先停止再编辑', 'warn');
      return;
    }
    getChatStore(this.panelId).input.getState().setInputText(msg.text);
    this._composer?.focus();
    this._composer?.selectEnd();
    this._retractUserMessage(msg);
  }
  resendUserMessage(msg: UserMessage): void {
    if (this._activeExec().isRunning) {
      showToast('Agent 正在运行，请先停止再重发', 'warn');
      return;
    }
    getChatStore(this.panelId).input.getState().setInputText(msg.text);
    this._retractUserMessage(msg);
    this.sendMessage();
  }
  retryAssistant(assistant: AssistantMessage): void {
    if (this._activeExec().isRunning) {
      showToast('Agent 正在运行，请先停止再重试', 'warn');
      return;
    }
    const userMsg = this.messages.find((m) => m.role === 'user' && m._id === assistant.respondingTo);
    const userText = userMsg && 'text' in userMsg ? (userMsg.text as string) : '';
    if (!userText) return;
    getChatStore(this.panelId).input.getState().setInputText('');
    const exec = this._activeExec();
    const signal = exec.start();
    const agent = this.agent;
    if (!agent) {
      exec.done(signal); // 早退也必须结算，否则 exec 永卡运行态
      return;
    }
    const sessIdx = agent.getSession().length;
    const retrySid = this.activeSessionId;
    Session.getTurnPairs(this.panelId, retrySid ?? undefined).push({
      userText,
      userBubble: null,
      assistantBubble: null,
      sessionIndex: sessIdx,
    });
    if (retrySid != null) {
      this.agent?.setUiSessionId(retrySid);
    }
    agent
      .run(signal, userText)
      .catch((err: Error) => {
        if (!err.message?.includes('aborted')) {
          Stream.markTurnError(this._streamCtxFor(retrySid), `重试失败: ${err.message || String(err)}`, 'error');
        }
      })
      .finally(() => {
        exec.done(signal); // 发起时刻捕获 + signal 守卫（见 execution-state.done）
        Stream.finishTurn(this._streamCtxFor(retrySid));
      });
  }

  // ── @ file reference autocomplete（视图注册控制器，core 转发）──

  private _lastAtCursor = 0;
  handleAtInput(textBefore: string, cursorPos: number): void {
    this._lastAtCursor = cursorPos;
    this._atAutocomplete?.update(textBefore, cursorPos);
  }
  atNavigate(delta: number): void {
    this._atAutocomplete?.navigate(delta);
  }
  atSelect(): void {
    this._atAutocomplete?.select();
  }
  get atOpen(): boolean {
    return this._atAutocomplete?.open ?? false;
  }
  /** @ 弹层选中回填：atIdx(@ 位置) → 当前光标处替换为 token */
  applyAtSelect(atIdx: number, token: string): void {
    const input = getChatStore(this.panelId).input.getState();
    const v = input.inputText;
    input.setInputText(v.slice(0, atIdx) + token + v.slice(this._lastAtCursor));
    this._composer?.focus();
  }

  // ── Slash panel（视图注册控制器，core 转发）──

  get slashVisible(): boolean {
    return this._slashController?.visible ?? false;
  }
  slashNavigate(delta: number): boolean {
    return this._slashController?.navigate(delta) ?? false;
  }
  slashSelect(): void {
    this._slashController?.select();
  }
  hideSlash(): void {
    this._hideSlashPanel();
  }
  /** Escape 专用：剥离输入框中的 /query 文本再隐藏，避免下次按键触发 handleSlashInput 重新弹出 */
  dismissSlash(): void {
    const input = getChatStore(this.panelId).input.getState();
    const v = input.inputText;
    const slashIdx = v.lastIndexOf('/');
    if (slashIdx >= 0) {
      input.setInputText(v.slice(0, slashIdx));
    }
    this._hideSlashPanel();
    this._composer?.focus();
  }
  private _hideSlashPanel(): void {
    this._slashController?.hide();
  }

  /** 为需要实例上下文的命令（new/compact/trail/export）挂载本地处理器。 */
  private _wireCommandHandlers(): void {
    const override = (id: string, handler: () => void) => {
      const idx = DEFAULT_COMMANDS.findIndex((c) => c.id === id);
      if (idx >= 0 && DEFAULT_COMMANDS[idx].action.type === 'local') {
        (DEFAULT_COMMANDS[idx].action as { handler: () => void }).handler = handler;
      }
    };
    override('new', () => {
      getChatStore(this.panelId).input.getState().setInputText('');
      this.createNewSession();
    });
    override('compact', () => {
      getChatStore(this.panelId).input.getState().setInputText('');
      if (!this.agent) return;
      // 守卫：压缩会重写会话 — 与运行中的轮次竞争会损坏数据。
      if (this._activeExec().isRunning) {
        showToast('Agent 正在运行，请先停止或等待完成后再压缩。', 'warn');
        return;
      }
      this.appendUserBubble('/compact');
      const exec = this._activeExec();
      const signal = exec.start();
      this.agent
        .compactNow(signal)
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
          exec.done();
        });
    });
    override('export', () => this.exportSession());
    override('trail', () => {
      this._onTrailToggle?.();
    });
  }

  /** 从注册表执行命令（SlashPanel onCommit 委托）。 */
  executeCommand(cmd: CommandDef): void {
    this._executeCommand(cmd);
  }

  private _executeCommand(cmd: CommandDef): void {
    this._hideSlashPanel();
    const action = cmd.action;
    switch (action.type) {
      case 'send':
        getChatStore(this.panelId).input.getState().setInputText('');
        this.sendAgentText(action.text, action.displayLabel);
        break;
      case 'fill':
        getChatStore(this.panelId).input.getState().setInputText(action.text);
        this._composer?.focus();
        this._composer?.selectEnd();
        break;
      case 'local':
        getChatStore(this.panelId).input.getState().setInputText('');
        action.handler();
        break;
      case 'skill':
        getChatStore(this.panelId).input.getState().setInputText('');
        this.sendAgentText(`Execute skill: ${action.skillName}`, `/${action.skillName}`);
        break;
    }
  }

  handleSlashInput(textBefore: string): void {
    // 行首或空格后的 / 时显示面板
    const showPanel = /(?:^|\s)\/$/.test(textBefore);
    if (showPanel) {
      const slashIdx = textBefore.lastIndexOf('/');
      const query = textBefore.slice(slashIdx + 1);
      this._slashController?.show(query);
    } else if (!textBefore.includes('/')) {
      this._hideSlashPanel();
    } else {
      const slashIdx = textBefore.lastIndexOf('/');
      if (slashIdx > 0 && textBefore[slashIdx - 1] !== ' ') {
        this._hideSlashPanel();
        return;
      }
      const query = textBefore.slice(slashIdx + 1).trimStart();
      this._slashController?.show(query.length > 0 ? query : '');
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

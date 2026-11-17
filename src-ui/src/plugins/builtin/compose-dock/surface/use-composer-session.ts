// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-session — 创作坞的**会话面**（2026-11-17 上帝文件治理 P6 拆出；语义零新增）。
//
// 归组判据（施工单）：**这组状态是否随同一个事件变化**——本件收的全是「卷变了 / 卷级账
// 变了 / 设置保存了」三类事件驱动的读数与生效配置：
//   · sess 订阅（切卷 / 改名 / token 入账）
//   · input-store live 槽（正文 + 附件 + 附图）与命令式接口注册
//   · compose-store 每会话偏好（覆盖 ?? 全局默认）
//   · settings 保存代数 → 新卷出生默认 / 模型描述符 / 思考档位表 / 附图能力
//
// ⚠ 与独立改造的边界（本次**不**做）：这些读数的真源都不在 React（store / Agent 侧账本），
// 现在靠 `tick + 1` 与订阅回调把它们灌进 useState。改成 useSyncExternalStore 是**另一刀**
// （会一次性消掉 settingsTick / sessionTokens 这两条触发器）——混进搬家会让 diff 不可审。
// 现存的两处「显式触发器」因此在函数签名里直言不讳：`void tick;` 就写在 memo 体内，
// 不再需要 biome-ignore 去豁免「依赖数组里有个没用到的值」。

import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChatCore,
  ChatImageRef,
  ComposeSessionPrefs,
  ProviderSettings,
  StoredThinking,
  TokenMeasurement,
} from '../host';
import {
  agentSessionState,
  getChatStore,
  getComposeStore,
  getModel,
  loadSettings,
  modelDescriptor,
  modelInput,
  modelThinking,
  onSettingsSaved,
  resolveNewSessionDefault,
  thinkingOptionsOrDefault,
  useDraftSheetStore,
} from '../host';

export interface ComposerSessionInput {
  core: ChatCore | null;
  /** 纸期（variant='sheet'）：模型/思考/组合的源头换成题签。 */
  isSheet: boolean;
  /** 上下文卷（纸期恒 null——纸还没有卷号）。 */
  activeSessionId: string | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

export interface ComposerSessionState {
  sessions: Array<{ id: number; label: string }>;
  activeSession: { id: number; label: string } | null;
  activeSidNum: number | null;
  tokenCount: number;
  tokenStats: TokenMeasurement | null;
  inputText: string;
  setInputText: (text: string) => void;
  attachedFiles: Array<{ path: string; name: string; size: number }>;
  attachedImages: ChatImageRef[];
  providerName: string;
  model: string;
  providerKind: string;
  provider: ProviderSettings | undefined;
  imageCapable: boolean;
  thinkingOptions: ReadonlyArray<{ value: string; label?: string }>;
  currentThinking: StoredThinking | '' | undefined;
}

export function useComposerSession({
  core,
  isSheet,
  activeSessionId,
  composerRef,
}: ComposerSessionInput): ComposerSessionState {
  /* ── 会话面：sess store 订阅（切卷/改名/token 变化自动重渲）── */
  const [sessions, setSessions] = useState<Array<{ id: number; label: string }>>([]);
  const [sessionTokens, setSessionTokens] = useState<Record<number, number>>({});
  useEffect(() => {
    if (!core) {
      setSessions([]);
      setSessionTokens({});
      return;
    }
    const sess = getChatStore(core.panelId).sess;
    const sync = () => {
      setSessions(sess.getState().sessions);
      setSessionTokens(sess.getState().sessionTokens);
    };
    sync();
    return sess.subscribe(sync);
  }, [core]);
  const activeSession =
    activeSessionId != null ? (sessions.find((s) => String(s.id) === activeSessionId) ?? null) : null;
  const activeSidNum = activeSessionId != null ? Number(activeSessionId) : null;
  const tokenCount = activeSidNum != null ? (sessionTokens[activeSidNum] ?? 0) : 0;

  /* ── 墨量册读数（2026-09-13）：真源 = 活跃卷 Agent 侧 token 账本 ──
   * 依赖 sessionTokens 作为重算触发（每次请求入账时 _recordTokens 会写它，
   * 卷级 store 的订阅随之把本组件重渲一次）——不引入第二个账本副本。
   * ⚠ sessionTokens 在体内只作**信号**读（void），故显式写在 memo 体里，
   * 不再需要 biome-ignore 豁免「依赖数组里的非响应值」。*/
  const tokenStats = useMemo(() => {
    void sessionTokens; // 入账触发器：账本真源在 Agent 侧，用卷级总量当重算信号
    if (!core || activeSidNum == null) return null;
    return agentSessionState.getAgent(core.panelId, activeSidNum)?.getTokenStats?.() ?? null;
  }, [core, activeSidNum, sessionTokens]);

  /* ── 草稿（input-store live = 当前活跃会话的输入框；切卷由 chat-session
   *    负责 save/restore sessionDrafts，本组件只读写 live 槽）── */
  const [inputText, setInputTextState] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<Array<{ path: string; name: string; size: number }>>([]);
  const [attachedImages, setAttachedImages] = useState<ChatImageRef[]>([]);
  useEffect(() => {
    if (!core) {
      setInputTextState('');
      setAttachedFiles([]);
      setAttachedImages([]);
      return;
    }
    const input = getChatStore(core.panelId).input;
    const sync = () => {
      setInputTextState(input.getState().inputText);
      setAttachedFiles(input.getState().attachedFiles);
      setAttachedImages(input.getState().attachedImages);
    };
    sync();
    return input.subscribe(sync);
  }, [core]);

  const setInputText = useCallback(
    (text: string) => {
      if (!core) return;
      getChatStore(core.panelId).input.getState().setInputText(text);
    },
    [core],
  );

  /* ── B6（2026-08-27）：注册输入框命令式接口——接活 chat-core 的
   *    _composer 死链（此前 registerComposer 全工程无调用方，9 处
   *    focus/selectEnd 全部空转，含斜杠 fill 后焦点回归、exec 停止后
   *    焦点回归路径）。卸载时注销。 ── */
  useEffect(() => {
    if (!core) return;
    core.registerComposer({
      focus: () => composerRef.current?.focus(),
      selectEnd: () => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      },
    });
    return () => core.registerComposer({ focus: () => {}, selectEnd: () => {} });
  }, [core, composerRef]);

  /* ── 会话生效配置（方案甲：覆盖 ?? 全局默认，实时解析）── */
  const [prefs, setPrefs] = useState<ComposeSessionPrefs | undefined>(undefined);
  /* 会话**显式**思考覆盖（2026-09-23 思考下沉）：prefs 是「解析后」的生效配置，
   * 未改卷时它带着全局快照的档位值——拿它当「本卷拨过」用会把全局值误当覆盖，
   * 永远压住模型的 per-model 档位显示。故档位显示单独读覆盖表（getPrefs）。 */
  const [thinkingOverride, setThinkingOverride] = useState<StoredThinking | undefined>(undefined);
  useEffect(() => {
    if (!core || activeSessionId == null) {
      setPrefs(undefined);
      setThinkingOverride(undefined);
      return;
    }
    const compose = getComposeStore(core.panelId);
    const sync = () => {
      const st = compose.getState();
      setPrefs(st.resolveEffective(activeSessionId));
      setThinkingOverride(st.getPrefs(activeSessionId)?.thinking);
    };
    sync();
    return compose.subscribe(sync);
  }, [core, activeSessionId]);

  // C4（2026-08-27）：显示读 settings 走「初值 + onSettingsSaved 订阅」，
  // 不再每渲染全量 loadSettings()（打字热路径上的 localStorage JSON.parse）
  const [settingsTick, setSettingsTick] = useState(0);
  useEffect(() => onSettingsSaved(() => setSettingsTick((n) => n + 1)), []);
  // 开口即开卷（2026-08-31）：无主态显示/操作「新卷出生默认」（全局活跃行）；
  // 有活跃卷时 prefs（resolveEffective）已含全局回落（覆盖 ?? 全局）。
  // tick 驱动重读——无主态拨模型/思考走 settings-saved → tick 变 → 重算。
  const newSessionDefault = useMemo(() => {
    void settingsTick; // 保存代数触发器（非响应值）：设置保存后重读全局默认
    return resolveNewSessionDefault();
  }, [settingsTick]);
  /* 待题纸（2026-11-15 V2）：纸自己那张（variant='sheet'）用**同一份** provider/model
   * 推导，只是源头换成题签：题签未填（纸刚摊开）= 出厂默认（新卷出生默认），
   * 与坞期 prefs 的空位同义。 */
  const draftPicks = useDraftSheetStore((s) => {
    const id = s.focusedId;
    return id === null ? null : (s.papers.find((p) => p.id === id)?.picks ?? null);
  });
  const providerName = (isSheet ? draftPicks?.providerName : prefs?.providerName) ?? newSessionDefault.providerName;
  const model = (isSheet ? draftPicks?.model : prefs?.model) ?? newSessionDefault.model;
  const settingsVersion = settingsTick + providerName.length; // 触发器合成：保存代数 + 覆盖换向
  const settings = useMemo(() => {
    void settingsVersion; // 触发器合成值（保存代数 + 覆盖换向）——非响应值
    try {
      return loadSettings();
    } catch {
      return null;
    }
  }, [settingsVersion]);
  const provider: ProviderSettings | undefined = settings?.providers.find((p) => p.name === providerName);
  const providerKind = provider?.kind ?? 'openai';
  // 2026-09-23 思考下沉：描述符改读 **provider 作用域**（覆盖 ?? API 拉取 ?? 目录
  // seed）——与设置页参数面板、请求期 assertEffortDeclared 同一把尺子。此前读全局
  // getModel：网关模型在拉取失败/重启后拿不到自己的档位声明，同一模型在坞里与在
  // 设置页显示的档位表可以不一致。行缺席（已删）才回落全局目录。
  const modelDesc = useMemo(() => (provider ? modelDescriptor(provider, model) : getModel(model)), [provider, model]);
  // 附图能力门禁（multimodal-image-plan D-8②）：生效输入模态含 'image' 才开
  // 图片采集道——策略在此（视图层），机制在 chat-core（intake 方法）。
  // modelInput 合并链（B5）：ModelOverrides.input 覆盖 ?? 目录 seed vision 声明；
  // 目录外自定义 vision 模型经设置页参数面板补声明即开。
  const imageCapable = modelInput(provider, model).includes('image');
  /* 2026-11-08 墨线退役（丙案尾项）：坞底那条 2px 墨线撤了——它与书眉「墨 NN%」
   * 读数**同源同判据**（同一个 tokenStats.usedTokens / 同一个 >80% 门槛），是同一件事
   * 画两遍；而且它占着"坞底发丝线"那条位置，而坞是浮在纸上的，底边本来就是纸的边。
   * 「快满了」的余光信号没有丢：近满态现在挂在触发器本体（.pp-ink-trigger.full →
   * 字与点一起转朱砂 + 呼吸，见 paper-composer.css），与旧 .pp-inkline.full 同判据。
   * 分母口径随之整个交回墨量册（它自己算 percent / nearFull，读同一把 token-meter 尺子）：
   * per-model 覆盖 ?? 目录声明（modelContextWindow，与运行时压缩阈值同链），未知窗口不编造。 */
  const thinkingOptions = useMemo(() => {
    // P14：有声明用声明档位表；无声明给「自动/关闭」协议安全兜底——思考按钮常驻
    // （DSH 语义），不编造命名档位（''/off 在 assertEffortDeclared 不拦、协议层可
    // 安全表达）。表来自 thinkingOptionsOrDefault（与设置页参数面板同一函数）。
    return thinkingOptionsOrDefault(modelDesc);
  }, [modelDesc]);
  // 生效档位三层（2026-09-23）：会话覆盖（本卷显式拨过）?? 该模型档位
  // （per-model 覆盖 ?? 本家默认档位，经 modelThinking 一把尺子）；行缺席（已删）
  // 才回落新卷出生默认。
  const currentThinking =
    (isSheet ? draftPicks?.thinking : thinkingOverride) ??
    (provider ? modelThinking(provider, model) : newSessionDefault.thinking);

  return {
    sessions,
    activeSession,
    activeSidNum,
    tokenCount,
    tokenStats,
    inputText,
    setInputText,
    attachedFiles,
    attachedImages,
    providerName,
    model,
    providerKind,
    provider,
    imageCapable,
    thinkingOptions,
    currentThinking,
  };
}

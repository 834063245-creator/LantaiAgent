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
import type { QuoteCard } from '../../../../state/card-quote';
import type {
  ChatCore,
  ChatImageRef,
  ComposeSessionPrefs,
  ProviderSettings,
  StoredThinking,
  TokenMeasurement,
} from '../host';
import { agentSessionState, getChatStore, getComposeStore, onSettingsSaved } from '../host';
import { useModelSeat } from './use-model-seat';

export interface ComposerSessionInput {
  core: ChatCore | null;
  /** 纸期（variant='sheet'）：模型/思考/组合的源头换成题签。 */
  isSheet: boolean;
  /** 纸期：**这张纸**的 id（2026-11-29 多纸错位批；缺省/null = 焦点那张）。 */
  paperId?: string | null;
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
  /** **夹签槽**（卡片引用，card-quote-plan §2.4）：本卷引用过、还没发出去的卡。 */
  attachedCards: QuoteCard[];
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
  paperId,
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
  const [attachedCards, setAttachedCards] = useState<QuoteCard[]>([]);
  useEffect(() => {
    if (!core) {
      setInputTextState('');
      setAttachedFiles([]);
      setAttachedImages([]);
      setAttachedCards([]);
      return;
    }
    const input = getChatStore(core.panelId).input;
    const sync = () => {
      setInputTextState(input.getState().inputText);
      setAttachedFiles(input.getState().attachedFiles);
      setAttachedImages(input.getState().attachedImages);
      setAttachedCards(input.getState().attachedCards);
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
  /* 生效配置读数（provider / 模型 / 描述符 / 思考档位 / 附图能力）——2026-11-19 题签重画批
   * 搬进 `use-model-seat`：同一组读数现在有第二处宿主（纸期卷首档行），解析只许一条链。 */
  const seat = useModelSeat({ isSheet, paperId, prefs, thinkingOverride, settingsTick });
  const { providerName, model, providerKind, provider, imageCapable, thinkingOptions, currentThinking } = seat;

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
    attachedCards,
    providerName,
    model,
    providerKind,
    provider,
    imageCapable,
    thinkingOptions,
    currentThinking,
  };
}

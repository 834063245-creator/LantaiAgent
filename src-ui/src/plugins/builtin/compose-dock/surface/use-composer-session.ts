// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-session — 创作坞的**会话面**（2026-11-17 上帝文件治理 P6 拆出；
// **2026-11-29 收口批**：四笔生效配置的解析搬去 `state/run-config`，本件只剩「这一趟怎么发」）。
//
// 归组判据（施工单）：**这组状态是否随同一个事件变化**——本件收的全是「卷变了 / 卷级账
// 变了 / 输入变了」三类事件驱动的读数与草稿面：
//   · sess 订阅（切卷 / 改名 / token 入账）
//   · input-store live 槽（正文 + 附件 + 附图 + 夹签）与命令式接口注册
//   · 四笔生效值（模型 / 思考 / 组合 / 权限）→ 经 `useRunConfig(目标)`（唯一解析层）
//   · 模型描述符 / 思考档位表 / 附图能力 → 拿已解析的四笔去设置面查（`use-model-seat`）
//
// ⚠ 与独立改造的边界（本次**不**做）：这些读数的真源都不在 React（store / Agent 侧账本），
// 现在靠 `tick + 1` 与订阅回调把它们灌进 useState。改成 useSyncExternalStore 是**另一刀**
// （会一次性消掉 settingsTick / sessionTokens 这两条触发器）——混进搬家会让 diff 不可审。
// 现存的两处「显式触发器」因此在函数签名里直言不讳：`void tick;` 就写在 memo 体内，
// 不再需要 biome-ignore 去豁免「依赖数组里有个没用到的值」。

import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import type { QuoteCard } from '../../../../state/card-quote';
import type { ChatCore, ChatImageRef, ProviderSettings, RunTarget, StoredThinking, TokenMeasurement } from '../host';
import { agentSessionState, getChatStore, onSettingsSaved } from '../host';
import { useModelSeat } from './use-model-seat';
import { useRunConfig } from './use-run-config';

export interface ComposerSessionInput {
  core: ChatCore | null;
  /** 本宿主指向的**目标**（纸 / 卷 / 无主）——四笔读数唯一入口的入参（2026-11-29 收口批）。
   *  宿主自己知道「我是谁」（题签行给纸 id、坞给卷号），本 hook 不猜、也不读 focusedId。 */
  target: RunTarget;
  /** **本件的草稿槽**（2026-11-30 非焦点纸身批）：`null/缺省` = 读 live（坞期、焦点那张纸）；
   *  给了槽（`draft:<纸 id>`）且本件不是 live 主人 ⇒ 读那一份（非焦点那张纸显示自己的正文）。 */
  draftSlot?: string | null;
  /** 上下文卷（纸期恒 null——纸还没有卷号）。 */
  activeSessionId: string | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

/** 草稿视图（正文 + 三族附件）——live 与各槽共用同一个形状。 */
interface DraftView {
  inputText: string;
  attachedFiles: Array<{ path: string; name: string; size: number }>;
  attachedImages: ChatImageRef[];
  attachedCards: QuoteCard[];
}

const EMPTY_DRAFT_VIEW: DraftView = { inputText: '', attachedFiles: [], attachedImages: [], attachedCards: [] };

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
  target,
  draftSlot,
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

  /* ── 草稿（input-store）──
   * 两条读面，按**本件是不是 live 的主人**分派（2026-11-30 非焦点纸身批）：
   *   · `draftSlot` 缺省 / 本件就是 liveOwner ⇒ 读 live 槽（坞期、焦点那张纸）；
   *   · 否则读 `sessionDrafts['draft:<纸 id>']` —— **非焦点那张纸要显示自己的草稿**。
   *     旧实现一律读 live，于是第二张纸的输入框里显示的是**焦点那张的正文**（看着像复制
   *     了一份）。切焦点时 `claimLive` 已把旧主的正文快照进槽，故槽里是它自己的字。
   * 写入仍只落 live（非焦点那张的输入栈由 DraftSheet 打 inert，本来也打不了字）。 */
  const [live, setLive] = useState<DraftView>(EMPTY_DRAFT_VIEW);
  const [drafts, setDrafts] = useState<Record<string, DraftView>>({});
  const [liveOwner, setLiveOwner] = useState('');
  useEffect(() => {
    if (!core) {
      setLive(EMPTY_DRAFT_VIEW);
      setDrafts({});
      setLiveOwner('');
      return;
    }
    const input = getChatStore(core.panelId).input;
    const sync = () => {
      const st = input.getState();
      setLive({
        inputText: st.inputText,
        attachedFiles: st.attachedFiles,
        attachedImages: st.attachedImages,
        attachedCards: st.attachedCards,
      });
      const slots: Record<string, DraftView> = {};
      for (const [key, d] of Object.entries(st.sessionDrafts)) {
        slots[key] = {
          inputText: d.inputText,
          attachedFiles: d.attachedFiles,
          attachedImages: d.attachedImages,
          attachedCards: d.attachedCards,
        };
      }
      setDrafts(slots);
      setLiveOwner(st.liveOwner);
    };
    sync();
    return input.subscribe(sync);
  }, [core]);

  /* 本件读哪一份：自己不是 live 主人（且宿主指定了槽）⇒ 读槽里那一份。 */
  const readSlot = draftSlot != null && draftSlot !== '' && liveOwner !== draftSlot ? draftSlot : null;
  const view = readSlot === null ? live : (drafts[readSlot] ?? EMPTY_DRAFT_VIEW);
  const { inputText, attachedFiles, attachedImages, attachedCards } = view;

  const setInputText = useCallback(
    (text: string) => {
      if (!core) return;
      /* 非焦点那张纸只**看**不写（它的栈是 inert；这里再兜一道，免得迟到的回调把字写进
       * 别人的 live 槽——那正是「两张纸的正文串了」的形态）。 */
      if (readSlot !== null) return;
      getChatStore(core.panelId).input.getState().setInputText(text);
    },
    [core, readSlot],
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

  /* ── 四笔的生效值（模型 / 思考 / 组合 / 权限）──
   * 2026-11-29 收口批：读数**不再由本 hook 自己拼**（旧实现自己订阅 compose 覆盖、自己
   * 拿 prefs 当覆盖用），一律经 `useRunConfig(目标)` —— 与题签行、坞的设置行同一份规则。
   * 本 hook 只保留「这一趟怎么发」需要的那一半：会话表 / token / 草稿 / 命令式接口。 */
  const config = useRunConfig(target);

  // C4（2026-08-27）：显示读 settings 走「初值 + onSettingsSaved 订阅」，
  // 不再每渲染全量 loadSettings()（打字热路径上的 localStorage JSON.parse）
  const [settingsTick, setSettingsTick] = useState(0);
  useEffect(() => onSettingsSaved(() => setSettingsTick((n) => n + 1)), []);
  /* 模型描述符 / 附图能力 / 思考档位表：拿已解析的四笔去查设置面（同一把尺子）。 */
  const seat = useModelSeat({ config, settingsTick });
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

// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-send — 创作坞的**发送与运行态**（2026-11-17 P6 拆出；语义零新增）。
//
// 归组判据（施工单）：这组状态**随同一个事件变化**——都随「这一卷在不在跑」：
// 发送动作、停钮的 running、后台卷指示、以及输入框的高度自适应（发送前面那一拍）。
//
// ⚡ 三条判据原样搬来（搬家不删判据）：
//   ① 发送**读 input-store 实时值**（真源），不读可能滞后的本地 inputText——快速连续
//      输入后立刻回车时本地 state 可能缺最后一个字符；也不许拿旧值回写 store。
//   ② 纸期（V2）：起卷 + 发出去**同一拍**，编排在 ChatCore.sendMessage 的纸在场分支
//      （判据与写入不在视图层）。本件只管点。
//   ③ 无活跃卷 = **开口即开卷**（2026-08-31 拍板）：先建卷再把这句发出去；建卷失败
//      （未绑定目录等）就地可见——坞不再是无主死端。
//
// 运行态唯一读面（v43）：`agentSessionState.runningSessions(panelId)`——不再各自
// `getExec(...).isRunning`（读面漂移在订阅那一环已经炸过一次，2026-09-06）。

import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { volumeDisplayName } from '../../../../state/volume-name';
import { navigateHistory } from '../composer-helpers';
import type { ChatCore, CommandContribution } from '../host';
import { agentSessionState, getChatStore } from '../host';
import { composerSubmitOnKey } from '../ime';

export interface ComposerSendInput {
  core: ChatCore | null;
  isSheet: boolean;
  activeSidNum: number | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** 正文（autoGrow 的重跑触发器：正文变 → 高度重算）。 */
  inputText: string;
  setInputText: (text: string) => void;
  /** 斜杠面板的回调（键义第 ① 条要用；斜杠状态本身归 use-composer-slash）。 */
  slash: {
    slashActive: boolean;
    slashCommands: ReadonlyArray<CommandContribution>;
    slashIdx: number;
    setSlashIdx: Dispatch<SetStateAction<number>>;
    commitSlash: (cmd: CommandContribution) => void;
  };
}

export function useComposerSend({
  core,
  isSheet,
  activeSidNum,
  composerRef,
  inputText,
  setInputText,
  slash,
}: ComposerSendInput) {
  /* ── 运行态（停止按钮 + 后台卷运行指示，B7 运行态感知 2026-08-27）── */
  const [running, setRunning] = useState(false);
  /** 后台运行中的会话（不含活跃卷）：显示「后台 N 卷运行中 + 停止」。 */
  const [bgRunning, setBgRunning] = useState<Array<{ id: number; label: string }>>([]);
  useEffect(() => {
    if (!core || activeSidNum == null) {
      setRunning(false);
      setBgRunning([]);
      return;
    }
    const syncAll = () => {
      // 运行态唯一读面（v43）：`runningSessions` = 本面板在跑的卷（含种类）。
      // 不再各自 `getExec(...).isRunning`——读面漂移在订阅那一环已经炸过一次
      //（2026-09-06），事实面收成一处后，停钮/后台指示/呼吸线永远同源。
      const runningIds = new Map(agentSessionState.runningSessions(core.panelId).map((r) => [r.sid, r.state]));
      let activeRun = false;
      const bg: Array<{ id: number; label: string }> = [];
      const sess = getChatStore(core.panelId).sess.getState().sessions;
      for (const s of sess) {
        if (!runningIds.has(s.id)) continue;
        if (s.id === activeSidNum) activeRun = true;
        else bg.push({ id: s.id, label: volumeDisplayName(s.label, s.id) });
      }
      setRunning(activeRun);
      setBgRunning(bg);
    };
    // 运行态同步根治（2026-09-06）：订阅面 = exec 实例表变更（版本 bump——
    // 惰性水合/拟文期迟到的实例、removeExec 后的重建，subscribeExecAll 内
    // 全部重挂）+ 既有实例起停 + sess 表（改名/增删 → 重算后台清单）。
    // 旧实现只对「effect 挂载时刻已存在」的实例挂 onChange——迟到的 exec
    // 实例永远无订阅，起停不可见（会话在跑而停钮不出现）。
    const unExecAll = agentSessionState.subscribeExecAll(core.panelId, syncAll);
    const unSess = getChatStore(core.panelId).sess.subscribe(syncAll);
    return () => {
      unExecAll();
      unSess();
    };
  }, [core, activeSidNum]);

  /** 卷名反查（役册「他卷」段用）——与后台卷指示同一把尺子：sess 表 +
   *  `volumeDisplayName`（禁在调用点散写卷号；2026-09-21 卷号收显示纪律）。 */
  const sessionNameOf = useCallback(
    (sid: number | null): string => {
      if (sid == null || !core) return '归属未知';
      const sess = getChatStore(core.panelId).sess.getState().sessions;
      const s = sess.find((x) => x.id === sid);
      return s ? volumeDisplayName(s.label, s.id) : `案卷 ${sid}`;
    },
    [core],
  );

  const autoGrow = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    /* box-sizing: border-box 下 scrollHeight 不含上下边框：只写 scrollHeight 会让
     * 单行的 clientHeight 比内容少 1px（实测 39/38）⇒ 滚动条常驻（2026-10-21 P0 病灶）。
     * 补上 border 高度再夹上限；上限之外才真滚动。 */
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, 144)}px`;
  }, [composerRef]);

  useEffect(() => {
    void inputText; // 正文变 → 高度重算（autoGrow 读的是 DOM 真值，不看这个值本身）
    autoGrow();
  }, [inputText, autoGrow]);

  /* ── 发送 ── */
  const onSend = useCallback(async () => {
    if (!core) return;
    // ⚠ 读 input-store 实时值（真源），不读可能滞后的本地 inputText——
    // 快速连续输入后立刻回车时本地 state 可能缺最后一个字符；
    // 也不许拿旧值回写 store（否则覆盖刚输入的字符 = 丢字）。
    const live = getChatStore(core.panelId).input.getState();
    const t = live.inputText.trim();
    // 「有内容就能拟文」的真判据（2026-11-19 纯图批）：正文 / 路径附件 / 附图道
    // 任一在场都算。旧判据只看正文——甩一张截图、写不写字都发不出去。
    if (!t && live.attachedFiles.length === 0 && live.attachedImages.length === 0) return;
    // 纸期（V2）：起卷 + 发出去**同一拍**，编排在 ChatCore.sendMessage 的纸在场分支
    // （判据与写入不在视图层）。本件只管点——失败原因会由 core 写回纸脚。
    if (isSheet) {
      await core.sendMessage();
      return;
    }
    /* 2026-11-28：`开口即开卷`（无活跃卷 → 先建卷再发）随案头坞退役——零卷时坞槽
     * 整只不渲染（判据在 PaperPanel），本件只可能在**有卷**时被点到。出生面唯一 =
     * 待题纸（纸期走上方的 isSheet 分支，起卷编排在 ChatCore.sendMessage 的纸在场分支）。 */
    await core.sendMessage();
  }, [core, isSheet]);

  /* ── 输入行的键盘分发（C3）────────────────────────────────────────────
   * 三条优先级，**顺序即规格**（挪动任意一条都会改变键义）：
   *   ① 斜杠面板开着：↑↓ 选 / Enter 执行 / Esc 关（关 = 去行首斜杠、保留查询词）；
   *   ② 发送键（composerSubmitOnKey：Enter 发 / Shift+Enter 换行 / 输入法组合期不拦）；
   *   ③ 输入历史：↑ 回取 / ↓ 返回草稿（仅首行且非组合期；多行中间行留给光标移动）。
   * ⚠ 2026-11-17 P6：整段从坞的 JSX 原样搬到这里（**连注释一起**）——判据不是废话。
   * 输入行件只负责把事件交上来（`onKeyDown={handleComposerKeyDown}`），它不知道键义。 */
  const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    /* ── C3：斜杠面板键盘导航优先（↑↓ 选 / Enter 执行 / Esc 关） ── */
    if (slash.slashActive && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slash.setSlashIdx((i) => Math.min(i + 1, slash.slashCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slash.setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const cmd = slash.slashCommands[slash.slashIdx];
        if (cmd) slash.commitSlash(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // / 触发词开着 = 关面板保留查询词（去行首斜杠）
        const live = core ? getChatStore(core.panelId).input.getState() : null;
        if (live) {
          const v = live.inputText;
          const last = v.lastIndexOf('/');
          if (last >= 0) setInputText(v.slice(0, last) + v.slice(last + 1));
        }
        return;
      }
    }
    if (composerSubmitOnKey(e.key, e.nativeEvent.isComposing, e.shiftKey)) {
      e.preventDefault();
      void onSend();
      return;
    }
    /* ⚠ **词/段选择是编辑，不是历史**（2026-11-17 精细编辑批）：Shift+↑↓ 与
     * Ctrl+↑↓ 是原生的「扩选 / 跳段」——旧实现只判「首行 + ↑」，把它们一并吃掉
     * （Ctrl+↑ 直接跳走历史、用户那句还没选中完的正文被整条替换）。同一把判据
     * 对 ↓ 也补上：Shift/Ctrl + ArrowDown 落在这里时不该进历史分支。
     * 判据写在**两条分支的入口**（不是各自内部）——一处判，两处同源。 */
    const selectMod = e.shiftKey || e.ctrlKey || e.metaKey;
    if (e.key === 'ArrowUp' && !e.nativeEvent.isComposing && !selectMod) {
      const el = e.currentTarget;
      const atFirstLine = el.selectionStart === 0 || !el.value.includes('\n');
      if (atFirstLine && core) {
        const input = getChatStore(core.panelId).input.getState();
        const { entry } = navigateHistory(input.inputHistory, input.inputHistoryIdx, -1);
        if (entry !== null) {
          e.preventDefault();
          // 进入历史时保存当前草稿（draftText 槽），越过后恢复
          if (input.inputHistoryIdx === -1) input.setDraftText(input.inputText);
          input.setInputHistoryIdx(entry.idx);
          setInputText(entry.text);
          requestAnimationFrame(() => el.setSelectionRange(entry.text.length, entry.text.length));
        }
      }
    } else if (e.key === 'ArrowDown' && !e.nativeEvent.isComposing && !selectMod) {
      const el = e.currentTarget;
      // 多行输入中间行按 ↓ 是移光标——只有已在历史浏览（idx≥0）时才消费
      const input = core ? getChatStore(core.panelId).input.getState() : null;
      if (input && input.inputHistoryIdx >= 0) {
        e.preventDefault();
        const { entry } = navigateHistory(input.inputHistory, input.inputHistoryIdx, +1);
        if (entry !== null) {
          input.setInputHistoryIdx(entry.idx);
          setInputText(entry.text);
          requestAnimationFrame(() => el.setSelectionRange(entry.text.length, entry.text.length));
        } else {
          // 越过最新一条 → 退出历史浏览，恢复进入时的草稿
          input.setInputHistoryIdx(-1);
          setInputText(input.draftText);
          requestAnimationFrame(() => el.setSelectionRange(input.draftText.length, input.draftText.length));
        }
      }
    }
  };

  return { running, bgRunning, sessionNameOf, onSend, autoGrow, handleComposerKeyDown };
}

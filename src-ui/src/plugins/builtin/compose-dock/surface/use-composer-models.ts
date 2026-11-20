// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-models — 创作坞的**模型 / 思考热切换面**（2026-11-17 P6 拆出；语义零新增）。
//
// 归组判据（施工单）：这组状态**随同一个事件变化**——都随「这一趟用哪个模型、拨多深」：
// 模型切换、思考档位切换，以及交给 ModelSelector 的那一份「思考座位」数据面。
//
// 三态变四态（纸期）：坞里写会话覆盖 / 全局默认；纸期写**题签**（开卷那一刻才落既有
// 写路径）——判据只有本文件这两处，别处不重复判 isSheet。
// ⚠ 与原坞的差别：'自动' 在坞里写成 '' 覆盖值，在纸上是 **undefined**（= 没题），
// 这样「没碰过」与「显式选自动」在开卷时同义（零覆盖，跟随全局）。
//
// 思考档位面（2026-11-12 DSH 两级菜单，用户拍板「去抄 dsh 的 UX」）：旧形态把档位表
// 平铺成 n 枚 chip 塞在模型弹层底部——用户判「这块 UX 有毛病」。DSH 的解法是**同级
// 第二面**：根栏两格「模型 / 思考」，点进思考面才是一张竖排档位清单（当前档行型选中）。
// 本件只把**数据面**交给 ModelSelector（值/标签/档位表/回调），文案仍由坞给
// （档位名在 thinkingZhLabel、说明在 THINKING_DESC），选择器不感知思考语义。

import { useCallback, useMemo } from 'react';
import { providerNameForModel } from './../composer-helpers';
import { THINKING_DESC, thinkingZhLabel } from './../dock-copy';
import type { ChatCore, StoredThinking } from './../host';
import { getComposeStore, useDraftSheetStore } from './../host';

export interface ComposerModelsInput {
  core: ChatCore | null;
  isSheet: boolean;
  /** 纸期：**这张纸**的 id（2026-11-29 多纸错位批；缺省/null = 焦点那张）。
   *  多纸同屏时每张纸的输入面各写各的题签——旧实现一律写焦点那张，非焦点那张
   *  拨了等于写进别人的记录。 */
  paperId?: string | null;
  activeSessionId: string | null;
  providerName: string;
  currentThinking: StoredThinking | '' | undefined;
  thinkingOptions: ReadonlyArray<{ value: string }>;
}

export function useComposerModels({
  core,
  isSheet,
  paperId,
  activeSessionId,
  providerName,
  currentThinking,
  thinkingOptions,
}: ComposerModelsInput) {
  /* ── 热切换：模型 / 思考 ── */
  const onModelChange = useCallback(
    (modelId: string, desc?: { vendor: string }) => {
      if (!core) return;
      const targetProvider = providerNameForModel(desc, providerName);
      // 纸期（V2）：拨的是**题签**（开卷那一刻才落会话覆盖）——三态变四态，
      // 判据只有这一处。
      //
      // ⚡ 2026-11-19「题签要能记住选择」批：题签同时把这一笔写成**新卷出生默认**
      // （与坞期「无主态拨 = 写默认」同一条写路径）——否则每开一张新纸都得重设一遍。
      // 语义分层不变：**这一卷**由题签决定（开卷时落会话覆盖），**下一卷**由默认决定。
      if (isSheet) {
        const st = useDraftSheetStore.getState();
        // 多纸：写的是**本件所属那张纸**的题签（缺省 = 焦点那张——裸挂单件的旧语义）
        const targetId = paperId ?? st.focusedId;
        const paper = targetId === null ? null : st.papers.find((p) => p.id === targetId);
        /* 纸不在了（力迟到的回调）：不写——空写会落到焦点那张身上，等于替别人改题签。 */
        if (!paper) return;
        st.setPicks(
          {
            presetId: paper.presetId,
            providerName: targetProvider,
            model: modelId,
            thinking: undefined, // 换模型 = 思考档重解析（旧档位可能不在新模型声明里）
            // 权限那一格不因换模型而丢（2026-11-28 卷级权限批）：原样保留已有题签
            permission: paper.picks?.permission ?? null,
          },
          paper.id,
        );
        // 下一卷：同一笔写成新卷出生默认（同一写路径 = 坞期「无主态拨」那条）
        getComposeStore(core.panelId).getState().setGlobalModel(targetProvider, modelId);
        return;
      }
      const compose = getComposeStore(core.panelId).getState();
      // 开口即开卷（2026-08-31）：无主态拨「新卷出生默认」；有卷写会话覆盖
      if (activeSessionId == null) {
        compose.setGlobalModel(targetProvider, modelId);
        return;
      }
      compose.setModel(activeSessionId, targetProvider, modelId);
    },
    [core, activeSessionId, providerName, isSheet, paperId],
  );
  const onThinkingChange = useCallback(
    (value: string) => {
      if (!core) return;
      // 纸期（V2）：同 onModelChange——写题签 + 记住为新卷出生默认。
      // ⚠ 与原坞的差别：'自动' 在坞里写成 '' 覆盖值，在纸上是 **undefined**（= 没题），
      // 这样「没碰过」与「显式选自动」在开卷时同义（零覆盖，跟随全局）。
      // 「记住」那一笔照坞期无主态的尺子走（'自动' = '' 显式值，别再交给行值兜底——
      // 否则用户选了「自动」，下次开纸又变回该模型的声明档位）。
      if (isSheet) {
        const st = useDraftSheetStore.getState();
        // 多纸：写的是**本件所属那张纸**的题签
        const targetId = paperId ?? st.focusedId;
        const picks = targetId === null ? null : (st.papers.find((p) => p.id === targetId)?.picks ?? null);
        if (!picks) return;
        st.setPicks(
          { ...picks, thinking: value === '' ? undefined : (value as StoredThinking) },
          targetId ?? undefined,
        );
        // 下一卷：记成该模型的默认档位（'自动' = 显式 ''，别再交给行值兜底）
        getComposeStore(core.panelId)
          .getState()
          .setGlobalThinking(value === '' ? '' : (value as StoredThinking));
        return;
      }
      const next = (value === '' ? '' : value) as StoredThinking;
      const compose = getComposeStore(core.panelId).getState();
      if (activeSessionId == null) {
        compose.setGlobalThinking(next);
        return;
      }
      compose.setThinking(activeSessionId, next);
    },
    [core, activeSessionId, isSheet, paperId],
  );

  /* ── 思考档位面（2026-11-12 DSH 两级菜单，用户拍板「去抄 dsh 的 UX」）──────
   * 旧形态（2026-11-06 合并 A）把档位表平铺成 n 枚 chip 塞在模型弹层底部——用户
   * 判「模型思考强度选择这块的 UX 有毛病」。DSH 的解法是**同级第二面**：根栏两格
   * 「模型 / 思考」，点进思考面才是一张竖排档位清单（当前档行型选中）。
   * 这里只把**数据面**交给 ModelSelector（值/标签/档位表/回调），文案仍由本件给
   * （档位名在 thinkingZhLabel、说明在 THINKING_DESC），选择器不感知思考语义。 */
  const thinkingSeat = useMemo(
    () => ({
      value: currentThinking ?? '',
      label: thinkingZhLabel(currentThinking),
      options: thinkingOptions.map((o) => ({
        value: o.value,
        label: thinkingZhLabel(o.value),
        hint: THINKING_DESC[o.value] ?? '',
      })),
      onChange: onThinkingChange,
    }),
    [currentThinking, thinkingOptions, onThinkingChange],
  );

  return { onModelChange, onThinkingChange, thinkingSeat };
}

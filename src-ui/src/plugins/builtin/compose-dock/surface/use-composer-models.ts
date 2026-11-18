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
  activeSessionId: string | null;
  providerName: string;
  currentThinking: StoredThinking | '' | undefined;
  thinkingOptions: ReadonlyArray<{ value: string }>;
}

export function useComposerModels({
  core,
  isSheet,
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
      // 纸期（V2）：拨的是**题签**（开卷那一刻才落会话覆盖/全局默认）——三态变四态，
      // 判据只有这一处。纸没有卷号，写全局默认是错的（那是「没起过卷」的语义）。
      if (isSheet) {
        const st = useDraftSheetStore.getState();
        // 多纸：写的是**焦点那张纸**的题签（setPicks 的缺省纸 = 焦点）
        st.setPicks({
          presetId: st.papers.find((p) => p.id === st.focusedId)?.presetId ?? null,
          providerName: targetProvider,
          model: modelId,
          thinking: undefined, // 换模型 = 思考档重解析（旧档位可能不在新模型声明里）
          // 权限那一格不因换模型而丢（2026-11-28 卷级权限批）：原样保留已有题签
          permission: st.papers.find((p) => p.id === st.focusedId)?.picks?.permission ?? null,
        });
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
    [core, activeSessionId, providerName, isSheet],
  );
  const onThinkingChange = useCallback(
    (value: string) => {
      if (!core) return;
      // 纸期（V2）：同 onModelChange——写题签，不写全局默认/会话覆盖。
      // ⚠ 与原坞的差别：'自动' 在坞里写成 '' 覆盖值，在纸上是 **undefined**（= 没题），
      // 这样「没碰过」与「显式选自动」在开卷时同义（零覆盖，跟随全局）。
      if (isSheet) {
        const st = useDraftSheetStore.getState();
        // 多纸：写的是**焦点那张纸**的题签
        const picks = st.papers.find((p) => p.id === st.focusedId)?.picks ?? null;
        if (!picks) return;
        st.setPicks({ ...picks, thinking: value === '' ? undefined : (value as StoredThinking) });
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
    [core, activeSessionId, isSheet],
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

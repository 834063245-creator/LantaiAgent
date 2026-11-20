// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-composer-models — 创作坞的**模型 / 思考热切换面**（2026-11-17 P6 拆出；
// **2026-11-29 收口批**：写路径收归 `patchRunConfig`）。
//
// 归组判据：这组状态**随同一个事件变化**——都随「这一趟用哪个模型、拨多深」：
// 模型切换、思考档位切换，以及交给 ModelSelector 的那一份「思考座位」数据面。
//
// 三态（坞 / 纸 / 无主）的差别**不在本件**：本件只做两件事——把 UI 事件翻成一个
// `RunPatch`，交给 `patchRunConfig(目标, …)`；把档位表包成 ModelSelector 要的座位。
// 分流规则（这一卷 / 下一卷 / 工作区默认）全在 `state/run-config`，本件不再判 `isSheet`。
//
// 思考档位面（2026-11-12 DSH 两级菜单，用户拍板「去抄 dsh 的 UX」）：旧形态把档位表
// 平铺成 n 枚 chip 塞在模型弹层底部——用户判「这块 UX 有毛病」。DSH 的解法是**同级
// 第二面**：根栏两格「模型 / 思考」，点进思考面才是一张竖排档位清单（当前档行型选中）。
// 本件只把**数据面**交给 ModelSelector（值/标签/档位表/回调），文案仍由坞给
// （档位名在 thinkingZhLabel、说明在 THINKING_DESC），选择器不感知思考语义。

import { useCallback, useMemo } from 'react';
import { providerNameForModel } from './../composer-helpers';
import { THINKING_DESC, thinkingZhLabel } from './../dock-copy';
import type { ChatCore, RunTarget, StoredThinking } from './../host';
import { patchRunConfig } from './../host';

export interface ComposerModelsInput {
  core: ChatCore | null;
  /** 本宿主指向的目标（纸 / 卷 / 无主）——写入分流的唯一入参。 */
  target: RunTarget;
  providerName: string;
  currentThinking: StoredThinking | '' | undefined;
  thinkingOptions: ReadonlyArray<{ value: string }>;
}

export function useComposerModels({
  core,
  target,
  providerName,
  currentThinking,
  thinkingOptions,
}: ComposerModelsInput) {
  /* ── 热切换：模型 / 思考 ── */
  const onModelChange = useCallback(
    (modelId: string, desc?: { vendor: string }) => {
      if (!core) return;
      const targetProvider = providerNameForModel(desc, providerName);
      /* 一笔写完三件事：本目标（纸 → 题签 / 卷 → 会话覆盖 / 无主 → 出生默认）、
       * 换模型 = 思考档重解析、以及「下一卷出生默认」（题签要能记住选择，见 run-config
       * 的 writeModel）。旧实现这两笔散在两个 hook 里，先后顺序各写一遍。 */
      patchRunConfig(target, { model: { providerName: targetProvider, model: modelId } });
    },
    [core, providerName, target],
  );
  const onThinkingChange = useCallback(
    (value: string) => {
      if (!core) return;
      /* 「自动」= `''`（显式值）：纸上会被 run-config 翻译成 undefined（= 没题，开卷零覆盖），
       * 坞里/卷上原样落成 ''（否则会回落该模型声明的档位——用户选了「自动」又变回去）。 */
      patchRunConfig(target, { thinking: value as StoredThinking });
    },
    [core, target],
  );

  /* ── 思考档位面（2026-11-12 DSH 两级菜单，用户拍板「去抄 dsh 的 UX」）──────
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

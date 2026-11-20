// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-model-seat — 「这一趟拿哪个模型、拨多深」的**读数解析**（2026-11-19 题签重画批拆出；
// **2026-11-29 收口批改写**）。
//
// 改写理由：这组读数原来由宿主自己拼（题签 / 会话覆盖 / 出生默认三处 `?? `、外加一层
// 「显式覆盖」的旁路）——每个宿主拼一遍，就有一份自己的优先级链。收口之后**四笔的生效值
// 只由 `state/run-config` 解析**（`useRunConfig` 把它变成响应式读数），本件只剩一件正事：
// 拿那三笔去解析出**模型描述符 / 附图能力 / 思考档位表**（设置面与请求面同一把尺子）。
//
// 于是「同一个动作一个实现」在读数面也成立了：纸期卷首档行、纸身输入面、坞的设置行，
// 三处拿到的是同一个 `RunConfig`，唯一的差别是宿主传给解析层的目标（纸 / 卷 / 无主）。

import { useMemo } from 'react';
import type { ProviderSettings, RunConfig, StoredThinking } from '../host';
import { getModel, loadSettings, modelDescriptor, modelInput, thinkingOptionsOrDefault } from '../host';

export interface ModelSeatInput {
  /** 四笔的**已解析**读数（`useRunConfig(目标)` 给的那一份；兜底与来源都已定好）。 */
  config: RunConfig;
  /** 设置保存代数（保存后重读 provider 行与描述符）。 */
  settingsTick: number;
}

export interface ModelSeat {
  providerName: string;
  model: string;
  providerKind: string;
  provider: ProviderSettings | undefined;
  imageCapable: boolean;
  thinkingOptions: ReadonlyArray<{ value: string; label?: string }>;
  currentThinking: StoredThinking | '' | undefined;
}

export function useModelSeat({ config, settingsTick }: ModelSeatInput): ModelSeat {
  const { providerName, model, thinking: currentThinking } = config;
  /* 描述符/能力表读的是**设置快照**（每次保存一代重读一次）——热路径不在渲染里做
   * localStorage JSON.parse（C4 纪律）。 */
  const settings = useMemo(() => {
    void settingsTick;
    try {
      return loadSettings();
    } catch {
      return null;
    }
  }, [settingsTick]);
  const provider: ProviderSettings | undefined = settings?.providers.find((p) => p.name === providerName);
  const providerKind = provider?.kind ?? 'openai';
  /* 2026-09-23 思考下沉：描述符改读 **provider 作用域**（覆盖 ?? API 拉取 ?? 目录 seed）
   * ——与设置页参数面板、请求期 assertEffortDeclared 同一把尺子。 */
  const modelDesc = useMemo(() => (provider ? modelDescriptor(provider, model) : getModel(model)), [provider, model]);
  const imageCapable = modelInput(provider, model).includes('image');
  const thinkingOptions = useMemo(() => thinkingOptionsOrDefault(modelDesc), [modelDesc]);
  return { providerName, model, providerKind, provider, imageCapable, thinkingOptions, currentThinking };
}

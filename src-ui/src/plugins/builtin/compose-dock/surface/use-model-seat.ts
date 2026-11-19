// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// use-model-seat — 「这一趟拿哪个模型、拨多深」的**读数解析**（2026-11-19 题签重画批拆出）。
//
// 为什么单独立文件：这组读数现在有**两处宿主**——坞期设置行（`useComposerSession` 的
// prefs 分支）与纸期卷首档行（`DraftFolioSurface`）。原样留在前者里，后者要么复制一遍
// 十六行推导（两把尺子），要么经第二份 store 读——两条都是本仓判过的病灶。
//
// 源解析**只有一条链**（逐字搬自 use-composer-session，语义零变化）：
//   题签（纸期）/ 会话覆盖（坞期）?? 新卷出生默认 → provider → 描述符（provider 作用域）
//   → 思考档位表（有声明用声明，无声明给协议安全兜底）→ 生效档位（题签/覆盖 ?? 模型默认）。

import { useMemo } from 'react';
import type { ProviderSettings, StoredThinking } from '../host';
import {
  getModel,
  loadSettings,
  modelDescriptor,
  modelInput,
  modelThinking,
  resolveNewSessionDefault,
  thinkingOptionsOrDefault,
  useDraftSheetStore,
} from '../host';

export interface ModelSeatInput {
  /** 纸期：模型/思考的源头是**题签**（`draft-sheet-store` 焦点那张纸）。 */
  isSheet: boolean;
  /** 坞期：会话生效配置（覆盖 ?? 全局；`undefined` = 无活跃卷/无主态）。 */
  prefs: { providerName: string; model: string } | undefined;
  /** 坞期：会话**显式**思考覆盖（不拿 prefs 当覆盖用——见 use-composer-session 原注）。 */
  thinkingOverride: StoredThinking | undefined;
  /** 设置保存代数（保存后重读全局默认与描述符）。 */
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

export function useModelSeat({ isSheet, prefs, thinkingOverride, settingsTick }: ModelSeatInput): ModelSeat {
  // 开口即开卷（2026-08-31）：无主态显示/操作「新卷出生默认」（全局活跃行）；
  // 有活跃卷时 prefs（resolveEffective）已含全局回落（覆盖 ?? 全局）。
  const newSessionDefault = useMemo(() => {
    void settingsTick; // 保存代数触发器（非响应值）：设置保存后重读全局默认
    return resolveNewSessionDefault();
  }, [settingsTick]);
  /* 待题纸（2026-11-15 V2）：纸自己那张用**同一份** provider/model 推导，只是源头换成
   * 题签：题签未填（纸刚摊开）= 出厂默认（新卷出生默认），与坞期 prefs 的空位同义。 */
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
  // 2026-09-23 思考下沉：描述符改读 **provider 作用域**（覆盖 ?? API 拉取 ?? 目录 seed）
  // ——与设置页参数面板、请求期 assertEffortDeclared 同一把尺子。
  const modelDesc = useMemo(() => (provider ? modelDescriptor(provider, model) : getModel(model)), [provider, model]);
  // 附图能力门禁（multimodal-image-plan D-8②）：生效输入模态含 'image' 才开图片采集道。
  const imageCapable = modelInput(provider, model).includes('image');
  const thinkingOptions = useMemo(() => thinkingOptionsOrDefault(modelDesc), [modelDesc]);
  // 生效档位三层（2026-09-23）：会话覆盖（本卷显式拨过）?? 该模型档位 ?? 新卷出生默认。
  const currentThinking =
    (isSheet ? draftPicks?.thinking : thinkingOverride) ??
    (provider ? modelThinking(provider, model) : newSessionDefault.thinking);
  return { providerName, model, providerKind, provider, imageCapable, thinkingOptions, currentThinking };
}

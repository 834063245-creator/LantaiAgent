// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider factory — unified entry point for creating Provider instances from settings
//
// 方言解析器（平台化 Phase 1 · D2 修订版，2026-08-27）：
//   - 协议实现按 settings.kind 解析：只查 ctx.llm adapter 注册表
//     （composition/services.ts activeLlmAdapters 露出），同 kind **后注册胜**
//     （对齐 renderer-service 覆盖语义）——外部方言可仪器化/替换内核实现；
//   - 内核 anthropic / openai 两方言由第一方插件贡献
//     （plugins/llm-adapters-plugin.ts，loadBuiltinPlugins 表序紧随四 service）
//     ——本文件零内核回落分支；
//   - 未命中任何 adapter = 响亮报错并列出已注册方言（PROVIDER_DIALECT）——
//     此前未知 kind 静默跌进 openai 分支（拼错 "anthromorphic" 也能跑通但语义
//     全错），违反宪法「错误不静默」，2026-08-27 收口时一并纠正，此处保持。
//
// 类型开放集挂起说明：第三方方言要新增 kind 字面量时才扩 Protocol（存储格式变更，
// 挂着 ADR #0002 单独裁决）；贡献道当前的合法用法是【覆盖】两种内核方言。

import { activeLlmAdapters } from '../composition/services';
import type { ProviderSettings } from '../settings';
import { withThinkingDisabled } from './thinking';
import type { Provider, ProviderRuntimeArgs } from './types';

export interface CreateProviderOptions {
  /** Disable reasoning/thinking on OpenAI-compatible providers (e.g. for translation). */
  disableThinking?: boolean;
}

/** 按 ctx.llm adapter 注册序取最后一个同 kind 实现（后注册胜）；未命中响亮报错。 */
function resolveProviderDialect(kind: string, rt: ProviderRuntimeArgs): Provider {
  const contributed = [...activeLlmAdapters()].filter((d) => d.kind === kind);
  const winner = contributed[contributed.length - 1];
  if (winner) return winner.create(rt);
  const registeredKinds = [...new Set(activeLlmAdapters().map((d) => d.kind))].sort();
  throw new Error(
    `PROVIDER_DIALECT: 未注册的协议方言 "${kind}"（当前可用：${registeredKinds.join(', ') || '(无已注册 adapter)'}）` +
      '——请检查该提供方的 kind 设置与 llm-adapters 装配',
  );
}

/** Create a Provider from ProviderSettings, dispatching to the correct implementation. */
export function createProvider(settings: ProviderSettings, options?: CreateProviderOptions): Provider {
  // per-model 最大输出覆盖（P14）：请求时按模型解析，0/缺省 = 目录值（clampMaxTokens 兜底）
  const maxTokensFor = (model: string): number | undefined => settings.modelOverrides?.[model]?.maxTokens || undefined;
  return resolveProviderDialect(settings.kind, {
    name: settings.name,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    // disableThinking 语义统一到两种协议：true → 强制关闭扩展思考。
    // 翻译器/摘要路径都传 disableThinking: true。
    thinking: withThinkingDisabled(settings.thinking, options?.disableThinking),
    maxTokensFor,
  });
}

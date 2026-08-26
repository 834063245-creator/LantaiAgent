// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Provider factory — unified entry point for creating Provider instances from settings
//
// 方言解析器（2026-08-27，provider 插件化收口）：
//   - 协议实现按 settings.kind 解析：先查贡献道（ProvidersService 经
//     activeProviderContributions 露出），同 kind **后注册胜**（对齐 renderer-service
//     覆盖语义）——插件可以包一层仪器化 wrapper 替换内核方言；
//   - 未命中回落内核 'anthropic' | 'openai'；
//   - 都没有 = 响亮报错并列出已注册方言。此前未知 kind 会静默跌进 openai 分支
//     （拼错 "anthromorphic" 也能跑通但语义全错），违反宪法「错误不静默」，此处一并纠正。
//
// 类型开放集挂起说明：第三方方言要新增 kind 字面量时才扩 Protocol（存储格式变更，
// 挂着 ADR #0002 单独裁决）；贡献道当前的合法用法是【覆盖】两种内核方言。

import { activeProviderContributions } from '../composition/services';
import type { ProviderSettings } from '../settings';
import { createAnthropicProvider } from './anthropic';
import { createOpenAIProvider } from './openai';
import { withThinkingDisabled } from './thinking';
import type { Provider, ProviderRuntimeArgs } from './types';

export interface CreateProviderOptions {
  /** Disable reasoning/thinking on OpenAI-compatible providers (e.g. for translation). */
  disableThinking?: boolean;
}

/** 按贡献注册序取最后一个同 kind 实现（后注册胜）；没有则回落内核方言。 */
function resolveProviderDialect(kind: string, rt: ProviderRuntimeArgs): Provider {
  const contributed = [...activeProviderContributions()].filter((d) => d.kind === kind);
  const winner = contributed[contributed.length - 1];
  if (winner) return winner.create(rt);
  if (kind === 'anthropic') {
    return createAnthropicProvider({
      name: rt.name,
      apiKey: rt.apiKey,
      baseUrl: rt.baseUrl,
      model: rt.model,
      thinking: rt.thinking,
      maxTokensFor: rt.maxTokensFor,
    });
  }
  if (kind === 'openai') {
    return createOpenAIProvider({
      name: rt.name,
      apiKey: rt.apiKey,
      baseUrl: rt.baseUrl,
      model: rt.model,
      thinking: rt.thinking,
      maxTokensFor: rt.maxTokensFor,
    });
  }
  const registered = [...new Set([...activeProviderContributions().map((d) => d.kind), 'anthropic', 'openai'])].join(
    ', ',
  );
  throw new Error(
    `PROVIDER_DIALECT: 未注册的协议方言 "${kind}"（当前可用：${registered}）——请检查该提供方的 kind 设置`,
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

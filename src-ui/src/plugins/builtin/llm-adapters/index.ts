// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 第一方 LLM adapter 插件（agent-platformization-plan Phase 1 · D2 修订版，2026-08-27）——
// 真源产物化（plugin-bundle-retirement S2，2026-09-03）；**实现归家**（插件化欠账账本
// 批 2a，2026-09-24）：三方言 `anthropic/openai/responses` 与私有 helper
// `shared/retry` 已在本包内 ⇒ 本插件不再经宿主桥取工厂，内核只留 seam 契约与目录/元数据面
// （见 host.ts 头注）。收益：LLM 适配器自此**改产物即热更**，不必重建 exe。
//
// 注册纪律：disposer 经 ctx.effect 登记；装载在四 service 之后（loadBuiltinPlugins
// 表序紧随 compositionServicesPlugin），ctx.llm 可解析；排在外部插件装载之前——
// 外部方言按「后注册胜」覆盖内核。

import type { Context } from '../../../cordis';
import type { ProviderRuntimeArgs } from '../../../provider/types';
import { createAnthropicProvider } from './anthropic';
import { createOpenAIProvider } from './openai';
import { createResponsesProvider } from './responses';

/** 第一方 LLM adapter 插件 —— anthropic/openai/responses 内核方言 adapter 贡献。 */
export const llmAdaptersPlugin = {
  name: 'hologram/llm-adapters',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.llm.register({
          id: 'builtin/anthropic',
          kind: 'anthropic',
          label: 'Anthropic',
          create: (rt: ProviderRuntimeArgs) =>
            createAnthropicProvider({
              name: rt.name,
              apiKey: rt.apiKey,
              baseUrl: rt.baseUrl,
              model: rt.model,
              thinking: rt.thinking,
              maxTokensFor: rt.maxTokensFor,
              // provider 作用域描述符（拉取元数据 + 覆盖 + seed）——方言请求期读它
              describeModel: rt.describeModel,
              // 自定义请求头（settings → 高级，连接怪癖用户可编辑面）
              headers: rt.headers,
            }),
        }),
      'llm-adapter-anthropic',
    );
    ctx.effect(
      () =>
        ctx.llm.register({
          id: 'builtin/openai',
          kind: 'openai',
          label: 'OpenAI 兼容',
          create: (rt: ProviderRuntimeArgs) =>
            createOpenAIProvider({
              name: rt.name,
              apiKey: rt.apiKey,
              baseUrl: rt.baseUrl,
              model: rt.model,
              thinking: rt.thinking,
              maxTokensFor: rt.maxTokensFor,
              describeModel: rt.describeModel,
              headers: rt.headers,
            }),
        }),
      'llm-adapter-openai',
    );
    ctx.effect(
      () =>
        ctx.llm.register({
          id: 'builtin/responses',
          kind: 'responses',
          label: 'OpenAI Responses',
          create: (rt: ProviderRuntimeArgs) =>
            createResponsesProvider({
              name: rt.name,
              apiKey: rt.apiKey,
              baseUrl: rt.baseUrl,
              model: rt.model,
              thinking: rt.thinking,
              maxTokensFor: rt.maxTokensFor,
              describeModel: rt.describeModel,
              // Phase 3D：authMode='oauth' 的 Codex 订阅注入头（live 层装配）
              extraHeaders: rt.oauthHeaders,
              headers: rt.headers,
            }),
        }),
      'llm-adapter-responses',
    );
  },
};

export default llmAdaptersPlugin;

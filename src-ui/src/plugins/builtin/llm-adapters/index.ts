// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// 第一方 LLM adapter 插件（agent-platformization-plan Phase 1 · D2 修订版，2026-08-27）——
// 真源产物化（plugin-bundle-retirement S2，2026-09-03）。原 plugins/llm-adapters-plugin.ts
// 整体迁入；运行时依赖 createAnthropicProvider/createOpenAIProvider 经宿主桥取用。
//
// 注册纪律：disposer 经 ctx.effect 登记；装载在四 service 之后（loadBuiltinPlugins
// 表序紧随 compositionServicesPlugin），ctx.llm 可解析；排在外部插件装载之前——
// 外部方言按「后注册胜」覆盖内核。

import type { Context } from '../../../cordis';
import type { ProviderRuntimeArgs } from '../../../provider/types';
import { createAnthropicProvider, createOpenAIProvider } from './host';

/** 第一方 LLM adapter 插件 —— anthropic/openai 内核方言两条默认 adapter 贡献。 */
export const llmAdaptersPlugin = {
  name: 'hologram/llm-adapters',
  inject: ['llm'],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.llm.register({
          id: 'builtin/anthropic',
          kind: 'anthropic',
          create: (rt: ProviderRuntimeArgs) => createAnthropicProvider(rt),
        }),
      'llm-adapter-anthropic',
    );
    ctx.effect(
      () =>
        ctx.llm.register({
          id: 'builtin/openai',
          kind: 'openai',
          create: (rt: ProviderRuntimeArgs) => createOpenAIProvider(rt),
        }),
      'llm-adapter-openai',
    );
  },
};

export default llmAdaptersPlugin;

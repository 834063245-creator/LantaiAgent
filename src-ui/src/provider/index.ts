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

import type { SeamDisabledMap } from '../composition/seam-resolution';
import { activeLlmAdapters } from '../composition/services';
import { modelDescriptor, modelInput, type ProviderSettings } from '../settings';
import { withThinkingDisabled } from './thinking';
import type { ModelDescriptor, Provider, ProviderRuntimeArgs } from './types';

export interface CreateProviderOptions {
  /** Disable reasoning/thinking on OpenAI-compatible providers (e.g. for translation). */
  disableThinking?: boolean;
  /** OAuth 请求注入头（Phase 3D）：authMode='oauth' 的 provider 由 live 层
   *  解析 grant 后传入（Authorization Bearer + chatgpt-account-id 等）。
   *  缺省 undefined = apiKey 路径。 */
  oauthHeaders?: Record<string, string>;
  /** 本次构建所属组合的 seam 裁剪面（S6 P2b）——方言解析按它裁剪 `seam/llm`
   *  （每卷可走不同 adapter）。**缺省 = 全局当前选择**（无组合上下文的构建点：
   *  设置面板连通性测试 / 翻译压缩旁路——P2 前语义，零漂移）。 */
  seamView?: SeamDisabledMap | null;
}

/** ctx.llm adapter 必须实现的成员（开放面契约 v25 起 `Provider` 形状的可执行镜像）。
 *  真源是 provider/types.ts 的 `Provider` 接口——TS 编译期只覆盖 src/ 内的实现，
 *  插件 bundle 是运行时加载的，编译器管不到（动态插件/外部插件同此）。 */
const REQUIRED_PROVIDER_MEMBERS: readonly (keyof Provider)[] = ['name', 'model', 'stream'];

/** 形状校验：旧契约构建的 adapter 在**创建边界**被点名，而不是等到回合中途
 *  抛 `TypeError: host.prov.model is not a function`（2026-09-12 实测：
 *  那是升级 v25 后旧 bundle 的实际失败形态，报错对 adapter 作者毫无指引）。
 *
 *  ⚠️ 这不是兼容层——不做任何回退/兜底（绝不 `?? name()` 之类把提供方名
 *  当模型 id 填回去，那正是 v25 修掉的静默 bug 形态）；只把「哪里坏了、
 *  怎么修」说清楚，报错即终局。 */
function assertProviderShape(prov: Provider, adapterId: string, kind: string): void {
  for (const member of REQUIRED_PROVIDER_MEMBERS) {
    if (typeof prov[member] === 'function') continue;
    const hint =
      member === 'model'
        ? '该 adapter 可能按 v25 之前的契约构建——开放面契约 v25 起 Provider 新增必填 model()（返回真实模型 id；name() 是提供方身份，两者不可混用），请补 model: () => rt.model 后重新构建插件'
        : `Provider 契约要求实现 ${String(member)}()`;
    throw new Error(
      `PROVIDER_ADAPTER_SHAPE: adapter「${adapterId}」(kind=${kind}) 未实现 ${String(member)}()——${hint}`,
    );
  }
}

/** 按 ctx.llm adapter 注册序取最后一个同 kind 实现（后注册胜）；未命中响亮报错。
 *  view（S6 P2b）= 本次构建所属组合的裁剪面；缺省 = 全局当前选择（零漂移）。 */
function resolveProviderDialect(kind: string, rt: ProviderRuntimeArgs, view?: SeamDisabledMap | null): Provider {
  const contributed = [...activeLlmAdapters(view)].filter((d) => d.kind === kind);
  const winner = contributed[contributed.length - 1];
  if (winner) {
    const prov = winner.create(rt);
    assertProviderShape(prov, winner.id, kind);
    return prov;
  }
  const registeredKinds = [...new Set(activeLlmAdapters(view).map((d) => d.kind))].sort();
  throw new Error(
    `PROVIDER_DIALECT: 未注册的协议方言 "${kind}"（当前可用：${registeredKinds.join(', ') || '(无已注册 adapter)'}）` +
      '——请检查该提供方的 kind 设置与 llm-adapters 装配',
  );
}

/** Create a Provider from ProviderSettings, dispatching to the correct implementation. */
export function createProvider(settings: ProviderSettings, options?: CreateProviderOptions): Provider {
  // per-model 最大输出覆盖（P14）：请求时按模型解析，0/缺省 = 目录值（clampMaxTokens 兜底）
  const maxTokensFor = (model: string): number | undefined => settings.modelOverrides?.[model]?.maxTokens || undefined;
  // provider 作用域描述符解析（provider-model-meta）：方言请求期（档位协商 / 输出
  // 钳制）读它——合并链 = 用户覆盖 ?? API 拉取元数据 ?? 静态目录 seed ?? 默认。
  // 此前方言一律读全局 getModel：聚合网关/自定义端点的模型（静态目录无条目）
  // 永远拿不到自己的窗口与档位声明，拉取到的元数据也到不了 wire 层。
  const describeModel = (model: string): ModelDescriptor | undefined => modelDescriptor(settings, model);
  const prov = resolveProviderDialect(
    settings.kind,
    {
      name: settings.name,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      // disableThinking 语义统一到两种协议：true → 强制关闭扩展思考。
      // 翻译器/摘要路径都传 disableThinking: true。
      thinking: withThinkingDisabled(settings.thinking, options?.disableThinking),
      maxTokensFor,
      describeModel,
      oauthHeaders: options?.oauthHeaders,
    },
    options?.seamView,
  );
  // 输入模态能力戳（multimodal-image-plan B3 · D-8③）：生效声明 = ModelOverrides.input
  // 覆盖 ?? 目录值（B5 modelInput 合并链）盖在实例上——Agent 请求期投影读它，
  // Provider 实现自身零感知。未声明 = ['text']（不编造能力）。
  prov.inputModalities = modelInput(settings, settings.model);
  return prov;
}

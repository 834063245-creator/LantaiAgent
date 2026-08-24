// Copyright (c) 2026 Wenbing Jing. MIT License.
// SPDX-License-Identifier: MIT

// Live Provider — 无状态协议适配器（Phase C，2026-08-24 工作区归属根治）。
//
// 形态对标 DSH（llm-pi-ai adapter）：provider 对象只携带「提供方名」这一
// 身份，baseUrl / model / apiKey / thinking / maxTokens 全部在每次使用点
// （stream / prewarm / fetchModels）按名现解析（resolveProviderRuntime：
// settings 同步读 + 凭据内存缓存，见 provider/credentials.ts）。效果：
//   - Agent/会话的构造与存在性彻底与 Key 无关——无 Key 冷启动照样装配；
//     缺 Key 的表现 = 请求期 MISSING_CREDENTIAL 响亮报错（不静默回退）
//   - 设置保存后即刻生效（无需换引用/重启）——恒 swap 热切换退役
// 思考档位同理随 settings 现解析——setThinking 对本形态为 no-op（运行时
// 覆盖退役；需要「强制关闭思考」的旁路（翻译/压缩）仍用显式构造的
// createProvider，不经本形态）。

import { providerId } from '../settings';
import { resolveProviderRuntime } from './credentials';
import { type CreateProviderOptions, createProvider } from './index';
import type { StoredThinking } from './thinking';
import type { Chunk, ModelDescriptor, Provider, Request } from './types';

export function createLiveProvider(name: string, options?: CreateProviderOptions): Provider {
  const pid = providerId(name);
  const resolve = () => resolveProviderRuntime(pid);

  return {
    name() {
      return name;
    },
    setThinking(_cfg: StoredThinking | undefined): void {
      // 无状态协议适配器：档位随 settings 每请求现解析，运行时覆盖退役
    },
    async *stream(signal: AbortSignal, req: Request): AsyncGenerator<Chunk> {
      const rt = await resolve();
      if (!rt) {
        throw new Error(`LIVE_PROVIDER: 提供方「${name}」已不在设置中——请在设置 → Provider 检查后重试`);
      }
      if (!rt.apiKey) {
        throw new Error(`MISSING_CREDENTIAL: 提供方「${name}」未配置 API Key——设置 → Provider 填写并保存后直接重试`);
      }
      const inner = createProvider({ ...rt.provider, apiKey: rt.apiKey }, options);
      yield* inner.stream(signal, req);
    },
    prewarm(): void {
      void resolve()
        .then((rt) => {
          if (!rt?.apiKey) return; // 无 Key 不预热（无谓的 401 噪音）
          createProvider({ ...rt.provider, apiKey: rt.apiKey }, options).prewarm?.();
        })
        .catch(() => {
          /* best-effort 预热 */
        });
    },
    async fetchModels(): Promise<ModelDescriptor[]> {
      const rt = await resolve();
      if (!rt?.apiKey) return [];
      const inner = createProvider({ ...rt.provider, apiKey: rt.apiKey }, options);
      return inner.fetchModels?.() ?? [];
    },
  };
}
